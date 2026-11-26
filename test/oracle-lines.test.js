import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { measureLines, sweepLines, LINE_SWEEP_SAMPLES } from "../src/framework/oracle/lines.js";
import { runSweeps } from "../src/framework/oracle/sweep.js";
import { collideBar } from "./fixtures/collide-bar.js";
import { concentricCapstan, slackCapstan, make, makeSlack } from "./fixtures/capstan-fixtures.js";
import { lineText, sweepText } from "../bin/sweep-text.js";

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
    expect(r.lines[0]).toEqual({ name: "rope", on: "drive", error: "boom" });
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

describe("sweepText with lines", () => {
  const row = { name: "drive", clear: true, clearance: 0.001, contacts: [], minClearance: null };
  it("appends each line's drift", () => {
    expect(sweepText({ ...row, lines: [{ name: "rope", drift: 0.0312 }], linesSampled: true })).toBe("drive clear, rope drift 0.03mm");
  });
  it("words an unreadable line", () => {
    expect(sweepText({ ...row, lines: [{ name: "rope", error: "x", at: 51 }], linesSampled: true })).toBe("drive clear, rope unreadable");
  });
  it("appends lines to a skipped row too", () => {
    expect(sweepText({ ...row, skipped: "timeout", lines: [{ name: "rope", drift: 0 }] })).toBe("drive skipped (timeout), rope drift 0.00mm");
  });
});
