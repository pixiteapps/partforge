// Spec → compiled tree: validate (grammar.js), then lower (ir.js). Its own leaf so a
// caller that only evaluates the field (distance.js) does not load the mesher and the
// native core that index.js brings.
import { validateSpec } from "./grammar.js";
import { lowerSpec } from "./ir.js";

export function compileImplicit(spec, { images = new Map() } = {}) {
  validateSpec(spec, { imageNames: new Set(images.keys()) });
  return lowerSpec(spec, { images });   // contact regions are found while lowering (regions.js)
}
