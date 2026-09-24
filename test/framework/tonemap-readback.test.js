import { expect, test } from "vitest";
import { neutralToneMapToSrgb8 } from "../../src/framework/materials/tonemap-readback.js";

const px = (r, g, b) => new Float32Array([r, g, b, 1]);

test("black stays black, alpha becomes opaque", () => {
  expect([...neutralToneMapToSrgb8(px(0, 0, 0), 1)]).toEqual([0, 0, 0, 255]);
});
test("mid-grey below the compression knee is only sRGB-encoded (after the toe offset)", () => {
  // 0.18 is past the toe (>= 0.08), so the offset is 0.04: 0.14 linear, below
  // the 0.76 knee, sRGB-encodes to 0.410 → 105 (Khronos PBR Neutral, by hand).
  const [r, g, b] = neutralToneMapToSrgb8(px(0.18, 0.18, 0.18), 1);
  expect(r).toBe(g); expect(g).toBe(b);
  expect(r).toBeGreaterThan(100); expect(r).toBeLessThan(110);
});
test("bright highlights compress below white instead of clipping", () => {
  const [r] = neutralToneMapToSrgb8(px(4, 4, 4), 1);
  expect(r).toBeLessThan(256); expect(r).toBeGreaterThan(245);
});
test("exposure scales before tone mapping", () => {
  expect(neutralToneMapToSrgb8(px(0.1, 0.1, 0.1), 2)[0]).toBeGreaterThan(neutralToneMapToSrgb8(px(0.1, 0.1, 0.1), 1)[0]);
});
