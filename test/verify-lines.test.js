// The line gates: `lineDrift` (how much a declared line's length changes along the
// declared sweeps) and `lineBend` (its smallest bend ratio, at the measured pose and along
// the sweeps), both `_view` gates in verify.
import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { verify, VIEW_METRICS } from "../src/framework/oracle/verify.js";
import { measure } from "../src/framework/oracle/measure.js";
import { runSweeps } from "../src/framework/oracle/sweep.js";
import { concentricCapstan, slackCapstan, make } from "./fixtures/capstan-fixtures.js";
import { collideBar } from "./fixtures/collide-bar.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const swept = (part) => ({ ...part, verify: { sweeps: { drive: { param: "motorAngle" } } } });
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
    expect(c.message).toMatch(/^not evaluated — line "rope" could not be read along sweep "drive" \(at [\d.]+\): snapped$/);
    expect(v.ok).toBe(null);
  });
  it("names the row's view in the withheld message when it has one", () => {
    const facts = { lines: [{ name: "rope" }], sweeps: [{ name: "drive", view: "print", lines: [{ name: "rope", error: "snapped", at: 51 }] }] };
    expect(VIEW_METRICS.lineDrift.withheld(facts)).toBe('not evaluated — line "rope" could not be read along sweep "drive" in view "print" (at 51): snapped');
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
  it("skips, not withheld, on a quick lap of a part with no lines", () => {
    const { lines: _l, ...noLines } = concentricCapstan;
    const v = run(gated(noLines, { lineDrift: "<=0.2" }), true);
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
    const facts = { lines: [{ name: "rope", bendRatio: 14 }], sweeps: [{ name: "a", lines: [{ name: "rope", bendMin: 9 }] }, { name: "b", lines: [{ name: "rope", bendMin: 11 }] }] };
    expect(VIEW_METRICS.lineBend.extract(facts)).toBe(9);
    expect(VIEW_METRICS.lineBend.withheld(facts)).toBe(null);
    // one erroring reading among several withholds it, though the others read
    const unread = { ...facts, sweeps: [...facts.sweeps, { name: "c", lines: [{ name: "rope", error: "x", at: 1 }] }] };
    expect(VIEW_METRICS.lineBend.extract(unread)).toBe(null);
    expect(VIEW_METRICS.lineBend.withheld(unread)).toBe('not evaluated — line "rope" could not be read along sweep "c" (at 1): x');
  });
  it("is withheld when a line cannot be read at the measured pose, whatever the others read", () => {
    const part = {
      ...concentricCapstan,
      derive: (p) => ({ drive: make(p.motorAngle), aux: { lineInfo() { throw new Error("boom"); } } }),
      lines: { rope: { on: "drive" }, cable: { on: "aux", line: "rope" } },
    };
    const v = run(gated(part, { lineBend: ">=8" }), true);
    const c = gateOf(v, "lineBend");
    expect(c).toMatchObject({ status: "skip", unevaluated: true, message: 'not evaluated — line "cable" could not be read at the measured pose: boom' });
    expect(v.ok).toBe(null);
  });
  it("skips when no line has a bend", () => {
    expect(VIEW_METRICS.lineBend.extract({ lines: [{ name: "rope", bendRatio: null }] })).toBe(null);
    const v = run({ ...collideBar, verify: { expect: { _view: { lineBend: ">=12" } } } });
    expect(gateOf(v, "lineBend")).toMatchObject({ status: "skip" });
  });
});

// Two lines on one drive, the second's source snapping past motorAngle 50.
describe("one unreadable line among several", () => {
  const twoLines = {
    ...concentricCapstan,
    derive: (p) => {
      const c = make(p.motorAngle);
      return { drive: c, aux: { lineInfo() { if (p.motorAngle > 50) throw new Error("snapped"); return c.lineInfo(); } } };
    },
    lines: { rope: { on: "drive" }, cable: { on: "aux", line: "rope" } },
  };
  it("keeps the row's contacts, clear and the other line's reading", () => {
    const [row] = runSweeps(k, swept(twoLines), "assembly");
    const [plain] = runSweeps(k, swept(concentricCapstan), "assembly");
    expect(row.contacts).toEqual(plain.contacts);
    expect(row.clear).toBe(plain.clear);
    expect(row.lines.map((l) => l.name)).toEqual(["rope", "cable"]);
    expect(row.lines[0]).toEqual(plain.lines[0]);
    expect(row.lines[1]).toMatchObject({ name: "cable", error: "snapped" });
  });
  it("withholds lineDrift and lineBend", () => {
    const v = run(gated(twoLines, { lineDrift: "<=0.2", lineBend: ">=8" }));
    for (const metric of ["lineDrift", "lineBend"]) {
      const c = gateOf(v, metric);
      expect(c, metric).toMatchObject({ status: "skip", unevaluated: true });
      expect(c.message, metric).toMatch(/^not evaluated — line "cable" could not be read along sweep "drive" \(at [\d.]+\): snapped$/);
    }
    expect(v.ok).toBe(null);
  });
});
