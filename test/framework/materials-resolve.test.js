import { expect, test } from "vitest";
import { PRESETS, DEFAULT_PRESET_ID } from "../../src/framework/materials/presets.js";
import { ENVIRONMENTS, DEFAULT_ENVIRONMENT_ID } from "../../src/framework/materials/environments.js";
import {
  OVERRIDE_RANGES, DISPLAY_KEYS, resolveMaterial, cadAppearance, printColor,
  declaresMaterials, resolveEnvironmentId,
} from "../../src/framework/materials/resolve.js";

const LISTED = [
  "machined-aluminum", "brushed-aluminum", "anodized-aluminum", "bead-blasted-aluminum",
  "brushed-stainless", "polished-chrome", "black-oxide-steel", "cast-iron", "titanium",
  "brass", "copper", "bronze", "powder-coat", "painted-metal",
  "pla-print", "petg-print", "resin-print", "nylon-sls",
  "abs-plastic", "clear-acrylic", "rubber", "oak", "walnut", "carbon-fiber",
];

test("the library lists exactly the 24 spec presets plus the hidden default", () => {
  expect(Object.keys(PRESETS).sort()).toEqual([...LISTED, DEFAULT_PRESET_ID].sort());
});

test("every preset is physically plausible and self-consistent", () => {
  for (const p of Object.values(PRESETS)) {
    expect(p.id, p.id).toBe(Object.keys(PRESETS).find((k) => PRESETS[k] === p));
    expect(Number.isInteger(p.color) && p.color >= 0 && p.color <= 0xffffff, p.id).toBe(true);
    for (const k of ["metalness", "roughness"]) expect(p[k] >= 0 && p[k] <= 1, `${p.id}.${k}`).toBe(true);
    expect(typeof p.tintable, p.id).toBe("boolean");
    expect(typeof p.use === "string" && p.use.length > 10, p.id).toBe(true);
  }
});

test("exactly the spec's tintable presets are tintable", () => {
  const tintable = Object.values(PRESETS).filter((p) => p.tintable).map((p) => p.id).sort();
  expect(tintable).toEqual([
    "abs-plastic", "anodized-aluminum", "clear-acrylic", "nylon-sls", "painted-metal",
    "petg-print", "pla-print", "powder-coat", "resin-print", "rubber",
  ]);
});

test("the four environments exist and studio is the default", () => {
  expect(Object.keys(ENVIRONMENTS).sort()).toEqual(["outdoor", "print-bed", "studio", "workshop"]);
  expect(DEFAULT_ENVIRONMENT_ID).toBe("studio");
});

test("no display → the default preset, no issues", () => {
  const r = resolveMaterial(undefined);
  expect(r.preset.id).toBe(DEFAULT_PRESET_ID);
  expect(r.issues).toEqual([]);
  expect(r.params.color).toBe(0x9fb4cc);
});

test("color tints a preset; overrides replace values", () => {
  const r = resolveMaterial({ material: "abs-plastic", color: 0xff0000, roughness: 0.25 });
  expect(r.params.color).toBe(0xff0000);
  expect(r.params.roughness).toBe(0.25);
  expect(r.params.metalness).toBe(PRESETS["abs-plastic"].metalness);
  expect(r.issues).toEqual([]);
});

test("an unknown preset falls back to the default and reports it", () => {
  const r = resolveMaterial({ material: "unobtanium" });
  expect(r.preset.id).toBe(DEFAULT_PRESET_ID);
  expect(r.issues).toEqual([{ kind: "unknown-material", key: "material", value: "unobtanium" }]);
});

test("an out-of-range override clamps and reports it", () => {
  const r = resolveMaterial({ material: "brass", roughness: 7 });
  expect(r.params.roughness).toBe(OVERRIDE_RANGES.roughness[1]);
  expect(r.issues).toEqual([{ kind: "material-override-clamped", key: "roughness", value: 7, clampedTo: 1 }]);
});

test("a non-numeric override is ignored and reported as clamped to the preset value", () => {
  const r = resolveMaterial({ material: "brass", roughness: "shiny" });
  expect(r.params.roughness).toBe(PRESETS.brass.roughness);
  expect(r.issues[0]).toMatchObject({ kind: "material-override-clamped", key: "roughness" });
});

test("an unknown display key is reported, never applied", () => {
  const r = resolveMaterial({ material: "brass", transmission: 1, sparkle: true });
  expect(r.params.transmission).toBe(PRESETS.brass.transmission ?? 0);
  expect(r.issues.map((i) => i.key).sort()).toEqual(["sparkle", "transmission"]);
  expect(r.issues.every((i) => i.kind === "material-key-unknown")).toBe(true);
});

test("DISPLAY_KEYS covers color, opacity, material and the six overrides", () => {
  expect([...DISPLAY_KEYS].sort()).toEqual(
    ["anisotropy", "clearcoat", "clearcoatRoughness", "color", "material", "metalness", "opacity", "roughness", "textureScale"],
  );
});

test("cadAppearance lifts very dark materials to a minimum luminance", () => {
  const dark = cadAppearance({ material: "rubber", color: 0x000000 });
  const r = (dark.color >> 16) & 255, g = (dark.color >> 8) & 255, b = dark.color & 255;
  expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThanOrEqual(60);
});

test("cadAppearance keeps a legacy color-only display exactly as today", () => {
  expect(cadAppearance({ color: 0x1e88e5 })).toEqual({ color: 0x1e88e5, metalness: 0.25, roughness: 0.55, opacity: 1 });
  expect(cadAppearance(undefined)).toEqual({ color: 0x9fb4cc, metalness: 0.25, roughness: 0.55, opacity: 1 });
});

test("cadAppearance flattens metalness so metals stay readable without an environment", () => {
  const chrome = cadAppearance({ material: "polished-chrome" });
  expect(chrome.metalness).toBeLessThanOrEqual(0.5);
  expect(chrome.roughness).toBeGreaterThanOrEqual(0.3);
});

test("printColor: null without color/material, tint first, then preset colour", () => {
  expect(printColor(undefined)).toBeNull();
  expect(printColor({ opacity: 0.3 })).toBeNull();
  expect(printColor({ color: 0x123456 })).toBe(0x123456);
  expect(printColor({ material: "brass" })).toBe(PRESETS.brass.color);
  expect(printColor({ material: "pla-print", color: 0xff0000 })).toBe(0xff0000);
});

test("declaresMaterials is true only when some sub-part names a material", () => {
  expect(declaresMaterials({ parts: { a: { display: { color: 1 } } } })).toBe(false);
  expect(declaresMaterials({ parts: { a: {}, b: { display: { material: "brass" } } } })).toBe(true);
  expect(declaresMaterials({})).toBe(false);
});

test("resolveEnvironmentId falls back to studio", () => {
  expect(resolveEnvironmentId("workshop")).toEqual({ id: "workshop", known: true });
  expect(resolveEnvironmentId("moon")).toEqual({ id: "studio", known: false });
  expect(resolveEnvironmentId(undefined)).toEqual({ id: "studio", known: true });
});
