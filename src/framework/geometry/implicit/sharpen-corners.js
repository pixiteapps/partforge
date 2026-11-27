// src/framework/geometry/implicit/sharpen-corners.js
// The sharpen pass's corners (sharpen.js step 6). Native-portable arithmetic only (js-math.js),
// for the core port.
import { hypot3 } from "../js-math.js";
import { SHARP_ANGLE_COS, SHARP_TOL, SHARP_MAX_MOVE, SHARP_CORNER_DET, CORNER_MERGE, SIDE, DIFF, SIDE_PTS, STEP_CAP, CONVERGED } from "./sharpen.js";
import { evalField, dot, det3, unit, adjacency, retriangulate, checkTris, fieldFlips, apartIndex } from "./sharpen-mesh.js";

// Step 6 on the split mesh `T` (positions P, normals N, leaves VL, all grown by step 5; P and N
// change here). A plane is (n, n·x): an edge point's two are the side gradients Newton ended on
// (`planeN`) through its own position, exact on flat faces; a mesher vertex's is its normal
// through its input position (P0, N0). Three such planes are only a candidate's start: it is
// solved on the field's three faces (solveCorners) and kept only where three faces meet. Returns
// the re-triangulated list, the candidates that made a new vertex in vertex order (`added`, each
// with its `leaf` and evaluating end `ev`), and the vertices that became corner points where they
// were or by a move (`marked`). `pts` lists every vertex with `sharp` 1, in any order; on the
// across pass `have` lists every one with `sharp` 2 (the corner points made so far, which its
// candidates keep clear of).
export function cornerPass(store, { P, N, T, VL, P0, N0, sharp, planeN, noPlane, free, edge, st, across = false, pts, have = [] }) {
  const nv1 = P.length / 3;
  // PORTED: lo·nv1 + hi is exact in a JS double (below 2^53); the core needs a 64-bit integer key.
  const ekey = (a, b) => (a < b ? a * nv1 + b : b * nv1 + a);
  const planesOf = (v) => {
    if (sharp[v] === 1) {
      const px = P[3 * v], py = P[3 * v + 1], pz = P[3 * v + 2], q6 = planeN.get(v) ?? [0, 0, 0, 0, 0, 0];
      return [0, 3].map((j) => {
        const n = [q6[j], q6[j + 1], q6[j + 2]];
        return { n, d: n[0] * px + n[1] * py + n[2] * pz, v };
      });
    }
    if (noPlane(v)) return [];
    const n = unit([N0[3 * v], N0[3 * v + 1], N0[3 * v + 2]]);
    return n ? [{ n, d: n[0] * P0[3 * v] + n[1] * P0[3 * v + 1] + n[2] * P0[3 * v + 2], v }] : [];
  };
  const adj = adjacency(T, nv1);
  let cand = [];
  // A candidate on edge (lo, hi) from the planes `ordered`, when exactly three are distinct.
  const offer = (ordered, lo, hi) => {
    const set = [];
    for (const q of ordered) if (set.every((o) => dot(o.n, q.n) < SHARP_ANGLE_COS)) set.push(q);
    if (set.length !== 3) return;
    st.cornerCandidates++;
    const [n0, n1, n2] = set.map((q) => q.n), c12 = cr(n1, n2), c20 = cr(n2, n0), c01 = cr(n0, n1), det = dot(n0, c12);
    if (!(Math.abs(det) >= SHARP_CORNER_DET)) { st.cornerDet++; return; }
    const p = [0, 1, 2].map((i) => (set[0].d * c12[i] + set[1].d * c20[i] + set[2].d * c01[i]) / det);
    const m = [(P[3 * lo] + P[3 * hi]) / 2, (P[3 * lo + 1] + P[3 * hi + 1]) / 2, (P[3 * lo + 2] + P[3 * hi + 2]) / 2];
    if (!(hypot3(m[0] - p[0], m[1] - p[1], m[2] - p[2]) <= SHARP_MAX_MOVE * edge)) { st.cornerFar++; return; }
    // A start on a corner made so far is that corner: not solved again.
    if (have.some((v) => hypot3(P[3 * v] - p[0], P[3 * v + 1] - p[1], P[3 * v + 2] - p[2]) <= CORNER_MERGE * edge)) return;
    if (!unit([0, 1, 2].map((i) => n0[i] + n1[i] + n2[i]))) { st.cornerDet++; return; }   // the three normals cancel: no side to face
    // How many of its planes are a mesher vertex's, and how far the point is from the nearest and
    // the farthest vertex that gave it one. The farthest sets the solve's first read distance.
    let rough = 0, clear = Infinity, reach = 0;
    for (const q of set) {
      if (sharp[q.v] !== 1) rough++;
      const d = hypot3(P[3 * q.v] - p[0], P[3 * q.v + 1] - p[1], P[3 * q.v + 2] - p[2]);
      clear = Math.min(clear, d);
      reach = Math.max(reach, d);
    }
    const h = reach < SIDE * edge ? SIDE * edge : reach > CORNER_SIDE_MAX * edge ? CORNER_SIDE_MAX * edge : reach;
    cand.push({ a: lo, b: hi, m, p, u: [n0, n1, n2], h, n: null, rough, clear, leaf: VL[lo], ev: lo, ok: true, from: 0, seed: { p: p.slice(), u: [n0, n1, n2], h } });
  };
  // Only a triangle with an edge point can hold a candidate edge: the edge points' fans, in index order.
  const near = new Set();
  for (const v of pts) for (const t of adj.fan.get(v)) near.add(t);
  for (const tt of Uint32Array.from(near).sort()) for (let k = 0; k < 3; k++) {
    const t = 3 * tt, a = T[t + k], b = T[t + (k + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a;
    if ((sharp[lo] !== 1 && sharp[hi] !== 1) || !adj.first(t / 3, lo, hi)) continue;
    // The distinct planes: an edge point's first (a mesher vertex's normal is the rougher one).
    const v = sharp[lo] === 1 ? lo : hi, u = v === lo ? hi : lo;
    if (!across) { offer([...planesOf(v), ...planesOf(u)], lo, hi); continue; }
    // When u is not an edge point: v's planes with those of each edge point w across u, in u's
    // fan order. Three creases meeting at a corner need not leave two of their edge points side
    // by side: the bevel's own vertices can sit between them.
    if (sharp[u] === 1) continue;
    const seen = [];
    for (const f of adj.fan.get(u)) for (let j = 0; j < 3; j++) {
      const w = T[3 * f + j];
      if (w === v || w === u || sharp[w] !== 1 || seen.includes(w)) continue;
      seen.push(w);
      offer([...planesOf(v), ...planesOf(w)], lo, hi);
    }
  }
  // Each candidate solved on the field's faces; then, on the across pass, its solved point clear
  // of the corners made so far too. Only those kept go on.
  const tol = (across ? ACROSS_TOL : SHARP_TOL) * edge, R0 = CORNER_MERGE * edge;
  solveCorners(store, cand, VL, edge, st, tol);
  cand = cand.filter((c) => c.ok && !have.some((v) => hypot3(P[3 * v] - c.p[0], P[3 * v + 1] - c.p[1], P[3 * v + 2] - c.p[2]) <= R0));
  if (!cand.length) return { out: T, added: [], marked: [], P, N };
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
    if (!(Math.abs(f) <= tol)) { c.ok = false; st.cornerOffField++; }
  });

  const { fan, byEdge } = adj;
  // Commit in candidate order, checked as step 4 checks; then the field-flip rounds, as there,
  // except that a candidate whose change flipped one goes on to its next try.
  let S;
  const apart = apartIndex(P, nv1, edge, cand.filter((c) => c.ok).map((c) => c.p)), work = {};
  for (;;) {
    S = commitCorners(cand, { P, N, T, ekey, fan, byEdge, free, edge, st, apart, work });
    const flipped = fieldFlips(store, S, [...S.touched.keys()], { VL0: VL, T, ekey, edge });
    if (!flipped.length) break;
    for (const t of flipped) for (const c of S.touched.get(t)) if (c.ok && c.from <= c.took) {
      c.from = c.took + 1;
      if (c.from >= TRIES) { c.ok = false; st.cornerFieldFlip++; }
    }
  }
  st.corners = S.added.length + S.marked.length;
  const out = retriangulate(T, S.cut, S.splitOf, ekey);
  return { out, added: S.added, marked: S.marked, P: S.P, N: S.N };
}

// The field limit (cells) for a corner found across a vertex: its planes are all edge points',
// exact on flat faces, and two tangent lines of one curved crease (a rim) meet off the surface.
export const ACROSS_TOL = 0.005;

// The corner solve's steps, and its first read distance's ceiling (cells).
export const CORNER_STEPS = 12, CORNER_SIDE_MAX = 0.5;

// The corner solve's reads. A face i of a corner lies in its own plane, in one of the four
// quadrants that the other two planes cut it into. Each face is read at four points, h along each
// quadrant's middle direction in its plane (the sum of the unit directions, in that plane, of the
// other two normals, each with a sign). The face is the quadrant whose mean value is nearest zero
// (the first on a tie): the others lie off the surface, in front of or behind another plane. Each
// point is SIDE_PTS reads, as an edge side is (readSides). With `withCentre`, the field at the
// point itself too (else `f` is NaN). A face with no quadrant to read is null. With `ring`, each
// face is read instead at CORNER_RING points evenly round the point in its plane, from the
// unit direction of the next normal: where four or more faces meet, a face can be narrower than
// its quadrants, and one of these then lies on it.
const QUADRANTS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
// The ring's directions, cos and sin of k·22.5°, from three literals.
export const RING_C1 = 0.9238795325112867, RING_S1 = 0.3826834323650898, RING_R2 = 0.7071067811865476;
const C1 = RING_C1, S1 = RING_S1, R2 = RING_R2;
const RING = [[1, 0], [C1, S1], [R2, R2], [S1, C1], [0, 1], [-S1, C1], [-R2, R2], [-C1, S1],
  [-1, 0], [-C1, -S1], [-R2, -R2], [-S1, -C1], [0, -1], [S1, -C1], [R2, -R2], [C1, -S1]];
export const CORNER_RING = RING.length;
function readCorners(store, cand, edge, withCentre, ring = false) {
  const nd = ring ? CORNER_RING : 4;
  const per = SIDE_PTS, c0 = withCentre ? 1 : 0, PTS = c0 + 3 * nd * per, e = DIFF * edge;
  const pts = new Float64Array(3 * PTS * cand.length), lf = [], zero = [0, 0, 0];
  cand.forEach((c, q) => {
    // The directions, face by face; null where the other two normals' parts in its plane are
    // zero or sum to zero (on the ring: where the next normal's part is zero).
    c.W = [0, 1, 2].map((i) => {
      const ni = c.u[i], nj = c.u[(i + 1) % 3], nk = c.u[(i + 2) % 3], dj = dot(ni, nj), dk = dot(ni, nk);
      const a = unit([nj[0] - dj * ni[0], nj[1] - dj * ni[1], nj[2] - dj * ni[2]]);
      if (ring) {
        const b = a ? cr(ni, a) : null;
        return RING.map(([ca, sb]) => (b ? [ca * a[0] + sb * b[0], ca * a[1] + sb * b[1], ca * a[2] + sb * b[2]] : null));
      }
      const b = unit([nk[0] - dk * ni[0], nk[1] - dk * ni[1], nk[2] - dk * ni[2]]);
      return QUADRANTS.map(([sa, sb]) => (a && b ? unit([sa * a[0] + sb * b[0], sa * a[1] + sb * b[1], sa * a[2] + sb * b[2]]) : null));
    });
    const [x, y, z] = c.p, o = 3 * PTS * q;
    if (withCentre) { pts[o] = x; pts[o + 1] = y; pts[o + 2] = z; }
    for (let i = 0; i < 3; i++) for (let s = 0; s < nd; s++) {
      const w = c.W[i][s] ?? zero, sx = x + c.h * w[0], sy = y + c.h * w[1], sz = z + c.h * w[2];
      pts.set([sx + e, sy, sz, sx - e, sy, sz, sx, sy + e, sz, sx, sy - e, sz, sx, sy, sz + e, sx, sy, sz - e], o + 3 * (c0 + per * (nd * i + s)));
    }
    for (let k = 0; k < PTS; k++) lf.push(c.leaf);
  });
  const d = evalField(store, pts, lf);
  return cand.map((c, q) => {
    const o = PTS * q, face = (i) => {
      let best = null;
      for (let s = 0; s < nd; s++) {
        if (!c.W[i][s]) continue;
        const b = o + c0 + per * (nd * i + s), f0 = d[b], f1 = d[b + 1], f2 = d[b + 2], f3 = d[b + 3], f4 = d[b + 4], f5 = d[b + 5];
        const f = (f0 + f1 + f2 + f3 + f4 + f5) / 6;
        if (!Number.isFinite(f) || (best && !(Math.abs(f) < Math.abs(best.f)))) continue;
        best = { f, g: [(f0 - f1) / (2 * e), (f2 - f3) / (2 * e), (f4 - f5) / (2 * e)], w: c.W[i][s] };
      }
      return best;
    };
    return { f: withCentre ? d[o] : NaN, S: [face(0), face(1), face(2)] };
  });
}

// The move that zeroes the three faces' linear models (Cramer's rule), or null when it cannot be
// found: a face not read, the three gradients' determinant under SHARP_CORNER_DET of their
// lengths' product, or a move that is not finite.
function cornerDelta(c, r) {
  const [A, B, C] = r.S;
  if (!A || !B || !C) return null;
  const rA = -A.f + c.h * dot(A.g, A.w), rB = -B.f + c.h * dot(B.g, B.w), rC = -C.f + c.h * dot(C.g, C.w);
  const a = A.g, b = B.g, n = C.g;
  const D = det3(a, b, n), scale = hypot3(a[0], a[1], a[2]) * hypot3(b[0], b[1], b[2]) * hypot3(n[0], n[1], n[2]);
  if (!(Math.abs(D) >= SHARP_CORNER_DET * scale)) return null;
  const dx = [
    det3([rA, a[1], a[2]], [rB, b[1], b[2]], [rC, n[1], n[2]]) / D,
    det3([a[0], rA, a[2]], [b[0], rB, b[2]], [n[0], rC, n[2]]) / D,
    det3([a[0], a[1], rA], [b[0], b[1], rB], [n[0], n[1], rC]) / D,
  ];
  return Number.isFinite(hypot3(dx[0], dx[1], dx[2])) ? dx : null;
}

// Whether a candidate back at its start is the corner of the faces read there: the move that
// zeroes their models is under CONVERGED·edge, as a converged solve's last step is.
function atStart(c, r, edge) {
  const dx = cornerDelta(c, r);
  return dx !== null && hypot3(dx[0], dx[1], dx[2]) <= CONVERGED * edge;
}

// One corner step: the three faces' linear models zero (Cramer's rule), as the edge round's
// newtonStep does for two faces and a plane. False when it cannot be taken: a face not read, or
// the three gradients' determinant under SHARP_CORNER_DET of their lengths' product. The read
// distance halves after each step, down to SIDE·edge; the point has converged on a step under
// CONVERGED·edge read at that floor.
function cornerStep(c, r, edge) {
  const dx = cornerDelta(c, r);
  if (!dx) return false;
  const [a, b, n] = [r.S[0].g, r.S[1].g, r.S[2].g], len = hypot3(dx[0], dx[1], dx[2]);
  const floor = SIDE * edge, done = c.h <= floor && len <= CONVERGED * edge, sc = len > STEP_CAP * edge ? (STEP_CAP * edge) / len : 1;
  if (!done) for (let k = 0; k < 3; k++) c.p[k] += dx[k] * sc;
  const uA = unit(a), uB = unit(b), uC = unit(n);
  if (uA && uB && uC) c.u = [uA, uB, uC];
  const half = c.h / 2;
  c.h = half > floor ? half : floor;
  return done ? "done" : true;
}

// The corner candidates solved on the field, as the edge round's solve does for its candidates:
// each step is one read of every live candidate. A candidate is evaluated with its first end's
// leaf program, or its other end's when the first gives a non-finite value at its start. One
// whose step converges is judged on that read; the rest are judged on one more read after
// CORNER_STEPS. One whose step cannot be taken goes back to its start (point, planes and read
// distance) and is judged on a ring read there (readCorners). Where four or more flat faces meet
// (a pyramid's tip), a quadrant read can land on a fourth face, and the three planes the
// candidate started from already meet at the tip. Such a candidate must also be the corner of
// the faces read there (atStart): beside a curved sharp edge, two tangent planes of one face
// meet off it. A candidate is kept (its point and, for its normal, the unit sum of its three
// face gradients) if the field at the point is within `tol` of zero, the point is within
// SHARP_MAX_MOVE·edge of its edge's middle, and the three faces' gradients read there differ
// pairwise by more than the angle. The last test refuses a point beside a curved sharp edge,
// where only two faces meet. Sets `c.ok` false on the rest.
function solveCorners(store, cand, VL, edge, st, tol) {
  let live = cand.slice();
  const judged = [], reads = [], back = [];
  for (let it = 0; it < CORNER_STEPS && live.length; it++) {
    const rs = readCorners(store, live, edge, it === 0);
    if (it === 0) {
      const redo = live.filter((c, q) => !Number.isFinite(rs[q].f));
      for (const c of redo) { c.leaf = VL[c.b]; c.ev = c.b; }
      if (redo.length) {
        const r2 = readCorners(store, redo, edge, true);
        let j = 0;
        live.forEach((c, q) => { if (c === redo[j]) rs[q] = r2[j++]; });
      }
    }
    live = live.filter((c, q) => {
      const s = cornerStep(c, rs[q], edge);
      if (!s) { back.push(c); return false; }
      if (s === "done") { judged.push(c); reads.push(rs[q]); return false; }
      return true;
    });
  }
  if (live.length) {
    const rs = readCorners(store, live, edge, true);
    live.forEach((c, q) => { judged.push(c); reads.push(rs[q]); });
  }
  if (back.length) {
    for (const c of back) { c.p = c.seed.p.slice(); c.u = c.seed.u; c.h = c.seed.h; c.back = true; }
    const rs = readCorners(store, back, edge, true, true);
    back.forEach((c, q) => { judged.push(c); reads.push(rs[q]); });
  }
  // The point itself, for those judged on a read without it.
  const need = judged.filter((c, q) => !Number.isFinite(reads[q].f));
  if (need.length) {
    const d = evalField(store, Float64Array.from(need.flatMap((c) => c.p)), need.map((c) => c.leaf));
    let j = 0;
    judged.forEach((c, q) => { if (c === need[j]) reads[q] = { ...reads[q], f: d[j++] }; });
  }
  judged.forEach((c, q) => {
    const r = reads[q], [uA, uB, uC] = r.S.map((s) => (s ? unit(s.g) : null));
    const dm = hypot3(c.p[0] - c.m[0], c.p[1] - c.m[1], c.p[2] - c.m[2]);
    if (!uA || !uB || !uC || !Number.isFinite(r.f) || (c.back && !atStart(c, r, edge))) { c.ok = false; st.cornerUnsolved++; }
    else if (!(dm <= SHARP_MAX_MOVE * edge)) { c.ok = false; st.cornerFar++; }
    else if (!(Math.abs(r.f) <= tol)) { c.ok = false; st.cornerOffField++; }
    else if (!(dot(uA, uB) < SHARP_ANGLE_COS && dot(uB, uC) < SHARP_ANGLE_COS && dot(uA, uC) < SHARP_ANGLE_COS)) { c.ok = false; st.cornerNotSharp++; }
    else {
      c.n = unit([uA[0] + uB[0] + uC[0], uA[1] + uB[1] + uC[1], uA[2] + uB[2] + uC[2]]);
      if (!c.n) { c.ok = false; st.cornerDet++; }
    }
  });
}

// A corner candidate's tries, in order: an end within CORNER_MERGE·edge of the point is moved
// onto it; the edge is split at the point; the nearer end, then the other, is moved onto it. A
// move takes the corner's normal, is at most SHARP_MAX_MOVE·edge and never moves a held, pinned
// or crease vertex.
export const TRIES = 4;

// The kept corner candidates, committed in order, each by its first try (from `c.from`) that
// makes no flip or sliver, and puts no point within SHARP_APART·edge of another vertex
// (`cornerNear`: that try fails, the next is tried). A point within CORNER_MERGE·edge of an earlier corner point is that
// vertex: nothing more when it is an end of the edge, else the edge is split at it if it is next
// to the edge (the apex of a triangle on it, or the split point of another edge of one), so a
// shared corner never pinches the mesh; a vertex not next to it gets a new one. Returns the
// positions, normals and splits, the candidates that made a vertex (`added`), the vertices made
// corners (`marked`) and, for each changed triangle, the candidates that changed it.
function commitCorners(cand, { P: P1, N: N1, T, ekey, fan, byEdge, free, edge, st, apart: index, work }) {
  // Room for a vertex per candidate, made by the first commit of the loop; `nv` is the count so
  // far. A later commit puts back the vertices the one before moved, in place.
  if (!work.P) {
    const cap = P1.length / 3 + cand.length;
    work.P = new Float64Array(3 * cap); work.N = new Float64Array(3 * cap);
    work.P.set(P1); work.N.set(N1);
  } else for (const v of work.dirty) for (let i = 0; i < 3; i++) { work.P[3 * v + i] = P1[3 * v + i]; work.N[3 * v + i] = N1[3 * v + i]; }
  work.dirty = [];
  const { P, N } = work;
  const apart = index(P);
  let nv = P1.length / 3;
  const splitOf = new Map(), made = [], added = [], marked = [], moved = new Set(), touched = new Map(), cut = [];
  for (const k of ["cornerSplits", "cornerMoves", "cornerFlip", "cornerSliver", "cornerApart", "cornerNear"]) st[k] = 0;
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
    if (apart.has(c.p, v)) { st.cornerNear++; return false; }
    const was = P.slice(3 * v, 3 * v + 3), wn = N.slice(3 * v, 3 * v + 3);
    for (let i = 0; i < 3; i++) { P[3 * v + i] = c.p[i]; N[3 * v + i] = c.n[i]; }
    const bad = checkTris(T, fan.get(v), splitOf, ekey, P, N);
    if (bad) {
      for (let i = 0; i < 3; i++) { P[3 * v + i] = was[i]; N[3 * v + i] = wn[i]; }
      st[bad === "flip" ? "cornerFlip" : "cornerSliver"]++;
      return false;
    }
    moved.add(v); marked.push(v); made.push({ v, p: c.p }); touch(fan.get(v), c); st.cornerMoves++; work.dirty.push(v);
    apart.add(v);
    return true;
  };
  for (const c of cand) {
    if (!c.ok) continue;
    c.took = -1;
    let v = -1;
    for (const q of made) if (d2(q.v, c.p) <= R2) { v = q.v; break; }
    if (v === c.a || v === c.b) { c.took = c.from; continue; }   // already the corner
    // A corner vertex not next to the edge: a new vertex here, or an end moved here, would sit on top of it.
    if (v >= 0 && !nextTo(v, c)) { st.cornerApart++; continue; }
    const near = d2(c.a, c.p) <= d2(c.b, c.p) ? c.a : c.b, far = near === c.a ? c.b : c.a;
    for (let k = c.from; k < TRIES && c.took < 0; k++) {
      if (k === 0) { if (v < 0 && d2(near, c.p) <= R2 && moveTo(near, c)) c.took = k; continue; }
      if (k === 2 || k === 3) { if (v < 0 && moveTo(k === 2 ? near : far, c)) c.took = k; continue; }
      // k === 1: split, at the shared vertex when there is one.
      const fresh = v < 0, key = ekey(c.a, c.b), u = fresh ? nv : v;
      if (fresh && apart.has(c.p, -1)) { st.cornerNear++; continue; }
      if (fresh) for (let i = 0; i < 3; i++) { P[3 * u + i] = c.p[i]; N[3 * u + i] = c.n[i]; }
      splitOf.set(key, u);
      const bad = checkTris(T, byEdge.get(key), splitOf, ekey, P, N);
      if (bad) {
        splitOf.delete(key);
        st[bad === "flip" ? "cornerFlip" : "cornerSliver"]++;
        continue;
      }
      if (fresh) { nv++; made.push({ v: u, p: c.p }); added.push(c); apart.add(u); }
      touch(byEdge.get(key), c); cut.push(...byEdge.get(key)); st.cornerSplits++; c.took = k;
    }
  }
  return { P: P.subarray(0, 3 * nv), N: N.subarray(0, 3 * nv), splitOf, added, marked, touched, cut };
}
