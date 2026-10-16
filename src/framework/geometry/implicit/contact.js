// src/framework/geometry/implicit/contact.js
// The `contact` node's field. This is the semantic definition the interval pass,
// the bytecode interpreter and the C++ core mirror op for op: keep the operation
// order exactly as written (jsmax/jsmin are Math.max/Math.min here, jsmath::jsmax/
// jsmin in C++).
import { unionN } from "./primitives.js";

/** Near-miss clearance, in grid cells (a gap of 0 still keeps this many cells apart). */
export const C_MIN_CELLS = 2;
/** Default bulge distance (mm) at a contact patch. */
export const BULGE_DEFAULT = 0.6;
/** Packed attachment layout: [ia, ib, ax, ay, az, r0, band, k]; ia/ib index value slots. */
export const ATTACH_STRIDE = 8;

/** The clearance a pair is cut with: the declared gap, floored at C_MIN_CELLS grid cells. */
export const clearance = (gap, edge) => Math.max(gap, C_MIN_CELLS * edge);

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
 * The contact field at p from the children's values `v` (slot order). `w` (≥ nA) and `c`
 * (≥ nK) are scratch the caller may supply so a hot loop does not allocate; they are fully
 * overwritten before being read.
 */
export function contactValue(v, nK, cl, fuse, att, nA, x, y, z, w = nA > 0 ? new Float64Array(nA) : null, c = new Float64Array(nK)) {
  // Attachment weights depend on the point only: compute once, slot order.
  for (let a = 0; a < nA; a++) w[a] = attachWeight(att, a * ATTACH_STRIDE, x, y, z);
  let value = Infinity;
  for (let i = 0; i < nK; i++) {
    let ci = v[i];
    for (let j = 0; j < nK; j++) {
      if (j === i) continue;
      const cut = (v[i] - v[j] + cl) * 0.5;
      // The pair's weight: its first attachment's (either order), else 0.
      let wij = 0;
      for (let a = 0; a < nA; a++) {
        const o = a * ATTACH_STRIDE, ia = att[o], ib = att[o + 1];
        if ((ia === i && ib === j) || (ia === j && ib === i)) { wij = w[a]; break; }
      }
      const u = wij > 0 ? cut + wij * (v[i] - cut) : cut;
      ci = Math.max(ci, u);
    }
    c[i] = ci;
    value = Math.min(value, ci);
  }
  if (fuse) {
    // s2: second-smallest of v (a tie counts twice).
    let m1 = Infinity, m2 = Infinity;
    for (let i = 0; i < nK; i++) {
      const d = v[i];
      if (d < m1) { m2 = m1; m1 = d; } else if (d < m2) m2 = d;
    }
    value = Math.min(value, m2);
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

/**
 * The contact node's interval over the ball from its children's intervals, over the KEPT
 * slots only (a pruned slot changes no value — interval.js) — contactValue's formula in
 * interval arithmetic: c_i ∈ [max(lo_i, cut_lo…), max(hi_i, cut_hi…)] with a pair's cut
 * widened to v_i's side when its attachment weight can be above 0; the fuse term's order
 * statistic per end; each live attachment lowers lo by k·wh/4. `wr[a]` holds attachment
 * a's [wl, wh] (attachWeightRange). Returns [lo, hi] in `out`.
 */
export function contactInterval(out, lo, hi, keep, N, cl, fuse, att, nA, wr) {
  let vlo = Infinity, vhi = Infinity;
  const clo = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (!keep[i]) continue;
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
      if (!live) ilo = Math.max(ilo, cutLo);
      ihi = Math.max(ihi, live ? Math.max(cutHi, hi[i]) : cutHi);
    }
    clo[i] = ilo;
    vlo = Math.min(vlo, ilo); vhi = Math.min(vhi, ihi);
  }
  if (fuse) {
    let a1 = Infinity, a2 = Infinity, b1 = Infinity, b2 = Infinity;
    for (let i = 0; i < N; i++) {
      if (!keep[i]) continue;
      if (lo[i] < a1) { a2 = a1; a1 = lo[i]; } else if (lo[i] < a2) a2 = lo[i];
      if (hi[i] < b1) { b2 = b1; b1 = hi[i]; } else if (hi[i] < b2) b2 = hi[i];
    }
    vlo = Math.min(vlo, a2); vhi = Math.min(vhi, b2);
  }
  for (let a = 0; a < nA; a++) {
    const o = a * ATTACH_STRIDE, ia = att[o], ib = att[o + 1], wh = wr[a][1];
    if (!keep[ia] || !keep[ib] || !(att[o + 7] * wh > 0)) continue;
    vlo = Math.min(vlo, Math.min(clo[ia], clo[ib]) - (att[o + 7] * wh) / 4);
  }
  out[0] = vlo; out[1] = vhi;
  return out;
}
