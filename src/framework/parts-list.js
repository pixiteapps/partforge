// src/framework/parts-list.js
// The View style popover's Parts section: the sub-parts in the active view,
// one row each with an eye (hide / show) and a swatch + name (opens the appearance
// card), plus Show all. DOM only; the row model is sub-part-list.js's and the
// state is the viewer's — this module renders `parts.list()` and calls
// `parts.setDisplay` / `parts.clear`, nothing more.
const EYE = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`;

export const hexColor = (int) => `#${(int >>> 0).toString(16).padStart(6, "0").slice(-6)}`;

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// `onSwatch(name)` opens the card. Returns { element, render, detach }.
export function attachPartsList(parts, { onSwatch } = {}) {
  const section = el("div", "pf-parts");
  const head = el("div", "pf-parts-head");
  const heading = el("p", "pf-view-style-heading pf-parts-heading");
  heading.textContent = "Parts";
  const showAll = el("button", "pf-parts-showall", { type: "button" });
  showAll.textContent = "Show all";
  showAll.hidden = true;
  showAll.addEventListener("click", () => { parts.clear({ viewing: true }); render(); });
  head.append(heading, showAll);
  const list = el("div", "pf-parts-list", { role: "list" });
  section.append(head, list);

  // Every render rebuilds the rows, so the control that had focus (an eye
  // just clicked from the keyboard) and the scroll position would be lost
  // with the old nodes. Both are remembered here and put back afterwards: the
  // focus by row name and control kind, the scroll on the list and on its
  // scrolling container (the popover, which is what actually scrolls).
  function focusedControl() {
    const a = document.activeElement;
    if (!a || !list.contains(a)) return null;
    const row = a.closest(".pf-parts-row");
    if (!row) return null;
    return { name: row.dataset.name, kind: a.classList.contains("pf-parts-open") ? "open" : "eye" };
  }
  function restoreFocus(was) {
    if (!was) return;
    const row = [...list.children].find((r) => r.dataset.name === was.name);
    row?.querySelector(was.kind === "open" ? ".pf-parts-open" : ".pf-parts-eye")?.focus({ preventScroll: true });
  }

  // One render path. Clicks render synchronously (a host whose `onChange`
  // never fires still updates); a display change from anywhere schedules a
  // render for the next microtask, and a synchronous render in between
  // cancels it — so a click whose setDisplay also emits renders once.
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { if (pending) render(); });
  }

  function render() {
    pending = false;
    const all = parts.list();
    const rows = all.filter((r) => r.inView);
    const was = focusedControl();
    const scroller = section.parentElement;
    const listTop = list.scrollTop, outerTop = scroller?.scrollTop ?? 0;
    list.replaceChildren(...rows.map((r) => {
      const row = el("div", "pf-parts-row", { role: "listitem", "data-name": r.name });
      if (r.hidden) row.classList.add("hidden");
      else if (r.opacity < 1) row.classList.add("faded");
      const eye = el("button", "pf-parts-eye", { type: "button", "aria-pressed": String(r.hidden), "aria-label": `${r.hidden ? "Show" : "Hide"} ${r.label}` });
      eye.title = eye.getAttribute("aria-label");
      eye.innerHTML = r.hidden ? EYE_OFF : EYE;
      eye.addEventListener("click", () => { parts.setDisplay(r.name, { hidden: !r.hidden }); render(); });
      // Swatch, name and material are ONE button: the whole row past the eye
      // opens the card, not just the 22px disc.
      const open = el("button", "pf-parts-open", { type: "button", "aria-label": `Change appearance of ${r.label}` });
      open.title = open.getAttribute("aria-label");
      const swatch = el("span", "pf-parts-swatch");
      swatch.style.setProperty("--pf-swatch", hexColor(r.color));
      const name = el("span", "pf-parts-name"); name.textContent = r.label;
      const mat = el("span", "pf-parts-mat"); mat.textContent = r.materialLabel ?? "";
      open.append(swatch, name, mat);
      open.addEventListener("click", () => onSwatch?.(r.name));
      row.append(eye, open);
      return row;
    }));
    list.scrollTop = listTop;
    if (scroller) scroller.scrollTop = outerTop;
    restoreFocus(was);
    // Show all hides itself once it has done its job; if it held focus, hand
    // focus to the first row's eye rather than dropping it on the page.
    const showAllHadFocus = document.activeElement === showAll;
    showAll.hidden = !all.some((r) => r.hidden || r.opacity < 1);
    if (showAllHadFocus && showAll.hidden) list.querySelector(".pf-parts-eye")?.focus({ preventScroll: true });
  }

  const offs = [parts.onChange(() => schedule()), parts.onViewChange?.(() => render()) ?? (() => {})];
  render();
  return { element: section, render, detach() { for (const off of offs) { try { off(); } catch { /* gone */ } } section.remove(); } };
}
