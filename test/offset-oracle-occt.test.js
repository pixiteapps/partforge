// Oracle: the deleted OCCT/BRepOffsetAPI offset route, reconstructed test-locally
// (Drawing per region via replicad's draw API, offset, SVG-path readback) against
// the raw replicad/OCCT WASM kernel. This is the safety net for the native
// contour-offset engine: it exists to FIND divergence from BRepOffsetAPI, not to
// be green.
//
// Manifold must NOT boot in the same process as OCCT — this file boots only
// replicad/OCCT, and the Manifold oracle lives in its own file (vitest isolates
// per file) so that invariant holds automatically.
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { beforeAll, expect, test } from "vitest";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea, svgPathToRings } from "../src/framework/geometry/shape2d-regions.js";

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
// (default: all three). Polygonal + curved cases. (Mirrors offset-oracle-manifold.test.js's
// corpus — duplicated per Task 8's brief, since the two oracle files must not share a module
// that boots anything. The corner-style restrictions differ between the two files, though:
// see the acute entries below.)
const sq = (s) => ({ outer: { start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] }, holes: [] });
const circ = (r) => ({ outer: { start: [r, 0], segments: [{ via: [0, r], to: [-r, 0] }, { via: [0, -r], to: [r, 0] }] }, holes: [] });
const Lsh = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] }, holes: [] };
// 30x10 dumbbell — two 10x10 lobes joined by a 2-wide waist. At delta -2 the waist pinches
// shut and the shape must SPLIT into two 6x6 squares (72), the failure mode this branch's
// review found most defects in.
const dumb = { outer: { start: [0, 0], segments: [
  { to: [10, 0] }, { to: [10, 4] }, { to: [20, 4] }, { to: [20, 0] }, { to: [30, 0] },
  { to: [30, 10] }, { to: [20, 10] }, { to: [20, 6] }, { to: [10, 6] }, { to: [10, 10] },
  { to: [0, 10] }, { to: [0, 0] }] }, holes: [] };
// Acute corners: an 11-point star (alternating radii 10/4), points ~33deg interior.
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
  { name: "dumbbell", regions: [dumb], deltas: [1], curved: false },
  // NOT included here: the dumbbell at delta -2, where the waist pinches shut and the shape
  // must split in two. This oracle cannot answer it — replicad's Drawing.offset returns an
  // empty result (no innerShape) for the split, i.e. the deleted OCCT production route would
  // have thrown "offset collapses the shape" on a shape that does not collapse. Native gets it
  // exactly right (72.000, two regions), cross-checked against Clipper2 in
  // offset-oracle-manifold.test.js, which is the right oracle for this case.
  // Two disjoint regions in ONE offset call — the multi-region path.
  { name: "two disjoint squares", regions: [sq(10), { outer: { start: [20, 0], segments: [{ to: [34, 0] }, { to: [34, 10] }, { to: [20, 10] }, { to: [20, 0] }] }, holes: [] }], deltas: [1, -1], curved: false },
  // Acute corners inward: all three agree (an inward offset of a convex corner trims rather
  // than joining, so no join policy — and no miter limit — is involved).
  { name: "acute 11-point star (inward)", regions: [acuteStar], deltas: [-1], curved: false },
  // Acute corners outward: round + CHAMFER, but NOT sharp. Note this is the mirror image of
  // the Manifold file's restriction, and the reason is the join policy each oracle implements:
  // replicad's "bevel" IS native's chamfer semantics exactly (both 278.389 on this star at +2),
  // whereas Clipper2 approximates a bevel with two chords and lands on 288.138. OCCT's miter,
  // by contrast, is UNBOUNDED — it lets an acute spike shoot arbitrarily far past the corner
  // (326.534 here) where native applies miter limit 2 and falls back to a bevel (282.158,
  // matching this repo's own offsetPolygon to the digit). That divergence is deliberate and
  // documented in docs/KERNEL-CONTRACT.md's v1 -> v2 migration note; asserting agreement on
  // sharp here would be asserting OCCT's limit policy, not offset correctness.
  { name: "acute 11-point star (outward)", regions: [acuteStar], deltas: [2], corners: ["round", "chamfer"], curved: false },
];
const AREA_RTOL = 0.005;                       // 0.5 %
const HAUS_TOL = (curved) => (curved ? 2e-2 : 5e-3);  // curved: absorb the oracle's own faceting

let replicad;
beforeAll(async () => {
  // Boot preamble copied from src/testing/occt.js (createRequire / wasmBinary / setOC).
  const require = createRequire(import.meta.url);
  globalThis.require = globalThis.require ?? require;
  globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const { default: init } = await import("replicad-opencascadejs/src/replicad_single.js");
  const OC = await init({ wasmBinary: fs.readFileSync(require.resolve("replicad-opencascadejs/src/replicad_single.wasm")) });
  replicad = await import("replicad");
  replicad.setOC(OC);
}, 60_000);

// contour IR ring -> replicad Drawing (lines + threePointsArcTo for via arcs — the same
// mapping occt-backend's (now-deleted) contourDrawing used: `s.c1 ? cubicBezierCurveTo(...)
// : s.via ? threePointsArcTo(...) : lineTo(...)`; cubics via cubicBezierCurveTo).
function contourToDrawing(c) {
  let d = replicad.draw(c.start);
  for (const s of c.segments)
    d = s.c1 ? d.cubicBezierCurveTo(s.to, s.c1, s.c2)
        : s.via ? d.threePointsArcTo(s.to, s.via)
        : d.lineTo(s.to);
  return d.close();
}

// IMPORTANT deviation from the brief's suggested helper (confirmed empirically, see
// task-8-report.md): a single `drawingOf(regions).offset(delta, {...})` call does NOT
// implement Shape2D.offset's documented material-wise semantics for a region WITH
// holes ("outer +delta, holes -delta" — docs/AUTHORING-PARTS.md's offsetPolygon entry,
// and the same convention contour-offset.js's native engine implements via the
// outer-CCW/holes-CW storage invariant). replicad's own `offset()` (dist.js's
// `offsetBlueprint`) auto-corrects each individual closed contour's sign so a bare
// `.offset(+delta)` ALWAYS GROWS that contour outward regardless of the winding it
// was drawn with — verified directly: drawCircle(2).offset(1) and a hand-drawn CW
// square both grow, never shrink, under a bare positive delta. A CompoundBlueprint's
// offset (`cut2D(offset(outer,...), fuseAll(holes.map(offset...)))`) offsets EVERY
// sub-blueprint — including holes — through that same always-grows rule with the SAME
// signed delta, so a fused region-with-hole Drawing's holes GROW under +delta instead
// of shrinking (confirmed: a 2x2 hole in a 10x10 square grew to 3x3 under delta=+0.5
// via the naive single-call reconstruction — backwards from the documented and native
// behavior). That is a real quirk of replicad's Drawing API, not a native-engine bug:
// asserting the naive reconstruction against native would report a false divergence on
// every holed case. The correct oracle offsets the outer and each hole as INDEPENDENT
// standalone contours (each with its own always-grows-with-positive-delta offset, so
// the hole gets -delta to shrink it) and then cuts — mirroring exactly how this
// codebase's own offsetPolygon (polygon.js) already handles holes on plain point lists
// (`holes.map((h) => offsetPolygon(h, -delta, opts))`).
function offsetRegionOracle(rg, delta, lineJoinType) {
  const outerOff = contourToDrawing(rg.outer).offset(delta, { lineJoinType });
  if (!outerOff || !outerOff.innerShape)
    throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  let result = outerOff;
  for (const h of rg.holes) {
    const holeOff = contourToDrawing(h).offset(-delta, { lineJoinType });
    if (holeOff && holeOff.innerShape) result = result.cut(holeOff);
    // else: the hole itself collapsed under erosion (shrunk to nothing) — no hole
    // survives to cut, matching what an eroded-to-nothing hole should do. Not
    // exercised by this file's corpus (deltas are small relative to hole size).
  }
  return result;
}
const oracleRings = (regions, delta, lineJoinType) => {
  const fused = regions.reduce((acc, rg) => {
    const r = offsetRegionOracle(rg, delta, lineJoinType);
    return acc ? acc.fuse(r) : r;
  }, null);
  return fused.toSVGPaths().flat(Infinity).flatMap((d) => svgPathToRings(d, SEGS))
    .map((ring) => ring.map(([x, y]) => [x, -y]));   // toSVGPathD is y-down
};

// chamfer -> "bevel": unlike Clipper2 (Manifold oracle), replicad's "bevel" join is
// EXACTLY the semantic native chamfer implements — a true straight-chord bevel at
// every corner, not a 2-chord approximation. The deleted production route
// (occt-backend.js's offsetDrawing, see git history) mapped corners->lineJoinType
// the same way: `{ round: "round", chamfer: "bevel", sharp: "miter" }`. So unlike
// the Manifold file, there's no semantic gap to exclude here — chamfer is included.
const JOIN = { round: "round", sharp: "miter", chamfer: "bevel" };
for (const { name, regions, deltas, curved, corners: styles = ["round", "sharp", "chamfer"] } of CORPUS) {
  for (const delta of deltas) for (const corners of styles) {
    test(`${name} delta=${delta} ${corners} matches BRepOffsetAPI within tolerance`, () => {
      const native = rings(offsetRegions(regions, delta, { corners }));
      const oracle = oracleRings(regions, delta, JOIN[corners]);
      // Only the oracle side needs abs() around totalArea: the y-flip in oracleRings
      // (toSVGPathD is y-down) inverts its global winding sign, but native's sign is
      // already correct (outer CCW positive, holes CW negative) — leaving it un-abs'd
      // means a hypothetical native winding inversion would still be caught here.
      expect(Math.abs(totalArea(native) - Math.abs(totalArea(oracle))) / Math.abs(totalArea(oracle))).toBeLessThan(AREA_RTOL);
      expect(hausdorff(native, oracle)).toBeLessThan(HAUS_TOL(curved));
    });
  }
}

// Sharp joins at ARC corners (contour-offset.js extendedJoin): where an arc meets a line or
// another arc at a real corner on the gap side, a sharp offset extends the arc along its
// own circle — OCCT's intersection join (BRepOffsetAPI_MakeOffset with GeomAbs_Intersection,
// replicad's Wire.offset2D(d, "intersection")), not the tangent miter replicad's
// Drawing.offset builds and the rows above compare against. Every row is a shape and delta
// where OCCT answers and no acute tip is involved (an acute corner takes the miter limit,
// the documented divergence above). Where the extended pieces never meet within 2|delta| — a
// 3..5 ring sector grown by 2, whose inner arc collapses — native falls back to the tangent
// miter and neither oracle matches; KERNEL-CONTRACT.md says so, and no row asserts it.
const P = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];
const ARC_CORNERS = [
  { name: "D (r 5 arc, flat chord)", c: { start: [3, -4], segments: [{ to: [3, 4] }, { via: [-5, 0], to: [3, -4] }] }, deltas: [0.5, 2, 4, -1] },
  { name: "pie 90° r 10", c: { start: [0, 0], segments: [{ to: [10, 0] }, { via: P(10, 45), to: [0, 10] }, { to: [0, 0] }] }, deltas: [1, 4, -1] },
  { name: "pie 90° r 1 (small radius)", c: { start: [0, 0], segments: [{ to: [1, 0] }, { via: P(1, 45), to: [0, 1] }, { to: [0, 0] }] }, deltas: [1, 4] },
  { name: "ring sector 10..20 × 90°", c: { start: [20, 0], segments: [{ via: P(20, 45), to: [0, 20] }, { to: [0, 10] }, { via: P(10, 45), to: [10, 0] }, { to: [20, 0] }] }, deltas: [2, 4, -1] },
  { name: "lens (two r 5 arcs)", c: { start: [0, -4], segments: [{ via: [2, 0], to: [0, 4] }, { via: [-2, 0], to: [0, -4] }] }, deltas: [2, 4] },
  { name: "plate with a r 3 notch (concave arc-line)", c: { start: [0, 0], segments: [{ to: [20, 0] }, { to: [20, 10] }, { to: [13, 10] }, { via: [10, 7], to: [7, 10] }, { to: [0, 10] }, { to: [0, 0] }] }, deltas: [1, -1] },
  { name: "plate with a r 0.5 notch (small radius)", c: { start: [0, 0], segments: [{ to: [20, 0] }, { to: [20, 10] }, { to: [10.5, 10] }, { via: [10, 9.5], to: [9.5, 10] }, { to: [0, 10] }, { to: [0, 0] }] }, deltas: [-1] },
  ...[5, 1.2].map((deg) => {
    const e = 5 * Math.tan((deg * Math.PI) / 180), Rn = 6 / Math.sin((deg * Math.PI) / 180), sag = Rn - Math.sqrt(Rn * Rn - 36);
    return [
      { name: `stadium kinked ${deg}° (near-tangent)`, c: { start: [0, 0], segments: [{ to: [10, 0] }, { via: [10 - e + Math.hypot(e, 5), 5], to: [10, 10] }, { to: [0, 10] }, { via: [e - Math.hypot(e, 5), 5], to: [0, 0] }] }, deltas: [4] },
      { name: `shallow notch, ${deg}° corners (near-tangent)`, c: { start: [0, 0], segments: [{ to: [20, 0] }, { to: [20, 10] }, { to: [16, 10] }, { via: [10, 10 - sag], to: [4, 10] }, { to: [0, 10] }, { to: [0, 0] }] }, deltas: [2, -2] },
    ];
  }).flat(),
];
const FINE = 1024;
const drawingOf = (c) => {
  let d = replicad.draw(c.start);
  for (const s of c.segments) d = s.via ? d.threePointsArcTo(s.to, s.via) : d.lineTo(s.to);
  return d.close();
};
// OCCT's intersection offset of one closed contour, as { area, rings }: offset2D's sign
// convention depends on the wire's orientation, so both signs are tried and the one that
// grows (delta > 0) or shrinks (delta < 0) the face is kept.
function occtIntersection(c, delta) {
  const faceArea = (w) => replicad.measureArea(replicad.makeFace(w));
  const a0 = faceArea(drawingOf(c).sketchOnPlane("XY").wire);
  for (const sign of [1, -1]) {
    let w;
    try { w = drawingOf(c).sketchOnPlane("XY").wire.offset2D(sign * Math.abs(delta), "intersection"); } catch { continue; }
    const area = faceArea(w);
    if (delta > 0 ? area > a0 : area < a0) {
      const pts = [];
      for (const e of w.edges) for (let i = 0; i < 256; i++) { const p = e.pointAt(i / 256); pts.push([p.x, p.y]); }
      return { area, rings: [pts] };
    }
  }
  throw new Error(`OCCT could not offset ${delta}`);
}
for (const { name, c, deltas } of ARC_CORNERS) for (const delta of deltas) {
  test(`${name} delta=${delta} sharp matches OCCT's intersection join`, () => {
    const native = offsetRegions([{ outer: c, holes: [] }], delta, { corners: "sharp" });
    const nativeRings = native.flatMap((rg) => [tessellateContour(rg.outer, FINE), ...rg.holes.map((h) => tessellateContour(h, FINE))]);
    const oracle = occtIntersection(c, delta);
    expect(Math.abs(totalArea(nativeRings) - oracle.area) / oracle.area).toBeLessThan(1e-3);
    expect(hausdorff(nativeRings, oracle.rings)).toBeLessThan(5e-3);      // the winding resolver's own precision
  });
}
