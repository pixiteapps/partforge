// test/implicit-owner-mesher.test.js
// The owner-aware mesher: each contact child keeps its own skin where the pieces are apart,
// at exactly the set gap; touching pieces fuse. First on the raw mesh, then through
// meshImplicit (owner-aware cleanup).
import { describe, test, expect } from "vitest";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { cleanupMesh, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail } from "../src/framework/geometry/implicit/detail.js";
import { evalNodeAt } from "../src/framework/geometry/implicit/reference.js";
import { attachWeight, ATTACH_STRIDE } from "../src/framework/geometry/implicit/contact.js";
import { planLeaves, evaluateLeaves, sampleField, LEAF } from "../src/framework/geometry/implicit/sparse.js";
import { evalBatch, evalBatchContact } from "../src/framework/geometry/implicit/program.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { meshStoreOwners, OWNER_AIR } from "../src/framework/geometry/implicit/mesher-owners.js";
import { edgeCheck, componentCount } from "./helpers/mesh-topology.js";
import { pieceGapError, childIndex, sharesAt } from "./helpers/seam-quality.js";
import { fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram } from "../src/framework/geometry/implicit/program.js";
import { capsulePress, threePress, PRESS_OVERLAP, SEAM_CASES } from "./fixtures/implicit-seam-cases.js";

const EDGE = 1.5;
const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };
const exact = (spec) => compileImplicit(spec, { exactContact: true });
const ownerMesh = (spec, gap) => {
  const compiled = exact(spec), store = sampleField(compiled, EDGE);
  return { compiled, store, mesh: meshStoreOwners(store, { gap }) };
};

/** The largest |field| at any vertex of the mesh (one full-decision program). */
function worstField(compiled, positions) {
  const nv = positions.length / 3, X = new Float64Array(nv), Y = new Float64Array(nv), Z = new Float64Array(nv), out = new Float64Array(nv);
  for (let v = 0; v < nv; v++) { X[v] = positions[3 * v]; Y[v] = positions[3 * v + 1]; Z[v] = positions[3 * v + 2]; }
  evalBatch(emitProgram(compiled, fullDecision(compiled), 0), compiled.textures, X, Y, Z, out);
  let worst = 0;
  for (const f of out) worst = Math.max(worst, Math.abs(f));
  return worst;
}

/** Each vertex's component root (triangles joined through shared vertices). */
function components(mesh) {
  const nv = mesh.positions.length / 3, parent = new Int32Array(nv).map((_, i) => i), I = mesh.indices;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < I.length; t += 3) {
    const r = find(I[t]);
    for (let k = 1; k < 3; k++) { const s = find(I[t + k]); if (s !== r) parent[s] = r; }
  }
  return find;
}

describe("owner mesher (raw mesh)", () => {
  test("far-apart pieces mesh exactly as the plain mesher", () => {
    const { store, mesh } = ownerMesh(capsulePress({ overlap: -10 }), 0);
    const plain = meshStore(store);
    expect(Buffer.from(mesh.positions.buffer).equals(Buffer.from(plain.positions.buffer))).toBe(true);
    expect(Buffer.from(mesh.indices.buffer).equals(Buffer.from(plain.indices.buffer))).toBe(true);
    expect(mesh.vertOwner.length).toBe(plain.positions.length / 3);
  });

  for (const [gap, tol] of [[0.2, 0.002], [0.05, 0.01]]) {
    test(`press gap ${gap} is two closed shells at the gap`, () => {
      const { compiled, mesh } = ownerMesh(capsulePress({ overlap: PRESS_OVERLAP, gap }), gap);
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
      expect(componentCount(mesh.indices)).toBe(2);
      const g = pieceGapError(compiled, mesh, "a", "b", gap);
      expect(g.maxFaceError).toBeLessThanOrEqual(tol);
      expect(g.min).toBeGreaterThanOrEqual(gap - tol);
    });
  }

  test("press gap 0 is one closed solid, no vertex further off the field than the plain mesher's", () => {
    const { compiled, store, mesh } = ownerMesh(capsulePress({ overlap: PRESS_OVERLAP, gap: 0 }), 0);
    expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
    expect(componentCount(mesh.indices)).toBe(1);
    expect(worstField(compiled, mesh.positions)).toBeLessThanOrEqual(worstField(compiled, meshStore(store).positions));
  });

  // Attachment blends: a merged owner's share jumps at a zone's rim, so nothing may be placed
  // on it there. Every vertex stays as near the field as the plain mesher's worst.
  for (const name of ["hand default gap 0", "hand fist gap 0.2"]) for (const edge of [1.5, 0.6]) {
    test(`${name} at ${edge}: closed, no vertex further off the field than the plain mesher's`, () => {
      const compiled = exact(SEAM_CASES.find((c) => c.name === name).spec), store = sampleField(compiled, edge);
      const mesh = meshStoreOwners(store, { gap: compiled.ir.nodes[compiled.ownerRoot].gap });
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
      expect(componentCount(mesh.indices)).toBe(1);
      expect(worstField(compiled, mesh.positions)).toBeLessThanOrEqual(worstField(compiled, meshStore(store).positions));
    }, 120_000);
  }

  test("near miss 0.3 at gap 0 stays apart", () => {
    const { compiled, mesh } = ownerMesh(capsulePress({ overlap: -0.3, gap: 0 }), 0);
    expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
    expect(componentCount(mesh.indices)).toBe(2);
    expect(pieceGapError(compiled, mesh, "a", "b", 0).min).toBeGreaterThanOrEqual(0.3 - 0.01);
  });

  test("owners: the press-0.2 a-shell is owned by a throughout", () => {
    const { compiled, mesh } = ownerMesh(capsulePress({ overlap: PRESS_OVERLAP, gap: 0.2 }), 0.2);
    const ia = childIndex(compiled, "a"), find = components(mesh), P = mesh.positions;
    let left = 0;   // the vertex furthest toward −x lies on a's shell
    for (let v = 1; v < P.length / 3; v++) if (P[3 * v] < P[3 * left]) left = v;
    const shell = find(left);
    let count = 0;
    for (let v = 0; v < P.length / 3; v++) if (find(v) === shell) { expect(mesh.vertOwner[v]).toBe(ia); count++; }
    expect(count).toBeGreaterThan(100);
    expect(mesh.ownerHeld.length).toBe(P.length / 3);
    expect(mesh.pinned.some((p) => p === 1)).toBe(true);
  });

  test("evaluateLeaves samples once: one capturing batch per leaf, plus zero nudges", () => {
    const compiled = exact(capsulePress({ overlap: PRESS_OVERLAP, gap: 0 })), plan = planLeaves(compiled, EDGE);
    expect(plan.ownerRoot).toBe(compiled.ownerRoot);
    expect(plan.ownerK).toBe(2);
    const S3 = (LEAF + 1) ** 3;
    let plain = 0, leafCalls = 0, nudgeCalls = 0;
    const store = evaluateLeaves(plan, {
      evalBatch: (...a) => { plain++; return evalBatch(...a); },
      evalBatchContact: (...a) => { if (a[2].length === S3) leafCalls++; else nudgeCalls++; return evalBatchContact(...a); },
    });
    expect(plain).toBe(0);
    expect(leafCalls).toBe(plan.leaves.length);
    expect(nudgeCalls).toBeLessThanOrEqual(plan.leaves.length);
    // The same values as an uncapturing run of the same plan; owners are AIR exactly where the stored value is ≥ 0.
    const ref = evaluateLeaves({ ...plan, ownerRoot: -1 });
    expect(ref.leaves[0].owner).toBeUndefined();
    let solid = 0;
    store.leaves.forEach((leaf, L) => expect(Buffer.from(leaf.vals.buffer).equals(Buffer.from(ref.leaves[L].vals.buffer))).toBe(true));
    for (const leaf of store.leaves) {
      expect(leaf.owner).toBeInstanceOf(Int8Array);
      expect(leaf.owner.length).toBe(S3);
      for (let s = 0; s < S3; s++) {
        if (leaf.vals[s] >= 0) expect(leaf.owner[s]).toBe(OWNER_AIR);
        else { expect(leaf.owner[s]).toBeGreaterThanOrEqual(0); solid++; }
      }
    }
    expect(solid).toBeGreaterThan(0);
  });
});

// The signed volume of each component (triangles joined through shared vertices).
function componentVolumes(mesh) {
  const find = components(mesh), P = mesh.positions, I = mesh.indices, vol = new Map();
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const v = (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
      + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    const r = find(I[t]);
    vol.set(r, (vol.get(r) ?? 0) + v);
  }
  return [...vol.values()];
}

/** Each vertex's share of child `o` (its own owner when `o` is an array). */
function shareAt(compiled, P, verts, o) {
  const X = Float64Array.from(verts, (v) => P[3 * v]), Y = Float64Array.from(verts, (v) => P[3 * v + 1]), Z = Float64Array.from(verts, (v) => P[3 * v + 2]);
  const { shares, K } = sharesAt(compiled, X, Y, Z);
  return verts.map((v, q) => shares[q * K + (Array.isArray(o) ? o[q] : o)]);
}

describe("through meshImplicit", () => {
  const GRIDS = [[1.5, "preview"], [0.6, "print"]];
  const run = (spec, edge, tier, opts = {}) => {
    const compiled = exact(spec);
    return { compiled, mesh: meshImplicit(compiled, edge, { tier, ...opts }) };
  };
  const noDetail = (name) => ({ ...SEAM_CASES.find((c) => c.name === name).spec, detail: [] });

  for (const [edge, tier] of GRIDS) {
    for (const [gap, tol] of [[0.2, 0.002], [0.05, 0.01]]) {
      test(`press gap ${gap} stays exact through cleanup (${tier} ${edge})`, () => {
        const { compiled, mesh } = run(capsulePress({ overlap: PRESS_OVERLAP, gap }), edge, tier);
        expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
        expect(componentCount(mesh.indices)).toBe(2);
        const g = pieceGapError(compiled, mesh, "a", "b", gap);
        expect(g.maxFaceError).toBeLessThanOrEqual(tol);
        expect(g.min).toBeGreaterThanOrEqual(gap - tol);
        // The held vertices, the mesher's moved ones and the ones it could not move alike, end on their own skin.
        const held = [];
        for (let v = 0; v < mesh.vertOwner.length; v++) if (mesh.ownerHeld[v]) held.push(v);
        expect(held.length).toBeGreaterThan(0);
        const own = shareAt(compiled, mesh.positions, held, held.map((v) => mesh.vertOwner[v]));
        expect(Math.max(...own.map(Math.abs))).toBeLessThanOrEqual(0.01 * edge);
        expect(mesh.crease.every((c) => c === 0)).toBe(true);
        expect(mesh.vertOwner.length).toBe(mesh.positions.length / 3);
      }, 60_000);
    }

    test(`bulge with a gap: press gap 0.2, bulge 1 (${tier} ${edge})`, () => {
      const { compiled, mesh } = run(capsulePress({ overlap: PRESS_OVERLAP, gap: 0.2, bulge: 1 }), edge, tier);
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
      expect(componentCount(mesh.indices)).toBe(2);
      expect(pieceGapError(compiled, mesh, "a", "b", 0.2).min).toBeGreaterThanOrEqual(0.198);
    }, 60_000);

    for (const miss of [0.3, 0.5]) {
      test(`near miss ${miss} never bridges (${tier} ${edge})`, () => {
        const { compiled, mesh } = run(capsulePress({ overlap: -miss, gap: 0 }), edge, tier);
        const [ia, ib] = compiled.ir.nodes[compiled.ownerRoot].children, P = mesh.positions, I = mesh.indices;
        const side = new Int8Array(P.length / 3);
        for (let v = 0; v < side.length; v++) side[v] = Math.sign(evalNodeAt(compiled, ia, P[3 * v], P[3 * v + 1], P[3 * v + 2]) - evalNodeAt(compiled, ib, P[3 * v], P[3 * v + 1], P[3 * v + 2]));
        let crossing = 0;
        for (let t = 0; t < I.length; t += 3) {
          const s = [side[I[t]], side[I[t + 1]], side[I[t + 2]]];
          if (s.includes(1) && s.includes(-1)) crossing++;
        }
        expect(crossing).toBe(0);
        expect(componentCount(I)).toBe(2);
      }, 60_000);
    }

    test(`three pieces at 0.2 are three closed shells (${tier} ${edge})`, () => {
      const { mesh } = run(threePress({ gap: 0.2 }), edge, tier);
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
      expect(componentCount(mesh.indices)).toBe(3);
    }, 60_000);

    test(`hand at 0.2 stays one body; fist tips off the palm (${tier} ${edge})`, () => {
      const { compiled, mesh } = run(SEAM_CASES.find((c) => c.name === "hand fist gap 0.2").spec, edge, tier);
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
      expect(componentVolumes(mesh).filter((v) => v > 0).length).toBe(1);   // sealed pockets (negative volume) aside
      // Every finger vertex outside its attachment zone (the webbing blend) keeps the gap from
      // the palm; the one nearest it is a fingertip pad in the fist.
      const palm = childIndex(compiled, "palm"), { att } = compiled.ir.nodes[compiled.ownerRoot], P = mesh.positions;
      for (const finger of ["index", "middle", "ring", "pinky"]) {
        const f = childIndex(compiled, finger), verts = [];
        let o = 0;
        while (!(att[o] === f || att[o + 1] === f)) o += ATTACH_STRIDE;
        for (let v = 0; v < mesh.vertOwner.length; v++) if (mesh.vertOwner[v] === f && attachWeight(att, o, P[3 * v], P[3 * v + 1], P[3 * v + 2]) === 0) verts.push(v);
        expect(verts.length).toBeGreaterThan(50);
        expect(Math.min(...shareAt(compiled, P, verts, palm))).toBeGreaterThanOrEqual(0.198);
      }
    }, 180_000);

    // A merged owner's share jumps at an attachment zone's rim, so a held vertex must never be
    // projected onto it there: the owner path ends no further off the field than the plain path.
    for (const name of ["hand default gap 0", "hand fist gap 0.2"]) {
      test(`${name}: no vertex further off the field than owners: false (${tier} ${edge})`, () => {
        const spec = noDetail(name);
        const owned = run(spec, edge, tier), plain = run(spec, edge, tier, { owners: false });
        expect(owned.mesh.vertOwner).toBeDefined();
        expect(worstField(owned.compiled, owned.mesh.positions)).toBeLessThanOrEqual(worstField(plain.compiled, plain.mesh.positions));
      }, 180_000);
    }
  }

  // Air samples lie inside the gap, so no cell holds two owners: no vertex is pinned, and the
  // gap face is a's vertices where its clearance cut makes its skin (d_a + d_b ≤ gap).
  test("gap wider than a cell: press gap 2 at 1.5", () => {
    const gap = 2, { compiled, mesh } = run(capsulePress({ overlap: PRESS_OVERLAP, gap }), 1.5, "preview");
    expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
    expect(componentCount(mesh.indices)).toBe(2);
    expect(mesh.pinned.every((p) => p === 0)).toBe(true);
    const [ia, ib] = compiled.ir.nodes[compiled.ownerRoot].children, P = mesh.positions, a = childIndex(compiled, "a"), face = [];
    for (let v = 0; v < mesh.vertOwner.length; v++) {
      if (mesh.vertOwner[v] !== a) continue;
      const da = evalNodeAt(compiled, ia, P[3 * v], P[3 * v + 1], P[3 * v + 2]), db = evalNodeAt(compiled, ib, P[3 * v], P[3 * v + 1], P[3 * v + 2]);
      if (da + db <= gap) face.push(v);
    }
    expect(face.length).toBeGreaterThan(20);
    const err = shareAt(compiled, P, face, childIndex(compiled, "b")).map((s) => Math.abs(s - gap));
    expect(Math.max(...err)).toBeLessThanOrEqual(0.02);
    expect(pieceGapError(compiled, mesh, "a", "b", gap).min).toBeGreaterThanOrEqual(gap - 0.02);
  });

  test("cleanup keeps pinned vertices in place and never merges two owners", () => {
    const compiled = exact(capsulePress({ overlap: PRESS_OVERLAP, gap: 0.2 })), store = sampleField(compiled, 1.5);
    const raw = meshStoreOwners(store, { gap: 0.2 }), out = cleanupMesh(store, raw, PREVIEW_CLEANUP);
    const key = (P, v) => `${P[3 * v]},${P[3 * v + 1]},${P[3 * v + 2]}`;
    const pinnedAt = (m) => { const set = new Map(); m.pinned.forEach((p, v) => { if (p) set.set(key(m.positions, v), m.vertOwner[v]); }); return set; };
    const before = pinnedAt(raw), after = pinnedAt(out);
    expect(before.size).toBeGreaterThan(0);
    expect(after).toEqual(before);
    // Each piece keeps its own shell: no triangle joins vertices of the two owners.
    for (let t = 0; t < out.indices.length; t += 3) {
      const o = out.vertOwner[out.indices[t]];
      expect(out.vertOwner[out.indices[t + 1]]).toBe(o);
      expect(out.vertOwner[out.indices[t + 2]]).toBe(o);
    }
    expect(out.ownerHeld.length).toBe(out.positions.length / 3);
  });

  test("owners: false is the old mesher on the new field", () => {
    const compiled = exact(SEAM_CASES.find((c) => c.name === "hand default gap 0").spec);
    const out = meshImplicit(compiled, 1.5, { tier: "preview", owners: false });
    const store = sampleField(compiled, 1.5);
    let ref = cleanupMesh(store, meshStore(store), PREVIEW_CLEANUP);
    ref = applySurfaceDetail(store, ref, compiled);
    expect(out.vertOwner).toBeUndefined();
    expect(out.indices.length).toBe(ref.indices.length);
    expect(Buffer.from(out.positions.buffer).equals(Buffer.from(ref.positions.buffer))).toBe(true);
  }, 60_000);
});
