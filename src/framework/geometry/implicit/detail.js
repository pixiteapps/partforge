// src/framework/geometry/implicit/detail.js
// Surface detail finer than the grid (spec §1 "Detail: two places"): refine the
// mesh only where an entry applies, then move vertices along the field normal by
// the summed heights. Native-portable arithmetic only.
import { pfCos, pfAtan2 } from "../js-math.js";
import { xformPoint, xformDir } from "./frames.js";
import { valueNoise } from "./noise.js";
import { sampleTexture } from "./textures.js";
import { emitExprProgram, runProgram } from "./program.js";
import { projectVertices } from "./project.js";

export const MAX_REFINE_ROUNDS = 3;
const TWO_PI = 2 * Math.PI;

// Every entry is flattened to DETAIL_STRIDE doubles (flattenDetail) and read only through
// that layout, so the JS and the native core consume identical numbers:
//   [kind, hasInv, inv[12], radius (−1 = none), hasSide, side[3], amplitude,
//    wavelength (−1 = none), axis, slot (−1), projection, size0, size1, target,
//    progIndex (−1)]
export const DETAIL_STRIDE = 28;
export const DETAIL_KIND = Object.freeze({ creases: 1, noise: 2, texture: 3, expr: 4 });
export const DETAIL_PROJECTION = Object.freeze({ planar: 0, cylindrical: 1, triplanar: 2 });
export const DF = Object.freeze({ KIND: 0, HAS_INV: 1, INV: 2, RADIUS: 14, HAS_SIDE: 15, SIDE: 16, AMPLITUDE: 19, WAVELENGTH: 20,
  AXIS: 21, SLOT: 22, PROJECTION: 23, SIZE0: 24, SIZE1: 25, TARGET: 26, PROG: 27 });

function flattenEntry(F, o, e, programs) {
  F[o + DF.KIND] = DETAIL_KIND[e.kind] ?? 0;
  F[o + DF.HAS_INV] = e.inv ? 1 : 0;
  for (let i = 0; i < 12; i++) F[o + DF.INV + i] = e.inv ? e.inv[i] : 0;
  F[o + DF.RADIUS] = e.radius != null ? e.radius : -1;
  F[o + DF.HAS_SIDE] = e.side ? 1 : 0;
  for (let i = 0; i < 3; i++) F[o + DF.SIDE + i] = e.side ? e.side[i] : 0;
  F[o + DF.AMPLITUDE] = e.amplitude;
  F[o + DF.WAVELENGTH] = e.wavelength != null ? e.wavelength : -1;
  F[o + DF.AXIS] = e.axis;
  F[o + DF.SLOT] = e.slot;
  F[o + DF.PROJECTION] = DETAIL_PROJECTION[e.projection] ?? 0;
  F[o + DF.SIZE0] = e.size ? e.size[0] : 0;
  F[o + DF.SIZE1] = e.size ? e.size[1] : 0;
  F[o + DF.TARGET] = e.target;
  F[o + DF.PROG] = -1;
  if (e.kind === "expr") { F[o + DF.PROG] = programs.length; programs.push(emitExprProgram(e.height)); }
}

/** The detail entries as flat data: { entries: Float64Array (DETAIL_STRIDE per entry), programs: expr-height programs }. */
export function flattenDetail(compiled) {
  const entries = new Float64Array(DETAIL_STRIDE * compiled.detail.length), programs = [];
  compiled.detail.forEach((e, k) => flattenEntry(entries, DETAIL_STRIDE * k, e, programs));
  return { entries, programs };
}

function weight(F, o, lx, ly, lz, nx, ny, nz) {
  let w = 1;
  if (F[o + DF.HAS_SIDE] !== 0) {
    const d = nx * F[o + DF.SIDE] + ny * F[o + DF.SIDE + 1] + nz * F[o + DF.SIDE + 2];
    const s = (d - 0.15) / 0.5;
    w = s < 0 ? 0 : s > 1 ? 1 : s;
    if (w === 0) return 0;
  }
  const radius = F[o + DF.RADIUS];
  if (radius >= 0) {
    const r2 = (lx * lx + ly * ly + lz * lz) / (radius * radius);
    if (r2 >= 1) return 0;
    const f = 1 - r2;
    w *= f * f;
  }
  return w;
}

function planar(t, axis, lx, ly, lz, size0, size1) {
  const u = axis === 2 ? lx : axis === 0 ? ly : lz, v = axis === 2 ? ly : axis === 0 ? lz : lx;
  return sampleTexture(t, u / size0 + 0.5, v / size1 + 0.5);
}

// Entry o's local point and normal (the entry's frame, when it has one).
function local(p, n, F, o, x, y, z, nx, ny, nz) {
  if (F[o + DF.HAS_INV] !== 0) {
    const inv = F.subarray(o + DF.INV, o + DF.INV + 12);
    xformPoint(p, inv, x, y, z); xformDir(n, inv, nx, ny, nz);
  } else { p[0] = x; p[1] = y; p[2] = z; n[0] = nx; n[1] = ny; n[2] = nz; }
}

// One-lane scratch for expr heights (runProgram overwrites everything it reads).
const LX = new Float64Array(1), LY = new Float64Array(1), LZ = new Float64Array(1), LO = new Float64Array(1);

function entryHeight(F, o, programs, textures, x, y, z, nx, ny, nz) {
  const p = [0, 0, 0], n = [0, 0, 0];
  local(p, n, F, o, x, y, z, nx, ny, nz);
  const w = weight(F, o, p[0], p[1], p[2], n[0], n[1], n[2]);
  if (w === 0) return 0;
  const kind = F[o + DF.KIND], axis = F[o + DF.AXIS], amplitude = F[o + DF.AMPLITUDE], wavelength = F[o + DF.WAVELENGTH];
  switch (kind) {
    case 1: return -amplitude * Math.max(0, pfCos((TWO_PI * p[axis]) / wavelength)) * w;
    case 2: return amplitude * 2 * valueNoise(p[0] / wavelength, p[1] / wavelength, p[2] / wavelength) * w;
    case 3: {
      const t = textures[F[o + DF.SLOT]], projection = F[o + DF.PROJECTION], size0 = F[o + DF.SIZE0], size1 = F[o + DF.SIZE1];
      let v;
      if (projection === 1) {
        const u = pfAtan2(p[(axis + 2) % 3], p[(axis + 1) % 3]) / TWO_PI + 0.5;
        v = sampleTexture(t, u, p[axis] / size1 + 0.5);
      } else if (projection === 2) {
        const ax = n[0] * n[0] * n[0] * n[0], ay = n[1] * n[1] * n[1] * n[1], az = n[2] * n[2] * n[2] * n[2], s = ax + ay + az;
        v = (planar(t, 0, p[0], p[1], p[2], size0, size1) * ax + planar(t, 1, p[0], p[1], p[2], size0, size1) * ay + planar(t, 2, p[0], p[1], p[2], size0, size1) * az) / s;
      } else v = planar(t, axis, p[0], p[1], p[2], size0, size1);
      return amplitude * v * w;
    }
    case 4: {
      LX[0] = p[0]; LY[0] = p[1]; LZ[0] = p[2];
      runProgram(programs[F[o + DF.PROG]], textures, LX, LY, LZ, 1, LO);
      const v = LO[0];
      return (Number.isNaN(v) ? 0 : v) * w;
    }
    default: return 0;
  }
}

/** The height one lowered detail entry adds at (x, y, z) with normal n — read through its flattened form. */
export function detailHeight(e, textures, x, y, z, nx, ny, nz) {
  const F = new Float64Array(DETAIL_STRIDE), programs = [];
  flattenEntry(F, 0, e, programs);
  return entryHeight(F, 0, programs, textures, x, y, z, nx, ny, nz);
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

/**
 * A refinement midpoint m whose projection found no gradient keeps a zero normal; it
 * takes the normalized sum of its endpoints' normals instead (zero if that is zero too).
 */
export function midpointNormal(N, a, b, m) {
  if (N[3 * m] !== 0 || N[3 * m + 1] !== 0 || N[3 * m + 2] !== 0) return;
  const x = N[3 * a] + N[3 * b], y = N[3 * a + 1] + N[3 * b + 1], z = N[3 * a + 2] + N[3 * b + 2];
  const l = Math.sqrt(x * x + y * y + z * z);
  if (!(l > 0)) return;
  N[3 * m] = x / l; N[3 * m + 1] = y / l; N[3 * m + 2] = z / l;
}

export function applySurfaceDetail(store, mesh, compiled) {
  const { entries: F, programs } = flattenDetail(compiled), count = compiled.detail.length;
  const tex = compiled.textures, edge = store.edge;
  let P = Array.from(mesh.positions), N = Array.from(mesh.normals), T = Array.from(mesh.indices), VL = Array.from(mesh.vertLeaf);
  // The refinement mask is exactly "some entry's weight is non-zero here".
  const lp = [0, 0, 0], ln = [0, 0, 0];
  const targetAt = (v) => {
    let t = Infinity;
    for (let k = 0; k < count; k++) {
      const o = DETAIL_STRIDE * k, target = F[o + DF.TARGET];
      local(lp, ln, F, o, P[3 * v], P[3 * v + 1], P[3 * v + 2], N[3 * v], N[3 * v + 1], N[3 * v + 2]);
      if (weight(F, o, lp[0], lp[1], lp[2], ln[0], ln[1], ln[2]) > 0) t = Math.min(t, target === Infinity ? edge / 2 : target);
    }
    return Math.max(edge / 8, t);
  };
  for (let round = 0; round < MAX_REFINE_ROUNDS; round++) {
    const nv = P.length / 3, target = new Float64Array(nv);
    for (let v = 0; v < nv; v++) target[v] = targetAt(v);
    const mid = new Map(), added = [], ends = [];
    const midpoint = (a, b) => {
      const key = a < b ? a * nv + b : b * nv + a;
      let m = mid.get(key);
      if (m !== undefined) return m;
      const lim = Math.min(target[a], target[b]);
      const dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
      if (!(lim < Infinity) || dx * dx + dy * dy + dz * dz <= lim * lim) { mid.set(key, -1); return -1; }
      m = P.length / 3;
      P.push((P[3 * a] + P[3 * b]) / 2, (P[3 * a + 1] + P[3 * b + 1]) / 2, (P[3 * a + 2] + P[3 * b + 2]) / 2);
      N.push(0, 0, 0); VL.push(VL[a]); added.push(m); ends.push(a, b);
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
    for (let q = 0; q < added.length; q++) midpointNormal(N, ends[2 * q], ends[2 * q + 1], added[q]);
  }
  const positions = Float64Array.from(P), normals = Float64Array.from(N);
  for (let v = 0; v < positions.length / 3; v++) {
    if (normals[3 * v] === 0 && normals[3 * v + 1] === 0 && normals[3 * v + 2] === 0) continue;   // no direction to move along
    let h = 0;
    for (let k = 0; k < count; k++) h += entryHeight(F, DETAIL_STRIDE * k, programs, tex, positions[3 * v], positions[3 * v + 1], positions[3 * v + 2], normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]);
    if (h === 0) continue;
    positions[3 * v] += normals[3 * v] * h; positions[3 * v + 1] += normals[3 * v + 1] * h; positions[3 * v + 2] += normals[3 * v + 2] * h;
  }
  return { positions, indices: Uint32Array.from(T), vertLeaf: Int32Array.from(VL), normals };
}
