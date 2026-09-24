// Shading-normal audits against a known analytic surface, shared by the Manifold
// and OCCT fillet-normal tests (backend parity: both must shade a fillet with the
// true rolling-ball normals).

const deg = (c) => (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;

// toMesh may be indexed (OCCT) or soup (Manifold): audit a soup either way.
function soup(mesh) {
  if (!mesh.indices) return mesh;
  const I = mesh.indices, n = I.length;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  for (let c = 0; c < n; c++) for (let j = 0; j < 3; j++) {
    positions[c * 3 + j] = mesh.positions[I[c] * 3 + j];
    normals[c * 3 + j] = mesh.normals[I[c] * 3 + j];
  }
  return { positions, normals, triangles: n / 3 };
}

// Every corner of every visible triangle vs truth(x) (unit normal, or null = not
// judged here). A corner is judged a hair inside its own triangle, so a corner on a
// hard edge is scored against the side it shades, not the one it borders. Two kinds
// of triangle are geometry, not shading, and are skipped: slivers thinner than a
// micron, and facets that do not face the way the true surface does (> 20° off at
// the centroid — the micron ledges a boolean leaves where tessellated tangent
// surfaces meet). Returns the worst angle (degrees) and where it sits.
export function auditNormals(mesh0, truth) {
  const mesh = soup(mesh0);
  const P = mesh.positions, N = mesh.normals;
  let worst = 0, at = null, judged = 0;
  for (let t = 0; t < mesh.triangles; t++) {
    const o = t * 9;
    const u = [P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]];
    const v = [P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]];
    const w = [P[o + 6] - P[o + 3], P[o + 7] - P[o + 4], P[o + 8] - P[o + 5]];
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const cr = Math.hypot(...f);
    const longest = Math.sqrt(Math.max(u[0] ** 2 + u[1] ** 2 + u[2] ** 2, v[0] ** 2 + v[1] ** 2 + v[2] ** 2, w[0] ** 2 + w[1] ** 2 + w[2] ** 2));
    if (!(cr / longest > 1e-3)) continue;
    const g = [(P[o] + P[o + 3] + P[o + 6]) / 3, (P[o + 1] + P[o + 4] + P[o + 7]) / 3, (P[o + 2] + P[o + 5] + P[o + 8]) / 3];
    const tg = truth(g);
    if (!tg || (f[0] * tg[0] + f[1] * tg[1] + f[2] * tg[2]) / cr < Math.cos((20 * Math.PI) / 180)) continue;
    for (let c = 0; c < 3; c++) {
      const i = o + c * 3;
      const x = [P[i], P[i + 1], P[i + 2]].map((q, j) => q + 1e-2 * (g[j] - q));
      const tn = truth(x);
      if (!tn) continue;
      judged++;
      const e = deg(N[i] * tn[0] + N[i + 1] * tn[1] + N[i + 2] * tn[2]);
      if (e > worst) { worst = e; at = [P[i], P[i + 1], P[i + 2]]; }
    }
  }
  return { worst, at, judged };
}

// Coincident corners (same position within `tol`) whose normals are within
// `smoothDeg` of each other belong to one smooth join; returns the largest
// disagreement among them, and the number of hard pairs (> smoothDeg) found where
// `where(x)` holds.
export function coincidentSpread(mesh0, { tol = 1e-4, smoothDeg = 20, where = () => true } = {}) {
  const mesh = soup(mesh0);
  const P = mesh.positions, N = mesh.normals;
  const cells = new Map();
  for (let c = 0; c < mesh.triangles * 3; c++) {
    const key = `${Math.round(P[c * 3] / tol)}|${Math.round(P[c * 3 + 1] / tol)}|${Math.round(P[c * 3 + 2] / tol)}`;
    (cells.get(key) ?? cells.set(key, []).get(key)).push(c);
  }
  let smooth = 0, hardPairs = 0;
  for (const cs of cells.values()) {
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i] * 3, b = cs[j] * 3;
      if (!(Math.hypot(N[a], N[a + 1], N[a + 2]) > 0.5 && Math.hypot(N[b], N[b + 1], N[b + 2]) > 0.5)) continue;
      const d = deg(N[a] * N[b] + N[a + 1] * N[b + 1] + N[a + 2] * N[b + 2]);
      if (d <= smoothDeg) smooth = Math.max(smooth, d);
      else if (where([P[a], P[a + 1], P[a + 2]])) hardPairs++;
    }
  }
  return { smooth, hardPairs };
}

// The filleted 30×30×12 box (x,y ∈ [-15,15], z ∈ [0,12]) rounded at r = 3 on every
// edge: every surface point's true normal points from its nearest point on the inner
// box [-12,12]²×[3,9] — the faces, the edge cylinders, and the corner sphere octants
// alike. Points off that surface (a later cut's walls) are not judged.
export function filletedBoxTruth(x) {
  const c = [Math.max(-12, Math.min(12, x[0])), Math.max(-12, Math.min(12, x[1])), Math.max(3, Math.min(9, x[2]))];
  const d = [x[0] - c[0], x[1] - c[1], x[2] - c[2]];
  const L = Math.hypot(...d);
  return Math.abs(L - 3) < 0.01 ? d.map((q) => q / L) : null;
}
