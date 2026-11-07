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
  const slow = { derive: (p) => { const t = Date.now(); while (Date.now() - t < 20) {} return { a: p.x }; } };
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
