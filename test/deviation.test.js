// Deviation facts (measure.js) + the ref* verify gate (verify-metrics.js) —
// Task 12: holds a parametric rebuild to its imported reference. Manifold-
// booting only (kernel.import needs the mesh-import backend), own file per the
// OCCT/Manifold same-process ban.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";
import { cubeSoup } from "./helpers/cube-soup.js";
import { compareTolerance } from "../src/framework/oracle/compare.js";

const scanImport = () => { const c = cubeSoup(10); return meshToStl(c.positions, c.indices); };

const part = (bodyBuild) => ({
  meta: { title: "dev" },
  imports: { scan: scanImport },
  defaults: {},
  views: { main: {} },
  parts: {
    ref: { views: ["main"], exportable: false, build: (k) => k.import("scan") },
    body: { views: ["main"], reference: "scan", build: bodyBuild },
  },
  verify: { expect: { body: { refXorVolume: "<=50mm3", refVolumeDeltaPct: "<=2", refBboxDelta: "<=[0.5,0.5,0.5]" } } },
});

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel({ imports: { scan: scanImport } }); });

describe("deviation gate", () => {
  it("an exact rebuild passes", () => {
    // cubeSoup(10) is origin-cornered — [0,10]^3, matched exactly here.
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }));
    const r = measure(kernel, p, "main");
    const body = r.subparts.find((s) => s.name === "body");
    expect(body.deviation.xorVolume).toBeLessThan(1);
    expect(verify(kernel, p, { view: "main", seed: { params: {}, result: r } }).ok).toBe(true);
  });

  it("a drifted rebuild fails the gate", () => {
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 12] }));
    const v = verify(kernel, p, { view: "main" });
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.metric === "refXorVolume")).toBe(true);
  });

  it("no reference declared → no deviation facts, metrics skip", () => {
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }));
    delete p.parts.body.reference;
    const r = measure(kernel, p, "main");
    expect(r.subparts.find((s) => s.name === "body").deviation).toBeNull();
    const v = verify(kernel, p, { view: "main" });
    expect(v.failures).toEqual([]); // ref* checks report status "skip", not fail…
    // …and a part whose EVERY declared check skipped has verified nothing: the
    // verdict is withheld (vacuous verify), with the notice that says why.
    expect(v.ok).toBeNull();
    expect(v.warnings.find((w) => w.metric === "expectations")?.message).toBe("no expectation could be evaluated");
  });
});

// `reference` naming another SUB-PART: the reference can be posed. cubeSoup(10) is
// [0,10]^3; rotateX(90) carries it to [0,10]x[-10,0]x[0,10].
const posedPart = () => ({
  meta: { title: "dev-posed" },
  imports: { scan: scanImport },
  defaults: {},
  views: { main: {} },
  parts: {
    ref: { views: ["main"], exportable: false, build: (k) => k.import("scan").rotateX(90) },
    body: { views: ["main"], reference: "ref", build: (k) => k.box({ min: [0, -8, 0], max: [10, 2, 10] }) },
  },
});

describe("deviation against a sub-part", () => {
  it("compares against the posed reference sub-part, not the raw import", () => {
    const r = measure(kernel, posedPart(), "main");
    const d = r.subparts.find((s) => s.name === "body").deviation;
    expect(d.ref).toBe("ref");
    // body ∩ posed ref = [0,10]x[-8,0]x[0,10] = 800 → xor 1000 + 1000 − 1600.
    expect(d.xorVolume).toBeCloseTo(400, 3);
    // The import-name form reads the raw import: ∩ = [0,10]x[0,2]x[0,10] = 200 → xor 1600.
    const imp = posedPart();
    imp.parts.body.reference = "scan";
    const di = measure(kernel, imp, "main").subparts.find((s) => s.name === "body").deviation;
    expect(di.ref).toBe("scan");
    expect(di.xorVolume).toBeCloseTo(1600, 3);
    expect(di.xorVolume).not.toBeCloseTo(d.xorVolume, 0);
  });

  it("carries where they differ, at the tolerance of the two bounds", () => {
    const r = measure(kernel, posedPart(), "main");
    const body = r.subparts.find((s) => s.name === "body");
    const d = body.deviation;
    const refBounds = r.subparts.find((s) => s.name === "ref").bounds;
    expect(d.tolerance).toBeCloseTo(compareTolerance(body.bounds, refBounds), 9);
    expect(d.missingVolume).toBeCloseTo(200, 2);   // ref's y∈[-10,-8]
    expect(d.excessVolume).toBeCloseTo(200, 2);    // body's y∈[0,2]
    expect(d.regions.map((x) => x.change).sort()).toEqual(["excess", "missing"]);
    const miss = d.regions.find((x) => x.change === "missing");
    expect(miss.at[1]).toBeCloseTo(-9, 3);
    expect(miss.size).toEqual([expect.closeTo(10, 3), expect.closeTo(2, 3), expect.closeTo(10, 3)]);
    expect(d.compareSkipped).toBeUndefined();
  });

  it("a reference sub-part outside the measured view is still built and compared", () => {
    const p = posedPart();
    p.views.solo = {};
    p.parts.body.views = ["main", "solo"];
    const r = measure(kernel, p, "solo");
    expect(r.subparts.map((s) => s.name)).toEqual(["body"]);
    expect(r.subparts[0].deviation.xorVolume).toBeCloseTo(400, 3);
  });

  it("a reference sub-part that cannot build gives deviation null, not a throw", () => {
    const p = posedPart();
    p.views.solo = {};
    p.parts.body.views = ["main", "solo"];
    p.parts.ref.build = () => { throw new Error("nope"); };
    const r = measure(kernel, p, "solo");
    expect(r.subparts[0].deviation).toBeNull();
  });

  it("the import-name form keeps its values and gains the new fields", () => {
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 12] }));
    const d = measure(kernel, p, "main").subparts.find((s) => s.name === "body").deviation;
    expect(d.ref).toBe("scan");
    expect(d.xorVolume).toBeCloseTo(200, 3);
    expect(d.volumeDeltaPct).toBeCloseTo(20, 3);
    expect(d.bboxDelta).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(2, 6)]);
    expect(d.excessVolume).toBeCloseTo(200, 2);
    expect(d.missingVolume).toBe(0);
    expect(d.regions).toHaveLength(1);
    expect(d.tolerance).toBeCloseTo(compareTolerance({ min: [0, 0, 0], max: [10, 10, 12] }, { min: [0, 0, 0], max: [10, 10, 10] }), 9);
  });

  it("a kernel with no _compareSolids reports compareSkipped: unsupported", () => {
    const bare = Object.create(kernel);
    bare._compareSolids = undefined;
    const d = measure(bare, posedPart(), "main").subparts.find((s) => s.name === "body").deviation;
    expect(d.xorVolume).toBeCloseTo(400, 3);
    expect(d.compareSkipped).toBe("unsupported");
    expect("regions" in d || "missingVolume" in d || "excessVolume" in d || "tolerance" in d).toBe(false);
  });

  it("a throwing _compareSolids keeps the exact fields and reports compareSkipped: error", () => {
    const boom = Object.create(kernel);
    boom._compareSolids = () => { throw new Error("boom"); };
    const d = measure(boom, posedPart(), "main").subparts.find((s) => s.name === "body").deviation;
    expect(d.xorVolume).toBeCloseTo(400, 3);
    expect(d.compareSkipped).toBe("error");
    expect("regions" in d || "missingVolume" in d || "excessVolume" in d || "tolerance" in d).toBe(false);
  });

  it("a refused comparison reports why and omits the new fields", () => {
    const tiny = Object.create(kernel);
    tiny._compareSolids = (a, b, o) => kernel._compareSolids(a, b, { ...o, maxTriangles: 1 });
    const d = measure(tiny, posedPart(), "main").subparts.find((s) => s.name === "body").deviation;
    expect(d.compareSkipped).toBe("too-large");
    expect(d.regions).toBeUndefined();
  });
});
