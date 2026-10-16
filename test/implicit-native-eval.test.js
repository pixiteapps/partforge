// The native program interpreter (native/implicit_eval.cpp) must return the SAME
// BYTES as program.js's evalBatch for every program the emitter produces: the
// full decision and pruned block decisions of every small tree, the vase, the
// adversarial specs, a formula reaching every expr function and a texture, and
// the NaN/∞ union case.
import { afterEach, describe, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { NativeSession, CORE_FAULT } from "../src/framework/core/implicit-core.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { blockDecision, fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch } from "../src/framework/geometry/implicit/program.js";
import { TREES } from "./fixtures/implicit-small-trees.js";
import { vaseSpec, ADVERSARIAL } from "./fixtures/implicit-trees.js";

afterEach(() => setCoreForTesting(undefined));

let seed = 11;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

// A 17×13 image of arbitrary 16-bit values: non-square, odd sides, every texel distinct-ish.
function noiseImage(w, h) {
  const data = new Uint16Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = (Math.imul(i + 1, 2654435761) >>> 16) & 0xffff;
  return { digest: `noise-${w}x${h}`, width: w, height: h, data };
}

// Every UN/BIN/TER function and texture(), in one formula.
const ALL_FNS = `
float a = abs(p.x) + floor(p.y) * fract(p.z) - sqrt(abs(p.x * p.y));
float b = sin(p.x) / cos(p.y) + min(p.x, p.y) - max(p.z, 0.5) + mod(p.x, 3.0) + step(0.2, p.y);
float d = clamp(a, -2.0, 2.0) + mix(a, b, 0.3) + smoothstep(-1.0, 1.0, p.z) + smin(a, b, 0.5) - smax(a, b, 0.7);
return ((p.x < p.y && p.y > 0.0) || !(p.z <= 1.0) || (p.x >= 2.0 && p.x == p.y) || p.z != 0.25 ? d : -d) + texture(t, p.xy * 0.1 + 0.5) - 5.0;`;

const CASES = {
  ...Object.fromEntries(Object.entries(TREES).map(([k, spec]) => [k, { spec }])),
  vase: vaseSpec(),
  ...Object.fromEntries(Object.entries(ADVERSARIAL).map(([k, spec]) => [`adversarial ${k}`, { spec }])),
  allFunctions: {
    spec: { root: { kind: "union", k: 1, children: [
      { kind: "expr", box: [[-8, -8, -8], [8, 8, 8]], lipschitz: 50, sdf: ALL_FNS, textures: { t: { image: "noise" } } },
      { kind: "displace", amount: 0.7, by: { expr: "return texture(t, p.yz * 0.07 + 0.5) * 2.0 - 1.0;", textures: { t: { image: "noise" } } },
        child: { kind: "sphere", r: 5, at: [3, 0, 0] } },
    ] } },
    images: new Map([["noise", noiseImage(17, 13)]]),
  },
  nanInfUnion: {
    spec: { root: { kind: "union", children: [
      { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return sqrt(-1.0) + 1.0 / 0.0;" },
      { kind: "sphere", r: 2 },
    ] } },
  },
};

function points(N, scale) {
  const X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N);
  for (let i = 0; i < N; i++) { X[i] = rnd() * scale; Y[i] = rnd() * scale; Z[i] = rnd() * scale; }
  return [X, Y, Z];
}

describe("native program interpreter", () => {
  for (const [name, { spec, images = new Map() }] of Object.entries(CASES)) {
    test(`${name}: full and pruned programs evaluate to the same bytes as evalBatch`, () => {
      const c = lowerSpec(spec, { images });
      const b = c.bounds, ext = Math.max(...b.max.map((v) => Math.abs(v)), ...b.min.map((v) => Math.abs(v))) + 2;
      expect(Number.isFinite(ext)).toBe(true);
      const progs = [emitProgram(c, fullDecision(c))];
      for (let k = 0; k < 40; k++) {
        const r = 1 + Math.abs(rnd()) * ext * 0.2;
        progs.push(emitProgram(c, blockDecision(c, rnd() * ext, rnd() * ext, rnd() * ext, r).dec));
      }
      const s = new NativeSession(core());
      try {
        for (const t of c.textures) s.addTexture(t);
        for (const prog of progs) {
          const idx = s.addProgram(prog);
          const [X, Y, Z] = points(2000, ext);
          const js = new Float64Array(2000);
          evalBatch(prog, c.textures, X, Y, Z, js);
          const nat = s.eval(idx, X, Y, Z);
          expect(Buffer.compare(bytes(nat), bytes(js))).toBe(0);
        }
      } finally {
        s.destroy();
      }
    });
  }

  test("the NaN/∞ union reads as outside without poisoning the union", () => {
    const c = lowerSpec(CASES.nanInfUnion.spec, { images: new Map() });
    const s = new NativeSession(core());
    try {
      const idx = s.addProgram(emitProgram(c, fullDecision(c)));
      expect(s.eval(idx, Float64Array.of(0), Float64Array.of(0), Float64Array.of(0))[0]).toBe(-2);
    } finally { s.destroy(); }
  });

  test("special inputs (±0, ±∞, NaN, huge) evaluate to the same bytes", () => {
    const SPECIAL = [0, -0, Infinity, -Infinity, NaN, 1e300, -1e300, 1e-300, 0.5, -3, 0.2, 0.25, 2]; // 0.2, 0.25, 2: the formula's step and comparison edges
    const N = SPECIAL.length ** 3, X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N);
    let i = 0;
    for (const a of SPECIAL) for (const b of SPECIAL) for (const d of SPECIAL) { X[i] = a; Y[i] = b; Z[i] = d; i++; }
    for (const name of ["allFunctions", "warps", "carved", "repeats", "bendCut", "formula"]) {
      const { spec, images = new Map() } = CASES[name];
      const c = lowerSpec(spec, { images });
      const prog = emitProgram(c, fullDecision(c));
      const s = new NativeSession(core());
      try {
        for (const t of c.textures) s.addTexture(t);
        const js = new Float64Array(N);
        evalBatch(prog, c.textures, X, Y, Z, js);
        const nat = s.eval(s.addProgram(prog), X, Y, Z);
        for (let k = 0; k < N; k++) if (!Object.is(nat[k], js[k])) throw new Error(`${name} at (${X[k]}, ${Y[k]}, ${Z[k]}): native ${nat[k]} vs JS ${js[k]}`);
      } finally { s.destroy(); }
    }
  });

  test("several sessions live at once keep their own textures and programs", () => {
    const a = lowerSpec(CASES.allFunctions.spec, { images: CASES.allFunctions.images });
    const imagesB = new Map([["noise", noiseImage(5, 9)]]);
    const b = lowerSpec(CASES.allFunctions.spec, { images: imagesB });
    const sa = new NativeSession(core()), sb = new NativeSession(core());
    try {
      for (const t of a.textures) sa.addTexture(t);
      for (const t of b.textures) sb.addTexture(t);
      const pa = sa.addProgram(emitProgram(a, fullDecision(a))), pb = sb.addProgram(emitProgram(b, fullDecision(b)));
      const [X, Y, Z] = points(700, 8);
      const ja = new Float64Array(700), jb = new Float64Array(700);
      evalBatch(emitProgram(a, fullDecision(a)), a.textures, X, Y, Z, ja);
      evalBatch(emitProgram(b, fullDecision(b)), b.textures, X, Y, Z, jb);
      expect(Buffer.compare(bytes(sb.eval(pb, X, Y, Z)), bytes(jb))).toBe(0);
      expect(Buffer.compare(bytes(sa.eval(pa, X, Y, Z)), bytes(ja))).toBe(0);
    } finally { sa.destroy(); sb.destroy(); }
  });

  test("a malformed program or a missing texture slot is refused, not run", () => {
    const s = new NativeSession(core());
    try {
      expect(() => s.eval(s.addProgram(Float64Array.of(1, 1, 99, 0)), Float64Array.of(0), Float64Array.of(0), Float64Array.of(0))).toThrow(/refused/);
      expect(() => s.eval(s.addProgram(Float64Array.of(1, 1, 3, 9, 0, 0, 1, 1, 0, 0)), Float64Array.of(0), Float64Array.of(0), Float64Array.of(0))).toThrow(/refused/);
      expect(() => s.eval(s.addProgram(Float64Array.of(1, 2, 21, 0, 0.5, 21, 1, 0.5)), Float64Array.of(0), Float64Array.of(0), Float64Array.of(0))).toThrow(/refused/); // no END
      const c = lowerSpec(CASES.allFunctions.spec, { images: CASES.allFunctions.images });
      const idx = s.addProgram(emitProgram(c, fullDecision(c)));   // no texture added
      expect(() => s.eval(idx, Float64Array.of(0), Float64Array.of(0), Float64Array.of(0))).toThrow(/refused/);
      expect(core()).not.toBeNull();   // refusing a program is not a fault
    } finally { s.destroy(); }
  });

  test("a fault poisons the instance and throws CORE_FAULT", () => {
    const c = core();
    const s = new NativeSession(c);
    s.addProgram(Float64Array.of(1, 1, 3, 1, 0, 0, 1, 1, 0, 0));
    const real = c.x;
    c.x = { ...real, ip_eval: () => { throw new WebAssembly.RuntimeError("unreachable"); } };
    try {
      expect(() => s.eval(0, Float64Array.of(0), Float64Array.of(0), Float64Array.of(0))).toThrow(CORE_FAULT);
      expect(c.poisoned).toBe(true);
      expect(core()).toBeNull();
      expect(() => s.addProgram(Float64Array.of(1, 1, 0, 0))).toThrow(CORE_FAULT);
    } finally {
      c.x = real;
      s.destroy();
    }
  });
});
