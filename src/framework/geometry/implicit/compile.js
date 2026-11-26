// Spec → compiled tree: validate (grammar.js), then lower (ir.js). Its own leaf so a
// caller that only evaluates the field (distance.js) does not load the mesher and the
// native core that index.js brings.
import { validateSpec } from "./grammar.js";
import { lowerSpec } from "./ir.js";

// The print grid when a spec omits `resolution`. A spec without `preview` gets an automatic
// preview grid instead (choosePreviewEdge, preview-edge.js). Here, not in index.js, so lint
// can read it without loading the mesher.
export const IMPLICIT_DEFAULTS = Object.freeze({ resolution: 0.6 });

// `meshFieldOf(solid)` gives a solid leaf's field (mesh-field.js's buildMeshField of its mesh
// by default); the manifold kernel passes one that memoizes per solid `_hash`.
export function compileImplicit(spec, { images = new Map(), meshFieldOf } = {}) {
  validateSpec(spec, { imageNames: new Set(images.keys()) });
  return lowerSpec(spec, { images, meshFieldOf });   // contact regions are found while lowering (regions.js)
}
