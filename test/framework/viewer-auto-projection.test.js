// @vitest-environment happy-dom
// Automatic projection (Fusion 360's "Perspective with Ortho Faces", Blender's
// "Auto Perspective"): a view cube FACE click settles into orthographic, an
// edge/corner click is perspective, and in a face view pan and zoom keep ortho
// while the first rotation returns to perspective. The live viewer, driven
// through its real render loop and real OrbitControls — the rule is a property
// of the tween, the per-frame direction check and setProjection together.
//
// Same faked-WebGLRenderer harness as viewer-cue-angle.test.js.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as THREE from "three";

const state = vi.hoisted(() => ({ renderer: null, cutaway: null, controls: null }));

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
    getPixelRatio() { return this.pixelRatio ?? 1; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

// The cutaway needs a GL context for its gizmo. Faking it also hands this suite
// the live OrbitControls instance, which the viewer otherwise keeps private —
// createCutaway is the one call it is passed to.
vi.mock("../../src/framework/cutaway.js", () => ({
  createCutaway: vi.fn((options) => {
    state.controls = options.orbitControls;
    return state.cutaway;
  }),
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
    setCamera: vi.fn(),
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

// A 10mm triangle in the XY plane: a real bounding box for frameTo to frame.
const triangle = (mm = 10) => ({
  positions: new Float32Array([0, 0, 0, mm, 0, 0, 0, mm, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
});

function makeViewer() {
  const viewer = createViewer(createContainer(), { meta: {}, parts: { body: {} } });
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"], { frame: true });
  return viewer;
}

// Drive the real render loop. The tween advances only from inside it, and the
// camera's own basis (quaternion) is only refreshed by the controls.update()
// of the frame AFTER the tween writes its last position — so "settle" means a
// few frames past the end, exactly as a real settle does.
let clock = 0;
function runFrames(count = 80, step = 16) {
  for (let i = 0; i < count; i++) {
    clock += step;
    state.renderer.animationLoop(clock);
  }
}

// Angle, in degrees, between the direction the camera looks FROM and an axis.
function offAxisDeg(viewer, axis) {
  const { pos, target } = viewer.getCameraState();
  const dir = new THREE.Vector3().fromArray(pos).sub(new THREE.Vector3().fromArray(target)).normalize();
  const want = new THREE.Vector3().fromArray(axis).normalize();
  return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(dir.dot(want), -1, 1)));
}

beforeEach(() => {
  clock = 0;
  state.renderer = null;
  state.controls = null;
  state.cutaway = createFakeCutaway();
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

const HALF_FOV_TAN = Math.tan((45 * Math.PI) / 360);
const distanceOf = (viewer) => {
  const { pos, target } = viewer.getCameraState();
  return Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
};
// What the view cube's face click (canvas or keyboard button) passes.
const CUBE = { duration: 0.6, refit: true, autoProjection: true };

function orthoFrontViewer() {
  const viewer = makeViewer();
  viewer.tweenCameraTo("front", CUBE);
  runFrames();
  expect(viewer.getProjection()).toBe("orthographic");
  return viewer;
}

test("a face click settles into orthographic at the END of the tween, with no size jump", () => {
  const viewer = makeViewer();
  const seen = [];
  viewer.onProjectionChange((mode) => seen.push(mode));

  viewer.tweenCameraTo("front", CUBE);
  runFrames(10); // 160ms into a 600ms tween
  expect(viewer.getProjection()).toBe("perspective");

  runFrames();
  expect(seen).toEqual(["orthographic"]);
  expect(viewer.camera.isOrthographicCamera).toBe(true);
  expect(offAxisDeg(viewer, [0, 0, 1])).toBeLessThan(0.01);
  // The frustum is the perspective half-height at the pose's framing distance,
  // at zoom 1 — the size-preserving identity setProjection establishes.
  expect(viewer.camera.zoom).toBe(1);
  expect(viewer.camera.top).toBeCloseTo(distanceOf(viewer) * HALF_FOV_TAN, 6);
  viewer.dispose();
});

test.each(["back", "left", "right", "top", "bottom"])("the %s face settles ortho too, and stays there", (face) => {
  const viewer = makeViewer();
  viewer.tweenCameraTo(face, CUBE);
  runFrames(200); // long past the tween: top/bottom sit 1e-6 rad off the pole (makeSafe)
  expect(viewer.getProjection()).toBe("orthographic");
  viewer.dispose();
});

test.each(["top-front", "bottom-left", "top-front-right", "iso"])(
  "a %s click from a face view returns to perspective at the START, same size",
  (view) => {
    const viewer = orthoFrontViewer();
    viewer.camera.zoom = 2; // the user dollied in
    viewer.camera.updateProjectionMatrix();
    const halfOnScreen = viewer.camera.top / viewer.camera.zoom;

    viewer.tweenCameraTo(view, CUBE);

    // Immediately, before any frame: the swap happens with the part still seen
    // head-on, and recovers the dolly as distance (the same apparent size).
    expect(viewer.getProjection()).toBe("perspective");
    expect(distanceOf(viewer) * HALF_FOV_TAN).toBeCloseTo(halfOnScreen, 6);
    runFrames();
    expect(viewer.getProjection()).toBe("perspective");
    viewer.dispose();
  },
);

test("face to face while ortho stays ortho the whole way", () => {
  const viewer = orthoFrontViewer();
  const seen = [];
  viewer.onProjectionChange((mode) => seen.push(mode));
  viewer.tweenCameraTo("right", CUBE);
  runFrames();
  expect(seen).toEqual([]);
  expect(viewer.getProjection()).toBe("orthographic");
  expect(offAxisDeg(viewer, [1, 0, 0])).toBeLessThan(0.01);
  viewer.dispose();
});

test("zoom and pan keep a face view orthographic", () => {
  const viewer = orthoFrontViewer();
  // Zoom: OrbitControls dollies an ortho camera by camera.zoom.
  viewer.camera.zoom = 3;
  viewer.camera.updateProjectionMatrix();
  runFrames(5);
  expect(viewer.getProjection()).toBe("orthographic");
  // Pan: the camera and its target move together.
  const shift = new THREE.Vector3(7, -3, 0);
  state.controls.target.add(shift);
  viewer.camera.position.add(shift);
  runFrames(5);
  expect(viewer.getProjection()).toBe("orthographic");
  expect(viewer.camera.zoom).toBe(3);
  viewer.dispose();
});

test("a canvas rotation leaves ortho for perspective, preserving apparent size", () => {
  const viewer = orthoFrontViewer();
  viewer.camera.zoom = 2;
  viewer.camera.updateProjectionMatrix();
  const halfH = viewer.camera.top / viewer.camera.zoom; // what is on screen

  // A drag as OrbitControls records it: a pending azimuth change it applies,
  // damped, over the next update()s. 0.05 rad is ~2.9°, well past the
  // half-degree epsilon.
  const seenOffAxis = [];
  viewer.onProjectionChange(() => seenOffAxis.push(offAxisDeg(viewer, [0, 0, 1])));
  state.controls._sphericalDelta.theta = 0.05;
  runFrames(30);

  expect(viewer.getProjection()).toBe("perspective");
  expect(viewer.camera.isPerspectiveCamera).toBe(true);
  // The perspective half-height at the new distance matches the ortho frame.
  expect(distanceOf(viewer) * HALF_FOV_TAN).toBeCloseTo(halfH, 6);
  // …and it swapped the first frame past the epsilon, not late.
  expect(seenOffAxis).toHaveLength(1);
  expect(seenOffAxis[0]).toBeGreaterThan(0.5);
  expect(seenOffAxis[0]).toBeLessThan(1);
  viewer.dispose();
});

test("the cube's drag (orbitBy) leaves ortho the same way", () => {
  const viewer = orthoFrontViewer();
  viewer.orbitBy(25, 0);
  runFrames(1);
  expect(viewer.getProjection()).toBe("perspective");
  viewer.dispose();
});

test("a rotation inside the epsilon does not leave ortho", () => {
  const viewer = orthoFrontViewer();
  state.controls._sphericalDelta.theta = 0.001; // ~0.06° all told, once damping spends it
  runFrames(200);
  expect(viewer.getProjection()).toBe("orthographic");
  viewer.dispose();
});

test("an animation cue (no autoProjection) never switches INTO ortho", () => {
  const viewer = makeViewer();
  viewer.tweenCameraTo("front", { duration: 0.6 });
  runFrames();
  expect(viewer.getProjection()).toBe("perspective");
  expect(offAxisDeg(viewer, [0, 0, 1])).toBeLessThan(0.01);
  viewer.dispose();
});

test("an animation cue onto another face keeps an ortho face view (and re-arms on it)", () => {
  const viewer = orthoFrontViewer();
  viewer.camera.zoom = 2;
  viewer.camera.updateProjectionMatrix();
  viewer.tweenCameraTo("top", { duration: 0.6 });
  runFrames();
  expect(viewer.getProjection()).toBe("orthographic");
  expect(viewer.camera.zoom).toBe(2); // a cue never refits
  // Armed on TOP now: a pan there keeps it, a rotation off it leaves.
  state.controls._sphericalDelta.phi = 0.05;
  runFrames(30);
  expect(viewer.getProjection()).toBe("perspective");
  viewer.dispose();
});

test("an animation cue off every face leaves ortho at its start", () => {
  const viewer = orthoFrontViewer();
  viewer.tweenCameraTo("iso", { duration: 0.6 });
  expect(viewer.getProjection()).toBe("perspective");
  viewer.dispose();
});

test("a host's setProjection('orthographic') is left by the first rotation, like a face view", () => {
  const viewer = makeViewer(); // the default iso-ish camera: not a face view
  viewer.setProjection("orthographic");
  runFrames(5);
  expect(viewer.getProjection()).toBe("orthographic"); // a still camera keeps it
  viewer.orbitBy(0, 25);
  runFrames(1);
  expect(viewer.getProjection()).toBe("perspective");
  viewer.dispose();
});

test("setCameraState re-arms ortho on a face-view pose, and restores perspective on any other", () => {
  const viewer = makeViewer();
  viewer.setProjection("orthographic");
  viewer.setCameraState({ pos: [0, 40, 0], target: [0, 0, 0] }); // top: a placement, not a rotation
  runFrames(5);
  expect(viewer.getProjection()).toBe("orthographic");
  // …and it is armed on that pose: rotating off it leaves.
  state.controls._sphericalDelta.phi = 0.05;
  runFrames(30);
  expect(viewer.getProjection()).toBe("perspective");

  viewer.setProjection("orthographic");
  viewer.setCameraState({ pos: [30, 20, 30], target: [0, 0, 0] }); // free orbit
  expect(viewer.getProjection()).toBe("perspective");
  // From a frustum synced to the pose's distance: the pose is kept exactly.
  expect(distanceOf(viewer)).toBeCloseTo(Math.hypot(30, 20, 30), 6);
  viewer.dispose();
});

test("a user grab mid face-to-face tween, under ortho, returns to perspective", () => {
  const viewer = orthoFrontViewer();
  viewer.tweenCameraTo("right", CUBE);
  runFrames(15); // part-way round: off both axes
  viewer.cancelCameraTween();
  runFrames(1);
  expect(viewer.getProjection()).toBe("perspective");
  viewer.dispose();
});

// partforge-cloud remounts on every edit, carrying getViewerState().camera. An
// ortho zoom never moves the camera, so the carried pose has to express it as
// distance, or the face view comes back at the unzoomed size.
test("a zoomed ortho face view survives a remount at the same apparent size", () => {
  const viewer = orthoFrontViewer();
  viewer.camera.zoom = 3;
  viewer.camera.updateProjectionMatrix();
  const onScreen = viewer.camera.top / viewer.camera.zoom;
  const carried = viewer.getCameraState();
  viewer.dispose();

  // What mount does with a carried face-view state: ortho first, then the pose.
  const next = makeViewer();
  next.setProjection("orthographic");
  next.setCameraState(carried);
  runFrames(5);

  expect(next.getProjection()).toBe("orthographic");
  expect(next.camera.top / next.camera.zoom).toBeCloseTo(onScreen, 6);
  expect(offAxisDeg(next, [0, 0, 1])).toBeLessThan(0.01);
  next.dispose();
});

test("getCameraState is the live pose in perspective, and keeps the view direction in ortho", () => {
  const viewer = orthoFrontViewer();
  viewer.camera.zoom = 2;
  viewer.camera.updateProjectionMatrix();
  const { pos, target } = viewer.getCameraState();
  const dir = new THREE.Vector3().fromArray(pos).sub(new THREE.Vector3().fromArray(target)).normalize();
  expect(dir.z).toBeCloseTo(1, 9);
  // Twice the zoom, half the distance — the conversion setProjection uses.
  expect(distanceOf(viewer) * HALF_FOV_TAN).toBeCloseTo(viewer.camera.top / 2, 6);
  viewer.dispose();
});

test("reframing after a pan keeps an ortho face view (the view direction, not the origin's)", () => {
  const viewer = orthoFrontViewer();
  const shift = new THREE.Vector3(9, 4, 0);
  state.controls.target.add(shift);
  viewer.camera.position.add(shift);
  runFrames(2);
  viewer.frame();
  runFrames(5);
  expect(viewer.getProjection()).toBe("orthographic");
  expect(offAxisDeg(viewer, [0, 0, 1])).toBeLessThan(0.01);
  viewer.dispose();
});
