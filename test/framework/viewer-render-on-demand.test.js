// @vitest-environment happy-dom
// The viewer draws on demand: the loop ticks every animation frame (controls,
// tweens, frame listeners) but only renders when something asked for it, so a
// still view costs no GPU work. These pin what asks — and that pure reads don't.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null }));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.frames = 0;
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() { this.frames += 1; }
    get capabilities() { return { maxTextureSize: 8192 }; }
    setRenderTarget() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

import { createViewer, withRenderRequests } from "../../src/framework/viewer.js";

function createContainer() {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  document.body.appendChild(container);
  return container;
}
const newViewer = () => createViewer(createContainer(), { meta: {}, parts: { body: {} } });

beforeEach(() => {
  state.renderer = null;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});


// Pin the clock the grace windows are measured against.
let now = 1000;
beforeEach(() => { now = 1000; vi.spyOn(performance, "now").mockImplementation(() => now); });
const tick = (n = 1) => { for (let i = 0; i < n; i++) state.renderer.animationLoop(now); };

test("a still view draws its first frame and then stops drawing", () => {
  const viewer = newViewer();
  tick(10);
  expect(state.renderer.frames).toBe(1);
  viewer.dispose();
});

test("requestRender draws exactly the next frame", () => {
  const viewer = newViewer();
  tick();
  viewer.requestRender();
  tick(5);
  expect(state.renderer.frames).toBe(2);
  viewer.dispose();
});

test("frame listeners keep ticking while nothing draws", () => {
  const viewer = newViewer();
  const listener = vi.fn();
  viewer.onFrame(listener);
  tick(6);
  expect(listener).toHaveBeenCalledTimes(6);
  expect(state.renderer.frames).toBe(1);
  viewer.dispose();
});

// Animation playback: its frame listener asks for every frame it drives, and
// the ask lands before the draw decision in the same tick.
test("a listener that asks every tick draws every frame", () => {
  const viewer = newViewer();
  tick();
  viewer.onFrame(() => viewer.requestRender());
  tick(30);
  expect(state.renderer.frames).toBe(31);
  viewer.dispose();
});

test("a mutating API call draws; pure reads do not", () => {
  const viewer = newViewer();
  tick();
  viewer.getCameraState();
  viewer.getRenderMode();
  viewer.isWorldPointVisible?.([0, 0, 0]);
  tick();
  expect(state.renderer.frames).toBe(1);
  viewer.setTheme("light");
  tick();
  expect(state.renderer.frames).toBe(2);
  viewer.dispose();
});

test("an API call keeps drawing briefly for its follow-ups, then stops", () => {
  const viewer = newViewer();
  tick();
  viewer.setTheme("light");
  tick(); tick();
  expect(state.renderer.frames).toBe(3); // inside the grace window
  now += 1000;
  tick(3);
  expect(state.renderer.frames).toBe(3);
  viewer.dispose();
});

test("input on the stage draws through the grace window, then stops", () => {
  const container = createContainer();
  const viewer = createViewer(container, { meta: {}, parts: { body: {} } });
  tick();
  container.dispatchEvent(new Event("pointermove"));
  tick(3);
  expect(state.renderer.frames).toBe(4);
  now += 1000;
  tick(3);
  expect(state.renderer.frames).toBe(4);
  // listeners come off with the viewer
  viewer.dispose();
  container.dispatchEvent(new Event("pointermove"));
});

test("withRenderRequests wraps mutators, skips reads, and re-asks when a promise settles", async () => {
  const request = vi.fn();
  let cam = "a";
  const api = withRenderRequests({
    setThing: (v) => v * 2,
    load: () => Promise.resolve("done"),
    fail: () => Promise.reject(new Error("no")),
    getThing: () => 1,
    isThing: () => true,
    onThing: () => () => {},
    get camera() { return cam; },
    domElement: "canvas",
  }, request);
  expect(api.getThing()).toBe(1);
  api.isThing();
  api.onThing();
  expect(request).not.toHaveBeenCalled();
  expect(api.setThing(2)).toBe(4);
  expect(request).toHaveBeenCalledTimes(1);
  await expect(api.load()).resolves.toBe("done");
  expect(request).toHaveBeenCalledTimes(3); // on call, and again on landing
  await expect(api.fail()).rejects.toThrow("no");
  expect(request).toHaveBeenCalledTimes(5);
  cam = "b";
  expect(api.camera).toBe("b"); // getters stay live
  expect(api.domElement).toBe("canvas");
});
