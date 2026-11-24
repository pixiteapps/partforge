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
});
