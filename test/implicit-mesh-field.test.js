// test/implicit-mesh-field.test.js
import { describe, expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { buildMeshField, meshDistance } from "../src/framework/geometry/implicit/mesh-field.js";

let k; beforeAll(async () => { k = await bootManifoldKernel({ quality: "print" }); });
const fieldOf = (s) => buildMeshField(s.toMesh());
// A fixed-seed generator (Park–Miller), so every run tests the same points.
const lcg = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
// The exact signed distance to an axis-aligned box.
const boxSd = (p, lo, hi) => {
  const q = [0, 1, 2].map((a) => Math.max(lo[a] - p[a], p[a] - hi[a]));
  const out = Math.hypot(...q.map((v) => Math.max(v, 0)));
  return out > 0 ? out : Math.max(...q);
};

describe("meshDistance", () => {
  test("a box: the exact box distance, at faces, edges and corners", () => {
    const f = fieldOf(k.box({ min: [-10, -5, -2], max: [10, 5, 2] }));
    expect(meshDistance(f, 0, 0, 0)).toBeCloseTo(-2, 12);        // inside, nearest face
    expect(meshDistance(f, 0, 0, 5)).toBeCloseTo(3, 12);         // above a face
    expect(meshDistance(f, 13, 9, 0)).toBeCloseTo(5, 12);        // off an edge (3, 4)
    expect(meshDistance(f, 12, 7, 3)).toBeCloseTo(3, 12);        // off a corner (2, 2, 1)
    expect(meshDistance(f, 9.5, 4.5, 1.5)).toBeCloseTo(-0.5, 12); // inside, near a corner
  });
  test("zero on the surface: on a face, an edge and a corner", () => {
    const f = fieldOf(k.box({ min: [-10, -5, -2], max: [10, 5, 2] }));
    for (const p of [[0, 0, 2], [10, 5, 0], [10, 5, 2]]) expect(Object.is(meshDistance(f, ...p), 0)).toBe(true);
  });
  test("a concave L: the sign is right in the notch", () => {
    const L = k.box({ min: [0, 0, 0], max: [20, 20, 10] }).cut(k.box({ min: [10, 10, -1], max: [21, 21, 11] }));
    const f = fieldOf(L);
    // In the notch the two walls (x = 10, y = 10) are 2 away, nearer than their edge.
    expect(meshDistance(f, 12, 12, 5)).toBeCloseTo(2, 12);                   // in the notch: outside
    // Inside, (8, 8) projects off both walls, so the nearest point is on the notch's
    // concave edge at (10, 10): the edge pseudonormal must still read inside.
    expect(meshDistance(f, 8, 8, 5)).toBeCloseTo(-Math.hypot(2, 2), 12);     // inside, nearest the notch edge
  });
  test("a sphere: within the chord error of |p| − r, and never the wrong sign", () => {
    const f = fieldOf(k.sphere(10));
    for (let i = 0; i < 400; i++) {
      const a = i * 2.399963, t = -1 + (2 * i + 1) / 400, s = Math.sqrt(1 - t * t), r = 4 + (i % 13);
      const d = meshDistance(f, r * s * Math.cos(a), r * s * Math.sin(a), r * t);
      expect(Math.abs(d - (r - 10))).toBeLessThan(0.15);
      if (Math.abs(r - 10) > 0.2) expect(Math.sign(d)).toBe(Math.sign(r - 10));
    }
  });
  test("1-Lipschitz between nearby points", () => {
    const f = fieldOf(k.cylinder({ r: 6, h: 20 }));
    for (let i = 0; i < 200; i++) {
      const p = [(i % 7) - 3, ((i * 3) % 11) - 5, ((i * 5) % 23) - 11], q = [p[0] + 0.3, p[1] - 0.2, p[2] + 0.1];
      expect(Math.abs(meshDistance(f, ...p) - meshDistance(f, ...q))).toBeLessThanOrEqual(Math.hypot(0.3, 0.2, 0.1) + 1e-9);
    }
  });
  test("edge and corner pseudonormals are shared data, the same in every triangle that touches them", () => {
    for (const s of [k.box({ min: [0, 0, 0], max: [20, 20, 10] }).cut(k.box({ min: [10, 10, -1], max: [21, 21, 11] })), k.sphere(10)]) {
      const f = fieldOf(s), V = f.bvh.vertices, N = f.normals;
      const key = (t, c) => `${V[t * 9 + c * 3]},${V[t * 9 + c * 3 + 1]},${V[t * 9 + c * 3 + 2]}`;
      const edges = new Map(), corners = new Map();
      for (let t = 0; t < f.tris; t++) for (let c = 0; c < 3; c++) {
        const a = key(t, c), b = key(t, (c + 1) % 3), e = a < b ? a + "|" + b : b + "|" + a;
        const en = Array.from(N.subarray(t * 21 + 3 + c * 3, t * 21 + 6 + c * 3));
        const cn = Array.from(N.subarray(t * 21 + 12 + c * 3, t * 21 + 15 + c * 3));
        if (edges.has(e)) expect(en).toEqual(edges.get(e)); else edges.set(e, en);
        if (corners.has(a)) expect(cn).toEqual(corners.get(a)); else corners.set(a, cn);
      }
    }
  });
  test("bounds and digest", () => {
    const a = fieldOf(k.box({ min: [-1, -2, -3], max: [4, 5, 6] }));
    expect([a.min, a.max]).toEqual([[-1, -2, -3], [4, 5, 6]]);
    expect(a.digest).toBe(fieldOf(k.box({ min: [-1, -2, -3], max: [4, 5, 6] })).digest);
    expect(a.digest).not.toBe(fieldOf(k.box({ min: [-1, -2, -3], max: [4, 5, 7] })).digest);
  });
  test("an empty mesh, an open mesh and a mesh with one flipped triangle are refused", () => {
    expect(() => buildMeshField({ positions: new Float32Array(0) })).toThrow(/empty/);
    expect(() => buildMeshField({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) })).toThrow(/not closed/);
    const flipped = k.box({ min: [0, 0, 0], max: [1, 1, 1] }).toMesh().positions.slice();
    for (let i = 0; i < 3; i++) { const b = flipped[3 + i]; flipped[3 + i] = flipped[6 + i]; flipped[6 + i] = b; }
    let err;
    try { buildMeshField({ positions: flipped }); } catch (e) { err = e; }
    expect(err?.reason).toBe("open");
    expect(err?.message).toMatch(/not closed.*inconsistently wound/);
  });
  test("a NaN, an infinite or an overflowing point reads as +Infinity", () => {
    const f = fieldOf(k.box({ min: [0, 0, 0], max: [1, 1, 1] }));
    for (const x of [NaN, Infinity, 1e200]) expect(meshDistance(f, x, 0, 0)).toBe(Infinity);
  });
  test("two boxes that touch along an edge: the solid builds and every sign is right", () => {
    const lo1 = [0, 0, 0], hi1 = [1, 1, 1], lo2 = [1, 1, 0], hi2 = [2, 2, 1];
    const f = fieldOf(k.box({ min: lo1, max: hi1 }).union(k.box({ min: lo2, max: hi2 })));
    const rnd = lcg(12345);
    let n = 0;
    for (let i = 0; i < 3000; i++) {
      const p = [0.5 + rnd(), 0.5 + rnd(), -0.5 + 2 * rnd()]; // around the shared edge x = y = 1
      const a = Math.min(boxSd(p, lo1, hi1), boxSd(p, lo2, hi2));
      if (Math.abs(a) < 1e-6) continue;
      const d = meshDistance(f, ...p);
      expect(Math.sign(d)).toBe(Math.sign(a));
      if (a > 0) expect(d).toBeCloseTo(a, 6); // outside, the union's distance is the nearer box's
      n++;
    }
    expect(n).toBeGreaterThan(2000);
  });
  test("the L shape: every sign matches the analytic one, near the notch edge and saddle corners too", () => {
    const f = fieldOf(k.box({ min: [0, 0, 0], max: [20, 20, 10] }).cut(k.box({ min: [10, 10, -1], max: [21, 21, 11] })));
    const sd = (p) => Math.max(boxSd(p, [0, 0, 0], [20, 20, 10]), -boxSd(p, [10, 10, -1], [21, 21, 11]));
    const rnd = lcg(777);
    const centres = [[10, 10, 5], [10, 10, 10], [10, 10, 0]];
    let n = 0;
    for (let i = 0; i < 4000; i++) {
      const p = i % 4 === 0
        ? [-2 + 24 * rnd(), -2 + 24 * rnd(), -2 + 14 * rnd()]          // the whole part
        : centres[i % 4 - 1].map((c) => c - 1.5 + 3 * rnd());          // near the notch edge and the two saddle corners
      const a = sd(p);
      if (Math.abs(a) < 1e-6) continue;
      expect(Math.sign(meshDistance(f, ...p))).toBe(Math.sign(a));
      n++;
    }
    expect(n).toBeGreaterThan(3500);
  });
});
