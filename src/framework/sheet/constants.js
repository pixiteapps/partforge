// The sheet-part vocabulary: names, thresholds and tiny pure helpers shared by the
// authoring layer (sheet/part.js, sheet/joinery.js), lint (lint/rules-sheet.js), the
// oracle (oracle/measure.js, oracle/verify.js) and the kit export (export/*).
//
// IMPORT-FREE, and that is load-bearing: lint's closure must stay free of bare
// dependencies (test/lint-purity.test.js) and the oracle's free of paper
// (test/oracle-no-paper.test.js), and all three read this file. Anything that needs
// a kernel, a Shape2D or paper belongs in resolve.js / joinery.js instead.

// The six axis words a SheetPose names its face and up with.
export const AXIS_WORDS = Object.freeze(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);

// Millimetres for messages: at most two decimals, no trailing zeros (3 → "3").
export const fmtMm = (x) => String(Number(x.toFixed(2)));
