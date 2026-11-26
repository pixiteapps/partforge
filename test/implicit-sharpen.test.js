// test/implicit-sharpen.test.js
// The sharpen pass, edges only (implicit solid design §4): run on the cleaned JS mesh, it puts
// vertices on the field's sharp edges, keeps the mesh closed with no flipped or sliver triangle,
// leaves smooth fields and resolvable curves alone, and never places a point on a thin wall's
// other face. The stage is not wired into meshImplicit yet.
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { implicitDistance } from "../src/framework/geometry/implicit/distance.js";
import { buildMeshField } from "../src/framework/geometry/implicit/mesh-field-build.js";
import { meshDistance } from "../src/framework/geometry/implicit/mesh-field.js";
import { sharpenMesh, SHARP_TOL } from "../src/framework/geometry/implicit/sharpen.js";
import { jsStages, meshChecks, meshFieldOf } from "./helpers/implicit-stages.js";

const GRIDS = [0.6, 1.0];
let k;
beforeAll(async () => { k = await bootManifoldKernel({ quality: "preview", meshFields: true }); }, 60_000);

const leaf = (s) => ({ kind: "solid", solid: s });
const boxCorners = ([lo, hi]) => { const r = []; for (let i = 0; i < 8; i++) r.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]); return r; };
const centre = (m, t) => [0, 1, 2].map((i) => (m.positions[3 * m.indices[3 * t] + i] + m.positions[3 * m.indices[3 * t + 1] + i] + m.positions[3 * m.indices[3 * t + 2] + i]) / 3);
const vert = (m, v) => [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]];
const dist = (p, q) => Math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);
const nearCorner = (p, corners, r) => corners.some((c) => dist(p, c) <= r);
const inBox = (p, [lo, hi], g) => p.every((x, i) => x > lo[i] - g && x < hi[i] + g);
const pct = (xs, q) => { const s = Float64Array.from(xs).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const sharpVerts = (m) => { const r = []; for (let v = 0; v < m.sharp.length; v++) if (m.sharp[v]) r.push(v); return r; };

// The spike's cases (spike/exact-faces/sharpen.mjs): a solid `a` blended with a solid `b`, the
// blend's reach box, and the corners of the solids' boxes.
const SOLID_CASES = {
  "plate-edge": () => {
    const plate = [[-30, -20, 0], [30, 20, 6]];
    return { k: 8, a: k.box({ min: plate[0], max: plate[1] }), b: k.cylinder({ r: 8, h: 26 }).at([20, 0, 4]), reach: [[4, -16, -8], [36, 16, 38]], corners: boxCorners(plate) };
  },
  "bracket-corner": () => {
    const plate = [[-30, -20, 0], [30, 20, 6]], wall = [[-30, -20, 0], [-24, 20, 30]];
    return { k: 6, a: k.box({ min: plate[0], max: plate[1] }).union(k.box({ min: wall[0], max: wall[1] })), b: k.cylinder({ r: 5, h: 20 }).at([-14, 0, 4]),
      reach: [[-25, -11, -6], [-3, 11, 30]], corners: [...boxCorners(plate), ...boxCorners(wall)] };
  },
  "cylinder-side": () => {
    const boss = [[8, -4, 16], [22, 4, 24]];
    return { k: 4, a: k.cylinder({ r: 12, h: 40 }), b: k.box({ min: boss[0], max: boss[1] }), reach: [[3, -9, 11], [28, 9, 29]], corners: boxCorners(boss) };
  },
};

// The cleaned mesh, the sharpened one and the full field.
function run(root, edge) {
  const { store, cleaned } = jsStages({ root }, edge, { tier: "preview", kernel: k });
  const stats = {};
  const mesh = sharpenMesh(store, cleaned, { corners: false, stats });
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
  expect(all.slivers).toBe(0);
  expect(made.flips).toBe(0);
  expect(all.flips).toBeLessThanOrEqual(meshChecks(cleaned, field).flips);
}

describe("sharpenMesh, edges", () => {
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
    }, 60_000);

    for (const name of Object.keys(SOLID_CASES)) {
      test(`${name}: centres away from the blend lie on the exact union (grid ${edge})`, () => {
        const c = SOLID_CASES[name](), root = { kind: "union", k: c.k, children: [leaf(c.a), leaf(c.b)] }, r = run(root, edge);
        expectSound(r);
        const exact = buildMeshField(c.a.union(c.b).toMesh()), ds = [];
        for (let t = 0; t < r.mesh.indices.length / 3; t++) {
          const p = centre(r.mesh, t);
          if (!inBox(p, c.reach, 1.5) && !nearCorner(p, c.corners, edge)) ds.push(Math.abs(meshDistance(exact, ...p)));
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
    const root = { kind: "intersect", children: [{ kind: "onion", t: 0.8, child: { kind: "box", size: [30, 30, 30] } }, { kind: "halfspace", normal: "z", offset: 5 }] };
    const r = run(root, edge);
    expectSound(r);
    for (const v of sharpVerts(r.mesh)) {
      const p = vert(r.mesh, v);
      expect(Math.abs(r.field(...p))).toBeLessThanOrEqual(SHARP_TOL * edge);
      for (const w of [r.mesh.sharpPlanes[2 * v], r.mesh.sharpPlanes[2 * v + 1]]) expect(dist(p, vert(r.mesh, w))).toBeLessThanOrEqual(1.5 * edge);
    }
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
