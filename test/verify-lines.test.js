// The line gates: `lineDrift` (how much a declared line's length changes along the
// declared sweeps) and `lineBend` (its smallest bend ratio, at the measured pose and along
// the sweeps), both `_view` gates in verify.
import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { verify, VIEW_METRICS } from "../src/framework/oracle/verify.js";
import { measure } from "../src/framework/oracle/measure.js";
import { concentricCapstan, slackCapstan, make } from "./fixtures/capstan-fixtures.js";
import { collideBar } from "./fixtures/collide-bar.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const gated = (part, view) => ({ ...part, verify: { sweeps: { drive: { param: "motorAngle" } }, expect: { _view: view } } });
// A quick lap reuses a seed measured without sweeps, as jobs.js's quick inspect does.
const run = (part, quick = false) => verify(k, part, quick
  ? { view: "assembly", quick, seed: { params: {}, result: measure(k, part, "assembly", {}, { sweeps: false }) } }
  : { view: "assembly" });
const gateOf = (v, metric) => v.cases[0].checks.find((c) => c.metric === metric);

describe("lineDrift", () => {
  it("passes a concentric drive", () => {
    const v = run(gated(concentricCapstan, { lineDrift: "<=0.2" }));
    expect(gateOf(v, "lineDrift")).toMatchObject({ status: "pass", kind: "gate" });
    expect(gateOf(v, "lineDrift").actual).toBeLessThan(0.2);
    expect(v.ok).toBe(true);
  });
  it("fails a slack drive, naming its pattern and hint", () => {
    const v = run(gated(slackCapstan, { lineDrift: "<=0.2" }));
    const c = gateOf(v, "lineDrift");
    expect(c).toMatchObject({ status: "fail", pattern: "line-drift", hint: VIEW_METRICS.lineDrift.hint });
    expect(c.actual).toBeGreaterThan(19);
    expect(v.ok).toBe(false);
  });
  it("is withheld when the line cannot be read along a motion", () => {
    const flaky = {
      ...concentricCapstan,
      derive: (p) => {
        const c = make(p.motorAngle);
        return { drive: { ...c, lineInfo() { if (p.motorAngle > 50) throw new Error("snapped"); return c.lineInfo(); } } };
      },
    };
    const v = run(gated(flaky, { lineDrift: "<=0.2" }));
    const c = gateOf(v, "lineDrift");
    expect(c).toMatchObject({ status: "skip", unevaluated: true });
    expect(c.message).toMatch(/rope/);
    expect(c.message).toMatch(/snapped/);
    expect(v.ok).toBe(null);
  });
  it("is withheld on a quick lap", () => {
    const v = run(gated(concentricCapstan, { lineDrift: "<=0.2" }), true);
    const c = gateOf(v, "lineDrift");
    expect(c).toMatchObject({ status: "skip", unevaluated: true, message: "not measured (quick check)" });
    expect(v.ok).toBe(null);
  });
  it("skips with its skip message on a part with no lines", () => {
    const { lines: _l, ...noLines } = concentricCapstan;
    const v = run(gated(noLines, { lineDrift: "<=0.2" }));
    const c = gateOf(v, "lineDrift");
    expect(c).toMatchObject({ status: "skip", message: VIEW_METRICS.lineDrift.skipMessage });
    expect(c.unevaluated).toBeUndefined();
  });
  it("reads 0 when no declared sweep moves anything", () => {
    expect(VIEW_METRICS.lineDrift.extract({ lines: [{ name: "rope" }], sweeps: [] })).toBe(0);
  });
  it("the locate is null", () => {
    expect(VIEW_METRICS.lineDrift.locate({})).toBe(null);
  });
});

describe("lineBend", () => {
  // The fixture's drum is radius 6 under a 1.2 mm rope: a bend ratio of 12 / 1.2 = 10.
  it("fails below the declared ratio", () => {
    const v = run(gated(concentricCapstan, { lineBend: ">=12" }));
    const c = gateOf(v, "lineBend");
    expect(c).toMatchObject({ status: "fail", pattern: "line-bend", hint: VIEW_METRICS.lineBend.hint });
    expect(c.actual).toBeCloseTo(10, 6);
    expect(v.ok).toBe(false);
  });
  it("passes at or under the drum's ratio", () => {
    const v = run(gated(concentricCapstan, { lineBend: ">=8" }));
    expect(gateOf(v, "lineBend")).toMatchObject({ status: "pass" });
    expect(v.ok).toBe(true);
  });
  it("is evaluated on a quick lap, from the measured pose", () => {
    const v = run(gated(concentricCapstan, { lineBend: ">=12" }), true);
    expect(gateOf(v, "lineBend")).toMatchObject({ status: "fail", actual: 10 });
    expect(v.ok).toBe(false);
  });
  it("takes the smaller of the rows' readings and the measured pose", () => {
    const facts = { lines: [{ name: "rope", bendRatio: 14 }], sweeps: [{ lines: [{ name: "rope", bendMin: 9 }] }, { lines: [{ name: "rope", error: "x", at: 1 }] }] };
    expect(VIEW_METRICS.lineBend.extract(facts)).toBe(9);
  });
  it("skips when no line has a bend", () => {
    expect(VIEW_METRICS.lineBend.extract({ lines: [{ name: "rope", bendRatio: null }] })).toBe(null);
    const v = run({ ...collideBar, verify: { expect: { _view: { lineBend: ">=12" } } } });
    expect(gateOf(v, "lineBend")).toMatchObject({ status: "skip" });
  });
});
