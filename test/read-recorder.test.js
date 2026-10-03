import { expect, test } from "vitest";
import { recorder, newReadSink, expandReads, expandDerivedReads } from "../src/framework/read-recorder.js";
import { resolveDerived, resolveDerivedAttributed } from "../src/framework/derive.js";

test("get records the key and returns the real value", () => {
  const seen = new Set();
  const p = recorder({ a: 1, b: 2 }, seen);
  expect(p.a).toBe(1);
  expect([...seen]).toEqual(["a"]);
});

test("`in` counts as a read", () => {
  const seen = new Set();
  expect("a" in recorder({ a: 1 }, seen)).toBe(true);
  expect(seen.has("a")).toBe(true);
});

test("spreading, Object.keys, entries and JSON.stringify read every key", () => {
  for (const use of [(p) => ({ ...p }), (p) => Object.keys(p), (p) => JSON.stringify(p), (p) => Object.entries(p)]) {
    const seen = new Set();
    use(recorder({ a: 1, b: 2, c: 3 }, seen));
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  }
});

test("default recorder writes hit a clone; a through recorder writes the original", () => {
  const orig = { a: 1 };
  recorder(orig, new Set()).a = 9;
  expect(orig.a).toBe(1);
  recorder(orig, new Set(), { through: true }).a = 9;
  expect(orig.a).toBe(9);
});

test("expandDerivedReads: grouped attribution, and the fold-everything fallbacks", () => {
  const depsOf = new Map([["area", new Set(["w", "h"])]]);
  expect([...expandDerivedReads(new Set(["x"]), new Set(["area"]), { depsOf, allInputs: new Set(["w", "h", "z"]) })].sort())
    .toEqual(["h", "w", "x"]);
  expect([...expandDerivedReads(new Set(), new Set(["area"]), { depsOf: null, allInputs: new Set(["w", "z"]) })].sort())
    .toEqual(["w", "z"]);
  expect([...expandDerivedReads(new Set(), new Set(["nope"]), { depsOf, allInputs: new Set(["w", "z"]) })].sort())
    .toEqual(["w", "z"]);
});

test("expandReads returns the sink's raw keys sorted", () => {
  const sink = newReadSink();
  sink.raw.add("b"); sink.raw.add("a");
  expect(expandReads(sink)).toEqual(["a", "b"]);
});

const grouped = { derive: { base: (p) => ({ area: p.w * p.h }), vol: (p, d) => ({ vol: d.area * p.t }) } };
const single = { derive: (p) => ({ area: p.w * p.h }) };
const P = () => ({ w: 2, h: 3, t: 4, unused: 5 });

test("resolveDerivedAttributed produces the same d as resolveDerived", () => {
  expect(resolveDerivedAttributed(grouped, P()).d).toEqual(resolveDerived(grouped, P()));
  expect(resolveDerivedAttributed(single, P()).d).toEqual(resolveDerived(single, P()));
  expect(resolveDerivedAttributed({}, P())).toEqual({ d: {}, depsOf: null, allInputs: new Set() });
});

test("grouped attribution is transitive through earlier groups", () => {
  const { depsOf, allInputs } = resolveDerivedAttributed(grouped, P());
  expect([...depsOf.get("area")].sort()).toEqual(["h", "w"]);
  expect([...depsOf.get("vol")].sort()).toEqual(["h", "t", "w"]);
  expect(allInputs.has("unused")).toBe(false);
});

test("a group reading a not-yet-produced key throws the same error as resolveDerived", () => {
  const bad = { derive: { a: (p, d) => ({ x: d.missing }) } };
  expect(() => resolveDerived(bad, P())).toThrow(/derive: group read "missing"/);
  expect(() => resolveDerivedAttributed(bad, P())).toThrow(/derive: group read "missing"/);
});

test("through: a derive that writes to p leaves the write on p, as resolveDerived does", () => {
  const writer = { derive: (p) => { p.extra = p.w * 10; return { area: p.w }; } };
  const a = P(); resolveDerived(writer, a);
  const b = P(); resolveDerivedAttributed(writer, b, { through: true });
  expect(b.extra).toBe(a.extra);
});
