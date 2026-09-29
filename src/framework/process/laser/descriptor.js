// Laser cutting — process module #1. A ProcessDescriptor is DATA: which layers a sheet
// part draws, which keys it reserves, which destinations the kit offers. Later phases
// add its lint rules, DFM metrics and 2-D checks here.
//
// Import-free apart from sheet/constants.js: lint and the oracle read the registry, so
// nothing reachable from here may touch a kernel, a Shape2D or paper
// (test/lint-purity.test.js, test/oracle-no-paper.test.js). The writers that draw this
// process's cut files live in process/laser/export.js, which only the kit loads.
import {
  widthFloor, WIDTH_RESOLUTION, LOSS_TOL_MM2, SOLID_MATCH_PCT, SHEET_DOC_ID, fmtMm,
  isSheetPart, sheetMeta, LASER_THICKNESS_RANGE,
} from "../../sheet/constants.js";
import { warn } from "../../lint/finding.js";

// ── 2-D design-for-manufacture facts ──────────────────────────────────────────
// Read from the RESOLVED sheet (sheet/resolve.js) through Shape2D methods alone —
// offset, area, cut, union, intersect, regions, boundingBox — so this file stays
// import-free and paper never enters lint's or the oracle's module graph: the
// shapes' own methods carry the booleans. 2-D only; the oracle lifts a location
// into the assembly itself (oracle/measure.js).

// Sharp corners make shrink-then-regrow exact on rectilinear joinery; round ones
// would shave every corner and report it as a lost web.
const SHARP = { corners: "sharp" };
// Shape2D.offset's refusal when a shrink removes everything (geometry/contour-offset.js).
const COLLAPSES = /collapses the shape/;
// Thrown by `spend` once the shared deadline has passed; caught only in facts().
const OUT_OF_TIME = Symbol("sheet check budget");
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Number(x.toFixed(3));

// The centre of the bounding box of `shape`'s largest region; null for an empty shape.
function centreOfLargest(shape) {
  if (shape.isEmpty()) return null;
  let best = null, bestArea = -Infinity;
  for (const region of shape.regions()) {
    const a = region.area();
    if (a > bestArea) { best = region; bestArea = a; }
  }
  if (!best) return null;
  const { min, max } = best.boundingBox();
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
}

// ── contour geometry, from the IR alone (toContours) ──────────────────────────
// A ring is a point list (all lines) or { start, segments }, a segment a line
// ({ to }), an arc ({ via, to }) or a cubic ({ c1, c2, to }).
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cubicMid = (p0, { c1, c2, to }) => [0, 1].map((i) => (p0[i] + 3 * c1[i] + 3 * c2[i] + to[i]) / 8);
// A hole ring that is a circle — every segment curved, and the circle through each
// segment's ends and midpoint (an arc's own, a cubic's through its midpoint) within 1 % of
// one centre and radius — as { d, at }, else null. Read from each segment's circle, not a
// bounding box of its points: recovered arcs (withArcs) end wherever the fit split them.
function roundHole(ring) {
  if (Array.isArray(ring) || !ring.segments?.length) return null;
  const circles = [];
  let from = ring.start;
  for (const seg of ring.segments) {
    if (!seg.via && !seg.c1) return null;
    const a = arcCircle(from, seg.via ?? cubicMid(from, seg), seg.to);
    if (!a) return null;
    circles.push(a);
    from = seg.to;
  }
  const n = circles.length;
  const at = [circles.reduce((x, a) => x + a.c[0], 0) / n, circles.reduce((y, a) => y + a.c[1], 0) / n];
  const r = circles.reduce((acc, a) => acc + a.r, 0) / n;
  return r > 0 && circles.every((a) => dist(a.c, at) <= 0.01 * r && Math.abs(a.r - r) <= 0.01 * r) ? { d: 2 * r, at } : null;
}

// Each segment of a ring as the hole plan sees it: its end tangents and points along it to
// FLAT_TOL (its end included). Zero-length lines are dropped: they have no direction.
// FLAT_TOL is also how closely the searches' polylines follow a cubic (searchable, below):
// a cubic is cut where its control points lie within FLAT_TOL of the chord, which puts
// the curve within 3/4 of that (0.00375 mm) of the polyline.
const FLAT_TOL = 0.005;
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (v) => { const L = Math.hypot(v[0], v[1]); return L > 1e-12 ? [v[0] / L, v[1] / L] : null; };
const asContour = (ring) => (Array.isArray(ring)
  ? { start: ring[0], segments: [...ring.slice(1).map((q) => ({ to: q })), { to: ring[0] }] }
  : ring);
const pointSegDist = (q, a, b) => {
  const ab = sub2(b, a), L2 = dot2(ab, ab);
  const t = L2 > 0 ? Math.max(0, Math.min(1, dot2(sub2(q, a), ab) / L2)) : 0;
  return dist(q, [a[0] + t * ab[0], a[1] + t * ab[1]]);
};
function arcCircle(from, via, to) {
  const d = 2 * (from[0] * (via[1] - to[1]) + via[0] * (to[1] - from[1]) + to[0] * (from[1] - via[1]));
  if (Math.abs(d) < 1e-12) return null;
  const n = (q) => q[0] * q[0] + q[1] * q[1];
  const c = [(n(from) * (via[1] - to[1]) + n(via) * (to[1] - from[1]) + n(to) * (from[1] - via[1])) / d,
    (n(from) * (to[0] - via[0]) + n(via) * (from[0] - to[0]) + n(to) * (via[0] - from[0])) / d];
  const TAU = 2 * Math.PI, mod = (x) => ((x % TAU) + TAU) % TAU, ang = (q) => Math.atan2(q[1] - c[1], q[0] - c[0]);
  const a0 = ang(from), toVia = mod(ang(via) - a0), toEnd = mod(ang(to) - a0);
  return { c, r: dist(from, c), a0, sweep: toVia <= toEnd ? toEnd : toEnd - TAU };   // + counter-clockwise
}
// How far a cubic's control polygon turns — at least as far as the curve does: the angles
// between its legs, a leg of no length skipped.
function polyTurn(p0, c1, c2, p3) {
  const legs = [sub2(c1, p0), sub2(c2, c1), sub2(p3, c2)].filter((v) => Math.hypot(v[0], v[1]) > 1e-12);
  let turn = 0;
  for (let k = 1; k < legs.length; k++) turn += Math.abs(Math.atan2(cross2(legs[k - 1], legs[k]), dot2(legs[k - 1], legs[k])));
  return turn;
}
// A cubic as the ends of lines within FLAT_TOL of it — each piece's control points within
// FLAT_TOL of its chord — and, with `maxTurn`, each piece turning at most that far.
function flattenCubic(p0, c1, c2, p3, out, maxTurn = Infinity, depth = 0) {
  if (depth >= 10 || (Math.max(pointSegDist(c1, p0, p3), pointSegDist(c2, p0, p3)) <= FLAT_TOL
    && (maxTurn === Infinity || polyTurn(p0, c1, c2, p3) <= maxTurn))) { out.push(p3); return; }
  const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const a = m(p0, c1), b = m(c1, c2), c = m(c2, p3), ab = m(a, b), bc = m(b, c), mid = m(ab, bc);
  flattenCubic(p0, a, ab, mid, out, maxTurn, depth + 1);
  flattenCubic(mid, bc, c, p3, out, maxTurn, depth + 1);
}
function segInfo(from, seg) {
  const line = () => {
    const t = unit(sub2(seg.to, from));
    return t && { from, to: seg.to, t0: t, t1: t, pts: [seg.to], line: true };
  };
  if (seg.via) {
    const a = arcCircle(from, seg.via, seg.to);
    if (!a) return line();
    const tan = (q) => { const rad = sub2(q, a.c); return unit(a.sweep > 0 ? [-rad[1], rad[0]] : [rad[1], -rad[0]]); };
    const steps = Math.min(512, Math.max(1, Math.ceil(Math.abs(a.sweep) / (2 * Math.acos(Math.max(-1, 1 - FLAT_TOL / a.r))))));
    const pts = [];
    for (let i = 1; i < steps; i++) { const t = a.a0 + (a.sweep * i) / steps; pts.push([a.c[0] + a.r * Math.cos(t), a.c[1] + a.r * Math.sin(t)]); }
    pts.push(seg.to);
    return { from, to: seg.to, t0: tan(from), t1: tan(seg.to), pts };
  }
  if (!seg.c1) return line();
  const { c1, c2, to } = seg;
  const t0 = unit(sub2(c1, from)) ?? unit(sub2(c2, from)) ?? unit(sub2(to, from));
  const t1 = unit(sub2(to, c2)) ?? unit(sub2(to, c1)) ?? unit(sub2(to, from));
  if (!t0 || !t1) return null;
  const pts = [];
  flattenCubic(from, c1, c2, to, pts);
  return { from, to, t0, t1, pts };
}
function ringParts(ring) {
  const c = asContour(ring), parts = [];
  let from = c.start;
  for (const seg of c.segments) { const p = segInfo(from, seg); if (p) parts.push(p); from = seg.to; }
  return parts;
}
const polyArea = (pts) => pts.reduce((a, q, i) => a + cross2(q, pts[(i + 1) % pts.length]), 0) / 2;

// ── the shapes the searches run on ─────────────────────────────────────────────
// paper hands every arc back from a boolean as cubics — a booleaned round hole as four, a
// fillet as one — and the offset engine only approximates a cubic's offset (adaptive
// Tiller–Hanson, subdivided to OFFSET_TOL). That approximation has a slow band no price
// follows: a cubic an offset moves toward its centre of curvature until little of its
// radius is left subdivides toward the depth limit, and ONE step ran for seconds — 4–73 s
// on an ordinary rounded mounting plate with four M3 holes; 20 s on a row of six booleaned
// 2 × 8 mm ovals on 6 mm stock, whose tips a test grew first and then moved back past
// their centres; 1.6 s closing a plate's elliptical corners. And a sharp join extends a
// cubic only along its end tangent, which cuts short a corner where the curve meets
// another edge — a false narrow web or gap there. So each search reads its shape in two
// passes:
//   • every run of cubics on one circle becomes that circle's arcs (withArcs), through the
//     resolved sheet's `recoverArcs` (geometry/arc-fit.js, handed over by sheet/resolve.js:
//     this file imports nothing) — the fit the kit draws the cut files with, so the
//     searches read the geometry that is cut. It fits a whole run at once, through the
//     run's own ends (a split circle stays ONE circle; fitted cubic by cubic, the pieces of
//     a booleaned D met at a kink the offset engine read as a false 1 mm web), and accepts
//     it only within min(1e-3·r, 2e-3·chord) of every cubic at every probe and joint,
//     refusing a fit through three near-collinear points (a wave is not an arc);
//   • every cubic left that the search could carry into the slow band becomes a polyline
//     within FLAT_TOL of it, no piece turning more than SEARCH_TURN (searchable): lines
//     offset exactly, a line meets another edge at a corner the sharp join mitres exactly,
//     and a test on lines costs what its price says.
//     At the widest test (h = ceiling/2) a cubic the search's first offset moves toward its
//     centre of curvature is slow below about 2.2·h — the spike at 0.9–1.35·h and
//     superlinear around it — and one moved away first below about 0.35·h (grown to r + h,
//     then moved toward its centre by h by the second offset); the edges are measured on
//     elliptical corners and holes at 3 and 6 mm (docs/research/sheet-inspect-timing.md).
//     A cubic under TOWARD·h, or AWAY·h, is flattened: margins of 1.1× and 2× over those
//     edges, and a cubic that bends both ways is judged the strict way.
// The cubics left are benign at every width the search tests (every width is at most the
// ceiling), and are priced per cubic like any segment. Flattening EVERY cubic was measured
// and set aside: a benign curve becomes a hundred lines where it was four cubics, and a
// line-heavy test costs superlinearly (the prices below), so panels of ordinary elliptical
// holes that read in tens of milliseconds as cubics were priced out — 106 of the 151
// calibration panels read under the budget, against 114 this way.
// What the lines READ is the cubics' reading wherever a web has length. Where it is a point
// — two tight tips facing, two elliptical holes tip to tip — the search reads the width at
// which LOSS_TOL_MM2 of area leaves, and that area grows so slowly past the true web that a
// small change in the outline moves the reading a long way, either way. Cut to FLAT_TOL
// alone, 2 × 5 mm ovals 1.2 mm apart on 3 mm stock read 1.83 (a silent pass; the exact
// curves read 1.22), and 2 × 8 mm ovals 2.85 mm apart on 6 mm read 3.00. So no piece turns
// more than SEARCH_TURN either: on the reviewer's 40 tip-to-tip rows under the budget that
// leaves no silent pass the exact curves do not share, and six panels of the helpers-and-
// ellipses fuzz (test/sheet-dfm.test.js) read the notice instead of a reading. Area on a
// point contact is still the exact curves' own limit: they too pass some sub-floor tip
// webs (docs/research/sheet-inspect-timing.md, "Point contacts").
// Only the shapes the width searches run on: the area, pieces and marks read the profile.
const TOWARD = 2.5, AWAY = 0.75;                      // × h at the ceiling — see above
const SEARCH_TURN = (4 * Math.PI) / 180;             // per flattened piece — see above
// A cubic's tightest radius of curvature: the radius at CURVE_SAMPLES + 1 points, and the
// radius each sample interval turns through (its chord over its turn), whichever is
// smaller — a turn too sharp to show at any sample still shows across its interval. A
// cusp or a loop turns fast and reads tight.
const CURVE_SAMPLES = 32;
const bezAt = (p0, c1, c2, p3, t) => { const u = 1 - t; return [0, 1].map((i) => u * u * u * p0[i] + 3 * u * u * t * c1[i] + 3 * u * t * t * c2[i] + t * t * t * p3[i]); };
const bez1 = (p0, c1, c2, p3, t) => { const u = 1 - t; return [0, 1].map((i) => 3 * (u * u * (c1[i] - p0[i]) + 2 * u * t * (c2[i] - c1[i]) + t * t * (p3[i] - c2[i]))); };
const bez2 = (p0, c1, c2, p3, t) => [0, 1].map((i) => 6 * ((1 - t) * (c2[i] - 2 * c1[i] + p0[i]) + t * (p3[i] - 2 * c2[i] + c1[i])));
// → { r: its tightest radius, dir: +1 when it bends toward the material everywhere
// (left of travel: the storage winding keeps the material on the left), -1 away, 0 both }
function curveOf(p0, c1, c2, p3) {
  let r = Infinity, left = false, right = false, prev = null;
  for (let k = 0; k <= CURVE_SAMPLES; k++) {
    const t = k / CURVE_SAMPLES, v = bez1(p0, c1, c2, p3, t), a = bez2(p0, c1, c2, p3, t);
    const speed = Math.hypot(v[0], v[1]), x = cross2(v, a);
    if (speed < 1e-9) return { r: 0, dir: 0 };                    // a cusp
    if (x > 1e-12) left = true; else if (x < -1e-12) right = true;
    if (Math.abs(x) > 1e-12) r = Math.min(r, speed ** 3 / Math.abs(x));
    const here = { q: bezAt(p0, c1, c2, p3, t), dir: [v[0] / speed, v[1] / speed] };
    if (prev) {
      const turn = Math.abs(Math.atan2(cross2(prev.dir, here.dir), dot2(prev.dir, here.dir)));
      if (turn > 1e-9) r = Math.min(r, dist(prev.q, here.q) / turn);
    }
    prev = here;
  }
  return { r, dir: left && right ? 0 : left ? 1 : right ? -1 : 0 };
}
// Whether a search whose first offset moves the material `shrinks` (+1: an opening shrinks
// it; -1: a closing grows it) must flatten this cubic. A shrink moves a cubic that bends
// toward the material toward its centre.
function isSlow(p0, c1, c2, p3, ceiling, shrinks) {
  const { r, dir } = curveOf(p0, c1, c2, p3);
  return r < (dir === -shrinks ? AWAY : TOWARD) * (ceiling / 2);
}
// The contours with every circular run of cubics read as its arcs, or the same array when
// that changes nothing.
function withArcs(contours, recover) {
  let changed = false;
  const ring = (r) => {
    if (Array.isArray(r) || !r.segments.some((g) => g.c1)) return r;
    const arcs = recover(r);
    if (arcs.segments.some((g) => g.via)) changed = true;
    return arcs;
  };
  const out = contours.map((rg) => ({ outer: ring(rg.outer), holes: rg.holes.map(ring) }));
  return changed ? out : contours;
}
// The contours with every cubic a search moving the material `shrinks` could carry into
// the slow band as a polyline, or the same array when there is none.
function searchable(contours, ceiling, shrinks) {
  let changed = false;
  const ring = (r) => {
    if (Array.isArray(r) || !r.segments.some((g) => g.c1)) return r;
    const segments = [];
    let from = r.start, flat = false;
    for (const g of r.segments) {
      if (g.c1 && isSlow(from, g.c1, g.c2, g.to, ceiling, shrinks)) {
        const pts = [];
        flattenCubic(from, g.c1, g.c2, g.to, pts, SEARCH_TURN);
        for (const q of pts) segments.push({ to: q });
        flat = true;
      } else segments.push(g);
      from = g.to;
    }
    if (!flat) return r;
    changed = true;
    return { start: r.start, segments };
  };
  const out = contours.map((rg) => ({ outer: ring(rg.outer), holes: rg.holes.map(ring) }));
  return changed ? out : contours;
}

// ── what a width search can leave out ────────────────────────────────────────
// Every test shrinks and regrows the whole profile, so every ring a search can leave out
// is work it does not do — most of all a curve that is not a circle, which the searches
// may read as a polyline of many short lines (above). A hole that cannot take part in what
// a search counts is left out of it instead: the search runs on the profile rebuilt from
// its own rings without that hole (the kernel's trusted lift — no boolean, no validation,
// arcs kept).
//   • The closing (gap) grows the material and shrinks it back, which shrinks each hole
//     from its own boundary and regrows it alone: holes never meet in it. A round hole
//     is read directly (its narrowest opening is its diameter), and a convex hole at
//     least WIDTH_RESOLUTION wider than the ceiling with no corner sharper than 60° has
//     nothing in it that closes (it only loses rounded corners, which the closing does
//     not count): both leave the closing.
//   • The opening (bridge) shrinks and regrows the material BETWEEN boundaries, so a hole
//     takes part wherever another ring is within reach. A sharp offset moves a boundary
//     at most w/2 along a straight run or an arc and at most w at a mitred corner
//     (MITER_LIMIT 2), so two boundaries can meet in a test only when they are closer
//     than w + w. A convex hole — it has no material of its own to lose — whose
//     clearance to every other ring is at least twice the ceiling (1.5 times for a round
//     one, which has no corner) meets nothing at any tested width and leaves the
//     opening; the web around it is wider than the ceiling, so no finding goes with it.
// A hole with another piece of the profile inside it is never left out (filling it
// would bury the piece), and a profile of more than PLAN_RING_CAP rings is not planned
// (the plan's pairwise clearances would be the slow step; the prices below decide).
const ISOLATION = { round: 1.5, other: 2 };      // × the ceiling
const PLAN_RING_CAP = 2000;
const partsCache = new WeakMap();
const partsOf = (ring) => { let p = partsCache.get(ring); if (!p) { p = ringParts(ring); partsCache.set(ring, p); } return p; };
function ringPoints(ring) {
  const parts = partsOf(ring);
  return parts.length ? [parts[0].from, ...parts.flatMap((pt) => pt.pts).slice(0, -1)] : [];
}
const boxOf = (pts) => pts.reduce((b, q) => [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])],
  [Infinity, Infinity, -Infinity, -Infinity]);
const boxGap = (a, b) => Math.hypot(Math.max(0, b[0] - a[2], a[0] - b[2]), Math.max(0, b[1] - a[3], a[1] - b[3]));
const boxWithin = (inner, outer) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
// Every edge sampled to FLAT_TOL turns one way, and the ring turns once.
function convexPoly(pts) {
  const n = pts.length, s = Math.sign(polyArea(pts));
  if (n < 3 || !s) return false;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const e1 = sub2(pts[i], pts[(i - 1 + n) % n]), e2 = sub2(pts[(i + 1) % n], pts[i]);
    const x = cross2(e1, e2);
    if (x * s < -1e-9 * Math.hypot(e1[0], e1[1]) * Math.hypot(e2[0], e2[1])) return false;
    total += Math.atan2(x, dot2(e1, e2));
  }
  return Math.abs(Math.abs(total) - 2 * Math.PI) < 1e-6;
}
// A convex polygon's narrowest extent: it lies flush against one of its edges.
function minWidth(pts) {
  if (pts.length > 2048) return 0;
  let best = Infinity;
  pts.forEach((a, i) => {
    const e = unit(sub2(pts[(i + 1) % pts.length], a));
    if (e) best = Math.min(best, pts.reduce((far, q) => Math.max(far, Math.abs(cross2(e, sub2(q, a)))), 0));
  });
  return best;
}
// A corner sharper than 60° (a turn past 120°), where the sharp join bevels (MITER_LIMIT 2).
const ACUTE_TURN = (2 * Math.PI) / 3;
const sharpCorner = (ring) => {
  const parts = partsOf(ring);
  return parts.some((pt, i) => { const a = parts[(i - 1 + parts.length) % parts.length].t1; return Math.abs(Math.atan2(cross2(a, pt.t0), dot2(a, pt.t0))) > ACUTE_TURN; });
};
const segsCross = (a, b, c, d) => {
  const o = (p, q, r) => Math.sign(cross2(sub2(q, p), sub2(r, p)));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};
const segSegDist = (a, b, c, d) => (segsCross(a, b, c, d) ? 0
  : Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b)));
// Whether any edge of A comes within `reach` of any edge of B: B's edges are filtered once
// against A's box grown by `reach`, then each of A's edges is measured against those.
function polyNear(A, boxA, B, reach) {
  const edgeBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const near = [];
  for (let j = 0; j < B.length; j++) {
    const c = B[j], d = B[(j + 1) % B.length], box = edgeBox(c, d);
    if (boxGap(boxA, box) < reach) near.push([c, d, box]);
  }
  if (!near.length) return false;
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = A[(i + 1) % A.length], ea = edgeBox(a, b);
    for (const [c, d, box] of near) if (boxGap(ea, box) < reach && segSegDist(a, b, c, d) < reach) return true;
  }
  return false;
}
// ── boundaries that face each other ──────────────────────────────────────────────
// Two pieces of a profile's boundary FACE each other when they run within 60° of opposite
// directions — the two sides of a web, a slot, a finger, a narrow hole — and come within
// `reach` of each other. facingPairs calls visit(i, j, d) once for every such pair of
// pieces, with their distance: each ring cut along its flattened boundary (ringParts) into
// pieces no longer than `step` (a segment whole, by default) — only its lines' pieces with
// `linesOnly` — a piece's neighbours on its own ring skipped (they meet it at a vertex). The
// pieces are bucketed in a grid of cells at least `reach` and a mean piece wide, so the work
// is linear in them and in the pairs found.
// → the pieces, ring by ring in boundary order: { a, b, dir, len, ring, k, line }.
function facingPairs(contours, { reach, step = Infinity, linesOnly = false }, visit) {
  const pieces = [], rings = [];
  for (const rg of contours) for (const ring of [rg.outer, ...rg.holes]) {
    const r = rings.length;
    let k = 0;
    for (const part of partsOf(ring)) {
      let from = part.from;
      for (const to of part.pts) {
        const len = dist(from, to), n = Math.max(1, Math.ceil(len / step));
        if (len > 1e-12) for (let i = 0; i < n; i++, k++) {
          if (linesOnly && !part.line) continue;
          const a = [from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n];
          const b = [from[0] + ((to[0] - from[0]) * (i + 1)) / n, from[1] + ((to[1] - from[1]) * (i + 1)) / n];
          pieces.push({ a, b, dir: [(to[0] - from[0]) / len, (to[1] - from[1]) / len], len: len / n, ring: r, k, line: !!part.line });
        }
        from = to;
      }
    }
    rings.push(k);
  }
  const mean = pieces.length ? pieces.reduce((t, pc) => t + pc.len, 0) / pieces.length : 0;
  const cell = Math.max(reach, Number.isFinite(step) ? step : 0, mean), cells = new Map();
  const range = (lo, hi) => [Math.floor(lo / cell), Math.floor(hi / cell)];
  pieces.forEach((pc, i) => {
    const [x0, x1] = range(Math.min(pc.a[0], pc.b[0]) - reach, Math.max(pc.a[0], pc.b[0]) + reach);
    const [y0, y1] = range(Math.min(pc.a[1], pc.b[1]) - reach, Math.max(pc.a[1], pc.b[1]) + reach);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x},${y}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(i);
    }
  });
  pieces.forEach((pc, i) => {
    const seen = new Set();
    const [x0, x1] = range(Math.min(pc.a[0], pc.b[0]), Math.max(pc.a[0], pc.b[0]));
    const [y0, y1] = range(Math.min(pc.a[1], pc.b[1]), Math.max(pc.a[1], pc.b[1]));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const j of cells.get(`${x},${y}`) ?? []) {
      if (j <= i || seen.has(j)) continue;
      seen.add(j);
      const o = pieces[j];
      if (o.ring === pc.ring) { const n = rings[pc.ring], d = Math.abs(o.k - pc.k); if (Math.min(d, n - d) <= 1) continue; }
      if (dot2(pc.dir, o.dir) >= -0.5) continue;
      const d = segSegDist(pc.a, pc.b, o.a, o.b);
      if (d < reach) visit(i, j, d);
    }
  });
  return pieces;
}
// How many of a shape's lines face another of its lines within `reach`.
function facingLines(contours, reach) {
  const hit = new Set();
  facingPairs(contours, { reach, linesOnly: true }, (i, j) => { hit.add(i); hit.add(j); });
  return hit.size;
}

// → { open, close, round }: the contours each search runs on (null: the whole profile),
// and the round holes the closing left out, whose diameters are read instead. The
// clearances are measured hole against outer (few) and against the holes a sweep over
// their left edges can bring within reach — never every pair.
function holePlan(contours, ceiling) {
  const rings = [];
  contours.forEach((rg, ri) => [rg.outer, ...rg.holes].forEach((ring, j) => {
    const pts = ringPoints(ring);
    rings.push({ ri, hi: j - 1, ring, pts, box: boxOf(pts) });
  }));
  const none = { open: null, close: null, round: [] };
  if (rings.length > PLAN_RING_CAP) return none;
  const outers = rings.filter((o) => o.hi < 0);
  const holes = rings.filter((o) => o.hi >= 0).sort((a, b) => a.box[0] - b.box[0]);
  const widest = holes.reduce((w, h) => Math.max(w, h.box[2] - h.box[0]), 0);
  const firstFrom = (x) => { let lo = 0, hi = holes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (holes[m].box[0] < x) lo = m + 1; else hi = m; } return lo; };
  const clear = (r, reach) => {
    const close = (o) => o !== r && boxGap(r.box, o.box) < reach && polyNear(r.pts, r.box, o.pts, reach);
    if (outers.some(close)) return false;
    for (let i = firstFrom(r.box[0] - reach - widest); i < holes.length && holes[i].box[0] < r.box[2] + reach; i++)
      if (close(holes[i])) return false;
    return true;
  };
  const open = new Set(), close = new Set(), round = [];
  for (const r of holes) {
    if (r.pts.length < 3) continue;
    if (outers.some((o) => o.ri !== r.ri && boxWithin(o.box, r.box))) continue;
    const circle = roundHole(r.ring);
    if (!circle && !convexPoly(r.pts)) continue;
    const key = `${r.ri}:${r.hi}`;
    if (circle) { round.push(circle); close.add(key); }
    else if (minWidth(r.pts) >= ceiling + WIDTH_RESOLUTION && !sharpCorner(r.ring)) close.add(key);
    if (clear(r, (circle ? ISOLATION.round : ISOLATION.other) * ceiling + 2 * FLAT_TOL)) open.add(key);
  }
  const without = (keys) => (keys.size
    ? contours.map((rg, ri) => ({ outer: rg.outer, holes: rg.holes.filter((_, hi) => !keys.has(`${ri}:${hi}`)) }))
    : null);
  return { open: without(open), close: without(close), round };
}
// The plan on the profile's arcs, and each search's shape (null: the profile itself) —
// the plan's contours less the holes it leaves out, flattened for that search's direction.
function searchPlan(contours, ceiling, recover) {
  const arcs = recover ? withArcs(contours, recover) : contours;
  const p = holePlan(arcs, ceiling);
  const own = (reduced, shrinks) => {
    const flat = searchable(reduced ?? arcs, ceiling, shrinks);
    return flat === contours ? null : flat;
  };
  return { open: own(p.open, 1), close: own(p.close, -1), round: p.round };
}

// ── what a step costs ────────────────────────────────────────────────────────
// Nothing interrupts a step once it has started: the deadline is checked between them.
// So under a deadline every step is PRICED before it starts, and a step whose price
// does not fit what is left of the budget is not started — the reading stays out
// (evaluated: false, verify's notice), exactly as if the budget had run out, without a
// multi-second offset or boolean running past it inside partforge-cloud's one 8 s
// report. That covers every test — the first one too, so a profile too complex to read
// at all is not started — and every test's one-sided difference, priced from the
// test's own result before it starts. With no deadline the caller asked for the whole
// reading, however long, and gets it.
// Prices are in units of about one desktop-Node millisecond, fitted to main-thread CPU
// time on the searched shapes as they are now — circles as arcs, slow cubics as lines
// (searchable), every difference taken a margin clear (MARGIN) — on 2–6 mm stock
// (docs/research/sheet-inspect-timing.md, "What a profile costs"):
//   a test (two sharp offsets), per segment of the shape tested:
//     line 1.2 (1,028: 1.1 s; 884 of a polyline-rounded tab panel: 0.92 s), plus
//     0.002 × (the lines facing another piece of the boundary within the ceiling)²
//     (facingLines): where a test brings two polylines nearly tangent — the webs of a
//     grille of flattened ovals, a stroke of text — the winding resolver splits them into
//     many pieces and probes each against every edge, many times over (24 flattened
//     2 × 1 mm ovals on 2 mm stock, 964 lines all facing: 2.4 s, priced 3.0 s; six
//     2 × 8 mm ovals on 6 mm, 436 lines, 384 facing: 0.72 s, priced 0.82 s). Linear alone,
//     a grille of drawn polylines ran 2.3 s in one step priced 1.4 s;
//     arc 2.5 plus 0.0015 × (the arcs)²: the same resolver on a grille of round holes whose
//     webs a test collapses (200 arcs 0.2 s, 578 1.3 s, 1,058 4.1 s);
//     cubic 3 — a cubic left as one is out of the slow band, at every width tested;
//   the one-sided difference, per segment of the shape tested and of its result:
//     line 0.1 (a grille of 50 drawn 32-facet circles: 0.28 s, priced 0.34 s), arc 0.5 (a
//     grille of 196 round holes: 0.55 s, priced 0.94 s), cubic 0.15 (200 booleaned
//     ellipses, 8,900 cubics and lines: 1.2 s, priced 1.5 s);
//   the margin shape, once per search: one offset, half a test at no width;
//   each search's setup (setupSearch) and the boundary pass (nearContacts), below.
// Over the 151 calibration panels, read with no deadline, no test or difference costs more
// than 0.93 of its price, no setup or boundary pass more than 0.93 (1.4 on steps under
// 6 ms); under the budget the worst step is 0.83 (grilles of flattened ovals).
// The meter scales every price by how much slower than that this device has run the
// steps it already took (never below 1), so a phone prices its own steps.
const PRICE = {
  test: { line: 1.2, facingPair: 0.002, arc: 2.5, arcPair: 0.0015, cubic: 3 },
  diff: { line: 0.1, arc: 0.5, cubic: 0.15 },
};
const countsOf = (contours) => {
  const c = { line: 0, arc: 0, cubic: 0 };
  for (const rg of contours) for (const ring of [rg.outer, ...rg.holes]) {
    if (Array.isArray(ring)) { c.line += ring.length; continue; }
    for (const seg of ring.segments) c[seg.c1 ? "cubic" : seg.via ? "arc" : "line"]++;
  }
  return c;
};
// How many cubics of these rings a search moving the material `shrinks` could carry into
// the slow band: none in a shape searchable made.
const slowCubics = (contours, ceiling, shrinks) => contours.flatMap((rg) => [rg.outer, ...rg.holes]).reduce((n, ring) => {
  if (Array.isArray(ring)) return n;
  let from = ring.start;
  for (const g of ring.segments) { if (g.c1 && isSlow(from, g.c1, g.c2, g.to, ceiling, shrinks)) n++; from = g.to; }
  return n;
}, 0);
// The per-segment part of a test's price: what one offset of the shape costs, twice.
const linearTestPrice = ({ line, arc, cubic }) => line * PRICE.test.line + arc * PRICE.test.arc + cubic * PRICE.test.cubic;
// Past this, a test's price needs no facing count: it is past any budget as it is.
const FACING_CAP = 10000;
// One test on a search's shape. A shape holds a slow cubic only where the kernel has no
// trusted lift to rebuild the profile with (the profile itself is searched): no price
// follows it, so that test is never started under a deadline (Infinity; with none, it runs).
function testPrice(search) {
  const P = PRICE.test, { arc } = search.counts;
  if (search.slow) return Infinity;
  return linearTestPrice(search.counts) + arc * arc * P.arcPair + search.facing * search.facing * P.facingPair;
}
// A search's own setup — the profile rebuilt from its rings (the lift) and its facing lines
// counted — is a step too, priced per segment before it runs (the facing count skipped
// where the rest of the price is already FACING_CAP past any budget): a grille of 36
// flattened ovals packed 1 mm apart, 2,300 lines, 43 ms, priced 46.
const SETUP_PRICE = { line: 0.02, other: 0.002 };
function setupSearch(shapeOf, contours, ceiling, slow, spend) {
  const counts = countsOf(contours);
  spend(counts.line * SETUP_PRICE.line + (counts.arc + counts.cubic) * SETUP_PRICE.other);
  const search = { shape: shapeOf(), counts, slow, facing: 0 };
  if (!slow && linearTestPrice(counts) + counts.arc * counts.arc * PRICE.test.arcPair <= FACING_CAP) search.facing = facingLines(contours, ceiling);
  return search;
}
function diffPrice(a, b) {
  const P = PRICE.diff;
  return (a.line + b.line) * P.line + (a.arc + b.arc) * P.arc + (a.cubic + b.cubic) * P.cubic;
}
// spend(price): not started unless `price` fits before the deadline, scaled by this
// device's measured pace. Each call settles the step the last one priced, and
// spend.settle() the last one; `onStep` hears each settled step as { price, ms }.
// Exported for its unit test only.
export function _meter(deadline, now, onStep) {
  let priced = 0, took = 0, open = null;
  const settle = (t) => {
    if (!open) return;
    priced += open.price; took += t - open.at;
    onStep?.({ price: open.price, ms: t - open.at });
    open = null;
  };
  const spend = (price = 0) => {
    const t = now();
    settle(t);
    const pace = priced >= 50 ? Math.max(1, took / priced) : 1;
    if (deadline !== Infinity && t + price * pace >= deadline) throw OUT_OF_TIME;
    open = { price, at: t };
  };
  spend.settle = () => settle(now());
  return spend;
}

// ── one width ─────────────────────────────────────────────────────────────────
// A test at width w asks whether material narrower than w leaves the profile (an
// OPENING: shrink by w/2, regrow) or empty space narrower than w fills in (a CLOSING:
// grow by w/2, shrink back), and returns what left (or entered) it, or null.
//
// ONE-SIDED, never a net area change, and computed on every test. With sharp offsets a
// corner narrower than w does not come back as itself: a convex fillet on the outline —
// an arc, a cubic, a chamfer or a run of short straight segments alike — loses its short
// edges and regrows as a square corner OUTSIDE the profile, and a hole's rounded or
// chamfered corner closes back square INSIDE the hole. Each lands on the side opposite
// the one being measured, so a net area change let an ordinary fillet elsewhere cancel
// a real narrow web or slot (capped, "nothing narrower found"), and so did any shortcut
// that read "nothing changed" off the net change — near a coincident dimension the
// artifacts cancel the finding to zero. Counting only what left the profile (opening)
// or only what entered it (closing) puts every such artifact on the uncounted side.
// And a loss is ONE region above LOSS_TOL_MM2, never a sum: the cubic offset's own
// approximation error (OFFSET_TOL) leaves hundreds of sub-tolerance slivers along
// curved edges, and summed they read three 8 mm rounded holes as a 2.91 mm gap — the
// same rule marksFacts counts stray marks by.
// That difference is a boolean between the profile and its near-copy — on curves
// paper's worst case — so it is priced from the test's own result before it starts,
// like every step. And it has no fallback: when paper refuses it, the refusal ends the
// reading (narrowest), which verify reports as a check it could not take.
//
// It is measured MARGIN clear of the searched shape: what left the profile is what the
// test lost of the profile shrunk by MARGIN, and what entered it is what the test gained
// beyond the profile grown by MARGIN. Against the shape itself, every boundary the test
// did not change runs within a hair of its twin, split at other points, and paper's
// boolean on such a pair fails two ways: it refuses ("curve-fill: resolved hole has no
// containing outer" — a clean keyhole read no gap at all), or it returns nothing — a
// keyhole's 4 mm slot, filled by a closing at 4.3 and 4.5 mm, came back as an empty
// difference and the gap read 4.55. MARGIN apart, the boolean meets curves only where
// they really cross. The offset engine's approximation slivers along curves (OFFSET_TOL,
// 1e-3 mm) go with the margin — and so would a web or slot under 2·MARGIN (0.02 mm), which
// is exactly what a kerf burns away: those are read from the boundary itself instead
// (nearContacts, below). The margin shape is one offset of the searched shape, made once
// per search when its first difference runs and priced into that difference.
// ── no change ─────────────────────────────────────────────────────────────────
// A test that finds nothing on straight edges and on arcs it does not cut short hands
// back the rings it was given, cut at extra points: a miter join meets an edge again at
// a vertex of its own, and a sharp join extends an arc along its own circle as a second
// arc. Ring for ring — collinear line runs merged, co-circular arc runs merged, each ring
// matched cyclically in the same orientation, every vertex and every arc's centre, radius
// and ends within SAME_EPS of its twin — that is no loss and no gain, and the priced
// difference is not run for it. It proves exactly what the difference would: the two
// shapes differ only inside a SAME_EPS band along the boundary, whose regions hold at most
// 2·SAME_EPS × their length, far under LOSS_TOL_MM2 and inside MARGIN besides. It compares
// geometry, never a number artifacts could cancel. Anything else falls through to the
// difference: a ring more or less, a corner regrown square, any cubic (an offset cubic
// never comes back the same), a vertex a hair off — including every ring the offset's
// winding resolver rebuilt, since it places arcs only as well as paper's cubic circle.
const SAME_EPS = 1e-9;
// A ring as its edges — { from, line } or { from, arc: { c, r, ccw } } — with runs merged,
// or [{ circle }] for a ring that is one whole circle; null when it holds a cubic.
function canonRing(ring) {
  const c = asContour(ring), edges = [];
  let from = c.start;
  for (const seg of c.segments) {
    if (seg.c1) return null;
    const a = seg.via ? arcCircle(from, seg.via, seg.to) : null;
    if (a) edges.push({ from, arc: { c: a.c, r: a.r, ccw: a.sweep > 0 }, sweep: Math.abs(a.sweep) });
    else if (dist(from, seg.to) > SAME_EPS) edges.push({ from, line: true });
    from = seg.to;
  }
  const sameCircle = (x, y) => x.arc && y.arc && dist(x.arc.c, y.arc.c) <= SAME_EPS && Math.abs(x.arc.r - y.arc.r) <= SAME_EPS && x.arc.ccw === y.arc.ccw;
  if (edges.length && edges.every((e) => sameCircle(e, edges[0])) && Math.abs(edges.reduce((t, e) => t + e.sweep, 0) - 2 * Math.PI) < 1e-6)
    return [{ circle: edges[0].arc }];
  // Merge edge i+1 into edge i while it continues it: a line along the same line (its start
  // within SAME_EPS of the chord from i's start to its end), an arc on the same circle.
  for (let i = 0; edges.length > 1 && i < edges.length;) {
    const j = (i + 1) % edges.length, e = edges[i], n = edges[j], end = edges[(j + 1) % edges.length].from;
    const collinear = e.line && n.line && dist(e.from, end) > SAME_EPS
      && Math.abs(cross2(sub2(n.from, e.from), sub2(end, e.from))) <= SAME_EPS * dist(e.from, end)
      && dot2(sub2(n.from, e.from), sub2(end, n.from)) > 0;
    if (collinear || (sameCircle(e, n) && e.sweep + n.sweep < 2 * Math.PI - 1e-6)) {
      if (e.arc) e.sweep += n.sweep;
      edges.splice(j, 1);
      if (j < i) i--;                                   // the ring's first edge merged into its last
    } else i++;
  }
  return edges;
}
const sameEdge = (x, y) => dist(x.from, y.from) <= SAME_EPS && !!x.line === !!y.line
  && (x.line || (dist(x.arc.c, y.arc.c) <= SAME_EPS && Math.abs(x.arc.r - y.arc.r) <= SAME_EPS && x.arc.ccw === y.arc.ccw));
function sameRing(x, y) {
  if (x.length !== y.length) return false;
  if (x[0].circle || y[0].circle) return !!(x[0].circle && y[0].circle) && dist(x[0].circle.c, y[0].circle.c) <= SAME_EPS
    && Math.abs(x[0].circle.r - y[0].circle.r) <= SAME_EPS && x[0].circle.ccw === y[0].circle.ccw;
  for (let k = 0; k < y.length; k++) {
    if (dist(y[k].from, x[0].from) > SAME_EPS) continue;
    if (x.every((e, i) => sameEdge(e, y[(k + i) % y.length]))) return true;
  }
  return false;
}
// A shape's rings in canonical form, bucketed by a key two equal rings share (their edge
// count and first vertex rounded to 1e-6 mm, a circle's centre): a lookup that misses
// only costs the difference. Null when a ring holds a cubic.
const ringKey = (e) => {
  const q = (v) => Math.round(v * 1e6);
  if (e[0].circle) return `o${q(e[0].circle.c[0])},${q(e[0].circle.c[1])}`;
  const v = e.reduce((m, x) => (x.from[0] < m[0] || (x.from[0] === m[0] && x.from[1] < m[1]) ? x.from : m), e[0].from);
  return `${e.length}:${q(v[0])},${q(v[1])}`;
};
function canonShape(contours) {
  const rings = new Map();
  let count = 0;
  for (const rg of contours) for (const ring of [rg.outer, ...rg.holes]) {
    const e = canonRing(ring);
    if (!e) return null;
    const key = ringKey(e);
    if (!rings.has(key)) rings.set(key, []);
    rings.get(key).push(e);
    count++;
  }
  return { regions: contours.length, count, rings };
}
// Whether `shape` is the search's own shape, ring for ring.
function unchanged(search, shape) {
  const mine = (search.canon ??= canonShape(search.shape.toContours()) ?? false);
  if (!mine) return false;
  const theirs = canonShape(shape.toContours());
  if (!theirs || theirs.regions !== mine.regions || theirs.count !== mine.count) return false;
  for (const [key, list] of theirs.rings) {
    const pool = [...(mine.rings.get(key) ?? [])];
    for (const e of list) {
      const i = pool.findIndex((m) => sameRing(e, m));
      if (i < 0) return false;
      pool.splice(i, 1);
    }
  }
  return true;
}

const MARGIN = 0.01;
function oneSided(difference, spend, price) {
  spend(price);
  const d = difference();
  return !d.isEmpty() && d.regions().some((r) => r.area() > LOSS_TOL_MM2) ? d : null;
}
// The searched shape moved `side` × MARGIN (−1 shrunk, +1 grown), kept on the search, and
// what making it costs while it is not made yet: one offset, half a test at no width.
function margined(search, side) {
  return (search.margin ??= {})[side] ??= search.shape.offset(side * MARGIN, SHARP);
}
const marginPrice = (search, side) => (search.margin?.[side] ? 0 : linearTestPrice(search.counts) / 2);

function openingLoss(search, w, spend) {
  let opened;
  try { opened = search.shape.offset(-w / 2, SHARP).offset(w / 2, SHARP); }
  catch (e) { if (COLLAPSES.test(e?.message ?? "")) return search.shape; throw e; }
  if (unchanged(search, opened)) return null;
  return oneSided(() => margined(search, -1).cut(opened), spend,
    marginPrice(search, -1) + diffPrice(search.counts, countsOf(opened.toContours())));
}

function closingGain(search, w, spend) {
  const closed = search.shape.offset(w / 2, SHARP).offset(-w / 2, SHARP);
  if (unchanged(search, closed)) return null;
  return oneSided(() => closed.cut(margined(search, 1)), spend,
    marginPrice(search, 1) + diffPrice(search.counts, countsOf(closed.toContours())));
}

// ── what the margin hides ─────────────────────────────────────────────────────────
// A web or a slot narrower than 2·MARGIN fits inside the margin, so the difference cannot
// see it — a slot a hair inside the plate's edge, a hairline slit: exactly what a 0.1 mm
// kerf burns away. The margin cannot shrink to let it through: the winding resolver merges
// crossings CLUSTER_TOL (0.005 mm) apart, and at a 0.005 margin the corners of large arcs
// read false webs of 4.7–5.7 mm on 6 mm stock (sector panels of radius 100–800). So what
// it hides is found directly, from the profile's own boundary: two faces of it within
// NEAR of each other (facingPairs), walked in NEAR_STEP pieces. A run of such pieces along
// one ring, all with the material between the faces (a web: the bridge) or all with it
// outside (a slot: the gap), counts once it is NEAR_RUN long — LOSS_TOL_MM2 of area at that
// width, the rule the difference counts a loss by — so the two sides of a sharp tip, which
// part at once, never do. It reads the narrowest such run's width, rounded up to 0.01 mm,
// at the middle of its closest pair. Whole segments are checked first — most profiles
// have no two faces that close and are done there — and the 0.1 mm walk runs only when
// they do. Linear in the pieces; priced as the walk, like a step.
const NEAR = 2 * MARGIN, NEAR_STEP = 0.1, NEAR_RUN = LOSS_TOL_MM2 / NEAR;
const NEAR_PRICE = 0.003;                   // per piece — see nearPrice
// The boundary pass's price, per piece of the 0.1 mm walk: a 900-hole grille's 91,000 took
// 0.15 s walked, a sign's worth of text 0.03 s (its pieces crowd the grid's cells).
const nearPrice = (contours) => {
  let pieces = 0;
  for (const rg of contours) for (const ring of [rg.outer, ...rg.holes]) for (const part of partsOf(ring)) {
    let from = part.from;
    for (const to of part.pts) { pieces += Math.max(1, Math.ceil(dist(from, to) / NEAR_STEP)); from = to; }
  }
  return NEAR_PRICE * pieces;
};
// → { bridge, gap }: each { value, at } or null.
function nearContacts(contours) {
  // Whole segments first: most profiles have no two faces that close, and are done here.
  let any = false;
  facingPairs(contours, { reach: NEAR }, () => { any = true; });
  if (!any) return { bridge: null, gap: null };
  const hits = [];
  const pieces = facingPairs(contours, { reach: NEAR, step: NEAR_STEP }, (i, j, d) => hits.push([i, j, d]));
  const mid = (pc) => [(pc.a[0] + pc.b[0]) / 2, (pc.a[1] + pc.b[1]) / 2];
  const best = new Map();
  for (const [i, j, d] of hits) for (const [x, y] of [[i, j], [j, i]]) {
    const px = pieces[x], side = cross2(px.dir, sub2(mid(pieces[y]), px.a)) > 0 ? "bridge" : "gap";
    const cur = best.get(x);
    if (!cur || d < cur.d) best.set(x, { d, side, other: y });
  }
  const out = { bridge: null, gap: null };
  // A run is read at the middle of its narrowest stretch (within 1e-4 mm of its least width).
  const found = (side, run) => {
    const d = Math.min(...run.map((idx) => best.get(idx).d));
    const narrowest = run.filter((idx) => best.get(idx).d <= d + 1e-4), i = narrowest[Math.floor(narrowest.length / 2)];
    const at = [0, 1].map((c) => (mid(pieces[i])[c] + mid(pieces[best.get(i).other])[c]) / 2);
    const value = Math.max(0.01, Math.ceil(d * 100 - 1e-9) / 100);
    if (!out[side] || value < out[side].value) out[side] = { value, at };
  };
  for (let s0 = 0; s0 < pieces.length;) {
    let n = 1;
    while (s0 + n < pieces.length && pieces[s0 + n].ring === pieces[s0].ring) n++;
    const sideOf = (k) => best.get(s0 + (k % n))?.side ?? null;
    // Walk the ring from a piece whose side differs from its predecessor's, so that no run
    // wraps across the walk's start; a ring whose pieces all agree is one run.
    let first = 0;
    while (first < n && sideOf(first) === sideOf(first + n - 1)) first++;
    const stop = first === n ? n : first + n;
    for (let k = first === n ? 0 : first; k < stop;) {
      const side = sideOf(k), run = [];
      let len = 0;
      for (; k < stop && sideOf(k) === side; k++) { run.push(s0 + (k % n)); len += pieces[s0 + (k % n)].len; }
      if (side && len >= NEAR_RUN) found(side, run);
    }
    s0 += n;
  }
  return out;
}
// The reading with what the margin hides beside it: the narrower of the two.
const withNear = (reading, near) => (near && (reading.capped || near.value < reading.value)
  ? { value: near.value, capped: false, at: near.at }
  : reading);

// The geometry engine refuses with a plain Error ("contour-winding: could not chain…",
// "curve-fill: …"); a TypeError, RangeError or the like is a bug, never a refusal, and
// is left to propagate so reading() can report it.
const isRefusal = (e) => e instanceof Error && e.name === "Error";

// The narrowest width at which `test` finds something, bisected over [0, ceiling] to
// WIDTH_RESOLUTION: the upper end of the last bracket (the first width that fails),
// rounded to 0.01 mm. The ceiling is tried first — most panels have nothing that
// narrow, and one test settles them — and then reads as the ceiling itself, `capped`.
// The finding is located by the last shape actually found.
// An engine refusal at any width ends the reading: reading() records why, with the width
// it came at, and the value is null, so verify says the check could not be taken.
// Counting a refusal as found read a refusal between a web's true width and the floor as
// a sub-floor web (a false warning placed at the real web); counting it as not found
// would pass a check on nothing.
function narrowest(test, ceiling, spend, price) {
  const at = (w) => {
    spend(price(w));
    try { return test(w); } catch (e) {
      if (isRefusal(e)) throw new Error(`${e.message} (width search at ${fmtMm(w)} mm)`, { cause: e });
      throw e;
    }
  };
  let found = at(ceiling);
  if (!found) return { value: ceiling, capped: true, at: null };
  let lo = 0, hi = ceiling;
  while (hi - lo > WIDTH_RESOLUTION) {
    const mid = (lo + hi) / 2, hit = at(mid);
    if (hit) { hi = mid; found = hit; } else lo = mid;
  }
  return { value: round2(hi), capped: false, at: centreOfLargest(found) };
}

// The narrowest opening: the closing's reading on the profile less the holes it can
// leave out (holePlan), against the narrowest round hole it left out, read directly —
// a booleaned screw hole never enters the bisection (4.5 s for one M2.5 hole, before).
// The narrower of the two wins.
function narrowestGap(search, round, ceiling, spend) {
  const gap = narrowest((w) => closingGain(search, w, spend), ceiling, spend, () => testPrice(search));
  const smallest = round.length ? round.reduce((a, b) => (b.d < a.d - 1e-9 ? b : a)) : null;   // the first of equals
  return smallest && smallest.d < ceiling && (gap.capped || smallest.d < gap.value)
    ? { value: round2(smallest.d), capped: false, at: smallest.at }
    : gap;
}

// One budget-gated reading, or null when it could not be taken — the geometry engine
// refused this profile (an offset it could not chain), or anything else threw — a
// missing reading, never a failed report. Never a silent one either: the reason lands in
// `errors[key]` (SheetFacts.readErrors), and verify reports it (oracle/verify.js).
// Running out of time is not caught here: it ends every gated reading at once (facts()).
const READ_ERROR_CHARS = 200;
function reading(errors, key, fn) {
  try {
    return fn();
  } catch (e) {
    if (e === OUT_OF_TIME) throw e;
    errors[key] = String(e?.message || e).slice(0, READ_ERROR_CHARS);
    return null;
  }
}

// Engrave ∪ score grooves, and how many regions of it lie outside the cut.
function marksFacts(s, spend) {
  const marks = [s.engrave, ...s.grooves].filter(Boolean).reduce((acc, m) => (acc ? acc.union(m) : m), null);
  if (!marks) return { marks: null, outside: 0, at: null };
  spend();
  const off = marks.cut(s.profile);
  const outside = off.isEmpty() ? 0 : off.regions().filter((r) => r.area() > LOSS_TOL_MM2).length;
  return { marks, outside, at: outside ? centreOfLargest(off) : null };
}

// ── verify metrics ─────────────────────────────────────────────────────────────
// SUBPART_METRICS-shaped (verify-metrics.js spreads SHEET_METRICS in). All warnings.
// `doc` names the guide section a failing check points at — oracle/verify.js turns
// it into the check's `pattern`; it is deliberately not `pattern`, which must name a
// docs/ERROR-PATTERNS.md entry. `budgeted` marks the readings the 2-D deadline can
// withhold, which verify reports as not evaluated rather than unavailable; `readError`
// returns why a reading could not be taken, which verify reports instead of a bare skip.
const cappedNote = (key) => (s) => (s.sheet?.[`${key}Capped`]
  ? `nothing narrower than ${fmtMm(s.sheet[key])} mm found — the value is the search ceiling`
  : null);

const METRICS = {
  sheetBridge: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.bridge : null),
    locate: (s) => s.sheet?.at?.bridge ?? null,
    readError: (s) => s.sheet?.readErrors?.bridge ?? null,
    note: cappedNote("bridge"),
    hint: "a web or finger of this sheet part is narrower than a laser can leave standing (the floor is half the sheet thickness, at least 0.5 mm) — widen the material between cuts at the reported location, or use fewer, wider fingers" },
  sheetGap: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.gap : null),
    locate: (s) => s.sheet?.at?.gap ?? null,
    readError: (s) => s.sheet?.readErrors?.gap ?? null,
    note: cappedNote("gap"),
    hint: "a hole, slot or notch in this sheet part is narrower than a laser can reliably cut (half the sheet thickness, at least 0.5 mm) — widen it at the reported location" },
  sheetMarks: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => (s.sheet?.evaluated ? s.sheet.marksOutside : null),
    locate: (s) => s.sheet?.at?.marks ?? null,
    readError: (s) => s.sheet?.readErrors?.marks ?? null,
    hint: "an engrave or score mark lies outside the cut outline, so it would burn scrap or empty air — move it inside the profile" },
  sheetPieces: { kind: "warn", doc: SHEET_DOC_ID,
    extract: (s) => s.sheet?.pieces ?? null,
    hint: "the profile is not exactly one piece — a sheet part must cut out as one region; join the pieces or split them into separate sheetPart sub-parts" },
  sheetSolidMatch: { kind: "warn", doc: SHEET_DOC_ID, budgeted: true,
    extract: (s) => s.sheet?.solidMatchPct ?? null,
    readError: (s) => s.sheet?.readErrors?.marksArea ?? null,
    hint: "this sheet part's custom build drifts from its profile (volume vs. profile area × thickness) — the cut file comes from the profile, so fix the profile or drop the custom build" },
};

// ── lint ───────────────────────────────────────────────────────────────────────
// The laser's own rule; lint/rules-sheet.js appends every process's
// (PROCESS_LINT_RULES). Kernel-free, and a warning: the part still builds. A
// thickness that is not a finite number above 0 is sheet-thickness-invalid's error,
// not also this warning — one cause, one finding.
const LASER_RULES = [{
  id: "laser-thickness-range",
  run: ({ part, p, d, deriveError }) => {
    if (deriveError || !part?.parts || typeof part.parts !== "object") return [];
    const [lo, hi] = LASER_THICKNESS_RANGE;
    return Object.entries(part.parts).flatMap(([name, sp]) => {
      if (!isSheetPart(sp) || sp.sheet.process !== "laser" || typeof sp.build !== "function") return [];
      const meta = sheetMeta(sp, p, d);
      if (!meta || typeof meta.thickness !== "number" || !Number.isFinite(meta.thickness) || meta.thickness <= 0) return [];
      if (meta.thickness >= lo && meta.thickness <= hi) return [];
      return [warn("laser-thickness-range",
        `sub-part "${name}": laser sheet thickness ${fmtMm(meta.thickness)} mm is outside ${fmtMm(lo)}–${fmtMm(hi)} mm`,
        "Hobby lasers and cutting services handle roughly 0.5–12 mm stock; check that thickness is the measured value in mm (not inches or a stock code), or make this part another way.",
        `parts.${name}.sheet.thickness`, SHEET_DOC_ID)];
    });
  },
}];

export const LASER = {
  id: "laser",
  label: "Laser cutting",
  stock: "sheet",
  docId: SHEET_DOC_ID,
  // profile = the CUT layer (filled regions: outline plus holes), score = vector lines,
  // engrave = filled regions burned into the laser face.
  layers: { profile: "region", score: "line", engrave: "region" },
  // Keys only this process reserves (sheet/constants.js RESERVED_KEYS covers the
  // global ones: folds, bends, grain).
  reservedKeys: [],
  // No preview hook: the default extrusion-plus-marks build (sheet/resolve.js
  // sheetPreview) is the laser preview.
  preview: undefined,
  destinations: [{ id: "own-laser", cutFormat: "svg" }, { id: "service", cutFormat: "dxf" }],
  // The sheet's 2-D facts (SheetFacts). Budget-gated readings — bridge, gap, marks —
  // run only until `deadline` (an absolute time in ms on `now`'s clock, Date.now by
  // default), and a step priced past it is not started (meter); then `evaluated` stays
  // false and each is null. The rest is cheap and always read. `at` and `solidMatchPct`
  // need the 3-D part and are the oracle's to fill (oracle/measure.js). `onStep`, a
  // diagnostic for the timing bench and the tests, hears every priced step that ran as
  // { price, ms } on `now`'s clock.
  facts(s, { deadline = Infinity, now = Date.now, onStep } = {}) {
    const { profile, thickness: t } = s;
    const contours = profile.toContours();
    const pieces = contours.length;
    const area = pieces ? profile.area() : 0;
    const bb = pieces ? profile.boundingBox() : null;
    const f = {
      process: s.process, material: s.material, thickness: t, group: s.group,
      flat: bb ? [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]] : [0, 0],
      area, pieces, customBuild: s.customBuild,
      marksArea: null, bridge: null, bridgeCapped: false, gap: null, gapCapped: false,
      marksOutside: null, solidMatchPct: null,
      at2d: { bridge: null, gap: null, marks: null },
      at: { bridge: null, gap: null, marks: null },
      readErrors: { bridge: null, gap: null, marks: null, marksArea: null },
      evaluated: false,
    };
    const spend = _meter(deadline, now, onStep);
    const ceiling = 2 * widthFloor(t);
    // Each search's shape: the profile with its circular cubics read as arcs and its slow
    // cubics as lines (searchPlan), less the holes it can leave out, rebuilt from its own
    // rings — or the profile itself, when none of that changes it or the kernel has no
    // trusted lift. The plan is made inside the readings that use it (and kept once made),
    // so whatever goes wrong in it costs those readings (readErrors), never these facts.
    const lift = s.trustedShape2d;
    let planned = null;
    const plan = () => (planned ??= lift && pieces ? searchPlan(contours, ceiling, s.recoverArcs) : { open: null, close: null, round: [] });
    const searchOn = (reduced, shrinks) => setupSearch(() => (reduced ? lift(reduced) : profile), reduced ?? contours, ceiling,
      reduced ? 0 : slowCubics(contours, ceiling, shrinks), spend);
    // What the difference's margin hides (nearContacts), read once, for both searches.
    let near = null;
    const nearOf = () => {
      if (!near) { spend(nearPrice(contours)); near = nearContacts(contours); }
      return near;
    };
    try {
      const errors = { bridge: null, gap: null, marks: null, marksArea: null };
      const bridge = reading(errors, "bridge", () => {
        const search = searchOn(plan().open, 1);
        return withNear(narrowest((w) => openingLoss(search, w, spend), ceiling, spend, () => testPrice(search)), nearOf().bridge);
      });
      const gap = reading(errors, "gap", () => withNear(narrowestGap(searchOn(plan().close, -1), plan().round, ceiling, spend), nearOf().gap));
      const m = reading(errors, "marks", () => marksFacts(s, spend));
      // A custom build is compared with profile area × thickness minus the marks'
      // removed volume (oracle/measure.js), so it needs the marks inside the cut.
      const marksArea = !s.customBuild || m === null ? null
        : reading(errors, "marksArea", () => { spend(); return m.marks ? m.marks.intersect(profile).area() : 0; });
      Object.assign(f, {
        readErrors: errors,
        bridge: bridge?.value ?? null, bridgeCapped: bridge?.capped ?? false,
        gap: gap?.value ?? null, gapCapped: gap?.capped ?? false,
        marksOutside: m?.outside ?? null, marksArea,
        at2d: { bridge: bridge?.at ?? null, gap: gap?.at ?? null, marks: m?.at ?? null },
        evaluated: true,
      });
    } catch (e) {
      if (e !== OUT_OF_TIME) throw e;
    }
    if (onStep) spend.settle();
    return f;
  },
  // The process's own expectations, VOLUNTEERED by verify on every sheet and never
  // counted toward declared/evaluated (oracle/verify.js). Thresholds follow thickness.
  checks(f) {
    const floor = `>=${round3(widthFloor(f.thickness))}`;
    return {
      sheetBridge: floor, sheetGap: floor, sheetMarks: "0", sheetPieces: "1",
      ...(f.customBuild ? { sheetSolidMatch: `<=${SOLID_MATCH_PCT}` } : {}),
    };
  },
  metrics: METRICS,
  lintRules: LASER_RULES,
};
