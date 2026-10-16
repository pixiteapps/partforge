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
import { nodeInterval } from "./interval.js";
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
 *  - fillRegions: (cx, cy, cz, rho) per region (FILL_STRIDE), the pad fill's gate;
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
      fill.push(c[0], c[1], c[2], rho);
      const A = n.bulge * Math.min(1, delta / BULGE_FULL_DEPTH);
      if (!(A > 0)) continue;   // bulge 0: an all-zero offset; leave the slot unbulged
      const rb = rho + BULGE_SPREAD * delta + 2 * n.bulge;
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
  const cells = [];   // [i, j, k, m] with m = max(d_a, d_b) < 0 at the cell centre
  let count = 0, over = false;
  const R3 = Math.sqrt(3) / 2;
  const rec = (i0, j0, k0, sz) => {
    if (over) return;
    const x0 = lo[0] + i0 * REGION_CELL, y0 = lo[1] + j0 * REGION_CELL, z0 = lo[2] + k0 * REGION_CELL;
    if (x0 > hi[0] || y0 > hi[1] || z0 > hi[2]) return;
    const h = (sz * REGION_CELL) / 2, cx = x0 + h, cy = y0 + h, cz = z0 + h;
    if (sz === 1) {
      if (++count > MAX_REGION_CELLS) { over = true; return; }
      const m = Math.max(evalNodeAt(compiled, ia, cx, cy, cz, SEARCH_EDGE), evalNodeAt(compiled, ib, cx, cy, cz, SEARCH_EDGE));
      if (m < 0) cells.push([i0, j0, k0, m]);
      return;
    }
    const r = 2 * h * R3;
    if (nodeInterval(compiled, ia, cx, cy, cz, r, SEARCH_EDGE).lo > 0) return;
    if (nodeInterval(compiled, ib, cx, cy, cz, r, SEARCH_EDGE).lo > 0) return;
    const s = sz / 2;
    for (let o = 0; o < 8; o++) rec(i0 + (o & 1 ? s : 0), j0 + (o & 2 ? s : 0), k0 + (o & 4 ? s : 0), s);
  };
  rec(0, 0, 0, S);
  if (over) return null;
  if (cells.length === 0) return [];

  // 26-connected clusters, over the cells in sorted (i, j, k) order; a cluster is ordered
  // by (and its sums run from) its first cell in that order.
  const key = (i, j, k) => (i * (S + 1) + j) * (S + 1) + k;
  cells.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const at = new Map(cells.map((p, idx) => [key(p[0], p[1], p[2]), idx]));
  const parent = cells.map((_, idx) => idx);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let idx = 0; idx < cells.length; idx++) {
    const [i, j, k] = cells[idx];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      if (i + di < 0 || j + dj < 0 || k + dk < 0) continue;
      const other = at.get(key(i + di, j + dj, k + dk));
      if (other === undefined) continue;
      const ra = find(idx), rb = find(other);
      if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; }
    }
  }
  const groups = new Map();   // root (its smallest index) → member indices, ascending
  for (let idx = 0; idx < cells.length; idx++) {
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
    const minM = deepest(compiled, ia, ib, centre(cells[best]), cells[best][3]);
    const c = [sx / members.length, sy / members.length, sz / members.length];
    let far = 0;
    for (const idx of members) { const q = centre(cells[idx]); far = Math.max(far, Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2])); }
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

// The 26 lattice directions, in a fixed order.
const DIRS = [];
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) DIRS.push([dx, dy, dz]);

/**
 * Refines a cluster's depth below the cell lattice: a deterministic pattern search for the
 * minimum of max(d_a, d_b) from its deepest cell centre (step REGION_CELL/2 halving to
 * REGION_CELL/128; each move to the best of the 26 neighbours, ties to the first in DIRS order). Without it δ is quantised
 * to the 0.5 mm lattice, and the bulge would not grow steadily with the press depth.
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
