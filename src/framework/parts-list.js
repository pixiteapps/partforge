// src/framework/parts-list.js
// The View style popover's Parts section: the sub-parts in the active view,
// one row each with an eye (hide / show) and a swatch + name (opens the appearance
// card), plus Show all. DOM only; the row model is sub-part-list.js's and the
// state is the viewer's — this module renders `parts.list()` and calls
// `parts.setDisplay` / `parts.clear`, nothing more.
//
// A seam carrying `compare` (compare-view.js's) adds the reference compare view:
// a "Show differences" switch above the list while the view shows a part with
// its reference, and, while a comparison is drawn, three piece rows under that
// part's row ("Matches", "Missing from <part>", "Extra in <part>"). A piece row
// has no appearance button (the pieces are flat colours and always opaque, so
// there is no see-through control), and only Missing and Extra have an eye.
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
  const compare = parts.compare ?? null;
  const compareSwitch = compare ? el("button", "pf-parts-compare", { type: "button", role: "switch" }) : null;
  if (compareSwitch) {
    compareSwitch.hidden = true;
    compareSwitch.addEventListener("click", () => {
      const t = compare.state()?.toggle;
      if (t && !t.disabled) { compare.setEnabled(!t.on); render(); }
    });
    section.append(head, compareSwitch, list);
  } else {
    section.append(head, list);
  }

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
    return { name: row.dataset.name, piece: row.dataset.piece, kind: a.classList.contains("pf-parts-open") ? "open" : "eye" };
  }
  function restoreFocus(was) {
    if (!was) return;
    const row = [...list.children].find((r) => (was.piece ? r.dataset.piece === was.piece : r.dataset.name === was.name && !r.dataset.piece));
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

  // What the list last drew, as one string over every field a row or the
  // Show all button reads. A render whose rows read the same leaves the DOM
  // alone: a playing animation re-shows the assembly every frame, and each
  // one reaches here through the popover's assembly hook, so rebuilding the
  // rows unconditionally replaced the node under the pointer sixty times a
  // second — a press landed on a row that was gone before the release, and no
  // click ever fired (seen on hinged-box.html).
  let drawn = null;
  const keyOf = (all, cmp) => JSON.stringify([all.map((r) => [r.name, r.label, r.inView, r.hidden, r.opacity, r.color, r.materialLabel]), cmp]);

  // The compare view's three rows under its part: swatch and label, an eye only
  // for a piece that can hide.
  function pieceRow(p) {
    const row = el("div", "pf-parts-row pf-parts-piece", { role: "listitem", "data-piece": p.kind });
    if (p.hidden) row.classList.add("hidden");
    if (p.canHide) {
      const eye = el("button", "pf-parts-eye", { type: "button", "aria-pressed": String(p.hidden), "aria-label": `${p.hidden ? "Show" : "Hide"} ${p.label}` });
      eye.title = eye.getAttribute("aria-label");
      eye.innerHTML = p.hidden ? EYE_OFF : EYE;
      eye.addEventListener("click", () => { compare.setHidden(p.kind, !p.hidden); render(); });
      row.append(eye);
    } else {
      row.append(el("span", "pf-parts-eye-spacer", { "aria-hidden": "true" }));
    }
    const body = el("span", "pf-parts-piece-body");
    const swatch = el("span", "pf-parts-swatch");
    swatch.style.setProperty("--pf-swatch", p.color);
    const name = el("span", "pf-parts-name"); name.textContent = p.label;
    const note = el("span", "pf-parts-mat"); note.textContent = p.none ? "none" : "";
    body.append(swatch, name, note);
    row.append(body);
    return row;
  }

  function render() {
    pending = false;
    const all = parts.list();
    const cmp = compare?.state() ?? null;
    const key = keyOf(all, cmp);
    if (key === drawn) return;
    drawn = key;
    const rows = all.filter((r) => r.inView);
    const was = focusedControl();
    const scroller = section.parentElement;
    const listTop = list.scrollTop, outerTop = scroller?.scrollTop ?? 0;
    if (compareSwitch) {
      compareSwitch.hidden = !cmp;
      if (cmp) {
        compareSwitch.textContent = cmp.toggle.text;
        compareSwitch.setAttribute("aria-checked", String(cmp.toggle.on));
        compareSwitch.disabled = cmp.toggle.disabled;
      }
    }
    list.replaceChildren(...rows.flatMap((r) => {
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
      return r.name === cmp?.under && cmp.pieces ? [row, ...cmp.pieces.map(pieceRow)] : [row];
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

  const offs = [parts.onChange(() => schedule()), parts.onViewChange?.(() => render()) ?? (() => {}), compare?.onChange(() => schedule()) ?? (() => {})];
  render();
  return { element: section, render, detach() { for (const off of offs) { try { off(); } catch { /* gone */ } } section.remove(); } };
}
