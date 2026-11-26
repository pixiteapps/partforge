// The mesh field: the signed distance to a closed triangle mesh, for the `solid`
// leaf of k.implicit. Negative inside, positive outside, exactly +0 on the surface.
//
// Distance: the oracle BVH's exact nearest surface point (closestPoint).
// Sign: the angle-weighted pseudonormal test (Bærentzen & Aanæs, "Signed distance
// computation using the angle weighted pseudonormal", 2005). The nearest point q
// lies in one of seven regions of the triangle the BVH reports: its face, one of
// its three edges, or one of its three corners. Each region has a pseudonormal n,
// and p is outside exactly when (p − q) · n > 0:
//   face    the triangle's unit normal
//   edge    the sum of the unit normals of the triangles on the edge
//   corner  the sum, over every triangle at that position, of that triangle's
//           unit normal times its angle at the corner
// No ray parity, no face-normal tolerance: the test is exact for any closed,
// consistently oriented mesh, concave edges and corners included.
//
// Which triangle the BVH reports for a nearest point on a shared edge or corner
// is an accident of the traversal. The result does not depend on it: the region
// is classified on the reported triangle, and an edge's or a corner's
// pseudonormal is SHARED data, the same numbers in every triangle that touches
// it. That is why edges and corners are matched across triangles by exact
// position (a Manifold soup repeats each position once per triangle).
//
// The mesh is accepted when every directed edge a→b occurs exactly as often as its
// reverse b→a (by exact position). That refuses an open mesh and an inconsistently
// wound one, and accepts a valid solid whose parts touch along an edge (four
// triangles on one edge). An edge's pseudonormal sums the unit normals of ALL the
// triangles on it.
//
// PORTED: meshDistance has a C++ twin that must give the same bits. Inside it,
// use only + − × ÷, Math.sqrt, comparisons and hypot3, in this order. The region
// branches are closestOnTri's (src/framework/oracle/bvh.js, Ericson's closest
// point on a triangle) in the same order on the same expressions, so the region
// found here is the one closestPoint took. buildMeshField runs once, in JS only;
// its arrays go to the native side as data. It uses pfAtan2 and hypot3 (never
// Math.atan2, Math.acos or Math.hypot) so its output is the same on every engine.
// When closestPoint finds no triangle (a NaN or infinite input, or one so far
// away that the squared distance overflows), meshDistance returns +Infinity; the
// C++ twin must return +Infinity in the same case.

import { buildBVH } from "../../oracle/bvh.js";
import { hypot3, pfAtan2 } from "../js-math.js";

// Floats per triangle in `normals`: face (1), edges AB, BC, CA (3), corners A, B, C
// (3), three each. A region code is the slot index, so its normal is at
// t * NORMALS_PER_TRI + region * 3.
export const NORMALS_PER_TRI = 21;
const FACE = 0, EDGE_AB = 1, EDGE_BC = 2, EDGE_CA = 3, CORNER_A = 4, CORNER_B = 5, CORNER_C = 6;

/**
 * A mesh the field cannot be built from. `reason` is "empty", or "open" for a
 * mesh whose directed edges do not pair up (open, or inconsistently wound).
 */
export class MeshFieldError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "MeshFieldError";
    this.reason = reason;
  }
}

// A position's identity: its three coordinates. Number-to-string is exact and
// injective on doubles, so two keys are equal exactly when the coordinates are
// bit for bit equal, except that −0 and +0 (one point) are merged by the `+ 0`.
const posKey = (x, y, z) => `${x + 0},${y + 0},${z + 0}`;

// FNV-1a over bytes, in two 32-bit lanes with different seeds (the shape of
// solid-hash.js's fnvBytes64): 64 bits of identity, still one pass and no BigInt.
function digestBytes(u8) {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    h1 ^= b; h1 = Math.imul(h1, 0x01000193);
    h2 ^= b; h2 = Math.imul(h2, 0x01000193);
  }
  // Fixed width (2^32 is 7 base-36 digits), so two lane pairs never join to one string.
  return (h1 >>> 0).toString(36).padStart(7, "0") + (h2 >>> 0).toString(36).padStart(7, "0");
}

/**
 * Build the field of a closed triangle mesh: `{ positions, indices? }`, a Manifold
 * soup (9 floats per triangle) or an indexed mesh. Other fields (normals, ...) are
 * ignored. Throws MeshFieldError for an empty mesh, or for a mesh with a directed
 * edge that does not occur as often as its reverse.
 * @returns {{ bvh, tris: number, normals: Float64Array, min: number[], max: number[], digest: string }}
 */
export function buildMeshField(mesh) {
  const bvh = buildBVH({ positions: mesh.positions, indices: mesh.indices });
  const V = bvh.vertices, tris = V.length / 9;
  if (tris === 0) throw new MeshFieldError("empty", "the mesh is empty");

  // Position ids, in first-use order (triangle order, corner A, B, C).
  const ids = new Map(), vid = new Uint32Array(tris * 3);
  for (let i = 0; i < tris * 3; i++) {
    const key = posKey(V[3 * i], V[3 * i + 1], V[3 * i + 2]);
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    vid[i] = id;
  }
  const nv = ids.size;

  // Face unit normals, and each corner's angle-weighted share of its position's sum.
  // A degenerate (zero-area) triangle has no normal: it adds nothing anywhere.
  // That is safe because its face region is empty: closestOnTri reports such a
  // triangle only in an edge or corner region, and those pseudonormals are shared
  // sums that its non-degenerate neighbours decide.
  const N = new Float64Array(tris * NORMALS_PER_TRI);
  const corner = new Float64Array(nv * 3);
  const angleAt = (ux, uy, uz, vx, vy, vz) =>
    pfAtan2(hypot3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx), ux * vx + uy * vy + uz * vz);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const ax = V[o], ay = V[o + 1], az = V[o + 2];
    const bx = V[o + 3], by = V[o + 4], bz = V[o + 5];
    const cx = V[o + 6], cy = V[o + 7], cz = V[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const l = hypot3(nx, ny, nz);
    if (l > 0) { nx = nx / l; ny = ny / l; nz = nz / l; } else { nx = 0; ny = 0; nz = 0; }
    const f = t * NORMALS_PER_TRI;
    N[f] = nx; N[f + 1] = ny; N[f + 2] = nz;
    const wa = angleAt(abx, aby, abz, acx, acy, acz);
    const wb = angleAt(cx - bx, cy - by, cz - bz, ax - bx, ay - by, az - bz);
    const wc = angleAt(ax - cx, ay - cy, az - cz, bx - cx, by - cy, bz - cz);
    const w = [wa, wb, wc];
    for (let k = 0; k < 3; k++) {
      const c = vid[t * 3 + k] * 3;
      corner[c] += nx * w[k]; corner[c + 1] += ny * w[k]; corner[c + 2] += nz * w[k];
    }
  }

  // Directed edges a→b by position id. Each must occur as often as b→a. The
  // undirected edge keeps its triangles in triangle order; its pseudonormal is the
  // sum of all their unit normals (two on a manifold edge, four where two parts of
  // the solid touch along it).
  const directed = new Map(), edges = new Map();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const i = vid[t * 3 + k], j = vid[t * 3 + ((k + 1) % 3)];
      const dk = i * nv + j;
      directed.set(dk, (directed.get(dk) ?? 0) + 1);
      const key = i < j ? dk : j * nv + i;
      const e = edges.get(key);
      if (e === undefined) edges.set(key, [t]); else e.push(t);
    }
  }
  let open = 0;
  for (const [dk, n] of directed) {
    const i = Math.floor(dk / nv), j = dk - i * nv;
    if ((directed.get(j * nv + i) ?? 0) !== n) open++;
  }
  if (open > 0) {
    throw new MeshFieldError("open",
      `the mesh is not closed: ${open} directed edge${open === 1 ? " is" : "s are"} not matched by its reverse (the mesh is open or inconsistently wound)`);
  }
  const edgeNormal = new Map();
  for (const [key, ts] of edges) {
    let x = 0, y = 0, z = 0;
    for (const t of ts) { const f = t * NORMALS_PER_TRI; x += N[f]; y += N[f + 1]; z += N[f + 2]; }
    edgeNormal.set(key, [x, y, z]);
  }
  for (let t = 0; t < tris; t++) {
    const f = t * NORMALS_PER_TRI;
    for (let k = 0; k < 3; k++) {
      const i = vid[t * 3 + k], j = vid[t * 3 + ((k + 1) % 3)];
      const en = edgeNormal.get(i < j ? i * nv + j : j * nv + i), s = f + 3 + k * 3;
      N[s] = en[0]; N[s + 1] = en[1]; N[s + 2] = en[2];
      const c = vid[t * 3 + k] * 3, d = f + 12 + k * 3;
      N[d] = corner[c]; N[d + 1] = corner[c + 1]; N[d + 2] = corner[c + 2];
    }
  }

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i++) {
    const a = i % 3, c = V[i];
    if (c < min[a]) min[a] = c;
    if (c > max[a]) max[a] = c;
  }
  const digest = digestBytes(new Uint8Array(V.buffer, V.byteOffset, V.byteLength));
  return { bvh, tris, normals: N, min, max, digest };
}

// The region of triangle `base` of V that holds the point nearest to P: the same
// branches as closestOnTri in bvh.js, on the same expressions, in the same order.
function regionOf(px, py, pz, V, base) {
  const ax = V[base], ay = V[base + 1], az = V[base + 2];
  const bx = V[base + 3], by = V[base + 4], bz = V[base + 5];
  const cx = V[base + 6], cy = V[base + 7], cz = V[base + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return CORNER_A;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return CORNER_B;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return EDGE_AB;
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return CORNER_C;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return EDGE_CA;
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return EDGE_BC;
  return FACE;
}

/**
 * The signed distance from (x, y, z) to the field's mesh: negative inside,
 * positive outside, exactly +0 on the surface.
 */
export function meshDistance(field, x, y, z) {
  const r = field.bvh.closestPoint([x, y, z]);
  if (r.tri < 0) return Infinity; // no triangle found: NaN, infinite or overflowing input
  const d = r.dist;
  if (d === 0) return 0; // +0, whatever the sign test would say
  const q = r.point, n = r.tri * NORMALS_PER_TRI + regionOf(x, y, z, field.bvh.vertices, r.tri * 9) * 3;
  const N = field.normals;
  // Only the sign of the dot product matters, so the edge and corner
  // pseudonormals are used as summed, never normalised. A dot product of exactly
  // 0 (p in the tangent plane) reads as outside.
  const s = (x - q[0]) * N[n] + (y - q[1]) * N[n + 1] + (z - q[2]) * N[n + 2];
  return s < 0 ? -d : d;
}
