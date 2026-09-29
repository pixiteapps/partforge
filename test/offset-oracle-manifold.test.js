// Oracle: the deleted Manifold/Clipper2 offset route, reconstructed test-locally
// against the raw manifold-3d WASM (not the framework's manifold-backend.js, which
// no longer has an offset route at all — Shape2D.offset runs the native engine on
// BOTH backends now). This is the safety net for the native contour-offset engine:
// it exists to FIND divergence from Clipper2, not to be green.
//
// Compares round + sharp + chamfer. Chamfer maps to Clipper2's Round join with
// circularSegments=4 (NOT this file's SEGS=64) — the exact mapping the deleted
// manifold-backend.js used for chamfer, since a true 45-degree bevel is a 4-segment
// "round" arc collapsed to its chord. That mapping matches native to float precision
// at interior angles >= 90 degrees (the deleted backend's own comment: "the two agree
// to float precision for convex corners with interior angle >= 90deg"); at ACUTE
// (<90deg) corners Clipper2's 2-facet approximation genuinely diverges from native's
// true bevel (see KERNEL-CONTRACT / manifold-backend history) — but no corpus case
// below has an acute corner (square/L-shape/circle are all >=90deg), so that
// divergence is real but currently UNEXERCISED. A future acute-cornered corpus
// addition must account for this before enabling chamfer on it.
//
// Manifold must NOT boot in the same process as OCCT (see offset-oracle-occt.test.js) —
// this file boots only manifold-3d, and the two are separate vitest files (vitest
// isolates per file) so that invariant holds automatically.
import { beforeAll, describe, expect, test } from "vitest";
import Module from "manifold-3d";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea, pointInRing } from "../src/framework/geometry/shape2d-regions.js";
import { minkowskiOracle } from "./helpers/minkowski-oracle.js";

const SEGS = 64;
const rings = (regions) => regions.flatMap((rg) =>
  [tessellateContour(rg.outer, SEGS), ...rg.holes.map((h) => tessellateContour(h, SEGS))]);
const totalArea = (rs) => rs.reduce((a, r) => a + ringArea(r), 0);
// one-directional sampled boundary distance: max over a's points of min distance to b's segments
function boundaryDist(a, b) {
  const segDist = (p, q1, q2) => {
    const dx = q2[0] - q1[0], dy = q2[1] - q1[1];
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / L2));
    return Math.hypot(p[0] - (q1[0] + t * dx), p[1] - (q1[1] + t * dy));
  };
  let worst = 0;
  for (const ring of a) for (const p of ring) {
    let best = Infinity;
    for (const r2 of b) for (let i = 0; i < r2.length; i++)
      best = Math.min(best, segDist(p, r2[i], r2[(i + 1) % r2.length]));
    worst = Math.max(worst, best);
  }
  return worst;
}
const hausdorff = (a, b) => Math.max(boundaryDist(a, b), boundaryDist(b, a));

// Corpus: name, regions (contour IR), deltas to test, and optionally which corner styles
// (default: all three — see the acute entries below for why some cases restrict it).
// Polygonal + curved cases.
const sq = (s) => ({ outer: { start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] }, holes: [] });
const circ = (r) => ({ outer: { start: [r, 0], segments: [{ via: [0, r], to: [-r, 0] }, { via: [0, -r], to: [r, 0] }] }, holes: [] });
const Lsh = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] }, holes: [] };
// 30×10 dumbbell — two 10×10 lobes joined by a 2-wide waist. At delta −2 the waist pinches
// shut and the shape must SPLIT into two 6×6 squares (72). Every failure mode this branch's
// review found lives in that split, so it belongs in the honest-agreement corpus rather than
// only in the pure unit tests.
const dumb = (dx) => ({ outer: { start: [dx, 0], segments: [
  { to: [dx + 10, 0] }, { to: [dx + 10, 4] }, { to: [dx + 20, 4] }, { to: [dx + 20, 0] }, { to: [dx + 30, 0] },
  { to: [dx + 30, 10] }, { to: [dx + 20, 10] }, { to: [dx + 20, 6] }, { to: [dx + 10, 6] }, { to: [dx + 10, 10] },
  { to: [dx, 10] }, { to: [dx, 0] }] }, holes: [] });
// Acute corners: an 11-point star (alternating radii 10/4) whose points are ~33° interior.
const acuteStar = (() => {
  const pts = [];
  for (let i = 0; i < 11; i++) { const r = i % 2 === 0 ? 10 : 4, a = (2 * Math.PI * i) / 11; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
  if (ringArea(pts) < 0) pts.reverse();
  return { outer: { start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] }, holes: [] };
})();
const CORPUS = [
  { name: "square", regions: [sq(10)], deltas: [1, -1, 2.5], curved: false },
  { name: "circle", regions: [circ(5)], deltas: [1, -2], curved: true },
  { name: "L-shape", regions: [Lsh], deltas: [1, -1.5], curved: false },
  { name: "square+hole", regions: [{ ...sq(10), holes: [{ start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] }] }], deltas: [0.5, -0.5], curved: false },
  { name: "dumbbell", regions: [dumb(0)], deltas: [1], curved: false },
  // The pinch itself, all three corner styles. Used to diverge badly from Clipper2 with a
  // ROUND or CHAMFER join (97.258 and 96.000 against 72.354 and 74.000) — the deleted
  // splitAtDuplicateEdges recovery was lines-only, so a join that introduced an arc or a
  // bevel chord at the waist left nothing for it to cut. resolveOffsetWinding has no such
  // gap (it works from crossings and winding, not duplicate-edge detection), so all three
  // styles now agree with Clipper2 — see the "formerly-parked divergences" describe block
  // below for the exact, no-longer-parked numbers.
  { name: "dumbbell (pinched waist)", regions: [dumb(0)], deltas: [-2], curved: false },
  // Two disjoint regions in ONE offset call — the multi-region path, which the corpus
  // otherwise never exercised (every case above is a single region).
  { name: "two disjoint squares", regions: [sq(10), { outer: { start: [20, 0], segments: [{ to: [34, 0] }, { to: [34, 10] }, { to: [20, 10] }, { to: [20, 0] }] }, holes: [] }], deltas: [1, -1], curved: false },
  // Acute corners on the TRIM side (inward): all three styles agree with Clipper2 exactly,
  // because an inward offset of a convex corner trims rather than joining, so no join policy
  // is involved and there is nothing for the miter limit to bite on.
  { name: "acute 11-point star (inward)", regions: [acuteStar], deltas: [-1], curved: false },
  // Acute corners on the JOIN side (outward): ROUND only. This is where the v2 migration note
  // (docs/KERNEL-CONTRACT.md § Versioning) applies — at +2 native gives sharp 282.158 and
  // chamfer 278.389 where Clipper2 gives 300.671 and 288.138, and that divergence is CORRECT
  // and deliberate: native applies miter limit 2 with a bevel fallback (matching this repo's
  // own offsetPolygon to the digit, and OCCT's `bevel` join for chamfer), where Clipper2
  // squares off past its limit and approximates a bevel with two chords. Asserting agreement
  // for sharp/chamfer here would be asserting Clipper2's join policy, not offset correctness.
  { name: "acute 11-point star (outward)", regions: [acuteStar], deltas: [2], corners: ["round"], curved: false },
];
const AREA_RTOL = 0.005;                       // 0.5 %
const HAUS_TOL = (curved) => (curved ? 2e-2 : 5e-3);  // curved: absorb the oracle's own faceting

let CrossSection;
beforeAll(async () => {
  const wasm = await Module();
  wasm.setup();
  CrossSection = wasm.CrossSection;
});

// [joinType, circularSegments] — chamfer rides Clipper2's Round join but with
// circularSegments=4 instead of this file's SEGS=64, matching the deleted
// manifold-backend.js's own chamfer mapping exactly (a 4-segment "round" arc IS a
// 45-degree-chord bevel, not a curve).
const JOIN = { round: ["Round", SEGS], sharp: ["Miter", SEGS], chamfer: ["Round", 4] };
// The oracle itself, callable from the parked block below so the "true" values there are
// DERIVED from Clipper2 in-file rather than hardcoded — this file already boots the WASM that
// knows them, so a hardcoded 348/408/928.274 is a copy that can silently go stale.
const clipperRings = (regions, delta, corners) => {
  const [joinType, circularSegments] = JOIN[corners];
  return CrossSection.ofPolygons(rings(regions), "EvenOdd").offset(delta, joinType, 2, circularSegments).toPolygons();
};
const clipperArea = (regions, delta, corners) => Math.abs(totalArea(clipperRings(regions, delta, corners)));

// ── topology ────────────────────────────────────────────────────────────────────────────
// Area agreement is the WEAKER half of this file. The text bug this branch exists to fix sat
// within 0.1–0.3 % on area while being badly wrong topologically — a dilated "o" whose
// counter had closed came back as 25 regions and 11 holes, 0.21 % from the true area — so an
// area-only corpus passes it. Every comparison below therefore asserts region count and hole
// count too, both DERIVED from the oracle in-file rather than hardcoded.
//
// A ring under SLIVER is not a feature; it is a resolver artifact (see the glyph block for
// what is known about them). Applied to BOTH sides before any count, so the filter can never
// hide a disagreement it does not also hide on the oracle.
const SLIVER = 1e-3;                                     // mm²
// Clipper2 under any fill rule hands outers back CCW (positive area) and holes CW, so the
// signed area of each returned ring is its own classifier.
function ringTopology(pointRingList) {
  let regions = 0, holes = 0;
  for (const r of pointRingList) {
    const a = ringArea(r);
    if (Math.abs(a) < SLIVER) continue;
    if (a > 0) regions++; else holes++;
  }
  return { regions, holes };
}
// The native side keeps its region/hole nesting, so count it structurally rather than by sign
// — a native hole ring's stored winding is the engine's claim, and reading the claim back as
// the classifier would make the check circular.
function nativeTopology(out) {
  let regions = 0, holes = 0;
  for (const rg of out) {
    if (Math.abs(ringArea(tessellateContour(rg.outer, SEGS))) < SLIVER) continue;
    regions++;
    for (const h of rg.holes) if (Math.abs(ringArea(tessellateContour(h, SEGS))) >= SLIVER) holes++;
  }
  return { regions, holes };
}

for (const { name, regions, deltas, curved, corners: styles = ["round", "sharp", "chamfer"] } of CORPUS) {
  for (const delta of deltas) for (const corners of styles) {
    test(`${name} delta=${delta} ${corners} matches Clipper2 within tolerance`, () => {
      const out = offsetRegions(regions, delta, { corners });
      const native = rings(out);
      const oracle = clipperRings(regions, delta, corners);
      expect(Math.abs(totalArea(native) - totalArea(oracle)) / Math.abs(totalArea(oracle))).toBeLessThan(AREA_RTOL);
      expect(hausdorff(native, oracle)).toBeLessThan(HAUS_TOL(curved));
      expect(nativeTopology(out)).toEqual(ringTopology(oracle));
    });
  }
}

// Known divergences (parked): cases where the native engine is KNOWN to disagree
// with the true offset result, verified by independent grid computation. These are
// NOT part of the honest-agreement corpus above — asserting equality here would
// either fail (masking nothing) or force the tolerances open (masking everything
// else). Instead: characterization tests. Each asserts the native engine's CURRENT
// (defective) measured value within a loose band, with the true value and root
// cause recorded in a comment, so a regression that makes the defect WORSE breaks
// the band, and a fix that makes it correct is expected to break the band too —
// at which point the case should be deleted from here and promoted to the main
// corpus above. As of task 7B there are NO parked divergences left — every case that
// was ever parked here now agrees with Clipper2 and lives in the block below. Keep
// the convention: a newly-found divergence goes back into a "known divergences
// (parked)" describe of its own rather than into the agreement corpus with a widened
// tolerance.
//
// Formerly parked as divergences, now FIXED and asserted as correctness. Both used to be
// topologically invalid output — two hole rings overlapping each other, and a hole ring
// escaping its own outer — which is not merely an accuracy gap: pushed through toRegions()
// and CrossSection.ofPolygons(…, "EvenOdd"), which is exactly what extrude does, the
// doubly-covered lens came back as SOLID material (merge extruded to 360 mm² against a truth
// of 348, breakthrough to 436 against 408). Both were regressions against 0.57 on Manifold,
// where Clipper2 returned 348.000 and 408.000 exactly. The fix is in contour-offset.js:
// ringsCross now also tests segsOverlap, hole containment tests the whole hole ring rather
// than one point of it, and the cleanup stage unites the outers and SUBTRACTS the united hole
// rings instead of self-uniting everything under one even-odd compound.
describe("formerly-parked divergences, now correct", () => {
  const plate40 = { start: [0, 0], segments: [{ to: [40, 0] }, { to: [40, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
  const netArea = (out) => out.reduce((a, rg) => a + Math.abs(ringArea(tessellateContour(rg.outer, SEGS)))
    - rg.holes.reduce((h, hole) => h + Math.abs(ringArea(tessellateContour(hole, SEGS))), 0), 0);

  test("merge: two nearby holes fuse into one hole, matching Clipper2 exactly", () => {
    // Two 6×8 holes (CW) 3 mm apart horizontally in a 40×20 plate, delta −2 sharp.
    const holeA = { start: [10, 6], segments: [{ to: [10, 14] }, { to: [16, 14] }, { to: [16, 6] }, { to: [10, 6] }] };
    const holeB = { start: [19, 6], segments: [{ to: [19, 14] }, { to: [25, 14] }, { to: [25, 6] }, { to: [19, 6] }] };
    const src = [{ outer: plate40, holes: [holeA, holeB] }];
    const truth = clipperArea(src, -2, "sharp");
    expect(truth).toBeCloseTo(348, 6);                      // sanity on the derived oracle value
    const out = offsetRegions(src, -2, { corners: "sharp" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);                    // ONE merged hole, not two overlapping rings
    expect(netArea(out)).toBeCloseTo(truth, 6);
    // and the result is topologically clean: the hole is fully inside its outer
    const outerRing = tessellateContour(out[0].outer, SEGS);
    expect(tessellateContour(out[0].holes[0], SEGS).every((p) => pointInRing(p, outerRing))).toBe(true);
  });

  test("breakthrough: a hole near the edge is clipped by the eroded outer, matching Clipper2 exactly", () => {
    // 10×10 hole (CW) 2 mm above the plate's bottom edge, delta −2 sharp.
    const hole = { start: [15, 2], segments: [{ to: [15, 12] }, { to: [25, 12] }, { to: [25, 2] }, { to: [15, 2] }] };
    const src = [{ outer: plate40, holes: [hole] }];
    const truth = clipperArea(src, -2, "sharp");
    expect(truth).toBeCloseTo(408, 6);                      // sanity on the derived oracle value
    const out = offsetRegions(src, -2, { corners: "sharp" });
    expect(out.length).toBe(1);
    // the grown hole reaches past the eroded bottom edge, so it becomes a notch in the
    // outline rather than a hole — no hole ring survives, and none escapes its outer
    expect(out[0].holes.length).toBe(0);
    expect(netArea(out)).toBeCloseTo(truth, 6);
  });

  // Task 7 (winding resolver wiring): the two cases below used to live in "known
  // divergences (parked)" — the deleted paper.js cleanup path (resolveSelfRegions /
  // splitAtDuplicateEdges) had no global validity check for a raw offset ring that is
  // locally valid (simple, correctly wound) but should have vanished or split entirely.
  // resolveOffsetWinding computes the raw curve's positive-winding region directly, which
  // has no such gap: a fully-eroded pocket is negative-winding everywhere and drops out on
  // its own, and a pinched waist's two lobes are two separate positive-winding faces
  // regardless of whether the join at the pinch is a line, an arc, or a bevel chord.
  test("wide L-pocket: delta closes a 5-wide-arm pocket, matching Clipper2 exactly", () => {
    // 30x20 plate with a wide L-shaped pocket (5-unit arms, the same shape family as
    // test/contour-offset.test.js's narrow-arm (4-unit) L-pocket fixture, scaled up)
    // cut out, offset +3. Max inscribed circle in the pocket has radius 2.5 < delta 3,
    // so the pocket (hole) fully closes (0 holes, true area = 928.274 — pure
    // (w+2d)(h+2d) - (4-pi)d^2 rounded-rect growth of the 30x20 plate, since no hole
    // survives to subtract).
    const plate = { start: [0, 0], segments: [{ to: [30, 0] }, { to: [30, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    // L-pocket, both arms 5 wide: vertical arm x:[10,15] y:[6,15]; horizontal arm
    // y:[6,11] x:[10,21]; reflex vertex at (15,11). CW (hole) winding.
    const pocket = { start: [10, 6], segments: [
      { to: [10, 15] }, { to: [15, 15] }, { to: [15, 11] }, { to: [21, 11] }, { to: [21, 6] }, { to: [10, 6] }] };
    const src = [{ outer: plate, holes: [pocket] }];
    // Truth, DERIVED from Clipper2 in-file rather than hardcoded: 928.229 at this file's
    // SEGS=64 faceting, converging on the closed-form 928.274 as segments rise.
    const truth = clipperArea(src, 3, "round");
    expect(truth).toBeCloseTo(928.23, 1);
    const out = offsetRegions(src, 3, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(netArea(out)).toBeCloseTo(truth, 1);
  });

  test("pinched waist: round and chamfer joins now split the dumbbell correctly, matching Clipper2", () => {
    // The same 30x10 dumbbell the corpus above offsets at -2 SHARP (splits into two 6x6
    // squares, matches Clipper2 exactly). ROUND and CHAMFER used to leave one connected,
    // over-solid blob (97.258 and 96.000, ~34% and ~30% too much) because the deleted
    // splitAtDuplicateEdges recovery only handled rings made entirely of straight lines —
    // a round or chamfer join inserts an arc or a bevel chord at the waist, leaving no
    // pair of duplicate collinear edges to cut. resolveOffsetWinding doesn't need that
    // recovery: the two lobes are separated by winding number directly.
    const src = [dumb(0)];
    for (const [corners, want] of [["round", 72.3537], ["chamfer", 74]]) {
      const truth = clipperArea(src, -2, corners);
      expect(truth).toBeCloseTo(want, 3);                   // sanity on the derived oracle value
      const out = offsetRegions(src, -2, { corners });
      const areas = out.map((rg) => Math.abs(ringArea(tessellateContour(rg.outer, SEGS))));
      expect(out.length).toBe(2);                           // the two lobes, no spurious blob
      expect(areas.every((a) => a > 30)).toBe(true);         // both are real lobes, not a sliver
      expect(areas.reduce((a, b) => a + b, 0)).toBeCloseTo(truth, 1);
    }
  });

  // Task 7B: the last parked divergence, now also correct. A 9-gon with three clustered
  // reflex corners at delta -2.79 read 7.70938 under the old paper.js self-union, 4.621926
  // once resolveOffsetWinding landed, and 3.553831 — the true value — once the overlap-side
  // TRIM in _offsetContour was gated on the offset lines actually crossing within both
  // segments' extents. The residual was never in the join policy or the resolver: it was the
  // trim silently EXTENDING two offset segments to a crossing point outside both of them,
  // fabricating material the raw offset never covered, on a ring simple and well-wound enough
  // that nothing downstream could object. See contour-offset.js's trim comment and
  // task-7B-report.md.
  test("clustered reflex corners: 9-gon chamfer offset matches Clipper2 exactly", () => {
    const pts = [[19.49, 10], [12.33, 11.95], [11.2, 16.81], [8.87, 11.96], [0.93, 13.3], [3.45, 7.62], [8.52, 7.44], [10.92, 4.78], [15.09, 5.73]];
    const nonagon = { start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] };
    const src = [{ outer: nonagon, holes: [] }];
    // Truth, DERIVED from Clipper2 in-file rather than hardcoded: 3.553831 under this file's
    // chamfer mapping (Clipper2's round join at circularSegments=4, which at these sweeps IS
    // a single-chord bevel). Confirmed independently by an explicit Minkowski-union
    // construction — erode(S, r) = Box \ dilate(Box \ S, r), dilate built as the union of the
    // edge slabs and the triangular bevel caps, with Clipper2 used only as a boolean engine
    // and never as an offsetter — which agrees to all six digits. NB for anyone re-deriving
    // this: Clipper2's JoinType::Square (2.701770) is NOT this engine's chamfer semantic and
    // must not be cited as one — it returns LESS area than its own Round join (2.765184),
    // which is impossible for a chord bevel on an erosion, since the chord cuts closer to the
    // reflex vertex than the arc does and must therefore retain MORE material. 2.76 is the
    // ROUND truth for this shape, not the chamfer truth.
    const truth = clipperArea(src, -2.79, "chamfer");
    expect(truth).toBeCloseTo(3.553831, 5);
    const out = offsetRegions(src, -2.79, { corners: "chamfer" });
    const area = out.reduce((a, rg) => a + Math.abs(ringArea(tessellateContour(rg.outer, SEGS))), 0);
    expect(area).toBeCloseTo(truth, 5);
  });

  test("clustered reflex corners: the same 9-gon under round and sharp joins", () => {
    const pts = [[19.49, 10], [12.33, 11.95], [11.2, 16.81], [8.87, 11.96], [0.93, 13.3], [3.45, 7.62], [8.52, 7.44], [10.92, 4.78], [15.09, 5.73]];
    const nonagon = { start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] };
    const src = [{ outer: nonagon, holes: [] }];
    // Round is where the "~2.76" figure quoted around this shape actually belongs: Clipper2's
    // round join gives 2.765184 here and the Minkowski construction 2.761295, converging as
    // the fan resolution rises. Sharp (miter, limit 2) is the tightest of the three at
    // 2.593411. Native agreed with none of the three before the trim gate (3.577195 / 4.621926
    // / 2.722960) and agrees with all three after.
    for (const corners of ["round", "sharp"]) {
      const truth = clipperArea(src, -2.79, corners);
      const out = offsetRegions(src, -2.79, { corners });
      const area = out.reduce((a, rg) => a + Math.abs(ringArea(tessellateContour(rg.outer, SEGS))), 0);
      expect(Math.abs(area - truth) / truth).toBeLessThan(AREA_RTOL);
    }
  });
});

// ── Known divergences (parked), re-opened by Task 7C ────────────────────────────────────
//
// Task 7B emptied this list; Task 7C's Minkowski-union oracle (test/helpers/minkowski-oracle.js)
// refilled it. Fixing the vertex-incident self-crossing miss made the engine agree with that
// oracle on every case the fix touched, but sweeping ~13 800 rectilinear cases against the
// oracle surfaced three classes it does NOT touch, all pre-existing. They are parked here per
// this file's convention: the truth is DERIVED in-file (never hardcoded), the engine's current
// defective value is pinned in a loose band, and the root cause is recorded. A fix is expected
// to break these tests, at which point the case moves up into the corpus.
//
// The oracle used here is the Minkowski construction, not `clipperArea` — Task 7B established
// that Clipper2's Round@circularSegments=4 is not this engine's chamfer at acute corners, so
// for newly-found divergences the construction that never calls an offsetter is the arbiter.
//
// Task 7D updated this list: class 3 (the four-notch comb) is no longer a throw and has moved
// up into the corpus below the parked block; what is parked in its place is the narrow residual
// band the fallback ladder still does not cover. It also retired the "the remaining gap is the
// ROUND join — arcs reaching resolveOffsetWinding" reading that stood here. Round is where MOST
// of the remaining defect sits, but not all of it (class 2 is join-independent, and chain
// failures were measured under chamfer and sharp too, on rectilinear shapes whose offsets
// contain no arcs at all), so the arc mechanism is disproven and no replacement mechanism is
// asserted. What the classes below share is only that chamfer and sharp are exact on the same
// inputs, which is evidence of a real engine defect rather than oracle error — not a cause.
describe("known divergences (parked) — Task 7C", () => {
  const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] });
  const holeRect = (x0, y0, x1, y1) => ring([[x0, y0], [x0, y1], [x1, y1], [x1, y0]]);   // CW
  const pointRing = (c) => tessellateContour(c, SEGS);
  let O;
  beforeAll(() => { O = minkowskiOracle(CrossSection); });
  // The oracle takes point rings; feed it the same tessellation this file measures with.
  const truthOf = (src, delta, corners) =>
    O.area(src.map((rg) => ({ outer: pointRing(rg.outer), holes: rg.holes.map(pointRing) })),
      delta, { corners, fan: 4096 });
  const engineArea = (src, delta, corners) => totalArea(rings(offsetRegions(src, delta, { corners })));

  // The "this style is exact" companion assertions below are held to 1e-4 mm² absolute, not to
  // toBeCloseTo's 6 digits. 6 digits is ~5e-9 relative on a ~96 mm² area, and the two sides are
  // computed by completely different means: the ORACLE side is a float sum over
  // Clipper2-assembled polygon geometry (it unions its slabs and caps through CrossSection),
  // while the ENGINE side is a pure-JS shoelace over this file's own tessellation of the
  // engine's contour IR. Holding two independent summations of ~96 mm² to 5e-9 relative is
  // asserting a coincidence of rounding order, and a Clipper2 bump — or a change to SEGS —
  // could move it with nothing being wrong. 1e-4 mm² is still four orders below the
  // divergences this block parks, so nothing this file exists to catch can hide under it.
  // THIS IS THE ONE PLACE IN THIS FILE WHERE A LOOSER BOUND IS THE RIGHT ONE — it is not a
  // licence to loosen an assertion that is actually failing.
  const EXACT_TOL = 1e-4;
  const expectExact = (got, truth) => expect(Math.abs(got - truth)).toBeLessThan(EXACT_TOL);

  // 1. ROUND-only over-inclusion when several grown holes reach the eroded outer boundary.
  //    Chamfer and sharp resolve it exactly (the grown holes become notches in the outline,
  //    0 holes out); round keeps ~26 % too much material.
  test("plate with three holes at −2: round keeps 324.75 against a true 258.18", () => {
    const src = [{ outer: ring([[0, 0], [30, 0], [30, 20], [0, 20]]),
      holes: [holeRect(2, 1, 4, 6), holeRect(8, 10, 14, 13), holeRect(18, 13, 24, 17)] }];
    expectExact(engineArea(src, -2, "chamfer"), truthOf(src, -2, "chamfer"));             // correct
    expectExact(engineArea(src, -2, "sharp"), truthOf(src, -2, "sharp"));                 // correct
    const truth = truthOf(src, -2, "round");
    expect(truth).toBeGreaterThan(258); expect(truth).toBeLessThan(258.5);
    const got = engineArea(src, -2, "round");
    expect(got).toBeGreaterThan(320); expect(got).toBeLessThan(330);                      // PARKED
  });

  // 2. A hole narrower than 2·delta vanishes under round dilation via the source-inradius
  //    gate — and under SHARP too since the sheet-parts fix wave: a sharp dilation erodes a
  //    hole at least as deeply as the disk (its miter reaches past the arc at the hole's
  //    reflex corners), so the same gate is sound for it, and the oracle agrees. Chamfer's
  //    bevel removes LESS than the arc there, so the disk rule would be the wrong criterion
  //    for it; chamfer remains parked.
  const out1holeCount = (src, corners) =>
    offsetRegions(src, 2, { corners }).reduce((a, rg) => a + rg.holes.length, 0);
  test("1×1 hole at +2 vanishes for round and sharp; chamfer remains parked", () => {
    const src = [{ outer: ring([[0, 0], [30, 0], [30, 20], [0, 20]]), holes: [holeRect(23, 2, 24, 3)] }];
    const truth = truthOf(src, 2, "chamfer");
    const got = engineArea(src, 2, "chamfer");
    expect(out1holeCount(src, "chamfer")).toBe(1);                                  // PARKED
    expect(truth - got).toBeGreaterThan(1.9);
    expect(truth - got).toBeLessThan(2.1);
    for (const corners of ["round", "sharp"]) {
      const cornersTruth = truthOf(src, 2, corners);
      const cornersGot = engineArea(src, 2, corners);
      expect(out1holeCount(src, corners), corners).toBe(0);
      expect(Math.abs(cornersGot - cornersTruth) / cornersTruth, corners).toBeLessThan(AREA_RTOL);
    }
  });

  // 3. The residual of what used to be a wider chain-incomplete failure. The fixed-distance
  //    classifier probe crossed the narrow cell beside the left pinch, read wLeft=0/wRight=-1,
  //    and dropped a real boundary piece. Round and chamfer then dead-ended in _chain; sharp
  //    happened to close after silently dropping a genuine ~0.01 mm² second component. The
  //    adaptive probe chooses a less-contested point on the same piece and all three styles now
  //    agree with independently-derived topology and area.
  test("four-notch comb at −2.4975: all corner styles retain the oracle topology at the pinch", () => {
    const comb = [{ outer: ring([[0, 0], [38, 0], [38, 10], [15, 10], [15, 5], [12, 5], [12, 10],
      [9, 10], [9, 4.5], [7, 4.5], [7, 10], [5, 10], [5, 5], [4, 5], [4, 10], [0, 10]]), holes: [] }];
    for (const corners of ["round", "chamfer", "sharp"]) {
      const out = offsetRegions(comb, -2.4975, { corners });
      const oracle = clipperRings(comb, -2.4975, corners);
      expect(nativeTopology(out)).toEqual(ringTopology(oracle));
      const truth = truthOf(comb, -2.4975, corners);
      expect(Math.abs(totalArea(rings(out)) - truth) / truth).toBeLessThan(AREA_RTOL);
    }
    // Neighbours stay covered so a future change cannot merely move the cliff sideways.
    expect(() => offsetRegions(comb, -2.4905, { corners: "round" })).not.toThrow();
    expect(() => offsetRegions(comb, -2.5045, { corners: "round" })).not.toThrow();
  });

  // 4. This 12-vertex two-notch plate was the counterexample that proved chain-incomplete was
  //    not a round-join effect: sharp and chamfer both threw at −3.25 while round built. It was
  //    the same contested-probe mechanism as the comb above, and all three styles now agree
  //    with independently-derived topology and area at the formerly-failing delta.
  test("two-notch plate at −3.25: all corner styles match the oracle", () => {
    const plate = [{ outer: ring([[0, 0], [32, 0], [32, 9],
      [9.428889, 9], [9.428889, 6.506983], [8.403683, 6.506983], [8.403683, 9],
      [5.132466, 9], [5.132466, 1.541126], [1.86893, 1.541126], [1.86893, 9], [0, 9]]), holes: [] }];
    for (const corners of ["round", "sharp", "chamfer"]) {
      const out = offsetRegions(plate, -3.25, { corners });
      expect(nativeTopology(out)).toEqual(ringTopology(clipperRings(plate, -3.25, corners)));
      const truth = truthOf(plate, -3.25, corners);
      expect(truth).toBeGreaterThan(40);
      expect(Math.abs(totalArea(rings(out)) - truth) / truth).toBeLessThan(AREA_RTOL);
      // Neighbours remain within their style's established policy, so the fix closes the
      // narrow failure band rather than moving it. Sharp/chamfer were float-exact here;
      // round carries the independent oracle's ordinary arc-faceting difference.
      for (const d of [-3.2, -3.3]) {
        const neighbourTruth = truthOf(plate, d, corners);
        const neighbourGot = engineArea(plate, d, corners);
        if (corners === "round")
          expect(Math.abs(neighbourGot - neighbourTruth) / neighbourTruth).toBeLessThan(AREA_RTOL);
        else expectExact(neighbourGot, neighbourTruth);
      }
    }
  });
});

// ── Four-notch comb at −2.5/round ─────────────────────────────────────────────────────────
//
// This was parked class 3 above: a hard throw where 91.744 mm² of the part survives. It is not
// only builds now; the adaptive classifier keeps all four real components directly. The truth
// is the oracle's, derived in-file as everywhere else in this file.
describe("four-notch comb at −2.5", () => {
  const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] });
  const pointRing = (c) => tessellateContour(c, SEGS);
  let O;
  beforeAll(() => { O = minkowskiOracle(CrossSection); });
  const comb = [{ outer: ring([[0, 0], [38, 0], [38, 10], [15, 10], [15, 5], [12, 5], [12, 10],
    [9, 10], [9, 4.5], [7, 4.5], [7, 10], [5, 10], [5, 5], [4, 5], [4, 10], [0, 10]]), holes: [] }];

  test("the direct resolver retains all four oracle components", () => {
    const truth = O.area(comb.map((rg) => ({ outer: pointRing(rg.outer), holes: rg.holes.map(pointRing) })),
      -2.5, { corners: "round", fan: 4096 });
    expect(truth).toBeGreaterThan(91.74); expect(truth).toBeLessThan(91.75);   // the oracle's own answer
    const out = offsetRegions(comb, -2.5, { corners: "round" });
    const got = totalArea(rings(out));
    // 2e-4 relative is tighter than the engine's ordinary round-join disagreement with the
    // independent Minkowski construction (up to 4.3e-3) while allowing the two methods'
    // different arc faceting. Measured here: 1.47e-4 relative.
    expect(Math.abs(got - truth) / truth).toBeLessThan(2e-4);
    const oracleRings = O.offset(comb.map((rg) => ({ outer: pointRing(rg.outer), holes: [] })),
      -2.5, { corners: "round", fan: 4096 }).toPolygons();
    expect(oracleRings.filter((r) => ringArea(r) > 0)).toHaveLength(4);        // derived truth
    expect(out).toHaveLength(4);
  });
});

// ── Glyphs (Task 8) ─────────────────────────────────────────────────────────────────────
//
// The case class whose ABSENCE is why the reported text bug shipped. Every case above is a
// hand-built polygon or a circle; a real glyph is a closed cubic outline with a counter,
// dozens of near-tangent joins, and acute corners at every terminal — and the engine behaves
// materially differently on one.
//
// The whole 6-glyph x 7-delta matrix is enumerated below under `round`, with truth DERIVED
// from Clipper2 in-file as everywhere else in this file. These are correctness assertions,
// not measured baselines: topology must match exactly, area must stay within the corpus
// tolerance, and the unfiltered result must contain no detached resolver slivers. The two
// intermediate deltas exercise the original "Scott" report between the older 0.5/1/2 pins.
describe("glyphs — the case class whose absence let the text bug ship", () => {
  const GLYPHS = ["o", "e", "a", "p", "t", "Scott"];
  const GLYPH_DELTAS = [0.2, 0.5, 0.8, 1, 1.5, 2, 3]; // brackets pinch recovery and counter collapse
  let glyph;                                         // ch -> regions
  // Every offset in this block is computed once here; Clipper2 truth is derived separately.
  let RUN;                                           // "ch@delta|corners" -> result | null
  beforeAll(async () => {
    const opentype = (await import("opentype.js")).default;
    const { textGlyphs } = await import("../src/framework/geometry/text2d.js");
    const { DEFAULT_FONT_BYTES: b } = await import("../src/framework/geometry/fonts/default-font.js");
    const font = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    glyph = Object.fromEntries(GLYPHS.map((ch) => [ch, textGlyphs(font, ch, { size: 10 })]));
    RUN = {};
    // Every glyph under `round`; single glyphs additionally exercise chamfer and sharp.
    // (scripts/offset-rates.mjs does sweep "Scott" all three ways, and it throws on all three.)
    for (const ch of GLYPHS) for (const d of GLYPH_DELTAS)
      for (const corners of ch === "Scott" ? ["round"] : ["round", "chamfer", "sharp"]) {
        try { RUN[`${ch}@${d}|${corners}`] = engineOf(offsetRegions(glyph[ch], d, { corners })); }
        catch (e) { RUN[`${ch}@${d}|${corners}`] = { error: e.message }; }
      }
  }, 30000);

  const truthOf = (ch, d) => {
    const oracle = clipperRings(glyph[ch], d, "round");
    return { ...ringTopology(oracle), area: Math.abs(totalArea(oracle)) };
  };
  const engineOf = (out) => {
    const t = nativeTopology(out);
    let area = 0;
    for (const rg of out) {
      const a = Math.abs(ringArea(tessellateContour(rg.outer, SEGS)));
      if (a < SLIVER) continue;
      area += a;
      for (const h of rg.holes) {
        const ha = Math.abs(ringArea(tessellateContour(h, SEGS)));
        if (ha >= SLIVER) area -= ha;
      }
    }
    return { ...t, area, raw: out.length };
  };

  for (const ch of GLYPHS) for (const d of GLYPH_DELTAS) {
    const key = `${ch}@${d}`;
    test(`"${ch}" +${d} round matches Clipper2 topology and area`, () => {
      const got = RUN[`${key}|round`];
      expect(got.error).toBeUndefined();
      const truth = truthOf(ch, d);
      expect({ regions: got.regions, holes: got.holes })
        .toEqual({ regions: truth.regions, holes: truth.holes });
      expect(Math.abs(got.area - truth.area) / truth.area).toBeLessThanOrEqual(AREA_RTOL);
      expect(got.raw).toBe(got.regions); // no source-less resolver slivers
    });
  }

  test("the whole round matrix has no parked throws or oracle divergences", () => {
    for (const ch of GLYPHS) for (const d of GLYPH_DELTAS) {
      const truth = truthOf(ch, d);
      const got = RUN[`${ch}@${d}|round`];
      expect(got.error, `${ch}@${d}`).toBeUndefined();
      expect([got.regions, got.holes], `${ch}@${d} topology`).toEqual([truth.regions, truth.holes]);
      expect(Math.abs(got.area - truth.area) / truth.area, `${ch}@${d} area`)
        .toBeLessThanOrEqual(AREA_RTOL);
    }
  });

  // The brief for this task named four targets derived from Clipper2. All four are asserted
  // here against the SAME derived truth, so the numbers below are sanity checks on the oracle
  // rather than a second source: "Scott" +3 = 522.349, "o" +3 = 139.537, "t" +3 = 121.842,
  // and "e"/"a"/"p" past collapse have no counter left. These values now guard the
  // corrected engine behavior rather than a measured limitation.
  test("the derived truths for the brief's four targets", () => {
    expect(truthOf("Scott", 3)).toEqual({ regions: 1, holes: 0, area: expect.closeTo(522.349, 2) });
    expect(truthOf("o", 3)).toEqual({ regions: 1, holes: 0, area: expect.closeTo(139.537, 2) });
    expect(truthOf("t", 3).area).toBeCloseTo(121.842, 2);
    for (const ch of ["e", "a", "p"]) expect(truthOf(ch, 3).holes).toBe(0);   // counters gone
  });

  test('"Scott" keeps native curves across the full round-offset range', () => {
    for (const d of GLYPH_DELTAS) {
      const out = offsetRegions(glyph.Scott, d, { corners: "round" });
      const segments = out.flatMap((rg) => [rg.outer, ...rg.holes]).flatMap((c) => c.segments);
      expect(segments.some((s) => s.via), `Scott@${d} should retain circular arcs`).toBe(true);
      expect(segments.some((s) => s.c1), `Scott@${d} should retain cubic curves`).toBe(true);
    }
  });

  test("all three corner styles complete across the single-glyph matrix", () => {
    for (const ch of GLYPHS.filter((g) => g !== "Scott")) for (const d of GLYPH_DELTAS)
      for (const corners of ["round", "chamfer", "sharp"])
        expect(RUN[`${ch}@${d}|${corners}`].error, `${ch}@${d}/${corners}`).toBeUndefined();
  });
});
