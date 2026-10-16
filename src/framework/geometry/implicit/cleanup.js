// src/framework/geometry/implicit/cleanup.js
// Replaces the spike's Manifold simplify/smoothOut/refine round trips: one pass of
// topology-safe short-edge collapse, then tangential relaxation alternating with
// projection onto the field. Deterministic: triangle order, first-use compaction.
//
// The preview tier also DECIMATES: after that pass, up to `decimatePasses` more
// collapse passes (each the same deterministic triangle-order walk, each vertex
// collapsed at most once per pass, stopping early once a pass collapses nothing)
// take edges shorter than decimateFrac · edge, under one more guard: a collapse may
// not make the sharpest corner around it both sharper than `decimateMinAngle` and
// sharper than it already was (so a collapse that removes a sliver still goes
// ahead). Without `decimateFrac` (CLEANUP, the print tier) the result is exactly the
// single pass's. Angles are compared through cos² (products, sums and one
// division; no acos), so the core reproduces them bit for bit.
import { projectVertices } from "./project.js";

export const CLEANUP = Object.freeze({ collapseFrac: 0.2, relaxPasses: 2, relaxWeight: 0.5, maxMoveCells: 0.5 });
// Tuned on the hand at its 1.5 mm preview grid and the vase at 1.2 mm
// (docs/research/organic-shapes.md §9a, CPU-timed medians): 0.7 · edge takes the
// hand's cleanup from 157k to 49k triangles (3.2×) with its 5th-percentile corner
// rising from 23° to 29° and its sharpest from 0.5° to 7.7°; 0.6 left 63k, and 0.8
// (39k) let the sharpest corner fall back to 2°. 15° beat 12° (sharpest 5.6°) and
// 18° (more triangles, no better corners). Four passes reach all but 0.1% of the
// collapses twelve do. Renders of the hand before and after are indistinguishable.
export const DECIMATE = Object.freeze({ decimateFrac: 0.7, decimatePasses: 4, decimateMinAngle: 15 });
/** The preview tier's cleanup: CLEANUP plus decimation. */
export const PREVIEW_CLEANUP = Object.freeze({ ...CLEANUP, ...DECIMATE });

/** cos² of the guard angle, or -1 (no guard): computed once in JS and handed to the core as is. */
export const guardCos2 = (deg) => {
  if (!(deg > 0)) return -1;
  const c = Math.cos((deg * Math.PI) / 180);
  return c * c;
};

function triNormal(P, a, b, c, out) {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
}

// How sharp the corner at a (of triangle a, b, c) is: cos² of its angle when acute,
// else 0 — so larger is sharper, and a corner is sharper than θ when this > cos²θ.
function sharpness(P, a, b, c) {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  const dot = ux * vx + uy * vy + uz * vz;
  return dot > 0 ? (dot * dot) / ((ux * ux + uy * uy + uz * uz) * (vx * vx + vy * vy + vz * vz)) : 0;
}
const triSharpness = (P, i, j, k) => Math.max(Math.max(sharpness(P, i, j, k), sharpness(P, j, k, i)), sharpness(P, k, i, j));

// One collapse pass. `cos2` (> 0) turns on the angle guard; -1 leaves it off.
function collapse(P, T, vertLeaf, minLen, cos2 = -1) {
  const nv = P.length / 3, nt = T.length / 3;
  const vt = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) vt[T[3 * t + c]].push(t);
  const alive = new Uint8Array(nt).fill(1), locked = new Uint8Array(nv);
  let collapsed = 0;
  const min2 = minLen * minLen, n0 = [0, 0, 0], n1 = [0, 0, 0];
  const ring = (v) => {
    const s = new Set();
    for (const t of vt[v]) if (alive[t]) for (let c = 0; c < 3; c++) if (T[3 * t + c] !== v) s.add(T[3 * t + c]);
    return s;
  };
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    for (let c = 0; c < 3; c++) {
      const a = T[3 * t + c], b = T[3 * t + ((c + 1) % 3)];
      if (locked[a] || locked[b]) continue;
      const dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
      if (dx * dx + dy * dy + dz * dz >= min2) continue;
      const ra = ring(a), rb = ring(b);
      let common = 0;
      for (const v of ra) if (rb.has(v)) common++;
      if (common !== 2) continue;
      const mx = (P[3 * a] + P[3 * b]) / 2, my = (P[3 * a + 1] + P[3 * b + 1]) / 2, mz = (P[3 * a + 2] + P[3 * b + 2]) / 2;
      // No flips: every surviving triangle around a or b keeps its orientation.
      let ok = true, after = 0;   // the sharpest corner the collapse would leave (guard on)
      const save = [P[3 * a], P[3 * a + 1], P[3 * a + 2], P[3 * b], P[3 * b + 1], P[3 * b + 2]];
      for (const v of [a, b]) for (const tt of vt[v]) {
        if (!ok || !alive[tt]) continue;
        const i = T[3 * tt], j = T[3 * tt + 1], k = T[3 * tt + 2];
        if ((i === a || j === a || k === a) && (i === b || j === b || k === b)) continue;
        triNormal(P, i, j, k, n0);
        P[3 * a] = P[3 * b] = mx; P[3 * a + 1] = P[3 * b + 1] = my; P[3 * a + 2] = P[3 * b + 2] = mz;
        triNormal(P, i, j, k, n1);
        if (cos2 > 0) after = Math.max(after, triSharpness(P, i, j, k));
        P[3 * a] = save[0]; P[3 * a + 1] = save[1]; P[3 * a + 2] = save[2]; P[3 * b] = save[3]; P[3 * b + 1] = save[4]; P[3 * b + 2] = save[5];
        if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] <= 0) ok = false;
      }
      if (ok && cos2 > 0 && after > cos2) {
        // Too sharp: allowed only if the corners around a and b now (the two triangles
        // on the edge included) already had one at least as sharp.
        let before = 0;
        for (const v of [a, b]) for (const tt of vt[v]) if (alive[tt]) before = Math.max(before, triSharpness(P, T[3 * tt], T[3 * tt + 1], T[3 * tt + 2]));
        if (after > before) ok = false;
      }
      if (!ok) continue;
      P[3 * a] = mx; P[3 * a + 1] = my; P[3 * a + 2] = mz;
      for (const tt of vt[b]) {
        if (!alive[tt]) continue;
        let hasA = false;
        for (let q = 0; q < 3; q++) if (T[3 * tt + q] === a) hasA = true;
        if (hasA) { alive[tt] = 0; continue; }
        for (let q = 0; q < 3; q++) if (T[3 * tt + q] === b) T[3 * tt + q] = a;
        vt[a].push(tt);
      }
      locked[a] = locked[b] = 1;
      collapsed++;
      break;   // triangle t is gone; move on
    }
  }
  // Compact: vertices renumbered in order of first use by a surviving triangle.
  const map = new Int32Array(nv).fill(-1), outT = [], outP = [], outL = [];
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    for (let c = 0; c < 3; c++) {
      const v = T[3 * t + c];
      if (map[v] < 0) { map[v] = outP.length / 3; outP.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); outL.push(vertLeaf[v]); }
      outT.push(map[v]);
    }
  }
  return { positions: Float64Array.from(outP), indices: Uint32Array.from(outT), vertLeaf: Int32Array.from(outL), collapsed };
}

// Tangential Laplacian smoothing. A vertex whose projection found no gradient has a
// zero normal and no tangent plane, so it stays put.
export function relax(P, T, N, weight, maxMove) {
  const nv = P.length / 3, sum = new Float64Array(3 * nv), cnt = new Uint32Array(nv);
  for (let t = 0; t < T.length; t += 3) for (let c = 0; c < 3; c++) {
    const a = T[t + c], b = T[t + ((c + 1) % 3)];
    sum[3 * a] += P[3 * b]; sum[3 * a + 1] += P[3 * b + 1]; sum[3 * a + 2] += P[3 * b + 2]; cnt[a]++;
    sum[3 * b] += P[3 * a]; sum[3 * b + 1] += P[3 * a + 1]; sum[3 * b + 2] += P[3 * a + 2]; cnt[b]++;
  }
  for (let v = 0; v < nv; v++) {
    if (!cnt[v]) continue;
    if (N[3 * v] === 0 && N[3 * v + 1] === 0 && N[3 * v + 2] === 0) continue;
    let dx = sum[3 * v] / cnt[v] - P[3 * v], dy = sum[3 * v + 1] / cnt[v] - P[3 * v + 1], dz = sum[3 * v + 2] / cnt[v] - P[3 * v + 2];
    const nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2], dn = dx * nx + dy * ny + dz * nz;
    dx = (dx - dn * nx) * weight; dy = (dy - dn * ny) * weight; dz = (dz - dn * nz) * weight;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > maxMove) { const s = maxMove / l; dx *= s; dy *= s; dz *= s; }
    P[3 * v] += dx; P[3 * v + 1] += dy; P[3 * v + 2] += dz;
  }
}

export function cleanupMesh(store, mesh, opts = CLEANUP) {
  const edge = store.edge;
  let m = collapse(Float64Array.from(mesh.positions), Uint32Array.from(mesh.indices), mesh.vertLeaf, opts.collapseFrac * edge);
  if ((opts.decimateFrac ?? 0) > 0) {
    const cos2 = guardCos2(opts.decimateMinAngle ?? 0), passes = opts.decimatePasses ?? 0;
    for (let pass = 0; pass < passes; pass++) {
      m = collapse(m.positions, m.indices, m.vertLeaf, opts.decimateFrac * edge, cos2);
      if (m.collapsed === 0) break;
    }
  }
  const { collapsed: _collapsed, ...cleaned } = m;
  m = cleaned;
  const normals = new Float64Array(m.positions.length);
  const maxStep = opts.maxMoveCells * edge;
  projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals });
  for (let pass = 0; pass < opts.relaxPasses; pass++) {
    relax(m.positions, m.indices, normals, opts.relaxWeight, maxStep);
    projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals });
  }
  return { ...m, normals };
}
