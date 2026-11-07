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
  // setSubPose is wrapped in a spy before anyone holds the viewer, so a test can
  // tell "no pose was ever set" from "the identity pose was set".
  return { ...real, createViewer: (...args) => {
    const v = real.createViewer(...args);
    v.setSubPose = vi.fn(v.setSubPose);
    viewers.push(v);
    return v;
  } };
});

import { mount } from "../../src/framework/mount.js";
import { mountPreview } from "../../src/framework/mount-preview.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { cameraPoseForView } from "../../src/framework/view-angles.js";
import { encodePreviewGlb } from "../../src/framework/gltf/encode-preview.js";
import { boxEdges, boxSoup, boundsOf, previewGlbFor, segmentMismatch } from "../helpers/preview-glb.js";
import { box, input, T } from "../helpers/preview-animation-fixture.js";

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

// --- mountPreview: the baked autoplay animation ---------------------------------
// The lid moves; one intro cue to "front".
const animatedGlb = () => encodePreviewGlb({ meshes: [box("base"), box("lid", 24)], view: "box", animation: input() });
const stillGlb = () => encodePreviewGlb({ meshes: [box("base"), box("lid", 24)], view: "box" });
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Drive the fake renderer's animation loop: `seconds` of 0.1s frames (the
// viewer clamps a frame's dt to 0.1s), continuing from wherever the clock is.
let clockMs = 0;
function runFrames(seconds) {
  const loop = state.renderer.animationLoop;
  for (let i = 0; i <= Math.round(seconds * 10); i++) loop((clockMs += 100));
}
beforeEach(() => { clockMs = 0; });

test("mountPreview plays the file's animation once drawn", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb() });
  await handle.ready;
  const v = viewers.at(-1);
  const orbit = vi.fn();
  v.onCameraStart(orbit);
  expect(handle.animation.state().status).toBe("intro"); // gated on the intro cue's tween
  const before = handle.getViewerState().camera;
  expect([...v.__subMesh("lid").matrix.elements]).toEqual(IDENTITY); // the opening pose

  runFrames(0.8); // the 0.6s intro tween lands on the same loop
  expect(orbit).not.toHaveBeenCalled(); // the viewer's own tween is not a user grab
  expect(handle.animation.state().status).toBe("playing");
  const cam = handle.getViewerState().camera;
  expect(cam.pos).not.toEqual(before.pos);
  // The camera now looks from where the "front" view puts it.
  const unit = (v) => { const n = Math.hypot(...v); return v.map((c) => c / n); };
  const front = cameraPoseForView("front", { center: [0, 0, 0], radius: 1 });
  expectNear(unit(cam.pos.map((c, i) => c - cam.target[i])), unit(front.position.map((c, i) => c - front.target[i])), 3);

  runFrames(0.5);
  expect(handle.animation.state().t).toBeGreaterThan(0);
  expect([...v.__subMesh("lid").matrix.elements]).not.toEqual(IDENTITY); // the lid swung
  expect([...v.__subMesh("base").matrix.elements]).toEqual(IDENTITY);    // the base has no track
  handle.animation.pause();
  expect(handle.animation.state().status).toBe("paused");
  handle.animation.resume();
  expect(handle.animation.state().status).toMatch(/intro|playing/);
  handle.dispose();
});

test("a host tween started mid-intro replaces the intro's, so its onComplete never fires", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb() });
  await handle.ready;
  viewers.at(-1).tweenCameraTo("top", { duration: 5 });
  runFrames(1.5); // well past the intro's 0.6s
  expect(handle.animation.state().status).toBe("intro");
  handle.dispose();
});

test("animate: false mounts the opening pose and no player", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(), animate: false });
  expect(handle.animation).toBeNull();
  await handle.ready;
  expect(handle.animation).toBeNull();
  runFrames(1);
  expect([...viewers.at(-1).__subMesh("lid").matrix.elements]).toEqual(IDENTITY);
  handle.dispose();
});

test("a still file has no animation handle", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb() });
  await handle.ready;
  expect(handle.animation).toBeNull();
  handle.dispose();
});

test("under prefers-reduced-motion the player never starts: no pose, and a faded-in sub-part stays drawn", async () => {
  const matchMedia = vi.fn((query) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query }));
  vi.stubGlobal("matchMedia", matchMedia);
  // An assemble-style file: the lid fades in from nothing.
  const a = input();
  a.samples[0].opacity = { lid: 0 };
  a.samples[1].opacity = { lid: 0.5 };
  a.samples[2].opacity = { lid: 1 };
  const handle = mountPreview(makeStage(), { glb: await encodePreviewGlb({ meshes: [box("base"), box("lid", 24)], view: "box", animation: a }) });
  await handle.ready;
  expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  expect(handle.animation.state().status).toBe("idle");
  runFrames(1.5);
  expect(handle.animation.state()).toEqual({ status: "idle", t: 0 });
  const lid = viewers.at(-1).__subMesh("lid");
  expect(lid.visible).toBe(true);              // never faded to 0
  expect(lid.material.opacity ?? 1).toBe(1);
  expect(viewers.at(-1).setSubPose).not.toHaveBeenCalled();
  expect([...lid.matrix.elements]).toEqual(IDENTITY);
  handle.dispose();
});

test("dispose stops the player", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb() });
  await handle.ready;
  const loop = state.renderer.animationLoop;
  runFrames(1);
  const animation = handle.animation;
  const { t } = animation.state();
  handle.dispose();
  expect(handle.animation).toBeNull(); // the disposed player's controls are not handed out
  for (let i = 0; i < 10; i++) loop((clockMs += 100));
  expect(animation.state().t).toBe(t);
});

test("parking (setActive(false)) pauses the player; unparking resumes it", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb() });
  await handle.ready;
  runFrames(0.8); // past the intro
  runFrames(0.3);
  const t1 = handle.animation.state().t;
  expect(t1).toBeGreaterThan(0);
  handle.setActive(false);
  expect(state.renderer.animationLoop).toBeNull(); // the viewer's frame loop, and the player's clock, stop
  clockMs += 5000;                                  // time passes while parked
  expect(handle.animation.state().t).toBe(t1);
  handle.setActive(true);
  expect(handle.animation.state().t).toBe(t1);
  runFrames(0.3);
  const t2 = handle.animation.state().t;
  expect(t2).toBeGreaterThan(t1);
  expect(t2 - t1).toBeLessThan(0.3); // resumed where it was, not jumped by the parked seconds
  handle.dispose();
});

test("a cue-only animation moves the camera over a still model", async () => {
  const a = input();
  for (const s of a.samples) s.poses.lid = T(24); // nothing moves
  a.anim = { ...a.anim, cues: [{ t: 0, view: "front", sweep: null }, { t: 0.5, view: "top", sweep: 0.3 }] };
  const handle = mountPreview(makeStage(), { glb: await encodePreviewGlb({ meshes: [box("base"), box("lid", 24)], view: "box", animation: a }) });
  await handle.ready;
  const v = viewers.at(-1);
  v.setSubPose.mockClear();
  const dir = () => { const c = handle.getViewerState().camera; const d = c.pos.map((x, i) => x - c.target[i]); const n = Math.hypot(...d); return d.map((x) => x / n); };
  runFrames(0.8); // the intro tween to "front" lands
  const atFront = dir();
  runFrames(1.5); // crosses t = 0.5: a 0.3s sweep to "top"
  const atTop = dir();
  expect(Math.hypot(...atTop.map((x, i) => x - atFront[i]))).toBeGreaterThan(0.5);
  const top = cameraPoseForView("top", { center: [0, 0, 0], radius: 1 });
  const unit = (d) => { const n = Math.hypot(...d); return d.map((x) => x / n); };
  expectNear(atTop, unit(top.position.map((c, i) => c - top.target[i])), 3);
  expect(v.setSubPose).not.toHaveBeenCalled();
  for (const name of ["base", "lid"]) expect([...v.__subMesh(name).matrix.elements]).toEqual(IDENTITY);
  handle.dispose();
});

// The hinged box's `cycle` is the box view's autoplay animation and drives only
// lidAngle, which build() never reads: the export bakes it as the lid's channels.
const hingedDelivery = () => [
  { ...boxSoup("base", [0, 0, 0], [60, 40, 24]), reads: ["width", "depth", "height", "wall"] },
  { ...boxSoup("lid", [0, 0, 0], [60, 40, 2]), reads: ["width", "depth", "wall"], frame: "canonical" },
];

async function mountHingedBox(part) {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(part, { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: hingedDelivery() } });
  await runtime.ready;
  return runtime;
}

test("exportPreview carries the hinged box's autoplay cycle as channels", async () => {
  const { default: hingedBox } = await import("../../src/parts/hinged-box.js");
  const runtime = await mountHingedBox(hingedBox);
  const out = await decodePreviewGlb(await runtime.exportPreview());
  expect(out.view).toBe("box");
  expect(out.animation?.animated).toEqual(["lid"]);
  runtime.dispose();
});

test("exportPreview stores the params the meshes sit at", async () => {
  const { default: hingedBox } = await import("../../src/parts/hinged-box.js");
  const runtime = await mountHingedBox(hingedBox);
  runtime.setParams({ lidAngle: 50 });
  const d = await decodePreviewGlb(await runtime.exportPreview());
  runtime.dispose();
  expect(d.params.lidAngle).toBe(0); // the cycle's t = 0 value, not the live 50
  expect(d.params.width).toBe(hingedBox.defaults.width); // the defaults ride along
});

test("a still export stores the live params", async () => {
  const { workers, createWorker } = makeWorkers();
  const base = makePart();
  const part = { ...base, defaults: { ...base.defaults, tilt: 0 } }; // build() never reads tilt
  const runtime = mount(part, { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", ms: 1, meshes: [
    { ...boxSoup("body", [0, 0, 0], [4, 4, 4]), reads: ["h"] },
  ] } });
  await runtime.ready;
  runtime.setParams({ tilt: 7 });
  const d = await decodePreviewGlb(await runtime.exportPreview());
  runtime.dispose();
  expect(d.animation).toBeNull();
  expect(d.params).toMatchObject({ h: 4, tilt: 7 });
});

test("exportPreview carries no animation when a tracked param is read by build()", async () => {
  const { default: hingedBox } = await import("../../src/parts/hinged-box.js");
  const animations = hingedBox.views.box.animations;
  const part = {
    ...hingedBox,
    views: { box: { ...hingedBox.views.box, animations: {
      ...animations, cycle: { ...animations.cycle, tracks: { width: [[0, 60], [1, 80]] } },
    } } },
  };
  const runtime = await mountHingedBox(part);
  const out = await decodePreviewGlb(await runtime.exportPreview());
  expect(out.view).toBe("box");
  expect(out.animation).toBeNull();
  runtime.dispose();
});

test("an export taken mid-autoplay (lidAngle 50, a non-identity rest) plays back where place(t) puts the lid", async () => {
  const { default: hingedBox } = await import("../../src/parts/hinged-box.js");
  const { viewAnimations, evaluate } = await import("../../src/framework/animation.js");
  const { probePoses } = await import("../../src/framework/pose-probe.js");
  const { composePose, invertRigid } = await import("../../src/framework/geometry/pose.js");
  const { createPreviewPlayer } = await import("../../src/framework/preview-player.js");
  const runtime = await mountHingedBox(hingedBox);
  runtime.setParams({ lidAngle: 50 }); // place-only: posed by matrix, no rebuild
  const d = await decodePreviewGlb(await runtime.exportPreview());
  runtime.dispose();
  expect(d.animation?.animated).toEqual(["lid"]);
  // The file was baked at 50° but opens at the cycle's t = 0 (closed): rest ≠ I.
  expect(Math.max(...d.animation.rest.lid.map((v, i) => Math.abs(v - IDENTITY[i])))).toBeGreaterThan(0.1);

  const anim = viewAnimations(hingedBox).get("box").find((a) => a.autoplay);
  const placeAt = (t) => composePose(probePoses(hingedBox, "box",
    { ...hingedBox.defaults, lidAngle: 50, ...evaluate(anim, t).values }, { scope: "place" }).get("lid").pose);
  const xf = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  const lid = d.meshes.find((m) => m.name === "lid").positions;
  const verts = [];
  for (let i = 0; i < lid.length; i += 3) verts.push([lid[i], lid[i + 1], lid[i + 2]]);
  // The meshes decode at the opening pose: every vertex is place(0) · a corner of the canonical 60×40×2 plate.
  const open = invertRigid(placeAt(0));
  for (const q of verts) {
    const c = xf(open, q);
    [[0, 60], [0, 40], [0, 2]].forEach((ends, a) => expect(Math.min(...ends.map((e) => Math.abs(c[a] - e))), `corner axis ${a}`).toBeLessThan(0.05));
  }
  // Played with a fake viewer: pose(t) · opening position = place(t) · canonical, within 0.05 mm.
  const poses = {};
  let frame = null;
  const fake = { setSubPose: (n, m) => { poses[n] = m; }, setSubPartOpacity() {}, tweenCameraTo() {}, holdGround() {},
    onFrame: (cb) => { frame = cb; return () => {}; }, onCameraStart: () => () => {} };
  const player = createPreviewPlayer(fake, { ...d.animation, cues: [] });
  player.start();
  let maxErr = 0, sawMid = false;
  for (let k = 0; k < 16; k++) {
    if (k) frame(0.1);
    const { t } = player.state();
    if (Math.abs(t - 0.5) < 0.05) sawMid = true;
    const M = placeAt(t);
    for (const q of verts) {
      const got = xf(poses.lid, q);
      const want = xf(M, xf(open, q));
      maxErr = Math.max(maxErr, Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]));
    }
  }
  expect(sawMid).toBe(true);
  expect(maxErr).toBeLessThan(0.05);
});

// --- mountPreview: the play/pause/replay button -----------------------------------
// A stage carrying the toolbar the cloud's sandbox scaffold supplies: #viewbar
// with #theme, which the view style button is inserted before.
function makeToolbarStage() {
  const stage = makeStage();
  const bar = document.createElement("div");
  bar.id = "viewbar";
  const theme = document.createElement("button");
  theme.id = "theme";
  bar.append(theme);
  stage.append(bar);
  return stage;
}
const playButton = (stage) => stage.querySelector("#pf-preview-play");
const oneTimeGlb = () => {
  const a = input();
  a.anim = { ...a.anim, loop: false };
  return encodePreviewGlb({ meshes: [box("base"), box("lid", 24)], view: "box", animation: a });
};

test("an animated preview gets a pause button directly beside the view style button", async () => {
  const stage = makeToolbarStage();
  const handle = mountPreview(stage, { glb: await animatedGlb() });
  await handle.ready;
  const button = playButton(stage);
  expect(button).not.toBeNull();
  expect(button.parentElement.id).toBe("viewbar");
  expect(button.nextElementSibling.id).toBe("view-style");
  expect(button.getAttribute("type")).toBe("button");
  expect(button.getAttribute("aria-label")).toBe("Pause animation"); // during the intro tween
  expect(button.hasAttribute("aria-pressed")).toBe(false); // the label carries the state
  expect(button.querySelector("svg")).not.toBeNull();
  handle.dispose();
});

test("no play button for a still file, with animate: false, or under reduced motion", async () => {
  const still = makeToolbarStage();
  const h1 = mountPreview(still, { glb: await stillGlb() });
  await h1.ready;
  expect(playButton(still)).toBeNull();
  h1.dispose();

  const off = makeToolbarStage();
  const h2 = mountPreview(off, { glb: await animatedGlb(), animate: false });
  await h2.ready;
  expect(playButton(off)).toBeNull();
  h2.dispose();

  vi.stubGlobal("matchMedia", (query) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query }));
  const reduced = makeToolbarStage();
  const h3 = mountPreview(reduced, { glb: await animatedGlb() });
  await h3.ready;
  expect(h3.animation).not.toBeNull();
  expect(playButton(reduced)).toBeNull();
  h3.dispose();
});

test("the button pauses and resumes, and t holds while paused", async () => {
  const stage = makeToolbarStage();
  const handle = mountPreview(stage, { glb: await animatedGlb() });
  await handle.ready;
  runFrames(0.8); // past the intro
  runFrames(0.3);
  const button = playButton(stage);
  button.click();
  expect(handle.animation.state().status).toBe("paused");
  expect(button.getAttribute("aria-label")).toBe("Play animation");
  const t = handle.animation.state().t;
  runFrames(1);
  expect(handle.animation.state().t).toBe(t);
  button.click();
  expect(button.getAttribute("aria-label")).toBe("Pause animation");
  runFrames(0.5);
  expect(handle.animation.state().t).toBeGreaterThan(t);
  // A host pause through the handle updates the button too.
  handle.animation.pause();
  expect(button.getAttribute("aria-label")).toBe("Play animation");
  handle.dispose();
});

test("pausing during the intro stops the camera where it is", async () => {
  const stage = makeToolbarStage();
  const handle = mountPreview(stage, { glb: await animatedGlb() });
  await handle.ready;
  runFrames(0.2); // partway through the 0.6s intro tween
  playButton(stage).click();
  const cam = handle.getViewerState().camera;
  runFrames(1);
  expectNear(handle.getViewerState().camera.pos, cam.pos, 6);
  expect(handle.animation.state()).toEqual({ status: "paused", t: 0 });
  handle.dispose();
});

test("a one-time animation ends on Replay, which plays it again from the start", async () => {
  const stage = makeToolbarStage();
  const handle = mountPreview(stage, { glb: await oneTimeGlb() });
  await handle.ready;
  runFrames(0.8);
  runFrames(2.5);
  expect(handle.animation.state()).toEqual({ status: "done", t: 1 });
  const button = playButton(stage);
  expect(button.getAttribute("aria-label")).toBe("Replay animation");
  button.click();
  expect(handle.animation.state()).toEqual({ status: "intro", t: 0 });
  expect(button.getAttribute("aria-label")).toBe("Pause animation");
  runFrames(0.8);
  runFrames(0.2);
  const { status, t } = handle.animation.state();
  expect(status).toBe("playing");
  expect(t).toBeGreaterThan(0);
  expect(t).toBeLessThan(0.5); // ~0.6s of play after the intro: restarted, not resumed from the end
  handle.dispose();
});

test("handle.animation.replay restarts a finished one-time animation", async () => {
  const handle = mountPreview(makeStage(), { glb: await oneTimeGlb() });
  await handle.ready;
  runFrames(3.5);
  expect(handle.animation.state().status).toBe("done");
  handle.animation.replay();
  expect(handle.animation.state()).toEqual({ status: "intro", t: 0 });
  handle.dispose();
});

test("dispose removes the play button", async () => {
  const stage = makeToolbarStage();
  const handle = mountPreview(stage, { glb: await animatedGlb() });
  await handle.ready;
  expect(playButton(stage)).not.toBeNull();
  handle.dispose();
  expect(playButton(stage)).toBeNull();
});

test("a tooltip showing when the label changes no longer names the old action", async () => {
  const stage = makeToolbarStage();
  const handle = mountPreview(stage, { glb: await oneTimeGlb() });
  await handle.ready;
  runFrames(0.8);
  const button = playButton(stage);
  button.dispatchEvent(new Event("pointerenter"));
  const tip = document.querySelector(".pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.textContent).toBe("Pause animation");
  runFrames(2.5); // the one-time animation reaches done: the button now says Replay
  expect(handle.animation.state().status).toBe("done");
  expect(button.getAttribute("aria-label")).toBe("Replay animation");
  const shown = tip.classList.contains("show") ? tip.textContent : null;
  expect(shown).not.toBe("Pause animation");
  handle.dispose();
});

// --- mountPreview({ part }): posing on the file ---------------------------------
// A gearbox GLB without a kernel: a 10 mm box soup per view sub-part, each at that
// sub-part's placement origin (so the viewer has something to frame), with the params
// the file sits at. Pose mode then runs on these meshes, posed by the file placer.
import gearbox from "../../src/parts/gearbox.js";
import drawerBox from "../../src/parts/drawer-box.js";
import { viewSubParts, resolveParams } from "../../src/framework/part-model.js";
import { placeMatrix } from "../../src/framework/collide/place.js";
import { snapValues } from "../../src/framework/pose/param-solve.js";
import { samplePreviewAnimation } from "../../src/framework/preview-animation.js";
import { viewAnimations, evaluate } from "../../src/framework/animation.js";

async function partGlb(part, view, params, animation = null) {
  const { p, d } = resolveParams(part, params);
  const meshes = viewSubParts(part, view, params).map((name) => {
    const m = placeMatrix(part.parts[name], view, p, d);
    const o = m ? [m[12], m[13], m[14]] : [0, 0, 0];
    return boxSoup(name, o.map((c) => c - 5), o.map((c) => c + 5));
  });
  return encodePreviewGlb({ meshes, part, view, params, animation });
}
const gearboxGlb = ({ params = gearbox.defaults, animation = false, cues = null } = {}) => {
  const all = { ...gearbox.defaults, ...params };
  if (!animation) return partGlb(gearbox, "gearbox", all);
  // An empty read set: no build reads a tracked key (true of the gearbox), so the spin bakes.
  const sampled = samplePreviewAnimation(gearbox, "gearbox", all, { buildReads: () => new Set() });
  return partGlb(gearbox, "gearbox", all, cues ? { ...sampled, anim: { ...sampled.anim, cues } } : sampled);
};
// The fake renderer draws only when its loop is driven: one frame lands `drawn`.
async function drawn(handle) {
  await handle.ready;
  state.renderer.animationLoop((clockMs += 100));
  await handle.drawn;
}
// The pose mode decides its handles in idle time after the first frame.
const settleIdle = (handle) => vi.waitFor(() => expect(handle.__preview.visible).not.toBeNull());
// The crank's point at `params`, turned `deg` about the crank's declared axis
// (gearbox.js: origin [C1x, C1y, GEAR_Z] with C1 = [0, 0], direction +Z).
function crankTarget(params, deg) {
  const { p, d } = resolveParams(gearbox, params);
  const [x, y, z] = gearbox.handles.crank.point(p, d);
  const [ox, oy] = gearbox.handles.crank.axis.origin;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [ox + (x - ox) * c - (y - oy) * s, oy + (x - ox) * s + (y - oy) * c, z];
}
// Turn the crank by `total` degrees through the session, in `step`-degree frames.
function turnCrank(handle, total, step = 30) {
  const { poseMode } = handle.__preview;
  const start = { ...handle.getParams() };
  poseMode.session.begin("crank");
  for (let a = step; a <= total; a += step) poseMode.session.frame(crankTarget(start, Math.min(a, total)));
  if (total % step) poseMode.session.frame(crankTarget(start, total));
}

// Turn the crank with the pointer on the canvas: hover its point, press, four moves
// round its axis on screen (`during` runs once pose mode's frame has taken them —
// it batches moves into a requestAnimationFrame), release.
async function pointerTurnCrank(handle, v, during = () => {}) {
  v.domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 });
  const fire = (type, x, y) => v.domElement.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true }));
  const centre = v.projectPoint(gearbox.handles.crank.axis.origin);
  const s = handle.pose.handlePoints().find((h) => h.handleId === "crank");
  const r = Math.hypot(s.x - centre.x, s.y - centre.y);
  const a0 = Math.atan2(s.y - centre.y, s.x - centre.x);
  fire("pointermove", s.x, s.y);
  fire("pointerdown", s.x, s.y);
  for (let k = 1; k <= 4; k++) fire("pointermove", centre.x + r * Math.cos(a0 + k * 0.15), centre.y + r * Math.sin(a0 + k * 0.15));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  during();
  fire("pointerup", centre.x + r * Math.cos(a0 + 0.6), centre.y + r * Math.sin(a0 + 0.6));
}

test("without part, mountPreview exposes the no-op pose and null params", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb() });
  await handle.ready;
  expect(handle.pose.isLive()).toBe(false);
  expect(handle.pose.isEnabled()).toBe(false);
  expect(handle.pose.pinCount()).toBe(0);
  expect(handle.pose.handlePoints()).toEqual([]);
  expect(handle.pose.onDragEnd(() => {})).toBeTypeOf("function");
  expect(handle.getParams()).toBeNull();
  expect(handle.__preview).toBeNull();
  handle.dispose();
});

test("part must be a PartDefinition", () => {
  expect(() => mountPreview(makeStage(), { glb: new Uint8Array(4), part: 3 })).toThrow(/part must be a PartDefinition/);
  expect(() => mountPreview(makeStage(), { glb: new Uint8Array(4), part: { defaults: {} } })).toThrow(/part must be a PartDefinition/);
});

test("with part, the pose surface is safe before ready", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb(), part: gearbox });
  expect(handle.getParams()).toBeNull();
  expect(handle.pose.isLive()).toBe(false);
  expect(handle.pose.handlePoints()).toEqual([]);
  expect(() => handle.pose.releasePins()).not.toThrow();
  expect(typeof handle.pose.onDragEnd(() => {})).toBe("function");
  expect(handle.pose.__lastDragEnd()).toBeNull();
  handle.pose.setEnabled(false); // kept until pose mode exists
  await drawn(handle); await settleIdle(handle);
  expect(handle.pose.isEnabled()).toBe(false);
  expect(handle.pose.isLive()).toBe(false);
  handle.pose.setEnabled(true);
  expect(handle.pose.isLive()).toBe(true);
  handle.dispose();
  expect(() => { handle.pose.setEnabled(false); handle.pose.releasePins(); }).not.toThrow();
  expect(handle.pose.onDragEnd(() => {})).toBeTypeOf("function");
});

test("with part, the preview seeds its params from the file and shows the place-only handles once decided", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ params: { driveAngle: 37 } }), part: gearbox });
  await drawn(handle);
  expect(handle.getParams().driveAngle).toBe(37);
  expect(handle.__preview.fileParams.driveAngle).toBe(37);
  expect(Object.isFrozen(handle.__preview.fileParams)).toBe(true);
  await settleIdle(handle);
  expect(handle.pose.isLive()).toBe(true);
  const ids = handle.pose.handlePoints().map((h) => h.handleId);
  expect(new Set(ids)).toEqual(new Set(Object.keys(gearbox.handles)));
  handle.dispose();
  expect(handle.getParams()).toBeNull();
  expect(handle.pose.handlePoints()).toEqual([]);
  expect(handle.pose.isLive()).toBe(false);
});

test("a drag writes the params and poses every gear by matrix; release fires onDragEnd once", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb(), part: gearbox });
  const early = [];
  handle.pose.onDragEnd((e) => early.push(e)); // subscribed before ready
  await drawn(handle); await settleIdle(handle);
  const v = viewers.at(-1);
  const { poseMode, placer } = handle.__preview;
  turnCrank(handle, 30);
  const mid = handle.getParams().driveAngle;
  expect(mid).toBeCloseTo(30, 0);
  const { p, d } = resolveParams(gearbox, handle.getParams());
  const want = placer.matricesAt(p, d);
  for (const name of ["gear1", "gear2", "gear3", "crank"]) {
    expectNear([...v._subMeshes[name].matrix.elements], want.get(name), 4);
  }
  expect(want.get("gear2")).not.toEqual(IDENTITY); // the idler turned too
  poseMode.session.end();
  expect(handle.pose.__lastDragEnd()).toMatchObject({ changed: ["driveAngle"] });

  // A released pointer drag tells onDragEnd once.
  const ends = [];
  const off = handle.pose.onDragEnd((e) => ends.push(e));
  await pointerTurnCrank(handle, v);
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ handleId: "crank", changed: ["driveAngle"] });
  expect(early).toEqual(ends);
  expect(handle.pose.__lastDragEnd()).toMatchObject({ handleId: "crank", changed: ["driveAngle"] });
  off();
  handle.dispose();
});

test("a wrapped param keeps its turn: a drag to 370 lands as the editor's own snapping has it", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb(), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  turnCrank(handle, 370, 10);
  handle.__preview.poseMode.session.end();
  expect(handle.getParams().driveAngle).toBe(snapValues(gearbox, { driveAngle: 370 }).driveAngle);
  handle.dispose();
});

test("the drawer box's corner handle is hidden in a preview; its drawers show", async () => {
  const glb = await partGlb(drawerBox, "cabinet", drawerBox.defaults);
  const handle = mountPreview(makeStage(), { glb, part: drawerBox });
  await drawn(handle); await settleIdle(handle);
  expect(handle.__preview.visible).toEqual({ shown: ["drawer1", "drawer2", "drawer3"], hidden: { corner: expect.stringMatching(/rebuilds/) } });
  expect(new Set(handle.pose.handlePoints({ offscreen: true }).map((h) => h.handleId))).toEqual(new Set(["drawer1", "drawer2", "drawer3"]));
  handle.dispose();
});

test("collisions: a part with a collisions block gets the editor's collide index over the drawn meshes", async () => {
  const glb = await partGlb(drawerBox, "cabinet", drawerBox.defaults);
  const handle = mountPreview(makeStage(), { glb, part: drawerBox });
  await drawn(handle); await settleIdle(handle);
  const pc = handle.__preview.poseCollide;
  expect(pc).not.toBeNull();
  const count = viewSubParts(drawerBox, "cabinet", drawerBox.defaults).length;
  // world.js loads on the first idle slice, then each slice indexes what it has time for
  await vi.waitFor(() => expect(pc.state().indexed.length).toBe(count));
  expect(pc.state().queued + pc.state().indexed.length).toBe(count);
  handle.dispose();
  expect(pc.state().indexed).toEqual([]); // disposed with the preview
});

test("collisions: a drawer dragged into the next one stops at contact and tints the pair", async () => {
  // partGlb's 10 mm boxes sit at each placement's origin: drawer1 (closed) at y = 0 and
  // drawer2 (40 % open) 44 mm out along -Y, so drawer1 meets it about 31 % open.
  const glb = await partGlb(drawerBox, "cabinet", drawerBox.defaults);
  const handle = mountPreview(makeStage(), { glb, part: drawerBox });
  await drawn(handle); await settleIdle(handle);
  const pc = handle.__preview.poseCollide;
  const count = viewSubParts(drawerBox, "cabinet", drawerBox.defaults).length;
  await vi.waitFor(() => expect(pc.state().indexed.length).toBe(count));
  const { poseMode } = handle.__preview;
  poseMode.session.begin("drawer1");
  for (const open of [20, 40, 60]) {
    const { d } = resolveParams(drawerBox, { ...drawerBox.defaults, drawer1Open: open });
    poseMode.session.frame(d.pulls[0]);
  }
  const held = handle.getParams().drawer1Open;
  expect(held).toBeGreaterThan(29);
  expect(held).toBeLessThan(32);
  expect(pc.state().tinted).toEqual({ a: "drawer1", b: "drawer2" });
  poseMode.session.end();
  expect(pc.state().tinted).toBeNull();
  handle.dispose();
});

test("collisions: a part with no collisions block creates no collide index", async () => {
  const { default: hingedBox } = await import("../../src/parts/hinged-box.js");
  const glb = await partGlb(hingedBox, "box", hingedBox.defaults);
  const handle = mountPreview(makeStage(), { glb, part: hingedBox });
  await drawn(handle); await settleIdle(handle);
  expect(handle.__preview.poseCollide).toBeNull();
  handle.dispose();
});

test("a file showing a view the part does not declare attaches nothing, and says so once", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const glb = await encodePreviewGlb({ meshes: [boxSoup("gear1", [0, 0, 0], [4, 4, 4])], view: "elsewhere" });
  const handle = mountPreview(makeStage(), { glb, part: gearbox });
  await drawn(handle);
  expect(warn.mock.calls.filter(([m]) => /preview part ignored/.test(m))).toEqual([
    ['partforge: preview part ignored — the file shows view "elsewhere", which the part does not declare'],
  ]);
  expect(handle.getParams()).toBeNull();
  expect(handle.pose.isLive()).toBe(false);
  expect(handle.pose.handlePoints()).toEqual([]);
  handle.dispose();
});

test("dispose mid-drag writes nothing and throws nothing", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb(), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  const v = viewers.at(-1);
  const { poseMode } = handle.__preview;
  turnCrank(handle, 30);
  v.setSubPose.mockClear();
  expect(() => handle.dispose()).not.toThrow();
  expect(handle.getParams()).toBeNull();
  // A late session effect after teardown is a no-op.
  expect(() => poseMode.session.end()).not.toThrow();
  expect(v.setSubPose).not.toHaveBeenCalled();
});

test("chrome: false attaches no Release pins action and no readout pill, but the chip", async () => {
  const stage = makeToolbarStage();
  const handle = mountPreview(stage, { glb: await gearboxGlb(), part: gearbox, chrome: false });
  await drawn(handle); await settleIdle(handle);
  expect(stage.querySelector(".pf-pose-actions")).toBeNull();
  expect(stage.querySelector(".pf-pose-readout")).toBeNull();
  expect(stage.querySelector(".pf-pose-chip")).not.toBeNull();
  handle.dispose();
  expect(stage.querySelector(".pf-pose-chip")).toBeNull();
});

test("with chrome, the Release pins action and the readout pill sit in the viewbar", async () => {
  const stage = makeToolbarStage();
  const handle = mountPreview(stage, { glb: await gearboxGlb(), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  expect(stage.querySelector("#viewbar .pf-pose-actions")).not.toBeNull();
  expect(stage.querySelector("#viewbar .pf-pose-readout")).not.toBeNull();
  let mid = null;
  await pointerTurnCrank(handle, viewers.at(-1), () => { mid = handle.pose.__dragReadout(); });
  expect(mid).toMatch(/Input angle/);
  expect(handle.pose.__dragReadout()).toBeNull(); // released
  handle.dispose();
  expect(stage.querySelector(".pf-pose-actions")).toBeNull();
  expect(stage.querySelector(".pf-pose-readout")).toBeNull();
});

// --- mountPreview({ part }) on a playing animation: the params follow the player -------
const spin = viewAnimations(gearbox).get("gearbox").find((a) => a.autoplay);
const maxAbsDiff = (a, b) => Math.max(...[...a].map((x, i) => Math.abs(x - b[i])));
// Advance the player to about `t` (the spin lasts 6 s; runFrames's 0.1 s frames).
const playTo = (t) => runFrames(t * spin.totalDuration - 0.1);

test("while the animation plays, getParams follows the player", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ animation: true }), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  playTo(0.4);
  expect(handle.animation.state().status).toBe("playing");
  const { t } = handle.animation.state();
  expect(t).toBeGreaterThan(0.3);
  const got = handle.getParams();
  expect(got.driveAngle).toBeCloseTo(evaluate(spin, t).values.driveAngle, 6);
  expect(got).toEqual({ ...handle.__preview.fileParams, ...evaluate(spin, t).values });
  expect(handle.__preview.params.driveAngle).toBe(handle.__preview.fileParams.driveAngle); // nothing written
  // the placer's matrices at those params are the player's pose
  const { p, d } = resolveParams(gearbox, got);
  const want = handle.__preview.placer.matricesAt(p, d);
  const v = viewers.at(-1);
  for (const name of ["gear1", "gear2", "gear3", "crank"]) {
    expect(maxAbsDiff(v._subMeshes[name].matrix.elements, want.get(name))).toBeLessThan(1e-3);
  }
  handle.dispose();
});

test("a press pauses the player and writes its params; cancel restores them, not t = 0", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ animation: true }), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  playTo(0.4);
  const { t } = handle.animation.state();
  const v = viewers.at(-1);
  const before = Object.fromEntries(["gear1", "gear2", "gear3", "crank"].map((n) => [n, [...v._subMeshes[n].matrix.elements]]));
  const { poseMode } = handle.__preview;
  const start = handle.getParams();
  poseMode.session.begin("crank");
  expect(handle.animation.state().status).toBe("paused");
  const held = handle.getParams().driveAngle;
  expect(held).toBeCloseTo(evaluate(spin, t).values.driveAngle, 9);
  expect(handle.__preview.params.driveAngle).toBe(held); // written into the preview's own params
  poseMode.session.frame(crankTarget(start, 30));
  expect(handle.getParams().driveAngle).toBeCloseTo(held + 30, 0);
  poseMode.session.cancel();
  expect(handle.getParams().driveAngle).toBeCloseTo(held, 9);
  // every mesh back at the paused pose
  for (const [name, m] of Object.entries(before)) expect(maxAbsDiff(v._subMeshes[name].matrix.elements, m)).toBeLessThan(1e-3);
  expect(handle.animation.state().status).toBe("paused"); // stays paused
  handle.dispose();
});

test("a press during the intro pauses it and writes the file params", async () => {
  const cues = [{ t: 0, view: "front", sweep: null }];
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ animation: true, cues }), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  expect(handle.animation.state().status).toBe("intro");
  expect(handle.getParams()).toEqual(handle.__preview.fileParams);
  handle.__preview.poseMode.session.begin("crank");
  expect(handle.animation.state().status).toBe("paused");
  expect(handle.getParams()).toEqual(handle.__preview.fileParams);
  handle.dispose();
});

test("a pause from the button writes the player's params, so a later press finds them", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ animation: true }), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  playTo(0.4);
  handle.animation.pause();
  const { t } = handle.animation.state();
  expect(handle.__preview.params.driveAngle).toBeCloseTo(evaluate(spin, t).values.driveAngle, 9);
  runFrames(1);
  expect(handle.getParams().driveAngle).toBeCloseTo(evaluate(spin, t).values.driveAngle, 9);
  handle.dispose();
});

test("under reduced motion the params are the file params and handles show at once", async () => {
  vi.stubGlobal("matchMedia", (query) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query }));
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ animation: true }), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  runFrames(1);
  expect(handle.getParams()).toEqual(handle.__preview.fileParams);
  expect(handle.pose.isLive()).toBe(true);
  handle.dispose();
});

test("a press stops the turntable", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb(), part: gearbox, turntable: 30 });
  await drawn(handle); await settleIdle(handle);
  expect(handle.motion.state).toBe("playing");
  handle.__preview.poseMode.session.begin("crank");
  expect(handle.motion.state).toBe("stopped");
  handle.__preview.poseMode.session.end();
  handle.motion.restart();
  expect(handle.motion.state).toBe("playing"); // restart re-arms it
  handle.dispose();
});

test("motion.restart puts the params back to the file's", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ animation: true }), part: gearbox });
  await drawn(handle); await settleIdle(handle);
  playTo(0.2);
  turnCrank(handle, 60);
  handle.__preview.poseMode.session.end();
  expect(handle.getParams().driveAngle).not.toBeCloseTo(handle.__preview.fileParams.driveAngle, 0);
  handle.motion.restart();
  expect(handle.__preview.params).toEqual(handle.__preview.fileParams);
  expect(handle.getParams()).toEqual(handle.__preview.fileParams); // playing again from t = 0
  expect(handle.animation.state().status).toBe("playing");
  handle.dispose();
});
