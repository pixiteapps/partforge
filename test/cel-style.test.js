import { describe, it, expect } from "vitest";
import { CEL, CEL_BODY, celBase, celTones } from "../src/framework/cel/cel-style.js";
import { cadAppearance } from "../src/framework/materials/resolve.js";

describe("celBase", () => {
  it("is the body white when the display names no colour and no material", () => {
    expect(celBase(undefined)).toBe(CEL_BODY);
    expect(celBase({})).toBe(CEL_BODY);
  });
  it("is the effective CAD colour when a colour or material is named", () => {
    expect(celBase({ color: 0xe8442c })).toBe(0xe8442c);
    expect(celBase({ material: "brass" })).toBe(cadAppearance({ material: "brass" }).color);
  });
});
describe("celTones", () => {
  const luma = (h) => 0.2126 * ((h >> 16) & 255) + 0.7152 * ((h >> 8) & 255) + 0.0722 * (h & 255);
  it("white goes to a blue-grey shadow: darker than lit, bluer than it, deep darker still", () => {
    const t = celTones(0xeef1f4);
    expect(t.lit).toBe(0xeef1f4);
    expect(luma(t.shadow)).toBeLessThan(luma(t.lit) * 0.8);
    expect(t.shadow & 255).toBeGreaterThan((t.shadow >> 16) & 255); // blue > red
    expect(luma(t.deep)).toBeCloseTo(luma(t.shadow) * CEL.shadow.deepDarken, -1);
  });
  it("a saturated red keeps red dominant in its shadow", () => {
    const t = celTones(0xe8442c);
    expect((t.shadow >> 16) & 255).toBeGreaterThan(t.shadow & 255);
  });
  it("black stays black", () => {
    expect(celTones(0x000000)).toEqual({ lit: 0, shadow: 0, deep: 0 });
  });
  it("constants are frozen and in range", () => {
    expect(Object.isFrozen(CEL) && Object.isFrozen(CEL.ink)).toBe(true);
    expect(CEL.ink.thickPx).toBe(0.7); expect(CEL.ink.thinPx).toBe(0.3); expect(CEL.ground.opacity).toBe(0.3);
    expect(CEL.bands.count).toBe(3); expect(CEL.field.color).toBe(0x9fd9ea);
  });
});
