// src/framework/oracle/bvh.js
// Triangle BVH over a mesh in either Manifold non-indexed soup form (9 floats per
// triangle, no `indices`) or OCCT indexed form (`positions` = 3 floats/vertex +
// `indices` = 3 vertex-indices/triangle). A reusable spatial index: nearest ray hit
// (raycast), nearest surface point (closestPoint), and exact mesh-to-mesh distance
// (distanceTo). AABB tree built by a binned surface-area heuristic (sahSplit),
// slab ray–box test with nearer-child-first traversal and pruning.
//
// STORAGE — four flat typed arrays, no per-triangle and no per-node JS objects.
// The nested-array representation this replaced ([[x,y,z],[x,y,z],[x,y,z]] per
// triangle, wrapped in an object carrying min/max/centroid arrays, hung off object
// nodes) cost ~950 bytes and ~7 heap objects per triangle: 350 MB for a 400k-triangle
// mesh, which is what OOM-killed the inspect job in mobile Safari. This costs ~75
// bytes/triangle for a Manifold soup, and every query allocates only its own stack.
//
//   vertices  9 coords per triangle (v0,v1,v2 interleaved), in MESH order — so the
//             triangle ids in raycast's `tri`/`skipTri` are still mesh indices.
//             Float32 in, Float32 out: a Manifold soup is already float32, and
//             widening it would double the footprint without adding a bit of
//             precision, while a mesh whose positions are plain JS numbers (OCCT,
//             hand-written fixtures) is kept in a Float64Array. Either copy is
//             exact, so no reading changes with the representation. Exposed
//             READ-ONLY: every node bound was computed from these coords at build
//             time, so writing into the array silently invalidates the whole tree
//             (queries would prune against boxes that no longer contain their
//             triangles). Read it through readTriangleInto() rather than
//             open-coding the stride.
//   order     Uint32 triangle ids, permuted by the build so each leaf owns a
//             contiguous run (at most MAX_LEAF). The vertices themselves never
//             move.
//   bounds    Float64, 6 per node: [minx,miny,minz, maxx,maxy,maxz]. Kept at double
//             precision whatever the vertices are — a narrowed bound would have to
//             be rounded outward to stay conservative, and node bounds are a small
//             fraction of the total anyway (well under one node per triangle).
//   meta      Uint32, 2 per node. A LEAF is [firstIndexIntoOrder, count + 1]; an
//             INTERNAL node is [rightChildIndex, 0]. The +1 is what lets an empty
//             mesh's root still read as a leaf instead of as an internal node
//             pointing at itself. Nodes are laid out in pre-order, so an internal
//             node's left child is always the next node.

import { core, poisonCore } from "../core/core.js";
import { buildCoreBVH } from "../core/bvh-core.js";

// The build (buildBVH): a binned surface-area heuristic. Each node is split
// where the two children's box areas, weighted by their triangle counts, sum
// least — the split that makes a query least likely to have to visit both — so
// sibling boxes overlap far less than a median split's do. Measured on the
// reference parts against the median build this replaced (native core): min-wall
// ~2.9x, closest point ~2x, mesh-to-mesh distance ~36x (lattice-box ~400x, whose
// median boxes overlapped so badly that its gap check was nearly brute force),
// and the build itself ~1.2x FASTER; in this JS, min-wall ~2.2x and the build
// ~1.1x faster.
//
// It is DETERMINISTIC by construction and has a C++ twin (native/bvh.cpp) that
// must build the same tree bit for bit, so: no sort anywhere (a NaN key would
// make a comparison sort's order the algorithm's own), a STABLE partition, the
// bin index and every cost computed by the same expressions in the same order,
// ties going to the first candidate (lowest axis, then lowest bin).
const BINS = 16;          // candidate split planes per axis, per node
const MAX_LEAF = 8;       // a node over more triangles is always split
const DEPTH_LIMIT = 48;   // past this depth, split ranges in half (bounds the tree's depth)

// Which of the BINS bins a centroid coordinate falls in. NaN lands in bin 0.
function binOf(c, lo, scale) {
  const b = Math.floor((c - lo) * scale);
  return b >= BINS ? BINS - 1 : b >= 0 ? b : 0;
}
// Half the surface area of a box (the factor of 2 cancels in every comparison).
const halfArea = (x0, y0, z0, x1, y1, z1) => {
  const x = x1 - x0, y = y1 - y0, z = z1 - z0;
  return x * y + y * z + z * x;
};

// Coords per triangle in a `vertices` store: v0,v1,v2 interleaved. The ONE place
// this layout is decoded outside the queries below — copy triangle `t` of `V` into
// `out` (9 numbers: x0,y0,z0, x1,y1,z1, x2,y2,z2) and hand callers a reusable
// buffer, so nobody else has to know the stride and no per-triangle garbage is
// made. min-wall casts one ray per triangle through this.
export function readTriangleInto(V, t, out) {
  const o = t * 9;
  for (let i = 0; i < 9; i++) out[i] = V[o + i];
  return out;
}

// Triangles as [v0,v1,v2] coord triples, from either a Manifold non-indexed soup
// (positions = 9 floats/triangle, no indices) or an OCCT indexed mesh (positions =
// 3 floats/vertex + indices = 3 vertex-indices/triangle). A convenience for callers
// that want plain arrays; the BVH itself reads triangleVertices() below, because
// this shape costs four heap objects per triangle.
export function meshTriangles(mesh) {
  const { positions, indices } = mesh;
  if (indices) {
    const n = indices.length / 3, out = new Array(n);
    for (let t = 0; t < n; t++) {
      const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
      out[t] = [[positions[a], positions[a + 1], positions[a + 2]],
                [positions[b], positions[b + 1], positions[b + 2]],
                [positions[c], positions[c + 1], positions[c + 2]]];
    }
    return out;
  }
  const n = positions.length / 9, out = new Array(n);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    out[t] = [[positions[o], positions[o + 1], positions[o + 2]],
              [positions[o + 3], positions[o + 4], positions[o + 5]],
              [positions[o + 6], positions[o + 7], positions[o + 8]]];
  }
  return out;
}

// The same triangles, flat: one typed array of 9 coords per triangle in mesh order.
// Float32 source → Float32Array (lossless, and half the bytes); anything else →
// Float64Array (plain JS numbers are doubles and must stay doubles).
export function triangleVertices(mesh) {
  const { positions, indices } = mesh;
  const Store = positions instanceof Float32Array ? Float32Array : Float64Array;
  if (indices) {
    const n = indices.length / 3, verts = new Store(n * 9);
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      for (let k = 0; k < 3; k++) {
        const s = indices[3 * t + k] * 3;
        verts[o + 3 * k] = positions[s];
        verts[o + 3 * k + 1] = positions[s + 1];
        verts[o + 3 * k + 2] = positions[s + 2];
      }
    }
    return verts;
  }
  const n = positions.length / 9;
  if (positions instanceof Float32Array) return positions.slice(0, n * 9);
  const verts = new Store(n * 9);
  for (let i = 0; i < n * 9; i++) verts[i] = positions[i];
  return verts;
}

// slab test: where the ray enters node `nb`'s box within (tMin, best], or
// Infinity if it doesn't meet it there.
function rayEntry(ox, oy, oz, ix, iy, iz, B, nb, tMin, best) {
  let t0 = tMin, t1 = best;
  let lo = (B[nb] - ox) * ix, hi = (B[nb + 3] - ox) * ix;
  if (lo > hi) { const s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
  if (t0 > t1) return Infinity;
  lo = (B[nb + 1] - oy) * iy; hi = (B[nb + 4] - oy) * iy;
  if (lo > hi) { const s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
  if (t0 > t1) return Infinity;
  lo = (B[nb + 2] - oz) * iz; hi = (B[nb + 5] - oz) * iz;
  if (lo > hi) { const s = lo; lo = hi; hi = s; }
  if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
  return t0 <= t1 ? t0 : Infinity;
}

// nearest point on triangle `base` of `V` to P (Ericson), returns { point, d2 }
function closestOnTri(P, V, base) {
  const A = [V[base], V[base + 1], V[base + 2]];
  const B = [V[base + 3], V[base + 4], V[base + 5]];
  const C = [V[base + 6], V[base + 7], V[base + 8]];
  const sub = (p, q) => [p[0]-q[0], p[1]-q[1], p[2]-q[2]];
  const dot = (p, q) => p[0]*q[0] + p[1]*q[1] + p[2]*q[2];
  const add = (p, q) => [p[0]+q[0], p[1]+q[1], p[2]+q[2]];
  const mul = (p, s) => [p[0]*s, p[1]*s, p[2]*s];
  const ab = sub(B,A), ac = sub(C,A), ap = sub(P,A);
  const d1 = dot(ab,ap), d2 = dot(ac,ap);
  let Q;
  if (d1<=0&&d2<=0) Q = A;
  else { const bp = sub(P,B), d3 = dot(ab,bp), d4 = dot(ac,bp);
    if (d3>=0&&d4<=d3) Q = B;
    else { const vc = d1*d4 - d3*d2;
      if (vc<=0&&d1>=0&&d3<=0) Q = add(A, mul(ab, d1/(d1-d3)));
      else { const cp = sub(P,C), d5 = dot(ab,cp), d6 = dot(ac,cp);
        if (d6>=0&&d5<=d6) Q = C;
        else { const vb = d5*d2 - d1*d6;
          if (vb<=0&&d2>=0&&d6<=0) Q = add(A, mul(ac, d2/(d2-d6)));
          else { const va = d3*d6 - d5*d4;
            if (va<=0&&(d4-d3)>=0&&(d5-d6)>=0) Q = add(B, mul(sub(C,B), (d4-d3)/((d4-d3)+(d5-d6))));
            else { const denom = 1/(va+vb+vc); Q = add(add(A, mul(ab, vb*denom)), mul(ac, vc*denom)); } } } } } }
  const pq = sub(P, Q);
  return { point: Q, d2: dot(pq, pq) };
}

// squared distance from a point to node `nb`'s AABB (0 inside)
function distSqBox(px, py, pz, B, nb) {
  const x = px < B[nb] ? B[nb] - px : px > B[nb + 3] ? px - B[nb + 3] : 0;
  const y = py < B[nb + 1] ? B[nb + 1] - py : py > B[nb + 4] ? py - B[nb + 4] : 0;
  const z = pz < B[nb + 2] ? B[nb + 2] - pz : pz > B[nb + 5] ? pz - B[nb + 5] : 0;
  return x * x + y * y + z * z;
}

// summed extent of a node's AABB — the "which node is larger" heuristic for dual traversal
const nodeExtent = (B, nb) => (B[nb + 3] - B[nb]) + (B[nb + 4] - B[nb + 1]) + (B[nb + 5] - B[nb + 2]);

// squared distance between two nodes' AABBs (0 when they overlap)
function boxBoxDistSq(A, na, B, nb) {
  let s = 0;
  for (let ax = 0; ax < 3; ax++) {
    const v = A[na + ax] > B[nb + 3 + ax] ? A[na + ax] - B[nb + 3 + ax]
      : B[nb + ax] > A[na + 3 + ax] ? B[nb + ax] - A[na + 3 + ax] : 0;
    s += v * v;
  }
  return s;
}

// closest points between segments P1→Q1 and P2→Q2 (Ericson 5.1.9), → { a, b, d2 }
function closestSegSeg(P1, Q1, P2, Q2) {
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const d1 = sub(Q1, P1), d2v = sub(Q2, P2), r = sub(P1, P2);
  const a = dot(d1, d1), e = dot(d2v, d2v), f = dot(d2v, r);
  const EPS = 1e-12;
  let s, t;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2v), denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const A = [P1[0] + d1[0] * s, P1[1] + d1[1] * s, P1[2] + d1[2] * s];
  const B = [P2[0] + d2v[0] * t, P2[1] + d2v[1] * t, P2[2] + d2v[2] * t];
  const pq = sub(A, B);
  return { a: A, b: B, d2: dot(pq, pq) };
}

// exact min distance between triangle `b1` of `V1` and triangle `b2` of `V2`
// → { d2, a, b } (a on the first, b on the second). Non-intersecting triangles
// realize their minimum at a vertex-face or edge-edge feature pair; a piercing
// edge (interior×interior crossing) is caught first with rayTri, since feature
// distances alone would miss it. rayTri's t is in units of the unnormalized edge
// direction, so 0 < t <= 1 means the segment itself pierces; parallel/grazing
// edges return Infinity and the coplanar cases fall to the feature distances.
function triTriDist(V1, b1, V2, b2) {
  const verts = (V, b) => [[V[b], V[b+1], V[b+2]], [V[b+3], V[b+4], V[b+5]], [V[b+6], V[b+7], V[b+8]]];
  const t1 = verts(V1, b1), t2 = verts(V2, b2);
  const edges = (t) => [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]];
  for (const [p, q] of edges(t1)) {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const t = rayTri(p[0], p[1], p[2], d[0], d[1], d[2], V2, b2, 0);
    if (t <= 1) { const at = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t]; return { d2: 0, a: at, b: at }; }
  }
  for (const [p, q] of edges(t2)) {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const t = rayTri(p[0], p[1], p[2], d[0], d[1], d[2], V1, b1, 0);
    if (t <= 1) { const at = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t]; return { d2: 0, a: at, b: at }; }
  }
  let best = { d2: Infinity, a: null, b: null };
  for (const v of t2) {
    const r = closestOnTri(v, V1, b1);
    if (r.d2 < best.d2) best = { d2: r.d2, a: r.point, b: v };
  }
  for (const v of t1) {
    const r = closestOnTri(v, V2, b2);
    if (r.d2 < best.d2) best = { d2: r.d2, a: v, b: r.point };
  }
  for (const [p1, q1] of edges(t1)) for (const [p2, q2] of edges(t2)) {
    const r = closestSegSeg(p1, q1, p2, q2);
    if (r.d2 < best.d2) best = { d2: r.d2, a: r.a, b: r.b };
  }
  return best;
}

// Möller–Trumbore against triangle `base` of `V`; returns t>tMin or Infinity.
// Scalars throughout — this is the inner loop of every raycast, and min-wall casts
// one ray per sampled triangle.
function rayTri(ox, oy, oz, dx, dy, dz, V, base, tMin) {
  const ax = V[base], ay = V[base + 1], az = V[base + 2];
  const e1x = V[base + 3] - ax, e1y = V[base + 4] - ay, e1z = V[base + 5] - az;
  const e2x = V[base + 6] - ax, e2y = V[base + 7] - ay, e2z = V[base + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return Infinity;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > tMin ? t : Infinity;
}

// The BVH for `mesh`, memoized in a CALLER-OWNED Map keyed on the mesh object.
// THE ONE HOME for the caller-owned-Map doctrine; the callers below just point here.
//
// Exists because two passes over the same posed meshes each want an index —
// min-wall casts rays, meshGaps measures pair distances — and building both is a
// second full index per sub-part at ~77 bytes/triangle. measure() owns the Map and
// hands the same one (or, for min-wall, the resolved index) to both passes.
//
// `cache` is optional everywhere, and with none this is exactly buildBVH: the
// direct callers that have no second pass to share with (assemblyGaps' bare
// meshGaps, the tests) keep today's behaviour of building fresh. The Map is
// deliberately the caller's, not a module-level WeakMap: a WeakMap keyed on
// meshes would keep an index alive for as long as anything held its mesh, which
// is the quiet retention this pass exists to remove. Here the index's lifetime is
// visibly the caller's scope.
//
// The native core (core/core.js) is used only where partforge OWNS the index's
// lifetime: with no Map (the caller — meshGaps — frees it), or with a Map made
// by coreBVHCache() (measure()'s, freed by measure()). Those get the core's
// index (core/bvh-core.js): same queries, same bits, living in WebAssembly
// memory until disposeBVHs(). A caller's own plain Map — meshGaps' public
// `bvhCache` option — and buildBVH() itself keep getting the JS index, exactly
// as before: code outside partforge is never handed something it must free.
export function cachedBVH(mesh, cache) {
  if (!cache) return indexFor(mesh, true);
  let bvh = cache.get(mesh);
  if (!bvh) cache.set(mesh, (bvh = indexFor(mesh, cache[CORE_CACHE] === true)));
  return bvh;
}

const CORE_CACHE = Symbol("coreBVHCache");
// A Map for cachedBVH that may hold core indexes — its owner must disposeBVHs().
export function coreBVHCache() {
  const m = new Map();
  m[CORE_CACHE] = true;
  return m;
}

function indexFor(mesh, allowCore) {
  const c = allowCore ? core() : null;
  if (c) {
    try {
      return buildCoreBVH(c, triangleVertices(mesh), () => buildBVH(mesh));
    } catch (err) {
      poisonCore(c, err); // a fault while building: this realm's core is done; JS from here
    }
  }
  return buildBVH(mesh);
}

// Free every core index among `bvhs` (a Map's values, or any iterable); JS
// indexes need nothing. Safe to call twice.
export function disposeBVHs(bvhs) {
  for (const b of bvhs) b?.dispose?.();
}

export function buildBVH(mesh) {
  const verts = triangleVertices(mesh);
  const count = verts.length / 9;

  // Per-triangle boxes, held in BUILD order (permuted with `order`) so a node's
  // pass over its range reads them sequentially. A box corner is a vertex
  // coordinate, so the vertices' own array type holds it exactly. Transient,
  // like the partition scratch.
  const Store = verts.constructor;
  const order = new Uint32Array(count);
  let tb = new Store(count * 6), tbTmp = new Store(count * 6), orderTmp = new Uint32Array(count);
  for (let t = 0; t < count; t++) {
    order[t] = t;
    const o = t * 9;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let j = 0; j < 9; j += 3) {
      const x = verts[o + j], y = verts[o + j + 1], z = verts[o + j + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    tb[t * 6] = x0; tb[t * 6 + 1] = y0; tb[t * 6 + 2] = z0; tb[t * 6 + 3] = x1; tb[t * 6 + 4] = y1; tb[t * 6 + 5] = z1;
  }

  // A binary tree over n >= 1 leaves has at most 2n - 1 nodes; trimmed below.
  let bounds = new Float64Array(Math.max(1, 2 * count - 1) * 6);
  let meta = new Uint32Array(bounds.length / 3);
  let next = 0;
  // Bin scratch, reused by every node (done with before it recurses).
  const binN = new Float64Array(BINS), binB = new Float64Array(BINS * 6);
  const rightArea = new Float64Array(BINS), rightN = new Float64Array(BINS);

  // A range's box and its centroids' box, as 12 numbers: lo xyz, hi xyz,
  // centroid lo xyz, centroid hi xyz. The parent's partition pass fills one
  // per child (same triangles, same order — the same values a pass of the
  // child's own would find), so a node never rescans its range just for these.
  const rangeBox = () => Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity,
    Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  function addTo(R, o) {
    const l0 = tb[o], l1 = tb[o + 1], l2 = tb[o + 2], h0 = tb[o + 3], h1 = tb[o + 4], h2 = tb[o + 5];
    const c0 = (l0 + h0) / 2, c1 = (l1 + h1) / 2, c2 = (l2 + h2) / 2;
    if (l0 < R[0]) R[0] = l0; if (h0 > R[3]) R[3] = h0; if (c0 < R[6]) R[6] = c0; if (c0 > R[9]) R[9] = c0;
    if (l1 < R[1]) R[1] = l1; if (h1 > R[4]) R[4] = h1; if (c1 < R[7]) R[7] = c1; if (c1 > R[10]) R[10] = c1;
    if (l2 < R[2]) R[2] = l2; if (h2 > R[5]) R[5] = h2; if (c2 < R[8]) R[8] = c2; if (c2 > R[11]) R[11] = c2;
  }
  function measureRange(start, len) {
    const R = rangeBox();
    for (let k = start; k < start + len; k++) addTo(R, k * 6);
    return R;
  }

  // Pre-order emit: a node claims its slot and writes its own AABB (`R`, its
  // range's boxes), then either becomes a leaf over order[start, start+len) or
  // partitions that range and recurses. The left child lands at self+1 by
  // construction, so only the right child's index needs storing.
  function emit(start, len, depth, R) {
    const self = next++, nb = self * 6;
    for (let j = 0; j < 6; j++) bounds[nb + j] = R[j];
    if (len <= 1) { meta[self * 2] = start; meta[self * 2 + 1] = len + 1; return self; }

    if (depth < DEPTH_LIMIT) {
      // The split search: the axis of the widest centroid spread (ties to the
      // lower axis), its BINS bins, the cheapest plane between them. One axis,
      // not three: measured, binning all three bought queries 5-10% for a
      // build ~1.8x as long in the native core.
      const ex = R[9] - R[6], ey = R[10] - R[7], ez = R[11] - R[8];
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const ext = R[9 + axis] - R[6 + axis];
      let bestCost = Infinity, bestAxis = -1, bestSplit = 0;
      if (ext > 0) {
        const lo = R[6 + axis], scale = BINS / ext;
        binN.fill(0);
        for (let i = 0; i < BINS; i++) {
          binB[i * 6] = binB[i * 6 + 1] = binB[i * 6 + 2] = Infinity;
          binB[i * 6 + 3] = binB[i * 6 + 4] = binB[i * 6 + 5] = -Infinity;
        }
        for (let k = start; k < start + len; k++) {
          const o = k * 6, bin = binOf((tb[o + axis] + tb[o + 3 + axis]) / 2, lo, scale), b = bin * 6;
          binN[bin]++;
          const l0 = tb[o], l1 = tb[o + 1], l2 = tb[o + 2], h0 = tb[o + 3], h1 = tb[o + 4], h2 = tb[o + 5];
          if (l0 < binB[b]) binB[b] = l0; if (h0 > binB[b + 3]) binB[b + 3] = h0;
          if (l1 < binB[b + 1]) binB[b + 1] = l1; if (h1 > binB[b + 4]) binB[b + 4] = h1;
          if (l2 < binB[b + 2]) binB[b + 2] = l2; if (h2 > binB[b + 5]) binB[b + 5] = h2;
        }
        // Sweep from the right for each candidate's right side, then from the
        // left, costing every plane that leaves triangles on both sides.
        let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rn = 0;
        for (let i = BINS - 1; i > 0; i--) {
          const o = i * 6;
          if (binB[o] < rx0) rx0 = binB[o]; if (binB[o + 3] > rx1) rx1 = binB[o + 3];
          if (binB[o + 1] < ry0) ry0 = binB[o + 1]; if (binB[o + 4] > ry1) ry1 = binB[o + 4];
          if (binB[o + 2] < rz0) rz0 = binB[o + 2]; if (binB[o + 5] > rz1) rz1 = binB[o + 5];
          rn += binN[i];
          rightArea[i] = halfArea(rx0, ry0, rz0, rx1, ry1, rz1); rightN[i] = rn;
        }
        let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, ln = 0;
        for (let i = 0; i < BINS - 1; i++) {
          const o = i * 6;
          if (binB[o] < lx0) lx0 = binB[o]; if (binB[o + 3] > lx1) lx1 = binB[o + 3];
          if (binB[o + 1] < ly0) ly0 = binB[o + 1]; if (binB[o + 4] > ly1) ly1 = binB[o + 4];
          if (binB[o + 2] < lz0) lz0 = binB[o + 2]; if (binB[o + 5] > lz1) lz1 = binB[o + 5];
          ln += binN[i];
          if (!ln || !rightN[i + 1]) continue;
          const cost = halfArea(lx0, ly0, lz0, lx1, ly1, lz1) * ln + rightArea[i + 1] * rightN[i + 1];
          if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestSplit = i; }
        }
      }
      if (bestAxis >= 0) {
        // A small node stays a leaf unless splitting beats testing its
        // triangles outright (one box test ~ one triangle test).
        const area = halfArea(R[0], R[1], R[2], R[3], R[4], R[5]);
        if (len <= MAX_LEAF && area + bestCost >= area * len) {
          meta[self * 2] = start; meta[self * 2 + 1] = len + 1; return self;
        }
        // Stable partition: bins <= bestSplit first, each side in its order.
        // The left side is compacted in place (it never overtakes k); the
        // right side waits in scratch and is appended after.
        const lo = R[6 + bestAxis], scale = BINS / (R[9 + bestAxis] - R[6 + bestAxis]);
        const L = rangeBox(), Rt = rangeBox();
        let l = start, r = 0;
        for (let k = start; k < start + len; k++) {
          const o = k * 6;
          if (binOf((tb[o + bestAxis] + tb[o + 3 + bestAxis]) / 2, lo, scale) <= bestSplit) {
            addTo(L, o);
            order[l] = order[k];
            for (let j = 0; j < 6; j++) tb[l * 6 + j] = tb[o + j];
            l++;
          } else {
            addTo(Rt, o);
            orderTmp[r] = order[k];
            for (let j = 0; j < 6; j++) tbTmp[r * 6 + j] = tb[o + j];
            r++;
          }
        }
        for (let i = 0; i < r; i++) {
          order[l + i] = orderTmp[i];
          for (let j = 0; j < 6; j++) tb[(l + i) * 6 + j] = tbTmp[i * 6 + j];
        }
        emit(start, l - start, depth + 1, L);
        meta[self * 2] = emit(l, r, depth + 1, Rt);
        meta[self * 2 + 1] = 0;
        return self;
      }
    }
    // No plane separates the centroids (they coincide), or the depth limit:
    // halve the range as it stands.
    if (len <= MAX_LEAF) { meta[self * 2] = start; meta[self * 2 + 1] = len + 1; return self; }
    const mid = len >> 1;
    emit(start, mid, depth + 1, measureRange(start, mid));
    meta[self * 2] = emit(start + mid, len - mid, depth + 1, measureRange(start + mid, len - mid));
    meta[self * 2 + 1] = 0;
    return self;
  }
  emit(0, count, 0, measureRange(0, count));
  bounds = bounds.slice(0, next * 6);
  meta = meta.slice(0, next * 2);
  // Dropped explicitly, not left to scope: `emit` and the three query closures
  // below share one function context, so build scratch merely gone out of use
  // would stay reachable from every returned BVH for the life of the index.
  tb = tbTmp = orderTmp = null;

  function raycast(origin, dir, { tMin = 1e-6, tMax = Infinity, skipTri = -1 } = {}) {
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const dx = dir[0], dy = dir[1], dz = dir[2];
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let best = tMax, bestTri = -1;
    // Nearer child first, each pushed with its entry distance: a node whose box
    // starts beyond the best hit found since is dropped on the pop.
    const stack = [], entry = [];
    const e0 = rayEntry(ox, oy, oz, ix, iy, iz, bounds, 0, tMin, best);
    if (e0 !== Infinity) { stack.push(0); entry.push(e0); }
    while (stack.length) {
      const n = stack.pop();
      if (entry.pop() > best) continue;
      const packed = meta[n * 2 + 1];
      if (packed) {
        const start = meta[n * 2];
        for (let k = 0; k < packed - 1; k++) {
          const tri = order[start + k];
          if (tri === skipTri) continue;
          const t = rayTri(ox, oy, oz, dx, dy, dz, verts, tri * 9, tMin);
          if (t < best) { best = t; bestTri = tri; }
        }
      } else {
        const l = n + 1, r = meta[n * 2];
        const tl = rayEntry(ox, oy, oz, ix, iy, iz, bounds, l * 6, tMin, best);
        const tr = rayEntry(ox, oy, oz, ix, iy, iz, bounds, r * 6, tMin, best);
        if (tl <= tr) {
          if (tr !== Infinity) { stack.push(r); entry.push(tr); }
          if (tl !== Infinity) { stack.push(l); entry.push(tl); }
        } else {
          if (tl !== Infinity) { stack.push(l); entry.push(tl); }
          if (tr !== Infinity) { stack.push(r); entry.push(tr); }
        }
      }
    }
    return bestTri === -1 ? null : { t: best, tri: bestTri };
  }

  function closestPoint(p) {
    const px = p[0], py = p[1], pz = p[2];
    let best2 = Infinity, bestPt = null, bestTri = -1;
    const stack = [0];
    while (stack.length) {
      const n = stack.pop();
      if (distSqBox(px, py, pz, bounds, n * 6) > best2) continue;
      const packed = meta[n * 2 + 1];
      if (packed) {
        const start = meta[n * 2];
        for (let k = 0; k < packed - 1; k++) {
          const tri = order[start + k];
          const r = closestOnTri(p, verts, tri * 9);
          if (r.d2 < best2) { best2 = r.d2; bestPt = r.point; bestTri = tri; }
        }
      } else {
        // visit the nearer child first for better pruning
        const l = n + 1, r = meta[n * 2];
        const dl = distSqBox(px, py, pz, bounds, l * 6), dr = distSqBox(px, py, pz, bounds, r * 6);
        if (dl < dr) { stack.push(r, l); } else { stack.push(l, r); }
      }
    }
    return { point: bestPt, dist: Math.sqrt(best2), tri: bestTri };
  }

  // Exact minimum surface-to-surface distance to another buildBVH result.
  // Dual traversal pruned by AABB–AABB distance; exact triangle–triangle
  // distance at leaf pairs; early-exits at 0 (touching/intersecting). The stack
  // holds node-index PAIRS, pushed and popped two entries at a time.
  function distanceTo(other) {
    // A core index on the other side (bvh-core.js) meets this one through its JS twin.
    if (other?.jsIndex) other = other.jsIndex();
    const oV = other.vertices, oB = other._bounds, oM = other._meta, oO = other._order;
    let best = { d2: Infinity, a: null, b: null };
    const stack = [0, 0];
    while (stack.length && best.d2 > 0) {
      const nb = stack.pop(), na = stack.pop();
      if (boxBoxDistSq(bounds, na * 6, oB, nb * 6) >= best.d2) continue;
      const pa = meta[na * 2 + 1], pb = oM[nb * 2 + 1];
      if (pa && pb) {
        const sa = meta[na * 2], sb = oM[nb * 2];
        for (let i = 0; i < pa - 1; i++) for (let j = 0; j < pb - 1; j++) {
          const r = triTriDist(verts, order[sa + i] * 9, oV, oO[sb + j] * 9);
          if (r.d2 < best.d2) best = r;
        }
      } else if (!pa && (pb || nodeExtent(bounds, na * 6) >= nodeExtent(oB, nb * 6))) {
        // descend the larger node; push the nearer child last so it pops first
        const l = na + 1, r = meta[na * 2];
        const dl = boxBoxDistSq(bounds, l * 6, oB, nb * 6), dr = boxBoxDistSq(bounds, r * 6, oB, nb * 6);
        if (dl < dr) stack.push(r, nb, l, nb); else stack.push(l, nb, r, nb);
      } else {
        const l = nb + 1, r = oM[nb * 2];
        const dl = boxBoxDistSq(bounds, na * 6, oB, l * 6), dr = boxBoxDistSq(bounds, na * 6, oB, r * 6);
        if (dl < dr) stack.push(na, r, na, l); else stack.push(na, l, na, r);
      }
    }
    if (best.a === null) return { distance: Infinity, at: null, pointA: null, pointB: null }; // empty mesh
    const at = [(best.a[0] + best.b[0]) / 2, (best.a[1] + best.b[1]) / 2, (best.a[2] + best.b[2]) / 2];
    return { distance: Math.sqrt(best.d2), at, pointA: best.a, pointB: best.b };
  }

  return {
    raycast, closestPoint, distanceTo,
    triangleCount: count,
    // Flat, 9 per triangle, mesh order — min-wall casts from these. READ-ONLY (see
    // the STORAGE note up top); decode a triangle with readTriangleInto().
    vertices: verts,
    // The root node's AABB, [minx,miny,minz, maxx,maxy,maxz] — a copy, so reading
    // it cannot disturb the tree. It is the mesh's own bounding box over exactly
    // the vertices the triangles reference, already computed by the build; min-wall
    // uses it for its default ray cap instead of rescanning mesh.positions.
    rootBounds: [bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5]],
    // Diagnostic self-report: the four typed arrays' byte lengths, summed at build.
    // NOT a measurement of retained memory — it counts only what this function
    // knows it allocated, and cannot see a regression that reintroduces per-triangle
    // JS objects (test/bvh.test.js weighs that in a child process). What it does
    // pin, and the child-process bound is too loose to catch, is the index's
    // COMPOSITION — widening `vertices` to Float64 would show up here.
    bytesAllocated: verts.byteLength + order.byteLength + bounds.byteLength + meta.byteLength,
    // Private to this module: only distanceTo reads them, off the OTHER BVH — a
    // dual traversal walks two trees at once, and JS has no cross-instance private
    // access to reach for. Nothing outside bvh.js touches them, and nothing should:
    // they are raw node storage whose meaning is the packing rules in the header.
    _bounds: bounds, _meta: meta, _order: order,
  };
}
