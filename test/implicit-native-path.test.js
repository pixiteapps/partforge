// meshImplicit's dispatch to the native core (core/implicit-core.js's
// meshImplicitCore): the same bytes either way, memory handed back when idle, and
// every way the core can fail answered by the JS, never by a crash or a different
// result. test/core-parity.test.js holds whole k.implicit builds core on == off.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { core, coreStatus, onCoreFallback, RECYCLE_BYTES, setCoreEnabled, setCoreForTesting } from "../src/framework/core/core.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handSpec, SUB_CELL_PLATE, vaseSpec } from "./fixtures/implicit-trees.js";
import { planLeaves } from "../src/framework/geometry/implicit/sparse.js";

afterEach(() => {
  setCoreEnabled(true);
  setCoreForTesting(undefined);
  delete globalThis.PARTFORGE_CORE;
});

const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function sameResult(a, b) {
  for (const k of ["positions", "indices", "normals"]) {
    expect(a[k].constructor, k).toBe(b[k].constructor);
    expect(Buffer.compare(bytes(a[k]), bytes(b[k])), k).toBe(0);
  }
  expect(a.warnings).toEqual(b.warnings);
  expect(a.stats).toEqual(b.stats);
}
const withCore = (on, fn) => {
  setCoreEnabled(on);
  try { return fn(); } finally { setCoreEnabled(true); }
};
const SPHERE = { root: { kind: "union", k: 1, children: [{ kind: "sphere", r: 4 }, { kind: "box", size: [3, 3, 9], round: 0.5 }] } };

// Both builds of the core (scripts/build-core-wasm.mjs): the SIMD one this engine
// boots by default, and the scalar one an engine without wasm SIMD gets
// (PARTFORGE_CORE_SIMD = false, read at each boot — afterEach re-boots).
describe.each([["SIMD", true], ["scalar", false]])("meshImplicit on the native core (%s build)", (_, simd) => {
  beforeAll(() => { if (!simd) globalThis.PARTFORGE_CORE_SIMD = false; setCoreForTesting(undefined); });
  afterAll(() => { delete globalThis.PARTFORGE_CORE_SIMD; setCoreForTesting(undefined); });
  test("this build is the one booted", () => {
    expect(core().simd).toBe(simd);
  });
  test("the hand at print tier (0.5 mm) builds identically, and the grown instance is recycled once idle", () => {
    const compiled = compileImplicit(handSpec());
    const js = withCore(false, () => meshImplicit(compiled, 0.5));
    const c = core();
    expect(c.x.memory.buffer.byteLength).toBeLessThan(RECYCLE_BYTES);
    const nat = meshImplicit(compiled, 0.5);
    sameResult(nat, js);
    expect(js.indices.length).toBeGreaterThan(0);
    expect(c.x.memory.buffer.byteLength).toBeGreaterThan(RECYCLE_BYTES);   // the session's peak
    expect(c.live).toBe(0);                                               // the session was destroyed
    const next = core();
    expect(next).not.toBe(c);                                             // ...and the big instance dropped
    expect(next.x.memory.buffer.byteLength).toBeLessThan(RECYCLE_BYTES);
    expect(coreStatus()).toMatchObject({ state: "on", reason: null, refusedMeshes: 0 });
  }, 300_000);

  test("a core that throws inside ip_mesh: k.implicit returns the JS result and one fallback is reported", async () => {
    const meshOf = (solid) => {
      const g = solid._m.getMesh();
      return { vp: Buffer.from(Float32Array.from(g.vertProperties).buffer), tv: Buffer.from(Uint32Array.from(g.triVerts).buffer) };
    };
    const kJs = await bootManifoldKernel();
    const expected = withCore(false, () => meshOf(kJs.implicit(SPHERE)));
    const real = core();
    const broken = { ...real, live: 0, poisoned: false, x: { ...real.x, ip_mesh: () => { throw new Error("boom"); } } };
    setCoreForTesting(broken);
    const seen = [];
    onCoreFallback((f) => seen.push(f));
    const k = await bootManifoldKernel();
    const got = meshOf(k.implicit(SPHERE));
    expect(Buffer.compare(got.vp, expected.vp)).toBe(0);
    expect(Buffer.compare(got.tv, expected.tv)).toBe(0);
    expect(broken.poisoned).toBe(true);
    expect(broken.live).toBe(0);
    expect(seen).toEqual([{ state: "faulted", reason: "error" }]);
    // Every later mesh runs the JS (the instance is retired); still one report.
    const compiled = compileImplicit(SPHERE);
    sameResult(meshImplicit(compiled, 0.6), withCore(false, () => meshImplicit(compiled, 0.6)));
    expect(seen).toHaveLength(1);
    expect(coreStatus()).toMatchObject({ state: "faulted", reason: "error" });
  }, 60_000);

  test("a trap inside the session poisons the instance and the JS answers", () => {
    const real = core();
    const trapping = { ...real, live: 0, poisoned: false,
      x: { ...real.x, ip_cleanup: () => { throw new WebAssembly.RuntimeError("unreachable"); } } };
    setCoreForTesting(trapping);
    const seen = [];
    onCoreFallback((f) => seen.push(f));
    const compiled = compileImplicit(SPHERE);
    sameResult(meshImplicit(compiled, 0.6), withCore(false, () => meshImplicit(compiled, 0.6)));
    expect(trapping.poisoned).toBe(true);
    expect(trapping.live).toBe(0);
    expect(seen).toEqual([{ state: "faulted", reason: "trap" }]);
    expect(coreStatus()).toMatchObject({ state: "faulted", reason: "trap" });
  });

  test("a core that will not open a session (id 0) is a counted refusal, never a silent fallback", () => {
    const real = core();
    const closed = { ...real, live: 0, poisoned: false, x: { ...real.x, ip_session_create: () => 0 } };
    setCoreForTesting(closed);
    const seen = [];
    onCoreFallback((f) => seen.push(f));
    const compiled = compileImplicit(SPHERE);
    sameResult(meshImplicit(compiled, 0.6), withCore(false, () => meshImplicit(compiled, 0.6)));
    expect(closed.poisoned).toBe(false);
    expect(closed.live).toBe(0);
    expect(seen).toEqual([]);
    expect(coreStatus().refusedMeshes).toBe(1);
  });

  test("the plan's textures are the compiled tree's (detail slots and session slots agree)", () => {
    const vase = vaseSpec();
    const compiled = compileImplicit(vase.spec, { images: vase.images });
    expect(compiled.textures.length).toBeGreaterThan(0);
    expect(planLeaves(compiled, 1.2).textures).toBe(compiled.textures);
  });

  test("a refusal is counted, not reported, and leaves the core usable", () => {
    const real = core();
    const refusing = { ...real, live: 0, poisoned: false, x: { ...real.x, ip_mesh: () => 1 } };
    setCoreForTesting(refusing);
    const seen = [];
    onCoreFallback((f) => seen.push(f));
    const compiled = compileImplicit(SPHERE);
    sameResult(meshImplicit(compiled, 0.6), withCore(false, () => meshImplicit(compiled, 0.6)));
    expect(refusing.poisoned).toBe(false);
    expect(seen).toEqual([]);
    expect(coreStatus().refusedMeshes).toBe(1);
  });

  test("the preview tier (decimating cleanup) builds identically, hand and vase", () => {
    const vase = vaseSpec();
    for (const [compiled, edge] of [[compileImplicit(handSpec()), 1.5], [compileImplicit(vase.spec, { images: vase.images }), 1.2]]) {
      const nat = meshImplicit(compiled, edge, { tier: "preview" });
      sameResult(nat, withCore(false, () => meshImplicit(compiled, edge, { tier: "preview" })));
      expect(nat.indices.length).toBeLessThan(meshImplicit(compiled, edge, { tier: "print" }).indices.length);
    }
    expect(coreStatus()).toMatchObject({ state: "on", reason: null, refusedMeshes: 0 });
  }, 120_000);

  test("globalThis.PARTFORGE_CORE = false runs the JS path, with identical bytes", () => {
    const compiled = compileImplicit(handSpec());
    const nat = meshImplicit(compiled, 1.5);
    const real = core();
    // A core that would fail the test if it were touched.
    setCoreForTesting({ ...real, x: { ...real.x, ip_session_create: () => { throw new Error("the core ran"); } } });
    globalThis.PARTFORGE_CORE = false;
    const js = meshImplicit(compiled, 1.5);
    expect(coreStatus().state).toBe("off");
    sameResult(nat, js);
  }, 60_000);

  test("an empty shape and a clipped one give the same error and warnings on both paths", async () => {
    const empty = { root: { kind: "subtract", children: [{ kind: "box", size: [5, 5, 5] }, { kind: "box", size: [20, 20, 20] }] }, preview: 1 };
    for (const spec of [empty, SUB_CELL_PLATE]) {
      const compiled = compileImplicit(spec);
      sameResult(meshImplicit(compiled, spec.preview), withCore(false, () => meshImplicit(compiled, spec.preview)));
      const errorOf = async (on) => {
        const k = await bootManifoldKernel();
        try { withCore(on, () => k.implicit(spec)); return null; } catch (e) { return e.message; }
      };
      expect(await errorOf(true)).toBe(await errorOf(false));
    }
    expect(await (async () => { const k = await bootManifoldKernel(); try { k.implicit(empty); } catch (e) { return e.message; } })())
      .toMatch(/implicit: the shape is empty at a 1 mm grid/);

    const tight = compileImplicit({ root: { kind: "sphere", r: 6 } });
    tight.bounds = { min: [-4, -4, -4], max: [4, 4, 4] };   // bounds derived too tight: clipped
    const withExpr = compileImplicit({ root: { kind: "expr", box: [[-4, -4, -4], [4, 4, 4]], sdf: "return length(p) - 6.0;" } });
    for (const compiled of [tight, withExpr]) {
      const nat = meshImplicit(compiled, 0.5);
      expect(nat.warnings.join(" ")).toMatch(/clipped/);
      sameResult(nat, withCore(false, () => meshImplicit(compiled, 0.5)));
    }
    expect(coreStatus()).toMatchObject({ state: "on", refusedMeshes: 0 });
  }, 60_000);
});
