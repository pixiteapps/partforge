// The implicit engine's public surface for the kernels: compile a spec once,
// mesh it at a grid edge. Pure and DOM-free (loads in the geometry worker).
import { validateSpec } from "./grammar.js";
import { lowerSpec } from "./ir.js";
import { planLeaves, evaluateLeaves } from "./sparse.js";
import { meshStore } from "./mesher.js";
import { meshStoreOwners } from "./mesher-owners.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "./cleanup.js";
import { cutCreases, untangle } from "./crease.js";
import { applySurfaceDetail } from "./detail.js";
import { implicitResult, triangleOwners } from "./result.js";
import { meshImplicitCore } from "../../core/implicit-core.js";

export const IMPLICIT_DEFAULTS = Object.freeze({ resolution: 0.6, preview: 1.5 });

export function compileImplicit(spec, { images = new Map(), exactContact = false } = {}) {
  validateSpec(spec, { imageNames: new Set(images.keys()) });
  return lowerSpec(spec, { images, exactContact });   // contact regions are found while lowering (regions.js)
}

// planLeaves, then the rest on the native core when it is on (core/implicit-core.js —
// the same bytes, test/core-parity.test.js); else, or when the core refuses or
// faults, the JS stages below. `tier: "preview"` decimates in cleanup
// (PREVIEW_CLEANUP); any other tier (print, export) cleans up exactly as CLEANUP.
//
// A root exact contact (`compiled.ownerRoot ≥ 0`) meshes through the owner mesher
// (mesher-owners.js) and owner-aware cleanup, and its result gains `vertOwner`,
// `ownerHeld`, `pinned`, `crease` and `triOwner` (the crease cut, crease.js, after cleanup and before detail). `owners: false`
// meshes the same field with the plain mesher instead: the seam baseline.
export function meshImplicit(compiled, edge, { tier, owners = true } = {}) {
  const opts = tier === "preview" ? PREVIEW_CLEANUP : CLEANUP;
  const plan = planLeaves(compiled, edge);
  // An exact-contact tree carries ops the native decoder does not know yet: JS answers.
  const native = compiled.ownerRoot >= 0 ? null : meshImplicitCore(compiled, edge, plan, opts);
  if (native) return native;
  const store = evaluateLeaves(plan);
  const ownerPath = owners && compiled.ownerRoot >= 0;
  const node = ownerPath ? compiled.ir.nodes[compiled.ownerRoot] : null;
  const raw = ownerPath ? meshStoreOwners(store, { gap: node.gap }) : meshStore(store);
  let mesh = cleanupMesh(store, raw, opts);
  if (ownerPath) mesh = untangle(store, cutCreases(store, mesh, node.att));
  if (compiled.detail.length) mesh = applySurfaceDetail(store, mesh, compiled);
  const result = implicitResult(compiled, edge, plan, mesh, store.clipped);
  if (ownerPath) Object.assign(result, { vertOwner: mesh.vertOwner, ownerHeld: mesh.ownerHeld, pinned: mesh.pinned, crease: mesh.crease, triOwner: triangleOwners(mesh) });
  return result;
}

export const implicitHashable = (spec, compiled) => ({ spec, digests: compiled.digests });
