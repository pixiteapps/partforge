// test/implicit-topology.test.js
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { handSpec, nailSpecs, vaseSpec, ADVERSARIAL, SUB_CELL_PLATE, randomSpec } from "./fixtures/implicit-trees.js";
import { edgeCheck, componentCount } from "./helpers/mesh-topology.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };
// meshImplicit's tiers: "preview" decimates in cleanup, "print" does not (k above is a
// preview kernel, so every k.implicit here is decimated).
const TIERS = ["preview", "print"];

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
    test(`adversarial ${name}: closed at both tiers and accepted by Manifold (Review Focus 3)`, () => {
      for (const tier of TIERS) expect(edgeCheck(meshImplicit(compileImplicit(spec), spec.preview, { tier }).indices), tier).toEqual(CLOSED);
      expect(k.implicit(spec).volume()).toBeGreaterThan(0);
    });
  }
  test("subCellPlate: warned; a solid or the empty-shape error, never an open mesh", () => {
    const spec = SUB_CELL_PLATE;
    const out = meshImplicit(compileImplicit(spec), spec.preview);
    expect(out.warnings.some((w) => /thinnest feature/.test(w))).toBe(true);
    for (const tier of TIERS) {
      const t = meshImplicit(compileImplicit(spec), spec.preview, { tier });
      if (t.indices.length) expect(edgeCheck(t.indices), tier).toEqual(CLOSED);
    }
    let solid = null;
    try { solid = k.implicit(spec); } catch (e) { expect(e.message).toMatch(/implicit: the shape is empty/); }
    if (solid) expect(solid.volume()).toBeGreaterThan(0);
  });
  test("volume is stable across grid sizes (within 3%)", () => {
    const spec = handSpec({ curl: 30 });
    const a = k.implicit({ ...spec, preview: 1.5 }).volume(), b = k.implicit({ ...spec, preview: 1.0 }).volume();
    expect(Math.abs(a - b) / b).toBeLessThan(0.03);
  }, 60_000);
  for (const tier of TIERS) {
    test(`seeded fuzz, ${tier} tier: 40 random trees mesh closed`, () => {
      let meshed = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const spec = randomSpec(seed);
        let out;
        try { out = meshImplicit(compileImplicit(spec), spec.preview, { tier }); } catch (e) { if (e.code === "IMPLICIT_SPEC") continue; throw e; }
        if (out.indices.length === 0) continue;
        expect(edgeCheck(out.indices), `seed ${seed}`).toEqual(CLOSED);
        meshed++;
      }
      expect(meshed).toBeGreaterThanOrEqual(30);   // 40 of 40 mesh today; a skip-everything fuzz must fail
    }, 120_000);
  }
});

// Exactly-touching faces: a hard union, mirror or repeat whose pieces share a face
// has d = 0 exactly on that face. When the face lies on a grid plane those samples
// must not read as outside (a sheet splitting the solid in two).
const TOUCHING = {
  mirrorHalfBox: { root: { kind: "mirror", plane: "yz", child: { kind: "box", size: [10, 10, 10], at: [5, 0, 0] } } },
  coincidentFaces: ADVERSARIAL.coincidentFaces,
  repeatTouching: { root: { kind: "repeat", linear: { count: 3, step: [4, 0, 0] }, child: { kind: "box", size: [4, 4, 4] } } },
};
// Flush subtracts must stay clean: a tool sharing a face plane with the base adds no sheet.
const FLUSH = {
  flushTouchingTool: { root: { kind: "subtract", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [20, 20, 10], at: [0, 0, 10] }] } },
  flushPocket: { root: { kind: "subtract", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [4, 4, 10], at: [0, 0, 5] }] } },
};

describe("exactly-touching faces", () => {
  for (const [name, spec] of Object.entries({ ...TOUCHING, ...FLUSH })) {
    for (const edge of [0.5, 0.6, 1.0, 1.5]) {
      test(`${name} at ${edge} mm: one closed shell at both tiers`, () => {
        for (const tier of TIERS) {
          const out = meshImplicit(compileImplicit(spec), edge, { tier });
          expect(edgeCheck(out.indices), tier).toEqual(CLOSED);
          expect(componentCount(out.indices), tier).toBe(1);
        }
      });
    }
  }
  for (const [name, spec] of Object.entries(TOUCHING)) {
    test(`${name}: sparse samples equal the dense run's bit for bit`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      for (const edge of [0.5, 1.0]) {
        const sparse = sampleField(c, edge), dense = sampleField(c, edge, { cull: false });
        const byKey = new Map(dense.leaves.map((l) => [`${l.i0},${l.j0},${l.l0}`, l]));
        for (const l of sparse.leaves) expect(Array.from(l.vals)).toEqual(Array.from(byKey.get(`${l.i0},${l.j0},${l.l0}`).vals));
      }
    });
  }
  test("the zero re-evaluation is deterministic", () => {
    const c = lowerSpec(TOUCHING.mirrorHalfBox, { images: new Map() });
    const a = sampleField(c, 0.5), b = sampleField(c, 0.5);
    expect(a.leaves.map((l) => Array.from(l.vals))).toEqual(b.leaves.map((l) => Array.from(l.vals)));
    expect(a.leaves.some((l) => l.vals.some((v) => v < 0 && v > -1e-5))).toBe(true);   // the face samples read inside
  });
});
