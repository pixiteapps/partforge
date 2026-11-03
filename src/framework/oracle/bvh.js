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
import { invertRigid, mulMat4 } from "../geometry/pose.js";

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

// ── Scalar twins for the posed queries (collisions) ─────────────────────────────
// closestOnTri, closestSegSeg and triTriDist above allocate a few arrays per call,
// which is fine for the oracle's one-off distanceTo (and keeps it the C++ twin's
// reference) but is most of a collision query's cost. These compute the SAME
// floating-point expressions in the same order and break ties the same way, with
// every result written into a scratch array instead of returned, so a posed query
// reads bit for bit what triTriDist would (test/bvh-posed.test.js holds them equal).

// closestOnTri for P = (px, py, pz): writes Q to out[o..o+2], returns |P - Q|²
function closestOnTriS(px, py, pz, V, base, out, o) {
  const ax = V[base], ay = V[base + 1], az = V[base + 2];
  const bx = V[base + 3], by = V[base + 4], bz = V[base + 5];
  const cx = V[base + 6], cy = V[base + 7], cz = V[base + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const s = d1 / (d1 - d3); qx = ax + abx * s; qy = ay + aby * s; qz = az + abz * s; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const s = d2 / (d2 - d6); qx = ax + acx * s; qy = ay + acy * s; qz = az + acz * s; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const s = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + (cx - bx) * s; qy = by + (cy - by) * s; qz = bz + (cz - bz) * s;
            } else {
              const denom = 1 / (va + vb + vc), sb = vb * denom, sc = vc * denom;
              qx = (ax + abx * sb) + acx * sc; qy = (ay + aby * sb) + acy * sc; qz = (az + abz * sb) + acz * sc;
            }
          }
        }
      }
    }
  }
  out[o] = qx; out[o + 1] = qy; out[o + 2] = qz;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

// closestSegSeg for P1→Q1 (vertex i then j of V1's triangle b1) and P2→Q2: writes
// the point on the first to out[0..2], on the second to out[3..5], returns |a - b|²
function closestSegSegS(V1, i1, j1, V2, i2, j2, out) {
  const p1x = V1[i1], p1y = V1[i1 + 1], p1z = V1[i1 + 2];
  const p2x = V2[i2], p2y = V2[i2 + 1], p2z = V2[i2 + 2];
  const d1x = V1[j1] - p1x, d1y = V1[j1 + 1] - p1y, d1z = V1[j1 + 2] - p1z;
  const d2x = V2[j2] - p2x, d2y = V2[j2 + 1] - p2y, d2z = V2[j2 + 2] - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s, t;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const ax = p1x + d1x * s, ay = p1y + d1y * s, az = p1z + d1z * s;
  const bx = p2x + d2x * t, by = p2y + d2y * t, bz = p2z + d2z * t;
  out[0] = ax; out[1] = ay; out[2] = az; out[3] = bx; out[4] = by; out[5] = bz;
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// triTriDist into `out` (a on the first triangle at out[0..2], b on the second at
// out[3..5]); returns d2. `tmp` is a 6-float scratch of the caller's.
function triTriDistS(V1, b1, V2, b2, out, tmp) {
  // a piercing edge of the first, then of the second (same order as triTriDist)
  for (let e = 0; e < 3; e++) {
    const p = b1 + e * 3, q = b1 + ((e + 1) % 3) * 3;
    const px = V1[p], py = V1[p + 1], pz = V1[p + 2];
    const dx = V1[q] - px, dy = V1[q + 1] - py, dz = V1[q + 2] - pz;
    const t = rayTri(px, py, pz, dx, dy, dz, V2, b2, 0);
    if (t <= 1) {
      out[0] = out[3] = px + dx * t; out[1] = out[4] = py + dy * t; out[2] = out[5] = pz + dz * t;
      return 0;
    }
  }
  for (let e = 0; e < 3; e++) {
    const p = b2 + e * 3, q = b2 + ((e + 1) % 3) * 3;
    const px = V2[p], py = V2[p + 1], pz = V2[p + 2];
    const dx = V2[q] - px, dy = V2[q + 1] - py, dz = V2[q + 2] - pz;
    const t = rayTri(px, py, pz, dx, dy, dz, V1, b1, 0);
    if (t <= 1) {
      out[0] = out[3] = px + dx * t; out[1] = out[4] = py + dy * t; out[2] = out[5] = pz + dz * t;
      return 0;
    }
  }
  let best = Infinity;
  for (let v = 0; v < 9; v += 3) { // the second's vertices on the first
    const x = V2[b2 + v], y = V2[b2 + v + 1], z = V2[b2 + v + 2];
    const d2 = closestOnTriS(x, y, z, V1, b1, tmp, 0);
    if (d2 < best) { best = d2; out[0] = tmp[0]; out[1] = tmp[1]; out[2] = tmp[2]; out[3] = x; out[4] = y; out[5] = z; }
  }
  for (let v = 0; v < 9; v += 3) { // the first's vertices on the second
    const x = V1[b1 + v], y = V1[b1 + v + 1], z = V1[b1 + v + 2];
    const d2 = closestOnTriS(x, y, z, V2, b2, tmp, 0);
    if (d2 < best) { best = d2; out[0] = x; out[1] = y; out[2] = z; out[3] = tmp[0]; out[4] = tmp[1]; out[5] = tmp[2]; }
  }
  for (let e1 = 0; e1 < 3; e1++) for (let e2 = 0; e2 < 3; e2++) {
    const d2 = closestSegSegS(V1, b1 + e1 * 3, b1 + ((e1 + 1) % 3) * 3, V2, b2 + e2 * 3, b2 + ((e2 + 1) % 3) * 3, tmp);
    if (d2 < best) { best = d2; for (let k = 0; k < 6; k++) out[k] = tmp[k]; }
  }
  return best;
}

// Squared distance between the AABBs of triangle `b1` of V1 and `b2` of V2 — a lower
// bound on the triangles' own distance, so a pair whose box gap is past the best (by a
// margin wider than any rounding, PRUNE_MARGIN_MM) can never be the closest one.
function triBoxDistSq(V1, b1, V2, b2) {
  let s = 0;
  for (let ax = 0; ax < 3; ax++) {
    const u0 = V1[b1 + ax], u1 = V1[b1 + 3 + ax], u2 = V1[b1 + 6 + ax];
    const w0 = V2[b2 + ax], w1 = V2[b2 + 3 + ax], w2 = V2[b2 + 6 + ax];
    const lo1 = u0 < u1 ? (u0 < u2 ? u0 : u2) : (u1 < u2 ? u1 : u2);
    const hi1 = u0 > u1 ? (u0 > u2 ? u0 : u2) : (u1 > u2 ? u1 : u2);
    const lo2 = w0 < w1 ? (w0 < w2 ? w0 : w2) : (w1 < w2 ? w1 : w2);
    const hi2 = w0 > w1 ? (w0 > w2 ? w0 : w2) : (w1 > w2 ? w1 : w2);
    const g = lo1 > hi2 ? lo1 - hi2 : lo2 > hi1 ? lo2 - hi1 : 0;
    s += g * g;
  }
  return s;
}

// A distance (mm) wider than any rounding in the box and triangle arithmetic of a mesh
// in the millimetre range (those errors are ~1e-12 mm): a lower bound is trusted to
// exclude a pair only when it clears the threshold by this much, so a skipped pair could
// never have been the answer.
const PRUNE_MARGIN_MM = 1e-9;
const pastSq = (d2) => { const d = Math.sqrt(d2) + PRUNE_MARGIN_MM; return d * d; };

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

// AABB of node `nb` of B under the column-major rigid R, into out[o..o+5] —
// the box of its 8 corners, a (looser, so still conservative) bound on the
// moved subtree.
function boxUnder(B, nb, R, out, o) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let c = 0; c < 8; c++) {
    const x = B[nb + (c & 1 ? 3 : 0)], y = B[nb + (c & 2 ? 4 : 1)], z = B[nb + (c & 4 ? 5 : 2)];
    const px = R[0] * x + R[4] * y + R[8] * z + R[12];
    const py = R[1] * x + R[5] * y + R[9] * z + R[13];
    const pz = R[2] * x + R[6] * y + R[10] * z + R[14];
    if (px < x0) x0 = px; if (px > x1) x1 = px;
    if (py < y0) y0 = py; if (py > y1) y1 = py;
    if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
  }
  out[o] = x0; out[o + 1] = y0; out[o + 2] = z0; out[o + 3] = x1; out[o + 4] = y1; out[o + 5] = z1;
}

// The posed queries' scratch, shared: a query runs to completion before the next
// starts (nothing in them yields or re-enters), so one set serves every index.
const POSED_NBOX = new Float64Array(18);
const POSED_BEST = new Float64Array(6), POSED_PTS = new Float64Array(6), POSED_TMP = new Float64Array(6);
let POSED_STACK = new Uint32Array(256);

// Push node pairs (a0, b0) and (a1, b1) onto the shared stack, in that order when
// `inOrder`, else reversed — the caller passes the nearer pair second so it pops first,
// distanceTo's order. Grows the stack when needed; returns the new top.
function pushPair(sp, inOrder, a0, b0, a1, b1) {
  if (sp + 4 > POSED_STACK.length) { const grown = new Uint32Array(POSED_STACK.length * 2); grown.set(POSED_STACK); POSED_STACK = grown; }
  const stack = POSED_STACK;
  if (inOrder) { stack[sp] = a0; stack[sp + 1] = b0; stack[sp + 2] = a1; stack[sp + 3] = b1; }
  else { stack[sp] = a1; stack[sp + 1] = b1; stack[sp + 2] = a0; stack[sp + 3] = b0; }
  return sp + 4;
}

// The other mesh's triangles, moved by R, for the query in progress: each is moved once
// per query, on first touch (a leaf of the other tree meets many of this tree's leaves),
// into the shared MOVED buffer at its own triangle id, with its plane beside it in
// MOVED_PLANE. An index's `_stamp` (one slot per triangle) holds the query count `_q` at
// which each was last moved, so a slot left by an earlier query is never read.
let MOVED = new Float64Array(9 * 64), MOVED_PLANE = new Float64Array(4 * 64), MOVED_SPHERE = new Float64Array(4 * 64);
function beginMoved(other) {
  const n = other.triangleCount, nodes = other._meta.length / 2;
  if (MOVED.length < n * 9) { MOVED = new Float64Array(n * 9); MOVED_PLANE = new Float64Array(n * 4); MOVED_SPHERE = new Float64Array(n * 4); }
  if (MOVED_NODE.length < nodes * 6) MOVED_NODE = new Float64Array(nodes * 6);
  if (!other._stamp) { other._stamp = new Uint32Array(n); other._nstamp = new Uint32Array(nodes); }
  if (++other._q === 0xffffffff) { other._q = 1; other._stamp.fill(0); other._nstamp.fill(0); }
  return other._q;
}
// The other tree's node boxes moved by R, likewise once per query (a node meets many of
// this tree's nodes): node nb's box at MOVED_NODE[nb * 6 ..]. `A` (|R|) picks
// boxUnderFast, else boxUnder — so the exact query reads exactly the boxes it always did.
let MOVED_NODE = new Float64Array(6 * 64);
const MN = () => MOVED_NODE; // read through: beginMoved may have grown it
function movedNode(other, nb, R, A, q) {
  const o = nb * 6;
  if (other._nstamp[nb] !== q) {
    other._nstamp[nb] = q;
    if (A) boxUnderFast(other._bounds, o, R, A, MOVED_NODE, o); else boxUnder(other._bounds, o, R, MOVED_NODE, o);
  }
  return o;
}
// Move triangles oO[sb .. sb+n) of `other` by R into MOVED (and their planes), unless
// query q moved them already.
function moveLeaf(other, oO, sb, n, R, q) {
  const oV = other.vertices, stamp = other._stamp, L = MOVED, P = MOVED_PLANE;
  for (let j = 0; j < n; j++) {
    const t = oO[sb + j];
    if (stamp[t] === q) continue;
    stamp[t] = q;
    const b = t * 9;
    for (let v = 0; v < 9; v += 3) {
      const x = oV[b + v], y = oV[b + v + 1], z = oV[b + v + 2];
      L[b + v] = R[0] * x + R[4] * y + R[8] * z + R[12];
      L[b + v + 1] = R[1] * x + R[5] * y + R[9] * z + R[13];
      L[b + v + 2] = R[2] * x + R[6] * y + R[10] * z + R[14];
    }
    planeInto(L, b, P, t * 4);
    sphereInto(L, b, MOVED_SPHERE, t * 4);
  }
}

// Triangle `b` of V's bounding sphere, into S[o..o+3]: its centroid and the farthest
// vertex's distance from it. |cA − cB| − rA − rB bounds two triangles' distance from below.
function sphereInto(V, b, S, o) {
  const cx = (V[b] + V[b + 3] + V[b + 6]) / 3, cy = (V[b + 1] + V[b + 4] + V[b + 7]) / 3, cz = (V[b + 2] + V[b + 5] + V[b + 8]) / 3;
  let r2 = 0;
  for (let v = 0; v < 9; v += 3) {
    const dx = V[b + v] - cx, dy = V[b + v + 1] - cy, dz = V[b + v + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  S[o] = cx; S[o + 1] = cy; S[o + 2] = cz; S[o + 3] = Math.sqrt(r2);
}

// The gap between triangle `b1` of V1 and triangle `b2` of V2 along the unit direction
// joining their centroids (S1[o1], S2[o2]): a lower bound on their distance (any unit
// direction's separation is one), nearly tight for two small triangles side by side,
// where neither one's plane separates them.
function centreAxisGap(V1, b1, S1, o1, V2, b2, S2, o2) {
  let ux = S2[o2] - S1[o1], uy = S2[o2 + 1] - S1[o1 + 1], uz = S2[o2 + 2] - S1[o1 + 2];
  const l = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (!(l > 0)) return -Infinity;
  ux /= l; uy /= l; uz /= l;
  const a0 = ux * V1[b1] + uy * V1[b1 + 1] + uz * V1[b1 + 2], a1 = ux * V1[b1 + 3] + uy * V1[b1 + 4] + uz * V1[b1 + 5], a2 = ux * V1[b1 + 6] + uy * V1[b1 + 7] + uz * V1[b1 + 8];
  const c0 = ux * V2[b2] + uy * V2[b2 + 1] + uz * V2[b2 + 2], c1 = ux * V2[b2 + 3] + uy * V2[b2 + 4] + uz * V2[b2 + 5], c2 = ux * V2[b2 + 6] + uy * V2[b2 + 7] + uz * V2[b2 + 8];
  const hiA = a0 > a1 ? (a0 > a2 ? a0 : a2) : (a1 > a2 ? a1 : a2);
  const loB = c0 < c1 ? (c0 < c2 ? c0 : c2) : (c1 < c2 ? c1 : c2);
  return loB - hiA;
}

// The sphere bound for triangle spheres A[oa] and B[ob]: a lower bound on their
// triangles' distance (may be negative).
function sphereGap(A, oa, B, ob) {
  const dx = A[oa] - B[ob], dy = A[oa + 1] - B[ob + 1], dz = A[oa + 2] - B[ob + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - A[oa + 3] - B[ob + 3];
}

// Triangle `b` of V's plane, into P[o..o+3]: its unit normal and offset (n·x = offset on
// the plane). A degenerate triangle gets NaN, which no plane test below passes.
function planeInto(V, b, P, o) {
  const ax = V[b], ay = V[b + 1], az = V[b + 2];
  const ux = V[b + 3] - ax, uy = V[b + 4] - ay, uz = V[b + 5] - az;
  const vx = V[b + 6] - ax, vy = V[b + 7] - ay, vz = V[b + 8] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const ix = len > 0 ? 1 / len : NaN;
  const ux2 = nx * ix, uy2 = ny * ix, uz2 = nz * ix;
  P[o] = ux2; P[o + 1] = uy2; P[o + 2] = uz2; P[o + 3] = ux2 * ax + uy2 * ay + uz2 * az;
}

// Whether the plane P[o..o+3] has all of triangle `b2` of V2 more than `gap` (+ margin)
// to one side: then that triangle is more than `gap` from the plane's own triangle.
// Exact as a bound: every point of a triangle is a convex mix of its vertices.
function planeSeparatesP(P, o, V2, b2, gap) {
  const nx = P[o], ny = P[o + 1], nz = P[o + 2], off = P[o + 3], lim = gap + PRUNE_MARGIN_MM;
  const s0 = nx * V2[b2] + ny * V2[b2 + 1] + nz * V2[b2 + 2] - off;
  if (s0 > lim) return nx * V2[b2 + 3] + ny * V2[b2 + 4] + nz * V2[b2 + 5] - off > lim && nx * V2[b2 + 6] + ny * V2[b2 + 7] + nz * V2[b2 + 8] - off > lim;
  if (s0 < -lim) return nx * V2[b2 + 3] + ny * V2[b2 + 4] + nz * V2[b2 + 5] - off < -lim && nx * V2[b2 + 6] + ny * V2[b2 + 7] + nz * V2[b2 + 8] - off < -lim;
  return false;
}

// boxUnder by centre and half-extents: the AABB of R·box is R·c + t ± |R|·h, the same
// box up to rounding (~1e-14 of the coordinates, far inside PRUNE_MARGIN_MM) for a ninth
// of the work. `A` is |R|'s 3×3, column-major like R. The within query uses it; the exact
// query keeps boxUnder, so its pruning — and so which of two tied pairs it keeps — stays
// bit for bit distanceTo's.
function boxUnderFast(B, nb, R, A, out, o) {
  const cx = (B[nb] + B[nb + 3]) * 0.5, cy = (B[nb + 1] + B[nb + 4]) * 0.5, cz = (B[nb + 2] + B[nb + 5]) * 0.5;
  const hx = (B[nb + 3] - B[nb]) * 0.5, hy = (B[nb + 4] - B[nb + 1]) * 0.5, hz = (B[nb + 5] - B[nb + 2]) * 0.5;
  const px = R[0] * cx + R[4] * cy + R[8] * cz + R[12];
  const py = R[1] * cx + R[5] * cy + R[9] * cz + R[13];
  const pz = R[2] * cx + R[6] * cy + R[10] * cz + R[14];
  const ex = A[0] * hx + A[3] * hy + A[6] * hz, ey = A[1] * hx + A[4] * hy + A[7] * hz, ez = A[2] * hx + A[5] * hy + A[8] * hz;
  out[o] = px - ex; out[o + 1] = py - ey; out[o + 2] = pz - ez; out[o + 3] = px + ex; out[o + 4] = py + ey; out[o + 5] = pz + ez;
}
const POSED_ABS = new Float64Array(9);

// Directions insideOf casts along, in order: +X, then fixed oblique ones for a
// ray that grazes an edge or vertex of the surface (which counts a crossing
// twice, or not at all).
const INSIDE_DIRS = [[1, 0, 0], [0.5773, 0.3217, 0.7489], [-0.2676, 0.8231, -0.5005], [0.1393, -0.4421, 0.8860]];
const GRAZE_EPS = 1e-7;

// Crossings of the ray from p along dir through `other` (any index with raycast),
// or -1 if two consecutive hits are within GRAZE_EPS (the ray runs along an edge).
function crossings(other, p, dir) {
  let n = 0, tMin = 1e-6, skipTri = -1;
  for (;;) {
    const hit = other.raycast(p, dir, { tMin, skipTri });
    if (!hit) return n;
    if (n > 0 && hit.t - tMin < GRAZE_EPS + 1e-9) return -1;
    n++;
    // look back a hair so a neighbour sharing this hit's edge is found (and flagged)
    tMin = hit.t - 1e-9; skipTri = hit.tri;
    if (n > 1e6) return -1;
  }
}

// Is the shared-frame point `w` inside `other` placed by mOther? Used by insideOf on
// both index kinds (the core index forwards to its JS twin).
export function insideShared(other, w, mOther) {
  const inv = invertRigid(mOther);
  const p = [
    inv[0] * w[0] + inv[4] * w[1] + inv[8] * w[2] + inv[12],
    inv[1] * w[0] + inv[5] * w[1] + inv[9] * w[2] + inv[13],
    inv[2] * w[0] + inv[6] * w[1] + inv[10] * w[2] + inv[14],
  ];
  let n = -1;
  for (const dir of INSIDE_DIRS) {
    n = crossings(other, p, dir);
    if (n >= 0) break;
  }
  return n > 0 && n % 2 === 1;
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

  // distanceTo with each mesh moved by a column-major rigid mat4 (geometry/pose.js)
  // into a shared frame; neither index is rebuilt. The traversal runs in THIS
  // mesh's frame under R = mSelf⁻¹·mOther: an `other` node's box is the AABB of its
  // 8 corners under R, and its leaf triangles are moved by R into a scratch buffer
  // before triTriDist. Same pruning and descent order as distanceTo; the result's
  // points are mapped back by mSelf, so `at`/`pointA`/`pointB` are in the shared frame.
  // `maxDistance` (default Infinity) is a cutoff: a pair farther apart than it reads
  // Infinity (no points), and the traversal prunes every node pair at least that far
  // apart from the start. A pair within it gets exactly the uncut answer: a pruned node
  // pair can only hold triangle pairs at or past the cutoff, never the closest one.
  // This mesh's triangle planes and spheres (planeInto, sphereInto; by triangle id),
  // built on the first posed query: a collision world asks many, an oracle index none.
  let planes = null, spheres = null;
  const selfPlanes = () => {
    if (!planes) {
      planes = new Float64Array(count * 4); spheres = new Float64Array(count * 4);
      for (let t = 0; t < count; t++) { planeInto(verts, t * 9, planes, t * 4); sphereInto(verts, t * 9, spheres, t * 4); }
    }
    return planes;
  };

  // Every node's SLAB, built on the first posed query: a unit direction and the interval
  // its triangles' vertices span along it — 5 numbers a node, [nx, ny, nz, lo, hi]. The
  // direction is the node's area-weighted normal, so a node on a flat face is a slab of
  // no thickness and a node on a gently curved one a thin slab, where its box can be
  // fat: two faces a hair apart at an angle to the axes have boxes that overlap all along
  // them. Any direction bounds its node, so the choice never matters to correctness.
  let slabs = null;
  function selfSlabs() {
    if (slabs) return slabs;
    const nodes = meta.length / 2;
    const S = new Float64Array(nodes * 5), start = new Uint32Array(nodes), len = new Uint32Array(nodes);
    // each node's run of `order` (a subtree's leaves are contiguous: pre-order, partitioned)
    const walk = (n) => {
      const packed = meta[n * 2 + 1];
      if (packed) { start[n] = meta[n * 2]; len[n] = packed - 1; return; }
      const l = n + 1, r = meta[n * 2];
      walk(l); walk(r);
      start[n] = start[l]; len[n] = len[l] + len[r];
    };
    if (count) walk(0);
    const cross = new Float64Array(count * 3);
    for (let t = 0; t < count; t++) {
      const b = t * 9, ax = verts[b], ay = verts[b + 1], az = verts[b + 2];
      const ux = verts[b + 3] - ax, uy = verts[b + 4] - ay, uz = verts[b + 5] - az;
      const vx = verts[b + 6] - ax, vy = verts[b + 7] - ay, vz = verts[b + 8] - az;
      cross[t * 3] = uy * vz - uz * vy; cross[t * 3 + 1] = uz * vx - ux * vz; cross[t * 3 + 2] = ux * vy - uy * vx;
    }
    for (let n = 0; n < nodes; n++) {
      let nx = 0, ny = 0, nz = 0;
      for (let k = start[n]; k < start[n] + len[n]; k++) { const t = order[k]; nx += cross[t * 3]; ny += cross[t * 3 + 1]; nz += cross[t * 3 + 2]; }
      let l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(l > 0)) { nx = 0; ny = 0; nz = 1; l = 1; }
      nx /= l; ny /= l; nz /= l;
      let lo = Infinity, hi = -Infinity;
      for (let k = start[n]; k < start[n] + len[n]; k++) {
        const b = order[k] * 9;
        for (let v = 0; v < 9; v += 3) {
          const d = nx * verts[b + v] + ny * verts[b + v + 1] + nz * verts[b + v + 2];
          if (d < lo) lo = d; if (d > hi) hi = d;
        }
      }
      const o = n * 5;
      S[o] = nx; S[o + 1] = ny; S[o + 2] = nz; S[o + 3] = lo; S[o + 4] = hi;
    }
    return (slabs = S);
  }

  // For a LEAF pair, once the other leaf's triangles are moved (MOVED): the gap between
  // this leaf's slab and the other leaf's moved vertices along this slab's direction, and
  // between the other leaf's slab (turned into this frame) and this leaf's vertices — the
  // exact supports, where slabGap projects boxes. A lower bound on the leaves' distance.
  function leafSlabGap(na, SA, sa, la, nb, SB, oO, sb, lb, R) {
    let o = na * 5;
    let nx = SA[o], ny = SA[o + 1], nz = SA[o + 2];
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < lb; j++) {
      const b = oO[sb + j] * 9;
      for (let v = 0; v < 9; v += 3) {
        const d = nx * MOVED[b + v] + ny * MOVED[b + v + 1] + nz * MOVED[b + v + 2];
        if (d < lo) lo = d; if (d > hi) hi = d;
      }
    }
    let gap = lo - SA[o + 4] > SA[o + 3] - hi ? lo - SA[o + 4] : SA[o + 3] - hi;
    // the other's slab: direction R·n, its interval shifted by (R·n)·t into this frame
    o = nb * 5;
    const bx = SB[o], by = SB[o + 1], bz = SB[o + 2];
    nx = R[0] * bx + R[4] * by + R[8] * bz; ny = R[1] * bx + R[5] * by + R[9] * bz; nz = R[2] * bx + R[6] * by + R[10] * bz;
    const shift = nx * R[12] + ny * R[13] + nz * R[14];
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < la; i++) {
      const b = order[sa + i] * 9;
      for (let v = 0; v < 9; v += 3) {
        const d = nx * verts[b + v] + ny * verts[b + v + 1] + nz * verts[b + v + 2];
        if (d < lo) lo = d; if (d > hi) hi = d;
      }
    }
    const g2 = lo - (SB[o + 4] + shift) > (SB[o + 3] + shift) - hi ? lo - (SB[o + 4] + shift) : (SB[o + 3] + shift) - hi;
    return g2 > gap ? g2 : gap;
  }

  // A lower bound on the distance between what node `na` of this tree and node `nb` of
  // `other` hold, with `other` moved by R (rotation part R, translation R[12..14]): the
  // larger gap along this node's slab direction (the other node's box projected onto it)
  // and along the other node's (this node's box projected), or <= 0 when both overlap.
  // A box's projection is exact: its support along a direction is per-axis.
  function slabGap(na, SA, oB, nb, SB, R) {
    // this node's slab against the other node's box, both in this frame
    let o = na * 5;
    const ax = SA[o], ay = SA[o + 1], az = SA[o + 2];
    // the direction in the other's own frame: Rᵀ·n
    const mx = R[0] * ax + R[1] * ay + R[2] * az, my = R[4] * ax + R[5] * ay + R[6] * az, mz = R[8] * ax + R[9] * ay + R[10] * az;
    const c = ax * R[12] + ay * R[13] + az * R[14];
    let b = nb * 6;
    let lo = c, hi = c;
    if (mx > 0) { lo += mx * oB[b]; hi += mx * oB[b + 3]; } else { lo += mx * oB[b + 3]; hi += mx * oB[b]; }
    if (my > 0) { lo += my * oB[b + 1]; hi += my * oB[b + 4]; } else { lo += my * oB[b + 4]; hi += my * oB[b + 1]; }
    if (mz > 0) { lo += mz * oB[b + 2]; hi += mz * oB[b + 5]; } else { lo += mz * oB[b + 5]; hi += mz * oB[b + 2]; }
    let gap = lo - SA[o + 4] > SA[o + 3] - hi ? lo - SA[o + 4] : SA[o + 3] - hi;
    // the other node's slab against this node's box, both in the other's frame: this
    // frame's point y is Rᵀ(y − t) there, so project this box onto R·n and shift by R·n·t
    o = nb * 5;
    const bx = SB[o], by = SB[o + 1], bz = SB[o + 2];
    const kx = R[0] * bx + R[4] * by + R[8] * bz, ky = R[1] * bx + R[5] * by + R[9] * bz, kz = R[2] * bx + R[6] * by + R[10] * bz;
    const shift = kx * R[12] + ky * R[13] + kz * R[14];
    b = na * 6;
    lo = -shift; hi = -shift;
    if (kx > 0) { lo += kx * bounds[b]; hi += kx * bounds[b + 3]; } else { lo += kx * bounds[b + 3]; hi += kx * bounds[b]; }
    if (ky > 0) { lo += ky * bounds[b + 1]; hi += ky * bounds[b + 4]; } else { lo += ky * bounds[b + 4]; hi += ky * bounds[b + 1]; }
    if (kz > 0) { lo += kz * bounds[b + 2]; hi += kz * bounds[b + 5]; } else { lo += kz * bounds[b + 5]; hi += kz * bounds[b + 2]; }
    const g2 = lo - SB[o + 4] > SB[o + 3] - hi ? lo - SB[o + 4] : SB[o + 3] - hi;
    return g2 > gap ? g2 : gap;
  }

  function distanceToPosed(other, mSelf, mOther, maxDistance = Infinity) {
    if (other?.jsIndex) other = other.jsIndex();
    const oB = other._bounds, oM = other._meta, oO = other._order;
    const R = mulMat4(invertRigid(mSelf), mOther);
    const nbox = POSED_NBOX; // [0..5] other's node, [6..11] its left child, [12..17] its right child
    const SA = selfSlabs(), SB = other._slabs();
    // a hair past the cutoff, so a pair exactly at it is kept (and a cutoff of 0 still
    // visits touching boxes)
    const cut = maxDistance < Infinity ? Math.max(Number.MIN_VALUE, maxDistance * maxDistance * (1 + 1e-12)) : Infinity;
    let bestD2 = cut, found = false, thr = pastSq(cut), gap = Math.sqrt(cut);
    const bestPts = POSED_BEST, pts = POSED_PTS, tmp = POSED_TMP;
    const AP = selfPlanes(), q = beginMoved(other), MV = MOVED, MP = MOVED_PLANE, MS = MOVED_SPHERE;
    let sp = 0;
    POSED_STACK[sp++] = 0; POSED_STACK[sp++] = 0;
    while (sp && bestD2 > 0) {
      const nb = POSED_STACK[--sp], na = POSED_STACK[--sp];
      const ob = movedNode(other, nb, R, null, q);
      if (boxBoxDistSq(bounds, na * 6, MN(), ob) >= bestD2) continue;
      // the same pruning as distanceTo's, plus pairs the slabs put past the best by more
      // than rounding: neither can drop a pair that would have become the best
      if (thr < Infinity) { const g = slabGap(na, SA, oB, nb, SB, R) - PRUNE_MARGIN_MM; if (g > 0 && g * g > thr) continue; }
      const pa = meta[na * 2 + 1], pb = oM[nb * 2 + 1];
      if (pa && pb) {
        const sa = meta[na * 2], sb = oM[nb * 2], nj = pb - 1;
        moveLeaf(other, oO, sb, nj, R, q);
        if (thr < Infinity) { const g = leafSlabGap(na, SA, sa, pa - 1, nb, SB, oO, sb, nj, R) - PRUNE_MARGIN_MM; if (g > 0 && g * g > thr) continue; }
        for (let i = 0; i < pa - 1; i++) {
          const ta = order[sa + i], ai = ta * 9;
          for (let j = 0; j < nj; j++) {
            const tb = oO[sb + j], bj = tb * 9;
            // a pair whose boxes or planes are past the best by more than rounding cannot
            // beat it, so the search keeps exactly the pair triTriDist alone would have kept
            if (triBoxDistSq(verts, ai, MV, bj) > thr) continue;
            if (gap < Infinity && (sphereGap(spheres, ta * 4, MS, tb * 4) > gap + PRUNE_MARGIN_MM
              || centreAxisGap(verts, ai, spheres, ta * 4, MV, bj, MS, tb * 4) > gap + PRUNE_MARGIN_MM
              || planeSeparatesP(AP, ta * 4, MV, bj, gap) || planeSeparatesP(MP, tb * 4, verts, ai, gap))) continue;
            const d2 = triTriDistS(verts, ai, MV, bj, pts, tmp);
            if (d2 < bestD2) { bestD2 = d2; found = true; thr = pastSq(d2); gap = Math.sqrt(d2); for (let k = 0; k < 6; k++) bestPts[k] = pts[k]; }
          }
        }
      } else if (!pa && (pb || nodeExtent(bounds, na * 6) >= nodeExtent(MN(), ob))) {
        const l = na + 1, r = meta[na * 2];
        const dl = boxBoxDistSq(bounds, l * 6, MN(), ob), dr = boxBoxDistSq(bounds, r * 6, MN(), ob);
        sp = pushPair(sp, dl < dr, r, nb, l, nb);
      } else {
        const l = nb + 1, r = oM[nb * 2];
        const ol = movedNode(other, l, R, null, q), or = movedNode(other, r, R, null, q);
        const dl = boxBoxDistSq(bounds, na * 6, MN(), ol), dr = boxBoxDistSq(bounds, na * 6, MN(), or);
        sp = pushPair(sp, dl < dr, na, r, na, l);
      }
    }
    if (!found) return { distance: Infinity, at: null, pointA: null, pointB: null };
    const place = (o) => [
      mSelf[0] * bestPts[o] + mSelf[4] * bestPts[o + 1] + mSelf[8] * bestPts[o + 2] + mSelf[12],
      mSelf[1] * bestPts[o] + mSelf[5] * bestPts[o + 1] + mSelf[9] * bestPts[o + 2] + mSelf[13],
      mSelf[2] * bestPts[o] + mSelf[6] * bestPts[o + 1] + mSelf[10] * bestPts[o + 2] + mSelf[14],
    ];
    const pointA = place(0), pointB = place(3);
    const at = [(pointA[0] + pointB[0]) / 2, (pointA[1] + pointB[1]) / 2, (pointA[2] + pointB[2]) / 2];
    return { distance: Math.sqrt(bestD2), at, pointA, pointB };
  }

  // Whether the two meshes, posed as distanceToPosed's are, come within `eps` (mm):
  // exactly `distanceToPosed(other, mSelf, mOther, eps).distance <= eps`, without the
  // minimum. Every node pair whose boxes (either way round) are more than eps apart is
  // pruned, a triangle pair is skipped when its boxes or either triangle's plane put it
  // past eps (each a lower bound, trusted only past PRUNE_MARGIN_MM), and the first
  // triangle pair within eps ends the search. Nothing a pruned or skipped pair holds can
  // be within eps, so the answer never reads clear when the exact distance is not.
  //
  // `out` (optional, an object) gets `bound`: a lower bound on the distance when the
  // answer is false (the least of every pruned or skipped pair's lower bound, less the
  // margin; Infinity for an empty mesh), 0 when it is true.
  function withinDistancePosed(other, mSelf, mOther, eps, out = null) {
    if (other?.jsIndex) other = other.jsIndex();
    const oB = other._bounds, oM = other._meta, oO = other._order;
    if (!count || !other.triangleCount) { if (out) out.bound = Infinity; return false; }
    const R = mulMat4(invertRigid(mSelf), mOther);
    const A = POSED_ABS;
    A[0] = Math.abs(R[0]); A[1] = Math.abs(R[1]); A[2] = Math.abs(R[2]);
    A[3] = Math.abs(R[4]); A[4] = Math.abs(R[5]); A[5] = Math.abs(R[6]);
    A[6] = Math.abs(R[8]); A[7] = Math.abs(R[9]); A[8] = Math.abs(R[10]);
    const nbox = POSED_NBOX, pts = POSED_PTS, tmp = POSED_TMP;
    const SA = selfSlabs(), SB = other._slabs();
    const e2 = Math.max(Number.MIN_VALUE, eps * eps * (1 + 1e-12)), thr = pastSq(e2); // distanceToPosed's cut
    const AP = selfPlanes(), q = beginMoved(other), MV = MOVED, MP = MOVED_PLANE, MS = MOVED_SPHERE;
    let low2 = Infinity; // least squared lower bound over everything pruned or skipped
    const note = (v) => { if (v < low2) low2 = v; };
    let sp = 0;
    POSED_STACK[sp++] = 0; POSED_STACK[sp++] = 0;
    while (sp) {
      const nb = POSED_STACK[--sp], na = POSED_STACK[--sp];
      const ob = movedNode(other, nb, R, A, q);
      let g2 = boxBoxDistSq(bounds, na * 6, MN(), ob);
      if (g2 <= thr) { const g = slabGap(na, SA, oB, nb, SB, R) - PRUNE_MARGIN_MM; if (g > 0 && g * g > g2) g2 = g * g; }
      if (g2 > thr) { note(g2); continue; }
      const pa = meta[na * 2 + 1], pb = oM[nb * 2 + 1];
      if (pa && pb) {
        const sa = meta[na * 2], sb = oM[nb * 2], nj = pb - 1;
        moveLeaf(other, oO, sb, nj, R, q);
        { const g = leafSlabGap(na, SA, sa, pa - 1, nb, SB, oO, sb, nj, R) - PRUNE_MARGIN_MM; if (g > eps) { note(g * g); continue; } }
        for (let i = 0; i < pa - 1; i++) {
          const ta = order[sa + i], ai = ta * 9;
          for (let j = 0; j < nj; j++) {
            const tb = oO[sb + j], bj = tb * 9;
            const t2 = triBoxDistSq(verts, ai, MV, bj);
            if (t2 > thr) { note(t2); continue; }
            let sg = sphereGap(spheres, ta * 4, MS, tb * 4);
            if (!(sg > eps)) { const cg = centreAxisGap(verts, ai, spheres, ta * 4, MV, bj, MS, tb * 4); if (cg > sg) sg = cg; }
            sg -= PRUNE_MARGIN_MM;
            if (sg > eps) { note(sg * sg); continue; }
            if (planeSeparatesP(AP, ta * 4, MV, bj, eps) || planeSeparatesP(MP, tb * 4, verts, ai, eps)) { note(e2); continue; }
            const d2 = triTriDistS(verts, ai, MV, bj, pts, tmp);
            if (d2 < e2 && Math.sqrt(d2) <= eps) { if (out) out.bound = 0; return true; }
            note(d2);
          }
        }
      } else if (!pa && (pb || nodeExtent(bounds, na * 6) >= nodeExtent(MN(), ob))) {
        const l = na + 1, r = meta[na * 2];
        const dl = boxBoxDistSq(bounds, l * 6, MN(), ob), dr = boxBoxDistSq(bounds, r * 6, MN(), ob);
        sp = pushPair(sp, dl < dr, r, nb, l, nb);
      } else {
        const l = nb + 1, r = oM[nb * 2];
        const ol = movedNode(other, l, R, A, q), or = movedNode(other, r, R, A, q);
        const dl = boxBoxDistSq(bounds, na * 6, MN(), ol), dr = boxBoxDistSq(bounds, na * 6, MN(), or);
        sp = pushPair(sp, dl < dr, na, r, na, l);
      }
    }
    if (out) out.bound = Math.max(0, Math.sqrt(low2) - PRUNE_MARGIN_MM);
    return false;
  }

  // Whether this mesh's first vertex, placed by mSelf, lies inside `other` placed by
  // mOther: an odd number of crossings of a ray through `other` (raycast, in other's
  // own frame). A ray that grazes an edge is retried along the next fixed direction.
  function insideOf(other, mSelf, mOther) {
    if (!count) return false;
    const x = verts[0], y = verts[1], z = verts[2];
    const w = [
      mSelf[0] * x + mSelf[4] * y + mSelf[8] * z + mSelf[12],
      mSelf[1] * x + mSelf[5] * y + mSelf[9] * z + mSelf[13],
      mSelf[2] * x + mSelf[6] * y + mSelf[10] * z + mSelf[14],
    ];
    return insideShared(other, w, mOther);
  }

  return {
    raycast, closestPoint, distanceTo, distanceToPosed, withinDistancePosed, insideOf,
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
    // The posed queries' per-index scratch (beginMoved): which triangles a query moved.
    _stamp: null, _nstamp: null, _q: 0,
    _slabs: selfSlabs,
  };
}
