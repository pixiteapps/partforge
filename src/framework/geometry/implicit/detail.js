// src/framework/geometry/implicit/detail.js
// Surface detail finer than the grid (spec §1 "Detail: two places"): refine the
// mesh only where an entry applies, then move vertices along the field normal by
// the summed heights. Native-portable arithmetic only.
import { pfCos, pfAtan2 } from "../js-math.js";
import { xformPoint, xformDir } from "./frames.js";
import { valueNoise } from "./noise.js";
import { sampleTexture } from "./textures.js";
import { evalExprScalar } from "./expr-lower.js";
import { projectVertices } from "./project.js";

export const MAX_REFINE_ROUNDS = 3;
const TWO_PI = 2 * Math.PI;

function weight(e, lx, ly, lz, nx, ny, nz) {
  let w = 1;
  if (e.side) {
    const d = nx * e.side[0] + ny * e.side[1] + nz * e.side[2];
    const s = (d - 0.15) / 0.5;
    w = s < 0 ? 0 : s > 1 ? 1 : s;
    if (w === 0) return 0;
  }
  if (e.radius != null) {
    const r2 = (lx * lx + ly * ly + lz * lz) / (e.radius * e.radius);
    if (r2 >= 1) return 0;
    const f = 1 - r2;
    w *= f * f;
  }
  return w;
}

function planar(t, axis, lx, ly, lz, size) {
  const u = axis === 2 ? lx : axis === 0 ? ly : lz, v = axis === 2 ? ly : axis === 0 ? lz : lx;
  return sampleTexture(t, u / size[0] + 0.5, v / size[1] + 0.5);
}

export function detailHeight(e, textures, x, y, z, nx, ny, nz) {
  const p = [x, y, z], n = [nx, ny, nz];
  if (e.inv) { xformPoint(p, e.inv, x, y, z); xformDir(n, e.inv, nx, ny, nz); }
  const w = weight(e, p[0], p[1], p[2], n[0], n[1], n[2]);
  if (w === 0) return 0;
  switch (e.kind) {
    case "creases": return -e.amplitude * Math.max(0, pfCos((TWO_PI * p[e.axis]) / e.wavelength)) * w;
    case "noise": return e.amplitude * 2 * valueNoise(p[0] / e.wavelength, p[1] / e.wavelength, p[2] / e.wavelength) * w;
    case "texture": {
      const t = textures[e.slot];
      let v;
      if (e.projection === "cylindrical") {
        const a = e.axis, u = pfAtan2(p[(a + 2) % 3], p[(a + 1) % 3]) / TWO_PI + 0.5;
        v = sampleTexture(t, u, p[a] / e.size[1] + 0.5);
      } else if (e.projection === "triplanar") {
        const ax = n[0] * n[0] * n[0] * n[0], ay = n[1] * n[1] * n[1] * n[1], az = n[2] * n[2] * n[2] * n[2], s = ax + ay + az;
        v = (planar(t, 0, p[0], p[1], p[2], e.size) * ax + planar(t, 1, p[0], p[1], p[2], e.size) * ay + planar(t, 2, p[0], p[1], p[2], e.size) * az) / s;
      } else v = planar(t, e.axis, p[0], p[1], p[2], e.size);
      return e.amplitude * v * w;
    }
    case "expr": {
      const v = evalExprScalar(e.height, p[0], p[1], p[2], textures, sampleTexture);
      return (v === v ? v : 0) * w;
    }
    default: return 0;
  }
}

// Split pattern for a triangle with midpoints m[0] (v0v1), m[1] (v1v2), m[2] (v2v0), −1 = none.
function splitTri(out, v, m) {
  const k = (m[0] >= 0) + (m[1] >= 0) + (m[2] >= 0);
  if (k === 0) { out.push(v[0], v[1], v[2]); return; }
  if (k === 3) { out.push(v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]); return; }
  // Rotate so the pattern is canonical: for k = 1 the marked edge is edge 0;
  // for k = 2 the unmarked edge is edge 2.
  let r = 0;
  if (k === 1) r = m[0] >= 0 ? 0 : m[1] >= 0 ? 1 : 2;
  else r = m[2] < 0 ? 0 : m[0] < 0 ? 1 : 2;
  const V = [v[r], v[(r + 1) % 3], v[(r + 2) % 3]], M = [m[r], m[(r + 1) % 3], m[(r + 2) % 3]];
  if (k === 1) out.push(V[0], M[0], V[2], M[0], V[1], V[2]);
  else out.push(M[0], V[1], M[1], V[0], M[0], M[1], V[0], M[1], V[2]);
}

export function applySurfaceDetail(store, mesh, compiled) {
  const entries = compiled.detail, tex = compiled.textures, edge = store.edge;
  let P = Array.from(mesh.positions), N = Array.from(mesh.normals), T = Array.from(mesh.indices), VL = Array.from(mesh.vertLeaf);
  // The refinement mask is exactly "some entry's weight is non-zero here".
  const targetAt = (v) => {
    let t = Infinity;
    for (const e of entries) {
      if (weight(e, ...localOf(e, P, N, v)) > 0) t = Math.min(t, e.target === Infinity ? edge / 2 : e.target);
    }
    return Math.max(edge / 8, t);
  };
  for (let round = 0; round < MAX_REFINE_ROUNDS; round++) {
    const nv = P.length / 3, target = new Float64Array(nv);
    for (let v = 0; v < nv; v++) target[v] = targetAt(v);
    const mid = new Map(), added = [];
    const midpoint = (a, b) => {
      const key = a < b ? a * nv + b : b * nv + a;
      let m = mid.get(key);
      if (m !== undefined) return m;
      const lim = Math.min(target[a], target[b]);
      const dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
      if (!(lim < Infinity) || dx * dx + dy * dy + dz * dz <= lim * lim) { mid.set(key, -1); return -1; }
      m = P.length / 3;
      P.push((P[3 * a] + P[3 * b]) / 2, (P[3 * a + 1] + P[3 * b + 1]) / 2, (P[3 * a + 2] + P[3 * b + 2]) / 2);
      N.push(0, 0, 0); VL.push(VL[a]); added.push(m);
      mid.set(key, m);
      return m;
    };
    const out = [];
    for (let t = 0; t < T.length; t += 3) {
      const v = [T[t], T[t + 1], T[t + 2]];
      splitTri(out, v, [midpoint(v[0], v[1]), midpoint(v[1], v[2]), midpoint(v[2], v[0])]);
    }
    if (!added.length) break;
    T = out;
    const Pf = Float64Array.from(P), Nf = Float64Array.from(N);
    projectVertices(store, Pf, Int32Array.from(VL), { maxStep: edge, which: Int32Array.from(added), normals: Nf });
    P = Array.from(Pf); N = Array.from(Nf);
  }
  const positions = Float64Array.from(P), normals = Float64Array.from(N);
  for (let v = 0; v < positions.length / 3; v++) {
    let h = 0;
    for (const e of entries) h += detailHeight(e, tex, positions[3 * v], positions[3 * v + 1], positions[3 * v + 2], normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]);
    if (h === 0) continue;
    positions[3 * v] += normals[3 * v] * h; positions[3 * v + 1] += normals[3 * v + 1] * h; positions[3 * v + 2] += normals[3 * v + 2] * h;
  }
  return { positions, indices: Uint32Array.from(T), vertLeaf: Int32Array.from(VL), normals };
}

function localOf(e, P, N, v) {
  const p = [P[3 * v], P[3 * v + 1], P[3 * v + 2]], n = [N[3 * v], N[3 * v + 1], N[3 * v + 2]];
  if (e.inv) { xformPoint(p, e.inv, p[0], p[1], p[2]); xformDir(n, e.inv, n[0], n[1], n[2]); }
  return [p[0], p[1], p[2], n[0], n[1], n[2]];
}
