// The kit's two plain-text files: README.txt, read by a person standing at the laser,
// and parts.csv, opened in a spreadsheet (spec D.9). Pure string building over a model
// that export/bundle.js assembles, so both are testable without a kernel.
//
// Neither carries a timestamp — the same forge and options always write the same bytes
// — and neither is Markdown: every label is an author string, and plain text is the one
// format in which nothing an author writes renders as anything.
import { fmtMm } from "../sheet/constants.js";

export const README_HEADINGS = Object.freeze([
  "BEFORE YOU CUT", "SHEETS", "PIECES", "ROUTER OPERATIONS", "PRINTED PARTS", "CLEARANCES (design fit, not kerf)",
  "SETTINGS", "CHECKS", "OVERSIZED PIECES", "RENAMED FILES", "LIMITS",
]);
export const CSV_HEADER = "file,kind,labels,material,thickness_mm,width_mm,height_mm,quantity";

const SVG_LEGEND = "Colours: engrave = filled black #000000, score = blue #0000FF, cut = red #FF0000 (inner cuts come before outer cuts).";
const DXF_LEGEND = "DXF layers: CUT (colour 1), SCORE (colour 5), ENGRAVE (colour 7) — set ENGRAVE to fill; R12 has no hatch.";
const ROUTER_LEGEND = "DXF layers: CUT (colour 1) is the through cut; POCKET_<depth>MM and DRILL_D<dia>_<depth>MM / _THRU carry one depth each; SECONDARY outlines operations done with another tool (see ROUTER OPERATIONS); REFERENCE is layout only. FAR_* layers are the same operations on the far face, drawn mirrored (see the flip note under each two-sided piece). Laser pieces keep CUT/SCORE/ENGRAVE.";
// A two-sided routed piece: how its far layers were mirrored, how to line them up, and
// where its through cut is made.
const FLIP_NOTE = {
  "left-right": "Far-side layers (FAR_*) are drawn as seen after flipping the board left-right, matching a VCarve two-sided job with Flip Direction = Horizontal.",
  "end-over-end": "Far-side layers (FAR_*) are drawn as seen after flipping the board end over end, matching a VCarve two-sided job with Flip Direction = Vertical.",
};
const ALIGN_NOTE = "On the bottom side, move the imported far-side vectors so their outline sits on the piece's outline as the CAM shows it from that side. Shortcut: make the job's material the piece's size with the datum at its centre on both sides, and the far layers land exactly.";
const ONE_FILE_NOTE = "On the bottom side the CUT outline is for alignment only — cut the piece out from the near side.";
const TWO_SIDED_ORDER = "Two-sided pieces: machine the far side first, flip, then the near side and the through cut last, so the board holds the piece until the end. Sheet layouts in sheets/ carry near-side work only; far-side work is in the per-piece files.";
const LIMITS_LINE = "Layout packs bounding boxes only: no nesting into holes, and grain direction is ignored.";

// C0 controls, DEL and C1 controls out of an author string, so a label can never ring a
// bell, move a cursor or smuggle a line break into a table row — and the Unicode line
// and paragraph separators (U+2028/U+2029, a line break in many editors) and the bidi
// embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069), which reorder the
// text around them, for the same reason.
export const cleanLabel = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");

// One RFC 4180 cell. A cell starting with = + - or @ is a formula to Excel, Numbers and
// Sheets, so it gets a leading ' first — before quoting, so no quote can be closed
// around it.
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// A parameter value the way one README line can hold it: numbers and booleans as
// written, strings JSON-quoted (so "" and " " stay visible), bytes by size, anything
// else as clipped JSON.
function settingValue(v) {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return JSON.stringify(clip(cleanLabel(v)));
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return `<${v.byteLength} bytes>`;
  try { return clip(JSON.stringify(v) ?? String(v)); } catch { return "<unprintable>"; }
}

const table = (header, rows) => (rows.length ? [header.join(" | "), ...rows.map((r) => r.join(" | "))] : []);
const mm2 = ([w, h]) => `${w.toFixed(2)} × ${h.toFixed(2)} mm`;
const faceOf = (op) => (op.face === "far" ? "far" : "near");
const labelsOf = (labels) => labels.map(cleanLabel).join(", ");

export function renderReadme(m) {
  const k = m.kerf;
  const kerfed = k > 0;
  const router = m.destination === "cnc-router";
  // A cutting service gets each piece's score and engrave lines in a separate
  // -marks.dxf, which neither table lists — so the files are named here, or a service
  // order built from the cut files alone silently leaves the marks off.
  const marksFiles = m.pieces.map((pc) => pc.marksFile).filter(Boolean);
  const body = {
    "BEFORE YOU CUT": [
      ...m.stockNotes.map((g) =>
        `This kit assumes ${g.thickness.toFixed(2)} mm ${cleanLabel(g.material)} — if yours differs, change "${cleanLabel(g.control ?? "the sheet thickness setting")}" and re-download.`),
      router
        ? "Kerf: none — a CNC router's CAM applies the tool offset."
        : kerfed
          ? `Kerf: ${k.toFixed(2)} mm applied to the cut lines only. Set kerf in ONE place — these download options, or your laser software / cutting service — never both.`
          : "Kerf: none applied — your laser software or cutting service must compensate.",
      ...(kerfed || router ? [] : ["To have the files adjusted instead, download again with a kerf set, and turn compensation off in your laser software or service."]),
      "Scale check — measure one cut piece against its line:",
      ...m.scale.map((s) => `${cleanLabel(s.label)}: nominal ${s.nominal[0].toFixed(2)} × ${s.nominal[1].toFixed(2)} mm; this file draws ${
        kerfed ? `${s.drawn[0].toFixed(2)} × ${s.drawn[1].toFixed(2)} with ${k.toFixed(2)} mm kerf` : "the same (no kerf applied)"}`),
      router ? ROUTER_LEGEND : m.cutFormat === "dxf" ? DXF_LEGEND : SVG_LEGEND,
      ...(m.anyTwoSided ? [TWO_SIDED_ORDER] : []),
      ...(marksFiles.length ? [`Score and engrave marks are in their own files, not in the cut files — send them with the cut files if you want the marks made: ${marksFiles.join(", ")}.`] : []),
      // A service kit whose every piece is oversized writes no sheets/ at all.
      ...(m.destination === "service" && m.sheets.length ? ["The sheets in sheets/ are for reference only — a cutting service lays out the pieces itself."] : []),
      "Test-cut one joint first.",
    ],
    SHEETS: table(["file", "material", "thickness", "size", "pieces", "used"], m.sheets.map((s) => [
      s.file, cleanLabel(s.material), `${s.thickness.toFixed(2)} mm`, `${fmtMm(s.size[0])} × ${fmtMm(s.size[1])} mm`,
      String(s.pieces), `${Math.round(s.used)}%`])),
    PIECES: table(["file", "labels", "material", "thickness", "size", "quantity"], m.pieces.map((pc) => [
      pc.file, labelsOf(pc.labels), cleanLabel(pc.material), `${pc.thickness.toFixed(2)} mm`, mm2(pc.size), String(pc.quantity)])),
    "ROUTER OPERATIONS": [...(m.router ?? []).flatMap((r) => [
      `${labelsOf(r.labels)} (${cleanLabel(r.material)} ${r.thickness.toFixed(2)} mm) — depths from each op's own face:`,
      ...table(["op", "face", "label", "size", "depth", "method"], [
        ...r.pockets.map((pk) => ["pocket", faceOf(pk), pk.label ? cleanLabel(pk.label) : "—", mm2([pk.w, pk.h]), `${pk.depth.toFixed(2)} mm`, "mill"]),
        ...r.drills.map((dr) => ["drill", faceOf(dr), dr.label ? cleanLabel(dr.label) : "—", `Ø${fmtMm(dr.d)} mm × ${dr.count}`, dr.through ? "through" : `${dr.depth.toFixed(2)} mm`, "drill"]),
        ...r.extra.map((x) => ["extra", faceOf(x), cleanLabel(x.label), mm2([x.w, x.h]), `to ${x.maxDepth.toFixed(2)} mm`, cleanLabel(x.method)]),
      ]),
      ...(r.twoSided ? [FLIP_NOTE[m.flip] ?? FLIP_NOTE["left-right"], ALIGN_NOTE,
        r.farFile ? `Far-side work is in ${r.farFile}; its REFERENCE outline is for alignment, not cutting.` : ONE_FILE_NOTE] : []),
    ]),
    // The layer legend: one colour per layer name across the whole kit.
    ...((m.router ?? []).length && (m.layers ?? []).length
      ? ["LAYERS (one colour per layer across the kit):", ...table(["layer", "face", "colour", "depth"], m.layers.map((l) => [l.name, faceOf(l), l.colour, l.depth]))]
      : [])],
    "PRINTED PARTS": table(["file", "labels", "quantity"], m.printed.map((pp) => [pp.file, labelsOf(pp.labels), String(pp.quantity)])),
    "CLEARANCES (design fit, not kerf)": m.clearances.map((c) =>
      `${cleanLabel(c.label)}: ${settingValue(c.value)}${c.unit ? ` ${cleanLabel(c.unit)}` : ""}`),
    SETTINGS: m.settings.map((s) => `${cleanLabel(s.key)} = ${settingValue(s.value)}`),
    CHECKS: m.checks.length ? m.checks.map(cleanLabel) : ["none"],
    // Only a non-strict layout (a service, a CNC router) can leave a piece off the sheets.
    "OVERSIZED PIECES": m.destination === "service" || router ? m.oversized.map(cleanLabel) : [],
    "RENAMED FILES": m.renamed.map(cleanLabel),
    LIMITS: [LIMITS_LINE],
  };
  const out = [`${cleanLabel(m.title)} — cut & print kit`, ""];
  for (const heading of README_HEADINGS) {
    if (body[heading].length) out.push(heading, ...body[heading], "");
  }
  return out.join("\n");
}

export function renderPartsCsv(rows) {
  const line = (cells) => `${cells.map(csvCell).join(",")}\r\n`;
  return `${CSV_HEADER}\r\n${rows.map((r) => line([
    r.file, r.kind, r.labels.map(cleanLabel).join("; "), cleanLabel(r.material ?? ""),
    r.thickness == null ? "" : r.thickness.toFixed(2), r.width.toFixed(2), r.height.toFixed(2), String(r.quantity),
  ])).join("")}`;
}
