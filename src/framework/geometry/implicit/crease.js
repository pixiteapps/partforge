// src/framework/geometry/implicit/crease.js
// The crease cut (seam spec §5): after cleanup, each mesh edge whose ends belong to different
// pieces is split where the two pieces' cut values are equal, and that point is moved onto the
// crease (field = 0 and the two cuts equal). Pure edge splits on a closed manifold keep it closed
// and oriented; placing crease points directly instead is what shed stray shards in the spike.
//
//   1. Re-own: a free vertex (not held, not pinned) takes the argmin owner of the cuts at its
//      final position (evalBatchContact's merged owner, so an attachment zone is one owner and
//      is never cut). Held and pinned vertices keep the owner the mesher gave them.
//   2. Each edge with differing owners, both ends free, is bisected on c_X − c_Y (20 steps). A
//      split within CREASE_SNAP of an end moves that end instead of adding a vertex.
//   3. Triangles with one, two or three split edges become 2, 3 or 4 triangles.
//   4. Crease points move onto d = 0 and c_X = c_Y (Newton, minimal norm, 6 steps, each move
//      capped at 0.25 edge).
//   5. A point still off by more than CREASE_TOL·edge (a near miss has no crease) goes back
//      where it was and loses its flag.
// Crease vertices are neither held nor pinned. Exact trees never reach the native core.
import { evalBatchContact } from "./program.js";
import { CREASE_SNAP, CREASE_TOL } from "./contact.js";

const BISECT_STEPS = 20, NEWTON_STEPS = 6, MAX_MOVE_CELLS = 0.25;

// The field, merged owner and every cut at the points, each evaluated with its leaf's program.
function evalPoints(store, K, pts, leafOf) {
  const n = pts.length / 3, d = new Float64Array(n), owner = new Int32Array(n).fill(-1), cuts = new Float64Array(n * K).fill(Infinity);
  const groups = new Map();
  for (let q = 0; q < n; q++) {
    const g = groups.get(leafOf[q]);
    if (g) g.push(q); else groups.set(leafOf[q], [q]);
  }
  for (const [L, qs] of groups) {
    const m = qs.length, X = new Float64Array(m), Y = new Float64Array(m), Z = new Float64Array(m);
    const out = new Float64Array(m), o = new Int32Array(m), c = new Float64Array(m * K);
    qs.forEach((q, i) => { X[i] = pts[3 * q]; Y[i] = pts[3 * q + 1]; Z[i] = pts[3 * q + 2]; });
    evalBatchContact(store.leaves[L].prog, store.textures, X, Y, Z, out, { K, owner: o, cuts: c });
    qs.forEach((q, i) => {
      d[q] = out[i]; owner[q] = o[i];
      for (let j = 0; j < K; j++) cuts[q * K + j] = c[i * K + j];
    });
  }
  return { d, owner, cuts };
}

/**
 * Cut the creases into an owner mesh (`vertOwner`, `ownerHeld`, `pinned`, `vertLeaf`, `normals`).
 * Returns the mesh with every per-vertex array grown to the new vertices and `crease` set.
 */
export function cutCreases(store, mesh) {
  const K = Math.max(1, store.ownerK ?? 0), edge = store.edge;
  const P = Array.from(mesh.positions), N = Array.from(mesh.normals), T = Array.from(mesh.indices);
  const VL = Array.from(mesh.vertLeaf), VO = Array.from(mesh.vertOwner), VH = Array.from(mesh.ownerHeld), VP = Array.from(mesh.pinned);
  const nv0 = P.length / 3;
  const isFree = (v) => !VH[v] && !VP[v];

  // 1. Re-own the free vertices.
  const at0 = evalPoints(store, K, Float64Array.from(P), VL);
  for (let v = 0; v < nv0; v++) if (isFree(v) && at0.owner[v] >= 0) VO[v] = at0.owner[v];

  // The edges whose free ends differ in owner.
  const cross = new Map();
  for (let t = 0; t < T.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = T[t + k], b = T[t + (k + 1) % 3];
      if (VO[a] === VO[b] || !isFree(a) || !isFree(b)) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * nv0 + hi;
      if (!cross.has(key)) cross.set(key, { a: lo, b: hi, X: VO[lo], Y: VO[hi] });
    }
  }
  const list = [...cross.values()];

  // 2. Where on each edge the two cuts are equal.
  const lo = new Float64Array(list.length), hi = new Float64Array(list.length).fill(1);
  const along = (e, s) => [0, 1, 2].map((k) => P[3 * e.a + k] + (P[3 * e.b + k] - P[3 * e.a + k]) * s);
  const leafOfEdge = list.map((e) => VL[e.a]);
  for (let it = 0; it < BISECT_STEPS && list.length; it++) {
    const pts = new Float64Array(3 * list.length);
    list.forEach((e, q) => pts.set(along(e, (lo[q] + hi[q]) / 2), 3 * q));
    const { cuts } = evalPoints(store, K, pts, leafOfEdge);
    list.forEach((e, q) => {
      const mid = (lo[q] + hi[q]) / 2;
      if (cuts[q * K + e.X] - cuts[q * K + e.Y] < 0) lo[q] = mid; else hi[q] = mid;   // NaN (a pruned cut) goes to the high side
    });
  }
  const pairOf = new Map();   // crease vertex -> [X, Y]
  const startOf = new Map();  // crease vertex -> where it was
  const snapped = new Set();
  const params = list.map((e, q) => (lo[q] + hi[q]) / 2);
  list.forEach((e, q) => {
    const s = params[q], v = s < CREASE_SNAP ? e.a : s > 1 - CREASE_SNAP ? e.b : -1;
    if (v < 0 || pairOf.has(v)) return;
    snapped.add(v); pairOf.set(v, [e.X, e.Y]); startOf.set(v, P.slice(3 * v, 3 * v + 3));
  });
  const splitOf = new Map();
  list.forEach((e, q) => {
    const s = params[q];
    if (s < CREASE_SNAP || s > 1 - CREASE_SNAP || snapped.has(e.a) || snapped.has(e.b)) return;
    const v = P.length / 3, p = along(e, s);
    P.push(...p); VL.push(VL[e.a]); VO.push(e.X); VH.push(0); VP.push(0);
    const nx = N[3 * e.a] + N[3 * e.b], ny = N[3 * e.a + 1] + N[3 * e.b + 1], nz = N[3 * e.a + 2] + N[3 * e.b + 2], nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    N.push(nx / nl, ny / nl, nz / nl);
    splitOf.set(e.a * nv0 + e.b, v); pairOf.set(v, [e.X, e.Y]); startOf.set(v, p);
  });

  // 3. Re-triangulate by how many of a triangle's edges were split.
  const out = [];
  const split = (a, b) => splitOf.get(a < b ? a * nv0 + b : b * nv0 + a);
  for (let t = 0; t < T.length; t += 3) {
    const v = [T[t], T[t + 1], T[t + 2]], s = [split(v[0], v[1]), split(v[1], v[2]), split(v[2], v[0])];
    const ns = s.filter((x) => x !== undefined).length;
    if (ns === 0) { out.push(...v); continue; }
    if (ns === 3) {
      out.push(v[0], s[0], s[2], s[0], v[1], s[1], s[2], s[1], v[2], s[0], s[1], s[2]);
    } else if (ns === 1) {
      const i = s.findIndex((x) => x !== undefined), a = v[i], b = v[(i + 1) % 3], c = v[(i + 2) % 3], m = s[i];
      out.push(a, m, c, m, b, c);
    } else {   // the unsplit edge is (a, b); the splits are on bc and ca
      const free = s.findIndex((x) => x === undefined), a = v[free], b = v[(free + 1) % 3], c = v[(free + 2) % 3];
      const mbc = s[(free + 1) % 3], mca = s[(free + 2) % 3];
      out.push(a, b, mbc, a, mbc, mca, mca, mbc, c);
    }
  }

  // 4. Move the crease points onto d = 0 and c_X = c_Y.
  const cv = [...pairOf.keys()], h = 0.02 * edge, cap = MAX_MOVE_CELLS * edge;
  for (let it = 0; it < NEWTON_STEPS && cv.length; it++) {
    const pts = new Float64Array(21 * cv.length), lf = [];
    cv.forEach((v, q) => {
      const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
      pts.set([x, y, z, x + h, y, z, x - h, y, z, x, y + h, z, x, y - h, z, x, y, z + h, x, y, z - h], 21 * q);
      for (let k = 0; k < 7; k++) lf.push(VL[v]);
    });
    const { d, cuts } = evalPoints(store, K, pts, lf);
    cv.forEach((v, q) => {
      const [X, Y] = pairOf.get(v);
      const F = (k) => { const o = 7 * q + k; return [d[o], cuts[o * K + X] - cuts[o * K + Y]]; };
      const F0 = F(0), Fp = [F(1), F(3), F(5)], Fm = [F(2), F(4), F(6)];
      const J = [0, 1].map((r) => [0, 1, 2].map((ax) => (Fp[ax][r] - Fm[ax][r]) / (2 * h)));
      const [ja, jb] = J, aa = ja[0] * ja[0] + ja[1] * ja[1] + ja[2] * ja[2], bb = jb[0] * jb[0] + jb[1] * jb[1] + jb[2] * jb[2], ab = ja[0] * jb[0] + ja[1] * jb[1] + ja[2] * jb[2];
      const det = aa * bb - ab * ab;
      if (!(det > 1e-12)) return;
      const l0 = (-F0[0] * bb + F0[1] * ab) / det, l1 = (-F0[1] * aa + F0[0] * ab) / det;
      const dx = [0, 1, 2].map((k) => ja[k] * l0 + jb[k] * l1), len = Math.sqrt(dx[0] * dx[0] + dx[1] * dx[1] + dx[2] * dx[2]);
      if (!Number.isFinite(len)) return;
      const sc = len > cap ? cap / len : 1;
      for (let k = 0; k < 3; k++) P[3 * v + k] += dx[k] * sc;
    });
  }

  // 5. Revert what did not reach a crease.
  const crease = new Uint8Array(P.length / 3);
  if (cv.length) {
    const pts = new Float64Array(3 * cv.length);
    cv.forEach((v, q) => pts.set(P.slice(3 * v, 3 * v + 3), 3 * q));
    const { d, cuts } = evalPoints(store, K, pts, cv.map((v) => VL[v]));
    const tol = CREASE_TOL * edge;
    cv.forEach((v, q) => {
      const [X, Y] = pairOf.get(v);
      if (Math.abs(d[q]) <= tol && Math.abs(cuts[q * K + X] - cuts[q * K + Y]) <= tol) { crease[v] = 1; return; }
      const p0 = startOf.get(v);
      P[3 * v] = p0[0]; P[3 * v + 1] = p0[1]; P[3 * v + 2] = p0[2];
    });
  }
  return {
    ...mesh, positions: Float64Array.from(P), normals: Float64Array.from(N), indices: Uint32Array.from(out), vertLeaf: Int32Array.from(VL),
    vertOwner: Int32Array.from(VO), ownerHeld: Uint8Array.from(VH), pinned: Uint8Array.from(VP), crease,
  };
}
