// The sheet vocabulary (sheet/constants.js) and the process registry: the values the
// contract pins, the tiny helpers lint, the oracle and the kit share, and the one
// coupling to kernel error TEXT — EMPTY_MARK_RE must keep matching what the kernel
// actually throws for an empty mark, or empty engravings start failing builds.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import {
  SHEET_DOC_ID, AXIS_WORDS, SHEET_KEYS, SUBPART_PASSTHROUGH_KEYS, RENAMED_KEYS, RESERVED_KEYS,
  MARK_DEPTH, MARK_OVERCUT, SCORE_WIDTH, WIDTH_FLOOR_FRACTION, WIDTH_FLOOR_MIN, WIDTH_RESOLUTION,
  LOSS_TOL_MM2, SOLID_MATCH_PCT, SHEET_CHECK_BUDGET_MS, LASER_THICKNESS_RANGE, EMPTY_MARK_RE,
  isSheetPart, normalizeMaterial, sheetGroup, fmtMm, widthFloor, sheetMeta, SHEET_CHECKS_NOTICE, SHEET_READ_ERROR_HINT,
} from "../src/framework/sheet/constants.js";
import * as verifyModule from "../src/framework/oracle/verify.js";
import { PROCESSES, PROCESS_IDS, processById, processFor } from "../src/framework/process/registry.js";
import { LASER } from "../src/framework/process/laser/descriptor.js";

describe("the vocabulary", () => {
  test("keys and axis words", () => {
    expect(SHEET_DOC_ID).toBe("sheet-parts");
    expect(AXIS_WORDS).toEqual(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);
    expect(SHEET_KEYS).toEqual(["material", "thickness", "profile", "score", "engrave", "pose", "process"]);
    expect(SUBPART_PASSTHROUGH_KEYS).toEqual(["label", "views", "display", "export", "enabled", "exportable", "reference", "place"]);
    expect(RENAMED_KEYS).toEqual({ outline: "profile", cut: "profile" });
    expect(RESERVED_KEYS).toEqual(["folds", "bends", "grain"]);
  });

  test("the preview marks and the laser thresholds (mm, ms)", () => {
    expect([MARK_DEPTH, MARK_OVERCUT, SCORE_WIDTH]).toEqual([0.2, 0.1, 0.3]);
    expect([WIDTH_FLOOR_FRACTION, WIDTH_FLOOR_MIN, WIDTH_RESOLUTION]).toEqual([0.5, 0.5, 0.05]);
    expect([LOSS_TOL_MM2, SOLID_MATCH_PCT, SHEET_CHECK_BUDGET_MS]).toEqual([0.01, 2, 1500]);
    expect(LASER_THICKNESS_RANGE).toEqual([0.5, 12]);
  });

  test("widthFloor = max(0.5·t, 0.5 mm)", () => {
    expect(widthFloor(3)).toBe(1.5);
    expect(widthFloor(0.6)).toBe(0.5);
  });

  test("fmtMm: two decimals at most, no trailing zeros", () => {
    expect([fmtMm(3), fmtMm(2.7), fmtMm(3.05), fmtMm(3.14159), fmtMm(0.1 + 0.2)]).toEqual(["3", "2.7", "3.05", "3.14", "0.3"]);
  });

  test("stock groups: normalized material | thickness to 0.01 mm", () => {
    expect(normalizeMaterial("  Birch   Plywood ")).toBe("birch plywood");
    expect(sheetGroup("Birch Plywood", 3)).toBe("birch plywood|3.00");
    expect(sheetGroup("birch  plywood", 2.999)).toBe("birch plywood|3.00");
    expect(sheetGroup("MDF", 2.7)).toBe("mdf|2.70");
  });
});

describe("recognition and stock at (p, d)", () => {
  const sheet = (fields) => ({ views: ["v"], build: () => null, sheet: { process: "laser", ...fields } });

  test("isSheetPart reads plain data only", () => {
    expect(isSheetPart(sheet({ material: "ply", thickness: 3 }))).toBe(true);
    expect(isSheetPart({ build: () => null })).toBe(false);
    expect(isSheetPart({ sheet: null })).toBe(false);
    expect(isSheetPart({ sheet: { process: 3 } })).toBe(false);
    expect(isSheetPart(null)).toBe(false);
  });

  test("sheetMeta evaluates material and thickness; the material stays as authored", () => {
    const sp = sheet({ material: (p) => p.m, thickness: (p, d) => d.t });
    expect(sheetMeta(sp, { m: "Birch Plywood" }, { t: 2.7 }))
      .toEqual({ process: "laser", material: "Birch Plywood", thickness: 2.7, group: "birch plywood|2.70" });
  });

  test("sheetMeta is null for a printed part, an unusable field, or a throw", () => {
    expect(sheetMeta({ build: () => null }, {}, {})).toBeNull();
    expect(sheetMeta(sheet({ material: "", thickness: 3 }), {}, {})).toBeNull();
    expect(sheetMeta(sheet({ material: "ply", thickness: (p) => p.missing }), {}, {})).toBeNull();
    expect(sheetMeta(sheet({ material: "ply", thickness: () => { throw new Error("boom"); } }), {}, {})).toBeNull();
  });
});

describe("the process registry", () => {
  test("laser is process #1, a static descriptor", () => {
    expect(PROCESSES).toEqual([LASER]);
    expect(PROCESS_IDS).toEqual(["laser"]);
    expect(LASER).toMatchObject({
      id: "laser", label: "Laser cutting", stock: "sheet", docId: "sheet-parts",
      layers: { profile: "region", score: "line", engrave: "region" },
      reservedKeys: [],
      destinations: [{ id: "own-laser", cutFormat: "svg" }, { id: "service", cutFormat: "dxf" }],
    });
    expect(LASER.preview).toBeUndefined();          // the default sheetPreview
  });

  test("processById / processFor", () => {
    expect(processById("laser")).toBe(LASER);
    expect(processById("cnc")).toBeNull();
    expect(processFor({ sheet: { process: "laser" } })).toBe(LASER);
    expect(processFor({ sheet: { process: "cnc" } })).toBeNull();
    expect(processFor({ build: () => null })).toBeNull();   // printed
  });
});

describe("EMPTY_MARK_RE matches the kernel's own empty-mark errors (Manifold)", () => {
  let k;
  beforeAll(async () => { k = await bootManifoldKernel(); });
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const messageOf = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

  test("extruding an empty Shape2D", () => {
    const msg = messageOf(() => k.shape2d(rect(0, 0, 1, 1)).intersect(rect(5, 5, 6, 6)).extrude({ h: 1 }));
    expect(msg).toMatch(EMPTY_MARK_RE);
  });

  test("an offset that collapses the shape", () => {
    const msg = messageOf(() => k.shape2d(rect(0, 0, 1, 1)).offset(-1));
    expect(msg).toMatch(EMPTY_MARK_RE);
  });

  test("an unrelated error does not match", () => {
    expect("box: unknown option \"sizes\"").not.toMatch(EMPTY_MARK_RE);
  });
});

// The sheet checks' two standing texts live here, import-free, so the kit (which may not
// import oracle/*) repeats them from one place; verify.js re-exports the same values.
test("the sheet check texts have one home, and verify re-exports the same values", () => {
  expect(SHEET_CHECKS_NOTICE).toMatchObject({ metric: "sheetChecks", kind: "warn", pattern: SHEET_DOC_ID });
  expect(Object.isFrozen(SHEET_CHECKS_NOTICE)).toBe(true);
  expect(SHEET_READ_ERROR_HINT).toMatch(/^The 2-D laser check could not finish on this profile/);
  expect(verifyModule.SHEET_CHECKS_NOTICE).toBe(SHEET_CHECKS_NOTICE);
  expect(verifyModule.SHEET_READ_ERROR_HINT).toBe(SHEET_READ_ERROR_HINT);
});
