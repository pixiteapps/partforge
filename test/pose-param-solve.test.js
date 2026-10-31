import { describe, it, expect } from "vitest";
import { limbInfo, solveAngles, goalValues, seedValues, snapValues } from "../src/framework/pose/param-solve.js";
import { resolveParams } from "../src/framework/part-model.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import hand from "./fixtures/ik-hand-fixture.js";

const tipOf = (part, params, name) => resolveParams(part, params).d[name].world("tip").origin;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Five warm-started 8-iteration calls, each feeding its values back into params. */
function drag(params, opts, calls = 5) {
  let p = { ...params };
  for (let i = 0; i < calls; i++) {
    const r = solveAngles({ part: hand, params: p, ...opts });
    expect(r).not.toBeNull();
    p = { ...p, ...r.values };
  }
  return p;
}

describe("limbInfo", () => {
  it("returns the posed limb's ikInfo, or null when the limb is missing or derive throws", () => {
    expect(limbInfo(hand, {}, hand.handles.a).name).toBe("a");
    expect(limbInfo(hand, {}, { limb: "nope", mode: "angles", params: [] })).toBeNull();
    expect(limbInfo(hand, { aCurl: 5 }, hand.handles.a)).toBeNull();   // curl > 1: derive throws
  });
});

describe("solveAngles", () => {
  it("drags a fingertip by writing only listed params", () => {
    const target = tipOf(hand, { wrist: 15, aCurl: 0.55, aSpread: 8 }, "a");
    const handle = hand.handles.a;
    const first = solveAngles({ part: hand, params: {}, handle, grab: "tip", target });
    for (const k of Object.keys(first.values)) expect(handle.params).toContain(k);
    const p = drag({}, { handle, grab: "tip", target });
    expect(dist(tipOf(hand, p, "a"), target)).toBeLessThan(0.5);
  });

  it("pinned tip holds", () => {
    // The target is off finger a's curl/spread surface, so reaching it needs the wrist,
    // which moves b: unheld, b swings away; held, b stays and a's tip gives way instead.
    const b0 = tipOf(hand, {}, "b");
    const target = tipOf(hand, { wrist: 10, aCurl: 0.4, aSpread: 5 }, "a");
    const free = drag({}, { handle: hand.handles.a, grab: "tip", target });
    expect(dist(tipOf(hand, free, "b"), b0)).toBeGreaterThan(5);
    const held = drag({}, { handle: hand.handles.a, grab: "tip", target, holds: [{ limb: "b", at: "tip", point: b0 }] });
    expect(dist(tipOf(hand, held, "b"), b0)).toBeLessThan(0.5);
  });

  it("starts from a DOF on its bound (a straight finger, curl 0)", () => {
    // The Jacobian probe below curl 0 would make derive throw; it must not poison the solve.
    const target = tipOf(hand, { aCurl: 0.5, aSpread: 6 }, "a");
    const p = drag({ aCurl: 0 }, { handle: hand.handles.a, grab: "tip", target });
    expect(dist(tipOf(hand, p, "a"), target)).toBeLessThan(0.5);
  });

  it("derive throw is skipped", () => {
    // A variant whose derive throws over part of the space the drag crosses.
    const part = { ...hand, derive: (p) => { if (p.aCurl > 0.4) throw new Error("fixture: no"); return hand.derive(p); } };
    const target = tipOf(hand, { aCurl: 0.9 }, "a");
    let r;
    expect(() => { r = solveAngles({ part, params: {}, handle: hand.handles.a, grab: "tip", target }); }).not.toThrow();
    expect(r).not.toBeNull();
    for (const v of Object.values(r.values)) expect(Number.isFinite(v)).toBe(true);
    expect(r.values.aCurl).toBeLessThanOrEqual(0.4);
    // The start pose itself failing is a null, never a throw.
    expect(solveAngles({ part, params: { aCurl: 0.8 }, handle: hand.handles.a, grab: "tip", target })).toBeNull();
  });

  it("grabs a joint as well as the tip", () => {
    const target = resolveParams(hand, { wrist: 10, aCurl: 0.5 }).d.a.world("pip").origin;
    const p = drag({}, { handle: hand.handles.a, grab: "pip", target });
    expect(dist(resolveParams(hand, p).d.a.world("pip").origin, target)).toBeLessThan(0.5);
  });

  it("locked handle is skipped", () => {
    // A wrist drag that lists bCurl too, with b's tip held: unlocked, bCurl moves to hold b.
    const wristDrag = { limb: "a", mode: "angles", params: ["wrist", "aCurl", "bCurl"] };
    const allHandles = [wristDrag, hand.handles.a, hand.handles.b];
    const b0 = tipOf(hand, {}, "b");
    const target = tipOf(hand, { wrist: 25, aCurl: 0.3 }, "a");
    const opts = { handle: wristDrag, grab: "tip", target, holds: [{ limb: "b", at: "tip", point: b0 }], allHandles };
    const free = solveAngles({ part: hand, params: { bLock: 0 }, ...opts });
    expect(free.values.bCurl).not.toBe(hand.defaults.bCurl);
    const locked = solveAngles({ part: hand, params: { bLock: 1 }, ...opts });
    expect(Object.keys(locked.values)).not.toContain("bCurl");
    expect(Object.keys(locked.values)).toContain("wrist");
  });

  it("clamps every DOF to its schema range", () => {
    const r = solveAngles({ part: hand, params: {}, handle: hand.handles.a, grab: "tip", target: [0, -500, -500] });
    expect(r.values.wrist).toBeGreaterThanOrEqual(-60);
    expect(r.values.wrist).toBeLessThanOrEqual(60);
    expect(r.values.aCurl).toBeGreaterThanOrEqual(0);
    expect(r.values.aCurl).toBeLessThanOrEqual(1);
  });
});

// A one-limb arm posed by goals from its own parameters, seeded from saved angles.
const ARM = limb("arm", {
  at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0],
  joints: [{ name: "shoulder", type: "ball", cone: 90 }, { name: "elbow", range: [0, 150] },
    { name: "wrist", range: [0, 60], follow: { joint: "elbow", ratio: 0.2 } }],
  lengths: [60, 50, 10],
});
const arm = {
  meta: { title: "arm" },
  parameters: [{ id: "g", title: "Goal", controls: [
    { key: "tx", min: -150, max: 150, step: 0.5 }, { key: "ty", min: -150, max: 150 }, { key: "tz", min: -150, max: 150 },
    { key: "sBend", min: -90, max: 90 }, { key: "sSpread", min: -90, max: 90 }, { key: "sTwist", min: -90, max: 90 },
    { key: "elbow", min: 0, max: 150, step: 5 }, { key: "count", min: 0, max: 10, step: 1 },
  ] }],
  defaults: { tx: 20, ty: -30, tz: 80, sBend: 10, sSpread: 0, sTwist: 0, elbow: 30, count: 0 },
  derive: (p) => ({
    arm: ARM.pose({
      bend: [{ bend: p.sBend, spread: p.sSpread, twist: p.sTwist }, p.elbow],
      goals: [{ at: "tip", position: [p.tx, p.ty, p.tz] }],
    }),
  }),
  parts: { body: { build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { main: { label: "Main" } },
  handles: {
    tool: { limb: "arm", mode: "goal", params: { position: ["tx", "ty", "tz"], aim: ["pitch", "yaw", "roll"] },
      seed: ["sBend", "sSpread", "sTwist", "elbow"] },
  },
};

describe("goalValues", () => {
  it("goalValues maps point to position params", () => {
    expect(goalValues({ handle: arm.handles.tool, point: [1, 2, 3] })).toEqual({ tx: 1, ty: 2, tz: 3 });
    expect(goalValues({ handle: arm.handles.tool, point: [1, 2, 3], aimAngles: [10, 20, 30] }))
      .toEqual({ tx: 1, ty: 2, tz: 3, pitch: 10, yaw: 20, roll: 30 });
    const noRoll = { ...arm.handles.tool, params: { position: ["tx", "ty", "tz"], aim: ["pitch", "yaw"] } };
    expect(goalValues({ handle: noRoll, point: [0, 0, 0], aimAngles: { pitch: 5, yaw: 6, roll: 7 } }))
      .toEqual({ tx: 0, ty: 0, tz: 0, pitch: 5, yaw: 6 });
  });

  it("clamps to the schema range when given the part", () => {
    expect(goalValues({ part: arm, handle: arm.handles.tool, point: [999, -999, 3] })).toEqual({ tx: 150, ty: -150, tz: 3 });
  });
});

describe("seedValues", () => {
  it("seedValues writes solved angles in seed order", () => {
    const posed = resolveParams(arm, {}).d.arm;
    const [s, e] = posed.values;   // the ball's { bend, spread, twist }, then the elbow (the wrist follows)
    expect(seedValues({ part: arm, params: {}, handle: arm.handles.tool }))
      .toEqual({ sBend: s.bend, sSpread: s.spread, sTwist: s.twist, elbow: e });
    expect(seedValues({ part: arm, params: { elbow: "x" }, handle: arm.handles.tool })).toBeNull();
  });
});

describe("snapValues", () => {
  it("snapValues", () => {
    expect(snapValues(arm, { elbow: 42.6 })).toEqual({ elbow: 45 });
    expect(snapValues(arm, { tx: 1.26, count: 3.4, ty: 1.234 })).toEqual({ tx: 1.5, count: 3, ty: 1.234 });
    expect(snapValues(arm, { elbow: 999, nope: 1.7 })).toEqual({ elbow: 150, nope: 1.7 });
    expect(snapValues(hand, { aCurl: 0.123456 })).toEqual({ aCurl: 0.12 });
  });
});
