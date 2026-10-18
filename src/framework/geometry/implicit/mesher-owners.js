// src/framework/geometry/implicit/mesher-owners.js
// Owner-aware marching tetrahedra for a store whose leaves carry `owner` (a root exact
// contact node: sparse.js). Each Kuhn tet takes one of three paths (the seam spec's §3):
//   1. one owner (or all labels equal): mesher.js's plain emission, the same code;
//   2. several solid owners but no OPEN owner–owner edge: the same plain emission on the
//      field (an all-solid tet emits nothing) — touching pieces fuse;
//   3. an open owner–owner edge (a gap thinner than the grid): the barycentric
//      multi-material layout, per tet face (E1, E2, C) on a two-label face and (E, F, C) per
//      crossing edge on a three-label face, each solid side's sheet emitted on its own
//      vertices so the gap is exact.
// An owner–owner grid edge is OPEN when the field is positive at the pieces' bisector along
// it (c_X − c_Y = 0, bisected) and each owner's cut is negative at its own end and positive
// at the bisector; else FUSED. It is decided once per grid edge, so every tet sharing it
// agrees. An open edge's side vertices sit on each owner's cut zero (bisected on its half);
// face and cell vertices are seeded from their edge-vertex neighbours and Newton-projected.
// Raw output: cleanup (owner-aware from Task 3) runs afterwards.
import { LEAF, OWNER_AIR } from "./sparse.js";
import { evalBatchContact } from "./program.js";
import { tetMesher, KUHN } from "./mesher.js";
import { clearanceExact } from "./contact.js";

export { OWNER_AIR };

const S = LEAF + 1;
const FACES = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];   // tet-local corner triples
// Newton: at most NEWTON_ITERS steps, each capped at NEWTON_CAP·edge, forward differences of
// FD_STEP·edge; a vertex whose step falls to NEWTON_DONE·edge has converged.
const BISECT_STEPS = 24, NEWTON_ITERS = 8, NEWTON_CAP = 0.5, FD_STEP = 0.05, NEWTON_DONE = 1e-7;
/** A vertex is on a gap face when its opposing piece's cut is the clearance to within this (× edge). */
const PIN_TOL = 1e-4;
const OWNER_SLOTS = 128;   // owner-qualified vertex keys: key · OWNER_SLOTS + owner (MAX_OWNER_K = 127)
const pushTo = (map, key, item) => { const list = map.get(key); if (list) list.push(item); else map.set(key, [item]); };
const sampleOf = (i, j, l, c) => ((l + ((c >> 2) & 1)) * S + (j + ((c >> 1) & 1))) * S + (i + (c & 1));

/**
 * meshStore with owners: { positions, indices, vertLeaf, vertOwner, ownerHeld, pinned }.
 * vertOwner is always a child index (the solid end's owner for an edge vertex; the side or
 * merged representative for a fused edge, face or cell vertex); ownerHeld = 1 marks vertices
 * cleanup projects onto their owner's share instead of the field (every side, face and cell
 * vertex of an open tet, and a plain vertex on a grid edge touching an open edge's end or
 * whose outside end's field belongs to another piece — placeHeldPlain); pinned = 1 marks
 * gap-face vertices, placed exactly: an open-edge side or a solved face or cell vertex with no
 * air corner whose opposing piece's cut is the clearance there (its own cut made the surface,
 * not its raw shape). `gap` is the contact node's: it sets that clearance and resolves sub-grid
 * line contacts (closed at gap 0, opened with a gap). Triangles are emitted in meshStore's
 * order and, outside open tets, by its code; a store whose pieces never share a leaf (or
 * without owners, every vertex then owned by child 0) meshes byte-identically to meshStore.
 */
export function meshStoreOwners(store, { gap = 0 } = {}) {
  const { origin, edge, n, leaves, textures } = store;
  const K = Math.max(1, store.ownerK ?? 0), owned = store.ownerRoot >= 0;
  const cl = clearanceExact(gap), pinTol = PIN_TOL * edge;
  const vertOwner = [], ownerHeld = [], pinned = [];
  let openPts = null;   // grid points at either end of an open edge (Set), once edges are resolved
  const nearOpen = (gLo, dir) => openPts !== null && (openPts.has(gLo) || openPts.has(gLo + (dir & 1) + ((dir >> 1) & 1) * n[0] + ((dir >> 2) & 1) * n[0] * n[1]));
  const leafMulti = new Uint8Array(leaves.length);   // a leaf whose samples hold two or more solid owners
  let lbl = null, curLeaf = -1;   // the current leaf's owners and index
  // Plain vertices that may need their owner's skin: [v, L, gLo, dir, loInside] each — those
  // beside an open edge, and every one in a leaf holding two solid owners (placeHeldPlain).
  const plainCandidates = [];
  const m = tetMesher(store, (v, sLo, sHi, gLo, dir, loInside) => {
    vertOwner.push(lbl === null ? 0 : loInside ? lbl[sLo] : lbl[sHi]);
    const held = nearOpen(gLo, dir);
    ownerHeld.push(held ? 1 : 0);
    pinned.push(0);
    if (held || leafMulti[curLeaf]) plainCandidates.push(v, curLeaf, gLo, dir, loInside ? 1 : 0);
  });
  const { positions, indices, vertLeaf, CP, gIndex } = m;

  // --- Pass 1: every owner–owner edge of a tet holding two or more solid owners. ---
  const lab = new Int32Array(8);
  const multiTets = [];   // [L, i, j, l, t] per tet
  const edgeRec = new Map();   // grid edge key → record index
  const recKey = [], recX = [], recY = [], recOpen = [], recBis = [], recSide = [], recPin = [];   // X/Y: the low/high end's owner
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
        multiTets.push(L, i, j, l, t);
        for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
          const ca = tet[a], cb = tet[b], A = lab[ca], B = lab[cb];
          if (A === OWNER_AIR || B === OWNER_AIR || A === B) continue;
          const key = edgeKeyOf(i, j, l, ca, cb);
          if (edgeRec.has(key)) continue;
          const r = recKey.length, lo = ca & cb;
          edgeRec.set(key, r);
          recKey.push(key); recX.push(lab[lo]); recY.push(lab[lo | (ca ^ cb)]); recOpen.push(0); recLeaf.push(L);
          recSide.push(null); recPin.push(null); recBis.push(null);
          pushTo(perProg, leaves[L].progIndex, r);
        }
      }
    }
  }

  // --- Resolve each edge on the leaf that first saw it: bisector, open or fused, sides. ---
  const keyPoint = (key, end, out, o) => {   // the grid edge's low (end 0) or high (end 1) point
    const dir = key % 8;
    let gi = (key - dir) / 8;
    if (end) gi += (dir & 1) + ((dir >> 1) & 1) * n[0] + ((dir >> 2) & 1) * n[0] * n[1];
    const i = gi % n[0], rest = (gi - i) / n[0], j = rest % n[1], l = (rest - j) / n[1];
    out[o] = origin[0] + i * edge; out[o + 1] = origin[1] + j * edge; out[o + 2] = origin[2] + l * edge;
  };
  // Records are batched by program (leaves with equal decisions share one; the first leaf to
  // see an edge decides it, and any leaf with its program evaluates it identically).
  for (const list of perProg.values()) {
    const prog = leaves[recLeaf[list[0]]].prog, cnt = list.length;
    const A = new Float64Array(3 * cnt), B = new Float64Array(3 * cnt);
    list.forEach((r, q) => { keyPoint(recKey[r], 0, A, 3 * q); keyPoint(recKey[r], 1, B, 3 * q); });
    const ev = evaluator(prog, textures, K, 2 * cnt);
    const lerpInto = (q, t, slot) => { for (let k = 0; k < 3; k++) ev.P[k][slot] = A[3 * q + k] + (B[3 * q + k] - A[3 * q + k]) * t; };
    const at = (q, t) => [0, 1, 2].map((k) => A[3 * q + k] + (B[3 * q + k] - A[3 * q + k]) * t);
    // The bisector of c_X − c_Y (negative at X's end, the low one).
    const lo = new Float64Array(cnt), hi = new Float64Array(cnt).fill(1);
    for (let it = 0; it < BISECT_STEPS; it++) {
      for (let q = 0; q < cnt; q++) lerpInto(q, (lo[q] + hi[q]) / 2, q);
      ev.run(cnt);
      for (let q = 0; q < cnt; q++) {
        const r = list[q], mid = (lo[q] + hi[q]) / 2;
        if (ev.cuts[q * K + recX[r]] - ev.cuts[q * K + recY[r]] < 0) lo[q] = mid; else hi[q] = mid;
      }
    }
    const tb = new Float64Array(cnt);
    for (let q = 0; q < cnt; q++) { tb[q] = (lo[q] + hi[q]) / 2; lerpInto(q, tb[q], q); }
    ev.run(cnt);
    const maybe = [];   // edges whose bisector reads as a gap; the rest are fused
    for (let q = 0; q < cnt; q++) {
      const r = list[q];
      recBis[r] = at(q, tb[q]);
      if (ev.out[q] > 0 && ev.cuts[q * K + recX[r]] > 0 && ev.cuts[q * K + recY[r]] > 0) maybe.push(q);
    }
    const nm = maybe.length;
    if (!nm) continue;
    // Open when each owner's cut is also negative at its own end; sides: X's cut zero on
    // [0, tb], Y's on [tb, 1].
    for (let k = 0; k < nm; k++) { lerpInto(maybe[k], 0, 2 * k); lerpInto(maybe[k], 1, 2 * k + 1); }
    ev.run(2 * nm);
    const ok = new Uint8Array(nm);
    for (let k = 0; k < nm; k++) { const r = list[maybe[k]]; ok[k] = ev.cuts[2 * k * K + recX[r]] < 0 && ev.cuts[(2 * k + 1) * K + recY[r]] < 0 ? 1 : 0; }
    const xl = new Float64Array(nm), xh = Float64Array.from(maybe, (q) => tb[q]), yl = Float64Array.from(xh), yh = new Float64Array(nm).fill(1);
    for (let it = 0; it < BISECT_STEPS; it++) {
      for (let k = 0; k < nm; k++) { lerpInto(maybe[k], (xl[k] + xh[k]) / 2, 2 * k); lerpInto(maybe[k], (yl[k] + yh[k]) / 2, 2 * k + 1); }
      ev.run(2 * nm);
      for (let k = 0; k < nm; k++) {
        const r = list[maybe[k]], mx = (xl[k] + xh[k]) / 2, my = (yl[k] + yh[k]) / 2;
        if (ev.cuts[2 * k * K + recX[r]] < 0) xl[k] = mx; else xh[k] = mx;
        if (ev.cuts[(2 * k + 1) * K + recY[r]] > 0) yl[k] = my; else yh[k] = my;
      }
    }
    // Each side is on a gap face when the other piece's cut there is the clearance (its own
    // cut, not its raw surface, made the zero).
    for (let k = 0; k < nm; k++) { lerpInto(maybe[k], (xl[k] + xh[k]) / 2, 2 * k); lerpInto(maybe[k], (yl[k] + yh[k]) / 2, 2 * k + 1); }
    ev.run(2 * nm);
    for (let k = 0; k < nm; k++) {
      const q = maybe[k], r = list[q];
      recOpen[r] = ok[k];
      recSide[r] = [at(q, (xl[k] + xh[k]) / 2), at(q, (yl[k] + yh[k]) / 2)];
      recPin[r] = [Math.abs(ev.cuts[2 * k * K + recY[r]] - cl) <= pinTol ? 1 : 0, Math.abs(ev.cuts[(2 * k + 1) * K + recX[r]] - cl) <= pinTol ? 1 : 0];
    }
  }

  // Tet edge (ca, cb)'s record in the current leaf's cell (i, j, l); lab holds the tet's cell labels.
  const recOf = (i, j, l, ca, cb) => edgeRec.get(edgeKeyOf(i, j, l, ca, cb));
  const loadLabels = (L, i, j, l) => { const own = leaves[L].owner; for (let c = 0; c < 8; c++) lab[c] = own[sampleOf(i, j, l, c)]; };

  // A fused X–Y edge whose two faces in some tet both hold an open X–Y edge is a line contact
  // thinner than the grid: the two sheets would share it (non-manifold). At gap 0 the openings
  // close; with a gap the fused edge opens (both sides at its bisector). Repeat until stable.
  // (The spike's rule, kept as it was: it can bridge a near miss at gap 0 — Task 5 replaces it.)
  if (recKey.length) for (let changed = true; changed;) {
    changed = false;
    for (let q = 0; q < multiTets.length; q += 5) {
      const L = multiTets[q], i = multiTets[q + 1], j = multiTets[q + 2], l = multiTets[q + 3], tet = KUHN[multiTets[q + 4]];
      m.setLeaf(L); loadLabels(L, i, j, l);
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
        const A = lab[tet[a]], B = lab[tet[b]];
        if (A === OWNER_AIR || B === OWNER_AIR || A === B) continue;
        const r = recOf(i, j, l, tet[a], tet[b]);
        if (recOpen[r]) continue;
        const openOn = (o) => {   // open edges with the same owner pair from a or b to corner o
          const found = [];
          for (const e of [a, b]) {
            const E = lab[tet[e]], O = lab[tet[o]];
            if (!((E === A && O === B) || (E === B && O === A))) continue;
            const r2 = recOf(i, j, l, tet[e], tet[o]);
            if (recOpen[r2]) found.push(r2);
          }
          return found;
        };
        const others = [0, 1, 2, 3].filter((x) => x !== a && x !== b);
        const P = openOn(others[0]), Q = openOn(others[1]);
        if (!P.length || !Q.length) continue;
        if (!(gap > 0)) for (const r2 of [...P, ...Q]) recOpen[r2] = 0;
        else { recOpen[r] = 1; recSide[r] = [recBis[r], recBis[r]]; recPin[r] = [0, 0]; }
        changed = true;
      }
    }
  }
  openPts = new Set();
  for (let r = 0; r < recKey.length; r++) if (recOpen[r]) {
    const key = recKey[r], dir = key % 8, gLo = (key - dir) / 8;
    openPts.add(gLo); openPts.add(gLo + (dir & 1) + ((dir >> 1) & 1) * n[0] + ((dir >> 2) & 1) * n[0] * n[1]);
  }

  // --- Pass 2: emission, cell by cell in meshStore's order. ---
  const sideVerts = new Map(), fusedVerts = new Map(), faceVerts = new Map(), cellVerts = new Map();
  const pending = [];   // face and cell vertices solved after emission: { v, L, air, members, others }
  const addVertex = (L, p, owner, held, pin) => {
    const v = positions.length / 3;
    positions.push(p[0], p[1], p[2]); vertLeaf.push(L); vertOwner.push(owner); ownerHeld.push(held); pinned.push(pin);
    return v;
  };
  const corner = (c) => [CP[3 * c], CP[3 * c + 1], CP[3 * c + 2]];
  const mean = (cs) => {
    const p = [0, 0, 0];
    for (const c of cs) { p[0] += CP[3 * c]; p[1] += CP[3 * c + 1]; p[2] += CP[3 * c + 2]; }
    return [p[0] / cs.length, p[1] / cs.length, p[2] / cs.length];
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  // Orientation from the proxies (edge midpoints, face and cell centres) against g, as mesher.js does.
  const orient = (A, B, C, g, a, b, c) => {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * g[0] + ny * g[1] + nz * g[2] < 0) indices.push(a, c, b); else indices.push(a, b, c);
  };

  // Path 3: one tet of cell (i, j, l) in leaf L, labels in lab, corners in CP.
  const emitOpenTet = (L, i, j, l, t) => {
    const tet = KUHN[t];
    const fusedPair = (X, Y, cs) => {   // any fused X–Y edge among corners cs
      for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
        const A = lab[cs[a]], B = lab[cs[b]];
        if (!((A === X && B === Y) || (A === Y && B === X))) continue;
        if (!recOpen[recOf(i, j, l, cs[a], cs[b])]) return true;
      }
      return false;
    };
    const rep = (X, cs) => {   // X's side at a location: the least owner it is fused with there (one hop)
      let r = X;
      for (const c of cs) { const Y = lab[c]; if (Y !== OWNER_AIR && Y !== X && Y < r && fusedPair(X, Y, cs)) r = Y; }
      return r;
    };
    const locVert = (map, key, X, cs) => {
      const r = rep(X, cs), k = key * OWNER_SLOTS + r;
      let v = map.get(k);
      if (v !== undefined) return v;
      let air = false;
      const members = [], others = [];
      for (const c of cs) {
        const Y = lab[c];
        if (Y === OWNER_AIR) air = true;
        else if (members.includes(Y) || others.includes(Y)) continue;
        else if (rep(Y, cs) === r) members.push(Y); else others.push(Y);
      }
      v = addVertex(L, mean(cs), r, 1, 0);   // pinned once solved, if it lands on a gap face
      map.set(k, v);
      pending.push({ v, L, air, members, others });
      return v;
    };
    const edgeVert = (ca, cb, Xo) => {   // the vertex on tet edge (ca, cb) on owner Xo's side
      if (lab[ca] === OWNER_AIR || lab[cb] === OWNER_AIR) return m.vertexOn(i, j, l, ca, cb);
      const key = edgeKeyOf(i, j, l, ca, cb), r = edgeRec.get(key);
      if (recOpen[r]) {
        const k = key * OWNER_SLOTS + Xo, side = Xo === recX[r] ? 0 : 1;
        let v = sideVerts.get(k);
        if (v === undefined) sideVerts.set(k, (v = addVertex(L, recSide[r][side], Xo, 1, recPin[r][side])));
        return v;
      }
      let v = fusedVerts.get(key);
      if (v === undefined) {
        const dir = key % 8;
        fusedVerts.set(key, (v = addVertex(L, recBis[r], Math.min(recX[r], recY[r]), nearOpen((key - dir) / 8, dir) ? 1 : 0, 0)));
      }
      return v;
    };
    const cellKey = gIndex(m.i0 + i, m.j0 + j, m.l0 + l) * 6 + t;
    const C = mean(tet), flab = new Int32Array(8);
    for (const f of FACES) {
      const fc = [tet[f[0]], tet[f[1]], tet[f[2]]];
      for (const c of fc) flab[c] = lab[c];
      // A face whose owner pair is fused on every one of its edges here is one owner.
      const solids = [];
      for (const c of fc) if (lab[c] !== OWNER_AIR && !solids.includes(lab[c])) solids.push(lab[c]);
      for (const X of solids) for (const Y of solids) {
        if (!(X < Y)) continue;
        let any = false, allFused = true;
        for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
          const A = lab[fc[a]], B = lab[fc[b]];
          if (!((A === X && B === Y) || (A === Y && B === X))) continue;
          any = true;
          if (recOpen[recOf(i, j, l, fc[a], fc[b])]) allFused = false;
        }
        if (any && allFused) for (const c of fc) if (flab[c] === Y) flab[c] = X;
      }
      const crossing = [];
      for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) if (flab[fc[a]] !== flab[fc[b]]) crossing.push([fc[a], fc[b]]);
      if (!crossing.length) continue;
      // Face vertex keys: the face's least corner (a Kuhn face is a chain c0 ⊂ c1 ⊂ c2) and its two offsets.
      const sorted = fc.slice().sort((p, q) => p - q);   // bit-subset chains sort by value
      const faceKey = () => (gIndex(m.i0 + i + (sorted[0] & 1), m.j0 + j + ((sorted[0] >> 1) & 1), m.l0 + l + ((sorted[0] >> 2) & 1)) * 8 + (sorted[1] ^ sorted[0])) * 8 + (sorted[2] ^ sorted[0]);
      const tris = [];   // { Pl, Ql, roles: [edge | "F" | "C"] ×3, prox, g }
      if (crossing.length === 2) {
        const [a1, b1] = crossing[0], Pl = flab[a1], Ql = flab[b1];
        const e2 = flab[crossing[1][0]] === Pl ? crossing[1] : [crossing[1][1], crossing[1][0]];
        tris.push({ Pl, Ql, roles: [[a1, b1], e2, "C"], prox: [mean([a1, b1]), mean(e2), C],
          g: sub(mean(fc.filter((c) => flab[c] === Ql)), mean(fc.filter((c) => flab[c] === Pl))) });
      } else {
        const Fm = mean(fc);
        for (const [a, b] of crossing) tris.push({ Pl: flab[a], Ql: flab[b], roles: [[a, b], "F", "C"], prox: [mean([a, b]), Fm, C], g: sub(corner(b), corner(a)) });
      }
      for (const T of tris) {
        const resolve = (X) => T.roles.map((role) => {
          if (role === "F") return locVert(faceVerts, faceKey(), X, fc);
          if (role === "C") return locVert(cellVerts, cellKey, X, tet);
          return edgeVert(role[0], role[1], flab[role[0]] === X ? lab[role[0]] : lab[role[1]]);
        });
        if (T.Pl === OWNER_AIR || T.Ql === OWNER_AIR) {   // one sheet, facing the air
          const solid = T.Pl === OWNER_AIR ? T.Ql : T.Pl, g = T.Pl === OWNER_AIR ? T.g.map((x) => -x) : T.g;
          const [a, b, c] = resolve(solid);
          orient(T.prox[0], T.prox[1], T.prox[2], g, a, b, c);
          continue;
        }
        // Two solid owners: one sheet per side, unless every owner–owner edge here is fused.
        let anyOpen = false;
        for (const role of T.roles) if (typeof role !== "string" && recOpen[recOf(i, j, l, role[0], role[1])]) anyOpen = true;
        if (!anyOpen) continue;
        { const [a, b, c] = resolve(T.Pl); orient(T.prox[0], T.prox[1], T.prox[2], T.g, a, b, c); }
        { const [a, b, c] = resolve(T.Ql); orient(T.prox[0], T.prox[1], T.prox[2], T.g.map((x) => -x), a, b, c); }
      }
    }
  };

  const tetOpen = (i, j, l, tet) => {
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
      const A = lab[tet[a]], B = lab[tet[b]];
      if (A !== OWNER_AIR && B !== OWNER_AIR && A !== B && recOpen[recOf(i, j, l, tet[a], tet[b])]) return true;
    }
    return false;
  };
  const anyOpen = openPts.size > 0;
  for (let L = 0; L < leaves.length; L++) {
    m.setLeaf(L);
    curLeaf = L;
    lbl = owned ? leaves[L].owner : null;
    const [iEnd, jEnd, lEnd] = m.ends();
    for (let l = 0; l < lEnd; l++) for (let j = 0; j < jEnd; j++) for (let i = 0; i < iEnd; i++) {
      const neg = m.cellNeg(i, j, l);
      let multi = false;
      if (anyOpen && leafMulti[L]) { loadLabels(L, i, j, l); multi = solidKinds(ALL8, 8) >= 2; }
      if (!multi) {   // paths 1 and 2 throughout
        if (neg === 0 || neg === 8) continue;
        m.corners(i, j, l);
        for (const tet of KUHN) m.tet(i, j, l, tet);
        continue;
      }
      m.corners(i, j, l);
      for (let t = 0; t < 6; t++) {
        const tet = KUHN[t];
        if (solidKinds(tet, 4) >= 2 && tetOpen(i, j, l, tet)) emitOpenTet(L, i, j, l, t);
        else m.tet(i, j, l, tet);
      }
    }
  }

  placeHeldPlain(store, positions, vertOwner, ownerHeld, plainCandidates, K, keyPoint);
  solveLocations(store, positions, indices, pending, K);
  pinSolved(store, positions, pinned, pending, K, cl, pinTol);
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
 * Places the face and cell vertices: each starts at the mean of its edge-vertex neighbours
 * (else its location's centre), then Newton steps (minimal norm, capped at NEWTON_CAP·edge,
 * at most NEWTON_ITERS of them, forward differences of FD_STEP·edge) take it onto its constraint:
 * one owner's side onto c_X = 0; owners merged beside air (the crease) onto the field and
 * c_X = c_Y together; owners merged away from air (a merged side facing a gap) onto
 * min over the members of c = 0.
 */
function solveLocations(store, positions, indices, pending, K) {
  if (!pending.length) return;
  const { edge, leaves, textures } = store;
  const nv = positions.length / 3, isPending = new Uint8Array(nv);
  for (const p of pending) isPending[p.v] = 1;
  const acc = new Float64Array(3 * nv), cnt = new Uint32Array(nv);
  for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = indices[t + k];
    if (!isPending[a]) continue;
    for (const b of [indices[t + ((k + 1) % 3)], indices[t + ((k + 2) % 3)]]) {
      if (isPending[b]) continue;
      acc[3 * a] += positions[3 * b]; acc[3 * a + 1] += positions[3 * b + 1]; acc[3 * a + 2] += positions[3 * b + 2]; cnt[a]++;
    }
  }
  for (const p of pending) if (cnt[p.v]) for (let k = 0; k < 3; k++) positions[3 * p.v + k] = acc[3 * p.v + k] / cnt[p.v];

  const byProg = new Map();
  for (const p of pending) pushTo(byProg, leaves[p.L].progIndex, p);
  const h = FD_STEP * edge, cap = NEWTON_CAP * edge, done = NEWTON_DONE * edge;
  const F = [0, 0], J = [[0, 0, 0], [0, 0, 0]];
  for (let list of byProg.values()) {
    const ev = evaluator(leaves[list[0].L].prog, textures, K, 4 * list.length);
    for (let it = 0; it < NEWTON_ITERS && list.length; it++) {
      // The point and a forward step along each axis.
      list.forEach((p, q) => {
        const x = positions[3 * p.v], y = positions[3 * p.v + 1], z = positions[3 * p.v + 2];
        for (let s = 0; s < 4; s++) {
          const o = 4 * q + s;
          ev.P[0][o] = s === 1 ? x + h : x; ev.P[1][o] = s === 2 ? y + h : y; ev.P[2][o] = s === 3 ? z + h : z;
        }
      });
      ev.run(4 * list.length);
      const next = [];
      list.forEach((p, q) => {
        const rows = p.members.length >= 2 && p.air ? 2 : 1;
        const fn = (s, row) => {
          const o = 4 * q + s, c = ev.cuts, M = p.members;
          if (M.length === 1) return c[o * K + M[0]];
          if (p.air) return row === 0 ? ev.out[o] : c[o * K + M[0]] - c[o * K + M[1]];
          let v = Infinity;
          for (const X of M) v = Math.min(v, c[o * K + X]);
          return v;
        };
        for (let r = 0; r < rows; r++) {
          F[r] = fn(0, r);
          for (let a = 0; a < 3; a++) J[r][a] = (fn(1 + a, r) - F[r]) / h;
        }
        let dx, dy, dz;
        if (rows === 1) {
          const g = J[0], g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
          if (!(g2 > 1e-12) || !Number.isFinite(F[0])) return;
          const s = -F[0] / g2;
          dx = g[0] * s; dy = g[1] * s; dz = g[2] * s;
        } else {
          const [a, b] = J, aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2], bb = b[0] * b[0] + b[1] * b[1] + b[2] * b[2], ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
          const det = aa * bb - ab * ab;
          if (!(det > 1e-12) || !Number.isFinite(F[0]) || !Number.isFinite(F[1])) return;
          const l0 = (-F[0] * bb + F[1] * ab) / det, l1 = (-F[1] * aa + F[0] * ab) / det;
          dx = a[0] * l0 + b[0] * l1; dy = a[1] * l0 + b[1] * l1; dz = a[2] * l0 + b[2] * l1;
        }
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!Number.isFinite(len)) return;
        const s = len > cap ? cap / len : 1;
        positions[3 * p.v] += dx * s; positions[3 * p.v + 1] += dy * s; positions[3 * p.v + 2] += dz * s;
        if (len > done) next.push(p);   // converged vertices drop out of later iterations
      });
      list = next;
    }
  }
}

/**
 * A plain vertex is held to its owner (ownerHeld = 1) when it lies beside an open edge or when
 * the field at its edge's outside end belongs to another piece (the owner's share there is
 * above the field): across a gap the field rises to a ridge between the pieces, so its linear
 * crossing can land by the other piece, and projecting onto the field would finish the bridge.
 * A held vertex goes onto its owner's share zero along its grid edge (bisected, as the side
 * vertices are), where that share changes sign along the edge; else it keeps the crossing.
 */
function placeHeldPlain(store, positions, vertOwner, ownerHeld, cand, K, keyPoint) {
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
    const list = [];   // [candidate index, edge index] of the held ones whose share changes sign
    all.forEach((q, e) => {
      const v = cand[q], o = vertOwner[v], inShare = ev.shares[2 * e * K + o], outShare = ev.shares[(2 * e + 1) * K + o];
      if (!ownerHeld[v] && !(outShare > ev.out[2 * e + 1])) return;
      ownerHeld[v] = 1;
      if (inShare < 0 && outShare > 0) list.push(e);
    });
    const cnt = list.length, lo = new Float64Array(cnt), hi = new Float64Array(cnt).fill(1);
    for (let it = 0; it < BISECT_STEPS && cnt; it++) {
      for (let k = 0; k < cnt; k++) lerpInto(list[k], (lo[k] + hi[k]) / 2, k);
      ev.run(cnt);
      for (let k = 0; k < cnt; k++) {
        const mid = (lo[k] + hi[k]) / 2;
        if (ev.shares[k * K + vertOwner[cand[all[list[k]]]]] < 0) lo[k] = mid; else hi[k] = mid;
      }
    }
    for (let k = 0; k < cnt; k++) {
      const e = list[k], v = cand[all[e]], t = (lo[k] + hi[k]) / 2;
      for (let c = 0; c < 3; c++) positions[3 * v + c] = A[3 * e + c] + (B[3 * e + c] - A[3 * e + c]) * t;
    }
  }
}

/**
 * Pins each solved face or cell vertex that landed on a gap face: no air at its location, on
 * its own side's surface (min over its members' cuts = 0) and with another piece's cut at the
 * clearance, all to within `tol`. An unconverged one stays free for cleanup to project.
 */
function pinSolved(store, positions, pinned, pending, K, cl, tol) {
  const byProg = new Map();
  for (const p of pending) if (!p.air && p.others.length) pushTo(byProg, store.leaves[p.L].progIndex, p);
  for (const list of byProg.values()) {
    const ev = evaluator(store.leaves[list[0].L].prog, store.textures, K, list.length);
    list.forEach((p, q) => { for (let k = 0; k < 3; k++) ev.P[k][q] = positions[3 * p.v + k]; });
    ev.run(list.length);
    list.forEach((p, q) => {
      let own = Infinity, gapFace = false;
      for (const X of p.members) own = Math.min(own, ev.cuts[q * K + X]);
      for (const Y of p.others) if (Math.abs(ev.cuts[q * K + Y] - cl) <= tol) gapFace = true;
      if (gapFace && Math.abs(own) <= tol) pinned[p.v] = 1;
    });
  }
}
