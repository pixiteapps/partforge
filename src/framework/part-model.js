// The pure part model: which sub-parts a view shows, which of those are exportable,
// how a part's params resolve, and how one posed sub-part solid is built. No async,
// no worker protocol, no kernel boot — just synchronous functions over a
// PartDefinition, a kernel handle, and params.
//
// Deliberately a LEAF of the framework graph. buildPosed is the single definition of
// "a posed sub-part solid", so the worker job loop (jobs.js), the collision check
// (assembly.js), the relevance probe (param-deps.js), and the headless oracle
// (oracle/) all call it. Keeping those four functions out of jobs.js — which is
// async, imports the kernels, and pulls in the whole export stack — is what lets the
// oracle depend on the part model without an import cycle back through the job loop.
import { resolveDerived, resolveDerivedAttributed } from "./derive.js";
import { recorder } from "./read-recorder.js";
import { inView, placeOf } from "./sub-part-views.js";

// Names of the sub-parts a view shows: declared in the view and enabled for these
// params. Order follows Object.keys(part.parts) (definition order).
export function viewSubParts(part, view, params) {
  return Object.keys(part.parts).filter((name) => {
    const sp = part.parts[name];
    const on = sp.enabled ? !!sp.enabled(params) : true;
    return inView(sp, view) && on;
  });
}

// Sub-parts to include in an EXPORT of this view: the visible sub-parts, minus any
// flagged `exportable: false` (reference/preview-only parts — motor ghosts, bearing
// placeholders, etc.). They still show in the viewer; they're just never written to
// an STL/STEP/3MF file, so the user never has to toggle them off before exporting.
export function exportSubParts(part, view, params) {
  return viewSubParts(part, view, params).filter((name) => part.parts[name].exportable !== false);
}

// Resolve a part's effective params + derived values for a build: the user's params
// layered over the part defaults, and derive() run once over the result.
//
// `sanitize(p)` is an optional hook that may rewrite the layered params IN PLACE —
// the seam a caller uses to refuse an untrusted value before it means anything.
// It runs BEFORE resolveDerived deliberately: derive() must see exactly the params
// build() will see, or a refused value still reaches the geometry through `d`.
// A hook rather than a second copy of this function in the caller, so "resolve a
// part's params" keeps one definition.
// resolveParams plus derive attribution, plain objects. `p` is passed to derive
// itself (through), so a derive that writes p behaves exactly as unrecorded.
export function resolveParamsAttributed(part, params, sanitize) {
  const p = { ...part.defaults, ...params };
  sanitize?.(p);
  const { d, depsOf, allInputs } = resolveDerivedAttributed(part, p, { through: true });
  return { p, d, attribution: { depsOf, allInputs } };
}

// Record-through views of a resolved (p, d) into one read sink. Everything that
// reads them — viewSubParts' enabled(), build(), place(), expect(p, d) — lands in
// the sink with no change to the reader.
export function recordedParams({ p, d }, sink) {
  return { p: recorder(p, sink.raw, { through: true }), d: recorder(d, sink.dSeen, { through: true }) };
}

// `reads` (optional): a newReadSink() (read-recorder.js). When given, the returned
// p/d record every key read into it, and the sink keeps the derive attribution
// expandReads needs. The single seam the oracle threads its sink through.
export function resolveParams(part, params, sanitize, reads) {
  if (!reads) {
    const p = { ...part.defaults, ...params };
    sanitize?.(p);
    return { p, d: resolveDerived(part, p) };
  }
  const resolved = resolveParamsAttributed(part, params, sanitize);
  reads.attribution ??= resolved.attribution;
  return recordedParams(resolved, reads);
}

// Build one sub-part and apply its placement (sub-part-views.js placeOf — a legacy place() or the compiled views map) for the given purpose/view.
// `p`/`d` come from resolveParams(). This is the SINGLE definition of "a posed
// sub-part solid" — the worker, the collision check, and the test harness all call
// it, so display/export poses can never drift between the app and its tests.
export function buildPosed(kernel, part, name, { purpose, view, p, d, onProgress } = {}) {
  const sp = part.parts[name];
  const solid = sp.build(kernel, p, d, onProgress);
  const place = placeOf(sp);
  return place ? place(solid, { view, purpose, p, d }) : solid;
}
