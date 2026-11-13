// The kit as a host draws its download dialog from it, behind the mount handle's
// describeKit(): every section a kit of this forge can have, with its parts and its
// options as plain data. Read at the live params from exportableRows (export-rows.js),
// so no geometry is built.
//
// Main-thread only, like export-rows.js: mount.js imports it, the worker never does
// (test/worker-layering.test.js keeps export/* out of worker boot).
import { exportableRows } from "../../export-rows.js";
import { KIT_DEFAULTS, KIT_LIMITS } from "../formats.js";
import { isSheetPart } from "../../sheet/constants.js";
import { stockGroupLabel } from "../readme.js";
import { SECTION_LABELS, cutSectionIds, sectionOptionSchema } from "./options.js";

// { sets, sections: [{ id, label, parts: [{ name, label, default, sheet? }], options }] }.
// `3d` lists every exportable part, sheet parts off by default; each cut section lists
// the parts its process cuts, all on, and is left out when there are none. A cut
// section's options.stock carries the stock groups of its parts, `{ group, label }`, in
// part order. Which section a part belongs to comes from its DECLARED sheet process, not
// from whether its stock evaluates: a part whose material or thickness cannot be read at
// these params has no `sheet` and no stock group, but is still listed in its cut section
// (and off in 3D), so the cut section's own named error reaches the person at download.
export function describeKitRows(part, params) {
  const rows = exportableRows(part, params);
  const declared = (row) => (isSheetPart(part.parts[row.name]) ? part.parts[row.name].sheet.process : null);
  const sections = [{
    id: "3d", label: SECTION_LABELS["3d"], options: sectionOptionSchema("3d"),
    parts: rows.map((row) => ({ ...row, default: declared(row) === null })),
  }];
  for (const id of cutSectionIds()) {
    const own = rows.filter((row) => declared(row) === id);
    if (own.length === 0) continue;
    const groups = new Map();
    for (const { sheet } of own)
      if (sheet && !groups.has(sheet.group)) groups.set(sheet.group, { group: sheet.group, label: stockGroupLabel(sheet.material, sheet.thickness) });
    const options = sectionOptionSchema(id);
    options.stock.groups = [...groups.values()];
    sections.push({ id, label: SECTION_LABELS[id], options, parts: own.map((row) => ({ ...row, default: true })) });
  }
  return { sets: { range: [...KIT_LIMITS.sets], default: KIT_DEFAULTS.sets }, sections };
}
