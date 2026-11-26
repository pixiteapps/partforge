// test/implicit-sharpen-native.test.js
// The sharpen stage's native port (native/implicit_sharpen.cpp) against its JS, in both core
// builds, for what the parity cases (test/core-parity.test.js) do not reach: the constants the
// C++ mirrors as literals (ip_sharpen_constants), and the field-flip memo's `how` test
// (ip_flip_probe) on the fixture of implicit-sharpen.test.js's "the flip memo".
import { afterAll, describe, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { NativeSession } from "../src/framework/core/implicit-core.js";
import { compileImplicit } from "../src/framework/geometry/implicit/compile.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import * as sharpen from "../src/framework/geometry/implicit/sharpen.js";
import { ACROSS_TOL, TRIES } from "../src/framework/geometry/implicit/sharpen-corners.js";
import { fieldFlips } from "../src/framework/geometry/implicit/sharpen-mesh.js";

afterAll(() => { delete globalThis.PARTFORGE_CORE_SIMD; setCoreForTesting(undefined); });

const JS_CONSTANTS = [sharpen.SHARP_ANGLE_COS, sharpen.SHARP_TOL, sharpen.SHARP_MAX_MOVE, sharpen.SHARP_SNAP, sharpen.SHARP_CORNER_DET,
  sharpen.SHARP_DENSE_DIV, sharpen.SHARP_DENSE_MIN, sharpen.NEWTON_STEPS, sharpen.STEP_CAP, sharpen.SIDE, sharpen.DIFF,
  sharpen.MIN_ALTITUDE, sharpen.FLIP_NEAR, sharpen.CONVERGED, sharpen.CORNER_MERGE, sharpen.SIDE_PTS, sharpen.FLAT_READS,
  ACROSS_TOL, TRIES, sharpen.SHARP_APART];

// The flip memo's fixture: a triangle on the top face of a 40 × 30 × 6 box (z = 3), first with
// one candidate moving end 0, then with that candidate splitting edge (1, 2) at a point that
// folds a part over, then the same again.
const P1 = [0, 0, 3, 1, 0, 3, 0, 1, 3], P2 = [0, 0, 3, 1, 0, 3, 0, 1, 3, -1, -1, 3];

function boxStore() {
  const compiled = compileImplicit({ root: { kind: "box", size: [40, 30, 6] } });
  const plan = planLeaves(compiled, 1.0, { anchor: false }), store = evaluateLeaves(plan, {});
  // The leaf nearest the face's centre (0, 0, 3): its first cell's corner closest to it.
  let leaf = 0, best = Infinity;
  plan.leaves.forEach((L, i) => {
    const c = [L.i0, L.j0, L.l0].map((x, a) => plan.origin[a] + (x + 2) * plan.edge);
    const d = (c[0] - 0) ** 2 + (c[1] - 0) ** 2 + (c[2] - 3) ** 2;
    if (d < best) { best = d; leaf = i; }
  });
  return { plan, store, leaf };
}

function flipsJs(store, leaf) {
  const VL0 = new Int32Array(4).fill(leaf), T = [0, 1, 2], ekey = (a, b) => (a < b ? 4 * a + b : 4 * b + a);
  const c = {}, memo = new Map(), opts = { VL0, T, ekey, edge: 1.0 };
  const moved = { P: P1, splitOf: new Map(), touched: new Map([[0, [c]]]), how: new Map([[0, [0]]]) };
  const split = { P: P2, splitOf: new Map([[ekey(1, 2), 3]]), touched: new Map([[0, [c]]]), how: new Map([[0, [-1]]]) };
  return [fieldFlips(store, moved, [0], opts, memo).length, fieldFlips(store, split, [0], opts, memo).length,
    fieldFlips(store, split, [0], opts, memo).length];
}

describe("the sharpen stage's native port", () => {
  for (const simd of [true, false]) {
    test(`constants agree with the JS (${simd ? "SIMD" : "scalar"} build)`, () => {
      if (simd) delete globalThis.PARTFORGE_CORE_SIMD; else globalThis.PARTFORGE_CORE_SIMD = false;
      setCoreForTesting(undefined);
      const c = core();
      expect(c.simd).toBe(simd);
      const out = c.alloc(8 * 64), n = c.x.ip_sharpen_constants(out);
      const native = Array.from(c.copyOut(Float64Array, out, n));
      c.x.free(out);
      expect(native).toEqual(JS_CONSTANTS);
    });

    test(`the flip memo reads a triangle again when a candidate's change goes from a move to a split (${simd ? "SIMD" : "scalar"} build)`, () => {
      if (simd) delete globalThis.PARTFORGE_CORE_SIMD; else globalThis.PARTFORGE_CORE_SIMD = false;
      setCoreForTesting(undefined);
      const c = core();
      const { plan, store, leaf } = boxStore();
      const js = flipsJs(store, leaf);
      expect(js).toEqual([0, 1, 1]);   // the JS unit test's answer: [], [0], [0]
      const s = new NativeSession(c);
      try {
        plan.textures.forEach((t) => s.addTexture(t));
        plan.programs.forEach((p) => s.addProgram(p));
        s.sample(plan, { readBack: false });
        const p1 = c.copyIn(Float64Array.from(P1)), p2 = c.copyIn(Float64Array.from(P2)), out = c.alloc(12);
        const rc = c.x.ip_flip_probe(s.id, leaf, p1, p2, 1.0, out);
        const native = Array.from(c.copyOut(Int32Array, out, 3));
        for (const p of [p1, p2, out]) c.x.free(p);
        expect(rc).toBe(0);
        expect(native).toEqual(js);
      } finally { s.destroy(); }
    });
  }
});
