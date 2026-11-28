import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { measureLines, sweepLines, lineBudget, LINE_SWEEP_SAMPLES, LINE_SWEEP_BUDGET_MS, LINE_GRACE_MS } from "../src/framework/oracle/lines.js";
import { runSweeps } from "../src/framework/oracle/sweep.js";
import { VIEW_METRICS } from "../src/framework/verify-metrics.js";
import { collideBar } from "./fixtures/collide-bar.js";
import { concentricCapstan, slackCapstan, staticSlackCapstan, make, makeSlack } from "./fixtures/capstan-fixtures.js";
import { lineText, sweepText, lineSweepText } from "../bin/sweep-text.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

describe("measure().lines", () => {
  it("reports the declared rope at the measured pose", () => {
    const r = measure(k, concentricCapstan, "assembly", { motorAngle: 40 });
    expect(r.lines).toHaveLength(1);
    const want = make(40).report().length;
    expect(r.lines[0].name).toBe("rope");
    expect(r.lines[0].on).toBe("drive");
    expect(Math.abs(r.lines[0].length - want)).toBeLessThan(1e-3);
    expect("points" in r.lines[0]).toBe(false);
  });
  it("adds no key to a part with no lines", () => {
    expect("lines" in measure(k, collideBar, "assembly")).toBe(false);
  });
  it("a source that throws is an error entry and measure still returns", () => {
    const bad = {
      ...concentricCapstan,
      derive: () => ({ drive: { lineInfo() { throw new Error("boom"); } } }),
      parts: { a: { label: "A", build: (kk) => kk.box({ min: [0, 0, 0], max: [1, 1, 1] }), views: { assembly: (s) => s } } },
    };
    const r = measure(k, bad, "assembly");
    expect(r.lines[0]).toEqual({ name: "rope", on: "drive", error: 'line "rope": boom' });
  });
  it("measureLines gives an error entry for a missing source", () => {
    expect(measureLines({ lines: { rope: { on: "nope" } } }, "assembly", {})[0].error).toMatch(/rope/);
  });
});

describe("lineText", () => {
  it("words a reading and an unreadable line", () => {
    expect(lineText({ name: "rope", on: "drive", mode: "taut", length: 212.4, bendRatio: 10, minBendRatio: 8 })).toBe("rope 212.40mm, bend 10.0 (min 8)");
    expect(lineText({ name: "rope", on: "drive", error: "boom" })).toBe("rope unreadable: boom");
  });
  it("leaves the bend off when there is none", () => {
    expect(lineText({ name: "rope", length: 5, bendRatio: null, minBendRatio: null })).toBe("rope 5.00mm");
  });
});

const swept = (part) => ({ ...part, verify: { sweeps: { drive: { param: "motorAngle" } } } });

describe("line readings on sweep rows", () => {
  it("a concentric drive reads almost no drift along the motor sweep", () => {
    const [row] = runSweeps(k, swept(concentricCapstan), "assembly");
    expect(row.linesSampled).toBe(true);
    expect(row.lines).toHaveLength(1);
    const l = row.lines[0];
    expect(l.name).toBe("rope");
    expect(l.drift).toBeLessThan(0.2);
    expect(l.lengthMin).toBeLessThanOrEqual(l.lengthMax);
    expect(l.samples).toBeGreaterThanOrEqual(LINE_SWEEP_SAMPLES);
    expect(l.drift).toBeCloseTo(l.lengthMax - l.lengthMin, 12);
  });
  it("an eccentric pulley's drift matches a brute-force scan within 1%", () => {
    const [row] = runSweeps(k, swept(slackCapstan), "assembly");
    const l = row.lines[0];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const len = makeSlack(-200 + (400 * i) / 2000).lineInfo().lines.rope.length;
      lo = Math.min(lo, len); hi = Math.max(hi, len);
    }
    expect(hi - lo).toBeGreaterThan(1);
    expect(Math.abs(l.drift - (hi - lo)) / (hi - lo)).toBeLessThan(0.01);
    expect(l.samples).toBeGreaterThan(LINE_SWEEP_SAMPLES); // an interior extreme was refined
    expect(l.lengthMinAt).toBeGreaterThanOrEqual(-200);
    expect(l.lengthMaxAt).toBeLessThanOrEqual(200);
  });
  it("a row the deadline stopped still has its lines", () => {
    const [row] = runSweeps(k, swept(concentricCapstan), "assembly", {}, { deadline: 0, now: () => 1 });
    expect(row.skipped).toBe("timeout");
    expect(row.linesSampled).toBe(true);
    expect(row.lines[0].drift).toBeLessThan(0.2);
  });
  it("a source that throws past 50 ends the reading there and leaves the contacts alone", () => {
    const flaky = {
      ...swept(concentricCapstan),
      derive: (p) => {
        const c = make(p.motorAngle);
        return { drive: { ...c, lineInfo() { if (p.motorAngle > 50) throw new Error("snapped"); return c.lineInfo(); } } };
      },
    };
    const [row] = runSweeps(k, flaky, "assembly");
    const [plain] = runSweeps(k, swept(concentricCapstan), "assembly");
    expect(row.lines[0].name).toBe("rope");
    expect(row.lines[0].error).toMatch(/snapped/);
    expect(row.lines[0].at).toBeGreaterThan(50);
    expect(row.contacts).toEqual(plain.contacts);
    expect(row.clear).toBe(plain.clear);
  });
  it("a part with no lines gets no line keys on its rows", () => {
    const { lines: _l, ...noLines } = swept(concentricCapstan);
    const [row] = runSweeps(k, noLines, "assembly");
    expect("lines" in row).toBe(false);
    expect("linesSampled" in row).toBe(false);
  });
  it("a skipped entry gets no lines", () => {
    const part = { ...concentricCapstan, verify: { sweeps: { bad: { param: "nope" } } } };
    const rows = runSweeps(k, part, "assembly");
    for (const r of rows) expect("lines" in r).toBe(false);
  });
  it("sweepLines reads endpoints exactly and a motion's values as …At", () => {
    const motion = { lo: 0, hi: 10, at: (v) => ({ motorAngle: v }) };
    const part = { ...concentricCapstan, derive: (p) => ({ drive: { lineInfo: () => ({ kind: "partforge.lines", lines: { rope: { length: 100 + p.motorAngle, bendRatio: 20 - p.motorAngle } } }) } }) };
    const [l] = sweepLines(part, "assembly", motion);
    expect(l).toMatchObject({ name: "rope", lengthMin: 100, lengthMinAt: 0, lengthMax: 110, lengthMaxAt: 10, drift: 10, bendMin: 10, bendMinAt: 10, samples: LINE_SWEEP_SAMPLES });
  });
});

describe("a sweep that moves no piece", () => {
  it("gives no contact row but still reads the line, as measure's lineSweeps", () => {
    const r = measure(k, swept(staticSlackCapstan), "assembly");
    expect(r.sweeps).toEqual([]);
    expect(r.lineSweeps).toHaveLength(1);
    expect(r.lineSweeps[0]).toMatchObject({ name: "drive", linesSampled: true });
    expect(r.lineSweeps[0].lines[0].name).toBe("rope");
    expect(r.lineSweeps[0].lines[0].drift).toBeGreaterThan(19);
  });
  it("runSweeps leaves it out of its rows and hands it to stillRows", () => {
    const stillRows = [];
    expect(runSweeps(k, swept(staticSlackCapstan), "assembly", {}, { stillRows })).toEqual([]);
    expect(stillRows.map((r) => r.name)).toEqual(["drive"]);
    // without a sink (verify's other views) nothing changes
    expect(runSweeps(k, swept(staticSlackCapstan), "assembly")).toEqual([]);
  });
  it("a part with no lines gets no lineSweeps key", () => {
    const { lines: _l, ...noLines } = swept(staticSlackCapstan);
    const r = measure(k, noLines, "assembly");
    expect(r.sweeps).toEqual([]);
    expect("lineSweeps" in r).toBe(false);
  });
});

describe("a row whose contact pass threw", () => {
  it("is unreadable and still has its line readings", () => {
    const broken = new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : () => { throw new Error("kernel down"); }) });
    const [row] = runSweeps(broken, swept(concentricCapstan), "assembly");
    expect(row.skipped).toBe("unreadable");
    expect(row.error).toMatch(/kernel down/);
    expect(row.linesSampled).toBe(true);
    expect(row.lines[0].name).toBe("rope");
    expect(row.lines[0].drift).toBeLessThan(0.2);
  });
});

// A source carrying `n` lines whose lengths rise with the param (no interior extreme, so no
// refinement), counting derive's calls.
function counted(n) {
  const calls = { n: 0 };
  const lines = Object.fromEntries(Array.from({ length: n }, (_, i) => [`l${i}`, { on: "drive" }]));
  const part = {
    ...concentricCapstan,
    derive: (p) => {
      calls.n++;
      const ls = Object.fromEntries(Array.from({ length: n }, (_, i) => [`l${i}`, { length: 100 + i + p.motorAngle }]));
      return { drive: { lineInfo: () => ({ kind: "partforge.lines", lines: ls }) } };
    },
    lines,
  };
  return { part, calls };
}

describe("the line pass's cost", () => {
  const motion = { lo: 0, hi: 10, at: (v) => ({ motorAngle: v }) };
  it("reads every line of a source from one derive per even sample", () => {
    const { part, calls } = counted(3);
    const out = sweepLines(part, "assembly", motion);
    expect(out.map((l) => l.name)).toEqual(["l0", "l1", "l2"]);
    for (const l of out) expect(l).toMatchObject({ drift: 10, samples: LINE_SWEEP_SAMPLES });
    expect(calls.n).toBe(LINE_SWEEP_SAMPLES);
  });
  it("runs out of its own budget: an unfinished reading is error \"timeout\"", () => {
    let t = 0;
    const { part } = counted(2);
    const slow = { ...part, derive: (p) => { t += 100; return part.derive(p); } };
    const budget = lineBudget({ now: () => t, ms: LINE_SWEEP_BUDGET_MS });
    const out = sweepLines(slow, "assembly", motion, undefined, { budget });
    for (const l of out) {
      expect(l.error).toBe("timeout");
      expect(l.at).toBeGreaterThan(0);
      expect(l.at).toBeLessThan(10);
    }
    // the budget is spent: a later pass on it stops at its first reading
    const again = sweepLines(slow, "assembly", motion, undefined, { budget });
    expect(again[0]).toEqual({ name: "l0", error: "timeout", at: 0 });
  });
  it("in measure, is counted apart from the sweep deadline, and withholds lineDrift", () => {
    let t = 0;
    const slow = { ...swept(concentricCapstan), derive: (p) => { t += 100; return concentricCapstan.derive(p); } };
    const r = measure(k, slow, "assembly", {}, { now: () => t });
    const [row] = r.sweeps;
    expect(row.lines[0]).toMatchObject({ name: "rope", error: "timeout" });
    expect(VIEW_METRICS.lineDrift.extract(r)).toBe(null);
    expect(VIEW_METRICS.lineDrift.withheld(r)).toMatch(/^not evaluated — line "rope" could not be read along sweep "drive" \(at [-\d.]+\): timeout$/);
  });
  it("stops at its hard end, whatever is left of ms", () => {
    let t = 0;
    const { part } = counted(1);
    const slow = { ...part, derive: (p) => { t += 100; return part.derive(p); } };
    const budget = lineBudget({ now: () => t, ms: 1e9, end: 450 });
    const [l] = sweepLines(slow, "assembly", motion, undefined, { budget });
    expect(l.error).toBe("timeout");
    expect(t).toBeLessThanOrEqual(600);
  });
  it("in measure, ends at the sweep deadline plus LINE_GRACE_MS", () => {
    let t = 0;
    const slow = { ...swept(concentricCapstan), derive: (p) => { t += 10; return concentricCapstan.derive(p); } };
    // 33 readings at 10 ms fit the 2000 ms budget, but the deadline has passed by more than the grace
    const r = measure(k, slow, "assembly", {}, { now: () => t, deadline: -LINE_GRACE_MS - 1 });
    expect(r.sweeps[0].lines[0]).toMatchObject({ name: "rope", error: "timeout" });
    expect(VIEW_METRICS.lineDrift.extract(r)).toBe(null);
    // the same with the grace still to run: read in full
    t = 0;
    const ok = measure(k, slow, "assembly", {}, { now: () => t, deadline: 0 });
    expect(ok.sweeps[0].lines[0].drift).toBeLessThan(0.2);
  });
  it("a row's ms leaves the line pass out", () => {
    let t = 0;
    const slow = { ...swept(concentricCapstan), derive: (p) => { t += 1; return concentricCapstan.derive(p); } };
    // a deadline already passed: no contact pass runs, so the row's ms is 0 though lines were read
    const [row] = runSweeps(k, slow, "assembly", {}, { deadline: -1, now: () => t });
    expect(row.skipped).toBe("timeout");
    expect(row.ms).toBe(0);
    expect(row.lines[0].drift).toBeLessThan(0.2);
  });
});

describe("sweepText with lines", () => {
  const row = { name: "drive", clear: true, clearance: 0.001, contacts: [], minClearance: null };
  it("appends each line's drift", () => {
    expect(sweepText({ ...row, lines: [{ name: "rope", drift: 0.0312 }], linesSampled: true })).toBe("drive clear, rope drift 0.03mm");
  });
  it("words an unreadable line", () => {
    expect(sweepText({ ...row, lines: [{ name: "rope", error: "x", at: 51 }], linesSampled: true })).toBe("drive clear, rope unreadable");
  });
  it("lineText names the line once in an error", () => {
    expect(lineText({ name: "rope", error: 'line "rope": boom' })).toBe("rope unreadable: boom");
    expect(lineText({ name: "rope", error: "timeout" })).toBe("rope unreadable: timeout");
  });
  it("words a line-only row of a sweep that moves no piece", () => {
    expect(lineSweepText({ name: "drive", lines: [{ name: "rope", drift: 20.5 }], linesSampled: true })).toBe("drive skipped (moves no piece), rope drift 20.50mm");
  });
  it("appends lines to a skipped row too", () => {
    expect(sweepText({ ...row, skipped: "timeout", lines: [{ name: "rope", drift: 0 }] })).toBe("drive skipped (timeout), rope drift 0.00mm");
  });
});
