// buildMeshField: a closed triangle mesh to the `solid` leaf's field (mesh-field.js
// says what the field is and how meshDistance reads it). The only module of the
// implicit engine that imports the oracle's BVH, so it loads on demand:
// mesh-field-loader.js imports it the first time a solid leaf needs it. Nothing in
// the worker's eager closure or the kit's closure may import this file.
//
// PORTED: its arrays go to the native side as data (mesh-field.js's PORTED note).
// It runs once, in JS only. It uses pfAtan2 and hypot3 (never Math.atan2, Math.acos
// or Math.hypot) so its output is the same on every engine.

import { buildBVH } from "../../oracle/bvh.js";
import { hypot3, pfAtan2 } from "../js-math.js";
import { NORMALS_PER_TRI, MeshFieldError } from "./mesh-field.js";

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
