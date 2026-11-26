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
// found here is the one closestPoint took. When closestPoint finds no triangle (a NaN or infinite input, or one so far
// away that the squared distance overflows), meshDistance returns +Infinity; the
// C++ twin must return +Infinity in the same case.
//
// This file imports nothing under oracle/ or core/: it is in the worker's eager
// closure (program.js) and the kit's closure. meshDistance only calls the
// closestPoint and reads the vertices of the BVH on the field it is handed.
// buildMeshField, which builds that BVH, is in mesh-field-build.js and loads on
// demand (mesh-field-loader.js).

// Floats per triangle in `normals`: face (1), edges AB, BC, CA (3), corners A, B, C
// (3), three each. A region code is the slot index, so its normal is at
// t * NORMALS_PER_TRI + region * 3.
export const NORMALS_PER_TRI = 21;
const FACE = 0, EDGE_AB = 1, EDGE_BC = 2, EDGE_CA = 3, CORNER_A = 4, CORNER_B = 5, CORNER_C = 6;

/**
 * A mesh the field cannot be built from. `reason` is "empty", or "open" for a
 * mesh whose directed edges do not pair up (open, or inconsistently wound). A mesh
 * that folds back on itself is not an error here: its field carries `folds`
 * (mesh-field-build.js findFolds), and the kernel's k.implicit decides.
 */
export class MeshFieldError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "MeshFieldError";
    this.reason = reason;
  }
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
