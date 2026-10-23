import { describe, test, expect } from "vitest";
import { makeTexture, sampleTexture, checkTextureBudget } from "../src/framework/geometry/implicit/textures.js";

const img = (w, h, f) => {
  const data = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.round(f(x, y) * 65535);
  return { digest: `d${w}x${h}`, width: w, height: h, data };
};

describe("textures", () => {
  test("bilinear sampling hits texel centres exactly and interpolates between them", () => {
    const t = makeTexture(img(3, 2, (x, y) => (x + 3 * y) / 5));
    expect(sampleTexture(t, 0, 0)).toBeCloseTo(0, 6);
    expect(sampleTexture(t, 1, 0)).toBeCloseTo(2 / 5, 6);
    expect(sampleTexture(t, 0, 1)).toBeCloseTo(3 / 5, 6);    // row 1 is v = 1 (heightfield convention)
    expect(sampleTexture(t, 0.25, 0)).toBeCloseTo(0.5 / 5, 6);
  });
  test("uv clamps and NaN reads as 0", () => {
    const t = makeTexture(img(2, 2, () => 1));
    expect(sampleTexture(t, -5, 9)).toBeCloseTo(1, 6);
    expect(sampleTexture(t, NaN, NaN)).toBeCloseTo(1, 6);
  });
  test("budget: per-side and per-part caps", () => {
    expect(() => checkTextureBudget([{ width: 4096, height: 2, digest: "a" }])).toThrow(/2048/);
    const big = { width: 2048, height: 2048, digest: "b" };
    expect(() => checkTextureBudget([big, big, big, big])).not.toThrow();
    expect(() => checkTextureBudget([big, big, big, big, { width: 2, height: 2, digest: "c" }])).toThrow(/16777216/);
  });
});
