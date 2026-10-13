// test/material-thumb-cache.test.js
import { describe, it, expect } from "vitest";
import { createMaterialThumbCache } from "../src/framework/materials/thumb-cache.js";

describe("material thumbnail cache", () => {
  it("keys on material, colour, environment, theme and mode; ignores finish overrides", () => {
    const c = createMaterialThumbCache();
    const a = c.key({ material: "oak", color: 0x112233, roughness: 0.2 }, "studio", "dark", "realistic");
    const b = c.key({ material: "oak", color: 0x112233, roughness: 0.9 }, "studio", "dark", "realistic");
    expect(a).toBe(b);
    expect(c.key({ material: "oak" }, "studio", "dark", "realistic")).not.toBe(a);
    expect(c.key({ material: "oak", color: 0x112233 }, "workshop", "dark", "realistic")).not.toBe(a);
    expect(c.key({ material: "oak", color: 0x112233 }, "studio", "light", "realistic")).not.toBe(a);
    expect(c.key({ material: "oak", color: 0x112233 }, "studio", "dark", "cad")).not.toBe(a);
  });
  it("evicts the oldest past 120 entries and clears", () => {
    const c = createMaterialThumbCache();
    for (let i = 0; i < 125; i++) c.set(`k${i}`, `u${i}`);
    expect(c.get("k0")).toBeUndefined();
    expect(c.get("k124")).toBe("u124");
    c.clear();
    expect(c.get("k124")).toBeUndefined();
  });
});
