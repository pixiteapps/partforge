// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { attachViewStyleControls } from "../../src/framework/view-style-controls.js";

function fakeViewer() {
  const l = { mode: new Set(), env: new Set(), proj: new Set(), asm: new Set(), theme: new Set() };
  const v = {
    mode: "cad", env: "studio", proj: "perspective",
    getRenderMode: () => v.mode,
    isRealisticPending: () => false,
    setRenderMode: vi.fn(async (m) => { v.mode = m; l.mode.forEach((cb) => cb({ mode: m })); return m; }),
    getEnvironment: () => v.env,
    setEnvironment: vi.fn(async (id) => { v.env = id; l.env.forEach((cb) => cb(id)); return id; }),
    getProjection: () => v.proj,
    setProjection: vi.fn((p) => { v.proj = p; l.proj.forEach((cb) => cb(p)); }),
    renderStyleThumbnail: vi.fn(async (s) => `data:${s}`),
    onRenderModeChange: (cb) => { l.mode.add(cb); return () => l.mode.delete(cb); },
    onEnvironmentChange: (cb) => { l.env.add(cb); return () => l.env.delete(cb); },
    onProjectionChange: (cb) => { l.proj.add(cb); return () => l.proj.delete(cb); },
    onAssemblyChange: (cb) => { l.asm.add(cb); return () => l.asm.delete(cb); },
    onThemeChange: (cb) => { l.theme.add(cb); return () => l.theme.delete(cb); },
    _fire: l,
  };
  return v;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
let stage, anchor;
beforeEach(() => {
  stage = document.createElement("div");
  anchor = document.createElement("div"); // stands in for the view cube's stack
  anchor.className = "pf-viewcube-stack";
  stage.append(anchor);
  document.body.append(stage);
});
afterEach(() => { document.body.innerHTML = ""; });

const tile = (id) => stage.querySelector(`.pf-view-style-tile[data-style="${id}"]`);

test("the button sits in the view cube's stack; the popover in the stage; detach removes both", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  expect(anchor.querySelector("#view-style")).not.toBeNull();
  expect(c.popover.parentNode).toBe(stage);
  c.detach();
  expect(stage.querySelector("#view-style")).toBeNull();
  expect(stage.querySelector("#pf-view-style-popover")).toBeNull();
});

test("the popover closes when the cube hides", async () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  c.open();
  anchor.hidden = true;
  await Promise.resolve(); // MutationObserver delivery
  await new Promise((r) => setTimeout(r, 0));
  expect(c.isOpen()).toBe(false);
});

test("opening shows a tile per style with thumbnails, the current one pressed", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  stage.querySelector("#view-style").click();
  expect(c.isOpen()).toBe(true);
  expect(stage.querySelector("#view-style").getAttribute("aria-expanded")).toBe("true");
  await flush(); await flush();
  expect([...stage.querySelectorAll(".pf-view-style-tile")].map((t) => t.dataset.style))
    .toEqual(["cad", "studio", "workshop", "print-bed", "outdoor"]);
  expect(tile("cad").getAttribute("aria-pressed")).toBe("true");
  expect(tile("workshop").querySelector("img").src).toBe("data:workshop");
});

test("thumbnails render once, and again only on the next open after the part changes", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open(); await flush(); await flush();
  c.close(); c.open(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(5);
  c.close();
  v._fire.asm.forEach((cb) => cb());
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(5); // not while closed
  c.open(); await flush(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(10);
});

test("a tile switches style: an environment then realistic, or back to CAD", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open();
  tile("print-bed").click(); await flush();
  expect(v.setEnvironment).toHaveBeenCalledWith("print-bed");
  expect(v.setRenderMode).toHaveBeenLastCalledWith("realistic");
  expect(tile("print-bed").getAttribute("aria-pressed")).toBe("true");
  tile("cad").click(); await flush();
  expect(v.setRenderMode).toHaveBeenLastCalledWith("cad");
});

test("the popover has no feature-lines switch — lines are CAD-only", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  c.open();
  expect(stage.querySelector(".pf-view-style-switch")).toBeNull();
  expect(stage.querySelector('[role="switch"]')).toBeNull();
});

test("the popover has no Projection row — projection is automatic (a cube face view is ortho)", () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open();
  expect(stage.querySelector('[data-projection]')).toBeNull();
  expect(stage.querySelector('[role="radiogroup"]')).toBeNull();
  expect(c.popover.textContent).not.toMatch(/projection|orthographic|perspective/i);
  // The Style heading and grid are all that is left.
  expect([...c.popover.children].map((n) => n.className))
    .toEqual(["pf-view-style-heading", "pf-view-style-grid"]);
  // …and nothing reaches for the projection API any more.
  expect(v.setProjection).not.toHaveBeenCalled();
  const css = readFileSync(resolve("src/framework/app.css"), "utf8");
  expect(css).not.toMatch(/pf-view-style-seg|pf-view-style-row/);
});

test("Escape with focus in the popover closes it, returns focus, and does not reach the stage", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  const button = stage.querySelector("#view-style");
  const stageEscape = vi.fn(); // stands in for measure/cutaway's stage-level Escape
  stage.addEventListener("keydown", stageEscape);
  c.open();
  tile("studio").focus();
  tile("studio").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(c.isOpen()).toBe(false);
  expect(document.activeElement).toBe(button);
  expect(stageEscape).not.toHaveBeenCalled();
  // On the button itself, too.
  c.open();
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(c.isOpen()).toBe(false);
  expect(stageEscape).not.toHaveBeenCalled();
});

test("Escape with focus elsewhere is left alone; an outside press closes it", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  const other = document.createElement("button");
  stage.append(other);
  c.open();
  other.focus();
  other.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(c.isOpen()).toBe(true);
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(c.isOpen()).toBe(false);
  expect(document.activeElement).toBe(other); // an outside press does not steal focus
});

test("a part change while open (a playing animation) keeps filling the tiles, then re-renders on the next open", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  v.renderStyleThumbnail = vi.fn(async (s) => { v._fire.asm.forEach((cb) => cb()); return `data:${s}`; });
  c.open();
  for (let i = 0; i < 6; i += 1) await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(5);
  expect([...stage.querySelectorAll(".pf-view-style-tile img")].every((i) => !i.hidden)).toBe(true);
  c.close(); c.open();
  for (let i = 0; i < 6; i += 1) await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(10);
});

test("closing mid-render stops the thumbnail loop; the next open resumes", async () => {
  const v = fakeViewer();
  const gates = [];
  v.renderStyleThumbnail = vi.fn((s) => new Promise((r) => gates.push(() => r(`data:${s}`))));
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open();
  await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(1);
  c.close();
  gates.shift()(); await flush(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(1); // nothing more while closed
  c.open(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(2); // resumed on open
  while (gates.length) { gates.shift()(); await flush(); await flush(); }
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(6);
  expect(tile("outdoor").querySelector("img").src).toBe("data:outdoor");
});

test("setHidden hides the button and closes the popover", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  c.open();
  c.setHidden(true);
  expect(c.element.hidden).toBe(true);
  expect(c.isOpen()).toBe(false);
});

test("toolbar: setHidden takes the divider with the button, and brings both back", () => {
  const bar = makeToolbar();
  const c = attachViewStyleControls(fakeViewer(), { stage, toolbar: bar, anchor });
  const divider = bar.querySelector(".pf-viewbar-divider");
  c.setHidden(true);
  expect(c.element.hidden).toBe(true);
  expect(divider.hidden).toBe(true);
  c.setHidden(false);
  expect(c.element.hidden).toBe(false);
  expect(divider.hidden).toBe(false);
});

test("the button wears an eye icon (one icon, open or closed)", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  const svg = stage.querySelector("#view-style svg");
  expect(svg.getAttribute("width")).toBe("16");
  expect(svg.querySelectorAll("path")).toHaveLength(1);  // the eye's outline
  expect(svg.querySelectorAll("circle")).toHaveLength(1); // the pupil
  expect(svg.querySelector("rect")).toBeNull();           // the movie camera's body is gone
  const closed = c.element.innerHTML;
  c.open();
  expect(c.element.innerHTML).toBe(closed);               // no eye-off swap
  expect(c.element.getAttribute("aria-label")).toBe("View style");
});

test("fallback: the button sits over the cube's bottom-right corner, inside the stack's box", () => {
  const css = readFileSync(resolve("src/framework/chrome.css"), "utf8");
  const rules = css.match(/^\.pf-viewcube-stack > \.pf-view-style-button\s*\{[^}]*\}/gm) ?? [];
  expect(rules).toHaveLength(1);
  const rule = rules[0].replace(/\s+/g, " ");
  expect(rule).toContain("position: absolute");
  expect(rule).toContain("right: 0;");
  expect(rule).toContain("bottom: 0;");
  expect(rule).not.toMatch(/calc\(100%/);               // not hung outside the stack (beside the cube)
  // No unscoped placement rule that would also move the toolbar's button.
  expect(css).not.toMatch(/^\.pf-view-style-button\s*\{/m);
});

test("fallback: the card chrome is scoped to the stack, so none of it reaches #viewbar", () => {
  const css = readFileSync(resolve("src/framework/app.css"), "utf8");
  expect(css).not.toMatch(/^\.pf-view-style-button\s*\{/m);
  const rule = (css.match(/^\.pf-viewcube-stack > \.pf-view-style-button\s*\{[^}]*\}/m) ?? [""])[0];
  expect(rule).toContain("box-shadow");
  expect(css).toMatch(/^\.pf-viewbar-divider\s*\{[^}]*width: 1px;[^}]*align-self: stretch;/m);
});

// --- toolbar mode (the stage has a #viewbar) ---------------------------------
function makeToolbar({ theme = true } = {}) {
  const bar = document.createElement("div");
  bar.id = "viewbar";
  for (const id of ["annotate", "measure", "cutaway", ...(theme ? ["theme"] : [])]) {
    const b = document.createElement("button");
    b.id = id;
    bar.append(b);
  }
  stage.append(bar);
  return bar;
}
const ids = (bar) => [...bar.children].map((c) => c.id || c.className);

test("toolbar: inserted before #theme behind a divider; not in the cube's stack; detach removes both", () => {
  const bar = makeToolbar();
  const c = attachViewStyleControls(fakeViewer(), { stage, toolbar: bar, anchor });
  expect(c.placement).toBe("toolbar");
  expect(ids(bar)).toEqual(["annotate", "measure", "cutaway", "pf-viewbar-divider", "view-style", "theme"]);
  expect(bar.querySelector(".pf-viewbar-divider").getAttribute("aria-hidden")).toBe("true");
  expect(anchor.querySelector("#view-style")).toBeNull();
  expect(c.popover.parentNode).toBe(stage);
  c.detach();
  expect(ids(bar)).toEqual(["annotate", "measure", "cutaway", "theme"]);
  expect(stage.querySelector("#pf-view-style-popover")).toBeNull();
});

test("toolbar: appended at the end (divider first) when there is no #theme", () => {
  const bar = makeToolbar({ theme: false });
  attachViewStyleControls(fakeViewer(), { stage, toolbar: bar, anchor });
  expect(ids(bar)).toEqual(["annotate", "measure", "cutaway", "pf-viewbar-divider", "view-style"]);
});

test("toolbar: the popover opens above the pill, right edge flush with the PILL's", () => {
  const bar = makeToolbar();
  const c = attachViewStyleControls(fakeViewer(), { stage, toolbar: bar, anchor });
  const rect = (r) => () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top });
  stage.getBoundingClientRect = rect({ left: 0, top: 0, right: 1000, bottom: 800 });
  bar.getBoundingClientRect = rect({ left: 700, top: 744, right: 988, bottom: 788 });
  c.element.getBoundingClientRect = rect({ left: 900, top: 749, right: 934, bottom: 783 });
  c.open();
  expect(c.popover.style.right).toBe("12px");        // the pill's inset, not the button's (66px)
  expect(c.popover.style.bottom).toBe("64px");       // 8px above the pill's top (800 − 744 + 8)
  expect(c.popover.style.maxHeight).toBe("728px");
});

test("toolbar: the popover closes when the toolbar hides (Sketch), and open() refuses then", async () => {
  const bar = makeToolbar();
  const c = attachViewStyleControls(fakeViewer(), { stage, toolbar: bar, anchor });
  c.open();
  bar.hidden = true;
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(c.isOpen()).toBe(false);
  c.open();
  expect(c.isOpen()).toBe(false);
});

test("toolbar: the cube hiding (crowding) neither hides the button nor closes the popover", async () => {
  const bar = makeToolbar();
  const c = attachViewStyleControls(fakeViewer(), { stage, toolbar: bar, anchor });
  c.open();
  anchor.hidden = true;
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(c.isOpen()).toBe(true);
  expect(c.element.hidden).toBe(false);
});

test("fallback: with no toolbar the button is in the stack and placed from its own rect", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  expect(c.placement).toBe("anchor");
  expect(anchor.querySelector("#view-style")).toBe(c.element);
  expect(stage.querySelector(".pf-viewbar-divider")).toBeNull();
  const rect = (r) => () => ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top });
  stage.getBoundingClientRect = rect({ left: 0, top: 0, right: 1000, bottom: 800 });
  c.element.getBoundingClientRect = rect({ left: 958, top: 600, right: 988, bottom: 630 });
  c.open();
  expect(c.popover.style.right).toBe("12px");
  expect(c.popover.style.bottom).toBe("208px");      // 8px above the button's top
});

// A host may hide #viewbar with its OWN CSS — partforge-cloud toggles a class,
// which is display:none and sets no `hidden` attribute, so the attribute
// observer never hears it. A ResizeObserver does: an element with no layout box
// reports a resize, and has no client rects.
describe("toolbar hidden by CSS rather than the hidden attribute", () => {
  let observers;
  const OriginalRO = globalThis.ResizeObserver;
  beforeEach(() => {
    observers = [];
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
      observe(el) { this.targets.push(el); }
      disconnect() { this.targets = []; }
    };
  });
  afterEach(() => { globalThis.ResizeObserver = OriginalRO; });
  const fire = (el) => { for (const o of observers) if (o.targets.includes(el)) o.cb([{ target: el }]); };
  const box = [{ width: 288, height: 44 }];

  test("closes the popover when the bar loses its box", () => {
    const bar = makeToolbar();
    bar.getClientRects = () => box;
    const c = attachViewStyleControls(fakeViewer(), { stage, toolbar: bar, anchor });
    c.open();
    fire(bar); // an ordinary resize (the stage got wider): still open
    expect(c.isOpen()).toBe(true);
    bar.getClientRects = () => []; // the host's class: display:none
    fire(bar);
    expect(c.isOpen()).toBe(false);
  });

  test("a resize while closed opens nothing, and detach stops observing", () => {
    const bar = makeToolbar();
    bar.getClientRects = () => [];
    const c = attachViewStyleControls(fakeViewer(), { stage, toolbar: bar, anchor });
    fire(bar);
    expect(c.isOpen()).toBe(false);
    c.detach();
    expect(observers.every((o) => o.targets.length === 0)).toBe(true);
  });
});
