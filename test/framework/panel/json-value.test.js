import { expect, test } from "vitest";
import { isJsonValue, jsonValueProblem, CUSTOM_VALUE_MAX_BYTES, CUSTOM_VALUE_MAX_DEPTH } from "../../../src/framework/panel/json-value.js";

test("primitives, arrays and plain objects of primitives are JSON values", () => {
  for (const v of [0, -1.5, "x", "", true, false, [], {}, [1, "a", [true]], { a: { b: [1, { c: "d" }] } }]) {
    expect(jsonValueProblem(v), JSON.stringify(v)).toBeNull();
    expect(isJsonValue(v)).toBe(true);
  }
});

test("null, non-finite numbers, functions and class instances are refused, with a path", () => {
  expect(jsonValueProblem(null)).toBe("is null");
  expect(jsonValueProblem({ a: [1, null] })).toBe("is null at a[1]");
  expect(jsonValueProblem(NaN)).toBe("is a non-finite number");
  expect(jsonValueProblem({ h: Infinity })).toBe("is a non-finite number at h");
  expect(jsonValueProblem(() => 1)).toBe("is a function");
  expect(jsonValueProblem({ f() {} })).toBe("is a function at f");
  expect(jsonValueProblem(new Date(0))).toBe("is not a plain object");
  expect(jsonValueProblem({ d: new Map() })).toBe("is not a plain object at d");
  expect(jsonValueProblem(10n)).toBe("is a bigint");
  expect(jsonValueProblem(undefined)).toBe("is a undefined");
});

test("the forbidden keys are refused wherever they appear", () => {
  expect(jsonValueProblem(JSON.parse('{"__proto__": 1}'))).toBe('uses the forbidden key "__proto__"');
  expect(jsonValueProblem({ a: { constructor: 1 } })).toBe('uses the forbidden key "constructor" at a');
  expect(jsonValueProblem({ prototype: 1 })).toBe('uses the forbidden key "prototype"');
});

test("depth and size caps", () => {
  expect(CUSTOM_VALUE_MAX_DEPTH).toBe(8);
  expect(CUSTOM_VALUE_MAX_BYTES).toBe(16384);
  let deep = 1;
  for (let i = 0; i < 8; i++) deep = [deep];        // 8 nested arrays: depths 0..7 — allowed
  expect(jsonValueProblem(deep)).toBeNull();
  deep = [deep];                                     // a 9th level
  expect(jsonValueProblem(deep)).toMatch(/^nests deeper than 8 levels/);
  const big = { s: "x".repeat(16384) };
  expect(jsonValueProblem(big)).toMatch(/^is \d+ bytes serialized; the cap is 16384$/);
  expect(jsonValueProblem(big, { maxBytes: Infinity })).toBeNull();
  expect(jsonValueProblem(deep, { maxDepth: 20 })).toBeNull();
});

test("the byte count is UTF-8 bytes, not characters", () => {
  // 5462 three-byte characters serialize past 16384 bytes but under it in chars.
  const v = { s: "€".repeat(5462) };
  expect(JSON.stringify(v).length).toBeLessThan(16384);
  expect(jsonValueProblem(v)).toMatch(/bytes serialized/);
});
