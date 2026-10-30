import { describe, it, expect } from "vitest";
import { resolveFrames } from "../src/framework/geometry/xform.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { buildTree, jointSteps } from "../src/framework/domains/kinematics/tree.js";

const world = (posed, frames = {}) => resolveFrames({ ...frames, ...posed.frames });
const origin = (W, name) => { const M = W.get(name).world; return [M[9], M[10], M[11]]; };
const col = (M, j) => [M[j], M[3 + j], M[6 + j]];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.sqrt(dot(a, a));
const perp = (b, t) => { const tu = t.map((v) => v / norm(t)); const d = dot(b, tu); return b.map((v, i) => v - d * tu[i]); };
const near3 = (a, b, tol) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tol));
const det = (M) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);

const finger = (extra = {}) => limb("index", {
  toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", range: [0, 110] }, { name: "dip", range: [0, 80] }],
  lengths: [42, 25, 22], ...extra,
});

describe("limb structure and pose", () => {
  it("names its frames and returns the frame names", () => {
    const f = finger();
    expect(f.name).toBe("index");
    expect(f.joints).toEqual(["index.mcp", "index.pip", "index.dip"]);
    expect(f.tip).toBe("index.tip");
    const p = f.pose({});
    expect(Object.keys(p.frames)).toEqual(["index.mcp", "index.pip", "index.dip", "index.tip"]);
    expect(p.joints).toEqual(f.joints);
    expect(p.tip).toBe("index.tip");
    expect(p.frames["index.pip"]).toMatchObject({ parent: "index.mcp", at: [0, 42, 0] });
    expect(p.frames["index.tip"]).toEqual({ parent: "index.dip", at: [0, 22, 0] });
    expect(p.frames["index.mcp"].parent).toBeUndefined();
  });

  it("buildTree and jointSteps expose the structure", () => {
    const t = buildTree("f", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a", { name: "b", axis: "spread" }], lengths: [5, 6] });
    expect(t.joints.map((j) => j.frame)).toEqual(["f.a", "f.b"]);
    expect(t.joints[1].axisKind).toBe("spread");
    expect(t.joints[0].axis).toEqual([1, 0, 0]);
    expect(t.mirrorAxis).toBe(null);
    const steps = jointSteps(t, [10, 20], { spread: 0, twist: 0 });
    expect(steps["f.a"]).toEqual([{ axis: [1, 0, 0], deg: -10 }]);
    expect(steps["f.b"]).toEqual([{ axis: [0, 0, 1], deg: 20 }]);
  });

  it("bends toward bendToward for any direction pair (sign)", () => {
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    let n = 0;
    while (n < 50) {
      const toward = [rnd(), rnd(), rnd()], bendToward = [rnd(), rnd(), rnd()];
      if (norm(toward) < 0.1 || norm(perp(bendToward, toward)) < 0.1 * norm(bendToward)) continue;
      n++;
      const L = limb("x", { at: [1, 2, 3], toward, bendToward, joints: ["a", "b", "c"], lengths: [30, 20, 15] });
      const t0 = origin(world(L.pose({ bend: [0, 0, 0] })), "x.tip");
      const tp = origin(world(L.pose({ bend: [0, 40, 0] })), "x.tip");
      const tn = origin(world(L.pose({ bend: [0, -5, 0] })), "x.tip");
      const b = perp(bendToward, toward);
      expect(dot(sub(tp, t0), b)).toBeGreaterThan(0);
      expect(dot(sub(tn, t0), b)).toBeLessThan(0);
    }
  });

  it("a straight limb's tip is at + toward·Σlengths", () => {
    const toward = [0.3, -0.5, 0.8], u = toward.map((v) => v / norm(toward));
    const L = limb("x", { at: [4, -2, 7], toward, bendToward: [1, 0, 0], joints: ["a", "b", "c"], lengths: [30, 20, 15] });
    const tip = origin(world(L.pose({ bend: [0, 0, 0] })), "x.tip");
    near3(tip, [4 + 65 * u[0], -2 + 65 * u[1], 7 + 65 * u[2]], 1e-9);
  });

  it("curl follows the closing end for one-signed ranges", () => {
    const L = limb("c", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "n", range: [-100, -10] }, { name: "p", range: [20, 110] }], lengths: [10, 10] });
    expect(L.pose({ curl: 1 }).values).toEqual([-100, 110]);
    const z = L.pose({ curl: 0 });
    expect(z.values).toEqual([-10, 20]);
    expect(z.report.clamped).toEqual([false, false]);
  });

  it("curl poses bend joints as curl × range[1]", () => {
    expect(finger().pose({ curl: 0.5 }).values).toEqual([45, 55, 40]);
    const L = limb("x", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: [{ name: "s", axis: "spread", length: 0, range: [-30, 30] }, { name: "a", range: [0, 90] }, { name: "b", range: [0, 60] }],
      lengths: [0, 20, 10],
    });
    expect(L.pose({ curl: 0.5 }).values).toEqual([0, 45, 30]);
    // curl sets the bend joints; an object bend sets the rest.
    expect(L.pose({ curl: 0.5, bend: { s: 12 } }).values).toEqual([12, 45, 30]);
  });

  it("bend as an object or as an array over driven joints", () => {
    expect(finger().pose({ bend: { pip: 60 } }).values).toEqual([0, 60, 0]);
    const L = limb("x", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: ["mcp", "pip", { name: "dip", follow: { joint: "pip" } }, "end"],
      lengths: [10, 10, 10, 10],
    });
    expect(L.pose({ bend: [5, 30, 7] }).values).toEqual([5, 30, 30, 7]);
  });

  it("followers follow, and clamp to their own range", () => {
    const mk = (range) => limb("x", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: ["mcp", { name: "pip", range: [0, 110] }, { name: "dip", range, follow: { joint: "pip", ratio: 0.75, offset: 2 } }],
      lengths: [10, 10, 10],
    });
    const a = mk([0, 80]).pose({ bend: { pip: 60 } });
    expect(a.values[2]).toBe(47);
    expect(a.report.clamped).toEqual([false, false, false]);
    const b = mk([0, 40]).pose({ bend: { pip: 60 } });
    expect(b.values[2]).toBe(40);
    expect(b.report.clamped[2]).toBe(true);
  });

  it("clamps to range and reports it", () => {
    const p = finger().pose({ bend: { mcp: 150 } });
    expect(p.values[0]).toBe(90);
    expect(p.report.clamped[0]).toBe(true);
    expect(p.report.bend).toEqual([90, 0, 0]);
  });

  it("a zero joint emits no step", () => {
    const p = finger().pose({ bend: [0, 0, 0] });
    for (const f of ["index.pip", "index.dip", "index.tip"]) expect(p.frames[f].rotate ?? []).toEqual([]);
    expect(p.frames["index.mcp"].rotate ?? []).toEqual([]);
  });

  it("a two-axis base equals spread", () => {
    const A = limb("x", {
      at: [3, 4, 5], toward: [0.2, 1, 0.1], bendToward: [0, 0.3, -1],
      joints: [{ name: "s", axis: "spread", length: 0, range: [-30, 30] }, "mcp", "pip"], lengths: [0, 30, 20],
    });
    const B = limb("x", { at: [3, 4, 5], toward: [0.2, 1, 0.1], bendToward: [0, 0.3, -1], joints: ["mcp", "pip"], lengths: [30, 20] });
    near3(origin(world(A.pose({ bend: { s: 12, mcp: 20 } })), "x.tip"), origin(world(B.pose({ bend: { mcp: 20 }, spread: 12 })), "x.tip"), 1e-9);
  });

  it("a vector axis turns by the right-hand rule", () => {
    const L = limb("x", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "a", axis: [0, 0, 1], range: [-180, 180] }, "b"], lengths: [10, 10] });
    const W = world(L.pose({ bend: { a: 90 } }));
    near3(origin(W, "x.b"), [-10, 0, 0], 1e-9);
    near3(origin(W, "x.tip"), [-20, 0, 0], 1e-9);
  });

  it("the rotate escape hatch", () => {
    const L = limb("x", { rotate: [{ axis: "z", deg: 8 }], joints: ["a", "b"], lengths: [10, 10] });
    expect(L.pose({ bend: [30, 0] }).frames["x.a"].rotate).toEqual([{ axis: "z", deg: 8 }, { axis: [1, 0, 0], deg: -30 }]);
    expect(() => L.pose({ spread: 3 })).toThrow("spread/twist need toward/bendToward, not rotate");
  });

  it.each([["YZ", 0], ["XZ", 1], ["XY", 2]])("mirror %s reflects positions and keeps frames right-handed", (plane, ax) => {
    const def = {
      parent: "torso", at: [20, 5, 3], toward: [1, 0.2, 0], bendToward: [0, 0, -1],
      joints: [
        { name: "s", axis: "spread", length: 0, range: [-30, 30] },
        { name: "v", axis: [0.3, 0, 1], length: 12, range: [-90, 90] },
        { name: "a", length: 20 }, { name: "b", length: 15 },
      ],
    };
    const opts = { bend: { s: 10, v: 25, a: 30, b: 40 }, spread: 7, twist: 11 };
    const torso = { torso: { at: [0, 50, 0] } };
    const W0 = world(limb("arm", def).pose(opts), torso);
    const W1 = world(limb("arm", { ...def, mirror: plane }).pose(opts), torso);
    for (const f of ["arm.s", "arm.v", "arm.a", "arm.b", "arm.tip"]) {
      const [x, y, z] = origin(W0, f);
      const P = (v) => v.map((c, i) => (i === ax ? -c : c));
      // Positions reflect across the plane through the parent's origin; directions just flip.
      near3(origin(W1, f), [x, y, z].map((c, i) => (i === ax ? 2 * torso.torso.at[ax] - c : c)), 1e-9);
      const M0 = W0.get(f).world, M1 = W1.get(f).world;
      near3(col(M1, 1), P(col(M0, 1)), 1e-9);
      near3(col(M1, 2), P(col(M0, 2)), 1e-9);
      expect(det(M1)).toBeGreaterThan(0);
      expect(dot(cross(col(M1, 0), col(M1, 1)), col(M1, 2))).toBeGreaterThan(0);
    }
    expect(Math.abs(origin(W0, "arm.tip")[ax] - torso.torso.at[ax])).toBeGreaterThan(1);
  });

  it("report.tip, rounding and no −0", () => {
    const p = finger({ at: [0, 0, 0] }).pose({ bend: [0, 0, 0] });
    expect(p.report.tip).toEqual([0, 89, 0]);
    expect(Object.is(p.report.tip[0], -0)).toBe(false);
    expect(Object.is(p.report.tip[2], -0)).toBe(false);
    const q = finger({ at: [0.12345, 0, 0] }).pose({ bend: { mcp: 33.33333 } });
    expect(q.report.bend[0]).toBe(33.333);
    for (const v of q.report.tip) expect(Math.round(v * 1000) / 1000).toBe(v);
    const withParent = finger({ parent: "palm", at: [1, 2, 3] });
    expect(withParent.pose({}).report.tip).toBeUndefined();
    expect(withParent.pose({}, { palm: { at: [10, 0, 0] } }).report.tip).toEqual([11, 91, 3]);
  });

  it("is deterministic", () => {
    const a = finger().pose({ bend: { mcp: 20, pip: 30 }, spread: 4, twist: 2 });
    const b = finger().pose({ bend: { mcp: 20, pip: 30 }, spread: 4, twist: 2 });
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames));
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  });
});

describe("limb errors", () => {
  const base = { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["mcp", "pip", "dip"], lengths: [10, 10, 10] };
  const make = (over) => () => limb("index", { ...base, ...over });
  const cases = [
    ["lengths: expected 3 entries, got 2", make({ lengths: [1, 2] })],
    ["r: expected 4 entries (one per joint, then the tip), got 3", make({ r: [1, 2, 3] })],
    ["bend: expected 3 entries (driven joints), got 4", () => limb("index", base).pose({ bend: [1, 2, 3, 4] })],
    ["joints[1].range: must be [min, max] with min ≤ max", make({ joints: ["mcp", { name: "pip", range: [10, 0] }, "dip"] })],
    ["toward: must be a non-zero [x, y, z]", make({ toward: [0, 0, 0] })],
    ["bendToward: must not be parallel to toward", make({ bendToward: [0, 2, 0] })],
    ["bendToward: must not be parallel to toward", make({ bendToward: [0, 1, 1e-9] })],
    ["use bend or curl, not both", () => limb("index", base).pose({ bend: [1, 2, 3], curl: 0.5 })],
    ["use bend or curl, not both", () => limb("index", base).pose({ bend: { pip: 2 }, curl: 0.5 })],
    ["use reach or grip, not both", () => limb("index", base).pose({ reach: [0, 0, 0], grip: {} })],
    ["joints[2].name: duplicate joint \"pip\"", make({ joints: ["mcp", "pip", "pip"] })],
    ["joints[2].follow.joint: unknown or later joint \"tip2\"", make({ joints: ["mcp", "pip", { name: "dip", follow: { joint: "tip2" } }] })],
    ["joints[1].follow.joint: unknown or later joint \"dip\"", make({ joints: ["mcp", { name: "pip", follow: { joint: "dip" } }, "dip"] })],
    ["bend.dip: dip follows pip and takes no value", () => limb("index", { ...base, joints: ["mcp", "pip", { name: "dip", follow: { joint: "pip" } }] }).pose({ bend: { dip: 3 } })],
    ["joints[0].axis: must be \"bend\", \"spread\", \"twist\" or a non-zero [x, y, z]", make({ joints: [{ name: "mcp", axis: "q" }, "pip", "dip"] })],
    ["joints[0].axis: must be \"bend\", \"spread\", \"twist\" or a non-zero [x, y, z]", make({ joints: [{ name: "mcp", axis: [0, 0, 0] }, "pip", "dip"] })],
    ["bend.pip: must be a finite number", () => limb("index", base).pose({ bend: { pip: NaN } })],
    ["curl: must be a number from 0 to 1", () => limb("index", base).pose({ curl: "0.5" })],
    ["curl: must be a number from 0 to 1", () => limb("index", base).pose({ curl: 1.5 })],
    ["spread: must be a finite number", () => limb("index", base).pose({ spread: Infinity })],
    ["mirror needs toward/bendToward, not rotate", () => limb("index", { joints: ["a"], lengths: [1], rotate: [{ axis: "z", deg: 3 }], mirror: "YZ" })],
    ["parent: unknown frame \"plam\"", () => limb("index", { ...base, parent: "plam" }).pose({}, { palm: {} })],
  ];
  for (const [msg, fn] of cases) it(msg, () => expect(fn).toThrow(msg));

  it("errors are SpecErrors prefixed with the limb name", () => {
    let err;
    try { make({ lengths: [1, 2] })(); } catch (e) { err = e; }
    expect(err.name).toBe("SpecError");
    expect(err.message).toContain('limb "index".lengths: expected 3 entries, got 2');
  });
});
