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
  // Goldens: the spike's shader maths (linear-space mix), read back as bytes.
  const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
  it("white goes to a blue-grey shadow, as the spike drew it", () => {
    const t = celTones(0xeef1f4);
    expect(t.lit).toBe(0xeef1f4);
    expect(rgb(t.shadow)).toEqual([193, 210, 218]);
    expect(rgb(t.deep)).toEqual([164, 179, 186]);
    expect(t.shadow & 255).toBeGreaterThan((t.shadow >> 16) & 255); // blue > red
  });
  it("a saturated red keeps red dominant in its shadow", () => {
    const t = celTones(0xe8442c);
    expect(rgb(t.shadow)).toEqual([163, 99, 125]);
    expect(rgb(t.deep)).toEqual([139, 83, 106]);
    expect((t.shadow >> 16) & 255).toBeGreaterThan(t.shadow & 255);
  });
  it("a dark slate", () => {
    const t = celTones(0x5b6577);
    expect(rgb(t.shadow)).toEqual([75, 87, 111]);
    expect(rgb(t.deep)).toEqual([63, 73, 94]);
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
