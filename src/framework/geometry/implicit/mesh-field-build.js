// buildMeshField: a closed triangle mesh to the `solid` leaf's field (mesh-field.js
// says what the field is and how meshDistance reads it). The only module of the
// implicit engine that imports the oracle's BVH, so it loads on demand:
// mesh-field-loader.js imports it the first time a solid leaf needs it. Nothing in
// the worker's eager closure or the kit's closure may import this file.
//
// PORTED: its arrays go to the native side as data (mesh-field.js's PORTED note).
// It runs once, in JS only. It uses pfAtan2 and hypot3 (never Math.atan2, Math.acos
// or Math.hypot) so its output is the same on every engine.

import { buildBVH, insideByParity } from "../../oracle/bvh.js";
import { hypot3, pfAtan2 } from "../js-math.js";
import { NORMALS_PER_TRI, MeshFieldError, meshDistance } from "./mesh-field.js";

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
// through itself. A mesh that folds back on itself can break it. Where a strip of the
// surface runs past an edge and folds back flat under itself (a fin, common in a
// damaged STL), the unit normals of the two layers cancel in the edge and corner
// sums and leave a tiny vector that points nowhere in particular. Every point whose
// nearest surface point is that corner then takes its sign from that vector, so a
// wedge that runs from the fold far out into space can read inside. The field is
// then not a distance, the sampler's cull (which trusts a 1-Lipschitz field) steps
// past the surface, and the result mesh is open ("Not manifold"). Re-signing those
// sums from a probe does not cure it: where two layers overlap only in part, one
// face normal is right over one part of a triangle and wrong over the rest. So a
// fold that breaks the sign is found and recorded on the field (`folds`).
//
// Not every fold breaks it. A k.implicit result has a few small flipped triangles
// on a sharp rim, and its field is still right a little way off the surface. So a
// fold is recorded only on evidence: the sign meshDistance gives at a point off the
// fold disagrees with ray parity (oracle/bvh.js insideByParity) there. Even then the
// wrong region is often a thin prism over a tiny triangle that the sampler never
// reaches, and the build is sound. So nothing is refused here: the kernel's
// k.implicit (manifold-backend.js) refuses a leaf with `folds` only when the kernel
// build fails, and warns when it builds.
//
// Suspects: the triangles of a manifold edge whose two unit normals' dot is below
// FOLD_DOT (they face away from each other: a fold, or a sound edge sharper than
// 60°). Probe points: from the face centre along ±the face normal; from each corner
// along ±its pseudonormal and along the direction out of the triangle between its
// two edges; from each edge's midpoint along ±its pseudonormal and along the
// direction out of the triangle across that edge. Each at the distances PROBE_NEAR
// and PROBE_MID mean edge lengths and PROBE_FAR of the mesh's diagonal (those below
// PROBE_NEAR mean edges dropped). The mesh field knows no grid, so the mean edge
// stands in for it: a k.implicit result's edges are about a cell, and a fold's local
// error (within a fold's own size) is closer in than that. A sound mesh's sign is
// right at every point, so its probes always agree, however thin the solid is: there
// is no "a hair in front is outside" assumption to break. A probe whose rays all
// graze an edge proves nothing and is skipped (no winding-number fallback, so the
// decision is the same on every engine), and so does one that ends near the surface
// (closer than PROBE_CLEAR of its distance), where neither sign means anything. A triangle is folded when one of its probes
// disagrees; it stops at its first.
//
// A clean mesh has no suspect edge, so it never probes and gives exactly the arrays
// it gave before. A fold changes no array and not the digest: it only adds `folds`. Cost: at most
// MAX_PROBED suspect triangles (the first in triangle order) take up to 60 probes
// each, a nearest-point query and up to four ray casts per probe. Suspects past the
// cap are not checked. Not checked at all: a fold whose two normals' dot is above
// FOLD_DOT, and a mesh that passes through itself without a folded edge.
const FOLD_DOT = -0.5;
const PROBE_NEAR = 2, PROBE_MID = 6, PROBE_FAR = 0.05;
const MAX_PROBED = 1024;
// A probe counts only when it ends at least PROBE_CLEAR of its distance from the surface.
const PROBE_CLEAR = 0.25;

// Probe directions for triangle t, as [origin, unit direction] pairs, in a fixed order.
function probeRays(V, N, t) {
  const o = t * 9, f = t * NORMALS_PER_TRI, rays = [];
  const P = (k) => [V[o + 3 * k], V[o + 3 * k + 1], V[o + 3 * k + 2]];
  const unit = (x, y, z) => { const l = hypot3(x, y, z); return l > 0 ? [x / l, y / l, z / l] : null; };
  const both = (at, x, y, z) => { const d = unit(x, y, z); if (d) rays.push([at, d], [at, [-d[0], -d[1], -d[2]]]); };
  const one = (at, x, y, z) => { const d = unit(x, y, z); if (d) rays.push([at, d]); };
  const c = [0, 1, 2].map((i) => (V[o + i] + V[o + 3 + i] + V[o + 6 + i]) / 3);
  both(c, N[f], N[f + 1], N[f + 2]);
  for (let k = 0; k < 3; k++) {
    const a = P(k), b = P((k + 1) % 3), x = P((k + 2) % 3);
    // corner a: its pseudonormal, and out of the triangle between edges a→b and a→x
    const s = f + 12 + k * 3;
    both(a, N[s], N[s + 1], N[s + 2]);
    const ub = unit(b[0] - a[0], b[1] - a[1], b[2] - a[2]), ux = unit(x[0] - a[0], x[1] - a[1], x[2] - a[2]);
    if (ub && ux) one(a, -(ub[0] + ux[0]), -(ub[1] + ux[1]), -(ub[2] + ux[2]));
    // edge a→b: its pseudonormal, and out of the triangle across it, in its plane
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], e = f + 3 + k * 3;
    both(m, N[e], N[e + 1], N[e + 2]);
    if (ub) {
      const wx = x[0] - m[0], wy = x[1] - m[1], wz = x[2] - m[2], along = wx * ub[0] + wy * ub[1] + wz * ub[2];
      one(m, -(wx - along * ub[0]), -(wy - along * ub[1]), -(wz - along * ub[2]));
    }
  }
  return rays;
}

// The folds found, `{ count, where }` (where: the first folded triangle's probe origin),
// or null when there are none.
function findFolds(field, V, N, edges, diagonal) {
  const tris = V.length / 9, suspect = new Uint8Array(tris);
  let any = false;
  for (const ts of edges.values()) {
    if (ts.length !== 2) continue;
    const a = ts[0] * NORMALS_PER_TRI, b = ts[1] * NORMALS_PER_TRI;
    if (N[a] * N[b] + N[a + 1] * N[b + 1] + N[a + 2] * N[b + 2] < FOLD_DOT) { suspect[ts[0]] = 1; suspect[ts[1]] = 1; any = true; }
  }
  if (!any) return null;
  let sum = 0;
  for (let o = 0; o < V.length; o += 9) {
    sum += hypot3(V[o + 3] - V[o], V[o + 4] - V[o + 1], V[o + 5] - V[o + 2])
      + hypot3(V[o + 6] - V[o + 3], V[o + 7] - V[o + 4], V[o + 8] - V[o + 5])
      + hypot3(V[o] - V[o + 6], V[o + 1] - V[o + 7], V[o + 2] - V[o + 8]);
  }
  const meanEdge = sum / (3 * tris), near = PROBE_NEAR * meanEdge;
  const dists = [near, PROBE_MID * meanEdge, PROBE_FAR * diagonal].filter((s) => s >= near);
  let count = 0, probed = 0, where = null;
  for (let t = 0; t < tris && probed < MAX_PROBED; t++) {
    if (!suspect[t]) continue;
    probed++;
    let bad = null;
    for (const [at, d] of probeRays(V, N, t)) {
      for (const s of dists) {
        const p = [at[0] + s * d[0], at[1] + s * d[1], at[2] + s * d[2]];
        // A probe that ends near the surface (one sliding along a face) proves nothing.
        const v = meshDistance(field, p[0], p[1], p[2]);
        if (!(Math.abs(v) >= PROBE_CLEAR * s)) continue;
        const truth = insideByParity(field.bvh, p);
        if (truth !== null && (v < 0) !== truth) { bad = at; break; }
      }
      if (bad) break;
    }
    if (bad) { count++; if (!where) where = bad; }
  }
  return count === 0 ? null : { count, where };
}

/**
 * Build the field of a closed triangle mesh: `{ positions, indices? }`, a Manifold
 * soup (9 floats per triangle) or an indexed mesh. Other fields (normals, ...) are
 * ignored. Throws MeshFieldError for an empty mesh, or for a mesh with a directed
 * edge that does not occur as often as its reverse. A mesh that folds back on itself
 * so its sign is wrong off the fold builds, with `folds: { count, where }` (findFolds).
 * @returns {{ bvh, tris: number, normals: Float64Array, min: number[], max: number[], digest: string, folds?: { count: number, where: number[] } }}
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
  const folds = findFolds({ bvh, normals: N }, V, N, edges, hypot3(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  const digest = digestBytes(new Uint8Array(V.buffer, V.byteOffset, V.byteLength));
  return { bvh, tris, normals: N, min, max, digest, ...(folds ? { folds } : {}) };
}
