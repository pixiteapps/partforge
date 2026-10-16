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
 *  - warnings: one per pair whose search ran past MAX_REGION_CELLS (it keeps no regions).
 */
export function contactRegions(view, n, path) {
  const N = n.children.length, per = n.children.map(() => []), fill = [], warnings = [];
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
    const clusters = pairClusters(view, n, a, b);
    if (clusters === null) {
      warnings.push(`implicit: ${path}: the contact search between children ${a} and ${b} found too much overlap to resolve (over ${MAX_REGION_CELLS} cells) — they get no bulge and no fused pad; separate them, or make them one child`);
      continue;
    }
    for (const { c, delta, rho } of clusters) {
      if (n.fuse) fill.push(a, b, c[0], c[1], c[2], rho);   // the pair's pad fill (gap 0 only)
      // The bump's falloff radius grows with the press depth; its peak is the node's bulge
      // scaled by depth, so no skin anywhere swells more than `bulge` mm (a flat contact's
      // sides lie well inside rho: a height set at the rim would blow up there).
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
 * The overlap clusters of slots a and b: [{ c, delta, rho }] in a deterministic order, or
 * null when the search passed MAX_REGION_CELLS leaf cells.
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
  let cells = [];   // [i, j, k, m] with m = max(d_a, d_b) < 0 at the cell centre
  let count = 0, over = false;
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
  const La = nodes[ia].L, Lb = nodes[ib].L;
  // pva/pvb: the parent cell's centre values (undefined at the root), r from it to this centre.
  const rec = (i0, j0, k0, sz, pva, pvb) => {
    if (over) return;
    const x0 = lo[0] + i0 * REGION_CELL, y0 = lo[1] + j0 * REGION_CELL, z0 = lo[2] + k0 * REGION_CELL;
    if (x0 > hi[0] || y0 > hi[1] || z0 > hi[2]) return;
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
        if (pva < -ra && pvb < -rb) { cells.push([i0, j0, k0, Math.max(pva, pvb)]); return; }
      }
      const va = evalNodeAt(compiled, ia, cx, cy, cz, SEARCH_EDGE);
      if (!(va < 0)) return;   // not inside a: not a region cell (b need not be evaluated)
      const m = Math.max(va, evalNodeAt(compiled, ib, cx, cy, cz, SEARCH_EDGE));
      if (m < 0) cells.push([i0, j0, k0, m]);
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
      // cell, without evaluating it. Its m is the cell centre's — read only to pick the
      // cluster's deepest start, whose own value is then evaluated (below).
      const mHi = Math.max(va, vb);
      for (let i = i0; i < i0 + sz; i++) {
        if (lo[0] + i * REGION_CELL > hi[0]) break;
        for (let j = j0; j < j0 + sz; j++) {
          if (lo[1] + j * REGION_CELL > hi[1]) break;
          for (let k = k0; k < k0 + sz; k++) {
            if (lo[2] + k * REGION_CELL > hi[2]) break;
            if (++count > MAX_REGION_CELLS) { over = true; return; }
            cells.push([i, j, k, mHi]);
          }
        }
      }
      return;
    }
    const s = sz / 2;
    for (let o = 0; o < 8; o++) rec(i0 + (o & 1 ? s : 0), j0 + (o & 2 ? s : 0), k0 + (o & 4 ? s : 0), s, va, vb);
  };
  rec(0, 0, 0, S);
  if (over) return null;
  if (cells.length === 0) return [];

  // 26-connected clusters, over the cells in sorted (i, j, k) order; a cluster is ordered
  // by (and its sums run from) its first cell in that order. key orders cells as (i, j, k)
  // does (j, k ≤ S); keys are unique, so packing the cell's index under its key sorts them.
  const nC = cells.length, key = (i, j, k) => (i * (S + 1) + j) * (S + 1) + k;
  const packed = new Float64Array(nC);
  for (let idx = 0; idx < nC; idx++) packed[idx] = key(cells[idx][0], cells[idx][1], cells[idx][2]) * IDX_SPAN + idx;
  packed.sort();
  cells = Array.from(packed, (v) => cells[v % IDX_SPAN]);
  // A cell → index lookup: a dense grid over the cells' bounding box (padded by one, so a
  // neighbour is always in range), or, past DENSE_MAX entries, an open-addressed hash.
  let i0 = Infinity, j0 = Infinity, k0 = Infinity, i1 = -Infinity, j1 = -Infinity, k1 = -Infinity;
  for (const p of cells) { i0 = Math.min(i0, p[0]); i1 = Math.max(i1, p[0]); j0 = Math.min(j0, p[1]); j1 = Math.max(j1, p[1]); k0 = Math.min(k0, p[2]); k1 = Math.max(k1, p[2]); }
  const NJ = j1 - j0 + 3, NK = k1 - k0 + 3, NV = (i1 - i0 + 3) * NJ * NK;
  let lookup;
  if (NV <= DENSE_MAX) {
    const grid = new Int32Array(NV).fill(-1);
    const at = (i, j, k) => ((i - i0 + 1) * NJ + (j - j0 + 1)) * NK + (k - k0 + 1);
    for (let idx = 0; idx < nC; idx++) grid[at(cells[idx][0], cells[idx][1], cells[idx][2])] = idx;
    lookup = (i, j, k) => grid[at(i, j, k)];
  } else {
    let P = 2, bits = 1;
    while (P < 2 * nC) { P *= 2; bits++; }
    const slotKey = new Float64Array(P), slotIdx = new Int32Array(P).fill(-1);
    // Fibonacci hashing (the product's top bits) of the key's two 20-bit halves.
    const slot = (kv) => Math.imul((kv % 1048576) ^ Math.imul(Math.floor(kv / 1048576), 0x85ebca6b), 0x9e3779b1) >>> (32 - bits);
    for (let idx = 0; idx < nC; idx++) {
      const kv = Math.floor(packed[idx] / IDX_SPAN);
      let h = slot(kv);
      while (slotIdx[h] >= 0) h = (h + 1) & (P - 1);
      slotKey[h] = kv; slotIdx[h] = idx;
    }
    lookup = (i, j, k) => {
      if (i < 0 || j < 0 || k < 0) return -1;
      const kv = key(i, j, k);
      for (let h = slot(kv); slotIdx[h] >= 0; h = (h + 1) & (P - 1)) if (slotKey[h] === kv) return slotIdx[h];
      return -1;
    };
  }
  const parent = new Int32Array(nC);
  for (let idx = 0; idx < nC; idx++) parent[idx] = idx;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  // Each adjacency is seen from both of its cells, so linking every cell to its 13 lattice
  // neighbours before it (BACK) links every pair once; roots are the smallest index either way.
  for (let idx = 0; idx < nC; idx++) {
    const i = cells[idx][0], j = cells[idx][1], k = cells[idx][2];
    for (let d = 0; d < BACK.length; d++) {
      const other = lookup(i + BACK[d][0], j + BACK[d][1], k + BACK[d][2]);
      if (other < 0) continue;
      const ra = find(idx), rb = find(other);
      if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; }
    }
  }
  const groups = new Map();   // root (its smallest index) → member indices, ascending
  for (let idx = 0; idx < nC; idx++) {
    const root = find(idx);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(idx);
  }
  const centre = (p) => [lo[0] + (p[0] + 0.5) * REGION_CELL, lo[1] + (p[1] + 0.5) * REGION_CELL, lo[2] + (p[2] + 0.5) * REGION_CELL];
  const out = [];
  for (const root of [...groups.keys()].sort((p, q) => p - q)) {
    const members = groups.get(root);
    let sx = 0, sy = 0, sz = 0, best = members[0];
    for (const idx of members) { const q = centre(cells[idx]); sx += q[0]; sy += q[1]; sz += q[2]; if (cells[idx][3] < cells[best][3]) best = idx; }
    // The deepest cell's m may be a filled block's centre value: refine from its own.
    const p0 = centre(cells[best]);
    const minM = deepest(compiled, ia, ib, p0, Math.max(evalNodeAt(compiled, ia, p0[0], p0[1], p0[2], SEARCH_EDGE), evalNodeAt(compiled, ib, p0[0], p0[1], p0[2], SEARCH_EDGE)));
    const c = [sx / members.length, sy / members.length, sz / members.length];
    let far = 0;
    for (const idx of members) { const q = centre(cells[idx]); far = Math.max(far, hypot3(q[0] - c[0], q[1] - c[1], q[2] - c[2])); }
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

// Cell indices packed under their keys (MAX_REGION_CELLS < IDX_SPAN).
const IDX_SPAN = 32768;
// The largest dense cell-lookup grid (entries) before the clustering falls back to a hash.
const DENSE_MAX = 1 << 21;

// The 26 lattice directions, in a fixed order.
const DIRS = [];
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) DIRS.push([dx, dy, dz]);
// The 13 of them lexicographically before the origin.
const BACK = DIRS.filter(([dx, dy, dz]) => dx < 0 || (dx === 0 && (dy < 0 || (dy === 0 && dz < 0))));

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
