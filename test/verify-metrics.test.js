// The verify metric vocabulary must live in a module the linter can import without
// pulling in a geometry kernel — src/framework/oracle/verify.js imports measure.js and the part model,
// which reach manifold-3d/replicad. This test pins both the move and the re-export.
import { expect, test } from "vitest";
import { SUBPART_METRICS, VIEW_METRICS } from "../src/framework/verify-metrics.js";
import { SUBPART_METRICS as reSub, VIEW_METRICS as reView } from "../src/framework/oracle/verify.js";
import { suggest } from "../src/framework/geometry/op-options.js";
import { SHEET_METRICS } from "../src/framework/process/registry.js";
import { evaluateCase } from "../src/framework/oracle/verify.js";

test("verify-metrics exposes the subpart metric vocabulary", () => {
  for (const name of ["holes", "watertight", "volume", "surfaceArea", "triangleCount",
    "bbox", "centerOfMass", "boundsMin", "boundsMax", "minWall"]) {
    expect(Object.keys(SUBPART_METRICS), `missing ${name}`).toContain(name);
  }
  expect(SUBPART_METRICS.minWall.kind).toBe("warn");
  expect(SUBPART_METRICS.holes.kind).toBe("gate");
});

test("verify-metrics exposes the view metric vocabulary", () => {
  for (const name of ["bbox", "volume", "overlaps", "centerOfMass", "boundsMin", "boundsMax"]) {
    expect(Object.keys(VIEW_METRICS), `missing ${name}`).toContain(name);
  }
});

test("every metric carries a hint, as the diagnostics contract promises", () => {
  for (const [name, m] of [...Object.entries(SUBPART_METRICS), ...Object.entries(VIEW_METRICS)]) {
    expect(typeof m.hint, `${name} has no hint`).toBe("string");
    expect(m.hint.length, `${name} hint is empty`).toBeGreaterThan(0);
  }
});

test("verify.js re-exports the same registry objects", () => {
  expect(reSub).toBe(SUBPART_METRICS);
  expect(reView).toBe(VIEW_METRICS);
});

test("suggest is exported for reuse by the linter", () => {
  expect(suggest("radius", ["r", "d", "h"])).toBe("r");
  // No "h" in `valid` here: suggest's prefix rule (by design, see op-options.js)
  // maps any h-prefixed key straight to a same-prefixed short key before edit
  // distance ever runs, so a valid set containing both "h" and "height" always
  // resolves to "h" — this case exercises the edit-distance fallback instead.
  expect(suggest("heigth", ["r", "d", "height"])).toBe("height");
  expect(suggest("zzzz", ["r", "d", "h"])).toBe(null);
});

// The sub-part metrics that existed before sheet parts. A process metric must never
// take one of these names: the spread into SUBPART_METRICS would silently replace it.
const PRINT_METRICS = ["holes", "watertight", "volume", "surfaceArea", "triangleCount", "bbox", "centerOfMass",
  "boundsMin", "boundsMax", "minWall", "overhangArea", "wall", "refXorVolume", "refVolumeDeltaPct", "refBboxDelta"];

// A sheet sub-part's facts row, as measure() stamps it (Task 4), for evaluateCase.
const sheetRow = (sheet) => ({ name: "plate", volume: 7200, bbox: [60, 40, 3], sheet: {
  process: "laser", material: "birch plywood", thickness: 3, group: "birch plywood|3.00",
  flat: [60, 40], area: 2400, pieces: 1, customBuild: false, marksArea: null,
  bridge: 3, bridgeCapped: true, gap: 3, gapCapped: true, marksOutside: 0, solidMatchPct: null,
  at2d: { bridge: null, gap: null, marks: null }, at: { bridge: null, gap: null, marks: null },
  evaluated: true, ...sheet } });
const caseOf = (row, expect) => evaluateCase(
  { subparts: [row], aggregate: { bbox: row.bbox, volume: row.volume }, overlaps: [] },
  { profile: null, expect });
const declared = (checks, metric) => checks.find((c) => c.metric === metric && !c.volunteered);

test("the sheet metrics join the sub-part vocabulary without replacing a print metric", () => {
  expect(Object.keys(SHEET_METRICS).sort()).toEqual(["sheetBridge", "sheetGap", "sheetMarks", "sheetPieces", "sheetSolidMatch"]);
  for (const name of Object.keys(SHEET_METRICS)) {
    expect(PRINT_METRICS, `${name} collides with a print metric`).not.toContain(name);
    expect(SUBPART_METRICS[name]).toBe(SHEET_METRICS[name]);
  }
  for (const name of PRINT_METRICS) expect(Object.keys(SUBPART_METRICS)).toContain(name);
});

test("every sheet metric is a warning that names the guide section, not an ERROR-PATTERNS entry", () => {
  for (const [name, m] of Object.entries(SHEET_METRICS)) {
    expect(m.kind, name).toBe("warn");
    expect(m.doc, name).toBe("sheet-parts");
    expect(m.pattern, name).toBeUndefined();
    expect(m.hint.length, `${name} hint`).toBeLessThanOrEqual(500);
  }
  expect(Object.entries(SHEET_METRICS).filter(([, m]) => m.budgeted).map(([n]) => n).sort())
    .toEqual(["sheetBridge", "sheetGap", "sheetMarks", "sheetSolidMatch"]);
});

test("a failing sheet check carries the guide section as its pattern, and its location", () => {
  const checks = caseOf(sheetRow({ pieces: 2, bridge: 0.8, bridgeCapped: false, at: { bridge: [1, 2, 3], gap: null, marks: null } }),
    { plate: { sheetPieces: 1, sheetBridge: ">=1.5" } });
  expect(declared(checks, "sheetPieces")).toMatchObject({ status: "warn", pass: false, kind: "warn", pattern: "sheet-parts",
    hint: SUBPART_METRICS.sheetPieces.hint });
  expect(declared(checks, "sheetBridge")).toMatchObject({ status: "warn", pattern: "sheet-parts", location: [1, 2, 3] });
});

test("a capped width passes with a note saying the value is the search ceiling", () => {
  const c = declared(caseOf(sheetRow({}), { plate: { sheetBridge: ">=1.5" } }), "sheetBridge");
  expect(c).toMatchObject({ status: "pass", note: "nothing narrower than 3 mm found — the value is the search ceiling" });
  expect(c.pattern).toBeUndefined();
});
