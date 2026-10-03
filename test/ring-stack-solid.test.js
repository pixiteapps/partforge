import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// a triangle ring (vertex 0 first) carried along a path
const tri = (p, u, v, s = 1) => [p, [p[0] + s * u[0], p[1] + s * u[1], p[2] + s * u[2]], [p[0] + s * v[0], p[1] + s * v[1], p[2] + s * v[2]]];

describe("_ringStackSolid", () => {
  it("open stack: a capped triangular prism with the right volume, either winding", () => {
    const rings = [0, 5, 10].map((z) => tri([0, 0, z], [1, 0, 0], [0, 1, 0]));
    for (const rs of [rings, rings.map((r) => [r[0], r[2], r[1]])]) {
      const s = k._ringStackSolid(rs, { closed: false });
      expect(s.genus()).toBe(0);
      expect(s.volume()).toBeCloseTo(0.5 * 10, 6);
    }
  });
  it("closed stack: a triangular torus has genus 1 and positive volume", () => {
    const N = 48, R = 10, rings = [];
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N, c = [R * Math.cos(a), R * Math.sin(a), 0];
      const radial = [Math.cos(a), Math.sin(a), 0];
      rings.push(tri(c, radial, [0, 0, 1]));
    }
    const s = k._ringStackSolid(rings, { closed: true });
    expect(s.genus()).toBe(1);
    expect(s.volume()).toBeGreaterThan(0);
  });
  it("rejects rings of unequal size", () => {
    expect(() => k._ringStackSolid([tri([0, 0, 0], [1, 0, 0], [0, 1, 0]), [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]]))
      .toThrow(/equal size/);
  });
  it("survives a cache hit and cleanup() across two builds", () => {
    const rings = [0, 5].map((z) => tri([0, 0, z], [2, 0, 0], [0, 2, 0]));
    const v1 = k._ringStackSolid(rings).volume();
    k.cleanup?.();
    const v2 = k._ringStackSolid(rings).volume();
    k.cleanup?.();
    expect(v2).toBeCloseTo(v1, 9);
  });
});
