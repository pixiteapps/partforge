import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { detectSharpEdges, chainEdges, generalStations } from "../src/framework/geometry/mesh-fillet.js";
import { FIXTURES } from "./fixtures/fillet-general-fixtures.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const chainsOf = (solid) => chainEdges(detectSharpEdges(solid.toIndexedMesh()));

describe("general chains", () => {
  it("every acceptance fixture classifies with no unsupported chain and at least one general chain", () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const chains = chainsOf(make(k));
      expect(chains.filter((c) => c.kind === "unsupported").map((c) => c.reason), name).toEqual([]);
      expect(chains.some((c) => c.kind === "general"), name).toBe(true);
    }
  });
  it("cross hole rims are closed general chains, convex; the tee junction is concave", () => {
    const hole = chainsOf(FIXTURES.crossHole(k)).filter((c) => c.kind === "general");
    expect(hole.length).toBeGreaterThanOrEqual(2);
    for (const c of hole) { expect(c.closed).toBe(true); expect(c.convex).toBe(true); }
    const tee = chainsOf(FIXTURES.tee(k)).filter((c) => c.kind === "general");
    expect(tee.every((c) => c.convex === false)).toBe(true);
  });
  it("stations carry unit tangents and unit flank normals perpendicular to them", () => {
    for (const c of chainsOf(FIXTURES.tee(k)).filter((ch) => ch.kind === "general")) {
      const st = generalStations(c);
      expect(st.length).toBeGreaterThanOrEqual(c.points.length);
      for (const s of st) {
        for (const v of [s.t, s.n1, s.n2]) expect(Math.hypot(...v)).toBeCloseTo(1, 9);
        expect(Math.abs(s.t[0] * s.n1[0] + s.t[1] * s.n1[1] + s.t[2] * s.n1[2])).toBeLessThan(1e-9);
        expect(Math.abs(s.t[0] * s.n2[0] + s.t[1] * s.n2[1] + s.t[2] * s.n2[2])).toBeLessThan(1e-9);
        expect(s.tilt).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it("never claims an edge an existing tool already handles (classification freeze)", () => {
    const blob = Array.from({ length: 72 }, (_, i) => {
      const th = (2 * Math.PI * i) / 72, rr = 20 + 4 * Math.sin(3 * th) + 2 * Math.cos(5 * th);
      return [rr * Math.cos(th), rr * Math.sin(th)];
    });
    const supported = {
      box: k.box({ size: [40, 30, 20] }),
      cylinder: k.cylinder({ r: 10, h: 20 }),
      blobExtrude: k.extrude({ profile: blob, h: 10 }),
      ribOnCylinder: k.cylinder({ r: 15, h: 30 }).union(k.box({ min: [10, -2, 0], max: [25, 2, 20] })),
      dShaft: k.cylinder({ r: 5, h: 20 }).cut(k.box({ min: [3.5, -10, -1], max: [10, 10, 30] })),
      draftedBox: k.loft({ rings: [{ polygon: [[-20, -15], [20, -15], [20, 15], [-20, 15]], z: 0 },
        { polygon: [[-17, -12], [17, -12], [17, 12], [-17, 12]], z: 20 }], ruled: true }),
      filletAfterFillet: k.box({ size: [40, 30, 20] }).fillet({ r: 5, edges: { dir: "Z" } }),
      bossOnPlate: k.box({ size: [60, 60, 5] }).union(k.cylinder({ r: 6, h: 20 })),
    };
    for (const [name, solid] of Object.entries(supported)) {
      const chains = chainsOf(solid);
      expect(chains.some((c) => c.kind === "general"), name).toBe(false);
      expect(chains.some((c) => c.kind === "unsupported"), name).toBe(false);
    }
  });
});
