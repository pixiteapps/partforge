// An angles drag stops at a joint's own range, not only its slider's: a param whose schema
// range is wider than the joint it drives used to push past the limb's clamp, where the
// pose stopped changing and the drag stuck. Also the ring clamp and the lint rule.
import { describe, it, expect } from "vitest";
import { solveAngles, jointRings, jointRingValues, limbInfo } from "../src/framework/pose/param-solve.js";
import { resolveParams } from "../src/framework/part-model.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { lintPart } from "../src/lint.js";
import hand from "../src/parts/hand.js";
import robotArm from "../src/parts/robot-arm.js";
import robotFinger from "../src/parts/robot-finger.js";

const LIMB = limb("arm", {
  at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0],
  joints: [{ name: "sh", range: [0, 90] }, { name: "eb", range: [0, 60] }, { name: "wr", type: "ball", cone: 20 }],
  lengths: [50, 40, 20],
});
const part = {
  meta: { title: "wide" },
  parameters: [{ id: "p", title: "P", controls: [
    { key: "sh", min: -50, max: 150 },        // joint 0..90: wide both ways
    { key: "eb", min: -100, max: 100 },       // scale -1: joint 0..60 => param -60..0
    { key: "wb", min: -60, max: 60 }, { key: "ws", min: -60, max: 60 },
  ] }],
  defaults: { sh: 10, eb: -10, wb: 0, ws: 0 },
  derive: (p) => ({ arm: LIMB.pose({ bend: [p.sh, -p.eb, { bend: p.wb, spread: p.ws }] }) }),
  parts: { body: { build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { main: { label: "Main" } },
  handles: {
    h: { on: "arm", drag: "angles", params: ["sh", "eb", "wb", "ws"],
      joints: { sh: "sh", eb: { param: "eb", scale: -1 }, wr: { bend: "wb", spread: "ws" } } },
  },
};
const handle = part.handles.h;
const tipOf = (params) => resolveParams(part, { ...part.defaults, ...params }).d.arm.world("tip").origin;

/** Drag warm from `params` toward `target`, a few calls like a drag's frames. */
function pull(params, target, calls = 6) {
  let p = { ...part.defaults, ...params };
  for (let i = 0; i < calls; i++) {
    const r = solveAngles({ part, params: p, handle, grab: "tip", target });
    expect(r).not.toBeNull();
    p = { ...p, ...r.values };
  }
  return p;
}

describe("solveAngles stops at a joint's range", () => {
  it("a hinge pulled far past its limit ends on the limit, and a pull back moves it again", () => {
    const far = [400, 0, -400];
    const p = pull({}, far);
    expect(p.sh).toBeGreaterThanOrEqual(0);
    expect(p.sh).toBeLessThanOrEqual(90 + 1e-9);
    expect(p.sh).toBeGreaterThan(80);                       // it went to the limit, not just somewhere
    // pulled back toward the start pose: the param moves off the limit (the stuck bug)
    const back = pull(p, tipOf({ sh: 30, eb: -10 }));
    expect(back.sh).toBeLessThan(p.sh - 10);
  });

  it("a negative scale bounds the param by the ordered range", () => {
    for (const target of [[300, 0, 100], [-300, 0, 100], [0, 300, -300], [300, 300, 300]]) {
      const p = pull({}, target);
      expect(p.eb).toBeGreaterThanOrEqual(-60 - 1e-9);
      expect(p.eb).toBeLessThanOrEqual(1e-9);
    }
  });

  it("a ball's bend and spread stay within the cone", () => {
    for (const target of [[300, 0, 0], [-300, 100, 0], [0, 300, 100]]) {
      const p = pull({}, target);
      expect(Math.abs(p.wb)).toBeLessThanOrEqual(20 + 1e-9);
      expect(Math.abs(p.ws)).toBeLessThanOrEqual(20 + 1e-9);
    }
  });

  it("a param no joints entry names keeps its schema bounds", () => {
    const loose = { ...part, handles: { h: { ...handle, joints: { sh: "sh" } } } };
    let p = { ...part.defaults };
    for (let i = 0; i < 6; i++) p = { ...p, ...solveAngles({ part: loose, params: p, handle: loose.handles.h, grab: "tip", target: [300, 0, 100] }).values };
    expect(p.eb).toBeLessThanOrEqual(100);                  // schema only: not clipped to -60..0
  });

  it("clamps a starting value that sits past the joint into the bounds", () => {
    const r = solveAngles({ part, params: { sh: 140 }, handle, grab: "tip", target: tipOf({ sh: 90 }) });
    expect(r.values.sh).toBeLessThanOrEqual(90 + 1e-9);
  });
});

describe("jointRingValues clamps to the joint's range", () => {
  const ring = (joint) => jointRings({ part, params: part.defaults, ids: ["h"], infoOf: (k) => limbInfo(part, part.defaults, { on: k }) })
    .find((r) => r.joint === joint);
  it("a hinge ring stops at the joint, not the slider", () => {
    const r = ring("sh");
    const w = jointRingValues({ part, params: part.defaults, ring: r, slot: Object.keys(r.slots)[0], value: 130 });
    expect(w.values.sh).toBe(90);
    expect(w.clamped).toBe(true);
    const ok = jointRingValues({ part, params: part.defaults, ring: r, slot: Object.keys(r.slots)[0], value: 40 });
    expect(ok.values.sh).toBe(40);
    expect(ok.clamped).toBe(false);
  });
  it("a negative-scale ring writes value / scale within the ordered bounds", () => {
    const r = ring("eb");
    const slot = Object.keys(r.slots)[0];
    const w = jointRingValues({ part, params: part.defaults, ring: r, slot, value: 100 });
    expect(w.values.eb).toBe(-60);
    expect(w.clamped).toBe(true);
  });
  it("a ball ring stops at the cone", () => {
    const r = ring("wr");
    const w = jointRingValues({ part, params: part.defaults, ring: r, slot: "bend", value: 50 });
    expect(Math.abs(w.values.wb)).toBeLessThanOrEqual(20 + 1e-9);
    expect(w.clamped).toBe(true);
  });
});

describe("lint: handle-joint-range", () => {
  const rule = (p) => lintPart(p).warnings.filter((f) => f.rule === "handle-joint-range");
  it("warns for each slider that reaches past its joint", () => {
    const fs = rule(part);
    expect(fs.map((f) => f.path).sort()).toEqual(["handles.h.joints.eb", "handles.h.joints.sh", "handles.h.joints.wr", "handles.h.joints.wr"].sort());
    expect(fs[0].message).toMatch(/slider/);
    expect(fs[0].hint).toMatch(/min/);
  });
  it("is quiet when the slider matches the joint, and when derive throws", () => {
    const tight = { ...part, parameters: [{ id: "p", title: "P", controls: [
      { key: "sh", min: 0, max: 90 }, { key: "eb", min: -60, max: 0 }, { key: "wb", min: -20, max: 20 }, { key: "ws", min: -20, max: 20 },
    ] }] };
    expect(rule(tight)).toEqual([]);
    expect(() => rule({ ...part, derive: () => { throw new Error("no"); } })).not.toThrow();
    expect(rule({ ...part, derive: () => { throw new Error("no"); } })).toEqual([]);
  });
  it("is quiet on the shipped limb parts", () => {
    for (const p of [hand, robotArm, robotFinger]) expect(rule(p)).toEqual([]);
  });
});
