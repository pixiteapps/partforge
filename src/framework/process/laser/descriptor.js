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
// A hole ring that is a circle — every segment curved, every endpoint, arc midpoint and
// cubic midpoint within 1 % of one radius — as { d, at }, else null.
function roundHole(ring) {
  if (Array.isArray(ring) || !ring.segments?.length) return null;
  const pts = [ring.start];
  let from = ring.start;
  for (const seg of ring.segments) {
    if (!seg.via && !seg.c1) return null;
    pts.push(seg.via ?? cubicMid(from, seg), seg.to);
    from = seg.to;
  }
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const at = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const r = pts.reduce((acc, q) => acc + dist(q, at), 0) / pts.length;
  return r > 0 && pts.every((q) => Math.abs(dist(q, at) - r) <= 0.01 * r) ? { d: 2 * r, at } : null;
}

// Each segment of a ring as the hole plan and the prices see it: its end tangents, points
// along it to FLAT_TOL (its end included), and for a cubic which way it bends (+1 left:
// toward the material, since storage winding keeps the material on the left of travel;
// -1 right; 0 both ways, an inflected cubic) and its tightest radius. Zero-length lines
// are dropped: they have no direction.
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
const bez1 = (p0, c1, c2, p3, t) => { const u = 1 - t; return [0, 1].map((i) => 3 * (u * u * (c1[i] - p0[i]) + 2 * u * t * (c2[i] - c1[i]) + t * t * (p3[i] - c2[i]))); };
const bez2 = (p0, c1, c2, p3, t) => [0, 1].map((i) => 6 * ((1 - t) * (c2[i] - 2 * c1[i] + p0[i]) + t * (p3[i] - 2 * c2[i] + c1[i])));
function flattenCubic(p0, c1, c2, p3, out, depth = 0) {
  if (depth >= 10 || Math.max(pointSegDist(c1, p0, p3), pointSegDist(c2, p0, p3)) <= FLAT_TOL) { out.push(p3); return; }
  const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const a = m(p0, c1), b = m(c1, c2), c = m(c2, p3), ab = m(a, b), bc = m(b, c), mid = m(ab, bc);
  flattenCubic(p0, a, ab, mid, out, depth + 1);
  flattenCubic(mid, bc, c, p3, out, depth + 1);
}
const CUBIC_SAMPLES = 16;
function segInfo(from, seg) {
  const line = () => {
    const t = unit(sub2(seg.to, from));
    return t && { from, to: seg.to, t0: t, t1: t, pts: [seg.to] };
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
  let left = false, right = false, rMin = Infinity;
  for (let k = 0; k <= CUBIC_SAMPLES; k++) {
    const t = k / CUBIC_SAMPLES, d1 = bez1(from, c1, c2, to, t), d2 = bez2(from, c1, c2, to, t);
    const x = cross2(d1, d2), speed = Math.hypot(d1[0], d1[1]);
    if (x > 1e-12) left = true; else if (x < -1e-12) right = true;
    if (Math.abs(x) > 1e-12 && speed > 1e-9) rMin = Math.min(rMin, speed ** 3 / Math.abs(x));
  }
  const pts = [];
  flattenCubic(from, c1, c2, to, pts);
  return { from, to, cubic: true, t0, t1, dir: left && right ? 0 : left ? 1 : right ? -1 : 0, rMin, pts };
}
function ringParts(ring) {
  const c = asContour(ring), parts = [];
  let from = c.start;
  for (const seg of c.segments) { const p = segInfo(from, seg); if (p) parts.push(p); from = seg.to; }
  return parts;
}
const polyArea = (pts) => pts.reduce((a, q, i) => a + cross2(q, pts[(i + 1) % pts.length]), 0) / 2;

// ── what a width search can leave out ────────────────────────────────────────
// Every test shrinks and regrows the whole profile, and on booleaned geometry the whole
// profile is the dominant cost: paper hands a booleaned round hole back as four cubics,
// the offset engine returns each as 16–32 (its cubic offset is an approximation), and
// the one-sided difference against that near-copy costs paper time quadratic in them
// (2,048 cubics: 2 s; 4,096: 8 s). A hole that cannot take part in what a search counts
// is left out of it instead: the search runs on the profile rebuilt from its own rings
// without that hole (the kernel's trusted lift — no boolean, no validation, arcs kept).
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
// Prices are in units of about one desktop-Node millisecond, fitted to CPU time on 3 mm
// stock (docs/research/sheet-inspect-timing.md, "What a profile costs"):
//   a test (two sharp offsets), per segment of the shape tested:
//     line 1.2 (1,028: 1.1 s)   arc 2.5 (512 perforations with narrow webs: 1.1 s)
//     cubic 3 (1,024 beside 1,028 lines: 5.2 s)
//   and the offset engine's worst case, a cubic whose radius the test SHRINKS to within
//   a few w/2 (its cubic offset then subdivides toward the depth limit, and the winding
//   resolver pays for every piece). A cubic bending the way the first offset shrinks
//   (convex in an opening, concave in a closing) with radius at most 2.5·w/2 costs
//   12 × (their count)² — superlinear, and fitted to the worst measured: 16 rounded-rect
//   corners closed at 3 mm, 3.5 s; 64, 50 s; 256, 804 s. One bending the other way is
//   grown first and shrunk back, and costs 10 more when its radius is at most 1.5·w/2
//   (128 filleted tab corners closed at 1.5 mm: 1.2 s);
//   the one-sided difference, per segment of the shape tested and of its result:
//     line 0.25, arc 0.5, cubic 0.4 plus 0.0005 × (all the cubics)², paper's cost on
//     a cubic near-copy (1,024: 0.7 s, 2,048: 2 s, 4,096: 8 s).
// The meter scales every price by how much slower than that this device has run the
// steps it already took (never below 1), so a phone prices its own steps.
const PRICE = {
  test: { line: 1.2, arc: 2.5, cubic: 3, shrunkPair: 12, grownBack: 10 },
  diff: { line: 0.25, arc: 0.5, cubic: 0.4, cubicPair: 0.0005 },
};
const countsOf = (contours) => {
  const c = { line: 0, arc: 0, cubic: 0 };
  for (const rg of contours) for (const ring of [rg.outer, ...rg.holes]) {
    if (Array.isArray(ring)) { c.line += ring.length; continue; }
    for (const seg of ring.segments) c[seg.c1 ? "cubic" : seg.via ? "arc" : "line"]++;
  }
  return c;
};
// Which way each cubic of these rings bends, and its tightest radius (segInfo).
const cubicsOf = (contours) => contours.flatMap((rg) => [rg.outer, ...rg.holes])
  .flatMap((ring) => partsOf(ring).filter((pt) => pt.cubic).map(({ dir, rMin }) => ({ dir, rMin })));
// One test at width w on a search's shape. `shrinks` is the way a cubic bends when the
// test's first offset shrinks it: +1 (convex) in an opening, -1 (concave) in a closing.
function testPrice(search, shrinks, w) {
  const { line, arc, cubic } = search.counts, P = PRICE.test, h = w / 2;
  let shrunk = 0, grownBack = 0;
  for (const c of search.cubics) {
    if (c.dir !== -shrinks && c.rMin <= 2.5 * h) shrunk++;
    if (c.dir !== shrinks && c.rMin <= 1.5 * h) grownBack++;
  }
  return line * P.line + arc * P.arc + cubic * P.cubic + shrunk * shrunk * P.shrunkPair + grownBack * P.grownBack;
}
function diffPrice(a, b) {
  const P = PRICE.diff, cubics = a.cubic + b.cubic;
  return (a.line + b.line) * P.line + (a.arc + b.arc) * P.arc + cubics * P.cubic + cubics * cubics * P.cubicPair;
}
// spend(price): not started unless `price` fits before the deadline, scaled by this
// device's measured pace. Each call settles the step the last one priced. Exported for
// its unit test only.
export function _meter(deadline, now) {
  let priced = 0, took = 0, open = null;
  return (price = 0) => {
    const t = now();
    if (open) { priced += open.price; took += t - open.at; open = null; }
    const pace = priced >= 50 ? Math.max(1, took / priced) : 1;
    if (t + price * pace >= deadline) throw OUT_OF_TIME;
    open = { price, at: t };
  };
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
function oneSided(difference, spend, price) {
  spend(price);
  const d = difference();
  return !d.isEmpty() && d.regions().some((r) => r.area() > LOSS_TOL_MM2) ? d : null;
}

function openingLoss(search, w, spend) {
  let opened;
  try { opened = search.shape.offset(-w / 2, SHARP).offset(w / 2, SHARP); }
  catch (e) { if (COLLAPSES.test(e?.message ?? "")) return search.shape; throw e; }
  return oneSided(() => search.shape.cut(opened), spend, diffPrice(search.counts, countsOf(opened.toContours())));
}

function closingGain(search, w, spend) {
  const closed = search.shape.offset(w / 2, SHARP).offset(-w / 2, SHARP);
  return oneSided(() => closed.cut(search.shape), spend, diffPrice(search.counts, countsOf(closed.toContours())));
}

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
  const gap = narrowest((w) => closingGain(search, w, spend), ceiling, spend, (w) => testPrice(search, -1, w));
  const smallest = round.length ? round.reduce((a, b) => (b.d < a.d ? b : a)) : null;
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
  // need the 3-D part and are the oracle's to fill (oracle/measure.js).
  facts(s, { deadline = Infinity, now = Date.now } = {}) {
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
    const spend = _meter(deadline, now);
    const ceiling = 2 * widthFloor(t);
    // Each search's shape: the profile less the holes it can leave out, rebuilt from its
    // own rings — or the profile itself, when nothing is left out or the kernel has no
    // trusted lift.
    const lift = s.trustedShape2d;
    const plan = lift && pieces ? holePlan(contours, ceiling) : { open: null, close: null, round: [] };
    const searchOn = (reduced) => ({
      shape: reduced ? lift(reduced) : profile, counts: countsOf(reduced ?? contours), cubics: cubicsOf(reduced ?? contours),
    });
    try {
      const errors = { bridge: null, gap: null, marks: null, marksArea: null };
      const bridge = reading(errors, "bridge", () => {
        const search = searchOn(plan.open);
        return narrowest((w) => openingLoss(search, w, spend), ceiling, spend, (w) => testPrice(search, 1, w));
      });
      const gap = reading(errors, "gap", () => narrowestGap(searchOn(plan.close), plan.round, ceiling, spend));
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
