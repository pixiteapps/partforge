import { expect, test } from "vitest";
import { parseAssertion, evaluateAssertion, bareVectorHint } from "../src/framework/oracle/assert-dsl.js";

test("parses numbers and booleans as equality", () => {
  expect(parseAssertion(1)).toEqual({ op: "eq", value: 1 });
  expect(parseAssertion(true)).toEqual({ op: "eq", value: true });
});

test("parses scalar comparators", () => {
  expect(parseAssertion(">=1.5")).toEqual({ op: "gte", value: 1.5 });
  expect(parseAssertion("<=2")).toEqual({ op: "lte", value: 2 });
  expect(parseAssertion(">0")).toEqual({ op: "gt", value: 0 });
  expect(parseAssertion("<10")).toEqual({ op: "lt", value: 10 });
});

test("parses ranges and normalizes units to base (mm / mm3)", () => {
  expect(parseAssertion("0.4..0.6cm3")).toEqual({ op: "range", min: 400, max: 600 });
  expect(parseAssertion("5mm")).toEqual({ op: "eq", value: 5 });
  expect(parseAssertion("2cm")).toEqual({ op: "eq", value: 20 });
});

test("parses vector bounds with * to skip an axis", () => {
  expect(parseAssertion("<=[12,12,16]")).toEqual({ op: "vle", vec: [12, 12, 16] });
  expect(parseAssertion(">=[10,*,14]")).toEqual({ op: "vge", vec: [10, null, 14] });
});

test("throws on unrecognized forms (strict)", () => {
  expect(() => parseAssertion(">==1.5")).toThrow();
  expect(() => parseAssertion("abc")).toThrow();
  expect(() => parseAssertion("<=[1,2]")).toThrow();
  expect(() => parseAssertion("5kg")).toThrow();
  expect(() => parseAssertion({})).toThrow();
});

// append to test/assert-dsl.test.js
const ev = (expr, actual) => evaluateAssertion(parseAssertion(expr), actual).pass;

test("evaluates scalar equality and comparators", () => {
  expect(ev(1, 1)).toBe(true);
  expect(ev(1, 2)).toBe(false);
  expect(ev(true, true)).toBe(true);
  expect(ev(true, false)).toBe(false);
  expect(ev(">=1.5", 1.5)).toBe(true);   // boundary
  expect(ev(">=1.5", 1.4)).toBe(false);
  expect(ev("<=2", 3)).toBe(false);
  expect(ev(">0", 0)).toBe(false);
});

test("evaluates ranges with unit normalization", () => {
  expect(ev("0.4..0.6cm3", 500)).toBe(true);   // 500 mm³ in [400,600]
  expect(ev("0.4..0.6cm3", 700)).toBe(false);
  expect(ev("0.4..0.6cm3", 400)).toBe(true);   // boundary
});

test("evaluates vector bounds componentwise, * skips", () => {
  expect(ev("<=[12,12,16]", [8, 8, 10])).toBe(true);
  expect(ev("<=[12,12,16]", [13, 8, 10])).toBe(false);
  expect(ev(">=[10,*,14]", [12, 5, 20])).toBe(true);   // axis 1 skipped
  expect(ev(">=[10,*,14]", [9, 5, 20])).toBe(false);
});

// A bare vector is the commonest slip (the writer means "exactly this size"). The
// error hands back both legal spellings in the writer's own numbers.
test.each([
  [[40, 40, 10]],
  ["[40,40,10]"],
  ["[40, 40, 10]"],
  ["=[40,40,10]"],
  [["40mm", "40mm", "10mm"]],
])("a bare vector %j names both legal spellings in its own numbers", (expr) => {
  expect(() => parseAssertion(expr)).toThrow(
    'use "<=[40,40,10]" or ">=[40,40,10]" (componentwise; * skips an axis)');
});

test("a bare vector keeps * axes in the suggestion", () => {
  expect(bareVectorHint("[*,*,25]")).toBe('use "<=[*,*,25]" or ">=[*,*,25]" (componentwise; * skips an axis)');
});

test("a bare vector it cannot rewrite falls back to placeholders", () => {
  expect(bareVectorHint([40, 40])).toMatch(/^use "<=\[x,y,z\]" or ">=\[x,y,z\]" \(exactly 3 plain numbers/);
});

test("bareVectorHint is null for anything that is not a bare vector", () => {
  for (const e of ["<=[1,2,3]", ">=5", "1..2", 3, true, null, { a: 1 }]) expect(bareVectorHint(e)).toBe(null);
});

test("vector components must be plain numbers or *", () => {
  expect(() => parseAssertion("<=[40mm,40,10]")).toThrow(/each a plain number in mm or \*/);
  expect(() => parseAssertion("<=[,1,2]")).toThrow(/each a plain number/);
  expect(() => parseAssertion("<=[1..2,1,2]")).toThrow(/each a plain number/);
});

// A per-axis RANGE vector is the two-sided form: "[28..32, 18..22, 9..11]". Three
// Sonnet trials wrote exactly this (one as the bare comma form, "40..40,40..40,3..3")
// and got "unrecognized form", then fell back to "<=[…]" and told the user the sizes
// were not exact.
test("parses a per-axis range vector, bracketed or bare, with * to skip an axis", () => {
  const want = { op: "vrange", vec: [[28, 32], [18, 22], [9, 11]] };
  expect(parseAssertion("[28..32, 18..22, 9..11]")).toEqual(want);
  expect(parseAssertion("[28..32,18..22,9..11]")).toEqual(want);
  expect(parseAssertion("28..32,18..22,9..11")).toEqual(want);
  expect(parseAssertion(" 28..32 , 18..22 , 9..11 ")).toEqual(want);
  expect(parseAssertion("[40..40,40..40,3..3]")).toEqual({ op: "vrange", vec: [[40, 40], [40, 40], [3, 3]] });
  expect(parseAssertion("[*, 18..22, *]")).toEqual({ op: "vrange", vec: [null, [18, 22], null] });
  expect(parseAssertion("[-1..1, 0.5..1.5, *]")).toEqual({ op: "vrange", vec: [[-1, 1], [0.5, 1.5], null] });
});

test("a range vector takes exactly 3 components, each a..b or *", () => {
  expect(() => parseAssertion("[1..2,3,4]")).toThrow(/each a range a\.\.b in mm or \*/);
  expect(() => parseAssertion("[1..2,3..4]")).toThrow(/exactly 3 components/);
  expect(() => parseAssertion("1..2,3..4,5..6,7..8")).toThrow(/exactly 3 components/);
  expect(() => parseAssertion("[1..2mm,3..4,5..6]")).toThrow(/each a range a\.\.b in mm or \*/);
  expect(() => parseAssertion("[1..2,3..4,5..6")).toThrow(/unrecognized form/);
  expect(() => parseAssertion("<=[1..2,3..4,5..6]")).toThrow(/each a plain number/);
});

test("evaluates a range vector per axis with the scalar range's slack, * skips", () => {
  expect(ev("[28..32, 18..22, 9..11]", [30, 20, 10])).toBe(true);
  expect(ev("[28..32, 18..22, 9..11]", [28, 22, 9])).toBe(true);          // boundaries
  expect(ev("[28..32, 18..22, 9..11]", [32.0000005, 20, 10])).toBe(true); // within 1e-6 slack
  expect(ev("[28..32, 18..22, 9..11]", [32.001, 20, 10])).toBe(false);
  expect(ev("[28..32, 18..22, 9..11]", [30, 17, 10])).toBe(false);
  expect(ev("[*, 18..22, *]", [999, 20, -999])).toBe(true);
  expect(ev("[*, 18..22, *]", [999, 23, -999])).toBe(false);
  expect(ev("40..40,40..40,3..3", [40, 40, 3])).toBe(true);
  expect(evaluateAssertion(parseAssertion("[*, 18..22, 9..11]"), [1, 20, 12]).message)
    .toBe("[1,20,12] out of [*,18..22,9..11]");
});

test("a range-vector attempt is not a bare vector", () => {
  expect(bareVectorHint("[1..2,3,4]")).toBe(null);
  expect(bareVectorHint("[28..32,18..22,9..11]")).toBe(null);
});
