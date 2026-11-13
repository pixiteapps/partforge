import { expect, test } from "vitest";
import { recorder, newReadSink, expandReads, expandDerivedReads, orderedReads } from "../src/framework/read-recorder.js";
import { resolveDerived, resolveDerivedAttributed } from "../src/framework/derive.js";
import { recordedParams } from "../src/framework/part-model.js";

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

test("the sink logs reads in order, duplicates kept, enumeration as *", () => {
  const sink = newReadSink({ log: true });
  const p = recorder({ a: 1, b: 2 }, sink.raw, { through: true, log: sink.log });
  void p.a; void p.b; void p.a;
  expect(sink.log).toEqual(["a", "b", "a"]);
  Object.keys(p);
  expect(sink.log.at(-1)).toBe("*");
});

test("deep d recording logs the leaf path and drops the parent entry", () => {
  const sink = newReadSink({ log: true });
  const d = recorder({ open: [1, 2, 3], pulls: [[0, 1, 2]], palm: { place: () => {}, n: 1 } }, sink.dSeen, { through: true, log: sink.log, deep: true });
  void d.open[1];
  void d.pulls[0][2];
  void d.palm.n;
  // A dropped parent leaves a null slot, so log positions never shift.
  expect(sink.log.filter(Boolean)).toEqual([{ path: "open.1" }, { path: "pulls.0.2" }, { path: "palm" }]);
  expect([...sink.dSeen].sort()).toEqual(["open", "palm", "pulls"]);
  expect(Array.isArray(d.open)).toBe(true);
});

test("orderedReads is newest first, expands paths, and refuses an enumeration", () => {
  const attribution = { depsOf: null, allInputs: new Set(["w", "h", "t"]) };
  const nudged = { depsForPath: (path) => (path === "open.1" ? new Set(["t"]) : null) };
  expect(orderedReads(["w", { path: "open.1" }, "h", "w"], { nudged, attribution })).toEqual(["w", "h", "t"]);
  expect(orderedReads(["w", { path: "size" }], { nudged, attribution })).toEqual(["w", "h", "t"]);
  expect(orderedReads(["w", "*"], { nudged, attribution })).toBeNull();
});

test("deep d recording reads frozen data: logs the path, returns the raw value", () => {
  const sink = newReadSink({ log: true });
  const prof = Object.freeze([Object.freeze([0, 0]), Object.freeze([5, 0]), Object.freeze([5, 5])]);
  const d = recorder({ prof, top: Object.freeze({ n: 1 }) }, sink.dSeen, { through: true, log: sink.log, deep: true });
  expect(d.prof.map(([x, y]) => [x, y])).toEqual([[0, 0], [5, 0], [5, 5]]);
  expect(d.prof[1]).toBe(prof[1]); // non-configurable, non-writable: the invariant wants the raw value
  expect(sink.log.filter(Boolean)).toContainEqual({ path: "prof.1" });
  const frozenD = recorder(Object.freeze({ arr: [1, 2] }), sink.dSeen, { through: true, log: sink.log, deep: true });
  expect(frozenD.arr[1]).toBe(2);
});

test("a held derived array read in a loop never scans the log", () => {
  const n = 20000;
  const sink = newReadSink({ log: true });
  let logReads = 0;
  const log = new Proxy(sink.log, {
    get(t, key) { if (typeof key === "string" && /^\d+$/.test(key)) logReads++; return Reflect.get(t, key); },
  });
  const d = recorder({ pts: Array.from({ length: n }, (_, i) => [i, i]) }, sink.dSeen, { through: true, log, deep: true });
  const pts = d.pts;
  let s = 0;
  for (let i = 0; i < n; i++) s += pts[i][0];
  expect(s).toBe((n * (n - 1)) / 2);
  expect(logReads).toBeLessThan(4 * n); // O(1) per read, not a backward scan
  // The ranking still sees leaf reads, newest first, and not the dropped parent.
  const live = sink.log.filter(Boolean);
  expect(live.at(-1)).toEqual({ path: `pts.${n - 1}.0` });
  expect(live.some((e) => e.path === "pts")).toBe(false);
});

test("a nested read drops its parent's newest entry, then the one before", () => {
  const sink = newReadSink({ log: true });
  const d = recorder({ a: [1, 2], b: 3 }, sink.dSeen, { through: true, log: sink.log, deep: true });
  const x = d.a, y = d.a;
  void d.b;
  void y[0];
  void x[1];
  expect(sink.log.filter(Boolean)).toEqual([{ path: "b" }, { path: "a.0" }, { path: "a.1" }]);
  expect(orderedReads(sink.log)).toEqual([]); // tombstones are skipped
});

test("the ordered log is opt-in: a plain sink records sets only, d stays shallow", () => {
  const plain = newReadSink();
  expect(plain.log).toBeNull();
  const open = [1, 2];
  const rec = recordedParams({ p: { w: 1 }, d: { open } }, plain);
  expect(rec.d.open).toBe(open);
  void rec.p.w;
  expect([...plain.raw]).toEqual(["w"]);
  expect([...plain.dSeen]).toEqual(["open"]);
  const logged = newReadSink({ log: true });
  const rec2 = recordedParams({ p: { w: 1 }, d: { open } }, logged);
  void rec2.d.open[1]; void rec2.p.w;
  expect(logged.log.filter(Boolean)).toEqual([{ path: "open.1" }, "w"]);
});
