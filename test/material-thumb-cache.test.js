// test/material-thumb-cache.test.js
import { describe, it, expect } from "vitest";
import { createMaterialThumbCache, thumbDisplay } from "../src/framework/materials/thumb-cache.js";

describe("material thumbnail cache", () => {
  it("keys on material, colour, environment, theme and mode; ignores finish overrides", () => {
    const c = createMaterialThumbCache();
    const a = c.key({ material: "pla-print", color: 0x112233, roughness: 0.2 }, "studio", "dark", "realistic");
    const b = c.key({ material: "pla-print", color: 0x112233, roughness: 0.9 }, "studio", "dark", "realistic");
    expect(a).toBe(b);
    expect(c.key({ material: "pla-print" }, "studio", "dark", "realistic")).not.toBe(a);
    expect(c.key({ material: "pla-print", color: 0x112233 }, "workshop", "dark", "realistic")).not.toBe(a);
    expect(c.key({ material: "pla-print", color: 0x112233 }, "studio", "light", "realistic")).not.toBe(a);
    expect(c.key({ material: "pla-print", color: 0x112233 }, "studio", "dark", "cad")).not.toBe(a);
  });
  it("an untintable preset's key ignores the colour (one sphere for every part); a tintable one keeps it", () => {
    const c = createMaterialThumbCache();
    const brass = c.key({ material: "brass" }, "studio", "dark", "cad");
    expect(c.key({ material: "brass", color: 0xff0000 }, "studio", "dark", "cad")).toBe(brass);
    expect(c.key({ material: "oak", color: 0x00ff00 }, "studio", "dark", "cad")).toBe(c.key({ material: "oak" }, "studio", "dark", "cad"));
    expect(c.key({ color: 0xff0000 }, "studio", "dark", "cad")).not.toBe(c.key({}, "studio", "dark", "cad"));
  });
  it("evicts the oldest past 120 entries and clears", () => {
    const c = createMaterialThumbCache();
    for (let i = 0; i < 125; i++) c.set(`k${i}`, `u${i}`);
    expect(c.get("k0")).toBeUndefined();
    expect(c.get("k124")).toBe("u124");
    c.clear();
    expect(c.get("k124")).toBeUndefined();
  });
  it("the display a thumbnail is built from holds only the key's material and colour", () => {
    expect(thumbDisplay({ material: "pla-print", color: 0x112233, roughness: 1, metalness: 0.5, clearcoat: 1, opacity: 0.3, hidden: true }))
      .toEqual({ material: "pla-print", color: 0x112233 });
    expect(thumbDisplay({ material: "pla-print", color: 0xff0000 })).toEqual({ material: "pla-print", color: 0xff0000 });
    expect(thumbDisplay({ material: "brass", color: 0xff0000 })).toEqual({ material: "brass" });
    expect(thumbDisplay({ material: "oak", color: 0x112233 })).toEqual({ material: "oak" });
    expect(thumbDisplay({ color: 0x112233 })).toEqual({ material: undefined, color: 0x112233 });
    expect(thumbDisplay({ material: "brass", roughness: 0.1 })).toEqual({ material: "brass" });
    expect(thumbDisplay(null)).toEqual({ material: undefined });
  });
});
