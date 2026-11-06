// Chooses which geometry backend (manifold vs occt) a part should build against.
// This is framework-level policy, not geometry-kernel plumbing: it knows the full
// PartDefinition shape (meta.backend, defaults, parts[name].build), unlike
// everything in geometry/, which is part-agnostic.
import { createProbeKernel } from "./geometry/probe.js";
import { isZeroMagnitudeCadOp } from "./geometry/op-options.js";
import { byteAwareReplacer } from "./geometry/solid-hash.js";
import { resolveDerived } from "./derive.js";
import { exportablePartNames } from "./export-select.js";
import { exportSubParts } from "./part-model.js";

/**
 * Per-sub-part routing: probe each sub-part's build independently and map it to
 * its own backend, so a mixed part previews its plain sub-parts on fast Manifold
 * while only the CAD-op ones pay for OCCT. Sub-parts build independently by
 * construction (buildPosed builds one at a time), which is what makes splitting
 * them across the two workers sound.
 */
export function detectBackends(part, params = {}) {
  const forced = part.meta?.backend;
  const p = { ...part.defaults, ...params };
  let d = {};
  // A throwing derive must not escape here — this runs on the main thread mid
  // regen (after the busy spinner goes up). Probe with an empty `d`; the worker
  // build hits the same throw and posts a proper error for the UI.
  try { d = resolveDerived(part, p); } catch { /* fall through with d = {} */ }
  const backends = {};
  for (const name of Object.keys(part.parts)) {
    if (forced) { backends[name] = forced; continue; }
    const { kernel, cadCalls } = createProbeKernel();
    try { part.parts[name].build(kernel, p, d); } catch { /* probe miss → capability backstop covers it */ }
    // cadCalls currently holds only Solid.shell calls. Solid fillet/chamfer start
    // on Manifold and use the runtime capability backstop below only when the mesh
    // backend cannot blend the selected edge class; Shape2D variants are shared JS.
    backends[name] = cadCalls.some(({ op, args }) => !isZeroMagnitudeCadOp(op, args))
      ? "occt"
      : "manifold";
  }
  return backends;
}

/**
 * The organic sub-parts of an export: those whose build calls k.implicit, among the
 * sub-parts the export writes (`parts`, else the view's — as jobs.js selects them). A
 * STEP export meshes these on Manifold and writes them as tessellated solids, since OCCT
 * cannot build k.implicit. A sub-part that also calls `shell` cannot build on either
 * backend, so it throws, naming it. `meta.backend` does not change the answer: a STEP
 * export splits by sub-part whatever the pin says.
 */
export function organicExportParts(part, { view, params = {}, parts } = {}) {
  const p = { ...part.defaults, ...params };
  let d = {};
  try { d = resolveDerived(part, p); } catch { /* the export's own build reports a throwing derive */ }
  const names = parts
    ? exportablePartNames(part, p).filter((name) => parts.includes(name))
    : exportSubParts(part, view, p);
  return names.filter((name) => {
    const { kernel, used, cadCalls } = createProbeKernel();
    try { part.parts[name].build(kernel, p, d); } catch { /* a probe miss: the OCCT build names it */ }
    if (!used.has("implicit")) return false;
    if (cadCalls.some(({ op, args }) => !isZeroMagnitudeCadOp(op, args))) {
      throw new Error(`sub-part "${name}" calls k.implicit and shell, which no backend can build together — for a hollow organic body use an onion node inside the k.implicit spec instead of shell`);
    }
    return true;
  });
}

// Whole-part detection: the max over detectBackends. This is the routing for
// anything that must build every sub-part in ONE worker — exports (a single
// STL/STEP/3MF job) and the single-process CLI, which can't mix kernels at all.
export function detectBackend(part, params = {}) {
  return Object.values(detectBackends(part, params)).includes("occt") ? "occt" : "manifold";
}

// The mount-time backend chooser. detectBackends() re-runs per regen with live
// params, so backend choice already follows the parameters in both directions —
// this wrapper exists for the runtime backstop: when the probe under-detects
// (a CAD-only call it can't reach — e.g. gated on a real geometry query the
// probe answers with dummies) the Manifold build throws NEEDS_OCCT and the
// worker asks for a reroute. That must not pin OCCT for the rest of the session,
// or turning the unsupported feature off never reverts to Manifold. Instead the
// reroute is latched per (sub-part, params snapshot): the exact combination that
// failed skips the doomed Manifold retry, and ANY param change re-consults the
// probe. A part the probe chronically under-detects costs one cheap failed
// Manifold dispatch per param change — the price of automatic reversion.
export function createBackendPolicy(part, { forced = null } = {}) {
  let latchedParams = null;  // JSON snapshot of the params proven at runtime to need OCCT
  let latchedNames = null;   // the sub-parts that proved it (null = all of them)
  // byteAwareReplacer: an image param carried as raw bytes must fingerprint by
  // content here too, or a swapped image either silently reuses a stale OCCT
  // latch (ArrayBuffer → the same "{}" for any image) or the reroute check
  // spends its time re-stringifying megabytes of typed-array bytes every regen.
  const latched = (params, name) =>
    latchedParams !== null && latchedParams === JSON.stringify(params, byteAwareReplacer) &&
    (latchedNames === null || latchedNames.has(name));
  return {
    // name → backend for a preview generate; mount groups sub-parts by this.
    backendsFor(params) {
      const backends = detectBackends(part, params);
      for (const name of Object.keys(backends)) {
        if (forced) backends[name] = forced;
        else if (latched(params, name)) backends[name] = "occt";
      }
      return backends;
    },
    // Whole-part max, for jobs that need one worker (exports).
    backendFor(params) {
      if (forced) return forced;
      return Object.values(this.backendsFor(params)).includes("occt") ? "occt" : "manifold";
    },
    // `subparts` names the failed job's sub-parts; omitted (an export job, which
    // doesn't carry them) it latches the whole part for these params.
    noteNeedsOcct(params, subparts) {
      latchedParams = JSON.stringify(params, byteAwareReplacer);
      latchedNames = subparts ? new Set(subparts) : null;
    },
  };
}
