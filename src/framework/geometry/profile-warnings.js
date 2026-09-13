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

// Contour segments (counted before curve sampling) above which validation is
// skipped, so an unusually dense authored profile can never make this the
// slowest step of a build. Authored geometry is expected to sit far below it.
export const PROFILE_VALIDATE_MAX_SEGMENTS = 4000;

const COACH =
  "the outline crosses itself, so the fill inverts there (a lobe becomes a hole, or vice versa). " +
  "A hand-sampled arc traversed the wrong way is the usual cause; build curved contours with " +
  "pathProfile().arcTo(to, via) or the partforge/geometry helpers, and check the outline with validateProfile().";

const segmentCount = (regions) =>
  regions.reduce((n, rg) => n + rg.outer.segments.length + rg.holes.reduce((m, h) => m + h.segments.length, 0), 0);

// One message per self-intersection issue, prefixed by the op and role that
// received the profile (`extrude: profile`, `loft: ring 2`, `shape2d: profile`).
export function profileWarningMessages(prefix, profile) {
  if (!profile || profile._shape2d) return [];
  let lifted;
  try { lifted = liftProfile(profile); } catch { return []; }
  if (segmentCount(lifted.regions) > PROFILE_VALIDATE_MAX_SEGMENTS) return [];
  let result;
  try { result = validateProfile(profile); } catch { return []; }
  return result.issues
    .filter((i) => i.type === "self-intersection" && Array.isArray(i.point))
    .map((i) => `${prefix} self-intersects near (${i.point[0].toFixed(4)}, ${i.point[1].toFixed(4)}) — ${COACH}`);
}

// A per-kernel warner: `warn` records each distinct message at most once until
// `reset` (the backend calls reset inside takeBuildWarnings, i.e. per drain).
export function makeProfileWarner(recordWarning) {
  const seen = new Set();
  return {
    reset: () => seen.clear(),
    warn(prefix, profile) {
      if (typeof recordWarning !== "function") return;
      for (const msg of profileWarningMessages(prefix, profile)) {
        if (seen.has(msg)) continue;
        seen.add(msg);
        recordWarning(msg);
      }
    },
  };
}
