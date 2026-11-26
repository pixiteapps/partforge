// The native program interpreter (native/implicit_eval.cpp) must return the SAME
// BYTES as program.js's evalBatch for every program the emitter produces: the
// full decision and pruned block decisions of every small tree, the vase, the
// adversarial specs, a formula reaching every expr function and a texture, and
// the NaN/∞ union case.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { NativeSession, CORE_FAULT, CORE_REFUSED } from "../src/framework/core/implicit-core.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { blockDecision, fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch, evalBatchContact, runProgram } from "../src/framework/geometry/implicit/program.js";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { TREES } from "./fixtures/implicit-small-trees.js";
import { vaseSpec, handSpec, HAND_POSES, ADVERSARIAL } from "./fixtures/implicit-trees.js";
import { threePress } from "./fixtures/implicit-seam-cases.js";

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

  // Hand-built programs at the inputs where a near-miss port would differ.
  const runBoth = (prog, X, Y, Z) => {
    const js = new Float64Array(X.length);
    evalBatch(prog, [], Float64Array.from(X), Float64Array.from(Y), Float64Array.from(Z), js);
    const s = new NativeSession(core());
    try { return { js, nat: s.eval(s.addProgram(prog), Float64Array.from(X), Float64Array.from(Y), Float64Array.from(Z)) }; }
    finally { s.destroy(); }
  };

  test("bend reads atan2 through pfAtan2 at its signed-zero and infinite edges", () => {
    // P1 = WARP bend (R = 10) of P0; V0 = P1.z (= R · pfAtan2(z, R − x)).
    const prog = Float64Array.of(2, 1, 11, 2, 1, 0, 1, 10, 20, 0, 1, 2, 0, 0);
    const X = [], Y = [], Z = [];
    for (const x of [20, -Infinity, Infinity]) for (const z of [-0, 0, -Infinity, Infinity, 1]) { X.push(x); Y.push(0); Z.push(z); }
    const { js, nat } = runBoth(prog, X, Y, Z);
    for (let i = 0; i < X.length; i++) {
      if (!Object.is(nat[i], js[i])) throw new Error(`bend at x=${X[i]}, z=${Object.is(Z[i], -0) ? "-0" : Z[i]}: native ${nat[i]} vs JS ${js[i]}`);
    }
  });

  test("UNION and INTER with k = 0 keep the first of tied operands (+0 vs -0)", () => {
    for (const op of [4, 5]) {
      for (const [a, b] of [[0, -0], [-0, 0]]) {
        // V0 = a, V1 = b, V2 = UNION/INTER(k = 0; V0, V1)
        const prog = Float64Array.of(1, 3, 21, 0, a, 21, 1, b, op, 2, 0, 2, 0, 1, 0, 2);
        const { js, nat } = runBoth(prog, [0], [0], [0]);
        const out = new Float64Array(1);
        runProgram(prog, [], Float64Array.of(0), Float64Array.of(0), Float64Array.of(0), 1, out);
        expect(Object.is(js[0], a)).toBe(true);
        expect(Object.is(out[0], a)).toBe(true);
        expect(Object.is(nat[0], a)).toBe(true);
      }
    }
  });

  // Lanes for the hand-built contact programs: a random cloud, the regions' centres and
  // the special values.
  const contactLanes = () => {
    const X = [], Y = [], Z = [];
    for (let i = 0; i < 600; i++) { X.push(rnd() * 4); Y.push(rnd() * 4); Z.push(rnd() * 4); }
    for (const c of [[0, 0, 0], [1, 0, 0], [1, 1, 1], [0.5, 0, 0], [2, 0, 0]]) { X.push(c[0]); Y.push(c[1]); Z.push(c[2]); }
    const SPECIAL = [0, -0, Infinity, -Infinity, NaN, 1e300, 0.3];
    for (const a of SPECIAL) for (const b of SPECIAL) for (const d of SPECIAL) { X.push(a); Y.push(b); Z.push(d); }
    return [X, Y, Z];
  };
  const sameBits = (label, X, Y, Z, { js, nat }) => {
    for (let i = 0; i < X.length; i++) {
      if (!Object.is(nat[i], js[i])) throw new Error(`${label} at (${X[i]}, ${Y[i]}, ${Z[i]}): native ${nat[i]} vs JS ${js[i]}`);
    }
  };

  test("CONTACT: attachments (first per pair wins, either order), at a gap and at gap 0's overlap", () => {
    // V0..V2 = x, y, z − 0.25; V3 = CONTACT(cl; V0, V1, V2) with three attachments (the second
    // repeats the first's pair reversed: never read), then the child map and tie ranks; END V3.
    for (const cl of [0.3, -0.02]) {
      const prog = Float64Array.of(1, 5, 20, 0, 0, 0, 20, 1, 0, 1, 20, 4, 0, 2, 9, 2, 4, -0.25,
        14, 3, 0, cl, 3, 3, 0, 1, 2,
        1, 0, 0, 0, 0, 1, 2, 1.5,
        0, 1, 1, 1, 1, 0.5, 1, 3,
        2, 1, 0.5, 0, 0, 2, 1, 0.7,
        0, 1, 2, 2, 3, 1,
        0, 3);
      const [X, Y, Z] = contactLanes();
      sameBits(`contact cl ${cl}`, X, Y, Z, runBoth(prog, X, Y, Z));
    }
  });

  test("BULGE: regions summed in order, at the centre, the rim and a zero radius", () => {
    // V0 = x; V1 = V0 − bulgeOffset over three regions (the last with rho = 0); END V1.
    const prog = Float64Array.of(1, 2, 20, 0, 0, 0, 15, 1, 0, 0, 3,
      0, 0, 0, 0.6, 2, 1, 0, 0, -0.3, 0.5, 2, 0, 0, 1, 0, 0, 1);
    const [X, Y, Z] = contactLanes();
    X.push(2, 1.5, 0); Y.push(0, 0, 2); Z.push(0, 0, 0);   // on the rims (t = 1)
    sameBits("bulge", X, Y, Z, runBoth(prog, X, Y, Z));
  });

  test("a malformed CONTACT or BULGE is refused, not run", () => {
    const s = new NativeSession(core());
    const at = Float64Array.of(0);
    // V0 = x, V1 = y; V2 = CONTACT(cl 0.3; V0, V1; one attachment), child map and tie ranks.
    const contact = (kids, att, nK = kids.length, tail = [...kids.map((_, i) => i), ...kids.map(() => 1)]) =>
      Float64Array.of(1, 3, 20, 0, 0, 0, 20, 1, 0, 1, 14, 2, 0, 0.3, nK, att.length / 8, ...kids, ...att, ...tail, 0, 2);
    const att = [0, 1, 0, 0, 0, 1, 1, 1];
    try {
      expect([...s.eval(s.addProgram(contact([0, 1], att)), at, at, at)]).toHaveLength(1);   // well-formed: runs
      for (const bad of [
        contact([0, 1], [0, 2, 0, 0, 0, 1, 1, 1]),   // attachment slot past nK
        contact([0, 1], [0.5, 1, 0, 0, 0, 1, 1, 1]), // non-integer slot
        contact([0, 7], att),                        // kid register past nV
        contact([], [], 0),                          // no operands
        contact([0, 1], att).subarray(0, 24),        // truncated in the attachment list
        Float64Array.of(1, 2, 14, 1, 0, 0.3, 2, 1e8, 0, 0, 0, 1),   // attachment count past the end
        Float64Array.of(1, 2, 20, 0, 0, 0, 15, 1, 5, 0, 1, 0, 0, 0, 1, 1, 0, 1),   // BULGE source past nV
        Float64Array.of(1, 2, 20, 0, 0, 0, 15, 1, 0, 3, 1, 0, 0, 0, 1, 1, 0, 1),   // BULGE point register past nP
        Float64Array.of(1, 2, 20, 0, 0, 0, 15, 1, 0, 0, 2, 0, 0, 0, 1, 1, 0, 1),   // BULGE region list runs off the end
      ]) {
        expect(() => s.eval(s.addProgram(bad), at, at, at)).toThrow(/refused/);
      }
      expect(core()).not.toBeNull();   // refusing a program is not a fault
    } finally { s.destroy(); }
  });

  test("a refused texture is not a fault: the instance stays usable", () => {
    const c = core();
    const s = new NativeSession(c);
    try {
      expect(() => s.addTexture({ width: 0, height: 0, data: new Float32Array(0) })).toThrow(/refused/);
      expect(() => s.addTexture({ width: 2, height: 2, data: new Float32Array(3) })).toThrow(/texels/);
      expect(() => s.eval(0.5, [0], [0], [0])).toThrow(/program index/);
    } finally { s.destroy(); }
    expect(c.poisoned).toBe(false);
    expect(core()).toBe(c);
    const other = new NativeSession(core());
    try {
      const idx = other.addProgram(Float64Array.of(1, 1, 3, 1, 0, 0, 1, 2, 0, 0));   // sphere r = 2
      expect([...other.eval(idx, [3], [0], [0])]).toEqual([1]);
      expect(other.eval(idx, [], [], []).length).toBe(0);
    } finally { other.destroy(); }
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

// The contact op (the spec's root): evalContact must
// capture what program.js's evalBatchContact captures, field for field — the value, the
// merged owner, the piece (Task 5's order-free tie rank), every child's cut and share — in
// both builds of the core (afterEach re-boots; PARTFORGE_CORE_SIMD is read at each boot).
describe.each([["SIMD", true], ["scalar", false]])("native contact capture (%s build)", (_, simd) => {
  beforeAll(() => { if (!simd) globalThis.PARTFORGE_CORE_SIMD = false; setCoreForTesting(undefined); });
  afterAll(() => { delete globalThis.PARTFORGE_CORE_SIMD; setCoreForTesting(undefined); });

  const exact = (spec) => compileImplicit(spec);
  const EXACT = {
    hand: () => exact(handSpec()),
    "hand nearMiss": () => exact(handSpec(HAND_POSES.nearMiss)),
    "threePress gap 0": () => exact(threePress({ gap: 0 })),
    "threePress gap 0.2": () => exact(threePress({ gap: 0.2 })),
  };
  const inBounds = (c, N) => {
    const X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      X[i] = c.bounds.min[0] + (rnd() * 0.5 + 0.5) * (c.bounds.max[0] - c.bounds.min[0]);
      Y[i] = c.bounds.min[1] + (rnd() * 0.5 + 0.5) * (c.bounds.max[1] - c.bounds.min[1]);
      Z[i] = c.bounds.min[2] + (rnd() * 0.5 + 0.5) * (c.bounds.max[2] - c.bounds.min[2]);
    }
    return [X, Y, Z];
  };
  const fullCap = (K, N) => ({ K, owner: new Int32Array(N), piece: new Int32Array(N), cuts: new Float64Array(N * K), shares: new Float64Array(N * K) });
  const sameCap = (label, a, b) => {
    for (const k of ["owner", "piece", "cuts", "shares"]) {
      if (!a[k]) { expect(b[k], `${label} ${k}`).toBeUndefined(); continue; }
      if (Buffer.compare(bytes(a[k]), bytes(b[k])) !== 0) {
        const q = a[k].findIndex((v, i) => !Object.is(v, b[k][i]));
        throw new Error(`${label}: ${k}[${q}] native ${b[k][q]} vs JS ${a[k][q]}`);
      }
    }
  };

  test("this build is the one booted", () => {
    expect(core().simd).toBe(simd);
  });

  for (const [name, make] of Object.entries(EXACT)) {
    test(`${name}: evalContact equals evalBatchContact bit for bit (out, owner, piece, cuts, shares)`, () => {
      const c = make(), K = c.ownerK;
      expect(c.ownerRoot).toBeGreaterThanOrEqual(0);
      const b = c.bounds, ext = Math.max(...b.max.map(Math.abs), ...b.min.map(Math.abs));
      const progs = [emitProgram(c, fullDecision(c), 1.5)];
      for (let k = 0; k < 12; k++) {   // pruned leaves: a pruned child reads +Infinity
        const [cx, cy, cz] = inBounds(c, 1);
        progs.push(emitProgram(c, blockDecision(c, cx[0], cy[0], cz[0], 1 + Math.abs(rnd()) * ext * 0.1).dec));
      }
      const s = new NativeSession(core());
      let pruned = 0, inside = 0;
      try {
        for (const t of c.textures) s.addTexture(t);
        for (const prog of progs) {
          const idx = s.addProgram(prog);
          const N = 2000, [X, Y, Z] = inBounds(c, N);
          const js = new Float64Array(N), jcap = fullCap(K, N);
          evalBatchContact(prog, c.textures, X, Y, Z, js, jcap);
          const ncap = fullCap(K, N);
          const nat = s.evalContact(idx, X, Y, Z, ncap);
          expect(Buffer.compare(bytes(nat), bytes(js))).toBe(0);
          sameCap(name, jcap, ncap);
          pruned += jcap.cuts.filter((v) => v === Infinity).length;
          inside += js.filter((v) => v < 0).length;
          // The plain eval of the same program is the same field.
          expect(Buffer.compare(bytes(s.eval(idx, X, Y, Z)), bytes(js))).toBe(0);
        }
      } finally { s.destroy(); }
      expect(pruned).toBeGreaterThan(0);   // the pruned programs reach a +Infinity cut
      expect(inside).toBeGreaterThan(0);   // and the points reach inside the pieces
    });
  }

  test("only the arrays present are written; a longer array is filled past N as evalBatchContact fills it", () => {
    const c = EXACT["threePress gap 0"](), K = c.ownerK, prog = emitProgram(c, fullDecision(c), 1.5);
    const [X, Y, Z] = inBounds(c, 300);
    const s = new NativeSession(core());
    try {
      const idx = s.addProgram(prog);
      for (const keys of [["piece"], ["owner"], ["cuts", "shares"], ["owner", "piece", "cuts", "shares"]]) {
        const mk = () => Object.fromEntries([["K", K], ...keys.map((k) => [k, k === "cuts" || k === "shares" ? new Float64Array(310 * K).fill(7) : new Int8Array(310).fill(7)])]);
        const jcap = mk(), ncap = mk(), js = new Float64Array(300);
        evalBatchContact(prog, c.textures, X, Y, Z, js, jcap);
        const nat = s.evalContact(idx, X, Y, Z, ncap);
        expect(Buffer.compare(bytes(nat), bytes(js))).toBe(0);
        sameCap(keys.join("+"), jcap, ncap);
      }
    } finally { s.destroy(); }
  });

  test("a malformed CONTACT child map, or a child index past K, is refused, not run", () => {
    const s = new NativeSession(core());
    const at = Float64Array.of(0);
    // V0 = x, V1 = y; V2 = CONTACT(cl −0.02; V0, V1; no attachments), child map, ranks.
    const exactOp = (tail) => Float64Array.of(1, 3, 20, 0, 0, 0, 20, 1, 0, 1, 14, 2, 0, -0.02, 2, 0, 0, 1, ...tail, 0, 2);
    try {
      expect([...s.eval(s.addProgram(exactOp([0, 1, 0, 0])), at, at, at)]).toHaveLength(1);   // well-formed: runs
      const cap = { K: 2, piece: new Int32Array(1) };
      s.evalContact(s.addProgram(exactOp([1, 0, 0, 0])), at, at, at, cap);
      expect(cap.piece[0]).toBe(0);   // x = y = 0: a tie, to the lesser child (child 0, slot 1)
      for (const bad of [
        exactOp([0, 127, 0, 0]),   // child index past MAX_OWNER_K
        exactOp([0, -1, 0, 0]),    // negative child index
        exactOp([0, 0.5, 0, 0]),   // non-integer child index
        exactOp([0, 1, 0]).subarray(0, 21),   // the tail runs off the end
      ]) {
        expect(() => s.eval(s.addProgram(bad), at, at, at)).toThrow(/refused/);
      }
      const wide = s.addProgram(exactOp([0, 5, 0, 0]));
      expect(() => s.evalContact(wide, at, at, at, { K: 2, piece: new Int32Array(1) })).toThrow(/refused/);   // child 5 ≥ K
      expect(() => s.evalContact(wide, at, at, at, { K: 0, piece: new Int32Array(1) })).toThrow(/K/);
      expect(core()).not.toBeNull();   // refusing a program is not a fault
    } finally { s.destroy(); }
  });
});

// The MESH op (a `solid` leaf): native/implicit_eval.cpp's mesh_distance against
// mesh-field.js's meshDistance, in both builds. The parity hinges on the native BVH
// reporting the same triangle, point and distance as the JS one, ties included (a point
// whose nearest point is on an edge or a corner several triangles share), so the points
// include every mesh vertex, every edge midpoint and points pushed off them.
describe.each([["SIMD", true], ["scalar", false]])("native MESH op (%s build)", (_, simd) => {
  let k;
  beforeAll(async () => {
    if (!simd) globalThis.PARTFORGE_CORE_SIMD = false;
    setCoreForTesting(undefined);
    k = await bootManifoldKernel({ quality: "print" });
  });
  afterAll(() => { delete globalThis.PARTFORGE_CORE_SIMD; setCoreForTesting(undefined); });

  const solid = (s, extra = {}) => ({ kind: "solid", solid: s, ...extra });
  const blend = () => compileImplicit({ root: { kind: "union", k: 3, children: [
    solid(k.box({ min: [-10, -5, -2], max: [10, 5, 2] })),
    solid(k.cylinder({ r: 6, h: 20 }), { at: [8, 0, 0] }),
  ] } });
  // The 2,000 lattice points: x −12..12 by 1, y −6.25..5 by 1.25, z −3..4 by 1. They hit the
  // box's faces (x = ±10, y = ±5, z = ±2), its edges and its corners exactly.
  const lattice = () => {
    const X = [], Y = [], Z = [];
    for (let i = 0; i < 25; i++) for (let j = 0; j < 10; j++) for (let l = 0; l < 8; l++) { X.push(i - 12); Y.push(-6.25 + 1.25 * j); Z.push(l - 3); }
    return [X, Y, Z].map((a) => Float64Array.from(a));
  };
  // Every vertex and edge midpoint of the field's mesh, each pushed out and in along the
  // face normal of a triangle that holds it, diagonally off it, and to three random
  // points within 0.6 of it (so every region of every triangle is reached).
  const onMesh = (f) => {
    const V = f.bvh.vertices, X = [], Y = [], Z = [];
    const push = (x, y, z) => { X.push(x); Y.push(y); Z.push(z); };
    for (let t = 0; t < f.tris; t++) {
      const o = t * 9, n = f.normals.subarray(t * 21, t * 21 + 3);
      for (let c = 0; c < 3; c++) {
        const a = o + 3 * c, b = o + 3 * ((c + 1) % 3);
        const pts = [[V[a], V[a + 1], V[a + 2]], [(V[a] + V[b]) / 2, (V[a + 1] + V[b + 1]) / 2, (V[a + 2] + V[b + 2]) / 2]];
        for (const [x, y, z] of pts) {
          push(x, y, z);
          for (const s of [0.25, -0.25]) push(x + s * n[0], y + s * n[1], z + s * n[2]);
          push(x + 0.5, y + 0.5, z + 0.5);
          push(x - 0.5, y - 0.5, z - 0.5);
          for (let q = 0; q < 3; q++) push(x + rnd() * 0.6, y + rnd() * 0.6, z + rnd() * 0.6);
        }
      }
    }
    return [X, Y, Z].map((a) => Float64Array.from(a));
  };
  const same = (label, nat, js, X, Y, Z) => {
    expect(nat.length).toBe(js.length);
    for (let i = 0; i < js.length; i++) {
      if (!Object.is(nat[i], js[i])) throw new Error(`${label} at (${X[i]}, ${Y[i]}, ${Z[i]}): native ${nat[i]} vs JS ${js[i]}`);
    }
  };
  const evalBoth = (c, prog, X, Y, Z) => {
    const s = new NativeSession(core());
    try {
      for (const t of c.textures) s.addTexture(t);
      c.meshes.forEach((f, i) => expect(s.addMesh(f)).toBe(i));
      const js = new Float64Array(X.length);
      evalBatch(prog, c.textures, X, Y, Z, js);
      return { js, nat: s.eval(s.addProgram(prog), X, Y, Z) };
    } finally { s.destroy(); }
  };

  test("this build is the one booted", () => {
    expect(core().simd).toBe(simd);
  });

  test("MESH: the core and the JS interpreter agree to the bit on 2,000 points", () => {
    const c = blend();
    expect(c.meshes.length).toBe(2);
    const [X, Y, Z] = lattice();
    expect(X.length).toBe(2000);
    const prog = emitProgram(c, fullDecision(c));
    const { js, nat } = evalBoth(c, prog, X, Y, Z);
    same("union", nat, js, X, Y, Z);
    // Not a vacuous match: the lattice reaches inside, outside and the surface.
    expect(js.some((v) => v < 0) && js.some((v) => v > 0)).toBe(true);
    // Pruned programs too (a block decision drops a far leaf).
    const b = c.bounds;
    for (let q = 0; q < 12; q++) {
      const cx = b.min[0] + (rnd() * 0.5 + 0.5) * (b.max[0] - b.min[0]), cy = b.min[1] + (rnd() * 0.5 + 0.5) * (b.max[1] - b.min[1]);
      const cz = b.min[2] + (rnd() * 0.5 + 0.5) * (b.max[2] - b.min[2]);
      const pruned = emitProgram(c, blockDecision(c, cx, cy, cz, 3).dec);
      const r = evalBoth(c, pruned, X, Y, Z);
      same(`pruned ${q}`, r.nat, r.js, X, Y, Z);
    }
  });

  test("MESH: a lone solid leaf agrees to the bit on every vertex and edge midpoint (ties on shared edges and corners)", () => {
    for (const [name, s] of [
      ["box", k.box({ min: [-10, -5, -2], max: [10, 5, 2] })],
      ["cylinder", k.cylinder({ r: 6, h: 20 })],
      ["sphere", k.sphere(7)],
      // Two cubes touching along one edge: four triangles on that edge.
      ["edge-touching cubes", k.box({ min: [0, 0, 0], max: [4, 4, 4] }).union(k.box({ min: [4, 4, 0], max: [8, 8, 4] }))],
    ]) {
      const c = compileImplicit({ root: solid(s) });
      const [X, Y, Z] = onMesh(c.meshes[0]);
      const { js, nat } = evalBoth(c, emitProgram(c, fullDecision(c)), X, Y, Z);
      same(name, nat, js, X, Y, Z);
      expect(js.some((v) => Object.is(v, 0)), `${name}: some points are on the surface`).toBe(true);
      expect(js.some((v) => v < 0) && js.some((v) => v > 0), `${name}: inside and outside`).toBe(true);
      // The real pseudonormals give the right sign from several regions, so a port that
      // picked a wrong region or triangle could still match on them. Scrambled normals
      // (a random direction in every slot, both sides reading the same array) make the
      // sign depend on exactly which slot was read.
      const f = c.meshes[0];
      for (let i = 0; i < f.normals.length; i++) f.normals[i] = rnd();
      const r = evalBoth(c, emitProgram(c, fullDecision(c)), X, Y, Z);
      same(`${name}, scrambled normals`, r.nat, r.js, X, Y, Z);
    }
  });

  test("MESH: the native BVH reports the JS's triangle, point and distance, ties included", () => {
    // The session builds its BVH from the vertices as doubles; a Manifold soup's JS BVH
    // holds them as float32. Both must be the same tree and give the same answers.
    const c = compileImplicit({ root: solid(k.box({ min: [0, 0, 0], max: [4, 4, 4] }).union(k.box({ min: [4, 4, 0], max: [8, 8, 4] }))) });
    const f = c.meshes[0], V = f.bvh.vertices;
    expect(V).toBeInstanceOf(Float32Array);
    const x = core().x, handle = x.bvh_build(core().copyIn(Float64Array.from(V)), f.tris, 1, 1);
    try {
      const [X, Y, Z] = onMesh(f);
      const p = core().alloc(4 * 8), out = core().alloc(4 * 8);
      try {
        for (let i = 0; i < X.length; i++) {
          new Float64Array(x.memory.buffer, p, 3).set([X[i], Y[i], Z[i]]);
          const tri = x.bvh_closest_point(handle, p, out);
          const o = new Float64Array(x.memory.buffer, out, 4);
          const r = f.bvh.closestPoint([X[i], Y[i], Z[i]]);
          expect(tri).toBe(r.tri);
          for (let a = 0; a < 3; a++) expect(Object.is(o[a], r.point[a])).toBe(true);
          expect(Object.is(o[3], r.dist)).toBe(true);
        }
      } finally { x.free(p); x.free(out); }
    } finally { x.bvh_destroy(handle); }
  });

  test("MESH: NaN and infinite points read +Infinity on both sides", () => {
    const c = compileImplicit({ root: solid(k.sphere(5)) });
    const SPECIAL = [0, -0, 5, -5, Infinity, -Infinity, NaN, 1e300, -1e300];
    const X = [], Y = [], Z = [];
    for (const a of SPECIAL) for (const b of SPECIAL) for (const d of SPECIAL) { X.push(a); Y.push(b); Z.push(d); }
    const [x, y, z] = [X, Y, Z].map((v) => Float64Array.from(v));
    const { js, nat } = evalBoth(c, emitProgram(c, fullDecision(c)), x, y, z);
    same("special", nat, js, x, y, z);
  });

  test("MESH: a session frees its mesh fields (and their BVHs) when destroyed", () => {
    const c = compileImplicit({ root: solid(k.sphere(20)) });   // a few thousand triangles
    const cycle = () => {
      const s = new NativeSession(core());
      try { s.addMesh(c.meshes[0]); s.addMesh(c.meshes[0]); } finally { s.destroy(); }
    };
    for (let i = 0; i < 4; i++) cycle();
    const before = core().x.memory.buffer.byteLength;
    for (let i = 0; i < 60; i++) cycle();   // ~2 MB a cycle: a leak would grow the memory
    expect(core().x.memory.buffer.byteLength).toBe(before);
  });

  test("MESH with a slot the session lacks is a refusal, not a fault", () => {
    const c = blend();
    const prog = emitProgram(c, fullDecision(c));
    const at = Float64Array.of(0);
    const s = new NativeSession(core());
    try {
      const idx = s.addProgram(prog);
      let err = null;
      try { s.eval(idx, at, at, at); } catch (e) { err = e; }
      expect(err?.code).toBe(CORE_REFUSED);
      s.addMesh(c.meshes[0]);   // one of two: slot 1 is still missing
      err = null;
      try { s.eval(idx, at, at, at); } catch (e) { err = e; }
      expect(err?.code).toBe(CORE_REFUSED);
      s.addMesh(c.meshes[1]);
      expect(s.eval(idx, at, at, at)).toHaveLength(1);   // now it runs
      // A malformed MESH op (no slot word, a negative or fractional slot) is refused too.
      for (const bad of [
        Float64Array.of(1, 1, 26, 0, 0),
        Float64Array.of(1, 1, 26, 0, 0, -1, 0, 0),
        Float64Array.of(1, 1, 26, 0, 0, 0.5, 0, 0),
        Float64Array.of(1, 1, 26, 1, 0, 0, 0, 0),   // dst past nV
      ]) {
        err = null;
        try { s.eval(s.addProgram(bad), at, at, at); } catch (e) { err = e; }
        expect(err?.code).toBe(CORE_REFUSED);
      }
      // A bad mesh field is refused at addMesh.
      for (const bad of [null, { tris: 1, normals: new Float64Array(21), bvh: { vertices: new Float64Array(8) } },
        { tris: 0, normals: new Float64Array(0), bvh: { vertices: new Float64Array(0) } },
        { tris: 1, normals: new Float64Array(20), bvh: { vertices: new Float64Array(9) } }]) {
        err = null;
        try { s.addMesh(bad); } catch (e) { err = e; }
        expect(err?.code).toBe(CORE_REFUSED);
      }
      expect(core()).not.toBeNull();   // refusing is not a fault
      expect(core().poisoned).toBe(false);
    } finally { s.destroy(); }
  });
});
