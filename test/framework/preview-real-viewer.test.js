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
import { mountPreview } from "../../src/framework/mount-preview.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { boxEdges, boxSoup, boundsOf, previewGlbFor, segmentMismatch } from "../helpers/preview-glb.js";

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

test("exportPreview carries the sub-part's feature edges, posed like its positions", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(placedPart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: [
    { ...boxSoup("body", [0, 0, 0], [1, 1, 1]), edges: boxEdges([0, 0, 0], [1, 1, 1]), reads: ["h"], frame: "canonical" },
  ] } });
  await runtime.ready;
  const out = await decodePreviewGlb(await runtime.exportPreview());
  expect(segmentMismatch(out.meshes[0].edges, boxEdges([10, 0, 0], [11, 1, 1]))).toBeNull();
  runtime.dispose();
});

test("a live sub-part with no feature edges exports none", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: [boxSoup("body", [0, 0, 0], [4, 4, 4])] } });
  await runtime.ready;
  const out = await decodePreviewGlb(await runtime.exportPreview());
  expect(out.meshes[0].edges).toEqual(new Float32Array(0));
  runtime.dispose();
});

test("delivered with no edge data, exportPreview carries the angle-derived lines the viewer draws", async () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  const { edges: _none, ...bare } = boxSoup("body", [0, 0, 0], [4, 4, 4]);
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: [bare] } });
  await runtime.ready;
  const out = await decodePreviewGlb(await runtime.exportPreview());
  expect(segmentMismatch(out.meshes[0].edges, boxEdges([0, 0, 0], [4, 4, 4]))).toBeNull();
  runtime.dispose();
});

test("a preview's decoded edges reach the viewer's edge lines", async () => {
  const preview = await previewGlbFor([{ ...boxSoup("body", [0, 0, 0], [4, 4, 4]), edges: boxEdges([0, 0, 0], [4, 4, 4]) }], makePart(), "main");
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), preview });
  await vi.waitFor(() => expect(runtime.previewActive).toBe(true));
  expect(viewers[0].getSubMeshPayload("body").edges.length).toBe(72);
  runtime.dispose();
});

// --- mountPreview: the kernel-free viewer --------------------------------------
const previewPart = { parts: { body: { display: { color: 0xff0000 } } } };
let glbBytes = null;
const glb = async () => (glbBytes ??= await previewGlbFor([boxSoup("body", [0, 0, 0], [4, 4, 4])], previewPart, "main"));

test("mountPreview draws the GLB with no worker, framed, in the part's own look", async () => {
  const Worker = vi.fn();
  vi.stubGlobal("Worker", Worker);
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await glb() });
  await handle.ready;
  const v = viewers.at(-1);
  expect(stage.contains(v.domElement)).toBe(true);
  expect(v.hasSubMesh("body")).toBe(true);
  expect(v.__subMesh("body").visible).toBe(true);
  expect(v.__subMesh("body").material.color.getHex()).toBe(0xff0000);
  expect(handle.getView()).toBe("main");
  expect(Worker).not.toHaveBeenCalled();
  handle.dispose();
  expect(stage.contains(v.domElement)).toBe(false);
  expect(stage.querySelector("canvas")).toBeNull(); // the view cube went with it
  expect(() => handle.dispose()).not.toThrow();
});

test("mountPreview carries viewer state in and out", async () => {
  const handle = mountPreview(makeStage(), {
    glb: await glb(), viewerState: { camera: { pos: [40, 0, 0], target: [0, 0, 0] }, projection: "perspective", cutaway: null },
  });
  await handle.ready;
  expectNear(handle.getViewerState().camera.pos, [40, 0, 0], 4);
  handle.setViewerState({ camera: { pos: [0, 50, 0], target: [1, 1, 1] }, projection: "perspective", cutaway: null });
  const s = handle.getViewerState();
  expect(s).toMatchObject({ projection: "perspective", cutaway: null, renderMode: "cad" });
  expectNear(s.camera.pos, [0, 50, 0], 4);
  expectNear(s.camera.target, [1, 1, 1], 4);
  handle.dispose();
});

test("before the decode, state is the carried one — never a cutaway", async () => {
  const handle = mountPreview(makeStage(), {
    glb: await glb(),
    viewerState: {
      camera: { pos: [40, 0, 0], target: [0, 0, 0] }, projection: "perspective", renderMode: "realistic", environment: "outdoor",
      cutaway: { enabled: true, flipped: false, pose: { position: [0, 0, 1], quaternion: [0, 0, 0, 1] } },
    },
  });
  expect(handle.getViewerState()).toMatchObject({ renderMode: "realistic", environment: "outdoor", cutaway: null });
  expect(handle.renderMode.get()).toBe("realistic");
  expect(handle.environment.get()).toBe("outdoor");
  await handle.ready;
  handle.dispose();
});

test("a GLB that will not decode rejects ready and leaves the container untouched", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: new Uint8Array([1, 2, 3]) });
  await expect(handle.ready).rejects.toThrow();
  expect(stage.children).toHaveLength(0);
  expect(viewers).toHaveLength(0);
  expect(handle.getView()).toBeNull();
  expect(() => handle.dispose()).not.toThrow();
});

test("dispose before the GLB decodes means nothing is ever drawn", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await glb() });
  handle.dispose();
  await handle.ready;
  expect(viewers).toHaveLength(0);
  expect(stage.children).toHaveLength(0);
});

test("the sticky hooks a host relays are safe, before and after the decode", async () => {
  const handle = mountPreview(makeStage(), { glb: await glb() });
  handle.setActive(false); // remembered until the viewer exists
  handle.setHostPane("rail");
  handle.setRailLayout({ mode: "overlay" });
  const lost = vi.fn();
  handle.onContextLost(lost);
  await handle.ready;
  expect(state.renderer.animationLoop).toBeNull(); // parked
  handle.setActive(true);
  expect(typeof state.renderer.animationLoop).toBe("function");
  expect(await handle.renderMode.set("cad")).toBe("cad");
  expect(handle.renderMode.get()).toBe("cad");
  expect(handle.environment.list().map((e) => e.id)).toContain("studio");
  handle.dispose();
});

test("mountPreview requires a container", () => {
  expect(() => mountPreview(null, { glb: new Uint8Array(0) })).toThrow(TypeError);
});
