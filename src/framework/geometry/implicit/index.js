// The implicit engine's public surface for the kernels: compile a spec once,
// mesh it at a grid edge. Pure and DOM-free (loads in the geometry worker).
import { validateSpec } from "./grammar.js";
import { lowerSpec } from "./ir.js";
import { planLeaves, evaluateLeaves } from "./sparse.js";
import { meshStore } from "./mesher.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "./cleanup.js";
import { applySurfaceDetail } from "./detail.js";
import { implicitResult } from "./result.js";
import { meshImplicitCore } from "../../core/implicit-core.js";

export const IMPLICIT_DEFAULTS = Object.freeze({ resolution: 0.6, preview: 1.5 });

export function compileImplicit(spec, { images = new Map() } = {}) {
  validateSpec(spec, { imageNames: new Set(images.keys()) });
  return lowerSpec(spec, { images });   // contact regions are found while lowering (regions.js)
}

// planLeaves, then the rest on the native core when it is on (core/implicit-core.js —
// the same bytes, test/core-parity.test.js); else, or when the core refuses or
// faults, the JS stages below. `tier: "preview"` decimates in cleanup
// (PREVIEW_CLEANUP); any other tier (print, export) cleans up exactly as CLEANUP.
export function meshImplicit(compiled, edge, { tier } = {}) {
  const opts = tier === "preview" ? PREVIEW_CLEANUP : CLEANUP;
  const plan = planLeaves(compiled, edge);
  const native = meshImplicitCore(compiled, edge, plan, opts);
  if (native) return native;
  const store = evaluateLeaves(plan);
  let mesh = cleanupMesh(store, meshStore(store), opts);
  if (compiled.detail.length) mesh = applySurfaceDetail(store, mesh, compiled);
  return implicitResult(compiled, edge, plan, mesh, store.clipped);
}

export const implicitHashable = (spec, compiled) => ({ spec, digests: compiled.digests });
