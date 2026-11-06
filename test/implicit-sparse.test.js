// test/implicit-sparse.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField, planLeaves, evaluateLeaves, LEAF } from "../src/framework/geometry/implicit/sparse.js";
import { TREES } from "./fixtures/implicit-small-trees.js";
import { handSpec, HAND_POSES } from "./fixtures/implicit-trees.js";

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
  test("the hand in a fist (contact: pads, bulges, attachments): culled leaves hold exactly the dense run's values", () => {
    // Clipped to the fingertips' pads and the finger bases, where every pruning rule binds.
    const c = lower(handSpec(HAND_POSES.fist));
    c.bounds = { min: [-40, 60, -25], max: [40, 100, 8] };
    for (const edge of [1.5, 0.8]) {
      const sparse = sampleField(c, edge), dense = sampleField(c, edge, { cull: false });
      expect(sparse.leaves.length).toBeLessThan(dense.leaves.length);
      const byKey = new Map(dense.leaves.map((l) => [`${l.i0},${l.j0},${l.l0}`, l]));
      for (const l of sparse.leaves) expect(Array.from(l.vals)).toEqual(Array.from(byKey.get(`${l.i0},${l.j0},${l.l0}`).vals));
    }
  }, 120_000);
  for (const gap of [0, 0.2]) {
    test(`exact capsule press (gap ${gap}): culled leaves hold exactly the dense run's values`, () => {
      const cap = (b) => ({ kind: "capsule", a: [0, 0, 2], b, r: 3 });
      const c = lowerSpec({ root: { kind: "contact", gap, children: [cap([0, 0, 30]), cap([14, 0, 26])] } }, { images: new Map() });
      expect(c.ownerRoot).toBeGreaterThanOrEqual(0);
      for (const edge of [1, 0.6]) {
        const sparse = sampleField(c, edge), dense = sampleField(c, edge, { cull: false });
        expect(sparse.leaves.length).toBeLessThan(dense.leaves.length);
        const byKey = new Map(dense.leaves.map((l) => [`${l.i0},${l.j0},${l.l0}`, l]));
        for (const l of sparse.leaves) expect(Array.from(l.vals)).toEqual(Array.from(byKey.get(`${l.i0},${l.j0},${l.l0}`).vals));
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
  test("an under-bounded large shape is clipped closed identically with and without culling", () => {
    const c = lower({ root: { kind: "box", size: [40, 40, 40] } });
    c.bounds = { min: [-10, -10, -10], max: [10, 10, 10] };
    const sparse = sampleField(c, 0.5), dense = sampleField(c, 0.5, { cull: false });
    expect(sparse.clipped).toBe(true);
    const byKey = new Map(dense.leaves.map((l) => [`${l.i0},${l.j0},${l.l0}`, l]));
    for (const l of sparse.leaves) expect(Array.from(l.vals)).toEqual(Array.from(byKey.get(`${l.i0},${l.j0},${l.l0}`).vals));
    for (const l of sparse.leaves) for (let q = 0, k = 0; k < S; k++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++, q++) {
      const gi = l.i0 + i, gj = l.j0 + j, gk = l.l0 + k;
      if (gi === 0 || gj === 0 || gk === 0 || gi >= sparse.n[0] - 1 || gj >= sparse.n[1] - 1 || gk >= sparse.n[2] - 1) expect(l.vals[q]).toBeGreaterThanOrEqual(0.25);
    }
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
  test("planLeaves + evaluateLeaves is sampleField; the plan is plain data and stays untouched", () => {
    const c = lower(TREES[Object.keys(TREES)[0]]);
    const plan = planLeaves(c, 0.8);
    expect(plan.clipped).toBe(false);
    expect(plan.programs.every((p) => p instanceof Float64Array)).toBe(true);
    for (const l of plan.leaves) expect(Object.keys(l)).toEqual(["i0", "j0", "l0", "progIndex"]);
    // Programs are indexed in order of first emission.
    let next = 0;
    for (const l of plan.leaves) { if (l.progIndex === next) next++; else expect(l.progIndex).toBeLessThan(next); }
    expect(next).toBe(plan.programs.length);
    const a = evaluateLeaves(plan), b = sampleField(c, 0.8);
    expect(Object.keys(plan.leaves[0])).toEqual(["i0", "j0", "l0", "progIndex"]);
    expect(a.samples).toBe(b.samples);
    expect(a.clipped).toBe(b.clipped);
    expect(a.leaves.length).toBe(b.leaves.length);
    a.leaves.forEach((l, k) => {
      expect(l.prog).toBe(a.programs[l.progIndex]);
      expect(Array.from(l.vals)).toEqual(Array.from(b.leaves[k].vals));
    });
  });
  test("a sample whose double is below float32 range counts as exactly zero and is decided off the grid", () => {
    // At the grid point (0, 0, 0) the formula is 1e-46: not 0 as a double, 0 once stored as float32.
    const c = lower({ root: { kind: "expr", box: [[-5, -5, -5], [5, 5, 5]], sdf: "return max(p.x + 1e-46, length(p) - 4.0);" } });
    const s = sampleField(c, 1);
    expect(s.origin).toEqual([-7, -7, -7]);
    let seen = 0;
    for (const l of s.leaves) for (let q = 0, k = 0; k < S; k++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++, q++) {
      if (l.i0 + i !== 7 || l.j0 + j !== 7 || l.l0 + k !== 7) continue;
      seen++;
      expect(l.vals[q]).toBe(Math.fround(1e-6));   // re-evaluated at the nudge point, x = 1e-6·edge
    }
    expect(seen).toBeGreaterThan(0);
  });
});
