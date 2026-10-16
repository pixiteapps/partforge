// The native implicit math (native/implicit_math.h) must return the SAME BITS as
// its JS twins — Object.is, so -0 and NaN-ness count. ip_math_probe is test-only.
import { afterEach, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { pfSin, pfCos, pfAtan2 } from "../src/framework/geometry/js-math.js";
import { latticeHash, valueNoise } from "../src/framework/geometry/implicit/noise.js";

afterEach(() => setCoreForTesting(undefined));

function rng(seed) { // mulberry32
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SPECIALS = [0, -0, Infinity, -Infinity, NaN, 1e-300, -1e-300, 2 ** 31 + 5, -(2 ** 40), 2 ** 31, -(2 ** 31),
  2 ** 32, 2 ** 53, -(2 ** 53), 1e20, 0.5, -0.5, 1, -1, 2.5, -2.5, 4294967295.5, Math.PI, -Math.PI / 2];
function inputs(seed) {
  const r = rng(seed), out = [];
  for (let i = 0; i < 16000; i++) out.push((r() * 2 - 1) * 1000);
  for (let i = 0; i < 2000; i++) out.push(Math.round((r() * 2 - 1) * 1e6) / (1 + Math.floor(r() * 8)));
  for (let i = 0; i < 1000; i++) out.push((r() * 2 - 1) * 1e12);
  return out.concat(SPECIALS);
}
const A = inputs(1), B = inputs(2), C = inputs(3);

function check(fn, name, js, arity) {
  const x = core().x;
  let bad = 0, first = null, n = 0;
  const N = A.length;
  for (let k = 0; k < 20000; k++) {
    const i = k < N ? k : (k * 7919) % N;
    const a = A[i], b = B[(i * 31 + k) % N], c = C[(i * 17 + k * 3) % N];
    // every special crossed with each argument position too
    const args = k < SPECIALS.length * 3 ? [SPECIALS[k % SPECIALS.length], B[k], C[k]] : [a, b, c];
    const want = js(...args.slice(0, arity));
    const got = x.ip_math_probe(fn, args[0], args[1], args[2]);
    n++;
    if (!(Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want)))) { bad++; first ??= [args, got, want]; }
  }
  expect(n).toBe(20000);
  expect(bad, `${name}: first mismatch ${JSON.stringify(first)}`).toBe(0);
}

test("core boots with the probe", () => { expect(typeof core().x.ip_math_probe).toBe("function"); });
test("pf_sin is bit-identical to pfSin", () => check(0, "sin", pfSin, 1));
test("pf_cos is bit-identical to pfCos", () => check(1, "cos", pfCos, 1));
test("pf_atan2 is bit-identical to pfAtan2", () => check(2, "atan2", pfAtan2, 2));
test("lattice_hash is bit-identical to latticeHash", () => check(3, "hash", latticeHash, 3));
test("value_noise is bit-identical to valueNoise", () => check(4, "noise", valueNoise, 3));
