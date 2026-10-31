// src/framework/geometry/implicit/bracket.js
// Where a function changes sign along many edges at once: the owner path's edge solves (the
// owner mesher's bisector and side zeros, the crease cut's equal-shares point). Each lane is a
// parameter t on [0, 1] and a function g(t); g(t) < 0 is the low side and anything else (NaN
// too) the high side, as the fixed-step bisection this replaces read it. The bracket is kept
// throughout and narrowed by the Illinois method (modified regula falsi): the secant of the
// bracket's ends, the retained end's value halved whenever the same end is kept twice running.
// A midpoint step is taken instead whenever the secant cannot be used (an end not on its side
// of zero, or not finite), would land outside the open bracket, or the step before was a secant
// step that did not at least halve the bracket (the safeguard: a kink, a jump or a flat
// crossing can stall the secant on one end). So every two steps at least halve the bracket:
// the worst case is 2 × 24 = MAX_BRACKET_STEPS steps (24 halvings take any bracket from 1 to
// 2^-24 ≤ BRACKET_TOL), twice bisection's; a smooth crossing takes two or three. A lane stops
// once its bracket is BRACKET_TOL wide (in t: that fraction of the edge) or g is exactly 0, and
// its answer is the bracket's midpoint, within BRACKET_TOL / 2 (< 2^-24) of a sign change. A
// caller's step cap below that bound can stop a lane early: it then answers the end whose |g| is
// smaller (the low end on a tie, or when only the high end is NaN), never the midpoint of a wide
// bracket. Evaluation stays batched: each step evaluates the lanes still running, in lane
// order, in one call. The native core runs the same solve
// (native/implicit_bracket.h's solve_brackets) with the same arithmetic in the same order.

/** A lane stops once its bracket is this wide (a fraction of its edge). */
export const BRACKET_TOL = 1e-7;
/** Steps that bound every lane: each two steps at least halve the bracket, and 24 halvings reach BRACKET_TOL. */
export const MAX_BRACKET_STEPS = 48;

/**
 * The sign change of g on [0, 1] in each of `n` lanes. `evalAt(lanes, ts, count, g)` writes
 * g at parameter ts[k] of lane lanes[k] into g[k], for k < count (count ≤ 2n). `f0`/`f1` are g
 * at t = 0 and t = 1 per lane when the caller has them; otherwise both ends are evaluated
 * first, in one call (lane k's at slots 2k and 2k + 1). Returns each lane's parameter.
 */
export function solveBrackets(n, maxSteps, evalAt, f0 = null, f1 = null) {
  const lo = new Float64Array(n), hi = new Float64Array(n).fill(1);
  // flo/fhi: the ends' values as the secant reads them (Illinois-scaled); glo/ghi: as evaluated.
  const flo = new Float64Array(n), fhi = new Float64Array(n), glo = new Float64Array(n), ghi = new Float64Array(n);
  const side = new Int8Array(n);   // the end the last step moved: -1 low, 1 high, 0 none yet
  const mid = new Uint8Array(n);   // 1: the next step is a midpoint (the safeguard)
  const lanes = new Int32Array(Math.max(1, 2 * n)), ts = new Float64Array(Math.max(1, 2 * n)), g = new Float64Array(Math.max(1, 2 * n));
  const secant = new Uint8Array(Math.max(1, n));   // per running slot: this step is a secant step
  if (f0 === null || f1 === null) {
    for (let k = 0; k < n; k++) { lanes[2 * k] = k; ts[2 * k] = 0; lanes[2 * k + 1] = k; ts[2 * k + 1] = 1; }
    if (n) evalAt(lanes, ts, 2 * n, g);
    for (let k = 0; k < n; k++) { flo[k] = g[2 * k]; fhi[k] = g[2 * k + 1]; }
  } else {
    for (let k = 0; k < n; k++) { flo[k] = f0[k]; fhi[k] = f1[k]; }
  }
  for (let k = 0; k < n; k++) { glo[k] = flo[k]; ghi[k] = fhi[k]; }
  let na = 0;
  for (let k = 0; k < n; k++) lanes[na++] = k;
  for (let it = 0; it < maxSteps && na > 0; it++) {
    for (let q = 0; q < na; q++) {
      const k = lanes[q];
      let t = (lo[k] + hi[k]) / 2;
      secant[q] = 0;
      if (!mid[k] && flo[k] < 0 && fhi[k] > 0) {
        const s = lo[k] + (hi[k] - lo[k]) * (flo[k] / (flo[k] - fhi[k]));
        if (s > lo[k] && s < hi[k]) { t = s; secant[q] = 1; }
      }
      ts[q] = t;
    }
    evalAt(lanes, ts, na, g);
    let keep = 0;
    for (let q = 0; q < na; q++) {
      const k = lanes[q], t = ts[q], v = g[q], w = hi[k] - lo[k];
      if (v < 0) {
        if (side[k] === -1) fhi[k] *= 0.5;
        lo[k] = t; flo[k] = v; glo[k] = v; side[k] = -1;
      } else if (v === 0) {
        lo[k] = t; hi[k] = t; glo[k] = v; ghi[k] = v;
      } else {
        if (side[k] === 1) flo[k] *= 0.5;
        hi[k] = t; fhi[k] = v; ghi[k] = v; side[k] = 1;
      }
      mid[k] = secant[q] && hi[k] - lo[k] > 0.5 * w ? 1 : 0;
      if (hi[k] - lo[k] > BRACKET_TOL) lanes[keep++] = k;
    }
    na = keep;
  }
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (!(hi[k] - lo[k] > BRACKET_TOL)) out[k] = (lo[k] + hi[k]) / 2;
    else out[k] = Math.abs(ghi[k]) < Math.abs(glo[k]) || (Number.isNaN(glo[k]) && !Number.isNaN(ghi[k])) ? hi[k] : lo[k];
  }
  return out;
}
