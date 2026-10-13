// test/display-overrides.test.js
import { describe, it, expect } from "vitest";
import {
  APPEARANCE_OVERRIDE_KEYS, VIEWING_KEYS, MIN_USER_OPACITY,
  sanitizeDisplayPatch, mergeOverride, effectiveDisplay, isAppearanceNoop, pruneOverrides, subPartVisibility,
} from "../src/framework/materials/overrides.js";
import { DISPLAY_KEYS } from "../src/framework/materials/resolve.js";

describe("key sets", () => {
  it("appearance keys are DISPLAY_KEYS minus opacity; viewing keys are hidden and opacity", () => {
    expect(APPEARANCE_OVERRIDE_KEYS).toEqual(DISPLAY_KEYS.filter((k) => k !== "opacity"));
    expect(VIEWING_KEYS).toEqual(["hidden", "opacity"]);
  });
});

describe("sanitizeDisplayPatch", () => {
  it("keeps known keys, clamps ranges, floors opacity, drops junk", () => {
    expect(sanitizeDisplayPatch({
      material: "brass", color: 0xb3261e, roughness: 2, metalness: -1, textureScale: 0.001,
      opacity: 0, hidden: 1, bogus: 3, clearcoat: "x",
    })).toEqual({ material: "brass", color: 0xb3261e, roughness: 1, metalness: 0, textureScale: 0.01, opacity: MIN_USER_OPACITY });
  });
  it("keeps hidden only as a real boolean (a host's \"false\" string must not hide the part)", () => {
    expect(sanitizeDisplayPatch({ hidden: true })).toEqual({ hidden: true });
    expect(sanitizeDisplayPatch({ hidden: false })).toEqual({ hidden: false });
    expect(sanitizeDisplayPatch({ hidden: "false" })).toEqual({});
    expect(sanitizeDisplayPatch({ hidden: 1 })).toEqual({});
  });
  it("keeps an unknown material id (resolve.js falls back; lint names it) and drops a non-string one", () => {
    expect(sanitizeDisplayPatch({ material: "unobtainium" })).toEqual({ material: "unobtainium" });
    expect(sanitizeDisplayPatch({ material: 7 })).toEqual({});
  });
  it("drops a colour outside 0..0xffffff and a non-integer", () => {
    expect(sanitizeDisplayPatch({ color: 0x1000000 })).toEqual({});
    expect(sanitizeDisplayPatch({ color: 1.5 })).toEqual({});
  });
  it("passes null through as 'clear' for every key, and reads opacity >= 1 as clear", () => {
    expect(sanitizeDisplayPatch({ material: null, color: null, hidden: null, opacity: 1 })).toEqual({ material: null, color: null, hidden: null, opacity: null });
  });
  it("returns {} for a non-object", () => {
    expect(sanitizeDisplayPatch(null)).toEqual({});
    expect(sanitizeDisplayPatch("x")).toEqual({});
  });
});

describe("mergeOverride", () => {
  it("merges, clears with null, and returns null when empty", () => {
    expect(mergeOverride(null, { material: "oak" })).toEqual({ material: "oak" });
    expect(mergeOverride({ material: "oak", hidden: true }, { material: null })).toEqual({ hidden: true });
    expect(mergeOverride({ hidden: true }, { hidden: false })).toBeNull();
    expect(mergeOverride({ opacity: 0.5 }, { opacity: null })).toBeNull();
  });
  it("hidden: false and opacity 1 are clears, never stored", () => {
    expect(mergeOverride(null, { hidden: false })).toBeNull();
    expect(mergeOverride({ material: "oak" }, { opacity: 1 })).toEqual({ material: "oak" });
  });
});

describe("effectiveDisplay", () => {
  it("merges appearance keys over the authored display and never carries viewing keys", () => {
    const authored = { material: "pla-print", color: 0x112233, opacity: 0.3 };
    expect(effectiveDisplay(authored, { material: "oak", hidden: true, opacity: 0.5 }))
      .toEqual({ material: "oak", color: 0x112233, opacity: 0.3 });
    expect(effectiveDisplay(undefined, null)).toEqual({});
    expect(effectiveDisplay(undefined, { color: 0xff0000 })).toEqual({ color: 0xff0000 });
  });
});

describe("isAppearanceNoop / pruneOverrides", () => {
  const part = { parts: { lid: { display: { material: "oak", color: 0x112233 } }, body: {} } };
  it("is a noop when every appearance key equals the authored value", () => {
    expect(isAppearanceNoop(part.parts.lid.display, { material: "oak", hidden: true })).toBe(true);
    expect(isAppearanceNoop(part.parts.lid.display, { material: "brass" })).toBe(false);
    expect(isAppearanceNoop(undefined, { color: 0x112233 })).toBe(false);
  });
  it("drops unknown names, strips no-op appearance keys, keeps viewing keys, drops empties", () => {
    expect(pruneOverrides({
      lid: { material: "oak", color: 0x112233, hidden: true },
      body: { material: "brass" },
      gone: { material: "oak" },
      base: { color: 0x112233 },
    }, part)).toEqual({ lid: { hidden: true }, body: { material: "brass" } });
  });
  it("sanitizes what it keeps (a carried token from an older host may be malformed)", () => {
    expect(pruneOverrides({ body: { roughness: 9, bogus: 1 } }, part)).toEqual({ body: { roughness: 1 } });
    expect(pruneOverrides(null, part)).toEqual({});
  });
  it("drops built-in property names (toString, constructor) that a plain object would read as present", () => {
    expect(pruneOverrides({
      toString: { color: 5 },
      constructor: { hidden: true },
      hasOwnProperty: { material: "oak" },
      body: { hidden: true },
    }, part)).toEqual({ body: { hidden: true } });
  });
});

describe("subPartVisibility", () => {
  const base = { shown: true, anim: undefined, user: undefined, hidden: false, renderMode: "cad", staticOpacity: 1 };
  it("shown and untouched: visible, lines in cad only, no fade", () => {
    expect(subPartVisibility(base)).toEqual({ meshVisible: true, linesVisible: true, fade: null });
    expect(subPartVisibility({ ...base, renderMode: "realistic" })).toEqual({ meshVisible: true, linesVisible: false, fade: null });
  });
  it("hidden wins over everything", () => {
    expect(subPartVisibility({ ...base, hidden: true, anim: 1, user: 1 })).toEqual({ meshVisible: false, linesVisible: false, fade: null });
  });
  it("not shown is not visible even with a fade", () => {
    expect(subPartVisibility({ ...base, shown: false, user: 0.5 })).toEqual({ meshVisible: false, linesVisible: false, fade: null });
  });
  it("anim 0 hides; anim and user multiply with the static opacity", () => {
    expect(subPartVisibility({ ...base, anim: 0 })).toEqual({ meshVisible: false, linesVisible: false, fade: null });
    expect(subPartVisibility({ ...base, anim: 0.5, user: 0.5, staticOpacity: 0.4 })).toEqual({ meshVisible: true, linesVisible: true, fade: 0.1 });
    expect(subPartVisibility({ ...base, user: 0.25 })).toEqual({ meshVisible: true, linesVisible: true, fade: 0.25 });
  });
});
