// buildMeshField: a closed triangle mesh to the `solid` leaf's field (mesh-field.js
// says what the field is and how meshDistance reads it). The only module of the
// implicit engine that imports the oracle's BVH, so it loads on demand:
// mesh-field-loader.js imports it the first time a solid leaf needs it. Nothing in
// the worker's eager closure or the kit's closure may import this file.
//
// PORTED: its arrays go to the native side as data (mesh-field.js's PORTED note).
// It runs once, in JS only. It uses pfAtan2 and hypot3 (never Math.atan2, Math.acos
// or Math.hypot) so its output is the same on every engine.

import { buildBVH, insideShared } from "../../oracle/bvh.js";
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

// Folds. The sign test (mesh-field.js) holds for a closed mesh that does not pass
// through itself. A mesh that folds back on itself breaks it. Where a strip of the
// surface runs past an edge and folds back flat under itself (a fin, common in a
// damaged STL), the unit normals of the two layers cancel in the edge and corner
// sums and leave a tiny vector that points nowhere in particular. Every point whose
// nearest surface point is that corner then takes its sign from that vector, so a
// wedge that runs from the fold far out into space reads inside. The field is then
// not a distance, the sampler's cull (which trusts a 1-Lipschitz field) steps past
// the surface, and the result mesh is open ("Not manifold"). Re-signing those sums
// from a probe does not cure it: where two layers overlap only in part, one face
// normal is right over one part of a triangle and wrong over the rest. So a fold is
// refused.
//
// A triangle is folded when it has a manifold edge whose other triangle faces the
// opposite way (unit normals' dot below OVERLAP_DOT: the two lie on each other), or
// when it has an edge whose other triangle faces away from it (dot below FOLD_DOT)
// and it faces the wrong way itself: a probe a hair in front of its centre is inside
// the solid, or one a hair behind it is outside. A sound knife edge (a wedge sharper
// than 60°) passes the probe. The probes are ray parity (oracle/bvh.js insideShared)
// and run only on a mesh with such an edge. A clean mesh has none, so it gives
// exactly the arrays it gave before. insideShared falls back to a winding number
// (Math.atan2) only when every ray grazes an edge, which a probe off a face centre
// does not meet in practice. A refusal changes no array: it is a throw.
const FOLD_DOT = -0.5, OVERLAP_DOT = -0.999;
// A probe's distance from the face: a hundredth of the triangle's shortest altitude,
// but at least PROBE_FLOOR of the mesh's diagonal (well above float32 noise, and above
// the ray cast's 1e-6 mm start for a part of a few mm).
const PROBE_FLOOR = 1e-5;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fmt = (v) => String(Math.round(v * 100) / 100 + 0);

// The midpoint of the edge triangles t and u share: the corners of t that u also has.
function sharedMid(V, t, u) {
  const m = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const o = t * 9 + k * 3;
    for (let j = 0; j < 3; j++) {
      const p = u * 9 + j * 3;
      if (V[o] === V[p] && V[o + 1] === V[p + 1] && V[o + 2] === V[p + 2]) { m[0] += V[o] / 2; m[1] += V[o + 1] / 2; m[2] += V[o + 2] / 2; break; }
    }
  }
  return m;
}

function refuseFolds(bvh, V, N, edges, diagonal) {
  const tris = V.length / 9, suspect = new Uint8Array(tris), folded = new Uint8Array(tris);
  // Where each folded triangle is reported: the fold edge for a pair that lies on each
  // other, the face centre for a triangle the probe found facing the wrong way.
  const where = new Map();
  let any = false;
  for (const ts of edges.values()) {
    if (ts.length !== 2) continue;
    const a = ts[0] * NORMALS_PER_TRI, b = ts[1] * NORMALS_PER_TRI;
    const dot = N[a] * N[b] + N[a + 1] * N[b + 1] + N[a + 2] * N[b + 2];
    if (dot < OVERLAP_DOT) {
      for (const t of ts) { folded[t] = 1; if (!where.has(t)) where.set(t, sharedMid(V, ts[0], ts[1])); }
      any = true;
    } else if (dot < FOLD_DOT) { suspect[ts[0]] = 1; suspect[ts[1]] = 1; any = true; }
  }
  if (!any) return;
  const floor = PROBE_FLOOR * diagonal;
  let count = 0, first = -1;
  for (let t = 0; t < tris; t++) {
    if (!folded[t] && suspect[t]) {
      const o = t * 9, f = t * NORMALS_PER_TRI;
      const abx = V[o + 3] - V[o], aby = V[o + 4] - V[o + 1], abz = V[o + 5] - V[o + 2];
      const acx = V[o + 6] - V[o], acy = V[o + 7] - V[o + 1], acz = V[o + 8] - V[o + 2];
      const longest = Math.max(hypot3(abx, aby, abz), hypot3(acx, acy, acz),
        hypot3(V[o + 6] - V[o + 3], V[o + 7] - V[o + 4], V[o + 8] - V[o + 5]));
      const twice = hypot3(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
      const h = Math.max(0.01 * (twice / longest), floor);
      const cx = (V[o] + V[o + 3] + V[o + 6]) / 3, cy = (V[o + 1] + V[o + 4] + V[o + 7]) / 3, cz = (V[o + 2] + V[o + 5] + V[o + 8]) / 3;
      const front = insideShared(bvh, [cx + h * N[f], cy + h * N[f + 1], cz + h * N[f + 2]], IDENTITY);
      const back = insideShared(bvh, [cx - h * N[f], cy - h * N[f + 1], cz - h * N[f + 2]], IDENTITY);
      if (front || !back) { folded[t] = 1; where.set(t, [cx, cy, cz]); }
    }
    if (folded[t]) { count++; if (first < 0) first = t; }
  }
  if (count === 0) return;
  const at = where.get(first).map(fmt);
  throw new MeshFieldError("folded",
    `the mesh folds back on itself: ${count} triangle${count === 1 ? " faces" : "s face"} the wrong way, the first near (${at.join(", ")}), so its inside cannot be told from its outside there: repair the mesh in a mesh tool (or export it again) and import the repaired file`);
}

/**
 * Build the field of a closed triangle mesh: `{ positions, indices? }`, a Manifold
 * soup (9 floats per triangle) or an indexed mesh. Other fields (normals, ...) are
 * ignored. Throws MeshFieldError for an empty mesh, for a mesh with a directed
 * edge that does not occur as often as its reverse, or for a mesh that folds back
 * on itself (refuseFolds).
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
  refuseFolds(bvh, V, N, edges, hypot3(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  const digest = digestBytes(new Uint8Array(V.buffer, V.byteOffset, V.byteLength));
  return { bvh, tris, normals: N, min, max, digest };
}
