// Scalar building blocks shared by the reference evaluator, the interval pass and
// the bytecode interpreter — one definition, so all three agree to the bit.
// Native-portable arithmetic only (see the plan's Global Constraints).
import { hypot3, pfSin, pfCos, pfAtan2 } from "../js-math.js";

export const PRIM = Object.freeze({ SPHERE: 1, ELLIPSOID: 2, CAPSULE: 3, ROUNDCONE: 4, BOX: 5, CYLINDER: 6, TORUS: 7, HALFSPACE: 8 });
export const BIG = 1e6;
// Lipschitz bound of a primitive's field. Every field here is ≤ 1-Lipschitz (the ellipsoid
// is the scaled-sphere form precisely so this holds). Task 7 reads this for culling.
export function primLipschitz(code, P) { return 1; }
// Lipschitz bound per primitive where it exceeds 1. The ellipsoid is Quilez's
// approximate distance: measured gradient magnitude 3.888 on radii (4, 2, 1)
// (theoretical ≤ rmax/rmin = 4); 3.888 × 1.05 rounded up.
export const PRIM_LIPSCHITZ = Object.freeze({ 2: 4.09 });

/** Precomputed round-cone constants (Quilez sdRoundCone, exact). */
export function roundConeParams(a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr;
  return Float64Array.of(a[0], a[1], a[2], bax, bay, baz, l2, rr, a2, 1 / l2, r1, r2);
}

const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export function evalPrim(code, P, x, y, z) {
  switch (code) {
    case 1: return hypot3(x, y, z) - P[0];
    // Scaled-sphere field min(r)·(k0−1): exactly 1-Lipschitz, not a true distance. Quilez's
    // outside branch measured up to 30× (radii 10,1,1) so it was dropped (see primLipschitz).
    case 2: return Math.min(P[0], P[1], P[2]) * (hypot3(x / P[0], y / P[1], z / P[2]) - 1);
    case 3: {
      const px = x - P[0], py = y - P[1], pz = z - P[2];
      const bx = P[3] - P[0], by = P[4] - P[1], bz = P[5] - P[2];
      const bb = bx * bx + by * by + bz * bz;
      let h = bb > 0 ? (px * bx + py * by + pz * bz) / bb : 0;
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      return hypot3(px - bx * h, py - by * h, pz - bz * h) - P[6];
    }
    case 4: {
      const pax = x - P[0], pay = y - P[1], paz = z - P[2];
      const bax = P[3], bay = P[4], baz = P[5], l2 = P[6], rr = P[7], a2 = P[8], il2 = P[9];
      const yv = pax * bax + pay * bay + paz * baz, zv = yv - l2;
      const xx = pax * l2 - bax * yv, xy = pay * l2 - bay * yv, xz = paz * l2 - baz * yv;
      const x2 = xx * xx + xy * xy + xz * xz, y2 = yv * yv * l2, z2 = zv * zv * l2;
      const k = sgn(rr) * rr * rr * x2;
      if (sgn(zv) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - P[11];
      if (sgn(yv) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - P[10];
      return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - P[10];
    }
    case 5: {
      const r = P[3];
      const qx = Math.abs(x) - P[0] + r, qy = Math.abs(y) - P[1] + r, qz = Math.abs(z) - P[2] + r;
      return hypot3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
    }
    case 6: {
      const r = P[2];
      const dx = Math.sqrt(x * x + y * y) - P[1] + r, dz = Math.abs(z) - P[0] + r;
      const mx = Math.max(dx, 0), mz = Math.max(dz, 0);
      return Math.sqrt(mx * mx + mz * mz) + Math.min(Math.max(dx, dz), 0) - r;
    }
    case 7: {
      const q = Math.sqrt(x * x + y * y) - P[0];
      return Math.sqrt(q * q + z * z) - P[1];
    }
    case 8: return P[0] * x + P[1] * y + P[2] * z - P[3];
    default: throw new Error(`implicit: unknown primitive code ${code}`);
  }
}

// n-ary, order-independent quadratic smooth min (plan decision 1). Two children:
// exactly Quilez's normalized quadratic smin. A child ≥ k above the minimum adds
// exactly 0, which is what makes interval pruning exact.
export function unionN(v, n, k) {
  let m = v[0], am = 0;
  for (let i = 1; i < n; i++) if (v[i] < m) { m = v[i]; am = i; }
  if (!(k > 0)) return m;
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i === am) continue;
    const g = k - (v[i] - m);
    if (g > 0) { const h = g / k; s += h * h; }
  }
  return m - s * k * 0.25;
}

export function intersectN(v, n, k) {
  let M = v[0], aM = 0;
  for (let i = 1; i < n; i++) if (v[i] > M) { M = v[i]; aM = i; }
  if (!(k > 0)) return M;
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i === aM) continue;
    const g = k - (M - v[i]);
    if (g > 0) { const h = g / k; s += h * h; }
  }
  return M + s * k * 0.25;
}

export const WARP = Object.freeze({ TWIST: 1, BEND: 2, TAPER: 3 });

/** Maps a point (in the warp's basis: axis = z, toward = x) into the child's space. */
export function warpPoint(out, kind, W, x, y, z) {
  if (kind === 1) {
    const a = -W[0] * z, c = pfCos(a), s = pfSin(a);
    out[0] = c * x - s * y; out[1] = s * x + c * y; out[2] = z;
  } else if (kind === 2) {
    const R = W[0], u = R - x, rho = Math.sqrt(u * u + z * z);
    out[0] = R - rho; out[1] = y; out[2] = R * pfAtan2(z, u);
  } else {
    let t = (z - W[0]) / (W[2] - W[0]);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const s = W[1] + (W[3] - W[1]) * t;
    out[0] = x / s; out[1] = y / s; out[2] = z;
  }
}

export function mirrorPoint(out, axis, x, y, z) {
  out[0] = axis === 0 ? -x : x; out[1] = axis === 1 ? -y : y; out[2] = axis === 2 ? -z : z;
}

export const sanitize = (v) => (v === v ? (v > BIG ? BIG : v < -BIG ? -BIG : v) : BIG);
export const clampUnit = (v) => (v > -1 ? (v < 1 ? v : 1) : v === v ? -1 : 0);
