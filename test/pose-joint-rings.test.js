// Joint rings, the pure half: which joints get a ring (param-solve's jointRings), what a
// turn writes (jointRingValues), the limb's ikForward and ballAxes, and anglesFromAim — the
// inverse of the aim convention a goal-mode ring uses to keep the goal on the turned pose.
import { describe, it, expect } from "vitest";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { aimTurn, anglesFromAim } from "../src/framework/solve/aim.js";
import { jointRings, jointRingValues, limbInfo, posedJointValue } from "../src/framework/pose/param-solve.js";
import { createPoseSession } from "../src/framework/pose/pose-session.js";
import { resolveParams } from "../src/framework/part-model.js";
import arm from "../src/parts/robot-arm.js";
import hand from "../src/parts/hand.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(...sub(a, b));
const angleDeg = (a, b) => (Math.atan2(Math.hypot(...cross(a, b)), dot(a, b)) * 180) / Math.PI;

/** Every ring as "limb.joint:ring=param" for compact comparisons. */
const ringList = (part, params, ids = Object.keys(part.handles)) => {
  const infoOf = (key) => limbInfo(part, params, { limb: key });
  return jointRings({ part, params, ids, infoOf })
    .flatMap((r) => Object.entries(r.slots).map(([ring, s]) => `${r.limb}.${r.joint}:${ring}=${s.param}${s.scale !== 1 ? `*${s.scale}` : ""}`));
};

describe("ikInfo and ikForward for joint rings", () => {
  const BALL = limb("arm", {
    toward: [0, 0, 1], bendToward: [1, 0, 0],
    joints: [{ name: "base", axis: "twist" }, { name: "s", type: "ball", cone: 90 }, "e"],
    lengths: [10, 40, 30],
  });
  const MIRRORED = limb("arm", {
    toward: [0, 0, 1], bendToward: [1, 0, 0], mirror: "YZ",
    joints: [{ name: "base", axis: "twist" }, { name: "s", type: "ball", cone: 90 }, "e"],
    lengths: [10, 40, 30],
  });

  it("a hinge record names its axis kind", () => {
    const info = BALL.pose({ bend: { base: 10, e: 20 } }).ikInfo();
    expect(info.joints.map((j) => j.axisKind)).toEqual(["twist", undefined, "bend"]);
  });

  for (const [label, L] of [["plain", BALL], ["mirrored", MIRRORED]]) {
    it(`a ball's bend, spread and twist axes turn the limb with each value's sign (${label})`, () => {
      const v0 = { bend: 20, spread: -15, twist: 30 };
      const posed = L.pose({ bend: { base: 25, s: v0, e: 40 } });
      const info = posed.ikInfo();
      const axes = info.ballAxes.s;
      const centre = info.points.s;
      const tip0 = posed.ikForward({}).origin;
      for (const comp of ["bend", "spread", "twist"]) {
        // a small positive change of one component turns the tip about its axis, positively
        const h = 1e-4;
        const tip1 = posed.ikForward({ s: { [comp]: v0[comp] + h } }).origin;
        const moved = sub(tip1, tip0);
        const want = cross(axes[comp], sub(tip0, centre)).map((c) => (c * h * Math.PI) / 180);
        // bend and spread mix at a swing (one swing about one axis): the direction agrees,
        // and twist turns exactly about the swung segment
        expect(dot(moved, want), comp).toBeGreaterThan(0);
        expect(angleDeg(moved, want), comp).toBeLessThan(comp === "twist" ? 0.5 : 25);
      }
      expect(info.axes.s).toBeUndefined();
    });
  }

  it("at rest a ball's bend axis is the bend hinge's, its spread a spread hinge's", () => {
    const info = BALL.pose({}).ikInfo();
    const H = limb("h", { toward: [0, 0, 1], bendToward: [1, 0, 0], joints: [{ name: "base", axis: "twist" }, "b", { name: "sp", axis: "spread" }], lengths: [10, 0, 30] }).pose({}).ikInfo();
    expect(info.ballAxes.s.bend).toEqual(H.axes.b);
    expect(info.ballAxes.s.spread).toEqual(H.axes.sp);
  });

  it("ikForward matches pose({ bend }) unrounded, followers and ranges coupled", () => {
    const F = limb("f", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: [{ name: "mcp", range: [0, 90] }, { name: "pip", range: [0, 90] }, { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } }],
      lengths: [40, 30, 20],
    });
    const posed = F.pose({ bend: { mcp: 10, pip: 20 } });
    const fk = posed.ikForward({ pip: 60 });
    const direct = F.pose({ bend: { mcp: 10, pip: 60 } });
    expect(fk.values).toEqual([10, 60, 45]);
    expect(dist(fk.origin, direct.world("tip").origin)).toBeLessThan(1e-3);
    expect(posed.ikForward({ pip: 200 }).values).toEqual([10, 90, 67.5]); // clamped, follower too
    // the at frame: a joint's
    expect(dist(posed.ikForward({}, "pip").origin, posed.world("pip").origin)).toBeLessThan(1e-3);
  });
});

describe("anglesFromAim: the inverse of the aim convention", () => {
  const close = (a, b, tol = 1e-9) => expect(Math.abs(((a - b + 540) % 360) - 180)).toBeLessThan(tol);
  for (const toward of [[1, 0, 0], [0.3, -0.5, 0.2], [0, 0, 1]]) {
    it(`round-trips aimTurn for toward ${JSON.stringify(toward)}`, () => {
      for (const [pitch, yaw, roll] of [[0, 0, 0], [-60, 30, 45], [45, -170, -120], [89, 10, 5], [-30, 179, 179]]) {
        const t = aimTurn(toward, { pitch, yaw, roll });
        const a = anglesFromAim(toward, { aim: t.aim, up: t.up }, { near: { pitch, yaw }, pitchRange: [-90, 90] });
        const back = aimTurn(toward, a);
        expect(angleDeg(back.aim, t.aim)).toBeLessThan(1e-6);
        expect(angleDeg(back.up, t.up)).toBeLessThan(1e-6);
        if (toward[2] !== 1) { close(a.pitch, pitch, 1e-6); close(a.yaw, yaw, 1e-6); close(a.roll, roll, 1e-6); }
      }
    });
  }

  it("at a vertical aim keeps the near yaw and puts the rest in roll (the gimbal-lock choice)", () => {
    const t = aimTurn([1, 0, 0], { pitch: -90, yaw: 40, roll: 10 });
    const a = anglesFromAim([1, 0, 0], { aim: t.aim, up: t.up }, { near: { pitch: -80, yaw: 25 } });
    expect(a.pitch).toBeCloseTo(-90, 6);
    expect(a.yaw).toBe(25);
    const back = aimTurn([1, 0, 0], a);
    expect(angleDeg(back.up, t.up)).toBeLessThan(1e-6);
  });

  it("without up gives pitch and yaw only; prefers the pitch inside the range", () => {
    const t = aimTurn([1, 0, 0], { pitch: 30, yaw: 0 });
    expect(anglesFromAim([1, 0, 0], { aim: t.aim }, { near: { pitch: 170 } })).toEqual({ pitch: expect.closeTo(150, 6), yaw: expect.closeTo(180, 6) });
    const ranged = anglesFromAim([1, 0, 0], { aim: t.aim }, { near: { pitch: 170 }, pitchRange: [-90, 90] });
    expect(ranged.pitch).toBeCloseTo(30, 9);
    expect(ranged.roll).toBeUndefined();
  });
});

describe("jointRings: which joints get a ring", () => {
  it("robot-arm: every seeded joint, each in its axis kind's ring", () => {
    expect(ringList(arm, arm.defaults)).toEqual([
      "arm.base:twist=base", "arm.shoulder:bend=shoulder", "arm.elbow:bend=elbow",
      "arm.wristPitch:bend=wristPitch", "arm.wristYaw:spread=wristYaw", "arm.wristRoll:twist=wristRoll",
    ]);
  });

  it("hand: the wrist, each spread (ring and pinky negated) and the thumb's oppose; no curl-driven knuckle", () => {
    const list = ringList(hand, hand.defaults);
    expect(list).toEqual([
      "thumb.oppose:spread=thumbOppose", "palm.wristPitch:bend=wristPitch", "palm.wristYaw:spread=wristYaw",
      "index.spread:spread=indexSpread", "middle.spread:spread=middleSpread",
      "ring.spread:spread=ringSpread*-1", "pinky.spread:spread=pinkySpread*-1",
    ]);
    for (const j of ["mcp", "pip", "dip", "ip"]) expect(list.some((r) => r.includes(`.${j}:`))).toBe(false);
  });

  it("a locked handle's parameters get no ring (its spread, and the wrist every digit drives)", () => {
    const list = ringList(hand, { ...hand.defaults, indexLock: 1 });
    expect(list).not.toContain("index.spread:spread=indexSpread");
    expect(list.some((r) => r.startsWith("palm."))).toBe(false);
    expect(list).toContain("middle.spread:spread=middleSpread");
  });

  it("follows `ids` (the visible handles)", () => {
    expect(ringList(hand, hand.defaults, ["index"])).toEqual(["index.spread:spread=indexSpread", "palm.wristPitch:bend=wristPitch", "palm.wristYaw:spread=wristYaw"]);
  });
});

describe("jointRingValues: what a turn writes", () => {
  const ringOf = (part, params, limbKey, joint) => {
    const infoOf = (key) => limbInfo(part, params, { limb: key });
    return jointRings({ part, params, ids: Object.keys(part.handles), infoOf }).find((r) => r.limb === limbKey && r.joint === joint);
  };

  it("angles: the parameter by value / scale, clamped to its schema range", () => {
    const params = { ...hand.defaults };
    expect(jointRingValues({ part: hand, params, ring: ringOf(hand, params, "ring", "spread"), slot: "spread", value: 10 })).toEqual({ values: { ringSpread: -10 }, clamped: false });
    expect(jointRingValues({ part: hand, params, ring: ringOf(hand, params, "palm", "wristPitch"), slot: "bend", value: 25 })).toEqual({ values: { wristPitch: 25 }, clamped: false });
    // past the parameter's schema range: written at the range end, and clamped
    expect(jointRingValues({ part: hand, params, ring: ringOf(hand, params, "index", "spread"), slot: "spread", value: 99 })).toEqual({ values: { indexSpread: 15 }, clamped: true });
  });

  it("angles, a ball: a bend that pushes the swing past the cone reports clamped", () => {
    const BALL = limb("arm", { toward: [0, 0, 1], bendToward: [1, 0, 0], joints: [{ name: "s", type: "ball", cone: 40 }, "e"], lengths: [40, 30] });
    const range = (key) => ({ key, label: key, min: -90, max: 90, step: 0.1 });
    const part = {
      meta: { title: "ball" }, parameters: [{ id: "p", title: "P", controls: [range("b"), range("sp"), range("tw"), range("el")] }],
      defaults: { b: 0, sp: 30, tw: 0, el: 0 },
      derive: (p) => ({ arm: BALL.pose({ bend: { s: { bend: p.b, spread: p.sp, twist: p.tw }, e: p.el } }) }),
      parts: {}, views: {},
      handles: { arm: { limb: "arm", mode: "angles", params: ["b", "sp", "tw", "el"], joints: { s: { bend: "b", spread: "sp", twist: "tw" } } } },
    };
    const params = { ...part.defaults };
    const ring = ringOf(part, params, "arm", "s");
    expect(jointRingValues({ part, params, ring, slot: "bend", value: 20 }).clamped).toBe(false); // swing 36 < 40
    expect(jointRingValues({ part, params, ring, slot: "bend", value: 35 }).clamped).toBe(true); // swing 46 > 40
    expect(jointRingValues({ part, params, ring, slot: "twist", value: 80 }).clamped).toBe(false);
  });

  it("goal mode: a turn whose goal would leave its schema range stops the joint there, other joints still", () => {
    // the shoulder leaning forward drives the tool below toolZ's -50 floor
    const params = { ...arm.defaults };
    const ring = ringOf(arm, params, "arm", "shoulder");
    const start = posedJointValue(arm, params, "arm", "shoulder");
    const posed = resolveParams(arm, params).d.arm;
    const r = jointRingValues({ part: arm, params, ring, slot: "bend", value: start + 40 });
    expect(r.clamped).toBe(true);
    expect(r.values.toolZ).toBeGreaterThanOrEqual(-50);
    expect(r.values.toolZ).toBeCloseTo(-50, 2);
    expect(r.values.shoulder).toBeGreaterThan(start);
    expect(r.values.shoulder).toBeLessThan(start + 40);
    // and the solve keeps it: the shoulder where the ring stopped, every other joint as it was
    const after = resolveParams(arm, { ...params, ...r.values }).d.arm;
    expect(after.report.goals[0].status).toBe("reached");
    after.values.forEach((v, i) => {
      const name = after.ikInfo().joints[i].name;
      expect(v, name).toBeCloseTo(name === "shoulder" ? r.values.shoulder : posed.values[i], 3);
    });
  });

  // The round trip a goal handle's ring must survive: turn one joint (forward kinematics),
  // write its seed AND the goal at the turned pose, derive — the goal solve starts at its
  // answer and the arm stays where the turn put it (no spring-back).
  for (const [joint, deg] of [["elbow", 15], ["shoulder", -20], ["base", 35], ["wristPitch", 25], ["wristYaw", -40], ["wristRoll", 60]]) {
    it(`goal mode: turning the robot arm's ${joint} by ${deg} keeps it there through derive`, () => {
      const params = { ...arm.defaults };
      const ring = ringOf(arm, params, "arm", joint);
      const slot = Object.keys(ring.slots)[0];
      const start = posedJointValue(arm, params, "arm", joint);
      const posed = resolveParams(arm, params).d.arm;
      const fk = posed.ikForward({ [joint]: start + deg });
      const { values, clamped } = jointRingValues({ part: arm, params, ring, slot, value: start + deg });
      expect(clamped).toBe(false);
      expect(values[joint]).toBeCloseTo(start + deg, 9);
      for (const k of ["toolX", "toolY", "toolZ", "toolPitch", "toolYaw", "toolRoll"]) expect(values).toHaveProperty(k);
      const after = resolveParams(arm, { ...params, ...values }).d.arm;
      expect(after.report.goals[0].status).toBe("reached");
      const tip = after.world("tip");
      expect(dist(tip.origin, fk.origin)).toBeLessThan(0.01);
      expect(angleDeg(tip.y, fk.y)).toBeLessThan(0.1);
      expect(angleDeg(tip.z, fk.z)).toBeLessThan(0.1);
      // and only that joint moved
      after.values.forEach((v, i) => {
        const name = after.ikInfo().joints[i].name;
        expect(v, name).toBeCloseTo(name === joint ? start + deg : posed.values[i], 3);
      });
    });
  }

  it("goal mode through the session: frames turn from the press, clamp at the range, one commit", () => {
    const params = { ...arm.defaults };
    const commits = [];
    const session = createPoseSession({
      part: arm, getParams: () => params,
      write: (v) => Object.assign(params, v), commit: (k) => commits.push(k), restore: (v) => Object.assign(params, v),
    });
    const ring = ringOf(arm, params, "arm", "elbow");
    const start = posedJointValue(arm, params, "arm", "elbow");
    session.begin("tool", "ring:elbow");
    for (const d of [5, 10, 15]) expect(session.jointFrame(ring, "bend", d).clamped).toBe(false);
    expect(params.elbow).toBeCloseTo(start + 15, 9);
    // past the elbow's 150 stop: clamped, and the arm reports reached there
    expect(session.jointFrame(ring, "bend", 200).clamped).toBe(true);
    expect(params.elbow).toBeLessThanOrEqual(150);
    expect(resolveParams(arm, params).d.arm.report.goals[0].status).toBe("reached");
    session.end();
    expect(commits).toHaveLength(1);
    expect(commits[0]).toContain("elbow");
    expect(commits[0]).toContain("toolX");
  });
});
