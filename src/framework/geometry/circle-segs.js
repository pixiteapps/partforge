// Per-circle segment counts for the mesh backend's two quality tiers.
//
// `preview` is a flat count: 116 segments per full circle whatever the radius. It is
// a VISUAL choice — the density every part is previewed, captured and thumbnailed
// at — and it already holds a 0.05 mm chord sagitta out to a 136 mm radius, so
// nothing is gained by scaling it.
//
// `print` used to be a flat 480, sized (whether anyone meant it or not) for a circle
// nearly a metre across: 480 segments meet a 0.01 mm sagitta at r ≈ 467 mm. Spent on
// a 0.75 mm rivet sphere that is 115,200 triangles for a chord error of 1.6e-5 mm —
// a thousandth of any printer's resolution — and a part carrying 176 such rivets
// (20 M triangles of rivets before a single boolean, against a preview whose whole
// unioned body was 530k) trapped the WASM kernel with "memory access out of bounds"
// on its first STL export, on a fresh 4 GB instance. So the print tier is now
// tolerance-based: the fewest segments that keep the chord sagitta r·(1 − cos(π/n))
// under SAGITTA_TOL.print — the same 0.01 mm the OCCT backend's print tessellation
// uses, and the same formula `roundAllSegs` (mesh-roundall.js) and `blendSegs`
// (mesh-fillet.js) already apply to their own circles. Those two keep their own
// tolerances and clamps on purpose (roundAll has a preview tolerance and a 12..64
// window; the fillet blends at 1 µm) — this table is not theirs to share, and
// `roundAllSegs(r, "preview")` against it would collapse to a flat 12. Two clamps
// make the rule here safe:
//
// - FLOOR at the preview count. An export must never be coarser than the preview the
//   user approved on screen, so below the radius where 116 segments already meet the
//   tolerance (r ≈ 27 mm) print and preview facet identically — which is also what
//   makes "if it previews, it exports" true for small features: the export costs what
//   the preview already paid.
// - CAP at the old flat count. A circle large enough to need more than 480 keeps
//   exactly the density it always had; nothing gets FINER than before.
//
// One rule, one place: every Manifold-backend site that facets a circle of known
// radius — sphere, cylinder, boredCylinder, roundedBox, revolve, and the arc and
// Bézier samplers behind prism/extrude/Shape2D — sizes through `circleSegs`. The
// helix tube's station/ring counts (TUBE in manifold-backend.js) and mesh-fillet's
// blend bands keep their own sizing; loft rings keep LOFT_SEGS.
//
// Pure, dependency-free: profile.js's samplers take a `(r) => n` function in place of
// a count, and this is what the backend hands them.

export const SEGS = { preview: 116, print: 480 };       // full-circle segments (flat / cap)
export const SAGITTA_TOL = { print: 0.01 };             // mm — max chord sagitta per tier

// Segments per full circle for a circle of radius `r` at `quality`. A tier with no
// tolerance (preview, or an unknown tier) is flat. A degenerate radius (0, negative,
// NaN, undefined) takes the floor: it facets like the preview and never throws.
export function circleSegs(r, quality) {
  const cap = SEGS[quality] ?? SEGS.preview;
  const tol = SAGITTA_TOL[quality];
  if (tol === undefined) return cap;
  const floor = SEGS.preview;
  if (!(r > tol)) return floor;
  // acos(1 − tol/r) is the half-angle of a chord with sagitta tol; π over it is the
  // full-circle count. r = Infinity gives acos(1) = 0 → Infinity → the cap.
  return Math.min(cap, Math.max(floor, Math.ceil(Math.PI / Math.acos(1 - tol / r))));
}
