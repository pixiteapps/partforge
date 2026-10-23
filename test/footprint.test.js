// The footprint cost (oracle/bed-contact.js `base`, measure.js `footprintPct`): how much
// of a printed piece's posed base area actually touches the bed. bedContactPct judges
// only the FLAT underside that exists, so a piece with almost none — a sphere-tipped
// rod standing on its end — passes it at 100; this reading is what catches that. A
// COST, like overhangArea: it reports what a brim or a new orientation would buy, and
// `verify.accept: ["footprint"]` records that the user chose a brim.
import { beforeAll, describe, expect, it, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { verify } from "../src/framework/oracle/verify.js";
import { measure } from "../src/framework/oracle/measure.js";
import { footprintFor, DEFAULT_FOOTPRINT, PROFILES } from "../src/framework/oracle/dfm-profiles.js";
import { sheetPart } from "../src/framework/geometry/polygon.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const forge = (parts, verifyBlock) => ({
  meta: { title: "Footprint", units: "mm" }, defaults: { t: 3 }, parts, views: { v: { label: "V" } },
  ...(verifyBlock ? { verify: verifyBlock } : {}),
});
// A cylinder r = 2, h = 30 standing on a sphere r = 2: its lowest point is the sphere's pole.
const rod = (extra = {}) => ({ views: ["v"], build: (kk) => kk.sphere({ r: 2 }).at([0, 0, 2]).union(kk.cylinder({ r: 2, h: 30 }).at([0, 0, 2])), ...extra });
const plate = () => ({ views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [20, 20, 5] }) });
const rodPart = forge({ rod: rod() }, { process: "fdm-pla" });
const platePart = forge({ plate: plate() }, { process: "fdm-pla" });
const nonExportableRodPart = forge({ plate: plate(), rod: rod({ exportable: false }) }, { process: "fdm-pla" });
const sheetPartDeclaringFootprint = forge({
  plate: sheetPart({ views: ["v"], label: "Plate", material: "birch plywood", thickness: (p) => p.t,
    profile: (kk) => kk.shape2d([[0, 0], [60, 0], [60, 40], [0, 40]]) }),
}, { expect: { plate: { footprintPct: ">=5" } } });
// A place() that queries its solid cannot be read by the pose probes, so bed contact
// reads the export build — which throws here.
const badExportPosePart = forge({ rod: rod({ place: (s, { purpose }) => {
  s.boundingBox();
  if (purpose === "export") throw new Error("export pose unavailable");
  return s;
} }) }, { process: "fdm-pla" });

const footprintChecks = (v) => v.cases.flatMap((c) => c.checks).filter((c) => c.metric === "footprintPct");

test("a sphere-tipped rod standing on its end is a footprint cost", () => {
  const v = verify(kernel, rodPart);
  const c = v.costs.find((c) => c.metric === "footprintPct");
  expect(c).toMatchObject({ status: "cost", accepted: false, pattern: "piece-stands-on-nothing" });
  expect(c.actual).toBeLessThan(5);
  expect(c.hint.length).toBeLessThanOrEqual(500);
  // Located at the lowest point, the sphere's pole, in display coordinates.
  expect(c.location[0]).toBeCloseTo(0, 3);
  expect(c.location[1]).toBeCloseTo(0, 3);
  expect(c.location[2]).toBeCloseTo(0, 3);
  expect(v.ok).toBe(true);
});

test("a plate reads 100 and reports no footprint cost", () => {
  expect(verify(kernel, platePart).costs.filter((c) => c.metric === "footprintPct")).toEqual([]);
  const m = measure(kernel, platePart, "v");
  expect(m.measuredFootprint).toBe(true);
  expect(m.subparts[0].footprintPct).toBeCloseTo(100, 3);
});

test("accept: [\"footprint\"] marks it accepted", () => {
  const v = verify(kernel, { ...rodPart, verify: { process: "fdm-pla", accept: ["footprint"] } });
  expect(v.costs.find((c) => c.metric === "footprintPct").accepted).toBe(true);
});

test("resin and an exportable:false piece are not judged", () => {
  expect(verify(kernel, { ...rodPart, verify: { process: "resin" } }).costs).toEqual([]);
  expect(verify(kernel, nonExportableRodPart).costs.filter((c) => c.metric === "footprintPct")).toEqual([]);
});

test("declared on a sheet part it is a PRINT_ONLY skip", () => {
  const v = verify(kernel, sheetPartDeclaringFootprint);
  const [c] = footprintChecks(v);
  expect(c).toMatchObject({ status: "skip", pass: null, actual: null, message: "not measured on a sheet part" });
  expect(c.hint).toMatch(/cut, not printed/);
  expect(c.hint).toMatch(/footprintPct/);
  expect(c.hint.length).toBeLessThanOrEqual(500);
});

test("a failed export pose skips footprint like bed contact", () => {
  const v = verify(kernel, badExportPosePart);
  expect(v.unevaluated.find((c) => c.metric === "footprintPct").message).toMatch(/print \(export\) pose did not build/);
});

test("read in the print pose: a rod shown lifted is located where the view shows its tip", () => {
  const part = forge({ rod: rod({ place: (s, { purpose }) => (purpose === "export" ? s : s.translate([10, 0, 7])) }) }, { process: "fdm-pla" });
  const c = verify(kernel, part).costs.find((c) => c.metric === "footprintPct");
  expect(c.location[0]).toBeCloseTo(10, 3);
  expect(c.location[2]).toBeCloseTo(7, 3);
});

test("measure: unarmed, the reading is absent and stamped as not measured", () => {
  const m = measure(kernel, rodPart, "v", {}, { bedContact: null });
  expect(m.measuredFootprint).toBe(false);
  expect(m.subparts[0].footprintPct).toBeNull();
  expect(m.subparts[0].footprintAt).toBeNull();
});

test("a quick lap on a seed without the pass withholds the cost", () => {
  const bare = measure(kernel, rodPart, "v", {}, { bedContact: null });
  const quick = verify(kernel, rodPart, { seed: { params: {}, result: bare }, quick: true });
  expect(footprintChecks(quick)[0].unevaluated).toBe(true);
});

describe("footprintFor (what arms it)", () => {
  it("the FDM profiles carry a floor; resin and no profile do not", () => {
    expect(PROFILES["fdm-pla"].footprint).toBe(5);
    expect(footprintFor({ verify: { process: "fdm-pla" } })).toBe(5);
    expect(footprintFor({ verify: { process: { base: "fdm-pla", footprint: 12 } } })).toBe(12);
    expect(footprintFor({ verify: { process: "resin" } })).toBeNull();
    expect(footprintFor({})).toBeNull();
    expect(footprintFor({ verify: { process: { base: "fdm-pla", footprint: null } } })).toBeNull();
  });

  it("an author's own expectation arms it under a floorless profile", () => {
    expect(footprintFor({ verify: { process: "resin" } }, undefined,
      { expanded: [{ expect: { a: { footprintPct: ">=10" } } }] })).toBe(DEFAULT_FOOTPRINT);
    expect(footprintFor({}, undefined, { expanded: [{ expect: { a: { footprintPct: ">=10" } } }] })).toBe(DEFAULT_FOOTPRINT);
    expect(DEFAULT_FOOTPRINT).toBe(5);
    expect(() => footprintFor({ verify: { orientation: "sideways" } })).toThrow(/unknown verify.orientation/);
  });
});
