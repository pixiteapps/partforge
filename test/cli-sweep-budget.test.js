// PARTFORGE_SWEEP_BUDGET_MS, as `partforge measure` reads it: a positive ms count or
// "Infinity"; anything invalid falls back to the default minute.
import { expect, test } from "vitest";
import { parseSweepBudget, DEFAULT_SWEEP_BUDGET_MS } from "../bin/sweep-budget.js";

test("the default is a minute", () => {
  expect(DEFAULT_SWEEP_BUDGET_MS).toBe(60_000);
  expect(parseSweepBudget(undefined)).toBe(60_000);
});

test("Infinity is no deadline; a positive number is ms", () => {
  expect(parseSweepBudget("Infinity")).toBe(Infinity);
  expect(parseSweepBudget("6000")).toBe(6000);
  expect(parseSweepBudget("2.5")).toBe(2.5);
});

test("empty, zero, negative and garbage fall back to the default", () => {
  for (const raw of ["", "  ", "0", "-5", "-Infinity", "abc", "12ms", "NaN"]) expect(parseSweepBudget(raw)).toBe(60_000);
});
