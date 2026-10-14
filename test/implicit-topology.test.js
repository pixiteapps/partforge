// test/implicit-topology.test.js
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { handSpec, nailSpecs, vaseSpec, ADVERSARIAL, SUB_CELL_PLATE, randomSpec } from "./fixtures/implicit-trees.js";
import { edgeCheck } from "./helpers/mesh-topology.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };

describe("topology", () => {
  for (const curl of [0, 50, 100]) {
    test(`hand at curl ${curl}: watertight, genus 0, nails attach`, () => {
      const pose = { curl };
      let hand = k.implicit(handSpec(pose));
      expect(hand.genus()).toBe(0);
      hand = k.union([hand, ...nailSpecs(pose).map((s) => k.implicit(s))]);
      expect(hand.genus()).toBe(0);
      expect(hand.volume()).toBeGreaterThan(0);
    }, 60_000);
  }
  test("vase: all grammar features in one part", async () => {
    const { spec, images } = vaseSpec();
    for (const [name, im] of images) await k._registerImage({ name, ...im });
    const v = k.implicit(spec);
    expect(v.volume()).toBeGreaterThan(0);
  }, 60_000);
  for (const [name, spec] of Object.entries(ADVERSARIAL)) {
    test(`adversarial ${name}: closed and accepted by Manifold (Review Focus 3)`, () => {
      const out = meshImplicit(compileImplicit(spec), spec.preview);
      expect(edgeCheck(out.indices)).toEqual(CLOSED);
      expect(k.implicit(spec).volume()).toBeGreaterThan(0);
    });
  }
  test("subCellPlate: warned; a solid or the empty-shape error, never an open mesh", () => {
    const spec = SUB_CELL_PLATE;
    const out = meshImplicit(compileImplicit(spec), spec.preview);
    expect(out.warnings.some((w) => /thinnest feature/.test(w))).toBe(true);
    if (out.indices.length) expect(edgeCheck(out.indices)).toEqual(CLOSED);
    let solid = null;
    try { solid = k.implicit(spec); } catch (e) { expect(e.message).toMatch(/implicit: the shape is empty/); }
    if (solid) expect(solid.volume()).toBeGreaterThan(0);
  });
  test("volume is stable across grid sizes (within 3%)", () => {
    const spec = handSpec({ curl: 30 });
    const a = k.implicit({ ...spec, preview: 1.5 }).volume(), b = k.implicit({ ...spec, preview: 1.0 }).volume();
    expect(Math.abs(a - b) / b).toBeLessThan(0.03);
  }, 60_000);
  test("seeded fuzz: 40 random trees mesh closed", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const spec = randomSpec(seed);
      let out;
      try { out = meshImplicit(compileImplicit(spec), spec.preview); } catch (e) { if (e.code === "IMPLICIT_SPEC") continue; throw e; }
      if (out.indices.length === 0) continue;
      expect(edgeCheck(out.indices), `seed ${seed}`).toEqual(CLOSED);
    }
  }, 120_000);
});
