import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel, measure } from "../src/testing.js";
import drawerBox from "../src/parts/drawer-box.js";
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
    expect(tool.kind).toBe("goal");
    expect(tool.params).toEqual(["toolX", "toolY", "toolZ", "toolPitch", "toolYaw", "toolRoll"]);
    expect(tool.point).toHaveLength(3);
    expect(tool.locked).toBe(false);
    expect(tool.direction).toBeUndefined();
  });

  it("an entry carries the handle's group when it sets one, and only then", () => {
    const part = { ...demo, handles: { a: { point: () => [0, 0, 0], params: ["od"], group: "rims" }, b: { point: () => [1, 0, 0], params: ["od"] } } };
    const r = handlesReport(part, "spacer", {});
    expect(r.find((e) => e.id === "a").group).toBe("rims");
    expect("group" in r.find((e) => e.id === "b")).toBe(false);
  });

  it("skips a null or non-object handles entry instead of throwing", () => {
    const part = { ...demo, handles: { bad: null, num: 3, ok: { point: () => [0, 0, 0], params: ["od"] } } };
    expect(handlesReport(part, "spacer", {}).map((e) => e.id)).toEqual(["ok"]);
    // a failing relevance analysis (RELEVANT_ALL) makes every entry a candidate
    const sp = Object.values(demo.parts)[0];
    const all = { ...part, parts: { ...demo.parts, [Object.keys(demo.parts)[0]]: { ...sp, enabled: () => { throw new Error("x"); } } } };
    expect(handlesReport(all, "spacer", {}).map((e) => e.id)).toEqual(["ok"]);
  });

  it("has no handles key on a part without handles", () => {
    expect("handles" in measure(k, demo, "spacer")).toBe(false);
    expect(handlesReport(demo, "spacer", {})).toBeUndefined();
  });

  it("reports which handles a cached preview would show, and why the rest are hidden", () => {
    const r = measure(k, drawerBox, Object.keys(drawerBox.views)[0], {}, { previewHandles: true });
    expect(r.previewHandles.shown).toEqual(["drawer1", "drawer2", "drawer3"]);
    expect(r.previewHandles.hidden.corner).toMatch(/rebuilds/);
  });

  it("a part without handles reports no previewHandles either", () => {
    expect("previewHandles" in measure(k, demo, "spacer", {}, { previewHandles: true })).toBe(false);
  });

  it("previewHandles is opt-in: absent without the flag", () => {
    const r = measure(k, drawerBox, Object.keys(drawerBox.views)[0]);
    expect(r.handles.length).toBeGreaterThan(0);
    expect("previewHandles" in r).toBe(false);
  });
});
