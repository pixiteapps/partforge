// partforge/organic — checks and vocabulary for k.implicit signed-distance bodies.
// The ops themselves stay on the kernel: k.implicit and k.implicitFrames (types/kernel.d.ts).
// Worker-safe: the grammar's leaf modules only — no mesher, no native core, no three.js, no DOM.

import type { ImplicitOptions } from "./kernel.js";

/** A spec the grammar refused: `issues` lists every problem with its path; the message starts "implicit: ". */
export declare class ImplicitSpecError extends Error {
  constructor(issues: string | string[]);
  readonly name: "ImplicitSpecError";
  readonly code: "IMPLICIT_SPEC";
  readonly issues: string[];
}

/** A spec too large to mesh at its resolution; the message starts "implicit: ". */
export declare class ImplicitSizeError extends Error {
  constructor(message: string);
  readonly name: "ImplicitSizeError";
  readonly code: "IMPLICIT_SIZE";
}

/**
 * Check a k.implicit spec without a kernel. Throws one ImplicitSpecError listing every
 * issue; returns nothing when the spec is valid. `imageNames` lists the part's declared
 * images, so a texture detail naming an undeclared image is refused.
 */
export declare function validateImplicit(spec: ImplicitOptions, options?: { imageNames?: ReadonlySet<string> | null }): void;

/** Every node `kind` the grammar accepts in a spec's tree. */
export declare const IMPLICIT_NODE_KINDS: readonly string[];
/** Every `kind` the grammar accepts in a spec's `detail` list. */
export declare const IMPLICIT_DETAIL_KINDS: readonly string[];
