// test/implicit-mesher.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { edgeCheck, eulerChar, volume } from "./helpers/mesh-topology.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const lower = (spec) => lowerSpec(spec, { images: new Map() });

describe("mesher", () => {
  test("a sphere: closed, oriented, genus 0, volume within 1.5%", () => {
    const m = meshStore(sampleField(lower({ root: { kind: "sphere", r: 10 } }), 1));
    expect(edgeCheck(m.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
    expect(eulerChar(m.positions, m.indices)).toBe(2);
    const want = (4 / 3) * Math.PI * 1000;
    expect(Math.abs(volume(m.positions, m.indices) - want) / want).toBeLessThan(0.015);
  });
  test("a torus has genus 1", () => {
    const m = meshStore(sampleField(lower({ root: { kind: "torus", R: 8, r: 3 } }), 0.8));
    expect(edgeCheck(m.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
    expect(eulerChar(m.positions, m.indices)).toBe(0);
  });
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: sparse and dense runs give the identical mesh`, () => {
      const c = lower(spec);
      const a = meshStore(sampleField(c, 0.8)), b = meshStore(sampleField(c, 0.8, { cull: false }));
      expect(edgeCheck(a.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
      expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
      expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    });
  }
  for (const name of ["shells", "formula"]) {
    test(`${name} meshes closed at edges 0.4, 0.6, 0.8, 1.0`, () => {
      for (const e of [0.4, 0.6, 0.8, 1.0]) {
        const m = meshStore(sampleField(lower(TREES[name]), e));
        expect(edgeCheck(m.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
      }
    });
  }
  test("Review Focus 2: a clipped shape still closes", () => {
    const c = lower({ root: { kind: "sphere", r: 6 } });
    c.bounds = { min: [-4, -4, -4], max: [4, 4, 4] };
    const s = sampleField(c, 0.5);
    expect(s.clipped).toBe(true);
    expect(edgeCheck(meshStore(s).indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
  });
});
