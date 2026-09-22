import { test, expect, vi } from "vitest";
import { filletProfile, chamferProfile } from "../src/framework/geometry/contour-ops.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("fillet all corners of a square: 4 line + 4 arc segments, area shrinks by 4·(r² − πr²/4)", () => {
  const out = filletProfile(sq, 2);
  expect(out.segments.filter((s) => s.via).length).toBe(4);
  expect(out.segments.filter((s) => !s.via && !s.c1).length).toBe(4);
  const area = ringArea(tessellateContour(out, 256));
  expect(area).toBeCloseTo(100 - 4 * (4 - Math.PI), 2);
});

test('corners:"concave" fillets only the L-shape notch', () => {
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const out = filletProfile(L, 1.5, { corners: "concave" });
  expect(out.segments.filter((s) => s.via).length).toBe(1);
});

test("{near} picks the closest corner; {indices} takes per-corner radii", () => {
  const near = filletProfile(sq, 3, { corners: { near: [9, 9] } });
  expect(near.segments.filter((s) => s.via).length).toBe(1);
  const idx = filletProfile(sq, [1, 2], { corners: { indices: [0, 2] } });
  expect(idx.segments.filter((s) => s.via).length).toBe(2);
});

test("radius that does not fit is CLAMPED to the max that would, and reported", () => {
  // Was a throw before the clamp policy (see contour-ops-clamp.test.js for why):
  // the ceiling it named is now the radius actually used.
  const record = vi.fn();
  const out = filletProfile(sq, 6, undefined, record);
  expect(out.segments.filter((s) => s.via).length).toBe(4);
  expect(record.mock.calls[0][0]).toMatch(/corner \d+ at \(.*\): r=6 does not fit — clamped to 5/);
});

test("an isolated corner's cap isn't halved by an unselected neighbour", () => {
  const out = filletProfile(sq, 9, { corners: { near: [0, 0] } });
  expect(out.segments.filter((s) => s.via).length).toBe(1);
});

test("adjacent fillets consuming one segment are both shrunk to fit it", () => {
  const thin = [[0, 0], [3, 0], [3, 20], [0, 20]];
  const record = vi.fn();
  const out = filletProfile(thin, 2, undefined, record);
  expect(out.segments.filter((s) => s.via).length).toBe(4);
  expect(record).toHaveBeenCalled();
  expect(record.mock.calls.some(([m]) => /clamped to/.test(m))).toBe(true);
});

test("chamfer emits straight cuts and shrinks area by 4·d²/2", () => {
  const out = chamferProfile(sq, 2);
  expect(out.segments.filter((s) => s.via || s.c1).length).toBe(0);
  expect(out.segments.length).toBe(8);
  expect(ringArea(tessellateContour(out, 8))).toBeCloseTo(100 - 4 * 2, 6);
});

test("empty selector match throws", () => {
  expect(() => filletProfile(sq, 1, { corners: "concave" })).toThrow(/no corner matched/);
});

test("a per-corner radius array without a {corners: {indices}} selector throws", () => {
  expect(() => filletProfile(sq, [3, 1.5])).toThrow(
    /filletProfile: a per-corner radius array requires a \{corners: \{indices\}\} selector/,
  );
  expect(() => chamferProfile(sq, [3, 1.5], { corners: "convex" })).toThrow(
    /chamferProfile: a per-corner radius array requires a \{corners: \{indices\}\} selector/,
  );
});

test("a per-corner radius array whose length mismatches {indices} throws", () => {
  expect(() => filletProfile(sq, [1, 2, 3], { corners: { indices: [0, 1] } })).toThrow(
    /filletProfile: per-corner radius array has 3 entries but \{indices\} has 2/,
  );
});

test("{indices} selects by `position`, so a corner past a smooth joint is reachable by its list place", () => {
  // (5,0) is a smooth joint: corners are vertices 0,2,3,4 at positions 0,1,2,3.
  const bent = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]];
  const out = filletProfile(bent, 2, { corners: { indices: [3] } });
  const arc = out.segments.find((s) => s.via);
  expect(out.segments.filter((s) => s.via).length).toBe(1);
  expect(arc.to[0]).toBeCloseTo(0, 6);   // the (0,10) corner, not (10,10)
  expect(arc.to[1]).toBeCloseTo(8, 6);
});

test("{indices} throws on ANY out-of-range or non-integer entry instead of silently dropping it", () => {
  const bent = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]];
  // A vertex number (4) used where a position belongs — the trap this guards.
  expect(() => filletProfile(bent, 2, { corners: { indices: [0, 4] } })).toThrow(
    /filletProfile: \{indices\} entry 4 is out of range — profileCorners\(\) reported 4 corners \(positions 0…3\)\. \{indices\} takes each corner's `position`/,
  );
  expect(() => chamferProfile(sq, 1, { corners: { indices: [-1] } })).toThrow(/chamferProfile: \{indices\} entry -1 is out of range/);
  expect(() => filletProfile(sq, 1, { corners: { indices: [1.5] } })).toThrow(/filletProfile: \{indices\} entry 1.5 is not an integer/);
});

test("{near, within} bounds the pick: nothing inside the radius throws, and count never reaches past it", () => {
  expect(() => filletProfile(sq, 1, { corners: { near: [50, 50], within: 5 } })).toThrow(
    /filletProfile: no corner within 5mm of \(50, 50\)/,
  );
  // count: 4 asks for four, but only the (10,10) corner lies within 2mm of (9,9).
  const out = filletProfile(sq, 1, { corners: { near: [9, 9], count: 4, within: 2 } });
  expect(out.segments.filter((s) => s.via).length).toBe(1);
  // Without `within`, the same pick takes the nearest four however far away.
  const unbounded = filletProfile(sq, 1, { corners: { near: [9, 9], count: 4 } });
  expect(unbounded.segments.filter((s) => s.via).length).toBe(4);
  expect(() => filletProfile(sq, 1, { corners: { near: [9, 9], within: 0 } })).toThrow(/within must be a positive number/);
});
