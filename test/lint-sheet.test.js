// Sheet-part lint (src/framework/lint/rules-sheet.js and the laser descriptor's own
// rule): each rule firing, the silences that keep one cause to one finding, the two
// existing rules whose hint changes when a sheet is involved, the CLI citation, and
// the contract every sheet finding keeps — pattern "sheet-parts", a self-contained
// hint of at most 500 characters, and never the note tier.
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { lintPart, RULES } from "../src/lint.js";
import { SHEET_RULES } from "../src/framework/lint/rules-sheet.js";
import { sheetPart } from "../src/framework/geometry/polygon.js";
import laserBox from "../src/parts/laser-box.js";

const SHEET_IDS = ["sheet-invalid", "sheet-thickness-invalid", "sheet-pose-invalid", "sheet-thickness-literal",
  "sheet-kerf-control", "sheet-custom-build", "verify-process-sheets-only", "laser-thickness-range"];
const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const panel = (extra = {}) => sheetPart({
  views: ["main"], label: "Panel", material: "birch plywood", thickness: (p) => p.t,
  profile: (k, p) => k.shape2d(rect(p.w, p.h)), ...extra,
});
const control = (key, label) => ({ key, label, unit: "mm", min: 0, max: 300, step: 0.05, description: `${label}.` });
const STOCK = { id: "stock", title: "Stock", description: "Measure your sheet.", controls: [
  control("t", "Sheet thickness"), control("w", "Width"), control("h", "Height"),
] };
const partWith = (parts, extra = {}) => ({
  meta: { title: "Sheet lint", units: "mm" }, parameters: [STOCK],
  defaults: { t: 3, w: 100, h: 60 }, parts, views: { main: { label: "Main" } }, ...extra,
});
const all = (r) => [...r.errors, ...r.warnings, ...r.notes];
const sheetFindings = (r) => all(r).filter((f) => SHEET_IDS.includes(f.rule));
const one = (r, rule) => {
  const hits = all(r).filter((f) => f.rule === rule);
  expect(hits, `${rule}: ${JSON.stringify(all(r).map((f) => f.rule))}`).toHaveLength(1);
  return hits[0];
};
// A hand-edited copy of a sheetPart() sub-part whose declaration differs by `sheet`.
const edited = (sheet, sp = panel()) => ({ ...sp, sheet: { ...sp.sheet, ...sheet } });
const withStock = (...controls) => ({ parameters: [{ ...STOCK, controls: [...STOCK.controls, ...controls] }] });

// Parts that each fire one sheet rule — shared by the per-rule tests and the
// finding-contract test at the end.
const FIRING = {
  "sheet-invalid": () => partWith({ panel: edited({ material: 42 }) }),
  "sheet-thickness-invalid": () => partWith({ panel: panel({ thickness: (p) => p.t - 3 }) }),
  "sheet-pose-invalid": () => partWith({ panel: panel({ pose: () => ({ face: "+Y", up: "+Y", at: [0, 0, 0] }) }) }),
  "sheet-thickness-literal": () => partWith({ panel: panel({ thickness: 3 }) }),
  "sheet-kerf-control": () => partWith({ panel: panel() }, withStock(control("kerf", "Kerf"))),
  "sheet-custom-build": () => partWith({ panel: { ...panel(), build: (k) => k.box({ size: [10, 10, 3] }) } }),
  "verify-process-sheets-only": () => partWith({ panel: panel() }, { verify: { process: "fdm-pla" } }),
  "laser-thickness-range": () => ({ ...partWith({ panel: panel() }), defaults: { t: 0.3, w: 100, h: 60 } }),
};

test("SHEET_RULES registers the seven sheet rules and the laser rule, in the lint registry", () => {
  expect(SHEET_RULES.map((r) => r.id)).toEqual(SHEET_IDS);
  for (const id of SHEET_IDS) expect(RULES.map((r) => r.id)).toContain(id);
});

test("a clean sheet part, and laser-box.js, draw no sheet finding", () => {
  expect(sheetFindings(lintPart(partWith({ panel: panel() })))).toEqual([]);
  const box = lintPart(laserBox);
  expect(sheetFindings(box)).toEqual([]);
  expect(box.errors).toEqual([]);
});

test("sheet-invalid: a malformed hand-edited declaration is one error, and the value rules stand down", () => {
  const r = lintPart(FIRING["sheet-invalid"]());
  expect(one(r, "sheet-invalid")).toMatchObject({ severity: "error", path: "parts.panel.sheet",
    message: 'sub-part "panel" has a malformed `sheet` declaration: material must be a non-empty string or a (p, d) => string function' });
  expect(sheetFindings(r).map((f) => f.rule)).toEqual(["sheet-invalid"]);
  expect(one(lintPart(partWith({ panel: edited({ process: "cnc" }) })), "sheet-invalid").message)
    .toBe('sub-part "panel" has a malformed `sheet` declaration: process must be one of: laser');
});

test("sheet-invalid skips a sub-part with no build: no-buildable-parts owns it, with the sheet hint", () => {
  const r = lintPart(partWith({ panel: { views: ["main"], label: "Panel", sheet: { process: "laser", material: "ply", thickness: 3 } } }));
  expect(all(r).map((f) => f.rule)).not.toContain("sheet-invalid");
  expect(one(r, "no-buildable-parts")).toMatchObject({ pattern: "sheet-parts",
    hint: "Every entry in `parts` needs a `build(k, p, d)` function that returns a solid. For a laser-cut flat part, wrap the whole sub-part in `sheetPart({ … })` from partforge/geometry — it supplies build and place." });
  const plain = one(lintPart(partWith({ panel: { views: ["main"] } })), "no-buildable-parts");
  expect(plain.hint).toBe("Every entry in `parts` needs a `build(k, p, d)` function that returns a solid.");
  expect(plain.pattern).toBeUndefined();
});

test("sheet-thickness-invalid: zero, and a throw, at the defaults — one sheet finding each", () => {
  const zero = lintPart(FIRING["sheet-thickness-invalid"]());
  expect(one(zero, "sheet-thickness-invalid")).toMatchObject({
    severity: "error", path: "parts.panel.sheet.thickness",
    message: 'sub-part "panel": sheet thickness is 0 at the defaults — it must be a finite number above 0 (mm)' });
  // One cause, one finding: not also laser-thickness-range ("0 mm is outside 0.5–12 mm")
  // or sheet-thickness-literal.
  expect(sheetFindings(zero).map((f) => f.rule)).toEqual(["sheet-thickness-invalid"]);
  const threw = lintPart(partWith({ panel: panel({ thickness: (p, d) => d.stock.t }) }));
  expect(one(threw, "sheet-thickness-invalid").message).toMatch(/^sub-part "panel": sheet thickness threw at the defaults: /);
  expect(sheetFindings(threw).map((f) => f.rule)).toEqual(["sheet-thickness-invalid"]);
});

test("sheet-pose-invalid: up parallel to face", () => {
  const f = one(lintPart(FIRING["sheet-pose-invalid"]()), "sheet-pose-invalid");
  expect(f).toMatchObject({ severity: "error", path: "parts.panel.sheet.pose",
    message: 'sub-part "panel": sheet pose is invalid at the defaults — up (+Y) must be perpendicular to face (+Y)' });
  expect(f.hint).toContain('{ face: "-Y", up: "+Z", at: [-W/2, -D/2, 0] }');
});

test("sheet-thickness-literal: a number, or a function that reads nothing; silent when it reads a control", () => {
  expect(one(lintPart(FIRING["sheet-thickness-literal"]()), "sheet-thickness-literal")).toMatchObject({
    severity: "warning", path: "parts.panel.sheet.thickness", message: 'sub-part "panel": sheet thickness is a fixed number (3 mm)' });
  expect(one(lintPart(partWith({ panel: panel({ thickness: () => 2.7 }) })), "sheet-thickness-literal").message)
    .toBe('sub-part "panel": sheet thickness is a fixed number (2.7 mm)');
  const viaDerive = partWith({ panel: panel({ thickness: (p, d) => d.t }) }, { derive: (p) => ({ t: p.t }) });
  expect(all(lintPart(viaDerive)).map((f) => f.rule)).not.toContain("sheet-thickness-literal");
});

test("sheet-kerf-control: by key or by label, only in a forge with a sheet part", () => {
  expect(one(lintPart(FIRING["sheet-kerf-control"]()), "sheet-kerf-control")).toMatchObject({
    severity: "warning", path: "parameters[0].controls[3]", message: 'control "kerf" looks like a kerf setting' });
  expect(one(lintPart(partWith({ panel: panel() }, withStock(control("k", "Laser kerf")))), "sheet-kerf-control").message)
    .toBe('control "k" looks like a kerf setting');
  const printedOnly = partWith({ body: { views: ["main"], build: (k) => k.box({ size: [10, 10, 10] }) } }, withStock(control("kerf", "Kerf")));
  expect(all(lintPart(printedOnly)).map((f) => f.rule)).not.toContain("sheet-kerf-control");
});

test("sheet-custom-build: a build that replaced the generated one", () => {
  expect(one(lintPart(FIRING["sheet-custom-build"]()), "sheet-custom-build")).toMatchObject({
    severity: "warning", path: "parts.panel.build", message: 'sub-part "panel" replaces the build sheetPart generated' });
});

test("verify-process-sheets-only: a print profile on an all-sheet forge; silent with a printed part", () => {
  expect(one(lintPart(FIRING["verify-process-sheets-only"]()), "verify-process-sheets-only")).toMatchObject({
    severity: "warning", path: "verify.process", message: '`verify.process` is "fdm-pla", but every exportable part is a sheet part' });
  const mixed = partWith({ panel: panel(), hinge: { views: ["main"], build: (k) => k.box({ size: [10, 10, 10] }) } }, { verify: { process: "fdm-pla" } });
  expect(all(lintPart(mixed)).map((f) => f.rule)).not.toContain("verify-process-sheets-only");
});

test('verify.process "laser" is one error with the sheet hint — not also the sheets-only warning', () => {
  const r = lintPart(partWith({ panel: panel() }, { verify: { process: "laser" } }));
  expect(one(r, "verify-unknown-process")).toMatchObject({ pattern: "sheet-parts",
    message: '`verify.process` names "laser", which is not a known DFM profile',
    hint: 'Laser-cut parts need no profile: build them with `sheetPart()` and the laser checks apply automatically (see "Sheet parts" in the authoring guide). verify.process is for 3D-printed parts — use one of: fdm-pla, fdm-petg, resin.' });
  expect(all(r).map((f) => f.rule)).not.toContain("verify-process-sheets-only");
});

test("laser-thickness-range: below 0.5 and above 12 mm", () => {
  expect(one(lintPart(FIRING["laser-thickness-range"]()), "laser-thickness-range")).toMatchObject({
    severity: "warning", path: "parts.panel.sheet.thickness",
    message: 'sub-part "panel": laser sheet thickness 0.3 mm is outside 0.5–12 mm' });
  const thick = { ...partWith({ panel: panel() }), defaults: { t: 15, w: 100, h: 60 } };
  expect(one(lintPart(thick), "laser-thickness-range").message).toBe('sub-part "panel": laser sheet thickness 15 mm is outside 0.5–12 mm');
});

test("recognition is plain data: a copied declaration, and one written without sheetPart(), are judged the same", () => {
  const sp = panel({ thickness: 3 });
  const copy = { ...sp, sheet: { ...sp.sheet } };
  expect(sheetFindings(lintPart(partWith({ panel: copy })))).toEqual(sheetFindings(lintPart(partWith({ panel: sp }))));
  // Written without sheetPart() at all: a plain object whose `sheet` is plain data.
  const handWritten = { views: ["main"], build: sp.build, sheet: { ...sp.sheet } };
  expect(sheetFindings(lintPart(partWith({ panel: handWritten }))).map((f) => f.rule))
    .toEqual(["sheet-thickness-literal"]);
  const handBuilt = { ...handWritten, build: (k) => k.box({ size: [100, 60, 3] }) };
  expect(sheetFindings(lintPart(partWith({ panel: handBuilt }))).map((f) => f.rule))
    .toEqual(["sheet-thickness-literal", "sheet-custom-build"]);
});

test("every sheet finding: pattern sheet-parts, a hint of at most 500 characters, error or warning", () => {
  for (const [rule, make] of Object.entries(FIRING)) {
    const f = one(lintPart(make()), rule);
    expect(f.pattern, rule).toBe("sheet-parts");
    expect(f.hint.length, rule).toBeLessThanOrEqual(500);
    expect(["error", "warning"], rule).toContain(f.severity);
  }
});

test("partforge lint cites a sheet finding's pattern as the guide section", () => {
  const out = execFileSync(process.execPath, ["bin/cli.js", "lint", "test/fixtures/sheet-plate-part.js"], { encoding: "utf8" });
  expect(out).toContain("sheet-kerf-control");
  expect(out).toContain('(AUTHORING-PARTS.md "Sheet parts")');
  expect(out).not.toContain("ERROR-PATTERNS.md#sheet-parts");
});
