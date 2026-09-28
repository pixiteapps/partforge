// The laser process's 2-D design-for-manufacture facts (process/laser/descriptor.js)
// and the oracle's use of them (oracle/measure.js). Every metric is read off a plate
// built to fire it. Widths are bisected to 0.05 mm, so an expected width is bracketed
// rather than pinned.
import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { bootManifoldKernel } from "../src/testing.js";
import { sheetPart, sheetHole } from "../src/framework/geometry/polygon.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { LASER } from "../src/framework/process/laser/descriptor.js";
import { measure } from "../src/framework/oracle/measure.js";
import { sheetToWorld } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const PLATE = rect(0, 0, 60, 40);
// Two 10 mm square holes leaving a 0.8 mm web at x 20–20.8.
const WEB = { outer: PLATE, holes: [rect(10, 15, 20, 25), rect(20.8, 15, 30.8, 25)] };
// A 20 × 0.6 mm slot centred at (30, 20).
const SLOT = { outer: PLATE, holes: [rect(20, 19.7, 40, 20.3)] };
const P = { t: 3 };
// A 60 × 40 plate of 3 mm stock: floor 1.5 mm, search ceiling 3 mm.
const plate = (extra = {}) => sheetPart({
  views: ["v"], label: "Plate", material: "birch plywood", thickness: (p) => p.t,
  profile: (kk) => kk.shape2d(PLATE), ...extra,
});
const factsOf = (sp, opts) => LASER.facts(resolveSheet(k, sp, P, {}), opts);

describe("LASER.facts", () => {
  test("a plain plate: the always-read facts, and nothing narrower than the ceiling", () => {
    const f = factsOf(plate());
    expect(f).toMatchObject({
      process: "laser", material: "birch plywood", thickness: 3, group: "birch plywood|3.00",
      pieces: 1, customBuild: false, marksArea: null, marksOutside: 0,
      bridge: 3, bridgeCapped: true, gap: 3, gapCapped: true, solidMatchPct: null, evaluated: true,
      at2d: { bridge: null, gap: null, marks: null }, at: { bridge: null, gap: null, marks: null },
    });
    expect(f.flat[0]).toBeCloseTo(60, 6);
    expect(f.flat[1]).toBeCloseTo(40, 6);
    expect(f.area).toBeCloseTo(2400, 6);
  });

  test("a 0.8 mm web reads as a 0.8 mm bridge, located at the web", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(WEB) }));
    expect(f.bridgeCapped).toBe(false);
    expect(f.bridge).toBeGreaterThan(0.79);
    expect(f.bridge).toBeLessThanOrEqual(0.85);
    expect(f.at2d.bridge[0]).toBeCloseTo(20.4, 1);
    expect(f.at2d.bridge[1]).toBeCloseTo(20, 1);
    expect(f.gapCapped).toBe(true);          // the holes themselves are 10 mm across
  });

  test("a 0.6 mm slot reads as a 0.6 mm gap, located at the slot", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(SLOT) }));
    expect(f.gapCapped).toBe(false);
    expect(f.gap).toBeGreaterThan(0.59);
    expect(f.gap).toBeLessThanOrEqual(0.65);
    expect(f.at2d.gap[0]).toBeCloseTo(30, 1);
    expect(f.at2d.gap[1]).toBeCloseTo(20, 1);
    expect(f.bridgeCapped).toBe(true);
  });

  test("an arc-exact hole cut with cutAll reads clean — no false web or gap", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(PLATE).cutAll([sheetHole({ d: 10, at: [30, 20] })]) }));
    expect(f.bridgeCapped).toBe(true);
    expect(f.gapCapped).toBe(true);
  });

  test("marks outside the cut are counted and located", () => {
    const f = factsOf(plate({
      engrave: (kk) => kk.shape2d(rect(55, 5, 70, 15)),   // 10 × 10 of it hangs off the right edge
      score: () => [[[-10, 5], [-2, 5]]],                 // entirely off the plate
    }));
    expect(f.marksOutside).toBe(2);
    expect(f.at2d.marks[0]).toBeCloseTo(65, 1);           // the larger stray: the engrave's overhang
    expect(f.at2d.marks[1]).toBeCloseTo(10, 1);
  });

  test("marks inside the cut count zero and have no location", () => {
    const f = factsOf(plate({ engrave: (kk) => kk.shape2d(rect(10, 10, 20, 20)), score: () => [[[5, 30], [55, 30]]] }));
    expect(f.marksOutside).toBe(0);
    expect(f.at2d.marks).toBeNull();
  });

  test("a profile of two regions reads as two pieces", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 20, 20)).union(rect(30, 0, 50, 20)) }));
    expect(f.pieces).toBe(2);
  });

  test("a custom build gets marksArea: the marks inside the cut", () => {
    const sp = plate({ engrave: (kk) => kk.shape2d(rect(10, 10, 20, 20)) });
    const f = factsOf({ ...sp, build: (kk) => kk.box({ min: [0, 0, 0], max: [60, 40, 3] }) });
    expect(f.customBuild).toBe(true);
    expect(f.marksArea).toBeCloseTo(100, 6);
  });

  test("past the deadline the gated readings are withheld and the always-read ones stay", () => {
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(WEB) }), { deadline: Date.now() - 1 });
    expect(f).toMatchObject({ evaluated: false, bridge: null, gap: null, marksOutside: null, marksArea: null, pieces: 1 });
    expect(f.area).toBeCloseTo(2400 - 200, 6);
  });
});

describe("LASER.checks", () => {
  test("3 mm stock: the floor is half the thickness", () => {
    expect(LASER.checks(factsOf(plate()))).toEqual({ sheetBridge: ">=1.5", sheetGap: ">=1.5", sheetMarks: "0", sheetPieces: "1" });
  });

  test("thin stock floors at 0.5 mm; a custom build adds the solid match", () => {
    const f = { ...factsOf(plate()), thickness: 0.8, customBuild: true };
    expect(LASER.checks(f)).toEqual({ sheetBridge: ">=0.5", sheetGap: ">=0.5", sheetMarks: "0", sheetPieces: "1", sheetSolidMatch: "<=2" });
  });
});

const forge = (parts, extra = {}) => ({ meta: { title: "DFM", units: "mm" }, defaults: { t: 3 }, parts, views: { v: { label: "V" } }, ...extra });
const printed = (max, place) => ({ views: ["v"], label: "Printed", build: (kk) => kk.box({ min: [0, 0, 0], max }), ...(place ? { place } : {}) });
const row = (r, name) => r.subparts.find((s) => s.name === name);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
// A rod printed standing up but displayed lying along X, on top of a 3 mm plate.
const rod = (h) => printed([10, 10, h], (s, { purpose }) =>
  (purpose === "export" ? s : s.rotate(90, [0, 0, 0], [0, 1, 0]).translate([0, 0, 13])));

describe("measure() on sheet parts", () => {
  test("a view with no sheet part: rows carry sheet: null and no printBbox", () => {
    const r = measure(k, forge({ block: printed([10, 10, 10]) }));
    expect(row(r, "block").sheet).toBeNull();
    expect("printBbox" in row(r, "block")).toBe(false);
  });

  test("a sheet row carries its facts; a printed row beside it gets its print-pose size", () => {
    const r = measure(k, forge({ plate: plate(), rod: rod(240) }));
    expect(row(r, "plate").sheet).toMatchObject({ process: "laser", thickness: 3, pieces: 1, evaluated: true });
    expect("printBbox" in row(r, "plate")).toBe(false);
    expect(row(r, "rod").sheet).toBeNull();
    expect(row(r, "rod").bbox[0]).toBeCloseTo(240, 3);       // displayed lying down
    expect(row(r, "rod").printBbox[2]).toBeCloseTo(240, 3);  // printed standing up
  });

  test("a finding's location is lifted into the assembly at mid-thickness", () => {
    const pose = { face: "-Y", up: "+Z", at: [0, 0, 0] };
    const f = row(measure(k, forge({ plate: plate({ profile: (kk) => kk.shape2d(WEB), pose }) })), "plate").sheet;
    expect(isVec3(f.at.bridge)).toBe(true);
    const want = sheetToWorld(pose, f.at2d.bridge, 1.5);
    f.at.bridge.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
    expect(f.at.gap).toBeNull();                               // capped: nothing to locate
  });

  test("a pose the probe cannot trust withholds the 3-D location, never the reading", () => {
    const sp = plate({ profile: (kk) => kk.shape2d(WEB), place: (s) => s.translate([0, 0, s.boundingBox().max[2]]) });
    const f = row(measure(k, forge({ plate: sp })), "plate").sheet;
    expect(f.bridgeCapped).toBe(false);
    expect(f.at2d.bridge).not.toBeNull();
    expect(f.at.bridge).toBeNull();
  });

  test("a custom build's volume is compared with profile area × thickness", () => {
    const sp = plate();
    const r = measure(k, forge({ plate: { ...sp, build: (kk) => kk.box({ min: [0, 0, 0], max: [60, 40, 6] }) } }));
    expect(row(r, "plate").sheet.solidMatchPct).toBeCloseTo(100, 3);   // 14400 mm³ against 7200
  });

  test("sheet rows skip the print passes: no min-wall rays, no overhang", () => {
    const part = forge({ plate: plate(), block: printed([10, 10, 10], (s) => s.translate([20, 20, 3])) },
      { verify: { process: "fdm-pla", orientation: "print" } });
    const r = measure(k, part, "v", {}, { minWall: true });
    expect(row(r, "plate")).toMatchObject({ minWall: null, minWallSamples: null, overhangArea: null });
    expect(row(r, "block").minWall).toBeGreaterThan(0);
    expect(row(r, "block").overhangArea).not.toBeNull();
  });

  test("past the 2-D budget every sheet reads evaluated: false and the report still comes back", () => {
    const r = measure(k, forge({ a: plate(), b: plate({ pose: { face: "+Z", up: "+Y", at: [100, 0, 3] } }) }),
      "v", {}, { sheetBudgetMs: 0 });
    for (const name of ["a", "b"]) expect(row(r, name).sheet).toMatchObject({ evaluated: false, bridge: null, pieces: 1 });
    expect(r.subparts).toHaveLength(2);
  });

  // Spec C.6: the 2-D checks are cheap, so a quick lap (no min-wall rays, no pair
  // distances — the inspect job's `checks: "quick"`) still reads them.
  test("a quick lap still reads the 2-D facts", () => {
    const r = measure(k, forge({ plate: plate({ profile: (kk) => kk.shape2d(WEB) }) }), "v", {}, { minWall: false, gaps: false });
    expect(row(r, "plate").sheet).toMatchObject({ evaluated: true, bridgeCapped: false });
    expect(row(r, "plate").sheet.bridge).toBeLessThanOrEqual(0.85);
  });
});

test("partforge measure prints a sheet line under a sheet sub-part", () => {
  const out = execFileSync(process.execPath, ["bin/cli.js", "measure", "test/fixtures/sheet-plate-part.js", "--no-lint"], { encoding: "utf8" });
  expect(out).toContain("    sheet  birch plywood 3 mm, flat 120.0 × 80.0 mm, 1 piece\n");
});
