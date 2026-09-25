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
  runFrames(1);
  // The triangle lies in the floor plane, so the front view sees it edge-on:
  // no surface under the screen centre, and the size is matched at the front
  // of the part — its front edge, world (-5, 0, 5) to (5, 0, 5).
  const edgeWidth = () => {
    viewer.camera.updateMatrixWorld();
    const a = new THREE.Vector3(-5, 0, 5).project(viewer.camera);
    const b = new THREE.Vector3(5, 0, 5).project(viewer.camera);
    return Math.abs(b.x - a.x);
  };
  const inOrtho = edgeWidth();

  // A drag as OrbitControls records it: a pending azimuth change it applies,
  // damped, over the next update()s. 0.05 rad is ~2.9°, well past the
  // half-degree epsilon.
  const seenOffAxis = [];
  let atSwap = null;
  viewer.onProjectionChange(() => {
    seenOffAxis.push(offAxisDeg(viewer, [0, 0, 1]));
    atSwap = edgeWidth();
  });
  state.controls._sphericalDelta.theta = 0.05;
  runFrames(30);

  expect(viewer.getProjection()).toBe("perspective");
  expect(viewer.camera.isPerspectiveCamera).toBe(true);
  // The front edge is the same width in the first perspective frame, to within
  // what the <1° the view has already turned does to it (0.3% here; matching
  // at the target's depth instead, as this used to, is 45% out).
  expect(atSwap / inOrtho).toBeCloseTo(1, 2);
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

// The user report behind this: "zoom out, switch to a face view that turns on
// orthographic, zoom in and then rotate — the part jumps because the zooms
// mismatch." A projection swap can only preserve size at ONE depth. It used to
// be the orbit target's (the part's centre), but what a face view shows is the
// part's FRONT surface, which sits nearer the camera than the centre — so the
// swap back to perspective magnified it by distance / (distance - depth), and
// the recovered distance shrinks as the ortho zoom grows, which is why zooming
// in made it worse. The match is made at the surface under the screen centre.
//
// Two parallel plates 10mm apart, facing world +Z (the front view): the front
// one is what the user is looking at, 5mm in front of the target.
const plates = () => {
  // Model coordinates (the pivot maps model (x, y, z) to world (x, z, -y)), so
  // model y = -5 is world z = +5. Wound to face model -y, i.e. the camera.
  const plate = (y, s) => [-10, y, -10 * s, 10, y, -10 * s, 0, y, 10 * s];
  return {
    positions: new Float32Array([...plate(-5, 1), ...plate(5, -1)]),
    normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    triangles: 2,
  };
};

// Screen height (NDC) of a vertical segment ON the front plate.
const frontPlateNdcHeight = (viewer) => {
  viewer.camera.updateMatrixWorld();
  const a = new THREE.Vector3(0, -4, 5).project(viewer.camera);
  const b = new THREE.Vector3(0, 4, 5).project(viewer.camera);
  return Math.abs(b.y - a.y);
};

test("zoom out, face view, ortho zoom in, rotate: the surface on screen keeps its size", () => {
  const viewer = createViewer(createContainer(), { meta: {}, parts: { body: {} } });
  viewer.setSubGeometry("body", plates());
  viewer.showAssembly(["body"], { frame: true });
  runFrames(5);

  // Zoom a long way out in perspective (a dolly moves the camera).
  const { pos, target } = viewer.getCameraState();
  viewer.setCameraState({ pos: pos.map((v, i) => target[i] + (v - target[i]) * 12), target });
  runFrames(5);

  // A face pick settles into orthographic.
  viewer.tweenCameraTo("front", CUBE);
  runFrames();
  expect(viewer.getProjection()).toBe("orthographic");

  // Zoom in, orthographically.
  viewer.camera.zoom = 2.5;
  viewer.camera.updateProjectionMatrix();
  runFrames(5);
  const lastOrtho = frontPlateNdcHeight(viewer);

  // Rotate: the first frame off the axis swaps to perspective. Measure in that
  // frame, from inside the swap.
  let firstPersp = null;
  viewer.onProjectionChange((mode) => { if (mode === "perspective") firstPersp = frontPlateNdcHeight(viewer); });
  state.controls._sphericalDelta.theta = 0.05;
  runFrames(30);

  expect(viewer.getProjection()).toBe("perspective");
  expect(firstPersp).not.toBeNull();
  expect(firstPersp / lastOrtho).toBeCloseTo(1, 3);
  viewer.dispose();
});

test("entering ortho keeps the surface under the screen centre the same size too", () => {
  const viewer = createViewer(createContainer(), { meta: {}, parts: { body: {} } });
  viewer.setSubGeometry("body", plates());
  viewer.showAssembly(["body"], { frame: true });
  viewer.setCameraState({ pos: [0, 0, 40], target: [0, 0, 0] }); // head-on, perspective
  runFrames(2);
  const persp = frontPlateNdcHeight(viewer);
  viewer.setProjection("orthographic");
  expect(frontPlateNdcHeight(viewer) / persp).toBeCloseTo(1, 6);
  // …and straight back is lossless: the same depth is matched both ways.
  viewer.setProjection("perspective");
  expect(distanceOf(viewer)).toBeCloseTo(40, 6);
  expect(frontPlateNdcHeight(viewer) / persp).toBeCloseTo(1, 6);
  viewer.dispose();
});

// --- the size-match surface, against real solids and a real clip plane ------
// A closed box, given in WORLD coordinates and converted to the model frame the
// pivot rotates (model (x, y, z) -> world (x, z, -y)), wound outward — the
// parity walk that finds a section cap reads which faces the ray enters by.
function worldBox([x0, y0, z0], [x1, y1, z1]) {
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const v = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  const out = [];
  for (const [a, b, cc, d] of quads) {
    for (const tri of [[a, b, cc], [a, cc, d]]) {
      let [p, q, r] = tri.map(v);
      const n = new THREE.Vector3().subVectors(new THREE.Vector3(...q), new THREE.Vector3(...p))
        .cross(new THREE.Vector3().subVectors(new THREE.Vector3(...r), new THREE.Vector3(...p)));
      const centroid = [0, 1, 2].map((k) => (p[k] + q[k] + r[k]) / 3 - c[k]);
      if (n.dot(new THREE.Vector3(...centroid)) < 0) [q, r] = [r, q];
      for (const [wx, wy, wz] of [p, q, r]) out.push(wx, -wz, wy); // world -> model
    }
  }
  return { positions: new Float32Array(out), triangles: out.length / 9 };
}
// World x, y in +/-10, z (toward the front camera) in +/-5.
const slab = () => worldBox([-10, -10, -5], [10, 10, 5]);

// A clip plane the fake cutaway really applies: three keeps the non-negative
// side, and getPlane is null while off — the real cutaway's contract.
function section(plane) {
  state.cutaway.isEnabled = Boolean(plane);
  state.cutaway.isPointVisible = vi.fn((p) => !plane || plane.distanceToPoint(p) >= -1e-6);
  state.cutaway.getPlane = vi.fn((target = new THREE.Plane()) => (plane ? target.copy(plane) : null));
}

// Screen height (NDC) of a vertical segment at world depth z on the axis.
const ndcHeightAt = (viewer, z) => {
  viewer.camera.updateMatrixWorld();
  const a = new THREE.Vector3(0, -4, z).project(viewer.camera);
  const b = new THREE.Vector3(0, 4, z).project(viewer.camera);
  return Math.abs(b.y - a.y);
};

function slabViewer(parts = { body: {} }, geometry = { body: slab() }) {
  const viewer = createViewer(createContainer(), { meta: {}, parts });
  for (const [n, g] of Object.entries(geometry)) viewer.setSubGeometry(n, g);
  viewer.showAssembly(Object.keys(geometry), { frame: true });
  return viewer;
}

test.each([
  ["the cap, where a front cut crosses the solid", new THREE.Plane(new THREE.Vector3(0, 0, -1), 1), 1],
  ["a deeper cap", new THREE.Plane(new THREE.Vector3(0, 0, -1), -3), -3],
  ["the front face, when the cut takes the back away", new THREE.Plane(new THREE.Vector3(0, 0, 1), 2), 5],
])("with the cutaway on, the size is matched at %s", (_label, plane, depth) => {
  section(plane);
  const viewer = slabViewer();
  viewer.setCameraState({ pos: [0, 0, 60], target: [0, 0, 0] });
  runFrames(2);
  const persp = ndcHeightAt(viewer, depth);
  viewer.setProjection("orthographic");
  expect(ndcHeightAt(viewer, depth) / persp).toBeCloseTo(1, 6);
  viewer.camera.zoom = 2;
  viewer.camera.updateProjectionMatrix();
  const ortho = ndcHeightAt(viewer, depth);
  viewer.setProjection("perspective");
  expect(ndcHeightAt(viewer, depth) / ortho).toBeCloseTo(1, 6);
  viewer.dispose();
});

test("a sectioned, zoomed ortho face view survives a remount whose cutaway comes back after the camera", () => {
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1); // cap at z = 1
  section(plane);
  const viewer = slabViewer();
  viewer.tweenCameraTo("front", CUBE);
  runFrames();
  viewer.camera.zoom = 3;
  viewer.camera.updateProjectionMatrix();
  const onScreen = viewer.camera.top / viewer.camera.zoom;
  const carried = viewer.getCameraState();
  viewer.dispose();

  // mount's order: ortho, the pose, the cutaway, then the pose again.
  section(null);
  const next = slabViewer();
  next.setProjection("orthographic");
  next.setCameraState(carried);
  section(plane);
  next.setCameraState(carried);
  expect(next.camera.top / next.camera.zoom).toBeCloseTo(onScreen, 6);
  next.dispose();
});

test("moving the cut plane asks afresh (the remembered surface is keyed on it)", () => {
  section(new THREE.Plane(new THREE.Vector3(0, 0, -1), 1)); // cap at z = 1
  const viewer = slabViewer();
  viewer.tweenCameraTo("front", CUBE);
  runFrames();
  viewer.camera.zoom = 2;
  viewer.camera.updateProjectionMatrix();
  runFrames(1);
  section(new THREE.Plane(new THREE.Vector3(0, 0, -1), -3)); // dragged deeper: cap at z = -3
  const ortho = ndcHeightAt(viewer, -3);
  let atSwap = null;
  viewer.onProjectionChange(() => { atSwap = ndcHeightAt(viewer, -3); });
  state.controls._sphericalDelta.theta = 0.05;
  runFrames(30);
  expect(viewer.getProjection()).toBe("perspective");
  expect(atSwap / ortho).toBeCloseTo(1, 2);
  viewer.dispose();
});

test("a regenerate that keeps the bounds asks afresh (the remembered surface is keyed on the geometry)", () => {
  // Same bounds both times; the second front sheet leaves the centre open, so
  // the ray reaches the back sheet (wound toward the camera) at z = -5.
  const sheet = (tri, z) => tri.flatMap(([x, y]) => [x, -z, y]);
  // Counter-clockwise in world x-y, so a world +z normal (toward the camera);
  // the pivot is a proper rotation and keeps the winding.
  const facing = (a, b, c) => [a, b, c];
  const covered = {
    positions: new Float32Array([
      ...sheet(facing([-10, -10], [10, -10], [0, 10]), 5),
      ...sheet(facing([-10, -10], [10, -10], [0, 10]), -5),
    ]),
    triangles: 2,
  };
  const open = {
    positions: new Float32Array([
      ...sheet(facing([-10, -10], [10, -10], [10, -2]), 5),
      ...sheet(facing([-10, -10], [10, -10], [0, 10]), -5),
      ...sheet(facing([-10, 10], [10, 10], [0, 9]), 5), // keeps the bounds' top edge
    ]),
    triangles: 3,
  };
  const viewer = slabViewer({ body: {} }, { body: covered });
  viewer.tweenCameraTo("front", CUBE);
  runFrames();
  viewer.camera.zoom = 2.5;
  viewer.camera.updateProjectionMatrix();
  runFrames(1);
  viewer.getCameraState(); // prime the remembered surface on the covered sheet

  viewer.setSubGeometry("body", open);
  viewer.showAssembly(["body"], { frame: false });
  // Asked along the very same ray (a swap after a rotation is off-axis and
  // would ask afresh anyway): the carried pose must describe the surface on
  // screen NOW, the back sheet 5mm behind the target, not the front sheet the
  // ray used to stop at.
  const onScreen = viewer.camera.top / viewer.camera.zoom;
  expect((distanceOf(viewer) + 5) * HALF_FOV_TAN).toBeCloseTo(onScreen, 6);
  viewer.dispose();
});

test("a ghosted sub-part is seen through, not matched at", () => {
  const viewer = slabViewer(
    { ghost: { display: { opacity: 0.4 } }, body: {} },
    { ghost: worldBox([-10, -10, 3], [10, 10, 5]), body: worldBox([-10, -10, -5], [10, 10, -1]) },
  );
  viewer.setCameraState({ pos: [0, 0, 60], target: [0, 0, 0] });
  runFrames(2);
  const persp = ndcHeightAt(viewer, -1); // the opaque body's front face
  viewer.setProjection("orthographic");
  expect(ndcHeightAt(viewer, -1) / persp).toBeCloseTo(1, 6);
  viewer.dispose();
});

test("a part faded out by an animation is no longer matched at (the remembered surface asks afresh)", () => {
  const viewer = slabViewer(
    { housing: {}, body: {} },
    { housing: worldBox([-10, -10, 3], [10, 10, 5]), body: worldBox([-10, -10, -5], [10, 10, -1]) },
  );
  viewer.setCameraState({ pos: [0, 0, 60], target: [0, 0, 0] });
  runFrames(2);
  viewer.setProjection("orthographic");
  viewer.camera.zoom = 2.5;
  viewer.camera.updateProjectionMatrix();
  viewer.getCameraState(); // remembers the housing's front face (z = 5)
  const onScreen = viewer.camera.top / viewer.camera.zoom;

  viewer.setSubPartOpacity("housing", 0); // a "reveal" cue fades the housing out
  // Same ray: the carried pose must now describe the body's front face (1 mm
  // behind the target), not the hidden housing's.
  expect((distanceOf(viewer) + 1) * HALF_FOV_TAN).toBeCloseTo(onScreen, 6);

  viewer.clearSubPartOpacities(); // and back: the housing is matched at again
  expect((distanceOf(viewer) - 5) * HALF_FOV_TAN).toBeCloseTo(onScreen, 6);
  viewer.dispose();
});

test("a remount at a very high ortho zoom keeps its size (the surface is right by the camera)", () => {
  const viewer = slabViewer();
  viewer.tweenCameraTo("front", CUBE);
  runFrames();
  viewer.camera.zoom = 400; // the recovered camera sits ~0.13mm off the front face
  viewer.camera.updateProjectionMatrix();
  const onScreen = viewer.camera.top / viewer.camera.zoom;
  const carried = viewer.getCameraState();
  viewer.dispose();

  const next = slabViewer();
  next.setProjection("orthographic");
  next.setCameraState(carried);
  expect(next.camera.top / next.camera.zoom).toBeCloseTo(onScreen, 9);
  next.dispose();
});
