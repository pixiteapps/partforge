// partforge/organic: what a part imports beside k.implicit — checking a spec before it
// reaches the kernel, and the grammar's vocabulary. The ops themselves stay on `k`.
// Only the grammar's leaf modules: the engine's index reaches the mesher and the native
// core's WebAssembly, which a part that only checks a spec should not load.
import { validateSpec, NODE_KINDS, DETAIL_KINDS } from "../../geometry/implicit/grammar.js";

export { ImplicitSpecError, ImplicitSizeError } from "../../geometry/implicit/errors.js";

/** Throws one ImplicitSpecError listing every issue in a k.implicit spec, with its path; returns nothing when the spec is valid. */
export function validateImplicit(spec, { imageNames = null } = {}) {
  validateSpec(spec, { imageNames });
}

export const IMPLICIT_NODE_KINDS = Object.freeze(Object.keys(NODE_KINDS));
export const IMPLICIT_DETAIL_KINDS = Object.freeze(Object.keys(DETAIL_KINDS));
