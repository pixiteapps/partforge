import { describe, it, expect } from "vitest";
import { CEL, CEL_BODY, celBase, celTones, celField, celLightView, celLightWorld, celGroundLightWorld } from "../src/framework/cel/cel-style.js";
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
  // Goldens: the spike's shader maths (linear-space mix), read back as bytes —
  // at tintAmount 0.25 (2026-11-08: the spike's 0.5 turned a warm part's shadow
  // mauve, so its lit faces read as a highlight of another colour).
  const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
  it("white goes to a blue-grey shadow, as the spike drew it", () => {
    const t = celTones(0xeef1f4);
    expect(t.lit).toBe(0xeef1f4);
    expect(rgb(t.shadow)).toEqual([201, 211, 216]);
    expect(rgb(t.deep)).toEqual([171, 180, 184]);
    expect(t.shadow & 255).toBeGreaterThan((t.shadow >> 16) & 255); // blue > red
  });
  it("a saturated red keeps red dominant in its shadow", () => {
    const t = celTones(0xe8442c);
    expect(rgb(t.shadow)).toEqual([184, 81, 94]);
    expect(rgb(t.deep)).toEqual([157, 68, 79]);
    expect((t.shadow >> 16) & 255).toBeGreaterThan(t.shadow & 255);
  });
  it("a dark slate", () => {
    const t = celTones(0x5b6577);
    expect(rgb(t.shadow)).toEqual([77, 87, 107]);
    expect(rgb(t.deep)).toEqual([64, 73, 91]);
  });
  it("black stays black", () => {
    expect(celTones(0x000000)).toEqual({ lit: 0, shadow: 0, deep: 0 });
  });
  it("constants are frozen and in range", () => {
    expect(Object.isFrozen(CEL) && Object.isFrozen(CEL.ink)).toBe(true);
    expect(CEL.ink.thickPx).toBe(0.7); expect(CEL.ink.thinPx).toBe(0.3); expect(CEL.ground.opacity).toBe(0.3);
    expect(CEL.bands.count).toBe(3); expect(CEL.field.color).toBe(0x9fd9ea); expect(CEL.field.darkColor).toBe(0x273648);
  });
  it("CEL.light.at is the viewer's default camera, 25° up — not a pure iso", () => {
    const [x, y, z] = CEL.light.at.dir;
    expect([x, y, z]).toEqual([18, 12, 18]);
    expect(Math.atan2(y, Math.hypot(x, z)) * 180 / Math.PI).toBeCloseTo(25.2, 0);
  });
});

describe("celField", () => {
  const luma = (hex) => 0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255);
  it("the light theme is the pale cyan with a darker dot", () => {
    const f = celField("light");
    expect(f.color).toBe(CEL.field.color);
    expect(luma(f.dot)).toBeLessThan(luma(f.color));
  });
  it("the dark theme is the slate with a lighter dot, and darker than the ink is not", () => {
    const f = celField("dark");
    expect(f.color).toBe(CEL.field.darkColor);
    expect(luma(f.dot)).toBeGreaterThan(luma(f.color));
    expect(luma(f.color)).toBeGreaterThan(luma(CEL.ink.color) + 20); // the outer contour still reads on it
  });
  it("anything but \"dark\" is the light field", () => {
    expect(celField(undefined)).toEqual(celField("light"));
    expect(celField("nope")).toEqual(celField("light"));
  });
});

describe("the key light's frame", () => {
  const unit = (v) => { const n = Math.hypot(...v); return v.map((c) => c / n); };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  it("the view-space key is up-left of the viewer and in front of the part", () => {
    const [x, y, z] = celLightView();
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
    expect(x).toBeLessThan(0); expect(y).toBeGreaterThan(0); expect(z).toBeGreaterThan(0);
    expect(Math.asin(y) * 180 / Math.PI).toBeCloseTo(CEL.light.elevationDeg, 9);
  });
  it("the world key is the view key seen from CEL.light.at (the default camera), a unit vector above the horizon", () => {
    const w = celLightWorld();
    expect(Math.hypot(...w)).toBeCloseTo(1, 9);
    expect(w[1]).toBeGreaterThan(0);
    // Rebuild that camera's basis and read the world key back in view space.
    const z = unit(CEL.light.at.dir);
    const up = CEL.light.at.up;
    const x = unit([up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const back = [dot(w, x), dot(w, y), dot(w, z)];
    const view = celLightView();
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(view[i], 9);
  });
  it("the ground light shares the world key's azimuth at the ground elevation", () => {
    const g = celGroundLightWorld(), k = celLightWorld();
    expect(Math.hypot(...g)).toBeCloseTo(1, 9);
    expect(Math.asin(g[1]) * 180 / Math.PI).toBeCloseTo(CEL.ground.elevationDeg, 9);
    expect(Math.atan2(g[0], g[2])).toBeCloseTo(Math.atan2(k[0], k[2]), 9);
  });
});
