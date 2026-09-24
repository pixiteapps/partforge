// @vitest-environment happy-dom
// The pick marker, once it can be HELD, stops being a fire-and-forget flash and
// becomes state a host hangs its own UI off. That changes two things nothing
// else in the suite covers, so both run against a REAL viewer over the same
// faked-WebGLRenderer harness as viewer-frame-guard/viewer-capture-view:
//
//   1. It must not appear in any offscreen capture. While a dot faded after
//      1200ms, a capture catching one was a vanishing race nobody had to design
//      for; a held dot lives as long as the host's bubble, so an agent render or
//      a published thumbnail taken during a pick would reliably contain it.
//   2. Hold/release lifecycle: held dots outlive the fade, they accumulate, and
//      one release clears them together.
//
// happy-dom has no 2D canvas, so we shim getContext("2d")/toDataURL (the
// viewer-capture-view trick) to let the REAL renderOffscreen run end to end. No
// pixels are asserted — the observation point is object visibility AT DRAW TIME,
// recorded from inside the fake renderer's render(), because the finally block
// restores it long before the caller sees the returned data URL.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  renderer: null,
  drawnScene: null,
  visibleAtDraw: null,
}));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.frames = 0;
      this.renderThrows = false;
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    // Marker sizing and marker projection both ask the renderer for the canvas
    // size in CSS px; the real one answers from the drawing buffer.
    getSize(target) { target.set(400, 300); return target; }
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render(scene) {
      this.frames += 1;
      state.drawnScene = scene;
      // Snapshot every object's `visible` as the draw sees it. traverse() (not
      // traverseVisible) so hidden objects are still in the map.
      const seen = new Map();
      scene.traverse((o) => seen.set(o.uuid, o.visible));
      state.visibleAtDraw = seen;
      if (this.renderThrows) throw new Error("GL lost");
    }
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

// A 1mm triangle in the XY plane — a real bbox, so the capture paths have
// something to frame and do not bail on an empty scene.
const triangle = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
});

function framedViewer() {
  const viewer = createViewer(createContainer(), { meta: {}, parts: { body: {} } });
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"], { frame: true });
  return viewer;
}

// Flash dots are added straight to the scene (not the pivot), so the newest
// scene child after a flashPoint IS the dot — no reliance on colour or renderOrder.
const liveSceneOf = (viewer) => viewer._subMeshes.body.parent.parent.parent;
function pickAt(viewer, world) {
  const scene = liveSceneOf(viewer);
  const before = new Set(scene.children);
  viewer.flashPoint(world);
  return scene.children.find((c) => !before.has(c));
}
const inScene = (dot) => dot.parent !== null;

let origGetContext;
let origToDataURL;

beforeEach(() => {
  state.renderer = null;
  state.drawnScene = null;
  state.visibleAtDraw = null;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  origGetContext = HTMLCanvasElement.prototype.getContext;
  origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.getContext = function getContext(type) {
    if (type !== "2d") return null;
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    };
  };
  HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,TEST";
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.ResizeObserver = OriginalResizeObserver;
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toDataURL = origToDataURL;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// --- the marker never reaches a capture ------------------------------------

test("captureCurrent draws no held marker, and leaves it on the live canvas", () => {
  const viewer = framedViewer();
  const dot = pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();

  const url = viewer.captureCurrent({ size: 64 });

  expect(url).toBe("data:image/jpeg;base64,TEST");
  // The dot was in the scene that was drawn, and it was hidden at draw time.
  expect(state.visibleAtDraw.has(dot.uuid)).toBe(true);
  expect(state.visibleAtDraw.get(dot.uuid)).toBe(false);
  // …and the user's own view still has it.
  expect(dot.visible).toBe(true);
  expect(inScene(dot)).toBe(true);
  viewer.dispose();
});

test("captureCanonicalViews draws no held marker either", () => {
  const viewer = framedViewer();
  const dot = pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();

  const shots = viewer.captureCanonicalViews(["front"]);

  expect(shots).toHaveLength(1);
  expect(state.visibleAtDraw.get(dot.uuid)).toBe(false);
  expect(dot.visible).toBe(true);
  viewer.dispose();
});

test("an unheld marker is hidden from a capture too, for its whole 1200ms life", () => {
  const viewer = framedViewer();
  const dot = pickAt(viewer, [0, 0, 0]); // never held — the #181 behaviour

  viewer.captureCurrent({ size: 64 });

  expect(state.visibleAtDraw.get(dot.uuid)).toBe(false);
  expect(dot.visible).toBe(true);
  viewer.dispose();
});

test("the marker comes back even when the offscreen render throws", () => {
  const viewer = framedViewer();
  const dot = pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();
  state.renderer.renderThrows = true;

  expect(() => viewer.captureCurrent({ size: 64 })).toThrow("GL lost");

  // Hidden at draw time, restored by the finally despite the throw — otherwise
  // a single failed capture would silently delete the marker from the live view.
  expect(state.visibleAtDraw.get(dot.uuid)).toBe(false);
  expect(dot.visible).toBe(true);
  viewer.dispose();
});

test("a capture does not resurrect a marker the live view had already hidden", () => {
  const viewer = framedViewer();
  const dot = pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();
  dot.visible = false;

  viewer.captureCurrent({ size: 64 });

  expect(state.visibleAtDraw.get(dot.uuid)).toBe(false);
  expect(dot.visible).toBe(false);
  viewer.dispose();
});

// --- the hover highlight never reaches a capture ----------------------------
// The contact sheet's "capture-only colour corruption" (an orange PLA sample
// captured pink, oak captured lavender) was the pointer's hover highlight: a
// 35% blue overlay on whatever the pointer rests on, baked into captureCurrent.

test("a capture-hidden overlay (the hover highlight) is hidden at draw time and restored", () => {
  const viewer = framedViewer();
  const overlay = new (viewer._subMeshes.body.constructor)();
  viewer._subMeshes.body.add(overlay);
  const unregister = viewer.registerCaptureHidden(overlay);

  viewer.captureCurrent({ size: 64 });
  expect(state.visibleAtDraw.get(overlay.uuid)).toBe(false);
  expect(overlay.visible).toBe(true);

  viewer.captureCanonicalViews(["front"]);
  expect(state.visibleAtDraw.get(overlay.uuid)).toBe(false);
  expect(overlay.visible).toBe(true);

  unregister();
  viewer.captureCurrent({ size: 64 });
  expect(state.visibleAtDraw.get(overlay.uuid)).toBe(true);
  viewer.dispose();
});

test("the real hover highlight registers its overlay as capture-hidden", async () => {
  const { createFeatureHighlight } = await import("../../src/framework/selection/feature-highlight.js");
  const viewer = framedViewer();
  const mesh = viewer._subMeshes.body;
  const hl = createFeatureHighlight(viewer);
  hl.show({ mesh, subPart: "body", feature: null });
  const overlay = mesh.children.find((c) => c.material?.opacity === 0.35);
  expect(overlay.visible).toBe(true);

  viewer.captureCurrent({ size: 64 });
  expect(state.visibleAtDraw.get(overlay.uuid)).toBe(false);
  expect(overlay.visible).toBe(true);
  hl.dispose();
  viewer.dispose();
});

// --- hold and release -------------------------------------------------------

test("an unheld marker still fades on its own", () => {
  vi.useFakeTimers();
  const viewer = framedViewer();
  const dot = pickAt(viewer, [0, 0, 0]);

  expect(inScene(dot)).toBe(true);
  vi.advanceTimersByTime(1199);
  expect(inScene(dot)).toBe(true);
  vi.advanceTimersByTime(2);
  expect(inScene(dot)).toBe(false);
  viewer.dispose();
});

test("holdFlashPoint keeps a marker well past the fade window", () => {
  vi.useFakeTimers();
  const viewer = framedViewer();
  const dot = pickAt(viewer, [0, 0, 0]);

  expect(viewer.holdFlashPoint()).toBe(true);
  vi.advanceTimersByTime(60_000);

  expect(inScene(dot)).toBe(true);
  viewer.dispose();
});

test("a second pick's hold leaves the first held, and one release clears both", () => {
  vi.useFakeTimers();
  const viewer = framedViewer();
  const first = pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();
  const second = pickAt(viewer, [1, 0, 0]);
  viewer.holdFlashPoint();

  vi.advanceTimersByTime(60_000);
  expect(inScene(first)).toBe(true);
  expect(inScene(second)).toBe(true);

  viewer.releaseFlashPoints();

  expect(inScene(first)).toBe(false);
  expect(inScene(second)).toBe(false);
  viewer.dispose();
});

test("holding does not strand the unheld marker beside it", () => {
  vi.useFakeTimers();
  const viewer = framedViewer();
  const stale = pickAt(viewer, [0, 0, 0]);
  const held = pickAt(viewer, [1, 0, 0]);
  viewer.holdFlashPoint(); // holds the NEWEST only

  vi.advanceTimersByTime(1300);

  expect(inScene(stale)).toBe(false); // still faded
  expect(inScene(held)).toBe(true);
  viewer.dispose();
});

test("holdFlashPoint reports false when there is no marker to hold", () => {
  vi.useFakeTimers();
  const viewer = framedViewer();
  expect(viewer.holdFlashPoint()).toBe(false);

  pickAt(viewer, [0, 0, 0]);
  vi.advanceTimersByTime(1300); // faded out from under the host
  expect(viewer.holdFlashPoint()).toBe(false);

  // …and a release with nothing held is a no-op, not a throw.
  expect(() => viewer.releaseFlashPoints()).not.toThrow();
  viewer.dispose();
});

// --- the anchor stream ------------------------------------------------------

test("onFlashAnchorChange reports current state on subscribe, then hold and release", () => {
  const viewer = framedViewer();
  const seen = [];
  const off = viewer.onFlashAnchorChange((a) => seen.push(a));

  expect(seen).toEqual([null]); // nothing held yet

  pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();
  expect(seen).toHaveLength(2);
  expect(Number.isFinite(seen[1].x)).toBe(true);
  expect(Number.isFinite(seen[1].y)).toBe(true);
  expect(typeof seen[1].visible).toBe("boolean");

  viewer.releaseFlashPoints();
  expect(seen).toHaveLength(3);
  expect(seen[2]).toBeNull();

  off();
  pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();
  expect(seen).toHaveLength(3); // unsubscribed
  viewer.dispose();
});

test("the anchor follows a moving camera, and a still one publishes nothing", () => {
  const viewer = framedViewer();
  pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();
  const seen = [];
  viewer.onFlashAnchorChange((a) => seen.push(a));
  const tick = (ms) => state.renderer.animationLoop(ms);

  // A still camera: the render loop re-projects every frame but publishes only
  // on movement, so these five frames must be silent.
  for (let t = 0; t <= 400; t += 100) tick(t);
  expect(seen).toHaveLength(1); // the subscribe-time emit alone

  viewer.tweenCameraTo("top", { duration: 0.6 });
  for (let t = 500; t <= 1400; t += 100) tick(t);
  const moved = seen.length;
  expect(moved).toBeGreaterThan(1);

  // Tween finished: the camera is at rest again and the gate closes.
  for (let t = 1500; t <= 1900; t += 100) tick(t);
  expect(seen).toHaveLength(moved);
  viewer.dispose();
});

test("the published anchor is the marker's own position, on hold and on every frame", () => {
  const viewer = framedViewer();
  const seen = [];
  viewer.onFlashAnchorChange((a) => { if (a) seen.push(a); });

  pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();
  const atOrigin = seen.at(-1).x;

  // A second marker off the orbit target, same camera. Anything that projects a
  // FIXED point — the origin, controls.target, the camera — publishes the same
  // pixel for both, and every other test in this file picks at [0, 0, 0], where
  // that mistake is invisible.
  pickAt(viewer, [5, 0, 0]);
  viewer.holdFlashPoint();
  expect(seen.at(-1).x).not.toBeCloseTo(atOrigin, 3);

  // The render loop has to re-project that same marker, not the camera pose it
  // is following. Once the tween settles, the stream's last word must agree
  // with a fresh projection of the dot — within the 0.5px publish gate, which
  // is exactly how stale the last publish is allowed to be.
  viewer.tweenCameraTo("top", { duration: 0.6 });
  for (let t = 0; t <= 1400; t += 100) state.renderer.animationLoop(t);
  const settled = viewer.projectPoint([5, 0, 0]);
  expect(Math.abs(seen.at(-1).x - settled.x)).toBeLessThan(0.5);
  expect(Math.abs(seen.at(-1).y - settled.y)).toBeLessThan(0.5);
  viewer.dispose();
});

test("a throwing anchor subscriber cannot take the render loop down", () => {
  const viewer = framedViewer();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  pickAt(viewer, [0, 0, 0]);
  const seen = [];
  // Armed only AFTER its subscribe-time emit: that first call is deliberately
  // outside publishAnchor's try/catch (a known, accepted gap — a subscriber that
  // throws on arrival throws at the caller, who is right there). What must not
  // happen is a later PUBLISH escaping into the render loop, and that is what
  // this arms for.
  let calls = 0;
  viewer.onFlashAnchorChange(() => { calls += 1; if (calls > 1) throw new Error("boom"); });
  viewer.onFlashAnchorChange((a) => seen.push(a));

  expect(() => viewer.holdFlashPoint()).not.toThrow();
  viewer.tweenCameraTo("top", { duration: 0.6 });
  for (let t = 0; t <= 900; t += 100) expect(() => state.renderer.animationLoop(t)).not.toThrow();

  expect(seen.length).toBeGreaterThan(1); // the survivor still got its updates
  viewer.dispose();
});

test("subscribing to a disposed viewer is inert", () => {
  const viewer = framedViewer();
  pickAt(viewer, [0, 0, 0]);
  viewer.holdFlashPoint();
  viewer.dispose();

  const seen = [];
  const off = viewer.onFlashAnchorChange((a) => seen.push(a));

  // No stale anchor for a dot that is no longer in the scene, and no listener
  // retained on a viewer whose dispose() will never run again.
  expect(seen).toEqual([]);
  expect(() => off()).not.toThrow();
});
