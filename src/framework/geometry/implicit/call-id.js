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

/**
 * The spec as it is hashed: every `solid` leaf's `solid` field becomes the string
 * `"solid:" + solid._hash`, so a hash names the solid by its geometry and never walks the
 * solid object. Copy on write: a branch with no solid leaf is the input object itself, so a
 * spec with no solid leaf comes back unchanged and every hash of it keeps its bytes. A solid
 * with no `_hash` (a stub, such as the lint probe's JSON copy, where a solid reads as `{}`)
 * becomes `"solid:?"`; the build itself refuses it (grammar.js `solidRef`).
 */
export function hashableSpec(spec) {
  const walk = (v) => {
    if (Array.isArray(v)) {
      let out = null;
      for (let i = 0; i < v.length; i++) {
        const w = walk(v[i]);
        if (w !== v[i]) (out ??= v.slice())[i] = w;
      }
      return out ?? v;
    }
    if (!v || typeof v !== "object" || ArrayBuffer.isView(v)) return v;
    let out = null;
    for (const key of Object.keys(v)) {
      const w = key === "solid" && v.kind === "solid" ? `solid:${v.solid?._hash ?? "?"}` : walk(v[key]);
      if (w !== v[key]) (out ??= { ...v })[key] = w;
    }
    if (v.kind === "solid" && !("solid" in v)) (out ??= { ...v }).solid = "solid:?";
    return out ?? v;
  };
  return walk(spec);
}

/** The hash of a spec's shape (its spec less frames). */
export const implicitShapeHash = (spec) => h("implicit-shape", hashableSpec(stripFrames(spec)));

/** `<shape hash>#<n>`, n = the number of `priorSpecs` with the same shape hash. */
export function implicitCallId(spec, priorSpecs = []) {
  const shape = implicitShapeHash(spec);
  let n = 0;
  for (const p of priorSpecs) if (implicitShapeHash(p) === shape) n++;
  return `${shape}#${n}`;
}
