// src/framework/geometry/implicit/sparse.js
// Coarse-to-fine sampling: blocks of TOP cells split in octants down to LEAF
// cells; a block is skipped when its interval excludes 0 (exact — see
// interval.js). Surviving leaves get the program emitted from their own decision
// (shared across leaves with equal decisions) and their (LEAF+1)³ samples.
import { blockDecision, fullDecision, decisionKey } from "./interval.js";
import { emitProgram, evalBatch } from "./program.js";
import { ImplicitSizeError } from "./errors.js";

export const LEAF = 4, TOP = 32, SNAP_CELLS = 0, PAD_CELLS = 1;
export const MAX_SAMPLES = 24_000_000, MAX_GRID_CELLS = 2e10;
const SQRT3 = Math.sqrt(3);

export function sampleField(compiled, edge, { cull = true } = {}) {
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
  const programs = new Map(), leaves = [];
  const X = new Float64Array(S3), Y = new Float64Array(S3), Z = new Float64Array(S3), out = new Float64Array(S3);
  const fullDec = cull ? null : fullDecision(compiled);
  // `samples` counts shared-face samples once per leaf (a conservative cap, not unique grid points).
  let samples = 0, clipped = false;

  const visit = (i0, j0, l0, B) => {
    let dec;
    if (cull) {
      const r = (B * edge * SQRT3) / 2 + PAD_CELLS * edge;
      const cx = origin[0] + (i0 + B / 2) * edge, cy = origin[1] + (j0 + B / 2) * edge, cz = origin[2] + (l0 + B / 2) * edge;
      const a = blockDecision(compiled, cx, cy, cz, r);
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
        if (i < n[0] - 1 && j < n[1] - 1 && l < n[2] - 1) visit(i, j, l, h);
      }
      return;
    }
    const key = decisionKey(dec);
    let prog = programs.get(key);
    if (!prog) { prog = emitProgram(compiled, dec); programs.set(key, prog); }
    samples += S3;
    if (samples > MAX_SAMPLES) throw new ImplicitSizeError(`the surface needs more than ${MAX_SAMPLES} samples at a ${edge} mm grid — raise \`resolution\`/\`preview\` or split the part`);
    let q = 0;
    for (let l = 0; l < S; l++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++, q++) {
      X[q] = origin[0] + (i0 + i) * edge; Y[q] = origin[1] + (j0 + j) * edge; Z[q] = origin[2] + (l0 + l) * edge;
    }
    evalBatch(prog, compiled.textures, X, Y, Z, out);
    const vals = new Float32Array(S3);
    q = 0;
    for (let l = 0; l < S; l++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++, q++) {
      let v = out[q];
      const gi = i0 + i, gj = j0 + j, gl = l0 + l;
      if (gi === 0 || gj === 0 || gl === 0 || gi >= n[0] - 1 || gj >= n[1] - 1 || gl >= n[2] - 1) {
        if (v <= 0) clipped = true;
        if (v < 0.5 * edge) v = 0.5 * edge;
      }
      // An exactly-zero sample counts as outside; nudging it off zero keeps every crossing on its
      // own edge vertex (a shared zero vertex would merge crossings and break manifoldness on thin features).
      if (v === 0) v = 1e-30;
      vals[q] = v;
    }
    leaves.push({ i0, j0, l0, prog, vals });
  };

  for (let l = 0; l < n[2] - 1; l += TOP) for (let j = 0; j < n[1] - 1; j += TOP) for (let i = 0; i < n[0] - 1; i += TOP) visit(i, j, l, TOP);
  return { origin, edge, n, snap, leaves, programs, textures: compiled.textures, samples, clipped };
}
