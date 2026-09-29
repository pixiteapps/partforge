import { expect, test } from "vitest";
import {
  roundedRectPolygon, regularPolygon, ellipsePolygon,
  slotPolygon, starPolygon, ringSectorPolygon, circleProfile, circlePolygon,
  roundedProfile, filletPolygon, pathProfile,
} from "../src/framework/geometry/polygon.js";
import { tessellateProfile, tessellateContour, normalizeProfile, isPathContour, sampleBezier } from "../src/framework/geometry/profile.js";

const signedArea = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const bbox = (p) => {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const [x, y] of p) { lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); }
  return { w: hi[0] - lo[0], h: hi[1] - lo[1] };
};

test("every profile is CCW (positive signed area)", () => {
  expect(signedArea(roundedRectPolygon(40, 20, 4))).toBeGreaterThan(0);
  expect(signedArea(regularPolygon(6, 10))).toBeGreaterThan(0);
  expect(signedArea(ellipsePolygon(10, 5))).toBeGreaterThan(0);
  expect(signedArea(slotPolygon(20, 4))).toBeGreaterThan(0);
  expect(signedArea(starPolygon(5, 10, 4))).toBeGreaterThan(0);
  expect(signedArea(ringSectorPolygon(5, 10, 90))).toBeGreaterThan(0);
});

test("roundedRectPolygon spans w x h and clamps the corner radius", () => {
  const b = bbox(roundedRectPolygon(40, 20, 4));
  expect(b.w).toBeCloseTo(40, 6);
  expect(b.h).toBeCloseTo(20, 6);
  // r clamped to min(w,h)/2 = 10 → a 20x20 with r=10 is a circle-ish, still 20 wide
  expect(bbox(roundedRectPolygon(20, 20, 999)).w).toBeCloseTo(20, 6);
});

test("regularPolygon returns n vertices on the circumradius", () => {
  const p = regularPolygon(6, 10);
  expect(p.length).toBe(6);
  for (const [x, y] of p) expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
});

test("ellipsePolygon spans 2*rx by 2*ry", () => {
  const b = bbox(ellipsePolygon(10, 5));
  expect(b.w).toBeCloseTo(20, 6);
  expect(b.h).toBeCloseTo(10, 6);
});

test("slotPolygon overall length is length + 2r", () => {
  expect(bbox(slotPolygon(20, 4)).w).toBeCloseTo(28, 6);
  expect(bbox(slotPolygon(20, 4)).h).toBeCloseTo(8, 6);
});

test("starPolygon alternates outer and inner radius over 2*points vertices", () => {
  const p = starPolygon(5, 10, 4);
  expect(p.length).toBe(10);
  expect(Math.hypot(...p[0])).toBeCloseTo(10, 6);
  expect(Math.hypot(...p[1])).toBeCloseTo(4, 6);
});

test("ringSectorPolygon rejects a full 360 ring", () => {
  expect(() => ringSectorPolygon(5, 10, 360)).toThrow(/< 360/);
});

test("circlePolygon: CCW, segs points, all at radius r about center", () => {
  const c = circlePolygon(5, [10, 0], 32);
  expect(c.length).toBe(32);
  expect(signedArea(c)).toBeGreaterThan(0);
  for (const [x, y] of c) expect(Math.hypot(x - 10, y - 0)).toBeCloseTo(5, 6);
});

test("circlePolygon spans 2r centered on `center`", () => {
  const b = bbox(circlePolygon(5, [10, 0]));
  expect(b.w).toBeCloseTo(10, 6);
  expect(b.h).toBeCloseTo(10, 6);
});

test("circlePolygon defaults center to origin and rejects r <= 0", () => {
  const c = circlePolygon(3);
  for (const [x, y] of c) expect(Math.hypot(x, y)).toBeCloseTo(3, 6);
  expect(() => circlePolygon(0)).toThrow(/r must be/);
  expect(() => circlePolygon(-1)).toThrow(/r must be/);
});

// circleProfile is an exact curve since 0.132 (it was circlePolygon's points before).
test("circleProfile is an exact two-arc circle starting at angle 0, CCW", () => {
  const c = circleProfile(5, [10, 0]);
  expect(isPathContour(c)).toBe(true);
  expect(c.start).toEqual([15, 0]);
  expect(c.segments).toEqual([{ to: [5, 0], via: [10, 5] }, { to: [15, 0], via: [10, -5] }]);
  const ring = tessellateContour(c, 4096);
  expect(signedArea(ring)).toBeCloseTo(Math.PI * 25, 3);
  const b = bbox(ring);
  expect(b.w).toBeCloseTo(10, 6);
  expect(b.h).toBeCloseTo(10, 6);
});

test("circleProfile rejects r <= 0 and refuses the point list's segs by name", () => {
  expect(() => circleProfile(0)).toThrow(/r must be/);
  expect(() => circleProfile(-1)).toThrow(/r must be/);
  expect(() => circleProfile(5, [0, 0], 32)).toThrow(/takes no segs — use circlePolygon/);
  expect(() => circleProfile(5, [0, 0], undefined)).not.toThrow();
});

// ── roundedProfile (arc-aware sibling of filletPolygon) ─────────────────────────
const A = 20, R = 4;
const SQ = [[-A / 2, -A / 2], [A / 2, -A / 2], [A / 2, A / 2], [-A / 2, A / 2]];
const roundedSquareArea = A * A - (4 - Math.PI) * R * R; // exact: a² − (4−π)r²

test("roundedProfile compiles to a canonical ArcContour (start + line/arc segments)", () => {
  const c = roundedProfile(SQ, R);
  expect(c.arc).toBe(true);
  expect(Array.isArray(c.start)).toBe(true);
  // four rounded corners → four arc segments (each { to, via }), interleaved with lines
  expect(c.segments.filter((s) => s.via).length).toBe(4);
  for (const s of c.segments.filter((v) => v.via)) expect(s.via.length).toBe(2);
});

test("roundedProfile tessellates CCW and hits the exact rounded-square area (inscribed)", () => {
  const ring = tessellateProfile(roundedProfile(SQ, R), 116).outer;
  expect(signedArea(ring)).toBeGreaterThan(0);                 // CCW
  expect(signedArea(ring)).toBeLessThanOrEqual(roundedSquareArea + 1e-6); // inscribed ⇒ ≤ analytic
  expect(signedArea(ring)).toBeCloseTo(roundedSquareArea, 1);  // and close (0.02·r² closed-form deficit)
});

test("roundedProfile tessellation converges to the true area as segs↑ and beats fixed-segs filletPolygon", () => {
  const near = signedArea(tessellateContour(roundedProfile(SQ, R), 480));
  const coarse = signedArea(tessellateContour(roundedProfile(SQ, R), 32));
  expect(Math.abs(near - roundedSquareArea)).toBeLessThan(Math.abs(coarse - roundedSquareArea)); // more facets → closer
  // the arc path (segs-scaled) beats filletPolygon's fixed segs=8 corners at print resolution
  expect(Math.abs(near - roundedSquareArea)).toBeLessThan(Math.abs(signedArea(filletPolygon(SQ, R)) - roundedSquareArea));
});

test("roundedProfile keeps sharp/degenerate corners as plain lines (r=0, per-corner r[], collinear)", () => {
  const half = roundedProfile(SQ, [R, 0, R, 0]);              // only 2 corners rounded
  expect(half.segments.filter((s) => s.via).length).toBe(2);
  expect(roundedProfile(SQ, 0)).toBeDefined();                // scalar 0 → all sharp (no arcs)
  expect(roundedProfile(SQ, 0).segments.every((s) => !s.via)).toBe(true);
  // a collinear (straight) vertex is skipped, not turned into a degenerate arc
  const withStraight = roundedProfile([[0, 0], [10, 0], [20, 0], [20, 10], [0, 10]], R);
  expect(withStraight.segments.filter((s) => s.via).length).toBe(4); // the 180° vertex stays a line
});

test("roundedProfile validates inputs", () => {
  expect(() => roundedProfile([[0, 0], [1, 1]], R)).toThrow(/at least 3/);
  expect(() => roundedProfile(SQ, [R, R])).toThrow(/length must match/);
});

test("isPathContour accepts the symbolic form (line/arc/cubic), rejects arrays", () => {
  expect(isPathContour({ start: [0, 0], segments: [{ to: [1, 0], c1: [0, 1], c2: [1, 1] }] })).toBe(true);
  expect(isPathContour([[0, 0], [1, 0], [1, 1]])).toBe(false);
});

test("cubic segment validation: mixing via+cubic and missing controls throw", () => {
  const mix = { start: [0, 0], segments: [{ to: [1, 1], via: [0, 1], c1: [0, 0], c2: [1, 0] }] };
  expect(() => normalizeProfile(mix)).toThrow("segment cannot mix arc (via) and cubic (c1/c2)");

  const half = { start: [0, 0], segments: [{ to: [1, 1], c1: [0, 1] }] };
  expect(() => normalizeProfile(half)).toThrow("cubic segment needs c1 and c2 as finite [x,y]");

  const nan = { start: [0, 0], segments: [{ to: [1, 1], c1: [0, NaN], c2: [1, 0] }] };
  expect(() => normalizeProfile(nan)).toThrow("cubic segment needs c1 and c2 as finite [x,y]");
});

test("a valid cubic contour passes normalizeProfile unchanged", () => {
  const c = { start: [0, 0], segments: [{ to: [10, 0], c1: [3, 4], c2: [7, 4] }] };
  expect(normalizeProfile(c).outer).toBe(c);
});

// Standard cubic approximation of a quarter circle radius R, (R,0)→(0,R).
const KAPPA = 0.5522847498307936;
const quarterArcCubic = (R) => ({ p0: [R, 0], c1: [R, R * KAPPA], c2: [R * KAPPA, R], p1: [0, R] });

test("sampleBezier excludes the start and pins the exact endpoint", () => {
  const { p0, c1, c2, p1 } = quarterArcCubic(10);
  const pts = sampleBezier(p0, c1, c2, p1, 32);
  expect(pts.length).toBeGreaterThan(1);
  expect(pts[0]).not.toEqual(p0);
  expect(pts[pts.length - 1]).toEqual(p1);
});

test("sampleBezier facet count rises with segs on a curved input", () => {
  const { p0, c1, c2, p1 } = quarterArcCubic(10);
  const lo = sampleBezier(p0, c1, c2, p1, 8).length;
  const hi = sampleBezier(p0, c1, c2, p1, 64).length;
  expect(hi).toBeGreaterThan(lo);
});

test("sampleBezier points of a quarter-circle cubic all lie on the circle (within Bézier tolerance)", () => {
  // de Casteljau split points are EXACT curve points, so every sample lies on the
  // Bézier — within its intrinsic ~0.027% circle-approximation error at any segs.
  // (Sample-point radius error does NOT shrink with segs — the flattening error
  // lives between samples. LOD is exercised by the point-count test above and the
  // Manifold cubic/circleProfile volume-parity test.)
  const R = 10, { p0, c1, c2, p1 } = quarterArcCubic(R);
  for (const segs of [8, 32, 64])
    for (const [x, y] of sampleBezier(p0, c1, c2, p1, segs))
      expect(Math.abs(Math.hypot(x, y) - R)).toBeLessThan(0.01);
});

test("sampleBezier of a near-straight cubic collapses to few chords", () => {
  const pts = sampleBezier([0, 0], [3, 0], [7, 0], [10, 0], 32); // controls on the line
  expect(pts.length).toBeLessThanOrEqual(2);
  expect(pts[pts.length - 1]).toEqual([10, 0]);
});

test("sampleBezier is pure (same input twice → deep equal)", () => {
  const { p0, c1, c2, p1 } = quarterArcCubic(7);
  expect(sampleBezier(p0, c1, c2, p1, 24)).toEqual(sampleBezier(p0, c1, c2, p1, 24));
});

// ── pathProfile (fluent builder) ──────────────────────────────────────────

test("pathProfile builds the canonical { start, segments } with correct kinds", () => {
  const c = pathProfile([0, 0])
    .lineTo([10, 0])
    .arcTo([10, 10], [11, 5])
    .cubicTo([0, 10], [7, 12], [3, 12])
    .close();
  expect(c.start).toEqual([0, 0]);
  expect(c.segments).toEqual([
    { to: [10, 0] },
    { to: [10, 10], via: [11, 5] },
    { to: [0, 10], c1: [7, 12], c2: [3, 12] },
  ]);
});

test("pathProfile rejects bad points and empty paths", () => {
  expect(() => pathProfile([0])).toThrow("pathProfile: start must be a finite [x,y]");
  expect(() => pathProfile([0, 0]).lineTo([1, NaN])).toThrow("pathProfile: lineTo point must be a finite [x,y]");
  expect(() => pathProfile([0, 0]).close()).toThrow("pathProfile: need ≥1 segment before close()");
});

test("a pathProfile contour tessellates and normalizes like any path contour", () => {
  const c = pathProfile([0, 0]).lineTo([10, 0]).cubicTo([0, 10], [10, 4], [4, 10]).close();
  expect(normalizeProfile(c).outer).toBe(c);
  expect(tessellateContour(c, 24).length).toBeGreaterThan(3);
});

test("pathProfile.close() snapshots segments — chaining afterward does not mutate the returned contour", () => {
  const b = pathProfile([0, 0]).lineTo([10, 0]);
  const a = b.close();
  b.lineTo([20, 20]);          // mutate the builder after close()
  expect(a.segments).toEqual([{ to: [10, 0] }]); // unchanged
});
