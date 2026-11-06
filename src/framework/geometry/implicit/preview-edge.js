// src/framework/geometry/implicit/preview-edge.js
// The automatic preview grid: a spec without `preview` previews at the finest edge on
// PREVIEW_LADDER whose predicted meshing cost fits PREVIEW_BUDGET, so a simple shape gets
// a fine grid and a complex one stays fast. The prediction is a pure function of the
// compiled tree — no clock (a build is memoized by content hash), so every machine, JS or
// native core, picks the same edge.
//
// The model, from one coarse planLeaves at PROBE_EDGE (its leaves are the surface band;
// its programs are what those leaves would run):
//   cost(e) = leaves · (PROBE_EDGE / e)² · (1 + opsPerSample / OP_WEIGHT) · (contact root ? OWNER_FACTOR : 1)
// in leaf units. On the native core a leaf's mesh/cleanup work costs about as much as
// OP_WEIGHT program instructions per sample, so the instruction count matters only for
// heavy trees; a contact root's owner path (piece capture, owner mesher, crease cut) about
// doubles the per-leaf work. Fitted on 17 reference fixtures (desktop, native meshImplicit,
// preview tier): one unit is about 17.5 µs. Fixed per-mesh overhead and surface-detail
// refinement are not modelled, so tiny shapes and textured detail at coarse grids run over
// their prediction — both far under the budget, where the choice does not depend on them.
import { planLeaves } from "./sparse.js";
import { programOps } from "./program.js";
import { ImplicitSizeError } from "./errors.js";

/** The preview edges (mm) the chooser picks from, finest first. */
export const PREVIEW_LADDER = Object.freeze([0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]);
/** The probe's grid edge (mm): coarse enough to cost ~3% of the hand's 1.5 mm preview. */
export const PROBE_EDGE = 4;
/** Program instructions per sample that cost as much as a leaf's own meshing work. */
export const OP_WEIGHT = 50;
/** A contact root's owner-path cost per leaf, relative to the plain mesher's. */
export const OWNER_FACTOR = 2;
/**
 * The work budget, in leaf units (~330 ms of desktop native meshing). Calibrated so the
 * default hand (handSpec() without its `preview`) and the fist both keep their 1.5 mm grid:
 * the fist predicts 16,700 at 1.5 and the hand 21,700 at 1.25, and the budget sits between,
 * about 14% from each. The ball pressed by a board (r 20 sphere, 80×80×6 box, round 1)
 * then previews at 0.6 mm and the vase fixture at 0.75 mm — what a ~300 ms limit on the
 * measured times picks too.
 */
export const PREVIEW_BUDGET = 19_000;

/**
 * The probe: the surface band's leaf count at PROBE_EDGE and the mean program instructions
 * per sample over those leaves, with `cost(edge)` the model above. Null when the shape is
 * too large to plan even at the probe grid (the chosen edge then fails with the size error).
 */
export function previewProbe(compiled) {
  let plan;
  try { plan = planLeaves(compiled, PROBE_EDGE); }
  catch (e) { if (e instanceof ImplicitSizeError) return null; throw e; }
  const progOps = plan.programs.map(programOps);
  let total = 0;
  for (const leaf of plan.leaves) total += progOps[leaf.progIndex];
  const leaves = plan.leaves.length, ops = leaves ? total / leaves : 0;
  const perLeaf = (1 + ops / OP_WEIGHT) * (compiled.ownerRoot >= 0 ? OWNER_FACTOR : 1);
  const cost = (edge) => leaves * (PROBE_EDGE / edge) ** 2 * perLeaf;
  return { leaves, ops, cost };
}

/**
 * The preview edge for a spec that does not set `preview`: the finest PREVIEW_LADDER edge
 * whose predicted cost fits PREVIEW_BUDGET, else the coarsest. That is also the finest
 * affordable grid for the thinnest feature — the result's thin-feature warning reads the
 * edge actually used.
 */
export function choosePreviewEdge(compiled, probe = previewProbe(compiled)) {
  const coarsest = PREVIEW_LADDER[PREVIEW_LADDER.length - 1];
  if (!probe) return coarsest;
  return PREVIEW_LADDER.find((edge) => probe.cost(edge) <= PREVIEW_BUDGET) ?? coarsest;
}
