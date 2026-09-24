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

test("Escape and an outside press close it; Escape returns focus to the button", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  const button = stage.querySelector("#view-style");
  c.open();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(c.isOpen()).toBe(false);
  expect(document.activeElement).toBe(button);
  c.open();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(c.isOpen()).toBe(false);
});

test("setHidden hides the button and closes the popover", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  c.open();
  c.setHidden(true);
  expect(c.element.hidden).toBe(true);
  expect(c.isOpen()).toBe(false);
});
