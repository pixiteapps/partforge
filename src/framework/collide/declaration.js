// The `collisions` block a part declares: how close counts as touching, which pairs may
// touch, and whether Pose mode keeps pieces solid. Pure data reading, imports pairs.js only.
import { CONTACT_EPS, pairKey } from "./pairs.js";

/** → { clearance, allow: Set<pairKey>, pose } or null when the part declares no block. */
export function normalizeCollisions(part) {
  const c = part?.collisions;
  if (c === undefined || c === null || typeof c !== "object" || Array.isArray(c)) return null;
  const allow = new Set();
  if (Array.isArray(c.allow)) {
    for (const entry of c.allow) {
      if (typeof entry !== "string") continue;
      const [a, b, ...rest] = entry.split("×");
      if (a && b && rest.length === 0) allow.add(pairKey(a, b));
    }
  }
  return {
    clearance: typeof c.clearance === "number" && Number.isFinite(c.clearance) ? c.clearance : CONTACT_EPS,
    allow,
    // a boolean, default true; anything else reads as the default (lint: collisions-bad-pose)
    pose: typeof c.pose === "boolean" ? c.pose : true,
  };
}

/** True when the declaration lets sub-parts `a` and `b` touch. */
export const isAllowed = (decl, a, b) => !!decl && decl.allow.has(pairKey(a, b));
