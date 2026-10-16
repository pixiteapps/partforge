// test/implicit-program.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { blockDecision, fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch } from "../src/framework/geometry/implicit/program.js";
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
});
