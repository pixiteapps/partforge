// The ctx buildKit receives, built the way jobs.js builds it for a job: params resolved
// from the part's defaults, sub-parts posed for export, labels and export names off the
// part, and selectedFrom filtering to exportable, enabled parts in definition order.
import { resolveParams, buildPosed } from "../../src/framework/part-model.js";
import { selectExportable } from "../../src/framework/export-select.js";
import { safeName } from "../../src/framework/safe-name.js";

export function kitCtx(kernel, part, { view = "all", params = {}, name = part.meta?.title, quality = "preview", phases = [] } = {}) {
  const { p, d } = resolveParams(part, params);
  return {
    kernel, part, msg: { view, quality }, p, d,
    posed: (n, purpose, prog) => buildPosed(kernel, part, n, { purpose, view, p, d, onProgress: prog }),
    label: (n) => part.parts[n].label ?? n,
    exportName: (n) => part.parts[n].export?.name ?? n,
    onProgress: (phase) => phases.push(phase),
    fileBase: safeName(name ?? view),
    selectedFrom: (names) => selectExportable(part, p, names),
  };
}
