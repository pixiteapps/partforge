// Shading-intent policies — the single home for every edge/shading threshold.
// A policy says how one original surface (a Manifold originalID) wants its
// SAME-surface edges treated by creased-normals.js:
//   creaseAngle       deg — same-surface edges bending more than this shade hard
//   sameSurfaceLines  whether same-surface edges past creaseAngle also draw lines
// Cross-surface (boolean cut seam) behavior is not policy: seams always shade
// hard, and draw a line when bent more than COPLANAR_ANGLE.

export const SMOOTH = Object.freeze({ creaseAngle: 35, sameSurfaceLines: true });
export const FACETED = Object.freeze({ creaseAngle: 10, sameSurfaceLines: false });
// An organic (k.implicit) surface: one continuous skin whose grooves — creases,
// pores, texture relief — are surface detail, not edges. Shade smoothly through
// anything short of a near-fold and draw no same-surface lines; boolean seams
// against other surfaces (a nail, a mechanical base) keep the ordinary seam rule.
export const ORGANIC = Object.freeze({ creaseAngle: 80, sameSurfaceLines: false });
// A blend surface (fillet/chamfer band). `boundaryLines` widens the CROSS-surface
// rule for it: a seam between a blend and a NON-blend surface draws regardless of
// bend — the band's start/end are tangent (~0°) and would otherwise be invisible,
// leaving the fillet's extent unreadable in the overlay. A seam between TWO blend
// surfaces keeps the ordinary bend rule (exactly-one-side semantics), so the
// handover seams along one band — tool splits, corner arcs continuing a sweep —
// stay invisible while real mitre crossings still draw.
export const BLEND = Object.freeze({ creaseAngle: 35, sameSurfaceLines: true, boundaryLines: true });

// Loft sector policies: identical crease/line behavior to SMOOTH/FACETED, plus the
// `sector` marker label() uses to preserve a sectored loft's runs 1:1 when it
// re-stamps original IDs (a plain asOriginal would fold the sectors into one
// surface and erase every provenance crease and dividing line).
export const LOFT_SECTOR_SMOOTH = Object.freeze({ ...SMOOTH, sector: true });
export const LOFT_SECTOR_FACETED = Object.freeze({ ...FACETED, sector: true });

export const COPLANAR_ANGLE = 5;  // deg — cut seams bending less than this are coplanar: no line
export const TANGENT_ANGLE = 5;   // deg — B-rep edges whose faces agree within this are tangent: no line
export const MIN_EDGE = 0.01;     // mm — drop shorter segments (degenerate slivers, pole edges)
// mm — a feature-line's incident FACES must both be at least this wide (min height).
// Wider than MIN_EDGE deliberately: a boolean face-split near a tool crossing (a
// mitre corner, a pivot's angular overshoot) re-triangulates the split band quad
// against seam vertices that sit microns off its plane — long fan slivers 14-34µm
// wide whose normals tilt 40-56°, drawing a full-weight line down an otherwise
// perfect band (total surface relief under 15µm — sub-visible at any scale this
// kernel prints at). Real band facets at the sagitta-bounded density are ≥ ~70µm
// wide; boundary rings bypass the gate entirely.
export const MIN_FACE = 0.04;

// Loft rings with at least this many sides read as an approximation of a smooth
// surface (e.g. a 64-gon "circle"), not as 64 intentional facets.
export const SMOOTH_SIDES_MIN = 32;

export const cosDeg = (deg) => Math.cos((deg * Math.PI) / 180);

// Loft shading inference over RESOLVED rings (resolveLoftRings' result). An explicit
// `shading` hint wins; `ruled:false` must preview smooth (it exports smooth via OCCT);
// any curved ring segment (arc/cubic) is smooth-surface intent; otherwise low
// resolved side counts are intentional facets.
export function loftShadingPolicy(resolvedLoft, { shading, ruled } = {}) {
  if (shading === "smooth") return SMOOTH;
  if (shading === "faceted") return FACETED;
  if (shading != null) throw new Error('loft: shading must be "smooth" | "faceted"');
  if (ruled === false) return SMOOTH;
  if (resolvedLoft?.hasCurve) return SMOOTH;
  let maxSides = 0;
  for (const r of resolvedLoft?.resolved ?? []) if (r.pts2d.length > maxSides) maxSides = r.pts2d.length;
  return maxSides >= SMOOTH_SIDES_MIN ? SMOOTH : FACETED;
}
