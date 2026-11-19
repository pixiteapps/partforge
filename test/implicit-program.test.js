// test/implicit-program.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { blockDecision, fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch, runProgram, FN_CODES, UN_NAMES, BIN_NAMES, TER_NAMES, BATCH } from "../src/framework/geometry/implicit/program.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

let seed = 5;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;

describe("bytecode", () => {
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: the full program equals the reference exactly`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      const prog = emitProgram(c, fullDecision(c));
      const N = 1000, X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), out = new Float64Array(N);
      for (let i = 0; i < N; i++) { X[i] = rnd() * 15; Y[i] = rnd() * 15; Z[i] = rnd() * 15; }
      evalBatch(prog, c.textures, X, Y, Z, out);
      for (let i = 0; i < N; i++) expect(out[i]).toBe(evalReference(c, X[i], Y[i], Z[i]));
    });
    test(`${name}: a pruned program equals the reference exactly inside its ball`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      for (let b = 0; b < 40; b++) {
        const cx = rnd() * 12, cy = rnd() * 12, cz = rnd() * 12, r = 1 + Math.abs(rnd()) * 2;
        const prog = emitProgram(c, blockDecision(c, cx, cy, cz, r).dec);
        const N = 64, X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), out = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          const dx = rnd(), dy = rnd(), dz = rnd(), l = Math.hypot(dx, dy, dz) || 1, t = (Math.abs(rnd()) * r) / l;
          X[i] = cx + dx * t; Y[i] = cy + dy * t; Z[i] = cz + dz * t;
        }
        evalBatch(prog, c.textures, X, Y, Z, out);
        for (let i = 0; i < N; i++) expect(out[i]).toBe(evalReference(c, X[i], Y[i], Z[i]));
      }
    });
  }
  test("Review Focus 1: NaN/∞ formulas read as outside without poisoning a union", () => {
    const c = lowerSpec({ root: { kind: "union", children: [
      { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return sqrt(-1.0) + 1.0 / 0.0;" },
      { kind: "sphere", r: 2 },
    ] } }, { images: new Map() });
    const prog = emitProgram(c, fullDecision(c));
    const out = new Float64Array(1);
    evalBatch(prog, c.textures, Float64Array.of(0), Float64Array.of(0), Float64Array.of(0), out);
    expect(out[0]).toBe(-2);
  });
  test("fn codes are pinned (the native tables index these arrays)", () => {
    expect(UN_NAMES).toEqual(["neg", "abs", "floor", "fract", "sqrt", "sin", "cos", "not"]);
    expect(BIN_NAMES).toEqual(["add", "sub", "mul", "div", "min", "max", "mod", "step", "lt", "gt", "le", "ge", "eq", "ne", "and", "or"]);
    expect(TER_NAMES).toEqual(["clamp", "mix", "smoothstep", "smin", "smax", "select"]);
    expect(FN_CODES).toEqual({ UN: UN_NAMES, BIN: BIN_NAMES, TER: TER_NAMES });
  });
  test("an unknown expr function fails at emission, not as a bad fn code", () => {
    const c = lowerSpec({ root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return abs(p.x) - 0.5;" } }, { images: new Map() });
    c.ir.nodes[c.ir.root].expr.ops.find((o) => o.op === "un").fn = "tanh";
    expect(() => emitProgram(c, fullDecision(c))).toThrow("implicit: unknown expr function tanh");
  });
  test("runProgram refuses more lanes than a batch holds", () => {
    const c = lowerSpec({ root: { kind: "sphere", r: 1 } }, { images: new Map() });
    const prog = emitProgram(c, fullDecision(c)), N = BATCH + 1;
    const X = new Float64Array(N), out = new Float64Array(N);
    expect(() => runProgram(prog, c.textures, X, X, X, N, out)).toThrow(/at most 256 lanes/);
  });
  test("a union wider than the shared gather buffer evaluates exactly", () => {
    const children = Array.from({ length: 70 }, (_, i) => ({ kind: "sphere", r: 0.5, at: [i * 0.3 - 10, 0, 0] }));
    const c = lowerSpec({ root: { kind: "union", k: 0.2, children } }, { images: new Map() });
    const prog = emitProgram(c, fullDecision(c));
    const N = 300, X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), out = new Float64Array(N);
    for (let i = 0; i < N; i++) { X[i] = rnd() * 12; Y[i] = rnd(); Z[i] = rnd(); }
    evalBatch(prog, c.textures, X, Y, Z, out);
    for (let i = 0; i < N; i++) expect(out[i]).toBe(evalReference(c, X[i], Y[i], Z[i]));
  });
});
