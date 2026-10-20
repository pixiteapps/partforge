# Selection Popover (partforge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pick opens a partforge popover at the picked spot — the sub-part's header, its appearance card as a second page, and an optional empty slot a host fills with its own UI — carried across remounts.

**Architecture:** A pure placement rule (`selection-placement.js`), a DOM module (`selection-popover.js`) that owns the popover, its two pages and the slot reporting, and mount wiring that opens it from the picker, follows the held pick marker, closes it on mode/view changes, carries it in `getViewerState()` and exposes `runtime.selection`. The appearance page reuses `attachAppearanceCard` on the same parts seam the view style popover uses.

**Tech Stack:** plain DOM ES modules, vitest + happy-dom, three.js viewer (only `getHeldAnchorPoint` is new there).

**Spec:** `partforge-cloud` repo, branch `claude/selection-popover`, `docs/superpowers/specs/2026-10-14-selection-popover-design.md` (section A is this plan; section B is the later cloud plan).

## Global Constraints

- Opt-in: a mount without `selectionPopover` behaves exactly as 0.149 (no popover node in the DOM, `runtime.selection === null`).
- The popover only exists with `onPick` (the picker is what opens it).
- `selectionPopover` is an object: `{ slot: boolean }`; anything else (true, a string) is treated as absent.
- Slot height: integer, minimum 44 px, maximum 2000 px; non-finite or negative values ignored.
- Close reasons are exactly `"dismiss"`, `"hide"`, `"gone"`. `close()` with no reason (the host's) fires no `onClose`.
- With `slot: false`, `onSlotChange` never fires.
- Disposal (detach) emits nothing.
- Placement: 12 px gutter, 10 px gap, 28 px tail inset; below the dot first, above when only above fits, below when neither fits.
- Version: `package.json` and the `package-lock.json` root both go to `0.150.0` in the last task.
- No new dependency. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A click on the canvas while the popover is open (picking another spot, or starting an orbit drag) must NOT dismiss it — the pick re-points it, the drag leaves it alone. Pinned in Task 2 (outside-pointerdown test).
2. Closing releases the held marker, and the marker's `null` anchor that release publishes must not re-enter `close` (no double `onClose`, no recursion). Pinned in Task 4.
3. A remount whose carried sub-part is no longer in the view must leave the popover closed and fire no `onPick`. Pinned in Task 4.
4. Picking a spot with no sub-part on a slot-less mount opens nothing; with a slot it opens with only a ✕ in the head row (no swatch button, no eye). Pinned in Task 2.
5. The appearance page's part disappearing (a rebuild drops it) closes with `"gone"` rather than showing a stale card. Pinned in Task 3.

Ruling recorded here (spec A.3 says a sub-part-less pick "shows only the slot"): the head row stays with only its ✕, because a slot with no visible close leaves a touch user only an outside tap. The cloud plan inherits this.

---

### Task 1: Placement rule and the held marker's world point

**Files:**
- Create: `src/framework/selection-placement.js`
- Create: `test/selection-placement.test.js`
- Modify: `src/framework/viewer.js` (beside `releaseFlashPoints`, ~line 2943, and the returned object ~line 3093)

**Interfaces:**
- Produces: `planSelectionPlacement({ anchor: {x, y, visible?}, box: {width, height}, stage: {left, top, width, height} }, options?) → { left, top, side: "below"|"above", tailOffset: number|null }`; `SELECTION_GUTTER = 12`.
- Produces: `viewer.getHeldAnchorPoint() → [x, y, z] | null` (world position of the held marker the anchor stream follows).

- [ ] **Step 1: Write the failing tests**

```js
// test/selection-placement.test.js
import { describe, it, expect } from "vitest";
import { planSelectionPlacement, SELECTION_GUTTER } from "../src/framework/selection-placement.js";

const stage = { left: 0, top: 0, width: 800, height: 600 };
const box = { width: 300, height: 120 };

describe("planSelectionPlacement", () => {
  it("centres below the dot with the tail on the dot", () => {
    const p = planSelectionPlacement({ anchor: { x: 400, y: 200, visible: true }, box, stage });
    expect(p).toEqual({ left: 250, top: 210, side: "below", tailOffset: 150 });
  });
  it("goes above when only above fits", () => {
    const p = planSelectionPlacement({ anchor: { x: 400, y: 550 }, box, stage });
    expect(p.side).toBe("above");
    expect(p.top).toBe(550 - 10 - 120);
  });
  it("stays below when neither side fits", () => {
    const p = planSelectionPlacement({ anchor: { x: 400, y: 100 }, box: { width: 300, height: 560 }, stage });
    expect(p.side).toBe("below");
  });
  it("clamps to the gutters on both edges", () => {
    expect(planSelectionPlacement({ anchor: { x: 5, y: 100 }, box, stage }).left).toBe(SELECTION_GUTTER);
    expect(planSelectionPlacement({ anchor: { x: 795, y: 100 }, box, stage }).left).toBe(800 - 12 - 300);
  });
  it("a box wider than the stage pins to the left gutter", () => {
    expect(planSelectionPlacement({ anchor: { x: 100, y: 100 }, box: { width: 900, height: 50 }, stage }).left).toBe(12);
  });
  it("drops the tail when the dot is off screen or too near the box's corner", () => {
    expect(planSelectionPlacement({ anchor: { x: 400, y: 200, visible: false }, box, stage }).tailOffset).toBeNull();
    // clamped hard left: the dot sits 3px into a box that starts at 12
    expect(planSelectionPlacement({ anchor: { x: 15, y: 100 }, box, stage }).tailOffset).toBeNull();
  });
  it("rounds to whole pixels and measures the tail from the rounded left", () => {
    const p = planSelectionPlacement({ anchor: { x: 400.4, y: 200.6 }, box: { width: 301, height: 120 }, stage });
    expect(Number.isInteger(p.left) && Number.isInteger(p.top)).toBe(true);
    expect(p.tailOffset).toBe(Math.round(400.4 - p.left));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/selection-placement.test.js`
Expected: FAIL — cannot resolve `selection-placement.js`.

- [ ] **Step 3: Implement**

```js
// src/framework/selection-placement.js
// Where the selection popover sits relative to the pick marker. Pure: handed
// measurements, returns geometry. Moved here from partforge-cloud's
// pickBubblePlacement.js (2026-10-14) when the pick bubble became partforge's.
//
// `tailInset` must stay above the popover's corner radius, or the tail can land
// on the curve. `gutter` is the clearance kept at each stage edge.
export const SELECTION_GUTTER = 12;

export function planSelectionPlacement({ anchor, box, stage }, options = {}) {
  // Destructuring defaults, not a spread: an explicit `undefined` from a caller
  // forwarding options must fall back, not yield NaN.
  const { gap = 10, tailInset = 28, gutter = SELECTION_GUTTER } = options;
  const minLeft = stage.left + gutter;
  const maxLeft = stage.left + stage.width - gutter - box.width;
  const centred = anchor.x - box.width / 2;
  // A box wider than the stage inverts the clamp; pin it to the left gutter.
  const left = maxLeft < minLeft ? minLeft : Math.min(Math.max(centred, minLeft), maxLeft);
  const belowTop = anchor.y + gap;
  const aboveTop = anchor.y - gap - box.height;
  const fitsBelow = belowTop + box.height <= stage.top + stage.height - gutter;
  const fitsAbove = aboveTop >= stage.top + gutter;
  // Neither fitting keeps `below`: overlapping an edge is recoverable.
  const side = fitsBelow || !fitsAbove ? "below" : "above";
  // From the ROUNDED left — the edge actually painted — or an odd width puts
  // the tail a pixel off the dot.
  const painted = Math.round(left);
  const tail = anchor.x - painted;
  const tailFits = tail >= tailInset && tail <= box.width - tailInset;
  return {
    left: painted,
    top: Math.round(side === "below" ? belowTop : aboveTop),
    side,
    tailOffset: anchor.visible !== false && tailFits ? Math.round(tail) : null,
  };
}
```

In `src/framework/viewer.js`, add after `releaseFlashPoints()`:

```js
  // The world position of the held marker the anchor stream follows, so a host
  // (mount's selection carry) can put the same marker back after a remount.
  function getHeldAnchorPoint() {
    return anchorDot ? [anchorDot.position.x, anchorDot.position.y, anchorDot.position.z] : null;
  }
```

and add `getHeldAnchorPoint,` to the returned object next to `releaseFlashPoints,`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/selection-placement.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection-placement.js test/selection-placement.test.js src/framework/viewer.js
git commit -m "selection popover: placement rule, and the held marker's world point"
```

---

### Task 2: The popover — spot page, slot, placement, closing

**Files:**
- Create: `src/framework/selection-popover.js`
- Create: `test/selection-popover.test.js`

**Interfaces:**
- Consumes: `planSelectionPlacement` (Task 1); `hexColor` from `parts-list.js`; a `parts` seam shaped like the view style popover's (`list()`, `setDisplay(name, patch)`, `onChange(cb) → off`, `getState(name)`, `clear(opts)`, `onViewChange(cb) → off`).
- Produces: `attachSelectionPopover({ stage, canvas = null, slot = false, parts, renderThumb = null, getSaveState = () => "screen-only", onClosed = null })` returning `{ element, open({subPart, anchor}) → boolean, setAnchor(anchor), setSlotHeight(px), showPage("spot"|"appearance") → boolean, close(reason?), isOpen(), getState() → {subPart, page}|null, onSlotChange(cb) → off, onClose(cb) → off, refreshSaveState(), detach() }`. `anchor` is `{x, y, visible?}` in STAGE css px. Task 3 fills in the appearance branch of `showPage` and `refreshSaveState`; in this task `showPage("appearance")` returns false.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/selection-popover.test.js`
Expected: FAIL — cannot resolve `selection-popover.js`.

- [ ] **Step 3: Implement**

```js
// src/framework/selection-popover.js
// The popover a pick opens at the picked spot (spec 2026-10-14 selection
// popover). Two pages: "spot" — a head row (the sub-part's swatch + label +
// material as ONE button that opens the appearance page, an eye that hides the
// part, ✕) and, for a host that asked for one, an empty SLOT the host floats
// its own UI over (partforge-cloud puts its chat composer there) — and
// "appearance", the appearance card (Task 3).
//
// It never decides anything about the slot's content: the host says how tall
// it must be (setSlotHeight) and is told where it is (onSlotChange). Mount owns
// the pick marker; this module is handed the marker's position in stage px.
import { hexColor } from "./parts-list.js";
import { planSelectionPlacement } from "./selection-placement.js";

const MIN_SLOT = 44;
const MAX_SLOT = 2000;
const ICONS = {
  eyeOff: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
};

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function attachSelectionPopover({ stage, canvas = null, slot = false, parts, renderThumb = null, getSaveState = () => "screen-only", onClosed = null } = {}) {
  const pop = el("div", "pf-selection-popover", { role: "dialog", "aria-label": "Selected spot" });
  pop.hidden = true;
  const tail = el("span", "pf-selection-tail", { "aria-hidden": "true" });
  const spot = el("div", "pf-selection-spot");
  const head = el("div", "pf-selection-head");
  const openBtn = el("button", "pf-selection-open", { type: "button" });
  const swatch = el("span", "pf-parts-swatch", { "aria-hidden": "true" });
  const nameEl = el("span", "pf-selection-name");
  const matEl = el("span", "pf-selection-mat");
  openBtn.append(swatch, nameEl, matEl);
  const eye = el("button", "pf-selection-eye", { type: "button" });
  eye.innerHTML = ICONS.eyeOff;
  const closeBtn = el("button", "pf-selection-close", { type: "button", "aria-label": "Close" });
  closeBtn.innerHTML = ICONS.close;
  head.append(openBtn, eye, closeBtn);
  spot.append(head);
  const slotEl = slot ? el("div", "pf-selection-slot") : null;
  if (slotEl) { slotEl.style.height = `${MIN_SLOT}px`; spot.append(slotEl); }
  pop.append(tail, spot);
  stage.append(pop);

  let current = null; // { subPart, anchor } while open
  let page = "spot";
  let card = null;    // Task 3
  let lastSlotKey = null;
  let detached = false;
  const slotCbs = new Set();
  const closeCbs = new Set();

  const isOpen = () => !pop.hidden;
  const rowFor = (n) => (typeof n === "string" ? parts.list().find((r) => r.name === n && r.inView) ?? null : null);

  function renderHead() {
    const row = rowFor(current?.subPart);
    openBtn.hidden = !row;
    eye.hidden = !row;
    if (!row) { pop.setAttribute("aria-label", "Selected spot"); return null; }
    swatch.style.setProperty("--pf-swatch", hexColor(row.color));
    swatch.classList.toggle("is-hidden", !!row.hidden);
    nameEl.textContent = row.label;
    matEl.textContent = row.materialLabel ?? "No material";
    openBtn.setAttribute("aria-label", `Change appearance of ${row.label}`);
    eye.setAttribute("aria-label", `Hide ${row.label}`);
    pop.setAttribute("aria-label", row.label);
    return row;
  }

  function emitSlot() {
    if (!slotEl || detached) return;
    let report;
    if (!isOpen()) report = { state: "closed" };
    else if (page !== "spot") report = { state: "collapsed" };
    else {
      const s = stage.getBoundingClientRect();
      const r = slotEl.getBoundingClientRect();
      report = { state: "open", rect: {
        x: Math.round(r.left - s.left), y: Math.round(r.top - s.top),
        width: Math.round(r.width), height: Math.round(r.height),
      } };
    }
    const key = JSON.stringify(report);
    if (key === lastSlotKey) return;
    lastSlotKey = key;
    for (const cb of [...slotCbs]) {
      try { cb(report); } catch (e) { console.warn("partforge: selection slot listener failed", e); }
    }
  }

  function place() {
    if (!isOpen() || !current?.anchor) return;
    const s = stage.getBoundingClientRect();
    pop.style.maxHeight = `${Math.max(120, Math.round(s.height) - 24)}px`;
    const plan = planSelectionPlacement({
      anchor: current.anchor,
      box: { width: pop.offsetWidth, height: pop.offsetHeight },
      stage: { left: 0, top: 0, width: s.width, height: s.height },
    });
    pop.style.left = `${plan.left}px`;
    pop.style.top = `${plan.top}px`;
    pop.dataset.side = plan.side;
    tail.hidden = plan.tailOffset === null;
    if (plan.tailOffset !== null) tail.style.left = `${plan.tailOffset - 6}px`;
    emitSlot();
  }

  // Task 3 extends the "appearance" branch; here only "spot" exists.
  function showPage(next) {
    if (next !== "spot") return false;
    page = "spot";
    pop.dataset.page = page;
    spot.hidden = false;
    if (!slot && !openBtn.hidden) openBtn.focus({ preventScroll: true });
    place();
    return true;
  }

  const onOutside = (e) => {
    const t = e.target;
    if (pop.contains(t)) return;
    // A canvas press is a pick (which re-points us) or an orbit (which we
    // follow) — never a dismiss.
    if (canvas && canvas.contains(t)) return;
    if (!stage.contains(t)) return;
    close("dismiss");
  };
  const onKey = (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    e.stopPropagation();
    e.preventDefault();
    close("dismiss");
  };
  pop.addEventListener("keydown", onKey);
  openBtn.addEventListener("click", () => showPage("appearance"));
  eye.addEventListener("click", () => {
    const n = current?.subPart;
    if (typeof n === "string") parts.setDisplay(n, { hidden: true });
    close("hide");
  });
  closeBtn.addEventListener("click", () => close("dismiss"));

  function open({ subPart = null, anchor } = {}) {
    if (detached || !anchor) return false;
    const n = typeof subPart === "string" ? subPart : null;
    if (!slot && !rowFor(n)) return false;
    const wasOpen = isOpen();
    current = { subPart: n, anchor };
    pop.hidden = false;
    renderHead();
    if (!wasOpen) document.addEventListener("pointerdown", onOutside, true);
    showPage("spot");
    return true;
  }

  function setAnchor(anchor) {
    if (!isOpen() || !anchor) return;
    current.anchor = anchor;
    place();
  }

  function setSlotHeight(px) {
    if (!slotEl || typeof px !== "number" || !Number.isFinite(px) || px < 0) return;
    slotEl.style.height = `${Math.min(MAX_SLOT, Math.max(MIN_SLOT, Math.round(px)))}px`;
    place();
  }

  function close(reason) {
    if (!isOpen()) return;
    pop.hidden = true;
    card?.hide?.();
    if (card) card.element.hidden = true;
    page = "spot";
    spot.hidden = false;
    current = null;
    document.removeEventListener("pointerdown", onOutside, true);
    emitSlot();
    if (reason) for (const cb of [...closeCbs]) {
      try { cb({ reason }); } catch (e) { console.warn("partforge: selection close listener failed", e); }
    }
    onClosed?.();
  }

  const offParts = parts.onChange?.(() => { if (isOpen()) { renderHead(); place(); } }) ?? (() => {});
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => place()) : null;
  ro?.observe(stage);
  ro?.observe(pop);

  return {
    element: pop,
    open,
    setAnchor,
    setSlotHeight,
    showPage,
    close: (reason) => close(reason === "dismiss" || reason === "hide" || reason === "gone" ? reason : undefined),
    isOpen,
    getState: () => (isOpen() ? { subPart: current.subPart, page } : null),
    onSlotChange: (cb) => { if (typeof cb !== "function") return () => {}; slotCbs.add(cb); return () => slotCbs.delete(cb); },
    onClose: (cb) => { if (typeof cb !== "function") return () => {}; closeCbs.add(cb); return () => closeCbs.delete(cb); },
    refreshSaveState: () => {},
    detach() {
      if (detached) return;
      detached = true;
      document.removeEventListener("pointerdown", onOutside, true);
      pop.removeEventListener("keydown", onKey);
      offParts();
      ro?.disconnect();
      card?.detach?.();
      slotCbs.clear();
      closeCbs.clear();
      pop.remove();
    },
  };
}
```

(`renderThumb` and `getSaveState` are accepted now and used in Task 3.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/selection-popover.test.js`
Expected: PASS (16 tests). If the ResizeObserver in happy-dom fires `place()` asynchronously and produces a second identical slot report, the coalescing already absorbs it — do not weaken the "coalescing" test.

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection-popover.js test/selection-popover.test.js
git commit -m "selection popover: the spot page, the host slot, placement and closing"
```

---

### Task 3: The appearance page

**Files:**
- Modify: `src/framework/selection-popover.js`
- Modify: `test/selection-popover.test.js` (append a describe block)

**Interfaces:**
- Consumes: `attachAppearanceCard(parts, { onBack, onClose, onGone, getSaveState, renderThumb })` from `appearance-card.js` → `{ element, show(name) → boolean, hide(), render(), detach() }`.
- Produces: `showPage("appearance") → boolean` (false when the head row has no listed sub-part, or the card refuses it); `refreshSaveState()` re-renders an open card.

- [ ] **Step 1: Write the failing tests** (append)

```js
describe("selection popover: the appearance page", () => {
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
  it("the head button opens the card, collapses the slot and focuses Back", () => {
    const { p, slots } = opened();
    p.element.querySelector(".pf-selection-open").click();
    expect(p.getState()).toEqual({ subPart: "body", page: "appearance" });
    expect(p.element.querySelector(".pf-selection-spot").hidden).toBe(true);
    const card = p.element.querySelector(".pf-card");
    expect(card.hidden).toBe(false);
    expect(document.activeElement).toBe(card.querySelector(".pf-card-back"));
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/selection-popover.test.js`
Expected: the 8 new tests FAIL (`showPage("appearance")` returns false; no `.pf-card`).

- [ ] **Step 3: Implement**

Add the import at the top of `selection-popover.js`:

```js
import { attachAppearanceCard } from "./appearance-card.js";
```

Replace `showPage` with:

```js
  // Built on first use, so a popover that never shows a card holds none of its
  // ~40 controls (the view style popover's rule).
  function ensureCard() {
    if (card) return card;
    card = attachAppearanceCard(parts, {
      onBack: () => showPage("spot"),
      onClose: () => close("dismiss"),
      // A rebuild dropped the part this card was for: the spot it pointed at
      // is gone too.
      onGone: () => { if (isOpen() && page === "appearance") close("gone"); },
      getSaveState,
      renderThumb,
    });
    card.element.hidden = true;
    pop.append(card.element);
    return card;
  }

  function showPage(next) {
    if (next === "appearance") {
      const n = current?.subPart;
      if (!isOpen() || !rowFor(n)) return false;
      if (!ensureCard().show(n)) return false;
    } else if (next !== "spot") {
      return false;
    }
    page = next;
    pop.dataset.page = page;
    spot.hidden = page !== "spot";
    if (card) {
      card.element.hidden = page !== "appearance";
      if (page !== "appearance") card.hide();
    }
    if (page === "appearance") card.element.querySelector(".pf-card-back")?.focus({ preventScroll: true });
    else if (!slot && !openBtn.hidden) openBtn.focus({ preventScroll: true });
    place();
    return true;
  }
```

and replace `refreshSaveState: () => {},` in the returned object with:

```js
    refreshSaveState: () => { if (isOpen() && page === "appearance") card?.render(); },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/selection-popover.test.js test/appearance-card.test.js`
Expected: PASS (24 + the appearance card suite unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection-popover.js test/selection-popover.test.js
git commit -m "selection popover: the appearance card as its second page"
```

---

### Task 4: Mount wiring, `runtime.selection`, and the carry

**Files:**
- Modify: `src/framework/mount.js` (the options docblock near `annotateSend`, the `mount(...)` signature ~line 483, beside `attachViewStyleControls` ~line 799, the picker's `onPick` ~line 891, `showView` ~line 1040, `makeHandle` ~line 75 and its call ~line 1650)
- Modify: `test/framework/mount.test.js` (mock viewer gains `getHeldAnchorPoint`; new tests appended)
- Modify: `test/mount-display-state.test.js` (handle defaults)

**Interfaces:**
- Consumes: `attachSelectionPopover` (Tasks 2–3); `viewer.getHeldAnchorPoint`, `viewer.holdFlashPoint`, `viewer.releaseFlashPoints`, `viewer.flashPoint`, `viewer.onFlashAnchorChange`, `viewer.domElement`; `measureMode.onModeChange/isEnabled`; `annotateMode?.onModeChange/isEnabled`; `viewChangeListeners`.
- Produces: mount option `selectionPopover: { slot: boolean }`; `runtime.selection: { setSlotHeight(px), onSlotChange(cb) → off, onClose(cb) → off, close(), isOpen() } | null`; `getViewerState().selection?: { subPart: string|null, point: [x,y,z], page: "spot"|"appearance" }`; `makeHandle({ selection, selectionState })`.

- [ ] **Step 1: Write the failing tests**

In `test/framework/mount.test.js`, add to the mock viewer object (beside `releaseFlashPoints`):

```js
      getHeldAnchorPoint: vi.fn(() => [1, 2, 3]),
```

Append:

```js
// --- selection popover (spec 2026-10-14) -----------------------------------
const pickBody = () => attachPicker.mock.calls.at(-1)[1].onPick(
  { subPart: "body", point: [0, 0, 0], normal: [0, 0, 1], params: {} }, { x: 40, y: 30 });

test("no selectionPopover: no popover node and runtime.selection is null", () => {
  const { createWorker } = makeWorkers();
  const els = makeElements();
  const runtime = mount(makePart(), { createWorker, elements: els, onPick: vi.fn() });
  pickBody();
  expect(els.viewer.querySelector(".pf-selection-popover")).toBeNull();
  expect(runtime.selection).toBeNull();
  runtime.dispose();
});

test("a pick tells the host first, then opens the popover and holds the marker", () => {
  const order = [];
  const onPick = vi.fn(() => order.push("host"));
  const { createWorker } = makeWorkers();
  const els = makeElements();
  const runtime = mount(makePart(), { createWorker, elements: els, onPick, selectionPopover: { slot: true } });
  const viewer = fakeViewers.at(-1);
  viewer.holdFlashPoint.mockImplementation(() => { order.push("hold"); return true; });
  pickBody();
  expect(order).toEqual(["host", "hold"]);
  expect(runtime.selection.isOpen()).toBe(true);
  expect(els.viewer.querySelector(".pf-selection-popover").hidden).toBe(false);
  runtime.dispose();
});

test("selectionPopover that is not an object is ignored", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn(), selectionPopover: true });
  expect(runtime.selection).toBeNull();
  runtime.dispose();
});

test("closing releases the marker once; the release's null anchor does not re-close", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn(), selectionPopover: { slot: true } });
  const viewer = fakeViewers.at(-1);
  viewer.releaseFlashPoints.mockImplementation(() => viewer.emitFlashAnchor(null));
  const reasons = [];
  runtime.selection.onClose((e) => reasons.push(e.reason));
  pickBody();
  runtime.selection.close();
  expect(viewer.releaseFlashPoints).toHaveBeenCalledTimes(1);
  expect(reasons).toEqual([]);
  runtime.dispose();
});

test("the marker going away (a host release) closes with gone", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn(), selectionPopover: { slot: true } });
  const viewer = fakeViewers.at(-1);
  const reasons = [];
  runtime.selection.onClose((e) => reasons.push(e.reason));
  pickBody();
  viewer.emitFlashAnchor(null);
  expect(reasons).toEqual(["gone"]);
  runtime.dispose();
});

test("measure mode turning on closes it with gone", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn(), selectionPopover: { slot: true } });
  const reasons = [];
  runtime.selection.onClose((e) => reasons.push(e.reason));
  pickBody();
  runtime.measure.setEnabled(true);
  expect(reasons).toEqual(["gone"]);
  runtime.dispose();
});

test("anchors from the marker stream move the popover", () => {
  const { createWorker } = makeWorkers();
  const els = makeElements();
  const runtime = mount(makePart(), { createWorker, elements: els, onPick: vi.fn(), selectionPopover: { slot: true } });
  const viewer = fakeViewers.at(-1);
  els.viewer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
  pickBody();
  const pop = els.viewer.querySelector(".pf-selection-popover");
  const before = pop.style.left;
  viewer.emitFlashAnchor({ x: 700, y: 30, visible: true });
  expect(pop.style.left).not.toBe(before);
  runtime.dispose();
});

test("getViewerState carries the open selection and nothing when closed", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn(), selectionPopover: { slot: true } });
  expect("selection" in runtime.getViewerState()).toBe(false);
  pickBody();
  expect(runtime.getViewerState().selection).toEqual({ subPart: "body", point: [1, 2, 3], page: "spot" });
  runtime.selection.close();
  expect("selection" in runtime.getViewerState()).toBe(false);
  runtime.dispose();
});

test("a carried selection reopens after the first build without a host onPick", () => {
  const onPick = vi.fn();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: makeElements(), onPick, selectionPopover: { slot: true },
    viewerState: { camera: null, projection: "perspective", cutaway: null, selection: { subPart: "body", point: [1, 2, 3], page: "spot" } },
  });
  const viewer = fakeViewers.at(-1);
  viewer.holdFlashPoint.mockImplementation(() => { viewer.emitFlashAnchor({ x: 50, y: 50, visible: true }); return true; });
  finishFirstBuild(workers);
  expect(viewer.flashPoint).toHaveBeenCalledWith([1, 2, 3]);
  expect(runtime.selection.isOpen()).toBe(true);
  expect(onPick).not.toHaveBeenCalled();
  runtime.dispose();
});

test("a carried selection whose sub-part is gone stays closed", () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: makeElements(), onPick: vi.fn(), selectionPopover: { slot: true },
    viewerState: { camera: null, projection: "perspective", cutaway: null, selection: { subPart: "ghost", point: [1, 2, 3], page: "spot" } },
  });
  const viewer = fakeViewers.at(-1);
  finishFirstBuild(workers);
  expect(viewer.flashPoint).not.toHaveBeenCalled();
  expect(runtime.selection.isOpen()).toBe(false);
  runtime.dispose();
});

test("a malformed carried point is ignored", () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: makeElements(), onPick: vi.fn(), selectionPopover: { slot: true },
    viewerState: { camera: null, projection: "perspective", cutaway: null, selection: { subPart: "body", point: [1, "x", 3], page: "spot" } },
  });
  finishFirstBuild(workers);
  expect(fakeViewers.at(-1).flashPoint).not.toHaveBeenCalled();
  runtime.dispose();
});

test("dispose emits no close", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn(), selectionPopover: { slot: true } });
  const onClose = vi.fn(); const onSlot = vi.fn();
  pickBody();
  runtime.selection.onClose(onClose);
  runtime.selection.onSlotChange(onSlot);
  runtime.dispose();
  expect(onClose).not.toHaveBeenCalled();
  expect(onSlot).not.toHaveBeenCalled();
});
```

In `test/mount-display-state.test.js`, add to the "openAppearance and setDisplaySaveState default…" test:

```js
    expect(h.selection).toBeNull();
    expect("selection" in h.getViewerState()).toBe(false);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/framework/mount.test.js test/mount-display-state.test.js`
Expected: the new tests FAIL (`runtime.selection` undefined, no popover node).

- [ ] **Step 3: Implement**

1. Import at the top of `mount.js`: `import { attachSelectionPopover } from "./selection-popover.js";`

2. Options docblock, after the `annotateSend` entry:

```js
// selectionPopover: { slot: boolean }    // opt in to the selection popover: a pick
//                                         // (onPick required) opens a popover at the
//                                         // spot — the sub-part's swatch/label/material
//                                         // (opens its appearance card), an eye, ✕ —
//                                         // and, with slot: true, an empty slot the
//                                         // host floats its own UI over (see
//                                         // runtime.selection). Absent or not an
//                                         // object: no popover, exactly as before.
```

3. Add `selectionPopover` to the `mount(part, { … })` destructuring.

4. Lift the parts seam passed to `attachViewStyleControls` into a const declared just above that call, and pass `parts: partsSeam`:

```js
    const partsSeam = {
      list: () => subPartRows(part, { view: view(), params, overrides: viewer.getDisplayOverrides?.() ?? {} }),
      setDisplay: (name, patch) => viewer.setSubPartDisplay(name, patch),
      clear: (opts) => viewer.clearSubPartDisplay(opts),
      onChange: (cb) => viewer.onDisplayChange?.(cb) ?? (() => {}),
      onViewChange: (cb) => { viewChangeListeners.add(cb); return () => viewChangeListeners.delete(cb); },
      getState: (name) => viewer.getSubPartDisplayState(name),
    };
```

5. Directly after `cleanup.defer(() => viewStyle.detach());`:

```js
    // The selection popover (spec 2026-10-14): opened by the picker below,
    // following the held pick marker. Only with onPick, and only for a host
    // that passed the option as an object.
    const selectionOpt = onPick && selectionPopover && typeof selectionPopover === "object"
      ? { slot: selectionPopover.slot === true } : null;
    let selPopover = null;
    let pendingSelection = null; // a carried selection waiting for its marker's first anchor
    // The marker's anchor is in canvas px; the popover lives in the stage.
    const toStage = (a) => {
      if (!a) return null;
      const s = els.viewer.getBoundingClientRect();
      const c = viewer.domElement.getBoundingClientRect();
      return { x: a.x + c.left - s.left, y: a.y + c.top - s.top, visible: a.visible !== false };
    };
    if (selectionOpt) {
      selPopover = attachSelectionPopover({
        stage: els.viewer, canvas: viewer.domElement, slot: selectionOpt.slot, parts: partsSeam,
        renderThumb: viewer.renderMaterialThumbnail ? (id, display) => viewer.renderMaterialThumbnail(display, { size: 96 }) : null,
        getSaveState: () => viewStyle.getSaveState?.() ?? "screen-only",
        // Every close lets the marker go. Its null anchor arrives with the
        // popover already closed, so the listener below ignores it.
        onClosed: () => viewer.releaseFlashPoints?.(),
      });
      cleanup.defer(() => selPopover.detach());
      cleanup.defer(viewer.onFlashAnchorChange?.((a) => {
        if (pendingSelection && a) {
          const carried = pendingSelection;
          pendingSelection = null;
          if (selPopover.open({ subPart: carried.subPart, anchor: toStage(a) }) && carried.page === "appearance") {
            selPopover.showPage("appearance");
          }
          return;
        }
        if (!selPopover.isOpen()) return;
        if (!a) { selPopover.close("gone"); return; }
        selPopover.setAnchor(toStage(a));
      }) ?? (() => {}));
      const closeGone = () => selPopover.close("gone");
      viewChangeListeners.add(closeGone);
      cleanup.defer(() => viewChangeListeners.delete(closeGone));
    }
```

(`measureMode` and `annotateMode` are created before this point — confirm by line order; if `attachViewStyleControls` precedes them in your checkout, put the two mode subscriptions below right after `measureMode`/`annotateMode` are created instead.)

```js
    if (selPopover) {
      cleanup.defer(measureMode.onModeChange(() => { if (measureMode.isEnabled()) selPopover.close("gone"); }));
      if (annotateMode) cleanup.defer(annotateMode.onModeChange(() => { if (annotateMode.isEnabled()) selPopover.close("gone"); }));
    }
```

6. In the picker's `onPick`, after the host call:

```js
        onPick: (selection, anchor) => {
          onPick({ /* …unchanged payload… */ });
          // After the host has its chip: open at the spot, and keep the marker.
          if (selPopover && selPopover.open({ subPart: selection.subPart ?? null, anchor: toStage(anchor) })) {
            viewer.holdFlashPoint?.();
          }
        },
```

7. The carry. Beside `let cutawayRestored = false;`:

```js
    let selectionRestored = false; // a carried selection, tried once, after the camera
    function restoreCarriedSelection() {
      selectionRestored = true;
      const c = viewerState?.selection;
      if (!selPopover || !c || !Array.isArray(c.point) || c.point.length !== 3 || !c.point.every(Number.isFinite)) return;
      const subPart = typeof c.subPart === "string" ? c.subPart : null;
      if (subPart !== null && !partsSeam.list().some((r) => r.name === subPart && r.inView)) return;
      pendingSelection = { subPart, page: c.page === "appearance" ? "appearance" : "spot" };
      viewer.flashPoint(c.point);
      // hold() publishes the marker's anchor synchronously; the listener opens us.
      if (!viewer.holdFlashPoint?.()) pendingSelection = null;
    }
```

At the end of `showView` (after the cutaway branches):

```js
      if (cameraRestored && !selectionRestored && !previewGate.isActive()) restoreCarriedSelection();
```

8. `makeHandle`: add `selection, selectionState` to its destructured parameters; add to the returned handle `selection: selection ?? null,`; and inside `getViewerState` after the `display` spread:

```js
      // The open selection popover, so a remount reopens it where it was.
      ...(() => { const s = selectionState?.(); return s ? { selection: s } : {}; })(),
```

In mount's `makeHandle({ … })` call add:

```js
      selection: selPopover ? {
        setSlotHeight: (px) => selPopover.setSlotHeight(px),
        onSlotChange: (cb) => selPopover.onSlotChange(cb),
        onClose: (cb) => selPopover.onClose(cb),
        close: () => selPopover.close(),
        isOpen: () => selPopover.isOpen(),
      } : null,
      selectionState: () => {
        const st = selPopover?.getState();
        const point = st ? viewer.getHeldAnchorPoint?.() : null;
        return st && point ? { subPart: st.subPart, point, page: st.page } : null;
      },
```

9. `setDisplaySaveState` must also refresh the selection popover's card: change it to

```js
      setDisplaySaveState: (state) => { viewStyle.setSaveState?.(state); selPopover?.refreshSaveState(); },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/framework/mount.test.js test/mount-display-state.test.js test/selection-popover.test.js`
Expected: PASS, with the pre-existing mount tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/framework/mount.js test/framework/mount.test.js test/mount-display-state.test.js
git commit -m "mount: selectionPopover option, runtime.selection, and the carry across a remount"
```

---

### Task 5: Styles, types, docs, a demo, release 0.150.0

**Files:**
- Modify: `src/framework/app.css` (after the `.pf-card` rules, ~line 840)
- Modify: `types/index.d.ts` (mount options near `onPick?` ~line 214, `ViewerState` ~line 318, the runtime near `pickMarker` ~line 705)
- Modify: `test/partforge.test-d.ts` (type assertions)
- Modify: `docs/AUTHORING-PARTS.md` (runtime section, after the `controlsFor` bullet ~line 3092)
- Modify: `src/app-materials.js` (opt the dev demo in)
- Modify: `package.json`, `package-lock.json` (root `version` → `0.150.0`)

- [ ] **Step 1: CSS**

```css
/* The selection popover (selection-popover.js): at the picked spot. */
.pf-selection-popover {
  position: absolute; z-index: 31;
  width: min(320px, calc(100% - 24px)); overflow: auto;
  padding: 8px; display: flex; flex-direction: column; gap: 8px;
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: 16px; box-shadow: var(--pf-shadow-float);
  color: var(--pf-text); font-size: 12px;
}
.pf-selection-popover[hidden], .pf-selection-popover [hidden] { display: none; }
.pf-selection-tail {
  position: absolute; width: 12px; height: 12px; transform: rotate(45deg);
  background: var(--pf-surface); border: 1px solid var(--pf-border);
}
.pf-selection-popover[data-side="below"] .pf-selection-tail { top: -7px; border-right: 0; border-bottom: 0; }
.pf-selection-popover[data-side="above"] .pf-selection-tail { bottom: -7px; border-left: 0; border-top: 0; }
.pf-selection-spot { display: flex; flex-direction: column; gap: 6px; }
.pf-selection-head { display: flex; align-items: center; gap: 2px; }
.pf-selection-open {
  flex: 1; min-width: 0; display: grid; grid-template-columns: 22px minmax(0, auto) minmax(0, 1fr);
  align-items: center; gap: 8px; padding: 3px 6px; border: 0; border-radius: 999px;
  background: none; font: inherit; color: var(--pf-text); text-align: left; cursor: pointer;
}
.pf-selection-open:hover { background: var(--pf-surface-2); }
.pf-selection-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-selection-mat { color: var(--pf-muted-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-selection-head .pf-parts-swatch.is-hidden { opacity: .35; }
.pf-selection-eye, .pf-selection-close {
  width: 28px; height: 28px; border: 0; background: none; color: var(--pf-muted-2);
  border-radius: 999px; display: grid; place-items: center; cursor: pointer; margin-left: auto;
}
.pf-selection-eye:hover, .pf-selection-close:hover { background: var(--pf-surface-2); color: var(--pf-text); }
/* The host's slot: an empty, sized region its UI floats over. */
.pf-selection-slot { flex: none; border-radius: 12px; }
.pf-selection-open:focus-visible, .pf-selection-eye:focus-visible, .pf-selection-close:focus-visible {
  outline: none; box-shadow: 0 0 0 3px color-mix(in oklab, var(--pf-accent) 35%, transparent);
}
```

- [ ] **Step 2: Types**

In the mount options interface, after `onPick?`:

```ts
  /** Opt in to the selection popover (requires `onPick`): a pick opens a popover at the spot with the sub-part's appearance controls, and with `slot: true` an empty region the host floats its own UI over (`runtime.selection`). */
  selectionPopover?: { slot: boolean };
```

In `ViewerState`:

```ts
  /** The open selection popover, reopened by the next mount if the sub-part is still in the view. */
  selection?: { subPart: string | null; point: [number, number, number]; page: "spot" | "appearance" };
```

New interface beside `PickMarkerRuntime`:

```ts
export type SelectionSlotReport =
  | { state: "open"; rect: { x: number; y: number; width: number; height: number } }
  | { state: "collapsed" }
  | { state: "closed" };

export interface SelectionRuntime {
  /** The height (CSS px, integer, 44–2000) the host's slot content needs. */
  setSlotHeight(px: number): void;
  /** Where the slot is, in stage CSS px; fires on every change. Never fires for `slot: false`. */
  onSlotChange(cb: (report: SelectionSlotReport) => void): () => void;
  /** Why partforge closed it. A host's own `close()` does not fire this. */
  onClose(cb: (event: { reason: "dismiss" | "hide" | "gone" }) => void): () => void;
  close(): void;
  isOpen(): boolean;
}
```

On the runtime, after `pickMarker`:

```ts
  /** The selection popover, or `null` without the `selectionPopover` option. */
  selection: SelectionRuntime | null;
```

In `test/partforge.test-d.ts` add (following that file's existing `expectTypeOf` style):

```ts
expectTypeOf(runtime.selection).toEqualTypeOf<SelectionRuntime | null>();
expectTypeOf<ViewerState["selection"]>().toEqualTypeOf<{ subPart: string | null; point: [number, number, number]; page: "spot" | "appearance" } | undefined>();
```

(import `SelectionRuntime` alongside the file's other type imports; use whatever variable name the file already gives its mounted runtime.)

- [ ] **Step 3: Docs** — after the `controlsFor` bullet in `docs/AUTHORING-PARTS.md`:

```markdown
- **The selection popover.** Pass `selectionPopover: { slot: true | false }` (with `onPick`)
  and a pick opens a popover at the picked spot: the sub-part's swatch, label and material as
  one button that opens its appearance card as the popover's second page, an eye that hides
  it, and ✕. With `slot: true` the popover also holds an empty region the host fills with its
  own UI (a chat box, say) floated over the frame: tell partforge how tall it must be with
  `runtime.selection.setSlotHeight(px)` and hear where it is with
  `runtime.selection.onSlotChange(({ state, rect }) => …)` — `state` is `"open"` (with a rect
  in stage px), `"collapsed"` (the card page is showing) or `"closed"`.
  `runtime.selection.onClose(({ reason }) => …)` says why partforge closed it (`"dismiss"`,
  `"hide"`, `"gone"`); `runtime.selection.close()` closes it from the host. An open popover
  rides `getViewerState().selection`, so a remount reopens it. `runtime.selection` is `null`
  without the option. `runtime.controlsFor(selection)` is the intended source for a future
  page of the controls that shape the picked spot.
```

- [ ] **Step 4: Demo opt-in** — in `src/app-materials.js`, add to the `mount(...)` options:

```js
  onPick: (pick) => { window.__pfLastPick = pick; },
  selectionPopover: { slot: false },
```

- [ ] **Step 5: Version** — set `"version": "0.150.0"` in `package.json` and both root `version` fields in `package-lock.json` (the top-level one and `packages[""]`).

- [ ] **Step 6: Full verification**

Run: `npm test && npm run lint && npx tsc -p tsconfig.json --noEmit`
Expected: all green; lint warning count not higher than on `origin/main` (compare with `git stash`-free method: run `npm run lint 2>&1 | tail -3` on a clean `origin/main` worktree if the count changed).

- [ ] **Step 7: Browser check** — start the dev server (`npm run dev`, never on port 3000), open `/materials.html`, click a swatch sphere: the popover appears below the dot with the swatch name and material; the head button opens the card and Back returns; the eye hides the sphere and closes; orbiting with the popover open moves it with the dot; clicking another sphere re-points it; pressing Escape closes it. Check at a 390px-wide window that it stays inside the stage. Take a screenshot of the open card page for the PR.

- [ ] **Step 8: Commit**

```bash
git add src/framework/app.css types/index.d.ts test/partforge.test-d.ts docs/AUTHORING-PARTS.md src/app-materials.js package.json package-lock.json
git commit -m "selection popover: styles, types, docs, materials demo; 0.150.0"
```
