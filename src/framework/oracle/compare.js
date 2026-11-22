// The reference compare view's two shared numbers (spec: partforge-cloud
// docs/superpowers/specs/2026-11-21-reference-compare-view-design.md). The kernel's
// _compareSolids splits a part and its reference into common / missing / excess;
// these say how thin a difference may be before it counts as a facet skin, and how
// big a comparison may get before it is refused rather than run.

// Combined triangle ceiling for one comparison (part + reference), checked before
// any boolean — the same ceiling the change tracker's mesh diff uses.
export const COMPARE_MAX_TRIANGLES = 300000;

const TOLERANCE_SHARE = 0.001; // 0.1% of the shared bounding-box diagonal
const TOLERANCE_MIN = 0.02;    // mm
const TOLERANCE_MAX = 0.25;    // mm

// The thickness below which a difference piece is a skin, not a feature: 0.1% of
// the diagonal of the box holding BOTH solids, clamped to 0.02-0.25 mm. Bounds are
// `{ min: [x,y,z], max: [x,y,z] }`.
export function compareTolerance(boundsA, boundsB) {
  const d = Math.hypot(...[0, 1, 2].map((i) =>
    Math.max(boundsA.max[i], boundsB.max[i]) - Math.min(boundsA.min[i], boundsB.min[i])));
  return Math.min(TOLERANCE_MAX, Math.max(TOLERANCE_MIN, d * TOLERANCE_SHARE));
}
