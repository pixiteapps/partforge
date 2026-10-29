// @vitest-environment happy-dom
// mountPreview's presentation options (chrome, background, contactShadow, zoom,
// pan, turntable, camera, renderMode), each alone and combined as the landing
// page's card, plus `handle.drawn`, and the createViewer options they map onto. The real viewer on a fake WebGLRenderer (the
// preview-real-viewer.test.js harness).
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null, dataTextures: 0 }));

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
  // Counted: the live contact shadow makes one DataTexture per build.
  class CountingDataTexture extends actual.DataTexture {
    constructor(...args) { super(...args); state.dataTextures++; }
  }
  return { ...actual, WebGLRenderer: FakeRenderer, DataTexture: CountingDataTexture };
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
    // Realistic mode fetches its environment over the network; a test only
    // needs to see it asked for.
    const setRenderMode = v.setRenderMode;
    v.setRenderMode = vi.fn((mode) => (mode === "realistic" ? Promise.resolve("realistic") : setRenderMode(mode)));
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
function makeStage(width = 400, height = 300) {
  const stage = document.createElement("div");
  Object.defineProperties(stage, { clientWidth: { value: width }, clientHeight: { value: height } });
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

const LANDING_CARD = {
  chrome: false, background: "transparent", contactShadow: true, zoom: false, pan: false,
  turntable: 14, fill: 0.8, camera: "default", renderMode: "cad",
};
const shadowIn = (scene) => scene.children.find((c) => c.isMesh && c.material?.alphaMap);
const gridIn = (scene) => scene.children.find((c) => c.type === "GridHelper");
const CARRIED = { camera: { pos: [40, 0, 0], target: [0, 0, 0] }, projection: "perspective", renderMode: "realistic", cutaway: null };

// The camera a plain mount of the still file opens at.
async function defaultFraming(extra = {}) {
  const plain = mountPreview(makeStage(), { glb: await stillGlb(), ...extra });
  await plain.ready;
  const cam = plain.getViewerState().camera;
  plain.dispose();
  state.renderer = null;
  return cam;
}
const expectCamera = (got, want) => {
  got.pos.forEach((v, i) => expect(v).toBeCloseTo(want.pos[i], 4));
  got.target.forEach((v, i) => expect(v).toBeCloseTo(want.target[i], 4));
};

// --- defaults -----------------------------------------------------------------

test("with no options mountPreview is unchanged: chrome, theme background, grid, no shadow, zoom and pan, no turn", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await animatedGlb() });
  await handle.ready;
  expect(stage.querySelector(".pf-viewcube-stack")).not.toBeNull();
  expect(stage.querySelector("#viewbar #pf-preview-play")).not.toBeNull();
  expect(stage.querySelector("#viewbar").children.length).toBeGreaterThan(1);
  expect(state.renderer.options.alpha).toBeUndefined();
  expect(controls[0]).toMatchObject({ enableZoom: true, enablePan: true });
  runFrames(0.1);
  const scene = state.renderer.lastScene;
  expect(scene.background).toBeInstanceOf(THREE.Color);
  expect(gridIn(scene).visible).toBe(true);
  expect(shadowIn(scene)).toBeUndefined();
  handle.dispose();

  state.renderer = null;
  const still = mountPreview(makeStage(), { glb: await stillGlb() });
  await still.ready;
  const a0 = azimuth(still);
  runFrames(1);
  expect(azimuth(still)).toBeCloseTo(a0, 6); // no turntable by default
  still.dispose();
});

test("an unknown option value throws rather than showing the default", () => {
  const glb = new Uint8Array(0);
  expect(() => mountPreview(makeStage(), { glb, background: "clear" })).toThrow(TypeError);
  expect(() => mountPreview(makeStage(), { glb, camera: "reset" })).toThrow(TypeError);
  expect(() => mountPreview(makeStage(), { glb, renderMode: "photo" })).toThrow(TypeError);
  expect(() => mountPreview(makeStage(), { glb, turntable: -5 })).toThrow(TypeError);
  expect(() => mountPreview(makeStage(), { glb, chrome: "no" })).toThrow(TypeError);
  for (const fill of [0, -0.5, 1.2, NaN, "0.8", null]) {
    expect(() => mountPreview(makeStage(), { glb, fill })).toThrow(TypeError);
  }
});

test("an unknown option key throws — a stale showcase included", () => {
  const glb = new Uint8Array(0);
  expect(() => mountPreview(makeStage(), { glb, showcase: {} })).toThrow(/unknown option "showcase"/);
  expect(() => mountPreview(makeStage(), { glb, turnTable: 14 })).toThrow(TypeError);
  // The non-presentation keys stay valid.
  const handle = mountPreview(makeStage(), { glb, elements: {}, viewerState: null, animate: false });
  handle.dispose();
});

// --- each option alone ----------------------------------------------------------

test("chrome: false mounts no view cube, view-style control or play button, on the theme background", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await animatedGlb(), chrome: false });
  await handle.ready;
  expect(stage.querySelector("#viewbar").children).toHaveLength(0);
  expect(stage.querySelector(".pf-viewcube-stack")).toBeNull();
  expect(stage.querySelector("#pf-preview-play")).toBeNull();
  expect(stage.querySelectorAll("canvas")).toHaveLength(1); // the viewer's own, no cube canvas
  runFrames(0.1);
  expect(state.renderer.lastScene.background).toBeInstanceOf(THREE.Color);
  expect(handle.animation.state().status).toMatch(/intro|playing/); // the animation still plays
  handle.dispose();
});

test("background: \"transparent\" clears to alpha 0 with no grid, and keeps the chrome", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await stillGlb(), background: "transparent" });
  await handle.ready;
  runFrames(0.1);
  expect(state.renderer.options.alpha).toBe(true);
  expect(state.renderer.getClearAlpha()).toBe(0);
  expect(state.renderer.lastScene.background).toBeNull();
  expect(gridIn(state.renderer.lastScene).visible).toBe(false);
  expect(shadowIn(state.renderer.lastScene)).toBeUndefined();
  expect(stage.querySelector(".pf-viewcube-stack")).not.toBeNull();
  handle.dispose();
});

test("contactShadow: true draws the shadow plane over the theme background and grid", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), contactShadow: true });
  await handle.ready;
  runFrames(0.1);
  const scene = state.renderer.lastScene;
  expect(shadowIn(scene)).toBeDefined();
  expect(scene.background).toBeInstanceOf(THREE.Color);
  expect(gridIn(scene).visible).toBe(true);
  handle.dispose();
});

test("the contact shadow is built once per assembly: a playing animation never rebuilds it", async () => {
  vi.spyOn(performance, "now").mockImplementation(() => clockMs); // no wall-clock throttle can hide a rebuild
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(), contactShadow: true });
  await handle.ready;
  runFrames(0.1);
  const built = state.dataTextures;
  const shadow = shadowIn(state.renderer.lastScene);
  expect(shadow).toBeDefined();
  runFrames(5); // the intro, two full loops of the lid swinging, and then some
  expect(handle.animation.state().status).toBe("playing");
  expect([...viewers.at(-1).__subMesh("lid").matrix.elements]).not.toEqual(IDENTITY);
  expect(state.dataTextures).toBe(built);
  expect(shadowIn(state.renderer.lastScene)).toBe(shadow);
  handle.dispose();
});

test("a turntable never rebuilds the contact shadow", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), contactShadow: true, turntable: 14 });
  await handle.ready;
  runFrames(0.1);
  const built = state.dataTextures;
  const shadow = shadowIn(state.renderer.lastScene);
  const a0 = azimuth(handle);
  runFrames(3);
  expect(azimuth(handle)).not.toBeCloseTo(a0, 3); // it turned
  expect(state.dataTextures).toBe(built);
  expect(shadowIn(state.renderer.lastScene)).toBe(shadow);
  handle.dispose();
});

test("zoom: false and pan: false reach OrbitControls, each on its own", async () => {
  const z = mountPreview(makeStage(), { glb: await stillGlb(), zoom: false });
  await z.ready;
  expect(controls.at(-1)).toMatchObject({ enableZoom: false, enablePan: true, enableRotate: true });
  z.dispose();
  const p = mountPreview(makeStage(), { glb: await stillGlb(), pan: false });
  await p.ready;
  expect(controls.at(-1)).toMatchObject({ enableZoom: true, enablePan: false, enableRotate: true });
  p.dispose();
});

test("turntable turns a still preview, and a view-cube drag stops it for good", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14 });
  await handle.ready;
  expect(handle.getViewerState().camera).toBeTruthy();
  const a0 = azimuth(handle);
  runFrames(1);
  const turned = Math.abs(azimuth(handle) - a0) * (180 / Math.PI);
  expect(turned).toBeGreaterThan(8);  // about 14° over the second just run
  expect(turned).toBeLessThan(20);

  viewers.at(-1).orbitBy(5, 0); // a user grab through the view cube's drag route
  const a1 = azimuth(handle);
  runFrames(1);
  expect(azimuth(handle)).toBeCloseTo(a1, 6);
  runFrames(2);
  expect(azimuth(handle)).toBeCloseTo(a1, 6);
  handle.dispose();
});

test("turntable keeps the chrome, and turns at the rate asked for", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await stillGlb(), turntable: 40 });
  await handle.ready;
  expect(stage.querySelector(".pf-viewcube-stack")).not.toBeNull();
  const a0 = azimuth(handle);
  runFrames(1);
  expect(Math.abs(azimuth(handle) - a0) * (180 / Math.PI)).toBeGreaterThan(30);
  handle.dispose();
});

test("the first canvas drag (OrbitControls' start) stops the turntable for good", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14 });
  await handle.ready;
  const a0 = azimuth(handle);
  runFrames(0.5);
  expect(azimuth(handle)).not.toBeCloseTo(a0, 3); // turning
  controls[0].dispatchEvent({ type: "start" }); // a pointer went down on the canvas
  controls[0].dispatchEvent({ type: "end" });
  const a1 = azimuth(handle);
  runFrames(1);
  expect(azimuth(handle)).toBeCloseTo(a1, 6);
  runFrames(2);
  expect(azimuth(handle)).toBeCloseTo(a1, 6);
  handle.dispose();
});

test("turntable never turns under reduced motion", async () => {
  reducedMotion();
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14 });
  await handle.ready;
  const a0 = azimuth(handle);
  runFrames(2);
  expect(azimuth(handle)).toBeCloseTo(a0, 6);
  handle.dispose();
});

test("a baked animation plays as authored instead of turning", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb((a) => {
    a.anim = { ...a.anim, cues: [] }; // no camera cue, so any camera motion would be a turntable
    return a;
  }), turntable: 14 });
  await handle.ready;
  const a0 = azimuth(handle);
  runFrames(1);
  expect(handle.animation.state().status).toBe("playing");
  expect(azimuth(handle)).toBeCloseTo(a0, 6);
  expect([...viewers.at(-1).__subMesh("lid").matrix.elements]).not.toEqual(IDENTITY);
  handle.dispose();
});

test("turntable turns an animated file mounted with animate: false", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(), animate: false, turntable: 14 });
  await handle.ready;
  const a0 = azimuth(handle);
  runFrames(1);
  expect(handle.animation).toBeNull();
  expect(azimuth(handle)).not.toBeCloseTo(a0, 3);
  handle.dispose();
});

test("dragging an animated model orbits the camera and the animation plays on", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(), chrome: false, turntable: 14 });
  await handle.ready;
  runFrames(0.8); // past the intro tween
  expect(handle.animation.state().status).toBe("playing");
  controls[0].dispatchEvent({ type: "start" });
  controls[0].dispatchEvent({ type: "end" });
  const lid = viewers.at(-1).__subMesh("lid");
  const seen = [];
  for (let i = 0; i < 4; i++) {
    runFrames(0.2);
    seen.push([...lid.matrix.elements].join());
    expect(handle.animation.state().status).toBe("playing");
  }
  expect(new Set(seen).size).toBe(seen.length); // the lid keeps moving
  handle.dispose();
});

test("a play-once animation holds its final pose; with chrome: false there is no replay button", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await animatedGlb(playOnce), chrome: false });
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

test("camera: \"default\" drops the carried camera and projection, opening at the file's own framing", async () => {
  const framing = await defaultFraming();
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), camera: "default", viewerState: CARRIED });
  await handle.ready;
  expectCamera(handle.getViewerState().camera, framing);
  // The carried render mode still applies: only the framing is the file's own.
  expect(viewers.at(-1).setRenderMode).toHaveBeenCalledWith("realistic");
  handle.setViewerState({ camera: { pos: [0, 50, 0], target: [1, 1, 1] }, projection: "orthographic", cutaway: null });
  expectCamera(handle.getViewerState().camera, framing);
  expect(handle.getViewerState().projection).toBe("perspective");
  handle.dispose();
});

test("camera: \"default\" still carries the environment, at mount and through setViewerState", async () => {
  const handle = mountPreview(makeStage(), {
    glb: await stillGlb(), camera: "default", viewerState: { ...CARRIED, renderMode: "cad", environment: "outdoor" },
  });
  await handle.ready;
  expect(handle.environment.get()).toBe("outdoor");
  const other = handle.environment.list().map((e) => e.id).find((id) => id !== "outdoor");
  handle.setViewerState({ camera: { pos: [0, 50, 0], target: [0, 0, 0] }, projection: "perspective", environment: other, cutaway: null });
  expect(handle.environment.get()).toBe(other);
  handle.dispose();
});

test("camera defaults to carrying the state in", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), viewerState: { ...CARRIED, renderMode: "cad" } });
  await handle.ready;
  expect(handle.getViewerState().camera.pos[0]).toBeCloseTo(40, 4);
  handle.dispose();
});

test("renderMode: \"cad\" is the opening mode: it wins over a carried realistic state, and keeps the carried camera", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), renderMode: "cad", viewerState: CARRIED });
  expect(handle.renderMode.get()).toBe("cad"); // before the decode too
  expect(handle.getViewerState().renderMode).toBe("cad");
  await handle.ready;
  expect(handle.renderMode.get()).toBe("cad");
  expect(viewers.at(-1).setRenderMode).not.toHaveBeenCalledWith("realistic");
  expect(handle.getViewerState().camera.pos[0]).toBeCloseTo(40, 4);
  handle.dispose();
});

test("renderMode only opens the mount: a later setViewerState can go realistic, with no snap-back", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), renderMode: "cad" });
  await handle.ready;
  const v = viewers.at(-1);
  // The stubbed realistic switch answers without loading; record the mode it lands on.
  let mode = v.getRenderMode();
  v.setRenderMode.mockImplementation(async (next) => (mode = next));
  v.getRenderMode = () => mode;
  handle.setViewerState({ ...CARRIED, renderMode: "realistic" });
  expect(v.setRenderMode).toHaveBeenLastCalledWith("realistic");
  expect(handle.renderMode.get()).toBe("realistic");
  runFrames(0.5);
  expect(v.setRenderMode).toHaveBeenLastCalledWith("realistic"); // nothing put it back to CAD
  handle.dispose();
});

test("renderMode: \"realistic\" opens realistic over a carried CAD state", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), renderMode: "realistic", viewerState: { ...CARRIED, renderMode: "cad" } });
  expect(handle.renderMode.get()).toBe("realistic");
  await handle.ready;
  expect(viewers.at(-1).setRenderMode).toHaveBeenCalledWith("realistic");
  handle.dispose();
});

// --- fill ------------------------------------------------------------------------
// `fill` frames the posed box's PROJECTION: the larger of (projected width /
// viewport width, projected height / viewport height) equals fill.

// A w x d plate, t thick, as a triangle soup (top and bottom faces are enough
// for the box and the projection).
function plate(name, w, d, t) {
  const quad = (z) => [0, 0, z, w, 0, z, 0, d, z, w, 0, z, w, d, z, 0, d, z];
  return { name, positions: new Float32Array([...quad(0), ...quad(t)]) };
}
const plateGlb = (w, d, t) => encodePreviewGlb({ meshes: [plate("plate", w, d, t)], view: "main" });
const camDistance = (handle) => {
  const { pos, target } = handle.getViewerState().camera;
  return Math.hypot(...pos.map((c, i) => c - target[i]));
};
// The live camera's NDC extent of every visible mesh's posed bounding box.
function projectedExtent(viewer, names) {
  const cam = viewer.camera;
  cam.updateMatrixWorld();
  const box = new THREE.Box3();
  for (const n of names) {
    const mesh = viewer.__subMesh(n);
    mesh.updateWorldMatrix(true, false);
    box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const n = new THREE.Vector3(x, y, z).project(cam);
    x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
  }
  return { x: (x1 - x0) / 2, y: (y1 - y0) / 2 };
}
const filledBy = (e) => Math.max(e.x, e.y);

test("fill unset keeps today's framing distance exactly", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb() });
  await handle.ready;
  expect(camDistance(handle)).toBeCloseTo(24 * 2.6 + 6, 6);
  handle.dispose();
});

test("fill: 0.8 makes the projected box span 0.8 of the limiting axis — a tall part is height-limited", async () => {
  const handle = mountPreview(makeStage(400, 300), { glb: await stillGlb(), fill: 0.8 });
  await handle.ready;
  const e = projectedExtent(viewers.at(-1), ["base", "lid"]);
  expect(e.y).toBeGreaterThan(0.8 * 0.98);
  expect(e.y).toBeLessThan(0.8 * 1.02);
  expect(e.x).toBeLessThan(e.y);
  expect(camDistance(handle)).toBeLessThan((24 * 2.6 + 6) * 0.8); // much closer than today
  handle.dispose();
});

test("a flat, wide part fills by width", async () => {
  const handle = mountPreview(makeStage(300, 400), { glb: await plateGlb(100, 30, 3), fill: 0.8 });
  await handle.ready;
  const e = projectedExtent(viewers.at(-1), ["plate"]);
  expect(e.x).toBeGreaterThan(0.8 * 0.98);
  expect(e.x).toBeLessThan(0.8 * 1.02);
  expect(e.y).toBeLessThan(e.x);
  expect(camDistance(handle)).toBeLessThan((100 * 2.6 + 6) * 0.8); // closer than today
  handle.dispose();
});

test("with a turntable, a long thin part is framed by its swept extent and never clips as it turns", async () => {
  const still = mountPreview(makeStage(), { glb: await plateGlb(100, 6, 3), fill: 0.8 });
  await still.ready;
  const staticDistance = camDistance(still);
  still.dispose();
  state.renderer = null;

  const handle = mountPreview(makeStage(), { glb: await plateGlb(100, 6, 3), fill: 0.8, turntable: 90 });
  await handle.ready;
  expect(camDistance(handle)).toBeGreaterThan(staticDistance * 1.05);
  let widest = 0;
  for (let i = 0; i < 40; i++) { // a full turn at 90°/s, sampled every 0.1 s
    runFrames(0.1);
    widest = Math.max(widest, filledBy(projectedExtent(viewers.at(-1), ["plate"])));
  }
  expect(widest).toBeLessThanOrEqual(0.8 * 1.02);
  expect(widest).toBeGreaterThan(0.8 * 0.9); // and it still fills the card at its widest
  handle.dispose();
});

// A flat round disc (a gear blank): radius r, t thick, as a soup of top and
// bottom fans plus the rim — its box corners sit ~√2 r from the axis, its rim r.
function disc(name, r, t, n = 96) {
  const at = (k, z) => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n), z];
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push(0, 0, 0, ...at(k + 1, 0), ...at(k, 0));
    out.push(0, 0, t, ...at(k, t), ...at(k + 1, t));
    out.push(...at(k, 0), ...at(k + 1, 0), ...at(k + 1, t), ...at(k, 0), ...at(k + 1, t), ...at(k, t));
  }
  return { name, positions: new Float32Array(out) };
}

test("a round part on a turntable is framed by its rim: it spans fill, not fill/√2", async () => {
  const glb = await encodePreviewGlb({ meshes: [disc("gear", 40, 4)], view: "main" });
  const handle = mountPreview(makeStage(400, 300), { glb, fill: 0.8, turntable: 90 });
  await handle.ready;
  // projectedExtent measures the BOX, which overstates a disc; measure the rim itself.
  const rimExtent = () => {
    const v = viewers.at(-1), cam = v.camera, mesh = v.__subMesh("gear");
    cam.updateMatrixWorld();
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute("position");
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).project(cam);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    return Math.max((x1 - x0) / 2, (y1 - y0) / 2);
  };
  let widest = 0;
  for (let i = 0; i < 40; i++) { // a full turn at 90°/s
    runFrames(0.1);
    const e = rimExtent();
    expect(e).toBeGreaterThan(0.8 * 0.98);
    widest = Math.max(widest, e);
  }
  expect(widest).toBeLessThanOrEqual(0.8 * 1.02);
  handle.dispose();
});

// A lopsided part: a dense hub disc at the origin plus one long arm reaching
// +x — its box centre sits far out along the arm, its vertex centroid on the hub.
function armPlate(name, len, wid, t) {
  const quad = (z) => [0, -wid / 2, z, len, -wid / 2, z, 0, wid / 2, z, len, -wid / 2, z, len, wid / 2, z, 0, wid / 2, z];
  return { name, positions: new Float32Array([...quad(0), ...quad(t)]) };
}
// Every posed vertex of the named meshes, projected through the live camera.
function projectedVertices(viewer, names) {
  const cam = viewer.camera;
  cam.updateMatrixWorld();
  const out = [];
  const p = new THREE.Vector3();
  for (const n of names) {
    const mesh = viewer.__subMesh(n);
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).project(cam);
      out.push([p.x, p.y]);
    }
  }
  return out;
}

test("a lopsided part on a turntable turns about its hub, which stays at the screen centre, and never exceeds fill", async () => {
  const glb = await encodePreviewGlb({ meshes: [disc("hub", 6, 4), armPlate("arm", 60, 6, 4)], view: "main" });
  const handle = mountPreview(makeStage(400, 300), { glb, fill: 0.8, turntable: 90 });
  await handle.ready;
  const v = viewers.at(-1);
  const hub = () => {
    const mesh = v.__subMesh("hub");
    mesh.updateWorldMatrix(true, false);
    v.camera.updateMatrixWorld();
    return new THREE.Vector3(0, 0, 2).applyMatrix4(mesh.matrixWorld).project(v.camera);
  };
  for (let i = 0; i < 40; i++) { // a full turn at 90°/s
    runFrames(0.1);
    const h = hub();
    expect(Math.abs(h.x)).toBeLessThan(0.03);
    expect(Math.abs(h.y)).toBeLessThan(0.03);
    const pts = projectedVertices(v, ["hub", "arm"]);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const spanHalf = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
    expect(spanHalf).toBeLessThanOrEqual(0.8 * 1.02);
    for (const [x, y] of pts) { expect(Math.abs(x)).toBeLessThanOrEqual(1); expect(Math.abs(y)).toBeLessThanOrEqual(1); }
  }
  handle.dispose();
});

test("unset fill still centres a lopsided part on its box, as before", async () => {
  const glb = await encodePreviewGlb({ meshes: [disc("hub", 6, 4), armPlate("arm", 60, 6, 4)], view: "main" });
  const handle = mountPreview(makeStage(400, 300), { glb });
  await handle.ready;
  const v = viewers.at(-1);
  const box = new THREE.Box3();
  for (const n of ["hub", "arm"]) {
    const mesh = v.__subMesh(n);
    mesh.updateWorldMatrix(true, false);
    box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  }
  box.getCenter(new THREE.Vector3()).toArray().forEach((c) => expect(c).toBeCloseTo(0, 6));
  handle.dispose();
});

test("fill keeps the view direction and the origin target, and the viewer's reframe uses it too", async () => {
  const plain = mountPreview(makeStage(), { glb: await stillGlb() });
  await plain.ready;
  const p = plain.getViewerState().camera;
  plain.dispose();
  state.renderer = null;

  const handle = mountPreview(makeStage(), { glb: await stillGlb(), fill: 0.8 });
  await handle.ready;
  const c = handle.getViewerState().camera;
  const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
  unit(c.pos).forEach((x, i) => expect(x).toBeCloseTo(unit(p.pos)[i], 6));
  c.target.forEach((x) => expect(x).toBeCloseTo(0, 6));
  const filled = camDistance(handle);
  viewers.at(-1).setCameraState({ pos: [200, 10, 0], target: [0, 0, 0] });
  viewers.at(-1).setCameraState({ pos: c.pos, target: [0, 0, 0] });
  viewers.at(-1).frame(); // the reframe button's call
  expect(camDistance(handle)).toBeCloseTo(filled, 6);
  handle.dispose();
});

test("fill on a stage with no size yet falls back to today's distance", async () => {
  const handle = mountPreview(makeStage(0, 0), { glb: await stillGlb(), fill: 0.8 });
  await handle.ready;
  expect(camDistance(handle)).toBeCloseTo(24 * 2.6 + 6, 6);
  handle.dispose();
});

test("fill under orthographic sizes the frustum to the projected box", () => {
  const part = { ...viewerPart(), parts: { base: { label: "base", views: ["main"] }, lid: { label: "lid", views: ["main"] } } };
  const v = createViewer(makeStage(400, 300), part, { frameFill: 0.5 });
  for (const m of [box("base"), box("lid", 24)]) v.setSubGeometry(m.name, m);
  v.showAssembly(["base", "lid"], { frame: true });
  v.setProjection("orthographic");
  v.frame();
  expect(v.camera.isOrthographicCamera).toBe(true);
  const e = projectedExtent(v, ["base", "lid"]);
  expect(filledBy(e)).toBeCloseTo(0.5, 3);
  v.dispose();
});

// --- the landing card: every option at once ----------------------------------------

test("the landing card: chrome-less, transparent, shadowed, orbit-only, turning, default framing, CAD", async () => {
  const framing = await defaultFraming({ fill: LANDING_CARD.fill, turntable: LANDING_CARD.turntable }); // the file's own framing, filled and swept (no frames run, so it has not turned)
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await stillGlb(), ...LANDING_CARD, viewerState: CARRIED });
  await handle.ready;
  expect(stage.querySelector("#viewbar").children).toHaveLength(0);
  expect(stage.querySelector(".pf-viewcube-stack")).toBeNull();
  expect(controls.at(-1)).toMatchObject({ enableZoom: false, enablePan: false, enableRotate: true });
  expectCamera(handle.getViewerState().camera, framing);
  expect(handle.renderMode.get()).toBe("cad");
  let drawn = false;
  handle.drawn.then(() => { drawn = true; });
  runFrames(0.1);
  await handle.drawn;
  expect(drawn).toBe(true);
  const scene = state.renderer.lastScene;
  expect(state.renderer.getClearAlpha()).toBe(0);
  expect(scene.background).toBeNull();
  expect(gridIn(scene).visible).toBe(false);
  expect(shadowIn(scene)).toBeDefined();
  const a0 = azimuth(handle);
  runFrames(1);
  expect(azimuth(handle)).not.toBeCloseTo(a0, 3);
  controls.at(-1).dispatchEvent({ type: "start" });
  const a1 = azimuth(handle);
  runFrames(1);
  expect(azimuth(handle)).toBeCloseTo(a1, 6);
  handle.dispose();
});

test("the landing card plays a baked animation instead of turning, with no play button", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await animatedGlb(), ...LANDING_CARD });
  await handle.ready;
  runFrames(1.5);
  expect(handle.animation.state().status).toBe("playing");
  expect([...viewers.at(-1).__subMesh("lid").matrix.elements]).not.toEqual(IDENTITY);
  expect(stage.querySelector("#pf-preview-play")).toBeNull();
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
  const handle = mountPreview(makeStage(), { glb: new Uint8Array([1, 2, 3]), ...LANDING_CARD });
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

test("the live contact shadow ignores poses and follows a new assembly", () => {
  const part = { ...viewerPart(), parts: {
    base: { label: "base", views: ["main"] }, lid: { label: "lid", views: ["main"] },
  } };
  const v = createViewer(makeStage(), part, { contactShadow: true });
  for (const m of [box("base"), box("lid", 24)]) v.setSubGeometry(m.name, m);
  v.showAssembly(["base", "lid"], { frame: true });
  const shadowY = () => state.renderer.lastScene.children.find((c) => c.isMesh && c.material?.alphaMap).position.y;
  runFrames(0.1);
  const floor = shadowY();
  const built = state.dataTextures;

  v.setSubPose("lid", T(-40)); // the lid dips below the base
  runFrames(1);
  expect(state.dataTextures).toBe(built); // a pose is not a rebuild
  expect(shadowY()).toBeCloseTo(floor, 6);

  v.showAssembly(["base", "lid"]); // a new assembly is: the shadow comes from the pose on screen
  runFrames(0.1);
  expect(state.dataTextures).toBe(built + 1);
  expect(shadowY()).toBeLessThan(floor - 10);
  v.dispose();
});
