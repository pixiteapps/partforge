// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as THREE from "three";

const state = vi.hoisted(() => ({
  cutaway: null,
  cutawayOptions: null,
  renderer: null,
  resize: null,
}));

const OriginalResizeObserver = globalThis.ResizeObserver;
const OriginalGetContext = globalThis.HTMLCanvasElement.prototype.getContext;
const OriginalToDataURL = globalThis.HTMLCanvasElement.prototype.toDataURL;

// happy-dom has no 2D canvas, and renderOffscreen encodes its readback through
// one. Enough of a stub to let the capture path run end to end.
function stubCanvas2D() {
  globalThis.HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (type !== "2d") return OriginalGetContext.call(this, type, ...rest);
    return {
      createImageData: (width, height) => ({
        width, height, data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: () => {},
    };
  };
  globalThis.HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,AAAA";
}

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.calls = [];
      this.renderTargets = [];
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio(value) { this.pixelRatio = value; }
    getPixelRatio() { return this.pixelRatio; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render(scene, camera) { this.calls.push({ type: "main", scene, camera }); }
    // Offscreen capture surface: record every target the viewer renders into so
    // a test can assert what was allocated, and leave the pixel buffer zeroed.
    get capabilities() { return { maxTextureSize: 8192 }; }
    setRenderTarget(target) { if (target) this.renderTargets.push(target); }
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock("../../src/framework/cutaway.js", () => ({
  createCutaway: vi.fn((options) => {
    state.cutawayOptions = options;
    return state.cutaway;
  }),
}));

import { createViewer } from "../../src/framework/viewer.js";

function createFakeCutaway() {
  const cutaway = {
    isSupported: true,
    isEnabled: false,
    setSubpart: vi.fn(),
    updateGeometry: vi.fn(),
    setVisible: vi.fn(),
    setEnabled: vi.fn(),
    flip: vi.fn(),
    reset: vi.fn(),
    setTheme: vi.fn(),
    setViewportSize: vi.fn(),
    isPointVisible: vi.fn(() => true),
    registerClippableMaterial: vi.fn(() => () => {}),
    resyncSubpart: vi.fn(),
    onHandleHoverChange: vi.fn(),
    onChange: vi.fn(() => () => {}),
    // Stands in for the gizmo's ghost plane group (cutaway.js's captureExcluded).
    captureExcluded: [new THREE.Group()],
    updateForCamera: vi.fn(),
    renderOverlay: vi.fn((renderer, camera) => {
      if (!cutaway.isEnabled) return false;
      renderer.calls.push({ type: "overlay", camera });
      return true;
    }),
    dispose: vi.fn(),
  };
  return cutaway;
}

function createContainer(width = 400, height = 300) {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: width },
    clientHeight: { value: height },
  });
  document.body.appendChild(container);
  return container;
}

beforeEach(() => {
  state.cutaway = createFakeCutaway();
  state.cutawayOptions = null;
  state.renderer = null;
  state.resize = null;
  stubCanvas2D();
  globalThis.ResizeObserver = class {
    constructor(callback) { state.resize = callback; }
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  globalThis.HTMLCanvasElement.prototype.getContext = OriginalGetContext;
  globalThis.HTMLCanvasElement.prototype.toDataURL = OriginalToDataURL;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

test("viewer skips per-frame cutaway camera updates while cutaway is disabled", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  state.renderer.animationLoop();
  expect(state.cutaway.updateForCamera).not.toHaveBeenCalled();

  state.cutaway.isEnabled = true;
  state.renderer.animationLoop();
  expect(state.cutaway.updateForCamera).toHaveBeenCalledOnce();

  viewer.dispose();
});

test("viewer renders the main scene before the enabled cutaway handle overlay", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });
  state.cutaway.isEnabled = true;

  state.renderer.animationLoop();

  expect(state.renderer.calls.map((call) => call.type)).toEqual(["main", "overlay"]);
  expect(state.cutaway.renderOverlay).toHaveBeenCalledWith(
    state.renderer,
    state.renderer.calls[0].camera,
  );
  viewer.dispose();
});

test("viewer renders only the main scene when cutaway is disabled", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  state.renderer.animationLoop();

  expect(state.renderer.calls.map((call) => call.type)).toEqual(["main"]);
  expect(state.cutaway.renderOverlay).toHaveBeenCalledOnce();
  viewer.dispose();
});

test("viewer injects its initial feature-edge color into cutaway", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  expect(state.cutawayOptions.edgeColor).toBe(0x1c232d);

  viewer.dispose();
});

test("viewer forwards every viewport resize to cutaway edge materials", () => {
  vi.stubGlobal("devicePixelRatio", 3);
  let width = 400;
  let height = 300;
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
  });
  document.body.appendChild(container);
  const viewer = createViewer(container, {
    meta: {},
    parts: { body: {} },
  });

  expect(state.renderer.getPixelRatio()).toBe(2);
  expect(state.cutaway.setViewportSize).toHaveBeenLastCalledWith(400, 300, 2);

  width = 900;
  height = 700;
  state.resize();
  expect(state.cutaway.setViewportSize).toHaveBeenLastCalledWith(900, 700, 2);

  viewer.dispose();
});

test("viewer forwards the exact feature-edge color for each cutaway theme", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  viewer.setTheme("dark");
  expect(state.cutaway.setTheme).toHaveBeenLastCalledWith("dark", 0x1c232d);

  viewer.setTheme("light");
  expect(state.cutaway.setTheme).toHaveBeenLastCalledWith("light", 0x33414f);

  viewer.dispose();
});

test("viewer delegates cutaway handle hover subscriptions without exposing the gizmo", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });
  const listener = vi.fn();
  const unsubscribe = vi.fn();
  state.cutaway.onHandleHoverChange.mockReturnValue(unsubscribe);

  expect(viewer.onCutawayHandleHover(listener)).toBe(unsubscribe);
  expect(state.cutaway.onHandleHoverChange).toHaveBeenCalledOnce();
  expect(state.cutaway.onHandleHoverChange).toHaveBeenCalledWith(listener);
  expect(viewer.gizmo).toBeUndefined();

  viewer.dispose();
});

test("captureCanonicalViews returns [] after dispose instead of touching the torn-down renderer", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });
  // Give the assembly real, visible geometry so the world bounds are non-empty —
  // otherwise captureCanonicalViews would already short-circuit on the "nothing
  // visible" empty-scene path, and the test would pass whether or not the
  // disposed guard exists. With a non-empty box, the pre-dispose path would
  // reach into the (incompletely faked) WebGLRenderer and throw; only the
  // disposed guard makes the post-dispose call a safe no-op.
  viewer.setSubGeometry("body", {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triangles: 1,
  });
  viewer.showAssembly(["body"], { frame: true });

  viewer.dispose();

  expect(viewer.captureCanonicalViews(["iso"])).toEqual([]);
});

test("captureCurrent returns null after dispose instead of touching the torn-down renderer", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });
  // Same rationale as the captureCanonicalViews test above: non-empty world
  // bounds so only the disposed guard (not the empty-scene guard) can save us
  // from reaching into the incompletely faked WebGLRenderer.
  viewer.setSubGeometry("body", {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triangles: 1,
  });
  viewer.showAssembly(["body"], { frame: true });

  viewer.dispose();

  expect(viewer.captureCurrent({ size: 2048 })).toBe(null);
});

// Cutaway paints its section caps through a stencil mask (cutaway-render.js
// writes the mask, the cap material tests against it). The VISIBLE canvas gets
// a stencil buffer because createViewer asks for one (`stencil: true`), but a
// WebGLRenderTarget defaults to `stencilBuffer: false` — and with no stencil
// attachment the mask silently does nothing and every cap quad floods its whole
// plane with hatch. That failure is invisible here (no error, live view fine)
// and only shows up in the capture, so pin the allocation itself.
test("captureCurrent renders into a target that has a stencil buffer", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });
  viewer.setSubGeometry("body", {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triangles: 1,
  });
  viewer.showAssembly(["body"], { frame: true });

  viewer.captureCurrent({ size: 2048 });

  expect(state.renderer.renderTargets).toHaveLength(1);
  expect(state.renderer.renderTargets[0].stencilBuffer).toBe(true);

  viewer.dispose();
});

test("captureCanonicalViews renders into targets that have a stencil buffer", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });
  viewer.setSubGeometry("body", {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triangles: 1,
  });
  viewer.showAssembly(["body"], { frame: true });

  viewer.captureCanonicalViews(["iso", "front"]);

  expect(state.renderer.renderTargets).toHaveLength(2);
  for (const target of state.renderer.renderTargets) {
    expect(target.stencilBuffer).toBe(true);
  }

  viewer.dispose();
});

test("captureCurrent returns null when nothing is visible in the scene", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  expect(viewer.captureCurrent()).toBe(null);

  viewer.dispose();
});

// createCutaway is mocked in this file, so `cutawayOptions.getBounds` is the
// real getVisibleWorldBounds passed through untouched — exercising it directly
// reaches the bug without booting the real cutaway feature.
test("getBounds follows the mesh's own geometry, not a stale outline child", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });
  viewer.setSubGeometry("body", {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triangles: 1,
  });
  viewer.showAssembly(["body"], { frame: true });

  // The real cut-face outline (cutaway-outline.js) is a LineSegments2 parented
  // to the mesh, carrying its own LineSegmentsGeometry that only re-slices
  // while the cutaway is enabled and visible. Reproduce a stale one directly:
  // the part shrank to a 0..1 box above, but the outline still holds a slice
  // from when the part spanned ±50 (e.g. taken with the cutaway enabled, then
  // left behind after the cutaway was disabled and a parameter shrank the part).
  const staleOutline = new THREE.Object3D();
  staleOutline.geometry = new THREE.BufferGeometry();
  staleOutline.geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-50, -50, -50, 50, 50, 50]), 3),
  );
  staleOutline.geometry.computeBoundingBox();
  viewer._subMeshes.body.add(staleOutline);

  const bounds = state.cutawayOptions.getBounds();

  // Bounds must follow the mesh's own geometry (the 0..1 triangle), not the
  // stale ±50 outline child.
  expect(bounds.min.x).toBeGreaterThan(-2);
  expect(bounds.max.x).toBeLessThan(2);

  viewer.dispose();
});

// The ghost plane is the cutaway's CONTROL, drawn in the part's own scene. It
// sits between the camera and everything the cut keeps, and a capture blends it
// in linear light, where it lands far stronger than on screen — the view style
// thumbnails came back with the part washed out behind it. Every offscreen
// render leaves it out; the section itself (clipped part + caps) stays in.
function builtViewer() {
  const viewer = createViewer(createContainer(), { meta: {}, parts: { body: {} } });
  viewer.setSubGeometry("body", {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triangles: 1,
  });
  viewer.showAssembly(["body"], { frame: true });
  return viewer;
}
function recordGizmoAtOffscreenRender() {
  const [gizmo] = state.cutaway.captureExcluded;
  const seen = [];
  let target = null;
  const setRenderTarget = state.renderer.setRenderTarget.bind(state.renderer);
  state.renderer.setRenderTarget = (t) => { target = t; setRenderTarget(t); };
  const render = state.renderer.render.bind(state.renderer);
  state.renderer.render = (scene, camera) => { if (target) seen.push(gizmo.visible); render(scene, camera); };
  return { gizmo, seen };
}

test("offscreen captures leave the cutaway's ghost plane out, and put it back after", () => {
  const viewer = builtViewer();
  const { gizmo, seen } = recordGizmoAtOffscreenRender();
  gizmo.visible = true; // the cutaway is on: its plane is showing

  expect(viewer.captureCurrent({ size: 512 })).toMatch(/^data:image/);
  expect(viewer.captureCanonicalViews(["iso"])).toHaveLength(1);

  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen.every((v) => v === false)).toBe(true);
  expect(gizmo.visible).toBe(true); // the live view keeps it
  viewer.dispose();
});

test("a ghost plane that was already hidden (cutaway off) stays hidden after a capture", () => {
  const viewer = builtViewer();
  const { gizmo } = recordGizmoAtOffscreenRender();
  gizmo.visible = false;
  viewer.captureCurrent({ size: 512 });
  expect(gizmo.visible).toBe(false);
  viewer.dispose();
});

test("viewer delegates cutaway change subscriptions (on/off, plane moves)", () => {
  const viewer = createViewer(createContainer(), { meta: {}, parts: { body: {} } });
  const unsubscribe = () => {};
  state.cutaway.onChange.mockReturnValue(unsubscribe);
  const listener = vi.fn();
  expect(viewer.onCutawayChange(listener)).toBe(unsubscribe);
  expect(state.cutaway.onChange).toHaveBeenCalledWith(listener);
  viewer.dispose();
});
