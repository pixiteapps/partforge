// Damped least squares: the solver core shared by joint-space and
// parameter-space inverse kinematics. Pure and deterministic.

const norm = (r) => {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i] * r[i];
  return Math.sqrt(s);
};

const clampTo = (x, lo, hi) => {
  for (let i = 0; i < x.length; i++) x[i] = Math.min(hi[i], Math.max(lo[i], x[i]));
  return x;
};

/** Solve the m x m system A y = b in place by Gaussian elimination with partial pivoting. */
function gauss(A, b, m) {
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (p !== c) {
      [A[p], A[c]] = [A[c], A[p]];
      [b[p], b[c]] = [b[c], b[p]];
    }
    const d = A[c][c];
    if (d === 0) continue;
    for (let r = c + 1; r < m; r++) {
      const f = A[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k < m; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const y = new Float64Array(m);
  for (let r = m - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < m; k++) s -= A[r][k] * y[k];
    y[r] = A[r][r] === 0 ? 0 : s / A[r][r];
  }
  return y;
}

/**
 * One damped least-squares step from x, x + J^T (J J^T + lam^2 I)^-1 (-r), solved over
 * the ACTIVE variables: a variable sitting on a bound whose step points out through it
 * is dropped (its column left out) and the rest re-solved, until no step points out.
 * Clamping such a step afterwards, as a plain solve would, throws away the share of the
 * step the other variables were given to go with it — the clamped step then fails to
 * help, damping doubles, and the variable stays pinned to its bound for frames (a fully
 * curled finger pulled straight). With no variable dropped this is the plain step,
 * computed in exactly the same order, so an unbounded solve is bit-identical.
 */
function activeSetStep(J, r, x, lo, hi, lam, m, n) {
  const free = new Uint8Array(n).fill(1);
  const neg = Array.from(r, (v) => -v);
  for (let pass = 0; ; pass++) {
    const A = Array.from({ length: m }, (_, i) => {
      const row = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        let s = 0;
        for (let j = 0; j < n; j++) if (free[j]) s += J[i][j] * J[k][j];
        row[k] = s;
      }
      row[i] += lam * lam;
      return row;
    });
    const y = gauss(A, neg.slice(), m);
    const xn = Float64Array.from(x);
    let dropped = false;
    for (let j = 0; j < n; j++) {
      if (!free[j]) continue;
      let s = 0;
      for (let i = 0; i < m; i++) s += J[i][j] * y[i];
      if (pass < n && ((x[j] <= lo[j] && s < 0) || (x[j] >= hi[j] && s > 0))) {
        free[j] = 0;
        dropped = true;
      }
      xn[j] += s;
    }
    if (!dropped) return xn;
  }
}

/**
 * Minimise ||residuals(x)|| over x in [lo, hi] by damped least squares with a
 * central-difference Jacobian. Returns the result and its residual norm.
 * `tol` (default 0: off) stops before an iteration once the residual norm is at most
 * tol — a solved point needs no more Jacobians (each costs 2n residual evaluations).
 * `onIteration(x)` (optional) runs before each iteration's Jacobian: a caller whose
 * residual function depends on state it refreshes there (the drag guard's contact
 * linearisation) gets the residual at x re-read after it, so a step is judged against
 * the same residual function it was taken on. With no hook nothing extra runs.
 */
export function solveDLS({ x0, lo, hi, residuals, iterations, lambda = 1, h = 1e-4, tol = 0, onIteration = null }) {
  const n = x0.length;
  let x = clampTo(Float64Array.from(x0), lo, hi);
  let r = residuals(x);
  let err = norm(r);
  const m = r.length;
  let lam = lambda;
  for (let it = 0; it < iterations; it++) {
    if (tol > 0 && err <= tol) break;
    if (onIteration) {
      onIteration(x);
      r = residuals(x);
      err = norm(r);
    }
    const J = Array.from({ length: m }, () => new Float64Array(n));
    for (let j = 0; j < n; j++) {
      const xp = Float64Array.from(x);
      const xm = Float64Array.from(x);
      xp[j] += h;
      xm[j] -= h;
      const rp = residuals(xp);
      const rm = residuals(xm);
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const xn = activeSetStep(J, r, x, lo, hi, lam, m, n);
      clampTo(xn, lo, hi);
      const rn = residuals(xn);
      const en = norm(rn);
      if (en <= err) {
        // A kept step that barely helps is zig-zagging across a narrow valley
        // (near a singularity): damp harder instead of relaxing.
        const slow = err - en < 1e-2 * err;
        x = xn;
        r = rn;
        err = en;
        lam = slow ? lam * 2 : Math.max(0.01, lam / 2);
        break;
      }
      lam *= 2;
    }
  }
  return { x, error: err };
}
