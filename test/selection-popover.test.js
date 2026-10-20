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
    // Focus goes to the popover itself, not a button: a pick is a pointer
    // action, and a focused button would draw its keyboard ring on open.
    expect(document.activeElement).toBe(pop);
    expect(pop.getAttribute("tabindex")).toBe("-1");
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
  it("a slot-less popover closes with gone when its sub-part leaves the view; a slot one stays", () => {
    const parts = partsStub(ROWS());
    const p = attachSelectionPopover({ stage, canvas, parts });
    const reasons = [];
    p.onClose((e) => reasons.push(e.reason));
    p.open({ subPart: "body", anchor: at });
    parts.rows[0].inView = false;
    parts.emit();
    expect(reasons).toEqual(["gone"]);
    expect(p.isOpen()).toBe(false);
    p.detach();
    const parts2 = partsStub(ROWS());
    const q = attachSelectionPopover({ stage, canvas, slot: true, parts: parts2 });
    q.open({ subPart: "body", anchor: at });
    parts2.rows[0].inView = false;
    parts2.emit();
    expect(q.isOpen()).toBe(true);
    expect(q.element.querySelector(".pf-selection-open").hidden).toBe(true);
    q.detach();
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
  it("showPage does nothing while closed", () => {
    const { p } = opened();
    p.close();
    expect(p.showPage("appearance")).toBe(false);
    expect(p.showPage("spot")).toBe(false);
    expect(p.isOpen()).toBe(false);
    expect(p.element.querySelector(".pf-card")).toBeNull();
    p.detach();
  });
  it("onClosed runs before the close listeners", () => {
    const order = [];
    const { p } = opened({ onClosed: () => order.push("onClosed") });
    p.onClose(() => order.push("listener"));
    p.close("dismiss");
    expect(order).toEqual(["onClosed", "listener"]);
    p.detach();
  });
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

describe("selection popover: the appearance page", () => {
  // Browsers reset a scroller's scrollTop when its box stops overflowing, and
  // place() clears the popover's max-height for a moment to measure. happy-dom
  // does no layout, so the browser's reset is mimicked on the style write.
  function mimicScrollReset(p) {
    const body = p.element.querySelector(".pf-selection-body");
    let top = 0;
    Object.defineProperty(body, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = v; } });
    let mh = "";
    Object.defineProperty(p.element.style, "maxHeight", { configurable: true, get: () => mh, set: (v) => { mh = v; if (v === "") top = 0; } });
    return body;
  }
  it("a change made from the card keeps the card scrolled where it was", () => {
    const parts = partsStub(ROWS());
    const p = attachSelectionPopover({ stage, canvas, parts });
    const body = mimicScrollReset(p);
    p.open({ subPart: "body", anchor: at });
    p.showPage("appearance");
    body.scrollTop = 240;
    parts.rows[0].materialLabel = "Brass";
    parts.emit(); // what a finish slider's write does
    expect(body.scrollTop).toBe(240);
    p.setAnchor({ x: 420, y: 210, visible: true }); // and an orbit
    expect(body.scrollTop).toBe(240);
    p.detach();
  });
  it("a reopen after a close starts at the top", () => {
    const parts = partsStub(ROWS());
    const p = attachSelectionPopover({ stage, canvas, parts });
    const body = mimicScrollReset(p);
    p.open({ subPart: "body", anchor: at });
    p.showPage("appearance");
    body.scrollTop = 240;
    p.close();
    p.open({ subPart: "body", anchor: at, page: "appearance" });
    expect(body.scrollTop).toBe(0);
    p.detach();
  });
  it("switching page starts the new page at the top", () => {
    const parts = partsStub(ROWS());
    const p = attachSelectionPopover({ stage, canvas, parts });
    const body = mimicScrollReset(p);
    p.open({ subPart: "body", anchor: at });
    p.showPage("appearance");
    body.scrollTop = 240;
    p.showPage("spot");
    expect(body.scrollTop).toBe(0);
    p.detach();
  });
  function opened() {
    const parts = partsStub(ROWS());
    let save = "screen-only";
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts, getSaveState: () => save });
    const reasons = []; const slots = [];
    p.onClose((e) => reasons.push(e.reason));
    p.onSlotChange((r) => slots.push(r.state));
    p.open({ subPart: "body", anchor: at });
    return { p, parts, reasons, slots, setSave: (s) => { save = s; } };
  }
  it("the head button opens the card, collapses the slot and focuses the popover", () => {
    const { p, slots } = opened();
    p.element.querySelector(".pf-selection-open").click();
    expect(p.getState()).toEqual({ subPart: "body", page: "appearance" });
    expect(p.element.querySelector(".pf-selection-spot").hidden).toBe(true);
    const card = p.element.querySelector(".pf-card");
    expect(card.hidden).toBe(false);
    expect(document.activeElement).toBe(p.element);
    expect(slots).toEqual(["open", "collapsed"]);
    p.detach();
  });
  it("Back returns to the spot page and the slot reopens", () => {
    const { p, slots } = opened();
    p.showPage("appearance");
    p.element.querySelector(".pf-card-back").click();
    expect(p.getState().page).toBe("spot");
    expect(p.element.querySelector(".pf-card").hidden).toBe(true);
    expect(slots.at(-1)).toBe("open");
    p.detach();
  });
  it("the card's ✕ dismisses", () => {
    const { p, reasons } = opened();
    p.showPage("appearance");
    p.element.querySelector(".pf-card-close").click();
    expect(reasons).toEqual(["dismiss"]);
    p.detach();
  });
  it("the card's part disappearing closes with gone", () => {
    const { p, parts, reasons } = opened();
    p.showPage("appearance");
    parts.rows.splice(0, 1);
    parts.emit();
    expect(reasons).toEqual(["gone"]);
    expect(p.isOpen()).toBe(false);
    p.detach();
  });
  it("a new pick while on the card returns to the spot page", () => {
    const { p } = opened();
    p.showPage("appearance");
    p.open({ subPart: "body", anchor: { x: 100, y: 100 } });
    expect(p.getState().page).toBe("spot");
    expect(p.element.querySelector(".pf-card").hidden).toBe(true);
    p.detach();
  });
  it("there is no card for a sub-part-less pick", () => {
    const parts = partsStub(ROWS());
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts });
    p.open({ subPart: null, anchor: at });
    expect(p.showPage("appearance")).toBe(false);
    expect(p.getState().page).toBe("spot");
    p.detach();
  });
  it("refreshSaveState re-renders the card's footer", () => {
    const { p, setSave } = opened();
    p.showPage("appearance");
    setSave("blocked");
    p.refreshSaveState();
    expect(p.element.querySelector(".pf-card-foot-note").textContent).toContain("set by code");
    p.detach();
  });
  it("a reopen after a close starts on the spot page", () => {
    const { p } = opened();
    p.showPage("appearance");
    p.close();
    p.open({ subPart: "body", anchor: at });
    expect(p.getState().page).toBe("spot");
    expect(p.element.querySelector(".pf-selection-spot").hidden).toBe(false);
    p.detach();
  });
});

// happy-dom does no layout: these stubs give the popover a 40px head row above
// the slot, honour the popover's max-height cap, and put the slot's rect where
// the popover was placed, so placement numbers mean something.
function stubLayout(p, { head = 40, width = 320 } = {}) {
  const pop = p.element;
  const slotEl = pop.querySelector(".pf-selection-slot");
  const slotH = () => parseFloat(slotEl.style.height) || 0;
  Object.defineProperty(pop, "offsetWidth", { configurable: true, get: () => width });
  Object.defineProperty(pop, "offsetHeight", { configurable: true, get: () => {
    const natural = head + slotH();
    const cap = parseFloat(pop.style.maxHeight);
    return Number.isFinite(cap) ? Math.min(natural, cap) : natural;
  } });
  slotEl.getBoundingClientRect = () => {
    const left = parseFloat(pop.style.left) || 0;
    const top = (parseFloat(pop.style.top) || 0) + head;
    return { left, top, width, height: slotH(), right: left + width, bottom: top + slotH() };
  };
  return slotEl;
}

describe("selection popover: a short stage caps the slot", () => {
  const mid = { x: 400, y: 150, visible: true };
  it("caps the slot's applied height so the popover fits, and reports the capped rect", () => {
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 300, right: 800, bottom: 300 });
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()) });
    const slotEl = stubLayout(p);
    const seen = [];
    p.onSlotChange((r) => seen.push(r));
    p.open({ subPart: "body", anchor: mid });
    // 128px of room either side (300 − 12 gutter − 150 − 10 gap): the head row
    // takes 40, so a 400px request is cut to 88.
    p.setSlotHeight(400);
    expect(slotEl.style.height).toBe("88px");
    expect(seen.at(-1)).toMatchObject({ state: "open", rect: { height: 88 } });
    // The request is kept: a smaller one that fits is applied as asked.
    p.setSlotHeight(60);
    expect(slotEl.style.height).toBe("60px");
    expect(seen.at(-1).rect.height).toBe(60);
    p.detach();
  });
  it("a taller stage restores the requested height, and the floor stays 44", () => {
    let h = 300;
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: h, right: 800, bottom: h });
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()) });
    const slotEl = stubLayout(p);
    const seen = [];
    p.onSlotChange((r) => seen.push(r));
    p.open({ subPart: "body", anchor: mid });
    p.setSlotHeight(400);
    expect(slotEl.style.height).toBe("88px");
    h = 1200;
    p.setAnchor({ ...mid }); // a re-place, as a stage resize would make
    expect(slotEl.style.height).toBe("400px");
    expect(seen.at(-1).rect.height).toBe(400);
    h = 100; // room ~28px: below the floor
    p.setAnchor({ ...mid, y: 50 });
    expect(slotEl.style.height).toBe("44px");
    p.detach();
  });
});

describe("selection popover: opening on a page", () => {
  it("open with page 'appearance' lands on the card with exactly one collapsed report", () => {
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()) });
    const seen = [];
    p.onSlotChange((r) => seen.push(r));
    expect(p.open({ subPart: "body", anchor: at, page: "appearance" })).toBe(true);
    expect(seen).toEqual([{ state: "collapsed" }]);
    expect(p.getState()).toEqual({ subPart: "body", page: "appearance" });
    expect(p.element.querySelector(".pf-card").hidden).toBe(false);
    expect(p.element.querySelector(".pf-selection-spot").hidden).toBe(true);
    p.detach();
  });
  it("page 'appearance' without a head row opens on the spot page", () => {
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()) });
    const seen = [];
    p.onSlotChange((r) => seen.push(r.state));
    expect(p.open({ subPart: null, anchor: at, page: "appearance" })).toBe(true);
    expect(seen).toEqual(["open"]);
    expect(p.getState().page).toBe("spot");
    p.detach();
  });
});

describe("selection popover: toStage", () => {
  it("converts the stored anchor at every placement, not once at open", () => {
    let dx = 0;
    const p = attachSelectionPopover({ stage, canvas, slot: true, parts: partsStub(ROWS()), toStage: (a) => ({ ...a, x: a.x + dx }) });
    stubLayout(p, { width: 200 });
    p.open({ subPart: "body", anchor: { x: 300, y: 100, visible: true } });
    expect(p.element.style.left).toBe("200px");
    dx = 100; // the canvas moved within the stage
    p.setSlotHeight(44); // any re-place (a resize would do the same)
    expect(p.element.style.left).toBe("300px");
    p.detach();
  });
});
