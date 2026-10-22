// test/implicit-bracket.test.js — bracket.js's solveBrackets, the owner path's edge solver: within
// bisection's accuracy (2^-24) on the crossings that stall a plain secant (kinks, jumps, flat
// zeros), within MAX_BRACKET_STEPS steps, with bisection's reading of NaN / infinite / same-sign
// ends; lanes independent of their batch; and the native solve_brackets bit-identical
// (ip_bracket_probe, test-only), in both core builds.
import { afterAll, describe, expect, test } from "vitest";
import { solveBrackets, BRACKET_TOL, MAX_BRACKET_STEPS } from "../src/framework/geometry/implicit/bracket.js";
import { core, setCoreForTesting } from "../src/framework/core/core.js";

afterAll(() => { delete globalThis.PARTFORGE_CORE_SIMD; setCoreForTesting(undefined); });

const BISECTION = 2 ** -24;
const NO_NAN = 2;
// The probe's test family, lane params [r, p, a, b, ja, jb, nanAbove]: NaN past nanAbove, else
// -(a·(r − t)^p + ja) below r and b·(t − r)^p + jb from r on (the power a product from 1).
function g(P, t) {
  if (t > P[6]) return NaN;
  const d = t < P[0] ? P[0] - t : t - P[0];
  let y = 1;
  for (let i = 0; i < P[1]; i++) y *= d;
  return t < P[0] ? -(P[2] * y + P[4]) : P[3] * y + P[5];
}
const lane = (r, p, a = 1, b = 1, ja = 0, jb = 0, nanAbove = NO_NAN) => [r, p, a, b, ja, jb, nanAbove];

/** The JS solve over lanes; counts as the probe counts them (every evalAt call, ends included). */
function solveJs(lanes, { maxSteps = MAX_BRACKET_STEPS, ends = null, log = null } = {}) {
  let points = 0, calls = 0;
  const t = solveBrackets(lanes.length, maxSteps, (ix, ts, c, out) => {
    calls++; points += c;
    for (let k = 0; k < c; k++) { out[k] = g(lanes[ix[k]], ts[k]); log?.push([ix[k], ts[k]]); }
  }, ends?.[0] ?? null, ends?.[1] ?? null);
  return { t: Array.from(t), points, calls };
}

function solveNative(lanes, { maxSteps = MAX_BRACKET_STEPS, ends = null } = {}) {
  const c = core(), n = lanes.length;
  const params = c.copyIn(Float64Array.from(lanes.flat()));
  const f0 = ends ? c.copyIn(Float64Array.from(ends[0])) : 0, f1 = ends ? c.copyIn(Float64Array.from(ends[1])) : 0;
  const tOut = c.alloc(8 * Math.max(1, n)), counts = c.alloc(8);
  const rc = c.x.ip_bracket_probe(params, n, maxSteps, f0, f1, tOut, counts);
  const t = Array.from(c.copyOut(Float64Array, tOut, n)), [points, calls] = c.copyOut(Int32Array, counts, 2);
  for (const p of [params, f0, f1, tOut, counts]) if (p) c.x.free(p);
  expect(rc).toBe(0);
  return { t, points, calls };
}

// [name, lane, true sign change]
const HARD = [
  ["linear", lane(0.3, 1), 0.3],
  ["linear near 0", lane(1e-6, 1), 1e-6],
  ["linear near 1", lane(1 - 1e-6, 1), 1 - 1e-6],
  ["(t − 0.3)^2, signed", lane(0.3, 2), 0.3],
  ["(t − 0.3)^3", lane(0.3, 3), 0.3],
  ["(t − 0.3)^5", lane(0.3, 5), 0.3],
  ["(t − 0.3)^9", lane(0.3, 9), 0.3],
  ["(t − 0.7)^9", lane(0.7, 9), 0.7],
  ["jump −1e-3 / +1", lane(0.3, 0, 1e-3, 1), 0.3],
  ["jump −1e-2 / +1", lane(0.3, 0, 1e-2, 1), 0.3],
  ["jump −1 / +1e-3", lane(0.6, 0, 1, 1e-3), 0.6],
  ["kink, slope ratio 0.01", lane(0.3, 1, 0.01, 1), 0.3],
  ["kink, slope ratio 0.001", lane(0.123456789, 1, 0.001, 1), 0.123456789],
  ["kink, slope ratio 1000", lane(0.8, 1, 1, 0.001), 0.8],
  ["flat then steep: (t − r)^3 + jump", lane(0.45, 3, 1, 1, 0, 1e-9), 0.45],
];

describe("solveBrackets (JS)", () => {
  for (const [name, P, root] of HARD) {
    test(`${name}: within bisection's error and the step bound`, () => {
      const { t: [t], calls } = solveJs([P]);
      expect(Math.abs(t - root)).toBeLessThanOrEqual(BISECTION);
      expect(calls - 1).toBeLessThanOrEqual(MAX_BRACKET_STEPS);   // less the ends' call
    });
  }

  test("a smooth crossing converges in a few steps", () => {
    const { calls } = solveJs([lane(0.37, 1, 2, 2)]);
    expect(calls - 1).toBeLessThanOrEqual(3);
  });

  test("NaN reads as the high side", () => {
    // Negative below 0.7, NaN past 0.5: the sign change as bisection reads it is at 0.5.
    const { t: [t] } = solveJs([lane(0.7, 1, 1, 1, 0, 0, 0.5)]);
    expect(Math.abs(t - 0.5)).toBeLessThanOrEqual(BISECTION);
  });

  test("±Infinity ends fall back to halving and still converge", () => {
    for (const ends of [[[-Infinity], [Infinity]], [[-Infinity], [1]], [[-1], [Infinity]]]) {
      const { t: [t], calls } = solveJs([lane(0.3, 1)], { ends });
      expect(Math.abs(t - 0.3)).toBeLessThanOrEqual(BISECTION);
      expect(calls).toBeLessThanOrEqual(MAX_BRACKET_STEPS);
    }
  });

  test("an exact zero ends the lane on it", () => {
    const { t: [t], calls } = solveJs([lane(0.5, 1)]);
    expect(t).toBe(0.5);
    expect(calls).toBe(2);   // the ends, then the secant lands on 0.5 exactly
  });

  test("same-sign ends converge to an end, as bisection does", () => {
    const pos = solveJs([lane(-1, 1)]), neg = solveJs([lane(2, 1)]);
    expect(pos.t[0]).toBeLessThanOrEqual(BISECTION);
    expect(1 - neg.t[0]).toBeLessThanOrEqual(BISECTION);
    expect(pos.calls - 1).toBe(24);
    expect(neg.calls - 1).toBe(24);
  });

  test("ends passed in answer exactly as ends evaluated, one call fewer", () => {
    for (const [, P] of HARD) {
      const evaluated = solveJs([P]), passed = solveJs([P], { ends: [[g(P, 0)], [g(P, 1)]] });
      expect(Object.is(passed.t[0], evaluated.t[0])).toBe(true);
      expect(passed.calls).toBe(evaluated.calls - 1);
    }
  });

  test("lanes are independent of their batch", () => {
    const lanes = HARD.map(([, P]) => P).concat([lane(0.5, 1), lane(-1, 1), lane(0.7, 1, 1, 1, 0, 0, 0.5)]);
    const batch = solveJs(lanes).t;
    lanes.forEach((P, k) => expect(Object.is(batch[k], solveJs([P]).t[0])).toBe(true));
  });

  test("a step cap answers an evaluated end, never a wide bracket's midpoint", () => {
    for (const [, P, root] of HARD) {
      const log = [], { t: [t] } = solveJs([P], { maxSteps: 4, log });
      const seen = log.map(([, x]) => x);
      expect(seen.includes(t) || Math.abs(t - root) <= BRACKET_TOL).toBe(true);
    }
  });
});

describe("native solve_brackets (ip_bracket_probe) is bit-identical", () => {
  const all = HARD.map(([, P]) => P).concat([lane(0.5, 1), lane(-1, 1), lane(2, 1), lane(0.7, 1, 1, 1, 0, 0, 0.5), lane(0.37, 1, 2, 2)]);
  for (const simd of [true, false]) {
    test(`${simd ? "SIMD" : "scalar"} build`, () => {
      if (simd) delete globalThis.PARTFORGE_CORE_SIMD; else globalThis.PARTFORGE_CORE_SIMD = false;
      setCoreForTesting(undefined);
      expect(core(), "the native core is available").toBeTruthy();
      const same = (a, b) => {
        expect(b.points).toBe(a.points);
        expect(b.calls).toBe(a.calls);
        a.t.forEach((x, k) => expect(Object.is(b.t[k], x), `lane ${k}: ${b.t[k]} vs ${x}`).toBe(true));
      };
      same(solveJs(all), solveNative(all));   // one batch, ends evaluated
      for (const P of all) same(solveJs([P]), solveNative([P]));   // solo
      const ends = [all.map((P) => g(P, 0)), all.map((P) => g(P, 1))];
      same(solveJs(all, { ends }), solveNative(all, { ends }));
      const inf = [[-Infinity, -Infinity, -1], [Infinity, 1, Infinity]], three = [lane(0.3, 1), lane(0.3, 1), lane(0.3, 1)];
      same(solveJs(three, { ends: inf }), solveNative(three, { ends: inf }));
      same(solveJs(all, { maxSteps: 4 }), solveNative(all, { maxSteps: 4 }));   // the cap's answer
    });
  }
});
