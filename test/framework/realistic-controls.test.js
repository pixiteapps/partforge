// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachRealisticControls } from "../../src/framework/realistic-controls.js";

function fakeViewer() {
  let mode = "cad", env = "studio"; const ml = new Set(), el = new Set();
  return {
    getRenderMode: () => mode, getEnvironment: () => env,
    setRenderMode: vi.fn(async (m) => { mode = m; for (const cb of ml) cb({ mode, busy: false, error: null }); return mode; }),
    setEnvironment: vi.fn(async (id) => { env = id; for (const cb of el) cb(id); return id; }),
    onRenderModeChange: (cb) => { ml.add(cb); return () => ml.delete(cb); },
    onEnvironmentChange: (cb) => { el.add(cb); return () => el.delete(cb); },
    emit: (e) => { for (const cb of ml) cb(e); },
    emitEnv: (id) => { env = id; for (const cb of el) cb(id); },
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => { document.body.innerHTML = ""; });

test("the toggle switches modes and reflects state", async () => {
  const v = fakeViewer(); const toggle = document.createElement("button"); const envMenu = document.createElement("select");
  attachRealisticControls(v, { toggle, envMenu });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(envMenu.hidden).toBe(true);
  toggle.click(); await Promise.resolve();
  expect(v.setRenderMode).toHaveBeenCalledWith("realistic");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(toggle.classList.contains("on")).toBe(true);
  expect(envMenu.hidden).toBe(false);
});

test("the environment menu lists the four environments and switches", async () => {
  const v = fakeViewer(); const envMenu = document.createElement("select");
  attachRealisticControls(v, { toggle: document.createElement("button"), envMenu });
  expect([...envMenu.options].map((o) => o.value)).toEqual(["studio", "workshop", "print-bed", "outdoor"]);
  envMenu.value = "workshop"; envMenu.dispatchEvent(new Event("change"));
  expect(v.setEnvironment).toHaveBeenCalledWith("workshop");
});

test("busy and error states show on the toggle", () => {
  const v = fakeViewer(); const toggle = document.createElement("button");
  attachRealisticControls(v, { toggle, envMenu: document.createElement("select") });
  v.emit({ mode: "cad", busy: true, error: null });
  expect(toggle.dataset.busy).toBe("true");
  v.emit({ mode: "cad", busy: false, error: "couldn't load realistic view" });
  expect(toggle.dataset.busy).toBeUndefined();
  expect(toggle.getAttribute("aria-label")).toBe("Couldn't load realistic view");
  expect(toggle.title).toBe("Couldn't load realistic view");
});

test("absent elements are a no-op", () => {
  expect(() => attachRealisticControls(fakeViewer(), {}).detach()).not.toThrow();
});

test("the choices persist as the mode and environment actually in effect", async () => {
  const v = fakeViewer();
  v.setRenderMode.mockImplementation(async () => "cad"); // assets failed: still CAD
  const toggle = document.createElement("button"); const envMenu = document.createElement("select");
  attachRealisticControls(v, { toggle, envMenu });
  toggle.click(); await Promise.resolve(); await Promise.resolve();
  expect(localStorage.getItem("partforge:renderMode")).toBe("cad");
  envMenu.value = "outdoor"; envMenu.dispatchEvent(new Event("change"));
  await Promise.resolve(); await Promise.resolve();
  expect(localStorage.getItem("partforge:environment")).toBe("outdoor");
});

test("the menu follows the viewer's environment, including a reverted switch", () => {
  const v = fakeViewer(); const envMenu = document.createElement("select");
  attachRealisticControls(v, { toggle: document.createElement("button"), envMenu });
  v.emitEnv("print-bed");
  expect(envMenu.value).toBe("print-bed");
  v.emitEnv("studio");
  expect(envMenu.value).toBe("studio");
});

test("an environment event keeps an error on the toggle", () => {
  const v = fakeViewer(); const toggle = document.createElement("button");
  attachRealisticControls(v, { toggle, envMenu: document.createElement("select") });
  v.emit({ mode: "realistic", busy: false, error: "couldn't load that environment" });
  v.emitEnv("studio");
  expect(toggle.getAttribute("aria-label")).toBe("Couldn't load realistic view");
});

test("clicking while realistic is loading cancels back to CAD", () => {
  const v = fakeViewer(); const toggle = document.createElement("button");
  attachRealisticControls(v, { toggle, envMenu: document.createElement("select") });
  v.emit({ mode: "cad", busy: true, error: null });
  toggle.click();
  expect(v.setRenderMode).toHaveBeenCalledWith("cad");
});

test("detach removes the listeners", () => {
  const v = fakeViewer(); const toggle = document.createElement("button"); const envMenu = document.createElement("select");
  const c = attachRealisticControls(v, { toggle, envMenu });
  c.detach();
  toggle.click();
  envMenu.value = "workshop"; envMenu.dispatchEvent(new Event("change"));
  v.emit({ mode: "cad", busy: true, error: null });
  expect(v.setRenderMode).not.toHaveBeenCalled();
  expect(v.setEnvironment).not.toHaveBeenCalled();
  expect(toggle.dataset.busy).toBeUndefined();
});

test("with a tooltip the label lives in aria-label, not title", () => {
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  const toggle = document.createElement("button");
  attachRealisticControls(fakeViewer(), { toggle }, { tooltip });
  expect(toggle.getAttribute("aria-label")).toBe("Realistic view");
  expect(toggle.hasAttribute("title")).toBe(false);
});
