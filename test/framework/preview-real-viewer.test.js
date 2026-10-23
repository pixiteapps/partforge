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
