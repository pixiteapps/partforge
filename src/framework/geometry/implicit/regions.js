// src/framework/geometry/implicit/regions.js
// Contact regions: where two children of a `contact` node actually overlap. Found once
// per compile, while lowering (pose facts, fixed per build; found before the node's box
// is taken, so the box pads by the bulge the regions actually give — none without a
// contact) and baked into the IR as constants, so the
// reference walk, the interval pass, the bytecode and the C++ core all read the same
// numbers. Each region drives a bulge on both pieces (`regions[slot]`, BULGE_STRIDE) and
// gates the gap-0 pad fill (`fillRegions`, FILL_STRIDE). Its own module, not contact.js:
// the search walks the reference and interval passes, which import contact.js.
import { evalNodeAt } from "./reference.js";
import { hypot3 } from "../js-math.js";
import {
  attachWeight, ATTACH_STRIDE, BULGE_STRIDE,
  REGION_CELL, BULGE_FULL_DEPTH, BULGE_SPREAD, MAX_REGION_CELLS,
} from "./contact.js";

// max over t of |d/dt (1 − t²)²| = 8 / (3√3), at t = 1/√3.
const PHI_SLOPE = 8 / (3 * Math.sqrt(3));

// The search runs at edge 0 (the bare declared gap): it happens at compile time, before any
// grid edge is known, so a nested contact child is searched with its own clearance at 0.
const SEARCH_EDGE = 0;

/**
 * Finds a contact node's regions while it is being lowered (ir.js), its children already
 * lowered — and, ids being post-order, any contact inside them already annotated. `view` is
 * { ir: { nodes }, textures } as far as lowering has got; `n` the contact node (children,
 * att, bulge). Works in the node's local coordinates from the UN-bulged children. Returns
 *  - regions: per slot, a Float64Array of (cx, cy, cz, A, rho) per region (BULGE_STRIDE);
 *  - fillRegions: (ia, ib, cx, cy, cz, rho) per region (FILL_STRIDE) of a fusing (gap-0)
 *    node — each the pad fill of its own pair; empty when the node does not fuse;
 *  - pad: the most any one slot's bulge can add to its field (Σ A), for the node's box;
 *  - Lb: the bulge's Lipschitz bound (a bulged piece is (L + Lb)-Lipschitz);
 *  - warnings: one per pair whose search ran past MAX_REGION_CELLS (it gets one conservative
 *    region over its whole box intersection instead of its clusters).
 */
export function contactRegions(view, n, path) {
  const N = n.children.length, per = n.children.map(() => []), fill = [], warnings = [];
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
    let clusters = pairClusters(view, n, a, b);
    if (!Array.isArray(clusters)) {
      // Too much overlap to resolve: one conservative region over the pair's whole box
      // intersection, so a gap-0 pair still fuses rather than being cut through.
      warnings.push(`implicit: ${path}: the contact search between children ${a} and ${b} found too much overlap to resolve (over ${MAX_REGION_CELLS} cells) — they get one region over their whole overlap (one bulge and fused pad); separate them, or make them one child`);
      clusters = clusters.region && !n.exact ? [clusters.region] : [];   // an exact node has no pad to fuse: no fallback region
    }
    for (const { c, delta, rho } of clusters) {
      if (n.fuse && !n.exact) fill.push(a, b, c[0], c[1], c[2], rho);   // the pair's pad fill (gap 0 only)
      // The bump's falloff radius grows with the press depth; its peak is the node's bulge
      // scaled by depth, so no one region swells a skin more than `bulge` mm — a piece's
      // regions add where they overlap (a flat contact's sides lie well inside rho: a height
      // set at the rim would blow up there).
      const rb = rho + BULGE_SPREAD * delta + 2 * n.bulge;
      const A = n.bulge * Math.min(1, delta / BULGE_FULL_DEPTH);
      if (!(A > 0)) continue;   // bulge 0: an all-zero offset; leave the slot unbulged
      per[a].push(c[0], c[1], c[2], A, rb);
      per[b].push(c[0], c[1], c[2], A, rb);
    }
  }
  const regions = per.map((r) => Float64Array.from(r));
  let pad = 0, Lb = 0;
  for (const R of regions) {
    let sA = 0, sL = 0;
    for (let o = 0; o < R.length; o += BULGE_STRIDE) { sA += R[o + 3]; sL += (R[o + 3] * PHI_SLOPE) / R[o + 4]; }
    pad = Math.max(pad, sA); Lb = Math.max(Lb, sL);
  }
  return { regions, fillRegions: Float64Array.from(fill), pad, Lb, warnings };
}

/**
 * The overlap clusters of slots a and b: [{ c, delta, rho }] in a deterministic order. A
 * search that passes MAX_REGION_CELLS entries returns { over: true, region } instead: ONE
 * conservative region over the whole box intersection (its centre, rho half its diagonal,
 * δ the deepest overlap seen before stopping; null when that centre lies in the pair's
 * attachment zone, as a cluster there would be dropped).
 */
function pairClusters(compiled, n, a, b) {   // compiled: the lowering view
  const nodes = compiled.ir.nodes, ia = n.children[a], ib = n.children[b];
  const A = nodes[ia].box, B = nodes[ib].box, lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    lo[i] = Math.max(A.min[i], B.min[i]); hi[i] = Math.min(A.max[i], B.max[i]);
    if (!(lo[i] <= hi[i])) return [];   // boxes apart: no overlap
    if (!Number.isFinite(lo[i]) || !Number.isFinite(hi[i])) return [];   // unbounded pair: not searched
  }
  // A cube lattice of REGION_CELL leaves anchored at the box's min corner.
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  let S = 1;
  while (S * REGION_CELL < ext) S *= 2;
  // The leaves in range on each axis: index i < S is in range while lo + i·REGION_CELL ≤ hi.
  const lim = [0, 1, 2].map((ax) => { let m = 0; while (m < S && lo[ax] + m * REGION_CELL <= hi[ax]) m++; return m; });
  // Entries [i, j, k, s, m, ni, nj, nk]: an octree block of s³ leaves (s = 1: one leaf) at
  // lattice corner (i, j, k), every leaf of it a region cell (m = max(d_a, d_b) < 0 at the
  // centre it was decided by), (ni, nj, nk) its leaves in range per axis. A block wholly
  // inside both pieces is one entry, so the budget counts the overlap's surface cells
  // (and its blocks), not its volume.
  let cells = [];
  let count = 0, over = false;
  // The deepest overlap seen (m < 0 at a point inside both), for the overflow region's δ.
  let bestM = Infinity, bestP = null;
  const seen = (m, x, y, z) => { if (m < bestM) { bestM = m; bestP = [x, y, z]; } };
  const R3 = Math.sqrt(3) / 2;
  // The pair's attachment (its first, either order — contactValue's rule), if any: its
  // joined zone (weight > 0) is not a contact, so a cell whose centre lies in it is not a
  // region cell, and a cell lying wholly inside it is not searched (the joined base of a
  // digit is a deep overlap the search would otherwise walk cell by cell).
  let ao = -1;
  for (let o = 0; o < n.att.length; o += ATTACH_STRIDE) {
    const sa = n.att[o], sb = n.att[o + 1];
    if ((sa === a && sb === b) || (sa === b && sb === a)) { ao = o; break; }
  }
  const zone = ao < 0 ? 0 : n.att[ao + 5] + n.att[ao + 6];   // the weight is > 0 below this distance
  // The children's L as Lipschitz bounds. L is the IR's pruning bound, not a true one for
  // every node (warp, displace and a nested contact can exceed it); a low bound only risks
  // the search skipping a region cell — never a wrong field value, since the regions only
  // place bulges and pad gates.
  const La = nodes[ia].L, Lb = nodes[ib].L;
  // pva/pvb: the parent cell's centre values (undefined at the root), r from it to this centre.
  const rec = (i0, j0, k0, sz, pva, pvb) => {
    if (over) return;
    if (i0 >= lim[0] || j0 >= lim[1] || k0 >= lim[2]) return;
    const x0 = lo[0] + i0 * REGION_CELL, y0 = lo[1] + j0 * REGION_CELL, z0 = lo[2] + k0 * REGION_CELL;
    const h = (sz * REGION_CELL) / 2, cx = x0 + h, cy = y0 + h, cz = z0 + h;
    const r = 2 * h * R3;
    let clear = true;   // the whole cell lies outside the attachment's joined zone
    if (ao >= 0) {
      const da = hypot3(cx - n.att[ao + 2], cy - n.att[ao + 3], cz - n.att[ao + 4]);
      if (sz === 1) { if (attachWeight(n.att, ao, cx, cy, cz) > 0) return; }
      else if (da + r < zone * (1 - 1e-9)) return;
      clear = da - r > zone * (1 + 1e-9);
    }
    if (sz === 1) {
      if (++count > MAX_REGION_CELLS) { over = true; return; }
      if (pva !== undefined) {
        // Decided by the parent's centre values where they suffice (the leaf's centre is r
        // from the parent's): outside either piece, or inside both.
        const ra = La * r * (1 + 1e-9) + 1e-12, rb = Lb * r * (1 + 1e-9) + 1e-12;
        if (pva > ra || pvb > rb) return;
        if (pva < -ra && pvb < -rb) { cells.push([i0, j0, k0, 1, Math.max(pva, pvb), 1, 1, 1]); return; }
      }
      const va = evalNodeAt(compiled, ia, cx, cy, cz, SEARCH_EDGE);
      if (!(va < 0)) return;   // not inside a: not a region cell (b need not be evaluated)
      const m = Math.max(va, evalNodeAt(compiled, ib, cx, cy, cz, SEARCH_EDGE));
      if (m < 0) { cells.push([i0, j0, k0, 1, m, 1, 1, 1]); seen(m, cx, cy, cz); }
      return;
    }
    // The pieces' values at the cell centre and their Lipschitz bounds: a piece more than
    // L·r outside at the centre is outside the whole cell (no overlap there), one more than
    // L·r inside is inside all of it. (The interval pass is far looser here: a smooth
    // union's interval drops by k/4 everywhere, so a blended palm reads "maybe inside"
    // within millimetres of its surface.)
    const va = evalNodeAt(compiled, ia, cx, cy, cz, SEARCH_EDGE), ra = La * r * (1 + 1e-9) + 1e-12;
    if (va > ra) return;
    const vb = evalNodeAt(compiled, ib, cx, cy, cz, SEARCH_EDGE), rb = Lb * r * (1 + 1e-9) + 1e-12;
    if (vb > rb) return;
    if (clear && va < -ra && vb < -rb) {
      // Wholly inside both pieces (and clear of any joined zone): every leaf is a region
      // cell, without evaluating it — one entry. Its m is the cell centre's — read only to
      // pick the cluster's deepest start, whose own value is then evaluated (below).
      if (++count > MAX_REGION_CELLS) { over = true; return; }
      const mHi = Math.max(va, vb);
      cells.push([i0, j0, k0, sz, mHi, Math.min(sz, lim[0] - i0), Math.min(sz, lim[1] - j0), Math.min(sz, lim[2] - k0)]);
      seen(mHi, cx, cy, cz);
      return;
    }
    const s = sz / 2;
    for (let o = 0; o < 8; o++) rec(i0 + (o & 1 ? s : 0), j0 + (o & 2 ? s : 0), k0 + (o & 4 ? s : 0), s, va, vb);
  };
  rec(0, 0, 0, S);
  if (over) {
    const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    if (ao >= 0 && attachWeight(n.att, ao, c[0], c[1], c[2]) > 0) return { over: true, region: null };
    let delta = 0;
    if (bestP !== null) {
      const v = Math.max(evalNodeAt(compiled, ia, bestP[0], bestP[1], bestP[2], SEARCH_EDGE), evalNodeAt(compiled, ib, bestP[0], bestP[1], bestP[2], SEARCH_EDGE));
      delta = Math.max(0, -deepest(compiled, ia, ib, bestP, v));
    }
    return { over: true, region: { c, delta, rho: hypot3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 } };
  }
  if (cells.length === 0) return [];

  // 26-connected clusters, over the entries in sorted (i, j, k) order of their corners (a
  // block's corner is its first leaf in that order; corners are unique, blocks being
  // disjoint); a cluster is ordered by (and its sums run from) its first entry. key orders
  // corners as (i, j, k) does (j, k ≤ S); packing the entry's index under its key sorts them.
  const nC = cells.length, key = (i, j, k) => (i * (S + 1) + j) * (S + 1) + k;
  const packed = new Float64Array(nC);
  for (let idx = 0; idx < nC; idx++) packed[idx] = key(cells[idx][0], cells[idx][1], cells[idx][2]) * IDX_SPAN + idx;
  packed.sort();
  cells = Array.from(packed, (v) => cells[v % IDX_SPAN]);
  // Entry lookups. Blocks larger than a leaf (few): a Map per size, by corner. Leaves: a
  // dense grid over their bounding box padded by one (so a neighbour is always in range),
  // or, past DENSE_MAX entries, an open-addressed hash.
  let i0 = Infinity, j0 = Infinity, k0 = Infinity, i1 = -Infinity, j1 = -Infinity, k1 = -Infinity, nLeaf = 0;
  const bySize = new Map();   // size > 1 → (corner key → index)
  for (let idx = 0; idx < nC; idx++) {
    const p = cells[idx];
    if (p[3] > 1) {
      if (!bySize.has(p[3])) bySize.set(p[3], new Map());
      bySize.get(p[3]).set(key(p[0], p[1], p[2]), idx);
      continue;
    }
    nLeaf++;
    i0 = Math.min(i0, p[0]); i1 = Math.max(i1, p[0]); j0 = Math.min(j0, p[1]); j1 = Math.max(j1, p[1]); k0 = Math.min(k0, p[2]); k1 = Math.max(k1, p[2]);
  }
  const sizes = [...bySize.keys()].sort((p, q) => p - q);   // the block sizes present, > 1
  // The block of size ≥ s holding the size-s cube at (ni, nj, nk), else −1.
  const blockAt = (ni, nj, nk, s, skipEqual) => {
    for (const t of sizes) {
      if (t < s || (skipEqual && t === s)) continue;
      const other = bySize.get(t).get(key(ni - (ni % t), nj - (nj % t), nk - (nk % t)));
      if (other !== undefined) return other;
    }
    return -1;
  };
  let leafAt = () => -1;   // the leaf entry at lattice position (i, j, k) of the leaves' padded box, else −1
  if (nLeaf > 0) {
    const NJ = j1 - j0 + 3, NK = k1 - k0 + 3, NV = (i1 - i0 + 3) * NJ * NK;
    if (NV <= DENSE_MAX) {
      const grid = new Int32Array(NV).fill(-1);
      const at = (i, j, k) => ((i - i0 + 1) * NJ + (j - j0 + 1)) * NK + (k - k0 + 1);
      for (let idx = 0; idx < nC; idx++) if (cells[idx][3] === 1) grid[at(cells[idx][0], cells[idx][1], cells[idx][2])] = idx;
      leafAt = (i, j, k) => grid[at(i, j, k)];
    } else {
      let P = 2, bits = 1;
      while (P < 2 * nLeaf) { P *= 2; bits++; }
      const slotKey = new Float64Array(P), slotIdx = new Int32Array(P).fill(-1);
      // Fibonacci hashing (the product's top bits) of the key's two 20-bit halves.
      const slot = (kv) => Math.imul((kv % 1048576) ^ Math.imul(Math.floor(kv / 1048576), 0x85ebca6b), 0x9e3779b1) >>> (32 - bits);
      for (let idx = 0; idx < nC; idx++) {
        if (cells[idx][3] !== 1) continue;
        const kv = Math.floor(packed[idx] / IDX_SPAN);
        let h = slot(kv);
        while (slotIdx[h] >= 0) h = (h + 1) & (P - 1);
        slotKey[h] = kv; slotIdx[h] = idx;
      }
      leafAt = (i, j, k) => {
        const kv = key(i, j, k);
        for (let h = slot(kv); slotIdx[h] >= 0; h = (h + 1) & (P - 1)) if (slotKey[h] === kv) return slotIdx[h];
        return -1;
      };
    }
  }
  const parent = new Int32Array(nC);
  for (let idx = 0; idx < nC; idx++) parent[idx] = idx;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const link = (x, y) => {
    const ra = find(x), rb = find(y);
    if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; }
  };
  // Leaves: each linked to the leaves among its 13 neighbours before it (IS_BACK) — a leaf
  // pair is seen from both of its leaves, so that links it once; a leaf beside a block in
  // another direction is linked from the block's side (below).
  // Blocks: octree blocks of size t sit at multiples of t, so the same-size cube beside a
  // block of size s lies wholly inside any block of size ≥ s that meets it — linking each
  // block to the block (at most one) holding each of its 26 neighbour cubes, at its own size
  // (13 directions, as for leaves) or larger, finds every block pair from its smaller side;
  // and each block is linked to every leaf on its shell (the leaf positions touching it).
  for (let idx = 0; idx < nC; idx++) {
    const e = cells[idx], i = e[0], j = e[1], k = e[2], s = e[3];
    for (let d = 0; d < DIRS.length; d++) {
      if (s === 1 && !IS_BACK[d]) continue;
      const ni = i + DIRS[d][0] * s, nj = j + DIRS[d][1] * s, nk = k + DIRS[d][2] * s;
      if (ni < 0 || nj < 0 || nk < 0 || ni >= lim[0] || nj >= lim[1] || nk >= lim[2]) continue;
      const other = s === 1 ? leafAt(ni, nj, nk) : blockAt(ni, nj, nk, s, !IS_BACK[d]);
      if (other >= 0) link(idx, other);
    }
    if (s === 1 || nLeaf === 0) continue;
    // The shell, clipped to the leaves' padded box (no leaf lies outside it).
    const a0 = Math.max(i - 1, i0 - 1, 0), a1 = Math.min(i + e[5], i1 + 1, lim[0] - 1);
    const b0 = Math.max(j - 1, j0 - 1, 0), b1 = Math.min(j + e[6], j1 + 1, lim[1] - 1);
    const c0 = Math.max(k - 1, k0 - 1, 0), c1 = Math.min(k + e[7], k1 + 1, lim[2] - 1);
    const touch = (x, y, z) => { const o = leafAt(x, y, z); if (o >= 0) link(idx, o); };
    for (let x = a0; x <= a1; x++) for (let y = b0; y <= b1; y++) {
      if (x < i || x >= i + e[5] || y < j || y >= j + e[6]) { for (let z = c0; z <= c1; z++) touch(x, y, z); continue; }
      if (k - 1 >= c0) touch(x, y, k - 1);
      if (k + e[7] <= c1) touch(x, y, k + e[7]);
    }
  }
  const groups = new Map();   // root (its smallest index) → member indices, ascending
  for (let idx = 0; idx < nC; idx++) {
    const root = find(idx);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(idx);
  }
  // A leaf's centre; an entry's first leaf's (its corner leaf).
  const centre = (i, j, k) => [lo[0] + (i + 0.5) * REGION_CELL, lo[1] + (j + 0.5) * REGION_CELL, lo[2] + (k + 0.5) * REGION_CELL];
  const out = [];
  for (const root of [...groups.keys()].sort((p, q) => p - q)) {
    const members = groups.get(root);
    let sx = 0, sy = 0, sz = 0, nLeaves = 0, best = members[0];
    for (const idx of members) {
      // An entry's leaves' centres sum to its leaf count times their centre.
      const e = cells[idx], w = e[5] * e[6] * e[7];
      sx += w * (lo[0] + (e[0] + e[5] / 2) * REGION_CELL);
      sy += w * (lo[1] + (e[1] + e[6] / 2) * REGION_CELL);
      sz += w * (lo[2] + (e[2] + e[7] / 2) * REGION_CELL);
      nLeaves += w;
      if (e[4] < cells[best][4]) best = idx;
    }
    // The deepest entry's m may be a filled block's centre value: refine from its first leaf's own.
    const p0 = centre(cells[best][0], cells[best][1], cells[best][2]);
    const minM = deepest(compiled, ia, ib, p0, Math.max(evalNodeAt(compiled, ia, p0[0], p0[1], p0[2], SEARCH_EDGE), evalNodeAt(compiled, ib, p0[0], p0[1], p0[2], SEARCH_EDGE)));
    const c = [sx / nLeaves, sy / nLeaves, sz / nLeaves];
    let far = 0;
    // Per entry, the leaf centre farthest from c: on each axis, its end leaf farther from c.
    const ext1 = (e, ax) => {
      const a0 = lo[ax] + (e[ax] + 0.5) * REGION_CELL, a1 = lo[ax] + (e[ax] + e[5 + ax] - 0.5) * REGION_CELL;
      return Math.max(Math.abs(a0 - c[ax]), Math.abs(a1 - c[ax]));
    };
    for (const idx of members) { const e = cells[idx]; far = Math.max(far, hypot3(ext1(e, 0), ext1(e, 1), ext1(e, 2))); }
    // The joined base of an attached pair is not a contact: no bulge, and its blend fills it.
    let attached = false;
    for (let o = 0; o < n.att.length; o += ATTACH_STRIDE) {
      const sa = n.att[o], sb = n.att[o + 1];
      if (((sa === a && sb === b) || (sa === b && sb === a)) && attachWeight(n.att, o, c[0], c[1], c[2]) > 0) { attached = true; break; }
    }
    if (attached) continue;
    out.push({ c, delta: -minM, rho: far + REGION_CELL / 2 });
  }
  return out;
}

// Entry indices packed under their keys (entries ≤ MAX_REGION_CELLS + 1 < IDX_SPAN).
const IDX_SPAN = 32768;
// The largest dense leaf-lookup grid (entries) before the clustering falls back to a hash.
const DENSE_MAX = 1 << 21;

// The 26 lattice directions, in a fixed order, and which of them lie lexicographically
// before the origin.
const DIRS = [];
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) DIRS.push([dx, dy, dz]);
const IS_BACK = DIRS.map(([dx, dy, dz]) => dx < 0 || (dx === 0 && (dy < 0 || (dy === 0 && dz < 0))));

/**
 * Refines a cluster's depth below the cell lattice: a deterministic pattern search for the
 * minimum of max(d_a, d_b) from its deepest cell centre (step REGION_CELL/2 halving to
 * REGION_CELL/128; each move to the best of the 26 neighbours, ties to the first in DIRS order). Without it δ is quantised
 * to the cell lattice, and the bulge would not grow steadily with the press depth.
 */
function deepest(view, ia, ib, p, m) {
  let x = p[0], y = p[1], z = p[2], step = REGION_CELL / 2;
  for (let moves = 0; step >= REGION_CELL / 128 && moves < 256; moves++) {
    let bi = -1;
    for (let d = 0; d < DIRS.length; d++) {
      const qx = x + DIRS[d][0] * step, qy = y + DIRS[d][1] * step, qz = z + DIRS[d][2] * step;
      const v = Math.max(evalNodeAt(view, ia, qx, qy, qz, SEARCH_EDGE), evalNodeAt(view, ib, qx, qy, qz, SEARCH_EDGE));
      if (v < m) { m = v; bi = d; }
    }
    if (bi < 0) { step /= 2; continue; }
    x += DIRS[bi][0] * step; y += DIRS[bi][1] * step; z += DIRS[bi][2] * step;
  }
  return m;
}

/** FNV-1a over every contact node's region floats (with their counts), in node order: a content-hash digest. */
export function regionDigest(nodes) {
  let h = 0x811c9dc5;
  const eat = (arr) => {
    const bytes = new Uint8Array(Float64Array.from([arr.length, ...arr]).buffer);
    for (const v of bytes) h = Math.imul(h ^ v, 0x01000193) >>> 0;
  };
  for (const n of nodes) {
    if (n.kind !== "contact") continue;
    for (const R of n.regions) eat(R);
    eat(n.fillRegions);
  }
  return `contact-regions:${h.toString(16).padStart(8, "0")}`;
}
