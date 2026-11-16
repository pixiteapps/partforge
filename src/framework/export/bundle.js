// The old one-call cut & print kit, `exportParts({ format: "bundle", options })`, kept for
// one release as a wrapper: it maps the old options onto a per-section kit request,
// builds the kit (export/kit/build.js) and zips its entries.
//
// The mapping: each checked sheet part goes to its own process's cut section, with the
// layout options (stock, margin, spacing) shared; `destination: "cnc-router"` gives laser
// parts a cutting service's files (cut-only DXF, -marks.dxf, reference sheets), as the
// old single destination did; every other checked part — a sheet part whose process has
// no cut section included — goes to the 3D section in `printFormat`. A stock entry
// naming a group only the other section has is passed to that section alone.
//
// jobs.js loads this module LAZILY, on the first export-bundle job (`loadBundle`), never
// at worker boot (test/worker-layering.test.js). And nothing here may reach ./oracle/*
// (test/kit-layering.test.js mocks every oracle module to throw).
import { zipSync } from "fflate";
import { isSheetPart, sheetMeta } from "../sheet/constants.js";
import { selectExportable } from "../export-select.js";
import { validateKitOptions, KIT_OPTIONS_ERROR } from "./formats.js";
import { buildKit } from "./kit/build.js";
import { cutSectionIds } from "./kit/options.js";

// One export-bundle job's kit. `names` is the job's selected() — exportable, enabled, in
// definition order — and `posed`/`label`/`exportName` are jobs.js's own, so the kit's
// models are built exactly the way the STL and 3MF exports build them.
export async function buildBundle({ kernel, part, msg, p, d, posed, label, exportName, names, onProgress, fileBase }) {
  // Options first, before anything is built: a bad option is the user's to fix and must
  // not wait behind a build (spec D.3). An absent options object means every default.
  const o = validateKitOptions(msg.options ?? {});
  if (names.length === 0) throw new Error("no exportable parts selected");
  // A sheet part goes to its process's cut section; one whose process has no cut section
  // is a 3D part like any other (export/kit/describe.js lists it the same way).
  const cutIds = cutSectionIds();
  const isCut = (name) => isSheetPart(part.parts[name]) && cutIds.includes(part.parts[name].sheet.process);
  const sheetNames = names.filter(isCut);
  const printNames = names.filter((name) => !isCut(name));
  if (sheetNames.length === 0) {
    throw new Error(`${KIT_OPTIONS_ERROR} none of the checked parts is a sheet part — check a sheet part or export STL/3MF instead`);
  }

  const byProcess = new Map();
  for (const name of sheetNames) {
    const id = part.parts[name].sheet.process;
    byProcess.set(id, [...(byProcess.get(id) ?? []), name]);
  }
  const groupsOf = (list) => new Set(list.map((name) => sheetMeta(part.parts[name], p, d)?.group).filter(Boolean));
  const groups = new Map([...byProcess].map(([id, list]) => [id, groupsOf(list)]));
  // The entries that belong to a section: "*", its own groups, and a group no section
  // has (so the section still refuses it, as the old kit did).
  const stockFor = (id) => o.stock?.filter(({ group }) => group === "*" || groups.get(id).has(group)
    || ![...groups.values()].some((g) => g.has(group))) ?? null;
  const layout = (id) => ({ stock: stockFor(id), margin: o.margin, spacing: o.spacing });
  const optionsFor = {
    laser: (id) => ({ destination: o.destination === "own-laser" ? "own-laser" : "service", kerf: o.kerf, colors: o.colors, ...layout(id) }),
    "cnc-router": (id) => ({ ...layout(id), flip: o.flip, twoSided: o.twoSided }),
  };
  const sections = {};
  for (const [id, list] of byProcess) sections[id] = { parts: list, options: optionsFor[id]?.(id) };
  if (printNames.length) sections["3d"] = { parts: printNames, options: { format: o.printFormat } };

  const entries = await buildKit({ kernel, part, msg, p, d, posed, label, exportName, onProgress, fileBase,
    selectedFrom: (wanted) => selectExportable(part, p, wanted) }, { sections, sets: o.sets });
  onProgress("zipping kit");
  return { data: zipSync(Object.fromEntries(entries.map((e) => [e.path, e.data])), { level: 6 }), filename: `${fileBase}-kit.zip` };
}
