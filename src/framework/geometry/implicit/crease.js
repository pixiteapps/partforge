// src/framework/geometry/implicit/crease.js
// The crease cut (seam spec §5), then untangling. After cleanup, each mesh edge whose ends belong
// to different pieces is cut where the two pieces' shares are equal, at a point moved onto the
// crease (field = 0 and the two shares equal). Pure edge splits on a closed manifold keep it
// closed and oriented; placing crease points directly instead is what shed stray shards in the
// spike.
//
//   1. Re-own: a free vertex (not held, not pinned) takes the piece at its final position
//      (evalBatchContact's `piece`). Held and pinned vertices keep the owner the mesher gave them.
//   2. Each edge with differing owners and neither end pinned is solved for s_X − s_Y = 0
//      (bracket.js: the Illinois method, the bracket kept, BRACKET_TOL of the edge).
//   3. That point is taken onto the crease — s_X = 0 and s_X = s_Y, within the plane holding the
//      edge and its normal (Newton, NEWTON_STEPS, each move capped at MAX_MOVE_CELLS·edge) — and
//      kept only if it reaches it: on the surface, the two shares equal and making the field (no
//      third piece nearer), all within CREASE_TOL·edge, outside the pair's attachment. A near
//      miss has no crease, so its edges stay as they were.
//   4. A kept point within CREASE_SNAP of an edge end moves that end (once); else it splits the edge.
//   5. Triangles with one, two or three split edges become 2, 3 or 4 triangles.
// Crease vertices are neither held nor pinned. untangle (below) then repairs triangles that face
// into the material. The native core runs the same cut (native/implicit_owner.cpp's crease
// stage, bit-identical: test/core-parity.test.js).
import { evalBatchContact } from "./program.js";
import { hypot3 } from "../js-math.js";
import { CREASE_SNAP, CREASE_TOL, ATTACH_STRIDE, attachWeight } from "./contact.js";
import { solveBrackets } from "./bracket.js";

const SOLVE_STEPS = 40, NEWTON_STEPS = 10, MAX_MOVE_CELLS = 0.25;

// The field, piece and every child's share at the points, each evaluated with its leaf's program.
function evalPoints(store, K, pts, leafOf) {
  const n = pts.length / 3, d = new Float64Array(n), owner = new Int32Array(n).fill(-1), shares = new Float64Array(n * K).fill(Infinity);
  const groups = new Map();
  for (let q = 0; q < n; q++) {
    const g = groups.get(leafOf[q]);
    if (g) g.push(q); else groups.set(leafOf[q], [q]);
  }
  for (const [L, qs] of groups) {
    const m = qs.length, X = new Float64Array(m), Y = new Float64Array(m), Z = new Float64Array(m);
    const out = new Float64Array(m), o = new Int32Array(m), c = new Float64Array(m * K);
    qs.forEach((q, i) => { X[i] = pts[3 * q]; Y[i] = pts[3 * q + 1]; Z[i] = pts[3 * q + 2]; });
    evalBatchContact(store.leaves[L].prog, store.textures, X, Y, Z, out, { K, piece: o, shares: c });
    qs.forEach((q, i) => {
      d[q] = out[i]; owner[q] = o[i];
      for (let j = 0; j < K; j++) shares[q * K + j] = c[i * K + j];
    });
  }
  return { d, owner, shares };
}

// The largest attachment weight, at (x, y, z), of an attachment joining pieces X and Y (0 if none).
function pairWeight(att, X, Y, x, y, z) {
  let w = 0;
  for (let o = 0; o < att.length; o += ATTACH_STRIDE) {
    if ((att[o] === X && att[o + 1] === Y) || (att[o] === Y && att[o + 1] === X)) w = Math.max(w, attachWeight(att, o, x, y, z));
  }
  return w;
}

/**
 * Cut the creases into an owner mesh (`vertOwner`, `ownerHeld`, `pinned`, `vertLeaf`, `normals`).
 * `att` is the contact node's WORLD-space attachment table (`attWorld`: the mesh is in world space,
 * while `att` holds the anchors in the node's frame): no crease is cut where the crossing pair's
 * own attachment weight is above 0. Returns the mesh with every per-vertex array grown to the new
 * vertices and `crease` set.
 */
export function cutCreases(store, mesh, att = new Float64Array(0)) {
  const K = Math.max(1, store.ownerK ?? 0), edge = store.edge;
  const P = Array.from(mesh.positions), N = Array.from(mesh.normals), T = Array.from(mesh.indices);
  const VL = Array.from(mesh.vertLeaf), VO = Array.from(mesh.vertOwner), VH = Array.from(mesh.ownerHeld), VP = Array.from(mesh.pinned);
  const nv0 = P.length / 3;
  const isFree = (v) => !VH[v] && !VP[v];
  const cuttable = (v) => !VP[v];   // a pinned vertex sits on a gap face and never moves

  // 1. Re-own the free vertices.
  const at0 = evalPoints(store, K, Float64Array.from(P), VL);
  for (let v = 0; v < nv0; v++) if (isFree(v) && at0.owner[v] >= 0) VO[v] = at0.owner[v];

  // The edges whose ends (neither pinned) differ in owner.
  const cross = new Map();
  for (let t = 0; t < T.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = T[t + k], b = T[t + (k + 1) % 3];
      if (VO[a] === VO[b] || !cuttable(a) || !cuttable(b)) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * nv0 + hi;
      if (!cross.has(key)) cross.set(key, { a: lo, b: hi, X: VO[lo], Y: VO[hi] });
    }
  }
  const list = [...cross.values()];

  // 2. Where on each edge the two shares are equal.
  const along = (e, s) => [0, 1, 2].map((k) => P[3 * e.a + k] + (P[3 * e.b + k] - P[3 * e.a + k]) * s);
  // Each edge is evaluated with one leaf's program: its first end's, unless that program pruned
  // either piece at the edge's middle (an edge can span two leaves), then its other end's.
  const leafOfEdge = list.map((e) => VL[e.a]);
  if (list.length) {
    const { shares } = evalPoints(store, K, Float64Array.from(list.flatMap((e) => along(e, 0.5))), leafOfEdge);
    list.forEach((e, q) => { if (!Number.isFinite(shares[q * K + e.X]) || !Number.isFinite(shares[q * K + e.Y])) leafOfEdge[q] = VL[e.b]; });
  }
  // s_X − s_Y along each edge (NaN, a pruned share, reads as the high side).
  const params = solveBrackets(list.length, SOLVE_STEPS, (lanes, ts, c, g) => {
    const pts = new Float64Array(3 * c), lf = new Array(c);
    for (let k = 0; k < c; k++) { pts.set(along(list[lanes[k]], ts[k]), 3 * k); lf[k] = leafOfEdge[lanes[k]]; }
    const { shares } = evalPoints(store, K, pts, lf);
    for (let k = 0; k < c; k++) { const e = list[lanes[k]]; g[k] = shares[k * K + e.X] - shares[k * K + e.Y]; }
  });
  // A crease point moves within the plane holding its edge and the edge's surface normal: the
  // crease crosses that plane once, so neighbouring points keep their order along the crease.
  const planeFor = (e) => {
    const ux = P[3 * e.b] - P[3 * e.a], uy = P[3 * e.b + 1] - P[3 * e.a + 1], uz = P[3 * e.b + 2] - P[3 * e.a + 2];
    const nx = N[3 * e.a] + N[3 * e.b], ny = N[3 * e.a + 1] + N[3 * e.b + 1], nz = N[3 * e.a + 2] + N[3 * e.b + 2];
    const px = uy * nz - uz * ny, py = uz * nx - ux * nz, pz = ux * ny - uy * nx, pl = Math.sqrt(px * px + py * py + pz * pz);
    return pl > 1e-9 * (ux * ux + uy * uy + uz * uz + 1) ? [px / pl, py / pl, pz / pl] : null;
  };
  // 3. Each crossing (not where its pair is attached) is taken onto the crease before anything is
  //    cut: s_X = 0 and s_X = s_Y, within its plane (Newton, NEWTON_STEPS, each move capped at
  //    MAX_MOVE_CELLS·edge). Only crossings that reach a real crease are cut, so a near miss
  //    (no crease) leaves its edges as they were.
  const cand = [];
  list.forEach((e, q) => {
    const p = along(e, params[q]);
    if (!(pairWeight(att, e.X, e.Y, p[0], p[1], p[2]) > 0)) cand.push({ e, q, p0: p, p: p.slice(), pn: planeFor(e), leaf: leafOfEdge[q] });
  });
  const h = 0.02 * edge, cap = MAX_MOVE_CELLS * edge;
  const det3 = (a, b, c) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  const solve = (cand) => {
  for (let it = 0; it < NEWTON_STEPS && cand.length; it++) {
    const pts = new Float64Array(21 * cand.length), lf = [];
    cand.forEach((c, q) => {
      const [x, y, z] = c.p;
      pts.set([x, y, z, x + h, y, z, x - h, y, z, x, y + h, z, x, y - h, z, x, y, z + h, x, y, z - h], 21 * q);
      for (let k = 0; k < 7; k++) lf.push(c.leaf);
    });
    const { shares } = evalPoints(store, K, pts, lf);
    cand.forEach((c, q) => {
      const { X, Y } = c.e;
      // s_X = 0 and s_X = s_Y: both rows smooth (the field, their minimum, kinks at the crease itself).
      const F = (k) => { const o = 7 * q + k; return [shares[o * K + X], shares[o * K + X] - shares[o * K + Y]]; };
      const F0 = F(0), Fp = [F(1), F(3), F(5)], Fm = [F(2), F(4), F(6)];
      const [ja, jb] = [0, 1].map((r) => [0, 1, 2].map((ax) => (Fp[ax][r] - Fm[ax][r]) / (2 * h)));
      let dx = null;
      if (c.pn) {   // s_X = 0, s_X = s_Y and the plane: a 3×3 solve (Cramer's rule)
        const pn = c.pn, r2 = -((c.p[0] - c.p0[0]) * pn[0] + (c.p[1] - c.p0[1]) * pn[1] + (c.p[2] - c.p0[2]) * pn[2]);
        const D = det3(ja, jb, pn), scale = Math.sqrt((ja[0] * ja[0] + ja[1] * ja[1] + ja[2] * ja[2]) * (jb[0] * jb[0] + jb[1] * jb[1] + jb[2] * jb[2]));
        if (Math.abs(D) > 1e-6 * scale) {
          const rhs = [-F0[0], -F0[1], r2], rows = [ja, jb, pn];
          dx = [0, 1, 2].map((k) => { const R = rows.map((row, i) => row.map((x, j) => (j === k ? rhs[i] : x))); return det3(R[0], R[1], R[2]) / D; });
        }
      }
      if (dx === null) {   // no plane, or the crease runs within it: the minimal-norm step
        const aa = ja[0] * ja[0] + ja[1] * ja[1] + ja[2] * ja[2], bb = jb[0] * jb[0] + jb[1] * jb[1] + jb[2] * jb[2], ab = ja[0] * jb[0] + ja[1] * jb[1] + ja[2] * jb[2];
        const det = aa * bb - ab * ab;
        if (!(det > 1e-12)) return;
        const l0 = (-F0[0] * bb + F0[1] * ab) / det, l1 = (-F0[1] * aa + F0[0] * ab) / det;
        dx = [0, 1, 2].map((k) => ja[k] * l0 + jb[k] * l1);
      }
      const len = Math.sqrt(dx[0] * dx[0] + dx[1] * dx[1] + dx[2] * dx[2]);
      if (!Number.isFinite(len)) return;
      const sc = len > cap ? cap / len : 1;
      for (let k = 0; k < 3; k++) c.p[k] += dx[k] * sc;
    });
  }
  };
  // A crease point is on the surface, with the two shares equal and making the field there (no
  // third piece nearer), all to within CREASE_TOL·edge, and outside the pair's attachment.
  const judge = (cand) => {
    const ok = new Uint8Array(cand.length);
    if (!cand.length) return ok;
    const { d, shares } = evalPoints(store, K, Float64Array.from(cand.flatMap((c) => c.p)), cand.map((c) => c.leaf));
    const tol = CREASE_TOL * edge;
    cand.forEach((c, q) => {
      const { X, Y } = c.e;
      ok[q] = Math.abs(d[q]) <= tol && Math.abs(shares[q * K + X] - shares[q * K + Y]) <= tol && Math.abs(shares[q * K + X] - d[q]) <= tol
        && !(pairWeight(att, X, Y, c.p[0], c.p[1], c.p[2]) > 0) ? 1 : 0;
    });
    return ok;
  };
  solve(cand);
  const reached = judge(cand);
  // A crossing the planar solve could not bring onto the crease (the crease nearly within its
  // plane, at a piece's silhouette) is tried again from its start without the plane.
  const retry = [];
  cand.forEach((c, q) => { if (!reached[q] && c.pn) { c.p = c.p0.slice(); c.pn = null; retry.push(q); } });
  if (retry.length) {
    const sub = retry.map((q) => cand[q]);
    solve(sub);
    const ok = judge(sub);
    retry.forEach((q, i) => { reached[q] = ok[i]; });
  }
  // 4. Cut: a crease point within CREASE_SNAP of an edge end moves that end (once), else it
  //    splits the edge (not beside a moved end).
  const crease = [], snapped = new Set();
  for (let v = 0; v < nv0; v++) crease.push(0);
  cand.forEach((c, q) => {
    if (!reached[q]) return;
    const s = params[c.q], v = s < CREASE_SNAP ? c.e.a : s > 1 - CREASE_SNAP ? c.e.b : -1;
    if (v < 0 || snapped.has(v)) return;
    snapped.add(v); crease[v] = 1; VH[v] = 0;
    P[3 * v] = c.p[0]; P[3 * v + 1] = c.p[1]; P[3 * v + 2] = c.p[2];
  });
  const splitOf = new Map();
  cand.forEach((c, q) => {
    const s = params[c.q], e = c.e;
    if (!reached[q] || s < CREASE_SNAP || s > 1 - CREASE_SNAP || snapped.has(e.a) || snapped.has(e.b)) return;
    const v = P.length / 3;
    P.push(...c.p); VL.push(VL[e.a]); VO.push(VO[e.a]); VH.push(0); VP.push(0); crease.push(1);
    const nx = N[3 * e.a] + N[3 * e.b], ny = N[3 * e.a + 1] + N[3 * e.b + 1], nz = N[3 * e.a + 2] + N[3 * e.b + 2], nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    N.push(nx / nl, ny / nl, nz / nl);
    splitOf.set(e.a * nv0 + e.b, v);
  });

  // 5. Re-triangulate by how many of a triangle's edges were split.
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
  return {
    ...mesh, positions: Float64Array.from(P), normals: Float64Array.from(N), indices: Uint32Array.from(out), vertLeaf: Int32Array.from(VL),
    vertOwner: Int32Array.from(VO), ownerHeld: Uint8Array.from(VH), pinned: Uint8Array.from(VP), crease: Uint8Array.from(crease),
  };
}

/** A triangle is flipped when the field steps the wrong way across it, probed this far (× edge) either side. */
const FLIP_PROBE = 0.03;
/** Adjacent triangles whose normals turn by more than this (cos) fold. */
const FOLD_COS = -0.866;
const UNTANGLE_ROUNDS = 24;
/** A triangle within this (cos) of all its corners' normals is not probed for a flip. */
const SUSPECT_COS = 0.866;
/** Untangling works within this many vertex rings of the flipped triangles it starts from. */
const REGION_RINGS = 12, REGROW_RINGS = 3;

/**
 * Untangle a cut owner mesh. A triangle FLIPS when the field steps the wrong way across it (at its
 * centroid, ± FLIP_PROBE·edge along its normal, the outer side reads lower) — its owner's share
 * when its non-crease corners share one owner, else the field: the seam spec's measure. Where the
 * surface turns sharply inward (a crease, a valley between two digits' webs, a gap closing into an
 * attachment) a triangle spanning the turn can face into the material. Each round, the flipped
 * triangles are tried for
 *   1. a swap of one of their edges (the quad's other diagonal; never a crease edge);
 *   2. a collapse of one of their edges onto one end (the other end's triangles taken over by it;
 *      never a pinned vertex removed, never two vertices of different owners merged unless one is
 *      a crease point or the removed one has only three triangles, the link condition kept);
 *   3. a move of one of their corners (not pinned, not on the crease) to the middle of its ring,
 *      taken back onto its owner's share (onto the field beside the crease);
 * and a change is taken when the triangles it makes hold fewer flips than the ones it replaces,
 * or as many and fewer folds. The mesh stays closed, manifold and oriented.
 * Only triangles near a flipped one are touched (REGION_RINGS); a mesh with none is returned as is.
 */
export function untangle(store, mesh) {
  const K = Math.max(1, store.ownerK ?? 0), edge = store.edge, eps = FLIP_PROBE * edge;
  const P = Array.from(mesh.positions), N = Array.from(mesh.normals), VL = Array.from(mesh.vertLeaf), VO = Array.from(mesh.vertOwner);
  const CR = Array.from(mesh.crease), PIN = Array.from(mesh.pinned), HELD = Array.from(mesh.ownerHeld), T = Array.from(mesh.indices);
  const nt0 = T.length / 3, alive = new Array(nt0).fill(1);
  const normalOf = (a, b, c) => {
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
  };
  const dot = (p, r) => p[0] * r[0] + p[1] * r[1] + p[2] * r[2];
  const ownerOf = (a, b, c) => {
    let o = -1;
    for (const v of [a, b, c]) { if (CR[v]) continue; if (o === -1) o = VO[v]; else if (VO[v] !== o) return -1; }
    return o;
  };
  // Which of the triangles (each [a, b, c]) flip: one batch of probes, each with its first corner's leaf program.
  const flipped = (tris) => {
    if (!tris.length) return [];
    const pts = new Float64Array(6 * tris.length), lf = [];
    tris.forEach(([a, b, c], q) => {
      const n = normalOf(a, b, c);
      for (let k = 0; k < 3; k++) {
        const m = (P[3 * a + k] + P[3 * b + k] + P[3 * c + k]) / 3;
        pts[6 * q + k] = m + eps * n[k]; pts[6 * q + 3 + k] = m - eps * n[k];
      }
      lf.push(VL[a], VL[a]);
    });
    const { d, shares } = evalPoints(store, K, pts, lf);
    // A share pruned from the first corner's leaf program (a triangle can span two leaves): the
    // probe is read again with the next corner's.
    for (let k = 1; k < 3; k++) {
      const redo = [];
      tris.forEach((x, q) => { const o = ownerOf(...x); if (o >= 0 && !(Number.isFinite(shares[2 * q * K + o]) && Number.isFinite(shares[(2 * q + 1) * K + o]))) redo.push(q); });
      if (!redo.length) break;
      const rp = new Float64Array(6 * redo.length), rl = [];
      redo.forEach((q, i) => { rp.set(pts.subarray(6 * q, 6 * q + 6), 6 * i); rl.push(VL[tris[q][k]], VL[tris[q][k]]); });
      const again = evalPoints(store, K, rp, rl);
      redo.forEach((q, i) => { for (let s2 = 0; s2 < 2; s2++) { d[2 * q + s2] = again.d[2 * i + s2]; for (let j = 0; j < K; j++) shares[(2 * q + s2) * K + j] = again.shares[(2 * i + s2) * K + j]; } });
    }
    return tris.map(([a, b, c], q) => {
      const o = ownerOf(a, b, c), f = (p) => (o >= 0 ? shares[p * K + o] : d[p]);
      return f(2 * q) < f(2 * q + 1);
    });
  };
  const KEYM = 2 ** 26;   // vertex counts stay far below it
  const edgeKey = (a, b) => (a < b ? a * KEYM + b : b * KEYM + a);
  // Adjacency is kept only for the triangles near flipped ones (built below): edge → triangles,
  // vertex → triangles.
  const byEdge = new Map(), fans = new Map();
  const fan = (v) => { let f = fans.get(v); if (!f) fans.set(v, (f = new Set())); return f; };
  const link = (t) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(T[3 * t + k], T[3 * t + (k + 1) % 3]), l = byEdge.get(key);
      if (l) l.push(t); else byEdge.set(key, [t]);
      fan(T[3 * t + k]).add(t);
    }
  };
  const unlink = (t) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(T[3 * t + k], T[3 * t + (k + 1) % 3]), l = byEdge.get(key);
      l.splice(l.indexOf(t), 1);
      if (!l.length) byEdge.delete(key);
      fan(T[3 * t + k]).delete(t);
    }
  };
  const triOf = (t) => [T[3 * t], T[3 * t + 1], T[3 * t + 2]];
  const setTri = (t, x) => { T[3 * t] = x[0]; T[3 * t + 1] = x[1]; T[3 * t + 2] = x[2]; };
  // A vertex beside the crease: a crease point is in its ring.
  const nearCrease = (v) => { for (const w of ring(v)) if (CR[w]) return true; return false; };
  const ring = (v) => { const r = new Set(); for (const t of fan(v)) for (const w of triOf(t)) if (w !== v) r.add(w); return r; };
  // How many of the triangles' edges fold: against another of them, or against a live triangle
  // across the edge that is not among `gone` (the triangles they replace).
  const foldCount = (tris, gone) => {
    const ns = tris.map((x) => normalOf(...x));
    let n = 0;
    for (let i = 0; i < tris.length; i++) for (let k = 0; k < 3; k++) {
      const x = tris[i][k], y = tris[i][(k + 1) % 3];
      for (let j = 0; j < tris.length; j++) if (j !== i && tris[j].includes(x) && tris[j].includes(y) && dot(ns[i], ns[j]) < FOLD_COS) n++;
      for (const w of byEdge.get(edgeKey(x, y)) ?? []) if (!gone.has(w) && dot(ns[i], normalOf(...triOf(w))) < FOLD_COS) n++;
    }
    return n;
  };
  // A change is taken when it leaves no more flipped triangles and no more folds than the ones
  // it replaces, and fewer of one.
  // Flips come first: a change that leaves fewer of them is taken even if it folds more (the
  // gate holds folds to the plain mesher's count, flips to zero); one that leaves as many is
  // taken when it folds less.
  const accept = (fB, fA, oB, oA) => fA < fB || (fA === fB && oA < oB);
  const better = (oldIds, tris, flipsAfter, badSet) => {
    const gone = new Set(oldIds), fB = oldIds.filter((t) => badSet.has(t)).length;
    const foldB = foldCount(oldIds.map(triOf), gone), foldA = foldCount(tris, gone);
    return accept(fB, flipsAfter, foldB, foldA);
  };
  const isBad = (ts) => { const live = ts.filter((t) => alive[t]), f = flipped(live.map(triOf)); return live.filter((_, q) => f[q]); };
  // Probed: every triangle at a seam (a crease, held or mixed-owner corner), and elsewhere a
  // triangle turned away from one of its corners' normals (the field's gradient there, from
  // cleanup's last projection) by more than SUSPECT_COS; only those can face into the material.
  const suspects = [];
  for (let t = 0; t < nt0; t++) {
    const x = triOf(t), n = normalOf(...x);
    if (CR[x[0]] || CR[x[1]] || CR[x[2]] || HELD[x[0]] || HELD[x[1]] || HELD[x[2]] || VO[x[0]] !== VO[x[1]] || VO[x[1]] !== VO[x[2]]) { suspects.push(t); continue; }
    for (const v of x) {
      const nv = [N[3 * v], N[3 * v + 1], N[3 * v + 2]];
      if (dot(n, nv) < SUSPECT_COS * hypot3(nv[0], nv[1], nv[2])) { suspects.push(t); break; }
    }
  }
  let bad = isBad(suspects);
  if (!bad.length) return mesh;
  // The region: every triangle within REGION_RINGS vertex rings of a flipped one is linked into
  // the adjacency; each round links the triangles within REGROW_RINGS of the flipped ones it
  // starts from, so every edge and fan a repair reads (and an edge a swap would add) is complete.
  // An unlinked triangle is one no repair has touched, so the original vertex → triangle table
  // still holds for it.
  const nvAll = P.length / 3, vStart = new Int32Array(nvAll + 1);
  for (let i = 0; i < T.length; i++) vStart[T[i] + 1]++;
  for (let v = 0; v < nvAll; v++) vStart[v + 1] += vStart[v];
  const vTris = new Int32Array(T.length), fillAt = vStart.slice(0, nvAll);
  for (let t = 0; t < nt0; t++) for (let k = 0; k < 3; k++) vTris[fillAt[T[3 * t + k]]++] = t;
  const linked = new Uint8Array(nt0);
  const grow = (seeds, rings) => {
    const seen = new Set();
    let front = [];
    for (const t of seeds) for (const v of triOf(t)) if (!seen.has(v)) { seen.add(v); front.push(v); }
    for (let r = 0; r <= rings && front.length; r++) {
      const next = [];
      for (const v of front) {
        const around = [...fan(v)];
        if (v < nvAll) for (let q = vStart[v]; q < vStart[v + 1]; q++) {
          const t = vTris[q];
          if (!linked[t] && alive[t]) { linked[t] = 1; link(t); }
          around.push(t);
        }
        for (const t of around) if (alive[t]) for (const w of triOf(t)) if (!seen.has(w)) { seen.add(w); next.push(w); }
      }
      front = next;
    }
  };
  grow(bad, REGION_RINGS);
  for (let round = 0; round < UNTANGLE_ROUNDS && bad.length; round++) {
    grow(bad, REGROW_RINGS);
    const touched = new Set();
    let changed = false;
    // 1. Swaps.
    const swaps = [];
    for (const t of bad) for (let k = 0; k < 3; k++) {
      const a = T[3 * t + k], b = T[3 * t + (k + 1) % 3], c = T[3 * t + (k + 2) % 3];
      if (CR[a] && CR[b]) continue;
      const l = byEdge.get(edgeKey(a, b));
      if (!l || l.length !== 2) continue;
      const u = l[0] === t ? l[1] : l[0];
      let d = -1;
      for (let j = 0; j < 3; j++) if (T[3 * u + j] === b && T[3 * u + (j + 1) % 3] === a) d = T[3 * u + (j + 2) % 3];
      if (d < 0 || d === c || byEdge.has(edgeKey(c, d))) continue;
      swaps.push({ t, u, tris: [[a, d, c], [d, b, c]] });
    }
    const fs = flipped(swaps.flatMap((s) => s.tris)), badNow = new Set(bad);
    swaps.forEach((s, q) => {
      if (touched.has(s.t) || touched.has(s.u)) return;
      if (!better([s.t, s.u], s.tris, fs[2 * q] + fs[2 * q + 1], badNow)) return;
      unlink(s.t); unlink(s.u);
      setTri(s.t, s.tris[0]); setTri(s.u, s.tris[1]);
      link(s.t); link(s.u);
      for (const v of [...s.tris[0], ...s.tris[1]]) for (const w of fan(v)) touched.add(w);
      changed = true;
    });
    // 2. Collapses: vertex `gone` merged into vertex `keep`, an end of an edge of a flipped triangle.
    const still = isBad(bad.filter((t) => !touched.has(t)));
    const cols = [];
    for (const t of still) for (let k = 0; k < 3; k++) for (const [keep, gone] of [[T[3 * t + k], T[3 * t + (k + 1) % 3]], [T[3 * t + (k + 1) % 3], T[3 * t + k]]]) {
      // (A vertex of three triangles may go whatever its owner: they become the one triangle
      // over its ring, whose edges are all in the mesh already.)
      if (PIN[gone] || (!CR[gone] && !CR[keep] && VO[keep] !== VO[gone] && fan(gone).size !== 3)) continue;
      const rk = ring(keep), rg = ring(gone);
      let common = 0;
      for (const v of rk) if (rg.has(v)) common++;
      if (common !== 2) continue;
      const goneTris = [...fan(gone)], dying = new Set(goneTris.filter((u) => fan(keep).has(u)));
      const tris = goneTris.filter((u) => !dying.has(u)).map((u) => triOf(u).map((v) => (v === gone ? keep : v)));
      cols.push({ keep, gone, goneTris, dying, tris });
    }
    const fc = flipped(cols.flatMap((c) => c.tris)), stillSet = new Set(still);
    let o = 0;
    for (const c of cols) {
      let fa = 0;
      for (let i = 0; i < c.tris.length; i++) fa += fc[o + i];
      o += c.tris.length;
      if (c.goneTris.some((u) => touched.has(u)) || [...fan(c.keep)].some((u) => touched.has(u))) continue;
      if (!better(c.goneTris, c.tris, fa, stillSet)) continue;
      for (const u of c.goneTris) unlink(u);
      for (const u of c.dying) alive[u] = 0;
      for (const u of c.goneTris) if (!c.dying.has(u)) { setTri(u, triOf(u).map((v) => (v === c.gone ? c.keep : v))); link(u); }
      for (const w of fan(c.keep)) { touched.add(w); for (const x of triOf(w)) for (const y of fan(x)) touched.add(y); }
      for (const u of c.goneTris) touched.add(u);
      changed = true;
    }
    // 3. Moves: a vertex of a flipped triangle (not pinned, not on the crease) goes to the middle
    //    of its ring, taken back onto its owner's share. Each triangle's three corners are tried
    //    in turn; vertices whose triangles share nothing are tried together.
    for (let k = 0; k < 3; k++) {
      const left = isBad(still.filter((t) => alive[t] && !touched.has(t)));
      if (!left.length) break;
      const leftSet = new Set(left), movers = [], claimed = new Set();
      for (const t of left) {
        const v = T[3 * t + k];
        if (PIN[v] || CR[v] || claimed.has(v)) continue;
        const vf = [...fan(v)];
        if (vf.some((u) => touched.has(u) || claimed.has(`t${u}`))) continue;
        const r = ring(v);
        let x = 0, y = 0, z = 0;
        for (const w of r) { x += P[3 * w] / r.size; y += P[3 * w + 1] / r.size; z += P[3 * w + 2] / r.size; }
        movers.push({ v, fan: vf, from: [P[3 * v], P[3 * v + 1], P[3 * v + 2]], to: [x, y, z] });
        claimed.add(v);
        for (const u of vf) { claimed.add(`t${u}`); for (const w of triOf(u)) claimed.add(w); }
      }
      if (!movers.length) continue;
      // Beside the crease the vertex goes onto the field (its own piece's share runs on inside the
      // other piece there); elsewhere onto its owner's share, so it never lands on a near miss's far skin.
      projectOnShare(store, K, movers.map((mv) => mv.to), movers.map((mv) => VL[mv.v]), movers.map((mv) => (nearCrease(mv.v) ? -1 : VO[mv.v])), edge);
      const before = movers.map((mv) => mv.fan.filter((u) => leftSet.has(u)).length);
      const foldsBefore = movers.map((mv) => foldCount(mv.fan.map(triOf), new Set(mv.fan)));
      for (const mv of movers) for (let c = 0; c < 3; c++) P[3 * mv.v + c] = mv.to[c];
      const fm = flipped(movers.flatMap((mv) => mv.fan.map(triOf)));
      let o2 = 0;
      movers.forEach((mv, q) => {
        let fa = 0;
        for (let i = 0; i < mv.fan.length; i++) fa += fm[o2 + i];
        o2 += mv.fan.length;
        const foldA = foldCount(mv.fan.map(triOf), new Set(mv.fan));
        if (accept(before[q], fa, foldsBefore[q], foldA)) {
          for (const u of mv.fan) touched.add(u);
          changed = true;
        } else for (let c = 0; c < 3; c++) P[3 * mv.v + c] = mv.from[c];
      });
    }
    if (!changed) break;
    bad = isBad([...new Set(bad.concat([...touched]))]);
  }
  // Compact: surviving triangles in order, vertices in order of first use.
  const nt = T.length / 3, map = new Int32Array(P.length / 3).fill(-1), out = [], keepV = [];
  for (let t = 0; t < nt; t++) if (alive[t]) for (let k = 0; k < 3; k++) {
    const v = T[3 * t + k];
    if (map[v] < 0) { map[v] = keepV.length; keepV.push(v); }
    out.push(map[v]);
  }
  const pick = (arr, w, Ctor) => { const r = new Ctor(keepV.length * w); keepV.forEach((v, i) => { for (let k = 0; k < w; k++) r[i * w + k] = arr[v * w + k]; }); return r; };
  return {
    ...mesh, indices: Uint32Array.from(out), positions: pick(P, 3, Float64Array), normals: pick(N, 3, Float64Array),
    vertLeaf: pick(VL, 1, Int32Array), vertOwner: pick(VO, 1, Int32Array), ownerHeld: pick(HELD, 1, Uint8Array), pinned: pick(PIN, 1, Uint8Array), crease: pick(CR, 1, Uint8Array),
  };
}

/** Newton steps (4) taking each point onto its owner's share zero (the field's, for owner −1); each step at most 2·|value| and 0.25·edge. */
function projectOnShare(store, K, pts, leaves, owners, edge) {
  const h = 0.05 * edge, cap = 0.25 * edge;
  for (let it = 0; it < 4; it++) {
    const q = new Float64Array(21 * pts.length), lf = [];
    pts.forEach((p, i) => {
      const [x, y, z] = p;
      q.set([x, y, z, x + h, y, z, x - h, y, z, x, y + h, z, x, y - h, z, x, y, z + h, x, y, z - h], 21 * i);
      for (let k = 0; k < 7; k++) lf.push(leaves[i]);
    });
    const got = evalPoints(store, K, q, lf), { shares } = got;
    pts.forEach((p, i) => {
      const { d: fd } = got, f = (k) => (owners[i] < 0 ? fd[7 * i + k] : shares[(7 * i + k) * K + owners[i]]), d = f(0);
      const g = [(f(1) - f(2)) / (2 * h), (f(3) - f(4)) / (2 * h), (f(5) - f(6)) / (2 * h)], gl = hypot3(g[0], g[1], g[2]);
      if (!(gl > 1e-9) || !Number.isFinite(d)) return;
      let t = d / gl;
      const lim = Math.min(cap, 2 * Math.abs(d));
      if (t > lim) t = lim; else if (t < -lim) t = -lim;
      for (let k = 0; k < 3; k++) p[k] -= (g[k] / gl) * t;
    });
  }
}
