// The laser process's 2-D design-for-manufacture facts (process/laser/descriptor.js)
// and the oracle's use of them (oracle/measure.js). Every metric is read off a plate
// built to fire it. Widths are bisected to 0.05 mm, so an expected width is bracketed
// rather than pinned.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { sheetPart, sheetHole } from "../src/framework/geometry/polygon.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { LASER } from "../src/framework/process/laser/descriptor.js";

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
