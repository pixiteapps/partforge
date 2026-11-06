// A k.implicit CALL's identity within one sub-part's build, for the pose bindings
// (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md). The worker names each
// bound frame "<call id>:<frame name>" (mesh-bindings.js) and the main thread, holding the
// same specs from its pose probe, computes the same ids to find each frame's motion — so
// this file is shared by both, and is a pure leaf (DOM-free, worker-safe).
//
// The id is the call's SHAPE (its spec less the frames table: a pose change moves frames,
// not the shape) plus an ordinal among earlier calls of the same shape in the sub-part, so
// two calls of one shape at different poses stay apart (…#0, …#1).
import { h } from "../solid-hash.js";

/** The spec without its `frames` table. */
export function stripFrames(spec) {
  const { frames, ...rest } = spec ?? {};
  return rest;
}

/** The hash of a spec's shape (its spec less frames). */
export const implicitShapeHash = (spec) => h("implicit-shape", stripFrames(spec));

/** `<shape hash>#<n>`, n = the number of `priorSpecs` with the same shape hash. */
export function implicitCallId(spec, priorSpecs = []) {
  const shape = implicitShapeHash(spec);
  let n = 0;
  for (const p of priorSpecs) if (implicitShapeHash(p) === shape) n++;
  return `${shape}#${n}`;
}
