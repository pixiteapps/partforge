// @vitest-environment happy-dom
// test/view-style-popover.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachViewStyleControls } from "../src/framework/view-style-controls.js";

const noop = () => () => {};
function viewerStub() {
  return {
    getRenderMode: () => "cad", getEnvironment: () => "studio",
    onRenderModeChange: noop, onEnvironmentChange: noop, onAssemblyChange: noop, onThemeChange: noop, onCutawayChange: noop,
    renderStyleThumbnail: async () => null,
  };
}
function partsStub(rows) {
  let listeners = new Set();
  return {
    rows,
    list: () => rows,
    setDisplay: vi.fn((name, patch) => { const r = rows.find((x) => x.name === name); if ("hidden" in patch) r.hidden = !!patch.hidden; if ("opacity" in patch) r.opacity = patch.opacity ?? 1; for (const cb of listeners) cb({ name, override: patch }); return patch; }),
    clear: vi.fn((opts) => { if (opts?.viewing) for (const r of rows) { r.hidden = false; r.opacity = 1; } for (const cb of listeners) cb(null); }),
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onViewChange: noop,
    getState: (name) => { const r = rows.find((x) => x.name === name); return r ? { authored: null, override: null, effective: r.effective, hidden: r.hidden, opacity: r.opacity } : null; },
  };
}
const ROWS = () => [
  { name: "body", label: "Body", inView: true, hidden: false, opacity: 1, effective: { material: "powder-coat" }, color: 0x3a3f47, materialLabel: "Powder coat", tintable: true, overridden: false },
  { name: "lid", label: "Lid", inView: true, hidden: false, opacity: 1, effective: { material: "brass" }, color: 0xc9a24b, materialLabel: "Brass", tintable: false, overridden: false },
  { name: "jig", label: "Jig", inView: false, hidden: false, opacity: 1, effective: {}, color: 0x9fb4cc, materialLabel: null, tintable: true, overridden: false },
];

let stage, toolbar;
beforeEach(() => {
  document.body.innerHTML = `<div id="stage"><div id="viewbar"><button id="theme"></button></div></div>`;
  stage = document.getElementById("stage"); toolbar = document.getElementById("viewbar");
});

describe("view style popover: parts section", () => {
  it("renders nothing new without a `parts` option (the cloud scaffold contract)", () => {
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar });
    vs.open();
    expect(vs.popover.querySelector(".pf-parts-list")).toBeNull();
    expect(vs.popover.querySelectorAll(".pf-view-style-tile").length).toBe(5);
    expect(vs.openCard("body")).toBe(false);
    vs.detach();
  });
  it("lists the rows IN the active view, with label, material and an eye each", () => {
    const parts = partsStub(ROWS());
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts });
    vs.open();
    const rows = [...vs.popover.querySelectorAll(".pf-parts-row")];
    expect(rows.map((r) => r.dataset.name)).toEqual(["body", "lid"]);
    expect(rows[0].querySelector(".pf-parts-name").textContent).toBe("Body");
    expect(rows[0].querySelector(".pf-parts-mat").textContent).toBe("Powder coat");
    expect(rows[0].querySelector(".pf-parts-eye").getAttribute("aria-label")).toBe("Hide Body");
    expect(vs.popover.querySelector(".pf-parts-heading").textContent).toBe("Parts");
    expect(vs.popover.querySelector(".pf-parts-swatch").style.getPropertyValue("--pf-swatch")).toBe("#3a3f47");
    vs.detach();
  });
  it("the eye hides and shows; Show all appears only while something is hidden or faded, and clears the viewing keys", () => {
    const parts = partsStub(ROWS());
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts });
    vs.open();
    const showAll = () => vs.popover.querySelector(".pf-parts-showall");
    expect(showAll().hidden).toBe(true);
    vs.popover.querySelector('.pf-parts-row[data-name="body"] .pf-parts-eye').click();
    expect(parts.setDisplay).toHaveBeenCalledWith("body", { hidden: true });
    const row = vs.popover.querySelector('.pf-parts-row[data-name="body"]');
    expect(row.classList.contains("hidden")).toBe(true);
    expect(row.querySelector(".pf-parts-eye").getAttribute("aria-label")).toBe("Show Body");
    expect(showAll().hidden).toBe(false);
    showAll().click();
    expect(parts.clear).toHaveBeenCalledWith({ viewing: true });
    expect(showAll().hidden).toBe(true);
    vs.detach();
  });
  it("a faded row shows a half-weight eye and counts for Show all", () => {
    const rows = ROWS(); rows[1].opacity = 0.4;
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts: partsStub(rows) });
    vs.open();
    expect(vs.popover.querySelector('.pf-parts-row[data-name="lid"]').classList.contains("faded")).toBe(true);
    expect(vs.popover.querySelector(".pf-parts-showall").hidden).toBe(false);
    vs.detach();
  });
  it("re-renders on a display change and on a view change", () => {
    const rows = ROWS();
    const parts = partsStub(rows);
    let viewCb = null; parts.onViewChange = (cb) => { viewCb = cb; return () => {}; };
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts });
    vs.open();
    rows[2].inView = true; viewCb("other");
    expect([...vs.popover.querySelectorAll(".pf-parts-row")].map((r) => r.dataset.name)).toEqual(["body", "lid", "jig"]);
    vs.detach();
  });
  it("re-renders on an assembly change", () => {
    const rows = ROWS();
    let asmCb = null;
    const viewer = { ...viewerStub(), onAssemblyChange: (cb) => { asmCb = cb; return () => {}; } };
    const vs = attachViewStyleControls(viewer, { stage, toolbar, parts: partsStub(rows) });
    vs.open();
    rows[2].inView = true; rows[0].label = "Shell";
    asmCb();
    const names = [...vs.popover.querySelectorAll(".pf-parts-row")];
    expect(names.map((r) => r.dataset.name)).toEqual(["body", "lid", "jig"]);
    expect(names[0].querySelector(".pf-parts-name").textContent).toBe("Shell");
    vs.detach();
  });
  it("keeps focus on the same row's eye across the re-render a click causes, and renders once", async () => {
    const parts = partsStub(ROWS());
    const list = vi.spyOn(parts, "list");
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts });
    vs.open();
    const eye = vs.popover.querySelector('.pf-parts-row[data-name="lid"] .pf-parts-eye');
    eye.focus();
    list.mockClear();
    eye.click();
    await Promise.resolve();
    const after = vs.popover.querySelector('.pf-parts-row[data-name="lid"] .pf-parts-eye');
    expect(after).not.toBe(eye);
    expect(document.activeElement).toBe(after);
    expect(after.getAttribute("aria-pressed")).toBe("true");
    expect(list).toHaveBeenCalledTimes(1);
    vs.detach();
  });
  it("a display change from elsewhere re-renders on the next microtask", async () => {
    const rows = ROWS();
    const parts = partsStub(rows);
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts });
    vs.open();
    parts.setDisplay("body", { hidden: true });
    await Promise.resolve();
    expect(vs.popover.querySelector('.pf-parts-row[data-name="body"]').classList.contains("hidden")).toBe(true);
    vs.detach();
  });
  it("the style grid is five across", () => {
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar });
    expect(vs.popover.querySelector(".pf-view-style-grid").children.length).toBe(5);
    vs.detach();
  });
  it("a swatch opens the card page; Back returns; openCard() from outside opens the popover on the card", () => {
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts: partsStub(ROWS()) });
    vs.open();
    vs.popover.querySelector('.pf-parts-row[data-name="lid"] .pf-parts-swatch').click();
    expect(vs.popover.dataset.page).toBe("card");
    expect(vs.popover.querySelector(".pf-card-title").textContent).toBe("Lid");
    expect(vs.popover.querySelector(".pf-view-style-grid").hidden).toBe(true);
    vs.popover.querySelector(".pf-card-back").click();
    expect(vs.popover.dataset.page).toBe("list");
    vs.close();
    expect(vs.openCard("body")).toBe(true);
    expect(vs.isOpen()).toBe(true);
    expect(vs.popover.dataset.page).toBe("card");
    expect(vs.openCard("nope")).toBe(false);
    vs.close();
    expect(vs.popover.dataset.page).toBe("list"); // close always returns to the list
    vs.detach();
  });
});
