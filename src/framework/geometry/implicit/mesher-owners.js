// src/framework/geometry/implicit/mesher-owners.js
// Owner-aware marching tetrahedra for a store whose leaves carry `owner` (a root
// contact node: sparse.js). Each Kuhn tet takes one of three paths (the seam spec's §3):
//   1. one owner (or all labels equal): mesher.js's plain emission, the same code;
//   2. several solid owners but no OPEN owner–owner edge: the same plain emission on the
//      field (an all-solid tet emits nothing) — touching pieces fuse;
//   3. an open owner–owner edge (a gap thinner than the grid): the tet is refined. Each open
//      edge is split at the pieces' bisector by an AIR NODE (the field there is positive: the
//      gap's air, which the grid missed), and plain marching tetrahedra runs on the sub-tets.
//      Every tet around an open edge holds two solid owners, so every one of them is refined,
//      and each splits its open edges in one global order (by grid edge key): a face is split
//      only by its own edges, in that order, so the two tets sharing it split it alike and the
//      refinement is conforming. Marching tetrahedra on a conforming tet mesh is closed and
//      manifold by construction — a line contact thinner than the grid, three pieces meeting
//      at a gap's end, a slit ending inside a fused contact all come out as closed sheets.
// The owners are the samples' pieces (evalBatchContact's `piece`: two attached pieces tie inside
// their blend, and a digit's web is the digit's). An owner–owner grid edge is OPEN when the
// field is positive at the pieces' bisector along it (s_X − s_Y = 0 on their shares, solved),
// else FUSED: the air node is just a truer sample of the field, so attached pieces get one too
// wherever air parts them. It is decided once per grid edge, so every tet sharing it agrees,
// and an open edge is never closed: the air node keeps every near miss apart (the seam spec's
// "near-miss safety wins"; this replaces the spike's line-contact conflict rule, which closed
// openings at gap 0 and could bridge a near miss), and a slit thinner than the grid inside a
// gap-0 contact stays a closed slit. A crossing on a sub-tet edge from a grid corner to an air
// node is solved onto the field's zero, so a gap face's vertices sit exactly on their piece's
// cut; crossings between two grid corners are mesher.js's own (welded with plain neighbours).
// Every edge solve is bracket.js's solveBrackets (bracketed Illinois, BRACKET_TOL of the edge).
// Raw output: cleanup (owner-aware) runs afterwards.
import { LEAF, OWNER_AIR } from "./sparse.js";
import { evalBatchContact } from "./program.js";
import { tetMesher, KUHN } from "./mesher.js";
import { clearance } from "./contact.js";
import { solveBrackets, MAX_BRACKET_STEPS } from "./bracket.js";

export { OWNER_AIR };

const S = LEAF + 1;
/** A vertex is on a gap face when its opposing piece's cut is the clearance to within this (× edge). */
const PIN_TOL = 1e-4;
const pushTo = (map, key, item) => { const list = map.get(key); if (list) list.push(item); else map.set(key, [item]); };
const sampleOf = (i, j, l, c) => ((l + ((c >> 2) & 1)) * S + (j + ((c >> 1) & 1))) * S + (i + (c & 1));

/**
 * meshStore with owners: { positions, indices, vertLeaf, vertOwner, ownerHeld, pinned }.
 * vertOwner is always a child index (the solid end's owner of the edge a vertex lies on);
 * ownerHeld = 1 marks vertices cleanup projects onto their owner's share instead of the field
 * (every crossing toward an air node, and a plain vertex whose grid edge shares a cell with an
 * open edge — placeHeldPlain); pinned = 1 marks gap-face vertices, placed exactly: a crossing
 * toward an air node where another piece's cut is the clearance (its own cut made the surface,
 * not its raw shape). `gap` is the contact node's: it sets that clearance. Triangles are
 * emitted in meshStore's order and, outside refined tets, by its code; a store whose pieces
 * never share a leaf (or without owners, every vertex then owned by child 0) meshes
 * byte-identically to meshStore.
 */
export function meshStoreOwners(store, { gap = 0 } = {}) {
  const { origin, edge, n, leaves, textures } = store;
  const K = Math.max(1, store.ownerK ?? 0), owned = store.ownerRoot >= 0;
  const cl = clearance(gap), pinTol = PIN_TOL * edge;
  const vertOwner = [], ownerHeld = [], pinned = [];
  // The cells holding both ends of grid edge (gLo, dir): a cell's low corner is the edge's low
  // point along each axis the edge runs, or that point or the one below along the others.
  const cellsOfEdge = (gLo, dir, fn) => {
    const i = gLo % n[0], rest = (gLo - i) / n[0], j = rest % n[1], l = (rest - j) / n[1];
    for (let dl = (dir & 4 ? 0 : -1); dl <= 0; dl++) for (let dj = (dir & 2 ? 0 : -1); dj <= 0; dj++) for (let di = (dir & 1 ? 0 : -1); di <= 0; di++) {
      if (i + di >= 0 && j + dj >= 0 && l + dl >= 0) fn((l + dl) * n[1] * n[0] + (j + dj) * n[0] + i + di);
    }
  };
  let openCells = null;   // cells holding an open edge (Set of low-corner indices), once edges are resolved
  // A grid edge borders a gap when it shares a cell with an open edge.
  const bordersOpen = (gLo, dir) => {
    if (openCells === null || openCells.size === 0) return false;
    let hit = false;
    cellsOfEdge(gLo, dir, (cell) => { if (openCells.has(cell)) hit = true; });
    return hit;
  };
  const leafMulti = new Uint8Array(leaves.length);   // a leaf whose samples hold two or more solid owners
  let lbl = null, curLeaf = -1;   // the current leaf's owners and index
  // Plain vertices bordering a gap, held to their owner's skin: [v, L, gLo, dir, loInside] each (placeHeldPlain).
  const plainCandidates = [];
  const m = tetMesher(store, (v, sLo, sHi, gLo, dir, loInside) => {
    vertOwner.push(lbl === null ? 0 : loInside ? lbl[sLo] : lbl[sHi]);
    const held = bordersOpen(gLo, dir);
    ownerHeld.push(held ? 1 : 0);
    pinned.push(0);
    if (held) plainCandidates.push(v, curLeaf, gLo, dir, loInside ? 1 : 0);
  });
  const { positions, indices, vertLeaf, CP, gIndex } = m;

  const keyPoint = (key, end, out, o) => {   // the grid edge's low (end 0) or high (end 1) point
    const dir = key % 8;
    let gi = (key - dir) / 8;
    if (end) gi += (dir & 1) + ((dir >> 1) & 1) * n[0] + ((dir >> 2) & 1) * n[0] * n[1];
    const i = gi % n[0], rest = (gi - i) / n[0], j = rest % n[1], l = (rest - j) / n[1];
    out[o] = origin[0] + i * edge; out[o + 1] = origin[1] + j * edge; out[o + 2] = origin[2] + l * edge;
  };  // --- Pass 1: every owner–owner edge of a tet holding two or more solid owners. ---
  const lab = new Int32Array(8);
  const edgeRec = new Map();   // grid edge key → record index
  // Per record: X/Y the low/high end's owner; the bisector point and the field there.
  const recKey = [], recX = [], recY = [], recOpen = [], recBis = [], recVal = [];
  const recLeaf = [];   // the leaf that first saw each record
  const perProg = new Map();   // program index → record indices first seen on a leaf running it
  const solidKinds = (cs, count) => {   // distinct solid labels among lab[cs[0..count)]
    let a = OWNER_AIR, kinds = 0;
    for (let q = 0; q < count; q++) {
      const x = lab[cs[q]];
      if (x === OWNER_AIR || x === a) continue;
      if (a === OWNER_AIR) { a = x; kinds = 1; } else return 2;
    }
    return kinds;
  };
  const edgeKeyOf = (i, j, l, ca, cb) => {
    const lo = ca & cb;
    return gIndex(m.i0 + i + (lo & 1), m.j0 + j + ((lo >> 1) & 1), m.l0 + l + ((lo >> 2) & 1)) * 8 + (ca ^ cb);
  };
  const ALL8 = [0, 1, 2, 3, 4, 5, 6, 7];
  if (owned) for (let L = 0; L < leaves.length; L++) {
    const own = leaves[L].owner;
    let first = OWNER_AIR, multi = false;
    for (let s = 0; s < own.length && !multi; s++) if (own[s] !== OWNER_AIR) { if (first === OWNER_AIR) first = own[s]; else if (own[s] !== first) multi = true; }
    if (!multi) continue;
    leafMulti[L] = 1;
    m.setLeaf(L);
    const [iEnd, jEnd, lEnd] = m.ends();
    for (let l = 0; l < lEnd; l++) for (let j = 0; j < jEnd; j++) for (let i = 0; i < iEnd; i++) {
      for (let c = 0; c < 8; c++) lab[c] = own[sampleOf(i, j, l, c)];
      if (solidKinds(ALL8, 8) < 2) continue;
      for (let t = 0; t < 6; t++) {
        const tet = KUHN[t];
        if (solidKinds(tet, 4) < 2) continue;
        for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
          const ca = tet[a], cb = tet[b], A = lab[ca], B = lab[cb];
          if (A === OWNER_AIR || B === OWNER_AIR || A === B) continue;
          const key = edgeKeyOf(i, j, l, ca, cb);
          if (edgeRec.has(key)) continue;
          const r = recKey.length, lo = ca & cb;
          edgeRec.set(key, r);
          recKey.push(key); recX.push(lab[lo]); recY.push(lab[lo | (ca ^ cb)]); recOpen.push(0); recLeaf.push(L);
          recBis.push(null); recVal.push(0);
          pushTo(perProg, leaves[L].progIndex, r);
        }
      }
    }
  }

  // --- Resolve each edge on the leaf that first saw it: bisector, open or fused. ---

  // Records are batched by program (leaves with equal decisions share one; the first leaf to
  // see an edge decides it, and any leaf with its program evaluates it identically).
  for (const list of perProg.values()) {
    const prog = leaves[recLeaf[list[0]]].prog, cnt = list.length;
    const A = new Float64Array(3 * cnt), B = new Float64Array(3 * cnt);
    list.forEach((r, q) => { keyPoint(recKey[r], 0, A, 3 * q); keyPoint(recKey[r], 1, B, 3 * q); });
    const ev = evaluator(prog, textures, K, 2 * cnt);
    const lerpInto = (q, t, slot) => { for (let k = 0; k < 3; k++) ev.P[k][slot] = A[3 * q + k] + (B[3 * q + k] - A[3 * q + k]) * t; };
    const at = (q, t) => [0, 1, 2].map((k) => A[3 * q + k] + (B[3 * q + k] - A[3 * q + k]) * t);
    // The bisector of the two pieces' shares, s_X − s_Y (negative at X's end, the low one).
    const tb = solveBrackets(cnt, MAX_BRACKET_STEPS, (lanes, ts, c, g) => {
      for (let k = 0; k < c; k++) lerpInto(lanes[k], ts[k], k);
      ev.run(c);
      for (let k = 0; k < c; k++) { const r = list[lanes[k]]; g[k] = ev.shares[k * K + recX[r]] - ev.shares[k * K + recY[r]]; }
    });
    for (let q = 0; q < cnt; q++) lerpInto(q, tb[q], q);
    ev.run(cnt);
    for (let q = 0; q < cnt; q++) {
      const r = list[q];
      recBis[r] = at(q, tb[q]);
      recVal[r] = ev.out[q];
      recOpen[r] = ev.out[q] > 0 ? 1 : 0;
    }
  }
  openCells = new Set();
  for (let r = 0; r < recKey.length; r++) if (recOpen[r]) {
    const key = recKey[r], dir = key % 8;
    cellsOfEdge((key - dir) / 8, dir, (cell) => openCells.add(cell));
  }

  // --- Pass 2: emission, cell by cell in meshStore's order. ---
  const loadLabels = (L, i, j, l) => { const own = leaves[L].owner; for (let c = 0; c < 8; c++) lab[c] = own[sampleOf(i, j, l, c)]; };
  // Crossings on sub-tet edges that touch a split node, keyed by their two nodes; each is solved
  // onto the field's zero afterwards: [v, L, inside x, y, z, outside x, y, z] (nodeCrossings).
  const nodeVerts = new Map(), nodeCand = [];
  // A sub-tet node: a cell corner (c = 0..7: its sample's value and owner) or an open edge's air
  // node (c = −1: the field at the bisector, positive; splitAt below). `id` keys crossings.
  const cornerNode = (L, i, j, l, c) => ({ c, val: leaves[L].vals[sampleOf(i, j, l, c)], own: lab[c], x: CP[3 * c], y: CP[3 * c + 1], z: CP[3 * c + 2],
    id: `g${gIndex(m.i0 + i + (c & 1), m.j0 + j + ((c >> 1) & 1), m.l0 + l + ((c >> 2) & 1))}` });
  // The vertex where sub-tet edge (a, b) crosses the field's zero (one end negative).
  const crossing = (L, i, j, l, a, b) => {
    if (a.c >= 0 && b.c >= 0) return m.vertexOn(i, j, l, a.c, b.c);   // an unsplit grid edge: the plain vertex
    const inn = a.val < 0 ? a : b, out = a.val < 0 ? b : a;
    const key = inn.id < out.id ? `${inn.id}:${out.id}` : `${out.id}:${inn.id}`;
    let v = nodeVerts.get(key);
    if (v !== undefined) return v;
    const t = inn.val / (inn.val - out.val);   // a first guess; nodeCrossings solves it
    v = positions.length / 3;
    positions.push(inn.x + (out.x - inn.x) * t, inn.y + (out.y - inn.y) * t, inn.z + (out.z - inn.z) * t);
    vertLeaf.push(L); vertOwner.push(inn.own); ownerHeld.push(1); pinned.push(0);
    nodeVerts.set(key, v);
    nodeCand.push(v, L, inn.x, inn.y, inn.z, out.x, out.y, out.z);
    return v;
  };
  // Plain marching tetrahedra on one sub-tet (four nodes), oriented as mesher.js orients: the
  // triangle's edge midpoints against the inside → outside direction of the node positions.
  const negN = [], posN = [], gv = [0, 0, 0];
  const mid = (a, b) => [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2];
  const tri = (A, B, C, a, b, c) => {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * gv[0] + ny * gv[1] + nz * gv[2] < 0) indices.push(a, c, b); else indices.push(a, b, c);
  };
  const subTet = (L, i, j, l, nodes) => {
    negN.length = 0; posN.length = 0;
    for (const p of nodes) (p.val < 0 ? negN : posN).push(p);
    const nn = negN.length, np = posN.length;
    if (nn === 0 || np === 0) return;
    gv[0] = gv[1] = gv[2] = 0;
    for (const p of posN) { gv[0] += p.x / np; gv[1] += p.y / np; gv[2] += p.z / np; }
    for (const p of negN) { gv[0] -= p.x / nn; gv[1] -= p.y / nn; gv[2] -= p.z / nn; }
    if (nn === 1 || nn === 3) {
      const lone = nn === 1 ? negN[0] : posN[0], o = nn === 1 ? posN.slice() : negN.slice();
      tri(mid(lone, o[0]), mid(lone, o[1]), mid(lone, o[2]),
        crossing(L, i, j, l, lone, o[0]), crossing(L, i, j, l, lone, o[1]), crossing(L, i, j, l, lone, o[2]));
    } else {
      const [n0, n1] = negN, [q0, q1] = posN;
      const v00 = crossing(L, i, j, l, n0, q0), v01 = crossing(L, i, j, l, n0, q1), v10 = crossing(L, i, j, l, n1, q0), v11 = crossing(L, i, j, l, n1, q1);
      tri(mid(n0, q0), mid(n0, q1), mid(n1, q1), v00, v01, v11);
      tri(mid(n0, q0), mid(n1, q1), mid(n1, q0), v00, v11, v10);
    }
  };
  // The split nodes, by grid edge key: each open owner–owner edge's air node at the bisector.
  const splitAt = new Map();
  for (let r = 0; r < recKey.length; r++) if (recOpen[r]) splitAt.set(recKey[r], { c: -1, val: recVal[r], own: OWNER_AIR, x: recBis[r][0], y: recBis[r][1], z: recBis[r][2], id: `e${recKey[r]}` });
  const splitCells = new Set();
  for (const key of splitAt.keys()) { const dir = key % 8; cellsOfEdge((key - dir) / 8, dir, (cell) => splitCells.add(cell)); }

  // Path 3: one tet of cell (i, j, l) in leaf L, labels in lab, corners in CP. Its split edges are
  // split in grid-edge-key order; a split halves every sub-tet holding both of the edge's ends.
  // Returns false (nothing emitted) when the tet has no split edge.
  const refineTet = (L, i, j, l, tet) => {
    const edges = [];
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
      const key = edgeKeyOf(i, j, l, tet[a], tet[b]);
      if (splitAt.has(key)) edges.push(key, tet[a], tet[b]);
    }
    if (!edges.length) return false;
    let subs = [tet.map((c) => cornerNode(L, i, j, l, c))];
    const order = [];
    for (let q = 0; q < edges.length; q += 3) order.push(q);
    order.sort((p, q) => edges[p] - edges[q]);
    for (const q of order) {
      const M = splitAt.get(edges[q]), ca = edges[q + 1], cb = edges[q + 2], next = [];
      for (const s of subs) {
        const ia = s.findIndex((p) => p.c === ca), ib = s.findIndex((p) => p.c === cb);
        if (ia < 0 || ib < 0) { next.push(s); continue; }
        const s1 = s.slice(), s2 = s.slice();
        s1[ia] = M; s2[ib] = M;
        next.push(s1, s2);
      }
      subs = next;
    }
    for (const s of subs) subTet(L, i, j, l, s);
    return true;
  };

  for (let L = 0; L < leaves.length; L++) {
    m.setLeaf(L);
    curLeaf = L;
    lbl = owned ? leaves[L].owner : null;
    const [iEnd, jEnd, lEnd] = m.ends();
    for (let l = 0; l < lEnd; l++) for (let j = 0; j < jEnd; j++) for (let i = 0; i < iEnd; i++) {
      const neg = m.cellNeg(i, j, l);
      if (!splitCells.size || !splitCells.has(gIndex(m.i0 + i, m.j0 + j, m.l0 + l))) {   // paths 1 and 2 throughout
        if (neg === 0 || neg === 8) continue;
        m.corners(i, j, l);
        for (const tet of KUHN) m.tet(i, j, l, tet);
        continue;
      }
      loadLabels(L, i, j, l);
      m.corners(i, j, l);
      for (const tet of KUHN) if (!refineTet(L, i, j, l, tet)) m.tet(i, j, l, tet);
    }
  }

  placeHeldPlain(store, positions, vertOwner, plainCandidates, K, keyPoint);
  nodeCrossings(store, positions, vertOwner, pinned, nodeCand, K, cl, pinTol);
  return {
    positions: Float64Array.from(positions), indices: Uint32Array.from(indices), vertLeaf: Int32Array.from(vertLeaf),
    vertOwner: Int32Array.from(vertOwner), ownerHeld: Uint8Array.from(ownerHeld), pinned: Uint8Array.from(pinned),
  };
}

/** A reusable evaluator of a leaf program at up to `cap` points: fill P[0..2], run(count) → out, cuts, shares. */
function evaluator(prog, textures, K, cap) {
  const P = [new Float64Array(cap), new Float64Array(cap), new Float64Array(cap)];
  const outAll = new Float64Array(cap), cutsAll = new Float64Array(cap * K), sharesAll = new Float64Array(cap * K);
  const ev = {
    P, out: outAll, cuts: cutsAll, shares: sharesAll,
    run(count) {
      evalBatchContact(prog, textures, P[0].subarray(0, count), P[1].subarray(0, count), P[2].subarray(0, count), outAll.subarray(0, count),
        { K, cuts: cutsAll.subarray(0, count * K), shares: sharesAll.subarray(0, count * K) });
    },
  };
  return ev;
}

/**
 * Each crossing toward an air node goes onto the field's zero along its sub-tet edge (solved
 * from the grid corner, inside, to the air node, outside), and is pinned when it lands on a gap
 * face: another piece's cut is the clearance there (its own cut, not its raw shape, made the
 * surface). An edge whose ends do not straddle the zero keeps the linear guess.
 */
function nodeCrossings(store, positions, vertOwner, pinned, cand, K, cl, tol) {
  const STRIDE = 8, byProg = new Map();
  for (let q = 0; q < cand.length; q += STRIDE) pushTo(byProg, store.leaves[cand[q + 1]].progIndex, q);
  for (const all of byProg.values()) {
    const cnt0 = all.length, ev = evaluator(store.leaves[cand[all[0] + 1]].prog, store.textures, K, 2 * cnt0);
    const lerpInto = (e, t, slot) => { const q = all[e]; for (let k = 0; k < 3; k++) ev.P[k][slot] = cand[q + 2 + k] + (cand[q + 5 + k] - cand[q + 2 + k]) * t; };
    for (let e = 0; e < cnt0; e++) { lerpInto(e, 0, 2 * e); lerpInto(e, 1, 2 * e + 1); }
    ev.run(2 * cnt0);
    const list = [], f0 = [], f1 = [];
    for (let e = 0; e < cnt0; e++) if (ev.out[2 * e] < 0 && ev.out[2 * e + 1] > 0) { list.push(e); f0.push(ev.out[2 * e]); f1.push(ev.out[2 * e + 1]); }
    const cnt = list.length;
    if (!cnt) continue;
    const ts = solveBrackets(cnt, MAX_BRACKET_STEPS, (lanes, tq, c, g) => {
      for (let k = 0; k < c; k++) lerpInto(list[lanes[k]], tq[k], k);
      ev.run(c);
      for (let k = 0; k < c; k++) g[k] = ev.out[k];
    }, f0, f1);
    for (let k = 0; k < cnt; k++) lerpInto(list[k], ts[k], k);
    ev.run(cnt);
    for (let k = 0; k < cnt; k++) {
      const v = cand[all[list[k]]];
      for (let c = 0; c < 3; c++) positions[3 * v + c] = ev.P[c][k];
      const X = vertOwner[v];
      for (let W = 0; W < K; W++) if (W !== X && Math.abs(ev.cuts[k * K + W] - cl) <= tol) pinned[v] = 1;
    }
  }
}

/**
 * A plain vertex bordering a gap (its grid edge shares a cell with an open edge) is held to its
 * owner: across a gap the field rises to a ridge between the pieces, so the field's linear
 * crossing can land by the other piece. It goes onto its owner's share zero along its grid edge
 * (solved, as the side vertices are) when that share changes sign along the edge AND the field
 * there is zero too (to within PIN_TOL·edge) — so a share that jumps (a merged owner's at an
 * attachment zone's rim) or a point the share puts inside another piece keeps the crossing.
 */
function placeHeldPlain(store, positions, vertOwner, cand, K, keyPoint) {
  const tol = PIN_TOL * store.edge;
  const byProg = new Map();
  for (let q = 0; q < cand.length; q += 5) pushTo(byProg, store.leaves[cand[q + 1]].progIndex, q);
  for (const all of byProg.values()) {
    const cnt0 = all.length, ev = evaluator(store.leaves[cand[all[0] + 1]].prog, store.textures, K, 2 * cnt0);
    const A = new Float64Array(3 * cnt0), B = new Float64Array(3 * cnt0);
    // Each edge inside end first: t runs from the inside end (0) to the outside end (1).
    all.forEach((q, e) => {
      const key = cand[q + 2] * 8 + cand[q + 3], inLow = cand[q + 4] === 1;
      keyPoint(key, inLow ? 0 : 1, A, 3 * e); keyPoint(key, inLow ? 1 : 0, B, 3 * e);
    });
    const lerpInto = (e, t, slot) => { for (let k = 0; k < 3; k++) ev.P[k][slot] = A[3 * e + k] + (B[3 * e + k] - A[3 * e + k]) * t; };
    for (let e = 0; e < cnt0; e++) { lerpInto(e, 0, 2 * e); lerpInto(e, 1, 2 * e + 1); }
    ev.run(2 * cnt0);
    const list = [], f0 = [], f1 = [];   // edge indices whose owner's share changes sign along the edge
    all.forEach((q, e) => {
      const o = vertOwner[cand[q]];
      if (ev.shares[2 * e * K + o] < 0 && ev.shares[(2 * e + 1) * K + o] > 0) { list.push(e); f0.push(ev.shares[2 * e * K + o]); f1.push(ev.shares[(2 * e + 1) * K + o]); }
    });
    const cnt = list.length;
    if (!cnt) continue;
    const ts = solveBrackets(cnt, MAX_BRACKET_STEPS, (lanes, tq, c, g) => {
      for (let k = 0; k < c; k++) lerpInto(list[lanes[k]], tq[k], k);
      ev.run(c);
      for (let k = 0; k < c; k++) g[k] = ev.shares[k * K + vertOwner[cand[all[list[lanes[k]]]]]];
    }, f0, f1);
    for (let k = 0; k < cnt; k++) lerpInto(list[k], ts[k], k);
    ev.run(cnt);
    for (let k = 0; k < cnt; k++) {
      if (!(Math.abs(ev.out[k]) <= tol)) continue;
      const e = list[k], v = cand[all[e]], t = ts[k];
      for (let c = 0; c < 3; c++) positions[3 * v + c] = A[3 * e + c] + (B[3 * e + c] - A[3 * e + c]) * t;
    }
  }
}

