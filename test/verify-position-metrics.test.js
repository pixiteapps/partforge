import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { evaluateCase, SUBPART_METRICS, VIEW_METRICS } from "../src/framework/oracle/verify.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const boxPart = {   // [0,0,0]..[10,20,5]; com [5,10,2.5]
  meta: { title: "Box", units: "mm" }, defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 20, 5] }) } },
  views: { v: { label: "V" } },
};
const run = (expect_) => evaluateCase(measure(k, boxPart, "v"), { expect: expect_, subPartNames: ["block"] });
const find = (checks, metric) => checks.find((c) => c.metric === metric);

test("centerOfMass vector assertion passes and fails componentwise", () => {
  expect(find(run({ block: { centerOfMass: "<=[*,*,3]" } }), "centerOfMass").status).toBe("pass");   // 2.5 <= 3
  expect(find(run({ block: { centerOfMass: "<=[*,*,2]" } }), "centerOfMass").status).toBe("fail");   // 2.5 > 2
});

test("view (aggregate) centerOfMass metric works", () => {
  expect(find(run({ _view: { centerOfMass: "<=[*,*,3]" } }), "centerOfMass").status).toBe("pass");
});

test("a null centerOfMass skips rather than fails", () => {
  const facts = { subparts: [{ name: "block", centerOfMass: null, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
    aggregate: { centerOfMass: null, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }, overlaps: [], gaps: [], nearMisses: [] };
  const checks = evaluateCase(facts, { expect: { block: { centerOfMass: "<=[*,*,3]" } }, subPartNames: ["block"] });
  expect(find(checks, "centerOfMass").status).toBe("skip");
});

test("bounds: { min, max } checks each side, reported as bounds.min / bounds.max", () => {
  const checks = run({ block: { bounds: { min: ">=[0,0,0]", max: "<=[9,*,*]" } } });
  expect(find(checks, "bounds.min")).toMatchObject({ status: "pass", kind: "gate", expr: ">=[0,0,0]" });
  expect(find(checks, "bounds.max")).toMatchObject({ status: "fail", actual: [10, 20, 5] });   // max x is 10
  expect(find(checks, "bounds.max").hint).toMatch(/high corner/);
  expect(find(checks, "bounds")).toBeUndefined();
});

test("bounds takes either side alone, and a side may carry its own hint", () => {
  const checks = run({ block: { bounds: { max: { expr: "<=[9,*,*]", hint: "keep it under 9" } } } });
  expect(checks.filter((c) => c.metric.startsWith("bounds"))).toHaveLength(1);
  expect(find(checks, "bounds.max").hint).toBe("keep it under 9");
});

test("view (aggregate) bounds works", () => {
  expect(find(run({ _view: { bounds: { min: ">=[0,0,0]", max: "<=[10,20,5]" } } }), "bounds.max").status).toBe("pass");
});

test("a malformed bounds throws with the accepted form", () => {
  expect(() => run({ block: { bounds: "<=[1,1,1]" } })).toThrow(/block: bounds takes an object \{ min, max \}.*bounds: \{ min: ">=\[x,y,z\]", max: "<=\[x,y,z\]" \}/);
  expect(() => run({ block: { bounds: { lo: ">=[0,0,0]" } } })).toThrow(/accepts only "min" and "max", got "lo"/);
  expect(() => run({ _view: { bounds: {} } })).toThrow(/_view: bounds needs at least one of min or max/);
});

test("the legacy boundsMin / boundsMax spellings still evaluate", () => {
  expect(find(run({ block: { boundsMin: ">=[0,0,0]" } }), "boundsMin").status).toBe("pass");
  expect(find(run({ block: { boundsMax: "<=[9,*,*]" } }), "boundsMax").status).toBe("fail");
});

// The point of `bounds`: the expectation is written in the shape measure reports.
// Its sides are exactly the keys of measure's `bounds`, and a measurement's own
// corners, fed straight back as expectations, pass.
test("measure's reported bounds and the bounds assertion share one shape", () => {
  const facts = measure(k, boxPart, "v");
  const reported = facts.subparts[0].bounds;
  expect(Object.keys(reported).sort()).toEqual(Object.keys(SUBPART_METRICS.bounds.sides).sort());
  expect(Object.keys(facts.aggregate.bounds).sort()).toEqual(Object.keys(VIEW_METRICS.bounds.sides).sort());
  const vec = (v) => `[${v.join(",")}]`;
  const checks = evaluateCase(facts, { expect: {
    block: { bounds: { min: `>=${vec(reported.min)}`, max: `<=${vec(reported.max)}` } },
    _view: { bounds: { min: `>=${vec(facts.aggregate.bounds.min)}`, max: `<=${vec(facts.aggregate.bounds.max)}` } },
  }, subPartNames: ["block"] });
  const bounds = checks.filter((c) => c.metric.startsWith("bounds."));
  expect(bounds).toHaveLength(4);
  for (const c of bounds) expect(c.status, `${c.scope} ${c.metric}`).toBe("pass");
});
