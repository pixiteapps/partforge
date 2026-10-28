// @vitest-environment happy-dom
// mountPreview({ showcase }): the chrome-less, transparent, orbit-only preview a
// marketing page drops into a small card — a still model turns slowly, a baked
// animation plays as authored — plus `handle.drawn`, and the three createViewer
// options showcase is built from. The real viewer on a fake WebGLRenderer (the
// preview-real-viewer.test.js harness).
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor(options = {}) {
      this.options = options;
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.toneMapping = 0;
      this.toneMappingExposure = 1;
      this.clearColor = null;
      this.clearAlpha = options.alpha ? 0 : 1; // three's own default
      this.renders = 0;
      this.lastScene = null;
      this.compileAsync = vi.fn(async () => {});
      state.renderer ??= this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    getSize(target) { return target.set(400, 300); }
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render(scene) { this.renders++; this.lastScene = scene; }
    get capabilities() { return { maxTextureSize: 8192, textureTypeReadable: () => true }; }
    setRenderTarget() {}
    getRenderTarget() { return null; }
    setClearColor(color, alpha) { this.clearColor = color; if (alpha !== undefined) this.clearAlpha = alpha; }
    getClearAlpha() { return this.clearAlpha; }
    setClearAlpha(a) { this.clearAlpha = a; }
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

// Every OrbitControls a viewer makes, so a test can read its switches.
const controls = vi.hoisted(() => []);
vi.mock("three/addons/controls/OrbitControls.js", async (importOriginal) => {
  const { OrbitControls } = await importOriginal();
  return { OrbitControls: class extends OrbitControls {
    constructor(...args) { super(...args); controls.push(this); }
  } };
});

const viewers = vi.hoisted(() => []);
vi.mock("../../src/framework/viewer.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, createViewer: (...args) => {
    const v = real.createViewer(...args);
    viewers.push(v);
    return v;
  } };
});

import * as THREE from "three";
import { createViewer } from "../../src/framework/viewer.js";
import { mountPreview } from "../../src/framework/mount-preview.js";
import { encodePreviewGlb } from "../../src/framework/gltf/encode-preview.js";
import { invertRigid, mulMat4 } from "../../src/framework/geometry/pose.js";
import { box, input, R, T } from "../helpers/preview-animation-fixture.js";

const OriginalResizeObserver = globalThis.ResizeObserver;

// A stage with the host's #viewbar, so "no chrome" is a real absence.
function makeStage() {
  const stage = document.createElement("div");
  Object.defineProperties(stage, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  stage.append(viewbar);
  document.body.append(stage);
  return stage;
}

const stillGlb = () => encodePreviewGlb({ meshes: [box("base"), box("lid", 24)], view: "box" });
const animatedGlb = (mutate = (a) => a) => encodePreviewGlb({ meshes: [box("base"), box("lid", 24)], view: "box", animation: mutate(input()) });
// Plays through once and stops with the lid swung open (its last keyframe).
const playOnce = (a) => {
  a.anim = { ...a.anim, loop: false };
  a.samples[2].poses = { base: T(0), lid: R(-110) };
  return a;
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

let clockMs = 0;
function runFrames(seconds) {
  const loop = state.renderer.animationLoop;
  for (let i = 0; i <= Math.round(seconds * 10); i++) loop((clockMs += 100));
}

const azimuth = (handle) => {
  const { pos, target } = handle.getViewerState().camera;
  return Math.atan2(pos[0] - target[0], pos[2] - target[2]);
};
const reducedMotion = () => vi.stubGlobal("matchMedia", vi.fn((query) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query })));

beforeEach(() => {
  localStorage.clear();
  viewers.length = 0;
  controls.length = 0;
  state.renderer = null;
  clockMs = 0;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- the chrome --------------------------------------------------------------

test("showcase mounts no view cube, view-style control or play button", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await animatedGlb(), showcase: {} });
  await handle.ready;
  expect(stage.querySelector("#viewbar").children).toHaveLength(0);
  expect(stage.querySelector(".pf-viewcube-stack")).toBeNull();
  expect(stage.querySelector("#pf-preview-play")).toBeNull();
  expect(stage.querySelectorAll("canvas")).toHaveLength(1); // the viewer's own, no cube canvas
  handle.dispose();
});

test("default mountPreview is unchanged: the view cube, view style and play button still mount", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await animatedGlb() });
  await handle.ready;
  expect(stage.querySelector(".pf-viewcube-stack")).not.toBeNull();
  expect(stage.querySelector("#viewbar #pf-preview-play")).not.toBeNull();
  expect(stage.querySelector("#viewbar").children.length).toBeGreaterThan(1);
  expect(state.renderer.options.alpha).toBeUndefined();
  expect(state.renderer.lastScene).toBeNull(); // nothing rendered until the loop runs
  runFrames(0.1);
  expect(state.renderer.lastScene.background).not.toBeNull();
  handle.dispose();
});

test("showcase creates a transparent, contact-shadowed viewer with zoom and pan off", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), showcase: {} });
  await handle.ready;
  runFrames(0.1);
  expect(state.renderer.options.alpha).toBe(true);
  expect(state.renderer.getClearAlpha()).toBe(0);
  const scene = state.renderer.lastScene;
  expect(scene.background).toBeNull();
  expect(scene.children.find((c) => c.type === "GridHelper").visible).toBe(false);
  // The contact shadow: a black, alpha-mapped plane under the part.
  expect(scene.children.some((c) => c.isMesh && c.material?.alphaMap)).toBe(true);
  expect(controls.at(-1)).toMatchObject({ enableZoom: false, enablePan: false, enableRotate: true });
  handle.dispose();
});

test("the contact shadow follows a playing animation, and stays put once a still model is drawn", async () => {
  const shadowOf = () => state.renderer.lastScene.children.find((c) => c.isMesh && c.material?.alphaMap);
  const still = mountPreview(makeStage(), { glb: await stillGlb(), showcase: {} });
  await still.ready;
  runFrames(0.1);
  const first = shadowOf();
  runFrames(1);
  expect(shadowOf()).toBe(first); // a turning camera moves no caster
  still.dispose();

  state.renderer = null;
  vi.spyOn(performance, "now").mockImplementation(() => clockMs); // the rebuild throttle reads wall time
  const moving = mountPreview(makeStage(), { glb: await animatedGlb(), showcase: {} });
  await moving.ready;
  runFrames(0.1);
  const opening = shadowOf();
  runFrames(1.5);
  expect(shadowOf()).not.toBe(opening);
  expect(opening.parent).toBeNull(); // the old plane left the scene
  moving.dispose();
});

// --- motion -------------------------------------------------------------------

test("showcase turns a still preview and the first camera grab stops it for good", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), showcase: {} });
  await handle.ready;
  const a0 = azimuth(handle);
  runFrames(1);
  const a1 = azimuth(handle);
  // 14°/s by default: about 14° over the second just run.
  expect(Math.abs(a1 - a0) * (180 / Math.PI)).toBeGreaterThan(8);
  expect(Math.abs(a1 - a0) * (180 / Math.PI)).toBeLessThan(20);

  viewers.at(-1).orbitBy(5, 0); // a user grab (the view cube's drag route)
  const a2 = azimuth(handle);
  runFrames(1);
  expect(azimuth(handle)).toBeCloseTo(a2, 6);
  runFrames(2);
  expect(azimuth(handle)).toBeCloseTo(a2, 6);
  handle.dispose();
});

test("showcase turns at the rate the host asks for", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), showcase: { turntableDegPerSec: 40 } });
  await handle.ready;
  const a0 = azimuth(handle);
  runFrames(1);
  expect(Math.abs(azimuth(handle) - a0) * (180 / Math.PI)).toBeGreaterThan(30);
  handle.dispose();
});

test("showcase never turns under reduced motion", async () => {
  reducedMotion();
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), showcase: {} });
  await handle.ready;
  const a0 = azimuth(handle);
  runFrames(2);
  expect(azimuth(handle)).toBeCloseTo(a0, 6);
  handle.dispose();
});

test("showcase plays a baked animation instead of turning", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb((a) => {
    a.anim = { ...a.anim, cues: [] }; // no camera cue, so any camera motion would be a turntable
    return a;
  }), showcase: {} });
  await handle.ready;
  const a0 = azimuth(handle);
  runFrames(1);
  expect(handle.animation.state().status).toBe("playing");
  expect(azimuth(handle)).toBeCloseTo(a0, 6);
  expect([...viewers.at(-1).__subMesh("lid").matrix.elements]).not.toEqual(IDENTITY);
  handle.dispose();
});

test("a play-once animation holds its final pose, with no replay button", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await animatedGlb(playOnce), showcase: {} });
  await handle.ready;
  runFrames(4); // the 0.6s intro tween, then the 2s animation, and then some
  expect(handle.animation.state().status).toBe("done");
  const lid = viewers.at(-1).__subMesh("lid");
  const want = mulMat4(R(-110), invertRigid(T(24)));
  const held = [...lid.matrix.elements];
  held.forEach((v, i) => expect(v).toBeCloseTo(want[i], 4));
  runFrames(2);
  expect([...lid.matrix.elements]).toEqual(held);
  expect(stage.querySelector("#pf-preview-play")).toBeNull();
  handle.dispose();
});

test("showcase ignores viewerState: it opens at its own default framing", async () => {
  const plain = mountPreview(makeStage(), { glb: await stillGlb(), animate: false });
  await plain.ready;
  const framing = plain.getViewerState().camera;
  plain.dispose();

  reducedMotion(); // hold the turntable still so the framing can be compared
  const handle = mountPreview(makeStage(), {
    glb: await stillGlb(),
    showcase: {},
    viewerState: { camera: { pos: [40, 0, 0], target: [0, 0, 0] }, projection: "perspective", renderMode: "realistic", cutaway: null },
  });
  await handle.ready;
  const cam = handle.getViewerState().camera;
  cam.pos.forEach((v, i) => expect(v).toBeCloseTo(framing.pos[i], 4));
  cam.target.forEach((v, i) => expect(v).toBeCloseTo(framing.target[i], 4));
  expect(handle.renderMode.get()).toBe("cad");
  handle.setViewerState({ camera: { pos: [0, 50, 0], target: [1, 1, 1] }, projection: "perspective", cutaway: null });
  expect(handle.getViewerState().camera.pos[0]).toBeCloseTo(framing.pos[0], 4);
  expect(await handle.renderMode.set("realistic")).toBe("cad");
  expect(handle.renderMode.get()).toBe("cad");
  handle.dispose();
});

// --- drawn --------------------------------------------------------------------

test("drawn resolves after the first rendered frame", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb() });
  let drawn = false;
  handle.drawn.then(() => { drawn = true; });
  await handle.ready;
  await Promise.resolve();
  expect(drawn).toBe(false);
  expect(state.renderer.renders).toBe(0);
  runFrames(0);
  await handle.drawn;
  expect(state.renderer.renders).toBeGreaterThan(0);
  handle.dispose();
});

test("drawn rejects with ready's error when the GLB will not decode", async () => {
  const handle = mountPreview(makeStage(), { glb: new Uint8Array([1, 2, 3]), showcase: {} });
  const error = await handle.ready.catch((e) => e);
  await expect(handle.drawn).rejects.toBe(error);
});

test("drawn rejects when the preview is disposed before its first frame", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb() });
  await handle.ready;
  handle.dispose();
  await expect(handle.drawn).rejects.toThrow(/disposed/);
});

// --- createViewer options -------------------------------------------------------

const viewerPart = () => ({
  meta: { title: "t" },
  defaults: {},
  parameters: [],
  views: { main: { label: "main" } },
  parts: { body: { label: "body", views: ["main"] } },
});

test("transparent viewer clears to alpha 0 and hides the grid, across a theme swap too", () => {
  const stage = makeStage();
  const v = createViewer(stage, viewerPart(), { transparent: true });
  state.renderer.animationLoop(0);
  const scene = state.renderer.lastScene;
  const grid = () => scene.children.find((c) => c.type === "GridHelper");
  expect(state.renderer.options.alpha).toBe(true);
  expect(state.renderer.getClearAlpha()).toBe(0);
  expect(scene.background).toBeNull();
  expect(grid().visible).toBe(false);
  v.setTheme("light");
  expect(scene.background).toBeNull();
  expect(grid().visible).toBe(false);
  v.dispose();
});

test("a default viewer keeps its theme background and grid", () => {
  const v = createViewer(makeStage(), viewerPart());
  state.renderer.animationLoop(0);
  const scene = state.renderer.lastScene;
  expect(state.renderer.options.alpha).toBeUndefined();
  expect(scene.background).toBeInstanceOf(THREE.Color);
  expect(scene.children.find((c) => c.type === "GridHelper").visible).toBe(true);
  v.dispose();
});

test("zoom:false and pan:false disable those OrbitControls", () => {
  const stage = makeStage();
  const wheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
  const v = createViewer(stage, viewerPart(), { zoom: false, pan: false });
  expect(controls.at(-1)).toMatchObject({ enableZoom: false, enablePan: false, enableRotate: true });
  v.domElement.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(false); // the page scrolls; the camera does not dolly
  v.dispose();

  const on = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
  const d = createViewer(makeStage(), viewerPart());
  expect(controls.at(-1)).toMatchObject({ enableZoom: true, enablePan: true });
  d.domElement.dispatchEvent(on);
  expect(on.defaultPrevented).toBe(true);
  d.dispose();
});
