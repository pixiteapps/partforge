import { describe, expect, it } from "vitest";
import { triangleCount, triangleOffsets } from "../src/framework/softrender/triangles.js";
import { contactShadowMask, sampleShadowMask } from "../src/framework/contact-shadow.js";

const SHADOW = { opacity: 0.25, falloff: 0.15, blur: 0.03, resolution: 64 };
// A flat square at height h (world Y), as a soup of two triangles.
const quad = (h, s = 10) => ({ positions: new Float32Array([
  -s, h, -s, s, h, -s, s, h, s,
  -s, h, -s, s, h, s, -s, h, s,
]) });

describe("triangles", () => {
  it("counts and indexes soup and indexed meshes the same way (Review Focus 4)", () => {
    const soup = quad(0);
    expect(triangleCount(soup)).toBe(2);
    expect(triangleOffsets(soup, 1)).toEqual([9, 12, 15]);
    const indexed = { positions: new Float32Array(12), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
    expect(triangleCount(indexed)).toBe(2);
    expect(triangleOffsets(indexed, 1)).toEqual([0, 6, 9]);
  });
});

describe("contactShadowMask", () => {
  const box = { min: [-10, 0, -10], max: [10, 20, 10] };

  it("is dark under geometry touching the floor and fades with height", () => {
    const low = contactShadowMask([quad(0)], box, SHADOW);
    const high = contactShadowMask([quad(2)], box, SHADOW);
    expect(sampleShadowMask(low, 0, 0)).toBeGreaterThan(0.9);
    expect(sampleShadowMask(high, 0, 0)).toBeLessThan(sampleShadowMask(low, 0, 0));
    // falloff = 0.15 · diag ≈ 5 mm: geometry 10 mm up casts nothing
    expect(sampleShadowMask(contactShadowMask([quad(10)], box, SHADOW), 0, 0)).toBe(0);
  });

  it("is zero outside the padded footprint and soft at its edge", () => {
    const m = contactShadowMask([quad(0)], box, SHADOW);
    expect(sampleShadowMask(m, 100, 0)).toBe(0);
    const edge = sampleShadowMask(m, 10, 0);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(0.9);
    expect(m.y).toBe(0);
    expect(m.rect.x0).toBeLessThan(-10);
  });

  it("row j runs along +z", () => {
    // geometry only on the +z half → high rows dark, low rows clear
    const half = { positions: new Float32Array([-10, 0, 1, 10, 0, 1, 10, 0, 10, -10, 0, 1, 10, 0, 10, -10, 0, 10]) };
    const m = contactShadowMask([half], box, SHADOW);
    const mid = Math.floor(m.width / 2);
    expect(m.data[(m.height - 3) * m.width + mid]).toBeGreaterThan(m.data[2 * m.width + mid]);
  });

  it("returns null for a zero-size box and copes with a zero-height part (Review Focus 1)", () => {
    expect(contactShadowMask([quad(0)], { min: [0, 0, 0], max: [0, 0, 0] }, SHADOW)).toBeNull();
    const flat = contactShadowMask([quad(0)], { min: [-10, 0, -10], max: [10, 0, 10] }, SHADOW);
    expect(sampleShadowMask(flat, 0, 0)).toBeGreaterThan(0.9);
  });
});
