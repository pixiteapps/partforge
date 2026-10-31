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
  expect(rulesOf(handleFindings({ a: goal({ params: { position: ["x", "y", "z"], aim: ["x"] }, toward: [1, 0, 0] }) }))).toEqual(["handle-param-count"]);
  expect(handleFindings({ a: goal({ params: { position: ["x", "y", "z"], aim: ["x", "y"] }, toward: [1, 0, 0] }) })).toEqual([]);
});

test("handle-param-count: the aim hint names angles, not a direction", () => {
  const [f] = handleFindings({ a: goal({ params: { position: ["x", "y", "z"], aim: ["x"] }, toward: [1, 0, 0] }) });
  expect(f.hint).toMatch(/pitch, yaw/);
  expect(f.hint).not.toMatch(/direction vector/);
});

test("handle-aim-toward: a goal handle with aim names its rest toward", () => {
  const aim = { position: ["x", "y", "z"], aim: ["x", "y"] };
  const fs = handleFindings({ a: goal({ params: aim }) });
  expect(rulesOf(fs)).toEqual(["handle-aim-toward"]);
  expect(fs[0].path).toBe("handles.a.toward");
  expect(rulesOf(handleFindings({ a: goal({ params: aim, toward: [0, 0, 0] }) }))).toEqual(["handle-aim-toward"]);
  expect(rulesOf(handleFindings({ a: goal({ params: aim, toward: [1, 0] }) }))).toEqual(["handle-aim-toward"]);
  expect(handleFindings({ a: goal({ params: aim, toward: [0, 0, 1] }) })).toEqual([]);
  // at a joint too: the rings turn the goal's aim parameters, whichever point holds it
  expect(handleFindings({ a: goal({ at: "pip", params: aim, toward: [0, 0, 1] }) })).toEqual([]);
});

test("handle-unknown-param: a lock may default to a boolean; nothing else may", () => {
  const angles = (over) => ({ a: { limb: "finger", mode: "angles", params: ["mcp"], ...over } });
  expect(handleFindings(angles({ lock: "held" }), { held: false })).toEqual([]);
  expect(handleFindings(angles({ lock: "held" }), { held: true })).toEqual([]);
  expect(rulesOf(handleFindings(angles({ lock: "held" }), { held: "no" }))).toEqual(["handle-unknown-param"]);
  expect(rulesOf(handleFindings(angles({ params: ["held"] }), { held: false }))).toEqual(["handle-unknown-param"]);
  expect(rulesOf(handleFindings({ a: goal({ seed: ["held"] }) }, { held: false }))).toEqual(["handle-unknown-param"]);
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

test("joints (an angles handle's joint rings): valid entries produce no findings", () => {
  const angles = (joints) => ({ a: { limb: "finger", mode: "angles", params: ["mcp", "pip"], joints } });
  expect(handleFindings(angles({ mcp: "mcp", pip: { param: "pip", scale: -1 } }))).toEqual([]);
  expect(handleFindings(angles({ "finger.mcp": "mcp" }))).toEqual([]);
});

test("handle-unknown-joint: a joints key must name a joint of a posed limb, in the shape it takes", () => {
  const angles = (joints, mode = "angles") => ({ a: { limb: "finger", mode, params: ["mcp"], joints } });
  const unknown = handleFindings(angles({ zzz: "mcp" }));
  expect(rulesOf(unknown)).toEqual(["handle-unknown-joint"]);
  expect(unknown[0].path).toBe("handles.a.joints.zzz");
  expect(unknown[0].hint).toMatch(/mcp, pip/);
  expect(rulesOf(handleFindings(angles({ "ghost.mcp": "mcp" })))).toEqual(["handle-unknown-joint"]);
  // a hinge takes a name or { param, scale }; a zero scale is refused
  expect(rulesOf(handleFindings(angles({ mcp: { bend: "mcp" } })))).toContain("handle-unknown-joint");
  expect(rulesOf(handleFindings(angles({ mcp: { param: "mcp", scale: 0 } })))).toEqual(["handle-unknown-joint"]);
  // a goal handle maps its rings through seed; `joints` must be an object
  expect(rulesOf(handleFindings({ a: goal({ joints: { mcp: "mcp" } }) }))).toEqual(["handle-unknown-joint"]);
  expect(rulesOf(handleFindings(angles(["mcp"])))).toEqual(["handle-unknown-joint"]);
});

test("handle-unknown-param: a joints entry must name a numeric parameter", () => {
  const angles = (joints) => ({ a: { limb: "finger", mode: "angles", params: ["mcp"], joints } });
  const fs = handleFindings(angles({ mcp: "nope" }));
  expect(rulesOf(fs)).toEqual(["handle-unknown-param"]);
  expect(fs[0].path).toBe("handles.a.joints.mcp");
  expect(rulesOf(handleFindings(angles({ mcp: "label" })))).toEqual(["handle-unknown-param"]); // a string default
  expect(rulesOf(handleFindings(angles({ mcp: { param: "nope" } })))).toEqual(["handle-unknown-param"]);
});
