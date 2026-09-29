// Profile-validity warnings: the pure half of the "your outline crosses itself"
// signal. A hand-authored 2-D profile (a point list, a pathProfile contour, a
// {outer, holes} region) that self-intersects builds WITHOUT error on both
// backends — Manifold fills even-odd, so the crossing quietly inverts the fill
// (a lobe becomes a hole). Nothing told the author. This module turns
// validateProfile's self-intersection issues into build-warning messages;
// the kernel front (KERNEL_OP_SPECS' `warn` slot) and the Shape2D factory's
// liftRegions call it, and each backend owns one warner so a message lands at
// most once per build (six placements of one bad socket profile = one line).
//
// Never throws, never blocks: a profile liftProfile rejects is left for the
// op's own error path, and a Shape2D is never re-validated (it was validated
// when it was lifted, and every boolean it went through resolves crossings).
import { liftProfile, validateProfile } from "./contour-ops.js";

// Contour segments above which validation is skipped, so an unusually dense
// authored profile can never make this the slowest step of a build. The count is
// of CONTOUR SEGMENTS as authored, BEFORE curve sampling: the validator expands
// each curved segment into VALIDATE_SEGS (8) sampled edges, so a curve-heavy
// profile at the ceiling costs roughly 8× the edges a polyline one does. The
// ceiling therefore bounds AUTHORED SIZE, not validator work exactly. Authored
// geometry is expected to sit far below it. `loft` applies it to the SUM over its
// rings (see op-options.js) — per ring it would not bound a many-ring loft at all.
export const PROFILE_VALIDATE_MAX_SEGMENTS = 4000;

// Messages emitted per profile. A profile that crosses itself once usually
// crosses itself many times (a 24-point {24/7} star reports 144), and the host's
// warning list is short and shared with every other degrade in the build — an
// unbounded profile would evict all of them. The last message carries the count
// of the crossings it stands in for.
export const PROFILE_WARN_MAX_PER_PROFILE = 3;

const COACH =
  "the outline crosses itself, so the fill inverts there (a lobe becomes a hole, or vice versa). " +
  "A hand-sampled arc traversed the wrong way is the usual cause; build curved contours with " +
  "pathProfile().arcTo(to, via) or the partforge/geometry helpers, and check the outline with validateProfile().";

const segmentCount = (regions) =>
  regions.reduce((n, rg) => n + rg.outer.segments.length + rg.holes.reduce((m, h) => m + h.segments.length, 0), 0);

// Authored contour segments in one profile, before curve sampling. 0 for a
// Shape2D (never re-validated) and for anything liftProfile rejects (the op's own
// error path) — both are profiles this module will not validate anyway, so they
// contribute nothing to a caller summing the ceiling across several profiles.
export function profileSegmentCount(profile) {
  if (!profile || profile._shape2d) return 0;
  try { return segmentCount(liftProfile(profile).regions); } catch { return 0; }
}

// One message per self-intersection issue, prefixed by the op and role that
// received the profile (`extrude: profile`, `loft: ring 2`, `shape2d: profile`).
export function profileWarningMessages(prefix, profile) {
  if (!profile || profile._shape2d) return [];
  let lifted;
  try { lifted = liftProfile(profile); } catch { return []; }
  if (segmentCount(lifted.regions) > PROFILE_VALIDATE_MAX_SEGMENTS) return [];
  let result;
  try { result = validateProfile(profile); } catch { return []; }
  // `crosses` marks a contact BETWEEN two contours of one region — an outer and
  // its own hole sharing an edge, the commonest of which is a hole flush with the
  // outer wall. validateProfile files those under self-intersection, but they
  // build exactly as drawn and inverted fill is not what happens, so they are not
  // this warning's subject. Only a contour crossing ITSELF is reported.
  const crossings = result.issues.filter(
    (i) => i.type === "self-intersection" && i.crosses === undefined && Array.isArray(i.point));
  const text = (i) => `${prefix} self-intersects near (${i.point[0].toFixed(4)}, ${i.point[1].toFixed(4)}) — ${COACH}`;
  const msgs = crossings.slice(0, PROFILE_WARN_MAX_PER_PROFILE).map(text);
  const more = crossings.length - PROFILE_WARN_MAX_PER_PROFILE;
  if (more > 0) msgs[msgs.length - 1] += ` (and ${more} more crossings on this profile)`;
  return msgs;
}

// ── Sampled arcs ─────────────────────────────────────────────────────────────
// A point list is built and exported exactly as written, so an arc sampled into it —
// by a round *Polygon helper or a hand-written Math.cos loop — keeps its facets in
// every export, where a path-contour arc is faceted by the kernel and refined for
// print. A 36° bayonet lug from ringSectorPolygon at r = 30 mm had four 9° facets,
// ~0.09 mm inside the true arc, on a fit with 0.25 mm of clearance (partforge-cloud
// feedback #144). Nothing said so. This finds such runs and reports the worst one.
//
// A run is a stretch of consecutive vertices that all turn the same small amount
// (≤ SAMPLED_ARC_MAX_STEP_DEG) between edges of one length — equal chords at equal turns
// lie on one circle, and the turn IS the angular step. Its two END facets may be shorter
// than the interior ones and still count: an offset or a boolean trims the first and last
// facet of a sampled arc but leaves its turns alone (a clearance-shrunk lug is the #144
// case exactly). A run is reported when it spans ≥ SAMPLED_ARC_MIN_EDGES facets and its
// chord sits more than SAMPLED_ARC_SAG_MM inside the true arc. The step bound keeps
// deliberate polygons out (a hexagon turns 60°, an octagon 45°); the sag bound keeps out
// arcs sampled finely enough, or small enough, that no print shows it (a 48-gon hole
// under ~23 mm radius, a dense loop). Two-facet arcs are not reported: one turn between
// two edges cannot be told from a deliberate bend.
export const SAMPLED_ARC_SAG_MM = 0.05;
export const SAMPLED_ARC_MAX_STEP_DEG = 20;
export const SAMPLED_ARC_MIN_EDGES = 3;
const REL_TOL = 1e-4;
// Absolute point noise tolerated in an authored or derived point list: coordinates
// rounded to 0.01 mm (toFixed(2)), or passed through a transform or an offset.
const NOISE_MM = 0.01;

const SAMPLED_ARC_COACH =
  "a point list is built and exported exactly as written, so a print shows those facets. " +
  "Build curves with the *Profile helpers (ringSectorProfile, slotProfile, pieProfile, " +
  "roundedRectProfile, roundedProfile) or pathProfile().arcTo(…) — the kernel facets those, finer at export.";

// The worst sampled-arc run in one closed point ring, or null.
// → { r, stepDeg, sag } for the run with the largest chord sagitta.
export function worstSampledArc(ring) {
  if (!Array.isArray(ring)) return null;
  let pts = ring;
  const [fx, fy] = pts[0] ?? [], [lx, ly] = pts[pts.length - 1] ?? [];
  if (pts.length > 1 && Math.hypot(lx - fx, ly - fy) < 1e-12) pts = pts.slice(0, -1);   // explicit closure
  const n = pts.length;
  if (n < SAMPLED_ARC_MIN_EDGES + 1 || n > PROFILE_VALIDATE_MAX_SEGMENTS) return null;
  // edge i runs p[i] → p[i+1]; junction i is the turn from edge i into edge i+1
  const len = [], dir = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
    len.push(Math.hypot(bx - ax, by - ay));
    dir.push(Math.atan2(by - ay, bx - ax));
  }
  const turn = dir.map((d, i) => {
    let t = dir[(i + 1) % n] - d;
    while (t <= -Math.PI) t += 2 * Math.PI;
    while (t > Math.PI) t -= 2 * Math.PI;
    return t;
  });
  const maxStep = (SAMPLED_ARC_MAX_STEP_DEG * Math.PI) / 180;
  const lenTol = (L) => Math.max(REL_TOL * L, 2 * NOISE_MM);
  const arcTurn = (i) => { const t = Math.abs(turn[i]); return t > 1e-9 && t <= maxStep + 1e-12; };
  // Junction i turns like junction i-1 across edge i (their shared edge): same direction,
  // same amount within the noise an edge of that length can put on a direction.
  const sameTurn = (i) => {
    const p = (i - 1 + n) % n;
    if (!arcTurn(p) || !arcTurn(i) || !(len[i] > 1e-12) || Math.sign(turn[i]) !== Math.sign(turn[p])) return false;
    return Math.abs(turn[i] - turn[p]) <= Math.max(REL_TOL * Math.abs(turn[p]), (4 * NOISE_MM) / len[i]);
  };
  let worst = null;
  // A run of k ≥ 2 junctions from `first`: interior edges first+1 … first+k-1, all of
  // length L; the end facets (edges first and first+k) count when no longer than L.
  const consider = (first, k, L, turnSum) => {
    if (k < 2) return;
    const endLen = [len[first], len[(first + k) % n]];
    const edges = (k - 1) + endLen.filter((e) => e <= L + lenTol(L)).length;
    if (edges < SAMPLED_ARC_MIN_EDGES) return;
    const step = Math.abs(turnSum / k);
    const r = L / (2 * Math.sin(step / 2));
    const sag = r * (1 - Math.cos(step / 2));
    if (sag > SAMPLED_ARC_SAG_MM && (!worst || sag > worst.sag))
      worst = { r, stepDeg: (step * 180) / Math.PI, sag };
  };
  // Start the walk at a turn break so no run is split across the wrap. A ring with no
  // break (a regular n-gon, a circleProfile) is one run all the way round.
  let start = -1;
  for (let i = 0; i < n; i++) if (!sameTurn(i)) { start = i; break; }
  if (start === -1) {
    const L = len[0];
    if (arcTurn(0) && len.every((e) => Math.abs(e - L) <= lenTol(L))) {
      const step = Math.abs(turn.reduce((a, t) => a + t, 0) / n);
      const r = L / (2 * Math.sin(step / 2)), sag = r * (1 - Math.cos(step / 2));
      if (sag > SAMPLED_ARC_SAG_MM) worst = { r, stepDeg: (step * 180) / Math.PI, sag };
    }
    return worst;
  }
  let first = start, k = 1, L = NaN, turnSum = turn[start];
  for (let s = 1; s <= n; s++) {
    const i = (start + s) % n;
    // junction i extends the run when it turns alike AND its incoming edge (edge i, an
    // interior edge of the run) matches the run's interior length
    if (s < n && sameTurn(i) && (k === 1 || Math.abs(len[i] - L) <= lenTol(L))) {
      if (k === 1) L = len[i];
      k++; turnSum += turn[i];
      continue;
    }
    consider(first, k, L, turnSum);
    // a length break still leaves junction i turning alike with i-1: it may start a new
    // run that shares that junction, so restart from i-1 when that is the case
    if (s < n && sameTurn(i) && k > 1) {
      first = (i - 1 + n) % n; k = 2; L = len[i]; turnSum = turn[first] + turn[i];
    } else {
      first = i; k = 1; L = NaN; turnSum = turn[i];
    }
  }
  return worst;
}

// One message per profile naming its worst sampled arc, or [] when none shows. Only
// point-list rings are examined: a path contour or a Shape2D carries its arcs
// symbolically, so the kernel already facets them per tier.
export function sampledArcMessages(prefix, profile) {
  if (!profile || profile._shape2d) return [];
  const rings = Array.isArray(profile)
    ? [profile]
    : profile.outer ? [profile.outer, ...(Array.isArray(profile.holes) ? profile.holes : [])] : [];
  let worst = null;
  for (const ring of rings) {
    if (!Array.isArray(ring) || !Array.isArray(ring[0])) continue;   // a contour ring: exact
    const w = worstSampledArc(ring);
    if (w && (!worst || w.sag > worst.sag)) worst = w;
  }
  if (!worst) return [];
  return [
    `${prefix} traces an arc in straight facets (radius ≈ ${worst.r.toFixed(1)} mm, ` +
    `${worst.stepDeg.toFixed(1)}° per facet, up to ${worst.sag.toFixed(2)} mm inside the true curve) — ` +
    SAMPLED_ARC_COACH,
  ];
}

// Sampled-arc lines per build. Each names a different radius, so dedupe alone does not
// bound them, and the warning list is shared with every other degrade in the build.
export const SAMPLED_ARC_MAX_PER_BUILD = 3;

// A per-kernel warner: `warn` records each distinct message at most once until
// `reset` (the backend calls reset inside takeBuildWarnings, i.e. per drain).
// `opts.sampledArcs` also reports a coarsely sampled arc — asked for only by the ops
// where a path contour would be refined instead (prism, extrude, revolve, shape2d); loft
// and sweep sample curve rings at their own fixed LOD, so the advice would not hold
// there. `opts.crossings: false` skips the self-intersection check (a caller that
// validates the same outline again downstream). `warn.quietArcs(fn)` runs a kernel
// composition that tessellates curves itself (a rim bevel, a screw sweep) without
// blaming its points on the author, who wrote curves.
export function makeProfileWarner(recordWarning) {
  const seen = new Set();
  let quiet = 0, arcLines = 0;
  const warn = (prefix, profile, opts) => {
    if (typeof recordWarning !== "function") return;
    const msgs = opts?.crossings === false ? [] : profileWarningMessages(prefix, profile);
    if (opts?.sampledArcs && quiet === 0 && arcLines < SAMPLED_ARC_MAX_PER_BUILD) {
      for (const msg of sampledArcMessages(prefix, profile)) {
        if (seen.has(msg) || arcLines >= SAMPLED_ARC_MAX_PER_BUILD) continue;
        arcLines++;
        msgs.push(msg);
      }
    }
    for (const msg of msgs) {
      if (seen.has(msg)) continue;
      seen.add(msg);
      recordWarning(msg);
    }
  };
  // The ceiling and the counter travel WITH the warner because op-options.js's
  // `loft` slot has to apply them to the SUM over the rings and that module must
  // stay geometry-free — it sits inside partforge/lint's import closure, which
  // may reach no geometry module at all (test/lint-purity.test.js), and this one
  // reaches paper.js through contour-ops.js.
  warn.segmentCount = profileSegmentCount;
  warn.maxSegments = PROFILE_VALIDATE_MAX_SEGMENTS;
  warn.quietArcs = (fn) => {
    quiet++;
    try { return fn(); } finally { quiet--; }
  };
  return { reset: () => { seen.clear(); arcLines = 0; }, warn };
}
