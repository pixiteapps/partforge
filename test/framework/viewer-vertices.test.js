// @vitest-environment happy-dom
// setSubVertices: the in-place vertex update the pose-drag deformer writes through.
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
  Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  document.body.appendChild(container);
  return container;
}
const makeViewer = () => createViewer(createContainer(), { meta: {}, parts: { body: {} } });
const triangle = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
});

let now = 1000;
beforeEach(() => {
  state.renderer = null;
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test("setSubVertices rewrites positions and normals in place, updates bounds and the payload", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"]);
  const geo = viewer._subMeshes.body.geometry;
  const posArray = geo.getAttribute("position").array;
  const p2 = new Float32Array([0, 0, 0, 5, 0, 0, 0, 7, 2]);
  const n2 = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]);
  expect(viewer.setSubVertices("body", { positions: p2, normals: n2 })).toBe(true);
  expect(geo.getAttribute("position").array).toBe(posArray); // same buffer, written in place
  expect(geo.getAttribute("position").version).toBeGreaterThan(0);
  expect(geo.boundingBox.max.toArray()).toEqual([5, 7, 2]);
  const payload = viewer.getSubMeshPayload("body");
  expect(Array.from(payload.positions)).toEqual(Array.from(p2));
  expect(Array.from(payload.normals)).toEqual(Array.from(n2));
  viewer.dispose();
});

test("setSubVertices refuses a length mismatch and an unknown name", () => {
  const viewer = makeViewer();
  expect(viewer.setSubVertices("body", { positions: new Float32Array(9), normals: new Float32Array(9) })).toBe(false);
  viewer.setSubGeometry("body", triangle());
  expect(() => viewer.setSubVertices("body", { positions: new Float32Array(6), normals: new Float32Array(9) })).toThrow(RangeError);
  expect(() => viewer.setSubVertices("body", { positions: new Float32Array(9), normals: new Float32Array(3) })).toThrow(RangeError);
  viewer.dispose();
});

test("setSubVertices requests a render", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  const tick = (n = 1) => { for (let i = 0; i < n; i++) state.renderer.animationLoop(now); };
  tick(3);
  const before = state.renderer.frames;
  viewer.setSubVertices("body", { positions: new Float32Array(9), normals: new Float32Array(9) });
  tick(3);
  expect(state.renderer.frames).toBeGreaterThan(before);
  viewer.dispose();
});

// A skinned surface leaves its delivered edge lines behind, so they hide while it is
// deformed and come back when the exact base is written back or a new mesh lands.
test("deformed vertices hide the edge lines; a restore or a new delivery shows them", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"]);
  const lines = viewer.__subLines("body");
  expect(lines.visible).toBe(true);
  const moved = { positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]), normals: triangle().normals };
  viewer.setSubVertices("body", moved, { deformed: true });
  expect(lines.visible).toBe(false);
  expect(viewer._subMeshes.body.visible).toBe(true);
  viewer.showAssembly(["body"]); // a refresh mid-drag keeps them hidden
  expect(lines.visible).toBe(false);
  viewer.setSubVertices("body", triangle()); // the base put back
  expect(lines.visible).toBe(true);
  viewer.setSubVertices("body", moved, { deformed: true });
  expect(lines.visible).toBe(false);
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"]);
  expect(lines.visible).toBe(true);
  viewer.dispose();
});
