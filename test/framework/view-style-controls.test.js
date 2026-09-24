// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachViewStyleControls } from "../../src/framework/view-style-controls.js";

function fakeViewer() {
  const l = { mode: new Set(), env: new Set(), proj: new Set(), lines: new Set(), asm: new Set(), theme: new Set() };
  const v = {
    mode: "cad", env: "studio", proj: "perspective", lines: { cad: true },
    getRenderMode: () => v.mode,
    isRealisticPending: () => false,
    setRenderMode: vi.fn(async (m) => { v.mode = m; l.mode.forEach((cb) => cb({ mode: m })); return m; }),
    getEnvironment: () => v.env,
    setEnvironment: vi.fn(async (id) => { v.env = id; l.env.forEach((cb) => cb(id)); return id; }),
    getProjection: () => v.proj,
    setProjection: vi.fn((p) => { v.proj = p; l.proj.forEach((cb) => cb(p)); }),
    getFeatureLines: () => v.lines[v.mode === "cad" ? "cad" : v.env] ?? v.mode === "cad",
    setFeatureLines: vi.fn((on) => { v.lines[v.mode === "cad" ? "cad" : v.env] = on; l.lines.forEach((cb) => cb({})); }),
    renderStyleThumbnail: vi.fn(async (s) => `data:${s}`),
    onRenderModeChange: (cb) => { l.mode.add(cb); return () => l.mode.delete(cb); },
    onEnvironmentChange: (cb) => { l.env.add(cb); return () => l.env.delete(cb); },
    onProjectionChange: (cb) => { l.proj.add(cb); return () => l.proj.delete(cb); },
    onFeatureLinesChange: (cb) => { l.lines.add(cb); return () => l.lines.delete(cb); },
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

test("the lines switch reflects and sets the current style's lines", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open();
  const sw = stage.querySelector(".pf-view-style-switch");
  expect(sw.getAttribute("role")).toBe("switch");
  expect(sw.getAttribute("aria-checked")).toBe("true");
  sw.click();
  expect(v.setFeatureLines).toHaveBeenCalledWith(false);
  expect(sw.getAttribute("aria-checked")).toBe("false");
});

test("the projection control sets and follows the projection", () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open();
  const ortho = stage.querySelector('.pf-view-style-seg [data-projection="orthographic"]');
  ortho.click();
  expect(v.setProjection).toHaveBeenCalledWith("orthographic");
  expect(ortho.getAttribute("aria-checked")).toBe("true");
  v.setProjection("perspective");
  expect(ortho.getAttribute("aria-checked")).toBe("false");
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

test("a feature-lines change re-renders the current style's tile while open, and re-renders all on the next open", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open(); await flush(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(5);
  let n = 0;
  v.renderStyleThumbnail.mockImplementation(async (s) => `data:${s}-v${++n}`);
  stage.querySelector(".pf-view-style-switch").click();   // lines off for CAD
  await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(6);
  expect(v.renderStyleThumbnail.mock.calls.at(-1)[0]).toBe("cad");
  expect(tile("cad").querySelector("img").src).toBe("data:cad-v1");
  c.close(); c.open(); await flush(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(11); // stale → the whole set again
});

test("a feature-lines change while closed renders nothing until the next open", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open(); await flush(); await flush();
  c.close();
  v.setFeatureLines(false);                                  // e.g. runtime.featureLines.set
  await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(5);
  c.open(); await flush(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(10);
});
