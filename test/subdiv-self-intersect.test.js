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
it("checks a clean ~30-face cage at level 5 quickly", () => {
  const c = createCage({ box: { size: [40, 30, 20], segs: [3, 2, 2] } });
  const snap = c.snapshot();
  expect(snap.faces.length).toBeGreaterThanOrEqual(28);
  const mesh = subdivide(snap, 5);
  const t0 = performance.now();
  expect(selfIntersections(mesh)).toEqual([]);
  expect(performance.now() - t0).toBeLessThan(2000);
});
