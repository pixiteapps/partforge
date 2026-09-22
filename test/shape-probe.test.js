import { expect, test } from "vitest";
import { summarizeContours, MAX_ARCS, MAX_CORNERS } from "../src/framework/oracle/shape-probe.js";
import { makeShape2dFactory } from "../src/framework/geometry/shape2d.js";

// Hand-built contour IR, the same shape Shape2D.toContours() returns.
const square = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
// A 10×10 square whose top-right corner is a true r=2 arc about (8, 8) (via at 45°).
const roundedCorner = { start: [0, 0], segments: [
  { to: [10, 0] }, { to: [10, 8] },
  { to: [8, 10], via: [8 + 2 * Math.SQRT1_2, 8 + 2 * Math.SQRT1_2] },
  { to: [0, 10] }, { to: [0, 0] },
] };
const region = (outer, holes = []) => [{ outer, holes }];
const facts = (regions) => summarizeContours(regions, { isEmpty: false, area: 100, bbox: { min: [0, 0], max: [10, 10] } });
// `.fillet`/`.simplify` are backend-agnostic (paper.js, no WASM), so a fake
// extrude/revolve is all a pure shape2d factory needs — see shape2d-storage.test.js.
const shape2d = makeShape2dFactory({ segs: 64, extrude: () => ({}), revolve: () => ({}) });

test("a via arc reports its exact centre, radius, endpoints and a CCW sweep", () => {
  const ring = facts(region(roundedCorner)).rings[0];
  expect(ring.region).toBe(0);
  expect(ring.ring).toBe("outer");
  expect(ring).not.toHaveProperty("hole");
  expect(ring.segments).toBe(5);
  expect(ring.lines).toBe(4);
  expect(ring.arcs).toHaveLength(1);
  const a = ring.arcs[0];
  expect(a.center[0]).toBeCloseTo(8, 4);
  expect(a.center[1]).toBeCloseTo(8, 4);
  expect(a.r).toBeCloseTo(2, 4);
  expect(a.from).toEqual([10, 8]);
  expect(a.to).toEqual([8, 10]);
  expect(a.sweepDeg).toBeCloseTo(90, 3);
  expect(a.fit).toBeUndefined();
});

test("a cubic segment is fitted and tagged", () => {
  // Standard kappa quarter circle r=2 about (8,8) from (10,8) to (8,10).
  const kap = 0.5522847498307936 * 2;
  const cubicCorner = { start: [0, 0], segments: [
    { to: [10, 0] }, { to: [10, 8] },
    { to: [8, 10], c1: [10, 8 + kap], c2: [8 + kap, 10] },
    { to: [0, 10] }, { to: [0, 0] },
  ] };
  const a = facts(region(cubicCorner)).rings[0].arcs[0];
  expect(a.fit).toBe("cubic");
  expect(a.center[0]).toBeCloseTo(8, 2);
  expect(a.center[1]).toBeCloseTo(8, 2);
  expect(a.r).toBeCloseTo(2, 2);
  expect(a.sweepDeg).toBeCloseTo(90, 1);
});

test("a collinear via triple is counted as a line", () => {
  const flat = { start: [0, 0], segments: [{ to: [10, 0], via: [5, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
  const ring = facts(region(flat)).rings[0];
  expect(ring.arcs).toHaveLength(0);
  expect(ring.lines).toBe(4);
});

test("a hand-built straight cubic (control points on the chord) is counted as a line, not a kilometre-radius arc", () => {
  // c1/c2 sit exactly on the segment from (0,0) to (10,0) — a "cubic" with zero curvature.
  const flatCubic = { start: [0, 0], segments: [
    { to: [10, 0], c1: [10 / 3, 0], c2: [20 / 3, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] },
  ] };
  const ring = facts(region(flatCubic)).rings[0];
  expect(ring.arcs).toHaveLength(0);
  expect(ring.lines).toBe(4);
});

// Round 2 (see feature1-fix-report.md, "Fix round 2"): the controller raised the
// straightness floor from 1e-4 mm to STRAIGHT_SAGITTA_MM (1e-3 mm, a micron), which is
// what this exact reproducer needed — simplify(0.01) leaves the three nominally-straight
// edges with real residual curvature measured at ≈3.24e-4 mm (below 1e-3, above the old
// 1e-4), so they are now correctly counted as lines. simplify() also subdivides three
// of the four fillet corners into two cubic pieces each and folds the fourth corner
// together with part of its adjacent straight edge into one larger-radius fragment
// (measured r≈29.04) rather than reporting a clean r≈4 fourth corner — a real geometric
// effect of simplify()'s own tolerance, not a probe defect. So most, but not all,
// reported arcs are r≈4; every one is well under the near-straight noise floor of
// r>1000 the pre-fix bug produced, and the segment accounting is exact either way.
test("fillet+simplify: near-straight edges are counted as lines under the STRAIGHT_SAGITTA_MM floor", () => {
  const shape = shape2d([[0, 0], [20, 0], [20, 20], [0, 20]]).fillet(4).simplify(0.01);
  const out = summarizeContours(shape.toContours(), { isEmpty: false, area: shape.area(), bbox: shape.boundingBox() });
  const ring = out.rings[0];
  expect(ring.segments).toBe(10);
  expect(ring.lines).toBeGreaterThanOrEqual(3);           // the near-straight edges, now correctly lines
  expect(ring.arcs.length + ring.lines).toBe(ring.segments); // every segment accounted for exactly once
  for (const a of ring.arcs) expect(a.r).toBeLessThanOrEqual(100); // nothing near the old ~55,586mm bug
  const near4 = ring.arcs.filter((a) => Math.abs(a.r - 4) < 0.05);
  expect(near4.length).toBeGreaterThanOrEqual(4); // the split fillet fragments, still r≈4 arcs
  for (const { center, r } of near4) {
    expect(center).toHaveLength(2);
    const [x, y] = center;
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    expect(r).toBeCloseTo(4, 1);
  }
});

test("corners carry position, point, interior angle and convexity, never an index", () => {
  const ring = facts(region(square)).rings[0];
  expect(ring.corners).toHaveLength(4);
  ring.corners.forEach((c, i) => {
    expect(c.position).toBe(i);
    expect(c.interiorAngleDeg).toBeCloseTo(90, 6);
    expect(c.convex).toBe(true);
    expect(c).not.toHaveProperty("index");
    expect(Object.keys(c).sort()).toEqual(["convex", "interiorAngleDeg", "point", "position"]);
  });
});

test("a hole's arc sweeps clockwise (negative), and the hole ring names its region/hole index", () => {
  // Outer 20×20 CCW, hole = the rounded square above, reversed to CW.
  const outer = { start: [-5, -5], segments: [{ to: [15, -5] }, { to: [15, 15] }, { to: [-5, 15] }, { to: [-5, -5] }] };
  const hole = { start: [0, 0], segments: [
    { to: [0, 10] }, { to: [8, 10] },
    { to: [10, 8], via: [8 + 2 * Math.SQRT1_2, 8 + 2 * Math.SQRT1_2] },
    { to: [10, 0] }, { to: [0, 0] },
  ] };
  const out = facts(region(outer, [hole]));
  expect(out.rings).toHaveLength(2);
  const outerRing = out.rings.find((r) => r.ring === "outer");
  const holeRing = out.rings.find((r) => r.ring === "hole");
  expect(outerRing.region).toBe(0);
  expect(holeRing.region).toBe(0);
  expect(holeRing.hole).toBe(0);
  expect(holeRing.arcs[0].sweepDeg).toBeCloseTo(-90, 3);
});

test("corners' `position` runs across every ring in region-then-hole order, matching profileCorners", () => {
  // A square hole punched dead-center in a bigger square: 4 outer corners (positions
  // 0-3), then 4 hole corners (positions 4-7) — the same order profileCorners flattens.
  const outer = { start: [-10, -10], segments: [{ to: [10, -10] }, { to: [10, 10] }, { to: [-10, 10] }, { to: [-10, -10] }] };
  const hole = { start: [-2, -2], segments: [{ to: [-2, 2] }, { to: [2, 2] }, { to: [2, -2] }, { to: [-2, -2] }] };
  const out = facts(region(outer, [hole]));
  const outerRing = out.rings.find((r) => r.ring === "outer");
  const holeRing = out.rings.find((r) => r.ring === "hole");
  expect(outerRing.corners.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  expect(holeRing.corners.map((c) => c.position)).toEqual([4, 5, 6, 7]);
});

test("arcs past the cap are cut and flagged, counted across the WHOLE summary", () => {
  const n = MAX_ARCS + 5;
  const segments = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n, am = (a0 + a1) / 2;
    segments.push({ to: [10 * Math.cos(a1), 10 * Math.sin(a1)], via: [10 * Math.cos(am), 10 * Math.sin(am)] });
  }
  const bumpy = { start: [10, 0], segments };
  const out = facts(region(bumpy));
  expect(out.rings[0].arcs).toHaveLength(MAX_ARCS);
  expect(out.rings[0].segments).toBe(n);
  expect(out.truncated).toBe(true);
});

test("corners past the cap are cut and flagged (a 70-gon reports only 64)", () => {
  const n = 70;
  const segments = [];
  // A convex n-gon whose interior angle (≈174.86° at n=70) still turns more than the
  // 1° smooth-joint threshold, so every one of its straight-line vertices is a corner.
  for (let i = 1; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    segments.push({ to: [10 * Math.cos(a), 10 * Math.sin(a)] });
  }
  const gon = { start: [10, 0], segments };
  const out = facts(region(gon));
  expect(out.rings[0].corners).toHaveLength(MAX_CORNERS);
  expect(out.rings[0].arcs).toHaveLength(0);
  expect(out.rings[0].lines).toBe(n);
  expect(out.truncated).toBe(true);
});

test("an empty shape is reported as empty with nothing else", () => {
  const out = summarizeContours([], { isEmpty: true, area: 0, bbox: null });
  expect(out).toEqual({ kind: "shape2d", empty: true, area: 0, bbox: null, rings: [], truncated: false });
});

test("the summary is rounded to 1e-4 and carries kind/area/bbox", () => {
  const out = facts(region(roundedCorner));
  expect(out.kind).toBe("shape2d");
  expect(out.empty).toBe(false);
  expect(out.area).toBe(100);
  expect(out.bbox).toEqual({ min: [0, 0], max: [10, 10] });
  const a = out.rings[0].arcs[0];
  expect(a.center[0]).toBe(8); // "8" exactly — no 7.999999999 tails
});

test("round() normalizes -0 to 0", () => {
  // A hole ring reversed to CW naturally produces some negative-zero coordinates
  // after rounding; center/point fields must never print a bare minus sign.
  const outer = { start: [-5, -5], segments: [{ to: [5, -5] }, { to: [5, 5] }, { to: [-5, 5] }, { to: [-5, -5] }] };
  const out = facts(region(outer));
  for (const c of out.rings[0].corners) {
    for (const v of c.point) expect(Object.is(v, -0)).toBe(false);
  }
});
