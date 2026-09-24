// src/framework/view-style-controls.js
// The view style button and its popover: every control that changes HOW the
// part is drawn, in one place — the style (CAD or a realistic environment, as
// live thumbnails of this part), feature lines for that style, and the
// projection. Generated into the stage, not declared by the host (the view
// cube / mobile-tabs.js precedent), so an embedder gets it with no markup.
//
// The button replaces the view cube's old projection toggle, in the cube's
// stack (so it hides whenever the cube does), and wears #viewbar's chrome so
// it reads as a control rather than a mark on the cube. The popover opens
// ABOVE it, placed from the button's rect at open time.
//
// The state shown is always the viewer's: a tile is pressed once the viewer
// reports that style, and a runtime change made elsewhere shows up here.
import { STYLES, styleFor, createThumbnailCache } from "./view-style-state.js";
import { saveRenderMode, saveEnvironment } from "./view-state.js";
import { attachButtonTooltips } from "./tooltip.js";

const ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/></svg>`;
const LABEL = "View style";

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function attachViewStyleControls(viewer, { stage, anchor } = {}, { tooltip } = {}) {
  const button = el("button", "pf-view-style-button", {
    type: "button", id: "view-style", "aria-label": LABEL,
    "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "pf-view-style-popover",
  });
  button.innerHTML = ICON;
  if (!tooltip) button.title = LABEL;
  (anchor ?? stage).append(button);

  const pop = el("div", "pf-view-style-popover", { id: "pf-view-style-popover", role: "dialog", "aria-label": LABEL });
  pop.hidden = true;

  const styleHead = el("p", "pf-view-style-heading");
  styleHead.textContent = "Style";
  const grid = el("div", "pf-view-style-grid", { role: "group", "aria-label": "Style" });
  const tiles = new Map();
  for (const s of STYLES) {
    const t = el("button", "pf-view-style-tile", { type: "button", "aria-pressed": "false" });
    t.dataset.style = s.id;
    const thumb = el("span", "pf-view-style-thumb");
    const img = el("img", "", { alt: "" });
    img.hidden = true;
    thumb.append(img);
    const label = el("span", "pf-view-style-label");
    label.textContent = s.label;
    t.append(thumb, label);
    t.addEventListener("click", () => choose(s.id));
    grid.append(t);
    tiles.set(s.id, { tile: t, img });
  }

  const linesRow = el("div", "pf-view-style-row");
  const linesLabel = el("span", "", { id: "pf-view-style-lines-label" });
  linesLabel.textContent = "Feature lines";
  const sw = el("button", "pf-view-style-switch", { type: "button", role: "switch", "aria-checked": "false", "aria-labelledby": "pf-view-style-lines-label" });
  sw.append(el("span", "pf-view-style-knob"));
  sw.addEventListener("click", () => viewer.setFeatureLines(!viewer.getFeatureLines()));
  linesRow.append(linesLabel, sw);

  const projRow = el("div", "pf-view-style-row");
  const projLabel = el("span", "", { id: "pf-view-style-proj-label" });
  projLabel.textContent = "Projection";
  const seg = el("div", "pf-view-style-seg", { role: "radiogroup", "aria-labelledby": "pf-view-style-proj-label" });
  const projButtons = [["perspective", "Perspective"], ["orthographic", "Orthographic"]].map(([id, text]) => {
    const b = el("button", "", { type: "button", role: "radio", "aria-checked": "false" });
    b.dataset.projection = id;
    b.textContent = text;
    b.addEventListener("click", () => { viewer.setProjection(id); render(); });
    seg.append(b);
    return b;
  });
  projRow.append(projLabel, seg);

  pop.append(styleHead, grid, linesRow, projRow);
  stage.append(pop);

  const tooltipBinding = tooltip ? attachButtonTooltips(tooltip, [{ element: button }]) : null;

  let detached = false;

  // --- state -----------------------------------------------------------------
  let pendingStyle = null; // a tile clicked whose switch is still loading
  function render() {
    const current = styleFor(viewer.getRenderMode(), viewer.getEnvironment());
    for (const [id, { tile }] of tiles) {
      tile.setAttribute("aria-pressed", String(id === current));
      if (id === pendingStyle && id !== current) tile.dataset.busy = "true"; else delete tile.dataset.busy;
    }
    sw.setAttribute("aria-checked", String(!!viewer.getFeatureLines()));
    const proj = viewer.getProjection();
    for (const b of projButtons) b.setAttribute("aria-checked", String(b.dataset.projection === proj));
    tooltipBinding?.sync();
  }

  // What persists is what the viewer says took effect (the realistic-controls
  // rule this replaces): a failed load settles to CAD and CAD is saved.
  async function choose(id) {
    pendingStyle = id;
    render();
    try {
      if (id === "cad") {
        saveRenderMode(await viewer.setRenderMode("cad"));
      } else {
        saveEnvironment(await viewer.setEnvironment(id));
        saveRenderMode(await viewer.setRenderMode("realistic"));
      }
    } catch { /* the viewer reports failures through its mode event */ }
    if (pendingStyle === id) pendingStyle = null;
    render();
  }

  // --- thumbnails (spec: live, cached; re-rendered on the next OPEN after a change)
  const cache = createThumbnailCache();
  function paint(id) {
    const { img } = tiles.get(id);
    const url = cache.get(id);
    if (url) { img.src = url; img.hidden = false; } else { img.hidden = true; }
  }
  async function refreshThumbnails() {
    if (!cache.isStale()) return;
    cache.markFresh();
    const gen = cache.generation();
    // One at a time: each realistic style may load an environment.
    for (const s of STYLES) {
      let url = null;
      try { url = await viewer.renderStyleThumbnail(s.id, { size: 256 }); } catch { url = null; }
      if (detached || gen !== cache.generation()) return;
      cache.set(s.id, url);
      paint(s.id);
    }
  }

  // --- open / close ------------------------------------------------------------
  const isOpen = () => !pop.hidden;
  const onOutside = (e) => {
    if (!pop.contains(e.target) && !button.contains(e.target)) close({ focus: false });
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  // Above the button, right edges aligned, never past the stage's top.
  function place() {
    const s = stage.getBoundingClientRect(), b = button.getBoundingClientRect();
    pop.style.right = `${Math.max(8, s.right - b.right)}px`;
    pop.style.bottom = `${Math.max(8, s.bottom - b.top + 8)}px`;
    pop.style.maxHeight = `${Math.max(160, b.top - s.top - 16)}px`;
  }
  function open() {
    if (isOpen() || button.hidden || anchor?.hidden) return;
    place();
    pop.hidden = false;
    button.setAttribute("aria-expanded", "true");
    button.classList.add("on");
    render();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
    refreshThumbnails();
  }
  function close({ focus = true } = {}) {
    if (!isOpen()) return;
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("on");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey);
    if (focus) button.focus();
  }
  const onButton = () => (isOpen() ? close() : open());
  button.addEventListener("click", onButton);

  const offs = [
    viewer.onRenderModeChange(() => render()),
    viewer.onEnvironmentChange(() => render()),
    viewer.onProjectionChange(() => render()),
    viewer.onFeatureLinesChange(() => render()),
    viewer.onAssemblyChange?.(() => cache.invalidate()) ?? (() => {}),
    viewer.onThemeChange?.(() => cache.invalidate()) ?? (() => {}),
  ];
  render();
  // The cube hides for Sketch mode and for a crowded transport bar; the
  // button goes with it (it is in the stack), and an open popover must too.
  const hideObserver = anchor && typeof MutationObserver === "function"
    ? new MutationObserver(() => { if (anchor.hidden) close({ focus: false }); })
    : null;
  hideObserver?.observe(anchor, { attributes: true, attributeFilter: ["hidden"] });

  return {
    element: button,
    popover: pop,
    isOpen,
    open,
    close,
    setHidden(flag) {
      if (flag) close({ focus: false });
      button.hidden = !!flag;
    },
    sync: render,
    detach() {
      if (detached) return;
      detached = true;
      close({ focus: false });
      button.removeEventListener("click", onButton);
      for (const off of offs) { try { off(); } catch { /* already gone */ } }
      tooltipBinding?.detach();
      hideObserver?.disconnect();
      button.remove();
      pop.remove();
    },
  };
}
