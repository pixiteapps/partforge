// The native core ships as two builds (src/framework/core/core.js): a small BASE one
// every worker loads, and the FULL one (the k.implicit engine) loaded on demand. This
// file runs a realm that has only the base build — what a part with no k.implicit ever
// sees — and the hand-over once the full build arrives. The setup file loads the full
// build for every other test.
import { afterEach, expect, test } from "vitest";
import { core, fullCore, fullCoreLoaded, loadFullCore, NEEDS_FULL_CORE, releaseIfIdle, setFullCoreForTesting, setFullCoreRequired } from "../src/framework/core/core.js";
import { creasedNormals, creasedNormalsJS } from "../src/framework/geometry/creased-normals.js";
import { cachedBVH, coreBVHCache, disposeBVHs } from "../src/framework/oracle/bvh.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { walk } from "./helpers/import-graph.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

afterEach(() => { setFullCoreRequired(false); return setFullCoreForTesting(true); });

const fan = {
  numProp: 3,
  vertProperties: new Float32Array([0, 0, 0.2, 1, 0, 0, 0, 1, 0, -1, 0, 0]),
  triVerts: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1]),
  runIndex: new Uint32Array([0, 9]),
  runOriginalID: new Uint32Array([1]),
};
const tet = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };
const bytes = (m) => JSON.stringify([[...m.positions], [...m.indices]]);

test("with only the base build, the core runs the base passes and has no implicit engine", async () => {
  await setFullCoreForTesting(false);
  const c = core();
  expect(c).not.toBeNull();
  expect(c.full).toBe(false);
  expect(typeof c.x.cn_create).toBe("function");
  expect(typeof c.x.bvh_build).toBe("function");
  expect(c.x.ip_session_create).toBeUndefined();
  const a = creasedNormals(fan), b = creasedNormalsJS(fan);
  expect([...a.normals]).toEqual([...b.normals]);
  expect(core()).toBe(c); // the base instance answered, and was not poisoned
});

test("k.implicit without the full build meshes in JS, the same bytes, and asks for the load", async () => {
  const compiled = compileImplicit(TREES.blobs, {});
  const native = meshImplicit(compiled, 1, { tier: "preview" });
  await setFullCoreForTesting(false);
  expect(fullCoreLoaded()).toBe(false);
  expect(fullCore()).toBeNull();
  const js = meshImplicit(compiled, 1, { tier: "preview" });
  expect(bytes(js)).toBe(bytes(native));
  expect(core().poisoned).toBe(false);
  // fullCore() started the load: once it lands, the next call is the full build.
  expect(await loadFullCore()).toBe(true);
  expect(fullCore()?.full).toBe(true);
  expect(bytes(meshImplicit(compiled, 1, { tier: "preview" }))).toBe(bytes(native));
});

test("where the caller can load and retry, the call throws NEEDS_FULL_CORE instead", async () => {
  const compiled = compileImplicit(TREES.blobs, {});
  await setFullCoreForTesting(false);
  setFullCoreRequired(true);
  let code;
  try { meshImplicit(compiled, 1, { tier: "preview" }); } catch (e) { code = e.code; }
  expect(code).toBe(NEEDS_FULL_CORE);
  expect(core().poisoned).toBe(false);
  await loadFullCore();
  expect(meshImplicit(compiled, 1, { tier: "preview" }).indices.length).toBeGreaterThan(0);
  // A realm whose load failed never throws: its JS is the answer.
  await setFullCoreForTesting("failed");
  expect(meshImplicit(compiled, 1, { tier: "preview" }).indices.length).toBeGreaterThan(0);
});

test("a base instance something holds survives the load, and is replaced once released", async () => {
  await setFullCoreForTesting(false);
  const cache = coreBVHCache();
  cachedBVH(tet, cache);
  const base = core();
  expect(base.full).toBe(false);
  expect(base.live).toBeGreaterThan(0);
  await loadFullCore();
  expect(core()).toBe(base);       // a live BVH pins it
  expect(fullCore()).toBeNull();   // so the implicit engine waits (its JS answers)
  disposeBVHs(cache.values());
  releaseIfIdle(base);
  const next = core();
  expect(next).not.toBe(base);
  expect(next.full).toBe(true);
});

test("loadFullCore is idempotent", async () => {
  await setFullCoreForTesting(false);
  const [a, b] = await Promise.all([loadFullCore(), loadFullCore()]);
  expect([a, b]).toEqual([true, true]);
  expect(await loadFullCore()).toBe(true);
});

// The point of the split: nothing a worker loads at boot, and nothing the base passes
// import, reaches the full build except through core.js's dynamic import.
test("core-full-wasm.js is reached only by core.js's dynamic import", () => {
  const eager = walk(`${ROOT}/src/framework/core/core.js`, "core eager walk", { eager: true }).files;
  expect([...eager].some((f) => f.endsWith("/core-full-wasm.js"))).toBe(false);
  expect([...eager].some((f) => f.endsWith("/core-wasm.js"))).toBe(true);
  for (const entry of ["src/framework/worker.js", "src/framework/geometry/manifold-backend.js", "src/oracle.js"]) {
    const files = walk(`${ROOT}/${entry}`, "full-core eager walk", { eager: true }).files;
    expect([...files].some((f) => f.endsWith("/core-full-wasm.js")), `${entry} loads the full core eagerly`).toBe(false);
  }
});
