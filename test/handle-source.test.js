import { expect, test } from "vitest";
import { handleKind, handleParamKeys, handleAt, sourceInfo, locateHandle, resolveGeom, handleAxis, handleRecord } from "../src/framework/pose/handle-source.js";
import robotArm from "../src/parts/robot-arm.js";
import hand from "../src/parts/hand.js";

const source = {
  handleInfo: () => ({
    kind: "partforge.points",
    points: { "gear1.rim": [10, 0, 0], "gear1.center": [0, 0, 0], "gear2.center": [20, 0, 0] },
    axes: { gear1: { origin: [0, 0, 0], direction: [0, 0, 1] } },
    lines: [["gear1.center", "gear2.center"]],
  }),
};
const d = { train: source };
const mk = (handles) => ({ defaults: { w: 4 }, handles });

test("handleKind", () => {
  expect(handleKind({ on: "a", drag: "goal" })).toBe("limb");
  expect(handleKind({ on: "a", drag: "angles" })).toBe("limb");
  expect(handleKind({ on: "t", at: "x" })).toBe("on");
  expect(handleKind({ on: "t", at: "x", drag: "axis" })).toBe("on");
  expect(handleKind({ point: () => [0, 0, 0], drag: "goal" })).toBe("point");
  expect(handleKind({ point: () => [0, 0, 0] })).toBe("point");
  expect(handleKind({ on: "t", point: () => [0, 0, 0] })).toBe(null);
  expect(handleKind({})).toBe(null);
  expect(handleKind(null)).toBe(null);
});

test("handleKind with d: goal / angles are limb drags only on a posed limb", () => {
  const limbD = { arm: { ikInfo: () => ({}), handleInfo: () => ({ points: {} }) }, train: source };
  expect(handleKind({ on: "arm", drag: "goal" }, limbD)).toBe("limb");
  expect(handleKind({ on: "arm", drag: "angles" }, limbD)).toBe("limb");
  expect(handleKind({ on: "arm", at: "tip", drag: "axis" }, limbD)).toBe("on");
  expect(handleKind({ on: "arm", at: "tip" }, limbD)).toBe("on");
  expect(handleKind({ on: "train", at: "gear1.rim", drag: "goal" }, limbD)).toBe("on");
});

test("handleAt and sourceInfo", () => {
  expect(handleAt({ on: "t", at: "gear1.rim" })).toBe("gear1.rim");
  expect(handleAt({ point: () => [0, 0, 0] })).toBe("point");
  expect(sourceInfo(d, "train").kind).toBe("partforge.points");
  expect(sourceInfo(d, "nope")).toBe(null);
  expect(sourceInfo({ x: {} }, "x")).toBe(null);
});

test("locateHandle: on, point, throwing", () => {
  expect(locateHandle(null, {}, d, { on: "train", at: "gear1.rim" })).toEqual([10, 0, 0]);
  expect(locateHandle(null, { w: 4 }, d, { point: (p) => [p.w / 2, 0, 1] })).toEqual([2, 0, 1]);
  expect(() => locateHandle(null, {}, d, { point: () => { throw new Error("boom"); } })).toThrow("boom");
  expect(() => locateHandle(null, {}, d, { on: "train", at: "missing" })).toThrow();
  expect(() => locateHandle(null, {}, d, { on: "nope", at: "x" })).toThrow();
  const limbD = { arm: { ikInfo: () => ({}), world: (at) => ({ origin: [1, 2, at === "tip" ? 3 : 4] }) } };
  expect(locateHandle(null, {}, limbD, { on: "arm", drag: "goal" })).toEqual([1, 2, 3]);
  expect(locateHandle(null, {}, limbD, { on: "arm", at: "elbow", drag: "angles" })).toEqual([1, 2, 4]);
});

test("resolveGeom", () => {
  expect(resolveGeom([1, 0, 0], {}, d)).toEqual([1, 0, 0]);
  expect(resolveGeom((p) => [p.w, 0, 0], { w: 2 }, d)).toEqual([2, 0, 0]);
});

test("handleAxis", () => {
  const rotary = { on: "train", at: "gear1.rim", drag: "rotary" };
  expect(handleAxis(rotary, {}, d)).toEqual({ origin: [0, 0, 0], direction: [0, 0, 1] });
  const own = { ...rotary, axis: { origin: [1, 1, 1], direction: [1, 0, 0] } };
  expect(handleAxis(own, {}, d)).toEqual({ origin: [1, 1, 1], direction: [1, 0, 0] });
  const axis = { point: () => [1, 2, 3], drag: "axis", direction: (p) => [0, p.w, 0] };
  expect(handleAxis(axis, { w: 1 }, d)).toEqual({ origin: [1, 2, 3], direction: [0, 1, 0] });
  const plane = { point: () => [1, 2, 3], drag: "plane", normal: [0, 0, 1] };
  expect(handleAxis(plane, {}, d)).toEqual({ origin: [1, 2, 3], direction: [0, 0, 1] });
  expect(handleAxis({ point: () => [0, 0, 0], drag: "point" }, {}, d)).toBe(null);
});

test("handleRecord shape", () => {
  const part = mk({ input: { on: "train", at: "gear1.rim", params: ["w"], drag: "rotary" } });
  const rec = handleRecord(part, {}, d, "input");
  expect(Object.keys(rec).sort()).toEqual(["axes", "axis", "drag", "handleId", "joints", "kind", "lines", "name", "points", "tip", "values"]);
  expect(rec).toEqual({
    kind: "partforge.handle", name: "handle:input", handleId: "input", joints: [], points: { tip: [10, 0, 0] }, tip: "tip",
    values: [], axes: {}, lines: [[[0, 0, 0], [20, 0, 0]]], drag: "rotary", axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
  });
  const pt = mk({ c: { point: () => [1, 2, 3], params: ["w"], drag: "point" } });
  expect("lines" in handleRecord(pt, {}, d, "c")).toBe(false);
  expect(handleRecord(mk({ c: { point: () => { throw new Error("x"); }, params: [] } }), {}, d, "c")).toBe(null);
  expect(handleRecord(mk({ l: { on: "a", drag: "goal" } }), {}, d, "l")).toBe(null);
});

test("handleRecord drag defaults to point", () => {
  const rec = handleRecord(mk({ c: { point: () => [1, 2, 3], params: ["w"] } }), {}, d, "c");
  expect(rec.drag).toBe("point");
  expect(rec.axis).toBe(null);
});

test("handleParamKeys is unchanged for limb handles", () => {
  expect(handleParamKeys(robotArm.handles.tool)).toEqual([
    "toolX", "toolY", "toolZ", "toolPitch", "toolYaw", "toolRoll",
    ...robotArm.handles.tool.seed,
  ]);
  expect(handleParamKeys(hand.handles.index)).toEqual(["indexKnuckle", "indexCurl", "indexSpread", "wristPitch", "wristYaw"]);
  expect(handleParamKeys({ on: "t", at: "a", params: ["a", "b"], lock: "l" })).toEqual(["a", "b", "l"]);
  expect(handleParamKeys({ point: () => [0, 0, 0], params: ["a"] })).toEqual(["a"]);
});

test("a geometric drag on a limb point reads the limb's handleInfo", async () => {
  const { limb } = await import("../src/framework/domains/kinematics/index.js");
  const arm = limb("arm", { toward: [0, 0, 1], bendToward: [1, 0, 0], joints: ["s", "e"], lengths: [10, 10] }).pose({ bend: { s: 0, e: 90 } });
  const limbD = { arm };
  const h = { on: "arm", at: "tip", drag: "axis", direction: [0, 0, 1], params: ["w"] };
  expect(handleKind(h, limbD)).toBe("on");
  expect(locateHandle(null, {}, limbD, h)).toEqual(arm.ikInfo().points.tip);
  const rec = handleRecord(mk({ h }), {}, limbD, "h");
  expect(rec.points.tip).toEqual(arm.ikInfo().points.tip);
  expect(rec.axis).toEqual({ origin: arm.ikInfo().points.tip, direction: [0, 0, 1] });
  expect(rec.lines.length).toBe(2);
  const rotary = { on: "arm", at: "e", drag: "rotary", params: ["w"] };
  expect(handleAxis(rotary, {}, limbD)).toEqual({ origin: arm.ikInfo().points.e, direction: arm.ikInfo().axes.e });
});
