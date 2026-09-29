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
import { verify } from "../src/framework/oracle/verify.js";
import { sheetToWorld } from "../src/framework/geometry/polygon.js";
import { lintPart } from "../src/lint.js";
import twelvePanel from "./fixtures/sheet-twelve-panel-part.js";
import perforated from "./fixtures/sheet-perforated-panel-part.js";
import screwPlate from "./fixtures/sheet-screw-plate-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// An arc-exact rounded rectangle (quarter arcs as `via` segments, like sheetHole's).
const roundedRect = (x0, y0, x1, y1, r) => {
  const c = r * (1 - Math.SQRT1_2);
  return { start: [x0 + r, y0], segments: [
    { to: [x1 - r, y0] }, { to: [x1, y0 + r], via: [x1 - c, y0 + c] },
    { to: [x1, y1 - r] }, { to: [x1 - r, y1], via: [x1 - c, y1 - c] },
    { to: [x0 + r, y1] }, { to: [x0, y1 - r], via: [x0 + c, y1 - c] },
    { to: [x0, y0 + r] }, { to: [x0 + r, y0], via: [x0 + c, y0 + c] }] };
};
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

  // Rounded corners elsewhere on the panel must not hide a real web or slot. With sharp
  // offsets a small convex fillet comes back as a square corner OUTSIDE the profile, and
  // a small hole-corner fillet comes back square INSIDE the hole — each the opposite sign
  // of what the test measures, so a net area change let the artifact cancel the finding.
  test("a filleted outline does not hide a 0.8 mm bridge elsewhere on the plate", () => {
    const holes = [rect(10, 15, 20, 25), rect(20.8, 24, 30.8, 34)];   // a 0.8 × 1 mm bridge at x 20–20.8, y 24–25
    for (const r of [1, 1.4]) {
      const f = factsOf(plate({ profile: (kk) => kk.shape2d(PLATE).fillet(r).cut(kk.shape2d(holes[0])).cut(kk.shape2d(holes[1])) }));
      expect(f.bridgeCapped, `outline fillet r=${r}`).toBe(false);
      expect(f.bridge).toBeGreaterThan(0.79);
      expect(f.bridge).toBeLessThanOrEqual(0.85);
      expect(f.at2d.bridge[0]).toBeCloseTo(20.4, 0);
      expect(f.at2d.bridge[1]).toBeCloseTo(24.5, 0);
    }
  });

  test("rounded-rect holes do not hide a 0.9 mm slot elsewhere on the plate", () => {
    const f = factsOf(plate({ profile: (kk) => {
      let s = kk.shape2d(rect(0, 0, 100, 60)).cut(kk.shape2d(rect(40, 30, 43, 30.9)));   // a 3 × 0.9 mm slot
      for (let i = 0; i < 2; i++) s = s.cut(kk.shape2d(roundedRect(5 + i * 11, 5, 13 + i * 11, 13, 1.4)));
      return s;
    } }));
    expect(f.gapCapped).toBe(false);
    expect(f.gap).toBeGreaterThan(0.89);
    expect(f.gap).toBeLessThanOrEqual(0.95);
    expect(f.at2d.gap[0]).toBeCloseTo(41.5, 0);
    expect(f.at2d.gap[1]).toBeCloseTo(30.45, 0);
  });

  // The offset engine approximates a cubic within OFFSET_TOL, leaving hundreds of
  // sub-tolerance slivers along filleted corners. Summed — by the net area change, or by
  // a one-sided difference's total — they crossed LOSS_TOL_MM2 and read three 8 mm
  // rounded holes as a 2.91 mm gap. A loss or gain is one region above the tolerance.
  test("approximation slivers along filleted holes are not a gap", () => {
    const f = factsOf(plate({ profile: (kk) => {
      let s = kk.shape2d(rect(0, 0, 100, 60));
      for (let i = 0; i < 3; i++) s = s.cut(kk.shape2d(rect(5 + i * 11, 5, 13 + i * 11, 13)).fillet(2.5));
      return s;
    } }));
    expect(f.gapCapped).toBe(true);          // the holes are 8 mm across; nothing narrower
  });

  // paper's boolean can refuse a difference the offsets produced ("curve-fill: resolved
  // hole has no containing outer"). The one-sided test then falls back to the net area
  // change it replaced — never a lost reading — and the finding goes unlocated.
  test("a one-sided difference the engine refuses falls back to the net area change", () => {
    const refusing = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "cut") return () => { throw new Error("curve-fill: resolved hole has no containing outer"); };
      if (key === "offset") return (...a) => refusing(target.offset(...a));
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const refused = (sp) => { const s = resolveSheet(k, sp, P, {}); return LASER.facts({ ...s, profile: refusing(s.profile) }); };
    const web = refused(plate({ profile: (kk) => kk.shape2d(WEB) }));
    expect(web).toMatchObject({ evaluated: true, bridgeCapped: false, gapCapped: true });
    expect(web.bridge).toBeGreaterThan(0.79);
    expect(web.bridge).toBeLessThanOrEqual(0.85);
    expect(web.at2d.bridge).toBeNull();
    const slot = refused(plate({ profile: (kk) => kk.shape2d(SLOT) }));
    expect(slot).toMatchObject({ evaluated: true, gapCapped: false, bridgeCapped: true });
    expect(slot.gap).toBeLessThanOrEqual(0.65);
    expect(slot.at2d.gap).toBeNull();
  });

  // A hole below the floor is the laser gap check's first job. Under the sharp closing a
  // small hole used to come back as a phantom (contour-offset.js), so the closing grew it
  // instead of filling it and every such hole read "nothing narrower than 3 mm".
  test("a hole below the floor reads as its own width — round, square, and round via cutAll", () => {
    const at = [30, 20];
    for (const profile of [
      (kk) => kk.shape2d({ outer: PLATE, holes: [sheetHole({ d: 1.2, at })] }),
      (kk) => kk.shape2d({ outer: PLATE, holes: [rect(29.4, 19.4, 30.6, 20.6)] }),
      (kk) => kk.shape2d(PLATE).cutAll([sheetHole({ d: 1.2, at })]),
    ]) {
      const f = factsOf(plate({ profile }));
      expect(f.gapCapped).toBe(false);
      expect(f.gap).toBeGreaterThan(1.15);
      expect(f.gap).toBeLessThanOrEqual(1.25);
      expect(f.at2d.gap[0]).toBeCloseTo(30, 0);
      expect(f.at2d.gap[1]).toBeCloseTo(20, 0);
    }
  });

  // A booleaned round hole is four cubics, and shrinking one to a near-point and regrowing
  // it is the offset engine's slowest case: one M2.5 clearance hole took 4.5 s, four took
  // 47 s. A round hole's narrowest opening is its diameter, and the closing treats each
  // hole on its own, so round holes are read directly and filled before the closing runs.
  test("booleaned screw holes read as their diameter, well inside the budget", () => {
    const holes = [10, 30, 50, 70].map((x) => sheetHole({ d: 2.7, at: [x, 20] }));
    const f = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 80, 40)).cutAll(holes) }), { deadline: 1500, now: () => 0 });
    expect(f).toMatchObject({ evaluated: true, gapCapped: false, gap: 2.7, bridgeCapped: true });
    expect(f.at2d.gap[0]).toBeCloseTo(10, 6);
    expect(f.at2d.gap[1]).toBeCloseTo(20, 6);
    const slot = factsOf(plate({ profile: (kk) => kk.shape2d(rect(0, 0, 80, 40)).cutAll([...holes, rect(20, 30, 40, 30.6)]) }),
      { deadline: 1500, now: () => 0 });
    expect(slot).toMatchObject({ evaluated: true, gapCapped: false });
    expect(slot.gap).toBeLessThanOrEqual(0.65);                       // the 0.6 mm slot is narrower than the holes
    expect(slot.at2d.gap[1]).toBeCloseTo(30.3, 0);
  });

  // Offsetting a cubic is an approximation (OFFSET_TOL), so a profile of many cubics comes
  // back from a test that changed nothing with its area moved a little all the same —
  // about 1e-4 mm² per cubic, 0.022 mm² for 64 booleaned holes. Past LOSS_TOL_MM2 that
  // noise sent every test into the one-sided difference, a boolean between the profile
  // and its near-copy: 28 s for those 256 cubics, then refused.
  test("many booleaned holes and nothing narrow: no boolean against a near-copy", () => {
    const holes = Array.from({ length: 48 }, (_, i) => sheetHole({ d: 6, at: [10 + (i % 16) * 12, 10 + Math.floor(i / 16) * 12] }));
    const s = resolveSheet(k, plate({ profile: (kk) => kk.shape2d(rect(0, 0, 200, 44)).cutAll(holes) }), P, {});
    let cuts = 0;
    const counted = (shape) => new Proxy(shape, { get(target, key) {
      if (key === "cut") return (...a) => { cuts++; return counted(target.cut(...a)); };
      if (key === "offset" || key === "union") return (...a) => counted(target[key](...a));
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const f = LASER.facts({ ...s, profile: counted(s.profile) });
    expect(f).toMatchObject({ evaluated: true, bridgeCapped: true, gapCapped: true });
    expect(cuts).toBe(0);
  });

  // What no reading can bound is ONE test: the deadline is checked between them. A profile
  // whose single test would outrun the whole budget is not started under a deadline —
  // evaluated stays false (verify's notice) — and without one it is read in full. On a
  // stopped clock the budget never runs out, so `evaluated: false` is the gate's alone.
  test("a perforated panel too complex for the budget is not started", () => {
    const s = resolveSheet(k, perforated.parts.grille, P, {});
    expect(LASER.facts(s, { deadline: 1500, now: () => 0 })).toMatchObject({ evaluated: false, bridge: null, gap: null, pieces: 1 });
  });

  test("so is a panel of many small rounded-rect cutouts", () => {
    const f = factsOf(plate({ profile: (kk) => {
      let s = kk.shape2d(rect(0, 0, 100, 60));
      for (let i = 0; i < 8; i++) s = s.cut(kk.shape2d(rect(5 + i * 11, 5, 13 + i * 11, 13)).fillet(1.2));
      return s;
    } }), { deadline: 1500, now: () => 0 });
    expect(f.evaluated).toBe(false);
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
// The 2-D budget on a stopped clock: it never runs out, so an assertion that needs the
// readings cannot flake on a slow runner, and the cost pre-gate still applies.
const STOPPED = { now: () => 0 };
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

  test("a sheet row carries its facts; a printed row beside it gets its print-pose size for the bed", () => {
    const r = measure(k, forge({ plate: plate(), rod: rod(240) }, { verify: { process: "fdm-pla" } }), "v", {}, STOPPED);
    expect(row(r, "plate").sheet).toMatchObject({ process: "laser", thickness: 3, pieces: 1, evaluated: true });
    expect("printBbox" in row(r, "plate")).toBe(false);
    expect(row(r, "rod").sheet).toBeNull();
    expect(row(r, "rod").bbox[0]).toBeCloseTo(240, 3);       // displayed lying down
    expect(row(r, "rod").printBbox[2]).toBeCloseTo(240, 3);  // printed standing up
  });

  test("a finding's location is lifted into the assembly at mid-thickness", () => {
    const pose = { face: "-Y", up: "+Z", at: [0, 0, 0] };
    const f = row(measure(k, forge({ plate: plate({ profile: (kk) => kk.shape2d(WEB), pose }) }), "v", {}, STOPPED), "plate").sheet;
    expect(isVec3(f.at.bridge)).toBe(true);
    const want = sheetToWorld(pose, f.at2d.bridge, 1.5);
    f.at.bridge.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
    expect(f.at.gap).toBeNull();                               // capped: nothing to locate
  });

  test("a pose the probe cannot trust withholds the 3-D location, never the reading", () => {
    const sp = plate({ profile: (kk) => kk.shape2d(WEB), place: (s) => s.translate([0, 0, s.boundingBox().max[2]]) });
    const f = row(measure(k, forge({ plate: sp }), "v", {}, STOPPED), "plate").sheet;
    expect(f.bridgeCapped).toBe(false);
    expect(f.at2d.bridge).not.toBeNull();
    expect(f.at.bridge).toBeNull();
  });

  test("a custom build's volume is compared with profile area × thickness", () => {
    const sp = plate();
    const r = measure(k, forge({ plate: { ...sp, build: (kk) => kk.box({ min: [0, 0, 0], max: [60, 40, 6] }) } }), "v", {}, STOPPED);
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

  // The 2-D budget pays for 2-D work alone. It used to run on the wall clock from the
  // first sheet, so a printed row between two sheets (min-wall rays, a reference
  // deviation) spent it, and the second sheet read evaluated: false.
  test("a slow printed row between two sheets spends none of the 2-D budget", () => {
    let t = 0;
    const slow = new Proxy(k, { get: (target, key) => (key === "import"
      ? () => { t += 5000; return target.box({ min: [0, 0, 0], max: [10, 10, 10] }); }
      : Reflect.get(target, key)) });
    const heavy = { ...printed([10, 10, 10], (s) => s.translate([100, 0, 0])), reference: "ref" };
    const part = forge({ a: plate({ profile: (kk) => kk.shape2d(WEB) }), heavy,
      b: plate({ profile: (kk) => kk.shape2d(WEB), pose: { face: "+Z", up: "+Y", at: [0, 100, 3] } }) });
    const r = measure(slow, part, "v", {}, { now: () => t });
    expect(t).toBe(5000);
    expect(row(r, "heavy").deviation).not.toBeNull();
    for (const name of ["a", "b"]) expect(row(r, name).sheet, name).toMatchObject({ evaluated: true, bridgeCapped: false });
  });

  // Print (export) poses are built only for a bed that will read them, one printed part
  // at a time: a place() that throws for purpose "export" costs that part its print
  // size, never the whole report.
  test("export poses are built only when a process bed will read them", () => {
    let exports = 0;
    const counting = printed([10, 10, 10], (s, { purpose }) => { if (purpose === "export") exports++; return s.translate([100, 0, 0]); });
    const r = measure(k, forge({ plate: plate(), block: counting }), "v", {}, STOPPED);
    expect(exports).toBe(0);
    expect("printBbox" in row(r, "block")).toBe(false);
    const bed = forge({ plate: plate(), block: counting }, { verify: { process: "fdm-pla" } });
    expect(row(measure(k, bed, "v", {}, STOPPED), "block").printBbox).toEqual([10, 10, 10]);
    expect(exports).toBe(1);
    expect(row(measure(k, bed, "v", {}, { ...STOPPED, printBboxes: false }), "block")).not.toHaveProperty("printBbox");
    expect(exports).toBe(1);
  });

  test("a printed part whose export pose throws loses only its print size", () => {
    const part = forge({
      plate: plate(),
      block: printed([10, 10, 10], (s, { purpose }) => { if (purpose === "export") throw new Error("no export pose here"); return s.translate([100, 0, 0]); }),
      rod: rod(100),
    }, { verify: { process: "fdm-pla" } });
    const r = measure(k, part, "v", {}, STOPPED);
    expect(row(r, "block")).not.toHaveProperty("printBbox");
    expect(row(r, "block").printBboxError).toContain("no export pose here");
    expect(row(r, "rod").printBbox[2]).toBeCloseTo(100, 3);
    const v = verify(k, part, { measureFn: (kk, pt, vw, pr, o) => measure(kk, pt, vw, pr, { ...o, ...STOPPED }) });
    const bed = v.cases[0].checks.find((c) => c.subpart === "block" && c.metric === "bbox");
    expect(bed).toMatchObject({ status: "skip", pass: null, unevaluated: true, note: "measured in the print (export) pose" });
    expect(bed.message).toContain("no export pose here");
    expect(v.ok).toBeNull();
  });

  // Spec C.6: the 2-D checks are cheap, so a quick lap (no min-wall rays, no pair
  // distances — the inspect job's `checks: "quick"`) still reads them.
  test("a quick lap still reads the 2-D facts", () => {
    const r = measure(k, forge({ plate: plate({ profile: (kk) => kk.shape2d(WEB) }) }), "v", {}, { ...STOPPED, minWall: false, gaps: false });
    expect(row(r, "plate").sheet).toMatchObject({ evaluated: true, bridgeCapped: false });
    expect(row(r, "plate").sheet.bridge).toBeLessThanOrEqual(0.85);
  });
});

test("partforge measure prints a sheet line under a sheet sub-part", () => {
  const out = execFileSync(process.execPath, ["bin/cli.js", "measure", "test/fixtures/sheet-plate-part.js", "--no-lint"], { encoding: "utf8" });
  expect(out).toContain("    sheet  birch plywood 3 mm, flat 120.0 × 80.0 mm, 1 piece\n");
});

test("the twelve-panel stress fixture: lint-clean, twelve sheet rows, no overlaps, all evaluated given time", () => {
  expect(lintPart(twelvePanel).errors).toEqual([]);
  const r = measure(k, twelvePanel, "kit", {}, STOPPED);
  const sheets = r.subparts.filter((s) => s.sheet);
  expect(sheets).toHaveLength(12);
  expect(sheets.every((s) => s.sheet.evaluated && s.sheet.pieces === 1)).toBe(true);
  expect(r.overlaps).toEqual([]);
}, 120_000);

test("the bench's plates: lint-clean; the screw plate reads in full, the grille is withheld at once", () => {
  for (const part of [screwPlate, perforated]) expect(lintPart(part).errors).toEqual([]);
  const plate = measure(k, screwPlate, "panel", {}, STOPPED).subparts[0].sheet;
  expect(plate).toMatchObject({ evaluated: true, pieces: 1, bridgeCapped: true, gapCapped: true });
  const grille = measure(k, perforated, "panel", {}, STOPPED).subparts[0].sheet;
  expect(grille).toMatchObject({ evaluated: false, pieces: 1 });
}, 60_000);
