// ikInfo(): the plain-data view of a posed limb the viewer reads for handles and limit arcs.
import { describe, it, expect } from "vitest";
import { limb } from "../src/framework/domains/kinematics/index.js";

const finger = (extra = {}) => limb("index", {
  at: [-30, 96, 2], toward: [0, 1, 0], bendToward: [0, 0, -1],
  joints: [
    { name: "mcp", range: [-10, 90] },
    { name: "pip", range: [0, 110] },
    { name: "dip", range: [0, 80], follow: { joint: "pip", ratio: 0.75 } },
  ],
  lengths: [42, 25, 22], r: [5, 4, 3, 2], ...extra,
});

describe("ikInfo", () => {
  const posed = finger().pose({ curl: 0.5 });
  const info = posed.ikInfo();

  it("is a plain limb record whose tip matches the report", () => {
    expect(info.kind).toBe("partforge.limb");
    expect(info.name).toBe("index");
    expect(info.tip).toBe("index.tip");
    expect(info.points.tip).toEqual(posed.report.tip);
    expect(Object.keys(info.points)).toEqual(["mcp", "pip", "dip", "tip"]);
    expect(info.values).toEqual(posed.report.bend);
    expect(info.r).toEqual([5, 4, 3, 2]);
  });

  it("survives JSON unchanged", () => {
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });

  it("describes joints and hinge axes", () => {
    expect(info.joints.map((j) => [j.name, j.frame, j.type, j.follower])).toEqual([
      ["mcp", "index.mcp", "hinge", false], ["pip", "index.pip", "hinge", false], ["dip", "index.dip", "hinge", true],
    ]);
    expect(info.joints[0].range).toEqual([-10, 90]);
    expect(Object.keys(info.axes)).toEqual(["mcp", "pip", "dip"]);
    // bend about the world x axis (bendToward -z, toward +y): positive value curls toward -z
    const [x, y, z] = info.axes.pip;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 2);
  });

  it("a ball joint has a cone and no axis", () => {
    const b = limb("arm", { toward: [0, 0, 1], bendToward: [1, 0, 0], joints: [{ name: "s", type: "ball", cone: 60 }, "e"], lengths: [10, 10] }).pose({}).ikInfo();
    expect(b.joints[0].cone).toBe(60);
    expect(b.joints[0].range).toBeUndefined();
    expect(b.axes.s).toBeUndefined();
    expect(b.axes.e).toBeDefined();
    expect(b.r).toBeUndefined();
  });

  it("a parented limb needs its frames", () => {
    const child = limb("c", { parent: "p", toward: [0, 1, 0], bendToward: [0, 0, 1], joints: ["a"], lengths: [5] });
    expect(() => child.pose({}).ikInfo()).toThrow(/parent frames/);
    expect(child.pose({}, { p: { at: [1, 2, 3] } }).ikInfo().points.a).toEqual([1, 2, 3]);
  });
});
