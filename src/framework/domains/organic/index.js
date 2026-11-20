// partforge/organic: what a part imports beside k.implicit — checking a spec before it
// reaches the kernel, the grammar's vocabulary, and the cage builder for kernel-free code.
// The ops themselves stay on `k`.
// Only the grammar's leaf modules: the engine's index reaches the mesher and the native
// core's WebAssembly, which a part that only checks a spec should not load.
import { validateSpec, NODE_KINDS, DETAIL_KINDS } from "../../geometry/implicit/grammar.js";

export { ImplicitSpecError, ImplicitSizeError } from "../../geometry/implicit/errors.js";
// The cage builder k.cage calls, for code that runs without a kernel: `derive` reading
// face centres to place drag handles. Plain arithmetic, so it stays light.
export { createCage as cage } from "../../geometry/subdiv/cage.js";

/** Throws one ImplicitSpecError listing every issue in a k.implicit spec, with its path; returns nothing when the spec is valid. */
export function validateImplicit(spec, { imageNames = null } = {}) {
  validateSpec(spec, { imageNames });
}

export const IMPLICIT_NODE_KINDS = Object.freeze(Object.keys(NODE_KINDS));
export const IMPLICIT_DETAIL_KINDS = Object.freeze(Object.keys(DETAIL_KINDS));
