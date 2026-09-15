import { expect, test } from "vitest";
import { readJsonLiteral, writeJsonLiteral, defaultsEntriesIn } from "../../../src/framework/lint/source-scan.js";

const read = (t) => readJsonLiteral(t)?.value;

test("reads arrays and objects of primitives, bare or quoted keys, trailing commas", () => {
  expect(read("[1, 2, 3]")).toEqual([1, 2, 3]);
  expect(read("[{ q: 0, r: 0, height: 10 }, { q: 1, r: 0, height: 14 },]"))
    .toEqual([{ q: 0, r: 0, height: 10 }, { q: 1, r: 0, height: 14 }]);
  expect(read('{ "north": true, \'south\': "x\\n", n: -1.5e2 }')).toEqual({ north: true, south: "x\n", n: -150 });
  expect(read("{}")).toEqual({});
  expect(read("[]")).toEqual([]);
  expect(read("[\n  [0, 0],\n  [1, 0],\n]")).toEqual([[0, 0], [1, 0]]);
});

test("rejects everything the rewriter could not write back identically", () => {
  for (const bad of [
    "[1, 2 * 3]", "[SIZE]", "{ a: `t` }", "[null]", "{ [k]: 1 }", "{ ...x }",
    "[1, // c\n 2]", "[1 /* c */]", "{ a }", "{ a: 1, a: 2 }".replace("a: 2", "a: () => 1"),
    "[0x10]", "[1_000]", "[1n]", "{ __proto__: 1 }", "[1,,2]", "[1] x", "{ a: 1 } ,",
    '"a string"', "42", "true",   // a primitive is readValue's job, not this reader's
  ]) {
    expect(readJsonLiteral(bad), bad).toBeNull();
  }
});

test("applies the value caps", () => {
  let deep = "1";
  for (let i = 0; i < 9; i++) deep = `[${deep}]`;
  expect(readJsonLiteral(deep)).toBeNull();
  expect(readJsonLiteral(`["${"x".repeat(16384)}"]`)).toBeNull();
});

test("pathological nesting fails fast during parsing instead of overflowing the stack", () => {
  // The depth guard must fire WHILE parsing, before a RangeError has any
  // chance to happen — readJsonLiteral only catches its own JsonLiteralError,
  // so an uncaught RangeError would escape to a host outside runRules' try/catch.
  expect(() => readJsonLiteral("[".repeat(50000))).not.toThrow();
  expect(readJsonLiteral("[".repeat(50000))).toBeNull();
  expect(() => readJsonLiteral("{a:".repeat(50000))).not.toThrow();
  expect(readJsonLiteral("{a:".repeat(50000))).toBeNull();
});

test("writes compact JSON under 80 chars, indented JSON above it, relative to the entry's indent", () => {
  expect(writeJsonLiteral([1, 2, 3])).toBe("[1,2,3]");
  const long = Array.from({ length: 12 }, (_, i) => ({ q: i, r: 0, height: 10 + i }));
  const out = writeJsonLiteral(long, { indent: "    " });
  expect(out.startsWith("[\n      {")).toBe(true);        // two spaces deeper than the entry
  expect(out.endsWith("\n    ]")).toBe(true);             // the closing bracket sits under the key
  expect(readJsonLiteral(out)?.value).toEqual(long);      // round-trips through the reader
});

test("defaultsEntriesIn reads a JSON-literal entry and still refuses an expression inside one", () => {
  const src = "export default {\n  defaults: {\n    od: 8,\n    tiles: [{ q: 0, h: 10 }],\n    pts: [[0, 0], [1, 2 * 3]],\n  },\n};";
  const entries = defaultsEntriesIn(src);
  expect(entries.find((e) => e.key === "tiles").readable).toBe(true);
  expect(entries.find((e) => e.key === "pts").readable).toBe(false);
});
