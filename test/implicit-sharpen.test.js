// test/implicit-sharpen.test.js
// The sharpen pass (implicit solid design §4): run on the cleaned JS mesh, it puts vertices on
// the field's sharp edges and corners, keeps the mesh closed with no flipped or sliver triangle,
// leaves smooth fields and resolvable curves alone, and never places a point on a thin wall's
// other face. On the owner path it never moves a held, pinned or crease vertex, and every
// per-vertex array keeps the new length through untangle. The stage is not wired into
// meshImplicit yet.
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { implicitDistance } from "../src/framework/geometry/implicit/distance.js";
import { fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch } from "../src/framework/geometry/implicit/program.js";
import { untangle } from "../src/framework/geometry/implicit/crease.js";
import { applySurfaceDetail } from "../src/framework/geometry/implicit/detail.js";
import { buildMeshField } from "../src/framework/geometry/implicit/mesh-field-build.js";
import { meshDistance } from "../src/framework/geometry/implicit/mesh-field.js";
import { sharpenMesh, SHARP_TOL } from "../src/framework/geometry/implicit/sharpen.js";
import { jsStages, meshChecks, meshFieldOf } from "./helpers/implicit-stages.js";

const GRIDS = [0.6, 1.0];
let k;
beforeAll(async () => { k = await bootManifoldKernel({ quality: "preview", meshFields: true }); }, 60_000);

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

// Exactly one corner point at each true corner, within 0.005 mm of it, and no other.
function expectCorners(mesh, truth) {
  const cs = cornerVerts(mesh).map((v) => vert(mesh, v));
  expect(cs.length).toBe(truth.length);
  for (const p of cs) expect(Math.min(...truth.map((c) => dist(p, c)))).toBeLessThanOrEqual(0.005);
  for (const c of truth) expect(cs.some((p) => dist(p, c) <= 0.005)).toBe(true);
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
function run(root, edge) {
  const { store, cleaned } = jsStages({ root }, edge, { tier: "preview" });
  const stats = {};
  const mesh = sharpenMesh(store, cleaned, { stats });
  return { cleaned, mesh, stats, field: implicitDistance(root, { meshFieldOf }) };
}

// The mesh is closed, has no sliver, and no triangle the stage made or changed is flipped. The
// mesher's own flips (a few, all within a cell of a corner, left there by cleanup before this
// stage runs) stay as they were: no more of them than the cleaned mesh had.
function expectSound({ cleaned, mesh, field }) {
  const nv0 = cleaned.positions.length / 3, T = mesh.indices;
  const changed = (t) => [T[3 * t], T[3 * t + 1], T[3 * t + 2]].some((v) => v >= nv0 || mesh.sharp[v]);
  const all = meshChecks(mesh, field), made = meshChecks(mesh, field, { only: changed });
  expect(all.open).toBe(0);
  expect(all.nonManifold).toBe(0);
  expect(all.slivers).toBe(0);
  expect(made.flips).toBe(0);
  expect(all.flips).toBeLessThanOrEqual(meshChecks(cleaned, field).flips);
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
