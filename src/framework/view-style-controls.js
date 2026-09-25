// src/framework/view-style-controls.js
// The view style button and its popover: every control that changes HOW the
// part is drawn, in one place — the style (CAD or a realistic environment, as
// live thumbnails of this part). Generated into the
// stage, not declared by the host (the view cube / mobile-tabs.js
// precedent), so an embedder gets it with no markup.
//
// WHERE the button goes is chosen once, at attach time:
//
//   - toolbar mode (a `toolbar` was passed — the stage's #viewbar): the
//     button joins the bottom toolbar's APPEARANCE group, inserted just
//     before #theme (appended when there is none) behind a divider
//     (`.pf-viewbar-divider`), so the pill reads "tools | appearance". It is a
//     plain `#viewbar button` there — no card chrome of its own — and it does
//     not hide with the view cube (it is not on the cube any more). The
//     popover opens ABOVE the pill, its right edge flush with the PILL's
//     right edge. Moved here 2026-09-24 at the user's request after a live
//     mock, following Fusion 360's display-settings-in-the-nav-bar convention.
//   - fallback (no toolbar — a host that supplies no #viewbar): the button is
//     a card-chromed child of the view cube's stack (`anchor`), over the
//     cube's bottom-right corner (chrome.css), hiding whenever the cube does;
//     the popover opens above the BUTTON.
//
// Either way the popover closes whenever the button's host (#viewbar, or the
// cube's stack) is hidden — Sketch mode hides both — whether by the `hidden`
// attribute or by CSS (partforge-cloud hides #viewbar with a class, which is
// display:none and no attribute at all). One code path for the popover; only
// its reference rect and the observed host differ.
//
// Through 2026-09-24 the popover also held a Projection row (a Perspective /
// Orthographic segmented control). It went when the projection became
// AUTOMATIC — orthographic on a view cube face view, perspective everywhere
// else (Fusion 360's "Perspective with Ortho Faces"; viewer.js's
// tweenCameraTo) — so the popover is the style grid alone.
//
// The state shown is always the viewer's: a tile is pressed once the viewer
// reports that style, and a runtime change made elsewhere shows up here.
import { STYLES, styleFor, createThumbnailCache } from "./view-style-state.js";
import { saveRenderMode, saveEnvironment } from "./view-state.js";
import { attachButtonTooltips } from "./tooltip.js";

// An eye (lucide "eye"): the button is about how the part is SEEN — a
// palette read as a paint/colour picker, and a movie camera (its icon until
// the move into the toolbar) as recording. One icon in both states: the
// open popover is signalled by `.on` and aria-expanded, never an eye-off.
const ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
const LABEL = "View style";

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function attachViewStyleControls(viewer, { stage, toolbar = null, anchor = null } = {}, { tooltip } = {}) {
  const button = el("button", "pf-view-style-button", {
    type: "button", id: "view-style", "aria-label": LABEL,
    "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "pf-view-style-popover",
  });
  button.innerHTML = ICON;
  if (!tooltip) button.title = LABEL;
  // The toolbar wins; see the header. `host` is the element whose `hidden`
  // closes the popover, `placeRef` the rect the popover is placed from.
  let divider = null;
  const host = toolbar ?? anchor;
  if (toolbar) {
    divider = el("span", "pf-viewbar-divider", { "aria-hidden": "true" });
    const theme = [...toolbar.children].find((c) => c.id === "theme") ?? null;
    toolbar.insertBefore(divider, theme);
    toolbar.insertBefore(button, theme);
  } else {
    (anchor ?? stage).append(button);
  }
  const placeRef = toolbar ?? button;

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

  pop.append(styleHead, grid);
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
    let missed = false;
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
      // A failed or empty render (null) blanks its tile rather than leaving an
      // older picture up, and leaves the cache stale so the next open tries
      // again: caching it made one bad moment permanent until a part or theme
      // change came along.
      cache.set(s.id, url);
      if (!url) missed = true;
      paint(s.id);
    }
    if (missed && token === loopToken) cache.invalidate();
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
  // Above the reference (the toolbar pill, else the button), right edges
  // aligned, 8px clear of its top, never past the stage's top — and clamped
  // so it never runs off the stage's left edge either: a stage narrower than
  // the popover plus the reference's inset (12px for either placement today)
  // would otherwise push it out.
  function place() {
    const s = stage.getBoundingClientRect(), b = placeRef.getBoundingClientRect();
    const width = pop.offsetWidth;
    let right = Math.max(8, s.right - b.right);
    if (width && s.width - right - width < 8) right = Math.max(8, s.width - width - 8);
    pop.style.right = `${right}px`;
    pop.style.bottom = `${Math.max(8, s.bottom - b.top + 8)}px`;
    pop.style.maxHeight = `${Math.max(160, b.top - s.top - 16)}px`;
  }
  function open() {
    if (isOpen() || button.hidden || host?.hidden) return;
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
    viewer.onAssemblyChange?.(() => cache.invalidate()) ?? (() => {}),
    viewer.onThemeChange?.(() => cache.invalidate()) ?? (() => {}),
    // A thumbnail shows the section as it was when it was taken, so turning
    // the cutaway on or off, or moving its plane, stales them all — without
    // this a set taken with the cutaway on outlived the cutaway itself.
    viewer.onCutawayChange?.(() => cache.invalidate()) ?? (() => {}),
  ];
  render();
  // The popover closes whenever the button's host is hidden: #viewbar hides
  // for Sketch mode; the cube's stack (fallback) for Sketch and for a crowded
  // transport bar. Observing the host actually holding the button means the
  // toolbar button does NOT go away when the cube hides for crowding.
  //
  // Two observers, because there are two ways to hide it. The `hidden`
  // attribute is what this framework sets; a HOST may instead hide the bar with
  // its own CSS (partforge-cloud toggles a class on #viewbar), which sets no
  // attribute. That one is caught by size: a display:none element — or one
  // inside a display:none ancestor — has no layout box, which a ResizeObserver
  // reports as a 0x0 resize. Read off the element (getClientRects is empty for
  // an element with no box) rather than the entry, so the test does not depend
  // on which box the observer measured. An element that has simply not been
  // laid out yet is never OPEN, so the early callback a ResizeObserver makes on
  // observe() closes nothing.
  const hostHidden = () => host.hidden || host.getClientRects().length === 0;
  const hideObserver = host && typeof MutationObserver === "function"
    ? new MutationObserver(() => { if (host.hidden) close({ focus: false }); })
    : null;
  hideObserver?.observe(host, { attributes: true, attributeFilter: ["hidden"] });
  const sizeObserver = host && typeof ResizeObserver === "function"
    ? new ResizeObserver(() => { if (isOpen() && hostHidden()) close({ focus: false }); })
    : null;
  sizeObserver?.observe(host);

  return {
    element: button,
    placement: toolbar ? "toolbar" : "anchor",
    popover: pop,
    isOpen,
    open,
    close,
    // The divider belongs to the button (it separates the appearance group
    // the button opens), so it goes with it — else a hidden button leaves a
    // stray rule at the end of the tools group.
    setHidden(flag) {
      if (flag) close({ focus: false });
      button.hidden = !!flag;
      if (divider) divider.hidden = !!flag;
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
      sizeObserver?.disconnect();
      button.remove();
      divider?.remove();
      pop.remove();
    },
  };
}
