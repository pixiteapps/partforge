// @vitest-environment happy-dom
// The viewer's pose fast path (setSubPose): a presentational rigid transform on a
// single sub-part's mesh + edge lines, used to re-pose already-delivered geometry
// while the worker rebuilds. Exercised through the same faked-WebGLRenderer harness
// as viewer-cutaway.test.js — no real GL context is needed for matrix bookkeeping.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as THREE from "three";

const state = vi.hoisted(() => ({ cutaway: null, renderer: null }));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio(value) { this.pixelRatio = value; }
    getPixelRatio() { return this.pixelRatio; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock("../../src/framework/cutaway.js", () => ({
  createCutaway: vi.fn(() => state.cutaway),
}));

import { createViewer } from "../../src/framework/viewer.js";

function createFakeCutaway() {
  return {
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
    updateForCamera: vi.fn(),
    renderOverlay: vi.fn(() => false),
    dispose: vi.fn(),
  };
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

// A 1mm triangle in the XY plane — enough to give the sub-part a real bounding box.
const triangle = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
});

const makeViewer = () => createViewer(createContainer(), { meta: {}, parts: { body: {}, lid: {} } });

// The edge lines live beside the meshes in partsGroup, in the same sub-part order;
// the viewer keeps them private, so recover them as "the children that aren't meshes".
function linesFor(viewer, name) {
  const names = Object.keys(viewer._subMeshes);
  const meshes = new Set(Object.values(viewer._subMeshes));
  const lines = viewer._subMeshes[name].parent.children.filter((child) => !meshes.has(child));
  return lines[names.indexOf(name)];
}

beforeEach(() => {
  state.cutaway = createFakeCutaway();
  state.renderer = null;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
});

test("setSubPose writes the matrix onto both the sub-part mesh and its edge lines", () => {
  const viewer = makeViewer();
  const mat16 = new THREE.Matrix4().makeTranslation(3, -4, 5).toArray();

  viewer.setSubPose("body", mat16);

  for (const obj of [viewer._subMeshes.body, linesFor(viewer, "body")]) {
    // three would otherwise recompose `matrix` from position/quaternion/scale
    // on the next frame and silently discard the pose.
    expect(obj.matrixAutoUpdate).toBe(false);
    expect(obj.matrixWorldNeedsUpdate).toBe(true);
    expect(obj.matrix.toArray()).toEqual(mat16);
  }
  // the pose is per-sub-part: nothing else moves
  expect(viewer._subMeshes.lid.matrix.equals(new THREE.Matrix4())).toBe(true);

  viewer.dispose();
});

test("setSubPose(name, null) resets the sub-part and its lines to identity", () => {
  const viewer = makeViewer();
  viewer.setSubPose("body", new THREE.Matrix4().makeRotationZ(Math.PI / 3).toArray());

  viewer.setSubPose("body", null);

  const identity = new THREE.Matrix4();
  for (const obj of [viewer._subMeshes.body, linesFor(viewer, "body")]) {
    expect(obj.matrix.equals(identity)).toBe(true);
    expect(obj.matrixWorldNeedsUpdate).toBe(true);
  }

  viewer.dispose();
});

test("delivering fresh geometry clears an outstanding fast-path pose", () => {
  // A worker mesh is baked at the current params, so its placement is already
  // correct — leaving the pose on would double-apply it.
  const viewer = makeViewer();
  viewer.setSubPose("body", new THREE.Matrix4().makeTranslation(50, 0, 0).toArray());

  viewer.setSubGeometry("body", triangle());

  const identity = new THREE.Matrix4();
  expect(viewer._subMeshes.body.matrix.equals(identity)).toBe(true);
  expect(linesFor(viewer, "body").matrix.equals(identity)).toBe(true);

  viewer.dispose();
});

test("framing unions posed bounds, not the delivered geometry's bounds", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  const partsGroup = viewer._subMeshes.body.parent;

  viewer.showAssembly(["body"], { frame: true });
  const unposed = partsGroup.position.clone();
  expect(unposed.x).toBeCloseTo(-0.5, 5); // centred on the 1mm triangle

  // Slide the sub-part 100mm along +X: the framing centre must follow it.
  viewer.setSubPose("body", new THREE.Matrix4().makeTranslation(100, 0, 0).toArray());
  viewer.frame();

  expect(partsGroup.position.x).toBeCloseTo(unposed.x - 100, 4);
  expect(partsGroup.position.y).toBeCloseTo(unposed.y, 5);

  viewer.dispose();
});

// --- getSubMeshPayload: what exportPreview encodes --------------------------
const expectNear = (got, want) => {
  expect(got).toHaveLength(want.length);
  [...got].forEach((g, i) => expect(g).toBeCloseTo(want[i], 5));
};

test("getSubMeshPayload returns the delivered geometry with its fast-path pose baked in", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  // rotate 90° about Z, then slide 10mm along +X
  const pose = new THREE.Matrix4().makeTranslation(10, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  viewer.setSubPose("body", pose.toArray());

  const out = viewer.getSubMeshPayload("body");

  expect(out.name).toBe("body");
  expect(out.triangles).toBe(1);
  expect(out.indices).toBeNull();
  expectNear(out.positions, [10, 0, 0, 10, 1, 0, 9, 0, 0]);
  expectNear(out.normals, [0, 0, 1, 0, 0, 1, 0, 0, 1]); // a Z rotation keeps +Z
  viewer.dispose();
});

test("normals turn with the pose and stay unit length", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  viewer.setSubPose("body", new THREE.Matrix4().makeRotationX(Math.PI / 2).toArray());
  expectNear(viewer.getSubMeshPayload("body").normals, [0, -1, 0, 0, -1, 0, 0, -1, 0]);
  viewer.dispose();
});

test("unposed geometry comes back as delivered, as copies the caller may keep", () => {
  const viewer = makeViewer();
  const tri = { ...triangle(), indices: new Uint32Array([0, 1, 2]) };
  viewer.setSubGeometry("body", tri);
  const out = viewer.getSubMeshPayload("body");
  expectNear(out.positions, [...tri.positions]);
  expect([...out.indices]).toEqual([0, 1, 2]);
  expect(out.positions).not.toBe(tri.positions);
  out.positions[0] = 99;
  expect(tri.positions[0]).toBe(0);
  expect(viewer.getSubMeshPayload("body").positions[0]).toBe(0);
  viewer.dispose();
});

test("getSubMeshPayload is null for a sub-part with nothing delivered, or no such sub-part", () => {
  const viewer = makeViewer();
  expect(viewer.getSubMeshPayload("lid")).toBeNull();
  expect(viewer.getSubMeshPayload("nope")).toBeNull();
  viewer.dispose();
});
