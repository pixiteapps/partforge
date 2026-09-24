// src/framework/view-style-controls.js
// The view style button and its popover: every control that changes HOW the
// part is drawn, in one place — the style (CAD or a realistic environment, as
// live thumbnails of this part), feature lines for that style, and the
// projection. Generated into the stage, not declared by the host (the view
// cube / mobile-tabs.js precedent), so an embedder gets it with no markup.
//
// The button replaces the view cube's old projection toggle, in the same
// place: a DOM child of the cube's stack (so it hides whenever the cube
// does), over the cube's bottom-right corner (chrome.css), wearing #viewbar's
// chrome so it reads as a control rather than a mark on the cube. The
// popover opens ABOVE it, placed from the button's rect at open time.
//
// The state shown is always the viewer's: a tile is pressed once the viewer
// reports that style, and a runtime change made elsewhere shows up here.
import { STYLES, styleFor, createThumbnailCache } from "./view-style-state.js";
import { saveRenderMode, saveEnvironment } from "./view-state.js";
import { attachButtonTooltips } from "./tooltip.js";

// A movie camera (lucide "video"): the button is about how the part is
// RENDERED, not about colour — a palette read as a paint/colour picker.
const ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>`;
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
  // A part change WHILE open (a playing animation re-shows the assembly every
  // frame) does not abort the loop: it only marks the cache stale for the
  // next open. Aborting on it — the first version — left every tile after the
  // first empty for as long as an animation played (seen on hinged-box.html).
  // A slightly older pose is fine here: a thumbnail shows the style, not a
  // live mirror (spec). What does stop a loop is a close (below), detach, or a
  // newer loop started by a reopen.
  let loopToken = 0;
  async function refreshThumbnails() {
    if (!cache.isStale()) return;
    cache.markFresh();
    const token = ++loopToken;
    // One at a time: each realistic style may load an environment.
    for (const s of STYLES) {
      if (detached || token !== loopToken) return;
      // Spec: thumbnails render on open, never while closed. A close mid-loop
      // stops it here and marks the cache stale, so the next open resumes
      // (re-rendering from the top; the finished ones are cheap to repeat and
      // keep one freshness flag rather than per-style bookkeeping).
      if (!isOpen()) { cache.invalidate(); return; }
      let url = null;
      try { url = await viewer.renderStyleThumbnail(s.id, { size: 256 }); } catch { url = null; }
      if (detached || token !== loopToken) return;
      cache.set(s.id, url);
      paint(s.id);
    }
  }

  // A feature-lines change alters exactly one style's picture (the style it
  // was made for). While open, that tile re-renders at once — the user just
  // flipped the switch under it; the cache is also marked stale, so a loop
  // that drew this style before the change cannot leave the old picture for
  // the next open.
  async function onLinesChange(evt) {
    cache.invalidate();
    if (!isOpen()) return;
    const id = evt?.style ?? styleFor(viewer.getRenderMode(), viewer.getEnvironment());
    if (!tiles.has(id)) return;
    let url = null;
    try { url = await viewer.renderStyleThumbnail(id, { size: 256 }); } catch { url = null; }
    if (detached) return;
    cache.set(id, url);
    paint(id);
  }

  // --- open / close ------------------------------------------------------------
  const isOpen = () => !pop.hidden;
  const onOutside = (e) => {
    if (!pop.contains(e.target) && !button.contains(e.target)) close({ focus: false });
  };
  // Escape is ours only while focus is in the popover or on the button: the
  // listener sits on those two elements rather than on document, so it runs
  // BEFORE the stage-level Escape handlers (measure, cutaway — they listen on
  // the stage and #viewbar) and stopPropagation keeps them from also treating
  // this key as their exit. Escape pressed anywhere else is left alone.
  const onKey = (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  button.addEventListener("keydown", onKey);
  pop.addEventListener("keydown", onKey);
  // Above the button, right edges aligned, never past the stage's top — and
  // clamped so it never runs off the stage's left edge either: a stage
  // narrower than the popover plus the button's inset (today 12px; it was
  // ~121px while the button sat beside the cube) would otherwise push it out.
  function place() {
    const s = stage.getBoundingClientRect(), b = button.getBoundingClientRect();
    const width = pop.offsetWidth;
    let right = Math.max(8, s.right - b.right);
    if (width && s.width - right - width < 8) right = Math.max(8, s.width - width - 8);
    pop.style.right = `${right}px`;
    pop.style.bottom = `${Math.max(8, s.bottom - b.top + 8)}px`;
    pop.style.maxHeight = `${Math.max(160, b.top - s.top - 16)}px`;
  }
  function open() {
    if (isOpen() || button.hidden || anchor?.hidden) return;
    // Unhidden before placing so its width can be measured (same frame: no paint between).
    pop.hidden = false;
    place();
    button.setAttribute("aria-expanded", "true");
    button.classList.add("on");
    render();
    document.addEventListener("pointerdown", onOutside, true);
    refreshThumbnails();
  }
  function close({ focus = true } = {}) {
    if (!isOpen()) return;
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("on");
    document.removeEventListener("pointerdown", onOutside, true);
    if (focus) button.focus();
  }
  const onButton = () => (isOpen() ? close() : open());
  button.addEventListener("click", onButton);

  const offs = [
    viewer.onRenderModeChange(() => render()),
    viewer.onEnvironmentChange(() => render()),
    viewer.onProjectionChange(() => render()),
    viewer.onFeatureLinesChange((evt) => { render(); onLinesChange(evt); }),
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
      button.removeEventListener("keydown", onKey);
      pop.removeEventListener("keydown", onKey);
      for (const off of offs) { try { off(); } catch { /* already gone */ } }
      tooltipBinding?.detach();
      hideObserver?.disconnect();
      button.remove();
      pop.remove();
    },
  };
}
