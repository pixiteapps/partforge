// Loads the mesh field builder (mesh-field-build.js) on demand and installs it in
// mesh-field-slot.js. This file holds the ONLY import of mesh-field-build.js, and
// that import is dynamic, so the oracle's BVH stays out of every eager closure.
// Only modules outside the worker's eager closure and the kit's closure may import
// this file (the Manifold backend, jobs.js, src/testing): ir.js imports the slot.
// test/worker-layering.test.js and test/kit-layering.test.js hold this in place.
import { installMeshFieldBuilder, registerMeshFieldStarter } from "./mesh-field-slot.js";

export { NEEDS_MESH_FIELD, meshFieldBuilder, meshFieldBuilderLoaded } from "./mesh-field-slot.js";

let loading = null;

/**
 * Load the mesh field builder. Idempotent. Resolves true once it is installed.
 * Unlike loadFullCore it REJECTS when the import fails: a solid leaf has no JS
 * fallback. A failed load is not remembered, so a later call tries again.
 * @returns {Promise<true>}
 */
export function loadMeshFieldBuilder() {
  return (loading ??= import("./mesh-field-build.js").then((m) => {
    installMeshFieldBuilder(m.buildMeshField);
    return true;
  }, (err) => { loading = null; throw err; }));
}

registerMeshFieldStarter(() => { void loadMeshFieldBuilder().catch(() => {}); });
