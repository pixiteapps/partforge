// @vitest-environment happy-dom
// test/appearance-card.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachAppearanceCard } from "../src/framework/appearance-card.js";
import { PRESETS } from "../src/framework/materials/presets.js";

function partsStub(rows) {
  const listeners = new Set();
  return {
    list: () => rows,
    setDisplay: vi.fn((name, patch) => { for (const cb of listeners) cb({ name, override: patch }); return patch; }),
    clear: vi.fn((opts) => { for (const cb of listeners) cb(null); }),
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onViewChange: () => () => {},
    getState: (name) => { const r = rows.find((x) => x.name === name); return r ? { authored: r.authored ?? null, override: r.override ?? null, effective: r.effective, hidden: r.hidden, opacity: r.opacity } : null; },
  };
}
const rows = () => [
  { name: "lid", label: "Lid", inView: true, hidden: false, opacity: 1, effective: { material: "anodized-aluminum", color: 0xb3261e }, color: 0xb3261e, materialLabel: "Anodized aluminium", tintable: true, overridden: true, override: { material: "anodized-aluminum" } },
  { name: "knob", label: "Knob", inView: true, hidden: false, opacity: 1, effective: { material: "brass" }, color: 0xc9a24b, materialLabel: "Brass", tintable: false, overridden: false },
  { name: "base", label: "Base", inView: true, hidden: false, opacity: 1, effective: {}, color: 0x9fb4cc, materialLabel: null, tintable: true, overridden: false },
];
beforeEach(() => { document.body.innerHTML = ""; });

describe("appearance card", () => {
  it("shows the label, one tile per preset plus CAD, the pressed one being the effective material", () => {
    const card = attachAppearanceCard(partsStub(rows()), { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    expect(card.element.querySelector(".pf-card-title").textContent).toBe("Lid");
    const tiles = [...card.element.querySelectorAll(".pf-card-tile")];
    expect(tiles.length).toBe(Object.keys(PRESETS).length + 1);
    expect(tiles[0].textContent).toBe("CAD");
    expect(tiles.find((t) => t.getAttribute("aria-pressed") === "true").dataset.material).toBe("anodized-aluminum");
    card.detach();
  });
  it("CAD is pressed for no material; an unknown id presses CAD and names itself", () => {
    const r = rows(); r[2].effective = { material: "unobtainium" };
    const card = attachAppearanceCard(partsStub(r), { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("base");
    expect(card.element.querySelector('.pf-card-tile[data-material=""]').getAttribute("aria-pressed")).toBe("true");
    expect(card.element.querySelector(".pf-card-unknown").textContent).toBe("unobtainium");
    card.detach();
  });
  it("tiles write material (CAD writes null); colour writes an int; the colour row is disabled for an untintable preset", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    card.element.querySelector('.pf-card-tile[data-material="oak"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: "oak" });
    card.element.querySelector('.pf-card-tile[data-material=""]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: null });
    card.element.querySelector('.pf-card-color[data-color="#1f5bd6"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { color: 0x1f5bd6 });
    card.show("knob");
    expect(card.element.querySelector(".pf-card-colors").classList.contains("disabled")).toBe(true);
    expect(card.element.querySelector(".pf-card-tint-note").textContent).toBe("Brass has its own colour. Pick a tintable preset to colour it.");
    card.detach();
  });
  it("the hex field and the native input write a colour; a bad hex writes nothing", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const hex = card.element.querySelector(".pf-card-hex");
    hex.value = "#00ff00"; hex.dispatchEvent(new Event("change"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { color: 0x00ff00 });
    parts.setDisplay.mockClear();
    hex.value = "nope"; hex.dispatchEvent(new Event("change"));
    expect(parts.setDisplay).not.toHaveBeenCalled();
    card.detach();
  });
  it("see-through writes opacity, 100% clears; the eye toggles hidden", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const range = card.element.querySelector(".pf-card-seethrough");
    range.value = "40"; range.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { opacity: 0.4 });
    range.value = "100"; range.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { opacity: null });
    card.element.querySelector(".pf-card-eye").click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { hidden: true });
    card.detach();
  });
  it("finish sliders write their key, clamped to the range", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const r = card.element.querySelector('.pf-card-finish[data-key="roughness"]');
    r.value = "0.25"; r.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { roughness: 0.25 });
    card.detach();
  });
  it("footer copy follows the save state; Reset clears appearance for this part only", () => {
    const parts = partsStub(rows());
    let state = "saved";
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => state });
    document.body.append(card.element);
    card.show("lid");
    expect(card.element.querySelector(".pf-card-foot-note").textContent).toBe("Material and colour are saved to this forge. See-through and hiding are only on this screen.");
    expect(card.element.querySelector(".pf-card-reset").textContent).toBe("Reset to authored");
    state = "blocked"; card.render();
    expect(card.element.querySelector(".pf-card-foot-note").textContent).toBe("This part's look is set by code. Ask the assistant to change it.");
    expect(card.element.querySelector(".pf-card-reset").textContent).toBe("Reset");
    card.element.querySelector(".pf-card-reset").click();
    expect(parts.clear).toHaveBeenCalledWith({ appearance: true, name: "lid" });
    card.detach();
  });
  it("Back calls onBack; show() of an unknown name returns false", () => {
    const onBack = vi.fn();
    const card = attachAppearanceCard(partsStub(rows()), { onBack, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    expect(card.show("nope")).toBe(false);
    expect(card.show("lid")).toBe(true);
    card.element.querySelector(".pf-card-back").click();
    expect(onBack).toHaveBeenCalled();
    card.detach();
  });
  it("finish sliders and the native colour input write once per frame: the first event at once, later ones coalesced to the last value", async () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const r = card.element.querySelector('.pf-card-finish[data-key="metalness"]');
    r.value = "0.2"; r.dispatchEvent(new Event("input"));
    r.value = "0.6"; r.dispatchEvent(new Event("input"));
    r.value = "0.7"; r.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenCalledTimes(1);
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { metalness: 0.2 });
    await new Promise((res) => setTimeout(res, 40));
    expect(parts.setDisplay).toHaveBeenCalledTimes(2);
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { metalness: 0.7 });
    parts.setDisplay.mockClear();
    await new Promise((res) => setTimeout(res, 40)); // the frame after a quiet one writes nothing
    const native = card.element.querySelector(".pf-card-native");
    native.value = "#112233"; native.dispatchEvent(new Event("input"));
    native.value = "#445566"; native.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenCalledTimes(1);
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { color: 0x112233 });
    await new Promise((res) => setTimeout(res, 40));
    expect(parts.setDisplay).toHaveBeenCalledTimes(2);
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { color: 0x445566 });
    card.detach();
  });
  it("an authored colour under an untintable preset shows its hex, still disabled, with the tint note", () => {
    const r = rows(); r[1].effective = { material: "brass", color: 0x123456 }; r[1].color = 0x123456;
    const card = attachAppearanceCard(partsStub(r), { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("knob");
    const vals = [...card.element.querySelectorAll(".pf-card-lab-row")].find((x) => x.textContent.startsWith("Colour")).querySelector(".pf-card-val");
    expect(vals.textContent).toBe("#123456");
    expect(card.element.querySelector(".pf-card-colors").classList.contains("disabled")).toBe(true);
    expect(card.element.querySelector(".pf-card-tint-note").hidden).toBe(false);
    card.show("lid");
    expect(card.element.querySelector(".pf-card-tint-note").hidden).toBe(true);
    card.detach();
  });
});
