import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel, measure } from "../src/testing.js";
import demo from "../src/parts/demo.js";
import robotArm from "../src/parts/robot-arm.js";
import { handlesReport } from "../src/framework/oracle/handles.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// The demo spacer plus handles of every generic kind. `unrelated` drives a key no
// sub-part reads, so Pose mode would not show it in this view.
const fixture = {
  ...demo,
  defaults: { ...demo.defaults, lk: true },
  handles: {
    top: { point: (p) => [0, 0, p.h], params: ["h"], drag: "axis", direction: [0, 0, 1], label: "Height" },
    rim: { point: (p) => [p.od / 2, 0, 0], params: ["od"] },
    shelf: { point: (p) => [p.od / 3, 0, 1 / 3], params: ["od", "h"], drag: "plane", normal: [0, 0, 1], lock: "lk" },
    spin: { point: () => [10, 0, 0], params: ["bore"], drag: "rotary", axis: { origin: [0, 0, 1], direction: [0, 0, 1] } },
    broken: { point: () => { throw new Error("no point here\nsecond line"); }, params: ["od"] },
    unrelated: { point: () => [0, 0, 0], params: ["nothingReadsThis"] },
  },
};

describe("handles in the measure report", () => {
  it("lists generic handles in declaration order with the contract's shape", () => {
    const r = measure(k, fixture, "spacer");
    expect(JSON.parse(JSON.stringify(r.handles))).toEqual([
      { id: "top", label: "Height", kind: "axis", point: [0, 0, 10], params: ["h"], locked: false, direction: [0, 0, 1] },
      { id: "rim", label: "rim", kind: "point", point: [4, 0, 0], params: ["od"], locked: false },
      { id: "shelf", label: "shelf", kind: "plane", point: [2.667, 0, 0.333], params: ["od", "h"], locked: true, direction: [0, 0, 1] },
      { id: "spin", label: "spin", kind: "rotary", point: [10, 0, 0], params: ["bore"], locked: false, direction: [0, 0, 1], origin: [0, 0, 1] },
      { id: "broken", label: "broken", kind: "point", point: null, params: ["od"], locked: false, error: "no point here" },
    ]);
  });

  it("reads points at the params measured", () => {
    const r = measure(k, fixture, "spacer", { h: 20, lk: false });
    expect(r.handles.find((h) => h.id === "top").point).toEqual([0, 0, 20]);
    expect(r.handles.find((h) => h.id === "shelf").locked).toBe(false);
  });

  it("reports a limb goal handle", () => {
    const h = handlesReport(robotArm, Object.keys(robotArm.views)[0]);
    const tool = h.find((e) => e.id === "tool");
    expect(tool.kind).toBe("limb-goal");
    expect(tool.params).toEqual(["toolX", "toolY", "toolZ", "toolPitch", "toolYaw", "toolRoll"]);
    expect(tool.point).toHaveLength(3);
    expect(tool.locked).toBe(false);
    expect(tool.direction).toBeUndefined();
  });

  it("has no handles key on a part without handles", () => {
    expect("handles" in measure(k, demo, "spacer")).toBe(false);
    expect(handlesReport(demo, "spacer", {})).toBeUndefined();
  });
});
