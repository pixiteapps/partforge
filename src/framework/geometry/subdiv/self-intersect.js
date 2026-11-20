// Self-intersection check for a subdivided cage: finds triangles of the mesh that pass
// through each other and names the cage faces they descend from, so an author can be told
// "face +x:0,0 runs through face -x:0,0" rather than "the mesh is broken".
//
// A bounding-box tree over the triangles (typed arrays, midpoint splits, leaves of
// LEAF_SIZE) answers, for each triangle, which later triangles' boxes overlap its own.
// Each candidate pair that shares no vertex index is tested exactly: two triangles that
// are not coplanar cross only if an edge of one passes through the other, so each of the
// six edges is tested against the other triangle.
//
// The test is strict, by a tolerance of EPS_REL of the mesh's bounding-box diagonal (about
// 0.1 µm on a 100 mm body): an edge must start and end more than that on either side of the
// other triangle's plane, and pass through the triangle more than that inside its edges.
// Touching at a point or along an edge, coplanar contact, and floating-point grazing are
// not reported; a real pass-through crosses by far more than that.

const LEAF_SIZE = 4;
export const SELF_INTERSECT_EPS_REL = 1e-6;

/**
 * Pairs of cage faces whose subdivided triangles cross.
 * @param {{ positions: Float64Array, indices: Uint32Array, triFace: Uint32Array }} mesh
 * @param {{ limit?: number }} [options]
 * @returns {Array<[number, number]>} distinct pairs, `a <= b`, in the order first found, at most `limit`
 */
export function selfIntersections({ positions: P, indices: I, triFace }, { limit = 8 } = {}) {
  const T = I.length / 3;
  const out = [];
  if (T < 2 || limit <= 0) return out;

  // Per-triangle boxes and centroids, and the mesh's size for the tolerance.
  const box = new Float64Array(6 * T);
  const cen = new Float64Array(3 * T);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let nFaces = 0;
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      let mn = Infinity, mx = -Infinity;
      for (let v = 0; v < 3; v++) {
        const x = P[3 * I[3 * t + v] + k];
        if (x < mn) mn = x;
        if (x > mx) mx = x;
      }
      box[6 * t + k] = mn; box[6 * t + 3 + k] = mx;
      cen[3 * t + k] = (mn + mx) / 2;
      if (mn < lo[k]) lo[k] = mn;
      if (mx > hi[k]) hi[k] = mx;
    }
    if (triFace[t] + 1 > nFaces) nFaces = triFace[t] + 1;
  }
  const eps = SELF_INTERSECT_EPS_REL * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);

  const tree = buildTree(box, cen, T);
  const seen = new Set();
  const stack = new Int32Array(tree.left.length);   // never deeper than the node count
  for (let i = 0; i < T; i++) {
    const i0 = I[3 * i], i1 = I[3 * i + 1], i2 = I[3 * i + 2];
    const fi = triFace[i];
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const n = stack[--sp];
      if (!overlaps(tree.bounds, 6 * n, box, 6 * i)) continue;
      const count = tree.count[n];
      if (count === 0) { stack[sp++] = tree.left[n]; stack[sp++] = tree.left[n] + 1; continue; }
      for (let s = tree.start[n], e = s + count; s < e; s++) {
        const j = tree.perm[s];
        if (j <= i || !overlaps(box, 6 * j, box, 6 * i)) continue;
        const j0 = I[3 * j], j1 = I[3 * j + 1], j2 = I[3 * j + 2];
        if (j0 === i0 || j0 === i1 || j0 === i2 || j1 === i0 || j1 === i1 || j1 === i2 || j2 === i0 || j2 === i1 || j2 === i2) continue;
        const fj = triFace[j];
        const a = fi < fj ? fi : fj, b = fi < fj ? fj : fi;
        const key = a * nFaces + b;
        if (seen.has(key) || !trianglesCross(P, i0, i1, i2, j0, j1, j2, eps)) continue;
        seen.add(key);
        out.push([a, b]);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function overlaps(A, a, B, b) {
  return A[a] <= B[b + 3] && B[b] <= A[a + 3]
    && A[a + 1] <= B[b + 4] && B[b + 1] <= A[a + 4]
    && A[a + 2] <= B[b + 5] && B[b + 2] <= A[a + 5];
}

// A tree in flat arrays: node n's box is bounds[6n..6n+6]; a leaf has count > 0 and holds
// perm[start .. start+count); an inner node has count 0 and children left[n], left[n] + 1.
function buildTree(box, cen, T) {
  const maxNodes = 2 * T;   // a binary tree with at most T leaves
  const bounds = new Float64Array(6 * maxNodes);
  const left = new Int32Array(maxNodes), start = new Int32Array(maxNodes), count = new Int32Array(maxNodes);
  const perm = new Uint32Array(T);
  for (let t = 0; t < T; t++) perm[t] = t;
  let nodes = 1;
  const work = [[0, 0, T]];
  while (work.length) {
    const [n, s, e] = work.pop();
    const o = 6 * n;
    for (let k = 0; k < 3; k++) { bounds[o + k] = Infinity; bounds[o + 3 + k] = -Infinity; }
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let q = s; q < e; q++) {
      const t = perm[q];
      for (let k = 0; k < 3; k++) {
        if (box[6 * t + k] < bounds[o + k]) bounds[o + k] = box[6 * t + k];
        if (box[6 * t + 3 + k] > bounds[o + 3 + k]) bounds[o + 3 + k] = box[6 * t + 3 + k];
        const c = cen[3 * t + k];
        if (c < cmin[k]) cmin[k] = c;
        if (c > cmax[k]) cmax[k] = c;
      }
    }
    if (e - s <= LEAF_SIZE) { start[n] = s; count[n] = e - s; continue; }
    let ax = 0;
    for (let k = 1; k < 3; k++) if (cmax[k] - cmin[k] > cmax[ax] - cmin[ax]) ax = k;
    const mid = (cmin[ax] + cmax[ax]) / 2;
    let m = s;
    for (let q = s; q < e; q++) {
      const t = perm[q];
      if (cen[3 * t + ax] < mid) { perm[q] = perm[m]; perm[m] = t; m++; }
    }
    if (m === s || m === e) m = (s + e) >> 1;   // every centroid on one side: split by count
    const l = nodes;
    nodes += 2;
    left[n] = l; count[n] = 0;
    work.push([l, s, m], [l + 1, m, e]);
  }
  return { bounds, left, start, count, perm };
}

// Non-coplanar triangles cross only if an edge of one passes through the other.
function trianglesCross(P, a0, a1, a2, b0, b1, b2, eps) {
  return edgeThrough(P, a0, a1, b0, b1, b2, eps) || edgeThrough(P, a1, a2, b0, b1, b2, eps) || edgeThrough(P, a2, a0, b0, b1, b2, eps)
    || edgeThrough(P, b0, b1, a0, a1, a2, eps) || edgeThrough(P, b1, b2, a0, a1, a2, eps) || edgeThrough(P, b2, b0, a0, a1, a2, eps);
}

// Does segment pq pass strictly through triangle abc (by more than eps on every side)?
function edgeThrough(P, p, q, a, b, c, eps) {
  const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
  const ux = P[3 * b] - ax, uy = P[3 * b + 1] - ay, uz = P[3 * b + 2] - az;
  const vx = P[3 * c] - ax, vy = P[3 * c + 1] - ay, vz = P[3 * c + 2] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz);
  if (nl === 0) return false;
  nx /= nl; ny /= nl; nz /= nl;
  const px = P[3 * p], py = P[3 * p + 1], pz = P[3 * p + 2];
  const qx = P[3 * q], qy = P[3 * q + 1], qz = P[3 * q + 2];
  const dp = nx * (px - ax) + ny * (py - ay) + nz * (pz - az);
  const dq = nx * (qx - ax) + ny * (qy - ay) + nz * (qz - az);
  if (!((dp > eps && dq < -eps) || (dp < -eps && dq > eps))) return false;
  const s = dp / (dp - dq);
  const x = px + (qx - px) * s, y = py + (qy - py) * s, z = pz + (qz - pz) * s;
  return inside(P, a, b, x, y, z, nx, ny, nz, eps) && inside(P, b, c, x, y, z, nx, ny, nz, eps) && inside(P, c, a, x, y, z, nx, ny, nz, eps);
}

// Is (x, y, z), on the triangle's plane, more than eps inside the edge from e0 to e1?
function inside(P, e0, e1, x, y, z, nx, ny, nz, eps) {
  const ox = P[3 * e0], oy = P[3 * e0 + 1], oz = P[3 * e0 + 2];
  const ex = P[3 * e1] - ox, ey = P[3 * e1 + 1] - oy, ez = P[3 * e1 + 2] - oz;
  const wx = x - ox, wy = y - oy, wz = z - oz;
  const side = nx * (ey * wz - ez * wy) + ny * (ez * wx - ex * wz) + nz * (ex * wy - ey * wx);
  return side > eps * Math.hypot(ex, ey, ez);
}
