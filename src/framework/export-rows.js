// The two lists an embedder's export UI is drawn from — the exportable sub-parts and
// the formats — behind the mount handle's listExportableParts()/listExportFormats().
//
// Main-thread only: mount.js imports it. Deliberately NOT part of export-select.js,
// which jobs.js imports at worker boot — export/formats.js must stay out of the
// worker's eager closure (test/worker-layering.test.js).
import { exportablePartNames, partLabel } from "./export-select.js";
import { resolveDerived } from "./derive.js";
import { sheetMeta } from "./sheet/constants.js";
import { EXPORT_FORMATS } from "./export/formats.js";

// A row for every exportable, enabled sub-part, in definition order. A sheet part's row
// adds `sheet: { process, material, thickness, group }`, evaluated here at the live
// params the way enabled() already is, so a host can tag it ("Sheet · …") and name its
// stock group before asking for a kit. The key is OMITTED, never null, when it cannot
// be evaluated — not a sheet, a material or thickness that throws, or a derive() that
// throws (nothing about any part's stock is trustworthy then). The kit recomputes its
// groups in the worker regardless, so a missing tag costs a label, never a wrong file.
export function exportableRows(part, params) {
  const p = { ...part.defaults, ...params };
  let d = null;
  let derived = true;
  try { d = resolveDerived(part, p); } catch { derived = false; }
  return exportablePartNames(part, params).map((name) => {
    const row = { name, label: partLabel(part, name) };
    const s = derived ? sheetMeta(part.parts[name], p, d) : null;
    if (s) row.sheet = { process: s.process, material: s.material, thickness: s.thickness, group: s.group };
    return row;
  });
}

// What exportParts can write in this version, as fresh copies — a host that annotates
// or sorts its list can never edit the table every later call reads.
export const exportFormatList = () => EXPORT_FORMATS.map((f) => ({ ...f }));
