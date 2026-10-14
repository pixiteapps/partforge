// @vitest-environment happy-dom
// test/selection-popover.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachSelectionPopover } from "../src/framework/selection-popover.js";

export function partsStub(rows) {
  const listeners = new Set();
  return {
    rows,
    list: () => rows,
    setDisplay: vi.fn((name, patch) => { const r = rows.find((x) => x.name === name); if (r && "hidden" in patch) r.hidden = !!patch.hidden; for (const cb of listeners) cb({ name, override: patch }); return patch; }),
    clear: vi.fn(),
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    emit: () => { for (const cb of [...listeners]) cb(null); },
    onViewChange: () => () => {},
    getState: (name) => { const r = rows.find((x) => x.name === name); return r ? { authored: null, override: null, effective: r.effective, hidden: r.hidden, opacity: r.opacity } : null; },
  };
}
export const ROWS = () => [
  { name: "body", label: "Body", inView: true, hidden: false, opacity: 1, effective: { material: "powder-coat" }, color: 0x3a3f47, materialLabel: "Powder coat", tintable: true, overridden: false },
  { name: "jig", label: "Jig", inView: false, hidden: false, opacity: 1, effective: {}, color: 0x9fb4cc, materialLabel: null, tintable: true, overridden: false },
];

let stage, canvas, chrome;
beforeEach(() => {
  document.body.innerHTML = `<div id="stage"><div id="canvas"></div><div id="viewbar"><button id="b"></button></div></div><div id="rail"></div>`;
  stage = document.getElementById("stage");
  canvas = document.getElementById("canvas");
  chrome = document.getElementById("b");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
});
const at = { x: 400, y: 200, visible: true };

describe("selection popover: opening", () => {
  it("slot-less: opens on a listed sub-part with its swatch, label and material", () => {
    const p = attachSelectionPopover({ stage, canvas, parts: partsStub(ROWS()) });
    expect(p.open({ subPart: "body", anchor: at })).toBe(true);
    expect(p.isOpen()).toBe(true);
    const pop = p.element;
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-label")).toBe("Body");
    expect(pop.querySelector(".pf-selection-name").textContent).toBe("Body");
    expect(pop.querySelector(".pf-selection-mat").textContent).toBe("Powder coat");
    expect(pop.querySelector(".pf-parts-swatch").style.getPropertyValue("--pf-swatch")).toBe("#3a3f47");
    expect(pop.querySelector(".pf-selection-open").getAttribute("aria-label")).toBe("Change appearance of Body");
    expect(pop.querySelector(".pf-selection-slot")).toBeNull();
    expect(document.activeElement).toBe(pop.querySelector(".pf-selection-open"));
    p.detach();
  });
  it("slot-less: a pick with no sub-part, or one not in view, opens nothing", () => {
    const p = attachSelectionPopover({ stage, canvas, parts: partsStub(ROWS()) });
    expect(p.open({ subPart: null, anchor: at })).toBe(false);
    expect(p.open({ subPart: "jig", anchor: at })).toBe(false);
    expect(p.isOpen()).toBe(false);
    p.detach();
  });
  it("with a slot: a sub-part-less pick opens with only the ✕ in the head row, and focus is left alone", () => {
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()) });
    chrome.focus();
    expect(p.open({ subPart: null, anchor: at })).toBe(true);
    const pop = p.element;
    expect(pop.querySelector(".pf-selection-open").hidden).toBe(true);
    expect(pop.querySelector(".pf-selection-eye").hidden).toBe(true);
    expect(pop.querySelector(".pf-selection-close").hidden).toBe(false);
    expect(pop.querySelector(".pf-selection-slot")).not.toBeNull();
    expect(pop.getAttribute("aria-label")).toBe("Selected spot");
    expect(document.activeElement).toBe(chrome);
    p.detach();
  });
  it("places itself from the anchor and follows setAnchor", () => {
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()) });
    p.open({ subPart: "body", anchor: at });
    const first = [p.element.style.left, p.element.style.top];
    p.setAnchor({ x: 600, y: 300, visible: true });
    expect([p.element.style.left, p.element.style.top]).not.toEqual(first);
    expect(p.element.dataset.side).toBe("below");
    p.detach();
  });
  it("a second open re-points the header to the new sub-part", () => {
    const rows = ROWS(); rows[1].inView = true;
    const p = attachSelectionPopover({ stage, canvas, parts: partsStub(rows) });
    p.open({ subPart: "body", anchor: at });
    p.open({ subPart: "jig", anchor: at });
    expect(p.element.querySelector(".pf-selection-name").textContent).toBe("Jig");
    expect(p.element.querySelector(".pf-selection-mat").textContent).toBe("No material");
    expect(p.getState()).toEqual({ subPart: "jig", page: "spot" });
    p.detach();
  });
  it("re-renders the header on a display change", () => {
    const parts = partsStub(ROWS());
    const p = attachSelectionPopover({ stage, canvas, parts });
    p.open({ subPart: "body", anchor: at });
    parts.rows[0].materialLabel = "Brass";
    parts.emit();
    expect(p.element.querySelector(".pf-selection-mat").textContent).toBe("Brass");
    p.detach();
  });
});

describe("selection popover: the slot", () => {
  it("reports open with a whole-pixel rect, coalescing identical reports", () => {
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()) });
    const seen = [];
    p.onSlotChange((r) => seen.push(r));
    p.open({ subPart: "body", anchor: at });
    p.setAnchor(at); // same place: no new report
    expect(seen.length).toBe(1);
    expect(seen[0].state).toBe("open");
    for (const k of ["x", "y", "width", "height"]) expect(Number.isInteger(seen[0].rect[k])).toBe(true);
    p.close();
    expect(seen.at(-1)).toEqual({ state: "closed" });
    p.detach();
  });
  it("setSlotHeight sets the slot's height, clamps to 44..2000 and ignores bad values", () => {
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()) });
    p.open({ subPart: "body", anchor: at });
    const slotEl = p.element.querySelector(".pf-selection-slot");
    expect(slotEl.style.height).toBe("44px");
    p.setSlotHeight(87.6); expect(slotEl.style.height).toBe("88px");
    p.setSlotHeight(10); expect(slotEl.style.height).toBe("44px");
    p.setSlotHeight(5000); expect(slotEl.style.height).toBe("2000px");
    p.setSlotHeight(Number.NaN); p.setSlotHeight(-3); p.setSlotHeight("90");
    expect(slotEl.style.height).toBe("2000px");
    p.detach();
  });
  it("a slot-less popover never reports", () => {
    const p = attachSelectionPopover({ stage, canvas, parts: partsStub(ROWS()) });
    const cb = vi.fn();
    p.onSlotChange(cb);
    p.open({ subPart: "body", anchor: at });
    p.close("dismiss");
    expect(cb).not.toHaveBeenCalled();
    p.detach();
  });
});

describe("selection popover: closing", () => {
  function opened(opts = {}) {
    const parts = partsStub(ROWS());
    const onClosed = vi.fn();
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts, onClosed, ...opts });
    const reasons = [];
    p.onClose((e) => reasons.push(e.reason));
    p.open({ subPart: "body", anchor: at });
    return { p, parts, onClosed, reasons };
  }
  it("✕ closes with dismiss and calls onClosed", () => {
    const { p, onClosed, reasons } = opened();
    p.element.querySelector(".pf-selection-close").click();
    expect(reasons).toEqual(["dismiss"]);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(p.isOpen()).toBe(false);
    p.detach();
  });
  it("the eye hides the part and closes with hide", () => {
    const { p, parts, reasons } = opened();
    p.element.querySelector(".pf-selection-eye").click();
    expect(parts.setDisplay).toHaveBeenCalledWith("body", { hidden: true });
    expect(reasons).toEqual(["hide"]);
    p.detach();
  });
  it("Escape inside the popover dismisses and does not travel on", () => {
    const { p, reasons } = opened();
    const outer = vi.fn();
    stage.addEventListener("keydown", outer);
    p.element.querySelector(".pf-selection-close").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reasons).toEqual(["dismiss"]);
    expect(outer).not.toHaveBeenCalled();
    p.detach();
  });
  it("pointerdown on stage chrome dismisses; on the canvas or outside the stage it does not", () => {
    const { p, reasons } = opened();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.getElementById("rail").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    p.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(reasons).toEqual([]);
    chrome.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(reasons).toEqual(["dismiss"]);
    p.detach();
  });
  it("close() from the host fires no onClose but does call onClosed; it is idempotent", () => {
    const { p, onClosed, reasons } = opened();
    p.close();
    p.close();
    expect(reasons).toEqual([]);
    expect(onClosed).toHaveBeenCalledTimes(1);
    p.detach();
  });
  it("close('gone') carries its reason", () => {
    const { p, reasons } = opened();
    p.close("gone");
    expect(reasons).toEqual(["gone"]);
    p.detach();
  });
  it("detach is silent and removes the node", () => {
    const { p, onClosed, reasons } = opened();
    const slot = vi.fn();
    p.onSlotChange(slot);
    p.detach();
    expect(reasons).toEqual([]);
    expect(onClosed).not.toHaveBeenCalled();
    expect(slot).not.toHaveBeenCalled();
    expect(stage.querySelector(".pf-selection-popover")).toBeNull();
    expect(p.open({ subPart: "body", anchor: at })).toBe(false);
  });
});
