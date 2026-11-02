// Joint offsets, ball joints, posed limbs as parents, and placing links built at rest.
import { describe, it, expect } from "vitest";
import { resolveFrames } from "../src/framework/geometry/xform.js";
import { limb } from "../src/framework/domains/kinematics/index.js";

const near = (a, b, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);
const near3 = (a, b, tol = 1e-6) => a.forEach((v, i) => near(v, b[i], tol));
const worldOf = (frames, name) => resolveFrames(frames).get(name).world;
const apply = (M, [x, y, z]) => [
  M[0] * x + M[1] * y + M[2] * z + M[9],
  M[3] * x + M[4] * y + M[5] * z + M[10],
  M[6] * x + M[7] * y + M[8] * z + M[11],
];
const tipOf = (posed, frames = {}) => { const M = worldOf({ ...frames, ...posed.frames }, posed.tip); return [M[9], M[10], M[11]]; };

/** A stand-in solid: a set of points that `place`'s rotate and translate move. */
function points(...pts) {
  return {
    pts,
    calls: 0,
    rotate(deg, about, axis) {
      const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      const l = Math.hypot(...axis), [x, y, z] = axis.map((v) => v / l);
      const R = [
        c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s,
        y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s,
        z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c),
      ];
      return { ...this, calls: this.calls + 1, pts: this.pts.map((p) => apply([...R, 0, 0, 0], p)) };
    },
    translate([a, b, c]) {
      return { ...this, calls: this.calls + 1, pts: this.pts.map(([x, y, z]) => [x + a, y + b, z + c]) };
    },
  };
}

describe("joint offset", () => {
  const digit = (extra = {}) => limb("d", {
    at: [0, 0, 4.6], toward: [0, 1, 0], bendToward: [0, 0, -1],
    joints: ["mcp", { name: "pip", offset: [0, 0, -0.5] }, { name: "dip", offset: [0, 0, -0.5] }],
    lengths: [40, 25, 20], ...extra,
  });

  it("puts a joint at the previous segment's end plus its offset, in the previous joint's frame", () => {
    const p = digit().pose({});
    expect(p.frames["d.pip"].at).toEqual([0, 40, -0.5]);
    expect(p.frames["d.dip"].at).toEqual([0, 25, -0.5]);
    near3(tipOf(p), [0, 85, 3.6]);
    // The offset turns with the previous joint: at mcp 90° the pip hinge's 0.5 mm drop runs along −Y.
    const bent = digit().pose({ bend: { mcp: 90 } });
    const pip = worldOf(bent.frames, "d.pip");
    near3([pip[9], pip[10], pip[11]], [0, -0.5, 4.6 - 40]);
  });

  it("mirrors with the limb", () => {
    const def = { at: [10, 0, 0], toward: [1, 0, 0], bendToward: [0, 0, -1], joints: ["a", { name: "b", offset: [2, 1, 3] }], lengths: [20, 15] };
    const pose = { bend: [30, 40], spread: 12 };
    const r = tipOf(limb("r", def).pose(pose));
    const l = tipOf(limb("l", { ...def, mirror: "YZ" }).pose(pose));
    near3(l, [-r[0], r[1], r[2]]);
  });

  it("refuses an offset on the base joint, and a bad offset", () => {
    expect(() => limb("x", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "a", offset: [0, 0, 1] }], lengths: [5] }))
      .toThrow(/limb "x".joints\[0\].offset: the base joint has no previous joint/);
    expect(() => digit({ joints: ["mcp", { name: "pip", offset: [0, 1] }, "dip"] })).toThrow(/joints\[1\].offset: must be \[x, y, z\]/);
  });

  it("reach and grip solve through offsets", () => {
    const f = digit({ joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", offset: [0, 0, -0.5], range: [0, 110] }, { name: "dip", offset: [0, 0, -0.5], range: [0, 90] }] });
    const target = tipOf(f.pose({ bend: [30, 50, 40] }));
    const solved = f.pose({ reach: target });
    expect(solved.report.reach.status).toBe("reached");
    near3(solved.report.tip, target, 0.01);
    const grip = f.pose({ grip: { around: { kind: "cylinder", r: 8, h: 40, at: [0, 45, -15], axis: "x" }, r: [4, 4, 4, 4] } });
    expect(grip.report.grip.touching).toBe(true);
  });

  it("reach still refuses an offset ahead of its aim joint", () => {
    const f = limb("y", { toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [{ name: "yaw", axis: "spread", length: 0 }, { name: "a", offset: [0, 0, 1] }, "b"], lengths: [0, 10, 10] });
    expect(() => f.pose({ reach: [0, 10, 0] })).toThrow(/reach needs the limb's first bend joint at its base/);
  });
});

describe("ball joint", () => {
  const thumb = (extra = {}) => limb("t", {
    toward: [0, 1, 0], bendToward: [0, 0, -1],
    joints: [{ name: "ball", type: "ball", cone: 45, length: 20 }, { name: "mcp", range: [0, 90] }],
    lengths: [20, 15], ...extra,
  });
  const hinged = (axis) => limb("h", {
    toward: [0, 1, 0], bendToward: [0, 0, -1],
    joints: [{ name: "a", axis, range: [-180, 180] }, { name: "mcp", range: [0, 90] }], lengths: [20, 15],
  });

  it("a bend alone swings like a hinge bend, a spread alone like a spread joint", () => {
    near3(tipOf(thumb().pose({ bend: { ball: { bend: 30 } } })), tipOf(hinged("bend").pose({ bend: { a: 30 } })));
    near3(tipOf(thumb().pose({ bend: { ball: { spread: -20 } } })), tipOf(hinged("spread").pose({ bend: { a: -20 } })));
  });

  it("swings once by √(bend² + spread²) and twists about the swung segment", () => {
    const p = thumb().pose({ bend: { ball: { bend: 30, spread: 40 }, mcp: 0 } });
    const M = worldOf(p.frames, "t.mcp");
    const dir = [M[1], M[4], M[7]];   // the mcp frame's +Y: the swung segment
    near(Math.acos(dir[1]) * (180 / Math.PI), 45, 1e-9);
    expect(p.report.clamped).toEqual([true, false]);   // 50° swing clamped to the 45° cone
    expect(p.report.bend[0]).toEqual({ bend: 27, spread: 36, twist: 0 });
    // Twist leaves the segment where it is and rolls the joints beyond it.
    const twisted = thumb().pose({ bend: { ball: { bend: 30, twist: 90 }, mcp: 40 } });
    const plain = thumb().pose({ bend: { ball: { bend: 30 }, mcp: 40 } });
    const a = worldOf(twisted.frames, "t.mcp"), b = worldOf(plain.frames, "t.mcp");
    near3([a[9], a[10], a[11]], [b[9], b[10], b[11]]);
    expect(Math.hypot(...twisted.report.tip.map((v, i) => v - plain.report.tip[i]))).toBeGreaterThan(1);
  });

  it("curl leaves a ball at rest; an array bend takes the ball's object in its slot", () => {
    expect(thumb().pose({ curl: 1 }).report.bend).toEqual([{ bend: 0, spread: 0, twist: 0 }, 90]);
    expect(thumb().pose({ curl: 1, bend: { ball: { spread: 10 } } }).report.bend).toEqual([{ bend: 0, spread: 10, twist: 0 }, 90]);
    expect(thumb().pose({ bend: [{ bend: 10 }, 20] }).values).toEqual([{ bend: 10, spread: 0, twist: 0 }, 20]);
  });

  it("mirrors symmetrically", () => {
    const def = { at: [5, 0, 0], toward: [1, 0, 0], bendToward: [0, 0, -1], joints: [{ name: "b", type: "ball", length: 10 }, "k"], lengths: [10, 10] };
    const pose = { bend: { b: { bend: 20, spread: 15, twist: 30 }, k: 25 } };
    const r = tipOf(limb("r", def).pose(pose)), l = tipOf(limb("l", { ...def, mirror: "YZ" }).pose(pose));
    near3(l, [-r[0], r[1], r[2]]);
  });

  it("validates its definition and its values", () => {
    const def = (j) => ({ toward: [0, 1, 0], bendToward: [0, 0, -1], joints: [j, "k"], lengths: [10, 10] });
    expect(() => limb("b", def({ name: "a", type: "ball", axis: "spread" }))).toThrow(/joints\[0\].axis: a ball joint has no axis/);
    expect(() => limb("b", def({ name: "a", type: "ball", range: [0, 10] }))).toThrow(/takes cone .* not range/);
    expect(() => limb("b", def({ name: "a", type: "ball", cone: 0 }))).toThrow(/cone: must be a number of degrees > 0 and ≤ 180/);
    expect(() => limb("b", def({ name: "a", cone: 30 }))).toThrow(/only a ball joint takes cone/);
    expect(() => limb("b", def({ name: "a", type: "socket" }))).toThrow(/type: must be "hinge" or "ball"/);
    expect(() => limb("b", { ...def({ name: "a", type: "ball" }), joints: [{ name: "a", type: "ball" }, { name: "k", follow: { joint: "a" } }] }))
      .toThrow(/a is a ball joint; a joint can follow only a hinge/);
    const t = thumb();
    expect(() => t.pose({ bend: { ball: 30 } })).toThrow(/limb "t".bend.ball: a ball joint takes \{ bend\?, spread\?, twist\? \}/);
    expect(() => t.pose({ bend: { ball: { roll: 3 } } })).toThrow(/bend.ball.roll: unknown ball option "roll"/);
    expect(() => t.pose({ bend: { ball: { bend: NaN } } })).toThrow(/bend.ball.bend: must be a finite number/);
  });

  it("reach and grip hold the ball and solve the hinges beyond it", () => {
    const f = limb("g", {
      toward: [0, 1, 0], bendToward: [0, 0, -1],
      joints: [{ name: "ball", type: "ball", length: 0 }, { name: "mcp", range: [-10, 90] }, { name: "ip", range: [0, 90] }],
      lengths: [0, 30, 20],
    });
    const ball = { bend: 10, spread: 20, twist: 15 };
    const target = tipOf(f.pose({ bend: { ball, mcp: 40, ip: 30 } }));
    const solved = f.pose({ bend: { ball }, reach: target });
    expect(solved.report.reach.status).toBe("reached");
    expect(solved.report.bend[0]).toEqual(ball);
    const grip = f.pose({ bend: { ball }, grip: { around: { kind: "sphere", r: 6, at: target }, r: [3, 3, 3, 3] } });
    expect(grip.report.bend[0]).toEqual(ball);
    expect(grip.report.grip.joints.map((j) => j.joint)).toEqual(["mcp", "ip"]);
  });
});

describe("a posed limb as the parent", () => {
  const palm = { palm: { at: [0, 0, 10], rotate: { axis: "x", deg: 20 } } };
  const arm = limb("arm", { parent: "palm", at: [0, 30, 0], toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["a"], lengths: [40] });
  const hand = limb("hand", { parent: "arm.tip", toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["b"], lengths: [20] });
  const nail = limb("nail", { parent: "hand.tip", at: [0, 0, 2], toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["c"], lengths: [5] });

  it("stands in for every frame of its chain", () => {
    const a = arm.pose({ bend: [30] }, palm);
    const h = hand.pose({ bend: [40] }, a);
    const n = nail.pose({ bend: [10] }, h);
    const by = nail.pose({ bend: [10] }, { ...palm, ...a.frames, ...h.frames });
    expect(n.report.tip).toEqual(by.report.tip);
    expect(n.world("c")).toEqual(by.world("c"));
  });

  it("takes an array of frames and posed limbs, later entries winning", () => {
    const a = arm.pose({ bend: [30] }, palm);
    const viaArray = hand.pose({ bend: [40] }, [{ unrelated: { at: [1, 2, 3] } }, a]);
    expect(viaArray.report.tip).toEqual(hand.pose({ bend: [40] }, a).report.tip);
  });

  it("refuses anything else", () => {
    expect(() => hand.pose({}, 5)).toThrow(/pose frames must be a \{ name: frame \} object, a posed limb, or an array of them/);
  });
});

describe("place from rest", () => {
  const finger = limb("f", {
    at: [5, 10, 4], toward: [1, 1, 0], bendToward: [0, 0, -1],
    joints: [{ name: "mcp", range: [-10, 90] }, { name: "pip", offset: [0, 0, -0.5], range: [0, 110] }],
    lengths: [30, 20],
  });

  it("moves a link built at rest, in part coordinates, by its joint's rest-to-posed motion", () => {
    const rest = finger.pose({});
    const posed = finger.pose({ bend: [40, 60] });
    // A point fixed to the pip link, written in part coordinates at rest…
    const local = [1, 7, -2];
    const atRest = apply(worldOf(rest.frames, "f.pip"), local);
    // …lands where that link's frame carries it in the posed limb.
    const moved = posed.place(points(atRest), "pip", { from: "rest" });
    near3(moved.pts[0], apply(worldOf(posed.frames, "f.pip"), local));
    expect(moved.calls).toBe(2);
  });

  it("is the identity at rest", () => {
    const p = [3, 4, 5];
    near3(finger.pose({}).place(points(p), "pip", { from: "rest" }).pts[0], p);
  });

  it("measures a parented limb's rest with its parent limb at rest too", () => {
    const base = limb("base", { toward: [0, 0, 1], bendToward: [1, 0, 0], joints: ["a"], lengths: [30] });
    const top = limb("top", { parent: "base.tip", toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["b"], lengths: [10] });
    const restBase = base.pose({}), restTop = top.pose({}, restBase);
    const b = base.pose({ bend: [50] }), t = top.pose({ bend: [30] }, b);
    const local = [0, 4, 1];
    const atRest = apply(worldOf({ ...restBase.frames, ...restTop.frames }, "top.b"), local);
    near3(t.place(points(atRest), "b", { from: "rest" }).pts[0], apply(worldOf({ ...b.frames, ...t.frames }, "top.b"), local));
  });

  it("validates its options", () => {
    const p = finger.pose({});
    expect(() => p.place(points([0, 0, 0]), "pip", { from: "printed" })).toThrow(/place: from must be "joint" or "rest"/);
    expect(() => p.place(points([0, 0, 0]), "pip", { form: "rest" })).toThrow(/place: unknown option "form"/);
  });
});

describe("ball joint posed by rotate steps", () => {
  const base = { at: [3, -2, 5], toward: [1, 1, 0], bendToward: [0, 0, -1] };
  const ballLimb = (extra = {}) => limb("b", {
    ...base, joints: [{ name: "ball", type: "ball" }, { name: "mcp", offset: [0, 0, -1], range: [0, 90] }], lengths: [22, 15], ...extra,
  });
  const frameOf = (posed, name) => Array.from(worldOf(posed.frames, name));
  const sameFrames = (a, b, names) => names.forEach((n) => frameOf(a, n).forEach((v, i) => near(v, frameOf(b, n)[i], 1e-9)));

  it("reproduces a four-step swing, yaw, roll and twist made of zero-length hinges", () => {
    const hinges = limb("b", {
      ...base,
      joints: [
        { name: "swing", range: [-180, 180] }, { name: "yaw", axis: "spread", range: [-180, 180] },
        { name: "roll", axis: "twist", range: [-180, 180] }, { name: "ball", range: [-180, 180] },
        { name: "mcp", offset: [0, 0, -1], range: [0, 90] },
      ],
      lengths: [0, 0, 0, 22, 15],
    });
    for (const [swing, yaw, roll, twist] of [[60, 30, 40, 25], [10, -70, 0, 90], [120, 15, -160, -30]]) {
      const old = hinges.pose({ bend: { swing, yaw, roll, ball: twist, mcp: 35 } });
      const steps = [{ axis: "x", deg: -swing }, { axis: "z", deg: yaw }, { axis: "y", deg: roll }, { axis: "x", deg: -twist }];
      const now = ballLimb().pose({ bend: { ball: { rotate: steps }, mcp: 35 } });
      sameFrames(now, old, ["b.mcp", "b.tip"]);
      expect(now.report.clamped).toEqual([false, false]);
    }
  });

  it("matches the rotation of its steps for vector axes, and at a 180° swing", () => {
    const steps = [{ axis: [1, 2, -0.5], deg: 47 }, { axis: "y", deg: 210 }, { axis: [0, 1, 1], deg: -33 }];
    const turned = limb("b", { ...base, joints: [{ name: "ball", axis: [0, 0, 1], range: [0, 0] }, { name: "mcp", offset: [0, 0, -1], range: [0, 90] }], lengths: [22, 15] });
    const ref = turned.pose({});
    ref.frames["b.ball"].rotate = [...(ref.frames["b.ball"].rotate ?? []), ...steps];
    ref.frames["b.mcp"].rotate = [{ axis: [1, 0, 0], deg: -20 }];
    sameFrames(ballLimb().pose({ bend: { ball: { rotate: steps }, mcp: 20 } }), ref, ["b.mcp", "b.tip"]);
    // Straight back: no shortest swing, so it is read as a bend of 180°.
    const back = ballLimb().pose({ bend: { ball: { rotate: [{ axis: "x", deg: 180 }, { axis: "y", deg: 30 }] } } });
    expect(Math.abs(back.report.bend[0].bend)).toBe(180);
    const flip = limb("f", { ...base, joints: [{ name: "a", axis: [1, 0, 0], range: [180, 180] }, { name: "mcp", offset: [0, 0, -1], range: [0, 90] }], lengths: [22, 15] }).pose({});
    flip.frames["f.a"].rotate.push({ axis: "y", deg: 30 });
    near3(tipOf(back), tipOf(flip), 1e-9);
  });

  it("is clamped by the cone and reported as one swing and twist", () => {
    const p = ballLimb({ joints: [{ name: "ball", type: "ball", cone: 30 }, { name: "mcp", range: [0, 90] }] })
      .pose({ bend: { ball: { rotate: [{ axis: "x", deg: -40 }, { axis: "y", deg: 15 }] } } });
    expect(p.report.bend[0]).toEqual({ bend: 30, spread: 0, twist: 15 });
    expect(p.report.clamped[0]).toBe(true);
  });

  it("mirrors symmetrically", () => {
    const def = { at: [5, 0, 0], toward: [1, 0, 0], bendToward: [0, 0, -1], joints: [{ name: "b", type: "ball" }, "k"], lengths: [10, 10] };
    const pose = { bend: { b: { rotate: [{ axis: "x", deg: -25 }, { axis: "z", deg: 20 }, { axis: "y", deg: 35 }] }, k: 25 } };
    const r = tipOf(limb("r", def).pose(pose)), l = tipOf(limb("l", { ...def, mirror: "YZ" }).pose(pose));
    near3(l, [-r[0], r[1], r[2]]);
  });

  it("validates its steps", () => {
    const t = ballLimb();
    expect(() => t.pose({ bend: { ball: { rotate: [{ axis: "x", deg: 10 }], bend: 3 } } })).toThrow(/bend.ball.bend: use rotate or bend\/spread\/twist, not both/);
    expect(() => t.pose({ bend: { ball: { rotate: [{ axis: "w", deg: 10 }] } } })).toThrow(/bend.ball.rotate\[0\].axis: must be "x", "y", "z" or a non-zero \[x, y, z\]/);
    expect(() => t.pose({ bend: { ball: { rotate: { axis: "x", deg: "10" } } } })).toThrow(/bend.ball.rotate.deg: must be a finite number/);
    expect(() => t.pose({ bend: { ball: { rotate: [{ axis: "x", by: 10 }] } } })).toThrow(/bend.ball.rotate\[0\].by: unknown option "by"/);
  });
});
