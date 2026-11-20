import { it, expect } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/index.js";
import { subdivide } from "../src/framework/geometry/subdiv/surface.js";
import { selfIntersections } from "../src/framework/geometry/subdiv/self-intersect.js";

it("finds nothing on a clean body", () => {
  const c = createCage({ box: { size: [40, 20, 20], segs: [2, 1, 1] } });
  c.extrude("+x:0,0", { by: 15, scale: 0.6 });
  expect(selfIntersections(subdivide(c.snapshot(), 3))).toEqual([]);
});
it("finds an extrude pushed back through the body, and names cage faces", () => {
  const c = createCage({ box: { size: [20, 20, 20] } });
  c.extrude("+x:0,0", { by: -40, scale: 0.5 });
  const snap = c.snapshot();
  const hits = selfIntersections(subdivide(snap, 3));
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.length).toBeLessThanOrEqual(8);
  for (const [a, b] of hits) { expect(snap.ids[a]).toBeTypeOf("string"); expect(snap.ids[b]).toBeTypeOf("string"); }
  // Every pair involves the extruded face's cap or sides ("+x:0,0>", "+x:0,0>.s0" …).
  for (const [a, b] of hits) expect([snap.ids[a], snap.ids[b]].some((id) => id.startsWith("+x:0,0>"))).toBe(true);
});
it("returns distinct ordered pairs and honours the limit", () => {
  const c = createCage({ box: { size: [20, 20, 20] } });
  c.extrude("+x:0,0", { by: -40, scale: 0.5 });
  const mesh = subdivide(c.snapshot(), 3);
  const all = selfIntersections(mesh, { limit: 1000 });
  expect(all.length).toBeGreaterThan(1);
  const keys = all.map(([a, b]) => `${a},${b}`);
  expect(new Set(keys).size).toBe(keys.length);
  for (const [a, b] of all) expect(a).toBeLessThanOrEqual(b);
  expect(selfIntersections(mesh, { limit: 1 })).toEqual([all[0]]);
});
it("does not report a mirrored cage's fins against each other or the body", () => {
  const c = createCage({ box: { size: [60, 30, 20], segs: [4, 2, 1] }, mirror: "xz" });
  c.extrude("+y:0,0", { by: 12, scale: 0.7 });
  expect(selfIntersections(subdivide(c.snapshot(), 3))).toEqual([]);
});
it("finds nothing on a clean ~30-face cage at level 5", () => {
  const c = createCage({ box: { size: [40, 30, 20], segs: [3, 2, 2] } });
  const snap = c.snapshot();
  expect(snap.faces.length).toBeGreaterThanOrEqual(28);
  expect(selfIntersections(subdivide(snap, 5))).toEqual([]);
});

// Hand-built triangle pairs: positions, indices and the cage face each triangle comes from.
const pairMesh = (A, B) => ({ positions: Float64Array.from([...A.flat(), ...B.flat()]), indices: Uint32Array.from([0, 1, 2, 3, 4, 5]), triFace: Uint32Array.from([0, 1]) });
const FLAT = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
it("finds two triangles that clearly cross", () => {
  expect(selfIntersections(pairMesh(FLAT, [[2, 2, -5], [3, 2, 5], [2, 3, 5]]))).toEqual([[0, 1]]);
});
it("finds nothing for two triangles clearly apart", () => {
  expect(selfIntersections(pairMesh(FLAT, [[2, 2, 1], [3, 2, 5], [2, 3, 5]]))).toEqual([]);
});
it("finds nothing for two triangles touching at a vertex", () => {
  expect(selfIntersections(pairMesh(FLAT, [[0, 0, 0], [-3, 2, 5], [-2, -3, 5]]))).toEqual([]);   // corner to corner
  expect(selfIntersections(pairMesh(FLAT, [[2, 2, 0], [3, 2, 5], [2, 3, 5]]))).toEqual([]);      // a corner on the face
});

// An independent all-pairs check (Möller–Trumbore, segment against triangle, no tolerance)
// agrees with the tree on a small mesh that crosses itself.
function bruteForce({ positions: P, indices: I, triFace }) {
  const v = (i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const segHits = (p, q, a, b, c) => {
    const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-12) return false;
    const s = sub(p, a), u = dot(s, h) / det;
    if (u <= 0 || u >= 1) return false;
    const qv = cross(s, e1), w = dot(d, qv) / det;
    if (w <= 0 || u + w >= 1) return false;
    const t = dot(e2, qv) / det;
    return t > 0 && t < 1;
  };
  const T = I.length / 3, pairs = new Set();
  for (let i = 0; i < T; i++) for (let j = i + 1; j < T; j++) {
    const a = [I[3 * i], I[3 * i + 1], I[3 * i + 2]], b = [I[3 * j], I[3 * j + 1], I[3 * j + 2]];
    if (a.some((x) => b.includes(x))) continue;
    const [A, B] = [a.map(v), b.map(v)];
    const hit = [0, 1, 2].some((k) => segHits(A[k], A[(k + 1) % 3], ...B) || segHits(B[k], B[(k + 1) % 3], ...A));
    if (hit) pairs.add([triFace[i], triFace[j]].sort((x, y) => x - y).join());
  }
  return [...pairs].sort();
}
it("agrees with an all-pairs check on a small mesh", () => {
  const c = createCage({ box: { size: [20, 20, 20] } });
  c.extrude("+x:0,0", { by: -40, scale: 0.5 });
  const mesh = subdivide(c.snapshot(), 2);
  const want = bruteForce(mesh);
  expect(want.length).toBeGreaterThan(0);
  expect(selfIntersections(mesh, { limit: 1000 }).map((p) => p.join()).sort()).toEqual(want);
});
