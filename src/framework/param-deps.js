// PREDICTED param dependencies — computed before building, against the geometry-free probe kernel. The mesh cache, panel, pickers and oracle use the reads RECORDED from the real build and fall back to this only for sub-parts not yet built. It is wrong whenever a build branches on a geometry query (isEmpty, volume, …), which the probe answers with stand-ins.
import { recorder, expandDerivedReads } from "./read-recorder.js";
import { resolveDerivedAttributed } from "./derive.js";
import { createProbeKernel } from "./geometry/probe.js";
import { byteAwareReplacer } from "./geometry/solid-hash.js";
import { viewSubParts } from "./part-model.js";

export const RELEVANT_ALL = Symbol("relevant-all");

export function relevantParamKeys(part, view, params) {
  // The union of every on-screen sub-part's read set (that's exactly what
  // subPartReadKeys computes, derive attribution included)...
  const reads = subPartReadKeys(part, view, params);
  if (reads === RELEVANT_ALL) return RELEVANT_ALL; // analysis failed → everything relevant
  try {
    const relevant = new Set();
    for (const keys of reads.values()) for (const k of keys) relevant.add(k);
    // ...plus the gate params of EVERY in-view sub-part, on or off: toggling one
    // changes what's on screen, so its enabled() inputs are relevant even when the
    // sub-part is currently hidden (on-screen ones are already in `reads`).
    for (const name of Object.keys(part.parts)) {
      const sp = part.parts[name];
      if (sp.views.includes(view) && sp.enabled) sp.enabled(recorder(params, relevant));
    }
    return relevant;
  } catch {
    return RELEVANT_ALL;
  }
}

// Per-sub-part version of relevantParamKeys: which raw params each ON-SCREEN
// sub-part of the active view reads. This is a PREDICTION: display consumers
// (selection, measure) and the oracle use it until they move to recorded reads;
// the mesh cache no longer does. Errs to RELEVANT_ALL on any
// analysis failure (caller then treats every param as relevant — safe, just slower).
export function subPartReadKeys(part, view, params) {
  try {
    const { d: derived, depsOf, allInputs } = resolveDerivedAttributed(part, params);
    const { kernel } = createProbeKernel();
    const map = new Map();
    for (const name of viewSubParts(part, view, params)) {
      const sp = part.parts[name];
      const reads = new Set();
      const dSeen = new Set();
      if (sp.enabled) sp.enabled(recorder(params, reads)); // gate params change presence too
      const built = sp.build(kernel, recorder(params, reads), recorder(derived, dSeen));
      // place() shapes what's on screen too (display pose is baked into the cached
      // mesh), so its reads count — without this, a param consumed only by place()
      // would let the mesh cache skip a rebuild and leave the sub-part misplaced.
      if (sp.place) sp.place(built, { view, purpose: "display", p: recorder(params, reads), d: recorder(derived, dSeen) });
      map.set(name, expandDerivedReads(reads, dSeen, { depsOf, allInputs }));
    }
    return map;
  } catch {
    return RELEVANT_ALL;
  }
}

// Stable string of the given param keys' current values — the cache-validity key
// for one sub-part. Sorted so key order never affects the result. `byteAwareReplacer`
// substitutes a content fingerprint for a byte-valued param (an ArrayBuffer/typed-array
// image source — see its own header) so JSON.stringify's default handling doesn't
// collapse every image to the same "{}" (cache never invalidates) or expand a typed
// array to one JSON number per byte (see solid-hash.js).
export function relevanceHash(keys, params) {
  return JSON.stringify(keys.slice().sort().map((k) => [k, params[k]]), byteAwareReplacer);
}
