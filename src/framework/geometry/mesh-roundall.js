// Morphological whole-solid rounding on the mesh backend: close-then-open with
// a ball — dilate(+r), erode(2r), dilate(+r) via Manifold's native Minkowski
// sum/difference. Rounds EVERY edge (convex and concave) at radius ≈ r and
// consumes features smaller than the ball (walls < 2r melt, holes < 2r seal) —
// that is the op's contract, not a defect (docs/roundall-design.md).
//
// simplify() between steps is mandatory, not an optimization: the naive
// Minkowski (hull-of-triangle-pairs) emits sliver-degenerate meshes whose
// complexity compounds through the chain — the design spike measured 106s and
// 761k broken-topology triangles without it vs 2.4s and 340 clean triangles
// with it, on the same torture case. asOriginal() first, because simplify()
// will not collapse triangles across run (originalID) boundaries and the
// Minkowski output is stitched from many.
//
// This op must NEVER throw KernelCapabilityError / NEEDS_OCCT: the mesh
// backend is roundAll's reference implementation — rerouting to OCCT would
// trade a correct result for a skip (occt-roundall.js can only skip where
// morphology exceeds what B-rep offsets support).
//
// INVARIANT — both balls share ONE segment count. Minkowski support functions
// add, so the chain displaces a face with normal n by 2·h_r(n) − h_2r(n), where
// h is the ball's support. Manifold spheres built with equal `segs` are similar
// (the 2r ball is the r ball scaled by two), so h_2r = 2·h_r and the term is
// exactly zero in EVERY direction — the input's planar faces return to their
// original planes. Give the two balls different segment counts and the term is
// only zero where a vertex happens to line up: axis-aligned boxes still look
// right while off-axis faces drift (measured 0.07mm at preview, r=2). The count
// is sized from the erosion ball (2r), the larger of the two, so the coarser of
// the two facetings still meets the tier's sagitta tolerance.

import { segsForSagitta } from "./circle-segs.js";

// Sphere tessellation from the facet sagitta r·(1 − cos(π/segs)): pick the
// fewest segments that keep it under the quality tier's tolerance — its own
// tolerance table and 12..64 window, on the shared formula.
const SAGITTA_TOL = { preview: 0.05, print: 0.01 }; // mm
export function roundAllSegs(r, quality) {
  return segsForSagitta(r, SAGITTA_TOL[quality] ?? SAGITTA_TOL.preview, 12, 64);
}

export function meshRoundAll(wasm, m, r, quality) {
  if (!Number.isFinite(r) || r <= 0) throw new Error("roundAll: r must be a finite number > 0 (r = 0 is handled as the identity by the caller)");
  const segs = roundAllSegs(2 * r, quality); // ONE count for BOTH balls — see the invariant above
  // Simplify tolerance: max(r/100, 0.01) mm, but never enough to collapse the
  // rim ring of a rounded edge into the next ring up. That ring sits
  // r·(1 − cos(2π/segs)) above the face plane, and it is what holds a planar
  // face at its exact position; collapsing it shaves the face inward (print
  // tier, r = 2: segs 45 puts the ring 0.0195 mm up, and a flat 0.02 tolerance
  // pulled every face of a box in by 0.034 mm). Half that spacing keeps margin.
  const tol = Math.min(Math.max(r / 100, 0.01), 0.5 * r * (1 - Math.cos((2 * Math.PI) / segs)));
  const step = (input, sphere, op) => {
    const raw = op === "sum" ? input.minkowskiSum(sphere) : input.minkowskiDifference(sphere);
    let orig;
    try {
      orig = raw.asOriginal();
    } finally {
      raw.delete?.();
    }
    try {
      return orig.simplify(tol);
    } finally {
      orig.delete?.();
    }
  };
  const sphR = wasm.Manifold.sphere(r, segs);
  const sph2R = wasm.Manifold.sphere(2 * r, segs);
  try {
    const a = step(m, sphR, "sum");          // dilate: rounds convex, seals holes < 2r
    let b;
    try {
      b = step(a, sph2R, "diff");        // erode 2r: melts walls < 2r
    } finally {
      a.delete?.();
    }
    try {
      return step(b, sphR, "sum");          // dilate back: final radius ≈ r everywhere
    } finally {
      b.delete?.();
    }
  } finally {
    sphR.delete?.();
    sph2R.delete?.();
  }
}

// ---------------------------------------------------------------------------
// Prism detection for the fast path (manifold-backend.js). The Minkowski chain
// above is seconds-per-thousand-triangles, but roundAll's expensive real-world
// inputs are almost always Z-prisms (text backings, plates, extruded outlines) —
// and on a prism the ball morphology decomposes exactly into the 2-D disk
// morphology of the cross-section plus rim fillets, all of which are fast. This
// function answers "is m a Z-prism, and what is its constant cross-section?"
//
// Detection is deliberately behavioral, not structural: three slices must have
// equal area AND vanishing symmetric difference (a sheared prism has equal-area
// TRANSLATED sections — the subtract catches it), and the solid's volume must
// equal section × height (a bulge parked between the slice planes would pass the
// slice checks alone). Any failure returns null and the caller keeps the
// reference morphology — the fast path may only ever substitute, never widen.
//
// On success the returned CrossSection is the CALLER's to delete.
export function prismSection(wasm, m, relTol = 1e-4) {
  const bb = m.boundingBox();
  const z0 = bb.min[2], h = bb.max[2] - z0;
  if (!(h > 0)) return null;
  const volume = m.volume();
  if (!(volume > 0)) return null;
  const slices = [0.25, 0.5, 0.75].map((t) => m.slice(z0 + t * h));
  try {
    const area = slices[1].area();
    if (!(area > 0)) return null;
    for (const s of slices) if (Math.abs(s.area() - area) > relTol * area) return null;
    for (const s of [slices[0], slices[2]]) {
      const d1 = slices[1].subtract(s), d2 = s.subtract(slices[1]);
      const diff = d1.area() + d2.area();
      d1.delete?.();
      d2.delete?.();
      if (diff > relTol * area) return null;
    }
    if (Math.abs(volume - area * h) > 10 * relTol * area * h) return null;
    const cs = slices[1];
    slices[1] = null; // ownership moves to the caller
    return { cs, z0, h };
  } finally {
    for (const s of slices) s?.delete?.();
  }
}
