// dragHandle (oracle/drag.js): a handle drag played headlessly, the way Pose mode would
// play it with no pins — derive only, no kernel, no browser. Run against the shipped
// reference parts, so a regression in a part's handle wiring shows up here too.
import { describe, it, expect } from "vitest";
import { dragHandle } from "../src/oracle.js";
import * as testing from "../src/testing.js";
import gearbox from "../src/parts/gearbox.js";
import drawerBox from "../src/parts/drawer-box.js";
import robotArm from "../src/parts/robot-arm.js";
import hand from "../src/parts/hand.js";
import dragViews from "./fixtures/drag-views-part.js";
import { resolveParams } from "../src/framework/part-model.js";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

describe("dragHandle: rotary (gearbox)", () => {
  it("is on partforge/testing too", () => {
    expect(testing.dragHandle).toBe(dragHandle);
  });

  it("turning the input gear +90 writes driveAngle +90", () => {
    const r = dragHandle(gearbox, { handle: "gear1", turn: 90 });
    expect(r.error).toBeUndefined();
    expect(r.drag).toBe("rotary");
    expect(r.values.driveAngle).toBeCloseTo(90, 0);
    expect(r.missMm).toBeLessThan(0.5);
  });

  it("turning the idler +90 turns the input the other way at the train's ratio", () => {
    // gear2 (30 teeth) meshes gear1 (20): +90 on gear2 is -90 * 30/20 on gear1
    const r = dragHandle(gearbox, { handle: "gear2", turn: 90 });
    expect(r.error).toBeUndefined();
    expect(r.values.driveAngle).toBeCloseTo(-135, 0);
  });

  it("accumulates past a turn: 720 is two turns, not none", () => {
    const r = dragHandle(gearbox, { handle: "gear1", turn: 720 });
    expect(r.values.driveAngle).toBeCloseTo(720, 0);
  });

  it("a rotary drag needs turn, and takes no to", () => {
    expect(dragHandle(gearbox, { handle: "gear1" }).error).toMatch(/turn/);
    expect(dragHandle(gearbox, { handle: "gear1", to: [0, 0, 0] }).error).toMatch(/turn/);
  });
});

describe("dragHandle: axis and plane (drawer-box)", () => {
  it("pulling a drawer's pull out writes its opening", () => {
    const from = resolveParams(drawerBox, {}).d.pulls[0];
    const r = dragHandle(drawerBox, { handle: "drawer1", to: add(from, [0, -44, 0]) });
    expect(r.error).toBeUndefined();
    expect(r.drag).toBe("axis");
    expect(Object.keys(r.values)).toEqual(["drawer1Open"]);
    // 44 mm of a 110 mm travel (depth 120 - 10)
    expect(r.values.drawer1Open).toBeCloseTo(40, 0);
    expect(r.missMm).toBeLessThan(0.2);
  });

  it("projects a to off the axis onto the axis line", () => {
    const from = resolveParams(drawerBox, {}).d.pulls[0];
    const r = dragHandle(drawerBox, { handle: "drawer1", to: add(from, [30, -44, 25]) });
    expect(r.error).toBeUndefined();
    expect(r.target[0]).toBeCloseTo(from[0], 2);
    expect(r.target[2]).toBeCloseTo(from[2], 2);
    expect(r.values.drawer1Open).toBeCloseTo(40, 0);
  });

  it("the corner plane handle writes width and depth", () => {
    const r = dragHandle(drawerBox, { handle: "corner", to: [100, 80, 999] });
    expect(r.error).toBeUndefined();
    expect(r.target[2]).toBeCloseTo(150, 6); // projected onto the plane z = height
    expect(r.values).toEqual({ width: 200, depth: 160 });
    expect(r.missMm).toBeLessThan(0.5);
  });

  it("an axis drag needs to", () => {
    expect(dragHandle(drawerBox, { handle: "drawer1" }).error).toMatch(/to/);
    expect(dragHandle(drawerBox, { handle: "drawer1", to: [1, 2] }).error).toMatch(/to/);
  });
});

describe("dragHandle: goal (robot-arm)", () => {
  const tip = () => resolveParams(robotArm, {}).d.arm.world("tip").origin;

  it("drags the tool to a reachable point", () => {
    const to = add(tip(), [20, -15, 10]);
    const t0 = performance.now();
    const r = dragHandle(robotArm, { handle: "tool", to });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.error).toBeUndefined();
    expect(r.drag).toBe("goal");
    expect(r.grab).toBe("tip");
    expect(r.missMm).toBeLessThan(0.5);
    expect(dist(r.reached, to)).toBeLessThan(0.5);
    expect(Object.keys(r.values)).toEqual(expect.arrayContaining(["toolX", "toolY", "toolZ"]));
  });

  it("grabbed by the elbow, the elbow follows", () => {
    const elbow = resolveParams(robotArm, {}).d.arm.world("elbow").origin;
    // turned 15 degrees about the base's vertical axis: a point the elbow can reach
    const c = Math.cos(Math.PI / 12), s = Math.sin(Math.PI / 12);
    const to = [elbow[0] * c - elbow[1] * s, elbow[0] * s + elbow[1] * c, elbow[2]];
    const t0 = performance.now();
    const r = dragHandle(robotArm, { handle: "tool", grab: "elbow", to });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.error).toBeUndefined();
    expect(r.grab).toBe("elbow");
    expect(dist(r.from, elbow)).toBeLessThan(1e-2);
    expect(dist(r.reached, elbow)).toBeGreaterThan(5);
    expect(r.missMm).toBeLessThan(0.5);
  });

  it("an unreachable to reports how far it missed, without an error", () => {
    const r = dragHandle(robotArm, { handle: "tool", to: [2000, 0, 300] });
    expect(r.error).toBeUndefined();
    expect(r.missMm).toBeGreaterThan(10);
  });

  it("a grab the goal handle cannot be grabbed by is an error", () => {
    expect(dragHandle(robotArm, { handle: "tool", grab: "nope", to: [0, 0, 0] }).error).toMatch(/grab/);
    // the first driven joint's origin cannot move: ring-only, not a grab
    expect(dragHandle(robotArm, { handle: "tool", grab: "base", to: [0, 0, 0] }).error).toMatch(/grab/);
  });
});

describe("dragHandle: angles (hand)", () => {
  it("a fingertip drag moves that finger's params (and the wrist) only", () => {
    const tip = resolveParams(hand, {}).d.index.world("tip").origin;
    const r = dragHandle(hand, { handle: "index", to: add(tip, [0, 0, -15]) });
    expect(r.error).toBeUndefined();
    expect(r.drag).toBe("angles");
    expect(r.grab).toBe("tip");
    const keys = Object.keys(r.values);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(hand.handles.index.params).toContain(k);
    expect(r.missMm).toBeLessThan(dist(tip, add(tip, [0, 0, -15])));
  });

  it("grab takes a joint of the limb or tip, nothing else", () => {
    expect(dragHandle(hand, { handle: "index", grab: "elbow", to: [0, 0, 0] }).error).toMatch(/grab/);
  });
});

describe("dragHandle: bad requests return error, never throw", () => {
  it("unknown handle", () => {
    const r = dragHandle(gearbox, { handle: "nope", turn: 90 });
    expect(r).toEqual({ handle: "nope", error: expect.stringMatching(/unknown handle/) });
    expect(r.error).toMatch(/gear1/); // names the ones there are
  });

  it("a handle the view does not show", () => {
    expect(dragHandle(hand, { handle: "index", view: "print", to: [0, 0, 0] }).error).toMatch(/view/);
  });

  it("a default view that does not show the handle names the views that do", () => {
    const r = dragHandle(dragViews, { handle: "slide", to: [20, 0, 0] });
    expect(r.error).toMatch(/view "print" does not show handle "slide"/);
    expect(r.error).toMatch(/views that show it: assembly — pass one as view/);
    expect(dragHandle(dragViews, { handle: "slide", view: "assembly", to: [20, 0, 0] }).values.x).toBeCloseTo(20, 1);
  });

  it("an unknown view", () => {
    expect(dragHandle(gearbox, { handle: "gear1", view: "nope", turn: 90 }).error).toMatch(/view/);
  });

  it("grab on a generic handle", () => {
    expect(dragHandle(gearbox, { handle: "gear1", grab: "tip", turn: 90 }).error).toMatch(/grab/);
  });

  it("a part with no handles, or no request at all", () => {
    expect(dragHandle({ parts: {}, views: { v: {} } }, { handle: "x", to: [0, 0, 0] }).error).toMatch(/handle/);
    expect(dragHandle(gearbox).error).toMatch(/handle/);
  });
});

describe("dragHandle: rotary turns past half a turn per frame, and stops short honestly", () => {
  const spinner = (wrap) => ({
    parameters: [{ id: "s", title: "Spin", controls: [{ key: "a", min: 0, max: 360, step: 0.1, ...(wrap ? { wrap: true } : {}) }] }],
    defaults: { a: 0 },
    derive: () => ({}),
    parts: { body: { build: () => null } },
    views: { main: { body: {} } },
    handles: {
      rim: {
        point: (p) => [20 * Math.cos((p.a * Math.PI) / 180), 20 * Math.sin((p.a * Math.PI) / 180), 0],
        params: ["a"], drag: "rotary", axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, views: ["main"],
      },
    },
  });

  it("an unwrapped param stopped at its max a whole turn short reports the miss", () => {
    const r = dragHandle(spinner(false), { handle: "rim", turn: 720 });
    expect(r.error).toBeUndefined();
    expect(r.values.a).toBeCloseTo(360, 0);
    expect(r.missMm).toBeCloseTo(20 * 2 * Math.PI, 0); // one whole turn at radius 20
  });

  it("a wrapped param turned many turns accumulates them", () => {
    const r = dragHandle(spinner(true), { handle: "rim", turn: 3000 });
    expect(r.error).toBeUndefined();
    expect(r.values.a).toBeCloseTo(3000, 0);
    expect(r.missMm).toBeLessThan(0.5);
  });

  it("one frame of 300 degrees turns forward, not -60", () => {
    const r = dragHandle(spinner(true), { handle: "rim", turn: 300, steps: 1 });
    expect(r.error).toBeUndefined();
    expect(r.values.a).toBeCloseTo(300, 0);
    expect(r.missMm).toBeLessThan(0.5);
  });

  it("an unwrapped param turned 3000 stops at its max and reports the rest as missed", () => {
    const r = dragHandle(spinner(false), { handle: "rim", turn: 3000 });
    expect(r.error).toBeUndefined();
    expect(r.values.a).toBeCloseTo(360, 0);
    expect(r.missMm).toBeCloseTo((20 * (3000 - 360) * Math.PI) / 180, 0);
  });
});
