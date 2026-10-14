// test/implicit-sparse.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField, LEAF } from "../src/framework/geometry/implicit/sparse.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const lower = (spec) => lowerSpec(spec, { images: new Map() });
const S = LEAF + 1;

describe("sparse sampler", () => {
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: culled leaves hold exactly the dense run's values; skipped leaves have no sign change`, () => {
      const c = lower(spec);
      const sparse = sampleField(c, 0.8), dense = sampleField(c, 0.8, { cull: false });
      const byKey = new Map(dense.leaves.map((l) => [`${l.i0},${l.j0},${l.l0}`, l]));
      for (const l of sparse.leaves) expect(Array.from(l.vals)).toEqual(Array.from(byKey.get(`${l.i0},${l.j0},${l.l0}`).vals));
      const kept = new Set(sparse.leaves.map((l) => `${l.i0},${l.j0},${l.l0}`));
      for (const l of dense.leaves) {
        if (kept.has(`${l.i0},${l.j0},${l.l0}`)) continue;
        let neg = 0, zero = 0;
        for (const v of l.vals) { if (v < 0) neg++; if (v === 0) zero++; }
        expect(zero).toBe(0);
        expect(neg === 0 || neg === S * S * S).toBe(true);
      }
    });
  }
  test("culling skips space away from the surface", () => {
    const c = lower({ root: { kind: "sphere", r: 20 } });
    const sparse = sampleField(c, 0.5), dense = sampleField(c, 0.5, { cull: false });
    // Measured 0.30 (349000 / 1157625): only a shell about one leaf ball (~2 mm) thick
    // around the sphere is sampled, versus the whole padded box. Bound = measured + 0.05.
    expect(sparse.samples).toBeLessThan(dense.samples * 0.35);
  });
  test("a shape reaching the grid edge is clipped closed and flagged", () => {
    const c = lower({ root: { kind: "displace", amount: 3, by: { expr: "return 1.0;" }, child: { kind: "sphere", r: 4 } } });
    c.bounds = { min: [-4, -4, -4], max: [4, 4, 4] };   // pretend the box was declared too small
    const s = sampleField(c, 0.5);
    expect(s.clipped).toBe(true);
  });
  test("Review Focus 4: an absurd grid fails fast with IMPLICIT_SIZE", () => {
    const c = lower({ root: { kind: "sphere", r: 1000 } });
    const t0 = Date.now();
    let err;
    try { sampleField(c, 0.05); } catch (e) { err = e; }
    expect(err?.code).toBe("IMPLICIT_SIZE");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
