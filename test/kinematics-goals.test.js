// limb.pose's goals and pins: damped-least-squares goals at any joint or the tip, with
// joints held by pins, couplings kept, and a per-goal report.
import { describe, it, expect } from "vitest";
import { resolveFrames } from "../src/framework/geometry/xform.js";
import { limb, aimFromAngles } from "../src/framework/domains/kinematics/index.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const sub = (a, b) => a.map((v, i) => v - b[i]);
const angleDeg = (a, b) => (Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (norm(a) * norm(b))))) * 180) / Math.PI;
const worldOf = (posed, frame, frames = {}) => resolveFrames({ ...frames, ...posed.frames }).get(frame).world;
const tipOf = (posed) => { const M = worldOf(posed, posed.tip); return [M[9], M[10], M[11]]; };

/** The guide's index finger: mcp, pip, dip following pip at 0.75. */
const finger = () => limb("index", {
  at: [-30, 96, 2], toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: [
    { name: "mcp", range: [-10, 90] },
    { name: "pip", range: [0, 110] },
    { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } },
  ],
  lengths: [42, 25, 22],
});

/**
 * A 6-axis arm standing up from the origin: base yaw (twist about the vertical), shoulder and
 * elbow bends, then a wrist of pitch, yaw and roll with a 30 mm tool. Reach 230 mm.
 */
const arm = () => limb("arm", {
  toward: [0, 0, 1], bendToward: [1, 0, 0],
  joints: [
    { name: "base", axis: "twist", range: [-180, 180] },
    { name: "shoulder", range: [-120, 120] },
    { name: "elbow", range: [-150, 150] },
    { name: "wristPitch", range: [-120, 120] },
    { name: "wristYaw", axis: "spread", range: [-120, 120] },
    { name: "wristRoll", axis: "twist", range: [-180, 180] },
  ],
  lengths: [0, 100, 100, 0, 0, 30],
});
const SEED = { base: 0, shoulder: 30, elbow: 60, wristPitch: 30, wristYaw: 0, wristRoll: 0 };

describe("goals", () => {
  it("goals reproduce reach on the finger", () => {
    // The guide's three reach examples: reached, too-far, out-of-range.
    const L = finger();
    for (const target of [[-30, 137, -64], [-30, 300, 2], [-30, 160, -20]]) {
      const byReach = L.pose({ reach: target });
      const byGoals = L.pose({ goals: [{ at: "tip", position: target }] });
      expect(byGoals.report.goals[0].status).toBe(byReach.report.reach.status);
      if (byReach.report.reach.status === "out-of-range") {
        // reach fixes the pitch-to-tip distance first, then clamps the aim (mcp stops at -10,
        // 11.786 mm off); the least-squares solve trades pip against the clamp and lands nearer.
        expect(byGoals.report.goals[0].residual).toBeLessThan(byReach.report.reach.residual);
        expect(byGoals.values[0]).toBe(-10);
      } else {
        expect(norm(sub(tipOf(byGoals), tipOf(byReach))), `tip for ${target}`).toBeLessThanOrEqual(0.01);
        expect(byGoals.report.goals[0].residual).toBeCloseTo(byReach.report.reach.residual, 2);
      }
    }
  });

  it("arm meets position + aim", () => {
    const posed = arm().pose({ bend: SEED, goals: [{ at: "tip", position: [120, 40, 80], aim: [0, 0, -1] }] });
    const g = posed.report.goals[0];
    expect(g).toEqual({ at: "tip", residual: expect.any(Number), aimResidual: expect.any(Number), status: "reached" });
    expect(g.residual).toBeLessThanOrEqual(0.01);
    expect(g.aimResidual).toBeLessThanOrEqual(0.1);
    expect(norm(sub(tipOf(posed), [120, 40, 80]))).toBeLessThanOrEqual(0.01);
    const M = worldOf(posed, posed.tip);
    expect(angleDeg([M[1], M[4], M[7]], [0, 0, -1])).toBeLessThanOrEqual(0.1);
  });

  it("up fixes the roll about the aim", () => {
    const posed = arm().pose({ bend: SEED, goals: [{ at: "tip", position: [120, 40, 80], aim: [0, 0, -1], up: [1, 0, 0] }] });
    expect(posed.report.goals[0].status).toBe("reached");
    const M = worldOf(posed, posed.tip);
    expect(angleDeg([M[2], M[5], M[8]], [1, 0, 0])).toBeLessThanOrEqual(0.1);
  });

  it("a goal at a joint moves only the joints above it", () => {
    const posed = arm().pose({ bend: SEED, goals: [{ at: "elbow", position: [60, 0, 80] }] });
    expect(posed.report.goals[0].status).toBe("reached");
    const M = worldOf(posed, "arm.elbow");
    expect(norm(sub([M[9], M[10], M[11]], [60, 0, 80]))).toBeLessThanOrEqual(0.01);
    expect(posed.values.slice(2)).toEqual([60, 30, 0, 0]);
  });

  it("pins hold", () => {
    const posed = arm().pose({ bend: { ...SEED, base: 25 }, goals: [{ at: "tip", position: [120, 40, 80] }], pins: ["base"] });
    expect(posed.values[0]).toBe(25);
  });

  it("a pinned leader also holds its followers", () => {
    const posed = finger().pose({ bend: { mcp: 0, pip: 40 }, goals: [{ at: "tip", position: [-30, 137, -64] }], pins: ["pip"] });
    expect(posed.values[1]).toBe(40);
    expect(posed.values[2]).toBe(30);
  });

  it("couplings hold", () => {
    const posed = finger().pose({ goals: [{ at: "tip", position: [-30, 137, -64] }] });
    expect(posed.report.goals[0].status).toBe("reached");
    expect(posed.values[2]).toBeCloseTo(0.75 * posed.values[1], 12);
  });

  it("too-far: the limb points at the target", () => {
    const target = [2 * 230 / Math.sqrt(3), 2 * 230 / Math.sqrt(3), 2 * 230 / Math.sqrt(3)];
    const posed = arm().pose({ bend: SEED, goals: [{ at: "tip", position: target }] });
    expect(posed.report.goals[0].status).toBe("too-far");
    expect(angleDeg(tipOf(posed), target)).toBeLessThanOrEqual(0.5);
  });

  it("conflict: two goals 400 mm apart on a short arm", () => {
    const posed = arm().pose({ bend: SEED, goals: [{ at: "tip", position: [200, 0, 60] }, { at: "tip", position: [-200, 0, 60] }] });
    expect(posed.report.goals.map((g) => g.status)).toEqual(["conflict", "conflict"]);
  });

  it("out-of-range: a target the limits keep the limb from", () => {
    // The base cannot yaw past ±10°, so a target behind the arm is out of range, not too far.
    const L = limb("a", {
      toward: [0, 0, 1], bendToward: [1, 0, 0],
      joints: [{ name: "base", axis: "twist", range: [-10, 10] }, { name: "shoulder", range: [-20, 120] }, { name: "elbow", range: [0, 150] }],
      lengths: [0, 100, 100],
    });
    const posed = L.pose({ bend: { shoulder: 30, elbow: 60 }, goals: [{ at: "tip", position: [-120, 0, 60] }] });
    expect(posed.report.goals[0].status).toBe("out-of-range");
    expect(posed.report.goals[0].residual).toBeGreaterThan(0.01);
  });

  it("deterministic", () => {
    const opts = { bend: SEED, goals: [{ at: "tip", position: [120, 40, 80], aim: [0, 0, -1], weight: 2 }, { at: "elbow", position: [40, 10, 90], weight: 0.5 }] };
    const a = arm().pose(opts), b = arm().pose(opts);
    expect(a.report).toEqual(b.report);
    expect(a.values).toEqual(b.values);
  });

  it("an empty goals list poses as bend does", () => {
    const L = arm();
    const posed = L.pose({ bend: SEED, goals: [] });
    expect(posed.values).toEqual(L.pose({ bend: SEED }).values);
    expect(posed.report.goals).toEqual([]);
  });

  it("solves a parented limb given its parent frames", () => {
    const palm = { palm: { at: [10, 0, 0], rotate: [{ axis: "z", deg: 90 }] } };
    const L = limb("f", { parent: "palm", toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", "b"], lengths: [40, 30] });
    const target = L.pose({ bend: [30, 40] }, palm).report.tip;
    const posed = L.pose({ goals: [{ at: "tip", position: target }] }, palm);
    expect(posed.report.goals[0].status).toBe("reached");
    expect(norm(sub(posed.report.tip, target))).toBeLessThanOrEqual(0.01);
  });
});

describe("goals: errors", () => {
  const err = (f) => { try { f(); } catch (e) { expect(e.name).toBe("SpecError"); return e.message; } throw new Error("no throw"); };

  it("reach + goals throws", () => {
    expect(err(() => finger().pose({ reach: [0, 0, 0], goals: [] }))).toContain("use one of reach, grip or goals");
    expect(err(() => finger().pose({ grip: { around: () => 1 }, goals: [] }))).toContain("use one of reach, grip or goals");
    expect(err(() => finger().pose({ reach: [0, 0, 0], grip: { around: () => 1 } }))).toBe('limb "index": use reach or grip, not both');
  });

  it("names the field", () => {
    const L = finger();
    expect(err(() => L.pose({ goals: [{ at: "tip", position: [0, 0, 0] }], pins: ["mcp", "knuckle"] }))).toBe('limb "index".pins[1]: unknown joint "knuckle"');
    expect(err(() => L.pose({ goals: [{ at: "nail", position: [0, 0, 0] }] }))).toBe('limb "index".goals[0].at: unknown joint "nail"');
    expect(err(() => L.pose({ goals: [{ at: "tip" }] }))).toBe('limb "index".goals[0]: needs position, aim or up');
    expect(err(() => L.pose({ goals: [{ at: "tip", position: [0, 0] }] }))).toBe('limb "index".goals[0].position: must be [x, y, z]');
    expect(err(() => L.pose({ goals: [{ at: "tip", aim: [0, 0, 0] }] }))).toBe('limb "index".goals[0].aim: must be a non-zero [x, y, z]');
    expect(err(() => L.pose({ goals: [{ at: "tip", position: [0, 0, 0], weight: 0 }] }))).toBe('limb "index".goals[0].weight: must be a finite number > 0');
    expect(err(() => L.pose({ goals: [{ at: "tip", position: [0, 0, 0], reach: 1 }] }))).toBe('limb "index".goals[0].reach: unknown goal option "reach"');
    expect(err(() => L.pose({ goals: {} }))).toBe('limb "index".goals: must be an array of { at, position?, aim?, up?, weight? }');
    expect(err(() => L.pose({ pins: ["mcp"] }))).toBe('limb "index".pins: pins hold joints for goals — pass goals too');
    const parented = limb("p", { parent: "palm", toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a"], lengths: [10] });
    expect(err(() => parented.pose({ goals: [{ at: "tip", position: [0, 0, 0] }] }))).toBe('limb "p": goals needs the frames declared so far — pass them as pose(…, frames)');
  });
});

describe("aimFromAngles", () => {
  const close = (a, b) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 12));

  it("zero is toward; yaw turns about +Z", () => {
    close(aimFromAngles({ toward: [0, 1, 0] }).aim, [0, 1, 0]);
    close(aimFromAngles({ toward: [0, 1, 0], yaw: 90 }).aim, [-1, 0, 0]);
    expect(aimFromAngles({ toward: [0, 1, 0] }).up).toBeUndefined();
  });

  it("pitch lifts the aim toward +Z; roll turns up about the aim", () => {
    close(aimFromAngles({ toward: [0, 1, 0], pitch: 90 }).aim, [0, 0, 1]);
    close(aimFromAngles({ toward: [0, 1, 0], pitch: -90 }).aim, [0, 0, -1]);
    const r = aimFromAngles({ toward: [0, 1, 0], roll: 90 });
    close(r.aim, [0, 1, 0]);
    expect(Math.abs(dot(r.up, r.aim))).toBeLessThan(1e-12);
    close(aimFromAngles({ toward: [0, 1, 0], roll: 0 }).up, [0, 0, 1]);
  });

  it("a vertical toward starts up as +Y", () => {
    close(aimFromAngles({ toward: [0, 0, -1], roll: 0 }).up, [0, 1, 0]);
    close(aimFromAngles({ toward: [0, 0, -2] }).aim, [0, 0, -1]);
  });

  it("validates", () => {
    expect(() => aimFromAngles({ toward: [0, 0, 0] })).toThrow(/aimFromAngles: toward must be a non-zero \[x, y, z\]/);
    expect(() => aimFromAngles({ toward: [0, 1, 0], pitch: "x" })).toThrow(/aimFromAngles: pitch must be a finite number/);
  });
});
