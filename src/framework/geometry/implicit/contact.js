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

export function contactValue(v, nK, cl, fuse, att, nA, x, y, z) {
  // Attachment weights depend on the point only: compute once, slot order.
  const w = nA > 0 ? new Float64Array(nA) : null;
  for (let a = 0; a < nA; a++) w[a] = attachWeight(att, a * ATTACH_STRIDE, x, y, z);
  const weightOf = (i, j) => {
    for (let a = 0; a < nA; a++) {
      const o = a * ATTACH_STRIDE, ia = att[o], ib = att[o + 1];
      if ((ia === i && ib === j) || (ia === j && ib === i)) return w[a];
    }
    return 0;
  };
  const c = new Float64Array(nK);
  let value = Infinity;
  for (let i = 0; i < nK; i++) {
    let ci = v[i];
    for (let j = 0; j < nK; j++) {
      if (j === i) continue;
      const cut = (v[i] - v[j] + cl) * 0.5;
      const wij = weightOf(i, j);
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
