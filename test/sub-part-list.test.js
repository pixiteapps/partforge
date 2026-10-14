// test/sub-part-list.test.js
import { describe, it, expect } from "vitest";
import { subPartRows } from "../src/framework/sub-part-list.js";
import { NO_MATERIAL_COLOR } from "../src/framework/materials/resolve.js";
import { PRESETS } from "../src/framework/materials/presets.js";

const part = {
  defaults: { withFeet: true },
  parts: {
    body: { label: "Body", views: { assembly: true, body: true }, display: { material: "powder-coat", color: 0x3a3f47 } },
    lid: { label: "Lid", views: { assembly: true }, display: { material: "brass" } },
    window: { views: { assembly: true }, display: { color: 0xbfe0f5 } },
    feet: { label: "Feet", views: { assembly: true }, enabled: (p) => p.withFeet },
    odd: { label: "Odd", views: { assembly: true }, display: { material: "unobtainium" } },
  },
  views: { assembly: {}, body: {} },
};

describe("subPartRows", () => {
  it("lists every sub-part in definition order and says which are in the view", () => {
    const rows = subPartRows(part, { view: "body", params: part.defaults, overrides: {} });
    expect(rows.map((r) => [r.name, r.inView])).toEqual([["body", true], ["lid", false], ["window", false], ["feet", false], ["odd", false]]);
  });
  it("respects enabled() through viewSubParts", () => {
    const rows = subPartRows(part, { view: "assembly", params: { withFeet: false }, overrides: {} });
    expect(rows.find((r) => r.name === "feet").inView).toBe(false);
  });
  it("labels fall back to the key; swatch colour, material label and tintable come from the EFFECTIVE display", () => {
    const rows = subPartRows(part, { view: "assembly", params: part.defaults, overrides: { lid: { material: "anodized-aluminum", color: 0xb3261e } } });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.window.label).toBe("window");
    expect(byName.body).toMatchObject({ color: 0x3a3f47, materialLabel: PRESETS["powder-coat"].label, tintable: true, overridden: false });
    expect(byName.lid).toMatchObject({ color: 0xb3261e, materialLabel: PRESETS["anodized-aluminum"].label, tintable: true, overridden: true });
    expect(byName.window).toMatchObject({ color: 0xbfe0f5, materialLabel: null, tintable: true });
    expect(byName.feet).toMatchObject({ color: NO_MATERIAL_COLOR, materialLabel: null, tintable: true });
    expect(byName.odd).toMatchObject({ materialLabel: "unknown", tintable: true });
  });
  it("an untintable preset with no explicit colour shows the preset colour and tintable: false", () => {
    const rows = subPartRows(part, { view: "assembly", params: part.defaults, overrides: {} });
    const lid = rows.find((r) => r.name === "lid");
    expect(lid.color).toBe(PRESETS.brass.color);
    expect(lid.tintable).toBe(false);
  });
  it("carries the viewing keys and the effective display", () => {
    const rows = subPartRows(part, { view: "assembly", params: part.defaults, overrides: { body: { hidden: true, opacity: 0.5 } } });
    const body = rows.find((r) => r.name === "body");
    expect(body).toMatchObject({ hidden: true, opacity: 0.5, overridden: false });
    expect(body.effective).toEqual({ material: "powder-coat", color: 0x3a3f47 });
    expect(rows.find((r) => r.name === "lid")).toMatchObject({ hidden: false, opacity: 1 });
  });
});
