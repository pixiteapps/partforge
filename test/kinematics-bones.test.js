import { describe, it, expect } from "vitest";
import { limb } from "../src/framework/domains/kinematics/index.js";

const def = (extra = {}) => ({
  at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0],
  joints: ["mcp", "pip"], lengths: [30, 20], r: [8, 7, 6], ...extra,
});
const near3 = (a, b, tol = 1e-9) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tol));

describe("a posed limb's bones", () => {
  it("names the limb, its joints and its radii", () => {
    const { bones } = limb("f", def()).pose({});
    expect(bones.kind).toBe("partforge.bones");
    expect(bones.name).toBe("f");
    expect(bones.parent).toBe(false);
    expect(bones.r).toEqual([8, 7, 6]);
    expect(bones.joints.map((j) => j.name)).toEqual(["f.mcp", "f.pip"]);
  });

  it("at rest, every joint's posed frame is its rest frame", () => {
    const { bones } = limb("f", def()).pose({});
    for (const j of bones.joints) expect(j.posed).toEqual(j.rest);
    near3(bones.tip.rest, [0, 0, 50]);
    expect(bones.tip.posed).toEqual(bones.tip.rest);
  });

  it("posed frames move with the pose, unrounded, and rest frames do not", () => {
    const f = limb("f", def());
    const rest = f.pose({}).bones;
    const { bones } = f.pose({ bend: [90, 0] });
    near3(bones.joints[1].posed.origin, [0, -30, 0]);
    near3(bones.tip.posed, [0, -50, 0]);
    expect(bones.joints.map((j) => j.rest)).toEqual(rest.joints.map((j) => j.rest));
    expect(bones.tip.rest).toEqual(rest.tip.rest);
  });

  it("is plain data", () => {
    const { bones } = limb("f", def()).pose({ bend: [37, 12], spread: 5 });
    expect(JSON.parse(JSON.stringify(bones))).toEqual(bones);
  });

  it("holds null for a limb with no r, and marks a limb with a parent", () => {
    expect(limb("f", def({ r: undefined })).pose({}).bones.r).toBe(null);
    const child = limb("c", def({ parent: "hand.wrist", r: undefined }));
    expect(child.pose({}).bones.parent).toBe(true);
    const hand = { "hand.wrist": { at: [5, 0, 0] } };
    expect(child.pose({}, hand).bones.parent).toBe(true);
  });

  it("a limb with a parent reads its rest frames among the parent's, and follows a moved parent", () => {
    const child = limb("c", def({ parent: "hand.wrist" }));
    const at = (x) => ({ "hand.wrist": { at: [x, 0, 0] } });
    const a = child.pose({}, at(5)).bones, b = child.pose({ bend: [30, 0] }, at(5)).bones;
    near3(a.joints[0].rest.origin, [5, 0, 0]);
    expect(b.joints.map((j) => j.rest)).toEqual(a.joints.map((j) => j.rest));
    near3(child.pose({}, at(9)).bones.joints[0].rest.origin, [9, 0, 0]);
    near3(child.pose({}, at(5)).bones.joints[0].rest.origin, [5, 0, 0]);
  });

  describe("rest is the limb with nothing asked", () => {
    const leaning = () => limb("w", {
      at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], lengths: [0, 0, 0, 20],
      joints: [{ name: "a", range: [0, 75] }, { name: "lean", axis: "spread", range: [23, 23] }, { name: "tilt", range: [10, 10] }, { name: "m", range: [0, 50] }],
    });
    it("holds a fixed joint at its fixed value, so pose({}) is the rest", () => {
      const { bones } = leaning().pose({});
      near3(bones.tip.posed, bones.tip.rest, 1e-12);
      near3(bones.tip.rest, [7.696, -3.473, 18.13], 1e-3);
      for (const j of bones.joints) expect(j.posed).toEqual(j.rest);
    });
    it("keeps the rest and the fixed joints while another joint bends", () => {
      const L = leaning();
      const rest = L.pose({}).bones;
      const { bones } = L.pose({ bend: { m: 40 } });
      expect(bones.joints.map((j) => j.rest)).toEqual(rest.joints.map((j) => j.rest));
      expect(bones.tip.rest).toEqual(rest.tip.rest);
      for (const n of ["w.lean", "w.tilt"]) {
        const j = bones.joints.find((x) => x.name === n);
        expect(j.posed).toEqual(j.rest);
      }
      expect(Math.hypot(...bones.tip.posed.map((v, i) => v - bones.tip.rest[i]))).toBeGreaterThan(1);
    });
    it("puts a joint whose range excludes 0 at the end nearest 0", () => {
      const L = limb("g", { at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: [{ name: "k", range: [10, 90] }], lengths: [20] });
      const { bones } = L.pose({});
      const t = 10 * Math.PI / 180;
      near3(bones.tip.rest, [0, -20 * Math.sin(t), 20 * Math.cos(t)]);
      expect(bones.joints[0].posed).toEqual(bones.joints[0].rest);
    });
  });
});
