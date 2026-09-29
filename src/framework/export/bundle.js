// The cut & print kit (spec D): one ZIP per forge — every checked sheet part drawn flat
// and laid out on the user's stock, every checked printed part as STL or 3MF, a README
// and a parts list.
//
// jobs.js loads this module LAZILY, on the first export-bundle job (`loadBundle`), never
// at worker boot (test/worker-layering.test.js). And nothing here may reach ./oracle/*
// (test/kit-layering.test.js mocks every oracle module to throw): the mesh oracle has
// OOM-killed iOS Safari, and the kit needs none of it — a sheet is drawn from its 2-D
// declaration and checked by its own process's facts()/checks().
import { zipSync, strToU8 } from "fflate";
import { safeName } from "../safe-name.js";
import { meshTo3MF } from "../geometry/threemf.js";
import { h } from "../geometry/solid-hash.js";
import { printColor } from "../materials/resolve.js";
import { isSheetPart, sheetMeta, fmtMm, SHEET_CHECK_BUDGET_MS } from "../sheet/constants.js";
import { resolveSheet } from "../sheet/resolve.js";
import { processById, SHEET_METRICS } from "../process/registry.js";
import { loadExporter } from "../process/exporters.js";
import { validateKitOptions, resolveStock, KIT_OPTIONS_ERROR, KIT_LIMITS } from "./formats.js";
import { canonicalDrawingKey } from "./drawing.js";
import { renderSvg } from "./svg.js";
import { renderDxf } from "./dxf.js";
import { layoutGroup } from "./layout.js";
import { renderReadme, renderPartsCsv, cleanLabel } from "./readme.js";

// Every entry name the kit may write (spec D.10). test/kit-bundle.test.js pins every
// kit it builds against it, and buildBundle asserts it again before zipping.
export const KIT_ENTRY_RE = /^(README\.txt|parts\.csv|sheets\/[a-z0-9][a-z0-9._-]*\/sheet-\d+-of-\d+\.(svg|dxf)|parts\/[a-z0-9][a-z0-9._-]*(-x\d+)?(-marks)?\.(svg|dxf)|print\/[a-z0-9][a-z0-9._-]*(-x\d+)?\.(stl|3mf))$/;

// A path segment from an author string. safeName already lowercases, collapses runs and
// refuses a leading dot or dash; folding every run of dots on top means no entry name
// can ever carry "..".
export const kitName = (s) => safeName(s, "part").replace(/\.{2,}/g, ".");

// The first of base, base-2, base-3, … whose files are all free, claimed in `taken`.
// `filesOf(name)` lists every path a name produces — a piece's cut file and its -marks
// file — so a name is free only when all of them are, and "front" ×2 can never land on
// the file of a piece literally named "front-x2". Called in definition order, so a
// forge always gets the same names.
export function uniqueName(base, taken, filesOf = (name) => [name]) {
  let name = base;
  for (let i = 2; filesOf(name).some((f) => taken.has(f)); i++) name = `${base}-${i}`;
  for (const f of filesOf(name)) taken.add(f);
  return name;
}

// Merge equal items, first-seen order kept. `hashOf` only NOMINATES candidates — the kit
// hashes with solid-hash.js's 32-bit FNV, which can collide — and `same(a, b)` confirms.
// Returns [{ item, members }], `item` being the first member.
export function dedupe(items, hashOf, same) {
  const groups = [];
  const byHash = new Map();
  for (const item of items) {
    const key = hashOf(item);
    const candidates = byHash.get(key) ?? [];
    const hit = candidates.find((g) => same(g.item, item));
    if (hit) { hit.members.push(item); continue; }
    const group = { item, members: [item] };
    candidates.push(group);
    byHash.set(key, candidates);
    groups.push(group);
  }
  return groups;
}

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

const NOT_EVALUATED = "2-D sheet checks not evaluated (time budget) — the kit ran out of time checking this piece for narrow webs, narrow gaps and stray marks; look it over before cutting";

// oracle/verify.js's wording for a reading the geometry engine refused (SheetFacts's
// readErrors, added past this file's own §5.4/§7.1 in the contract) — restated here
// rather than imported, for the same reason checkMessage restates assert-dsl: the kit
// must never load ./oracle/*. test/kit-bundle-helpers.test.js pins this string.
const SHEET_READ_ERROR_HINT = "The geometry engine could not run this 2-D laser check on the profile (the reason is in the message). The part still builds; an overlapping or self-touching contour, or a sliver, is the usual cause — simplify the profile there and re-run.";

// The README's CHECKS lines for one piece: every volunteered check its process runs
// that fails, as `${label}: ${message} — ${hint}` with the metric's own hint. A metric
// with no reading (budget-gated and not evaluated, or a custom build's volume match,
// which needs a solid the kit never builds) is skipped; an unevaluated piece gets one
// line saying so instead. A metric the geometry engine refused to read (readErrors) gets
// its own line, worded like verify's: `not measured — <reason>`, with a fixed hint —
// never the metric's own hint, which describes a value that was never taken.
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

// ─── buildBundle ────────────────────────────────────────────────────────────

// cl:src/sandbox/protocol.js clips a progress phase at 120 characters; the kit keeps
// its own phases under that, so a long label is cut here, once, with an ellipsis.
const PHASE_MAX = 120;
const clipPhase = (s) => (s.length > PHASE_MAX ? `${s.slice(0, PHASE_MAX - 1)}…` : s);
const sizeOf = (b) => [b.max[0] - b.min[0], b.max[1] - b.min[1]];
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
// Controls the README lists as design fit rather than kerf (spec D.9), on key or label.
const CLEARANCE_RE = /clearance|fit|play/i;
const ALL_LAYERS = ["cut", "score", "engrave"];

// Every control that owns a parameter key, whatever the section shape: authored
// `controls` (groups nest), and the legacy `advanced`, `toggles`, `features` and a
// feature's own `sliders`. Groups and presets own no key.
function collectControls(parameters) {
  const out = [];
  const visit = (list) => {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.key === "string" && c.type !== "group" && c.type !== "preset") out.push(c);
      visit(c.controls);
      visit(c.sliders);
    }
  };
  for (const sec of Array.isArray(parameters) ? parameters : []) {
    visit(sec?.controls); visit(sec?.advanced); visit(sec?.toggles); visit(sec?.features);
  }
  return out;
}

// The control a sheet part's thickness reads, so the README can name the setting to
// change when the user's sheet measures differently; null for a literal thickness or
// one that reads no control.
function thicknessControlLabel(controls, sp, p, d) {
  const t = sp.sheet.thickness;
  if (typeof t !== "function") return null;
  const reads = new Set();
  const spy = new Proxy(p, { get: (target, key) => { if (typeof key === "string") reads.add(key); return target[key]; } });
  try { t(spy, d); } catch { return null; }
  const c = controls.find((x) => reads.has(x.key));
  return c ? String(c.label ?? c.key) : null;
}

// A sheet part's stock group, or the part's own named error: sheetMeta answers null
// when material or thickness cannot be evaluated, and resolveSheet is what knows how to
// say why.
function sheetMetaOrThrow(kernel, sp, p, d, name) {
  const meta = sheetMeta(sp, p, d);
  if (meta) return meta;
  resolveSheet(kernel, sp, p, d);
  throw new Error(`sheet part "${name}": its material or thickness could not be evaluated`);
}

// One export-bundle job's kit. `names` is the job's selected() — exportable, enabled, in
// definition order — and `posed`/`label`/`exportName` are jobs.js's own, so a kit's
// printed parts are built exactly the way the STL and 3MF exports build them.
export async function buildBundle({ kernel, part, msg, p, d, posed, label, exportName, names, onProgress, fileBase }) {
  // Options first, before anything is built: a bad option is the user's to fix and must
  // not wait behind a build (spec D.3). An absent options object means every default.
  const o = validateKitOptions(msg.options ?? {});
  const service = o.destination === "service";
  const cutExt = service ? "dxf" : "svg";
  const say = (phase) => onProgress(clipPhase(phase));
  const nameOf = (name) => cleanLabel(label(name));
  if (names.length === 0) throw new Error("no exportable parts selected");
  const sheetNames = names.filter((name) => isSheetPart(part.parts[name]));
  const printNames = names.filter((name) => !isSheetPart(part.parts[name]));
  if (sheetNames.length === 0) {
    throw new Error(`${KIT_OPTIONS_ERROR} none of the checked parts is a sheet part — check a sheet part or export STL/3MF instead`);
  }
  // The cut-piece count is sheet sub-parts × sets — exactly what the merged pieces sum
  // to — so it is checked before the builds it would otherwise waste.
  const cutCount = sheetNames.length * o.sets;
  if (cutCount > KIT_LIMITS.pieces) {
    throw new Error(`${KIT_OPTIONS_ERROR} the kit has ${cutCount} pieces — at most ${KIT_LIMITS.pieces}; lower sets`);
  }

  // Stock groups from each part's material and thickness alone, so a stock entry that
  // names no group in the kit fails before any drawing is made.
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
  const stockFor = resolveStock(o.stock, [...groups.values()].map((g) => ({ group: g.group, label: g.label })));

  // Draw every sheet part flat, from its 2-D declaration, with its 2-D facts under ONE
  // budget for the whole kit.
  const deadline = Date.now() + SHEET_CHECK_BUDGET_MS;
  const drawn = [];
  for (const name of sheetNames) {
    say(`building ${nameOf(name)}`);
    const s = resolveSheet(kernel, part.parts[name], p, d);
    const desc = processById(s.process);
    if (!desc) throw new Error(`sheet part "${nameOf(name)}": unknown process "${s.process}"`);
    const facts = desc.facts(s, { deadline });
    const exporter = await loadExporter(s.process);
    const drawing = exporter.drawing(s, o, kernel, { label: nameOf(name), facts });
    drawn.push({ name, label: nameOf(name), fileKey: exportName(name), group: groupOf.get(name),
      drawing, facts, key: canonicalDrawingKey(drawing) });
  }

  // Identical pieces become one file ×N (spec D.4): the hash nominates; the canonical
  // drawing and the stock group confirm.
  const pieces = dedupe(drawn, (x) => h(x.key), (a, b) => a.key === b.key && a.group === b.group)
    .map(({ item, members }) => ({
      ...item, labels: members.map((m) => m.label), qty: members.length * o.sets,
      hasMarks: item.drawing.layers.some((l) => l.id === "score" || l.id === "engrave"),
    }));

  // Names, in definition order. A name that was taken moves to name-2; the README's
  // RENAMED FILES says which file it was and who held the name (spec D.10).
  const taken = new Set();
  const owners = new Map();
  const renamed = [];
  const claim = (base, filesOf, labels) => {
    const name = uniqueName(base, taken, filesOf);
    if (name !== base) {
      const holder = filesOf(base).find((f) => owners.has(f));
      renamed.push(`${filesOf(name)[0]}: ${labels.join(", ")}${holder ? ` (renamed: ${holder} is ${owners.get(holder).join(", ")})` : ""}`);
    }
    for (const f of filesOf(name)) owners.set(f, labels);
    return name;
  };
  for (const pc of pieces) {
    const sx = pc.qty > 1 ? `-x${pc.qty}` : "";
    const filesOf = (n) => [`parts/${n}${sx}.${cutExt}`, ...(service && pc.hasMarks ? [`parts/${n}${sx}-marks.dxf`] : [])];
    const files = filesOf(claim(kitName(pc.fileKey), filesOf, pc.labels));
    pc.file = files[0];
    pc.marksFile = files[1] ?? null;
  }

  // Lay out each stock group. An own laser needs every piece to fit (layoutGroup
  // throws "stock too small"); for a cutting service the sheets are reference only, so
  // an oversized piece is listed in the README instead (spec D.5).
  const sheets = [];
  const oversized = [];
  for (const g of groups.values()) {
    const inGroup = pieces.filter((pc) => pc.group === g.group);
    const count = inGroup.reduce((n, pc) => n + pc.qty, 0);
    say(`laying out ${g.material} ${fmtMm(g.thickness)} mm (${count} pieces)`);
    const stock = stockFor.get(g.group);
    const laid = layoutGroup({
      group: g.group, label: g.label, stock, margin: o.margin, spacing: o.spacing, strict: !service,
      pieces: inGroup.map((pc) => ({ key: pc.file, label: pc.labels[0], drawing: pc.drawing, qty: pc.qty })),
    });
    if (laid.sheets.length > KIT_LIMITS.sheetsPerGroup) {
      throw new Error(`${KIT_OPTIONS_ERROR} ${g.material} ${fmtMm(g.thickness)} mm needs ${laid.sheets.length} sheets — at most ${KIT_LIMITS.sheetsPerGroup} per material; use larger stock or fewer sets`);
    }
    const dir = claim(kitName(`${g.material}-${fmtMm(g.thickness)}mm`), (n) => [`sheets/${n}/`], [g.label]);
    laid.sheets.forEach((sh, i) => sheets.push({
      file: `sheets/${dir}/sheet-${i + 1}-of-${laid.sheets.length}.${cutExt}`,
      group: g, stock, placements: sh.placements, used: sh.used, index: i + 1, count: laid.sheets.length,
    }));
    for (const key of laid.oversized) {
      const pc = inGroup.find((x) => x.file === key);
      const [w, ht] = sizeOf(pc.drawing.bounds);
      oversized.push(`${pc.labels.join(", ")}: ${w.toFixed(1)} × ${ht.toFixed(1)} mm does not fit a ${fmtMm(stock[0])} × ${fmtMm(stock[1])} mm sheet after its ${fmtMm(o.margin)} mm margin (${g.label}) — cut it from ${pc.file}`);
    }
  }

  // Printed parts, posed for export exactly as the STL/3MF exports pose them. Identical
  // prints merge: the solid hash nominates; volume, bounding box, triangle count and
  // print colour confirm (spec D.4).
  const quality = msg.quality ?? "print";
  const builtPrints = [];
  for (const name of printNames) {
    say(`building ${nameOf(name)}`);
    const solid = posed(name, "export", onProgress);
    const box = solid.boundingBox();
    const display = part.parts[name]?.display;
    const pp = {
      name, label: nameOf(name), fileKey: exportName(name), hash: String(solid._hash ?? ""),
      size: [0, 1, 2].map((i) => box.max[i] - box.min[i]), volume: solid.volume(),
      color: printColor(display), material: typeof display?.material === "string" ? display.material : "",
    };
    if (o.printFormat === "stl") {
      pp.bytes = new Uint8Array(await solid.toSTL({ quality }));
      pp.triangles = new DataView(pp.bytes.buffer, pp.bytes.byteOffset, pp.bytes.byteLength).getUint32(80, true);
    } else {
      const { positions, indices } = solid.toIndexedMesh({ quality });
      pp.mesh = { positions, indices };
      pp.triangles = indices.length / 3;
    }
    builtPrints.push(pp);
  }
  const prints = dedupe(builtPrints, (x) => x.hash, (a, b) => a.triangles === b.triangles && a.color === b.color
      && near(a.volume, b.volume) && a.size.every((x, i) => near(x, b.size[i])))
    .map(({ item, members }) => ({ ...item, labels: members.map((m) => m.label), qty: members.length * o.sets }));
  for (const pp of prints) {
    const sx = pp.qty > 1 ? `-x${pp.qty}` : "";
    const filesOf = (n) => [`print/${n}${sx}.${o.printFormat}`];
    pp.file = filesOf(claim(kitName(pp.fileKey), filesOf, pp.labels))[0];
    if (!pp.bytes) pp.bytes = new Uint8Array(meshTo3MF([{ name: pp.fileKey, ...pp.mesh, color: pp.color }]));
  }

  // The files (spec D.8): own laser — an SVG per sheet and per piece; service — a
  // cut-only DXF per piece, a -marks.dxf where it has marks, and reference DXF sheets.
  say("writing cut files");
  const title = cleanLabel(part.meta?.title ?? fileBase);
  const files = [];
  const put = (file, text) => files.push({ file, data: strToU8(text) });
  for (const sh of sheets) {
    const doc = { title: `${title} — ${sh.group.label} — sheet ${sh.index} of ${sh.count}`, size: sh.stock, placements: sh.placements };
    put(sh.file, service ? renderDxf(doc, { include: ALL_LAYERS }) : renderSvg(doc));
  }
  for (const pc of pieces) {
    const doc = { title: pc.labels.join(", "), size: sizeOf(pc.drawing.bounds),
      placements: [{ drawing: pc.drawing, at: [0, 0], rotated: false }] };
    if (!service) { put(pc.file, renderSvg(doc)); continue; }
    put(pc.file, renderDxf(doc, { include: ["cut"] }));
    if (pc.marksFile) put(pc.marksFile, renderDxf(doc, { include: ["score", "engrave"] }));
  }
  for (const pp of prints) files.push({ file: pp.file, data: pp.bytes });

  const controls = collectControls(part.parameters);
  const readme = renderReadme({
    title, destination: o.destination, cutFormat: o.cutFormat, kerf: o.kerf,
    stockNotes: [...groups.values()].map((g) => ({ material: g.material, thickness: g.thickness,
      control: thicknessControlLabel(controls, part.parts[g.first], p, d) })),
    scale: pieces.map((pc) => ({ label: pc.labels.join(", "), nominal: pc.drawing.nominal, drawn: sizeOf(pc.drawing.bounds) })),
    sheets: sheets.map((sh) => ({ file: sh.file, material: sh.group.material, thickness: sh.group.thickness,
      size: sh.stock, pieces: sh.placements.length, used: sh.used })),
    pieces: pieces.map((pc) => ({ file: pc.file, labels: pc.labels, material: groups.get(pc.group).material,
      thickness: groups.get(pc.group).thickness, size: pc.drawing.nominal, quantity: pc.qty })),
    printed: prints.map((pp) => ({ file: pp.file, labels: pp.labels, quantity: pp.qty })),
    clearances: controls.filter((c) => CLEARANCE_RE.test(c.key) || CLEARANCE_RE.test(String(c.label ?? "")))
      .map((c) => ({ label: c.label ?? c.key, value: p[c.key], unit: c.unit ?? "" })),
    settings: Object.keys(p).map((key) => ({ key, value: p[key] })),
    checks: pieces.flatMap((pc) => sheetWarnings(pc.labels.join(", "), pc.facts)),
    oversized, renamed,
  });
  const csv = renderPartsCsv([
    ...pieces.map((pc) => ({ file: pc.file, kind: "sheet", labels: pc.labels, material: groups.get(pc.group).material,
      thickness: groups.get(pc.group).thickness, width: pc.drawing.nominal[0], height: pc.drawing.nominal[1], quantity: pc.qty })),
    ...prints.map((pp) => ({ file: pp.file, kind: "print", labels: pp.labels, material: pp.material, thickness: null,
      width: pp.size[0], height: pp.size[1], quantity: pp.qty })),
  ]);

  // Every planned file must land under its own name: a path two files shared would
  // silently overwrite one of them, so the count is asserted, and every name is held to
  // the entry pattern once more on the way in.
  const planned = [{ file: "README.txt", data: strToU8(readme) }, { file: "parts.csv", data: strToU8(csv) }, ...files];
  const entries = {};
  for (const { file, data } of planned) {
    if (!KIT_ENTRY_RE.test(file) || file.includes("..")) throw new Error(`cut kit: bad entry name ${JSON.stringify(file)}`);
    entries[file] = data;
  }
  const built = Object.keys(entries).length;
  if (built !== planned.length) throw new Error(`cut kit: planned ${planned.length} files but built ${built}`);
  say("zipping kit");
  return { data: zipSync(entries, { level: 6 }), filename: `${fileBase}-kit.zip` };
}
