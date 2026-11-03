import { describe, it, expect } from "vitest";
import { limbInfo, solveAngles, solveGoalPinned, goalGrabJoints, goalValues, seedValues, snapValues, rangesOf } from "../src/framework/pose/param-solve.js";
import { defaultSolve } from "../src/framework/pose/pose-session.js";
import robotArm from "../src/parts/robot-arm.js";
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
    expect(limbInfo(hand, {}, { on: "nope", drag: "angles", params: [] })).toBeNull();
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
    const wristDrag = { on: "a", drag: "angles", params: ["wrist", "aCurl", "bCurl"] };
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

  // The frame budget: every residual evaluation is a derive, and a drag solves once per
  // frame. A solved point stops the solve (TOL_MM), so a warm-started drag pays for the
  // iterations it needs, not all eight.
  it("stops once the residual is met: a warm-started drag derives far less often", () => {
    let calls = 0;
    const counted = { ...hand, derive: (p) => { calls++; return hand.derive(p); } };
    const handle = hand.handles.a;
    const start = tipOf(hand, {}, "a");
    const run = (opts) => {
      calls = 0;
      let p = {};
      for (let f = 1; f <= 20; f++) {
        const target = [start[0] + f * 0.3, start[1] - f * 0.2, start[2] - f * 0.3];
        const r = solveAngles({ part: counted, params: p, handle, grab: "tip", target, ...opts });
        expect(r.error).toBeLessThan(0.01);
        p = { ...p, ...r.values };
      }
      return { calls, p };
    };
    const full = run({ tol: 0 });
    const early = run({});
    expect(early.calls).toBeLessThan(full.calls * 0.7);
    // the same pose, to well within a drag's readout
    expect(dist(tipOf(hand, early.p, "a"), tipOf(hand, full.p, "a"))).toBeLessThan(0.01);
    // a target already met costs only the start pose's evaluations
    calls = 0;
    solveAngles({ part: counted, params: {}, handle, grab: "tip", target: start });
    expect(calls).toBeLessThanOrEqual(3);
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
    tool: { on: "arm", drag: "goal", params: { position: ["tx", "ty", "tz"], aim: ["pitch", "yaw", "roll"] },
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

describe("solveGoalPinned (a goal drag holding pins)", () => {
  const handle = robotArm.handles.tool;
  const world = (params, at) => resolveParams(robotArm, params).d.arm.world(at).origin;

  it("moves the tool toward the target while the pinned elbow stays put, and derive lands on the same pose", () => {
    let p = { ...robotArm.defaults };
    const elbow = world(p, "elbow");
    const tip0 = world(p, "tip");
    const holds = [{ limb: "arm", at: "elbow", point: elbow }];
    const target = [tip0[0] - 20, tip0[1] + 10, tip0[2] + 15];
    for (let i = 1; i <= 5; i++) {
      const step = tip0.map((v, c) => v + ((target[c] - v) * i) / 5);
      const r = solveGoalPinned({ part: robotArm, params: p, handle, target: step, holds });
      expect(r).not.toBeNull();
      p = { ...p, ...r.values };
    }
    // seed + goal written: derive's own goal solve reproduces the pose
    const posed = resolveParams(robotArm, p).d.arm;
    expect(posed.report.goals[0].status).toBe("reached");
    expect(dist(posed.world("tip").origin, [p.toolX, p.toolY, p.toolZ])).toBeLessThan(0.01);
    expect(dist(posed.world("elbow").origin, elbow)).toBeLessThan(0.5);
    expect(dist(posed.world("tip").origin, target)).toBeLessThan(dist(tip0, target) / 2);
  });

  it("defaultSolve takes the pinned path only for a pin on the goal's limb", () => {
    const p = { ...robotArm.defaults };
    const tip0 = world(p, "tip");
    const target = [tip0[0] - 30, tip0[1], tip0[2] + 30];
    const free = defaultSolve({ part: robotArm, params: p, handle, grab: "tip", target, holds: [] });
    expect(free.values.toolX).toBeCloseTo(target[0], 6); // the direct goal write
    const other = defaultSolve({ part: robotArm, params: p, handle, grab: "tip", target, holds: [{ limb: "other", at: "tip", point: [0, 0, 0] }] });
    expect(other.values.toolX).toBeCloseTo(target[0], 6);
    const pinned = defaultSolve({ part: robotArm, params: p, handle, grab: "tip", target, holds: [{ limb: "arm", at: "elbow", point: world(p, "elbow") }] });
    expect(pinned.values.toolPitch).toBeDefined(); // the goal rewritten from the solved pose, aim included
    expect(dist(world({ ...p, ...pinned.values }, "elbow"), world(p, "elbow"))).toBeLessThan(0.5);
  });

  it("a goal the schema would clip stops the pose short (the tool's lowest Z), still reproducible", () => {
    const p = { ...robotArm.defaults };
    const holds = [{ limb: "arm", at: "elbow", point: world(p, "elbow") }];
    const r = solveGoalPinned({ part: robotArm, params: p, handle, target: [200, 0, -200], holds });
    expect(r.values.toolZ).toBeGreaterThanOrEqual(-50);
    const posed = resolveParams(robotArm, { ...p, ...r.values }).d.arm;
    expect(dist(posed.world("tip").origin, [r.values.toolX, r.values.toolY, r.values.toolZ])).toBeLessThan(0.01);
  });
});

describe("solveGoalPinned with a mid-joint grab (spec 2026-11-02 goal 2)", () => {
  const handle = robotArm.handles.tool;
  const posedOf = (params) => resolveParams(robotArm, params).d.arm;
  const world = (params, at) => posedOf(params).world(at).origin;
  /** Five warm-started calls stepping the elbow from where it is to `target`. */
  function dragElbow(p0, target, holds = []) {
    let p = { ...p0 };
    const e0 = world(p, "elbow");
    for (let i = 1; i <= 5; i++) {
      const step = e0.map((v, c) => v + ((target[c] - v) * i) / 5);
      const r = solveGoalPinned({ part: robotArm, params: p, handle, target: step, holds, grab: "elbow" });
      expect(r).not.toBeNull();
      p = { ...p, ...r.values };
    }
    return p;
  }

  it("moves the elbow onto a reachable target; the joints below it keep their angles; derive lands on the same pose", () => {
    const p0 = { ...robotArm.defaults };
    const v0 = posedOf(p0).values;
    // where the elbow sits with the base and shoulder turned a little: reachable
    const turned = posedOf(p0);
    const target = turned.ikForward({ base: v0[0] + 15, shoulder: v0[1] - 10 }, "elbow").origin;
    const tip0 = world(p0, "tip");
    const p = dragElbow(p0, target);
    const posed = posedOf(p);
    expect(dist(posed.world("elbow").origin, target)).toBeLessThan(0.5);
    for (let i = 2; i < 6; i++) expect(posed.values[i]).toBeCloseTo(v0[i], 3);
    // seed and goal written: the goal is the tool frame, and derive's goal solve reaches it
    for (const k of [...handle.seed, "toolX", "toolY", "toolZ", "toolPitch", "toolYaw", "toolRoll"]) expect(p[k]).toBeTypeOf("number");
    expect(posed.report.goals[0].status).toBe("reached");
    expect(dist(posed.world("tip").origin, [p.toolX, p.toolY, p.toolZ])).toBeLessThan(0.01);
    expect(dist(posed.world("tip").origin, tip0)).toBeGreaterThan(5); // the tool rode along
  });

  it("an unreachable target stops the elbow as near as it gets", () => {
    const p0 = { ...robotArm.defaults };
    const shoulder = world(p0, "shoulder");
    const target = [100, 0, 400];
    const p = dragElbow(p0, target);
    const elbow = world(p, "elbow");
    const nearest = dist(shoulder, target) - p0.upperLen;
    expect(dist(elbow, target)).toBeLessThan(nearest + 1);
  });

  it("a goal the schema would clip stops at the fraction that fits", () => {
    const p0 = { ...robotArm.defaults };
    const r = solveGoalPinned({ part: robotArm, params: p0, handle, target: [250, 0, -150], grab: "elbow" });
    expect(r).not.toBeNull();
    expect(r.values.toolZ).toBeGreaterThanOrEqual(-50);
    const posed = posedOf({ ...p0, ...r.values });
    expect(dist(posed.world("tip").origin, [r.values.toolX, r.values.toolY, r.values.toolZ])).toBeLessThan(0.01);
  });

  it("a pin on the grabbed joint itself is no hold", () => {
    const p0 = { ...robotArm.defaults };
    const e0 = world(p0, "elbow");
    const v0 = posedOf(p0).values;
    const target = posedOf(p0).ikForward({ base: v0[0] - 12, shoulder: v0[1] + 8 }, "elbow").origin;
    const self = dragElbow(p0, target, [{ limb: "arm", at: "elbow", point: e0 }]);
    expect(dist(world(self, "elbow"), target)).toBeLessThan(0.5);
  });

  it("defaultSolve routes a mid-joint grab to the pinned solve, never the goal-point write", () => {
    const p0 = { ...robotArm.defaults };
    const e0 = world(p0, "elbow");
    const target = [e0[0] - 10, e0[1], e0[2] + 5];
    const r = defaultSolve({ part: robotArm, params: p0, handle, grab: "elbow", target, holds: [] });
    expect(r.values.toolX).not.toBeCloseTo(target[0], 1); // not the tool moved to the cursor
    expect(dist(world({ ...p0, ...r.values }, "elbow"), target)).toBeLessThan(dist(e0, target));
    // the `at` grab is unchanged: the direct goal write
    const tip = defaultSolve({ part: robotArm, params: p0, handle, grab: "tip", target, holds: [] });
    expect(tip.values.toolX).toBeCloseTo(target[0], 6);
    // a limb that cannot be solved holds still: null, never the goal write
    const noSeed = { ...handle, seed: undefined };
    expect(defaultSolve({ part: robotArm, params: p0, handle: noSeed, grab: "elbow", target, holds: [] })).toBeNull();
  });
});

describe("goalGrabJoints", () => {
  it("a joint is a grab when a seeded joint above it moves its origin", () => {
    const info = limbInfo(robotArm, robotArm.defaults, robotArm.handles.tool);
    // the base twists about the shoulder's own axis line: the shoulder never moves
    expect(goalGrabJoints(info, robotArm.handles.tool)).toEqual(["elbow", "wristPitch", "wristYaw", "wristRoll"]);
    const armInfo = limbInfo(arm, arm.defaults, arm.handles.tool);
    expect(goalGrabJoints(armInfo, arm.handles.tool)).toEqual(["elbow", "wrist"]);
    // unseeded joints drive nothing
    expect(goalGrabJoints(armInfo, { ...arm.handles.tool, seed: [null, null, null, "elbow"] })).toEqual(["wrist"]);
    expect(goalGrabJoints(info, { ...robotArm.handles.tool, seed: undefined })).toEqual([]);
  });
});

describe("wrap controls", () => {
  const wrapPart = (wrap) => ({
    parameters: [{ id: "s", title: "S", controls: [{ key: "a", type: "slider", label: "A", min: 0, max: 360, step: 0.1, wrap }] }],
    defaults: { a: 0 },
  });
  it("snapValues rounds a wrapped key to its step but never clamps it", () => {
    expect(snapValues(wrapPart(true), { a: 720.04 })).toEqual({ a: 720 });
    expect(snapValues(wrapPart(false), { a: 400 })).toEqual({ a: 360 });
  });
  it("rangesOf carries wrap", () => {
    expect(rangesOf(wrapPart(true)).get("a").wrap).toBe(true);
    expect(rangesOf(wrapPart(false)).get("a").wrap).toBe(false);
  });
});
