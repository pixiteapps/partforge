// The footprint cost (oracle/bed-contact.js `downArea`, measure.js `footprintPct`): the
// share of a printed piece's silhouette on the bed that actually touches it. bedContactPct judges
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

// The denominator is the silhouette (the union of the downward triangles' shadows), not
// the xy bounding box nor their summed shadows: a piece that stands on all of its
// outline reads near 100 however little of its box that fills, and one balanced on a
// point, a line or a curl reads low.
describe("the reading over the silhouette", () => {
  const read = (build) => measure(kernel, forge({ p: { views: ["v"], build } }, { process: "fdm-pla" }), "v").subparts[0].footprintPct;

  it("near 0: a sphere-tipped rod on its end, a cylinder on its side, a wide piece on a narrow foot", () => {
    expect(read((kk) => kk.sphere({ r: 2 }).at([0, 0, 2]).union(kk.cylinder({ r: 2, h: 30 }).at([0, 0, 2])))).toBeLessThan(5);
    // A cylinder on its side: its two facets along the lowest line lie within the flat
    // tolerance and the footprint slack, so at the preview tessellation (116 segments)
    // it reads about 5 % (finer tessellation reads less) — under the 10 % floor.
    for (const r of [2, 10, 30]) expect(read((kk) => kk.cylinder({ r, h: 60 }).rotateX(90).translate([0, 0, r]))).toBeLessThan(10);
    // A 60×60 plate 10 mm up on a 4×4 post: 16 mm² of a 3,600 mm² underside.
    expect(read((kk) => kk.box({ min: [-30, -30, 10], max: [30, 30, 14] }).union(kk.box({ min: [-2, -2, 0], max: [2, 2, 10] })))).toBeLessThan(5);
  });

  it("near 100: a tube on its rim, a frame of thin bars, spread pins, a diagonal bar", () => {
    const tube = (kk) => kk.cylinder({ r: 20, h: 30 }).cut(kk.cylinder({ r: 19, h: 40 }).at([0, 0, -5]));
    const frame = (kk) => kk.box({ min: [0, 0, 0], max: [80, 60, 6] }).cut(kk.box({ min: [2, 2, -1], max: [78, 58, 7] }));
    const pins = (kk) => [[0, 0], [40, 0], [0, 40], [40, 40]].map(([x, y]) => kk.cylinder({ r: 2.5, h: 10 }).at([x, y, 0]))
      .reduce((a, b) => a.union(b));
    const diagonal = (kk) => kk.box({ min: [0, 0, 0], max: [200, 5, 5] }).rotateZ(45);
    for (const build of [tube, frame, pins, diagonal]) expect(read(build)).toBeGreaterThan(95);
  });

  it("a flaring, faceted body counts its outline once, not every zig-zag facet", () => {
    // A 10-mm-tall stack of ever-wider plates: the wide top overhangs the base many
    // times over in summed shadow, but its silhouette is the top plate's outline.
    const stair = (kk) => [0, 1, 2, 3, 4].map((i) => kk.box({ min: [-10 - 2 * i, -10 - 2 * i, 2 * i], max: [10 + 2 * i, 10 + 2 * i, 2 * i + 2] }))
      .reduce((a, b) => a.union(b));
    expect(read(stair)).toBeCloseTo((100 * 400) / (36 * 36), 0);
  });
});

// Arming by the footprint alone: with bed contact switched off the profile's footprint
// floor still arms the bed-contact pass (verify's `armsBedPass`, measure's default).
test("a profile with bedContact: null still measures the footprint cost", () => {
  const v = verify(kernel, { ...rodPart, verify: { process: { base: "fdm-pla", bedContact: null } } });
  const c = v.costs.find((c) => c.metric === "footprintPct");
  expect(c).toMatchObject({ status: "cost", accepted: false });
  expect(c.actual).toBeLessThan(5);
  expect(c.unevaluated).toBeUndefined();
  expect(v.cases.flatMap((cs) => cs.checks).filter((c) => c.metric === "bedContactPct")).toEqual([]);
});

describe("footprintFor (what arms it)", () => {
  it("the FDM profiles carry a floor; resin and no profile do not", () => {
    expect(PROFILES["fdm-pla"].footprint).toBe(10);
    expect(footprintFor({ verify: { process: "fdm-pla" } })).toBe(10);
    expect(footprintFor({ verify: { process: { base: "fdm-pla", footprint: 12 } } })).toBe(12);
    expect(footprintFor({ verify: { process: "resin" } })).toBeNull();
    expect(footprintFor({})).toBeNull();
    expect(footprintFor({ verify: { process: { base: "fdm-pla", footprint: null } } })).toBeNull();
  });

  it("an author's own expectation arms it under a floorless profile", () => {
    expect(footprintFor({ verify: { process: "resin" } }, undefined,
      { expanded: [{ expect: { a: { footprintPct: ">=10" } } }] })).toBe(DEFAULT_FOOTPRINT);
    expect(footprintFor({}, undefined, { expanded: [{ expect: { a: { footprintPct: ">=10" } } }] })).toBe(DEFAULT_FOOTPRINT);
    expect(DEFAULT_FOOTPRINT).toBe(10);
    expect(() => footprintFor({ verify: { orientation: "sideways" } })).toThrow(/unknown verify.orientation/);
  });
});
