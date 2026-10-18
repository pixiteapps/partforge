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
      expect(nat).toEqual({ vals: null, clipped: evaluateLeaves(plan).clipped });
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
      const plan = planLeaves(compileImplicit(spec, { exactContact: true }), 1.5);
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
    const plan = planLeaves(compileImplicit(SEAM_CASES[0].spec, { exactContact: true }), 1.5);
    const s = sessionFor(plan);
    try {
      expect(() => s.sample({ ...plan, ownerK: 1 })).toThrow(/refused/);
      expect(() => s.sample({ ...plan, ownerK: 128 })).toThrow(/ownerK/);
      expect(s.leafOwners()).toBeNull();
    } finally { s.destroy(); }
    expect(core().poisoned).toBe(false);
  });
});
