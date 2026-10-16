// src/framework/geometry/implicit/contact.js
// The `contact` node's field. This is the semantic definition the interval pass,
// the bytecode interpreter and the C++ core mirror op for op: keep the operation
// order exactly as written (jsmax/jsmin are Math.max/Math.min here, jsmath::jsmax/
// jsmin in C++).
import { unionN } from "./primitives.js";

// Tuned on the hand (docs/superpowers/specs/2026-10-15-implicit-contact-design.md, "Left to
// the builder", has each value's reason).
/**
 * Near-miss clearance, in grid cells (a gap of 0 still keeps this many cells apart): the
 * smallest that keeps the hand's 0.75 mm near miss bridge-free at 1.5 and 0.6 mm (1.25 bridged).
 */
export const C_MIN_CELLS = 1.5;
/** Default bulge (mm): the most the skin swells at a full press (the bump's peak; about 0.6 mm shows at a fingertip pad's rim). */
export const BULGE_DEFAULT = 1;
/** Packed attachment layout: [ia, ib, ax, ay, az, r0, band, k]; ia/ib index value slots. */
export const ATTACH_STRIDE = 8;
/**
 * Packed pad-fill region layout: [ia, ib, cx, cy, cz, rho] — one per contact region of a
 * gap-0 node; ia/ib index the pair's value slots, rho is the overlap cluster's radius.
 */
export const FILL_STRIDE = 6;
/**
 * The pad's crease blend (mm): the pair fuses as a smooth union of this width (unionN's k),
 * a crease about PAD_BLEND/4 deep rounded — a hard one samples jagged on the grid.
 */
export const PAD_BLEND = 1.5;
/** The gate's band (mm): g = 1 within rho + cl + FILL_BAND of a region's centre, easing to 0 over a further FILL_BAND. */
export const FILL_BAND = 2;

// Contact-region search (regions.js) and the bulge profile.
/** Leaf cell edge (mm) of the region search's octree (1 mm splits thin contacts and misses a 0.5 mm press). */
export const REGION_CELL = 0.75;
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
  const dx = x - F[o + 2], dy = y - F[o + 3], dz = z - F[o + 4];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let t = (d - (F[o + 5] + cl + FILL_BAND)) / FILL_BAND;
  t = Math.max(0, Math.min(1, t));
  return 1 - t * t * (3 - 2 * t);
}

const pair = new Float64Array(2);

/**
 * Slot i's cut piece: v_i maxed, in slot order, with its cut against every other slot j
 * except `skip` — `cut = (v_i − v_j + cl)·0.5`, eased toward v_i by the pair's first
 * attachment's weight (either order) when that is above 0. `w`: the attachment weights.
 */
function cutPiece(v, nK, i, skip, cl, att, nA, w) {
  let ci = v[i];
  for (let j = 0; j < nK; j++) {
    if (j === i || j === skip) continue;
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
 * The contact field at p from the children's values `v` (slot order; already bulged).
 * `F`/`nF` are the node's pad-fill regions (FILL_STRIDE each; used only when `fuse`). `w` (≥ nA) and `c` (≥ nK)
 * are scratch the caller may supply so a hot loop does not allocate; they are fully
 * overwritten before being read.
 */
export function contactValue(v, nK, cl, fuse, att, nA, F, nF, x, y, z, w = nA > 0 ? new Float64Array(nA) : null, c = new Float64Array(nK)) {
  // Attachment weights depend on the point only: compute once, slot order.
  for (let a = 0; a < nA; a++) w[a] = attachWeight(att, a * ATTACH_STRIDE, x, y, z);
  let value = Infinity;
  for (let i = 0; i < nK; i++) {
    const ci = cutPiece(v, nK, i, -1, cl, att, nA, w);
    c[i] = ci;
    value = Math.min(value, ci);
  }
  if (fuse) {
    // The pad fill, one term per contact region r (pair a_r, b_r), in region order, where
    // its gate is open (g_r > 0): value = min(value, f + (1 − g_r)·(cl + PAD_BLEND/4)), f = U(c'_a, c'_b)
    // maxed with (min(v_a, v_b) − v_j + cl)/2 for every third slot j in slot order; c'_a is
    // a_r cut against every piece but b_r (and c'_b likewise), U the smooth union of width
    // PAD_BLEND. Near its region (g_r = 1) the term is the pair's union, each still
    // held clear of third pieces: the pair fuses with a soft crease at the rim (a hard one
    // samples jagged on the grid) instead of each stopping cl/2 short
    // of the bisector (the pair's overlap alone, the earlier form, left a moat cl/2 deep
    // around a pad shallower than cl, and a floating lens in it), and a neighbour beside
    // the pad keeps its gap (the raw v_a would bring a's surface back against it). Easing
    // out, it rises toward cl + PAD_BLEND/4 above that union (the blend's dip plus the
    // clearance: by the gate's edge the clearance cut is below it at any grid edge, so the
    // term vanishes without a jump), where the clearance cut takes over; with
    // the gate shut it is no term at all (so a pruned slot's terms are exactly absent,
    // interval.js rule (d)). No regions: no fill.
    for (let k = 0; k < nF; k++) {
      const o = k * FILL_STRIDE;
      const g = gateWeight(F, o, cl, x, y, z);
      if (g > 0) {
        const ia = F[o], ib = F[o + 1];
        pair[0] = cutPiece(v, nK, ia, ib, cl, att, nA, w); pair[1] = cutPiece(v, nK, ib, ia, cl, att, nA, w);
        let f = unionN(pair, 2, PAD_BLEND);
        // The fused pair's own clearance from each third piece, so the blend's dip never
        // closes a third piece's gap: at their bisector this is cl/2, as the cut pieces are.
        const m = Math.min(v[ia], v[ib]);
        for (let j = 0; j < nK; j++) if (j !== ia && j !== ib) f = Math.max(f, (m - v[j] + cl) * 0.5);
        value = Math.min(value, f + (1 - g) * (cl + PAD_BLEND / 4));
      }
    }
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
  let t = (d - (F[o + 5] + cl + FILL_BAND)) / FILL_BAND;
  t = Math.max(0, Math.min(1, t));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Fill region o's gate bounds over the ball: [gl, gh, near] in `out` (near: the padded near
 * distance, for the prune test's firmness). gh = 0 means g_r is exactly 0 over the ball.
 */
export function gateWeightRange(out, F, o, cl, x, y, z, r) {
  const dx = x - F[o + 2], dy = y - F[o + 3], dz = z - F[o + 4];
  const dc = Math.sqrt(dx * dx + dy * dy + dz * dz), pad = PAD * (dc + r + F[o + 5] + cl + FILL_BAND);
  const near = dc - r - pad;
  out[0] = gateAt(F, o, cl, dc + r + pad);
  out[1] = gateAt(F, o, cl, Math.max(0, near));
  out[2] = near;
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
function cutPieceRange(out, lo, hi, keep, N, i, skip, cl, att, nA, wr) {
  let ilo = lo[i], ihi = hi[i];
  for (let j = 0; j < N; j++) {
    if (j === i || j === skip || !keep[j]) continue;
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
  out[0] = ilo; out[1] = ihi;
  return out;
}

/**
 * The contact node's interval over the ball from its children's intervals, over the KEPT
 * slots only (a pruned slot changes no value — interval.js) — contactValue's formula in
 * interval arithmetic: c_i ∈ [max(lo_i, cut_lo…), max(hi_i, cut_hi…)] with a pair's cut
 * widened to v_i's side when its attachment weight can be above 0; with fuse, a pad-fill term
 * per fill region with both sides kept and its gate open somewhere in the ball (gh > 0),
 * [min(c'lo_a, c'lo_b) − PAD_BLEND/4 + (1 − gh)·lift, f_hi + (1 − gl)·lift] (lift = cl + PAD_BLEND/4) over the pair's
 * cut pieces less each other, f_hi raised by the kept third slots' clearances (hi only when gl > 0: a shut gate is no term); each live attachment lowers lo by k·wh/4. `wr[a]` holds attachment a's
 * [wl, wh] (attachWeightRange), `gr[k]` fill region k's [gl, gh] (gateWeightRange; read only
 * when `fuse`). `lo`/`hi` are the bulged children's. Returns [lo, hi] in `out`.
 */
export function contactInterval(out, lo, hi, keep, N, cl, fuse, att, nA, wr, F, nF, gr) {
  let vlo = Infinity, vhi = Infinity;
  const clo = new Float64Array(N), cr = [0, 0], cr2 = [0, 0];
  for (let i = 0; i < N; i++) {
    if (!keep[i]) continue;
    cutPieceRange(cr, lo, hi, keep, N, i, -1, cl, att, nA, wr);
    clo[i] = cr[0];
    vlo = Math.min(vlo, cr[0]); vhi = Math.min(vhi, cr[1]);
  }
  if (fuse) {
    for (let k = 0; k < nF; k++) {
      const o = k * FILL_STRIDE, ia = F[o], ib = F[o + 1];
      if (!keep[ia] || !keep[ib]) continue;   // pruned side: the gate is shut over the ball (interval.js rule (d))
      if (!(gr[k][1] > 0)) continue;   // shut everywhere in the ball: no term
      cutPieceRange(cr, lo, hi, keep, N, ia, ib, cl, att, nA, wr);
      cutPieceRange(cr2, lo, hi, keep, N, ib, ia, cl, att, nA, wr);
      // unionN(·, 2, k) lies in [min − k/4, min]; the third-piece clearances only raise f
      // (a pruned j's never reaches the union: interval.js rule (b)'s PAD_BLEND/2).
      vlo = Math.min(vlo, Math.min(cr[0], cr2[0]) - PAD_BLEND / 4 + (1 - gr[k][1]) * (cl + PAD_BLEND / 4));
      // Shut somewhere in the ball, the term is absent there: it bounds hi only when open throughout.
      if (gr[k][0] > 0) {
        let fhi = Math.min(cr[1], cr2[1]);
        const mhi = Math.min(hi[ia], hi[ib]);
        for (let j = 0; j < N; j++) if (j !== ia && j !== ib && keep[j]) fhi = Math.max(fhi, (mhi - lo[j] + cl) * 0.5);
        vhi = Math.min(vhi, fhi + (1 - gr[k][0]) * (cl + PAD_BLEND / 4));
      }
    }
  }
  for (let a = 0; a < nA; a++) {
    const o = a * ATTACH_STRIDE, ia = att[o], ib = att[o + 1], wh = wr[a][1];
    if (!keep[ia] || !keep[ib] || !(att[o + 7] * wh > 0)) continue;
    vlo = Math.min(vlo, Math.min(clo[ia], clo[ib]) - (att[o + 7] * wh) / 4);
  }
  out[0] = vlo; out[1] = vhi;
  return out;
}
