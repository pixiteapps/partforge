// The native surface detail (native/implicit_detail.cpp, ip_detail) must produce
// the SAME BYTES as detail.js's applySurfaceDetail: positions, indices, vertLeaf
// and normals — refinement rounds, midpoint projection, the zero-normal fallback
// and the displacement by every entry kind (creases, noise, planar / cylindrical /
// triplanar textures, expr heights run as programs).
import { afterEach, describe, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh, CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail, flattenDetail } from "../src/framework/geometry/implicit/detail.js";
import { handSpec, vaseSpec } from "./fixtures/implicit-trees.js";
import { sessionFor } from "./fixtures/implicit-native-cases.js";

afterEach(() => setCoreForTesting(undefined));

const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function same(name, nat, js) {
  expect(nat.constructor).toBe(js.constructor);
  if (nat.length !== js.length) throw new Error(`${name}: native length ${nat.length} vs JS ${js.length}`);
  if (Buffer.compare(bytes(nat), bytes(js)) !== 0) {
    const k = js.findIndex((v, i) => !Object.is(v, nat[i]));
    throw new Error(`${name}[${k}]: native ${nat[k]} vs JS ${js[k]}`);
  }
}

const white = () => new Map([["w", { digest: "w1", width: 4, height: 4, data: new Uint16Array(16).fill(65535) }]]);
// A ramp with a dark spot, so a texture read is not constant.
const ramp = () => {
  const W = 16, H = 12, data = new Uint16Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) data[j * W + i] = (i * 4000 + j * 1500 + ((i - 7) * (i - 7) + (j - 5) * (j - 5) < 9 ? 0 : 3000)) % 65536;
  return new Map([["r", { digest: "r1", width: W, height: H, data }]]);
};

const handNoise = () => {
  const h = handSpec();
  return { ...h, detail: [...h.detail, { kind: "noise", amplitude: 0.08, wavelength: 1.1 }] };
};
const vase = vaseSpec();

const CASES = [
  // The hand's creases sit at the joint centres with a radius under the finger's, so
  // they never reach its surface: nothing refines, and only the displacement loop runs.
  { name: "hand with creases", spec: handSpec(), images: new Map(), edges: [1.5, 0.8], refines: false },
  { name: "hand with creases and noise", spec: handNoise(), images: new Map(), edges: [1.5, 0.8] },
  { name: "vase (cylindrical texture)", spec: vase.spec, images: vase.images, edges: [1.0, 0.5] },
  { name: "box with creases", images: new Map(), edges: [1.0],
    spec: { root: { kind: "box", size: [20, 20, 6], round: 2 },
      detail: [{ kind: "creases", amplitude: 0.3, wavelength: 1.2, axis: "x", at: [0, 0, 3], radius: 4, side: [0, 0, 1] }] } },
  { name: "texture emboss (planar)", images: white(), edges: [1.0], refines: false,   // texel target 2.5 mm > the edge
    spec: { root: { kind: "box", size: [10, 10, 4] }, detail: [{ kind: "texture", image: "w", amplitude: 0.5, size: [10, 10], side: [0, 0, 1] }] } },
  { name: "planar and triplanar textures from a ramp", images: ramp(), edges: [1.0],
    spec: { root: { kind: "box", size: [12, 10, 8], round: 1.5 }, detail: [
      { kind: "texture", image: "r", amplitude: 0.3, size: [12, 10], projection: "triplanar" },
      { kind: "texture", image: "r", amplitude: -0.2, size: [8, 6], axis: "x", at: [6, 0, 0], radius: 5 },
    ] } },
  { name: "expr detail with a texture", images: ramp(), edges: [1.0],
    spec: { root: { kind: "sphere", r: 5 }, detail: [
      { kind: "expr", height: "return 0.3 * texture(t, p.xy * 0.1 + vec2(0.5, 0.5)) - 0.05 * sin(p.z * 2.0);", textures: { t: { image: "r" } }, wavelength: 1.5, side: [0, 0, 1] },
      { kind: "expr", height: "return sqrt(-1.0 - p.x * p.x);", radius: 3, at: [0, 0, -5] },
    ] } },
];

describe("native surface detail", () => {
  for (const { name, spec, images, edges, refines = true } of CASES) {
    for (const edge of edges) {
      test(`${name} at ${edge} mm: applySurfaceDetail's positions, indices, vertLeaf and normals`, () => {
        const compiled = lowerSpec(spec, { images });
        expect(compiled.detail.length).toBeGreaterThan(0);
        const plan = planLeaves(compiled, edge);
        const store = evaluateLeaves(plan);
        const cleaned = cleanupMesh(store, meshStore(store));
        const js = applySurfaceDetail(store, cleaned, compiled);
        expect(js.indices.length > cleaned.indices.length).toBe(refines);
        const s = sessionFor(plan);
        try {
          s.sample(plan, { readBack: false });
          s.mesh();
          s.cleanup(CLEANUP, { readBack: false });
          const nat = s.detail(flattenDetail(compiled));
          same("positions", nat.positions, js.positions);
          same("indices", nat.indices, js.indices);
          same("vertLeaf", nat.vertLeaf, js.vertLeaf);
          same("normals", nat.normals, js.normals);
        } finally { s.destroy(); }
      }, 300_000);
    }
  }

  test("zero normals: skipped by the displacement, and midpoints projected without a gradient take their endpoints' normals", () => {
    // Inside the sphere the field is flat (-0.5), so a mesh loaded there projects no
    // midpoint: every one falls back to its endpoints' normalized sum (or stays zero).
    const images = ramp();
    const compiled = lowerSpec({ root: { kind: "expr", box: [[-6, -6, -6], [6, 6, 6]], sdf: "return max(length(p) - 4.0, -0.5);" }, detail: [
      { kind: "noise", amplitude: 0.1, wavelength: 1.2 },
      { kind: "texture", image: "r", amplitude: 0.2, size: [6, 6], projection: "triplanar" },
      { kind: "creases", amplitude: 0.1, wavelength: 1.5, axis: "y", side: [0, 0, 1] },
    ] }, { images });
    const plan = planLeaves(compiled, 1);
    const store = evaluateLeaves(plan);
    const cleaned = cleanupMesh(store, meshStore(store));
    const positions = cleaned.positions.map((v) => v * 0.5), normals = Float64Array.from(cleaned.normals);
    for (let v = 0; v < normals.length / 3; v += 5) normals[3 * v] = normals[3 * v + 1] = normals[3 * v + 2] = 0;
    const mesh = { positions, indices: cleaned.indices, vertLeaf: cleaned.vertLeaf, normals };
    const js = applySurfaceDetail(store, mesh, compiled);
    expect(js.indices.length).toBeGreaterThan(cleaned.indices.length);
    expect(js.positions.every(Number.isFinite)).toBe(true);
    const s = sessionFor(plan);
    try {
      s.sample(plan, { readBack: false });
      s.loadMesh(mesh);
      same("normals loaded", s.normals(), normals);
      const nat = s.detail(flattenDetail(compiled));
      same("positions", nat.positions, js.positions);
      same("indices", nat.indices, js.indices);
      same("vertLeaf", nat.vertLeaf, js.vertLeaf);
      same("normals", nat.normals, js.normals);
    } finally { s.destroy(); }
  });

  test("refusals: no mesh, no normals, a bad texture slot or program; the instance is not poisoned", () => {
    const compiled = lowerSpec(CASES[4].spec, { images: CASES[4].images });
    const plan = planLeaves(compiled, 1);
    const flat = flattenDetail(compiled);
    const s = sessionFor(plan);
    try {
      expect(() => s.detail(flat)).toThrow(/refused/);   // nothing meshed
      s.sample(plan, { readBack: false });
      s.mesh();
      expect(() => s.detail(flat)).toThrow(/refused/);   // meshed, but no normals yet
      s.cleanup(CLEANUP, { readBack: false });
      const badSlot = Float64Array.from(flat.entries);
      badSlot[22] = 7;
      expect(() => s.detail({ entries: badSlot, programs: [] })).toThrow(/refused/);
      const badProg = Float64Array.from(flat.entries);
      badProg[0] = 4; badProg[27] = 0;
      expect(() => s.detail({ entries: badProg, programs: [] })).toThrow(/refused/);
      expect(() => s.detail({ entries: new Float64Array(5), programs: [] })).toThrow(/28/);
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });
});
