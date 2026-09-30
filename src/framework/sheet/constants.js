// The sheet-part vocabulary: names, thresholds and tiny pure helpers shared by the
// authoring layer (sheet/part.js, sheet/joinery.js), lint (lint/rules-sheet.js), the
// oracle (oracle/measure.js, oracle/verify.js) and the kit export (export/*).
//
// IMPORT-FREE, and that is load-bearing: lint's closure must stay free of bare
// dependencies (test/lint-purity.test.js) and the oracle's free of paper
// (test/oracle-no-paper.test.js), and all three read this file. Anything that needs
// a kernel, a Shape2D or paper belongs in resolve.js / joinery.js instead.
//
// Recognition is PLAIN DATA: a sheet sub-part is one whose `sheet` is an object with a
// string `process` (isSheetPart below). Never instanceof, a module-scoped Symbol() or
// a WeakMap — in partforge-cloud's part worker the part's `partforge/geometry` and the
// framework are separate module instances, so an identity marker silently never
// matches there.

// The guide section id ("## Sheet parts" in docs/AUTHORING-PARTS.md). Every sheet
// lint finding and DFM check carries it as `pattern`, which survives the host's
// truncation of message/hint.
export const SHEET_DOC_ID = "sheet-parts";

// The six axis words a SheetPose names its face and up with.
export const AXIS_WORDS = Object.freeze(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);

// sheetPart's own keys, and the ordinary sub-part keys it passes through untouched.
export const SHEET_KEYS = Object.freeze(["material", "thickness", "profile", "score", "engrave", "pose", "process"]);
export const SUBPART_PASSTHROUGH_KEYS = Object.freeze(["label", "views", "display", "export", "enabled", "exportable", "reference", "place"]);

// Keys an author reaches for by another name, and keys held for future processes
// (sheet-metal bends, papercraft folds, grain direction). Each gets its own error.
export const RENAMED_KEYS = Object.freeze({ outline: "profile", cut: "profile" });
export const RESERVED_KEYS = Object.freeze(["folds", "bends", "grain"]);

// The preview build's marks (mm): engrave and score are cut MARK_DEPTH into the laser
// face by tools that rise MARK_OVERCUT above it (never coplanar with the face — OCCT's
// coplanar booleans are fragile), and a score is a SCORE_WIDTH-wide groove. The
// depths exist only in the preview; the cut files carry vectors.
export const MARK_DEPTH = 0.2;
export const MARK_OVERCUT = 0.1;
export const SCORE_WIDTH = 0.3;

// The laser DFM thresholds (read by the checks in P1b). A web, finger, hole or slot
// narrower than widthFloor(t) = max(0.5·t, 0.5 mm) — SendCutSend's floor — is flagged;
// widths are found by bisection to WIDTH_RESOLUTION mm, an area change under
// LOSS_TOL_MM2 is not a loss, and a custom build may drift SOLID_MATCH_PCT % from its
// profile. All of a measure()/kit call's 2-D checks share SHEET_CHECK_BUDGET_MS.
export const WIDTH_FLOOR_FRACTION = 0.5;
export const WIDTH_FLOOR_MIN = 0.5;
export const WIDTH_RESOLUTION = 0.05;
export const LOSS_TOL_MM2 = 0.01;
export const SOLID_MATCH_PCT = 2;
export const SHEET_CHECK_BUDGET_MS = 1500;
export const LASER_THICKNESS_RANGE = Object.freeze([0.5, 12]);

// The two standing texts verify gives the laser checks (oracle/verify.js). They live here,
// import-free, so every surface that repeats them — the kit's README, which may not import
// oracle/* — reads one text; verify.js imports and re-exports them.
// Standing in for a sheet's budget-gated volunteered checks when its 2-D budget ran out
// (measure()'s `sheet.evaluated` false): one warning, never `unevaluated`.
export const SHEET_CHECKS_NOTICE = Object.freeze({
  metric: "sheetChecks", kind: "warn", expr: "evaluated", actual: null, status: "warn", pass: null, volunteered: true,
  message: "2-D sheet checks not evaluated (time budget)",
  hint: "The laser checks (narrow webs and gaps, stray marks) did not fit their time budget, or the profile was too complex to start them. They are warnings only and never decide verify.ok. What they spend time on is edges, curved ones most: round holes crowded close to each other or to an edge, and corners rounded tighter than about the sheet thickness, cost the most.",
  pattern: SHEET_DOC_ID,
});
// Why a sheet reading the geometry engine could not take (SheetFacts.readErrors) has no
// verdict. On a valid profile a read error is the checker's own limit, so it never blames the
// contour first.
export const SHEET_READ_ERROR_HINT = "The 2-D laser check could not finish on this profile (the engine stopped at the width in the message), so this reading was not taken; the part still builds. On a valid profile this is a limit of the checker, often near rounded corners or booleaned round holes — do not reshape the part for it; check widths near the one named by eye. Only if the profile really has overlapping or self-touching contours or a sliver, fix those and re-run.";

// The two errors a mark that turned out empty can raise: extruding an empty Shape2D
// (geometry/op-options.js, geometry/occt-backend.js) and an offset that collapses a
// shape (geometry/contour-offset.js). The preview build drops such a mark instead of
// failing — matched by MESSAGE so the build never queries geometry (see resolve.js).
export const EMPTY_MARK_RE = /is empty — nothing to build|collapses the shape/;

export const isSheetPart = (sp) =>
  !!sp && typeof sp.sheet === "object" && sp.sheet !== null && typeof sp.sheet.process === "string";

// Stock grouping: pieces cut from the same material at the same thickness share
// sheets. The key is "<normalized material>|<thickness to 0.01 mm>".
export const normalizeMaterial = (m) => String(m).trim().toLowerCase().replace(/\s+/g, " ");
export const sheetGroup = (material, thickness) => `${normalizeMaterial(material)}|${thickness.toFixed(2)}`;

// Millimetres for messages: at most two decimals, no trailing zeros (3 → "3").
export const fmtMm = (x) => String(Number(x.toFixed(2)));

export const widthFloor = (t) => Math.max(WIDTH_FLOOR_FRACTION * t, WIDTH_FLOOR_MIN);

// A sheet sub-part's stock at these params — { process, material, thickness, group } —
// or null when the sub-part is not a sheet, a field is invalid, or evaluating one
// throws. `material` is returned as authored; `group` is the normalized key.
export function sheetMeta(sp, p, d) {
  if (!isSheetPart(sp)) return null;
  try {
    const { process, material: m, thickness: t } = sp.sheet;
    const material = typeof m === "function" ? m(p, d) : m;
    const thickness = typeof t === "function" ? t(p, d) : t;
    if (typeof material !== "string" || material.trim() === "") return null;
    if (typeof thickness !== "number" || !Number.isFinite(thickness) || thickness <= 0) return null;
    return { process, material, thickness, group: sheetGroup(material, thickness) };
  } catch {
    return null;
  }
}
