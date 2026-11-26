// test/implicit-program.test.js
import { beforeAll, describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { blockDecision, fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch, runProgram, programOps, OP, FN_CODES, UN_NAMES, BIN_NAMES, TER_NAMES, BATCH } from "../src/framework/geometry/implicit/program.js";
import { compileImplicit } from "../src/framework/geometry/implicit/compile.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
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
  test("the opcode table is pinned, with MESH = 26", () => {
    expect(OP).toEqual({ END: 0, XFORM: 1, XDIR: 2, PRIM: 3, UNION: 4, INTER: 5, NEG: 6, MIN2: 7, MIRRORP: 8, ADDC: 9, ONION: 10, WARP: 11, DISP: 12, SANITIZE: 13, CONTACT: 14, BULGE: 15, GET: 20, CONST: 21, UN: 22, BIN: 23, TER: 24, TEX: 25, MESH: 26 });
  });
});

describe("the solid leaf", () => {
  let k;
  beforeAll(async () => { k = await bootManifoldKernel({ quality: "print" }); });
  const spec = (solid) => ({ root: { kind: "union", k: 3, children: [{ kind: "solid", solid, at: [1, 0, 0] }, { kind: "sphere", r: 4, at: [-5, 1, 0] }] } });

  test("the batch interpreter and the reference evaluator agree on a solid leaf, to the bit", () => {
    const c = compileImplicit(spec(k.box({ min: [-6, -4, -3], max: [6, 4, 3] })));
    const prog = emitProgram(c, fullDecision(c));
    expect(Array.from(prog)).toContain(OP.MESH);
    const N = 500, X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), out = new Float64Array(N);
    let s = 17;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let i = 0; i < N; i++) { X[i] = r() * 14; Y[i] = r() * 10; Z[i] = r() * 8; }
    X[0] = 7; Y[0] = 0; Z[0] = 0;   // on the box's +x face (moved by at)
    evalBatch(prog, c.textures, X, Y, Z, out);
    let inside = 0, outside = 0;
    for (let i = 0; i < N; i++) {
      const ref = evalReference(c, X[i], Y[i], Z[i]);
      expect(Object.is(out[i], ref), `point ${i}: ${out[i]} vs ${ref}`).toBe(true);
      if (ref < 0) inside++; else outside++;
    }
    expect(inside).toBeGreaterThan(20); expect(outside).toBeGreaterThan(20);
  });
  test("a pruned program over a solid leaf equals the reference inside its ball", () => {
    const c = compileImplicit(spec(k.sphere(5)));
    let s = 99;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let b = 0; b < 30; b++) {
      const cx = r() * 10, cy = r() * 8, cz = r() * 8, rad = 0.5 + Math.abs(r()) * 2;
      const prog = emitProgram(c, blockDecision(c, cx, cy, cz, rad).dec);
      const N = 32, X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), out = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const dx = r(), dy = r(), dz = r(), l = Math.hypot(dx, dy, dz) || 1, t = (Math.abs(r()) * rad) / l;
        X[i] = cx + dx * t; Y[i] = cy + dy * t; Z[i] = cz + dz * t;
      }
      evalBatch(prog, c.textures, X, Y, Z, out);
      for (let i = 0; i < N; i++) expect(Object.is(out[i], evalReference(c, X[i], Y[i], Z[i]))).toBe(true);
    }
  });
  test("programOps weighs a MESH op by its BVH depth", () => {
    const s = k.sphere(5), c = compileImplicit({ root: { kind: "solid", solid: s } });
    const prog = emitProgram(c, fullDecision(c));
    const tris = c.meshes[0].tris;
    expect(tris).toBeGreaterThan(1);
    // MESH (1 + ceil(log2 tris)), then END (1).
    expect(programOps(prog, c.meshes)).toBe(1 + Math.ceil(Math.log2(tris)) + 1);
  });
});
