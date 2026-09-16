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
// The one exception is `sphere`, which has its own rule at the bottom of this file.
//
// Pure, dependency-free: profile.js's samplers take a `(r) => n` function in place of
// a count, and this is what the backend hands them.

export const SEGS = { preview: 116, print: 480 };       // full-circle segments (flat / cap)
export const SAGITTA_TOL = { print: 0.01 };             // mm — max chord sagitta per tier

// THE formula, shared by every tolerance-sized circle in the mesh backend: the fewest
// full-circle segments that keep the chord sagitta r·(1 − cos(π/n)) under `tol`,
// clamped to [floor, cap]. acos(1 − tol/r) is the half-angle of a chord with sagitta
// tol; π over it is the full-circle count. r = Infinity gives acos(1) = 0 → Infinity →
// the cap. A degenerate radius (0, negative, NaN, undefined) or one no larger than the
// tolerance takes the floor and never throws. The callers differ only in POLICY — which
// tolerance, which clamps — and that is all they should ever add: `circleSegs` and
// `sphereSegs` below, mesh-fillet's blendSegs and mesh-roundall's roundAllSegs.
export function segsForSagitta(r, tol, floor, cap) {
  if (!(r > tol)) return floor;
  return Math.min(cap, Math.max(floor, Math.ceil(Math.PI / Math.acos(1 - tol / r))));
}

// Segments per full circle for a circle of radius `r` at `quality`. A tier with no
// tolerance (preview, or an unknown tier) is flat; print is sized by tolerance, floored
// at the preview count and capped at its own.
export function circleSegs(r, quality) {
  const cap = SEGS[quality] ?? SEGS.preview;
  const tol = SAGITTA_TOL[quality];
  if (tol === undefined) return cap;
  return segsForSagitta(r, tol, SEGS.preview, cap);
}

// Spheres are the one primitive whose triangle count is QUADRATIC in the segment
// count — Manifold.sphere(r, n) subdivides an octahedron n/4 times per edge, 8·(n/4)²
// triangles — so the per-circle budget above, spent on a sphere, is spent squared:
// at the flat preview 116 every sphere is 6,728 triangles whatever its radius, and a
// 0.75 mm rivet sphere carries a chord error of 0.0003 mm, a hundredth of a screen
// pixel at any zoom. A part carrying ~250 such rivets (the steampunk-spider feedback,
// "not loading on phones") unioned 1.7 M triangles of rivets into a 100k body: 10 s
// and a 2.7 GB peak on a desktop, which iOS Safari's content process does not
// survive — with the rivets at 12 triangles each the same body was 4 s and 500 MB.
//
// So spheres are sized by chord tolerance on BOTH tiers, like print circles are:
//
// - preview holds SPHERE_SAGITTA_TOL.preview (0.02 mm — an absolute chord error is
//   what screen pixels measure, so one tolerance reads equally smooth at every radius
//   and every zoom; 0.02 mm is a fifth of a pixel at a typical 100 mm-part zoom),
//   floored at SPHERE_FLOOR segments (24 — ~15° facets, so a tiny ball never reads as
//   a polygon under close zoom, and 288 triangles instead of 6,728) and capped at the
//   old flat count (nothing gets FINER than before; a sphere of 60 mm radius and up
//   keeps exactly the density it always had).
// - print holds the print tier's 0.01 mm, floored at the preview count for the same
//   radius (never coarser than the preview the user approved — the same property the
//   circle rule keeps) and capped at 480.
//
// Circles in extrusions, revolves, cylinders and 2-D outlines stay on the flat preview
// count on purpose: their cost is linear in the count, and the mesh fillet's arc gate,
// the roundAll prism fast path and the shading policies are all tuned to that density
// — a spike that made EVERY preview circle tolerance-based (0.05 mm, floor 24) turned
// bore-rim fillets from revolve tools into planar sweeps and drew 26 feature lines
// across a roundAll band that had none. A sphere has no sharp edges of its own and roundAll
// sizes its own balls (roundAllSegs), so this rule touches nothing tuned to 116.
export const SPHERE_SAGITTA_TOL = { preview: 0.02, print: SAGITTA_TOL.print }; // mm
export const SPHERE_FLOOR = 24;                                                  // segments

// Segments for a sphere of radius `r` at `quality`: the fewest that keep the chord
// sagitta under the tier's sphere tolerance, clamped as described above. An unknown
// tier facets as preview; a degenerate radius takes the floor and never throws.
export function sphereSegs(r, quality) {
  const tier = Object.hasOwn(SPHERE_SAGITTA_TOL, quality ?? "") ? quality : "preview";
  const floor = tier === "preview" ? SPHERE_FLOOR : sphereSegs(r, "preview");
  return segsForSagitta(r, SPHERE_SAGITTA_TOL[tier], floor, SEGS[tier]);
}
