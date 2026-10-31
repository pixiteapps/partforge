// The world-anchored preview grid and the sample cache (sample-cache.js): a preview build
// anchors its grid to a world lattice so a leaf whose program, textures, world cell and edge
// are unchanged can take its samples from the previous pose — and a warm build is the same
// bytes as a cold one. The native core does not take the cache yet (core off here).
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { setCoreEnabled } from "../src/framework/core/core.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { planLeaves, LEAF, TOP } from "../src/framework/geometry/implicit/sparse.js";
import { createSampleCache, leafKeys, SAMPLE_CACHE_BYTES } from "../src/framework/geometry/implicit/sample-cache.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { TWO_BONE } from "./fixtures/skin-fixtures.js";
import { handSpec } from "./fixtures/implicit-trees.js";

beforeAll(() => setCoreEnabled(false));
afterAll(() => setCoreEnabled(true));

const digest = (o) => {
  const h = createHash("sha256");
  for (const k of ["positions", "indices", "normals"]) h.update(Buffer.from(o[k].buffer, o[k].byteOffset, o[k].byteLength));
  return h.digest("hex");
};

test("an anchored plan sits on the world lattice; an unanchored plan is unchanged", () => {
  const c = compileImplicit(TWO_BONE(0)), a = planLeaves(c, 1, { anchor: true }), u = planLeaves(c, 1);
  expect(a.base.every((b) => Number.isInteger(b) && b % TOP === 0)).toBe(true);
  expect(a.origin).toEqual(a.base.map((b) => b * 1));
  expect(u.base).toBeNull();
  expect(u.origin).toEqual(c.bounds.min.map((v) => v - 2));   // the pre-change formula, pad = 2·edge
});

test("leaf keys: outer-layer leaves have none; a shared interior cell keys the same under two poses", () => {
  const pA = planLeaves(compileImplicit(TWO_BONE(0)), 1, { anchor: true });
  const kA = leafKeys(pA);
  expect(kA).toHaveLength(pA.leaves.length);
  const { n } = pA;
  pA.leaves.forEach(({ i0, j0, l0 }, q) => {
    const outer = i0 < 1 || j0 < 1 || l0 < 1 || i0 + LEAF > n[0] - 2 || j0 + LEAF > n[1] - 2 || l0 + LEAF > n[2] - 2;
    expect(kA[q] === null, `leaf ${q}`).toBe(outer);
  });
  expect(kA.some((k) => k !== null)).toBe(true);
  const kB = new Set(leafKeys(planLeaves(compileImplicit(TWO_BONE(40)), 1, { anchor: true })));
  expect(kA.some((k) => k !== null && kB.has(k))).toBe(true);
  // An unanchored plan keys nothing.
  expect(leafKeys(planLeaves(compileImplicit(TWO_BONE(0)), 1)).every((k) => k === null)).toBe(true);
});

test("warm == cold: a frames-only pose change reuses samples and meshes the same bytes", () => {
  const cold = meshImplicit(compileImplicit(TWO_BONE(40)), 1, { tier: "preview", cache: createSampleCache() });
  expect(cold.stats.cacheHits).toBe(0);
  const cache = createSampleCache();
  meshImplicit(compileImplicit(TWO_BONE(0)), 1, { tier: "preview", cache });
  const warm = meshImplicit(compileImplicit(TWO_BONE(40)), 1, { tier: "preview", cache });
  expect(warm.stats.cacheHits).toBeGreaterThan(0);
  expect(digest(warm)).toBe(digest(cold));
  // The same pose again hits every keyed leaf, still the same bytes.
  const again = meshImplicit(compileImplicit(TWO_BONE(40)), 1, { tier: "preview", cache });
  expect(again.stats.cacheHits).toBeGreaterThan(warm.stats.cacheHits);
  expect(digest(again)).toBe(digest(cold));
});

test("the hand reuses samples across a one-finger flex, byte for byte", () => {
  const bent = handSpec({ flex: { index: 62 } });
  const cold = meshImplicit(compileImplicit(bent), 1.5, { tier: "preview", cache: createSampleCache() });
  const cache = createSampleCache();
  meshImplicit(compileImplicit(handSpec()), 1.5, { tier: "preview", cache });
  const warm = meshImplicit(compileImplicit(bent), 1.5, { tier: "preview", cache });
  expect(warm.stats.cacheHits).toBeGreaterThan(0);
  expect(digest(warm)).toBe(digest(cold));
  for (const k of ["vertOwner", "triOwner"]) {
    if (cold[k]) expect(Buffer.compare(Buffer.from(warm[k].buffer), Buffer.from(cold[k].buffer)), k).toBe(0);
  }
}, 120_000);

test("no cache: no anchor, and the result is byte-identical to before", () => {
  expect(planLeaves(compileImplicit(TWO_BONE(0)), 1).base).toBeNull();
  expect(meshImplicit(compileImplicit(TWO_BONE(0)), 1, { tier: "preview" }).stats.cacheHits).toBe(0);
});

test("the cache evicts by age within its byte bound", () => {
  expect(SAMPLE_CACHE_BYTES).toBe(64 * 2 ** 20);
  const c = createSampleCache({ maxBytes: 1500 });
  for (const k of ["a", "b", "c", "d"]) c.put(k, { vals: new Float32Array(125), owner: null });
  expect(c.has("a")).toBe(false); expect(c.has("d")).toBe(true); expect(c.bytes).toBeLessThanOrEqual(1500);
  expect(c.size).toBe(3);
  // A get refreshes an entry's age: "b" survives the next put, "c" does not.
  expect(c.get("b")).toBeDefined();
  c.put("e", { vals: new Float32Array(125), owner: new Int8Array(125) });
  expect(c.has("b")).toBe(true); expect(c.has("c")).toBe(false);
  expect(c.bytes).toBe(500 + 625);
  expect(c.get("zz")).toBeUndefined();
  expect(c.stats()).toEqual({ hits: 1, misses: 1 });
  c.resetStats(); expect(c.stats()).toEqual({ hits: 0, misses: 0 });
  c.clear(); expect(c.size).toBe(0); expect(c.bytes).toBe(0);
});

test("the Manifold preview kernel reuses samples across a frames-only rebuild; the print kernel never caches", async () => {
  const k = await bootManifoldKernel(); k.beginSubPart("t");
  k.implicit(TWO_BONE(0)); k.implicit(TWO_BONE(40));
  expect(k._sampleCache.stats().hits).toBeGreaterThan(0);
  const kp = await bootManifoldKernel({ quality: "print" }); kp.beginSubPart("t"); kp.implicit(TWO_BONE(0)); kp.implicit(TWO_BONE(40));
  expect(kp._sampleCache.size).toBe(0);
});
