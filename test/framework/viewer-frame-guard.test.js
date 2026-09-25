// @vitest-environment happy-dom
// Frame listeners are fanned out from inside three's animation callback, and
// three re-arms requestAnimationFrame only AFTER that callback returns
// (WebGLAnimation.onAnimationFrame). So a listener that throws does not cost one
// frame — it stops the rAF chain and freezes the viewer permanently. The animation
// driver was the first subscriber to make that reachable (a malformed easing threw
// out of the playback state machine), but the containment belongs to the publisher:
// no subscriber should be able to take the render loop down with it.
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

import { createViewer } from "../../src/framework/viewer.js";

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

test("a throwing frame listener does not propagate out of the render loop", () => {
  const viewer = newViewer();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  viewer.onFrame(() => { throw new Error("boom"); });
  // If this threw, three would never re-arm requestAnimationFrame.
  expect(() => state.renderer.animationLoop()).not.toThrow();
  viewer.dispose();
});

test("the frame still renders and the other listeners still run", () => {
  const viewer = newViewer();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const before = vi.fn();
  const after = vi.fn();
  viewer.onFrame(before);
  viewer.onFrame(() => { throw new Error("boom"); });
  viewer.onFrame(after);

  state.renderer.animationLoop();

  expect(before).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1); // a throwing sibling must not skip it
  expect(state.renderer.frames).toBe(1);  // and the frame itself still renders
  viewer.dispose();
});

test("a listener that throws every frame keeps the loop alive", () => {
  const viewer = newViewer();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  viewer.onFrame(() => { throw new Error("boom"); });
  // The viewer draws on demand, so ask for each frame: the point is that the
  // loop is still alive to draw it.
  for (let i = 0; i < 5; i++) { viewer.requestRender(); state.renderer.animationLoop(); }
  expect(state.renderer.frames).toBe(5);
  viewer.dispose();
});
