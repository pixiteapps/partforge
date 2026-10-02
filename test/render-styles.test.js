import { describe, expect, it } from "vitest";
import {
  RENDER_STYLES, getRenderStyle, validateRenderStyle, srgbHexToLinear, SRGB8,
  CAD_LIGHT_THEME, CAD_DARK_THEME,
} from "../src/framework/renderStyles.js";

describe("render styles", () => {
  it("cad carries exactly today's capture lighting and material", () => {
    const { lights, material, camera } = RENDER_STYLES.cad;
    expect(lights.hemisphere).toEqual({ sky: 0xdce9ff, ground: 0x687586, intensity: 1.35 });
    expect(lights.key).toEqual({ color: 0xffffff, intensity: 1.45, offset: { right: 0.45, up: 0.75 } });
    expect(lights.fill).toEqual({ color: 0xe5efff, intensity: 0.65, offset: { right: -0.7, up: 0.15 } });
    expect(material).toEqual({ color: 0x9fb4cc, metalness: 0.25, roughness: 0.55 });
    expect(camera).toEqual({ projection: "perspective", fov: 45, framing: "canonical" });
    expect(RENDER_STYLES.cad.background).toBe(CAD_LIGHT_THEME.bg);
    expect(RENDER_STYLES.cad.edges).toEqual({ color: CAD_LIGHT_THEME.line, widthPx: 1, opacity: 1 });
    expect(RENDER_STYLES.cad.shadow).toBeNull();
  });

  it("thumbnail shares cad's material (the viewer reuses its CAD material for it)", () => {
    expect(RENDER_STYLES.thumbnail.material).toEqual(RENDER_STYLES.cad.material);
    expect(RENDER_STYLES.thumbnail.view).toBe("iso");
    expect(RENDER_STYLES.thumbnail.camera.framing).toBe("fit");
    expect(RENDER_STYLES.thumbnail.shadow).not.toBeNull();
  });

  it("styles are frozen all the way down", () => {
    expect(Object.isFrozen(RENDER_STYLES.cad.lights.key.offset)).toBe(true);
  });

  it("getRenderStyle resolves names and refuses unknown ones", () => {
    expect(getRenderStyle("cad")).toBe(RENDER_STYLES.cad);
    expect(getRenderStyle(RENDER_STYLES.thumbnail)).toBe(RENDER_STYLES.thumbnail);
    expect(() => getRenderStyle("realistic")).toThrow(/unknown render style/);
  });

  it("validateRenderStyle names the bad field", () => {
    const bad = structuredClone(RENDER_STYLES.cad);
    bad.material.roughness = 2;
    expect(() => validateRenderStyle(bad)).toThrow(/material\.roughness/);
    const bad2 = structuredClone(RENDER_STYLES.thumbnail);
    bad2.camera.fill = 0;
    expect(() => validateRenderStyle(bad2)).toThrow(/camera\.fill/);
    const bad3 = structuredClone(RENDER_STYLES.cad);
    bad3.camera.projection = "orthographic";
    expect(() => validateRenderStyle(bad3)).toThrow(/camera\.projection/);
  });

  it("srgbHexToLinear matches the sRGB transfer function", () => {
    expect(srgbHexToLinear(0xffffff)).toEqual([1, 1, 1]);
    expect(srgbHexToLinear(0x000000)).toEqual([0, 0, 0]);
    const [r] = srgbHexToLinear(0x808080);
    expect(r).toBeCloseTo(0.2158605, 6);
  });

  it("SRGB8 is the encode LUT (moved, not changed)", () => {
    expect(SRGB8[0]).toBe(0);
    expect(SRGB8[255]).toBe(255);
    expect(SRGB8[55]).toBe(Math.round(255 * (1.055 * (55 / 255) ** (1 / 2.4) - 0.055)));
  });

  it("theme constants keep the viewer's values", () => {
    expect(CAD_DARK_THEME).toEqual({ bg: 0x15181d, line: 0x1c232d });
  });
});
