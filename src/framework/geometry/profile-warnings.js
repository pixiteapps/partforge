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

// A per-kernel warner: `warn` records each distinct message at most once until
// `reset` (the backend calls reset inside takeBuildWarnings, i.e. per drain).
export function makeProfileWarner(recordWarning) {
  const seen = new Set();
  const warn = (prefix, profile) => {
    if (typeof recordWarning !== "function") return;
    for (const msg of profileWarningMessages(prefix, profile)) {
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
  return { reset: () => seen.clear(), warn };
}
