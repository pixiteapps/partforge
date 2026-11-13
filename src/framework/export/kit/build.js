// The kit as a list of entries, built section by section (design 2026-11-13 "Sections"):
// every requested section's options and parts are checked first, then each section
// builds and returns its entries, and README.txt and parts.csv are written last, from
// what the sections returned. A host zips the list (or saves its one model bare).
//
// `ctx` is what a kit job holds: { kernel, part, msg, p, d, posed, label, exportName,
// onProgress, fileBase, selectedFrom(names) → names } — selectedFrom keeps the names
// that are exportable and enabled, in definition order (export-select.js
// selectExportable). `request` is { sections: { [id]: { parts: string[], options } },
// sets }; a section left out is not built.
import { strToU8 } from "fflate";
import { KIT_OPTIONS_ERROR, isPlainObject } from "../formats.js";
import { renderReadme, renderPartsCsv, cleanLabel } from "../readme.js";
import { sheetGroup } from "../../sheet/constants.js";
import { makeEntry, assertEntries } from "./entries.js";
import { SECTION_LABELS, cutSectionIds, validateSectionOptions, validateSets } from "./options.js";
import { prepareCutSection, buildCutSection } from "./cut-section.js";
import { prepareModelSection, buildModelSection } from "./model-section.js";
import { collectControls, isClearance } from "./controls.js";

const fail = (message) => new Error(`${KIT_OPTIONS_ERROR} ${message}`);

// An options error raised inside a section names that section — `cut kit options:
// <Section label>: <rest>` — so a host can send the person back to its settings. The
// writers below the kit (resolveStock, layout.js, the cut section's own checks) do not
// know which section they serve, so the label is put in here, once: the error keeps its
// object and every other word, and one that already names its section is left alone.
// Errors about sets or the request as a whole are raised outside every section and keep
// the bare prefix; any other error passes through untouched.
function nameSection(id, err) {
  const label = SECTION_LABELS[id];
  const head = `${KIT_OPTIONS_ERROR} `;
  if (!label || !(err instanceof Error) || !err.message.startsWith(head)) return err;
  const rest = err.message.slice(head.length);
  if (!rest.startsWith(`${label}:`)) err.message = `${head}${label}: ${rest}`;
  return err;
}
function inSection(id, run) {
  try {
    const out = run();
    return out instanceof Promise ? out.catch((err) => { throw nameSection(id, err); }) : out;
  } catch (err) {
    throw nameSection(id, err);
  }
}

// The request's sections in build order — cut sections first, in the process registry's
// order, then 3D — each with its options checked and its part list read. An unknown
// section id is refused by validateSectionOptions.
function readSections(request) {
  if (!isPlainObject(request) || !isPlainObject(request.sections)) throw fail("the kit request needs a sections object");
  const read = new Map();
  for (const [id, section] of Object.entries(request.sections)) {
    const options = inSection(id, () => validateSectionOptions(id, isPlainObject(section) ? section.options : undefined));
    if (!isPlainObject(section) || !Array.isArray(section.parts) || !section.parts.every((n) => typeof n === "string"))
      throw fail(`${SECTION_LABELS[id]}: parts must be a list of part names`);
    read.set(id, { id, parts: section.parts, options });
  }
  if (read.size === 0) throw fail("no exportable parts selected");
  return [...cutSectionIds(), "3d"].filter((id) => read.has(id)).map((id) => read.get(id));
}

// Two cut sections on the same material and thickness assume the same stock: say so once.
function onePerStock(notes) {
  const seen = new Set();
  return notes.filter((n) => {
    const key = sheetGroup(n.material, n.thickness);
    return !seen.has(key) && seen.add(key);
  });
}

export async function buildKit(ctx, request) {
  // Everything that needs no drawing is checked before anything is built: every
  // section's options, sets, each section's parts, piece counts and stock.
  const sections = readSections(request);
  const sets = validateSets(request.sets);
  const plans = sections.map(({ id, parts, options }) => inSection(id, () => {
    const names = ctx.selectedFrom(parts);
    return id === "3d"
      ? { id, plan: prepareModelSection(names, options) }
      : { id, plan: prepareCutSection(ctx, id, names, options, sets) };
  }));

  const { part, p } = ctx;
  const controls = collectControls(part.parameters);
  const anyCut = plans.some((s) => s.id !== "3d");
  const cut = [];
  let model = null;
  for (const { id, plan } of plans) {
    if (id === "3d") model = await inSection(id, () => buildModelSection(ctx, plan, { quantity: anyCut ? sets : 1 }));
    else cut.push(await inSection(id, () => buildCutSection({ ...ctx, controls }, plan)));
  }

  const readme = renderReadme({
    title: cleanLabel(part.meta?.title ?? ctx.fileBase),
    cut: cut.map((c) => c.cut),
    flip: cut.find((c) => c.flip)?.flip,
    stockNotes: onePerStock(cut.flatMap((c) => c.stockNotes)),
    sheets: cut.flatMap((c) => c.sheets),
    pieces: cut.flatMap((c) => c.pieces),
    router: cut.flatMap((c) => c.router),
    layers: cut.flatMap((c) => c.layers),
    printed: model?.printed ?? [],
    clearances: controls.filter(isClearance).map((c) => ({ label: c.label ?? c.key, value: p[c.key], unit: c.unit ?? "" })),
    settings: Object.keys(p).map((key) => ({ key, value: p[key] })),
    checks: cut.flatMap((c) => c.checks),
    oversized: cut.flatMap((c) => c.oversized),
    renamed: [...cut.flatMap((c) => c.renamed), ...(model?.renamed ?? [])],
  });
  const csv = renderPartsCsv([...cut.flatMap((c) => c.rows), ...(model?.rows ?? [])]);

  const entries = [...cut.flatMap((c) => c.entries), ...(model?.entries ?? []),
    makeEntry("README.txt", "text", strToU8(readme)), makeEntry("parts.csv", "table", strToU8(csv))];
  assertEntries(entries);
  return entries;
}
