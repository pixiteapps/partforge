// Native curve-aware contour offset — the engine behind Shape2D.offset. Pure leaf in
// the worker graph (DOM-free, three-free, node:-free). Offsets every ring by one signed
// rule: each point displaced `delta` along the normal to the RIGHT of the direction of
// travel — under the storage winding invariant (outer CCW, holes CW) that always points
// away from the filled interior, so positive delta grows outers and shrinks holes with
// no per-ring casing. Lines and arcs offset EXACTLY; cubics use adaptive Tiller–Hanson.
//
// The cubic subdivision approach is ported from glenzli/paperjs-offset
// (https://github.com/glenzli/paperjs-offset, MIT License, Copyright (c) glenzli),
// adapted from paper.js Segments to the partforge contour IR.
import { arcCenterAndSweep, booleanRegions } from "./paper-bridge.js";
import { cubicAt, splitCubic, jointTangents, SMOOTH_JOINT_DEG } from "./contour-ops.js";
import { tessellateContour, closeContourGap } from "./profile.js";
import { ringArea, pointInRing } from "./shape2d-regions.js";
import { resolveOffsetWinding, CLUSTER_TOL, CHAIN_INCOMPLETE_MESSAGE } from "./contour-winding.js";

export const OFFSET_TOL = 1e-3;   // mm — max deviation of a cubic offset approximation
const MAX_DEPTH = 12;             // cubic subdivision recursion cap
const JOIN_EPS = 1e-6;            // endpoints closer than this are coincident

const VALIDATE_SEGS = 32;
const AREA_EPS = 1e-9;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scl = (v, s) => [v[0] * s, v[1] * s];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (v) => Math.hypot(v[0], v[1]);
const norm = (v) => { const L = len(v) || 1; return [v[0] / L, v[1] / L]; };
const rightOf = ([tx, ty]) => [ty, -tx];   // unit right-of-travel normal
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function offsetLine(from, to, delta) {
  const n = scl(rightOf(norm(sub(to, from))), delta);
  return { start: add(from, n), segments: [{ to: add(to, n) }], dirty: false };
}

function offsetArc(from, seg, delta) {
  const c = arcCenterAndSweep(from, seg.via, seg.to);
  if (!c) return offsetLine(from, seg.to, delta);          // collinear via → straight
  const { center, r, dA } = c;
  // CCW sweep (dA>0): right-of-travel is the outward radial → r+delta; CW: inward → r-delta
  const rNew = r + (dA >= 0 ? delta : -delta);
  if (Math.abs(rNew) <= JOIN_EPS) {
    // fully collapsed arc: bridge the offset endpoints with a line, let cleanup cope
    const tanAt = (p) => { const rad = sub(p, center); return norm(dA >= 0 ? [-rad[1], rad[0]] : [rad[1], -rad[0]]); };
    const q = (p) => add(p, scl(rightOf(tanAt(p)), delta));
    return { start: q(from), segments: [{ to: q(seg.to) }], dirty: true };
  }
  // rNew < 0 lands every point on the opposite side of center — the inverted loop
  // that stage-3 cleanup removes. Same projection formula either way.
  const proj = (p) => add(center, scl(norm(sub(p, center)), rNew));
  return { start: proj(from), segments: [{ via: proj(seg.via), to: proj(seg.to) }], dirty: rNew < 0 };
}

// Tiller–Hanson single-piece offset of cubic (p0,c1,c2,p1): displace endpoints along
// their endpoint normals and the handle line by the normal of the c1→c2 chord, then
// accept only if sampled deviation stays within OFFSET_TOL; otherwise split at t=0.5.
// (Ported from paperjs-offset's offsetSegment/adaptiveOffsetCurve.)
function offsetCubic(p0, c1, c2, p1, delta, depth) {
  const nz = (v) => (len(v) > 1e-9 ? v : null);
  const t0 = norm(nz(sub(c1, p0)) ?? nz(sub(c2, p0)) ?? sub(p1, p0));
  const t1 = norm(nz(sub(p1, c2)) ?? nz(sub(p1, c1)) ?? sub(p1, p0));
  const off0 = scl(rightOf(t0), delta), off1 = scl(rightOf(t1), delta);
  const hChord = nz(sub(c2, c1)) ?? sub(p1, p0);
  const hN = scl(rightOf(norm(hChord)), delta);
  const q0 = add(p0, off0), q1 = add(p1, off1);
  const qc1 = add(c1, scl(add(hN, off0), 0.5)), qc2 = add(c2, scl(add(hN, off1), 0.5));
  let ok = true;
  for (const t of [0.25, 0.5, 0.75]) {
    const d = dist(cubicAt(q0, qc1, qc2, q1, t), cubicAt(p0, c1, c2, p1, t));
    if (Math.abs(d - Math.abs(delta)) > OFFSET_TOL) { ok = false; break; }
  }
  if (ok || depth >= MAX_DEPTH) return { start: q0, segments: [{ to: q1, c1: qc1, c2: qc2 }], dirty: !ok };
  const [L, R] = splitCubic(p0, c1, c2, p1, 0.5);
  const a = offsetCubic(L.p0, L.c1, L.c2, L.p1, delta, depth + 1);
  const b = offsetCubic(R.p0, R.c1, R.c2, R.p1, delta, depth + 1);
  return { start: a.start, segments: [...a.segments, ...b.segments], dirty: a.dirty || b.dirty };
}

// One IR segment (running from `from` to seg.to) → its raw offset piece.
export function _offsetSegment(from, seg, delta) {
  if (seg.c1) return offsetCubic(from, seg.c1, seg.c2, seg.to, delta, 0);
  if (seg.via) return offsetArc(from, seg, delta);
  return offsetLine(from, seg.to, delta);
}

const MITER_LIMIT = 2;

// Where X falls along the directed segment P0→P1, as a fraction of its length (null for a
// degenerate segment). This is the overlap-side trim's validity test — see the trim itself.
function paramOn(P0, P1, X) {
  const d = sub(P1, P0), L2 = dot(d, d);
  if (L2 < 1e-18) return null;
  return dot(sub(X, P0), d) / L2;
}

// Intersection of the line through P (direction u) with the line through Q (direction v).
function lineIntersect(P, u, Q, v) {
  const d = cross(u, v);
  if (Math.abs(d) < 1e-12) return null;
  const w = sub(Q, P);
  return add(P, scl(u, cross(w, v) / d));
}

// A sharp join's miter apex, or null where the miter would pass MITER_LIMIT·|delta| and the
// join falls back to the bevel — a turn past 120°, i.e. a spike of material under 60°. One
// spelling for the join itself and for the source-hole disk gate (sharpHoleTakesMiters),
// which is only sound while no join on the hole bevels.
function sharpMiter(corner, aEnd, bStart, inTan, outTan, delta, limit = MITER_LIMIT) {
  const X = lineIntersect(aEnd, inTan, bStart, outTan);
  return X && dist(X, corner) <= limit * Math.abs(delta) ? X : null;
}

// Segments bridging aEnd → bStart around `corner` on the gap side.
function joinSegs(corner, aEnd, bStart, inTan, outTan, delta, corners) {
  if (corners === "chamfer") return [{ to: bStart }];
  if (corners === "sharp") {
    const X = sharpMiter(corner, aEnd, bStart, inTan, outTan, delta);
    if (X) return [{ to: X }, { to: bStart }];
    return [{ to: bStart }];                               // miter-limit fallback = bevel
  }
  // round: exact arc about the corner, via on the displacement bisector
  const d1 = sub(aEnd, corner), d2 = sub(bStart, corner);
  let m = add(d1, d2);
  // 180° turn: the two displacement normals cancel exactly, but their sum's LIMIT as the
  // turn approaches 180° is the incoming tangent direction (for either delta sign) — the
  // cap bulges forward past the tip. The old rightOf(d1) fallback put `via` on the
  // diametrically wrong side, sweeping the cap arc back through the interior where the
  // winding rule cancelled it and the whole tip cap silently vanished (review finding,
  // execution-confirmed: a zero-width spike dilated +1 round lost its end caps — area
  // 20.000 where the stadium truth is 20+π, maxX 10 where the cap reaches 11).
  if (len(m) < 1e-9) m = inTan;
  return [{ via: add(corner, scl(norm(m), Math.abs(delta))), to: bStart }];
}

// Exposed for stroke-outline.js, which walks OPEN chains and so cannot use
// _offsetContour's ring loop, but needs exactly this join vocabulary
// (round/chamfer/sharp + miter limit) at its interior vertices.
export const _joinSegs = joinSegs;

// Offset one explicitly-closed ring. Returns { contour, dirty }.
export function _offsetContour(contour, delta, corners) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  // drop zero-length line segments (they carry no direction)
  const keep = contour.segments.map((s, i) => s.c1 || s.via || dist(pts[i], s.to) > 1e-9);
  const segs = contour.segments.filter((_, i) => keep[i]);
  const froms = [];
  { let p = contour.start; for (const s of contour.segments) { froms.push(p); p = s.to; } }
  const fromsKept = froms.filter((_, i) => keep[i]);
  // A ring whose every segment dropped as zero-length has no direction to offset along —
  // treat it as collapsed (contour:null) rather than letting assembleRing dereference an
  // empty piece list (review finding, execution-confirmed: a sub-1e-9-extent sliver ring
  // from an upstream boolean reaches here through the public surface — checkPointRing
  // demands three points, not nonzero extent — and crashed the whole offset with a raw
  // TypeError instead of the pinned collapse message).
  if (segs.length === 0) return { contour: null, dirty: true };
  // NB: feed jointTangents the KEPT chain's start — if the first segment was dropped
  // as zero-length, contour.start no longer heads the filtered ring.
  const joints = jointTangents({ start: fromsKept[0] ?? contour.start, segments: segs });
  const pieces = segs.map((s, i) => _offsetSegment(fromsKept[i], s, delta));
  let dirty = pieces.some((p) => p.dirty);
  const n = segs.length;
  const joins = new Array(n).fill(null);   // joins[i] bridges piece[i-1] → piece[i] at vertex i
  // Each piece's ORIGINAL (pre-trim) first- and last-segment extents, captured before the
  // join loop starts mutating them. The trim gate below is a question about the raw offset
  // geometry, so it must be asked of the raw extents: reading the live, partly-trimmed ones
  // makes the answer depend on which corner the loop happens to have reached, and a ring
  // whose corners are then trimmed inconsistently (some yes, some no) is worse than either
  // all-trimmed or none-trimmed — measured: a 6.99×7.78 rectangular hole at delta +3.5 (it
  // over-collapses in x by 0.008 mm and should vanish) leaves a 12.26 mm² spurious face
  // under a live-extent gate and 0.007 mm² under this one.
  //
  // Built eagerly for every piece, deliberately. Deferring it to the first overlap-side corner
  // looks like free savings — four .slice() allocations per piece, read only by the trim gate —
  // and it is not: an INWARD offset (the case the trim exists for, and the one benchmarked
  // below) puts every convex corner on the overlap side, so every piece's extents get demanded
  // anyway and laziness buys one closure call per corner. Measured, 300 runs, 100 disjoint
  // squares: eager 0.328-0.334 ms against lazy 0.336-0.344 at delta -1, and eager 0.842 against
  // lazy 0.827 at +1 — a wash in both directions. Not worth the ordering invariant it would add
  // (corner i mutates piece i-1's last `.to` and piece i's `.start`, so a lazy read would have
  // to be proven to happen before those, forever).
  const ext = pieces.map((p) => ({
    aFrom: (p.segments.length > 1 ? p.segments.at(-2).to : p.start).slice(),
    aEnd: p.segments.at(-1).to.slice(),
    bStart: p.start.slice(),
    bEnd: p.segments[0].to.slice(),
  }));

  for (let i = 0; i < n; i++) {
    const prev = pieces[(i - 1 + n) % n], next = pieces[i];
    const aEnd = prev.segments.at(-1).to, bStart = next.start;
    const { point, inTan, outTan } = joints[i];
    const turn = cross(inTan, outTan);
    const turnDeg = (Math.atan2(Math.abs(turn), Math.max(-1, Math.min(1, inTan[0] * outTan[0] + inTan[1] * outTan[1]))) * 180) / Math.PI;
    if (dist(aEnd, bStart) <= JOIN_EPS || turnDeg < SMOOTH_JOINT_DEG) continue;   // smooth
    // Gap side gets a join. An EXACT 180° reversal (turn === 0 with a large turnDeg — the
    // tip of a zero-width spike) is ambiguous under the sign test alone and used to fall
    // through to the overlap branch, flat-capping a requested round end; treat it as gap
    // side so the cap is honored (an inward spike's join makes an inverted loop the
    // winding rule cancels, so the choice is safe for either delta sign).
    if (turn * delta > 0 || turn === 0) { joins[i] = joinSegs(point, aEnd, bStart, inTan, outTan, delta, corners); continue; }
    // Overlap side: the two offset pieces run into each other instead of leaving a gap.
    // When both neighbors are plain lines and the two offset LINES cross WITHIN both
    // segments' own extents, that crossing is the true corner of the offset outline: trim
    // both to it and the ring stays simple, so validateRawOffset's exact fast path still
    // applies (this is the everyday polygon inset, and keeping it on the fast path matters —
    // 100 disjoint squares at delta −1 measure 0.33 ms against 9.1 ms with the trim ablated,
    // both as shipped, i.e. with the in-extent gate below in force. An earlier revision of
    // this comment quoted 0.22 ms, which was the UNGATED trim; the gate costs the difference
    // and the number to plan against is the one the code actually runs).
    //
    // The in-extent test is the whole point and is NOT a formality. Past a corner's own
    // feature size the two offset lines still cross, but OUTSIDE both segments — the "trim"
    // then EXTENDS the segments to a point neither of them reaches, fabricating material the
    // raw offset never covered, and because the result is still a simple, correctly-wound
    // ring nothing downstream can tell. That was the whole residual gap after the winding
    // resolver landed: on the clustered-reflex 9-gon at delta −2.79 it produced 4.621926
    // against a true 3.553831 (Clipper2 and an independent Minkowski-union construction
    // agree on that value), ~30 % too much surviving area. Untrimmed, the crossing offset
    // segments are simply emitted and the positive-winding rule cancels the reversed loop,
    // which is what every standard offset algorithm (Clipper2 included) does — so decline
    // the trim, bevel across, and let resolveOffsetWinding do it properly.
    const aSeg = prev.segments.at(-1), bSeg = next.segments[0];
    if (!aSeg.via && !aSeg.c1 && !bSeg.via && !bSeg.c1) {
      const X = lineIntersect(aEnd, inTan, bStart, outTan);
      const eA = ext[(i - 1 + n) % n], eB = ext[i];
      const ta = X && paramOn(eA.aFrom, eA.aEnd, X), tb = X && paramOn(eB.bStart, eB.bEnd, X);
      if (X && ta !== null && tb !== null && ta > 0 && ta <= 1 && tb >= 0 && tb < 1) {
        aSeg.to = X; next.start = X; continue;             // exact trim, stays clean
      }
    }
    joins[i] = [{ to: bStart }]; dirty = true;
  }

  // Whole-ring collapse check: when delta exceeds the ring's own inradius, EVERY plain-line
  // piece's trimmed direction reverses relative to its pre-offset direction — reflection
  // through the collapse point preserves winding, so the reflected ring passes every other
  // validity check there is (paper.js included: it's a genuinely simple polygon, just the
  // wrong one). That whole-ring signal is reliable; a PER-PIECE version of it is not — it
  // also fires on ordinary trims (acute barbs, narrow slots, non-square holes, 45° chamfers)
  // that never reflected, and "fixing" those by un-trimming produces over-inclusive geometry
  // instead of the correct, already-exact Task 1-4 result. So: only act when ALL plain-line
  // pieces agree; when some but not all do, this is a normal partial trim — leave it alone.
  // Critically, "the whole ring" means EVERY piece of the ring, not just its line pieces: a
  // ring where lines are a minority (a mostly-arc disc with a small tab, say) can have every
  // one of its few line pieces reverse while the ring as a whole is nowhere near collapsed —
  // requiring lineReversals.length === n makes this a genuine whole-ring predicate again. An
  // all-arc ring that truly collapses is still caught downstream: offsetArc already marks
  // rNew<0 / fully-collapsed arcs dirty, routing to cleanup instead of a false fast-path pass.
  // pieceDot[i] is the reversal signal (dot of post-trim vs pre-offset direction) for
  // plain-line piece i, or null for arc/cubic pieces — a dot of zero here also flags a
  // piece trimmed down to zero length, since a zero vector's dot with anything is 0.
  const pieceDot = pieces.map((p, i) => {
    if (p.segments.length !== 1 || p.segments[0].via || p.segments[0].c1) return null;
    const origDir = sub(segs[i].to, fromsKept[i]);
    const newDir = sub(p.segments[0].to, p.start);
    return dot(newDir, origDir);
  });
  const lineReversals = pieceDot.filter((d) => d !== null).map((d) => d <= 0);
  if (lineReversals.length === n && n > 0 && lineReversals.every(Boolean)) return { contour: null, dirty: true };

  // Part 1 of the partial-reflection fix (task 5B): the whole-ring gate above only fires
  // when EVERY plain-line piece reverses — by design, since a per-piece version of that
  // gate also fires on ordinary trims that never reflected (see the comment above). But a
  // ring that does NOT collapse wholesale can still carry one or two individually-reversed
  // pieces (an over-offset corner that trimmed past its own neighbor) — that's the seed of
  // the partial-reflection residual: those pieces survive into the ring and validateRawOffset
  // can't see anything locally wrong with them. Delete them (not un-trim — un-trimming was
  // rejected in an earlier round for other over-inclusive regressions) and re-link the
  // surviving neighbors with a direct chord, marking the ring dirty so resolveOffsetWinding
  // gets a chance to untangle whatever that chord leaves behind. Every non-line piece
  // always survives this pass; the whole-ring gate above already guarantees at least one
  // piece survives here too.
  const allIdx = pieces.map((_, i) => i);
  const dropped = pieceDot.map((d) => d !== null && d <= 0);
  if (!dropped.some(Boolean)) return { contour: assembleRing(pieces, joins, allIdx, n), dirty };

  const keptIdx = allIdx.filter((i) => !dropped[i]);
  if (keptIdx.length === 0) return { contour: null, dirty: true };

  // Guard (review round 1, Important 3): deletion is unrecoverable — unlike a chord/dirty
  // join, which resolveOffsetWinding can still untangle downstream, a deleted piece is gone for
  // good, so a bad deletion can turn perfectly good geometry into a false "offset collapses
  // the shape" throw (measured: 18 new throws per 3000 random polygons; repro: a 9-gon at
  // delta -2.79/chamfer with true eroded area 2.76). A raw *piece count* floor doesn't work as
  // the discriminator — an arc-dominated ring can be legitimately reduced to a single
  // surviving piece (this file's own storage convention stores a full circle as just two arcs;
  // the keyed-bore regression test below reduces to one surviving arc + closing chord and that
  // IS the correct answer). Routing through the former Paper.js self-union cleanup did not
  // work either — it was tried first and rejected because it assumed the CCW/positive-area
  // "outer" convention (an
  // uninverted self-union is real material, an inverted one that flips positive is a
  // discarded artifact), but _offsetContour has no idea here whether it's assembling an outer
  // or a hole, and a perfectly valid CW/negative-area hole ring (like the keyed bore's) reads
  // as "inverted" under that assumption and gets wrongly discarded. What actually
  // distinguishes "deletion destroyed real geometry" from "deletion correctly trimmed it
  // down" is winding-agnostic: is the assembled result still a SIMPLE (non-self-intersecting)
  // ring with nonzero area — exactly what validateRawOffset's own segment-crossing test
  // (ringSelfIntersects, defined below) already checks without any orientation assumption.
  // Fall back to the un-deleted ring (still marked dirty, since a piece DID look reversed)
  // when deletion isn't simple: cleanup gets a chance to untangle whatever the un-deleted
  // piece leaves behind, which is strictly more recoverable than deletion's dead end.
  const deleted = assembleRing(pieces, joins, keptIdx, n);
  const deletedRing = sampleRing(deleted, VALIDATE_SEGS);
  const deletedArea = Math.abs(ringArea(deletedRing));
  if (deletedArea <= AREA_EPS || ringSelfIntersects(deletedRing))
    return { contour: assembleRing(pieces, joins, allIdx, n), dirty: true };
  return { contour: deleted, dirty: true };
}

// Assemble a closed ring from a subset of offset pieces (by index into `pieces`, in ring
// order), bridging consecutive survivors with their original join (when adjacent in the
// source ring) or a single chord (when one or more pieces were skipped in between — Part 1's
// deletion path). `idx = [0..n-1]` (every piece kept) reproduces the plain, no-deletion
// assembly exactly, since every piece is then "adjacent" to the next by construction.
function assembleRing(pieces, joins, idx, n) {
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    out.push(...pieces[i].segments);
    const nextI = idx[(k + 1) % idx.length];
    if (nextI === (i + 1) % n) {
      const j = joins[nextI];
      if (j) out.push(...j);
    } else {
      // one or more pieces were skipped between i and nextI: bridge with a single chord
      out.push({ to: [pieces[nextI].start[0], pieces[nextI].start[1]] });
    }
  }
  const start = pieces[idx[0]].start;
  const last = out.at(-1);
  if (dist(last.to, start) <= JOIN_EPS) last.to = [start[0], start[1]];  // snap the closure exactly
  else out.push({ to: [start[0], start[1]] });
  return { start, segments: out };
}

// Do two segments meet anywhere — including AT an endpoint of either one? The orientation
// test `o1 !== o2 && o3 !== o4` already answers that (a vertex-incident crossing shows up as
// one orientation being 0 and the other two straddling), so the endpoint-incident case costs
// nothing extra; what it costs is the right to be sloppy about adjacency, which is why every
// caller must hand this a ring with no duplicate and no zero-length vertices (see dedupeRing).
//
// This used to demand all four orientations be nonzero — "strict crossings only" — and that
// discarded exactly the case an inward offset produces most often: a ring that runs into
// ITSELF at one of its own vertices. A 20×10 block with an 8-deep slot, inset by 2, offsets
// the slot floor DOWN past the block's own eroded bottom edge, so the ring dips below y=2 and
// re-crosses it AT the vertices where the slot walls land — every crossing endpoint-incident,
// every orientation product zero, `validateRawOffset` satisfied, and the tangled ring taken
// straight down the exact fast path. It silently kept 32 mm² of a true 48 mm² erosion (the
// walls' offsets cancel under positive winding, which is what resolveOffsetWinding would have
// done had the ring ever reached it). Endpoint-incidence is not a degenerate curiosity here;
// it is the generic case, because offset pieces are BUILT by translating shared vertices.
function segsIntersect(a1, a2, b1, b2) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a1, a2, b1), o2 = o(a1, a2, b2), o3 = o(b1, b2, a1), o4 = o(b1, b2, a2);
  return o1 !== o2 && o3 !== o4;
}

// True when two (non-adjacent) segments are collinear and overlap along more than a point.
// segsIntersect is an orientation test, and a fully collinear pair makes all four
// orientations 0, so `o1 !== o2` is false and it reports nothing — yet an offset ring can
// retrace the same line twice (a neck/hole pinched shut by delta past its own width flips
// the offset pieces from either side onto each other), producing exact duplicate or
// overlapping collinear edges with no transversal crossing anywhere. That is this test's
// job and it stays: widening segsIntersect to endpoint-incidence does not subsume it.
function segsOverlap(a1, a2, b1, b2) {
  const d = sub(a2, a1);
  const L = len(d);
  if (L < 1e-9) return false;
  const u = norm(d);
  const perp = (p) => Math.abs(cross(u, sub(p, a1)));      // distance off the a1→a2 line
  if (perp(b1) > 1e-9 || perp(b2) > 1e-9) return false;     // not collinear with a
  const t = (p) => dot(sub(p, a1), u);                      // param along a1→a2
  const [ta1, ta2] = [0, L];
  const [tb1, tb2] = [t(b1), t(b2)].sort((x, y) => x - y);
  return Math.min(ta2, tb2) - Math.max(ta1, tb1) > 1e-9;    // overlap longer than a touch
}

// Axis-aligned bounding box of a ring / of one segment, and a disjointness test between
// two boxes. These exist purely as a rejection filter in front of the pairwise segment
// tests below: validateRawOffset runs on the geometry worker on EVERY offset (so on every
// parameter change), and its pairwise loops are O(R²·m²) in ring count and ring resolution
// with nothing to stop them. Measured on offsetRegions end to end, +0.5 round over N disjoint
// squares: 40 → 11.6 ms before this filter and 1.0 ms after, 100 → 64.0 / 1.3 ms, 200 → 326.2
// / 2.0 ms — clean quadratic before, effectively flat after. (Many-region TEXT is a smaller
// win — a 24-glyph string went 93 → 85 ms — because a glyph's raw offset ring self-intersects,
// so validation short-circuits early and paper.js cleanup dominates that case regardless.)
// Boxes never change the ANSWER — two segments whose boxes are disjoint cannot cross or
// overlap — so this is a pure short-circuit, not an approximation.
const BOX_EPS = 1e-9;
function ringBox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
const boxesApart = (a, b) =>
  a[2] < b[0] - BOX_EPS || b[2] < a[0] - BOX_EPS || a[3] < b[1] - BOX_EPS || b[3] < a[1] - BOX_EPS;
const segBox = (p, q) => [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];

// Every ring below is read as IMPLICITLY closed — segment i runs ring[i] → ring[(i+1)%m] —
// and the pairwise loops decide "these two may legitimately touch" purely from index
// adjacency. `tessellateContour` does not produce such a ring: it emits the closing point,
// so ring[m-1] === ring[0]. That duplicate is not harmless bookkeeping once segsIntersect
// counts endpoint contact. It creates a zero-length segment m-1 sitting on ring[0], and it
// pushes the real closing edge back to index m-2 — which then shares the vertex ring[0] with
// segment 0 while being two apart in the index, i.e. NON-adjacent by the loop's reckoning.
// Result: every ring in the repo would report a self-touch at its own start point, and every
// offset would take the resolver. Coincident interior vertices (a join that lands exactly on
// its neighbour, a piece trimmed to zero length) do the same thing one index further in.
// So: normalize first, and let "non-adjacent" mean what it says.
const RING_EPS = 1e-9;
function dedupeRing(ring) {
  const out = [];
  for (const p of ring) if (!out.length || dist(out.at(-1), p) > RING_EPS) out.push(p);
  while (out.length > 1 && dist(out[0], out.at(-1)) <= RING_EPS) out.pop();
  return out;
}
// Tessellate a contour into the deduplicated, implicitly-closed ring the tests below expect.
// (ringArea / ringBox / pointInRing all wrap modularly too, so they read it unchanged.)
const sampleRing = (contour, segs) => dedupeRing(tessellateContour(contour, segs));

function ringSelfIntersects(ring) {
  const m = ring.length;
  const boxes = [];
  for (let i = 0; i < m; i++) boxes.push(segBox(ring[i], ring[(i + 1) % m]));
  for (let i = 0; i < m; i++) for (let j = i + 2; j < m; j++) {
    if (i === 0 && j === m - 1) continue;                  // adjacent via wraparound
    if (boxesApart(boxes[i], boxes[j])) continue;
    const a1 = ring[i], a2 = ring[(i + 1) % m], b1 = ring[j], b2 = ring[(j + 1) % m];
    if (segsIntersect(a1, a2, b1, b2) || segsOverlap(a1, a2, b1, b2)) return true;
  }
  return false;
}

// Two DIFFERENT rings interfering. Like ringSelfIntersects this checks segsOverlap as well
// as segsIntersect: two rings can interfere without any transversal crossing at all when
// their boundaries run along the same line — exactly what two eroding holes that grew into
// each other produce under a sharp join, where the crossings land on shared vertices and the
// rest of the signal is a pair of collinear, partially-overlapping edges. Missing that let an
// invalid double-ring result pass the fast path and reach extrude, where even-odd fill turned
// the doubly-covered lens back into SOLID material inside the merged pocket. (The shared-
// vertex half of that is now caught directly — segsIntersect counts endpoint contact — but
// the collinear half still is not, so both tests stay.)
function ringsCross(a, b, boxA = ringBox(a), boxB = ringBox(b)) {
  if (boxesApart(boxA, boxB)) return false;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    const bx = segBox(a1, a2);
    if (boxesApart(bx, boxB)) continue;
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length];
      if (boxesApart(bx, segBox(b1, b2))) continue;
      if (segsIntersect(a1, a2, b1, b2) || segsOverlap(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

// Every point of `inner` strictly inside `outer`. Sampling ONE point (which this used to do)
// is satisfied by a hole that has grown most of the way out through its own outer boundary
// as long as its first vertex happens to still be inside — and a hole ring poking outside
// its outer is not merely inaccurate, it becomes real material: fed through toRegions() and
// CrossSection.ofPolygons(…,"EvenOdd"), the escaped part of the ring extrudes to a solid tab
// hanging off the plate below its own boundary.
function ringInsideRing(inner, outer, outerBox) {
  for (const p of inner) {
    if (p[0] < outerBox[0] || p[0] > outerBox[2] || p[1] < outerBox[1] || p[1] > outerBox[3]) return false;
    if (!pointInRing(p, outer)) return false;
  }
  return true;
}

// True when a raw offset result is already valid (fast path). Sampled at VALIDATE_SEGS.
export function validateRawOffset(regions) {
  const sampled = regions.map((rg) => ({
    outer: sampleRing(rg.outer, VALIDATE_SEGS),
    holes: rg.holes.map((h) => sampleRing(h, VALIDATE_SEGS)),
  }));
  const allRings = [];
  for (const rg of sampled) {
    if (ringArea(rg.outer) <= AREA_EPS) return false;                  // flipped or collapsed outer
    const outerBox = ringBox(rg.outer);
    for (const h of rg.holes) {
      if (ringArea(h) >= -AREA_EPS) return false;                      // flipped or collapsed hole
      if (!ringInsideRing(h, rg.outer, outerBox)) return false;        // hole escaped its outer
    }
    allRings.push(rg.outer, ...rg.holes);
  }
  for (const r of allRings) if (ringSelfIntersects(r)) return false;
  const boxes = allRings.map(ringBox);
  for (let i = 0; i < allRings.length; i++) for (let j = i + 1; j < allRings.length; j++)
    if (ringsCross(allRings[i], allRings[j], boxes[i], boxes[j])) return false;
  return true;
}

// Part 2 of the partial-reflection fix (task 5B) — REMOVED (review round 2). A global
// distance-from-source prune existed here through two review rounds, narrowing its scope each
// time (round 1: per-hole rather than whole-region, to stop swallowing legitimate hole
// merges/breakthroughs; round 2: exact closed-form line/arc distance and an adaptively-
// flattened cubic distance instead of a chord-length-bounded tolerance, to stop losing curved
// holes to discretization noise). Round 2 confirmed the prune's own justification was sound —
// the wide-arm-L-pocket case it exists to fix is a genuine defect (max inscribed circle in a
// 5-wide-arm L has radius 2.5 < delta 3, so the hole DOES fully vanish; a truth value is
// derivable and the pre-fix engine got it wrong) — but even with exact-geometry distances, a
// sweep of real glyph counters (uppercase/lowercase/digit counters on 10mm text at delta
// 0.1–0.5mm) still lost 36 of 76 entirely, all silent total-hole-loss, none
// recoverable by further tolerance tuning: the wide-L-pocket's own raw hole ring is ALREADY
// `dirty` from Part 1 before any distance check runs, and so are the failing glyph counters —
// there is no scoping condition (dirty vs not, tolerance size, source curve type) that
// distinguishes "prune this, it's really gone" from "don't prune this, cleanup will recover
// it" using only the raw, pre-cleanup ring. The prune's collateral (silently deleting real
// text counters at sub-millimetre offsets) is strictly worse than the single defect it fixes,
// so it's gone rather than shipped delicately tuned. See task-5B-report.md's round-2 section
// for the full sweep. (The wide-L-pocket case itself is no longer an open gap: task 7's
// resolveOffsetWinding — see below — resolves it correctly with no per-ring heuristic at all,
// since a fully-eroded hole ring is simply negative-winding everywhere and drops out on its
// own; see test/contour-offset.test.js's "wide L-shaped hole (5-unit arms) at +3" test.)

// A positive round offset erodes each source hole by a Euclidean disk. The hole survives
// exactly when its source domain contains a disk of radius `delta`; asking that question
// before constructing the raw offset avoids the inverted pockets that fully-eroded curved
// counters can otherwise leave behind. This deliberately examines the SOURCE contour, not
// the self-tangled raw output — see the removed-prune history above.
//
// A SHARP offset erodes a hole at least as deeply — WHILE EVERY JOIN ON IT TAKES THE MITER.
// At the hole's convex corners the inset lines meet exactly as the disk's would, and at
// its reflex corners (spikes of material pointing into it) a miter reaches past the arc,
// so a hole with no room for the disk is gone under sharp corners too. It gets the same
// question. Without it the inverted ring survived: past twice a hole's half-width a
// square came back as a small diamond hole and a circle as a mirrored one, so a sharp
// closing (grow, shrink back) GREW a small hole — the laser gap check never flagged a
// hole below its floor — and an inverted cubic counter subdivided to MAX_DEPTH and cost
// the winding resolver seconds per hole.
// The argument fails at the miter limit. A spike of material under 60° would miter past
// MITER_LIMIT·delta, so joinSegs bevels it, and the bevel chord adds LESS than the arc:
// the hole keeps a real pocket beyond the chord that the disk would have filled — a
// 12-ray star hole (rays 5, spikes to 1.2) in a plate keeps 0.9–1.9 mm² at +1.3…+2, the
// Minkowski oracle agrees (test/offset-oracle-manifold.test.js), and the gate must not
// drop it. So a sharp hole is asked the disk question only when no join on it bevels
// (sharpHoleTakesMiters); one that does takes the ordinary path, as before the gate ran
// for sharp. Chamfer is left alone for the same reason everywhere: its bevel removes LESS
// than the arc at every reflex corner, so an empty disk test does not prove an empty inset.
const SOURCE_DISK_TOL = 5 * OFFSET_TOL;
const SOURCE_DISK_FLAT_TOL = OFFSET_TOL / 2;
const SOURCE_DISK_POINT_CAP = 16384;

// Whether a sharp offset of `contour` by `delta` joins every gap-side corner with its miter
// — the condition under which the disk gate above is sound for sharp. Mirrors
// _offsetContour's own join decision (zero-length segments dropped, smooth joints skipped,
// the gap side by the sign of the turn) and joinSegs' through sharpMiter, from the source
// geometry alone: an offset piece starts and ends exactly one delta along its endpoint
// normal. The limit is held a hair tighter so a spike sitting exactly on it reads as a
// bevel and keeps the hole on the ordinary path — never the other way round.
const MITER_GATE_LIMIT = MITER_LIMIT * (1 - 1e-9);
function sharpHoleTakesMiters(contour, delta) {
  const froms = [];
  { let p = contour.start; for (const s of contour.segments) { froms.push(p); p = s.to; } }
  const keep = contour.segments.map((s, i) => s.c1 || s.via || dist(froms[i], s.to) > 1e-9);
  const segs = contour.segments.filter((_, i) => keep[i]);
  if (!segs.length) return true;
  const start = froms.find((_, i) => keep[i]);
  for (const { point, inTan, outTan } of jointTangents({ start, segments: segs })) {
    const turn = cross(inTan, outTan);
    const turnDeg = (Math.atan2(Math.abs(turn), Math.max(-1, Math.min(1, dot(inTan, outTan)))) * 180) / Math.PI;
    if (turnDeg < SMOOTH_JOINT_DEG || !(turn * delta > 0 || turn === 0)) continue;   // smooth, or no join
    const aEnd = add(point, scl(rightOf(inTan), delta)), bStart = add(point, scl(rightOf(outTan), delta));
    if (dist(aEnd, bStart) <= JOIN_EPS) continue;
    if (!sharpMiter(point, aEnd, bStart, inTan, outTan, delta, MITER_GATE_LIMIT)) return false;
  }
  return true;
}

function pointSegmentDistance(p, a, b) {
  const ab = sub(b, a);
  const d2 = dot(ab, ab);
  if (d2 <= 1e-18) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / d2));
  return dist(p, add(a, scl(ab, t)));
}

// Flatten specifically for the disk proof with a distance-bound, rather than the display
// sampler's angle-bound. Arc sagitta and the cubic control hull both give conservative
// Hausdorff bounds. If a pathological curve exceeds the work cap, return null so its hole is
// kept — resource exhaustion must not turn into silent topology loss.
function sourceDiskRing(contour) {
  if (Array.isArray(contour)) return dedupeRing(contour);
  const ring = [[...contour.start]];
  let capped = false;
  const push = (p) => {
    if (ring.length >= SOURCE_DISK_POINT_CAP) { capped = true; return; }
    ring.push([p[0], p[1]]);
  };
  const cubic = (p0, c1, c2, p1, depth = 0) => {
    if (capped) return;
    const flatness = Math.max(pointSegmentDistance(c1, p0, p1), pointSegmentDistance(c2, p0, p1));
    if (flatness <= SOURCE_DISK_FLAT_TOL) { push(p1); return; }
    if (depth >= 18) { capped = true; return; }
    const [left, right] = splitCubic(p0, c1, c2, p1, 0.5);
    cubic(left.p0, left.c1, left.c2, left.p1, depth + 1);
    cubic(right.p0, right.c1, right.c2, right.p1, depth + 1);
  };

  let from = contour.start;
  for (const seg of contour.segments) {
    if (seg.c1) cubic(from, seg.c1, seg.c2, seg.to);
    else if (seg.via) {
      const arc = arcCenterAndSweep(from, seg.via, seg.to);
      if (!arc) push(seg.to);
      else {
        const maxStep = 2 * Math.acos(Math.max(-1, 1 - SOURCE_DISK_FLAT_TOL / arc.r));
        const steps = Math.max(2, Math.ceil(Math.abs(arc.dA) / maxStep));
        const a0 = Math.atan2(from[1] - arc.center[1], from[0] - arc.center[0]);
        if (!Number.isFinite(steps) || ring.length + steps > SOURCE_DISK_POINT_CAP) capped = true;
        else for (let i = 1; i <= steps; i++) {
          const a = a0 + arc.dA * (i / steps);
          push([arc.center[0] + arc.r * Math.cos(a), arc.center[1] + arc.r * Math.sin(a)]);
        }
      }
    } else push(seg.to);
    if (capped) return null;
    from = seg.to;
  }
  return dedupeRing(ring);
}

function signedRingDistance(p, ring) {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++)
    d = Math.min(d, pointSegmentDistance(p, ring[i], ring[(i + 1) % ring.length]));
  return pointInRing(p, ring) ? d : -d;
}

const diskCell = (x, y, hx, hy, ring) => {
  const d = signedRingDistance([x, y], ring);
  return { x, y, hx, hy, d, max: d + Math.hypot(hx, hy) };
};

function heapPush(heap, cell) {
  let i = heap.length;
  heap.push(cell);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].max >= cell.max) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = cell;
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (!heap.length) return top;
  let i = 0;
  while (true) {
    const left = i * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right].max > heap[left].max ? right : left;
    if (heap[child].max <= last.max) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = last;
  return top;
}

export function _sourceHoleContainsDisk(contour, radius, tolerance = SOURCE_DISK_TOL) {
  if (radius <= 0) return true;
  const ring = sourceDiskRing(closeContourGap(contour));
  if (!ring) return true;
  if (ring.length < 3) return false;
  const [x0, y0, x1, y1] = ringBox(ring);
  const width = x1 - x0, height = y1 - y0;
  if (width <= 0 || height <= 0) return false;

  // Keep a near-threshold hole rather than silently erase real material because of curve
  // tessellation or floating-point error. A false positive merely leaves cleanup its former
  // input; a false negative permanently deletes the counter.
  const threshold = Math.max(0, radius - tolerance);
  if (Math.min(width, height) / 2 < threshold) return false;

  const heap = [];
  heapPush(heap, diskCell((x0 + x1) / 2, (y0 + y1) / 2, width / 2, height / 2, ring));
  while (heap.length) {
    const cell = heapPop(heap); // greatest remaining upper bound
    if (cell.d >= threshold) return true;
    if (cell.max < threshold) return false;
    if (Math.hypot(cell.hx, cell.hy) <= tolerance) return true;

    const hx = cell.hx / 2, hy = cell.hy / 2;
    for (const dx of [-hx, hx]) for (const dy of [-hy, hy])
      heapPush(heap, diskCell(cell.x + dx, cell.y + dy, hx, hy, ring));
  }
  return false;
}

// Raw per-ring offset of a whole region list, plus whether any surviving ring came back
// approximated. Split out of offsetRegions so the fallback ladder below can re-run it at a
// perturbed delta without recursing through the public entry point.
function rawOffset(regions, delta, corners) {
  // _offsetContour signals a whole-ring collapse with contour:null (see its comment) — a
  // dropped outer removes its whole region, a dropped hole is simply omitted. If everything
  // drops, raw ends up [] and offsetRegions' "no regions survive" throw fires naturally.
  let dirty = false;
  const raw = [];
  for (const rg of regions) {
    const o = _offsetContour(closeContourGap(rg.outer), delta, corners);
    dirty = dirty || o.dirty;
    if (!o.contour) continue;
    const hs = rg.holes.map((h) => {
      const hole = closeContourGap(h);
      const diskGate = delta > 0 && (corners === "round" || (corners === "sharp" && sharpHoleTakesMiters(hole, delta)));
      if (diskGate && !_sourceHoleContainsDisk(hole, delta)) return { contour: null, dirty: false };
      return _offsetContour(hole, delta, corners);
    });
    // Only a SURVIVING hole's dirtiness can dirty the result. A hole that collapsed
    // (contour === null) always reports dirty — that is how _offsetContour signals the drop —
    // but the drop itself is a clean operation: the hole is simply gone and nothing else about
    // the region moved. Folding that signal into `dirty` would send an otherwise-exact outer
    // through resolveOffsetWinding for no reason — unnecessary crossing search over a ring that
    // was already exact — for a hole that isn't even in the output.
    dirty = dirty || hs.some((h) => h.contour && h.dirty);
    raw.push({ outer: o.contour, holes: hs.filter((h) => h.contour).map((h) => h.contour) });
  }
  return { raw, dirty };
}

const resolveOrRaw = ({ raw, dirty }) =>
  (!dirty && validateRawOffset(raw)) ? raw : resolveOffsetWinding(raw);

// Three underscore hooks, none of them part of the public surface, all three existing for
// ONE reason: `scripts/offset-rates.mjs` is the committed instrument behind every offset rate
// quoted in docs/ERROR-PATTERNS.md and docs/KERNEL-CONTRACT.md, and it has to measure the
// SHIPPED ladder rather than a copy of it. Those rates previously came from scratch scripts
// that were never committed, and several of them turned out to be wrong.
//   _rawOffset          — the raw per-ring offset, the ladder's input.
//   _offsetNoFallback   — the offset as it behaved BEFORE the ladder existed (the "before"
//                         column of the rate table).
//   _ladderRungs        — the ladder itself, as named lazy thunks.
export const _rawOffset = rawOffset;
export const _offsetNoFallback = (regions, delta, corners) =>
  resolveOrRaw(rawOffset(regions, delta, corners));

// A ring rebuilt as straight chords at `segs` facets per full turn — arcs and cubics
// replaced by their own tessellation, lines unchanged (tessellateContour emits a line's
// endpoints and nothing between). Used only by the fallback ladder's last rungs.
const flattenRing = (contour, segs) => {
  const pts = tessellateContour(contour, segs);
  // closeContourGap, not a bare rebuild: resolveOffsetWinding requires every ring to carry a
  // real closing segment back to `start` (_splitRings throws on an implicitly-closed one), and
  // whether tessellateContour's last point lands exactly on the first is a property of the
  // input, not something to assume.
  return closeContourGap({ start: [pts[0][0], pts[0][1]],
                           segments: pts.slice(1).map((p) => ({ to: [p[0], p[1]] })) });
};

// The fallback ladder for a raw offset whose arrangement the winding resolver cannot close
// (contour-winding.js's CHAIN_INCOMPLETE_MESSAGE). Each rung re-runs the SAME offset with one
// numerical nuisance perturbed, and the first rung that produces a non-empty region set wins.
//
// Why a ladder exists at all: the chain failure is a defect in resolving a degenerate
// arrangement, not a statement about the shape — the material is really there. Left as a
// throw it reads, in a parametric app that re-offsets on every slider move, as "the part
// builds at 2.4 mm and dies at 2.5 mm", which is a harder failure than any other defect class
// in this engine (all of which degrade to bounded inaccuracy).
//
// RATES, and where they come from. `node scripts/offset-rates.mjs` sweeps the committed
// corpus (600 seeded shapes + 6 glyphs, 20 deltas, 3 styles = 36 090 offsets). After the
// adaptive pinch classifier and the fold-aware clearance fix in contour-winding's
// scanArrangement (which also resolved five of the seven former pre-ladder failures),
// failures before the ladder / after it are:
//   round 0 -> 0   chamfer 1 -> 0   sharp 1 -> 0
// Both rescues are oracle-checked: median area error 0.0727 %, worst 0.073 %, with zero
// region-count losses and zero complete arc losses. The ladder stays because those two raw
// arrangements remain numerically unclosable, not because the formerly parked comb/text
// failures still exist. Both are erosion (negative delta) or single-region cases;
// the per-region rung below is positive-delta-and-multi-region only, so it wins none of them
// and the rates above are unchanged by its addition — its own coverage class (whole-word text
// dilation, feedback 86970b00) sits outside this corpus, whose glyphs are single characters
// and whose "Scott" case never reaches the delta band where the merged word fails to close.
//
// Rung ORDER is by fidelity of what survives, not by hit rate:
//   1. delta perturbed by ±1e-9 relative. Escapes an exactly-degenerate arrangement (two
//      offset walls landing on the same coordinate) with the requested corner style and the
//      exact curve IR both intact.
//   2. a coarser crossing-merge radius (4x and 20x CLUSTER_TOL). Keeps corner style AND the
//      exact IR — a trimmed arc is still an arc — at the cost of collapsing crossings up to
//      that radius apart onto one vertex. This can merge a genuine severing pinch, so the
//      20x rung is not widened further even though the current seven rescues preserve the
//      oracle's region count.
//   3. per-region-union (delta > 0, more than one region only). Offsets each region alone and
//      unites the results through paper's curve-native boolean. EXACT, not approximate: a
//      positive dilation distributes over union, so this equals the whole-region offset the
//      resolver could not close — with arcs intact, above the polyline rungs. It is here rather
//      than at #1 only because it costs a boolean per region and re-runs the earlier rungs on
//      each; the two cheaper exact rungs get first refusal.
//   4. the raw outline re-run as polylines (64/256/1024 facets per turn). Geometrically
//      faithful to the chord error of that tessellation, but it DEGRADES THE IR: round joins
//      come back as chords, so A STEP EXPORT OF A POLYLINE-RUNG RESULT LOSES ITS TRUE CIRCLES.
//      No current corpus rescue loses every arc, but these rungs remain last because that
//      fidelity cost is structural.
// Coverage is not monotonic in any rung's parameter (64 facets resolves cases 256 does not) —
// these are escapes from degeneracy, not refinements, so every rung earns its place by cases
// no other rung covers.
//
// Two things this deliberately does NOT do. (The numbers in this paragraph are task 7D's
// design measurements, taken on a 59-case round-only sweep that predates the committed corpus
// and is NOT reproducible from this repo — they are recorded as the reasoning behind two
// rejected rungs, not as current rates. Everything above is from scripts/offset-rates.mjs.)
// It never retries under a different JOIN: swapping
// to chamfer resolves 58 of the 59, but at a median 5 % from the round truth (worst 4 800 %),
// and it would hand back geometry with visibly different corners than the caller asked for —
// silently wrong beats loudly failed only when the wrongness is bounded, and that one is not.
// And it never perturbs delta by more than 1e-9: the failures are NOT the knife-edge
// degeneracies they look like (the four-notch comb throws across a whole 0.02 mm band of delta,
// not at one value), so escaping by delta alone takes ~1e-2 relative, which resolves 100 % at a
// median 0.15 % and a worst 9 % error — well outside the band above. A bounded middle ground
// (±1e-4 and ±1e-3 mm absolute rungs) was measured too: it bought ONE extra case out of 62 and
// more than doubled the worst absolute error, 0.048 → 0.112 mm², so it is not here either.
//
// Offset each region on its own and unite the results through paper's planar boolean engine.
// This is EXACT for a positive delta, not an approximation: Minkowski dilation distributes
// over union, (⋃ Rᵢ) ⊕ B = ⋃ (Rᵢ ⊕ B), so the whole-region offset the winding resolver cannot
// close as one merged arrangement equals the union of the single-region offsets. Each single
// region is a far simpler arrangement — a lone glyph rather than a whole word's worth of offset
// walls meeting near-tangentially — and its own base offset still gets the earlier rungs'
// rescues, because the per-region call re-enters the public offsetRegions (which runs its own
// ladder for that one region). booleanRegions unites through paper's CURVE-native engine rather
// than a tessellation, so arcs stay arcs and a STEP export keeps its true circles — which is why
// this rung sits ABOVE the polyline rungs, whose chord approximation is the fidelity floor.
function perRegionUnion(regions, delta, corners) {
  let out = [];
  for (const rg of regions) {
    const one = offsetRegions([rg], delta, { corners });   // single region: never re-enters this rung
    out = out.length ? booleanRegions(out, one, "unite") : one;
  }
  return out;
}

// The ladder as named, LAZY rungs — one list, walked by chainFallback below and by
// scripts/offset-rates.mjs, so a measurement of "what each rung costs" can never drift from
// the ladder that actually ships. Every rung's whole body (including tessellating the outline
// for the polyline rungs) runs inside its own thunk. The expected chain-incomplete signal
// advances to the next rung; any other setup or resolver exception propagates as a bug report,
// matching offsetRegions' policy instead of being silently hidden by the fallback ladder.
export function _ladderRungs(regions, raw, delta, corners) {
  return [
    ...[-1, 1].map((sign) => ({ name: `delta*(1${sign < 0 ? "-" : "+"}1e-9)`,
      run: () => resolveOrRaw(rawOffset(regions, delta * (1 + sign * 1e-9), corners)) })),
    ...[4, 20].map((mult) => ({ name: `clusterTol*${mult}`,
      run: () => resolveOffsetWinding(raw, { clusterTol: CLUSTER_TOL * mult }) })),
    // Exact for positive dilation and arc-preserving, so it ranks above the polyline rungs but
    // below the two cheaper exact rungs that need no boolean. Only meaningful when there is more
    // than one region to decompose, and only distributive for a positive delta; the guard is
    // also what bounds the recursion — a single-region offsetRegions call never reaches here.
    ...(delta > 0 && regions.length > 1
      ? [{ name: "per-region-union", run: () => perRegionUnion(regions, delta, corners) }]
      : []),
    ...[64, 256, 1024].map((segs) => ({ name: `polyline@${segs}`,
      run: () => resolveOffsetWinding(raw.map((rg) => ({ outer: flattenRing(rg.outer, segs),
                                                         holes: rg.holes.map((h) => flattenRing(h, segs)) }))) })),
  ];
}

// Returns null when every rung fails, which is the caller's signal to rethrow the original.
function chainFallback(regions, raw, delta, corners) {
  for (const rung of _ladderRungs(regions, raw, delta, corners)) {
    let out;
    try {
      out = rung.run();
    } catch (err) {
      // A rung may fail with the SAME unresolvable-arrangement signal the ladder exists
      // for — move to the next rung. Anything else (the _splitRings clustering tripwire,
      // a TypeError) is a bug report, exactly as offsetRegions' own policy says below;
      // swallowing it here would defeat those tripwires' stated fail-at-the-source purpose
      // (review finding).
      if (err?.message === CHAIN_INCOMPLETE_MESSAGE) continue;
      throw err;
    }
    if (out.length > 0) return out;
  }
  return null;
}

// Dilation is extensive: S ⊆ S+B. A resolver artifact that contains no point from any
// source outer therefore cannot be a real output component. Unlike an area cutoff this keeps
// arbitrarily small source components, and it is valid for every positive join style. Source
// boundary samples lie strictly inside their dilation once delta clears the numerical band.
function sourceBackedPositiveRegions(source, out, delta) {
  if (delta <= SOURCE_DISK_TOL) return out;
  const witnesses = source.flatMap((rg) => sampleRing(closeContourGap(rg.outer), VALIDATE_SEGS));
  const entries = out.map((rg) => {
    const outer = sampleRing(rg.outer, VALIDATE_SEGS);
    const box = ringBox(outer);
    const holeRings = rg.holes.map((h) => sampleRing(h, VALIDATE_SEGS));
    const backed = witnesses.some((p) => p[0] >= box[0] && p[0] <= box[2]
      && p[1] >= box[1] && p[1] <= box[3] && pointInRing(p, outer)
      && !holeRings.some((h) => pointInRing(p, h)));
    return { rg, outer, box, backed };
  });
  const kept = entries.filter((e) => e.backed);
  // If numerical sampling cannot witness even one component, preserve the resolver result.
  // The filter is allowed to remove proved source-less artifacts, never all caller geometry.
  if (!kept.length || kept.length === entries.length) return out;

  const result = kept.map((e) => ({ ...e.rg, holes: [...e.rg.holes] }));
  for (const entry of entries.filter((e) => !e.backed)) for (const hole of entry.rg.holes) {
    const p = hole.start;
    const homes = kept.map((e, i) => ({ e, i })).filter(({ e }) =>
      p[0] >= e.box[0] && p[0] <= e.box[2] && p[1] >= e.box[1] && p[1] <= e.box[3]
      && pointInRing(p, e.outer));
    homes.sort((a, b) => Math.abs(ringArea(a.e.outer)) - Math.abs(ringArea(b.e.outer)));
    if (homes.length) result[homes[0].i].holes.push(hole);
  }
  return result;
}

// Crossing clustering can snap both ends of a tiny curve run onto the same pool vertex.
// The run then survives as a closed loop attached at one point (or as a whole one-segment
// contour). It encloses only geometry inside the resolver's own splice uncertainty, but a
// downstream cap triangulator may bridge that loop across the face and expose the bridge
// as a bogus feature edge — and a surviving zero-chord loop also breaks the NEXT offset or
// boolean over this output (its crossing chaining reads the loop as an unclosable
// arrangement: the "could not chain offset boundary" class of failure). Positive dilation
// may discard these sub-resolution counter loops: they are collapsed negative boundaries,
// never new material. Keep erosion unchanged; its tiny surviving islands have no
// equivalent source-domain proof.
//
// The radius is 10*CLUSTER_TOL, not the 2*CLUSTER_TOL cluster-diameter bound this pass
// shipped with: the CROSSINGS that got merged sit within one cluster, but the curve run
// BETWEEN them wanders further before returning — measured on offset(6, round) of
// "Scotty" size 24 (test/contour-cleanup.test.js), the surviving splice loops reached
// 0.028 mm of control extent, 5.6x the old radius, and every one of them slipped this
// pass. 10x (0.05 mm) covers them with margin while staying far below any printable
// feature; a genuine pinch-off lobe bigger than that survives as its own region ring and
// never presents as a single zero-chord segment in the first place.
function dropSubresolutionPositiveLoops(out, delta) {
  if (delta <= 0) return out;
  const radius = 10 * CLUSTER_TOL;
  const clean = (contour) => {
    const segments = [];
    let from = contour.start;
    for (const seg of contour.segments) {
      const controls = [seg.via, seg.c1, seg.c2].filter(Boolean);
      const clusteredLoop = dist(from, seg.to) <= 1e-12
        && controls.every((p) => dist(from, p) <= radius);
      if (!clusteredLoop) segments.push(seg);
      from = seg.to;
    }
    return segments.length ? { start: contour.start, segments } : null;
  };

  return out.flatMap((rg) => {
    const outer = clean(rg.outer);
    return outer ? [{ outer, holes: rg.holes.map(clean).filter(Boolean) }] : [];
  });
}

// Positive dilation may also discard whole SUB-SLIVER rings — the multi-segment
// sibling of the zero-chord splice loops above. The winding resolver can emit
// entire junk rings a few segments long (measured on "Scott" size 28, delta 5:
// 14 of 16 holes were resolver debris of 1e-8..1e-5 mm² beside two real ~6-8 mm²
// counters), and every one of them extrudes into a degenerate fin or sliver face
// that downstream mesh consumers trip over (the planar rim fillet's knife-edge
// refusals). The bar is the corpus oracle's own SLIVER convention (1e-3 mm² —
// test/offset-text.test.js, the fuzz suite): rings under it are "resolver
// artifacts, not features". The proof this cannot eat real geometry is
// dilation-only, in two halves: a genuine separate REGION of a dilation is at
// least the dilation disc (area ≥ π·δ²), and a genuine HOLE under that bar is a
// counter within a hair of closing — which the oracle already counts as closed.
// Erosion keeps everything, same as dropSubresolutionPositiveLoops: a tiny
// surviving island there is real geometry with no source-domain proof otherwise.
const RING_SLIVER = 1e-3;   // mm² — the corpus oracle's sub-sliver bar
function dropSubSliverRings(out, delta) {
  if (delta <= 0) return out;
  const tiny = (ring) => Math.abs(ringArea(tessellateContour(ring, VALIDATE_SEGS))) < RING_SLIVER;
  return out.flatMap((rg) => {
    if (tiny(rg.outer)) return [];
    const holes = rg.holes.filter((h) => !tiny(h));
    return [holes.length === rg.holes.length ? rg : { outer: rg.outer, holes }];
  });
}

// Region-in / region-out offset: the engine behind Shape2D.offset on BOTH backends.
// Fast path: raw per-ring offsets that validate cleanly are returned as-is (lines/arcs
// exact). Cleanup path: anything dirty or invalid goes through resolveOffsetWinding
// (contour-winding.js), which computes the positive-winding region of the raw offset
// outline directly — no boolean engine, no degenerate-shape recovery heuristics. When THAT
// cannot close its arrangement, chainFallback above retries it a few ways before the failure
// is allowed to reach the caller.
export function offsetRegions(regions, delta, { corners = "round" } = {}) {
  if (!["round", "chamfer", "sharp"].includes(corners))
    throw new Error('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
  if (!Number.isFinite(delta)) throw new Error("Shape2D.offset: delta must be a finite number");
  if (delta === 0) return JSON.parse(JSON.stringify(regions));

  const first = rawOffset(regions, delta, corners);
  let out;
  try {
    out = resolveOrRaw(first);
  } catch (err) {
    // Only the unclosable-arrangement failure has a measured degradation behind it. Anything
    // else out of the resolver (a clustering regression, an implicitly-closed ring) is a bug
    // report, not a case to paper over, and goes straight up.
    if (err?.message !== CHAIN_INCOMPLETE_MESSAGE) throw err;
    out = chainFallback(regions, first.raw, delta, corners);
    if (out === null) throw err;            // pinned message, unchanged, when nothing works
  }
  out = sourceBackedPositiveRegions(regions, out, delta);
  out = dropSubresolutionPositiveLoops(out, delta);
  out = dropSubSliverRings(out, delta);
  if (out.length === 0) throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  return out;
}
