import { expect, test } from "vitest";
import { summarizeContours, MAX_RING_ARCS, MAX_RING_CORNERS } from "../src/framework/oracle/shape-probe.js";

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

test("a via arc reports its exact centre, radius, endpoints and a CCW sweep", () => {
  const ring = facts(region(roundedCorner)).regions[0].outer;
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
  const a = facts(region(cubicCorner)).regions[0].outer.arcs[0];
  expect(a.fit).toBe("cubic");
  expect(a.center[0]).toBeCloseTo(8, 2);
  expect(a.center[1]).toBeCloseTo(8, 2);
  expect(a.r).toBeCloseTo(2, 2);
  expect(a.sweepDeg).toBeCloseTo(90, 1);
});

test("a collinear via triple is counted as a line", () => {
  const flat = { start: [0, 0], segments: [{ to: [10, 0], via: [5, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
  const ring = facts(region(flat)).regions[0].outer;
  expect(ring.arcs).toHaveLength(0);
  expect(ring.lines).toBe(4);
});

test("corners carry point, interior angle and convexity, never an index", () => {
  const ring = facts(region(square)).regions[0].outer;
  expect(ring.corners).toHaveLength(4);
  for (const c of ring.corners) {
    expect(c.interiorAngleDeg).toBeCloseTo(90, 6);
    expect(c.convex).toBe(true);
    expect(c).not.toHaveProperty("index");
    expect(Object.keys(c).sort()).toEqual(["convex", "interiorAngleDeg", "point"]);
  }
});

test("a hole's arc sweeps clockwise (negative)", () => {
  // Outer 20×20 CCW, hole = the rounded square above, reversed to CW.
  const outer = { start: [-5, -5], segments: [{ to: [15, -5] }, { to: [15, 15] }, { to: [-5, 15] }, { to: [-5, -5] }] };
  const hole = { start: [0, 0], segments: [
    { to: [0, 10] }, { to: [8, 10] },
    { to: [10, 8], via: [8 + 2 * Math.SQRT1_2, 8 + 2 * Math.SQRT1_2] },
    { to: [10, 0] }, { to: [0, 0] },
  ] };
  const rg = facts(region(outer, [hole])).regions[0];
  expect(rg.holes).toHaveLength(1);
  expect(rg.holes[0].arcs[0].sweepDeg).toBeCloseTo(-90, 3);
});

test("rings past the caps are cut and flagged", () => {
  const n = MAX_RING_ARCS + 5;
  const segments = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n, am = (a0 + a1) / 2;
    segments.push({ to: [10 * Math.cos(a1), 10 * Math.sin(a1)], via: [10 * Math.cos(am), 10 * Math.sin(am)] });
  }
  const bumpy = { start: [10, 0], segments };
  const out = facts(region(bumpy));
  expect(out.regions[0].outer.arcs).toHaveLength(MAX_RING_ARCS);
  expect(out.regions[0].outer.segments).toBe(n);
  expect(out.truncated).toBe(true);
  expect(MAX_RING_CORNERS).toBe(64);
});

test("an empty shape is reported as empty with nothing else", () => {
  const out = summarizeContours([], { isEmpty: true, area: 0, bbox: null });
  expect(out).toEqual({ kind: "shape2d", empty: true, area: 0, bbox: null, regions: [], truncated: false });
});

test("the summary is rounded to 1e-4 and carries kind/area/bbox", () => {
  const out = facts(region(roundedCorner));
  expect(out.kind).toBe("shape2d");
  expect(out.empty).toBe(false);
  expect(out.area).toBe(100);
  expect(out.bbox).toEqual({ min: [0, 0], max: [10, 10] });
  const a = out.regions[0].outer.arcs[0];
  expect(String(a.center[0]).length).toBeLessThanOrEqual(6); // "8" — no 7.999999999 tails
});
