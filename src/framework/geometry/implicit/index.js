// The implicit engine's public surface for the kernels: compile a spec once,
// mesh it at a grid edge. Pure and DOM-free (loads in the geometry worker).
import { planLeaves, evaluateLeaves } from "./sparse.js";
import { meshStore } from "./mesher.js";
import { meshStoreOwners } from "./mesher-owners.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "./cleanup.js";
import { cutCreases, untangle } from "./crease.js";
import { applySurfaceDetail } from "./detail.js";
import { implicitResult, triangleOwners } from "./result.js";
import { meshImplicitCore } from "../../core/implicit-core.js";

export { choosePreviewEdge } from "./preview-edge.js";

export { compileImplicit, IMPLICIT_DEFAULTS } from "./compile.js";

// planLeaves, then the rest on the native core when it is on (core/implicit-core.js —
// the same bytes, test/core-parity.test.js); else, or when the core refuses or
// faults, the JS stages below. `tier: "preview"` decimates in cleanup
// (PREVIEW_CLEANUP); any other tier (print, export) cleans up exactly as CLEANUP.
//
// A contact root (`compiled.ownerRoot ≥ 0`) meshes through the owner mesher
// (mesher-owners.js) and owner-aware cleanup, and its result gains `vertOwner`,
// `ownerHeld`, `pinned`, `crease` and `triOwner` (the crease cut, crease.js, after cleanup and before detail),
// on the core as in JS. `owners: false` meshes the same field with the plain mesher instead: the seam baseline.
//
// `cache` (a createSampleCache(), sample-cache.js — the preview kernel's) anchors the grid to
// the world lattice (planLeaves `anchor`) and lets a leaf take its samples from an earlier
// build: the same bytes a cold build gives, and `stats.cacheHits` counts the leaves taken.
// Without one the plan is unanchored, exactly as before. The native core does not take the
// cache yet, so an anchored build runs the JS stages — core on and off alike, the same bytes.
export function meshImplicit(compiled, edge, { tier, owners = true, cache } = {}) {
  const opts = tier === "preview" ? PREVIEW_CLEANUP : CLEANUP;
  const plan = planLeaves(compiled, edge, { anchor: !!cache });
  if (!cache) {
    const native = meshImplicitCore(compiled, edge, plan, opts, { owners });
    if (native) return native;
  }
  const store = evaluateLeaves(plan, { cache });
  const ownerPath = owners && compiled.ownerRoot >= 0;
  const node = ownerPath ? compiled.ir.nodes[compiled.ownerRoot] : null;
  const raw = ownerPath ? meshStoreOwners(store, { gap: node.gap }) : meshStore(store);
  let mesh = cleanupMesh(store, raw, opts);
  if (ownerPath) mesh = untangle(store, cutCreases(store, mesh, node.attWorld));
  if (compiled.detail.length) mesh = applySurfaceDetail(store, mesh, compiled);
  const result = implicitResult(compiled, edge, plan, mesh, store.clipped);
  result.stats.cacheHits = store.cacheHits;
  if (ownerPath) Object.assign(result, { vertOwner: mesh.vertOwner, ownerHeld: mesh.ownerHeld, pinned: mesh.pinned, crease: mesh.crease, triOwner: triangleOwners(mesh) });
  return result;
}

export const implicitHashable = (spec, compiled) => ({ spec, digests: compiled.digests });
