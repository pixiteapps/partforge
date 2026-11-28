// test/implicit-sharpen.test.js
// The sharpen pass (implicit solid design §4): run on the cleaned JS mesh, it puts vertices on
// the field's sharp edges and corners, keeps the mesh closed with no flipped or sliver triangle,
// leaves smooth fields and resolvable curves alone, and never places a point on a thin wall's
// other face. On the owner path it never moves a held, pinned or crease vertex, and every
// per-vertex array keeps the new length through untangle. The stage is not wired into
// meshImplicit yet.
import { describe, test, expect, beforeAll } from "vitest";
import Module from "manifold-3d";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { manifoldFromWeldedMesh } from "../src/framework/geometry/mesh-build.js";
import { implicitDistance } from "../src/framework/geometry/implicit/distance.js";
import { fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch } from "../src/framework/geometry/implicit/program.js";
import { untangle } from "../src/framework/geometry/implicit/crease.js";
import { applySurfaceDetail } from "../src/framework/geometry/implicit/detail.js";
import { buildMeshField } from "../src/framework/geometry/implicit/mesh-field-build.js";
import { meshDistance } from "../src/framework/geometry/implicit/mesh-field.js";
import { sharpenMesh, SHARP_TOL, SHARP_ANGLE_COS } from "../src/framework/geometry/implicit/sharpen.js";
import { fieldFlips } from "../src/framework/geometry/implicit/sharpen-mesh.js";
import { compileImplicit } from "../src/framework/geometry/implicit/compile.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { jsStages, meshChecks, meshFieldOf, faceNormals } from "./helpers/implicit-stages.js";
import { vaseSpec } from "./fixtures/implicit-trees.js";

const GRIDS = [0.6, 1.0];
let k, wasm;
beforeAll(async () => {
  k = await bootManifoldKernel({ quality: "preview", meshFields: true });
  wasm = await Module();
  wasm.setup();
}, 60_000);

const leaf = (s) => ({ kind: "solid", solid: s });
const boxCorners = ([lo, hi]) => {
  const r = [];
  for (let i = 0; i < 8; i++) r.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
  return r;
};
const centre = (m, t) => {
  const a = 3 * m.indices[3 * t], b = 3 * m.indices[3 * t + 1], c = 3 * m.indices[3 * t + 2], P = m.positions;
  return [0, 1, 2].map((i) => (P[a + i] + P[b + i] + P[c + i]) / 3);
};
const vert = (m, v) => [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]];
const dist = (p, q) => Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
const nearCorner = (p, corners, r) => corners.some((c) => dist(p, c) <= r);
const inBox = (p, [lo, hi], g) => p.every((x, i) => x > lo[i] - g && x < hi[i] + g);
const pct = (xs, q) => { const s = Float64Array.from(xs).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const sharpVerts = (m) => { const r = []; for (let v = 0; v < m.sharp.length; v++) if (m.sharp[v]) r.push(v); return r; };
const cornerVerts = (m) => { const r = []; for (let v = 0; v < m.sharp.length; v++) if (m.sharp[v] === 2) r.push(v); return r; };
// The corners of an L profile in xz (the bracket: plate plus wall), at both ends in y.
const lCorners = (xz, [y0, y1]) => [y0, y1].flatMap((y) => xz.map(([x, z]) => [x, y, z]));

// Exactly one corner point at each true corner, within `tol` mm of it, and no other.
function expectCorners(mesh, truth, tol = 0.005) {
  const cs = cornerVerts(mesh).map((v) => vert(mesh, v));
  expect(cs.length).toBe(truth.length);
  for (const p of cs) expect(Math.min(...truth.map((c) => dist(p, c)))).toBeLessThanOrEqual(tol);
  for (const c of truth) expect(cs.some((p) => dist(p, c) <= tol)).toBe(true);
}

// The spike's cases (spike/exact-faces/sharpen.mjs): a solid `a` blended with a solid `b`, the
// blend's reach box, and the corners of the solids' boxes.
const SOLID_CASES = {
  "plate-edge": () => {
    const plate = [[-30, -20, 0], [30, 20, 6]];
    return { k: 8, a: k.box({ min: plate[0], max: plate[1] }), b: k.cylinder({ r: 8, h: 26 }).at([20, 0, 4]),
      reach: [[4, -16, -8], [36, 16, 38]], corners: boxCorners(plate), trueCorners: boxCorners(plate) };
  },
  "bracket-corner": () => {
    const plate = [[-30, -20, 0], [30, 20, 6]], wall = [[-30, -20, 0], [-24, 20, 30]];
    const a = k.box({ min: plate[0], max: plate[1] }).union(k.box({ min: wall[0], max: wall[1] }));
    return { k: 6, a, b: k.cylinder({ r: 5, h: 20 }).at([-14, 0, 4]),
      reach: [[-25, -11, -6], [-3, 11, 30]], corners: [...boxCorners(plate), ...boxCorners(wall)],
      trueCorners: lCorners([[-30, 0], [30, 0], [30, 6], [-24, 6], [-24, 30], [-30, 30]], [-20, 20]) };
  },
  "cylinder-side": () => {
    const boss = [[8, -4, 16], [22, 4, 24]];
    return { k: 4, a: k.cylinder({ r: 12, h: 40 }), b: k.box({ min: boss[0], max: boss[1] }),
      reach: [[3, -9, 11], [28, 9, 29]], corners: boxCorners(boss) };
  },
};

// The cleaned mesh, the sharpened one (corners on) and the full field.
function run(root, edge, tier = "preview") {
  const { store, cleaned } = jsStages({ root }, edge, { tier });
  const stats = {};
  const mesh = sharpenMesh(store, cleaned, { stats });
  return { cleaned, mesh, stats, field: implicitDistance(root, { meshFieldOf }) };
}

// The mesh is closed, no two of its vertices sit on top of each other, and no triangle the stage
// made or changed is flipped or a sliver. The mesher's own flips and slivers (a few, near a
// corner or on a knurl's creases, left there by cleanup before this stage runs) stay as they
// were: no more of them than the cleaned mesh had.
function expectSound({ cleaned, mesh, field }) {
  const nv0 = cleaned.positions.length / 3, T = mesh.indices, before = meshChecks(cleaned, field);
  const changed = (t) => [T[3 * t], T[3 * t + 1], T[3 * t + 2]].some((v) => v >= nv0 || mesh.sharp?.[v]);
  const all = meshChecks(mesh, field), made = meshChecks(mesh, field, { only: changed });
  expect(all.open).toBe(0);
  expect(all.nonManifold).toBe(0);
  expect(all.coincident).toBe(0);
  expect(made.flips).toBe(0);
  expect(made.slivers).toBe(0);
  expect(all.flips).toBeLessThanOrEqual(before.flips);
  expect(all.slivers).toBeLessThanOrEqual(before.slivers);
}

describe("sharpenMesh, edges and corners", () => {
  for (const edge of GRIDS) {
    test(`box: faces away from the corners are exact (grid ${edge})`, () => {
      const root = { kind: "box", size: [40, 30, 6] }, r = run(root, edge);
      expectSound(r);
      expect(r.stats.split + r.stats.moved).toBeGreaterThan(0);
      const corners = boxCorners([[-20, -15, -3], [20, 15, 3]]);
      let worst = 0;
      for (let t = 0; t < r.mesh.indices.length / 3; t++) {
        const p = centre(r.mesh, t);
        if (!nearCorner(p, corners, edge)) worst = Math.max(worst, Math.abs(r.field(...p)));
      }
      expect(worst).toBeLessThanOrEqual(0.005);
      expectCorners(r.mesh, corners);
      let worstAll = 0;
      for (let t = 0; t < r.mesh.indices.length / 3; t++) worstAll = Math.max(worstAll, Math.abs(r.field(...centre(r.mesh, t))));
      expect(worstAll).toBeLessThanOrEqual(0.02);
    }, 60_000);

    for (const name of Object.keys(SOLID_CASES)) {
      test(`${name}: centres away from the blend lie on the exact union (grid ${edge})`, () => {
        const c = SOLID_CASES[name](), root = { kind: "union", k: c.k, children: [leaf(c.a), leaf(c.b)] }, r = run(root, edge);
        expectSound(r);
        const exact = buildMeshField(c.a.union(c.b).toMesh()), ds = [];
        let worstAll = 0;
        for (let t = 0; t < r.mesh.indices.length / 3; t++) {
          const p = centre(r.mesh, t);
          if (inBox(p, c.reach, 1.5)) continue;
          const d = Math.abs(meshDistance(exact, ...p));
          worstAll = Math.max(worstAll, d);
          if (!nearCorner(p, c.corners, edge)) ds.push(d);
        }
        if (c.trueCorners) {
          // Away from the blend, corners included, every centre is on the exact union.
          expectCorners(r.mesh, c.trueCorners);
          expect(worstAll).toBeLessThanOrEqual(0.02);
        }
        // The cylinder's facets are not resolved at a 1.0 mm grid: its side's own chord error
        // (not a sharp edge) holds this case's 99th percentile at about 0.022 there.
        const limit = name === "cylinder-side" && edge === 1.0 ? 0.025 : 0.015;
        expect(pct(ds, 0.99)).toBeLessThanOrEqual(limit);
        if (name === "cylinder-side") {
          // Edge points away from the blend lie on a rim circle; the facets are not sharpened.
          for (const v of sharpVerts(r.mesh)) {
            const p = vert(r.mesh, v);
            if (inBox(p, c.reach, 1.5)) continue;
            const dr = Math.sqrt(p[0] * p[0] + p[1] * p[1]) - 12, rim = Math.min(Math.abs(p[2]), Math.abs(p[2] - 40));
            expect(Math.sqrt(dr * dr + rim * rim)).toBeLessThanOrEqual(0.05);
          }
        }
      }, 120_000);
    }

    test(`smooth: a blend of two spheres has no candidate (grid ${edge})`, () => {
      const root = { kind: "union", k: 6, children: [{ kind: "sphere", r: 10, at: [-6, 0, 0] }, { kind: "sphere", r: 10, at: [6, 0, 0] }] };
      const r = run(root, edge);
      expect(r.mesh).toBe(r.cleaned);
    }, 60_000);

    test(`curved-crease: points lie on the sphere-cylinder circle (grid ${edge})`, () => {
      const root = { kind: "intersect", k: 0, children: [{ kind: "sphere", r: 12 }, { kind: "cylinder", r: 8, h: 40 }] };
      const r = run(root, edge), z0 = Math.sqrt(80);
      expectSound(r);
      const vs = sharpVerts(r.mesh);
      expect(vs.length).toBeGreaterThan(0);
      for (const v of vs) {
        const p = vert(r.mesh, v);
        expect(Math.abs(r.field(...p))).toBeLessThanOrEqual(SHARP_TOL * edge);
        const dr = Math.sqrt(p[0] * p[0] + p[1] * p[1]) - 8, dz = Math.abs(p[2]) - z0;
        expect(Math.sqrt(dr * dr + dz * dz)).toBeLessThanOrEqual(0.02);
      }
    }, 60_000);
  }

  test("thin-wall: no point is placed on the wall's other face (grid 1.0)", () => {
    const edge = 1.0;
    const shell = { kind: "onion", t: 0.8, child: { kind: "box", size: [30, 30, 30] } };
    const root = { kind: "intersect", children: [shell, { kind: "halfspace", normal: "z", offset: 5 }] };
    const r = run(root, edge);
    expectSound(r);
    for (const v of sharpVerts(r.mesh)) {
      const p = vert(r.mesh, v);
      expect(Math.abs(r.field(...p))).toBeLessThanOrEqual(SHARP_TOL * edge);
      if (r.mesh.sharp[v] === 2) continue;   // a corner point lists no plane vertex
      // A moved end lists itself as one of its two plane vertices: the other is the one to test.
      const others = [r.mesh.sharpPlanes[2 * v], r.mesh.sharpPlanes[2 * v + 1]].filter((w) => w !== v);
      expect(others.length).toBeGreaterThan(0);
      for (const w of others) expect(dist(p, vert(r.mesh, w))).toBeLessThanOrEqual(1.5 * edge);
    }
  }, 60_000);

  // A contact root for pose drag: test/implicit-crease.test.js's first fixture (two capsules
  // pressed 1.2 into each other), each in its own frame, plus a box child whose sharp edges the
  // stage cuts. With a gap the owner path pins vertices and cuts no crease; at gap 0 it cuts
  // creases and pins none, so both are run. Its field, frames resolved, for meshChecks.
  const posed = (gap) => ({
    frames: { fa: { at: [-7.4, 0, 0] }, fb: { at: [7.4, 0, 0], rotate: [{ axis: "y", deg: 6 }] } },
    root: {
      kind: "contact", gap, bulge: 0, children: [
        { kind: "capsule", a: [0, 0, -20], b: [0, 0, 20], r: 8, frame: "fa", label: "a" },
        { kind: "capsule", a: [0, 0, -20], b: [0, 0, 20], r: 8, frame: "fb", label: "b" },
        { kind: "box", size: [36, 24, 6], at: [0, 0, 26], label: "c" },
      ],
    },
  });
  const fieldOf = (compiled) => {
    const prog = emitProgram(compiled, fullDecision(compiled));
    const X = new Float64Array(1), Y = new Float64Array(1), Z = new Float64Array(1), out = new Float64Array(1);
    return (x, y, z) => { X[0] = x; Y[0] = y; Z[0] = z; evalBatch(prog, compiled.textures, X, Y, Z, out); return out[0]; };
  };
  const OWNER_ARRAYS = ["vertOwner", "ownerHeld", "pinned", "crease", "vertLeaf", "sharp"];

  for (const edge of GRIDS) for (const gap of [0, 0.05]) {
    test(`posed: held, pinned and crease vertices stay; every array keeps the length (gap ${gap}, grid ${edge})`, () => {
      const { store, cleaned, compiled } = jsStages(posed(gap), edge, { tier: "preview" });
      expect(compiled.ownerRoot).toBeGreaterThanOrEqual(0);
      const nv0 = cleaned.positions.length / 3, kept = [];
      for (let v = 0; v < nv0; v++) if (cleaned.crease[v] || cleaned.pinned[v] || cleaned.ownerHeld[v]) kept.push(v);
      expect(kept.length).toBeGreaterThan(0);
      expect((gap === 0 ? cleaned.crease : cleaned.pinned).some((x) => x)).toBe(true);
      const sharpened = sharpenMesh(store, cleaned);
      expect(sharpened).not.toBe(cleaned);
      expect(cornerVerts(sharpened).length).toBeGreaterThan(0);
      const nv = sharpened.positions.length / 3;
      for (const f of OWNER_ARRAYS) expect(sharpened[f].length, f).toBe(nv);
      expect(sharpened.normals.length).toBe(3 * nv);
      // By index, none of these held, pinned or crease vertices moved.
      for (const v of kept) expect(vert(sharpened, v)).toEqual(vert(cleaned, v));
      // A new vertex takes its evaluating end's owner, and is not held, pinned or crease.
      for (let v = nv0; v < nv; v++) {
        expect(sharpened.ownerHeld[v] + sharpened.pinned[v] + sharpened.crease[v]).toBe(0);
        expect(sharpened.vertOwner[v]).toBeGreaterThanOrEqual(0);
      }
      // A crease vertex is never an end of an edge candidate: no edge point joins its plane.
      for (const v of sharpVerts(sharpened)) for (let j = 0; j < 2; j++) {
        const w = sharpened.sharpPlanes[2 * v + j];
        if (w >= 0) expect(sharpened.crease[w]).toBe(0);
      }
      const field = fieldOf(compiled), base = meshChecks(untangle(store, cleaned), field);
      const done = untangle(store, sharpened), n = done.positions.length / 3;
      for (const f of OWNER_ARRAYS) expect(done[f].length, f).toBe(n);
      expect(done.sharpPlanes.length).toBe(2 * n);
      for (const w of done.sharpPlanes) expect(w >= -1 && w < n).toBe(true);
      expect(done.normals.length).toBe(3 * n);
      const checks = meshChecks(done, field);
      expect(checks.open).toBe(0);
      expect(checks.slivers).toBeLessThanOrEqual(base.slivers);
      expect(checks.flips).toBeLessThanOrEqual(base.flips);
    }, 120_000);
  }

  test("detail: a noise detail on a sharpened box meshes closed", () => {
    const spec = { root: { kind: "box", size: [40, 30, 6] }, detail: [{ kind: "noise", amplitude: 0.1, wavelength: 1.5 }] };
    const { store, cleaned, compiled } = jsStages(spec, 1.0, { tier: "preview" });
    const sharpened = sharpenMesh(store, cleaned);
    expect(cornerVerts(sharpened).length).toBe(8);
    const out = applySurfaceDetail(store, sharpened, compiled);
    expect(out.positions.length).toBe(out.normals.length);
    expect(meshChecks(out, () => 0, { only: () => false }).open).toBe(0);
  }, 60_000);

  test("every per-vertex array grows to the new vertex count", () => {
    const r = run({ kind: "box", size: [40, 30, 6] }, 1.0), nv = r.mesh.positions.length / 3;
    expect(nv).toBeGreaterThan(r.cleaned.positions.length / 3);
    expect(r.mesh.normals.length).toBe(3 * nv);
    expect(r.mesh.vertLeaf.length).toBe(nv);
    expect(r.mesh.sharp.length).toBe(nv);
    expect(r.mesh.sharpPlanes.length).toBe(2 * nv);
  }, 60_000);
});

// The kernel builds a solid from the sharpened mesh as k.implicit does (manifold-backend.js: one
// welded mesh, one original ID): it is a valid manifold with every triangle kept.
function expectSolid(mesh) {
  const m = manifoldFromWeldedMesh(wasm, mesh.positions, mesh.indices, wasm.Manifold.reserveIDs(1));
  try {
    expect(m.status()).toBe("NoError");
    expect(m.numTri()).toBe(mesh.indices.length / 3);
    expect(m.volume()).toBeGreaterThan(0);
  } finally { m.delete?.(); }
}

const KNURL = "vec2 z = normalize(p.xy); for (int i = 0; i < 4; i++) { z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y); } "
  + "float c = cos(p.z * 1.3); float s = sin(p.z * 1.3); return max(z.x * c - z.y * s, z.x * c + z.y * s);";
// spike/solid-field/run.mjs's d-knurl tree (commit 257500e2), over a solid leaf.
const knurl = (r = 12, h = 30) => ({ kind: "displace", amount: 0.7, child: leaf(k.cylinder({ r, h })), by: { expr: KNURL } });
// spike/exact-faces/border.mjs's cage-post case: a post blended into a subdivision body's underside.
const cagePost = () => {
  const c = k.cage({ box: { size: [44, 24, 22], segs: [2, 1, 1] } });
  c.extrude("+x:0,0", { by: 14, scale: 0.55 });
  return { kind: "union", k: 7, children: [leaf(k.subdiv(c).at([0, 0, 24])), leaf(k.cylinder({ r: 5, h: 22 }).at([-6, 0, 0]))] };
};
const solidRoot = (name) => { const c = SOLID_CASES[name](); return { kind: "union", k: c.k, children: [leaf(c.a), leaf(c.b)] }; };

describe("sharpenMesh, hard cases", () => {
  test("fade: where the plate's top edge at x = 30 runs into the blend, points stay on the field and no triangle is stretched", () => {
    const edge = 0.6, c = SOLID_CASES["plate-edge"](), r = run(solidRoot("plate-edge"), edge);
    expectSound(r);
    // Near the line x = 30, z = 6, inside the blend's reach box.
    const nearEdge = (p) => inBox(p, c.reach, 0) && Math.sqrt((p[0] - 30) ** 2 + (p[2] - 6) ** 2) <= 2 * edge;
    const m = r.mesh, T = m.indices;
    let n = 0;
    for (const v of sharpVerts(m)) {
      const p = vert(m, v);
      if (!nearEdge(p)) continue;
      n++;
      expect(Math.abs(r.field(...p))).toBeLessThanOrEqual(SHARP_TOL * edge);
    }
    expect(n).toBeGreaterThan(0);
    let longest = 0;
    for (let t = 0; t < T.length / 3; t++) {
      const vs = [T[3 * t], T[3 * t + 1], T[3 * t + 2]];
      if (!vs.some((v) => m.sharp[v] && nearEdge(vert(m, v)))) continue;
      for (let j = 0; j < 3; j++) longest = Math.max(longest, dist(vert(m, vs[j]), vert(m, vs[(j + 1) % 3])));
    }
    expect(longest).toBeLessThanOrEqual(3 * edge);
  }, 120_000);

  // The density rule: a texture finer than the grid makes half its edges candidates. Its leaf
  // program is skipped whole, so the knurl stays as the mesher left it, and the stage costs little.
  test("knurl: a displaced cylinder is too dense to sharpen; the stage skips it cheaply (grid 0.6)", () => {
    const edge = 0.6, spec = { root: knurl() };
    jsStages(spec, edge, { tier: "preview" });   // warm: the solid's mesh field and the JIT
    const t0 = performance.now(), { store, cleaned } = jsStages(spec, edge, { tier: "preview" }), t1 = performance.now();
    const stats = {}, mesh = sharpenMesh(store, cleaned, { stats }), t2 = performance.now();
    expect(stats.dense).toBeGreaterThan(0);
    expect(mesh.sharp ? sharpVerts(mesh).length : 0).toBeLessThanOrEqual(0.001 * cleaned.positions.length / 3);
    expectSound({ cleaned, mesh, field: implicitDistance(spec.root, { meshFieldOf }) });
    expect(mesh.indices.length).toBeLessThanOrEqual(1.4 * cleaned.indices.length);
    expect(t2 - t1).toBeLessThan(0.25 * (t1 - t0));
  }, 240_000);

  // At the print grid the knurl's ridges are resolved: it is not dense and is sharpened in full.
  // Two splits on unrelated edges, mirror images across x = y on either side of a ridge on the
  // top cap, once converged onto one point (three such pairs); SHARP_APART refuses the later.
  test("knurl at print 0.3: sharpened in full, sound, no two vertices at one position", () => {
    const r = run(knurl(), 0.3, "print");
    expect(r.stats.dense).toBe(0);
    expect(r.stats.apart).toBeGreaterThan(0);
    expect(cornerVerts(r.mesh).length).toBeGreaterThan(0);
    expectSound(r);
  }, 600_000);

  // The density rule's floor: a small part has a high share of crease edges but few of them.
  for (const edge of GRIDS) {
    test(`small: cubes 3 to 6 cells wide keep all 8 corners (grid ${edge})`, () => {
      for (const n of [3, 4, 4.5, 5, 6]) {
        const h = (n * edge) / 2, r = run({ kind: "box", size: [2 * h, 2 * h, 2 * h] }, edge);
        expectSound(r);
        expect(r.stats.dense, `${n} cells`).toBe(0);
        expectCorners(r.mesh, boxCorners([[-h, -h, -h], [h, h, h]]));
      }
    }, 120_000);
  }

  // Plain boxes 3 to 12 cells wide, placed three ways against the grid. Every one gets all 8
  // corners. Four used to miss one ("0.6 8 1", "0.6 9 1", "1 3 1", "1 4 1": the mesher's bevel
  // joined a face vertex straight to a crease point there). Since cleanup merges the vertex
  // clusters on a face that lies on a grid plane (0.207), that join is gone.
  const OFFSETS = [[0, 0, 0], [0.37, 0.11, 0.73], [0.5, 0.5, 0.5]];
  for (const edge of GRIDS) {
    test(`sweep: boxes 3 to 12 cells wide get all 8 corners, wherever the grid falls (grid ${edge})`, () => {
      for (let n = 3; n <= 12; n += 0.5) OFFSETS.forEach((o, i) => {
        const h = (n * edge) / 2, at = o.map((x) => x * edge), r = run({ kind: "box", size: [2 * h, 2 * h, 2 * h], at }, edge);
        const name = `${edge} ${n} ${i}`, truth = boxCorners([[-h, -h, -h], [h, h, h]]).map((c) => c.map((x, k) => x + at[k]));
        expectSound(r);
        const cs = cornerVerts(r.mesh).map((v) => vert(r.mesh, v));
        for (const p of cs) expect(Math.min(...truth.map((c) => dist(p, c))), name).toBeLessThanOrEqual(0.005);
        expect(cs.length, name).toBe(8);
      });
    }, 120_000);
  }

  // Two shapes the final review of 0.206 saw find 7 of 8 corners. Both find 8 now.
  // The cut onion box is the thin-wall shape. Its outer edges and corners are rounded (an onion
  // offsets the box outward by a distance), so its 8 sharp corners are on the inner box: the 4 at
  // the bottom and the 4 where the cut meets the inner box's upright edges. The cut keeps z ≤ 5,
  // so the inner box's top (z = 14.2) is gone, and those 4 sit at z = 5.
  // The bent box is a 10 x 10 x 40 box bent around z at radius 30. Its 8 corners are the box's
  // corners carried by the bend.
  const square = (h, zs) => zs.flatMap((z) => [[-h, -h, z], [h, -h, z], [-h, h, z], [h, h, z]]);
  const bent = ([x, y, z], R) => { const rho = R - x, a = z / R; return [R - rho * Math.cos(a), y, rho * Math.sin(a)]; };
  for (const edge of GRIDS) for (const tier of ["preview", "print"]) {
    test(`cut onion box: all 8 inner corners (grid ${edge}, ${tier})`, () => {
      const shell = { kind: "onion", t: 0.8, child: { kind: "box", size: [30, 30, 30] } };
      const r = run({ kind: "intersect", children: [shell, { kind: "halfspace", normal: "z", offset: 5 }] }, edge, tier);
      expectSound(r);
      expectCorners(r.mesh, square(14.2, [-14.2, 5]));
    }, 120_000);
    test(`bent box: all 8 corners (grid ${edge}, ${tier})`, () => {
      const r = run({ kind: "bend", radius: 30, child: { kind: "box", size: [10, 10, 40] } }, edge, tier);
      expectSound(r);
      expectCorners(r.mesh, square(5, [-20, 20]).map((c) => bent(c, 30)));
    }, 120_000);
  }

  // A corner point is solved on its three faces, and kept only where three faces meet. A curved
  // sharp edge (a hole's rim, a cut torus's rims) has two faces: two tangent planes of one of them
  // and a plane of the other meet beside the rim, which used to make a stray corner point there
  // (box minus cylinder 4 at 1.0 mm, 12 corner points in all; cut torus 2 at 1.0 mm print).
  for (const edge of GRIDS) {
    test(`hole: a box minus a through cylinder has its 8 box corners and none on the rims (grid ${edge})`, () => {
      const root = { kind: "subtract", k: 0, children: [{ kind: "box", size: [30, 20, 10] }, { kind: "cylinder", h: 30, r: 4 }] };
      const r = run(root, edge);
      expectSound(r);
      expectCorners(r.mesh, boxCorners([[-15, -10, -5], [15, 10, 5]]));
    }, 120_000);
    for (const tier of ["preview", "print"]) {
      test(`torus: a torus cut by a half-space has no corner point (grid ${edge}, ${tier})`, () => {
        const root = { kind: "intersect", children: [{ kind: "torus", R: 12, r: 4 }, { kind: "halfspace", normal: "z", offset: 1.3 }] };
        const r = run(root, edge, tier);
        expectSound(r);
        expect(r.mesh.sharp ? sharpVerts(r.mesh).length : 0).toBeGreaterThan(0);
        expect(cornerVerts(r.mesh).length).toBe(0);
      }, 120_000);
    }
  }

  // A pyramid's tip, where 4 or 6 flat faces meet: a box cut by a floor and n faces leaning
  // `lean` degrees from upright, turned `rot` radians about z, through a tip at (0, 0, H). With
  // more than three faces at a point, the three-face solve often cannot take a step. The
  // candidate's start point then stands if the faces read round it meet there and pass the same
  // field and angle tests. Of these 36 tips, 2 lie more than 0.01 mm from every vertex, the same
  // 2 as before the corner solve was added (it had made 11 of them).
  const pyramid = (n, lean, rot, H) => {
    const s = Math.sin(((90 - lean) * Math.PI) / 180), c = Math.cos(((90 - lean) * Math.PI) / 180), sides = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (2 * Math.PI * i) / n;
      sides.push({ kind: "halfspace", normal: [s * Math.cos(a), s * Math.sin(a), c], offset: H * c });
    }
    return { kind: "intersect", children: [{ kind: "box", size: [40, 40, 40] }, { kind: "halfspace", normal: [0, 0, -1], offset: 0 }, ...sides] };
  };
  const tipGap = (mesh, H) => {
    let best = Infinity;
    for (let v = 0; v < mesh.positions.length / 3; v++) best = Math.min(best, dist(vert(mesh, v), [0, 0, H]));
    return best;
  };
  test("pyramid: of 36 tips where 4 or 6 faces meet, no more than 2 are missed (grid 0.6)", () => {
    const missed = [];
    for (const n of [4, 6]) for (const lean of [25, 35, 50]) for (const rot of [0, 0.3, 0.7]) for (const H of [8, 10.17]) {
      const r = run(pyramid(n, lean, rot, H), 0.6);
      expectSound(r);
      const gap = tipGap(r.mesh, H);
      if (gap > 0.01) missed.push(`${n} faces, lean ${lean}, rot ${rot}, H ${H}: ${gap.toFixed(3)} mm`);
    }
    expect(missed.length, missed.join("; ")).toBeLessThanOrEqual(2);
  }, 240_000);
  for (const edge of GRIDS) {
    test(`pyramid: a 4-faced tip leaning 35° and turned 0.3 rad gets a vertex on its tip (grid ${edge})`, () => {
      for (const H of [8, 10.17]) {
        const r = run(pyramid(4, 35, 0.3, H), edge);
        expectSound(r);
        expect(tipGap(r.mesh, H), `H ${H}`).toBeLessThanOrEqual(0.005);
      }
    }, 120_000);
  }

  // The vase (test/implicit-cleanup.test.js's tier case, 1.2 mm): every corner point it keeps
  // has three faces of the field within 0.05 cells of it. Four used to sit 0.017 to 0.139 mm
  // beside a curved crease, where only two faces meet. It keeps none now, so the count is pinned
  // too: a new corner point here must be looked at, not passed by the loop.
  test("vase: every corner point has three faces of the field around it (grid 1.2)", () => {
    const vase = vaseSpec(), compiled = compileImplicit(vase.spec, { images: vase.images }), edge = 1.2;
    const store = evaluateLeaves(planLeaves(compiled, edge));
    const mesh = sharpenMesh(store, cleanupMesh(store, meshStore(store), { ...PREVIEW_CLEANUP, decimateFrac: 0 }));
    const field = (x, y, z) => evalReference(compiled, x, y, z);
    expect(cornerVerts(mesh).length, "corner points").toBe(0);
    for (const v of cornerVerts(mesh)) {
      const p = vert(mesh, v);
      expect(faceNormals(field, p, 0.05 * edge, SHARP_ANGLE_COS).length, `corner at ${p.map((x) => x.toFixed(3))}`).toBeGreaterThanOrEqual(3);
    }
  }, 240_000);

  test("small: a 4 mm boss on a plate keeps its own edges and corners (grid 1.0)", () => {
    const root = { kind: "union", k: 0, children: [{ kind: "box", size: [40, 30, 6] }, { kind: "box", size: [4, 4, 4], at: [0, 0, 5] }] };
    const r = run(root, 1.0);
    expectSound(r);
    expect(r.stats.dense).toBe(0);
    const cs = cornerVerts(r.mesh).map((v) => vert(r.mesh, v));
    for (const c of boxCorners([[-2, -2, 7], [2, 2, 7]]).slice(0, 4)) expect(cs.some((p) => dist(p, c) <= 0.005)).toBe(true);
    // Sharp points on each of the boss's four upright edges, away from its ends.
    for (const [x, y] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      expect(sharpVerts(r.mesh).some((v) => { const p = vert(r.mesh, v); return Math.hypot(p[0] - x, p[1] - y) < 0.05 && p[2] > 3.5 && p[2] < 6.5; })).toBe(true);
    }
  }, 120_000);

  test("knob: a small knurled knob stays sound, skipped or not (grid 0.6)", () => {
    const big = run(knurl(6, 8), 0.6);   // dense: 11,748 candidates
    expect(big.stats.dense).toBeGreaterThan(0);
    expectSound(big);
    const tiny = run(knurl(0.6, 1), 0.6);   // under the floor: tried
    expect(tiny.stats.dense).toBe(0);
    expectSound(tiny);
  }, 120_000);

  test("dense: a knurled solid does not stop a plain box edge far from it being sharpened (grid 0.6)", () => {
    const root = { kind: "union", children: [knurl(), leaf(k.box({ min: [30, -10, 0], max: [50, 10, 10] }))] }, r = run(root, 0.6);
    expectSound(r);
    expect(r.stats.dense).toBeGreaterThan(0);
    expectCorners(r.mesh, boxCorners([[30, -10, 0], [50, 10, 10]]));
    for (const v of sharpVerts(r.mesh)) expect(vert(r.mesh, v)[0]).toBeGreaterThan(29);
  }, 240_000);

  test("cage: on a subdivision body, sharp points only at the post's bottom rim (grid 0.6)", () => {
    const edge = 0.6, r = run(cagePost(), edge);
    expectSound(r);
    for (const v of sharpVerts(r.mesh)) {
      const p = vert(r.mesh, v), dr = Math.sqrt((p[0] + 6) ** 2 + p[1] ** 2) - 5;
      expect(Math.sqrt(dr * dr + p[2] * p[2])).toBeLessThanOrEqual(2 * edge);
    }
  }, 240_000);

  test("offset: a shrunk box keeps its 8 corners; a grown box has round edges and no sharp point (grid 0.6)", () => {
    const edge = 0.6, box = () => leaf(k.box({ min: [-20, -15, -10], max: [20, 15, 10] }));
    const shrunk = run({ kind: "offset", d: -2, child: box() }, edge);
    expectSound(shrunk);
    expectCorners(shrunk.mesh, boxCorners([[-18, -13, -8], [18, 13, 8]]), 0.01);
    const grown = run({ kind: "offset", d: 2, child: box() }, edge);
    expect(grown.mesh.sharp ? sharpVerts(grown.mesh).length : 0).toBe(0);
  }, 120_000);

  test("print: the plate at the print tier's cleanup is sound and exact away from the blend (grid 0.3)", () => {
    const edge = 0.3, c = SOLID_CASES["plate-edge"](), r = run(solidRoot("plate-edge"), edge, "print");
    expectSound(r);
    const exact = buildMeshField(c.a.union(c.b).toMesh()), ds = [];
    for (let t = 0; t < r.mesh.indices.length / 3; t++) {
      const p = centre(r.mesh, t);
      if (!inBox(p, c.reach, 1.5) && !nearCorner(p, c.corners, edge)) ds.push(Math.abs(meshDistance(exact, ...p)));
    }
    expect(pct(ds, 0.99)).toBeLessThanOrEqual(0.01);
  }, 240_000);

  for (const name of ["plate-edge", "bracket-corner", "knurl"]) {
    test(`kernel: the sharpened ${name} builds as a solid (grid 0.6)`, () => {
      const r = run(name === "knurl" ? knurl() : solidRoot(name), 0.6);
      expectSolid(r.mesh);
    }, 240_000);
  }
});

describe("sharpenMesh, the flip memo", () => {
  // In the stage, dropping one candidate for a field flip can turn a second one's move into a
  // split. This drives fieldFlips with that second candidate alone: the same candidate touches the
  // triangle in both rounds, first as a move, then as a split, so its final form changed and it
  // must be read again.
  test("a triangle touched by the same candidate in a different way is read again", () => {
    const { store, cleaned } = jsStages({ root: { kind: "box", size: [40, 30, 6] } }, 1.0, { tier: "preview" });
    let near = 0;
    for (let v = 0; v < cleaned.positions.length / 3; v++) if (dist(vert(cleaned, v), [0, 0, 3]) < dist(vert(cleaned, near), [0, 0, 3])) near = v;
    const VL0 = new Int32Array(4).fill(cleaned.vertLeaf[near]), T = [0, 1, 2], ekey = (a, b) => (a < b ? 4 * a + b : 4 * b + a);
    const c = {}, memo = new Map(), opts = { VL0, T, ekey, edge: 1.0 };
    // Round r: c moved end 0; the triangle lies on the top face, facing up.
    const moved = { P: [0, 0, 3, 1, 0, 3, 0, 1, 3], splitOf: new Map(), touched: new Map([[0, [c]]]), how: new Map([[0, [0]]]) };
    expect(fieldFlips(store, moved, [0], opts, memo)).toEqual([]);
    // Round r + 1: c splits edge (1, 2) instead, at a point that folds one part over.
    const split = { P: [0, 0, 3, 1, 0, 3, 0, 1, 3, -1, -1, 3], splitOf: new Map([[ekey(1, 2), 3]]), touched: new Map([[0, [c]]]),
      how: new Map([[0, [-1]]]) };
    expect(fieldFlips(store, split, [0], opts, memo)).toEqual([0]);
    // The same change again is taken from the memo.
    expect(fieldFlips(store, { ...split, P: [] }, [0], opts, memo)).toEqual([0]);
  }, 60_000);
});
