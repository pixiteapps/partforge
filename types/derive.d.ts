// partforge/derive — a lean, DOM-free entry so a part module (or a helper, or a
// test) can merge a grouped `derive` exactly the way the framework does.

import type { Derived, PartDefinition, ResolvedParams } from "./part.js";

/**
 * Resolve a part's `derive` into the derived-values object `d` builds receive.
 *
 * Both authoring forms are handled: one function computed in a single pass, or
 * named groups run in declaration order (each seeing the merged outputs of the
 * groups before it). A group that reads a key no earlier group produced throws.
 * Returns `{}` when the part declares no `derive`.
 */
export function resolveDerived(part: Pick<PartDefinition, "derive">, p: ResolvedParams): Derived;

/**
 * Resolve a part's `derive` plus attribution: which raw params each derived key came from.
 *
 * Produces the same `d` as `resolveDerived`, throws its errors, and (with `through`)
 * leaves its writes on `p`. For grouped forms, `depsOf` maps each key to its group's
 * raw reads, transitively through earlier groups it read. For single-function form,
 * `depsOf` is null.
 */
export function resolveDerivedAttributed(
  part: Pick<PartDefinition, "derive">,
  p: ResolvedParams,
  options?: { through?: boolean }
): { d: Derived; depsOf: Map<string, Set<string>> | null; allInputs: Set<string> };
