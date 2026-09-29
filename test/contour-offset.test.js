// Pure unit tests for the native contour offset engine — no WASM, no kernel boot.
import { describe, expect, test } from "vitest";
import { _offsetSegment, _rawOffset, _ladderRungs, _sourceHoleContainsDisk }
  from "../src/framework/geometry/contour-offset.js";
import { caseFor } from "./helpers/offset-corpus.js";

const close = (a, b, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(tol);

describe("line offset", () => {
  test("offsets right of travel", () => {
    // travel +x, right of travel is -y; delta +1 → shifted down
    const r = _offsetSegment([0, 0], { to: [10, 0] }, 1);
    close(r.start, [0, -1]); close(r.segments[0].to, [10, -1]);
    expect(r.dirty).toBe(false);
  });
});

describe("arc offset", () => {
  test("CCW arc grows concentrically with positive delta", () => {
    // quarter circle r=5 about origin, CCW from (5,0) to (0,5): right of travel is outward
    const r = _offsetSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, 1);
    close(r.start, [6, 0]); close(r.segments[0].to, [0, 6]);
    close(r.segments[0].via, [6 / Math.SQRT2, 6 / Math.SQRT2]);
    expect(r.dirty).toBe(false);
  });
  test("CW arc shrinks with positive delta", () => {
    // same quarter circle traversed CW from (0,5) to (5,0): right of travel is inward
    const r = _offsetSegment([0, 5], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [5, 0] }, 1);
    close(r.start, [0, 4]); close(r.segments[0].to, [4, 0]);
    expect(r.dirty).toBe(false);
  });
  test("radius inversion flags dirty", () => {
    const r = _offsetSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, -6);
    expect(r.dirty).toBe(true);
  });
  test("collinear via degrades to a line", () => {
    const r = _offsetSegment([0, 0], { via: [5, 0], to: [10, 0] }, 1);
    expect(r.segments[0].via).toBeUndefined();
    close(r.start, [0, -1]);
  });
});

describe("cubic offset", () => {
  test("offset endpoints displaced along endpoint normals; deviation within tolerance", () => {
    // quarter-circle cubic r=5 (k = 0.5523·r), CCW from (5,0) to (0,5)
    const k = 0.551915 * 5;
    const r = _offsetSegment([5, 0], { c1: [5, k], c2: [k, 5], to: [0, 5] }, 1);
    close(r.start, [6, 0], 1e-6); close(r.segments.at(-1).to, [0, 6], 1e-6);
    expect(r.dirty).toBe(false);
    // every emitted piece is a cubic
    for (const s of r.segments) expect(s.c1).toBeDefined();
  });
  test("subdivided pieces connect exactly", () => {
    const k = 0.551915 * 5;
    const r = _offsetSegment([5, 0], { c1: [5, k], c2: [k, 5], to: [0, 5] }, 4); // large delta forces subdivision
    expect(r.segments.length).toBeGreaterThan(1);
  });
});

import { _offsetContour, validateRawOffset } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const sq = (s) => ({ start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] });
const area = (c) => ringArea(tessellateContour(c, 256));
const kinds = (c) => c.segments.map((s) => (s.c1 ? "cubic" : s.via ? "arc" : "line"));

describe("offsetContour", () => {
  test("sharp outset of a square is the exact bigger square", () => {
    const { contour, dirty } = _offsetContour(sq(10), 1, "sharp");
    expect(dirty).toBe(false);
    expect(area(contour)).toBeCloseTo(144, 9);
    expect(kinds(contour).every((k) => k === "line")).toBe(true);
  });
  test("round outset adds exact quarter-circle arcs", () => {
    const { contour, dirty } = _offsetContour(sq(10), 1, "round");
    expect(dirty).toBe(false);
    expect(kinds(contour).filter((k) => k === "arc").length).toBe(4);
    expect(area(contour)).toBeCloseTo(140 + Math.PI, 2);  // exact πd² corners (tessellation-limited)
  });
  test("chamfer outset cuts 2d² off the sharp area", () => {
    const { contour } = _offsetContour(sq(10), 1, "chamfer");
    expect(area(contour)).toBeCloseTo(142, 9);
  });
  test("inset square trims line-line corners exactly on the fast path", () => {
    const { contour, dirty } = _offsetContour(sq(10), -1, "round");
    expect(dirty).toBe(false);                             // trimmed, not chord+dirty
    expect(area(contour)).toBeCloseTo(64, 9);
    expect(kinds(contour).every((k) => k === "line")).toBe(true);
  });
  test("circle offset is exact concentric arcs, no joins", () => {
    // a circle is two half-arcs (the storage convention — one full-circle arc is ambiguous)
    const circ = { start: [5, 0], segments: [{ via: [0, 5], to: [-5, 0] }, { via: [0, -5], to: [5, 0] }] };
    const { contour, dirty } = _offsetContour(circ, 1, "round");
    expect(dirty).toBe(false);
    expect(kinds(contour)).toEqual(["arc", "arc"]);
    for (const p of tessellateContour(contour, 64)) expect(Math.hypot(p[0], p[1])).toBeCloseTo(6, 6);
  });
  test("acute triangle chamfer is a single chord per corner (true bevel)", () => {
    const tri = { start: [0, 0], segments: [{ to: [20, 0] }, { to: [10, 3] }, { to: [0, 0] }] };
    const { contour } = _offsetContour(tri, 1, "chamfer");
    // every corner contributes exactly one extra line: 3 edges + 3 chamfer chords
    expect(contour.segments.filter((s) => !s.via && !s.c1).length).toBe(6);
  });
});

describe("validateRawOffset", () => {
  const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });
  test("accepts a clean square with a hole", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]),
      holes: [ring([[4, 4], [4, 6], [6, 6], [6, 4]])] }])).toBe(true);
  });
  test("rejects a self-intersecting (butterfly) ring", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 10]]), holes: [] }])).toBe(false);
  });
  // The butterfly case above short-circuits on zero net area; this pins the
  // ringSelfIntersects branch itself with a self-intersecting quad whose net area is nonzero.
  test("rejects a self-intersecting ring with nonzero net area", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 20]]), holes: [] }])).toBe(false);
  });
  test("rejects a flipped (CW) outer", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [0, 10], [10, 10], [10, 0]]), holes: [] }])).toBe(false);
  });
  test("rejects crossing rings", () => {
    expect(validateRawOffset([
      { outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [] },
      { outer: ring([[5, 5], [15, 5], [15, 15], [5, 15]]), holes: [] },
    ])).toBe(false);
  });
});

import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { profileArea } from "../src/framework/geometry/contour-ops.js";
import { resolveOffsetWinding, _chain, CHAIN_INCOMPLETE_MESSAGE }
  from "../src/framework/geometry/contour-winding.js";

const region = (outer, holes = []) => ({ outer, holes });
const sqRegion = (s) => region(sq(s));
// 30×10 dumbbell: two 10×10 lobes joined by a 10-long, 2-wide waist (y 4→6). At delta −2
// the waist pinches shut and the two lobes become separate 6×6 squares (72 total).
const dumbbell = (dx = 0) => ({ start: [dx, 0], segments: [
  { to: [dx + 10, 0] }, { to: [dx + 10, 4] }, { to: [dx + 20, 4] }, { to: [dx + 20, 0] }, { to: [dx + 30, 0] },
  { to: [dx + 30, 10] }, { to: [dx + 20, 10] }, { to: [dx + 20, 6] }, { to: [dx + 10, 6] }, { to: [dx + 10, 10] },
  { to: [dx, 10] }, { to: [dx, 0] }] });

describe("offsetRegions", () => {
  test("validates corners and delta with the pinned messages", () => {
    expect(() => offsetRegions([sqRegion(10)], 1, { corners: "bevel" }))
      .toThrow('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
    expect(() => offsetRegions([sqRegion(10)], NaN)).toThrow("Shape2D.offset: delta must be a finite number");
  });
  test("collapse throws the pinned message", () => {
    expect(() => offsetRegions([sqRegion(10)], -6)).toThrow("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  });
  test("zero delta returns an equal-area copy", () => {
    const out = offsetRegions([sqRegion(10)], 0);
    expect(profileArea(out)).toBeCloseTo(100, 9);
  });
  test("hole shrinks when the region grows", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] }; // CW
    // delta 0.5 keeps this short of the hole's own half-width (1) — past that the hole
    // collapses entirely (see "hole vanishing" below), so this is the largest delta that
    // still leaves a partially-shrunk hole to assert against.
    const out = offsetRegions([region(sq(10), [hole])], 0.5, { corners: "sharp" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(121 - 1, 6);      // hole 2×2 shrank to 1×1
  });
  test("hole vanishing under positive delta is absorbed", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] };
    const out = offsetRegions([region(sq(10), [hole])], 2, { corners: "sharp" });
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(196, 6);
  });
  // The test above sits at EXACTLY twice the hole's half-width. Past it the inverted ring
  // used to survive as a phantom diamond hole — under a sharp dilation a small hole came
  // back as a hole, and the laser gap check's closing then GREW it instead of filling it,
  // so no hole below the laser floor was ever flagged. A hole with no room for a disk of
  // radius delta vanishes under sharp corners exactly as under round ones.
  test("a hole narrower than twice a sharp dilation vanishes — no phantom", () => {
    const hole = { start: [4.4, 4.4], segments: [{ to: [4.4, 5.6] }, { to: [5.6, 5.6] }, { to: [5.6, 4.4] }, { to: [4.4, 4.4] }] };   // 1.2 × 1.2, CW
    for (const d of [1.25, 1.5, 3]) {
      const out = offsetRegions([region(sq(10), [hole])], d, { corners: "sharp" });
      expect(out[0].holes, `delta ${d}`).toHaveLength(0);
      expect(profileArea(out)).toBeCloseTo((10 + 2 * d) ** 2, 6);
    }
    const circle = { start: [5.6, 5], segments: [{ via: [5, 4.4], to: [4.4, 5] }, { via: [5, 5.6], to: [5.6, 5] }] };   // d 1.2, CW
    const out = offsetRegions([region(sq(10), [circle])], 1.5, { corners: "sharp" });
    expect(out[0].holes).toHaveLength(0);
    expect(profileArea(out)).toBeCloseTo(169, 6);
  });
  test("dumbbell inset splits into two regions via cleanup", () => {
    const out = offsetRegions([region(dumbbell())], -2, { corners: "sharp" });
    expect(out.length).toBe(2);
    expect(profileArea(out)).toBeCloseTo(72, 4);           // two 6×6 squares
  });
  test("`segs` is accepted and ignored", () => {
    // The contract lists `segs` in offset's options for source compatibility with the
    // v1 Manifold route (where it tuned Clipper2's tessellation) — the native engine has
    // no tessellation to tune, so it must accept the key and produce identical geometry
    // for every value, rather than throwing on an unknown option or quietly honoring it.
    const circ = { start: [5, 0], segments: [{ via: [0, 5], to: [-5, 0] }, { via: [0, -5], to: [5, 0] }] };
    const base = offsetRegions([region(circ)], 1, { corners: "round" });
    for (const segs of [4, 64, 256, undefined])
      expect(offsetRegions([region(circ)], 1, { corners: "round", segs })).toEqual(base);
    // and the arcs stay arcs regardless — `segs` never facets anything
    expect(kinds(offsetRegions([region(circ)], 1, { corners: "round", segs: 4 })[0].outer)).toEqual(["arc", "arc"]);
  });
  test("L-shape inset stays on the fast path with exact area", () => {
    const L = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] };
    const out = offsetRegions([region(L)], -2, { corners: "sharp" });
    expect(profileArea(out)).toBeCloseTo(11, 9);
    for (const s of out[0].outer.segments) { expect(s.via).toBeUndefined(); expect(s.c1).toBeUndefined(); }
  });
  test("cusp-producing inward cubic offset yields a simple result", () => {
    const arch = { start: [10, 0], segments: [{ c1: [7, 4], c2: [3, 4], to: [0, 0] }, { to: [10, 0] }] };
    const out = offsetRegions([region(arch)], -0.8, { corners: "round" });
    expect(validateRawOffset(out)).toBe(true);             // output must be simple
  });
});

// Severing a neck that an inward offset pinched shut (splitAtDuplicateEdges) used to be
// gated on `raw.length === 1 && raw[0].holes.length === 0` — so it fired only on a single
// bare ring, i.e. on the shipped one-dumbbell fixture's exact shape family and nothing else.
// A plate with a waist AND bolt holes, or two such plates in one Shape2D, silently missed the
// recovery. Measured against the deleted Clipper2 route (truth here) at delta −2 sharp:
// two disjoint dumbbells came back 200.000 in 2 regions instead of 144.000 in 4, and a
// dumbbell with one 1×1 hole came back 93.000 with the hole GONE instead of 56.000.
describe("offsetRegions — pinched-neck recovery is not limited to one bare ring", () => {
  test("two disjoint dumbbells each split: 4 regions, area 144", () => {
    const out = offsetRegions([region(dumbbell()), region(dumbbell(40))], -2, { corners: "sharp" });
    expect(out.length).toBe(4);
    expect(profileArea(out)).toBeCloseTo(144, 4);          // four 6×6 squares
  });
  test("dumbbell with a 1×1 hole splits AND keeps the hole", () => {
    // 1×1 hole (CW) at x,y ∈ [3,4] inside the left lobe. At delta −2 the lobe erodes to
    // [2,8]² (36) and the hole grows to [1,6]² — clipped by the eroded lobe to [2,6]² (16).
    // So the left lobe contributes 36 − 16 = 20 and the right the full 36: 56 exactly.
    const hole = { start: [3, 3], segments: [{ to: [3, 4] }, { to: [4, 4] }, { to: [4, 3] }, { to: [3, 3] }] };
    const out = offsetRegions([region(dumbbell(), [hole])], -2, { corners: "sharp" });
    expect(out.length).toBe(2);
    expect(profileArea(out)).toBeCloseTo(56, 4);
  });
});

// A hole that collapses under the offset is dropped from the result — a clean operation that
// changes nothing about the outer. It used to set the region-wide `dirty` flag anyway (that
// flag is how _offsetContour signals the drop), pushing an otherwise-exact outer through
// paper.js, which has no arc primitive and hands every curve back as a cubic. On OCCT that is
// B_SPLINE where CIRCLE should be — exactly the exact-curve fidelity the STEP tests pin.
describe("offsetRegions — a collapsing hole must not cost the outer its exact arcs", () => {
  test("10×10 square at +2 round keeps line,arc,… with a collapsing 2×2 hole present", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] };
    const withHole = offsetRegions([region(sq(10), [hole])], 2, { corners: "round" });
    const without = offsetRegions([sqRegion(10)], 2, { corners: "round" });
    expect(withHole[0].holes.length).toBe(0);              // the hole did collapse
    expect(kinds(withHole[0].outer)).toEqual(["line", "arc", "line", "arc", "line", "arc", "line", "arc"]);
    expect(kinds(withHole[0].outer)).toEqual(kinds(without[0].outer));
  });
});

// Pins the regression class from fix round 1: a per-piece "did this trim reverse" check is
// a LOCAL signal that also fires on ordinary, non-reflected trims (acute barbs, narrow
// slots, non-square holes, 45° chamfers) — these are not full-ring reflections, and
// un-trimming them produces an over-inclusive result (or a false collapse throw). Loose
// tolerances on purpose: the point is the failure class, not exact areas.
describe("offsetRegions — whole-ring collapse vs. partial trims", () => {
  test("U-slot block insets cleanly, no false collapse", () => {
    const uSlot = { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 10] }, { to: [6, 10] }, { to: [6, 4] },
      { to: [4, 4] }, { to: [4, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
    // Region count is deliberately not pinned here: the slot's two prongs (each 4 wide)
    // are exactly critical at delta -2 (half-width 2), so whether the sliver remainder
    // comes back as one connected piece or splits into near-cancelling slivers right at
    // that threshold is a precision detail, not the thing this test is pinning — the bug
    // was a false collapse throw, not the resulting region count.
    let out;
    expect(() => { out = offsetRegions([region(uSlot)], -2, { corners: "round" }); }).not.toThrow();
    expect(profileArea(out)).toBeGreaterThan(1);
    expect(profileArea(out)).toBeLessThan(3);
  });
  test("plate with a star-shaped hole: hole vanishes, plate itself does not", () => {
    // The star hole is the reviewer's own explicitly-verified case ("restores every
    // regression case including the star-hole (+2) one that un-trimming could not fix").
    const plate = { start: [0, 0], segments: [{ to: [30, 0] }, { to: [30, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const starPts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 4 : 1.6;
      const ang = (Math.PI / 5) * i - Math.PI / 2;
      starPts.push([15 + r * Math.cos(ang), 10 + r * Math.sin(ang)]);
    }
    starPts.reverse();     // CW winding for a hole
    const star = { start: starPts[0], segments: [...starPts.slice(1), starPts[0]].map((p) => ({ to: p })) };
    const out = offsetRegions([region(plate, [star])], 2, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeGreaterThan(805);
    expect(profileArea(out)).toBeLessThan(815);
  });
  // Task 5B note: the L-pocket test below was originally slated to assert 0 holes /
  // area≈812.566 at +2 (the plate's own rounded-rectangle growth 600+200+4π, assuming the
  // hole vanishes completely). That expectation is mathematically wrong for THIS geometry —
  // verified independently below, not just asserted — so this test pins the corrected
  // number instead of the one in the original task brief. See task-5B-report.md for the
  // full derivation; short version:
  //
  // The hole is an L with both arms exactly 4 wide (10-14 in x, 6-10 in y) offset by
  // delta=2 = exactly half that width. A round join at the hole's one reflex vertex (14,10)
  // pivots a radius-2 arc about that vertex — standard "uncut corner" behavior for any
  // round-tool erosion of an internal reflex corner (the same reason a round end mill
  // always leaves material in a sharp internal pocket corner: it physically cannot reach
  // in past its own radius). Shifting the reflex vertex to the origin, the surviving
  // residual is exactly {(a,b) ∈ [0,2]×[0,2] : a²+b² ≥ 2²} — a 2×2 square minus the quarter
  // disk of radius 2 nearest the vertex — with EXACT area 4−π ≈ 0.8584. Rendering that exact
  // lens shape (start [12,8], line to [12,10], round-join arc via [12.5858,8.5858] to
  // [14,8], line closing back to [12,8]) through this file's own `area()` helper at 256
  // segments returns 0.858412…, matching 4−π to 5 significant figures — and is exactly the
  // shape `offsetRegions` returns below (its raw ring visits a couple of extra collinear,
  // zero-area waypoints along the way, an artifact of Part 1's chord-bridging that doesn't
  // change the enclosed area). So "0 holes" was never the correct answer for +2 on this
  // specific geometry; "1 hole, area 4−π" is. (The *wide*-arm L-pocket below, where the
  // reflex vertex sits far enough from the two straight sides that even the corner bulge
  // can't clear delta=3, genuinely does fully vanish — that one's brief-prescribed
  // expectation checks out and is asserted unchanged.)
  test("plate with a narrow L-shaped hole at +2: a small uncut-corner residual is correct, not a bug", () => {
    const plate = { start: [0, 0], segments: [{ to: [30, 0] }, { to: [30, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const lHole = { start: [10, 6], segments: [
      { to: [10, 14] }, { to: [14, 14] }, { to: [14, 10] }, { to: [20, 10] }, { to: [20, 6] }, { to: [10, 6] }] };
    const out = offsetRegions([region(plate, [lHole])], 2, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);                       // NOT 0 — see comment above
    expect(profileArea(out)).toBeCloseTo(812.566 - (4 - Math.PI), 1);   // outer growth − exact uncut-corner residual
  });
  // Task 5B, round 2: the wide-arm L-pocket case genuinely didn't fully absorb its hole
  // through the old paper.js cleanup path — this stayed true across both review rounds
  // (0 holes / area≈928.27 is the verified-correct truth: max inscribed circle in a
  // 5-wide-arm L has radius 2.5 < the delta=3 offset, confirmed by the same grid-search
  // method validated on the narrow-L-pocket case above). A global distance-from-source
  // prune (Part 2) closed this gap across two review rounds of tightening, but its round-2
  // form — even with EXACT line/arc distance and an adaptively-flattened cubic distance,
  // eliminating discretization error rather than just bounding it — still silently deleted
  // 36 of 84 real glyph-counter holes at delta as small as 0.1mm on 10mm text (every failure
  // total hole loss, none recoverable by further tolerance tuning), so Part 2 was removed
  // entirely rather than shipped delicately tuned, and this case was parked pending a proper
  // oracle (see task-5B-report.md's round-2 section for the full 76-combo sweep).
  //
  // Task 7 (winding resolver wiring): resolveOffsetWinding's positive-winding rule (w >= 1)
  // resolves this correctly with no per-ring heuristic — a fully-eroded hole ring is simply
  // negative-winding everywhere and drops out on its own. Cross-checked against Clipper2 in
  // test/offset-oracle-manifold.test.js's "formerly-parked divergences, now correct" set.
  test("wide L-shaped hole (5-unit arms) at +3 fully absorbs the hole", () => {
    const plate = { start: [0, 0], segments: [{ to: [30, 0] }, { to: [30, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const wideLHole = { start: [10, 6], segments: [
      { to: [10, 15] }, { to: [15, 15] }, { to: [15, 11] }, { to: [21, 11] }, { to: [21, 6] }, { to: [10, 6] }] };
    const out = offsetRegions([region(plate, [wideLHole])], 3, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(928.274, 1);
  });
  test("chamfered rectangle insets without a false collapse throw", () => {
    const chamfered = { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 4] }, { to: [9, 5] }, { to: [1, 5] }, { to: [0, 4] }, { to: [0, 0] }] };
    let out;
    expect(() => { out = offsetRegions([region(chamfered)], -2, { corners: "round" }); }).not.toThrow();
    expect(profileArea(out)).toBeGreaterThan(5.5);
    expect(profileArea(out)).toBeLessThan(6.6);
  });
});

// Pins the regression class from fix round 2: the whole-ring collapse predicate only
// inspected plain-LINE pieces, so on a ring where lines are a minority (a mostly-arc
// disc/bore carrying a small line-built tab or keyway) it was really a "whole-small-
// feature" predicate — it dropped the entire ring whenever just the small feature's line
// pieces collapsed, even though the ring as a whole (dominated by its arcs) was nowhere
// near critical. Loose tolerances on purpose: the point is the failure class.
describe("offsetRegions — whole-ring collapse must span the whole ring, not just its lines", () => {
  test("disc with a small rectangular tab insets without a false collapse throw", () => {
    const tab = { start: [0, -10], segments: [
      { via: [7.0711, -7.0711], to: [10, 0] },
      { to: [12, 0] }, { to: [12, 2] }, { to: [10, 2] },
      { via: [3.70, 9.29], to: [0, 10] }, { via: [-10, 0], to: [0, -10] } ] };
    let out;
    expect(() => { out = offsetRegions([region(tab)], -3, { corners: "round" }); }).not.toThrow();
    expect(profileArea(out)).toBeGreaterThan(150);
    expect(profileArea(out)).toBeLessThan(160);
  });
  test("keyed bore survives: circular hole with a keyway does not vanish", () => {
    const plate = { start: [0, 0], segments: [{ to: [60, 0] }, { to: [60, 60] }, { to: [0, 60] }, { to: [0, 0] }] };
    // r=10 circular hole centered at (30,30), CW, carrying a keyway: a 2×2-ish rectangular
    // notch (radius 10 -> 11, spanning a 30° arc) sticking outward at angle 0.
    const cx = 30, cy = 30, r = 10, rOut = 11, halfAngle = 15;
    const pt = (ang, rad) => [cx + rad * Math.cos((ang * Math.PI) / 180), cy + rad * Math.sin((ang * Math.PI) / 180)];
    const Q1 = pt(halfAngle, r), Q2 = pt(-halfAngle, r);
    const viaBig = pt(180 + halfAngle, r);
    const K1 = pt(-halfAngle, rOut), K2 = pt(halfAngle, rOut);
    const bore = { start: Q1, segments: [{ to: K2 }, { to: K1 }, { to: Q2 }, { via: viaBig, to: Q1 }] };
    const out = offsetRegions([region(plate, [bore])], 2.5, { corners: "round" });
    // Part 1's per-piece deletion (Task 5B) eliminates the spurious ≈0.63-area sliver that
    // cleanup used to leave alongside the main plate+bore region, so the output is now
    // exactly the one region — a Part-1-only build already returns this; Part 2 (the
    // distance prune) isn't involved. Kept the .find() below (rather than out[0]) since
    // that isn't what this assertion is pinning — the bug here was the bore vanishing
    // outright (0 holes, area jumping to the full ungrown-by-a-hole plate size).
    expect(out.length).toBe(1);
    const bored = out.find((rg) => rg.holes.length > 0);
    expect(bored).toBeDefined();
    expect(bored.holes.length).toBe(1);
    expect(profileArea(out)).toBeGreaterThan(4000);
    expect(profileArea(out)).toBeLessThan(4100);
  });
});

// Pins the regression class from task 5B's round-1 review, Critical 1: an early version of
// Part 2's distance prune checked each raw hole against EVERY ring of its region (outer +
// siblings), not just its own source hole — indistinguishable from two features legitimately
// merging (a case cleanup exists to resolve, not something to prune away). Verified directly
// against the pre-round-1 commit (aa82380), which HAD the whole-region prune: both fixtures
// below returned area 576 there — the bare plate, holes.length === 0 — because the prune saw a
// legitimately-merging/breaking-through hole come within |delta| of a DIFFERENT ring and
// deleted it outright.
//
// These were originally pinned in a loose 300..500 band because the engine could only get
// them approximately right; both are now EXACT, so they assert the exact value. (The 40×20
// fixtures with the same shape at 6×8/3 mm spacing and 10×10/2 mm are cross-checked against
// the Clipper2 oracle in test/offset-oracle-manifold.test.js; these two keep the original
// round-1 coordinates and stay WASM-free.)
describe("offsetRegions — merging/breaking-through holes must survive", () => {
  test("two holes 3mm apart merge into one hole, exact area", () => {
    const plate = { start: [0, 0], segments: [{ to: [40, 0] }, { to: [40, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const holeA = { start: [5, 6], segments: [{ to: [5, 14] }, { to: [11, 14] }, { to: [11, 6] }, { to: [5, 6] }] };
    const holeB = { start: [14, 6], segments: [{ to: [14, 14] }, { to: [20, 14] }, { to: [20, 6] }, { to: [14, 6] }] };
    const out = offsetRegions([region(plate, [holeA, holeB])], -2, { corners: "sharp" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);              // merged, not two overlapping rings
    // eroded plate 36×16 = 576; merged hole spans x [3,22] × y [4,16] = 19×12 = 228
    expect(profileArea(out)).toBeCloseTo(576 - 228, 4);
  });
  test("a hole 2mm from the edge is clipped by the eroded outer, exact area", () => {
    const plate = { start: [0, 0], segments: [{ to: [40, 0] }, { to: [40, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const hole = { start: [15, 2], segments: [{ to: [15, 12] }, { to: [25, 12] }, { to: [25, 2] }, { to: [15, 2] }] };
    const out = offsetRegions([region(plate, [hole])], -2, { corners: "sharp" });
    expect(out.length).toBe(1);
    // the grown hole breaks through the eroded bottom edge, so it is a notch in the
    // outline rather than a hole: x [13,27] × y [2,14] = 14×12 = 168 removed from 576
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(576 - 168, 4);
  });
});

// Task 5B, round 2: Part 2 (the global distance-from-source prune added in round 0 and
// narrowed in round 1) was found to silently delete real CURVED holes on outward offsets —
// a cubic-circle hole, an arc-cornered rounded-rect hole, and 36 of 76 real glyph-counter
// combinations (uppercase/lowercase/digit counters on 10mm Roboto text at delta 0.1–0.5mm),
// every failure a total hole loss with no warning. Root cause: the round-1 tolerance bounded
// discretization error with a sagitta model valid only for sampleArc's angle-capped stepping,
// not for sampleBezier, and it ignored OFFSET_TOL (the cubic-offset approximation's own error
// budget) entirely — on the r=5 cubic-circle case the deficit against the flattened source was
// 2.404e-2 against a tolerance of 2.372e-2, a 1.3% margin, so curved-hole survival was close
// to a coin flip. Attempted the prescribed fix (exact line/arc distance via closed-form
// point-to-circle math, adaptive cubic flattening to OFFSET_TOL/10, tolerance derived from
// OFFSET_TOL rather than chord length) — it fixed the circle, the rounded-rect, and the "P"
// counter exactly, but 36/76 glyph combinations STILL lost their counter, because the defect
// isn't really about tolerance sizing: the wide-L-pocket's own raw hole (Part 2's one
// justification) is already `dirty` from Part 1 before Part 2's check ever runs, and so are
// the failing glyph counters — there is no scoping condition available on a raw, pre-cleanup
// ring that reliably tells "prune this, it's really gone" apart from "leave it, cleanup will
// recover it." Per the standing instruction that silently deleting real geometry is strictly
// worse than the single defect (the wide-L-pocket) the prune existed to fix, Part 2 is REMOVED
// entirely as of this round rather than shipped delicately tuned — see the wide-L-pocket
// test above (a real, passing test since task 7 — it was a test.todo when this note was
// written) and task-5B-report.md's round-2 section for the full derivation and the
// 76-combo sweep. These three are kept as permanent regression coverage against reintroducing
// that failure class (a future distance-based prune, or any other mechanism that can delete a
// whole hole based on a raw pre-cleanup sample, should be checked against these first).
describe("offsetRegions — curved holes must survive outward offsets (Part 2 removal coverage)", () => {
  test("cubic-circle hole (r=5) keeps its hole at +0.2", () => {
    const plate = { start: [0, 0], segments: [{ to: [60, 0] }, { to: [60, 40] }, { to: [0, 40] }, { to: [0, 0] }] };
    const k = 0.551915 * 5, cx = 20, cy = 20, r = 5;
    // CW (hole) winding, built from 4 cubic quarter-arcs — the same kappa-approximation shape
    // a font or CAD import would hand this engine, not a native arc.
    const circleHole = { start: [cx + r, cy], segments: [
      { c1: [cx + r, cy - k], c2: [cx + k, cy - r], to: [cx, cy - r] },
      { c1: [cx - k, cy - r], c2: [cx - r, cy - k], to: [cx - r, cy] },
      { c1: [cx - r, cy + k], c2: [cx - k, cy + r], to: [cx, cy + r] },
      { c1: [cx + k, cy + r], c2: [cx + r, cy + k], to: [cx + r, cy] },
    ] };
    const out = offsetRegions([region(plate, [circleHole])], 0.2, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(2367.71, 1);
  });
  test("arc-cornered rounded-rect hole (16×10, r2) keeps its hole at +2", async () => {
    const { reverseContour } = await import("../src/framework/geometry/profile.js");
    const plate = { start: [0, 0], segments: [{ to: [60, 0] }, { to: [60, 40] }, { to: [0, 40] }, { to: [0, 0] }] };
    // Built CCW (bottom edge rightward, right edge up, top edge leftward, left edge down —
    // the walk that traces a rectangle's boundary counterclockwise) then reversed to the CW
    // winding a hole needs, rather than hand-deriving the CW arc `via` points directly — this
    // engine's own storage/winding convention is exercised by _offsetContour either way, and
    // reverseContour is already the tested, correct way to flip a contour's direction. Native
    // {via,to} arc corners (not cubics) — covers the exact-arc-distance half of the fix.
    const cx = 40, cy = 20, w = 16, h = 10, r = 2;
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, k = r * 0.7071;
    const rrCCW = { start: [x0 + r, y0], segments: [
      { to: [x1 - r, y0] },
      { via: [x1 - r + k, y0 + r - k], to: [x1, y0 + r] },
      { to: [x1, y1 - r] },
      { via: [x1 - r + k, y1 - r + k], to: [x1 - r, y1] },
      { to: [x0 + r, y1] },
      { via: [x0 + r - k, y1 - r + k], to: [x0, y1 - r] },
      { to: [x0, y0 + r] },
      { via: [x0 + r - k, y0 + r - k], to: [x0 + r, y0] },
    ] };
    const rr = reverseContour(rrCCW);
    const out = offsetRegions([region(plate, [rr])], 2, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(2740.57, 1);
  });
  test("Roboto 'P' counter (10mm) keeps its hole at +0.3", async () => {
    const opentype = (await import("opentype.js")).default;
    const { textGlyphs } = await import("../src/framework/geometry/text2d.js");
    const { DEFAULT_FONT_BYTES } = await import("../src/framework/geometry/fonts/default-font.js");
    const bytes = DEFAULT_FONT_BYTES;
    const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const regions = textGlyphs(font, "P", { size: 10 });
    expect(regions[0].holes.length).toBe(1);           // sanity: the glyph has a counter to lose
    const out = offsetRegions(regions, 0.3, { corners: "round" });
    expect(out.reduce((a, r) => a + r.holes.length, 0)).toBeGreaterThan(0);
    expect(profileArea(out)).toBeCloseTo(42.843, 1);
  });
});

describe("offsetRegions — source-hole inradius collapse", () => {
  test("Roboto 'o' keeps its counter at +2 and loses it at +3", async () => {
    const opentype = (await import("opentype.js")).default;
    const { textGlyphs } = await import("../src/framework/geometry/text2d.js");
    const { DEFAULT_FONT_BYTES } = await import("../src/framework/geometry/fonts/default-font.js");
    const bytes = DEFAULT_FONT_BYTES;
    const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const regions = textGlyphs(font, "o", { size: 10 });

    const holesAt = (delta) => offsetRegions(regions, delta, { corners: "round" })
      .flatMap((rg) => rg.holes)
      .filter((hole) => Math.abs(area(hole)) > 1e-3)
      .length;
    expect(holesAt(2)).toBe(1);
    expect(holesAt(3)).toBe(0);
  });

  test("large round dilation removes collapsed glyph counters, including 'Scott'", async () => {
    const opentype = (await import("opentype.js")).default;
    const { textGlyphs } = await import("../src/framework/geometry/text2d.js");
    const { DEFAULT_FONT_BYTES } = await import("../src/framework/geometry/fonts/default-font.js");
    const bytes = DEFAULT_FONT_BYTES;
    const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const significant = (contour) => Math.abs(area(contour)) > 1e-3;

    for (const text of ["e", "a", "p", "Scott"]) {
      const out = offsetRegions(textGlyphs(font, text, { size: 10 }), 3, { corners: "round" });
      expect(out.filter((rg) => significant(rg.outer))).toHaveLength(1);
      expect(out.flatMap((rg) => rg.holes).filter(significant)).toHaveLength(0);
    }
  });

  test("a near-threshold circle is kept conservatively", () => {
    const hole = {
      start: [5, 0],
      segments: [
        { via: [0, -5], to: [-5, 0] },
        { via: [0, 5], to: [5, 0] },
      ],
    };
    expect(_sourceHoleContainsDisk(hole, 4.99)).toBe(true);
    expect(_sourceHoleContainsDisk(hole, 5.004)).toBe(true);
    expect(_sourceHoleContainsDisk(hole, 5.02)).toBe(false);
  });
});

describe("offsetRegions — positive dilation keeps only source-backed components", () => {
  test("Roboto 'a' and 'p' do not gain detached sliver islands at +0.5", async () => {
    const opentype = (await import("opentype.js")).default;
    const { textGlyphs } = await import("../src/framework/geometry/text2d.js");
    const { DEFAULT_FONT_BYTES } = await import("../src/framework/geometry/fonts/default-font.js");
    const bytes = DEFAULT_FONT_BYTES;
    const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    for (const text of ["a", "p"]) {
      const out = offsetRegions(textGlyphs(font, text, { size: 10 }), 0.5, { corners: "round" });
      expect(out.filter((rg) => Math.abs(area(rg.outer)) > 1e-3)).toHaveLength(1);
      expect(out.flatMap((rg) => rg.holes).filter((h) => Math.abs(area(h)) > 1e-3)).toHaveLength(1);
    }
  });

  test("an arbitrarily small real source component is retained", () => {
    const box = (x, y, w, h) => ({ start: [x, y], segments: [
      { to: [x + w, y] }, { to: [x + w, y + h] }, { to: [x, y + h] }, { to: [x, y] },
    ] });
    const source = [region(box(0, 0, 10, 10)), region(box(20, 0, 0.01, 0.01))];
    for (const corners of ["round", "chamfer", "sharp"])
      expect(offsetRegions(source, 0.5, { corners })).toHaveLength(2);
  });
});

// Pins the regression class from task 5B's round-1 review, Important 3: Part 1's per-piece
// deletion is unrecoverable (unlike a chord/dirty join, a deleted piece can't be un-deleted
// downstream), so a bad deletion could turn perfectly good geometry into a false "offset
// collapses the shape" throw. The fix is the guard in _offsetContour: when deletion doesn't
// resolve to a simple, nonzero-area ring, prefer the un-deleted ring (still dirty) instead.
describe("offsetRegions — round-1 review: Part 1 deletion must not cause a false collapse throw", () => {
  test("concave 9-gon at delta -2.79/chamfer no longer throws", () => {
    const nonagon = { start: [19.49, 10], segments: [
      { to: [12.33, 11.95] }, { to: [11.2, 16.81] }, { to: [8.87, 11.96] }, { to: [0.93, 13.3] },
      { to: [3.45, 7.62] }, { to: [8.52, 7.44] }, { to: [10.92, 4.78] }, { to: [15.09, 5.73] }, { to: [19.49, 10] }] };
    // The false throw (HEAD, pre-task-5B) is fixed and well-evidenced: this used to throw
    // "offset collapses the shape (reduce |delta|)" and no longer does — see the fixed area
    // value below for the current (winding-resolver) accuracy of this specific input.
    let out;
    expect(() => { out = offsetRegions([region(nonagon)], -2.79, { corners: "chamfer" }); }).not.toThrow();
    expect(profileArea(out)).toBeGreaterThan(0);
  });
  // Task 7 (winding resolver wiring): this used to go through paper.js's resolveSelfRegions
  // (a self-union), which returned ~7.7094 split across 2 regions — provably wrong, since
  // feeding this exact raw offset polygon straight into Clipper2 with FillRule::NonZero
  // reproduces 7.7094 to the digit (the self-union path is a nonzero-style resolution).
  // resolveOffsetWinding instead computes the raw curve's POSITIVE-winding region (w >= 1),
  // which for this input is 4.621926 — also cross-checked directly: feeding the SAME raw
  // polygon into Clipper2 with FillRule::Positive reproduces 4.621926 to the digit, so
  // resolveOffsetWinding is resolving _offsetContour's raw output correctly.
  //
  // Task 7B closed the remaining 4.621926 → 3.553831 gap, and it was NOT in the join policy.
  // Ablating _offsetContour piece by piece localised it to the overlap-side TRIM: at a corner
  // whose offset lines cross outside both offset segments' own extents, "trimming" to that
  // crossing EXTENDS both segments to a point neither reaches, inventing material the raw
  // offset never covered — and leaves a ring simple and correctly wound enough that
  // validateRawOffset, and every other downstream check, sees nothing wrong. Gating the trim
  // on the crossing landing within both extents (contour-offset.js) makes this exact, and the
  // untrimmed corner beveled + resolved by winding is what Clipper2 does anyway.
  //
  // 3.553831 is the CHAMFER truth, agreed to six digits by Clipper2's chamfer mapping and by
  // an independent Minkowski-union construction. The "~2.76" that used to be quoted here as
  // the chamfer truth is the ROUND truth for this shape (Clipper2 round: 2.765184; Minkowski:
  // 2.761295); Clipper2's JoinType::Square (2.701770) is a different join policy again and is
  // not this engine's chamfer — it returns less area than its own round join, which no chord
  // bevel on an erosion can do.
  test("concave 9-gon at delta -2.79/chamfer: exactly the true chamfer offset (3.553831, was 4.621926, was 7.7094)", () => {
    const nonagon = { start: [19.49, 10], segments: [
      { to: [12.33, 11.95] }, { to: [11.2, 16.81] }, { to: [8.87, 11.96] }, { to: [0.93, 13.3] },
      { to: [3.45, 7.62] }, { to: [8.52, 7.44] }, { to: [10.92, 4.78] }, { to: [15.09, 5.73] }, { to: [19.49, 10] }] };
    const out = offsetRegions([region(nonagon)], -2.79, { corners: "chamfer" });
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(3.553831, 5);
  });
});

// Task 7B regression coverage for the overlap-side trim gate, on three shapes whose offsets
// have exact CLOSED-FORM areas — no oracle, no tolerance judgement. Each was wrong before the
// gate by 15-30 %, in the silent direction: a simple, correctly-wound ring that validated
// clean and took the fast path while carrying material the raw offset never produced.
describe("offsetRegions — the overlap-side trim only fires when the offset lines really cross", () => {
  const shape = (pts) => ({ start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] });

  test("plus sign (10×10, 4-wide arms) at +3/sharp is the union of its two dilated bars (220)", () => {
    // Dilating each bar by 3 with square (miter, 90°) corners is exact: the horizontal bar
    // [0,10]×[3,7] → [-3,13]×[0,10] and the vertical [3,7]×[0,10] → [0,10]×[-3,13], so the
    // union is 16·10 + 10·16 − 10·10 = 220. Pre-gate this returned 184 — the four reflex
    // corners were each trimmed to a crossing well outside both offset segments.
    const plus = shape([[3, 0], [7, 0], [7, 3], [10, 3], [10, 7], [7, 7], [7, 10], [3, 10], [3, 7], [0, 7], [0, 3], [3, 3]]);
    expect(profileArea(offsetRegions([region(plus)], 3, { corners: "sharp" }))).toBeCloseTo(220, 6);
  });

  test("dumbbell at +4/sharp is the union of its three dilated rectangles (668)", () => {
    // Lobes [0,10]² and [20,30]×[0,10] and waist [10,20]×[4,6], each dilated by 4 with square
    // corners: 18·18 + 18·18 + 18·10 − 8·10 − 8·10 = 668. Pre-gate: 636.
    const dumb = shape([[0, 0], [10, 0], [10, 4], [20, 4], [20, 0], [30, 0], [30, 10], [20, 10], [20, 6], [10, 6], [10, 10], [0, 10]]);
    expect(profileArea(offsetRegions([region(dumb)], 4, { corners: "sharp" }))).toBeCloseTo(668, 6);
  });

  test("a plain convex inset still takes the exact fast path (square, -1)", () => {
    // The gate must NOT cost the everyday case its trim: every corner of a convex inset
    // crosses within both segments, so the ring stays simple and validateRawOffset passes it
    // through untouched — 4 segments in, 4 out, no resolver, no extra vertices.
    const square = shape([[0, 0], [20, 0], [20, 20], [0, 20]]);
    const out = offsetRegions([region(square)], -1, { corners: "sharp" });
    expect(out.length).toBe(1);
    expect(out[0].outer.segments.length).toBe(4);
    expect(profileArea(out)).toBeCloseTo(324, 9);
  });
});

// Task 7C. The fast-path validator's crossing test used to demand all four orientations be
// nonzero — "strict crossings only" — which is exactly the wrong exclusion for offset output,
// because offset pieces are built by translating SHARED vertices and so meet each other AT
// vertices as the generic case, not the degenerate one. A ring that ran through one of its own
// vertices was therefore reported simple, `validateRawOffset` returned true, and the tangled
// ring went straight down the exact fast path — silently, no throw, never reaching
// resolveOffsetWinding, which cancels the reversed loop correctly.
//
// The truths below are closed-form, and independently reproduced by the Minkowski-union oracle
// (test/minkowski-oracle.test.js runs the same three shapes through
// test/helpers/minkowski-oracle.js, which never calls anybody's offsetter).
describe("offsetRegions — a ring that crosses itself AT a vertex is not simple", () => {
  const shape = (pts) => ({ start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] });
  // 20×10 block, slot of width w cut from the top down to y = 2, eroded by 2. The 2 mm floor
  // under the slot is exactly the erosion depth, so it vanishes and the block SPLITS into
  // [2, 8−w/2]×[2,8] and [12+w/2, 18]×[2,8]: area 72 − 6w, and identical for all three corner
  // styles because every join the erosion introduces sits at y < 2, below the surviving
  // material. The raw offset ring instead dips to y = 0 and re-crosses its own eroded bottom
  // edge at y = 2 — at the two vertices where the slot walls land.
  const slotted = (w) => shape([[0, 0], [20, 0], [20, 10],
    [10 + w / 2, 10], [10 + w / 2, 2], [10 - w / 2, 2], [10 - w / 2, 10], [0, 10]]);
  for (const w of [2, 4, 6]) {
    for (const corners of ["round", "chamfer", "sharp"]) {
      test(`slotted block, ${w}-wide slot at −2/${corners} erodes to ${72 - 6 * w}`, () => {
        expect(profileArea(offsetRegions([region(slotted(w))], -2, { corners }))).toBeCloseTo(72 - 6 * w, 6);
      });
    }
  }
  test("the raw ring is rejected by validateRawOffset rather than merely fixed downstream", () => {
    // Belt and braces on the ROUTING, not just the number: the raw offset here is not dirty
    // (no arc inverted, no piece deleted), so the only thing standing between it and the fast
    // path is this validator. If it ever says true again the area assertions above go quiet.
    const o = _offsetContour(slotted(4), -2, "round");
    expect(o.dirty).toBe(false);
    expect(validateRawOffset([{ outer: o.contour, holes: [] }])).toBe(false);
  });
  test("clean shapes are NOT pushed to the resolver by the widened test", () => {
    // The counter-risk: every ring shares a vertex between adjacent segments by construction,
    // and tessellateContour also emits the closing point, so a naive endpoint-inclusive test
    // reports a self-touch on literally every ring. Two ordinary insets that must stay exact.
    const square = shape([[0, 0], [20, 0], [20, 20], [0, 20]]);
    const L = shape([[0, 0], [10, 0], [10, 10], [5, 10], [5, 5], [0, 5]]);
    expect(validateRawOffset([{ outer: _offsetContour(square, -1, "sharp").contour, holes: [] }])).toBe(true);
    expect(validateRawOffset([{ outer: _offsetContour(L, -1, "round").contour, holes: [] }])).toBe(true);
    expect(profileArea(offsetRegions([region(square)], -1, { corners: "sharp" }))).toBeCloseTo(324, 9);
  });
});

// ── former chain-incomplete cases (Task 7D) ──────────────────────────────────────────────
//
// These fixtures originally exercised the fallback ladder. The adaptive winding classifier
// now resolves them directly; the assertions below pin that higher-fidelity behavior while
// retaining explicit coverage of what later ladder rungs would cost if reached.
describe("offsetRegions — the chain-incomplete fallback", () => {
  const shape = (pts) => ({ start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] });
  // 38×10 plate with four notches of differing depth cut into its top edge. Eroded by 2.5 the
  // two 5-deep notch floors reach the eroded bottom edge exactly, severing two webs.
  const comb = shape([[0, 0], [38, 0], [38, 10], [15, 10], [15, 5], [12, 5], [12, 10],
    [9, 10], [9, 4.5], [7, 4.5], [7, 10], [5, 10], [5, 5], [4, 5], [4, 10], [0, 10]]);
  const areaAt = (d) => profileArea(offsetRegions([region(comb)], d, { corners: "round" }));

  test("the raw arrangement at −2.5/round chains directly into all four pieces", () => {
    const o = _offsetContour(comb, -2.5, "round");
    let out;
    expect(() => { out = resolveOffsetWinding([{ outer: o.contour, holes: [] }]); }).not.toThrow();
    expect(out).toHaveLength(4);
  });

  test("−2.5/round returns the oracle's four pieces", () => {
    expect(() => areaAt(-2.5)).not.toThrow();
    // More than one region: the two 5-deep notches erode through their webs at exactly this
    // delta, so the comb really does sever. That it SEVERS is the point — the resolver's job
    // is to report the pieces, not to give up on the arrangement.
    //
    expect(offsetRegions([region(comb)], -2.5, { corners: "round" })).toHaveLength(4);
  });

  test("the recovered area is bracketed by the same shape at deltas that never failed", () => {
    // Area is strictly decreasing in |delta| here, so the two nearest deltas OUTSIDE the old
    // failing band bound the answer on both sides. Both bounds come from the engine's own
    // never-failing output, not a pinned constant. (The tight check — within 0.006 % of the
    // Minkowski oracle's 91.744 — lives in test/offset-oracle-manifold.test.js, where truth is
    // derived rather than asserted. A midpoint/linearity bound would be wrong here: |delta| =
    // 2.5 is exactly where the webs sever, so the area curve has a genuine kink at it.)
    expect(areaAt(-2.5)).toBeLessThan(areaAt(-2.49));
    expect(areaAt(-2.5)).toBeGreaterThan(areaAt(-2.52));
  });

  test("the recovered stretch of the old failing band is monotone, with no holes", () => {
    // The failure was a BAND, not a knife edge — that was the premise the measurement killed:
    // −2.4950 through −2.5150 all threw, and a slider dragged through it died the whole way.
    // −2.500 downwards is continuous; walk it at 0.001 and require every step to build and
    // to keep decreasing.
    let prev = Infinity;
    for (let i = 0; i <= 20; i++) {
      const a = areaAt(-2.5 - i * 0.001);
      expect(a).toBeGreaterThan(80);
      expect(a).toBeLessThan(prev);
      prev = a;
    }
  });

  // What the ladder COSTS when it fires. Both of these are properties of the shipped rung
  // list, walked directly via `_ladderRungs` so the test sees each rung's answer rather than
  // only the winner — the same view `scripts/offset-rates.mjs` measures the whole corpus with.
  // Seeds are from the committed corpus (test/helpers/offset-corpus.js), so both cases
  // reproduce with `node scripts/offset-rates.mjs --seed <n>`.
  describe("what the fallback ladder costs", () => {
    const arcs = (rs) => rs.reduce((a, r) =>
      a + [r.outer, ...r.holes].reduce((n, c) => n + c.segments.filter((s) => s.via).length, 0), 0);
    const segs = (rs) => rs.reduce((a, r) =>
      a + [r.outer, ...r.holes].reduce((n, c) => n + c.segments.length, 0), 0);

    test("the first high-fidelity rung now wins before a polyline can strip arcs", () => {
      const c = caseFor(330);
      const { raw } = _rawOffset(c.regions, -3.75, "round");
      expect(arcs(raw)).toBe(3);
      const rungs = _ladderRungs(c.regions, raw, -3.75, "round");
      const won = rungs.map((r) => { try { return { name: r.name, out: r.run() }; } catch { return null; } })
        .find(Boolean);
      expect(won.name).toBe("delta*(1-1e-9)");
      expect(arcs(won.out)).toBe(3);
      expect(segs(won.out)).toBe(5);
      expect(arcs(offsetRegions(c.regions, -3.75, { corners: "round" }))).toBe(3);
    });

    test("the first high-fidelity rung keeps a region a coarse rung would lose", () => {
      const c = caseFor(397);
      const { raw } = _rawOffset(c.regions, -3.25, "round");
      const out = Object.fromEntries(_ladderRungs(c.regions, raw, -3.25, "round")
        .map((r) => { try { return [r.name, r.run().length]; } catch { return [r.name, null]; } }));
      expect(out["delta*(1-1e-9)"]).toBe(2);
      expect(out["clusterTol*20"]).toBe(1);
      expect(out["polyline@1024"]).toBe(2);
      expect(offsetRegions(c.regions, -3.25, { corners: "round" })).toHaveLength(2);
    });
  });

  test("a genuinely unresolvable arrangement still throws the pinned message", () => {
    // _chain is the throw's own home; feeding it a piece whose end vertex has no outgoing
    // continuation is the failure the fallback exists for, and no ladder rung applies below
    // offsetRegions. The literal text is pinned because ERROR-PATTERNS.md quotes it.
    expect(CHAIN_INCOMPLETE_MESSAGE)
      .toBe("contour-winding: could not chain offset boundary (incomplete intersection set)");
    const pool = [[0, 0], [1, 0]];
    const dangling = [{ keep: true, reverse: false,
      piece: { from: [0, 0], segs: [{ to: [1, 0] }], vStart: 0, vEnd: 1 } }];
    expect(() => _chain(dangling, pool)).toThrow(CHAIN_INCOMPLETE_MESSAGE);
  });
});

// A sharp join is where two offset pieces are extended until they meet. A line extends along
// itself; an ARC extends along its own circle (OCCT's intersection join) — not along its end
// tangent, which leaves the circle at once. Tangent-extended, a sharp dilation cut the corner
// short wherever an arc met another edge at a real corner and curved away from the join, so
// shrinking a shape and growing it back no longer returned the shape: a sliver beside the
// corner went missing (0.013 mm² at a 1.9 mm test on a ring-sector hole — the laser checks
// read it as a 1.88 mm gap in a 10 mm-wide hole). The shrink goes through the winding
// resolver, which places an arc's new ends only as well as paper's cubic circle allows, so
// "returns the shape" is measured to 5e-3 mm, both ways: every boundary point of each shape
// lies that close to the other's boundary. Extended along the tangent, the cut corner stood
// 0.011 mm off at the smallest test here and 0.086 mm at h 1.5.
describe("offsetRegions — a sharp join extends an arc along its own circle", () => {
  const C45 = Math.SQRT1_2;
  // A 10..20 mm ring sector over 90°: two arcs, two radial lines, four 90° corners.
  const sector = { start: [20, 0], segments: [
    { via: [20 * C45, 20 * C45], to: [0, 20] }, { to: [0, 10] },
    { via: [10 * C45, 10 * C45], to: [10, 0] }, { to: [20, 0] }] };
  const reversed = (c) => {                 // the same ring traversed the other way (a hole)
    const pts = [c.start, ...c.segments.map((sg) => sg.to)];
    const segments = [];
    for (let i = c.segments.length - 1; i >= 0; i--) segments.push(c.segments[i].via ? { via: c.segments[i].via, to: pts[i] } : { to: pts[i] });
    return { start: pts.at(-1), segments };
  };
  const plate = (w, h) => ({ start: [0, 0], segments: [{ to: [w, 0] }, { to: [w, h] }, { to: [0, h] }, { to: [0, 0] }] });
  const shifted = (c, [dx, dy]) => ({ start: [c.start[0] + dx, c.start[1] + dy],
    segments: c.segments.map((sg) => ({ ...(sg.via ? { via: [sg.via[0] + dx, sg.via[1] + dy] } : {}), to: [sg.to[0] + dx, sg.to[1] + dy] })) });
  // Every ring's boundary as points no more than 0.02 mm apart.
  const dense = (regions) => regions.flatMap((rg) => [rg.outer, ...rg.holes]).map((ring) => {
    const pts = tessellateContour(ring, 8192), out = [];
    pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length], n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.02));
      for (let j = 0; j < n; j++) out.push([p[0] + ((q[0] - p[0]) * j) / n, p[1] + ((q[1] - p[1]) * j) / n]); });
    return out;
  });
  const segDist = (p, a, b) => {
    const ab = [b[0] - a[0], b[1] - a[1]], L2 = ab[0] * ab[0] + ab[1] * ab[1];
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L2)) : 0;
    return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1]);
  };
  // The farthest any boundary point of A lies from B's boundary, up to CELL (B's edges are
  // bucketed on a CELL grid; a point with no edge in the 3 × 3 cells around it is ≥ CELL away).
  const CELL = 0.25;
  const oneWay = (A, B) => {
    const grid = new Map(), key = (i, j) => `${i},${j}`;
    for (const r of dense(B)) r.forEach((a, n) => {
      const b = r[(n + 1) % r.length];
      for (let i = Math.floor(Math.min(a[0], b[0]) / CELL); i <= Math.floor(Math.max(a[0], b[0]) / CELL); i++)
        for (let j = Math.floor(Math.min(a[1], b[1]) / CELL); j <= Math.floor(Math.max(a[1], b[1]) / CELL); j++) {
          const k = key(i, j);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([a, b]);
        }
    });
    let worst = 0;
    for (const p of dense(A).flat()) {
      const ci = Math.floor(p[0] / CELL), cj = Math.floor(p[1] / CELL);
      let best = CELL;
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
        for (const [a, b] of grid.get(key(i, j)) ?? []) best = Math.min(best, segDist(p, a, b));
      worst = Math.max(worst, best);
    }
    return worst;
  };
  const deviation = (A, B) => Math.max(oneWay(A, B), oneWay(B, A));
  const SHARP = { corners: "sharp" };

  test("shrinking a ring sector and growing it back returns the ring sector", () => {
    for (const h of [0.5, 0.95, 1.5, 2.5]) {
      const R = [region(sector)];
      expect(deviation(R, offsetRegions(offsetRegions(R, -h, SHARP), h, SHARP)), `h ${h}`).toBeLessThan(5e-3);
    }
  });

  test("…and a ring-sector hole grown shut and shrunk back returns the hole", () => {
    for (const h of [0.5, 0.95, 1.5, 2.5]) {
      const R = [region(plate(100, 80), [reversed(shifted(sector, [40, 25]))])];
      expect(deviation(R, offsetRegions(offsetRegions(R, h, SHARP), -h, SHARP)), `h ${h}`).toBeLessThan(5e-3);
    }
  });

  test("two overlapping circles meet at arc–arc corners, and those come back too", () => {
    // d 10 circles 6 apart, as one hole: a CW ring of two arcs crossing at (50, 40 ± 4).
    const lens = { start: [50, 44], segments: [{ via: [42, 40], to: [50, 36] }, { via: [58, 40], to: [50, 44] }] };
    for (const h of [0.5, 1.5]) {
      const R = [region(plate(100, 80), [reversed(lens)])];
      expect(deviation(R, offsetRegions(offsetRegions(R, h, SHARP), -h, SHARP)), `close h ${h}`).toBeLessThan(5e-3);
      expect(deviation(R, offsetRegions(offsetRegions(R, -h, SHARP), h, SHARP)), `open h ${h}`).toBeLessThan(5e-3);
    }
  });

  test("a sharp outset of a D is the D of the grown circle and the grown flat", () => {
    // A disc of radius 5 with a flat at x = 3 (corners 126.87°): grown by δ with its edges
    // extended, it is the disc of radius 5 + δ with its flat at x = 3 + δ.
    const D = { start: [3, -4], segments: [{ to: [3, 4] }, { via: [-5, 0], to: [3, -4] }] };
    const keptOf = (R, d) => Math.PI * R * R - (R * R * Math.acos(d / R) - d * Math.sqrt(R * R - d * d));
    for (const delta of [0.5, 1, 2]) {
      const out = offsetRegions([region(D)], delta, SHARP);
      expect(ringArea(tessellateContour(out[0].outer, 16384)), `δ ${delta}`).toBeCloseTo(keptOf(5 + delta, 3 + delta), 4);
    }
  });

  test("a line–line corner still takes the tangent miter", () => {
    expect(profileArea(offsetRegions([region(sq(10))], 1, SHARP))).toBeCloseTo(144, 9);
  });
});
