// Which raw parameters affect the parts on screen in the active view. A removable
// relevance layer: the panel uses this to dim controls / hide sections that don't
// affect what's visible. Pure — no DOM, no real geometry (reuses the geometry-free
// probe kernel). Errs toward RELEVANT_ALL whenever it can't analyze a build.
import { createProbeKernel } from "./geometry/probe.js";
import { byteAwareReplacer } from "./geometry/solid-hash.js";
import { viewSubParts } from "./part-model.js";

export const RELEVANT_ALL = Symbol("relevant-all");

// A read-recording Proxy over a shallow clone of `obj`: records each top-level
// property key read into `seen`, returns the real value so the build's conditionals
// evaluate correctly, and never mutates the original `obj` (writes hit the clone).
function recorder(obj, seen) {
  return new Proxy({ ...obj }, {
    get(target, key) {
      if (typeof key === "string") seen.add(key);
      return Reflect.get(target, key);
    },
  });
}

// Run derive with recorders. `allInputs` is every raw param derive reads.
// For the grouped form (derive as an object of group functions — see derive.js),
// `depsOf` maps each derived key to the raw params of just its own group,
// transitively including the groups whose outputs it read. For the single-function
// form there is no per-key attribution, so depsOf is null and callers fall back to
// treating every derive input as feeding every derived key.
function analyzeDerive(part, params) {
  const allInputs = new Set();
  if (!part.derive) return { derived: {}, allInputs, depsOf: null };
  if (typeof part.derive === "function") {
    const derived = part.derive(recorder(params, allInputs)) ?? {};
    return { derived, allInputs, depsOf: null };
  }
  const derived = {};
  const depsOf = new Map();
  for (const fn of Object.values(part.derive)) {
    const raw = new Set();
    const fromEarlier = new Set();
    const written = new Set();
    // Reads are recorded (and guarded against not-yet-produced keys, matching
    // resolveDerived); writes pass THROUGH to the real accumulator so a group
    // that mutates `d` in place analyzes exactly like it runs in production.
    const dProxy = new Proxy(derived, {
      get(t, key) {
        if (typeof key === "string" && key !== "then") {
          if (!(key in t)) throw new Error(`derive: group read "${key}" before any earlier group produced it`);
          fromEarlier.add(key);
        }
        return Reflect.get(t, key);
      },
      set(t, key, v) {
        if (typeof key === "string") written.add(key);
        return Reflect.set(t, key, v);
      },
    });
    const out = fn(recorder(params, raw), dProxy) ?? {};
    const deps = new Set(raw);
    for (const k of fromEarlier) for (const dep of depsOf.get(k) ?? []) deps.add(dep);
    for (const r of raw) allInputs.add(r);
    for (const key of [...Object.keys(out), ...written]) {
      depsOf.set(key, deps);
      if (Object.hasOwn(out, key)) derived[key] = out[key];
    }
  }
  return { derived, allInputs, depsOf };
}

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
// sub-part of the active view reads. Used by Layer 1 (mount.js) to skip
// regenerating sub-parts whose inputs are unchanged. Errs to RELEVANT_ALL on any
// analysis failure (caller then treats every param as relevant — safe, just slower).
export function subPartReadKeys(part, view, params) {
  try {
    const { derived, allInputs, depsOf } = analyzeDerive(part, params);
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
      if (dSeen.size > 0) {
        if (depsOf && [...dSeen].every((k) => depsOf.has(k))) {
          for (const k of dSeen) for (const dep of depsOf.get(k)) reads.add(dep);
        } else {
          // single-function derive, or a derived key no group produced: no
          // attribution possible — fold every derive input in (safe, coarser).
          for (const dep of allInputs) reads.add(dep);
        }
      }
      map.set(name, reads);
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
