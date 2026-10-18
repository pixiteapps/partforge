// src/framework/geometry/implicit/sparse.js
// Coarse-to-fine sampling: blocks of TOP cells split in octants down to LEAF
// cells; a block is skipped when its interval excludes 0 (exact — see
// interval.js). Surviving leaves get the program emitted from their own decision
// (shared across leaves with equal decisions) and their (LEAF+1)³ samples.
// Two halves: planLeaves (traversal, programs) and evaluateLeaves (samples) — the
// native core plugs in at the seam and evaluates the same plan.
import { blockDecision, fullDecision, decisionKey } from "./interval.js";
import { emitProgram, evalBatch, evalBatchContact } from "./program.js";
import { ImplicitSizeError } from "./errors.js";

export const LEAF = 4, TOP = 32, SNAP_CELLS = 0, PAD_CELLS = 1;
export const MAX_SAMPLES = 24_000_000, MAX_GRID_CELLS = 2e10;
const SQRT3 = Math.sqrt(3);
const ZERO_DIR = [1, 0.7071067811865476, 0.5773502691896258];

/** The whole sampler: plan the leaves, then evaluate them. */
export function sampleField(compiled, edge, opts) {
  return evaluateLeaves(planLeaves(compiled, edge, opts));
}

/**
 * The traversal half: which leaves survive the interval cull, and the program each
 * one runs. Plan = { origin, edge, n, snap, leaves: [{ i0, j0, l0, progIndex }],
 * programs: Float64Array[] (index order = first emission), textures, samples, clipped: false,
 * ownerRoot, ownerK } — ownerRoot/ownerK copied from the compiled tree (−1/0 unless its root is
 * an exact contact node, whose children then own the samples: evaluateLeaves).
 * It is plain data — the native core samples the same plan.
 * Each child block starts from its parent block's decision (`inherit`, interval.js:
 * a slot the parent pruned firmly is not walked again), which yields exactly the plan a
 * full walk from the IR root per block gives; `inherit: false` is that full walk, kept for
 * test/implicit-plan-inherit.test.js to hold the two equal.
 */
export function planLeaves(compiled, edge, { cull = true, inherit = true } = {}) {
  const { bounds } = compiled;
  const pad = 2 * edge;
  const origin = bounds.min.map((v) => v - pad);
  const n = [0, 1, 2].map((a) => Math.max(2, Math.ceil((bounds.max[a] + pad - origin[a]) / edge) + 1));
  const cells = (n[0] - 1) * (n[1] - 1) * (n[2] - 1);
  if (cells > MAX_GRID_CELLS) {
    throw new ImplicitSizeError(`a ${edge} mm grid over this shape has ${cells.toExponential(1)} cells (limit ${MAX_GRID_CELLS.toExponential(0)}) — raise \`resolution\`/\`preview\` or split the part`);
  }
  const snap = SNAP_CELLS * edge;
  const S = LEAF + 1, S3 = S * S * S;
  const progIndex = new Map(), programs = [], leaves = [];
  const fullDec = cull ? null : fullDecision(compiled, edge);
  // `samples` counts shared-face samples once per leaf (a conservative cap, not unique grid points).
  let samples = 0;

  const visit = (i0, j0, l0, B, parentDec) => {
    let dec;
    if (cull) {
      const r = (B * edge * SQRT3) / 2 + PAD_CELLS * edge;
      const cx = origin[0] + (i0 + B / 2) * edge, cy = origin[1] + (j0 + B / 2) * edge, cz = origin[2] + (l0 + B / 2) * edge;
      const a = blockDecision(compiled, cx, cy, cz, r, inherit ? parentDec : undefined, edge);
      // No vertex snapping (snap = 0): a block whose interval excludes 0 holds no surface.
      // The inside cull (hi < 0) is only taken for blocks touching no outer-layer
      // sample: those must be raised to 0.5·edge and flag `clipped`, so they are sampled.
      const interior = i0 > 0 && j0 > 0 && l0 > 0 && i0 + B < n[0] - 1 && j0 + B < n[1] - 1 && l0 + B < n[2] - 1;
      if (a.lo > 0 || (interior && a.hi < 0)) return;
      dec = a.dec;
    } else dec = fullDec;
    if (B > LEAF) {
      const h = B / 2;
      for (let dl = 0; dl < 2; dl++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
        const i = i0 + di * h, j = j0 + dj * h, l = l0 + dl * h;
        if (i < n[0] - 1 && j < n[1] - 1 && l < n[2] - 1) visit(i, j, l, h, dec);
      }
      return;
    }
    const key = decisionKey(dec);
    let pi = progIndex.get(key);
    if (pi === undefined) { pi = programs.length; programs.push(emitProgram(compiled, dec, edge)); progIndex.set(key, pi); }
    samples += S3;
    if (samples > MAX_SAMPLES) throw new ImplicitSizeError(`the surface needs more than ${MAX_SAMPLES} samples at a ${edge} mm grid — raise \`resolution\`/\`preview\` or split the part`);
    leaves.push({ i0, j0, l0, progIndex: pi });
  };

  for (let l = 0; l < n[2] - 1; l += TOP) for (let j = 0; j < n[1] - 1; j += TOP) for (let i = 0; i < n[0] - 1; i += TOP) visit(i, j, l, TOP, undefined);
  return { origin, edge, n, snap, leaves, programs, textures: compiled.textures, samples, clipped: false, ownerRoot: compiled.ownerRoot ?? -1, ownerK: compiled.ownerK ?? 0 };
}

/** A sample's owner where the stored value is ≥ 0 (outside every piece). */
export const OWNER_AIR = -1;

/**
 * The evaluation half: each planned leaf's (LEAF+1)³ samples, stored as float32. Returns
 * the Store — the plan's fields with `clipped` set and every leaf as { i0, j0, l0,
 * progIndex, prog, vals }. The plan itself is not modified.
 * When the plan has an owner root (`ownerRoot ≥ 0`), each leaf also gets `owner`, an
 * Int8Array of its samples' owning children (evalBatchContact's `piece`; OWNER_AIR where the
 * stored value is ≥ 0),
 * captured by the same evaluation: one evalBatchContact replaces the evalBatch, and the
 * zero nudge captures its own. `hooks` swaps the two evaluators (a test counts calls).
 */
export function evaluateLeaves(plan, hooks = {}) {
  const { origin, edge, n, programs, textures } = plan;
  const run = hooks.evalBatch ?? evalBatch, runContact = hooks.evalBatchContact ?? evalBatchContact;
  const owned = plan.ownerRoot >= 0, K = plan.ownerK;
  const S = LEAF + 1, S3 = S * S * S;
  const X = new Float64Array(S3), Y = new Float64Array(S3), Z = new Float64Array(S3), out = new Float64Array(S3);
  const ZI = new Int32Array(S3);
  // The zero-sample re-evaluation offset: 1e-6 of a cell along a fixed, axis-free direction.
  const nudge = [1e-6 * edge, 1e-6 * edge * ZERO_DIR[1], 1e-6 * edge * ZERO_DIR[2]];
  const leaves = [];
  let clipped = false;
  for (const { i0, j0, l0, progIndex } of plan.leaves) {
    const prog = programs[progIndex];
    let q = 0;
    for (let l = 0; l < S; l++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++, q++) {
      X[q] = origin[0] + (i0 + i) * edge; Y[q] = origin[1] + (j0 + j) * edge; Z[q] = origin[2] + (l0 + l) * edge;
    }
    const owner = owned ? new Int8Array(S3) : null;
    if (owned) runContact(prog, textures, X, Y, Z, out, { K, piece: owner }); else run(prog, textures, X, Y, Z, out);
    const vals = new Float32Array(S3);
    let zeros = 0;
    q = 0;
    for (let l = 0; l < S; l++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++, q++) {
      let v = out[q];
      const gi = i0 + i, gj = j0 + j, gl = l0 + l;
      if (gi === 0 || gj === 0 || gl === 0 || gi >= n[0] - 1 || gj >= n[1] - 1 || gl >= n[2] - 1) {
        if (v <= 0) clipped = true;
        if (v < 0.5 * edge) v = 0.5 * edge;
      }
      const f = Math.fround(v);   // the value as stored
      vals[q] = f;
      if (f === 0) ZI[zeros++] = q;   // zero once stored as float32 (exact, or below float32 range)
    }
    // A sample that is exactly zero sits on the surface: often a face two hard pieces share
    // (a union, mirror or repeat of touching solids), where min(d1, d2) = 0 exactly. Reading
    // it as outside would cut a sheet between the pieces; reading it as inside would grow a
    // sheet on every flush subtract. Instead the leaf's own program decides at a fixed point
    // a hair off the grid, in sample order (deterministic, + only). Never 0 afterwards: the
    // crossings stay on their own edge vertices (a shared zero vertex breaks thin features).
    if (zeros > 0) {
      const ZX = new Float64Array(zeros), ZY = new Float64Array(zeros), ZZ = new Float64Array(zeros), Zout = new Float64Array(zeros);
      for (let z = 0; z < zeros; z++) { const s = ZI[z]; ZX[z] = X[s] + nudge[0]; ZY[z] = Y[s] + nudge[1]; ZZ[z] = Z[s] + nudge[2]; }
      const Zown = owned ? new Int8Array(zeros) : null;
      if (owned) runContact(prog, textures, ZX, ZY, ZZ, Zout, { K, piece: Zown }); else run(prog, textures, ZX, ZY, ZZ, Zout);
      for (let z = 0; z < zeros; z++) {
        const s = ZI[z], f = Math.fround(Zout[z]);
        vals[s] = f === 0 ? (Zout[z] < 0 ? -1e-30 : 1e-30) : f;
        if (owned) owner[s] = Zown[z];
      }
    }
    if (owned) for (let s = 0; s < S3; s++) if (vals[s] >= 0) owner[s] = OWNER_AIR;
    leaves.push(owned ? { i0, j0, l0, progIndex, prog, vals, owner } : { i0, j0, l0, progIndex, prog, vals });
  }
  return { ...plan, leaves, clipped };
}
