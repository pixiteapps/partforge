// @vitest-environment happy-dom
// test/appearance-card.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachAppearanceCard, textureScaleToPos, posToTextureScale } from "../src/framework/appearance-card.js";
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
afterEach(() => { vi.useRealTimers(); });
// Deterministic frames: the card's throttles and its paint pass read
// requestAnimationFrame (and setTimeout) when they run, so faking them before
// attachAppearanceCard puts every frame under the test's control.
const FAKE = { toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] };

describe("appearance card", () => {
  it("shows the label, one tile per preset, the pressed one being the effective material", () => {
    const card = attachAppearanceCard(partsStub(rows()), { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    expect(card.element.querySelector(".pf-card-title").textContent).toBe("Lid");
    const tiles = [...card.element.querySelectorAll(".pf-card-tile")];
    expect(tiles.length).toBe(Object.keys(PRESETS).length);
    expect(tiles.every((t) => t.dataset.material !== "")).toBe(true);
    expect(tiles.find((t) => t.getAttribute("aria-pressed") === "true").dataset.material).toBe("anodized-aluminum");
    card.detach();
  });
  it("no tile is pressed for no material; an unknown id presses nothing and names itself", () => {
    const r = rows(); r[1].effective = { material: "unobtainium" };
    const card = attachAppearanceCard(partsStub(r), { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("base");
    expect(card.element.querySelector('.pf-card-tile[aria-pressed="true"]')).toBeNull();
    expect(card.element.querySelector(".pf-card-unknown").hidden).toBe(true);
    card.show("knob");
    expect(card.element.querySelector('.pf-card-tile[aria-pressed="true"]')).toBeNull();
    expect(card.element.querySelector(".pf-card-unknown").textContent).toBe("unobtainium");
    card.detach();
  });
  it("tiles write material; colour writes an int; the colour row is disabled for an untintable preset", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    card.element.querySelector('.pf-card-tile[data-material="oak"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: "oak" });
    card.element.querySelector('.pf-card-color[data-color="#1f5bd6"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { color: 0x1f5bd6 });
    card.show("knob");
    expect(card.element.querySelector(".pf-card-colors").classList.contains("disabled")).toBe(true);
    expect(card.element.querySelector(".pf-card-color").disabled).toBe(true);
    expect(card.element.querySelector(".pf-card-native").disabled).toBe(true);
    expect(card.element.querySelector(".pf-card-tint-note").textContent).toBe("Brass has its own colour. Pick a tintable preset to colour it.");
    card.show("lid");
    expect(card.element.querySelector(".pf-card-color").disabled).toBe(false);
    expect(card.element.querySelector(".pf-card-native").disabled).toBe(false);
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
  it("see-through writes opacity (once per frame, the first at once), 100% clears; the eye toggles hidden", () => {
    vi.useFakeTimers(FAKE);
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const range = card.element.querySelector(".pf-card-seethrough");
    range.value = "40"; range.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { opacity: 0.4 });
    range.value = "100"; range.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenCalledTimes(1); // coalesced into the frame's end
    vi.advanceTimersToNextFrame();
    expect(parts.setDisplay).toHaveBeenCalledTimes(2);
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
    state = "screen-only"; card.render();
    expect(card.element.querySelector(".pf-card-foot-note").hidden).toBe(true);
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
    expect(onBack).toHaveBeenCalledWith("lid");
    card.detach();
  });
  it("calls onGone when a re-render finds the part gone", () => {
    const r = rows();
    const onGone = vi.fn();
    const parts = partsStub(r);
    const card = attachAppearanceCard(parts, { onBack: () => {}, onGone, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    r.splice(0, 1);
    parts.clear({});
    expect(onGone).toHaveBeenCalledWith("lid");
    card.detach();
  });
  it("finish sliders and the native colour input write once per frame: the first event at once, later ones coalesced to the last value", () => {
    vi.useFakeTimers(FAKE);
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
    vi.advanceTimersToNextFrame();
    expect(parts.setDisplay).toHaveBeenCalledTimes(2);
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { metalness: 0.7 });
    parts.setDisplay.mockClear();
    vi.advanceTimersToNextFrame(); // the frame after a write closes its window...
    vi.advanceTimersToNextFrame(); // ...and a quiet one writes nothing
    expect(parts.setDisplay).not.toHaveBeenCalled();
    const native = card.element.querySelector(".pf-card-native");
    native.value = "#112233"; native.dispatchEvent(new Event("input"));
    native.value = "#445566"; native.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenCalledTimes(1);
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { color: 0x112233 });
    vi.advanceTimersToNextFrame();
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
  it("picking an untintable preset clears an OVERRIDE colour; a tintable one leaves it", () => {
    const r = rows(); r[0].override = { material: "anodized-aluminum", color: 0xff0000 };
    const parts = partsStub(r);
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    card.element.querySelector('.pf-card-tile[data-material="brass"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: "brass", color: null });
    card.element.querySelector('.pf-card-tile[data-material="oak"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: "oak", color: null });
    card.element.querySelector('.pf-card-tile[data-material="pla-print"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: "pla-print" });
    card.detach();
  });
  it("picking an untintable preset over an authored colour writes the material alone (effectiveDisplay drops the authored tint for it)", () => {
    const parts = partsStub(rows()); // lid: override has no colour; its red is authored
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    card.element.querySelector('.pf-card-tile[data-material="brass"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: "brass" });
    card.detach();
  });
  it("texture scale is a log slider: 0.2 mm round-trips, values clamp, and the preset default shows", () => {
    expect(Math.abs(posToTextureScale(textureScaleToPos(0.2)) - 0.2) / 0.2).toBeLessThan(0.01);
    expect(Math.abs(posToTextureScale(textureScaleToPos(48)) - 48) / 48).toBeLessThan(0.01);
    expect(posToTextureScale(0)).toBeCloseTo(0.01, 6);
    expect(posToTextureScale(1)).toBeCloseTo(1000, 6);
    expect(posToTextureScale(2)).toBeCloseTo(1000, 6);
    expect(textureScaleToPos(0)).toBe(0);
    const r = rows(); r[0].effective = { material: "pla-print" }; r[0].override = { material: "pla-print" };
    const parts = partsStub(r);
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const input = card.element.querySelector('.pf-card-finish[data-key="textureScale"]');
    const label = input.parentElement.querySelector(".pf-card-val");
    expect(Number(input.value)).toBeCloseTo(textureScaleToPos(PRESETS["pla-print"].textureScale), 3);
    expect(label.textContent).toBe(`${PRESETS["pla-print"].textureScale} mm`);
    input.value = String(textureScaleToPos(0.2)); input.dispatchEvent(new Event("input"));
    const written = parts.setDisplay.mock.lastCall[1].textureScale;
    expect(Math.abs(written - 0.2) / 0.2).toBeLessThan(0.01);
    card.detach();
  });
  it("tile thumbnails repaint at most once per 150 ms while the colour changes, with a frame between tiles", async () => {
    vi.useFakeTimers(FAKE);
    const parts = partsStub(rows());
    const renderThumb = vi.fn(async () => null);
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only", renderThumb });
    document.body.append(card.element);
    card.show("lid");
    const firstId = Object.keys(PRESETS)[0];
    const passStarts = () => renderThumb.mock.calls.filter(([id]) => id === firstId).length;
    await vi.advanceTimersByTimeAsync(0);
    expect(passStarts()).toBe(1);
    expect(renderThumb).toHaveBeenCalledTimes(1); // the next tile waits for a frame
    await vi.advanceTimersByTimeAsync(200); // let show()'s pass and its repaint window finish
    renderThumb.mockClear();
    const native = card.element.querySelector(".pf-card-native");
    native.value = "#112233"; native.dispatchEvent(new Event("input")); // writes at once -> render -> paint
    await vi.advanceTimersByTimeAsync(20);
    native.value = "#445566"; native.dispatchEvent(new Event("input")); // a later frame: writes, render held
    await vi.advanceTimersByTimeAsync(60);
    expect(passStarts()).toBe(1); // two colour writes inside 150 ms: one pass
    await vi.advanceTimersByTimeAsync(200);
    expect(passStarts()).toBe(2); // and one trailing pass for the last state
    card.detach();
  });
});
