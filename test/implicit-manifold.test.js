import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const ball = { root: { kind: "sphere", r: 10 }, preview: 1 };

describe("k.implicit on Manifold", () => {
  test("a watertight genus-0 solid with the right volume", () => {
    const s = k.implicit(ball);
    const want = (4 / 3) * Math.PI * 1000;
    expect(Math.abs(s.volume() - want) / want).toBeLessThan(0.02);
    if (typeof s.genus === "function") expect(s.genus()).toBe(0);
  });
  test("composes with ordinary booleans", () => {
    const s = k.implicit(ball).cut(k.box([-20, -20, 0], [20, 20, 20]));
    expect(s.boundingBox().max[2]).toBeLessThanOrEqual(1e-6);
  });
  test("cache key: equal specs share a hash, different specs do not", () => {
    expect(k.implicit(ball)._hash).toBe(k.implicit({ ...ball })._hash);
    expect(k.implicit(ball)._hash).not.toBe(k.implicit({ ...ball, root: { kind: "sphere", r: 9 } })._hash);
  });
  test("textures read registered images, and the image digest is in the key", async () => {
    const data = new Uint16Array(16).fill(32768);
    await k._registerImage({ name: "grey", digest: "g1", width: 4, height: 4, data });
    const spec = { root: { kind: "displace", amount: 1, by: { expr: "return texture(t, p.xy * 0.05 + 0.5);", textures: { t: { image: "grey" } } }, child: { kind: "sphere", r: 8 } }, preview: 1 };
    const a = k.implicit(spec);
    await k._registerImage({ name: "grey", digest: "g2", width: 4, height: 4, data: new Uint16Array(16) });
    const b = k.implicit(spec);
    expect(a._hash).not.toBe(b._hash);
    expect(a.volume()).toBeGreaterThan(b.volume());   // grey (0.5) lowers d by 0.5: the surface moves OUT 0.5 mm
  });
  test("an empty result is a clear error", () => {
    expect(() => k.implicit({ root: { kind: "subtract", children: [{ kind: "sphere", r: 2 }, { kind: "sphere", r: 5 }] }, preview: 1 }))
      .toThrow(/implicit: the shape is empty/);
  });
  test("spec errors surface with their path", () => {
    expect(() => k.implicit({ root: { kind: "sphere", r: -1 } })).toThrow(/root\.r: must be a number > 0/);
  });
  test("the cache key ignores the other tier's grid", async () => {
    expect(k.implicit({ ...ball, resolution: 0.4 })._hash).toBe(k.implicit({ ...ball, resolution: 0.6 })._hash);
    expect(k.implicit({ ...ball, preview: 1.2 })._hash).not.toBe(k.implicit(ball)._hash);
    const kp = await bootManifoldKernel({ quality: "print" });
    const small = { root: { kind: "sphere", r: 3 }, resolution: 1 };
    expect(kp.implicit({ ...small, preview: 2 })._hash).toBe(kp.implicit({ ...small, preview: 1.5 })._hash);
    expect(kp.implicit({ ...small, resolution: 0.8 })._hash).not.toBe(kp.implicit(small)._hash);
  });
  test("warnings surface on a cache hit too", () => {
    const thin = { root: { kind: "box", size: [10, 10, 1] }, preview: 0.8 };
    k.beginSubPart("thin");
    k.takeBuildWarnings();
    k.implicit(thin);
    const first = k.takeBuildWarnings();
    const hitsBefore = k.cacheStats().hits;
    k.implicit(thin);
    expect(k.cacheStats().hits).toBe(hitsBefore + 1);
    const second = k.takeBuildWarnings();
    k.endSubPart();
    expect(first.some((w) => /thinnest feature/.test(w))).toBe(true);
    expect(second).toEqual(first);
  });
});

describe("k.implicit contact pieces on Manifold", () => {
  test("one ID per piece", async () => {
    const { handSpec, HAND_POSES } = await import("./fixtures/implicit-trees.js");
    const { bootManifoldKernel: boot } = await import("../src/testing/manifold.js");
    const ke = await boot();
    const spec = handSpec({ ...HAND_POSES.fist, contactGap: 0 });
    const g = ke.implicit(spec)._m.getMesh();
    const ids = [...new Set(g.runOriginalID)];
    g.delete?.();
    expect(ids.length).toBe(6);
    expect(new Set(ids).size).toBe(6);
    const first = Math.min(...ids);
    for (const id of ids) expect(ke._shadingPolicy(id)).toMatchObject({ organic: true, group: first });
  }, 60_000);
  test("by default a root contact's pieces are separate IDs in one group; `exactContact: false` keeps one ID", async () => {
    const { capsulePress } = await import("./fixtures/implicit-seam-cases.js");
    const { bootManifoldKernel: boot } = await import("../src/testing/manifold.js");
    const idsOf = (kernel) => {
      const g = kernel.implicit({ ...capsulePress({ overlap: 1.2 }), preview: 1.5 })._m.getMesh();
      const ids = [...new Set(g.runOriginalID)];
      g.delete?.();
      return ids;
    };
    const exactIds = idsOf(k);
    expect(exactIds.length).toBe(2);
    expect(k._shadingPolicy(exactIds[0]).group).toBeDefined();
    const old = await boot({ exactContact: false });
    const ids = idsOf(old);
    expect(ids.length).toBe(1);
    expect(old._shadingPolicy(ids[0]).group).toBeUndefined();
  }, 60_000);
});
