// @vitest-environment happy-dom
// The cached preview against the REAL viewer, on a fake WebGLRenderer (the
// mount-realistic.test.js harness): what the user sees across the preview → live
// swap, the pose exportPreview bakes into its file, and (Task 7) mountPreview.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.toneMapping = 0;
      this.toneMappingExposure = 1;
      this.compileAsync = vi.fn(async () => {});
      // The FIRST renderer a test makes is the viewer's own (view-style thumbnails
      // may make more later); beforeEach resets it.
      state.renderer ??= this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    getSize(target) { return target.set(400, 300); }
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    get capabilities() { return { maxTextureSize: 8192, textureTypeReadable: () => true }; }
    setRenderTarget() {}
    getRenderTarget() { return null; }
    getClearAlpha() { return 1; }
    setClearAlpha() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock("../../src/framework/selection/index.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    attachHoverLabels: vi.fn(() => ({ detach: vi.fn(), setSuppressed: vi.fn() })),
    attachPickToggle: vi.fn(() => ({ detach: vi.fn() })),
    attachPicker: vi.fn(() => ({ setActive: vi.fn(), detach: vi.fn() })),
  };
});

vi.mock("../../src/framework/pick-request/index.js", async () => ({
  ...(await import("../../src/framework/pick-request/endpoint.js")),
  createPickRequestClient: vi.fn(() => ({ detach: vi.fn() })),
}));

// The real viewer, captured so a test can read its meshes and camera.
const viewers = vi.hoisted(() => []);
vi.mock("../../src/framework/viewer.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, createViewer: (...args) => { const v = real.createViewer(...args); viewers.push(v); return v; } };
});

import { mount } from "../../src/framework/mount.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { boxSoup, boundsOf, previewGlbFor } from "../helpers/preview-glb.js";

const OriginalResizeObserver = globalThis.ResizeObserver;

const expectNear = (got, want, digits = 2) => {
  expect(got).toHaveLength(want.length);
  [...got].forEach((g, i) => expect(g).toBeCloseTo(want[i], digits));
};

const makePart = () => ({
  meta: { title: "Preview Fixture", backend: "manifold" },
  defaults: { h: 4 },
  views: { main: { label: "Main" } },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] }) } },
  parameters: [{ id: "size", title: "Size", advanced: [{ key: "h", label: "Height", min: 1, max: 10, step: 1 }] }],
});

// body is built at the origin and posed 10mm along +X by place(): a rigid,
// geometry-free place(), so the worker delivers it CANONICAL and mount poses it.
const placedPart = () => ({
  ...makePart(),
  parts: { body: { label: "Body", views: ["main"],
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] }),
    place: (s) => s.translate([10, 0, 0]) } },
});

function makeStage() {
  const stage = document.createElement("div");
  Object.defineProperties(stage, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  document.body.append(stage);
  return stage;
}

function makeElements() {
  const mk = (tag = "div") => document.createElement(tag);
  const els = {
    viewer: makeStage(), controls: mk(), rail: mk(),
    status: { status: mk(), busy: mk(), phase: mk() },
    tabs: mk(),
    exports: { stl: mk("button"), step: mk("button"), threeMf: mk("button") },
    chrome: { reframe: mk("button"), theme: mk("button"), cutaway: mk("button"), railToggle: mk("button") },
  };
  document.body.append(els.controls, els.rail, els.tabs);
  return els;
}

function makeWorkers() {
  const workers = {};
  const createWorker = (name) => {
    const w = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null };
    workers[name] = w;
    return w;
  };
  return { workers, createWorker };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  viewers.length = 0;
  state.renderer = null;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the preview shows on the real viewer, and the swap keeps the camera the user moved to", async () => {
  const preview = await previewGlbFor([boxSoup("body", [0, 0, 0], [4, 4, 4])], makePart(), "main");
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview });
  await vi.waitFor(() => expect(runtime.previewActive).toBe(true));
  const v = viewers[0];
  expect(v.__subMesh("body").visible).toBe(true);
  expect(v.subTriangles("body")).toBe(12);

  v.setCameraState({ pos: [30, 20, 10], target: [1, 2, 3] }); // the user orbits the preview
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: [boxSoup("body", [0, 0, 0], [4, 4, 4])] } });
  await runtime.ready;

  expect(runtime.previewActive).toBe(false);
  const cam = runtime.getViewerState().camera;
  expectNear(cam.pos, [30, 20, 10], 4);
  expectNear(cam.target, [1, 2, 3], 4);
  runtime.dispose();
});

test("exportPreview bakes a canonical sub-part's place() pose into the file", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(placedPart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: [
    { ...boxSoup("body", [0, 0, 0], [1, 1, 1]), reads: ["h"], frame: "canonical" },
  ] } });
  await runtime.ready;
  // Precondition: mount posed the canonical delivery by MATRIX, not in the geometry.
  expect(viewers[0].__subMesh("body").matrix.elements[12]).toBeCloseTo(10, 6);

  const out = await decodePreviewGlb(await runtime.exportPreview());
  expect(out.view).toBe("main");
  const { min, max } = boundsOf(out.meshes[0].positions);
  expectNear(min, [10, 0, 0]);
  expectNear(max, [11, 1, 1]);
  runtime.dispose();
});
