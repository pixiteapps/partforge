// lines/read.js: the `lines` block and one declared line read out of derive's output.
import { describe, it, expect } from "vitest";
import { normalizeLines, linesInView, readLine } from "../src/framework/lines/read.js";

const source = (lines) => ({ lineInfo: () => ({ kind: "partforge.lines", lines }) });

describe("normalizeLines", () => {
  it("defaults line to the key and views to null", () => {
    expect(normalizeLines({ lines: { rope: { on: "drive" } } })).toEqual([{ name: "rope", on: "drive", line: "rope", views: null, display: null }]);
  });
  it("keeps declaration order and explicit line/views", () => {
    const r = normalizeLines({ lines: { a: { on: "x", line: "b", views: ["assembly"] }, c: { on: "y" } } });
    expect(r.map((e) => e.name)).toEqual(["a", "c"]);
    expect(r[0]).toEqual({ name: "a", on: "x", line: "b", views: ["assembly"], display: null });
  });
  it("drops malformed entries and tolerates no block", () => {
    expect(normalizeLines({ lines: { a: 3, b: null, c: {}, d: { on: "x" } } }).map((e) => e.name)).toEqual(["d"]);
    expect(normalizeLines({})).toEqual([]);
    expect(normalizeLines(null)).toEqual([]);
  });
});

describe("linesInView", () => {
  it("honours views", () => {
    const part = { lines: { a: { on: "x" }, b: { on: "x", views: ["print"] }, c: { on: "x", views: ["assembly"] } } };
    expect(linesInView(part, "assembly").map((e) => e.name)).toEqual(["a", "c"]);
    expect(linesInView(part, "print").map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("readLine", () => {
  const a = { mode: "taut", d: 1, closed: false, length: 10, bendRatio: 4, minBendRatio: 3, points: [[0, 0, 0], [10, 0, 0]] };
  const b = { mode: "taut", d: 2, closed: true, length: 20, points: [[0, 0, 0]] };
  it("reads the named line", () => {
    const d = { drive: source({ a, b }) };
    const r = readLine(d, { name: "rope", on: "drive", line: "b", views: null });
    expect(r).toEqual({ name: "rope", on: "drive", mode: "taut", d: 2, closed: true, length: 20, bendRatio: null, minBendRatio: null, points: [[0, 0, 0]] });
    expect(readLine(d, { name: "rope", on: "drive", line: "a", views: null }).bendRatio).toBe(4);
  });
  it("throws a named error", () => {
    const decl = { name: "rope", on: "drive", line: "rope", views: null };
    expect(() => readLine({}, decl)).toThrow(/line "rope": derive\(\)\.drive is not a line source/);
    expect(() => readLine({ drive: source({ a }) }, { ...decl, line: "x" })).toThrow(/has no line "x"/);
    expect(() => readLine({ drive: source({ rope: { mode: "taut", d: 1, points: [] } }) }, decl)).toThrow(/line "rope": .* has no length/);
  });
  it("reads only the source's own lines, never a prototype key", () => {
    const decl = { name: "rope", on: "drive", line: "toString", views: null };
    expect(() => readLine({ drive: source({ a }) }, decl)).toThrow(/line "rope": derive\(\)\.drive has no line "toString"/);
  });
  it("prefixes a source's own throw with the line and names the field", () => {
    const decl = { name: "rope", on: "drive", line: "rope", views: null };
    let caught;
    try { readLine({ drive: { lineInfo() { throw new Error("boom"); } } }, decl); } catch (e) { caught = e; }
    expect(caught.message).toBe('line "rope": boom');
    expect(caught.field).toBe("lines.rope");
    expect(caught.name).toBe("SpecError");
  });
});
