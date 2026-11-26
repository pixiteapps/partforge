// src/framework/geometry/implicit/sharpen.js
// The sharpen pass (implicit solid design §4). The mesher bevels every sharp edge of the field by
// about a third of a cell. This stage puts a vertex on each one: it is the crease cut's method
// (crease.js: split an edge at a point moved onto a crease) with a different test for where a
// crease is. After cleanup, and after the crease cut on the owner path:
//
//   1. A candidate is a mesh edge whose two ends (neither pinned) have field normals more than
//      SHARP_ANGLE_COS apart. Its start is the point nearest the edge's middle on both ends'
//      tangent planes.
//   2. That point is moved onto the field's zero set and the crease of its two sides: Newton,
//      NEWTON_STEPS, within the plane holding the edge and the sum of the two normals. Each side
//      is read SIDE·edge along its own plane, away from the other, so a step sees the two smooth
//      surfaces and not the kink between them.
//   3. It is kept if the field there is within SHARP_TOL·edge of zero, it moved at most
//      SHARP_MAX_MOVE·edge from the edge's middle, and the gradients just to each side still
//      differ by more than the angle. The last test refuses a point on a thin wall's other face
//      and a round the grid can resolve.
//   4. A kept point within SHARP_SNAP of an edge end moves that end (once; never a held, pinned or
//      crease vertex); else it splits the edge, unless an end of it moved. Moves go first. A change that would make a triangle face against
//      its corners' normals, or one thinner than MIN_ALTITUDE, is dropped; so is one whose
//      triangles, in their final form, face against the field's gradient at their centre.
//   5. Triangles with one, two or three split edges become 2, 3 or 4 triangles.
// Pure edge splits on a closed manifold keep it closed and oriented. Native-portable arithmetic
// only (js-math.js), for the core port. The corner pass (`corners`) is not built yet.
import { evalBatch } from "./program.js";
import { hypot3 } from "../js-math.js";

/** cos 25°: a mesh edge whose ends' normals are further apart than this is a candidate. */
export const SHARP_ANGLE_COS = 0.9063077870366499;
/** A kept point's field, in cells. */
export const SHARP_TOL = 0.05;
/** A kept point's farthest move from its edge's middle, in cells. */
export const SHARP_MAX_MOVE = 1.5;
/** A kept point this close to an edge end (a fraction of the edge) moves that end. CREASE_SNAP's value. */
export const SHARP_SNAP = 0.15;
/** The corner pass's least determinant of three plane normals (Task 2). */
export const SHARP_CORNER_DET = 0.05;

const NEWTON_STEPS = 10, STEP_CAP = 0.25, SIDE = 0.02, DIFF = 0.005, MIN_ALTITUDE = 0.001;
// Per candidate per round: the point, then each side's point and its six difference points.
const PTS = 15;

// The field at the points, each evaluated with its leaf's program (crease.js's evalPoints).
function evalField(store, pts, leafOf) {
  const n = pts.length / 3, d = new Float64Array(n), groups = new Map();
  for (let q = 0; q < n; q++) {
    const g = groups.get(leafOf[q]);
    if (g) g.push(q); else groups.set(leafOf[q], [q]);
  }
  for (const [L, qs] of groups) {
    const m = qs.length, X = new Float64Array(m), Y = new Float64Array(m), Z = new Float64Array(m), out = new Float64Array(m);
    qs.forEach((q, i) => { X[i] = pts[3 * q]; Y[i] = pts[3 * q + 1]; Z[i] = pts[3 * q + 2]; });
    evalBatch(store.leaves[L].prog, store.textures, X, Y, Z, out);
    qs.forEach((q, i) => { d[q] = out[i]; });
  }
  return d;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const det3 = (a, b, c) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
const unit = (v) => { const l = hypot3(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null; };

// Each side's direction: along its own plane, away from the other plane. `sigma` is +1 on a
// convex edge and −1 on a concave one.
function sides(c) {
  const k = dot(c.uA, c.uB);
  const wA = unit([0, 1, 2].map((i) => -c.sigma * (c.uB[i] - k * c.uA[i])));
  const wB = unit([0, 1, 2].map((i) => -c.sigma * (c.uA[i] - k * c.uB[i])));
  return wA && wB ? [wA, wB] : null;
}

// One round for every candidate: the field at its point, and each side's value and gradient.
function readSides(store, cand, edge) {
  const h = SIDE * edge, e = DIFF * edge, pts = new Float64Array(3 * PTS * cand.length), lf = [];
  cand.forEach((c, q) => {
    c.w = sides(c);
    const [x, y, z] = c.p, o = 3 * PTS * q;
    pts[o] = x; pts[o + 1] = y; pts[o + 2] = z;
    for (let s = 0; s < 2; s++) {
      const w = c.w ?? [[0, 0, 0], [0, 0, 0]], sx = x + h * w[s][0], sy = y + h * w[s][1], sz = z + h * w[s][2];
      pts.set([sx, sy, sz, sx + e, sy, sz, sx - e, sy, sz, sx, sy + e, sz, sx, sy - e, sz, sx, sy, sz + e, sx, sy, sz - e], o + 3 + 21 * s);
    }
    for (let k = 0; k < PTS; k++) lf.push(c.leaf);
  });
  const d = evalField(store, pts, lf);
  return cand.map((c, q) => {
    const o = PTS * q, side = (s) => {
      const b = o + 1 + 7 * s;
      const gx = (d[b + 1] - d[b + 2]) / (2 * e), gy = (d[b + 3] - d[b + 4]) / (2 * e), gz = (d[b + 5] - d[b + 6]) / (2 * e);
      return { f: d[b], g: [gx, gy, gz] };
    };
    return { f: d[o], A: side(0), B: side(1) };
  });
}

// One Newton step: both sides' linear models zero, within the edge's plane (Cramer's rule); or,
// without a plane, the least step to both. False when the step cannot be taken.
function newtonStep(c, r, edge) {
  const h = SIDE * edge, { A, B } = r;
  const rA = -A.f + h * dot(A.g, c.w[0]), rB = -B.f + h * dot(B.g, c.w[1]);
  let dx = null;
  if (c.pn) {
    const a = A.g, b = B.g, n = c.pn;
    const D = det3(a, b, n), scale = hypot3(a[0], a[1], a[2]) * hypot3(b[0], b[1], b[2]);
    if (Math.abs(D) > 1e-6 * scale) {
      const rP = -((c.p[0] - c.m[0]) * n[0] + (c.p[1] - c.m[1]) * n[1] + (c.p[2] - c.m[2]) * n[2]);
      // Cramer's rule: column k of the rows (a, b, n) replaced by the right-hand side (rA, rB, rP).
      const dx0 = det3([rA, a[1], a[2]], [rB, b[1], b[2]], [rP, n[1], n[2]]) / D;
      const dx1 = det3([a[0], rA, a[2]], [b[0], rB, b[2]], [n[0], rP, n[2]]) / D;
      const dx2 = det3([a[0], a[1], rA], [b[0], b[1], rB], [n[0], n[1], rP]) / D;
      dx = [dx0, dx1, dx2];
    }
  }
  if (dx === null) {
    const aa = dot(A.g, A.g), bb = dot(B.g, B.g), ab = dot(A.g, B.g), det = aa * bb - ab * ab;
    if (!(det > 1e-12)) return false;
    const l0 = (rA * bb - rB * ab) / det, l1 = (rB * aa - rA * ab) / det;
    dx = [0, 1, 2].map((k) => A.g[k] * l0 + B.g[k] * l1);
  }
  const len = hypot3(dx[0], dx[1], dx[2]);
  if (!Number.isFinite(len)) return false;
  const sc = len > STEP_CAP * edge ? (STEP_CAP * edge) / len : 1;
  for (let k = 0; k < 3; k++) c.p[k] += dx[k] * sc;
  const uA = unit(A.g), uB = unit(B.g);
  if (uA && uB) { c.uA = uA; c.uB = uB; }
  return true;
}

/**
 * Put vertices on the field's sharp edges. `mesh` is cleanupMesh's (or cutCreases') result. Returns
 * it with every per-vertex array grown to the new vertices, plus `sharp` (0 a mesher vertex, 1 an
 * edge point) and `sharpPlanes` (for an edge point, the two vertex ids whose planes it joins; −1
 * otherwise; a moved end lists itself as one of the two, its normal unchanged so its plane stays).
 * A mesh with no candidate edge is returned as the same object. `stats`, when given,
 * is filled with the candidates' counts by outcome.
 */
export function sharpenMesh(store, mesh, { corners = true, stats = null } = {}) {
  void corners;
  const edge = store.edge, N0 = mesh.normals, P0 = mesh.positions, T = mesh.indices, VL0 = mesh.vertLeaf, nv0 = P0.length / 3;
  const pinned = (v) => (mesh.pinned ? mesh.pinned[v] : 0);
  const normal = (v) => [N0[3 * v], N0[3 * v + 1], N0[3 * v + 2]], pos = (v) => [P0[3 * v], P0[3 * v + 1], P0[3 * v + 2]];
  const st = stats ?? {};
  for (const name of ["candidates", "split", "moved", "offField", "tooFar", "notSharp", "unsolved"]) st[name] = 0;
  for (const name of ["snapBlocked", "endMoved", "flip", "sliver", "fieldFlip"]) st[name] = 0;

  // 1. The candidate edges, in the order the triangle list first names them.
  const seen = new Set(), cand = [];
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = T[t + k], b = T[t + (k + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a;
    const key = lo * nv0 + hi;   // PORTED: a 64-bit integer key in the core (see ekey)
    if (seen.has(key)) continue;
    seen.add(key);
    if (pinned(lo) || pinned(hi)) continue;
    const nA = normal(lo), nB = normal(hi), lA = hypot3(nA[0], nA[1], nA[2]), lB = hypot3(nB[0], nB[1], nB[2]);
    if (!(lA > 0.5 && lB > 0.5) || dot(nA, nB) >= SHARP_ANGLE_COS * lA * lB) continue;
    const uA = nA.map((x) => x / lA), uB = nB.map((x) => x / lB), pA = pos(lo), pB = pos(hi);
    const m = [0, 1, 2].map((i) => (pA[i] + pB[i]) / 2), ab = [0, 1, 2].map((i) => pB[i] - pA[i]);
    // The point nearest the middle on both tangent planes: m + α·nA + β·nB.
    const c = dot(uA, uB), det = 1 - c * c;
    if (!(det > 1e-9)) continue;   // normals (anti)parallel: the planes do not meet in a line
    const ra = -(uA[0] * (m[0] - pA[0]) + uA[1] * (m[1] - pA[1]) + uA[2] * (m[2] - pA[2]));
    const rb = -(uB[0] * (m[0] - pB[0]) + uB[1] * (m[1] - pB[1]) + uB[2] * (m[2] - pB[2]));
    const al = (ra - c * rb) / det, be = (rb - c * ra) / det;
    const p = [0, 1, 2].map((i) => m[i] + al * uA[i] + be * uB[i]);
    const conv = ab[0] * (uB[0] - uA[0]) + ab[1] * (uB[1] - uA[1]) + ab[2] * (uB[2] - uA[2]);
    const s = [0, 1, 2].map((i) => uA[i] + uB[i]);
    const pn = unit([ab[1] * s[2] - ab[2] * s[1], ab[2] * s[0] - ab[0] * s[2], ab[0] * s[1] - ab[1] * s[0]]);
    cand.push({ a: lo, b: hi, m, p, uA, uB, sigma: conv > 0 ? 1 : -1, ok: conv !== 0, pn, leaf: VL0[lo] });
  }
  if (!cand.length) return mesh;
  st.candidates = cand.length;
  // Each edge is evaluated with its first end's leaf program, or its other end's when the first
  // gives a non-finite value at its start.
  const d0 = evalField(store, Float64Array.from(cand.flatMap((c) => c.p)), cand.map((c) => c.leaf));
  cand.forEach((c, q) => { if (!Number.isFinite(d0[q])) c.leaf = VL0[c.b]; });

  // 2. Newton onto the crease.
  let live = cand.filter((c) => c.ok);
  for (let it = 0; it < NEWTON_STEPS && live.length; it++) {
    const rs = readSides(store, live, edge);
    live = live.filter((c, q) => {
      if (!c.w || !newtonStep(c, rs[q], edge)) { c.ok = false; return false; }
      return true;
    });
  }
  // 3. Judge each point.
  const judged = cand.filter((c) => c.ok), rs = readSides(store, judged, edge);
  judged.forEach((c, q) => {
    const r = rs[q], gA = unit(r.A.g), gB = unit(r.B.g), dm = hypot3(c.p[0] - c.m[0], c.p[1] - c.m[1], c.p[2] - c.m[2]);
    if (!c.w || !Number.isFinite(r.f) || !gA || !gB) { c.ok = false; st.unsolved++; }
    else if (!(dm <= SHARP_MAX_MOVE * edge)) { c.ok = false; st.tooFar++; }
    else if (!(Math.abs(r.f) <= SHARP_TOL * edge)) { c.ok = false; st.offField++; }
    else if (!(dot(gA, gB) < SHARP_ANGLE_COS)) { c.ok = false; st.notSharp++; }
  });
  st.unsolved += cand.length - judged.length;

  // 4. Commit, in candidate order. Each change is checked on the triangles it makes, against the
  // state so far (the sum of their corners' normals, and MIN_ALTITUDE). Then every changed
  // triangle's final form is read against the field's gradient at its centre, and the candidates
  // that changed one facing against it are dropped and the commit run again. Each new round
  // drops at least one kept candidate, so the loop ends.
  // PORTED: lo·nv0 + hi is exact in a JS double (below 2^53); the core needs a 64-bit integer key.
  const ekey = (a, b) => (a < b ? a * nv0 + b : b * nv0 + a);
  const fan = new Map(), byEdge = new Map();
  for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) {
    const v = T[3 * t + k], key = ekey(v, T[3 * t + (k + 1) % 3]);
    (fan.get(v) ?? fan.set(v, []).get(v)).push(t);
    (byEdge.get(key) ?? byEdge.set(key, []).get(key)).push(t);
  }
  const free = (v) => !(mesh.ownerHeld?.[v]) && !pinned(v) && !(mesh.crease?.[v]);
  let S;
  for (;;) {
    S = commit(cand, { P0, N0, T, nv0, ekey, fan, byEdge, free, st });
    const flipped = fieldFlips(store, S, [...S.touched.keys()], { VL0, T, ekey, edge });
    if (!flipped.length) break;
    for (const t of flipped) for (const c of S.touched.get(t)) if (c.ok) { c.ok = false; st.fieldFlip++; }
  }
  const { P, N, splitOf, sharp, planes, added } = S;

  // 5. Re-triangulate.
  const out = [];
  for (let t = 0; t < T.length / 3; t++) subdivide(T, t, splitOf, ekey, out);
  const VL = Array.from(VL0);
  const extra = ["vertOwner", "ownerHeld", "pinned", "crease"].filter((f) => mesh[f]).map((f) => ({ f, a: Array.from(mesh[f]) }));
  for (const c of added) {
    VL.push(c.leaf);
    for (const x of extra) x.a.push(x.f === "vertOwner" ? x.a[c.a] : 0);
  }
  const res = {
    ...mesh, positions: Float64Array.from(P), normals: Float64Array.from(N), indices: Uint32Array.from(out), vertLeaf: Int32Array.from(VL),
    sharp: Uint8Array.from(sharp), sharpPlanes: Int32Array.from(planes),
  };
  for (const x of extra) res[x.f] = x.f === "vertOwner" ? Int32Array.from(x.a) : Uint8Array.from(x.a);
  return res;
}

// Triangle t of T, split at `splitOf`'s points, appended to `out`: 1, 2, 3 or 4 triangles.
function subdivide(T, t, splitOf, ekey, out) {
  const cut = (a, b) => { const v = splitOf.get(ekey(a, b)); return v === undefined ? -1 : v; };
  const v = [T[3 * t], T[3 * t + 1], T[3 * t + 2]], s = [cut(v[0], v[1]), cut(v[1], v[2]), cut(v[2], v[0])];
  const n = (s[0] >= 0) + (s[1] >= 0) + (s[2] >= 0);
  if (n === 0) { out.push(v[0], v[1], v[2]); return; }
  if (n === 3) { out.push(v[0], s[0], s[2], v[1], s[1], s[0], v[2], s[2], s[1], s[0], s[1], s[2]); return; }
  let r = 0;
  if (n === 1) while (s[r] < 0) r++;
  else while (!(s[r] >= 0 && s[(r + 2) % 3] >= 0)) r++;
  const A = v[r], B = v[(r + 1) % 3], C = v[(r + 2) % 3], sAB = s[r], sCA = s[(r + 2) % 3];
  if (n === 1) out.push(A, sAB, C, sAB, B, C);
  else out.push(A, sAB, sCA, sAB, B, C, sAB, C, sCA);
}

// The kept candidates (c.ok), committed in order: every move, then every split on an edge with
// neither end moved. Returns the positions, normals, splits, the
// `sharp` and `sharpPlanes` tables, the split candidates in vertex order (`added`), and for each
// changed triangle the candidates that changed it (`touched`).
function commit(cand, { P0, N0, T, nv0, ekey, fan, byEdge, free, st }) {
  const P = Array.from(P0), N = Array.from(N0), splitOf = new Map(), moved = new Uint8Array(nv0);
  const sharp = new Array(nv0).fill(0), planes = new Array(2 * nv0).fill(-1), added = [], touched = new Map();
  for (const k of ["split", "moved", "endMoved", "snapBlocked", "flip", "sliver"]) st[k] = 0;
  // "flip" (a triangle against the sum of its corners' normals), "sliver" (an altitude under
  // MIN_ALTITUDE) or null, over the triangles `tris` become.
  const check = (tris) => {
    const out = [];
    for (const t of tris) subdivide(T, t, splitOf, ekey, out);
    for (let i = 0; i < out.length; i += 3) {
      const n = triNormal(P, out[i], out[i + 1], out[i + 2]);
      if (n === null) return "sliver";
      const a = 3 * out[i], b = 3 * out[i + 1], c = 3 * out[i + 2];
      if (n[0] * (N[a] + N[b] + N[c]) + n[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + n[2] * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) return "flip";
    }
    return null;
  };
  const touch = (tris, c) => { for (const t of tris) (touched.get(t) ?? touched.set(t, []).get(t)).push(c); };
  // Which end each kept candidate moves (−1: it splits), from the original positions.
  const endOf = (c) => {
    const ax = P0[3 * c.a], ay = P0[3 * c.a + 1], az = P0[3 * c.a + 2];
    const ux = P0[3 * c.b] - ax, uy = P0[3 * c.b + 1] - ay, uz = P0[3 * c.b + 2] - az;
    const s = ((c.p[0] - ax) * ux + (c.p[1] - ay) * uy + (c.p[2] - az) * uz) / (ux * ux + uy * uy + uz * uz);
    return s < SHARP_SNAP ? c.a : s > 1 - SHARP_SNAP ? c.b : -1;
  };
  const kept = cand.filter((c) => c.ok), ends = kept.map(endOf);
  // Moves first, as crease.js does: a split is then never beside an end that moves after it.
  kept.forEach((c, q) => {
    const end = ends[q];
    if (end < 0) return;
    if (moved[c.a] || moved[c.b]) { st.endMoved++; return; }
    if (!free(end)) { st.snapBlocked++; return; }
    const was = [P[3 * end], P[3 * end + 1], P[3 * end + 2]];
    P[3 * end] = c.p[0]; P[3 * end + 1] = c.p[1]; P[3 * end + 2] = c.p[2];
    const bad = check(fan.get(end));
    if (bad) { P[3 * end] = was[0]; P[3 * end + 1] = was[1]; P[3 * end + 2] = was[2]; st[bad]++; return; }
    // The moved end keeps its normal: the crease point is on its own plane too.
    moved[end] = 1; sharp[end] = 1; planes[2 * end] = c.a; planes[2 * end + 1] = c.b; st.moved++;
    touch(fan.get(end), c);
  });
  // Then splits, on edges with neither end moved.
  kept.forEach((c, q) => {
    if (ends[q] >= 0) return;
    if (moved[c.a] || moved[c.b]) { st.endMoved++; return; }
    const v = P.length / 3, key = ekey(c.a, c.b);
    const n = unit([0, 1, 2].map((i) => N0[3 * c.a + i] + N0[3 * c.b + i])) ?? [0, 0, 0];
    P.push(c.p[0], c.p[1], c.p[2]); N.push(n[0], n[1], n[2]);
    splitOf.set(key, v);
    const bad = check(byEdge.get(key));
    if (bad) { P.length -= 3; N.length -= 3; splitOf.delete(key); st[bad]++; return; }
    sharp.push(1); planes.push(c.a, c.b); added.push(c);
    touch(byEdge.get(key), c);
    st.split++;
  });
  return { P, N, splitOf, sharp, planes, added, touched };
}

// The triangle's (unnormalized) normal, or null when an altitude is under MIN_ALTITUDE.
function triNormal(P, i, j, k) {
  const a = 3 * i, b = 3 * j, c = 3 * k;
  const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], w = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  const x = [P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const longest = Math.sqrt(Math.max(dot(u, u), dot(w, w), dot(x, x)));
  return longest > 0 && hypot3(n[0], n[1], n[2]) >= MIN_ALTITUDE * longest ? n : null;
}

// The changed triangles (ids in T) one of whose parts faces against the field's gradient at its
// centre (central differences, DIFF·edge), read with its first corner's leaf program.
function fieldFlips(store, S, tris, { VL0, T, ekey, edge }) {
  const e = DIFF * edge, parts = [], owner = [], pts = [], lf = [];
  for (const t of tris) {
    const out = [];
    subdivide(T, t, S.splitOf, ekey, out);
    for (let i = 0; i < out.length; i += 3) {
      const n = triNormal(S.P, out[i], out[i + 1], out[i + 2]) ?? [0, 0, 0], P = S.P;
      const a = 3 * out[i], b = 3 * out[i + 1], c = 3 * out[i + 2];
      const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      pts.push(cx + e, cy, cz, cx - e, cy, cz, cx, cy + e, cz, cx, cy - e, cz, cx, cy, cz + e, cx, cy, cz - e);
      for (let k = 0; k < 6; k++) lf.push(VL0[T[3 * t]]);
      parts.push(n); owner.push(t);
    }
  }
  const d = evalField(store, Float64Array.from(pts), lf), bad = [];
  parts.forEach((n, q) => {
    const o = 6 * q;
    const g = n[0] * (d[o] - d[o + 1]) + n[1] * (d[o + 2] - d[o + 3]) + n[2] * (d[o + 4] - d[o + 5]);
    if (g < 0 && bad[bad.length - 1] !== owner[q]) bad.push(owner[q]);
  });
  return bad;
}
