// src/framework/geometry/implicit/project.js
// Newton projection of mesh vertices onto d = 0, batched per leaf: each vertex is
// evaluated with its own leaf's program, which is exact within PAD_CELLS (1 cell)
// of the leaf (sparse.js). Each move is clamped per step (`maxStep`); nothing bounds
// the cumulative drift by construction, but on the fixtures it measured at most
// 0.69 cell, inside the 1-cell pad.
//
// Owner meshes (a root exact contact, `owner` and `held` given): a vertex takes its step on
// its owner's SHARE of the field (evalBatchContact) instead of the field when it is held
// (held[v], the mesher's mark beside an open gap) or when another piece makes the field at
// it (its owner's share is above the field there: a linear crossing that landed past a near
// miss's bisector, or a fingertip pad's vertex on the palm's skin). Otherwise the field step
// is its own skin's, and it takes that. So a vertex beside a thin gap lands on its own piece's
// skin rather than the nearer piece's. A merged owner's share is discontinuous at an
// attachment zone's rim (a blend lowers it inside, the raw cut returns outside), so a share
// step is tried only when the share's stencil gradient is distance-like (≤ HELD_GRAD_MAX), and
// kept only when the share still makes the field at the landing (no other piece is nearer
// there) and either the landing is on the surface (|field| ≤ HELD_FIELD_TOL·edge) or the share
// behaved continuously along the step; otherwise, or when the owner's share is pruned at the
// vertex's leaf, the vertex takes the ordinary field step. Every owner-mesh step is also capped at
// DIST_RATIO × |value|: beside a crease the stencil straddles two pieces' gradients, which average
// toward zero, and value / |gradient| would throw the vertex far across the crease. `unsettled`
// (a per-vertex Uint8Array, owner meshes only) records, for each vertex projected, whether it
// may need another step: it was selected for a share step (held, or another piece makes the
// field at it), or its step moved it more than HELD_FIELD_TOL·edge (it may not be on its
// surface yet). Cleanup's final pass projects only those. A mesh without owners projects
// exactly as before.
import { evalBatch, evalBatchContact } from "./program.js";

/** A held step that lands within this (× edge) of the field's zero is kept. */
const HELD_FIELD_TOL = 1e-3;
/**
 * A share whose stencil gradient is steeper than this has a jump inside the stencil (a
 * distance-like share's is about 1): no share step. A share that, at the landing, is off what
 * the step predicted by more than HELD_CONTINUITY × the step length was not continuous along it.
 */
const HELD_GRAD_MAX = 3, HELD_CONTINUITY = 0.5;
/** An owner-mesh step moves at most this many times the field's value (the fields are distance-like). */
const DIST_RATIO = 2;

export function projectVertices(store, positions, vertLeaf, { maxStep, which = null, normals = null, owner = null, held = null, unsettled = null }) {
  const e = 0.1 * store.edge;
  const groups = new Map();   // leaf index -> vertex list (insertion order = vertex order)
  const count = which ? which.length : positions.length / 3;
  for (let q = 0; q < count; q++) {
    const v = which ? which[q] : q, L = vertLeaf[v];
    let g = groups.get(L);
    if (!g) { g = []; groups.set(L, g); }
    g.push(v);
  }
  const owned = owner !== null && held !== null && store.ownerRoot >= 0, K = Math.max(1, store.ownerK ?? 0);
  for (const [L, verts] of groups) {
    const prog = store.leaves[L].prog, m = verts.length;
    const X = new Float64Array(7 * m), Y = new Float64Array(7 * m), Z = new Float64Array(7 * m), out = new Float64Array(7 * m);
    verts.forEach((v, k) => {
      const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2], o = 7 * k;
      X[o] = x; Y[o] = y; Z[o] = z;
      X[o + 1] = x + e; Y[o + 1] = y; Z[o + 1] = z;
      X[o + 2] = x - e; Y[o + 2] = y; Z[o + 2] = z;
      X[o + 3] = x; Y[o + 3] = y + e; Z[o + 3] = z;
      X[o + 4] = x; Y[o + 4] = y - e; Z[o + 4] = z;
      X[o + 5] = x; Y[o + 5] = y; Z[o + 5] = z + e;
      X[o + 6] = x; Y[o + 6] = y; Z[o + 6] = z - e;
    });
    if (owned) {
      projectOwnedGroup(store, prog, positions, verts, owner, held, { X, Y, Z, out, e, K, maxStep, normals, unsettled });
      continue;
    }
    evalBatch(prog, store.textures, X, Y, Z, out);
    verts.forEach((v, k) => {
      const o = 7 * k, d = out[o];
      const gx = (out[o + 1] - out[o + 2]) / (2 * e), gy = (out[o + 3] - out[o + 4]) / (2 * e), gz = (out[o + 5] - out[o + 6]) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (!(g2 > 1e-12)) return;
      const gl = Math.sqrt(g2);
      if (normals) { normals[3 * v] = gx / gl; normals[3 * v + 1] = gy / gl; normals[3 * v + 2] = gz / gl; }
      let t = d / gl;                              // signed distance estimate along the gradient
      if (t > maxStep) t = maxStep; else if (t < -maxStep) t = -maxStep;
      positions[3 * v] -= (gx / gl) * t; positions[3 * v + 1] -= (gy / gl) * t; positions[3 * v + 2] -= (gz / gl) * t;
    });
  }
}

// One Newton step from the 7-point stencil values f(q), q = 0..6: { d, gx, gy, gz, gl, t } or
// null where there is no gradient. t is the clamped signed distance along the unit gradient.
function newtonStep(f, e, maxStep) {
  const d = f(0), gx = (f(1) - f(2)) / (2 * e), gy = (f(3) - f(4)) / (2 * e), gz = (f(5) - f(6)) / (2 * e);
  const g2 = gx * gx + gy * gy + gz * gz;
  if (!(g2 > 1e-12)) return null;
  const gl = Math.sqrt(g2);
  let t = d / gl;
  // A stencil straddling a crease (where two pieces meet) averages their gradients toward zero,
  // and d / |g| then throws the vertex far: never step more than DIST_RATIO × |d|.
  const far = DIST_RATIO * Math.abs(d);
  if (t > far) t = far; else if (t < -far) t = -far;
  if (t > maxStep) t = maxStep; else if (t < -maxStep) t = -maxStep;
  return { d, gx, gy, gz, gl, t };
}

// A leaf's vertices on an owner mesh: one capturing batch gives the field and every share at
// the stencil; vertices that try a share step are checked by a second capturing batch at the
// landing points.
function projectOwnedGroup(store, prog, positions, verts, owner, held, { X, Y, Z, out, e, K, maxStep, normals, unsettled }) {
  const m = verts.length, shares = new Float64Array(7 * m * K), tol = HELD_FIELD_TOL * store.edge;
  evalBatchContact(prog, store.textures, X, Y, Z, out, { K, shares });
  const fieldSteps = new Array(m), shareSteps = new Array(m).fill(null), tries = [], selected = new Uint8Array(m);
  verts.forEach((v, k) => {
    const o = 7 * k;
    fieldSteps[k] = newtonStep((q) => out[o + q], e, maxStep);
    const w = owner[v];
    // Not held, and its owner makes the field here: the field step is its own skin's.
    if (!held[v] && !(shares[o * K + w] - out[o] > tol)) return;
    selected[k] = 1;
    let finite = true;
    for (let q = 0; q < 7 && finite; q++) if (!Number.isFinite(shares[(o + q) * K + w])) finite = false;
    if (!finite) return;
    const s = newtonStep((q) => shares[(o + q) * K + w], e, maxStep);
    if (s === null || s.gl > HELD_GRAD_MAX) return;   // the stencil straddles a jump in the share
    shareSteps[k] = s;
    tries.push(k);
  });
  // Where each share step lands: the field and the vertex's owner's share there.
  const accepted = new Uint8Array(m);
  if (tries.length) {
    const n = tries.length, CX = new Float64Array(n), CY = new Float64Array(n), CZ = new Float64Array(n), cOut = new Float64Array(n), cShares = new Float64Array(n * K);
    tries.forEach((k, q) => {
      const v = verts[k], s = shareSteps[k];
      CX[q] = positions[3 * v] - (s.gx / s.gl) * s.t; CY[q] = positions[3 * v + 1] - (s.gy / s.gl) * s.t; CZ[q] = positions[3 * v + 2] - (s.gz / s.gl) * s.t;
    });
    evalBatchContact(prog, store.textures, CX, CY, CZ, cOut, { K, shares: cShares });
    tries.forEach((k, q) => {
      const s = shareSteps[k], predicted = s.d - s.gl * s.t, landed = cShares[q * K + owner[verts[k]]];
      const continuous = Math.abs(landed - predicted) <= HELD_CONTINUITY * Math.abs(s.t) + tol, mine = landed - cOut[q] <= tol;
      if (mine && (Math.abs(cOut[q]) <= tol || continuous)) accepted[k] = 1;
    });
  }
  verts.forEach((v, k) => {
    const s = accepted[k] ? shareSteps[k] : fieldSteps[k];
    if (unsettled) unsettled[v] = selected[k] || (s !== null && Math.abs(s.t) > tol) ? 1 : 0;
    if (s === null) return;
    if (normals) { normals[3 * v] = s.gx / s.gl; normals[3 * v + 1] = s.gy / s.gl; normals[3 * v + 2] = s.gz / s.gl; }
    positions[3 * v] -= (s.gx / s.gl) * s.t; positions[3 * v + 1] -= (s.gy / s.gl) * s.t; positions[3 * v + 2] -= (s.gz / s.gl) * s.t;
  });
}
