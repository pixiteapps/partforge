// OCCT-only file (never boot Manifold here). A Shape2D with many regions must extrude
// in ~linear time and with the SAME semantics the old left-fold fuse had: disjoint
// regions stay separate solids, a region nested in another's hole is an island, and
// regions that overlap or touch are unioned. See drawingFromRegions in occt-backend.js.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const tri = (x, y) => ({ outer: [[x, y], [x + 2, y], [x + 1, y + 1.7]], holes: [] });
const TRI_AREA = 1.7;

test("many disjoint regions: volume is the sum, no region lost", () => {
  const n = 120, cols = 12, regs = [];
  for (let i = 0; i < n; i++) regs.push(tri((i % cols) * 3, Math.floor(i / cols) * 3));
  const solid = k.extrude({ profile: k.shape2d(regs), h: 2 });
  expect(solid.volume()).toBeCloseTo(n * TRI_AREA * 2, 6);
});

test("scaling: 1,000 disjoint regions extrude in seconds, not the quadratic ~14 s", () => {
  const n = 1000, cols = 32, regs = [];
  for (let i = 0; i < n; i++) regs.push(tri((i % cols) * 3, Math.floor(i / cols) * 3));
  const t0 = performance.now();
  const solid = k.extrude({ profile: k.shape2d(regs), h: 2 });
  const ms = performance.now() - t0;
  expect(solid.volume()).toBeCloseTo(n * TRI_AREA * 2, 5);
  expect(ms).toBeLessThan(5000);
}, 60_000);

test("region with holes + an island inside a hole + a far region", () => {
  const regs = [
    { outer: sq(0, 0, 20), holes: [sq(2, 2, 6), sq(12, 12, 6)] },  // 400 - 36 - 36
    { outer: sq(4, 4, 2), holes: [] },                              // island in the first hole
    { outer: sq(40, 0, 5), holes: [] },
  ];
  const solid = k.extrude({ profile: k.shape2d(regs), h: 3 });
  expect(solid.volume()).toBeCloseTo((328 + 4 + 25) * 3, 6);
});

test("overlapping hand-authored regions are still unioned", () => {
  const solid = k.extrude({ profile: k.shape2d([{ outer: sq(0, 0, 10), holes: [] }, { outer: sq(5, 5, 10), holes: [] }]), h: 1 });
  expect(solid.volume()).toBeCloseTo(175, 6);                       // 100 + 100 - 25
});

test("a region inside another's MATERIAL is absorbed; edge-touching regions merge", () => {
  const inside = k.extrude({ profile: k.shape2d([{ outer: sq(0, 0, 10), holes: [] }, { outer: sq(2, 2, 3), holes: [] }]), h: 1 });
  expect(inside.volume()).toBeCloseTo(100, 6);
  const touching = k.extrude({ profile: k.shape2d([{ outer: sq(0, 0, 10), holes: [] }, { outer: sq(10, 0, 10), holes: [] }]), h: 1 });
  expect(touching.volume()).toBeCloseTo(200, 6);
});

test("twist/taper and revolve accept multi-region profiles", () => {
  const regs = [{ outer: sq(5, -2, 4), holes: [sq(6, -1, 2)] }, { outer: sq(15, -2, 4), holes: [] }];
  const tapered = k.extrude({ profile: k.shape2d(regs), h: 4, scaleTop: 1 });
  expect(tapered.volume()).toBeCloseTo((16 - 4 + 16) * 4, 6);
  const twisted = k.extrude({ profile: k.shape2d(regs), h: 4, twist: 30 });
  expect(twisted.volume()).toBeGreaterThan(100);
  const ring = k.revolve({ profile: k.shape2d([{ outer: sq(5, 0, 2), holes: [] }, { outer: sq(10, 0, 2), holes: [] }]) });
  const expected = 2 * Math.PI * (6 * 4 + 11 * 4);
  expect(ring.volume()).toBeCloseTo(expected, 3);
});
