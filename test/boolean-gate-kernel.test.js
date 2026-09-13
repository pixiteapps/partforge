// The boolean result gate WIRED into the Manifold backend. boolean-gate.test.js
// pins the rules with plain numbers; this file proves the backend actually
// consults them — with the real operand and result volumes, from inside the
// cached closure (a cache hit is never re-judged), on every author-facing
// boolean including the hoisted n-ary union — and that a refusal propagates out
// of the op. Mesh CSG is exact, so no real Manifold boolean can trip the gate;
// the refusal path is exercised by making the (spied) gate answer once.
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

const gate = vi.hoisted(() => ({ calls: [], answerNext: null }));
vi.mock("../src/framework/geometry/boolean-gate.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkBooleanResult: (...args) => {
      gate.calls.push(args);
      if (gate.answerNext) { const e = gate.answerNext; gate.answerNext = null; return e; }
      return actual.checkBooleanResult(...args);
    },
  };
});

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
beforeEach(() => { gate.calls.length = 0; gate.answerNext = null; });

const ops = () => gate.calls.map(([op]) => op);
const last = () => gate.calls[gate.calls.length - 1];

// Fresh geometry per test — a hash-identical solid would be a cache hit and skip
// the gate (which is the point of one test below, and noise in every other).
let n = 0;
const box = (s) => k.box({ size: [s, s, s + (++n) * 1e-3] });

test("union: judged with the operands' volumes and the result's, and passes", () => {
  const a = box(10), b = box(10).translate([5, 0, 0]);
  const u = a.union(b);
  expect(ops()).toEqual(["union"]);
  const [, operands, result] = last();
  expect(operands[0]).toBeCloseTo(a.volume(), 6);
  expect(operands[1]).toBeCloseTo(b.volume(), 6);
  expect(result).toBeCloseTo(u.volume(), 6);
  expect(u.volume()).toBeGreaterThan(a.volume());
});

test("cut, cutAll and intersect are judged too", () => {
  const body = box(10);
  body.cut(box(4).translate([3, 3, 3]));
  body.cutAll([box(3).translate([1, 1, 1]), box(3).translate([6, 6, 6])]);
  body.intersect(box(10).translate([5, 5, 5]));
  expect(ops()).toEqual(["cut", "cutAll", "intersect"]);
  expect(gate.calls[1][1]).toHaveLength(3); // body + two tools
});

test("the n-ary kernel union is judged once, on the hoisted path as well", () => {
  // every operand ends in the same translate, so hoistBoolean lifts it out and
  // evaluates (and judges) the union in the canonical frame
  const shift = [20, 5, 0];
  k.union([box(6).translate([0, 0, 0]).translate(shift), box(6).translate([3, 0, 0]).translate(shift), box(6).translate([6, 0, 0]).translate(shift)]).volume();
  expect(ops()).toEqual(["union"]);
  expect(last()[1]).toHaveLength(3);
});

test("a cache hit is not re-judged", () => {
  // the solid cache only stores inside a sub-part (solid-cache.js), which is
  // where every real build runs
  k.beginSubPart("gate-cache");
  try {
    const a = box(10), b = box(10).translate([5, 0, 0]);
    a.union(b).volume();
    a.union(b).volume();
    expect(gate.calls).toHaveLength(1);
  } finally { k.endSubPart(); }
});

test("the dropped-operand signature: the box test settles an enclosed operand, and the overlap probe is a real intersect", () => {
  const outer = box(10), inner = box(4).translate([3, 3, 3]);
  const u = outer.union(inner);
  expect(u.volume()).toBeCloseTo(outer.volume(), 6); // the equality signature, legitimately
  const [, , , probes] = last();
  expect(probes.encloses(0, 1)).toBe(true);
  expect(probes.encloses(1, 0)).toBe(false);
  expect(probes.overlap(0, 1)).toBeCloseTo(inner.volume(), 6);
});

test("a cut that empties its body passes when the tool encloses it", () => {
  const body = box(4).translate([3, 3, 3]);
  const r = body.cut(box(10));
  expect(r.volume()).toBe(0);
  expect(ops()).toEqual(["cut"]);
});

test("a refusal propagates out of the op with its code", () => {
  const err = new Error("boolean result invalid: union dropped an operand — (stub)");
  err.code = "BOOLEAN_RESULT_INVALID";
  gate.answerNext = err;
  expect(() => box(10).union(box(10).translate([5, 0, 0]))).toThrow(/dropped an operand/);
});
