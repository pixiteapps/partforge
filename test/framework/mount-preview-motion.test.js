// @vitest-environment happy-dom
// mountPreview's motion control (0.169.0): `autostart: false` holds the
// animation and the turntable at their first frame until `handle.motion.start()`,
// `handle.motion.restart()` puts the model back as it opened and starts again,
// and framing no longer depends on reduced motion. The real viewer on a fake
// WebGLRenderer (the mount-preview-options.test.js harness).
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

import { mountPreview } from "../../src/framework/mount-preview.js";
import { encodePreviewGlb } from "../../src/framework/gltf/encode-preview.js";
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

const camera = (handle) => handle.getViewerState().camera;
const expectCamera = (got, want) => {
  got.pos.forEach((v, i) => expect(v).toBeCloseTo(want.pos[i], 4));
  got.target.forEach((v, i) => expect(v).toBeCloseTo(want.target[i], 4));
};
const lidMatrix = () => [...viewers.at(-1).__subMesh("lid").matrix.elements];
const camDistance = (handle) => {
  const { pos, target } = camera(handle);
  return Math.hypot(...pos.map((c, i) => c - target[i]));
};
// A long thin plate: its swept framing is clearly farther than its box framing.
function plate(name, w, d, t) {
  const q = (z) => [0, 0, z, w, 0, z, 0, d, z, w, 0, z, w, d, z, 0, d, z];
  return { name, positions: new Float32Array([...q(0), ...q(t)]) };
}
const plateGlb = () => encodePreviewGlb({ meshes: [plate("plate", 100, 6, 3)], view: "main" });

// --- validation and lifecycle --------------------------------------------------

test("autostart must be a boolean", () => {
  const glb = new Uint8Array(0);
  for (const autostart of ["no", 0, 1, null, {}]) {
    expect(() => mountPreview(makeStage(), { glb, autostart })).toThrow(/autostart must be a boolean/);
  }
  mountPreview(makeStage(), { glb, autostart: false }).dispose(); // a known key
});

test("motion is null before ready, present for every file, and null once disposed", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb() });
  expect(handle.motion).toBeNull();
  await handle.ready;
  expect(handle.motion.state).toBe("stopped"); // a still file with no turntable: nothing to move
  expect(() => { handle.motion.start(); handle.motion.restart(); }).not.toThrow();
  handle.dispose();
  expect(handle.motion).toBeNull();
});

test("autostart defaults to true: the animation and the turntable start as before", async () => {
  const anim = mountPreview(makeStage(), { glb: await animatedGlb() });
  await anim.ready;
  expect(anim.motion.state).toBe("playing");
  runFrames(1.5);
  expect(lidMatrix()).not.toEqual(IDENTITY);
  anim.dispose();
  state.renderer = null;

  const turning = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14 });
  await turning.ready;
  expect(turning.motion.state).toBe("playing");
  const a0 = azimuth(turning);
  runFrames(1);
  expect(azimuth(turning)).not.toBeCloseTo(a0, 3);
  turning.dispose();
});

// --- autostart: false ----------------------------------------------------------

test("autostart: false holds the animation at its first pose and camera, frame after frame, until start()", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(), autostart: false, chrome: false });
  let drawn = false;
  handle.drawn.then(() => { drawn = true; });
  await handle.ready;
  expect(handle.motion.state).toBe("waiting");
  expect(handle.animation.state().status).toBe("idle");
  const cam0 = camera(handle);
  runFrames(0);
  await handle.drawn;
  expect(drawn).toBe(true);
  expect(lidMatrix()).toEqual(IDENTITY); // the t = 0 pose
  for (let i = 0; i < 5; i++) {
    runFrames(0.5);
    expect(lidMatrix()).toEqual(IDENTITY);
    expectCamera(camera(handle), cam0); // no intro cue tween either
    expect(handle.motion.state).toBe("waiting");
  }
  handle.motion.start();
  expect(handle.motion.state).toBe("playing");
  runFrames(1.5); // past the 0.6 s intro tween, into the swing
  expect(lidMatrix()).not.toEqual(IDENTITY);
  handle.dispose();
});

test("autostart: false holds the turntable at angle 0 until start(); start() is idempotent", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14, autostart: false });
  await handle.ready;
  expect(handle.motion.state).toBe("waiting");
  const a0 = azimuth(handle);
  for (let i = 0; i < 5; i++) {
    runFrames(0.5);
    expect(azimuth(handle)).toBeCloseTo(a0, 6);
  }
  handle.motion.start();
  handle.motion.start();
  handle.motion.start();
  expect(handle.motion.state).toBe("playing");
  const a1 = azimuth(handle);
  runFrames(1);
  const turned = Math.abs(azimuth(handle) - a1) * (180 / Math.PI);
  expect(turned).toBeGreaterThan(8); // about 14° over the second: one turntable, not three
  expect(turned).toBeLessThan(20);
  handle.dispose();
});

test("onChange reports each state change and unsubscribes", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14, autostart: false });
  await handle.ready;
  const seen = [];
  const off = handle.motion.onChange((s) => seen.push(s));
  handle.motion.start();
  controls[0].dispatchEvent({ type: "start" });
  controls[0].dispatchEvent({ type: "end" });
  expect(seen).toEqual(["playing", "stopped"]);
  off();
  handle.motion.restart();
  expect(seen).toEqual(["playing", "stopped"]);
  handle.dispose();
});

// --- restart -------------------------------------------------------------------

test("restart() after a drag stopped the turntable restores the opening camera and turns again", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14, fill: 0.8, camera: "default" });
  await handle.ready;
  const opening = camera(handle);
  runFrames(1);
  controls[0].dispatchEvent({ type: "start" }); // a pointer went down on the canvas
  controls[0].dispatchEvent({ type: "end" });
  viewers.at(-1).orbitBy(60, 20);
  expect(handle.motion.state).toBe("stopped");
  const parked = azimuth(handle);
  runFrames(1);
  expect(azimuth(handle)).toBeCloseTo(parked, 6);

  handle.motion.restart();
  expectCamera(camera(handle), opening);
  expect(handle.motion.state).toBe("playing");
  runFrames(1);
  const turned = Math.abs(azimuth(handle) - Math.atan2(opening.pos[0], opening.pos[2])) * (180 / Math.PI);
  expect(turned).toBeGreaterThan(8);
  // The first grab stops it again.
  viewers.at(-1).orbitBy(5, 0);
  expect(handle.motion.state).toBe("stopped");
  handle.dispose();
});

test("restart() on a waiting turntable starts it from the opening camera", async () => {
  const handle = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14, autostart: false });
  await handle.ready;
  const opening = camera(handle);
  viewers.at(-1).orbitBy(40, 0); // the visitor drags before the host says go
  handle.motion.restart();
  expectCamera(camera(handle), opening);
  expect(handle.motion.state).toBe("playing");
  const a0 = azimuth(handle);
  runFrames(1);
  expect(azimuth(handle)).not.toBeCloseTo(a0, 3);
  handle.dispose();
});

test("restart() after a play-once animation finished replays from t = 0 and the opening camera", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(playOnce), chrome: false });
  await handle.ready;
  const opening = camera(handle);
  runFrames(4);
  expect(handle.motion.state).toBe("finished");
  expect(lidMatrix()).not.toEqual(IDENTITY); // resting open
  viewers.at(-1).orbitBy(50, 10);

  handle.motion.restart();
  expect(lidMatrix()).toEqual(IDENTITY); // back at the first pose at once
  expectCamera(camera(handle), opening);
  expect(handle.motion.state).toBe("playing");
  expect(handle.animation.state().status).toBe("intro"); // the intro cue re-armed
  runFrames(1.5);
  expect(lidMatrix()).not.toEqual(IDENTITY);
  runFrames(3);
  expect(handle.motion.state).toBe("finished");
  handle.dispose();
});

test("restart() mid-loop replays from t = 0", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(), chrome: false });
  await handle.ready;
  runFrames(1.2);
  expect(lidMatrix()).not.toEqual(IDENTITY);
  handle.motion.restart();
  expect(lidMatrix()).toEqual(IDENTITY);
  expect(handle.animation.state().t).toBe(0);
  handle.dispose();
});

test("restart() on a waiting animation starts it", async () => {
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(), autostart: false, chrome: false });
  await handle.ready;
  handle.motion.restart();
  expect(handle.motion.state).toBe("playing");
  runFrames(1.5);
  expect(lidMatrix()).not.toEqual(IDENTITY);
  handle.motion.start(); // a no-op now
  expect(handle.motion.state).toBe("playing");
  handle.dispose();
});

// --- reduced motion ------------------------------------------------------------

test("reduced motion: start() and restart() move nothing; restart() still resets the camera", async () => {
  reducedMotion();
  const handle = mountPreview(makeStage(), { glb: await animatedGlb(), autostart: false });
  await handle.ready;
  expect(handle.motion.state).toBe("stopped");
  const opening = camera(handle);
  handle.motion.start();
  runFrames(2);
  expect(lidMatrix()).toEqual(IDENTITY);
  expectCamera(camera(handle), opening);
  viewers.at(-1).orbitBy(40, 10);
  handle.motion.restart();
  expectCamera(camera(handle), opening);
  runFrames(2);
  expect(lidMatrix()).toEqual(IDENTITY);
  expectCamera(camera(handle), opening);
  expect(handle.motion.state).toBe("stopped");
  handle.dispose();
  state.renderer = null;

  const turning = mountPreview(makeStage(), { glb: await stillGlb(), turntable: 14 });
  await turning.ready;
  const a0 = azimuth(turning);
  turning.motion.start();
  turning.motion.restart();
  runFrames(2);
  expect(azimuth(turning)).toBeCloseTo(a0, 6);
  expect(turning.motion.state).toBe("stopped");
  turning.dispose();
});

test("framing does not depend on reduced motion: a turntable mount is framed swept either way", async () => {
  const on = mountPreview(makeStage(), { glb: await plateGlb(), fill: 0.8, turntable: 14 });
  await on.ready;
  const swept = camDistance(on);
  on.dispose();
  state.renderer = null;
  const still = mountPreview(makeStage(), { glb: await plateGlb(), fill: 0.8 });
  await still.ready;
  const boxed = camDistance(still);
  still.dispose();
  state.renderer = null;
  expect(swept).toBeGreaterThan(boxed * 1.05); // the fixture tells the two apart

  reducedMotion();
  const off = mountPreview(makeStage(), { glb: await plateGlb(), fill: 0.8, turntable: 14 });
  await off.ready;
  expect(camDistance(off)).toBeCloseTo(swept, 6);
  off.dispose();
});

test("a waiting animation's play button reads Play and starts it", async () => {
  const stage = makeStage();
  const handle = mountPreview(stage, { glb: await animatedGlb(), autostart: false });
  await handle.ready;
  const button = stage.querySelector("#pf-preview-play");
  expect(button.getAttribute("aria-label")).toBe("Play animation");
  button.click();
  expect(handle.motion.state).toBe("playing");
  expect(button.getAttribute("aria-label")).toBe("Pause animation");
  handle.dispose();
});
