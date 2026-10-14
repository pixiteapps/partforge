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
