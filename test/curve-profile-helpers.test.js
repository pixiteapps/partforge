// The curve twins of the round *Polygon helpers (ringSectorProfile, pieProfile,
// slotProfile, roundedRectProfile): each returns a {start, segments} path contour
// whose arcs are symbolic, so the kernel facets them per tier and STEP keeps true
// circles. Each must trace the SAME outline as its *Polygon twin — same start point,
// same CCW direction, same extent — so swapping one for the other never moves a part.
import { describe, expect, test } from "vitest";
import {
  ringSectorPolygon, ringSectorProfile,
  piePolygon, pieProfile,
  slotPolygon, slotProfile,
  roundedRectPolygon, roundedRectProfile,
} from "../src/framework/geometry/polygon.js";
import { isPathContour, tessellateContour } from "../src/framework/geometry/profile.js";

const signedArea = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const bounds = (p) => {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const [x, y] of p) {
    lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y);
    hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y);
  }
  return { lo, hi };
};
// Fine enough that tessellation error is far below the tolerances asserted.
const FINE = 4096;
const ring = (c) => tessellateContour(c, FINE);
const closeTo = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThan(tol);

// Each case: the curve twin, the point-list twin, and the exact area of the shape.
const CASES = {
  ringSectorProfile: {
    curve: () => ringSectorProfile(28, 30, 36),
    points: () => ringSectorPolygon(28, 30, 36),
    area: 0.5 * (30 ** 2 - 28 ** 2) * (36 * Math.PI / 180),
  },
  "ringSectorProfile (reflex sweep)": {
    curve: () => ringSectorProfile(10, 20, 270),
    points: () => ringSectorPolygon(10, 20, 270),
    area: 0.5 * (20 ** 2 - 10 ** 2) * (270 * Math.PI / 180),
  },
  pieProfile: {
    curve: () => pieProfile(25, 120),
    points: () => piePolygon(25, 120),
    area: 0.5 * 25 ** 2 * (120 * Math.PI / 180),
  },
  slotProfile: {
    curve: () => slotProfile(20, 4),
    points: () => slotPolygon(20, 4),
    area: 20 * 8 + Math.PI * 4 ** 2,
  },
  roundedRectProfile: {
    curve: () => roundedRectProfile(40, 20, 4),
    points: () => roundedRectPolygon(40, 20, 4),
    area: 40 * 20 - (4 - Math.PI) * 4 ** 2,
  },
};

describe.each(Object.entries(CASES))("%s", (_name, { curve, points, area }) => {
  test("is a path contour carrying symbolic arcs", () => {
    const c = curve();
    expect(isPathContour(c)).toBe(true);
    expect(Array.isArray(c)).toBe(false);
    expect(c.segments.some((s) => s.via)).toBe(true);
    expect(c.segments.some((s) => s.c1)).toBe(false);
  });

  test("starts where its *Polygon twin starts and closes explicitly on it", () => {
    const c = curve(), p = points();
    closeTo(c.start[0], p[0][0], 1e-9);
    closeTo(c.start[1], p[0][1], 1e-9);
    const last = c.segments[c.segments.length - 1].to;
    closeTo(last[0], c.start[0], 1e-9);
    closeTo(last[1], c.start[1], 1e-9);
  });

  test("is CCW and has the exact area of the shape it names", () => {
    const a = signedArea(ring(curve()));
    expect(a).toBeGreaterThan(0);
    closeTo(a, area, area * 1e-5);
  });

  test("spans the same extent as its *Polygon twin, which only ever falls inside it", () => {
    const exact = bounds(ring(curve())), twin = bounds(points());
    // A chord never reaches past its arc, so the twin's box sits inside the curve's.
    for (const i of [0, 1]) {
      expect(twin.lo[i]).toBeGreaterThanOrEqual(exact.lo[i] - 1e-9);
      expect(twin.hi[i]).toBeLessThanOrEqual(exact.hi[i] + 1e-9);
    }
    // …and the twin's area is the smaller one: the facets cut inside the true arcs.
    expect(signedArea(points())).toBeLessThan(signedArea(ring(curve())));
  });

  test("never carries a zero-length segment", () => {
    const c = curve();
    let prev = c.start;
    for (const s of c.segments) {
      expect(Math.hypot(s.to[0] - prev[0], s.to[1] - prev[1])).toBeGreaterThan(1e-9);
      prev = s.to;
    }
  });
});

describe("degenerate spans collapse cleanly", () => {
  test("slotProfile with length 0 is a circle of radius r", () => {
    const c = slotProfile(0, 5);
    expect(c.segments.every((s) => s.via)).toBe(true);
    closeTo(signedArea(ring(c)), Math.PI * 25, 1e-3);
  });

  test("roundedRectProfile clamps r to min(w, h)/2, like its twin", () => {
    const c = roundedRectProfile(40, 20, 999);   // clamps to r = 10: a stadium
    const b = bounds(ring(c));
    closeTo(b.hi[0] - b.lo[0], 40, 1e-9);
    closeTo(b.hi[1] - b.lo[1], 20, 1e-9);
    closeTo(signedArea(ring(c)), 20 * 20 + Math.PI * 100, 1e-3);
    const circle = roundedRectProfile(20, 20, 999);
    closeTo(signedArea(ring(circle)), Math.PI * 100, 1e-3);
  });

  test("roundedRectProfile with r = 0 is the plain rectangle", () => {
    const c = roundedRectProfile(40, 20, 0);
    expect(c.segments.every((s) => !s.via)).toBe(true);
    closeTo(signedArea(ring(c)), 800, 1e-9);
  });
});

describe("input validation", () => {
  test("ringSectorProfile needs 0 < innerR < outerR and 0 < arcDeg < 360", () => {
    expect(() => ringSectorProfile(10, 20, 360)).toThrow(/arcDeg must be between 0 and 360/);
    expect(() => ringSectorProfile(10, 20, 0)).toThrow(/arcDeg must be between 0 and 360/);
    expect(() => ringSectorProfile(20, 10, 90)).toThrow(/innerR must be > 0 and < outerR/);
    expect(() => ringSectorProfile(0, 10, 90)).toThrow(/pieProfile/);
  });

  test("pieProfile needs tipR > 0 and 0 < arcDeg < 360", () => {
    expect(() => pieProfile(0, 90)).toThrow(/tipR must be > 0/);
    expect(() => pieProfile(10, 360)).toThrow(/arcDeg must be between 0 and 360/);
  });

  test("slotProfile needs r > 0 and length ≥ 0", () => {
    expect(() => slotProfile(10, 0)).toThrow(/r must be > 0/);
    expect(() => slotProfile(-1, 2)).toThrow(/length must be ≥ 0/);
  });

  test("roundedRectProfile needs positive w and h", () => {
    expect(() => roundedRectProfile(0, 10, 1)).toThrow(/w and h must be > 0/);
  });
});
