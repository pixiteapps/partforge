import { describe, it, expect } from "vitest";
import { createCage } from "../src/framework/geometry/subdiv/index.js";
import { skinCacheStats } from "../src/framework/geometry/subdiv/skin.js";
import { cage as organicCage } from "../src/framework/domains/organic/index.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import { compose, invert } from "../src/framework/geometry/xform.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(...a);
const near3 = (a, b, tol = 1e-9) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tol));
const matrixOf = ({ origin: o, x, y, z }) => Float64Array.of(x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2], o[0], o[1], o[2]);
const apply = (M, p) => [0, 1, 2].map((i) => M[3 * i] * p[0] + M[3 * i + 1] * p[1] + M[3 * i + 2] * p[2] + M[9 + i]);

// Fixture A: one straight arm, two joints, every point inside the limb's radius.
const arm = (extra = {}) => limb("arm", {
  at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0],
  joints: ["mcp", "pip"], lengths: [30, 30], r: [12, 12, 12], ...extra,
});
const armCage = () => createCage({ box: { size: [16, 16, 60], center: [0, 0, 30], segs: [1, 1, 6] } });

// Fixture B: a palm with two fingers and a gap between them that opens upward.
const handCage = (scale = 0.8) => {
  const c = createCage({ box: { size: [40, 16, 20], center: [0, 0, 10], segs: [2, 1, 1] } });
  c.extrude("+z:0,0", { by: 40, steps: 4, scale, id: "L" });
  c.extrude("+z:1,0", { by: 40, steps: 4, scale, id: "R" });
  return c;
};
const finger = (name, x, extra = {}) => limb(name, {
  at: [x, 0, 20], toward: [0, 0, 1], bendToward: [0, -1, 0],
  joints: ["mcp", "pip"], lengths: [20, 20], r: [13, 13, 13], ...extra,
});
const left = finger("left", -10), right = finger("right", 10);

describe("cage.skin", () => {
  it("is on every cage: k.cage and partforge/organic's cage are createCage", () => {
    expect(typeof organicCage({ box: { size: [1, 1, 1] } }).skin).toBe("function");
  });

  it("moves no point at a rest pose, bit for bit", () => {
    const c = armCage();
    const before = c.snapshot();
    c.skin(arm().pose({}));
    expect(c.snapshot()).toEqual(before);
    const h = handCage();
    const hb = h.snapshot();
    h.skin([left.pose({}), right.pose({})]);
    expect(h.snapshot()).toEqual(hb);
  });

  it("moves points past a joint rigidly with it, and leaves points before it", () => {
    const c = armCage();
    const rest = c.snapshot();
    const posed = arm().pose({ bend: [0, 90] });
    c.skin(posed);
    const after = c.snapshot();
    const j = posed.bones.joints[1];
    const D = compose(matrixOf(j.posed), invert(matrixOf(j.rest)));
    let past = 0, before = 0;
    rest.points.forEach((p, i) => {
      if (p[2] > 30 + 6) { near3(after.points[i], apply(D, p)); past++; }
      if (p[2] < 30 - 6) { expect(after.points[i]).toEqual(p); before++; }
    });
    expect(past).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    expect(after.faces).toEqual(rest.faces);
    expect(after.ids).toEqual(rest.ids);
  });

  it("turns the ring at a bend, so it keeps its distance from the joint's axis", () => {
    const c = armCage();
    const rest = c.snapshot();
    const posed = arm().pose({ bend: [0, 90] });
    c.skin(posed);
    const after = c.snapshot();
    const axis = posed.ikInfo().axes.pip, O = posed.bones.joints[1].rest.origin;
    const fromAxis = (p) => len(cross(sub(p, O), axis));
    let ring = 0;
    rest.points.forEach((p, i) => {
      if (Math.abs(p[2] - 30) > 1e-9) return;
      expect(Math.abs(fromAxis(after.points[i]) - fromAxis(p))).toBeLessThan(1e-9);
      expect(after.points[i]).not.toEqual(p);
      ring++;
    });
    expect(ring).toBe(4);
  });

  it("keeps a finger's points from following the finger beside it", () => {
    const h = handCage();
    const rest = h.snapshot();
    const report = h.skin([left.pose({ bend: [60, 0] }), right.pose({})]);
    const after = h.snapshot();
    const moved = (i) => len(sub(after.points[i], rest.points[i]));
    const rightPts = new Set(rest.faces.filter((_, f) => rest.ids[f].startsWith("R")).flat());
    const leftPts = new Set(rest.faces.filter((_, f) => rest.ids[f].startsWith("L")).flat());
    let leftMax = 0;
    for (const i of leftPts) leftMax = Math.max(leftMax, moved(i));
    expect(leftMax).toBeGreaterThan(10);
    for (const i of rightPts) {
      const p = rest.points[i];
      if (p[2] > 20) expect(moved(i)).toBe(0);
    }
    // The palm-top points between the fingers share both limbs, so they move less.
    const between = rest.points.map((p, i) => i).filter((i) => rest.points[i][0] === 0 && rest.points[i][2] === 20);
    expect(between.length).toBe(2);
    for (const i of between) {
      expect(moved(i)).toBeGreaterThan(0);
      expect(moved(i)).toBeLessThan(leftMax);
    }
    expect(report.shared).toBeGreaterThan(0);
  });

  it("still builds when the fingers touch, and shares the touching points", () => {
    const h = handCage(1);
    const rest = h.snapshot();
    const report = h.skin([left.pose({ bend: [60, 0] }), right.pose({})]);
    const after = h.snapshot();
    expect(report.shared).toBeGreaterThan(0);
    // A point both limbs pull fully lands strictly between where each alone would put it:
    // the right limb, at rest, leaves it where it is; the left carries it rigidly with its
    // last joint, since the point is past both of the left's joints.
    const i = rest.points.findIndex((p) => p[0] === 0 && p[2] === 60);
    const j = left.pose({ bend: [60, 0] }).bones.joints[1];
    const byLeft = apply(compose(matrixOf(j.posed), invert(matrixOf(j.rest))), rest.points[i]);
    const span = sub(byLeft, rest.points[i]), got = sub(after.points[i], rest.points[i]);
    const t = (got[0] * span[0] + got[1] * span[1] + got[2] * span[2]) / (len(span) ** 2);
    expect(t).toBeGreaterThan(0.01);
    expect(t).toBeLessThan(0.99);
    near3(got, span.map((v) => v * t));
  });

  it("set.follow makes chosen faces follow a named limb", () => {
    const h = handCage();
    const rest = h.snapshot();
    const report = h.skin([left.pose({ bend: [60, 0] }), right.pose({})], { set: [{ faces: ["R"], follow: { left: 1 } }] });
    const after = h.snapshot();
    const cap = rest.faces[rest.ids.indexOf("R")];
    for (const i of cap) expect(len(sub(after.points[i], rest.points[i]))).toBeGreaterThan(5);
    expect(report.faces.R.follow).toEqual({ left: 1 });
  });

  it("set.follow over 1 is an error naming the face", () => {
    const h = handCage();
    expect(() => h.skin([left.pose({}), right.pose({})], { set: [{ faces: ["R"], follow: { left: 0.7, right: 0.6 } }] }))
      .toThrow(/set\[0\]\.follow adds up to 1\.3 for face "R" — at most 1/);
  });

  it("set.turn holds points still while the limb bends", () => {
    const h = handCage();
    const rest = h.snapshot();
    h.skin([left.pose({ bend: [60, 0] }), right.pose({})], { set: [{ faces: ["L"], turn: { "left.mcp": 0 } }] });
    const after = h.snapshot();
    for (const i of rest.faces[rest.ids.indexOf("L")]) expect(after.points[i]).toEqual(rest.points[i]);
  });

  describe("errors", () => {
    const pose = () => [left.pose({}), right.pose({})];
    it("names a limb with no r", () => {
      expect(() => handCage().skin(finger("bare", -10, { r: undefined }).pose({}))).toThrow(/limb "bare" has no r/);
    });
    it("names a limb that pulls no point, with the distance", () => {
      const far = limb("far", { at: [100, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["a"], lengths: [10], r: [5, 5] });
      expect(() => handCage().skin(far.pose({}))).toThrow(/limb "far" pulls no point of the cage: its rest line is 80\.4 mm from the nearest point/);
    });
    it("names an unknown limb in follow", () => {
      expect(() => handCage().skin(pose(), { set: [{ faces: ["R"], follow: { lft: 1 } }] }))
        .toThrow(/set\[0\]\.follow names "lft", which is not one of these limbs: left, right/);
    });
    it("names an unknown joint in turn", () => {
      expect(() => handCage().skin(pose(), { set: [{ faces: ["R"], turn: { "left.dip": 1 } }] }))
        .toThrow(/set\[0\]\.turn names "left\.dip", which is not a joint/);
    });
    it("names a turn on a face the limb does not pull", () => {
      expect(() => handCage().skin(pose(), { set: [{ faces: ["-z:0,0"], turn: { "left.mcp": 1 } }] }))
        .toThrow(/set\[0\]\.turn names "left\.mcp" for face "-z:0,0"/);
    });
    it("refuses a mirrored cage", () => {
      const m = createCage({ box: { size: [40, 16, 60], center: [0, 0, 30], segs: [2, 1, 6] }, mirror: "yz" });
      expect(() => m.skin(left.pose({}))).toThrow(/a mirrored cage cannot be skinned yet/);
    });
    it("refuses a limb with a parent", () => {
      const child = limb("kid", { parent: "hand.wrist", at: [0, 0, 20], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["a"], lengths: [10], r: [5, 5] });
      expect(() => handCage().skin(child.pose({}, { "hand.wrist": { at: [0, 0, 0] } }))).toThrow(/limb "kid" has a parent/);
    });
    it("refuses an unknown option, entry key, or something that is not a posed limb", () => {
      expect(() => handCage().skin(pose(), { blnd: 3 })).toThrow(/skin: unknown option "blnd"/);
      expect(() => handCage().skin(pose(), { set: [{ faces: ["R"], follows: { left: 1 } }] })).toThrow(/set\[0\] has unknown key "follows"/);
      expect(() => handCage().skin([left])).toThrow(/limbs\[0\] is not a posed limb/);
      expect(() => handCage().skin(pose(), { blend: { "left.dip": 4 } })).toThrow(/blend names "left\.dip"/);
    });
    it("gives the cage's own error for a face that was extruded away", () => {
      expect(() => handCage().skin(pose(), { set: [{ faces: ["+z:0,0"], follow: { left: 1 } }] }))
        .toThrow(/cage: face "\+z:0,0" was extruded; it is now L/);
    });
  });

  it("locks the cage after skin, and reads return posed values", () => {
    const c = armCage();
    const rest = c.snapshot();
    c.skin(arm().pose({ bend: [0, 90] }));
    expect(() => c.extrude("+z:0,0", { by: 5 })).toThrow(/cage: extrude after skin/);
    expect(() => c.move("+z:0,0", [0, 0, 1])).toThrow(/cage: move after skin/);
    expect(() => c.scale("+z:0,0", 0.5)).toThrow(/cage: scale after skin/);
    expect(() => c.rotate("+z:0,0", { axis: "x", deg: 5 })).toThrow(/cage: rotate after skin/);
    expect(() => c.crease("+z:0,0")).toThrow(/cage: crease after skin/);
    expect(() => c.skin(arm().pose({}))).toThrow(/cage: skin after skin/);
    const top = rest.faces[rest.ids.indexOf("+z:0,0")];
    const posed = c.snapshot();
    const mean = [0, 1, 2].map((k) => top.reduce((s, i) => s + posed.points[i][k], 0) / 4);
    near3(c.centroid("+z:0,0"), mean);
    expect(c.centroid("+z:0,0")[1]).toBeLessThan(-20);
    expect(c.bounds().min[1]).toBeLessThan(-20);
  });

  it("returns a plain-data report", () => {
    const h = handCage();
    const report = h.skin([left.pose({ bend: [30, 30] }), right.pose({})]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.limbs.left.points).toBeGreaterThan(0);
    expect(report.limbs.left.full).toBeGreaterThan(0);
    expect(report.shared).toBeGreaterThan(0);
    expect(report.still).toBeGreaterThan(0);
    expect(report.faces["-z:0,0"]).toBeUndefined();
    expect(report.faces.L.follow).toEqual({ left: 1 });
  });

  describe("edge cases", () => {
    it("a point exactly on a rest line follows it", () => {
      // The arm's line runs up the box's centre; a cage whose face crosses it puts a point on it.
      const c = createCage({ box: { size: [16, 16, 60], center: [0, 0, 30], segs: [2, 2, 6] } });
      const rest = c.snapshot();
      const i = rest.points.findIndex((p) => p[0] === 0 && p[1] === 0 && p[2] === 60);
      expect(i).toBeGreaterThanOrEqual(0);
      const report = c.skin(arm().pose({ bend: [0, 90] }));
      expect(report.still).toBe(0);
      expect(c.snapshot().points[i]).not.toEqual(rest.points[i]);
    });

    it("two limbs fully pulling one point share it, never past 1", () => {
      const a = limb("a", { at: [-1, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["j"], lengths: [60], r: [20, 20] });
      const b = limb("b", { at: [1, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["j"], lengths: [60], r: [20, 20] });
      const report = armCage().skin([a.pose({}), b.pose({})]);
      expect(report.shared).toBe(report.limbs.a.points);
      expect(report.limbs.a.full).toBe(0);
      for (const f of Object.values(report.faces)) expect(f.follow.a + f.follow.b).toBeLessThanOrEqual(1);
      expect(report.faces["+z:0,0"].follow).toEqual({ a: 0.5, b: 0.5 });
    });

    it("two joints at one place take the next segment's direction", () => {
      const two = limb("arm", { at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["a", "b", "c"], lengths: [0, 30, 30], r: [12, 12, 12, 12] });
      const c = armCage();
      const rest = c.snapshot();
      c.skin(two.pose({ bend: [0, 0, 90] }));
      const after = c.snapshot();
      const want = armCage();
      want.skin(arm().pose({ bend: [0, 90] }));
      after.points.forEach((p, i) => near3(p, want.snapshot().points[i]));
      // and a bend of the zero-length joint turns the points above it, not the ones below
      const d = armCage();
      d.skin(two.pose({ bend: [0, 45, 0] }));
      rest.points.forEach((p, i) => { if (p[2] > 6) expect(d.snapshot().points[i]).not.toEqual(p); });
    });

    it("a joint followed by a zero-length segment takes its share direction from the next one", () => {
      // Joint a's next origin (b) is at the same place; its direction must come from c.
      const two = limb("arm", { at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["a", "b", "c"], lengths: [0, 30, 30], r: [12, 12, 12, 12] });
      const posed = two.pose({ bend: [50, 0, 0] });
      const c = armCage();
      const rest = c.snapshot();
      c.skin(posed);
      const after = c.snapshot();
      const j = posed.bones.joints[0];
      const D = compose(matrixOf(j.posed), invert(matrixOf(j.rest)));
      let past = 0;
      rest.points.forEach((p, i) => { if (p[2] > 6) { near3(after.points[i], apply(D, p)); past++; } });
      expect(past).toBeGreaterThan(0);
    });
  });

  it("keeps weights by content: the same cage at two poses hits, a new blend misses", () => {
    const one = handCage().skin([left.pose({ bend: [10, 0] }), right.pose({})], { blend: 7.25 });
    const s1 = skinCacheStats();
    const two = handCage().skin([left.pose({ bend: [70, 40] }), right.pose({ bend: [5, 5] })], { blend: 7.25 });
    const s2 = skinCacheStats();
    expect(two).toEqual(one);
    expect(s2.hits).toBe(s1.hits + 1);
    expect(s2.misses).toBe(s1.misses);
    handCage().skin([left.pose({ bend: [70, 40] }), right.pose({ bend: [5, 5] })], { blend: 9.5 });
    const s3 = skinCacheStats();
    expect(s3.misses).toBe(s2.misses + 1);
    expect(s3.hits).toBe(s2.hits);
    const c1 = armCage(), c2 = armCage();
    c1.skin(arm().pose({ bend: [0, 90] }), { blend: 4 });
    c2.skin(arm().pose({ bend: [0, 90] }), { blend: 20 });
    expect(c2.snapshot().points).not.toEqual(c1.snapshot().points);
  });

  it("keeps two cages of one shape but different face ids apart", () => {
    const build = (a, b) => {
      const c = createCage({ box: { size: [40, 16, 20], center: [0, 0, 10], segs: [2, 1, 1] } });
      c.extrude("+z:0,0", { by: 40, steps: 4, scale: 0.8, id: a });
      c.extrude("+z:1,0", { by: 40, steps: 4, scale: 0.8, id: b });
      return c;
    };
    const first = build("L", "R"), second = build("P", "Q");
    const ids = (c) => new Set(c.snapshot().ids);
    const r1 = first.skin([left.pose({ bend: [20, 0] }), right.pose({})]);
    const r2 = second.skin([left.pose({ bend: [20, 0] }), right.pose({})]);
    for (const id of Object.keys(r1.faces)) expect(ids(first).has(id)).toBe(true);
    for (const id of Object.keys(r2.faces)) expect(ids(second).has(id)).toBe(true);
    expect(r2.faces.P.follow).toEqual({ left: 1 });
  });

  describe("a limb whose rest has a joint that is never 0", () => {
    const leaning = () => limb("w", {
      at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], lengths: [0, 0, 0, 20], r: [8, 8, 8, 8, 8],
      joints: [{ name: "a", range: [0, 75] }, { name: "lean", axis: "spread", range: [23, 23] }, { name: "tilt", range: [10, 10] }, { name: "m", range: [0, 50] }],
    });
    // A small box under the joints, its top extruded along the limb's resting direction.
    const leaningCage = (L) => {
      const tip = L.pose({}).bones.tip.rest;
      const c = createCage({ box: { size: [8, 8, 4], center: [0, 0, -2] } });
      c.extrude("+z:0,0", { by: tip.map((v) => v * 1.1), steps: 6, id: "w" });
      return c;
    };
    it("moves no point at pose({})", () => {
      const L = leaning();
      const c = leaningCage(L);
      const before = c.snapshot();
      c.skin(L.pose({}));
      expect(c.snapshot()).toEqual(before);
    });
    it("carries points well past joint m to the rigid place it gives", () => {
      const L = leaning();
      const c = leaningCage(L);
      const rest = c.snapshot();
      const posed = L.pose({ bend: { m: 40 } });
      c.skin(posed);
      const after = c.snapshot();
      const j = posed.bones.joints[3];
      const D = compose(matrixOf(j.posed), invert(matrixOf(j.rest)));
      const tip = posed.bones.tip.rest, u = tip.map((v) => v / len(tip));
      let past = 0, below = 0;
      rest.points.forEach((p, i) => {
        const along = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
        if (along > 8) { near3(after.points[i], apply(D, p)); past++; }
        if (along < -4) { expect(after.points[i]).toEqual(p); below++; }
      });
      expect(past).toBeGreaterThan(0);
      expect(below).toBeGreaterThan(0);
    });
  });
});
