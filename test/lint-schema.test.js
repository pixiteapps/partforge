// Group 2 — parameter schema. features-requires-sliders is the exact crash that
// shipped in the nameplate and bracket demos: controls.js:313 does
// `feat.sliders.filter(...)` with no guard, so a bare boolean placed in `features`
// instead of `toggles` throws "Cannot read properties of undefined (reading 'filter')"
// only once a browser boots the panel.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const goodPart = () => ({
  meta: { title: "Test", units: "mm" },
  parameters: [{
    id: "body", title: "Body",
    presets: { M3: { od: 8 } },
    advanced: [{ key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 }],
    features: [{ key: "flange_d", label: "Flange", on: 16,
      sliders: [{ key: "flange_d", label: "Flange diameter", min: 8, max: 50, step: 1 }] }],
    toggles: [{ key: "vented", label: "Vented", on: false }],
  }],
  defaults: { od: 8, flange_d: 0, vented: false },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.od, p.od, p.od] }) } },
  views: { main: { label: "Main" } },
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a well-formed schema produces no schema findings", () => {
  const r = lintPart(goodPart());
  expect(ids(r.errors)).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
});

test("a features entry with no sliders is an error", () => {
  const part = goodPart();
  delete part.parameters[0].features[0].sliders;
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("features-requires-sliders");
  expect(find(r, "features-requires-sliders").path).toBe("parameters[0].features[0]");
  expect(find(r, "features-requires-sliders").hint).toMatch(/toggles/);
});

// controls.js:342 does `params[feat.key] = feat.on` with no fallback, unlike the
// toggle path one screen up which uses `t.on ?? 1`. A feature's `on` is the real
// value its parameter takes when switched on (demo's flange is 16mm, planter's
// drain is 8mm), so defaulting it would quietly build the wrong part rather than
// no part — which is why this is caught at lint time instead of patched at runtime.
test("a features entry with no `on` is an error", () => {
  const part = goodPart();
  delete part.parameters[0].features[0].on;
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("features-requires-on");
  expect(find(r, "features-requires-on").path).toBe("parameters[0].features[0]");
  expect(find(r, "features-requires-on").message).toMatch(/flange_d/);
});

test("a features entry whose `on` can never read as enabled is an error", () => {
  // The panel's enabled test is `params[key] > 0`, so 0 or a negative writes a
  // value it immediately reads back as "off" — the checkbox won't stay ticked.
  for (const on of [0, -4, Number.NaN, "16"]) {
    const part = goodPart();
    part.parameters[0].features[0].on = on;
    expect(ids(lintPart(part).errors), `on: ${String(on)}`).toContain("features-requires-on");
  }
});

test("a hidden feature with no `on` is not an error — the panel never renders it", () => {
  const part = goodPart();
  delete part.parameters[0].features[0].on;
  part.parameters[0].features[0].hidden = true;
  part.parameters[0].features.push({ key: "flange_d", label: "Flange", on: 16,
    sliders: [{ key: "flange_d", label: "Flange diameter", min: 8, max: 50, step: 1 }] });
  expect(ids(lintPart(part).errors)).not.toContain("features-requires-on");
});

test("a hidden feature with no sliders is not an error, even if its section still renders", () => {
  // controls.js only iterates visibleFeatures(sec), which filters out `hidden:
  // true` — the unguarded feat.sliders.filter(...) the rule protects against is
  // never reached for a feature the panel skips. Add a second, visible feature
  // with valid sliders so the section still renders (visibleFeatures.length > 0)
  // and this isn't conflated with the "whole section doesn't render" case below.
  const part = goodPart();
  delete part.parameters[0].features[0].sliders;
  part.parameters[0].features[0].hidden = true;
  part.parameters[0].features.push({ key: "vented2", label: "Vented 2", on: 1,
    sliders: [{ key: "vented2", label: "V2", min: 0, max: 1, step: 1 }] });
  part.defaults.vented2 = 0;
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("features-requires-sliders");
});

test("a sliderless feature inside a section that never renders is not an error", () => {
  // The section is marked hidden, so controls.js (sectionRenders) never builds it
  // — not even to iterate its features — so a sliderless feature inside it can
  // never reach the unguarded feat.sliders.filter(...) the rule protects against.
  const part = goodPart();
  delete part.parameters[0].features[0].sliders;
  part.parameters[0].hidden = true;
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("features-requires-sliders");
});

test("a control key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].advanced[0].key = "diameter";
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("control-key-not-in-defaults");
  expect(find(r, "control-key-not-in-defaults").path).toBe("parameters[0].advanced[0].key");
});

test("a toggle key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].toggles[0].key = "ventilated";
  expect(ids(lintPart(part).errors)).toContain("control-key-not-in-defaults");
});

test("a preset bundle key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].presets.M3 = { outerDiameter: 8 };
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("preset-key-not-in-defaults");
  expect(find(r, "preset-key-not-in-defaults").path).toBe('parameters[0].presets["M3"].outerDiameter');
});

test("a default outside a slider's range is a warning, not an error", () => {
  const part = goodPart();
  part.defaults.od = 80; // slider is min 4 max 40
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("slider-range-excludes-default");
  expect(ids(r.errors)).not.toContain("slider-range-excludes-default");
});

test("an unrecognised control field warns with a did-you-mean", () => {
  const part = goodPart();
  part.parameters[0].advanced[0].lable = "typo";
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("unknown-control-field");
  expect(find(r, "unknown-control-field").hint).toMatch(/label/);
});

test("the same key owned by two sections warns", () => {
  const part = goodPart();
  part.parameters.push({ id: "other", title: "Other",
    advanced: [{ key: "od", label: "Also OD", min: 1, max: 5, step: 1 }] });
  expect(ids(lintPart(part).warnings)).toContain("duplicate-control-key");
});

test("a defaults key no control references warns", () => {
  const part = goodPart();
  part.defaults.orphan = 3;
  expect(ids(lintPart(part).warnings)).toContain("default-not-exposed");
});

test("a hidden control still counts as exposing its key", () => {
  // demo.js's flange_h is a documented, legitimate hidden internal constant.
  const part = goodPart();
  part.defaults.flange_h = 2;
  part.parameters[0].advanced.push({ key: "flange_h", label: "Flange thickness", min: 1, max: 5, step: 0.5, hidden: true });
  expect(ids(lintPart(part).warnings)).not.toContain("default-not-exposed");
});

test("a part with no parameters section produces no schema findings", () => {
  // `parameters` is optional — a part can ship with defaults and no control panel.
  const part = goodPart();
  delete part.parameters;
  const r = lintPart(part);
  expect(ids(r.errors)).toEqual([]);
});

test("a feature's own-key slider with the off-sentinel default does not warn", () => {
  // goodPart() already is exactly this shape: feature "flange_d" owns a slider
  // keyed "flange_d" (range 8..50), and defaults.flange_d is 0 — controls.js's
  // documented "feature off" sentinel, not an out-of-range slider value.
  const r = lintPart(goodPart());
  expect(ids(r.warnings)).not.toContain("slider-range-excludes-default");
});

test("a feature's own-key slider with a non-sentinel out-of-range default still warns", () => {
  // Same shape as demo.js, but the default is a mistyped "on" value (999) rather
  // than the 0 off-sentinel — matching keys alone must not exempt this from the
  // range check, since it's exactly the authoring mistake the rule exists to catch.
  const part = goodPart();
  part.defaults.flange_d = 999; // slider range is min:8 max:50
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("slider-range-excludes-default");
  expect(find(r, "slider-range-excludes-default").path).toBe("parameters[0].features[0].sliders[0]");
});

test("an explicit empty defaults still gets its control keys checked", () => {
  // missing-defaults (shape rule) only fires when `defaults` isn't a plain object;
  // an explicit `defaults: {}` passes that check but must not silently exempt
  // control-key-not-in-defaults, or a real control key with no matching default
  // goes unreported forever.
  const part = goodPart();
  part.defaults = {};
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("control-key-not-in-defaults");
});

// A control can only edit a primitive: the widgets read and write one value, and a
// host that persists panel edits back into the part's source has to be able to
// write that value as a literal. An array or object default under a control is
// therefore dead in exactly the way control-key-not-in-defaults is — the part
// builds, the panel renders, and the control does nothing anyone can use.
test("a control over a non-primitive default is an error", () => {
  const part = goodPart();
  part.defaults.od = [4, 8];
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("control-default-not-primitive");
  expect(find(r, "control-default-not-primitive").path).toBe("parameters[0].advanced[0].key");
  expect(find(r, "control-default-not-primitive").message).toMatch(/array/);
});

test("null and NaN defaults under a control are errors too", () => {
  for (const [value, word] of [[null, "null"], [Number.NaN, "NaN"], [undefined, "undefined"]]) {
    const part = goodPart();
    part.defaults.od = value;
    expect(ids(lintPart(part).errors), `${word} should be reported`).toContain("control-default-not-primitive");
  }
});

test("a non-primitive default with no control is left alone", () => {
  // `defaults` also seeds `p` for build(), so a part may legitimately park data
  // there that no control edits. Only an unusable CONTROL is provably broken.
  const part = goodPart();
  part.defaults.profile = [[0, 0], [1, 1]];
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("control-default-not-primitive");
});

// `size` is bound to a slider so `default-not-exposed` stays quiet; it is the
// key the `keys` test below lists.
const customPart = (over = {}) => ({
  meta: { title: "Test", units: "mm" },
  parameters: [{ id: "t", title: "Tiles", controls: [
    { key: "tiles", type: "custom", label: "Tiles", widget: () => {}, ...over },
    { key: "size", label: "Size", min: 1, max: 40, step: 1 },
  ] }],
  defaults: { tiles: [{ q: 0, h: 10 }], size: 20 },
  parts: { body: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { main: { label: "Main" } },
});

test("a custom control over a JSON default is clean — no primitive finding", () => {
  const r = lintPart(customPart());
  expect(ids(r.errors)).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
});

test("a custom control whose widget is not a function is an error", () => {
  const r = lintPart(customPart({ widget: "hexPicker" }));
  expect(ids(r.errors)).toContain("custom-control-widget-not-function");
  expect(find(r, "custom-control-widget-not-function").path).toBe("parameters[0].controls[0].widget");
  const missing = customPart(); delete missing.parameters[0].controls[0].widget;
  expect(ids(lintPart(missing).errors)).toContain("custom-control-widget-not-function");
});

test("a custom default outside the JSON contract is custom-default-not-json, with the reason", () => {
  const part = customPart(); part.defaults.tiles = [{ q: 0, h: null }];
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("custom-default-not-json");
  expect(ids(r.errors)).not.toContain("control-default-not-primitive");
  expect(find(r, "custom-default-not-json").message).toContain("is null at [0].h");
  expect(find(r, "custom-default-not-json").path).toBe("defaults.tiles");
  const fn = customPart(); fn.defaults.tiles = { f() {} };
  expect(ids(lintPart(fn).errors)).toContain("custom-default-not-json");
});

test("a scalar default on a custom control is fine, and a slider over an array still errs", () => {
  const scalar = customPart(); scalar.defaults.tiles = 3;
  expect(ids(lintPart(scalar).errors)).toEqual([]);
  const slider = customPart(); slider.parameters[0].controls[0] = { key: "tiles", label: "T", min: 0, max: 9, step: 1 };
  expect(ids(lintPart(slider).errors)).toContain("control-default-not-primitive");
});

test("keys a custom control may write must exist in defaults", () => {
  const r = lintPart(customPart({ keys: ["size", "missing"] }));
  expect(ids(r.errors)).toContain("custom-keys-not-in-defaults");
  expect(find(r, "custom-keys-not-in-defaults").message).toContain('"missing"');
  expect(find(r, "custom-keys-not-in-defaults").path).toBe("parameters[0].controls[0].keys[1]");
  expect(ids(lintPart(customPart({ keys: ["size"] })).errors)).toEqual([]);
});
