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
/** Packed fill-gate region layout: [cx, cy, cz, rho] (rho: the overlap cluster's radius). */
export const FILL_STRIDE = 4;
/** The gate's band (mm): g = 1 within rho + cl + FILL_BAND of a region's centre, easing to 0 over a further FILL_BAND. */
export const FILL_BAND = 2;

// Contact-region search (regions.js) and the bulge profile. Task 5 tunes these.
/** Leaf cell edge (mm) of the region search's octree. */
export const REGION_CELL = 0.5;
/** Press depth δ (mm) at which a region's bulge reaches the node's full `bulge`. */
export const BULGE_FULL_DEPTH = 1.5;
/** A region's bulge falloff radius grows by this many mm per mm of press depth. */
export const BULGE_SPREAD = 2;
/** Leaf cells one pair's search may visit before it gives up (no regions, a compile warning). */
export const MAX_REGION_CELLS = 20000;

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

/**
 * The pad fill's gate weight of fill region `o` (FILL_STRIDE layout) at p: 1 within
 * rho + cl + FILL_BAND of its centre, easing (smoothstep) to 0 across a further FILL_BAND.
 */
export function gateWeight(F, o, cl, x, y, z) {
  const dx = x - F[o], dy = y - F[o + 1], dz = z - F[o + 2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let t = (d - (F[o + 3] + cl + FILL_BAND)) / FILL_BAND;
  t = Math.max(0, Math.min(1, t));
  return 1 - t * t * (3 - 2 * t);
}

const pair = new Float64Array(2);

/**
 * The contact field at p from the children's values `v` (slot order; already bulged).
 * `F`/`nF` are the node's fill-gate regions (FILL_STRIDE each). `w` (≥ nA) and `c` (≥ nK)
 * are scratch the caller may supply so a hot loop does not allocate; they are fully
 * overwritten before being read.
 */
export function contactValue(v, nK, cl, fuse, att, nA, F, nF, x, y, z, w = nA > 0 ? new Float64Array(nA) : null, c = new Float64Array(nK)) {
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
    // The pad fill, gated by the contact regions: f = s2 + (1 − g)·cl, g the max gate
    // weight over the regions (0 with none) — so away from every real contact the fill
    // never undercuts the clearance cut.
    let g = 0;
    for (let k = 0; k < nF; k++) g = Math.max(g, gateWeight(F, k * FILL_STRIDE, cl, x, y, z));
    value = Math.min(value, m2 + (1 - g) * cl);
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

// The gate weight at a distance d from a fill region's centre (gateWeight's easing).
function gateAt(F, o, cl, d) {
  let t = (d - (F[o + 3] + cl + FILL_BAND)) / FILL_BAND;
  t = Math.max(0, Math.min(1, t));
  return 1 - t * t * (3 - 2 * t);
}

/** The gate g's bounds over the ball: [gl, gh] in `out` (max over the regions of each end; 0 with none). */
export function gateRange(out, F, nF, cl, x, y, z, r) {
  let gl = 0, gh = 0;
  for (let k = 0, o = 0; k < nF; k++, o += FILL_STRIDE) {
    const dx = x - F[o], dy = y - F[o + 1], dz = z - F[o + 2];
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz), pad = PAD * (dc + r + F[o + 3] + cl + FILL_BAND);
    gl = Math.max(gl, gateAt(F, o, cl, dc + r + pad));
    gh = Math.max(gh, gateAt(F, o, cl, Math.max(0, dc - r - pad)));
  }
  out[0] = gl; out[1] = gh;
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

/**
 * The contact node's interval over the ball from its children's intervals, over the KEPT
 * slots only (a pruned slot changes no value — interval.js) — contactValue's formula in
 * interval arithmetic: c_i ∈ [max(lo_i, cut_lo…), max(hi_i, cut_hi…)] with a pair's cut
 * widened to v_i's side when its attachment weight can be above 0; the fuse term's order
 * statistic per end plus (1 − g)·cl at g's other end; each live attachment lowers lo by
 * k·wh/4. `wr[a]` holds attachment a's [wl, wh] (attachWeightRange); [gl, gh] is the fill
 * gate's range (gateRange). `lo`/`hi` are the bulged children's. Returns [lo, hi] in `out`.
 */
export function contactInterval(out, lo, hi, keep, N, cl, fuse, att, nA, wr, gl = 0, gh = 0) {
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
    vlo = Math.min(vlo, a2 + (1 - gh) * cl); vhi = Math.min(vhi, b2 + (1 - gl) * cl);
  }
  for (let a = 0; a < nA; a++) {
    const o = a * ATTACH_STRIDE, ia = att[o], ib = att[o + 1], wh = wr[a][1];
    if (!keep[ia] || !keep[ib] || !(att[o + 7] * wh > 0)) continue;
    vlo = Math.min(vlo, Math.min(clo[ia], clo[ib]) - (att[o + 7] * wh) / 4);
  }
  out[0] = vlo; out[1] = vhi;
  return out;
}
