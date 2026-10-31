import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";
import { limb } from "../src/framework/domains/kinematics/index.js";

const mkLimb = (p) => limb("finger", {
  at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0],
  joints: [{ name: "mcp", range: [0, 90] }, { name: "pip", range: [0, 90] }],
  lengths: [40, 30],
}).pose({ bend: { mcp: p.mcp, pip: p.pip } });

const partWith = (handles, defaults = {}) => ({
  meta: { title: "T" },
  defaults: { mcp: 10, pip: 20, x: 0, y: 0, z: 50, label: "a", ...defaults },
  derive: (p) => ({ finger: mkLimb(p) }),
  parts: { body: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { main: { label: "Main" } },
  handles,
});
const goal = (over = {}) => ({ limb: "finger", mode: "goal", params: { position: ["x", "y", "z"] }, ...over });
const handleFindings = (handles, defaults) => {
  const r = lintPart(partWith(handles, defaults));
  return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule.startsWith("handle-"));
};
const rulesOf = (fs) => fs.map((f) => f.rule);

test("a valid goal handle and a valid angles handle produce no handle findings", () => {
  expect(handleFindings({ tip: goal({ at: "pip", seed: ["mcp"] }), curl: { limb: "finger", mode: "angles", params: ["mcp", "pip"], lock: "mcp" } })).toEqual([]);
});

test("handle-unknown-limb: a limb missing from derive or not a posed limb", () => {
  const fs = handleFindings({ a: goal({ limb: "nope" }), b: goal({ limb: "ghost" }) });
  expect(rulesOf(fs)).toEqual(["handle-unknown-limb", "handle-unknown-limb"]);
  expect(fs[0].path).toBe("handles.a.limb");
  expect(fs[0].hint).toBeTruthy();
});

test("handle-unknown-param: unknown param, non-numeric default, seed and lock", () => {
  expect(rulesOf(handleFindings({ a: goal({ params: { position: ["x", "y", "nope"] } }) }))).toContain("handle-unknown-param");
  expect(rulesOf(handleFindings({ a: goal() }, { z: "str" }))).toContain("handle-unknown-param");
  expect(rulesOf(handleFindings({ a: goal({ seed: ["nope"] }) }))).toContain("handle-unknown-param");
  expect(rulesOf(handleFindings({ a: { limb: "finger", mode: "angles", params: ["mcp"], lock: "nope" } }))).toContain("handle-unknown-param");
  expect(handleFindings({ a: { limb: "finger", mode: "angles", params: ["mcp", "bad"] } })[0].path).toBe("handles.a.params");
});

test("handle-param-count: position must be 3, aim 2 or 3", () => {
  expect(rulesOf(handleFindings({ a: goal({ params: { position: ["x", "y"] } }) }))).toEqual(["handle-param-count"]);
  expect(rulesOf(handleFindings({ a: goal({ params: { position: ["x", "y", "z"], aim: ["x"] } }) }))).toEqual(["handle-param-count"]);
  expect(handleFindings({ a: goal({ params: { position: ["x", "y", "z"], aim: ["x", "y"] } }) })).toEqual([]);
});

test("handle-unknown-joint: at must be a joint or tip", () => {
  expect(rulesOf(handleFindings({ a: goal({ at: "zzz" }) }))).toEqual(["handle-unknown-joint"]);
  expect(handleFindings({ a: goal({ at: "tip" }) })).toEqual([]);
  expect(handleFindings({ a: goal({ at: "mcp" }) })).toEqual([]);
});

test("handle-bad-mode: mode must be goal or angles", () => {
  expect(rulesOf(handleFindings({ a: goal({ mode: "wiggle" }) }))).toEqual(["handle-bad-mode"]);
  expect(rulesOf(handleFindings({ a: { limb: "finger", params: ["mcp"] } }))).toEqual(["handle-bad-mode"]);
});

test("a part without handles, or with a malformed handles value, never throws", () => {
  expect(() => lintPart({ ...partWith(undefined) })).not.toThrow();
  expect(() => lintPart(partWith("junk"))).not.toThrow();
  expect(() => lintPart(partWith({ a: null, b: 3 }))).not.toThrow();
});
