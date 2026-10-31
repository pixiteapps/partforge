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
 * Minimise ||residuals(x)|| over x in [lo, hi] by damped least squares with a
 * central-difference Jacobian. Returns the result and its residual norm.
 */
export function solveDLS({ x0, lo, hi, residuals, iterations, lambda = 1, h = 1e-4 }) {
  const n = x0.length;
  let x = clampTo(Float64Array.from(x0), lo, hi);
  let r = residuals(x);
  let err = norm(r);
  const m = r.length;
  let lam = lambda;
  for (let it = 0; it < iterations; it++) {
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
      const A = Array.from({ length: m }, (_, i) => {
        const row = new Float64Array(m);
        for (let k = 0; k < m; k++) {
          let s = 0;
          for (let j = 0; j < n; j++) s += J[i][j] * J[k][j];
          row[k] = s;
        }
        row[i] += lam * lam;
        return row;
      });
      const y = gauss(A, Array.from(r, (v) => -v), m);
      const xn = Float64Array.from(x);
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i][j] * y[i];
        xn[j] += s;
      }
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
