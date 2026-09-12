import { expect, test } from "vitest";
import { liftLoftRings, classifyLoftRings, loftRingsKey } from "../src/framework/geometry/loft-rings.js";
import { roundedProfile, regularPolygon, circleProfile } from "../src/framework/geometry/polygon.js";
import { pointsToContour } from "../src/framework/geometry/profile.js";

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
const fakeShape = (regions) => ({ _shape2d: true, _regions: regions, _hash: "abc123", toContours: () => JSON.parse(JSON.stringify(regions)) });
const rsq = roundedProfile(SQ, 2); // curve contour: 4 lines + 4 arcs, "LALALALA"

test("point-list rings lift with legacy scale-then-rotate baked into pts (bit-exact math)", () => {
  const [r] = liftLoftRings([{ polygon: SQ, z: 0, scale: 2, rotate: 90 }, { polygon: SQ, z: 1 }]);
  // scale 2 → (−10,−10), rotate 90° CCW → (10,−10)
  expect(r.pts[0][0]).toBeCloseTo(10, 12);
  expect(r.pts[0][1]).toBeCloseTo(-10, 12);
  expect(r.z).toBe(0);
});

test("sides+radius shorthand lifts to regularPolygon points", () => {
  const [r] = liftLoftRings([{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 5 }]);
  expect(r.pts).toEqual(regularPolygon(6, 8));
});

test("a curve contour ring lifts with a contour and no pts", () => {
  const [r] = liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 5 }]);
  expect(r.pts).toBeNull();
  expect(r.contour.segments.filter((s) => s.via).length).toBe(4); // 4 corner arcs survive lifting
});

test("a Shape2D ring lifts its single region's outer contour", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }]);
  const [r] = liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]);
  expect(r.contour.segments.filter((s2) => s2.via).length).toBe(4);
});

test("a multi-region Shape2D ring throws a loud error", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }, { outer: rsq, holes: [] }]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]))
    .toThrow(/ring 0 is a Shape2D with 2 regions/);
});

test("a Shape2D ring with holes throws a loud error", () => {
  const s = fakeShape([{ outer: rsq, holes: [rsq] }]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]))
    .toThrow(/ring 0 has holes/);
});

test("an empty Shape2D ring throws a loud error", () => {
  const s = fakeShape([]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }])).toThrow(/ring 0 is an empty Shape2D/);
});

test("existing validation survives: <2 rings, missing z, short point list all throw", () => {
  expect(() => liftLoftRings([{ polygon: SQ, z: 0 }])).toThrow(/at least 2 rings/);
  expect(() => liftLoftRings([{ polygon: SQ }, { polygon: SQ, z: 1 }])).toThrow(/finite z/);
  expect(() => liftLoftRings([{ polygon: [[0, 0], [1, 0]], z: 0 }, { polygon: SQ, z: 1 }])).toThrow(/≥3 points/);
});

test("an all-line contour ring with only 2 segments throws a loud error", () => {
  const twoLine = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [0, 0] }] }; // degenerate back-and-forth
  expect(() => liftLoftRings([{ polygon: twoLine, z: 0 }, { polygon: SQ, z: 1 }]))
    .toThrow(/ring 0's contour has only 2 line segment/);
});

test("a 2-arc circle contour ring lifts fine (curved contours may have fewer than 3 segments)", () => {
  const r = 5;
  const twoArcCircle = { start: [r, 0], segments: [{ via: [0, r], to: [-r, 0] }, { via: [0, -r], to: [r, 0] }] };
  expect(() => liftLoftRings([{ polygon: twoArcCircle, z: 0 }, { polygon: twoArcCircle, z: 5 }])).not.toThrow();
});

test("classify: equal-N point rings → poly-exact", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: SQ, z: 9 }]));
  expect(c).toEqual({ mode: "poly-exact", hasCurve: false });
});

test("classify: identical curved signatures → curve", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: 0.5 }]));
  expect(c).toEqual({ mode: "curve", hasCurve: true });
});

test("classify: rounded square → plain square is resample (signatures differ)", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: SQ, z: 9 }]));
  expect(c.mode).toBe("resample");
  expect(c.hasCurve).toBe(true);
});

test("classify: unequal-N point rings → resample (was an error before this feature)", () => {
  const oct = regularPolygon(8, 5);
  expect(classifyLoftRings(liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: oct, z: 9 }])).mode).toBe("resample");
});

test("classify: NON-uniform scale on a curved ring still classifies deterministically", () => {
  // arcs under non-uniform scale become cubics (transformContour), so the scaled ring's
  // signature differs from the unscaled one → resample, not a crash.
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: [2, 1] }]));
  expect(c.mode).toBe("resample");
});

test("loftRingsKey substitutes a Shape2D with its _hash and is h()-stable", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }]);
  const k1 = JSON.stringify(loftRingsKey([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]));
  expect(k1).toContain("abc123");
  expect(k1).not.toContain("_shape2d"); // no live object leaked into the key
});

import { matchedTessellation } from "../src/framework/geometry/loft-rings.js";
import { arcGeometry } from "../src/framework/geometry/profile.js";

test("arcGeometry matches sampleArc's implicit circle (90° arc r=2)", () => {
  const g = arcGeometry([2, 0], [Math.SQRT2, Math.SQRT2], [0, 2]);
  expect(g.r).toBeCloseTo(2, 9);
  expect(g.cx).toBeCloseTo(0, 9);
  expect(g.cy).toBeCloseTo(0, 9);
  expect(Math.abs(g.dA)).toBeCloseTo(Math.PI / 2, 9);
});

test("arcGeometry returns null for a collinear triple", () => {
  expect(arcGeometry([0, 0], [1, 0], [2, 0])).toBeNull();
});

test("matched tessellation: one rounded square at two scales → equal N, corners exact", () => {
  const rsq = roundedProfile(SQ, 2);
  const lifted = liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: 0.5 }]);
  const [a, b] = matchedTessellation(lifted);
  expect(a.length).toBe(b.length);
  // every segment endpoint of the baked contour appears verbatim in the ring
  for (const seg of lifted[0].contour.segments.slice(0, -1)) {
    expect(a.some(([x, y]) => Math.hypot(x - seg.to[0], y - seg.to[1]) < 1e-12)).toBe(true);
  }
  // ring 1 is exactly ring 0 scaled by 0.5, index-for-index (aligned correspondence)
  for (let i = 0; i < a.length; i++) {
    expect(b[i][0]).toBeCloseTo(a[i][0] * 0.5, 9);
    expect(b[i][1]).toBeCloseTo(a[i][1] * 0.5, 9);
  }
});

test("matched tessellation gives each arc the max natural count across rings", () => {
  // big ring's arcs need more facets than the small ring's; both must get the max
  const big = roundedProfile([[-50, -50], [50, -50], [50, 50], [-50, 50]], 20);
  const lifted = liftLoftRings([{ polygon: big, z: 0 }, { polygon: big, z: 9, scale: 0.1 }]);
  const [a, b] = matchedTessellation(lifted);
  expect(a.length).toBe(b.length);
  expect(a.length).toBeGreaterThan(8); // arcs actually sampled, not collapsed to endpoints
});

test("matched tessellation: cubic (Bézier) contour at two scales → equal N, cubics sampled, exact scaling", () => {
  // Hand-built cubic contour (blob-like shape with 4 cubic segments)
  const blob = { start: [4, 0], segments: [
    { to: [0, 4], c1: [4, 2.2], c2: [2.2, 4] },
    { to: [-4, 0], c1: [-2.2, 4], c2: [-4, 2.2] },
    { to: [0, -4], c1: [-4, -2.2], c2: [-2.2, -4] },
    { to: [4, 0], c1: [2.2, -4], c2: [4, -2.2] },
  ] };
  const lifted = liftLoftRings([{ polygon: blob, z: 0 }, { polygon: blob, z: 9, scale: 0.5 }]);
  const [a, b] = matchedTessellation(lifted);
  // (1) equal ring lengths
  expect(a.length).toBe(b.length);
  // (2) more points than segment endpoints alone (cubics actually sampled)
  expect(a.length).toBeGreaterThan(4);
  // (3) index-for-index exact 0.5 scaling (cubics are affine-invariant)
  for (let i = 0; i < a.length; i++) {
    expect(b[i][0]).toBeCloseTo(a[i][0] * 0.5, 9);
    expect(b[i][1]).toBeCloseTo(a[i][1] * 0.5, 9);
  }
});

import { resampleTessellation } from "../src/framework/geometry/loft-rings.js";

test("resample: square → circle rings come out equal-N, CCW, seam on the +X axis", () => {
  const lifted = liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 9 }]);
  const [sq, ci] = resampleTessellation(lifted);
  expect(sq.length).toBe(ci.length);
  // seams: first sample of each ring sits on its +X ray from centroid (y ≈ 0 for both)
  expect(sq[0][1]).toBeCloseTo(0, 9);
  expect(sq[0][0]).toBeCloseTo(5, 9);          // square crosses +X at x = 5
  expect(ci[0][1]).toBeCloseTo(0, 6);
  // CCW: shoelace positive
  const area = (ring) => ring.reduce((a, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return a + x * ny - nx * y; }, 0) / 2;
  expect(area(sq)).toBeGreaterThan(0);
  expect(area(ci)).toBeGreaterThan(0);
});

test("resample: the square's four corners survive exactly (corner snapping)", () => {
  const lifted = liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 9 }]);
  const [sq] = resampleTessellation(lifted);
  for (const [cx, cy] of SQ)
    expect(sq.some(([x, y]) => x === cx && y === cy)).toBe(true);
});

test("resample: N is the max ring vertex count", () => {
  const oct = regularPolygon(8, 5);
  const lifted = liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: oct, z: 9 }]);
  const rings = resampleTessellation(lifted);
  expect(rings[0].length).toBe(8);
  expect(rings[1].length).toBe(8);
});

test("resample: CW input ring is normalized CCW before resampling", () => {
  const CW = [[-5, -5], [-5, 5], [5, 5], [5, -5]];
  const lifted = liftLoftRings([{ polygon: CW, z: 0 }, { polygon: circleProfile(4), z: 9 }]);
  const [sq] = resampleTessellation(lifted);
  const area = (ring) => ring.reduce((a, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return a + x * ny - nx * y; }, 0) / 2;
  expect(area(sq)).toBeGreaterThan(0);
});

test("resample: a true arc contour (roundedProfile) resamples against a point ring — curve tessellation path", () => {
  const rsq = roundedProfile(SQ, 2); // arc contour → tessellated at LOFT_SEGS
  const lifted = liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: SQ, z: 9 }]);
  const [a, b] = resampleTessellation(lifted);
  expect(a.length).toBe(b.length);
  expect(a.length).toBeGreaterThan(30);          // arcs actually tessellated, N = max ring count
  const area = (ring) => ring.reduce((s, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return s + x * ny - nx * y; }, 0) / 2;
  expect(area(a)).toBeGreaterThan(0);            // CCW after closure-drop
  // Rounded square area ≈ 100 - 4*(4 - π) ≈ 96.57; account for facet deficit with tolerance
  expect(Math.abs(area(a) - 96.566)).toBeLessThan(1);
  for (const [cx, cy] of SQ) expect(b.some(([x, y]) => x === cx && y === cy)).toBe(true); // square corners still snap
});

import { resolveLoftRings } from "../src/framework/geometry/loft-rings.js";
import { loftShadingPolicy, SMOOTH, FACETED } from "../src/framework/geometry/shading-policy.js";

test("resolveLoftRings: poly-exact resolved pts2d are byte-identical to the legacy bake", () => {
  const { mode, resolved } = resolveLoftRings([{ polygon: SQ, z: 0, scale: 2, rotate: 90 }, { polygon: SQ, z: 10 }]);
  expect(mode).toBe("poly-exact");
  expect(resolved[1].pts2d).toEqual(SQ); // identity transform: caller's numbers verbatim
  expect(resolved[0].z).toBe(0);
});

test("resolveLoftRings: curve mode carries both pts2d and the baked contour", () => {
  const rsq = roundedProfile(SQ, 2);
  const { mode, resolved } = resolveLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: 0.5 }]);
  expect(mode).toBe("curve");
  expect(resolved[0].pts2d.length).toBe(resolved[1].pts2d.length);
  expect(resolved[0].contour.segments.filter((s) => s.via).length).toBe(4);
});

test("resolveLoftRings: mixed CW point ring + all-line contour ring both come out CCW (finding 1 fix)", () => {
  const CW = [[-5, -5], [-5, 5], [5, 5], [5, -5]]; // same square as SQ, wound clockwise
  const contourSQ = pointsToContour(SQ);           // all-line contour form of the same square
  const { mode, resolved } = resolveLoftRings([{ polygon: CW, z: 0 }, { polygon: contourSQ, z: 10 }]);
  expect(mode).toBe("poly-exact");
  const area = (ring) => ring.reduce((a, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return a + x * ny - nx * y; }, 0) / 2;
  expect(area(resolved[0].pts2d)).toBeGreaterThan(0); // was CW (negative) pre-fix
  expect(area(resolved[1].pts2d)).toBeGreaterThan(0);
});

test("resolveLoftRings: an all-point-list ring set stays untouched even with a CW ring (bit-exactness preserved)", () => {
  const CW = [[-5, -5], [-5, 5], [5, 5], [5, -5]];
  const { resolved } = resolveLoftRings([{ polygon: CW, z: 0 }, { polygon: CW, z: 10 }]);
  expect(resolved[0].pts2d).toEqual(CW); // untouched — legacy self-correction happens downstream in loftMesh
});

test("resolveLoftRings: resample mode has equal-N pts2d and null contours", () => {
  const { mode, resolved } = resolveLoftRings([{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 9 }]);
  expect(mode).toBe("resample");
  expect(resolved[0].pts2d.length).toBe(resolved[1].pts2d.length);
  expect(resolved[0].contour).toBeNull();
});

test("resample: corner snapping respects contest rule (closer corner wins via snapshot)", () => {
  // Construct a contested case: two corners competing for one sample position.
  // Use a simple 2-ring loft where the resampled ring passes between two corners.
  // The smaller (closer) circle's point should claim the sample over the larger one.
  const smallCircle = circleProfile(1);         // circle, radius 1
  const largeCircle = circleProfile(3);         // circle, radius 3
  const lifted = liftLoftRings([{ polygon: smallCircle, z: 0 }, { polygon: largeCircle, z: 9 }]);
  const [small, large] = resampleTessellation(lifted);
  expect(small.length).toBe(large.length);
  // Verify both rings are CCW
  const area = (ring) => ring.reduce((s, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return s + x * ny - nx * y; }, 0) / 2;
  expect(area(small)).toBeGreaterThan(0);
  expect(area(large)).toBeGreaterThan(0);
  // Small ring corners should survive (they are the closer candidates when snapping occurs)
  const smallCorners = smallCircle;
  for (const [cx, cy] of smallCorners)
    expect(small.some(([x, y]) => Math.hypot(x - cx, y - cy) < 0.01)).toBe(true);
});

test("shading: any curved ring segment ⇒ SMOOTH", () => {
  const rl = resolveLoftRings([{ polygon: roundedProfile(SQ, 2), z: 0 }, { polygon: roundedProfile(SQ, 2), z: 9 }]);
  expect(loftShadingPolicy(rl, {})).toBe(SMOOTH);
});

test("shading: low-count all-line rings stay FACETED; 32+ resolved sides shade SMOOTH", () => {
  expect(loftShadingPolicy(resolveLoftRings([{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 9 }]), {})).toBe(FACETED);
  expect(loftShadingPolicy(resolveLoftRings([{ sides: 48, radius: 8, z: 0 }, { sides: 48, radius: 8, z: 9 }]), {})).toBe(SMOOTH);
});

test("shading: explicit hint and ruled:false still win", () => {
  const rl = resolveLoftRings([{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 9 }]);
  expect(loftShadingPolicy(rl, { shading: "smooth" })).toBe(SMOOTH);
  expect(loftShadingPolicy(rl, { ruled: false })).toBe(SMOOTH);
  expect(() => loftShadingPolicy(rl, { shading: "flat" })).toThrow(/smooth.*faceted/);
});

// ── Shading provenance (sector detection) ───────────────────────────────────
// A "D" profile: straight chord + semicircular arc, meeting at two sharp 90°
// joints — the minimal contour with both a flat span and a smooth span.
const dProfile = { start: [-4, 0], segments: [
  { to: [4, 0] },                    // chord (line)
  { to: [-4, 0], via: [0, 4] },      // semicircle back over the top (arc)
] };

test("curve-mode shading provenance: D-profile splits into a flat sector and a smooth sector", () => {
  const { mode, shading } = resolveLoftRings([{ polygon: dProfile, z: 0 }, { polygon: dProfile, z: 8, scale: 0.5 }]);
  expect(mode).toBe("curve");
  const { sectorOf, sectorSmooth } = shading;
  expect(sectorSmooth.length).toBe(2);
  // column 0 is the chord (seg 0 has 1 sample); its sector is flat
  expect(sectorSmooth[sectorOf[0]]).toBe(false);
  // a mid-arc column belongs to the smooth sector
  expect(sectorSmooth[sectorOf[Math.floor(sectorOf.length / 2)]]).toBe(true);
  // exactly the two sectors appear, split at the two sharp joints
  expect(new Set(sectorOf).size).toBe(2);
});

test("curve-mode shading provenance: a tangent-only contour (rounded square) is ONE smooth sector", () => {
  const { shading } = resolveLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 8, scale: 0.5 }]);
  expect(new Set(shading.sectorOf).size).toBe(1);
  expect(shading.sectorSmooth).toEqual([true]);
});

test("resample-mode shading provenance: square→circle sectors split at the snapped corners", () => {
  const { mode, shading } = resolveLoftRings([{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 8 }]);
  expect(mode).toBe("resample");
  expect(new Set(shading.sectorOf).size).toBe(4);          // one sector per square corner span
  expect(shading.sectorSmooth.every((s) => s === true)).toBe(true); // gentle interior turns on both rings
});

test("poly-exact rings carry no shading provenance (legacy single-surface path)", () => {
  const { shading } = resolveLoftRings([{ polygon: SQ, z: 0 }, { polygon: SQ, z: 8 }]);
  expect(shading).toBeNull();
});
