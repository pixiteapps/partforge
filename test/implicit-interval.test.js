// test/implicit-interval.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { blockDecision, fullDecision, decisionKey } from "../src/framework/geometry/implicit/interval.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

let seed = 11;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;

describe("interval pass", () => {
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: every sampled value lies inside its block's interval`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      const { min, max } = c.bounds;
      for (let b = 0; b < 300; b++) {
        const cx = min[0] + (max[0] - min[0]) * (rnd() * 0.5 + 0.5), cy = min[1] + (max[1] - min[1]) * (rnd() * 0.5 + 0.5), cz = min[2] + (max[2] - min[2]) * (rnd() * 0.5 + 0.5);
        const r = 0.5 + Math.abs(rnd()) * 3;
        const { lo, hi } = blockDecision(c, cx, cy, cz, r);
        for (let s = 0; s < 20; s++) {
          let dx = rnd(), dy = rnd(), dz = rnd();
          const l = Math.hypot(dx, dy, dz) || 1, t = Math.abs(rnd()) * r / l;
          const v = evalReference(c, cx + dx * t, cy + dy * t, cz + dz * t);
          expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
          expect(v).toBeLessThanOrEqual(hi + 1e-9);
        }
      }
    });
  }
  test("far children are pruned; keys are stable and distinguish decisions", () => {
    const c = lowerSpec({ root: { kind: "union", k: 1, children: [{ kind: "sphere", r: 1 }, { kind: "sphere", r: 1, at: [50, 0, 0] }] } }, { images: new Map() });
    const near = blockDecision(c, 0, 0, 0, 1);
    expect(near.dec.kids[0]).not.toBeNull();
    expect(near.dec.kids[1]).toBeNull();
    expect(decisionKey(near.dec)).toBe(decisionKey(blockDecision(c, 0.1, 0, 0, 1).dec));
    expect(decisionKey(near.dec)).not.toBe(decisionKey(fullDecision(c)));
  });

  test("bend branch cut: blocks near it stay sound", () => {
    const c = lowerSpec(TREES.bendCut, { images: new Map() });
    const { lo, hi } = blockDecision(c, 15, 0, 0.4, 1);
    const v = evalReference(c, 15, 0, -0.5);
    expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(v).toBeLessThanOrEqual(hi + 1e-9);
  });
  test("intersect and subtract prune far operands, keep relevant ones", () => {
    const sub = lowerSpec({ root: { kind: "subtract", k: 1, children: [{ kind: "sphere", r: 3 }, { kind: "sphere", r: 1, at: [50, 0, 0] }, { kind: "sphere", r: 1, at: [3, 0, 0] }] } }, { images: new Map() });
    const d = blockDecision(sub, 0, 0, 0, 0.5).dec;
    expect(d.kids[1]).toBeNull();
    expect(blockDecision(sub, 3, 0, 0, 0.5).dec.kids[2]).not.toBeNull();
    const isec = lowerSpec({ root: { kind: "intersect", k: 1, children: [{ kind: "sphere", r: 3 }, { kind: "sphere", r: 1000, at: [0, 0, 0] }, { kind: "sphere", r: 3.2 }] } }, { images: new Map() });
    expect(blockDecision(isec, 0, 0, 0, 0.5).dec.kids[1]).toBeNull();
    expect(blockDecision(isec, 3, 0, 0, 0.5).dec.kids[2]).not.toBeNull();
    expect(blockDecision(isec, 3, 0, 0, 0.5).dec.kids[1]).toBeNull();
  });
  test("pruned union slot exceeds the kept minimum by more than k", () => {
    const k = 1;
    const c = lowerSpec({ root: { kind: "union", k, children: [{ kind: "sphere", r: 1 }, { kind: "sphere", r: 1, at: [50, 0, 0] }] } }, { images: new Map() });
    const one = lowerSpec({ root: { kind: "sphere", r: 1 } }, { images: new Map() });
    const two = lowerSpec({ root: { kind: "sphere", r: 1, at: [50, 0, 0] } }, { images: new Map() });
    expect(blockDecision(c, 0, 0, 0, 1).dec.kids[1]).toBeNull();
    for (let s = 0; s < 50; s++) {
      const x = rnd(), y = rnd(), z = rnd(), l = Math.hypot(x, y, z) || 1;
      const px = x / l, py = y / l, pz = z / l;
      expect(evalReference(two, px, py, pz)).toBeGreaterThan(evalReference(one, px, py, pz) + k);
    }
  });
});
