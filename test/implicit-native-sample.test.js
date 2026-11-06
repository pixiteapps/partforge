// The native leaf sampler (native/implicit_mesh.cpp, ip_sample) must store the SAME
// BYTES as sparse.js's evaluateLeaves for the same plan — every leaf's float32
// samples (outer-layer raise and exact-zero nudge included) and the clipped flag.
import { afterEach, describe, expect, test } from "vitest";
import { core, setCoreForTesting } from "../src/framework/core/core.js";
import { NativeSession } from "../src/framework/core/implicit-core.js";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { nativeCases, sessionFor } from "./fixtures/implicit-native-cases.js";
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { SEAM_CASES } from "./fixtures/implicit-seam-cases.js";
import { createSampleCache } from "../src/framework/geometry/implicit/sample-cache.js";
import { TWO_BONE } from "./fixtures/skin-fixtures.js";
import { BALL_BOARD } from "./fixtures/implicit-trees.js";

afterEach(() => setCoreForTesting(undefined));

const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

describe("native leaf sampling", () => {
  for (const { name, spec, images, edges } of nativeCases()) {
    for (const edge of edges) {
      test(`${name} at ${edge} mm: every leaf's samples and clipped match evaluateLeaves`, () => {
        const plan = planLeaves(lowerSpec(spec, { images }), edge);
        const js = evaluateLeaves(plan);
        const s = sessionFor(plan);
        try {
          const nat = s.sample(plan);
          expect(nat.vals.length).toBe(js.leaves.length);
          for (let L = 0; L < js.leaves.length; L++) {
            if (Buffer.compare(bytes(nat.vals[L]), bytes(js.leaves[L].vals)) !== 0) {
              const a = js.leaves[L].vals, b = nat.vals[L];
              const q = a.findIndex((v, k) => !Object.is(v, b[k]));
              throw new Error(`leaf ${L} sample ${q}: native ${b[q]} vs JS ${a[q]}`);
            }
          }
          expect(nat.clipped).toBe(js.clipped);
        } finally { s.destroy(); }
      }, 120_000);
    }
  }

  test("the cases reach the zero nudge", () => {
    // Guard against a case list that never exercises the nudge (the raise: the clipped test below).
    const c = lowerSpec(nativeCases().find((k) => k.name === "touching mirrorHalfBox").spec, { images: new Map() });
    const js = evaluateLeaves(planLeaves(c, 0.5));
    expect(js.leaves.some((l) => l.vals.some((v) => v < 0 && v > -1e-5))).toBe(true);
  });

  test("a clipped plan reports clipped", () => {
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 5 } }, { images: new Map() }), 1);
    const shrunk = { ...plan, n: plan.n.map((v) => v - 4), leaves: plan.leaves.filter((l) => l.i0 < plan.n[0] - 6 && l.j0 < plan.n[1] - 6 && l.l0 < plan.n[2] - 6) };
    shrunk.origin = plan.origin.map((v) => v + 2);
    const js = evaluateLeaves(shrunk);
    expect(js.clipped).toBe(true);
    expect(js.leaves.some((l) => l.vals.some((v) => v === 0.5))).toBe(true);   // the outer-layer raise to 0.5·edge
    const s = sessionFor(shrunk);
    try {
      const nat = s.sample(shrunk);
      expect(nat.clipped).toBe(true);
      for (let L = 0; L < js.leaves.length; L++) expect(Buffer.compare(bytes(nat.vals[L]), bytes(js.leaves[L].vals))).toBe(0);
    } finally { s.destroy(); }
  });

  test("a dense plan (leaves running past the grid's far faces) samples the same bytes", () => {
    for (const name of ["blobs", "carved"]) {
      const plan = planLeaves(lowerSpec(nativeCases().find((k) => k.name === name).spec, { images: new Map() }), 1, { cull: false });
      expect(plan.leaves.some((l) => l.i0 + 4 >= plan.n[0] || l.j0 + 4 >= plan.n[1] || l.l0 + 4 >= plan.n[2])).toBe(true);
      const js = evaluateLeaves(plan);
      const s = sessionFor(plan);
      try {
        const nat = s.sample(plan);
        for (let L = 0; L < js.leaves.length; L++) expect(Buffer.compare(bytes(nat.vals[L]), bytes(js.leaves[L].vals))).toBe(0);
        expect(nat.clipped).toBe(js.clipped);
      } finally { s.destroy(); }
    }
  });

  test("still-zero samples fall back to ±1e-30 by the double's sign, as the JS does", () => {
    // Exactly 0 for x ≥ 0 and -1e-50 (a float32 zero) for x < 0, at the sample AND the
    // nudged point: the zero pass reaches both fallbacks.
    const spec = { root: { kind: "expr", box: [[-3, -3, -3], [3, 3, 3]], sdf: "return p.x < 0.0 ? -1e-50 : 0.0;" } };
    const plan = planLeaves(lowerSpec(spec, { images: new Map() }), 1);
    const js = evaluateLeaves(plan);
    const count = (v) => js.leaves.reduce((a, l) => a + l.vals.filter((x) => x === Math.fround(v)).length, 0);
    expect(count(-1e-30)).toBeGreaterThan(0);
    expect(count(1e-30)).toBeGreaterThan(0);
    const s = sessionFor(plan);
    try {
      const nat = s.sample(plan);
      for (let L = 0; L < js.leaves.length; L++) expect(Buffer.compare(bytes(nat.vals[L]), bytes(js.leaves[L].vals))).toBe(0);
    } finally { s.destroy(); }
  });

  test("readBack: false keeps the samples in the session and copies nothing out", () => {
    const plan = planLeaves(lowerSpec(nativeCases().find((k) => k.name === "blobs").spec, { images: new Map() }), 1);
    const s = sessionFor(plan);
    try {
      const nat = s.sample(plan, { readBack: false });
      expect(nat).toEqual({ vals: null, clipped: evaluateLeaves(plan).clipped, cacheHits: 0 });
      expect(s.mesh().indices.length).toBeGreaterThan(0);
    } finally { s.destroy(); }
  });

  test("a leaf outside the grid's cells is refused before the core sees it", () => {
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
    const s = sessionFor(plan);
    try {
      for (const a of ["i0", "j0", "l0"]) {
        const ax = { i0: 0, j0: 1, l0: 2 }[a];
        const bad = { ...plan, leaves: [{ ...plan.leaves[0], [a]: plan.n[ax] - 1 }] };
        expect(() => s.sample(bad)).toThrow(/inside the grid/);
      }
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });

  test("a program reading a texture slot the session lacks is refused (rc 3), not run", () => {
    const data = new Uint16Array(9 * 7).map((_, i) => (i * 7919) & 0xffff);
    const images = new Map([["noise", { digest: "noise-9x7", width: 9, height: 7, data }]]);
    const spec = { root: { kind: "expr", box: [[-4, -4, -4], [4, 4, 4]], sdf: "return length(p) - 3.0 + texture(t, p.xy * 0.1 + 0.5);", textures: { t: { image: "noise" } } } };
    const plan = planLeaves(lowerSpec(spec, { images }), 1);
    expect(plan.textures.length).toBe(1);
    const s = new NativeSession(core());
    try {
      for (const p of plan.programs) s.addProgram(p);   // programs but no texture
      expect(() => s.sample(plan)).toThrow(/refused/);
      expect(() => s.mesh()).toThrow(/refused/);       // the refusal kept nothing
      s.addTexture(plan.textures[0]);
      const js = evaluateLeaves(plan);
      const nat = s.sample(plan);
      for (let L = 0; L < js.leaves.length; L++) expect(Buffer.compare(bytes(nat.vals[L]), bytes(js.leaves[L].vals))).toBe(0);
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });

  test("a plan naming a program the session lacks is refused, not run", () => {
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
    const s = new NativeSession(core());
    try {
      expect(() => s.sample(plan)).toThrow(/refused/);
      expect(() => s.sample({ ...plan, edge: NaN })).toThrow(/plan/);
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });

  // An exact-contact plan (the root contact's children own the samples): every leaf's owners
  // are evaluateLeaves' — the piece captured by the same evaluation, the zero nudge's own
  // capture, AIR where the stored value is ≥ 0 (the outer-layer raise included).
  for (const { name, spec } of SEAM_CASES) {
    test(`${name} at 1.5 mm: every leaf's owners match evaluateLeaves`, () => {
      const plan = planLeaves(compileImplicit(spec), 1.5);
      expect(plan.ownerRoot).toBeGreaterThanOrEqual(0);
      const js = evaluateLeaves(plan);
      const s = sessionFor(plan);
      try {
        const nat = s.sample(plan);
        expect(nat.clipped).toBe(js.clipped);
        const owners = s.leafOwners();
        expect(owners.length).toBe(js.leaves.length);
        let owned = 0;
        for (let L = 0; L < js.leaves.length; L++) {
          expect(Buffer.compare(bytes(nat.vals[L]), bytes(js.leaves[L].vals))).toBe(0);
          expect(owners[L]).toBeInstanceOf(Int8Array);
          if (Buffer.compare(bytes(owners[L]), bytes(js.leaves[L].owner)) !== 0) {
            const a = js.leaves[L].owner, b = owners[L], q = a.findIndex((v, k) => v !== b[k]);
            throw new Error(`leaf ${L} sample ${q}: native owner ${b[q]} vs JS ${a[q]}`);
          }
          owned += js.leaves[L].owner.filter((o) => o >= 0).length;
        }
        expect(owned).toBeGreaterThan(0);
      } finally { s.destroy(); }
    }, 120_000);
  }

  test("a plan without an owner root has no owners", () => {
    const plan = planLeaves(lowerSpec({ root: { kind: "sphere", r: 3 } }, { images: new Map() }), 1);
    const s = sessionFor(plan);
    try {
      s.sample(plan, { readBack: false });
      expect(s.leafOwners()).toBeNull();
    } finally { s.destroy(); }
  });

  test("an owner plan whose programs name a child past ownerK is refused, not run", () => {
    const plan = planLeaves(compileImplicit(SEAM_CASES[0].spec), 1.5);
    const s = sessionFor(plan);
    try {
      expect(() => s.sample({ ...plan, ownerK: 1 })).toThrow(/refused/);
      expect(() => s.sample({ ...plan, ownerK: 128 })).toThrow(/ownerK/);
      expect(s.leafOwners()).toBeNull();
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });

  // The cached sample (ip_sample_cached): an anchored plan's positions are (base + i)·edge, and
  // a leaf the cache holds takes its preloaded samples (and owners) instead of being evaluated.
  const sampleAll = (plan, opts) => {
    const s = sessionFor(plan);
    try {
      const nat = s.sample(plan, opts);
      return { ...nat, owners: s.leafOwners() };
    } finally { s.destroy(); }
  };
  const sameLeaves = (got, want, what) => {
    expect(got.length).toBe(want.length);
    for (let L = 0; L < want.length; L++) {
      if (Buffer.compare(bytes(got[L]), bytes(want[L])) !== 0) {
        const q = want[L].findIndex((v, k) => !Object.is(v, got[L][k]));
        throw new Error(`${what}: leaf ${L} sample ${q}: native ${got[L][q]} vs expected ${want[L][q]}`);
      }
    }
  };

  // A face on a lattice plane: at 0.7 mm, (base + i)·edge and base·edge + i·edge differ by an
  // ulp there and the stored float32 shows it, so this case tells the two formulas apart.
  const PLANE_CUT = { root: { kind: "expr", box: [[-3, -3, -3], [3, 3, 3]], sdf: "return max(length(p) - 2.5, p.x - 2.1);" } };
  for (const edge of [1, 0.7]) {
    test(`an anchored plan samples the base formula's bytes at ${edge} mm: the core equals evaluateLeaves`, () => {
      for (const spec of [TWO_BONE(0), PLANE_CUT]) {
        const plan = planLeaves(compileImplicit(spec), edge, { anchor: true });
        expect(plan.base).not.toBeNull();
        const js = evaluateLeaves(plan);
        const nat = sampleAll(plan);
        sameLeaves(nat.vals, js.leaves.map((l) => l.vals), "anchored");
        expect(nat.clipped).toBe(js.clipped);
      }
    });
  }

  test("the plane cut tells the anchored formula from the origin formula at 0.7 mm", () => {
    const plan = planLeaves(compileImplicit(PLANE_CUT), 0.7, { anchor: true });
    const a = evaluateLeaves(plan), b = evaluateLeaves({ ...plan, base: null });
    expect(a.leaves.some((l, k) => Buffer.compare(bytes(l.vals), bytes(b.leaves[k].vals)) !== 0)).toBe(true);
  });

  test("skipped leaves take the preloaded values and the rest are evaluated: equal to an unskipped sample", () => {
    for (const [name, spec, edge] of [["two bone", TWO_BONE(0), 0.7], ["ball board", BALL_BOARD, 1.5]]) {
      const plan = planLeaves(compileImplicit(spec), edge, { anchor: true });
      const plain = sampleAll(plan);
      const cache = createSampleCache();
      const cold = sampleAll(plan, { cache });
      expect(cold.cacheHits, name).toBe(0);
      expect(cache.size, name).toBeGreaterThan(0);
      sameLeaves(cold.vals, plain.vals, `${name} cold`);
      const warm = sampleAll(plan, { cache });
      expect(warm.cacheHits, name).toBe(cache.size);
      expect(warm.cacheHits, name).toBeLessThan(plan.leaves.length);   // the outer-layer leaves are evaluated
      sameLeaves(warm.vals, plain.vals, `${name} warm`);
      expect(warm.clipped).toBe(plain.clipped);
      if (plan.ownerRoot >= 0) {
        const js = evaluateLeaves(plan);
        sameLeaves(warm.owners, js.leaves.map((l) => l.owner), `${name} warm owners`);
        sameLeaves(cold.owners, js.leaves.map((l) => l.owner), `${name} cold owners`);
      } else {
        expect(warm.owners).toBeNull();
      }
    }
  });

  test("a warm cache never changes clipped", () => {
    // An anchored sphere plan cut short at its far faces: the outer layer runs through the solid.
    const full = planLeaves(compileImplicit({ root: { kind: "sphere", r: 5 }, preview: 1 }), 1, { anchor: true });
    const n = full.n.map((v) => v - 4);
    const plan = { ...full, n, leaves: full.leaves.filter((l) => l.i0 < n[0] - 1 && l.j0 < n[1] - 1 && l.l0 < n[2] - 1) };
    const js = evaluateLeaves(plan);
    expect(js.clipped).toBe(true);
    const cache = createSampleCache();
    const cold = sampleAll(plan, { cache });
    expect(cold.clipped).toBe(true);
    const warm = sampleAll(plan, { cache });
    expect(warm.cacheHits).toBeGreaterThan(0);
    expect(warm.clipped).toBe(true);
    sameLeaves(warm.vals, js.leaves.map((l) => l.vals), "clipped warm");
  });
});
