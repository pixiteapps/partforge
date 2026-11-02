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
const goal = (over = {}) => ({ on: "finger", drag: "goal", params: { position: ["x", "y", "z"] }, ...over });
const handleFindings = (handles, defaults) => {
  const r = lintPart(partWith(handles, defaults));
  return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule.startsWith("handle-"));
};
const rulesOf = (fs) => fs.map((f) => f.rule);

test("a valid goal handle and a valid angles handle produce no handle findings", () => {
  expect(handleFindings({ tip: goal({ at: "pip", seed: ["mcp"] }), curl: { on: "finger", drag: "angles", params: ["mcp", "pip"], lock: "mcp" } })).toEqual([]);
});

test("handle-unknown-source: a goal / angles handle whose on is missing from derive or not a posed limb", () => {
  const fs = handleFindings({ a: goal({ on: "nope" }), b: goal({ on: "ghost" }) });
  expect(rulesOf(fs)).toEqual(["handle-unknown-source", "handle-unknown-source"]);
  expect(fs[0].path).toBe("handles.a.on");
  expect(fs[0].hint).toBeTruthy();
});

test("handle-unknown-param: unknown param, non-numeric default, seed and lock", () => {
  expect(rulesOf(handleFindings({ a: goal({ params: { position: ["x", "y", "nope"] } }) }))).toContain("handle-unknown-param");
  expect(rulesOf(handleFindings({ a: goal() }, { z: "str" }))).toContain("handle-unknown-param");
  expect(rulesOf(handleFindings({ a: goal({ seed: ["nope"] }) }))).toContain("handle-unknown-param");
  expect(rulesOf(handleFindings({ a: { on: "finger", drag: "angles", params: ["mcp"], lock: "nope" } }))).toContain("handle-unknown-param");
  expect(handleFindings({ a: { on: "finger", drag: "angles", params: ["mcp", "bad"] } })[0].path).toBe("handles.a.params");
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
  const angles = (over) => ({ a: { on: "finger", drag: "angles", params: ["mcp"], ...over } });
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

test("handle-bad-drag: a limb handle's drag must be a known kind, and a limb never defaults one", () => {
  expect(rulesOf(handleFindings({ a: goal({ drag: "wiggle" }) }))).toEqual(["handle-bad-drag"]);
  expect(rulesOf(handleFindings({ a: { on: "finger", params: ["mcp"] } }))).toEqual(["handle-bad-drag"]);
  expect(handleFindings({ a: { on: "finger", params: ["mcp"] } })[0].path).toBe("handles.a.drag");
  // goal / angles need `on` naming a posed limb, never a `point`
  expect(rulesOf(handleFindings({ a: { point: () => [0, 0, 0], drag: "angles", params: ["mcp"] } }))).toEqual(["handle-bad-drag"]);
});

test("a geometric drag may sit on a limb's point (its handleInfo)", () => {
  expect(handleFindings({ a: { on: "finger", at: "tip", drag: "axis", direction: [0, 1, 0], params: ["mcp"] } })).toEqual([]);
  expect(handleFindings({ a: { on: "finger", at: "pip", drag: "rotary", params: ["pip"] } }).filter((f) => f.severity === "error")).toEqual([]);
  expect(rulesOf(handleFindings({ a: { on: "finger", at: "zzz", drag: "axis", direction: [0, 1, 0], params: ["mcp"] } }))).toEqual(["handle-unknown-source"]);
});

test("a part without handles, or with a malformed handles value, never throws", () => {
  expect(() => lintPart({ ...partWith(undefined) })).not.toThrow();
  expect(() => lintPart(partWith("junk"))).not.toThrow();
  expect(() => lintPart(partWith({ a: null, b: 3 }))).not.toThrow();
});

test("joints (an angles handle's joint rings): valid entries produce no findings", () => {
  const angles = (joints) => ({ a: { on: "finger", drag: "angles", params: ["mcp", "pip"], joints } });
  expect(handleFindings(angles({ mcp: "mcp", pip: { param: "pip", scale: -1 } }))).toEqual([]);
  expect(handleFindings(angles({ "finger.mcp": "mcp" }))).toEqual([]);
});

test("handle-unknown-joint: a joints key must name a joint of a posed limb, in the shape it takes", () => {
  const angles = (joints, mode = "angles") => ({ a: { on: "finger", drag: mode, params: ["mcp"], joints } });
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
  const angles = (joints) => ({ a: { on: "finger", drag: "angles", params: ["mcp"], joints } });
  const fs = handleFindings(angles({ mcp: "nope" }));
  expect(rulesOf(fs)).toEqual(["handle-unknown-param"]);
  expect(fs[0].path).toBe("handles.a.joints.mcp");
  expect(rulesOf(handleFindings(angles({ mcp: "label" })))).toEqual(["handle-unknown-param"]); // a string default
  expect(rulesOf(handleFindings(angles({ mcp: { param: "nope" } })))).toEqual(["handle-unknown-param"]);
});

// ---- generic handles: `on` / `point` ----
const pts = (points, extra = {}) => ({ handleInfo: () => ({ kind: "partforge.points", points, ...extra }) });
const genPart = (handles, { derive, parameters, defaults } = {}) => ({
  meta: { title: "T" },
  defaults: { ang: 0, w: 10, r: 20, ...defaults },
  derive: derive ?? ((p) => ({
    gear: pts({ "g.rim": [20 * Math.cos(p.ang * Math.PI / 180), 20 * Math.sin(p.ang * Math.PI / 180), 0], "g.center": [0, 0, 0] },
      { axes: { g: { origin: [0, 0, 0], direction: [0, 0, 1] } } }),
    finger: mkLimb({ mcp: 10, pip: 20 }),
  })),
  parameters: parameters ?? [{ type: "slider", key: "ang", min: 0, max: 360, step: 1, wrap: true }, { type: "slider", key: "w", min: 0, max: 100 }, { type: "slider", key: "r", min: 0, max: 100 }],
  parts: { body: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { main: { label: "Main" } },
  handles,
});
const genFindings = (handles, opts) => {
  const r = lintPart(genPart(handles, opts));
  return [...r.errors, ...r.warnings, ...r.notes].filter((f) => f.rule.startsWith("handle-"));
};
const good = { on: "gear", at: "g.rim", params: ["ang"], drag: "rotary" };

test("generic handles: valid on / point handles produce no findings", () => {
  expect(genFindings({
    input: good,
    corner: { point: (p) => [p.w, p.r, 0], params: ["w", "r"], drag: "plane", normal: [0, 0, 1] },
    slide: { point: (p) => [p.w, 0, 0], params: ["w"], drag: "axis", direction: (p, d) => [1, 0, 0] },
    free: { point: (p) => [p.w, p.r, 0], params: ["w"] },
  })).toEqual([]);
});

test("handle-no-source: neither, or both, of on / point", () => {
  expect(rulesOf(genFindings({ a: { params: ["w"] } }))).toContain("handle-no-source");
  expect(rulesOf(genFindings({ a: { ...good, point: () => [0, 0, 0] } }))).toContain("handle-no-source");
  expect(genFindings({ a: { ...good, point: () => [0, 0, 0] } })[0].path).toBe("handles.a");
});

test("handle-unknown-source: on not in derive, no handleInfo, or at not a point", () => {
  expect(rulesOf(genFindings({ a: { ...good, on: "nope" } }))).toEqual(["handle-unknown-source"]);
  expect(rulesOf(genFindings({ a: { ...good, on: "plain" } }, { derive: () => ({ plain: { x: 1 } }) }))).toEqual(["handle-unknown-source"]);
  const fs = genFindings({ a: { ...good, at: "g.nope" } });
  expect(rulesOf(fs)).toEqual(["handle-unknown-source"]);
  expect(fs[0].path).toBe("handles.a.at");
  expect(fs[0].hint).toMatch(/g\.rim/);
});

test("handle-bad-drag: on naming a posed limb with no drag is an error, not an unknown source", () => {
  expect(rulesOf(genFindings({ a: { on: "finger", at: "tip", params: ["w"] } }))).toEqual(["handle-bad-drag"]);
});

test("handle-bad-drag: unknown drag, axis / plane without a direction, rotary without an axis", () => {
  expect(rulesOf(genFindings({ a: { ...good, drag: "spin", axis: undefined } }))).toEqual(["handle-bad-drag"]);
  expect(rulesOf(genFindings({ a: { point: (p) => [p.w, 0, 0], params: ["w"], drag: "axis" } }))).toEqual(["handle-bad-drag"]);
  expect(rulesOf(genFindings({ a: { point: (p) => [p.w, 0, 0], params: ["w"], drag: "plane", normal: [0, 0, 0] } }))).toEqual(["handle-bad-drag"]);
  expect(rulesOf(genFindings({ a: { point: (p) => [p.w, 0, 0], params: ["w"], drag: "rotary" } }))).toEqual(["handle-bad-drag"]);
  // an axis handle on a source whose axes has the prefix of `at` takes that direction
  expect(genFindings({ a: { on: "gear", at: "g.rim", params: ["ang"], drag: "axis" } })).toEqual([]);
  const noAxes = { derive: (p) => ({ gear: pts({ "g.rim": [p.ang, 0, 0] }) }) };
  expect(rulesOf(genFindings({ a: { on: "gear", at: "g.rim", params: ["ang"], drag: "axis" } }, noAxes))).toEqual(["handle-bad-drag"]);
  // a rotary handle on a source with axes, or given its own axis, is fine
  expect(genFindings({ a: { point: (p) => [p.w, 0, 0], params: ["w"], drag: "rotary", axis: { origin: [0, 0, 0], direction: [0, 0, 1] } } })).toEqual([]);
});

test("handle-point-throws: the point, or an axis function, throws at the defaults", () => {
  const fs = genFindings({ a: { point: () => { throw new Error("boom"); }, params: ["w"] } });
  expect(rulesOf(fs)).toEqual(["handle-point-throws"]);
  expect(fs[0].message).toMatch(/boom/);
  expect(rulesOf(genFindings({ a: { point: () => [0, 0, 0], params: ["w"], drag: "rotary", axis: () => { throw new Error("x"); } } }))).toContain("handle-point-throws");
  expect(rulesOf(genFindings({ a: { point: () => ["a", 0, 0], params: ["w"] } }))).toEqual(["handle-point-throws"]);
});

test("handle-inert (warning): no listed param moves the point", () => {
  const r = lintPart(genPart({ a: { point: (p) => [1, 2, 3], params: ["w"] } }));
  expect(r.warnings.map((f) => f.rule).filter((x) => x.startsWith("handle-"))).toEqual(["handle-inert"]);
  expect(r.errors.filter((f) => f.rule.startsWith("handle-"))).toEqual([]);
  expect(rulesOf(genFindings({ a: { point: (p) => [p.w, 0, 0], params: [] } }))).toEqual(["handle-inert"]);
  // a wrapped param nudges by its step; a gear at radius 0 is inert
  expect(rulesOf(genFindings({ a: { on: "gear", at: "g.center", params: ["ang"], drag: "rotary" } }))).toEqual(["handle-inert"]);
});

test("handle-axis-moves (warning): a rotary axis that follows the handle's own params", () => {
  const derive = (p) => ({ gear: pts({ "g.rim": [20, 0, 0] }, { axes: { g: { origin: [p.ang, 0, 0], direction: [0, 0, 1] } } }) });
  const r = lintPart(genPart({ a: { on: "gear", at: "g.rim", params: ["ang"], drag: "rotary" } }, { derive }));
  expect(r.warnings.map((f) => f.rule)).toContain("handle-axis-moves");
  const tilt = { point: (p) => [p.w, 0, 0], params: ["w"], drag: "rotary", axis: (p) => ({ origin: [0, 0, 0], direction: [Math.sin(p.w / 50), 0, 1] }) };
  expect(rulesOf(genFindings({ a: tilt }))).toContain("handle-axis-moves");
});

test("handle-unknown-param covers generic handles; limb rules skip them", () => {
  const fs = genFindings({ a: { ...good, params: ["ang", "nope"] }, b: { ...good, lock: "nope" } });
  expect(rulesOf(fs)).toEqual(["handle-unknown-param", "handle-unknown-param"]);
  expect(fs[0].path).toBe("handles.a.params");
  expect(rulesOf(genFindings({ a: good }))).not.toContain("handle-unknown-joint");
  expect(rulesOf(genFindings({ a: good }))).not.toContain("handle-param-count");
});

test("generic rules never throw on a malformed declaration", () => {
  expect(() => genFindings({ a: { on: 5, at: {}, params: "x", drag: null }, b: { point: 3, drag: "rotary", axis: 7 }, c: { on: "gear", at: "g.rim", drag: "axis", direction: () => { throw 1; } } })).not.toThrow();
});
