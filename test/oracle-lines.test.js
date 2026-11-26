import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { measureLines } from "../src/framework/oracle/lines.js";
import { collideBar } from "./fixtures/collide-bar.js";
import { concentricCapstan, make } from "./fixtures/capstan-fixtures.js";
import { lineText } from "../bin/sweep-text.js";

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
