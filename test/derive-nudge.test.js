import { expect, test } from "vitest";
import { nudgeAttribution } from "../src/framework/derive-nudge.js";
import drawerBox from "../src/parts/drawer-box.js";
import hand from "../src/parts/hand.js";

test("drawer-box: each drawer's opening depends on its own slider and the depth", () => {
  const n = nudgeAttribution(drawerBox, { ...drawerBox.defaults }, { steps: new Map([["drawer2Open", 0.1]]) });
  expect([...n.depsForPath("open.1")].sort()).toEqual(["depth", "drawer2Open"]);
  expect([...n.depsForPath("pulls.0")].sort()).toEqual(["depth", "drawer1Open", "height"]);
  expect(n.depsForPath("nothing")).toBeNull();
});

test("hand: the index finger's pose never depends on the thumb", () => {
  const n = nudgeAttribution(hand, { ...hand.defaults }, { budgetMs: 1000 });
  const deps = n.depsForPath("index");
  expect(deps.has("indexCurl")).toBe(true);
  expect(deps.has("thumbCurl")).toBe(false);
});

test("budget, grouped derives and throws", () => {
  const slow = { derive: (p) => { const t = Date.now(); while (Date.now() - t < 20) { /* spin */ } return { a: p.x }; } };
  expect(nudgeAttribution(slow, { x: 1 }, { budgetMs: 10 })).toBeNull();
  expect(nudgeAttribution({ derive: { g: (p) => ({ a: p.x }) } }, { x: 1 })).toBeNull();
  const throws = { derive: (p) => { if (p.x > 1) throw new Error("no"); return { a: p.x, b: p.y }; } };
  const n = nudgeAttribution(throws, { x: 1, y: 2 });
  expect(n.depsForPath("b").has("x")).toBe(true);
  expect(n.depsForPath("a").has("y")).toBe(false);
});

test("no derive, too many inputs, skipped inputs and function leaves", () => {
  expect(nudgeAttribution({}, { x: 1 })).toBeNull();
  const many = { derive: (p) => ({ a: p.x + p.y + p.z }) };
  expect(nudgeAttribution(many, { x: 1, y: 1, z: 1 }, { maxCalls: 2 })).toBeNull();
  const str = { derive: (p) => ({ a: p.s, b: p.x, f: () => Math.random() }) };
  const n = nudgeAttribution(str, { s: "hi", x: 2 });
  expect(n.inputs).toEqual(["s", "x"]);
  expect(n.depsForPath("b").has("s")).toBe(true);
  expect(n.depsForPath("f")).toBeNull();
});

test("a large derive answers path lookups from an index, not a scan of every leaf", () => {
  // 1,500 leaf paths (500 points × [x, y, z]) and 30,000 lookups - the shape of a
  // laser-box generate (855 leaves × ~6,000 log entries), scaled up.
  const big = { derive: (p) => ({ pts: Array.from({ length: 500 }, (_, i) => [p.a * i, p.b, i]), w: p.a }) };
  const n = nudgeAttribution(big, { a: 1, b: 2 }, { budgetMs: 1000 });
  expect([...n.depsForPath("pts")].sort()).toEqual(["a", "b"]);
  expect([...n.depsForPath("pts.3")].sort()).toEqual(["a", "b"]);
  expect([...n.depsForPath("pts.3.0")]).toEqual(["a"]);
  expect([...n.depsForPath("pts.3.2")]).toEqual([]); // a constant leaf: no input moves it
  expect([...n.depsForPath("pts.length")].sort()).toEqual(["a", "b"]); // not in the output: its parent answers
  expect([...n.depsForPath("pts.3.0.toFixed")]).toEqual(["a"]);
  expect(n.depsForPath("pt")).toBeNull(); // a prefix of a key, not of a path
  const t0 = performance.now();
  for (let r = 0; r < 20; r++) for (let i = 0; i < 500; i++) { n.depsForPath(`pts.${i}`); n.depsForPath(`pts.${i}.1`); n.depsForPath("w"); }
  expect(performance.now() - t0).toBeLessThan(250);
});

test("the whole pass is bounded: past totalMs the remaining inputs count for everything", () => {
  let clock = 0;
  const part = { derive: (p) => { clock += 4; return { a: p.x, b: p.y, c: p.z }; } };
  const n = nudgeAttribution(part, { x: 1, y: 2, z: 3 }, { budgetMs: 10, totalMs: 6, now: () => clock });
  // base call: 4 ms. x is nudged (clock 8, past the 6 ms total); y and z are not.
  expect([...n.depsForPath("a")].sort()).toEqual(["x", "y", "z"]);
  expect([...n.depsForPath("b")].sort()).toEqual(["y", "z"]);
  expect(clock).toBe(8);
});
