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
  expect(() => parseAssertion("[1..2,3,4]")).toThrow(/exactly 3 plain numbers/);
});

test("bareVectorHint is null for anything that is not a bare vector", () => {
  for (const e of ["<=[1,2,3]", ">=5", "1..2", 3, true, null, { a: 1 }]) expect(bareVectorHint(e)).toBe(null);
});

test("vector components must be plain numbers or *", () => {
  expect(() => parseAssertion("<=[40mm,40,10]")).toThrow(/each a plain number in mm or \*/);
  expect(() => parseAssertion("<=[,1,2]")).toThrow(/each a plain number/);
  expect(() => parseAssertion("<=[1..2,1,2]")).toThrow(/each a plain number/);
});
