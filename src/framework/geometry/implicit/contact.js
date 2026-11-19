// src/framework/geometry/implicit/contact.js
// The `contact` node's field. This is the semantic definition the interval pass,
// the bytecode interpreter and the C++ core mirror op for op: keep the operation
// order exactly as written (jsmax/jsmin are Math.max/Math.min here, jsmath::jsmax/
// jsmin in C++).
import { unionN } from "./primitives.js";

// Tuned on the hand (docs/superpowers/specs/2026-10-15-implicit-contact-design.md, "Left to
// the builder", has each value's reason).
/** Default bulge (mm): the most the skin swells at a full press (the bump's peak; about 0.6 mm shows at a fingertip pad's rim). */
export const BULGE_DEFAULT = 1;
/** Packed attachment layout: [ia, ib, ax, ay, az, r0, band, k]; ia/ib index value slots. */
export const ATTACH_STRIDE = 8;

// Contact-region search (regions.js) and the bulge profile.
/** Leaf cell edge (mm) of the region search's octree (1 mm splits thin contacts and misses a 0.5 mm press). */
export const REGION_CELL = 0.75;
/** Press depth δ (mm) at which a region's bulge reaches the node's full `bulge`. */
export const BULGE_FULL_DEPTH = 1.5;
/** A region's bulge falloff radius grows by this many mm per mm of press depth. */
export const BULGE_SPREAD = 2;
/** Search entries (leaf cells visited, plus blocks wholly inside both) one pair's search may take before it gives up (no region for the pair, and a compile warning). */
export const MAX_REGION_CELLS = 20000;

// Seams. A contact node is the top of its spec (ir.js), its children owning the surface;
// its field reads the declared gap alone, never the grid edge.
/** At gap 0 the cut sits this far (mm) past the bisector, so the two pieces overlap by a hair and fuse into one shell with a crisp crease. */
export const CONTACT_OVERLAP = 0.02;
/** A crease split within this fraction of an edge from an end moves that end instead of adding a vertex (crease.js). */
export const CREASE_SNAP = 0.15;
/** A crossing is cut into the crease only when its field, its two shares' difference and their gap to the field are all within this (× edge) after Newton (crease.js); 0.02 left crease points further off the field than plain cleanup leaves any vertex. */
export const CREASE_TOL = 0.005;
/** Skin detail fades to nothing over this distance (mm) from another piece's cut, so it never roughens a crease or closes a gap (detail.js). */
export const DETAIL_SEAM_FADE = 1;
/** The clearance a pair is cut with: the declared gap itself; at gap 0 a small negative (the pieces overlap by CONTACT_OVERLAP). */
export const clearance = (gap) => (gap > 0 ? gap : -CONTACT_OVERLAP);
/** The most children a contact node (owner-labelled) may have. */
export const MAX_OWNER_K = 127;

/** Attachment weight at p: 1 inside the radius, easing to 0 across `band`. */
export function attachWeight(att, o, x, y, z) {
  const dx = x - att[o + 2], dy = y - att[o + 3], dz = z - att[o + 4];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let t = (d - att[o + 5]) / att[o + 6];
  t = Math.max(0, Math.min(1, t));
  return 1 - t * t * (3 - 2 * t);
}

const pair = new Float64Array(2);

/**
 * Slot i's cut piece: v_i maxed, in slot order, with its cut against every other slot j —
 * `cut = (v_i − v_j + cl)·0.5`, eased toward v_i by the pair's first
 * attachment's weight (either order) when that is above 0. `w`: the attachment weights.
 */
function cutPiece(v, nK, i, cl, att, nA, w) {
  let ci = v[i];
  for (let j = 0; j < nK; j++) {
    if (j === i) continue;
    // The pair's weight: its first attachment's (either order), else 0.
    let wij = 0;
    for (let a = 0; a < nA; a++) {
      const o = a * ATTACH_STRIDE, ia = att[o], ib = att[o + 1];
      if ((ia === i && ib === j) || (ia === j && ib === i)) { wij = w[a]; break; }
    }
    // A bare cut of two pieces more than cl apart lies below v_i ≤ c_i, margin over its
    // rounding: skipping it changes no bit (most pairs, most points).
    if (!(wij > 0) && v[i] + v[j] > cl + CUT_SKIP * (Math.abs(v[i]) + Math.abs(v[j]) + cl)) continue;
    const cut = (v[i] - v[j] + cl) * 0.5;
    const u = wij > 0 ? cut + wij * (v[i] - cut) : cut;
    ci = Math.max(ci, u);
  }
  return ci;
}
const CUT_SKIP = 1e-9;

/**
 * The contact field at p from the children's values `v` (slot order; already bulged): the
 * least cut piece, then each attachment's smooth union of its pair's cut pieces, in
 * attachment order. `w` (≥ nA) and `c` (≥ nK) are scratch the caller may supply so a hot loop
 * does not allocate; they are fully overwritten before being read.
 */
export function contactValue(v, nK, cl, att, nA, x, y, z, w = nA > 0 ? new Float64Array(nA) : null, c = new Float64Array(nK)) {
  // Attachment weights depend on the point only: compute once, slot order.
  for (let a = 0; a < nA; a++) w[a] = attachWeight(att, a * ATTACH_STRIDE, x, y, z);
  let value = Infinity;
  for (let i = 0; i < nK; i++) {
    const ci = cutPiece(v, nK, i, cl, att, nA, w);
    c[i] = ci;
    value = Math.min(value, ci);
  }
  for (let a = 0; a < nA; a++) {
    const o = a * ATTACH_STRIDE;
    const kk = att[o + 7] * w[a];
    if (kk > 0) {
      pair[0] = c[att[o]]; pair[1] = c[att[o + 1]];
      value = Math.min(value, unionN(pair, 2, kk));
    }
  }
  return value;
}

/** Packed bulge region layout: [cx, cy, cz, A, rho]. */
export const BULGE_STRIDE = 5;

/** The bulge offset at p: Σ over regions, in order, of A·φ(|p − c| / rho), φ(t) = (1 − t²)² for t < 1, else 0. */
export function bulgeOffset(R, o, nR, x, y, z) {
  let s = 0;
  for (let k = 0; k < nR; k++, o += BULGE_STRIDE) {
    const dx = x - R[o], dy = y - R[o + 1], dz = z - R[o + 2];
    const t = Math.sqrt(dx * dx + dy * dy + dz * dz) / R[o + 4];
    s += t < 1 ? R[o + 3] * ((1 - t * t) * (1 - t * t)) : 0;
  }
  return s;
}

// The ball's distance range [near, far] to a centre at distance dc, each end padded by
// 1e-12 relative (`scale`: the other magnitudes in play) so a point's computed distance
// lies inside it as evaluated, not just in real arithmetic.
const PAD = 1e-12;

/**
 * The bulge offset's bounds over the ball (x, y, z; r): [offLo, offHi] in `out`. Each
 * term A·φ(t) is non-increasing in the distance, so a region's term lies between its
 * values at the far and near distances; summed in the same order as bulgeOffset, so the
 * bounds hold as evaluated (float rounding is monotone).
 */
export function bulgeRange(out, R, o, nR, x, y, z, r) {
  let lo = 0, hi = 0;
  for (let k = 0; k < nR; k++, o += BULGE_STRIDE) {
    const dx = x - R[o], dy = y - R[o + 1], dz = z - R[o + 2];
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz), pad = PAD * (dc + r + R[o + 4]);
    const tn = Math.max(0, dc - r - pad) / R[o + 4], tf = (dc + r + pad) / R[o + 4];
    hi += tn < 1 ? R[o + 3] * ((1 - tn * tn) * (1 - tn * tn)) : 0;
    lo += tf < 1 ? R[o + 3] * ((1 - tf * tf) * (1 - tf * tf)) : 0;
  }
  out[0] = lo; out[1] = hi;
  return out;
}

// The attachment weight at a distance d from its anchor (attachWeight's easing).
function weightAt(att, o, d) {
  let t = (d - att[o + 5]) / att[o + 6];
  t = Math.max(0, Math.min(1, t));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * The attachment's weight bounds over the ball (x, y, z; r) in the node's frame: [wl, wh].
 * The near distance carries the union's 1e-12 margin, so wh = 0 means the weight is
 * exactly 0 at every point of the ball as evaluated. Writes into `out`.
 */
export function attachWeightRange(out, att, o, x, y, z, r) {
  const dx = x - att[o + 2], dy = y - att[o + 3], dz = z - att[o + 4];
  const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const near = dc - r - 1e-12 * (dc + r + att[o + 5] + att[o + 6]);
  out[0] = weightAt(att, o, dc + r);
  out[1] = weightAt(att, o, Math.max(0, near));
  out[2] = near;   // for the prune test's firmness
  return out;
}

/** cutPiece's bounds over the ball from the kept slots' [lo, hi] (pruned slots change no cut): [lo, hi] in `out`. */
function cutPieceRange(out, lo, hi, keep, N, i, cl, att, nA, wr) {
  let ilo = lo[i], ihi = hi[i];
  for (let j = 0; j < N; j++) {
    if (j === i || !keep[j]) continue;
    let live = false;
    for (let a = 0; a < nA; a++) {
      const o = a * ATTACH_STRIDE, ia = att[o], ib = att[o + 1];
      if ((ia === i && ib === j) || (ia === j && ib === i)) { live = wr[a][1] > 0; break; }
    }
    const cutLo = (lo[i] - hi[j] + cl) * 0.5, cutHi = (hi[i] - lo[j] + cl) * 0.5;
    // u = cut + w·(v_i − cut) lies between cut and v_i: below v_i adds nothing to c_i's lo.
    // As evaluated the lerp can round a few ulps past both ends, so its hi carries a 1e-12
    // pad (PAD) relative to the operands' magnitudes, to stay a strict bound.
    if (!live) ilo = Math.max(ilo, cutLo);
    if (live) {
      const uHi = Math.max(cutHi, hi[i]);
      ihi = Math.max(ihi, uHi + PAD * (Math.abs(cutLo) + Math.abs(cutHi) + Math.abs(lo[i]) + Math.abs(hi[i])));
    } else ihi = Math.max(ihi, cutHi);
  }
  out[0] = ilo; out[1] = ihi;
  return out;
}

/**
 * The contact node's interval over the ball from its children's intervals, over the KEPT
 * slots only (a pruned slot changes no value — interval.js) — contactValue's formula in
 * interval arithmetic: c_i ∈ [max(lo_i, cut_lo…), max(hi_i, cut_hi…)] with a pair's cut
 * widened to v_i's side when its attachment weight can be above 0; each live attachment
 * lowers lo by k·wh/4. `wr[a]` holds attachment a's [wl, wh] (attachWeightRange). `lo`/`hi`
 * are the bulged children's. Returns [lo, hi] in `out`.
 */
export function contactInterval(out, lo, hi, keep, N, cl, att, nA, wr) {
  let vlo = Infinity, vhi = Infinity;
  const clo = new Float64Array(N), cr = [0, 0];
  for (let i = 0; i < N; i++) {
    if (!keep[i]) continue;
    cutPieceRange(cr, lo, hi, keep, N, i, cl, att, nA, wr);
    clo[i] = cr[0];
    vlo = Math.min(vlo, cr[0]); vhi = Math.min(vhi, cr[1]);
  }
  for (let a = 0; a < nA; a++) {
    const o = a * ATTACH_STRIDE, ia = att[o], ib = att[o + 1], wh = wr[a][1];
    if (!keep[ia] || !keep[ib] || !(att[o + 7] * wh > 0)) continue;
    vlo = Math.min(vlo, Math.min(clo[ia], clo[ib]) - (att[o + 7] * wh) / 4);
  }
  out[0] = vlo; out[1] = vhi;
  return out;
}
