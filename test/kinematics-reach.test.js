import { describe, it, expect } from "vitest";
import { resolveFrames } from "../src/framework/geometry/xform.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { r3 } from "../src/framework/domains/kinematics/outputs.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const sub = (a, b) => a.map((v, i) => v - b[i]);
const tipOf = (posed, frames = {}) => {
  const M = resolveFrames({ ...frames, ...posed.frames }).get(posed.tip).world;
  return [M[9], M[10], M[11]];
};
const angleDeg = (a, b) => (Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (norm(a) * norm(b))))) * 180) / Math.PI;

const JOINTS = (ratio = 0.75) => [
  { name: "mcp", range: [-10, 90] },
  { name: "pip", range: [0, 110] },
  { name: "dip", range: [0, 80], follow: { joint: "pip", ratio } },
];
const finger = (extra = {}, ratio) => limb("index", {
  toward: [0, 1, 0], bendToward: [0, 0, -1], joints: JOINTS(ratio), lengths: [42, 25, 22], ...extra,
});

/** dip = 0.75 × pip, clamped to dip's range — the coupling every reach must hold. */
const couplingHolds = (values, ratio = 0.75) => {
  const want = Math.min(80, Math.max(0, ratio * values[1]));
  expect(values[2]).toBe(want + 0);
};

let seed = 4242;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const between = (lo, hi) => lo + (hi - lo) * rnd();

describe("reach", () => {
  it("reaches 30 seeded reachable targets, including the far side of the pole", () => {
    const L = finger();
    let farSide = 0;
    for (let n = 0; n < 30; n++) {
      const target = tipOf(L.pose({ bend: [between(-10, 90), between(0, 110)], spread: between(-40, 40) }));
      if (target[1] < 0) farSide++;
      const posed = L.pose({ reach: target });
      expect(posed.report.reach.status).toBe("reached");
      expect(posed.report.reach.residual).toBeLessThanOrEqual(0.01);
      expect(norm(sub(tipOf(posed), target))).toBeLessThanOrEqual(0.01);
      expect(posed.report.reach.target).toEqual(target.map(r3));
      couplingHolds(posed.values);
    }
    expect(farSide).toBeGreaterThan(0);
  });

  it("takes the far-side pitch when the near one is out of range", () => {
    // mcp 75 curls the tip behind the base; the v_y > 0 pitch would need mcp ≈ −20.
    const L = finger();
    const target = tipOf(L.pose({ bend: [75, 95], spread: 10 }));
    const posed = L.pose({ reach: target });
    expect(posed.report.reach.status).toBe("reached");
    expect(norm(sub(tipOf(posed), target))).toBeLessThanOrEqual(0.01);
    couplingHolds(posed.values);
  });

  it("a target posed exactly at a range end reads reached", () => {
    const L = finger();
    for (const bend of [[-10, 0], [90, 0], [-10, 110], [40, 110], [90, 110]]) {
      const target = tipOf(L.pose({ bend, spread: 10 }));
      const posed = L.pose({ reach: target });
      expect(posed.report.reach.status).toBe("reached");
      expect(posed.report.reach.residual).toBeLessThanOrEqual(0.01);
    }
  });

  it("a distal range that excludes 0 starts from its in-range end nearest 0", () => {
    const L = limb("r", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [20, 110] }, { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } }],
      lengths: [42, 25, 22],
    });
    const target = tipOf(L.pose({ bend: [30, 20], spread: 5 }));
    const posed = L.pose({ reach: target });
    expect(posed.report.reach.status).toBe("reached");
    expect(posed.report.reach.residual).toBeLessThanOrEqual(0.01);
    expect(posed.report.clamped).toEqual([false, false, false]);
  });

  it("a distal range below 0 curls toward its end farthest from 0", () => {
    const L = limb("n", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [-60, -5] }],
      lengths: [42, 25],
    });
    const target = tipOf(L.pose({ bend: [30, -40], spread: 5 }));
    const posed = L.pose({ reach: target });
    expect(posed.report.reach.status).toBe("reached");
    expect(posed.report.reach.residual).toBeLessThanOrEqual(0.01);
    expect(norm(sub(tipOf(posed), target))).toBeLessThanOrEqual(0.01);
  });

  it("too far: straight and aimed at the target", () => {
    const L = finger();
    const dir = [0.3, 0.8, -0.5].map((v, _, a) => v / norm(a));
    const target = dir.map((v) => v * 1.5 * 89);
    const posed = L.pose({ reach: target });
    expect(posed.report.reach.status).toBe("too-far");
    expect(posed.values[1]).toBe(0);
    expect(posed.values[2]).toBe(0);
    expect(angleDeg(tipOf(posed), target)).toBeLessThan(0.01);
    expect(posed.report.reach.residual).toBeGreaterThan(0);
    couplingHolds(posed.values);
  });

  it("too close: a target at the base gives finite frames", () => {
    const posed = finger().pose({ reach: [0, 0, 0] });
    expect(posed.report.reach.status).toBe("too-close");
    for (const { world } of resolveFrames(posed.frames).values()) for (const v of world) expect(Number.isFinite(v)).toBe(true);
    expect(posed.values.every(Number.isFinite)).toBe(true);
    couplingHolds(posed.values);
  });

  it("too close: closer than the fully curled limb, curled and aimed at it", () => {
    const L = finger();
    const curled = tipOf(L.pose({ bend: [30, 110] }));
    const target = curled.map((v) => v / 2);
    const posed = L.pose({ reach: target });
    expect(posed.report.reach.status).toBe("too-close");
    expect(posed.values.slice(1)).toEqual([110, 80]);
    expect(angleDeg(tipOf(posed), target)).toBeLessThan(0.01);
    couplingHolds(posed.values);
  });

  it("too close is measured with couplings held", () => {
    const ratio = 0.3;
    const coupled = finger({}, ratio);
    const free = limb("free", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "a", range: [-10, 90] }, { name: "b", range: [0, 110] }, { name: "c", range: [0, 80] }], lengths: [42, 25, 22] });
    const dCoupled = norm(tipOf(coupled.pose({ bend: [0, 110] })));
    const dFree = norm(tipOf(free.pose({ bend: [0, 110, 80] })));
    // A target the uncoupled finger poses itself onto, between the two curled distances.
    const target = tipOf(free.pose({ bend: [30, 104.5, 76] }));
    const d = norm(target);
    expect(dFree).toBeLessThan(d);
    expect(d).toBeLessThan(dCoupled);
    // The uncoupled finger reaches it…
    const freePosed = free.pose({ reach: target });
    expect(freePosed.report.reach.status).toBe("reached");
    expect(freePosed.report.reach.residual).toBeLessThanOrEqual(0.01);
    // …the coupled one reports it as too close instead of breaking the coupling.
    const posed = coupled.pose({ reach: target });
    expect(posed.report.reach.status).toBe("too-close");
    expect(posed.values.slice(1)).toEqual([110, 33]);
    couplingHolds(posed.values, ratio);
  });

  it("out of range: a target behind the base needs a pitch below −10°", () => {
    const posed = finger().pose({ reach: [0, 0, 50] });
    expect(posed.report.reach.status).toBe("out-of-range");
    expect(posed.report.reach.residual).toBeGreaterThan(0);
    expect(posed.values[0]).toBe(-10);
    expect(posed.report.clamped[0]).toBe(true);
    couplingHolds(posed.values);
  });

  it("the frame report agrees with report.tip (parented, with frames)", () => {
    const frames = { palm: { at: [5, -3, 2], rotate: [{ axis: "z", deg: 30 }, { axis: "x", deg: -15 }] } };
    const L = finger({ parent: "palm", at: [-30, 96, 2] });
    const target = tipOf(L.pose({ bend: [25, 60], spread: 12 }, frames), frames);
    const posed = L.pose({ reach: target }, frames);
    expect(posed.report.reach.status).toBe("reached");
    expect(norm(sub(tipOf(posed, frames), target))).toBeLessThanOrEqual(0.01);
    expect(posed.report.tip).toEqual(tipOf(posed, frames).map(r3));
    couplingHolds(posed.values);
  });

  it("a mirrored limb reaches an unreflected part-coordinate target", () => {
    const L = finger({ mirror: "YZ", at: [20, 0, 0] });
    for (let n = 0; n < 10; n++) {
      const target = tipOf(L.pose({ bend: [between(-10, 90), between(0, 110)], spread: between(-30, 30) }));
      const posed = L.pose({ reach: target });
      expect(posed.report.reach.status).toBe("reached");
      expect(norm(sub(tipOf(posed), target))).toBeLessThanOrEqual(0.01);
    }
  });

  it("solves through pose twist and a zero-length twist joint, and drives a spread joint", () => {
    const L = limb("t", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: [{ name: "abd", axis: "spread", range: [-170, 170] }, { name: "rot", axis: "twist", range: [-90, 90] }, ...JOINTS()],
      lengths: [0, 0, 42, 25, 22],
    });
    for (let n = 0; n < 10; n++) {
      const tw = between(-30, 30), rot = between(-20, 20);
      const target = tipOf(L.pose({ bend: [between(-120, 120), rot, between(-10, 40), between(0, 80)], twist: tw }));
      const posed = L.pose({ reach: target, bend: { rot }, twist: tw });
      expect(posed.report.reach.status).toBe("reached");
      expect(norm(sub(tipOf(posed), target))).toBeLessThanOrEqual(0.01);
      expect(posed.values[1]).toBe(rot);
    }
  });

  it("errors", () => {
    const parented = finger({ parent: "palm" });
    expect(() => parented.pose({ reach: [0, 50, 0] })).toThrow('limb "index": reach needs the frames declared so far — pass them as pose(…, frames)');
    const twistFirst = limb("x", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "rot", axis: "twist" }, "mcp", "pip"], lengths: [5, 40, 25] });
    expect(() => twistFirst.pose({ reach: [0, 50, 0] })).toThrow('limb "x": reach needs the limb\'s first bend joint at its base');
    expect(() => finger().pose({ reach: [0, 1] })).toThrow('limb "index".reach: must be [x, y, z]');
    const followsAim = limb("y", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["mcp", { name: "pip", follow: { joint: "mcp" } }], lengths: [40, 25] });
    expect(() => followsAim.pose({ reach: [0, 50, 0] })).toThrow('limb "y".joints[1].follow: reach sets "mcp" to aim the limb, so "pip" cannot follow it');
    const noBend = limb("z", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "rot", axis: "twist", length: 10 }] });
    expect(() => noBend.pose({ reach: [0, 5, 0] })).toThrow('limb "z": reach needs a driven bend joint to aim with');
  });

  it("asymmetric ranges: reach bends distal joints toward bendToward (positive)", () => {
    const L = limb("a", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: [{ name: "m", range: [-90, 80] }, { name: "p", range: [-90, 80] }, { name: "d", range: [-90, 80] }],
      lengths: [40, 30, 20],
    });
    const target = tipOf(L.pose({ bend: [20, 50, 40] }));
    const posed = L.pose({ reach: target });
    expect(posed.report.reach.status).toBe("reached");
    expect(posed.values[1]).toBeGreaterThan(0);
    expect(posed.values[2]).toBeGreaterThan(0);
    expect(norm(sub(tipOf(posed), target))).toBeLessThan(1e-3);
  });
});
