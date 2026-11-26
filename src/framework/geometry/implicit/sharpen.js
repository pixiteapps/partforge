// src/framework/geometry/implicit/sharpen.js
// The sharpen pass (implicit solid design §4). The mesher bevels every sharp edge of the field by
// about a third of a cell. This stage puts a vertex on each one: it is the crease cut's method
// (crease.js: split an edge at a point moved onto a crease) with a different test for where a
// crease is. After cleanup, and after the crease cut on the owner path:
//
//   1. A candidate is a mesh edge whose two ends (neither pinned nor a crease point) have field
//      normals more than SHARP_ANGLE_COS apart. Its start is the point nearest the edge's middle
//      on both ends' tangent planes. A crease point's normal is a bisector, not a field normal.
//      Each edge belongs to the leaf program of its lower end's sparse-grid leaf. When a
//      program's candidates are more than a fifth of its edges (SHARP_DENSE_DIV) and more than
//      SHARP_DENSE_MIN (a texture or facets finer than the grid), none of them is tried. The
//      floor keeps a small part, whose crease share is high but whose cost is small.
//   2. That point is moved onto the field's zero set and the crease of its two sides: Newton,
//      NEWTON_STEPS, within the plane holding the edge and the sum of the two normals. Each side
//      is read SIDE·edge along its own plane, away from the other, so a step sees the two smooth
//      surfaces and not the kink between them. Newton stops at a step under CONVERGED·edge; a
//      candidate whose sides agree within the angle on its first FLAT_READS reads, while its
//      step is not getting shorter, stops as not sharp.
//   3. It is kept if the field there is within SHARP_TOL·edge of zero, it moved at most
//      SHARP_MAX_MOVE·edge from the edge's middle, and the gradients just to each side still
//      differ by more than the angle. The last test refuses a point on a thin wall's other face
//      and a round the grid can resolve.
//   4. A kept point within SHARP_SNAP of an edge end moves that end (once; never a held, pinned or
//      crease vertex); else, or when that move cannot be made, it splits the edge, unless an end
//      of it moved. Moves go first. A change that would make a triangle face against its
//      corners' normals, or one thinner than MIN_ALTITUDE, is dropped; so is one whose
//      triangles, in their final form, face against the field at their centre (read along the
//      normal at FLIP_NEAR·edge and at DIFF·edge), or one whose point is within SHARP_APART·edge
//      of another vertex (two splits on unrelated edges can meet on one ridge point).
//   5. Triangles with one, two or three split edges become 2, 3 or 4 triangles.
//   6. Corners (`corners`, on by default). Each vertex carries its tangent planes: an edge point
//      the two side gradients Newton ended on, through its own position; a mesher vertex its
//      normal; a pinned or crease vertex none. An edge of step 5's mesh with an edge point at one
//      end and exactly three distinct planes between its ends is a candidate, at the point where
//      the three meet, if their determinant is at least SHARP_CORNER_DET and the point is within
//      SHARP_MAX_MOVE·edge of the edge's middle. Candidates within CORNER_MERGE·edge of each
//      other are one corner, at the best one's point. It is kept within SHARP_TOL·edge of the
//      zero set. Then, in order: an end within CORNER_MERGE·edge of it is moved onto it; else the
//      edge is split there (at an earlier corner vertex there, which must be next to the edge:
//      else the candidate is refused, so no two vertices share a position); else its nearer
//      end, then its other end, is moved there. A moved end takes the corner's normal; a held,
//      pinned or crease vertex never moves. Each try is checked as step 4 checks. A triangle
//      left with a repeated vertex is dropped.
//      Then a second corner pass across a vertex (cornerPass `across`): v's planes with those of
//      each edge point across a non-edge-point neighbour u, for corners whose creases' edge points
//      are not side by side. Its points keep within ACROSS_TOL of the field and clear of the
//      first pass's corners, and no corner point moves.
//   7. Steps 4 and 5 once more, on edges with neither end an edge or corner point: a corner in
//      place lets a split through that the bevel beside it refused. The candidates are step 3's
//      kept ones; their ends did not change, so they are not solved again.
// Pure edge splits on a closed manifold keep it closed and oriented; a corner point shared by
// several edges only drops the triangles it collapses. Native-portable arithmetic only
// (js-math.js), for the core port.
import { hypot3 } from "../js-math.js";
import { evalField, dot, det3, unit, adjacency, retriangulate, checkTris, fieldFlips, apartIndex } from "./sharpen-mesh.js";
import { cornerPass } from "./sharpen-corners.js";

// Every constant of the stage, here and in sharpen-corners.js, has a mirror in
// native/implicit_sharpen.cpp; test/implicit-sharpen-native.test.js checks that they agree.
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
/**
 * The density rule: a leaf program is skipped when SHARP_DENSE_DIV times its candidate edges is
 * more than its edges (a share over one fifth) and it has more than SHARP_DENSE_MIN candidates.
 * Measured (design §4): a share of at most 0.122 where real edges are, at least 0.314 on a knurl;
 * small parts reach 0.4 with at most 249 candidates; the smallest dense knurl measured (r 1, h 1.2,
 * at a 0.6 mm grid) has 619, and the r 6, h 8 knob at 1.0 mm has 4,839.
 */
export const SHARP_DENSE_DIV = 5, SHARP_DENSE_MIN = 400;

export const NEWTON_STEPS = 10, STEP_CAP = 0.25, SIDE = 0.02;
/** Difference steps (cells) and the least altitude (mm), shared with sharpen-mesh.js. */
export const DIFF = 0.005, MIN_ALTITUDE = 0.001;
/** The flip test's near step (cells): see fieldFlips. */
export const FLIP_NEAR = 1e-4;
/** A Newton step shorter than this (cells) is not taken: the point has converged. */
export const CONVERGED = 1e-5;
/** Corner points this close (cells) are one vertex. */
export const CORNER_MERGE = 0.05;
/**
 * No change may put a point closer than this (cells) to another vertex (apartIndex): two vertices
 * at one position can weld when the kernel builds the solid. It is 1e-4 mm at a 0.1 mm grid,
 * far above the 1e-6 mm the tests call coincident, and 50 times below CORNER_MERGE.
 */
export const SHARP_APART = 0.001;
// Per side per read: six points, DIFF·edge each way along each axis. Their differences are the
// gradient (central differences); their mean is the side's value.
export const SIDE_PTS = 6;
/** A candidate whose sides agree within the angle on this many reads in a row is not sharp. */
export const FLAT_READS = 3;

// Each side's direction: along its own plane, away from the other plane. `sigma` is +1 on a
// convex edge and −1 on a concave one.
function sides(c) {
  const k = dot(c.uA, c.uB);
  const wA = unit([0, 1, 2].map((i) => -c.sigma * (c.uB[i] - k * c.uA[i])));
  const wB = unit([0, 1, 2].map((i) => -c.sigma * (c.uA[i] - k * c.uB[i])));
  return wA && wB ? [wA, wB] : null;
}

// One read for every candidate: each side's value and gradient, and with `withCentre` the field at
// the point itself (else `f` is NaN).
function readSides(store, cand, edge, withCentre) {
  const per = SIDE_PTS, c0 = withCentre ? 1 : 0, PTS = 2 * per + c0;
  const h = SIDE * edge, e = DIFF * edge, pts = new Float64Array(3 * PTS * cand.length), lf = [];
  cand.forEach((c, q) => {
    c.w = sides(c);
    const [x, y, z] = c.p, o = 3 * PTS * q;
    if (withCentre) { pts[o] = x; pts[o + 1] = y; pts[o + 2] = z; }
    for (let s = 0; s < 2; s++) {
      const w = c.w ?? [[0, 0, 0], [0, 0, 0]], sx = x + h * w[s][0], sy = y + h * w[s][1], sz = z + h * w[s][2];
      pts.set([sx + e, sy, sz, sx - e, sy, sz, sx, sy + e, sz, sx, sy - e, sz, sx, sy, sz + e, sx, sy, sz - e], o + 3 * (c0 + per * s));
    }
    for (let k = 0; k < PTS; k++) lf.push(c.leaf);
  });
  const d = evalField(store, pts, lf);
  return cand.map((c, q) => {
    const o = PTS * q, side = (s) => {
      const b = o + c0 + per * s, f0 = d[b], f1 = d[b + 1], f2 = d[b + 2], f3 = d[b + 3], f4 = d[b + 4], f5 = d[b + 5];
      return { f: (f0 + f1 + f2 + f3 + f4 + f5) / 6, g: [(f0 - f1) / (2 * e), (f2 - f3) / (2 * e), (f4 - f5) / (2 * e)] };
    };
    return { f: withCentre ? d[o] : NaN, A: side(0), B: side(1) };
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
  c.lastLen = c.len ?? Infinity; c.len = len;
  const done = len <= CONVERGED * edge, sc = len > STEP_CAP * edge ? (STEP_CAP * edge) / len : 1;
  if (!done) for (let k = 0; k < 3; k++) c.p[k] += dx[k] * sc;
  const uA = unit(A.g), uB = unit(B.g);
  if (uA && uB) { c.uA = uA; c.uB = uB; }
  return done ? "done" : true;
}

// Steps 2 and 3 for every candidate: Newton onto the crease, then the judge. Each read is one
// batch for all live candidates. A candidate is evaluated with its first end's leaf program, or its
// other end's when the first gives a non-finite value at its start (read again with that one). A
// candidate whose step is under CONVERGED·edge stops and is judged on that read; the rest are
// judged on one more read after NEWTON_STEPS. One whose sides agree within the angle on each of
// its first FLAT_READS reads, and whose Newton step on the last of them is not shorter than the
// one before, stops there as not sharp: it is not closing on a crease. This changes no kept point
// on any measured case (design §4). Only the first read and the judge read the point itself. Sets
// `c.solved` on each that passes.
function solve(store, cand, VL0, edge, st) {
  let live = cand.filter((c) => c.ok);
  const judged = [], reads = [];
  const agree = (r) => { const gA = unit(r.A.g), gB = unit(r.B.g); return !gA || !gB || dot(gA, gB) >= SHARP_ANGLE_COS; };
  for (let it = 0; it < NEWTON_STEPS && live.length; it++) {
    const rs = readSides(store, live, edge, it === 0);
    if (it === 0) {
      const redo = live.filter((c, q) => !Number.isFinite(rs[q].f));
      for (const c of redo) { c.leaf = VL0[c.b]; c.ev = c.b; }
      if (redo.length) {
        const r2 = readSides(store, redo, edge, true);
        let j = 0;
        live.forEach((c, q) => { if (c === redo[j]) rs[q] = r2[j++]; });
      }
    }
    live = live.filter((c, q) => {
      if (it < FLAT_READS && agree(rs[q])) c.flat = (c.flat ?? 0) + 1;
      const s = c.w ? newtonStep(c, rs[q], edge) : false;
      if (!s) { c.ok = false; return false; }
      if (s === "done") { judged.push(c); reads.push(rs[q]); return false; }
      // Flat on every one of its first FLAT_READS reads, and Newton's step is not getting shorter.
      if (it === FLAT_READS - 1 && c.flat === FLAT_READS && !(c.len < c.lastLen)) {
        c.ok = false; judged.push(c); reads.push(null); return false;
      }
      return true;
    });
  }
  if (live.length) {
    const rs = readSides(store, live, edge, true);
    live.forEach((c, q) => { judged.push(c); reads.push(rs[q]); });
  }
  // The point itself, for those judged on a read without it.
  const need = judged.filter((c, q) => reads[q] && !Number.isFinite(reads[q].f) && c.ok);
  if (need.length) {
    const d = evalField(store, Float64Array.from(need.flatMap((c) => c.p)), need.map((c) => c.leaf));
    const at = new Map(need.map((c, q) => [c, d[q]]));
    judged.forEach((c, q) => { if (at.has(c)) reads[q] = { ...reads[q], f: at.get(c) }; });
  }
  judged.forEach((c, q) => {
    if (!reads[q]) { st.notSharp++; return; }
    const r = reads[q], gA = unit(r.A.g), gB = unit(r.B.g), dm = hypot3(c.p[0] - c.m[0], c.p[1] - c.m[1], c.p[2] - c.m[2]);
    if (!c.w || !Number.isFinite(r.f) || !gA || !gB) { c.ok = false; st.unsolved++; }
    else if (!(dm <= SHARP_MAX_MOVE * edge)) { c.ok = false; st.tooFar++; }
    else if (!(Math.abs(r.f) <= SHARP_TOL * edge)) { c.ok = false; st.offField++; }
    else if (!(dot(gA, gB) < SHARP_ANGLE_COS)) { c.ok = false; st.notSharp++; }
    else c.solved = true;
  });
  st.unsolved += cand.length - judged.length;
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
 * candidates' counts by outcome (`dense`: skipped by the density rule), and step 7's in
 * `stats.again`, the second corner pass's in `stats.across`. Step 7 solves nothing, so there `candidates` is the retried count and the solve
 * outcomes (`dense`, `offField`, `tooFar`, `notSharp`, `unsolved`) are always 0.
 */
export function sharpenMesh(store, mesh, { corners = true, stats = null } = {}) {
  return sharpenRound(store, mesh, corners, stats ?? {}, null);
}

// One edge round (steps 1 to 5), then with `corners` the corner pass and step 7. `retry` is
// null for the first round. In step 7 it is the first round's candidates that passed the judge:
// an edge whose ends neither moved nor became edge or corner points has the same ends, normals
// and leaf as before, so its solve gives the same point, and it is not solved again. Only the
// commit can come out differently.
function sharpenRound(store, mesh, corners, st, retry) {
  const edge = store.edge, N0 = mesh.normals, P0 = mesh.positions, T = mesh.indices, VL0 = mesh.vertLeaf, nv0 = P0.length / 3;
  const pinned = (v) => (mesh.pinned ? mesh.pinned[v] : 0), creased = (v) => (mesh.crease ? mesh.crease[v] : 0);
  const prior = (v) => (mesh.sharp ? mesh.sharp[v] : 0);
  const normal = (v) => [N0[3 * v], N0[3 * v + 1], N0[3 * v + 2]], pos = (v) => [P0[3 * v], P0[3 * v + 1], P0[3 * v + 2]];
  for (const name of ["candidates", "dense", "split", "moved", "offField", "tooFar", "notSharp", "unsolved"]) st[name] = 0;
  for (const name of ["snapBlocked", "endMoved", "flip", "sliver", "fieldFlip", "apart"]) st[name] = 0;
  for (const name of ["cornerCandidates", "corners", "cornerSplits", "cornerDet", "cornerFar", "cornerOffField"]) st[name] = 0;
  for (const name of ["cornerMoves", "cornerFlip", "cornerSliver", "cornerFieldFlip", "cornerNear"]) st[name] = 0;

  // 1. The candidate edges, in the order the triangle list first names them. The first round
  // tests every edge's angle before it builds anything else, so a mesh with no sharp edge costs
  // one pass over its triangles; step 7 with nothing to retry costs nothing.
  if (retry && !retry.length) return mesh;
  let hits = null, lens = null;
  if (!retry) {
    // The angle test first, on the raw normals: it refuses most edges. `hits` holds the index in
    // T of each half-edge that passes (t + k), in triangle order.
    // Each normal's length is taken once per vertex.
    hits = [];
    const PIN = mesh.pinned, CR = mesh.crease, PR = mesh.sharp;
    lens = new Float64Array(nv0);
    for (let v = 0; v < nv0; v++) lens[v] = hypot3(N0[3 * v], N0[3 * v + 1], N0[3 * v + 2]);
    for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = T[t + k], b = T[t + (k + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a;
      if ((PIN && (PIN[lo] || PIN[hi])) || (CR && (CR[lo] || CR[hi])) || (PR && (PR[lo] || PR[hi]))) continue;
      const x = 3 * lo, y = 3 * hi, lA = lens[lo], lB = lens[hi];
      if (!(lA > 0.5 && lB > 0.5) || N0[x] * N0[y] + N0[x + 1] * N0[y + 1] + N0[x + 2] * N0[y + 2] >= SHARP_ANGLE_COS * lA * lB) continue;
      hits.push(t + k);
    }
    if (!hits.length) return mesh;
  }
  const adj = adjacency(T, nv0);
  let cand = [];
  // PORTED: lo·nv0 + hi is exact in a JS double (below 2^53); the core needs a 64-bit integer key.
  const again = retry ? new Map(retry.map((c) => [c.a * nv0 + c.b, c])) : null;
  // The density rule: each edge belongs to the leaf program of its lower end's sparse-grid leaf.
  const nProg = 1 + store.leaves.reduce((m, L) => (L.progIndex > m ? L.progIndex : m), -1);
  const progOf = (v) => store.leaves[VL0[v]].progIndex, progEdges = new Int32Array(nProg), progCand = new Int32Array(nProg);
  if (!again) {
    const progV = new Int32Array(nv0);
    for (let v = 0; v < nv0; v++) progV[v] = progOf(v);
    for (let i = 0; i < T.length; i++) {
      const a = T[i], b = T[i - (i % 3) + (i % 3 + 1) % 3];
      if (a < b) progEdges[progV[a]]++;   // a closed mesh names each edge once in each direction
    }
  }
  if (again) {
    // Step 7 looks only at its own edges: each where a scan of the triangle list would first find
    // it (the first triangle holding both ends, the place in it), in that order.
    const at = [];
    for (const [key, c] of again) {
      const lo = c.a, hi = c.b;
      if (pinned(lo) || pinned(hi) || creased(lo) || creased(hi) || prior(lo) || prior(hi)) continue;
      const tris = adj.byEdge.get(key);
      if (!tris.length) continue;
      const t = 3 * tris[0];
      for (let k = 0; k < 3; k++) {
        const a = T[t + k], b = T[t + (k + 1) % 3];
        if ((a === lo && b === hi) || (a === hi && b === lo)) at.push([t + k, c]);
      }
    }
    at.sort((x, y) => x[0] - y[0]);
    for (const [, c] of at) { c.ok = true; cand.push(c); }
  }
  if (!again) for (const i of hits) {
    const t = i - (i % 3), a = T[i], b = T[t + (i % 3 + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a;
    const lA = lens[lo], lB = lens[hi];
    if (!adj.first(t / 3, lo, hi)) continue;
    progCand[progOf(lo)]++;
    const nA = normal(lo), nB = normal(hi);
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
  if (!again) {
    // A program with many candidates that are more than a fifth of its edges is a texture or
    // facets finer than the grid: none of its candidates is tried.
    const dense = (c) => {
      const n = progCand[progOf(c.a)];
      return SHARP_DENSE_DIV * n > progEdges[progOf(c.a)] && n > SHARP_DENSE_MIN;
    };
    st.dense = cand.filter(dense).length;
    if (st.dense) cand = cand.filter((c) => !dense(c));
  }
  if (!cand.length) return mesh;
  st.candidates = cand.length;
  if (!retry) solve(store, cand, VL0, edge, st);

  // 4. Commit, in candidate order. Each change is checked on the triangles it makes, against the
  // state so far (the sum of their corners' normals, and MIN_ALTITUDE). Then every changed
  // triangle's final form is read against the field's gradient at its centre, and the candidates
  // that changed one facing against it are dropped and the commit run again. Each new round
  // drops at least one kept candidate, so the loop ends.
  const ekey = (a, b) => (a < b ? a * nv0 + b : b * nv0 + a);
  const { fan, byEdge } = adj;
  const free = (v) => !(mesh.ownerHeld?.[v]) && !pinned(v) && !creased(v);
  let S;
  const flipMemo = new Map(), apart = apartIndex(P0, nv0, edge, cand.filter((c) => c.ok).map((c) => c.p)), work = {};
  for (;;) {
    S = commit(cand, { P0, N0, T, nv0, ekey, fan, byEdge, free, st, mesh, apart, work });
    const flipped = fieldFlips(store, S, [...S.touched.keys()], { VL0, T, ekey, edge }, flipMemo);
    if (!flipped.length) break;
    for (const t of flipped) for (const c of S.touched.get(t)) if (c.ok) { c.ok = false; st.fieldFlip++; }
  }
  const { splitOf, planeN, added } = S;
  let { P, N } = S;

  // 5. Re-triangulate (only the triangles on a split edge change). A new vertex takes its
  // evaluating end's leaf and owner.
  let out = retriangulate(T, S.cut, splitOf, ekey);
  // The candidates that made a vertex, in vertex order; the leaf table so far.
  const grown = [...added];
  const leaves = () => {
    const r = new Int32Array(nv0 + grown.length);
    r.set(VL0);
    for (let i = 0; i < grown.length; i++) r[nv0 + i] = grown[i].leaf;
    return r;
  };
  // 6. Corners, on step 5's mesh.
  const nv1 = P.length / 3;
  const marked = [];
  // The edge points for the corner passes: those of an earlier round (a mesh given with `sharp`),
  // then this commit's. The corner points of an earlier round.
  const pts = [], had = [];
  if (mesh.sharp) for (let v = 0; v < nv0; v++) { if (mesh.sharp[v] === 1) pts.push(v); else if (mesh.sharp[v] === 2) had.push(v); }
  pts.push(...S.pts);
  // The `sharp` table for the current vertices: step 5's, then 2 for every corner point so far.
  const sharpNow = () => {
    const r = new Uint8Array(P.length / 3).fill(2, nv1);
    r.set(S.sharp);
    for (const v of marked) r[v] = 2;
    return r;
  };
  if (corners) {
    const noPlane = (v) => v < nv0 && (pinned(v) || creased(v));
    const C = cornerPass(store, { P, N, T: out, VL: leaves(), P0, N0, sharp: S.sharp, planeN, noPlane, free, edge, st, pts });
    ({ out, P, N } = C);
    marked.push(...C.marked);
    grown.push(...C.added);
    // 6b. Corners across a bevel vertex, where the first pass made none (see cornerPass). A
    // corner point made so far never moves.
    const sh = sharpNow(), nvC = P.length / 3, have = [...had, ...C.marked];
    for (let v = nv1; v < nvC; v++) have.push(v);
    st.across = {};
    for (const name of ["cornerCandidates", "corners", "cornerDet", "cornerFar", "cornerOffField", "cornerFieldFlip", "cornerNear"]) st.across[name] = 0;
    const D = cornerPass(store, { P, N, T: out, VL: leaves(), P0, N0, sharp: sh, planeN, noPlane, free: (v) => free(v) && sh[v] !== 2,
      edge, st: st.across, across: true, pts: pts.filter((v) => sh[v] === 1), have });
    ({ out, P, N } = D);
    marked.push(...D.marked);
    grown.push(...D.added);
    st.corners += st.across.corners;
  }
  const nvF = P.length / 3, sharp = sharpNow(), planes = new Int32Array(2 * nvF).fill(-1);
  planes.set(S.planes);
  for (const v of marked) { planes[2 * v] = -1; planes[2 * v + 1] = -1; }
  const res = {
    ...mesh, positions: P.slice(), normals: N.slice(), indices: out, vertLeaf: leaves(), sharp, sharpPlanes: planes,
  };
  // The owner fields: a new vertex takes its evaluating end's owner, and 0 for the rest.
  for (const f of ["vertOwner", "ownerHeld", "pinned", "crease"]) {
    if (!mesh[f]) continue;
    const r = f === "vertOwner" ? new Int32Array(nvF) : new Uint8Array(nvF);
    r.set(mesh[f]);
    if (f === "vertOwner") for (let i = 0; i < grown.length; i++) r[nv0 + i] = r[grown[i].ev];
    res[f] = r;
  }
  // 7. One more edge round, on edges with neither end an edge or corner point.
  if (corners) { st.again = {}; return sharpenRound(store, res, false, st.again, cand.filter((c) => c.solved)); }
  return res;
}

// The kept candidates (c.ok), committed in order: every move, then every split on an edge with
// neither end moved. A change whose point is within SHARP_APART·edge of another vertex (old, or
// placed by this commit so far) is refused (`apart`): the earlier candidate keeps its place. Returns the positions, normals, splits, the
// `sharp` and `sharpPlanes` tables, the split candidates in vertex order (`added`), and for each
// changed triangle the candidates that changed it (`touched`) and what each did (`how`: the moved
// end, or −1 for a split).
function commit(cand, { P0, N0, T, nv0, ekey, fan, byEdge, free, st, mesh, apart: index, work }) {
  const kept = cand.filter((c) => c.ok);
  // Room for a vertex per kept candidate, made by the first commit of the loop (a later one keeps
  // fewer); `nv` is the count so far. A later commit puts back the ends the one before moved, in
  // place. `planeN` maps each edge point to its two plane normals (the side gradients Newton ended
  // on), six numbers; a vertex with no entry has none (0).
  if (!work.P) {
    const cap = nv0 + kept.length;
    work.P = new Float64Array(3 * cap); work.N = new Float64Array(3 * cap); work.moved = new Uint8Array(nv0);
    work.P.set(P0); work.N.set(N0);
    work.sharp = new Uint8Array(cap); work.planes = new Int32Array(2 * cap).fill(-1); work.planeN = new Map();
    if (mesh.sharp) { work.sharp.set(mesh.sharp); work.planes.set(mesh.sharpPlanes); }
  } else for (const v of work.dirty) {
    for (let i = 0; i < 3; i++) work.P[3 * v + i] = P0[3 * v + i];
    work.planeN.delete(v);
    work.moved[v] = 0;
    work.sharp[v] = mesh.sharp ? mesh.sharp[v] : 0;
    work.planes[2 * v] = mesh.sharp ? mesh.sharpPlanes[2 * v] : -1; work.planes[2 * v + 1] = mesh.sharp ? mesh.sharpPlanes[2 * v + 1] : -1;
  }
  work.dirty = [];
  const { P, N, moved, sharp, planes, planeN } = work, splitOf = new Map();
  const apart = index(P);
  let nv = nv0;
  const added = [], touched = new Map(), how = new Map(), cut = [], pts = [];
  const setPlanes = (v, c) => { planeN.set(v, [c.uA[0], c.uA[1], c.uA[2], c.uB[0], c.uB[1], c.uB[2]]); };
  for (const k of ["split", "moved", "endMoved", "snapBlocked", "flip", "sliver", "apart"]) st[k] = 0;
  const check = (tris) => checkTris(T, tris, splitOf, ekey, P, N);
  const touch = (tris, c, v) => {
    for (const t of tris) { (touched.get(t) ?? touched.set(t, []).get(t)).push(c); (how.get(t) ?? how.set(t, []).get(t)).push(v); }
  };
  // Which end each kept candidate moves (−1: it splits), from the original positions.
  const endOf = (c) => {
    const ax = P0[3 * c.a], ay = P0[3 * c.a + 1], az = P0[3 * c.a + 2];
    const ux = P0[3 * c.b] - ax, uy = P0[3 * c.b + 1] - ay, uz = P0[3 * c.b + 2] - az;
    const s = ((c.p[0] - ax) * ux + (c.p[1] - ay) * uy + (c.p[2] - az) * uz) / (ux * ux + uy * uy + uz * uz);
    return s < SHARP_SNAP ? c.a : s > 1 - SHARP_SNAP ? c.b : -1;
  };
  const ends = kept.map(endOf);
  // Moves first, as crease.js does: a split is then never beside an end that moves after it.
  kept.forEach((c, q) => {
    const end = ends[q];
    if (end < 0) return;
    if (moved[c.a] || moved[c.b]) { st.endMoved++; return; }
    // A move that cannot be made is tried as a split below.
    if (!free(end)) { st.snapBlocked++; ends[q] = -1; return; }
    if (apart.has(c.p, end)) { st.apart++; return; }   // not tried as a split either: same point
    const was = [P[3 * end], P[3 * end + 1], P[3 * end + 2]];
    P[3 * end] = c.p[0]; P[3 * end + 1] = c.p[1]; P[3 * end + 2] = c.p[2];
    const bad = check(fan.get(end));
    if (bad) { P[3 * end] = was[0]; P[3 * end + 1] = was[1]; P[3 * end + 2] = was[2]; st[bad]++; ends[q] = -1; return; }
    // The moved end keeps its normal: the crease point is on its own plane too.
    moved[end] = 1; sharp[end] = 1; planes[2 * end] = c.a; planes[2 * end + 1] = c.b; setPlanes(end, c); st.moved++;
    apart.add(end); pts.push(end); work.dirty.push(end);
    touch(fan.get(end), c, end);
  });
  // Then splits, on edges with neither end moved.
  kept.forEach((c, q) => {
    if (ends[q] >= 0) return;
    if (moved[c.a] || moved[c.b]) { st.endMoved++; return; }
    if (apart.has(c.p, -1)) { st.apart++; return; }
    const v = nv, key = ekey(c.a, c.b);
    const n = unit([0, 1, 2].map((i) => N0[3 * c.a + i] + N0[3 * c.b + i])) ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) { P[3 * v + i] = c.p[i]; N[3 * v + i] = n[i]; }
    splitOf.set(key, v);
    const bad = check(byEdge.get(key));
    if (bad) { splitOf.delete(key); st[bad]++; return; }   // v is not counted: the next split writes over it
    nv++; sharp[v] = 1; planes[2 * v] = c.a; planes[2 * v + 1] = c.b; setPlanes(v, c); added.push(c);
    apart.add(v); pts.push(v);
    touch(byEdge.get(key), c, -1);
    cut.push(...byEdge.get(key));
    st.split++;
  });
  return { P: P.subarray(0, 3 * nv), N: N.subarray(0, 3 * nv), splitOf, sharp: sharp.subarray(0, nv), planes: planes.subarray(0, 2 * nv),
    planeN, added, touched, how, cut, pts };
}
