// A cut section of the kit: the checked sheet parts of ONE process (`laser`,
// `cnc-router`) drawn flat from their 2-D declaration, merged where identical, laid out
// on the user's stock, and written as drawings under the section's folder. This is what
// the old one-ZIP kit (export/bundle.js) did for every sheet part at once; run per
// section, a laser part and a routed part never share a layout or a destination.
//
// Two steps, so a kit checks every section before it builds any: prepareCutSection
// (options, parts, piece count, stock groups — no drawing) and buildCutSection.
//
// Nothing here may reach ./oracle/* (test/kit-layering.test.js): a sheet is drawn from
// its 2-D declaration and checked by its own process's facts()/checks().
import { strToU8 } from "fflate";
import { h } from "../../geometry/solid-hash.js";
import { fmtMm, SHEET_CHECK_BUDGET_MS, SHEET_CHECKS_NOTICE, SHEET_READ_ERROR_HINT, isSheetPart, sheetMeta } from "../../sheet/constants.js";
import { resolveSheet } from "../../sheet/resolve.js";
import { processById, SHEET_METRICS } from "../../process/registry.js";
import { loadExporter } from "../../process/exporters.js";
import { DESTINATIONS, KIT_OPTIONS_ERROR, KIT_LIMITS, resolveStock } from "../formats.js";
import { canonicalDrawingKey, routedPalette, splitFaces } from "../drawing.js";
import { renderSvg } from "../svg.js";
import { renderDxf } from "../dxf.js";
import { layoutGroup, marginFitsStock } from "../layout.js";
import { cleanLabel } from "../readme.js";
import { makeEntry } from "./entries.js";
import { SECTION_FOLDERS, SECTION_LABELS, SECTION_NOUNS } from "./options.js";
import { kitName, namer, dedupe, clipPhase } from "./names.js";
import { thicknessControlLabel } from "./controls.js";

// verify's wording for the three expression forms a process's checks() emits — ">=N",
// "<=N" and a bare number (equality) — restated from oracle/assert-dsl.js, because the
// kit must never load ./oracle/*. test/kit-bundle-helpers.test.js holds the two equal.
// Any other form throws: it needs a line here, not a silent pass.
const EPS = 1e-6;
export function checkMessage(expr, actual) {
  const m = /^(>=|<=)?\s*([-+]?[0-9]*\.?[0-9]+)$/.exec(String(expr).trim());
  if (!m) throw new Error(`cut kit: unsupported sheet check "${expr}"`);
  const value = Number(m[2]);
  if (m[1] === ">=") {
    const pass = actual >= value - EPS;
    return { pass, message: `${actual} ${pass ? ">=" : "not >="} ${value}` };
  }
  if (m[1] === "<=") {
    const pass = actual <= value + EPS;
    return { pass, message: `${actual} ${pass ? "<=" : "not <="} ${value}` };
  }
  const pass = Math.abs(actual - value) <= EPS + EPS * Math.abs(value);
  return { pass, message: `${actual} ${pass ? "==" : "!="} ${value}` };
}

// SHEET_CHECKS_NOTICE.message ("2-D sheet checks not evaluated (time budget)") is
// oracle/verify.js's own wording for the same state, imported from sheet/constants.js —
// the one place it lives, since the kit must never load ./oracle/*. The kit appends its
// own reason to the shared prefix rather than restating the whole line.
const NOT_EVALUATED = `${SHEET_CHECKS_NOTICE.message} — the kit ran out of time checking this piece for narrow webs, narrow gaps and stray marks; look it over before cutting`;

// The README's CHECKS lines for one piece: every volunteered check its process runs
// that fails, as `${label}: ${message} — ${hint}` with the metric's own hint. A metric
// with no reading (budget-gated and not evaluated, or a custom build's volume match,
// which needs a solid the kit never builds) is skipped; an unevaluated piece gets one
// line saying so instead. A metric the geometry engine refused to read (readErrors) gets
// its own line, worded like verify's: `not measured — <reason>`, with SHEET_READ_ERROR_HINT
// (sheet/constants.js, imported above — the kit must never load ./oracle/* itself, so it
// reads the one shared text rather than a copy) — never the metric's own hint, which
// describes a value that was never taken.
export function sheetWarnings(label, facts) {
  const desc = facts ? processById(facts.process) : null;
  if (!desc) return [];
  const out = [];
  for (const [metric, expr] of Object.entries(desc.checks(facts))) {
    const reg = SHEET_METRICS[metric];
    const actual = reg?.extract({ sheet: facts });
    if (actual === null || actual === undefined) {
      const why = reg?.readError?.({ sheet: facts });
      if (why) out.push(`${label}: not measured — ${why} — ${SHEET_READ_ERROR_HINT}`);
      continue;
    }
    const { pass, message } = checkMessage(expr, actual);
    if (!pass) out.push(`${label}: ${message} — ${reg.hint}`);
  }
  if (facts.evaluated === false) out.push(`${label}: ${NOT_EVALUATED}`);
  return out;
}

const sizeOf = (b) => [b.max[0] - b.min[0], b.max[1] - b.min[1]];

// A sheet part's stock group, or the part's own named error: sheetMeta answers null
// when material or thickness cannot be evaluated, and resolveSheet is what knows how to
// say why.
function sheetMetaOrThrow(kernel, sp, p, d, name) {
  const meta = sheetMeta(sp, p, d);
  if (meta) return meta;
  resolveSheet(kernel, sp, p, d);
  throw new Error(`sheet part "${name}": its material or thickness could not be evaluated`);
}

// The README's layer legend: every routed layer name in the section, once, with its face,
// colour (ACI in a DXF kit, hex in an SVG one) and depth — REFERENCE, SECONDARY, then
// drills in palette order, then pockets shallowest first; the far face's layers follow
// in the same order. The palette is section-wide, so a name has one colour; the legend
// is the authority when a palette cycles. It reads each piece's whole drawing, so the
// far file's alignment outline (splitFaces' `far-outline`) is never listed.
const LEGEND_RANK = { reference: 0, secondary: 1, drill: 2, pocket: 3, "far-secondary": 4, "far-drill": 5, "far-pocket": 6 };
const legendKind = (l) => {
  const m = /^(far-)?(drill|pocket)-/.exec(l.id);
  return m ? `${m[1] ?? ""}${m[2]}` : l.id;
};
function routedLegend(pieces, cutExt) {
  const rows = new Map();
  for (const pc of pieces) {
    for (const l of pc.drawing.layers) {
      if (l.name === undefined || rows.has(l.name)) continue;
      const kind = legendKind(l);
      rows.set(l.name, { name: l.name, kind, face: l.face === "far" ? "far" : "near", order: rows.size,
        colour: cutExt === "svg" ? l.svgColor : String(l.color),
        depth: l.through ? "through" : typeof l.depth === "number" ? `${l.depth.toFixed(2)} mm` : "—", mm: l.depth ?? 0 });
    }
  }
  return [...rows.values()]
    .sort((a, b) => (LEGEND_RANK[a.kind] ?? 9) - (LEGEND_RANK[b.kind] ?? 9)
      || (a.kind.endsWith("pocket") ? a.mm - b.mm : 0) || a.order - b.order)
    .map(({ name, face, colour, depth }) => ({ name, face, colour, depth }));
}

// Everything that can be checked without drawing a piece. `names` is ctx.selectedFrom()
// of the section's parts; a name whose sheet process is not this section's is dropped.
// `options` are validateSectionOptions(id)'s, `sets` validateSets'.
export function prepareCutSection(ctx, id, names, options, sets) {
  const { kernel, part, p, d, label } = ctx;
  const nameOf = (name) => cleanLabel(label(name));
  const sheetNames = names.filter((name) => isSheetPart(part.parts[name]) && part.parts[name].sheet.process === id);
  if (sheetNames.length === 0) throw new Error(`${KIT_OPTIONS_ERROR} none of the checked parts is a ${SECTION_NOUNS[id]} part`);
  // The cut-piece count is sheet sub-parts × sets — exactly what the merged pieces sum
  // to — so it is checked before the builds it would otherwise waste. The remedy named
  // is one that can work: past the cap at a single set, only fewer parts will do.
  const cutCount = sheetNames.length * sets;
  if (cutCount > KIT_LIMITS.pieces) {
    const remedy = sheetNames.length > KIT_LIMITS.pieces ? "check fewer sheet parts" : "lower sets";
    throw new Error(`${KIT_OPTIONS_ERROR} the kit has ${cutCount} pieces — at most ${KIT_LIMITS.pieces}; ${remedy}`);
  }

  // Stock groups from each part's material and thickness alone, so a stock entry that
  // names no group in the section fails before any drawing is made.
  const groups = new Map();
  const groupOf = new Map();
  for (const name of sheetNames) {
    const meta = sheetMetaOrThrow(kernel, part.parts[name], p, d, nameOf(name));
    if (!groups.has(meta.group)) {
      const material = cleanLabel(meta.material);
      groups.set(meta.group, { group: meta.group, material, thickness: meta.thickness,
        label: `${material} ${fmtMm(meta.thickness)} mm`, first: name });
    }
    groupOf.set(name, meta.group);
  }
  const stockFor = resolveStock(options.stock, [...groups.values()].map((g) => ({ group: g.group, label: g.label })));
  // A margin that leaves a group's stock with no inside at all is known right here —
  // check it before any piece is drawn (spec D.3), not only once layoutGroup reaches
  // that group after every sheet part has been built.
  for (const g of groups.values()) marginFitsStock(stockFor.get(g.group), options.margin, g.label);
  return { id, o: options, sets, sheetNames, groups, groupOf, stockFor };
}

// Draw, merge, name and lay out the section's pieces, and write them. Returns the
// section's entries plus everything the README and parts list say about it.
export async function buildCutSection(ctx, plan) {
  const { kernel, part, p, d, label, exportName, controls = [] } = ctx;
  const { id, o, sets, sheetNames, groups, groupOf, stockFor } = plan;
  const folder = SECTION_FOLDERS[id];
  const router = id === "cnc-router";
  const destination = router ? "cnc-router" : o.destination;
  const service = destination === "service";
  const cutExt = DESTINATIONS[destination];                 // svg for own-laser, dxf otherwise
  const say = (phase) => ctx.onProgress(clipPhase(phase));
  const nameOf = (name) => cleanLabel(label(name));

  // Draw every sheet part flat, from its 2-D declaration, with its 2-D facts under ONE
  // budget for the whole section.
  // Resolved first, drawn second: a routed layer's colour comes from a palette over
  // EVERY routed piece's depths (drawing.js routedPalette), so one depth is one colour
  // in every file of the section and on every sheet.
  const deadline = Date.now() + SHEET_CHECK_BUDGET_MS;
  const resolved = [];
  for (const name of sheetNames) {
    say(`building ${nameOf(name)}`);
    const s = resolveSheet(kernel, part.parts[name], p, d);
    const desc = processById(s.process);
    if (!desc) throw new Error(`sheet part "${nameOf(name)}": unknown process "${s.process}"`);
    resolved.push({ name, s, facts: desc.facts(s, { deadline }) });
  }
  const palette = routedPalette(resolved.filter((x) => x.s.process === "cnc-router").map((x) => x.s));
  const exporter = await loadExporter(id);
  const drawn = resolved.map(({ name, s, facts }) => ({
    name, label: nameOf(name), fileKey: exportName(name), group: groupOf.get(name), facts, routed: router,
    drawing: exporter.drawing(s, o, kernel, { label: nameOf(name), facts, palette }),
  })).map((x) => ({ ...x, key: canonicalDrawingKey(x.drawing) }));

  // Identical pieces become one file ×N (spec D.4): the hash nominates; the canonical
  // drawing and the stock group confirm.
  // A routed piece's operations table is confirmed too: an extra op's depth and method,
  // and the op labels, are not in its drawing — only the README carries them, so two
  // pieces that draw alike but machine differently must stay two files.
  const sameOps = (a, b) => JSON.stringify(a.facts?.routed ?? null) === JSON.stringify(b.facts?.routed ?? null);
  // A routed piece with far-face work is two-sided: its sheets carry the near face only
  // (`faces.near`), and the two-files mode writes its far face to a file of its own.
  const pieces = dedupe(drawn, (x) => h(x.key), (a, b) => a.key === b.key && a.group === b.group && sameOps(a, b))
    .map(({ item, members }) => {
      const faces = splitFaces(item.drawing);
      return { ...item, labels: members.map((m) => m.label), qty: members.length * sets, faces, twoSided: faces.far !== null,
        hasMarks: item.drawing.layers.some((l) => l.id === "score" || l.id === "engrave") };
    });

  // Names, in definition order. A name that was taken moves to name-2; the README's
  // RENAMED FILES says which file it was and who held the name (spec D.10). A piece
  // claims its bare name as well as its files (the `parts/<name>/` key, which no file
  // path can equal): `-x<n>` is a QUANTITY, so a second, different piece with the
  // same name must be name-2 — never name.svg beside name-x2.svg, which reads as one
  // piece at two quantities.
  const { claim, renamed } = namer();
  const dir = `${folder}/parts`;
  for (const pc of pieces) {
    const sx = pc.qty > 1 ? `-x${pc.qty}` : "";
    // A routed piece is never split: its depths are one layered file for the CAM.
    const marks = service && pc.hasMarks && !pc.routed;
    const far = pc.twoSided && o.twoSided === "two-files";
    const name = claim(kitName(pc.fileKey), (n) => [`${dir}/${n}${sx}.${cutExt}`, ...(marks ? [`${dir}/${n}${sx}-marks.dxf`] : []),
      ...(far ? [`${dir}/${n}${sx}-far.${cutExt}`] : []), `${dir}/${n}/`], pc.labels);
    pc.file = `${dir}/${name}${sx}.${cutExt}`;
    pc.marksFile = marks ? `${dir}/${name}${sx}-marks.dxf` : null;
    pc.farFile = far ? `${dir}/${name}${sx}-far.${cutExt}` : null;
  }

  // Lay out each stock group. An own laser needs every piece to fit (layoutGroup
  // throws "stock too small"); for a cutting service or a router the sheets are
  // reference only, so an oversized piece is listed in the README instead (spec D.5).
  const sheets = [];
  const oversized = [];
  for (const g of groups.values()) {
    const inGroup = pieces.filter((pc) => pc.group === g.group);
    const count = inGroup.reduce((n, pc) => n + pc.qty, 0);
    say(`laying out ${g.material} ${fmtMm(g.thickness)} mm (${count} pieces)`);
    const stock = stockFor.get(g.group);
    const laid = layoutGroup({
      group: g.group, label: g.label, stock, margin: o.margin, spacing: o.spacing, strict: !(service || router),
      pieces: inGroup.map((pc) => ({ key: pc.file, label: pc.labels[0], drawing: pc.faces.near, qty: pc.qty })),
    });
    if (laid.sheets.length > KIT_LIMITS.sheetsPerGroup) {
      throw new Error(`${KIT_OPTIONS_ERROR} ${g.material} ${fmtMm(g.thickness)} mm needs ${laid.sheets.length} sheets — at most ${KIT_LIMITS.sheetsPerGroup} per material; use larger stock or fewer sets`);
    }
    const sheetDir = claim(kitName(`${g.material}-${fmtMm(g.thickness)}mm`), (n) => [`${folder}/sheets/${n}/`], [g.label]);
    laid.sheets.forEach((sh, i) => sheets.push({
      file: `${folder}/sheets/${sheetDir}/sheet-${i + 1}-of-${laid.sheets.length}.${cutExt}`,
      group: g, stock, placements: sh.placements, used: sh.used, index: i + 1, count: laid.sheets.length,
    }));
    for (const key of laid.oversized) {
      const pc = inGroup.find((x) => x.file === key);
      const [w, ht] = sizeOf(pc.drawing.bounds);
      oversized.push(`${pc.labels.join(", ")}: ${w.toFixed(1)} × ${ht.toFixed(1)} mm does not fit a ${fmtMm(stock[0])} × ${fmtMm(stock[1])} mm sheet after its ${fmtMm(o.margin)} mm margin (${g.label}) — cut it from ${pc.file}`);
    }
  }

  // The files (spec D.8): own laser — an SVG per sheet and per piece; service — a
  // cut-only DXF per piece, a -marks.dxf where it has marks, and reference DXF sheets.
  // A routed piece is one file with every layer — or, two-sided in the two-files mode,
  // its near face and its far face (behind a REFERENCE outline) as two.
  say("writing cut files");
  const title = cleanLabel(part.meta?.title ?? ctx.fileBase);
  const entries = [];
  const put = (file, text) => entries.push(makeEntry(file, `drawing-${file.slice(file.lastIndexOf(".") + 1)}`, strToU8(text)));
  for (const sh of sheets) {
    const doc = { title: `${title} — ${sh.group.label} — sheet ${sh.index} of ${sh.count}`, size: sh.stock, placements: sh.placements };
    put(sh.file, cutExt === "dxf" ? renderDxf(doc) : renderSvg(doc));
  }
  for (const pc of pieces) {
    const docOf = (drawing) => ({ title: pc.labels.join(", "), size: sizeOf(drawing.bounds),
      placements: [{ drawing, at: [0, 0], rotated: false }] });
    const render = cutExt === "svg" ? renderSvg : renderDxf;
    if (pc.farFile) { put(pc.file, render(docOf(pc.faces.near))); put(pc.farFile, render(docOf(pc.faces.far))); continue; }
    const doc = docOf(pc.drawing);
    if (cutExt === "svg") { put(pc.file, renderSvg(doc)); continue; }
    if (pc.routed) { put(pc.file, renderDxf(doc)); continue; }       // every layer, one file
    put(pc.file, renderDxf(doc, { include: ["cut"] }));
    if (pc.marksFile) put(pc.marksFile, renderDxf(doc, { include: ["score", "engrave"] }));
  }

  const material = (pc) => groups.get(pc.group).material;
  const thickness = (pc) => groups.get(pc.group).thickness;
  return {
    entries,
    // The README's cutting block for this section (readme.js renderReadme's `cut`).
    cut: {
      label: SECTION_LABELS[id], folder, destination, cutFormat: cutExt, kerf: o.kerf ?? 0,
      scale: pieces.map((pc) => ({ label: pc.labels.join(", "), nominal: pc.drawing.nominal, drawn: sizeOf(pc.drawing.bounds) })),
      marksFiles: pieces.map((pc) => pc.marksFile).filter(Boolean),
      hasSheets: sheets.length > 0,
      anyTwoSided: pieces.some((pc) => pc.twoSided),
    },
    ...(router ? { flip: o.flip } : {}),
    stockNotes: [...groups.values()].map((g) => ({ material: g.material, thickness: g.thickness,
      control: thicknessControlLabel(controls, part.parts[g.first], p, d) })),
    sheets: sheets.map((sh) => ({ file: sh.file, material: sh.group.material, thickness: sh.group.thickness,
      size: sh.stock, pieces: sh.placements.length, used: sh.used })),
    pieces: pieces.map((pc) => ({ file: pc.file, marksFile: pc.marksFile, farFile: pc.farFile, labels: pc.labels,
      material: material(pc), thickness: thickness(pc), size: pc.drawing.nominal, quantity: pc.qty })),
    router: pieces.filter((pc) => pc.routed && pc.facts?.routed).map((pc) => ({
      labels: pc.labels, material: material(pc), thickness: thickness(pc), ...pc.facts.routed,
      twoSided: pc.twoSided, farFile: pc.farFile })),
    layers: router ? routedLegend(pieces, cutExt) : [],
    checks: pieces.flatMap((pc) => sheetWarnings(pc.labels.join(", "), pc.facts)),
    oversized, renamed,
    rows: pieces.flatMap((pc) => {
      const row = { file: pc.file, kind: "sheet", labels: pc.labels, material: material(pc),
        thickness: thickness(pc), width: pc.drawing.nominal[0], height: pc.drawing.nominal[1], quantity: pc.qty };
      return pc.farFile ? [row, { ...row, file: pc.farFile, kind: "far" }] : [row];
    }),
  };
}
