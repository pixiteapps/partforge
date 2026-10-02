// partforge/testing — utilities for testing parts headlessly (Manifold kernel, the
// job loop, the assembly collision check, an OCCT kernel, and mesh measures).
// See docs/AUTHORING-PARTS.md "Testing a part".
//
// Most of what this re-exports is NOT test-only code: the oracle (measure/verify/
// buildView/gaps/BVH/min-wall) also runs inside the browser geometry worker, so it
// lives in src/framework/oracle/. Only the Node-bound harness — the two kernel
// booters, the PNG renderer — lives in src/testing/. This barrel is the published
// entry point and hides that split from downstream consumers.
export { createManifoldKernel } from "./framework/geometry/manifold-backend.js";
export { bootManifoldKernel } from "./testing/manifold.js";
export { handle } from "./framework/jobs.js";
export { viewSubParts } from "./framework/part-model.js";
export { resolveDerived } from "./framework/derive.js";
export { relevantParamKeys, RELEVANT_ALL } from "./framework/param-deps.js";
export { assemblyOverlaps } from "./framework/assembly.js";
export { bootOcctKernel } from "./testing/occt.js";
export { renderViews, renderViewImages, RENDER_VIEWS } from "./testing/render.js";
export { RENDER_STYLES } from "./framework/renderStyles.js";
// The whole oracle surface (measure/verify/buildView, gaps/BVH/min-wall, silhouette
// match scoring, and the semantic mesh oracle) comes through partforge/oracle — one
// list of names, two doors. See src/oracle.js for what each group is.
export * from "./oracle.js";
