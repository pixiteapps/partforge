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
  test("Review Focus 5: an empty result is a clear error", () => {
    expect(() => k.implicit({ root: { kind: "subtract", children: [{ kind: "sphere", r: 2 }, { kind: "sphere", r: 5 }] }, preview: 1 }))
      .toThrow(/implicit: the shape is empty/);
  });
  test("spec errors surface with their path", () => {
    expect(() => k.implicit({ root: { kind: "sphere", r: -1 } })).toThrow(/root\.r: must be a number > 0/);
  });
});
