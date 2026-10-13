// src/framework/parts-list.js
// The View style popover's Parts section: the sub-parts in the active view,
// one row each with an eye (hide / show) and a swatch (opens the appearance
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

  function render() {
    const rows = parts.list().filter((r) => r.inView);
    list.replaceChildren(...rows.map((r) => {
      const row = el("div", "pf-parts-row", { role: "listitem", "data-name": r.name });
      if (r.hidden) row.classList.add("hidden");
      else if (r.opacity < 1) row.classList.add("faded");
      const eye = el("button", "pf-parts-eye", { type: "button", "aria-pressed": String(r.hidden), "aria-label": `${r.hidden ? "Show" : "Hide"} ${r.label}` });
      eye.title = eye.getAttribute("aria-label");
      eye.innerHTML = r.hidden ? EYE_OFF : EYE;
      eye.addEventListener("click", () => { parts.setDisplay(r.name, { hidden: !r.hidden }); render(); });
      const swatch = el("button", "pf-parts-swatch", { type: "button", "aria-label": `Change appearance of ${r.label}` });
      swatch.title = swatch.getAttribute("aria-label");
      swatch.style.setProperty("--pf-swatch", hexColor(r.color));
      swatch.addEventListener("click", () => onSwatch?.(r.name));
      const name = el("span", "pf-parts-name"); name.textContent = r.label;
      const mat = el("span", "pf-parts-mat"); mat.textContent = r.materialLabel ?? "";
      row.append(eye, swatch, name, mat);
      return row;
    }));
    showAll.hidden = !parts.list().some((r) => r.hidden || r.opacity < 1);
  }

  const offs = [parts.onChange(() => render()), parts.onViewChange?.(() => render()) ?? (() => {})];
  render();
  return { element: section, render, detach() { for (const off of offs) { try { off(); } catch { /* gone */ } } section.remove(); } };
}
