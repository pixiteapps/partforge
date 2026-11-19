// src/framework/geometry/implicit/cleanup.js
// Replaces the spike's Manifold simplify/smoothOut/refine round trips: one pass of
// topology-safe short-edge collapse, then tangential relaxation alternating with
// projection onto the field. Deterministic: triangle order, first-use compaction.
//
// The preview tier also DECIMATES: after that pass, up to `decimatePasses` more
// collapse passes (each the same deterministic triangle-order walk, each vertex
// collapsed at most once per pass, stopping early once a pass collapses nothing)
// take edges shorter than decimateFrac · edge, under four more guards: never a
// tetrahedron (both endpoints of ring size 3 — it would fold into a pillow); no new
// corner both sharper than `decimateMinAngle` and sharper than the corners around
// the edge already were (so collapses that remove slivers still go ahead); no
// surviving triangle's normal turning by more than `decimateMaxTurn`; and every
// surviving triangle's new normal within `decimateMaxSpread` of their sum — the
// fidelity guard: a fan's spread is about its size over the surface's radius, so
// small, curved features keep their triangles. Two stops keep decimation from
// costing more than it saves: before the first pass a probe tries the edges of every
// PROBE_STRIDE-th triangle and skips decimation outright when fewer than
// `decimateMinAccept` of the short ones may collapse (a surface the guards mostly
// keep), and the passes end once one removes fewer than `decimateMinGain` of the
// triangles. Without `decimateFrac` (CLEANUP, the print tier) the result is exactly
// the single pass's. Angles are compared
// through cos² (products, sums and one division; no acos), so the core reproduces
// them bit for bit.
//
// An owner mesh (meshStoreOwners: `vertOwner`, `ownerHeld`, `pinned`) is cleaned with three
// more rules, the seam spec's §4: collapse and decimation never merge vertices of different
// owners or a pinned one (a merged vertex is held when either end was); held vertices, and any
// vertex another piece makes the field at, project onto their owner's share (project.js, which
// guards the share's jumps), and those (and any vertex still moving) take one more projection
// after the last relaxation; pinned vertices (exactly on a gap face) are neither projected nor
// relaxed, and take their normals from a zero-step projection at the end. The three fields are carried through every
// compaction and returned. A mesh without them is cleaned exactly as before.
import { projectVertices } from "./project.js";

export const CLEANUP = Object.freeze({ collapseFrac: 0.2, relaxPasses: 2, relaxWeight: 0.5, maxMoveCells: 0.5 });
// Tuned on spheres at the 1.5 mm grid, the hand at 1.5 mm and the vase at 1.2 mm
// (docs/research/organic-shapes.md §9a, CPU-timed medians). The spread guard sets
// fidelity: at 12° decimation adds at most 0.5% volume loss to spheres of r 1.5–4.5 mm
// (1.3% at 6 mm), where the per-triangle turn guard alone, at any angle from 15° to
// 30°, still lost 6–8% at r = 3 mm; 15° lost 0.4–2%, 10° left the hand 7% more triangles.
// 0.7 · edge then takes the hand's cleanup from 157k to 53k triangles over four
// passes (p5 corner 23° → 28°); 0.8 reached 43k but let the sharpest corner fall to 0.2°. The corner
// guard at 15° and four passes as before; the turn guard (20°) changes almost
// nothing beside the spread guard but bounds any single collapse. The probe allows
// 53% of the hand's edges and 30% of the vase's, whose four passes cost more than
// they saved (k.implicit 328 → 400 ms for 145k → 130k triangles): at 0.4 the vase
// is not decimated and the hand is. The early stop at 0.2 ends the hand after three
// passes (the fourth removed 4%), 77k triangles; 0.03–0.05 kept the fourth pass and
// were no faster end to end.
export const DECIMATE = Object.freeze({ decimateFrac: 0.7, decimatePasses: 4, decimateMinAngle: 15, decimateMaxTurn: 20, decimateMaxSpread: 12,
  decimateMinAccept: 0.4, decimateMinGain: 0.2 });
/** The preview tier's cleanup: CLEANUP plus decimation. */
export const PREVIEW_CLEANUP = Object.freeze({ ...CLEANUP, ...DECIMATE });

/** cos² of a guard angle in degrees, or -1 (no guard): computed once in JS and handed to the core as is. */
export const guardCos2 = (deg) => {
  if (!(deg > 0)) return -1;
  const c = Math.cos((deg * Math.PI) / 180);
  return c * c;
};

// The decimation probe tests every PROBE_STRIDE-th triangle's edges (see collapse).
const PROBE_STRIDE = 32;

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

// One collapse pass. `dec` (a decimation pass) adds the decimation guards: never
// both endpoints of ring size 3 (with the link condition that is exactly a
// tetrahedron — a tiny closed component — which would fold into a zero-volume
// pillow of duplicate triangles), the corner guard (`dec.cos2`, cos² of
// decimateMinAngle), the normal-turn guard (`dec.ncos2`, cos² of decimateMaxTurn:
// no surviving triangle's normal turns by more) and the spread guard (`dec.scos2`,
// cos² of decimateMaxSpread). A cos² <= 0 turns its guard off. `own` (an owner mesh:
// { vertOwner, ownerHeld, pinned }) keeps different owners and pinned vertices apart.
function collapse(P, T, vertLeaf, minLen, dec = null, own = null) {
  const cos2 = dec ? dec.cos2 : -1, ncos2 = dec ? dec.ncos2 : -1, scos2 = dec ? dec.scos2 : -1, fan = [];
  const nv = P.length / 3, nt = T.length / 3;
  const vt = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) vt[T[3 * t + c]].push(t);
  const alive = new Uint8Array(nt).fill(1), locked = new Uint8Array(nv);
  const apart = own === null ? null : (a, b) => own.pinned[a] || own.pinned[b] || own.vertOwner[a] !== own.vertOwner[b];
  let collapsed = 0;
  const min2 = minLen * minLen, n0 = [0, 0, 0], n1 = [0, 0, 0];
  const ring = (v) => {
    const s = new Set();
    for (const t of vt[v]) if (alive[t]) for (let c = 0; c < 3; c++) if (T[3 * t + c] !== v) s.add(T[3 * t + c]);
    return s;
  };
  const short = (a, b) => {
    const dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
    return dx * dx + dy * dy + dz * dz < min2;
  };
  // May edge (a, b) collapse to its midpoint? Sets mx, my, mz. Reads only; P is restored.
  let mx = 0, my = 0, mz = 0;
  const allowed = (a, b) => {
    const ra = ring(a), rb = ring(b);
    if (dec && ra.size === 3 && rb.size === 3) return false;   // a tetrahedron: it would fold into a pillow
    let common = 0;
    for (const v of ra) if (rb.has(v)) common++;
    if (common !== 2) return false;
    mx = (P[3 * a] + P[3 * b]) / 2; my = (P[3 * a + 1] + P[3 * b + 1]) / 2; mz = (P[3 * a + 2] + P[3 * b + 2]) / 2;
    // No flips: every surviving triangle around a or b keeps its orientation.
    let ok = true, after = 0; fan.length = 0;   // the sharpest corner the collapse would leave (guard on)
    const save = [P[3 * a], P[3 * a + 1], P[3 * a + 2], P[3 * b], P[3 * b + 1], P[3 * b + 2]];
    for (const v of [a, b]) for (const tt of vt[v]) {
      if (!ok || !alive[tt]) continue;
      const i = T[3 * tt], j = T[3 * tt + 1], k = T[3 * tt + 2];
      if ((i === a || j === a || k === a) && (i === b || j === b || k === b)) continue;
      triNormal(P, i, j, k, n0);
      P[3 * a] = P[3 * b] = mx; P[3 * a + 1] = P[3 * b + 1] = my; P[3 * a + 2] = P[3 * b + 2] = mz;
      triNormal(P, i, j, k, n1);
      if (cos2 > 0) after = Math.max(after, triSharpness(P, i, j, k));
      if (scos2 > 0) fan.push(n1[0], n1[1], n1[2]);
      P[3 * a] = save[0]; P[3 * a + 1] = save[1]; P[3 * a + 2] = save[2]; P[3 * b] = save[3]; P[3 * b + 1] = save[4]; P[3 * b + 2] = save[5];
      const turn = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
      if (turn <= 0) ok = false;
      else if (ncos2 > 0 && turn * turn < ncos2 * ((n0[0] * n0[0] + n0[1] * n0[1] + n0[2] * n0[2]) * (n1[0] * n1[0] + n1[1] * n1[1] + n1[2] * n1[2]))) ok = false;
    }
    if (ok && scos2 > 0) {
      // Spread: every surviving triangle's new normal within the spread angle of
      // their sum (an area-weighted mean). The fan's spread grows with its size over
      // the surface's radius, so this keeps triangles small where curvature is high.
      let Nx = 0, Ny = 0, Nz = 0;
      for (let q = 0; q < fan.length; q += 3) { Nx += fan[q]; Ny += fan[q + 1]; Nz += fan[q + 2]; }
      const NN = Nx * Nx + Ny * Ny + Nz * Nz;
      for (let q = 0; q < fan.length && ok; q += 3) {
        const d = fan[q] * Nx + fan[q + 1] * Ny + fan[q + 2] * Nz;
        if (d <= 0 || d * d < scos2 * ((fan[q] * fan[q] + fan[q + 1] * fan[q + 1] + fan[q + 2] * fan[q + 2]) * NN)) ok = false;
      }
    }
    if (ok && cos2 > 0 && after > cos2) {
      // Too sharp: allowed only if the corners around a and b now (the two triangles
      // on the edge included) already had one at least as sharp.
      let before = 0;
      for (const v of [a, b]) for (const tt of vt[v]) if (alive[tt]) before = Math.max(before, triSharpness(P, T[3 * tt], T[3 * tt + 1], T[3 * tt + 2]));
      if (after > before) ok = false;
    }
    return ok;
  };
  // The probe (a decimation pass given `minAccept`): test every edge of every
  // PROBE_STRIDE-th triangle on the mesh as it stands, nothing collapsed; when fewer
  // than minAccept of the short ones may collapse, the pass is skipped (the mesh is
  // returned as it came, collapsed 0) — a curved surface the guards keep would pay
  // a full pass, and more, for little.
  if (dec && dec.minAccept > 0) {
    let tried = 0, ok = 0;
    for (let t = 0; t < nt; t += PROBE_STRIDE) for (let c = 0; c < 3; c++) {
      const a = T[3 * t + c], b = T[3 * t + ((c + 1) % 3)];
      if (!short(a, b) || (apart !== null && apart(a, b))) continue;
      tried++;
      if (allowed(a, b)) ok++;
    }
    if (ok < dec.minAccept * tried) return { positions: P, indices: T, vertLeaf, own, collapsed: 0 };
  }
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    for (let c = 0; c < 3; c++) {
      const a = T[3 * t + c], b = T[3 * t + ((c + 1) % 3)];
      if (locked[a] || locked[b] || (apart !== null && apart(a, b))) continue;
      if (!short(a, b) || !allowed(a, b)) continue;
      P[3 * a] = mx; P[3 * a + 1] = my; P[3 * a + 2] = mz;
      if (own !== null && own.ownerHeld[b]) own.ownerHeld[a] = 1;
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
  const map = new Int32Array(nv).fill(-1), outT = [], outP = [], outL = [], outO = [], outH = [], outPin = [];
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    for (let c = 0; c < 3; c++) {
      const v = T[3 * t + c];
      if (map[v] < 0) {
        map[v] = outP.length / 3; outP.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); outL.push(vertLeaf[v]);
        if (own !== null) { outO.push(own.vertOwner[v]); outH.push(own.ownerHeld[v]); outPin.push(own.pinned[v]); }
      }
      outT.push(map[v]);
    }
  }
  const kept = own === null ? null : { vertOwner: Int32Array.from(outO), ownerHeld: Uint8Array.from(outH), pinned: Uint8Array.from(outPin) };
  return { positions: Float64Array.from(outP), indices: Uint32Array.from(outT), vertLeaf: Int32Array.from(outL), own: kept, collapsed };
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
  const own0 = mesh.vertOwner ? { vertOwner: Int32Array.from(mesh.vertOwner), ownerHeld: Uint8Array.from(mesh.ownerHeld), pinned: Uint8Array.from(mesh.pinned) } : null;
  let m = collapse(Float64Array.from(mesh.positions), Uint32Array.from(mesh.indices), mesh.vertLeaf, opts.collapseFrac * edge, null, own0);
  if ((opts.decimateFrac ?? 0) > 0) {
    const dec = { cos2: guardCos2(opts.decimateMinAngle ?? 0), ncos2: guardCos2(opts.decimateMaxTurn ?? 0), scos2: guardCos2(opts.decimateMaxSpread ?? 0), minAccept: opts.decimateMinAccept ?? 0 };
    const passes = opts.decimatePasses ?? 0, minGain = opts.decimateMinGain ?? 0;
    for (let pass = 0; pass < passes; pass++) {
      const before = m.indices.length / 3;
      m = collapse(m.positions, m.indices, m.vertLeaf, opts.decimateFrac * edge, pass === 0 ? dec : { ...dec, minAccept: 0 }, m.own);
      // Stop once a pass removes too little to pay for the next (none removed: nothing will be).
      if (m.collapsed === 0 || before - m.indices.length / 3 < minGain * before) break;
    }
  }
  const { collapsed: _collapsed, own, ...cleaned } = m;
  m = cleaned;
  const normals = new Float64Array(m.positions.length);
  const maxStep = opts.maxMoveCells * edge;
  if (own === null) {
    projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals });
    for (let pass = 0; pass < opts.relaxPasses; pass++) {
      relax(m.positions, m.indices, normals, opts.relaxWeight, maxStep);
      projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals });
    }
    return { ...m, normals };
  }
  // Pinned vertices keep a zero normal until the end, so relax leaves them where they are.
  const free = [], pins = [];
  for (let v = 0; v < own.pinned.length; v++) (own.pinned[v] ? pins : free).push(v);
  const held = { owner: own.vertOwner, held: own.ownerHeld };
  const which = Int32Array.from(free), unsettled = new Uint8Array(own.pinned.length);
  projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals, which, ...held, unsettled });
  for (let pass = 0; pass < opts.relaxPasses; pass++) {
    relax(m.positions, m.indices, normals, opts.relaxWeight, maxStep);
    projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals, which, ...held, unsettled });
  }
  // One more step after the last relaxation: a gap's tolerance (1% of it) is below one step's
  // residual on curved skin at the preview grid. Only the vertices that last projection left
  // unsettled need it (selected for their own piece's share, or moved more than project.js's
  // HELD_FIELD_TOL·edge); a store without an owner root projects on the field alone and marks
  // none, so every free vertex takes it.
  const again = store.ownerRoot >= 0 ? free.filter((v) => unsettled[v]) : free;
  // A vertex skipped here keeps the position and normal its last projection gave it.
  if (again.length) projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals, which: Int32Array.from(again), ...held });
  if (pins.length) projectVertices(store, m.positions, m.vertLeaf, { maxStep: 0, normals, which: Int32Array.from(pins), ...held });
  return { ...m, normals, ...own };
}
