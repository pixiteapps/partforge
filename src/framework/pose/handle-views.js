// Which views a handle shows in. One rule for Pose mode (mount's syncPoseVisible), the
// oracle's `handles` report and lint's handle-crowded, so what an agent reads is what the
// viewer draws.
//
// A handle that declares `views` (keys of part.views) shows in exactly those. Otherwise
// the AUTOMATIC rule, three tests that must all pass:
//   1. relevance — some parameter the handle writes is relevant in the view (the panel's
//      dimming; unknown relevance passes);
//   2. its SOURCE is drawn — the derived values its point comes from (`on`, or the `d`
//      keys a `point` function reads) are read by a sub-part shown in the view, in its
//      build or its placement there. Applied only when SOME view's sub-parts read that
//      source: a source no view draws tells nothing about where the handle belongs, so
//      relevance alone decides then (a limb used only to compute other values);
//   3. `showOn` — when it names only known sub-parts, at least one is in the view.
// Relevance alone was the old rule, and it is too generous: a print layout that reads any
// derived value attributes that read to every derive input when derive is one function,
// so every pose parameter turned "relevant" and the handles showed in the print view at
// the assembly pose, floating in air. Test 2 asks the question that matters — does this
// view draw the thing the handle sits on.
//
// Pure: no DOM, no three.js, no node: (the oracle runs it in the worker). Source reads come
// from a geometry-free probe build (geometry/probe.js), never the kernel.
import { recorder } from "../read-recorder.js";
import { resolveDerived } from "../derive.js";
import { createProbeKernel } from "../geometry/probe.js";
import { inView, placeOf } from "../sub-part-views.js";
import { viewSubParts } from "../part-model.js";
import { relevantParamKeys, RELEVANT_ALL } from "../param-deps.js";
import { handleKind, handleParamKeys } from "./handle-source.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/** A handle's declared views (a string or a list of them), or null when it declares none. */
export function declaredViews(handle) {
  const v = handle?.views;
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;
}

/**
 * The derived keys (`d.<key>`) the sub-parts shown in `view` read, in their build or their
 * placement there, from a geometry-free probe: a Set, or null when the probe cannot tell
 * (derive throws, or every sub-part's probe does). A sub-part whose probe throws keeps the
 * reads it made before the throw, and the others still count: one unprobeable sub-part
 * must not blind the view (it would show every handle there again). `d` may be passed in
 * when the caller already resolved it.
 */
export function viewSourceReads(part, view, params = {}, d = undefined) {
  let p, derived, kernel, names;
  try {
    p = { ...part.defaults, ...params };
    derived = d ?? resolveDerived(part, p);
    ({ kernel } = createProbeKernel());
    names = viewSubParts(part, view, p);
  } catch {
    return null;
  }
  const seen = new Set();
  let failed = 0;
  for (const name of names) {
    try {
      const sp = part.parts[name];
      const built = sp.build(kernel, recorder(p, new Set()), recorder(derived, seen));
      const place = placeOf(sp);
      if (place) place(built, { view, purpose: "display", p: recorder(p, new Set()), d: recorder(derived, seen) });
    } catch {
      failed++;
    }
  }
  return names.length && failed === names.length ? null : seen;
}

/** The derived keys a handle's point comes from: `[on]`, or what a `point` function reads of `d`. */
export function handleSourceKeys(handle, p, d) {
  const kind = handleKind(handle);
  if (kind === "limb" || kind === "on") return typeof handle.on === "string" ? [handle.on] : [];
  if (kind !== "point" || typeof handle.point !== "function" || !isPlainObject(d)) return [];
  const seen = new Set();
  try { handle.point(p, recorder(d, seen)); } catch { /* the keys read before the throw still count */ }
  return [...seen];
}

/**
 * The ids of the handles `view` shows, in declaration order.
 * @param opts.relevant the view's relevant param keys (mount passes its recorded ones;
 *   default: the predicted relevantParamKeys). RELEVANT_ALL / anything not a Set: unknown.
 * @param opts.sourceReads `(view) => Set | null`, the derived keys a view's sub-parts read
 *   (mount passes a cached one; default: viewSourceReads at these params).
 */
export function handlesShownInView(part, view, params = {}, { relevant, sourceReads } = {}) {
  const handles = part?.handles;
  if (!isPlainObject(handles)) return [];
  const ids = Object.keys(handles).filter((id) => isPlainObject(handles[id]));
  const auto = ids.filter((id) => !declaredViews(handles[id]));
  if (!auto.length) return ids.filter((id) => declaredViews(handles[id]).includes(view));
  const p = { ...part?.defaults, ...params };
  if (relevant === undefined) {
    try { relevant = relevantParamKeys(part, view, p); } catch { relevant = RELEVANT_ALL; }
  }
  // derive runs only if something needs it (a `point` handle, the default source probe)
  let d;
  const derived = () => {
    if (d === undefined) { try { d = resolveDerived(part, p); } catch { d = null; } }
    return d;
  };
  const readsOf = sourceReads ?? ((v) => (derived() ? viewSourceReads(part, v, p, derived()) : null));
  const views = isPlainObject(part.views) ? Object.keys(part.views) : [view];
  const allReads = new Map(); // view -> its source reads (each probed at most once)
  const readsIn = (v) => {
    if (!allReads.has(v)) allReads.set(v, readsOf(v));
    return allReads.get(v);
  };
  const drawnAnywhere = (keys) => views.some((v) => {
    const r = readsIn(v);
    return r instanceof Set && keys.some((k) => r.has(k));
  });
  return ids.filter((id) => {
    const h = handles[id];
    const declared = declaredViews(h);
    if (declared) return declared.includes(view);
    if (relevant instanceof Set && !handleParamKeys(h).some((k) => relevant.has(k))) return false;
    const showOn = [h.showOn].flat().filter((n) => n != null);
    if (showOn.length && showOn.every((n) => typeof n === "string" && isPlainObject(part.parts?.[n]))
      && !showOn.some((n) => inView(part.parts[n], view))) return false;
    const keys = handleSourceKeys(h, p, handleKind(h) === "point" ? derived() : null);
    if (!keys.length) return true;
    const here = readsIn(view);
    if (!(here instanceof Set) || keys.some((k) => here.has(k))) return true;
    return !drawnAnywhere(keys);
  });
}
