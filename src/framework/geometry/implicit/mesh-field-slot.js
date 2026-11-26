// Where the mesh field builder (mesh-field-build.js) is, once it is loaded. The
// builder imports the oracle's BVH, so it loads on demand; this slot imports
// nothing, so ir.js and anything else in the worker's eager closure or the kit's
// closure can ask for the builder without reaching the BVH. mesh-field-loader.js
// holds the one dynamic import of the builder. It installs the builder here, and
// it registers itself as the load starter when it is evaluated.
//
// A solid leaf has no fallback: with no builder, meshFieldBuilder() throws an
// error with code NEEDS_MESH_FIELD. The worker's job loop (jobs.js handle) loads
// the builder and runs the job again; a Node caller awaits loadMeshFieldBuilder()
// before it builds.

export const NEEDS_MESH_FIELD = "NEEDS_MESH_FIELD";

let builder = null;
let starter = null;

/** The loader installs the loaded buildMeshField. */
export function installMeshFieldBuilder(fn) { builder = fn; }

/** The loader registers the function that starts its load. */
export function registerMeshFieldStarter(fn) { starter = fn; }

/** Whether the builder is loaded. */
export const meshFieldBuilderLoaded = () => builder !== null;

/**
 * The loaded buildMeshField. Not loaded: starts the load (when a loader is
 * registered), so a later build finds it, and throws code NEEDS_MESH_FIELD.
 */
export function meshFieldBuilder() {
  if (builder !== null) return builder;
  if (starter !== null) starter();
  throw Object.assign(
    new Error("implicit: a solid leaf needs the mesh field builder, which is not loaded yet — await loadMeshFieldBuilder() and build again"),
    { code: NEEDS_MESH_FIELD });
}
