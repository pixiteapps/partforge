// Verify's scoping for forges with sheet parts (sheet parts spec C.5). The process
// bed fits each PRINTED part in its print pose instead of the assembled view; min
// wall and overhang skip sheets; the laser checks are volunteered — warnings that
// never count toward declared/evaluated, so they never set verify.ok on their own.
// A forge with no sheet part is test/verify-golden.test.js's business.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { SUBPART_METRICS } from "../src/framework/verify-metrics.js";
import { sheetPart } from "../src/framework/geometry/polygon.js";
import laserBox from "../src/parts/laser-box.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// A w × h plate of 3 mm stock lying flat on the floor (no pose: z 0 to 3).
const plate = (w, h, extra = {}) => sheetPart({
  views: ["v"], label: "Plate", material: "birch plywood", thickness: (p) => p.t,
  profile: (kk) => kk.shape2d(rect(0, 0, w, h)), ...extra,
});
// A 60 × 40 plate whose two square holes leave a 0.8 mm web.
const webbed = () => plate(60, 40, { profile: (kk) => kk.shape2d({ outer: rect(0, 0, 60, 40), holes: [rect(10, 15, 20, 25), rect(20.8, 15, 30.8, 25)] }) });
// A printed box from the origin to `max`, optionally placed.
const printed = (max, place) => ({ views: ["v"], label: "Printed", build: (kk) => kk.box({ min: [0, 0, 0], max }), ...(place ? { place } : {}) });
// A rod printed standing up (10 × 10 × h) but displayed lying along X on the plate.
const rod = (h) => printed([10, 10, h], (s, { purpose }) =>
  (purpose === "export" ? s : s.rotate(90, [0, 0, 0], [0, 1, 0]).translate([0, 0, 13])));
const forge = (parts, verifyBlock) => ({
  meta: { title: "Scoping", units: "mm" }, defaults: { t: 3 }, parts, views: { v: { label: "V" } },
  ...(verifyBlock ? { verify: verifyBlock } : {}),
});
const checksOf = (v) => v.cases.flatMap((c) => c.checks);
const on = (v, subpart, metric) => checksOf(v).filter((c) => c.subpart === subpart && c.metric === metric);
// measure() with no 2-D budget at all, for verify's measureFn.
const noBudget = (kk, part, view, params, opts) => measure(kk, part, view, params, { ...opts, sheetBudgetMs: 0 });
// measure() on a stopped clock: the 2-D budget never runs out, so no assertion here
// rides on a runner being fast enough (the cost pre-gate still applies). Every verify
// below that is not about the budget measures this way.
const unhurried = (kk, part, view, params, opts) => measure(kk, part, view, params, { ...opts, now: () => 0 });
const verifyUnhurried = (kk, part, opts = {}) => verify(kk, part, { measureFn: unhurried, ...opts });

test("a 300 mm plate beside a small printed block passes the FDM bed: the bed fits the printed part", () => {
  const v = verifyUnhurried(k, forge({ plate: plate(300, 300), block: printed([20, 20, 20], (s) => s.translate([140, 140, 3])) },
    { process: "fdm-pla", expect: { _view: { overlaps: 0 } } }));
  expect(v.ok).toBe(true);
  expect(v.failures).toEqual([]);
  expect(checksOf(v).filter((c) => c.scope === "view" && c.metric === "bbox")).toEqual([]);
  expect(on(v, "block", "bbox")[0]).toMatchObject({ status: "pass", expr: "<=[220,220,250]", note: "measured in the print (export) pose" });
  expect(on(v, "plate", "bbox")).toEqual([]);
  expect(on(v, "plate", "minWall")).toEqual([]);
});

test("the same plate as a printed part still fails the view bed — scoping is for sheet parts only", () => {
  const v = verifyUnhurried(k, forge({ plate: printed([300, 300, 3]), block: printed([20, 20, 20], (s) => s.translate([140, 140, 3])) },
    { process: "fdm-pla", expect: { _view: { overlaps: 0 } } }));
  expect(v.ok).toBe(false);
  expect(v.failures.map((c) => `${c.scope}:${c.metric}`)).toContain("view:bbox");
});

test("a sheet-only forge with no verify block stays ok: null with the notice; its laser checks are volunteered", () => {
  const v = verifyUnhurried(k, forge({ plate: plate(60, 40) }));
  expect(v).toMatchObject({ ok: null, declared: 0, evaluated: 0 });
  expect(v.warnings.find((c) => c.scope === "part")).toMatchObject({ message: "no expectations declared" });
  const volunteered = checksOf(v).filter((c) => c.volunteered);
  expect(volunteered.map((c) => c.metric).sort()).toEqual(["sheetBridge", "sheetGap", "sheetMarks", "sheetPieces"]);
  expect(volunteered.every((c) => c.status === "pass" && c.kind === "warn")).toBe(true);
});

test("a long printed part displayed lying down is bed-checked standing up, as it prints", () => {
  const v = verifyUnhurried(k, forge({ plate: plate(300, 60), rod: rod(240) },
    { process: "fdm-pla", expect: { rod: { bbox: "<=[250,20,20]" } } }));
  expect(v.ok).toBe(true);
  const [bed, own] = on(v, "rod", "bbox");
  expect(bed).toMatchObject({ status: "pass", expr: "<=[220,220,250]", note: "measured in the print (export) pose" });
  expect(own).toMatchObject({ status: "pass", expr: "<=[250,20,20]" });   // the author's own bbox reads the display pose
  expect(own.note).toBeUndefined();
});

test("a printed part too tall for the bed in its print pose fails, saying where it was measured", () => {
  const v = verifyUnhurried(k, forge({ plate: plate(300, 60), rod: rod(260) }, { process: "fdm-pla" }));
  expect(v.ok).toBe(false);
  expect(v.failures[0]).toMatchObject({ subpart: "rod", metric: "bbox", note: "measured in the print (export) pose" });
});

test("a failing volunteered check warns, points at the guide and a 3-D spot, and never counts", () => {
  const v = verifyUnhurried(k, forge({ plate: webbed() }, { expect: { _view: { overlaps: 0 } } }));
  expect(v).toMatchObject({ ok: true, declared: 1, evaluated: 1 });
  const bridge = v.warnings.find((c) => c.metric === "sheetBridge");
  expect(bridge).toMatchObject({ volunteered: true, status: "warn", kind: "warn", pattern: "sheet-parts" });
  expect(bridge.location).toHaveLength(3);
  expect(bridge.location.every(Number.isFinite)).toBe(true);
});

test("a declared sheet check counts like any other expectation", () => {
  const v = verifyUnhurried(k, forge({ plate: webbed() }, { expect: { plate: { sheetBridge: ">=1.5" } } }));
  expect(v).toMatchObject({ ok: true, declared: 1, evaluated: 1 });     // a warn never fails a gate
  const [c] = on(v, "plate", "sheetBridge");
  expect(c.volunteered).toBeUndefined();
  expect(c.status).toBe("warn");
});

// Spec H: each laser metric fires on a plate built to fail it, as a volunteered
// warning that points at the guide — located in the assembly (a finite 3-vector)
// wherever the metric has a spot — and none of them moves ok off null.
test("each laser check fires as a volunteered warning on a plate built to fail it", () => {
  const FAILING = {
    sheetBridge: webbed(),
    sheetGap: plate(60, 40, { profile: (kk) => kk.shape2d({ outer: rect(0, 0, 60, 40), holes: [rect(20, 19.7, 40, 20.3)] }) }),
    sheetMarks: plate(60, 40, { engrave: (kk) => kk.shape2d(rect(55, 5, 70, 15)) }),
    sheetPieces: plate(60, 40, { profile: (kk) => kk.shape2d(rect(0, 0, 20, 20)).union(rect(30, 0, 50, 20)) }),
    sheetSolidMatch: { ...plate(60, 40), build: (kk) => kk.box({ min: [0, 0, 0], max: [60, 40, 6] }) },
  };
  for (const [metric, sp] of Object.entries(FAILING)) {
    const v = verifyUnhurried(k, forge({ plate: sp }));
    const c = v.warnings.find((w) => w.metric === metric);
    expect(c, metric).toMatchObject({ subpart: "plate", volunteered: true, status: "warn", kind: "warn", pattern: "sheet-parts" });
    if (SUBPART_METRICS[metric].locate) {
      expect(c.location, metric).toHaveLength(3);
      expect(c.location.every(Number.isFinite), metric).toBe(true);
    }
    expect(v.ok, metric).toBeNull();
  }
});

test("past the 2-D budget: one sheetChecks notice per sheet, and the verdict is untouched", () => {
  const v = verify(k, forge({ plate: plate(60, 40) }), { measureFn: noBudget });
  expect(on(v, "plate", "sheetChecks")).toEqual([expect.objectContaining({
    scope: "subpart", kind: "warn", status: "warn", pass: null, volunteered: true, pattern: "sheet-parts",
    message: "2-D sheet checks not evaluated (time budget)" })]);
  expect(on(v, "plate", "sheetBridge")).toEqual([]);
  expect(on(v, "plate", "sheetPieces")[0]).toMatchObject({ volunteered: true, status: "pass" });
  expect(v.unevaluated).toEqual([]);
  expect(v.ok).toBeNull();
});

test("past the 2-D budget a DECLARED sheet check is unevaluated, which withholds the verdict", () => {
  const v = verify(k, forge({ plate: plate(60, 40) }, { expect: { plate: { sheetBridge: ">=1.5" } } }), { measureFn: noBudget });
  expect(on(v, "plate", "sheetBridge")[0]).toMatchObject({ status: "skip", pass: null, unevaluated: true, message: "not evaluated (2-D check budget)" });
  expect(v.unevaluated).toHaveLength(1);
  expect(v.ok).toBeNull();
});

test("laser-box.js verifies: hinges fit the bed as printed, no laser warning", () => {
  const v = verifyUnhurried(k, laserBox);
  expect(v.failures).toEqual([]);
  expect(v.ok).toBe(true);
  for (const hinge of ["hingeL", "hingeR"]) expect(on(v, hinge, "bbox")[0]).toMatchObject({ status: "pass", note: "measured in the print (export) pose" });
  expect(v.warnings.filter((c) => c.volunteered)).toEqual([]);
});

test("recognition is plain data: a copied declaration measures and verifies the same", () => {
  const sp = webbed();
  const copy = { ...sp, sheet: { ...sp.sheet } };
  expect(unhurried(k, forge({ plate: copy })).subparts[0].sheet).toEqual(unhurried(k, forge({ plate: sp })).subparts[0].sheet);
  expect(checksOf(verifyUnhurried(k, forge({ plate: copy })))).toEqual(checksOf(verifyUnhurried(k, forge({ plate: sp }))));
});
