// Pure — no DOM, no real geometry.
// PREDICTED param dependencies — computed before building, against the geometry-free probe kernel. The mesh cache, panel, pickers and oracle use the reads RECORDED from the real build and fall back to this only for sub-parts not yet built. It is wrong whenever a build branches on a geometry query (isEmpty, volume, …), which the probe answers with stand-ins.
import { recorder, expandDerivedReads } from "./read-recorder.js";
import { resolveDerivedAttributed } from "./derive.js";
import { createProbeKernel } from "./geometry/probe.js";
import { inView, placeOf } from "./sub-part-views.js";
import { byteAwareReplacer } from "./geometry/solid-hash.js";
import { viewSubParts, resolveParamsAttributed, recordedParams } from "./part-model.js";
import { newReadSink, expandReads } from "./read-recorder.js";
import { probeSubPartPose } from "./pose-probe-core.js";

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
      if (inView(sp, view) && sp.enabled) sp.enabled(recorder(params, relevant));
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
      const place = placeOf(sp);
      if (place) place(built, { view, purpose: "display", p: recorder(params, reads), d: recorder(derived, dSeen) });
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

// Which params one sub-part depends on, for DISPLAY consumers (pick scoping,
// measure flash, runtime.controlsFor): its last real build's recorded reads
// when there are any, else the prediction, else every param. The one ladder —
// feature-level precision lands here later (spec §5).
export function subPartParamKeys(part, view, params, readsOf, name) {
  const rec = readsOf?.(name);
  if (rec) {
    // The worker records the BUILD's reads; the sub-part's own show/hide gate
    // and its place() reads in this view are added here, as the prediction rung
    // does (subPartReadKeys runs enabled() and place()).
    const out = new Set(rec);
    const sp = part.parts[name];
    if (sp?.enabled) sp.enabled(recorder(params, out));
    for (const k of placeReadKeys(part, view, params, name)) out.add(k);
    return [...out].sort();
  }
  const reads = subPartReadKeys(part, view, params);
  const keys = reads === RELEVANT_ALL ? Object.keys(params) : [...(reads.get(name) ?? Object.keys(params))];
  return keys.sort();
}

// The params one sub-part's place() reads in THIS view, derive attribution
// included. A canonical delivery (jobs.js displayWithReads) is stamped with its
// BUILD reads alone — the pose is applied as a matrix, and the pose fast path
// needs a build-only stamp — so a param read only in place() (an explode slider
// feeding views.cutaway) never reaches the recorded rung. The display side adds
// it back here, per view: a view whose place() never reads the param leaves it
// irrelevant. Runs place() on the geometry-free canonical token (no build); the
// reads count whether or not the probe trusts the pose — they were read either
// way. Never throws; an unreadable place() contributes nothing (a posed delivery
// already recorded its place reads in the stamp). `resolved` lets a caller
// walking many sub-parts run derive() once (a resolveParamsAttributed result).
export function placeReadKeys(part, view, params, name, resolved) {
  const sp = part.parts[name];
  if (!sp || !placeOf(sp)) return [];
  try {
    resolved ??= resolveParamsAttributed(part, params);
    const sink = newReadSink();
    sink.attribution = resolved.attribution;
    const rec = recordedParams(resolved, sink);
    probeSubPartPose(sp, { view, purpose: "display", p: rec.p, d: rec.d }, { scope: "place" });
    return expandReads(sink);
  } catch {
    return [];
  }
}

// Panel relevance from RECORDED reads: the union over on-screen sub-parts, each
// with its place() reads in this view (a not-yet-built one contributes its
// prediction — display only, so a wrong guess costs one build's dimming), plus
// the gate params of every in-view sub-part.
export function recordedRelevantKeys(part, view, params, readsOf) {
  try {
    const relevant = new Set();
    let predicted = null;
    let resolved = null;
    for (const name of viewSubParts(part, view, params)) {
      const rec = readsOf(name);
      if (rec) {
        for (const k of rec) relevant.add(k);
        // derive() once per call, and only if some sub-part has a pose to read.
        // A throwing derive() costs only the place reads, never the recorded ones.
        if (resolved === null && placeOf(part.parts[name])) {
          try { resolved = resolveParamsAttributed(part, params); } catch { resolved = false; }
        }
        if (resolved) for (const k of placeReadKeys(part, view, params, name, resolved)) relevant.add(k);
        continue;
      }
      predicted ??= subPartReadKeys(part, view, params);
      if (predicted === RELEVANT_ALL) return RELEVANT_ALL;
      for (const k of predicted.get(name) ?? []) relevant.add(k);
    }
    for (const name of Object.keys(part.parts)) {
      const sp = part.parts[name];
      if (inView(sp, view) && sp.enabled) sp.enabled(recorder(params, relevant));
    }
    return relevant;
  } catch {
    return RELEVANT_ALL;
  }
}
