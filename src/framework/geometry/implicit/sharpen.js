// src/framework/geometry/implicit/sharpen.js
// The sharpen pass (implicit solid design §4). The mesher bevels every sharp edge of the field by
// about a third of a cell. This stage puts a vertex on each one: it is the crease cut's method
// (crease.js: split an edge at a point moved onto a crease) with a different test for where a
// crease is. After cleanup, and after the crease cut on the owner path:
//
//   1. A candidate is a mesh edge whose two ends (neither pinned nor a crease point) have field
//      normals more than SHARP_ANGLE_COS apart. Its start is the point nearest the edge's middle
//      on both ends' tangent planes. A crease point's normal is a bisector, not a field normal.
//   2. That point is moved onto the field's zero set and the crease of its two sides: Newton,
//      NEWTON_STEPS, within the plane holding the edge and the sum of the two normals. Each side
//      is read SIDE·edge along its own plane, away from the other, so a step sees the two smooth
//      surfaces and not the kink between them.
//   3. It is kept if the field there is within SHARP_TOL·edge of zero, it moved at most
//      SHARP_MAX_MOVE·edge from the edge's middle, and the gradients just to each side still
//      differ by more than the angle. The last test refuses a point on a thin wall's other face
//      and a round the grid can resolve.
//   4. A kept point within SHARP_SNAP of an edge end moves that end (once; never a held, pinned or
//      crease vertex); else, or when that move cannot be made, it splits the edge, unless an end
//      of it moved. Moves go first. A change that would make a triangle face against its
//      corners' normals, or one thinner than MIN_ALTITUDE, is dropped; so is one whose
//      triangles, in their final form, face against the field's gradient at their centre.
//   5. Triangles with one, two or three split edges become 2, 3 or 4 triangles.
//   6. Corners (`corners`, on by default). Each vertex carries its tangent planes: an edge point
//      the two side gradients Newton ended on, through its own position; a mesher vertex its
//      normal; a pinned or crease vertex none. An edge of step 5's mesh with an edge point at one
//      end and exactly three distinct planes between its ends is a candidate, at the point where
//      the three meet, if their determinant is at least SHARP_CORNER_DET and the point is within
//      SHARP_MAX_MOVE·edge of the edge's middle. Candidates within CORNER_MERGE·edge of each
//      other are one corner, at the best one's point. It is kept within SHARP_TOL·edge of the
//      zero set. Then, in order: an end within CORNER_MERGE·edge of it is moved onto it; else the
//      edge is split there (at an earlier corner vertex there only when that vertex is next to
//      the edge); else its nearer end, then its other end, is moved there. A moved end takes the
//      corner's normal; a held, pinned or crease vertex never moves. Each try is checked as step
//      4 checks. A triangle left with a repeated vertex is dropped.
//   7. Steps 1 to 5 once more, on edges with neither end an edge or corner point: a corner in
//      place lets a split through that the bevel beside it refused.
// Pure edge splits on a closed manifold keep it closed and oriented; a corner point shared by
// several edges only drops the triangles it collapses. Native-portable arithmetic only
// (js-math.js), for the core port.
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
/** The corner pass's least |determinant| of three unit plane normals. */
export const SHARP_CORNER_DET = 0.05;

const NEWTON_STEPS = 10, STEP_CAP = 0.25, SIDE = 0.02, DIFF = 0.005, MIN_ALTITUDE = 0.001;
/** Corner points this close (cells) are one vertex. */
const CORNER_MERGE = 0.05;
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
 * Put vertices on the field's sharp edges and corners. `mesh` is cleanupMesh's (or cutCreases')
 * result. Returns it with every per-vertex array grown to the new vertices (on an owner mesh a new
 * vertex takes its evaluating end's `vertOwner`, and 0 for `ownerHeld`, `pinned` and `crease`),
 * plus `sharp` (0 a mesher vertex, 1 an edge point, 2 a corner point) and `sharpPlanes` (for an
 * edge point, the two vertex ids whose planes it joins; −1 otherwise; a moved end lists itself as
 * one of the two, its normal unchanged so its plane stays). A mesh that already has `sharp` keeps
 * it, and its edge and corner points are no candidate's end (step 7 runs on such a mesh). A mesh
 * with no candidate edge is returned as the same object. `stats`, when given, is filled with the
 * candidates' counts by outcome, and step 7's in `stats.again`.
 */
export function sharpenMesh(store, mesh, { corners = true, stats = null } = {}) {
  const edge = store.edge, N0 = mesh.normals, P0 = mesh.positions, T = mesh.indices, VL0 = mesh.vertLeaf, nv0 = P0.length / 3;
  const pinned = (v) => (mesh.pinned ? mesh.pinned[v] : 0), creased = (v) => (mesh.crease ? mesh.crease[v] : 0);
  const prior = (v) => (mesh.sharp ? mesh.sharp[v] : 0);
  const normal = (v) => [N0[3 * v], N0[3 * v + 1], N0[3 * v + 2]], pos = (v) => [P0[3 * v], P0[3 * v + 1], P0[3 * v + 2]];
  const st = stats ?? {};
  for (const name of ["candidates", "split", "moved", "offField", "tooFar", "notSharp", "unsolved"]) st[name] = 0;
  for (const name of ["snapBlocked", "endMoved", "flip", "sliver", "fieldFlip"]) st[name] = 0;
  for (const name of ["cornerCandidates", "corners", "cornerSplits", "cornerDet", "cornerFar", "cornerOffField"]) st[name] = 0;
  for (const name of ["cornerMoves", "cornerFlip", "cornerSliver", "cornerFieldFlip"]) st[name] = 0;

  // 1. The candidate edges, in the order the triangle list first names them.
  const seen = new Set(), cand = [];
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = T[t + k], b = T[t + (k + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a;
    const key = lo * nv0 + hi;   // PORTED: a 64-bit integer key in the core (see ekey)
    if (seen.has(key)) continue;
    seen.add(key);
    if (pinned(lo) || pinned(hi) || creased(lo) || creased(hi) || prior(lo) || prior(hi)) continue;
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
    cand.push({ a: lo, b: hi, m, p, uA, uB, sigma: conv > 0 ? 1 : -1, ok: conv !== 0, pn, leaf: VL0[lo], ev: lo });
  }
  if (!cand.length) return mesh;
  st.candidates = cand.length;
  // Each edge is evaluated with its first end's leaf program, or its other end's when the first
  // gives a non-finite value at its start.
  const d0 = evalField(store, Float64Array.from(cand.flatMap((c) => c.p)), cand.map((c) => c.leaf));
  cand.forEach((c, q) => { if (!Number.isFinite(d0[q])) { c.leaf = VL0[c.b]; c.ev = c.b; } });

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
  const free = (v) => !(mesh.ownerHeld?.[v]) && !pinned(v) && !creased(v);
  let S;
  for (;;) {
    S = commit(cand, { P0, N0, T, nv0, ekey, fan, byEdge, free, st, mesh });
    const flipped = fieldFlips(store, S, [...S.touched.keys()], { VL0, T, ekey, edge });
    if (!flipped.length) break;
    for (const t of flipped) for (const c of S.touched.get(t)) if (c.ok) { c.ok = false; st.fieldFlip++; }
  }
  const { P, N, splitOf, sharp, planes, planeN, added } = S;

  // 5. Re-triangulate. A new vertex takes its evaluating end's leaf and owner.
  let out = [];
  for (let t = 0; t < T.length / 3; t++) subdivide(T, t, splitOf, ekey, out);
  const VL = Array.from(VL0);
  const extra = ["vertOwner", "ownerHeld", "pinned", "crease"].filter((f) => mesh[f]).map((f) => ({ f, a: Array.from(mesh[f]) }));
  const grow = (c) => {
    VL.push(c.leaf);
    for (const x of extra) x.a.push(x.f === "vertOwner" ? x.a[c.ev] : 0);
  };
  for (const c of added) grow(c);
  // 6. Corners, on step 5's mesh.
  if (corners) {
    const noPlane = (v) => v < nv0 && (pinned(v) || creased(v));
    const C = cornerPass(store, { P, N, T: out, VL, P0, N0, sharp, planeN, noPlane, free, edge, st });
    out = C.out;
    for (const v of C.marked) { sharp[v] = 2; planes[2 * v] = -1; planes[2 * v + 1] = -1; }
    for (const c of C.added) { grow(c); sharp.push(2); planes.push(-1, -1); }
  }
  const res = {
    ...mesh, positions: Float64Array.from(P), normals: Float64Array.from(N), indices: Uint32Array.from(out), vertLeaf: Int32Array.from(VL),
    sharp: Uint8Array.from(sharp), sharpPlanes: Int32Array.from(planes),
  };
  for (const x of extra) res[x.f] = x.f === "vertOwner" ? Int32Array.from(x.a) : Uint8Array.from(x.a);
  // 7. One more edge round, on edges with neither end an edge or corner point.
  if (corners) { st.again = {}; return sharpenMesh(store, res, { corners: false, stats: st.again }); }
  return res;
}

// Triangle t of T, split at `splitOf`'s points, appended to `out`: 1, 2, 3 or 4 triangles. One
// left with a repeated vertex (two of its edges split at one shared corner point) is dropped.
function subdivide(T, t, splitOf, ekey, out) {
  const cut = (a, b) => { const v = splitOf.get(ekey(a, b)); return v === undefined ? -1 : v; };
  const v = [T[3 * t], T[3 * t + 1], T[3 * t + 2]], s = [cut(v[0], v[1]), cut(v[1], v[2]), cut(v[2], v[0])];
  const n = (s[0] >= 0) + (s[1] >= 0) + (s[2] >= 0);
  const put = (a, b, c) => { if (a !== b && b !== c && c !== a) out.push(a, b, c); };
  if (n === 0) { out.push(v[0], v[1], v[2]); return; }
  if (n === 3) { put(v[0], s[0], s[2]); put(v[1], s[1], s[0]); put(v[2], s[2], s[1]); put(s[0], s[1], s[2]); return; }
  let r = 0;
  if (n === 1) while (s[r] < 0) r++;
  else while (!(s[r] >= 0 && s[(r + 2) % 3] >= 0)) r++;
  const A = v[r], B = v[(r + 1) % 3], C = v[(r + 2) % 3], sAB = s[r], sCA = s[(r + 2) % 3];
  if (n === 1) { put(A, sAB, C); put(sAB, B, C); }
  else { put(A, sAB, sCA); put(sAB, B, C); put(sAB, C, sCA); }
}

// The kept candidates (c.ok), committed in order: every move, then every split on an edge with
// neither end moved. Returns the positions, normals, splits, the
// `sharp` and `sharpPlanes` tables, the split candidates in vertex order (`added`), and for each
// changed triangle the candidates that changed it (`touched`).
function commit(cand, { P0, N0, T, nv0, ekey, fan, byEdge, free, st, mesh }) {
  const P = Array.from(P0), N = Array.from(N0), splitOf = new Map(), moved = new Uint8Array(nv0);
  const sharp = mesh.sharp ? Array.from(mesh.sharp) : new Array(nv0).fill(0);
  const planes = mesh.sharpPlanes ? Array.from(mesh.sharpPlanes) : new Array(2 * nv0).fill(-1), added = [], touched = new Map();
  // Each edge point's two plane normals (the side gradients Newton ended on); 0 otherwise.
  const planeN = new Array(6 * nv0).fill(0);
  const setPlanes = (v, c) => { for (let i = 0; i < 3; i++) { planeN[6 * v + i] = c.uA[i]; planeN[6 * v + 3 + i] = c.uB[i]; } };
  for (const k of ["split", "moved", "endMoved", "snapBlocked", "flip", "sliver"]) st[k] = 0;
  const check = (tris) => checkTris(T, tris, splitOf, ekey, P, N);
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
    // A move that cannot be made is tried as a split below.
    if (!free(end)) { st.snapBlocked++; ends[q] = -1; return; }
    const was = [P[3 * end], P[3 * end + 1], P[3 * end + 2]];
    P[3 * end] = c.p[0]; P[3 * end + 1] = c.p[1]; P[3 * end + 2] = c.p[2];
    const bad = check(fan.get(end));
    if (bad) { P[3 * end] = was[0]; P[3 * end + 1] = was[1]; P[3 * end + 2] = was[2]; st[bad]++; ends[q] = -1; return; }
    // The moved end keeps its normal: the crease point is on its own plane too.
    moved[end] = 1; sharp[end] = 1; planes[2 * end] = c.a; planes[2 * end + 1] = c.b; setPlanes(end, c); st.moved++;
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
    sharp.push(1); planes.push(c.a, c.b); planeN.push(...c.uA, ...c.uB); added.push(c);
    touch(byEdge.get(key), c);
    st.split++;
  });
  return { P, N, splitOf, sharp, planes, planeN, added, touched };
}

// "flip" (a triangle against the sum of its corners' normals), "sliver" (an altitude under
// MIN_ALTITUDE) or null, over the triangles `tris` of T become when split at `splitOf`.
function checkTris(T, tris, splitOf, ekey, P, N) {
  const out = [];
  for (const t of tris) subdivide(T, t, splitOf, ekey, out);
  for (let i = 0; i < out.length; i += 3) {
    const n = triNormal(P, out[i], out[i + 1], out[i + 2]);
    if (n === null) return "sliver";
    const a = 3 * out[i], b = 3 * out[i + 1], c = 3 * out[i + 2];
    if (n[0] * (N[a] + N[b] + N[c]) + n[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + n[2] * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) return "flip";
  }
  return null;
}

// Step 6 on the split mesh `T` (positions P, normals N, leaves VL, all grown by step 5; P and N
// change here). A plane is (n, n·x): an edge point's two are the side gradients Newton ended on
// (`planeN`) through its own position, exact on flat faces; a mesher vertex's is its normal
// through its input position (P0, N0). Returns the re-triangulated list, the candidates that
// made a new vertex in vertex order (`added`, each with its `leaf` and evaluating end `ev`), and
// the vertices that became corner points where they were or by a move (`marked`).
function cornerPass(store, { P, N, T, VL, P0, N0, sharp, planeN, noPlane, free, edge, st }) {
  const nv1 = P.length / 3;
  // PORTED: lo·nv1 + hi is exact in a JS double (below 2^53); the core needs a 64-bit integer key.
  const ekey = (a, b) => (a < b ? a * nv1 + b : b * nv1 + a);
  const planesOf = (v) => {
    if (sharp[v] === 1) {
      const px = P[3 * v], py = P[3 * v + 1], pz = P[3 * v + 2], o = 6 * v;
      return [0, 3].map((j) => {
        const n = [planeN[o + j], planeN[o + j + 1], planeN[o + j + 2]];
        return { n, d: n[0] * px + n[1] * py + n[2] * pz, v };
      });
    }
    if (noPlane(v)) return [];
    const n = unit([N0[3 * v], N0[3 * v + 1], N0[3 * v + 2]]);
    return n ? [{ n, d: n[0] * P0[3 * v] + n[1] * P0[3 * v + 1] + n[2] * P0[3 * v + 2], v }] : [];
  };
  const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const seen = new Set(), cand = [];
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = T[t + k], b = T[t + (k + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a, key = ekey(lo, hi);
    if (seen.has(key)) continue;
    seen.add(key);
    if (sharp[lo] !== 1 && sharp[hi] !== 1) continue;
    // The distinct planes: an edge point's first (a mesher vertex's normal is the rougher one).
    const set = [], ordered = sharp[lo] === 1 ? [...planesOf(lo), ...planesOf(hi)] : [...planesOf(hi), ...planesOf(lo)];
    for (const q of ordered) if (set.every((o) => dot(o.n, q.n) < SHARP_ANGLE_COS)) set.push(q);
    if (set.length !== 3) continue;
    st.cornerCandidates++;
    const [n0, n1, n2] = set.map((q) => q.n), c12 = cr(n1, n2), c20 = cr(n2, n0), c01 = cr(n0, n1), det = dot(n0, c12);
    if (!(Math.abs(det) >= SHARP_CORNER_DET)) { st.cornerDet++; continue; }
    const p = [0, 1, 2].map((i) => (set[0].d * c12[i] + set[1].d * c20[i] + set[2].d * c01[i]) / det);
    const mx = (P[3 * lo] + P[3 * hi]) / 2 - p[0], my = (P[3 * lo + 1] + P[3 * hi + 1]) / 2 - p[1], mz = (P[3 * lo + 2] + P[3 * hi + 2]) / 2 - p[2];
    if (!(hypot3(mx, my, mz) <= SHARP_MAX_MOVE * edge)) { st.cornerFar++; continue; }
    const n = unit([0, 1, 2].map((i) => n0[i] + n1[i] + n2[i]));
    if (!n) { st.cornerDet++; continue; }   // the three normals cancel: no side to face
    // How many of its planes are a mesher vertex's, and how far the point is from the nearest
    // vertex that gave it one.
    let rough = 0, clear = Infinity;
    for (const q of set) {
      if (sharp[q.v] !== 1) rough++;
      clear = Math.min(clear, hypot3(P[3 * q.v] - p[0], P[3 * q.v + 1] - p[1], P[3 * q.v + 2] - p[2]));
    }
    cand.push({ a: lo, b: hi, p, n, rough, clear, leaf: VL[lo], ev: lo, ok: true, from: 0 });
  }
  if (!cand.length) return { out: T, added: [], marked: [] };
  // One point per corner. Candidates within CORNER_MERGE·edge of a group's first point take the
  // point of the member with the fewest mesher planes (a mesher vertex on a bevel has a normal of
  // neither face), then the one whose planes come from farthest away (a plane read within a hair
  // of the corner sees its third face); the first on a tie.
  const R = CORNER_MERGE * edge, groups = [];
  for (const c of cand) {
    const g = groups.find((x) => hypot3(x[0].p[0] - c.p[0], x[0].p[1] - c.p[1], x[0].p[2] - c.p[2]) <= R);
    if (g) g.push(c); else groups.push([c]);
  }
  for (const g of groups) {
    let best = g[0];
    for (const c of g) if (c.rough < best.rough || (c.rough === best.rough && c.clear > best.clear)) best = c;
    for (const c of g) { c.p = best.p; c.n = best.n; }
  }
  // The field at each point, with its first end's leaf program, or its other end's when the
  // first gives a non-finite value.
  const d = evalField(store, Float64Array.from(cand.flatMap((c) => c.p)), cand.map((c) => c.leaf));
  const redo = cand.filter((c, q) => !Number.isFinite(d[q]));
  for (const c of redo) { c.leaf = VL[c.b]; c.ev = c.b; }
  const d2 = redo.length ? evalField(store, Float64Array.from(redo.flatMap((c) => c.p)), redo.map((c) => c.leaf)) : [];
  let r = 0;
  cand.forEach((c, q) => {
    const f = Number.isFinite(d[q]) ? d[q] : d2[r++];
    if (!(Math.abs(f) <= SHARP_TOL * edge)) { c.ok = false; st.cornerOffField++; }
  });

  const fan = new Map(), byEdge = new Map();
  for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) {
    const v = T[3 * t + k], key = ekey(v, T[3 * t + (k + 1) % 3]);
    (fan.get(v) ?? fan.set(v, []).get(v)).push(t);
    (byEdge.get(key) ?? byEdge.set(key, []).get(key)).push(t);
  }
  // Commit in candidate order, checked as step 4 checks; then the field-flip rounds, as there,
  // except that a candidate whose change flipped one goes on to its next try.
  let S;
  for (;;) {
    S = commitCorners(cand, { P, N, T, ekey, fan, byEdge, free, edge, st });
    const flipped = fieldFlips(store, S, [...S.touched.keys()], { VL0: VL, T, ekey, edge });
    if (!flipped.length) break;
    for (const t of flipped) for (const c of S.touched.get(t)) if (c.ok && c.from <= c.took) {
      c.from = c.took + 1;
      if (c.from >= TRIES) { c.ok = false; st.cornerFieldFlip++; }
    }
  }
  for (let i = 0; i < S.P.length; i++) { P[i] = S.P[i]; N[i] = S.N[i]; }
  st.corners = S.added.length + S.marked.length;
  const out = [];
  for (let t = 0; t < T.length / 3; t++) subdivide(T, t, S.splitOf, ekey, out);
  return { out, added: S.added, marked: S.marked };
}

// A corner candidate's tries, in order: an end within CORNER_MERGE·edge of the point is moved
// onto it; the edge is split at the point; the nearer end, then the other, is moved onto it. A
// move takes the corner's normal, is at most SHARP_MAX_MOVE·edge and never moves a held, pinned
// or crease vertex.
const TRIES = 4;

// The kept corner candidates, committed in order, each by its first try (from `c.from`) that
// makes no flip or sliver. A point within CORNER_MERGE·edge of an earlier corner point is that
// vertex: nothing more when it is an end of the edge, else the edge is split at it if it is next
// to the edge (the apex of a triangle on it, or the split point of another edge of one), so a
// shared corner never pinches the mesh; a vertex not next to it gets a new one. Returns the
// positions, normals and splits, the candidates that made a vertex (`added`), the vertices made
// corners (`marked`) and, for each changed triangle, the candidates that changed it.
function commitCorners(cand, { P: P1, N: N1, T, ekey, fan, byEdge, free, edge, st }) {
  const P = P1.slice(), N = N1.slice(), splitOf = new Map(), made = [], added = [], marked = [], moved = new Set(), touched = new Map();
  for (const k of ["cornerSplits", "cornerMoves", "cornerFlip", "cornerSliver"]) st[k] = 0;
  const R2 = CORNER_MERGE * edge * CORNER_MERGE * edge, M2 = SHARP_MAX_MOVE * edge * SHARP_MAX_MOVE * edge;
  const d2 = (v, p) => { const x = P[3 * v] - p[0], y = P[3 * v + 1] - p[1], z = P[3 * v + 2] - p[2]; return x * x + y * y + z * z; };
  const touch = (tris, c) => { for (const t of tris) (touched.get(t) ?? touched.set(t, []).get(t)).push(c); };
  // Whether v is the apex of a triangle on c's edge, or the split point of another of its edges.
  const nextTo = (v, c) => byEdge.get(ekey(c.a, c.b)).some((t) => {
    const x = T[3 * t], y = T[3 * t + 1], z = T[3 * t + 2];
    return x === v || y === v || z === v || splitOf.get(ekey(x, y)) === v || splitOf.get(ekey(y, z)) === v || splitOf.get(ekey(z, x)) === v;
  });
  // Move v onto the corner point, if free and the fan stays sound; true when done.
  const moveTo = (v, c) => {
    if (moved.has(v) || !free(v) || d2(v, c.p) > M2) return false;
    const was = P.slice(3 * v, 3 * v + 3), wn = N.slice(3 * v, 3 * v + 3);
    for (let i = 0; i < 3; i++) { P[3 * v + i] = c.p[i]; N[3 * v + i] = c.n[i]; }
    const bad = checkTris(T, fan.get(v), splitOf, ekey, P, N);
    if (bad) {
      for (let i = 0; i < 3; i++) { P[3 * v + i] = was[i]; N[3 * v + i] = wn[i]; }
      st[bad === "flip" ? "cornerFlip" : "cornerSliver"]++;
      return false;
    }
    moved.add(v); marked.push(v); made.push({ v, p: c.p }); touch(fan.get(v), c); st.cornerMoves++;
    return true;
  };
  for (const c of cand) {
    if (!c.ok) continue;
    c.took = -1;
    let v = -1;
    for (const q of made) if (d2(q.v, c.p) <= R2) { v = q.v; break; }
    if (v === c.a || v === c.b) { c.took = c.from; continue; }   // already the corner
    if (v >= 0 && !nextTo(v, c)) v = -1;
    const near = d2(c.a, c.p) <= d2(c.b, c.p) ? c.a : c.b, far = near === c.a ? c.b : c.a;
    for (let k = c.from; k < TRIES && c.took < 0; k++) {
      if (k === 0) { if (v < 0 && d2(near, c.p) <= R2 && moveTo(near, c)) c.took = k; continue; }
      if (k === 2 || k === 3) { if (v < 0 && moveTo(k === 2 ? near : far, c)) c.took = k; continue; }
      // k === 1: split, at the shared vertex when there is one.
      const fresh = v < 0, key = ekey(c.a, c.b), u = fresh ? P.length / 3 : v;
      if (fresh) { P.push(c.p[0], c.p[1], c.p[2]); N.push(c.n[0], c.n[1], c.n[2]); }
      splitOf.set(key, u);
      const bad = checkTris(T, byEdge.get(key), splitOf, ekey, P, N);
      if (bad) {
        splitOf.delete(key);
        if (fresh) { P.length -= 3; N.length -= 3; }
        st[bad === "flip" ? "cornerFlip" : "cornerSliver"]++;
        continue;
      }
      if (fresh) { made.push({ v: u, p: c.p }); added.push(c); }
      touch(byEdge.get(key), c); st.cornerSplits++; c.took = k;
    }
  }
  return { P, N, splitOf, added, marked, touched };
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
