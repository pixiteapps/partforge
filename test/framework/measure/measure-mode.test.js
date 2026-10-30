// @vitest-environment happy-dom
// Orchestrator against a minimal real-three fake viewer: enable -> always-on
// overall dims; hover -> a snap marker and nothing else; first click -> one
// reading (or a start point); second click -> one distance; third click starts
// over. Dimensions are in-scene objects, so the observation surface is the
// "pf-dims" group under the meshes' shared parent (each label mesh carries its
// item id in userData.pfDimItemId).
import { expect, test, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { createMeasureMode } from "../../../src/framework/measure/measure-mode.js";
import { placeDims } from "../../../src/framework/measure/dim3-place.js";
import { classifyFeature } from "../../../src/framework/measure/feature-dims.js";
import { buildSnapIndex } from "../../../src/framework/measure/snaps.js";
import { buildBVH } from "../../../src/framework/oracle/bvh.js";

// Pass-through spy on the placement entry point: behaviour is untouched, but
// "which items were re-placed, and when" becomes observable.
vi.mock("../../../src/framework/measure/dim3-place.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, placeDims: vi.fn(actual.placeDims) };
});

// Pass-through spies on the per-geometry builders, so "built once, in idle
// time, never on hover" is countable.
vi.mock("../../../src/framework/measure/feature-dims.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, classifyFeature: vi.fn(actual.classifyFeature) };
});
vi.mock("../../../src/framework/measure/snaps.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildSnapIndex: vi.fn(actual.buildSnapIndex) };
});
vi.mock("../../../src/framework/oracle/bvh.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildBVH: vi.fn(actual.buildBVH) };
});

// Pass-through on spanSpec, overridable per test: a span that only exists in
// one kind is too fine to click into the fixture, so a test can stand it in.
let spanOverride = null;
vi.mock("../../../src/framework/measure/readings.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spanSpec: (...args) => (spanOverride ? spanOverride(actual.spanSpec, ...args) : actual.spanSpec(...args)) };
});

// dim3-scene's default label painter needs a real 2d context; happy-dom has
// none. Stub the minimum it touches and record every painted string, which is
// how the assertions read label content.
const paintLog = [];
HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 0,
    lineJoin: "", textAlign: "", textBaseline: "",
    measureText: (t) => ({ width: 8 * String(t).length }),
    fillText: (t) => { paintLog.push(String(t)); },
    strokeText: (t) => { paintLog.push(String(t)); },
    beginPath() {}, roundRect() {}, fill() {}, stroke() {},
  };
};
beforeEach(() => {
  paintLog.length = 0;
  placeDims.mockClear();
  classifyFeature.mockClear();
  buildSnapIndex.mockClear();
  buildBVH.mockClear();
  spanOverride = null;
});

// A 20×10 plate: one sub-part, one labeled planar feature covering both
// triangles of its top face at z=2, with the face's four boundary edges drawn
// (edgePositions, as the viewer stores them). Non-indexed, feature ids per
// triangle. `halfLabeled` leaves the upper-left triangle unlabeled.
function plateMesh({ halfLabeled = false } = {}) {
  const positions = new Float32Array([
    0, 0, 2, 20, 0, 2, 20, 10, 2,
    0, 0, 2, 20, 10, 2, 0, 10, 2,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.featureIds = new Uint16Array([1, halfLabeled ? 0 : 1]);
  geo.userData.features = ["top face"];
  geo.userData.edgePositions = new Float32Array([
    0, 0, 2, 20, 0, 2,
    20, 0, 2, 20, 10, 2,
    20, 10, 2, 0, 10, 2,
    0, 10, 2, 0, 0, 2,
  ]);
  return new THREE.Mesh(geo);
}

// `parts` is the meshes' shared parent group — the frame every dimension is
// placed in, and the node the dim group parents itself under.
function fakeViewer(mesh, parts = new THREE.Group()) {
  const dom = document.createElement("div");
  const stage = document.createElement("div");
  stage.appendChild(dom);
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  // happy-dom lays nothing out; give the canvas its 100 px so screen-constant
  // label sizes (and so label picks) are realistic
  Object.defineProperty(dom, "clientWidth", { value: 100 });
  Object.defineProperty(dom, "clientHeight", { value: 100 });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(10, 5, 40); // over the plate center, looking down -Z
  camera.lookAt(10, 5, 2);
  camera.updateMatrixWorld(true);
  mesh.name = "plate";
  if (mesh.parent !== parts) parts.add(mesh);
  parts.updateMatrixWorld(true);
  const frameCbs = new Set();
  const handleHoverCbs = new Set();
  const themeCbs = new Set();
  return {
    domElement: dom,
    stage, // NOT stageElement: the real viewer has none, so mode must be handed one
    camera,
    _subMeshes: { plate: mesh },
    __parts: parts,
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    registerCutawayMaterial: () => () => {},
    registerCanonicalCaptureHidden: () => () => {},
    getTheme: () => "dark",
    onThemeChange: (cb) => { themeCbs.add(cb); return () => themeCbs.delete(cb); },
    fireTheme: (m) => { for (const cb of [...themeCbs]) cb(m); },
    frame: () => { for (const cb of [...frameCbs]) cb(16); },
    onCutawayHandleHover: (cb) => { handleHoverCbs.add(cb); return () => handleHoverCbs.delete(cb); },
    fireHandleHover: (handle) => { for (const cb of [...handleHoverCbs]) cb(handle); },
  };
}

const part = {
  parameters: [{ id: "s", title: "S", controls: [
    { key: "plate_w", unit: "mm" },
    { key: "wall", unit: "mm" },
    { key: "tilt", unit: "°" },
    { key: "rad_t", unit: "rad" },
    { key: "fill", unit: "%" },
  ] }],
  parts: { plate: { label: "Plate", build: () => {} } },
  views: { main: { parts: ["plate"] }, alt: { parts: ["plate"] } },
};
const pointerOpts = { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 };

function setup({ parts, mesh = plateMesh() } = {}) {
  const viewer = fakeViewer(mesh, parts);
  const revealParams = vi.fn();
  const ctx = { view: "main", params: { plate_w: 20, wall: 3 } };
  // The idle pre-build waits here until a test runs it (runIdle).
  const idleQueue = [];
  const idle = (cb) => {
    idleQueue.push(cb);
    return () => { const i = idleQueue.indexOf(cb); if (i >= 0) idleQueue.splice(i, 1); };
  };
  const runIdle = () => { while (idleQueue.length) idleQueue.shift()({ timeRemaining: () => 0 }); };
  const mode = createMeasureMode(viewer, {
    part,
    getContext: () => ctx,
    revealParams,
    stage: viewer.stage,
    schedule: (cb) => cb(), // synchronous for tests
    idle,
  });
  const dimGroup = () => viewer.__parts.children.find((c) => c.name === "pf-dims");
  const itemIds = () => (dimGroup()?.children ?? [])
    .filter((c) => c.userData.pfDimItemId)
    .map((c) => c.userData.pfDimItemId);
  const snapLabel = () => viewer.stage.querySelector(".pf-measure-snap");
  const snapShown = () => !!snapLabel() && !snapLabel().hidden;
  const startDot = () => {
    let found = null;
    viewer.__parts.traverse((o) => { if (o.name === "pf-measure-start") found = o; });
    return found;
  };
  // world positions of one item's dim labels, for "did the placement move?"
  const labelPositions = (prefix) => {
    viewer.__parts.updateMatrixWorld(true);
    return (dimGroup()?.children ?? [])
      .filter((c) => c.userData.pfDimItemId?.startsWith(prefix))
      .map((c) => c.getWorldPosition(new THREE.Vector3()).toArray());
  };
  return { mesh, viewer, mode, ctx, revealParams, dimGroup, itemIds, snapLabel, snapShown, startDot, labelPositions, idleQueue, runIdle };
}

// Client px of a parts-frame point (the fake's 100×100 canvas at the origin).
function screenOf(viewer, p) {
  viewer.__parts.updateMatrixWorld(true);
  const v = new THREE.Vector3(...p).applyMatrix4(viewer.__parts.matrixWorld).project(viewer.camera);
  return { x: ((v.x + 1) / 2) * 100, y: ((1 - v.y) / 2) * 100 };
}

// Mirror viewer.setSubPose: a rigid pose written straight onto mesh.matrix.
const poseSubMesh = (mesh, matrix) => {
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix);
  mesh.matrixWorldNeedsUpdate = true;
};

const move = (dom, x = 50, y = 50) =>
  dom.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: x, clientY: y }));

const clickAt = (dom, x = 50, y = 50, extra = {}) => {
  const opts = { ...pointerOpts, clientX: x, clientY: y, ...extra };
  dom.dispatchEvent(new PointerEvent("pointerdown", opts));
  dom.dispatchEvent(new PointerEvent("pointerup", opts));
  dom.dispatchEvent(new MouseEvent("click", opts));
};
const clickPoint = (viewer, p, extra) => {
  const { x, y } = screenOf(viewer, p);
  clickAt(viewer.domElement, x, y, extra);
};
// Two corners of the plate, and a point on its bottom edge away from both the
// corners and the edge midpoint (so it snaps to the EDGE).
const CORNER_A = [0, 0, 2];
const CORNER_C = [20, 10, 2];
const ON_EDGE = [5, 0, 2]; // 14 px from both the corner and the midpoint (snap radius 12)

function labelScreen(viewer, label) {
  viewer.__parts.updateMatrixWorld(true);
  const p = label.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
  return { x: ((p.x + 1) / 2) * 100, y: ((1 - p.y) / 2) * 100 };
}

// ---- entering the mode ------------------------------------------------------

test("enable renders always-on overall dims; disable clears", () => {
  const { mode, dimGroup, itemIds } = setup();
  mode.setEnabled(true);
  expect(dimGroup()).toBeDefined();
  expect(itemIds()).toContain("overall");
  // the plate is flat, so only its W and D extents are dimensioned
  expect(itemIds().filter((id) => id === "overall").length).toBe(2);
  expect(paintLog).toContain("20.00 mm");
  expect(paintLog).toContain("10.00 mm");
  expect(mode.isEnabled()).toBe(true);

  mode.setEnabled(false);
  expect(mode.isEnabled()).toBe(false);
  expect(dimGroup().children.length).toBe(0);
  mode.setEnabled(true);
  expect(itemIds()).toContain("overall");
  mode.detach();
});

test("setUnits re-renders labels in inches; values stay mm", () => {
  const { mode, dimGroup } = setup();
  mode.setEnabled(true);
  expect(mode.getUnits()).toBe("mm");
  paintLog.length = 0;
  mode.setUnits("in");
  expect(mode.getUnits()).toBe("in");
  expect(paintLog).toContain("0.787 in");
  expect(paintLog).not.toContain("20.00 mm");
  expect(dimGroup().children.find((c) => c.userData.pfDimValue === 20)).toBeDefined();
  mode.setUnits("furlongs");
  expect(mode.getUnits()).toBe("in");
  mode.detach();
});

test("the dim group is parented under the meshes' shared group", () => {
  const parts = new THREE.Group();
  parts.position.set(5, 0, 0);
  const { viewer, mode, dimGroup } = setup({ parts });
  mode.setEnabled(true);
  expect(dimGroup().parent).toBe(viewer.__parts);
  mode.detach();
});

// ---- hover ------------------------------------------------------------------

test("hover draws no dimension", () => {
  const { viewer, mode, snapLabel, snapShown, itemIds } = setup();
  mode.setEnabled(true);
  const calls = placeDims.mock.calls.length;
  const ids = itemIds();
  move(viewer.domElement);
  expect(placeDims.mock.calls.length).toBe(calls);
  expect(itemIds()).toEqual(ids);
  expect(snapShown()).toBe(true);
  expect(snapLabel().textContent).toBe("top face · face");
  mode.detach();
});

test("hover labels name the feature and the snap kind; unnamed geometry says point", () => {
  const { viewer, mode, snapLabel } = setup();
  mode.setEnabled(true);
  const a = screenOf(viewer, CORNER_A);
  move(viewer.domElement, a.x, a.y);
  expect(snapLabel().textContent).toBe("top face · corner");
  const e = screenOf(viewer, ON_EDGE);
  move(viewer.domElement, e.x, e.y);
  expect(snapLabel().textContent).toBe("top face · edge");
  const m = screenOf(viewer, [10, 0, 2]);
  move(viewer.domElement, m.x, m.y);
  expect(snapLabel().textContent).toBe("top face · midpoint");
  mode.detach();

  const un = setup({ mesh: plateMesh({ halfLabeled: true }) });
  un.mode.setEnabled(true);
  move(un.viewer.domElement, 35.9, 44.4); // inside the UNLABELED triangle
  expect(un.snapLabel().textContent).toBe("point");
  un.mode.detach();
});

test("pointerleave and an empty-space move hide the snap marker", () => {
  const { viewer, mode, snapShown } = setup();
  mode.setEnabled(true);
  move(viewer.domElement);
  expect(snapShown()).toBe(true);
  move(viewer.domElement, 2, 2);
  expect(snapShown()).toBe(false);
  move(viewer.domElement);
  viewer.domElement.dispatchEvent(new MouseEvent("pointerleave"));
  expect(snapShown()).toBe(false);
  mode.detach();
});

test("the snap marker drops when its mesh goes invisible", () => {
  const { mesh, viewer, mode, snapShown } = setup();
  mode.setEnabled(true);
  move(viewer.domElement);
  expect(snapShown()).toBe(true);
  mesh.visible = false;
  viewer.frame();
  expect(snapShown()).toBe(false);
  mode.detach();
});

test("cutaway handle hover suppresses the snap marker; release resumes it", () => {
  const { viewer, mode, snapShown } = setup();
  mode.setEnabled(true);
  move(viewer.domElement);
  expect(snapShown()).toBe(true);
  viewer.fireHandleHover("radius");
  expect(snapShown()).toBe(false);
  move(viewer.domElement, 51, 50);
  expect(snapShown()).toBe(false);
  viewer.fireHandleHover(null);
  move(viewer.domElement);
  expect(snapShown()).toBe(true);
  mode.detach();
});

// ---- first click --------------------------------------------------------------

test("first click on the labelled face reads W × H and flashes a matching param", () => {
  const { viewer, mode, itemIds, revealParams } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);
  expect(onPins).toHaveBeenCalledTimes(1);
  expect(itemIds().filter((id) => id === "first").length).toBe(2); // W and H
  expect(revealParams).toHaveBeenCalledWith(["plate_w"], null);
  mode.detach();
});

test("first click on a straight edge reads its length", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, ON_EDGE);
  expect(mode.pinCount()).toBe(1);
  const first = dimGroup().children.filter((c) => c.userData.pfDimItemId === "first");
  expect(first.map((c) => c.userData.pfDimValue)).toEqual([20]);
  mode.detach();
});

test("first click on a corner reads nothing but counts 1", () => {
  const { viewer, mode, itemIds, revealParams, startDot } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  expect(mode.pinCount()).toBe(1);
  expect(itemIds().every((id) => id === "overall")).toBe(true);
  expect(revealParams).not.toHaveBeenCalled();
  expect(startDot()?.visible).toBe(true);
  mode.detach();
});

test("a drag does not click", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 80 }));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", { ...pointerOpts, clientX: 80 }));
  viewer.domElement.dispatchEvent(new MouseEvent("click", { ...pointerOpts, clientX: 80 }));
  expect(mode.pinCount()).toBe(0);
  mode.detach();
});

// ---- touch: preview, then commit ----------------------------------------------

// A finger: pointer events say "touch"; the compatibility click after a tap is a
// plain MouseEvent (no pointerType), as Safari sends it.
const finger = (type, x, y, extra = {}) => new PointerEvent(type, {
  bubbles: true, clientX: x, clientY: y, pointerId: 7, pointerType: "touch", isPrimary: true, ...extra,
});
const tapAt = (dom, x, y) => {
  dom.dispatchEvent(finger("pointerdown", x, y));
  dom.dispatchEvent(finger("pointerup", x, y));
  dom.dispatchEvent(finger("pointerleave", x, y)); // touch leaves after every lift
  dom.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
};
const tapPoint = (viewer, p, dx = 0, dy = 0) => {
  const { x, y } = screenOf(viewer, p);
  tapAt(viewer.domElement, x + dx, y + dy);
};

test("touch tap previews, second tap commits", () => {
  const { viewer, mode, snapLabel, snapShown, startDot, itemIds, dimGroup } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  const placed = placeDims.mock.calls.length;

  tapPoint(viewer, CORNER_A);
  expect(mode.pinCount()).toBe(0); // a tap shows, it does not commit
  expect(onPins).not.toHaveBeenCalled();
  expect(placeDims.mock.calls.length).toBe(placed);
  expect(snapShown()).toBe(true);
  expect(snapLabel().textContent).toBe("top face · corner");

  // a tap somewhere else moves the preview; a background tap drops it
  tapPoint(viewer, CORNER_C);
  expect(mode.pinCount()).toBe(0);
  expect(snapShown()).toBe(true);
  tapAt(viewer.domElement, 2, 2);
  expect(mode.pinCount()).toBe(0);
  expect(snapShown()).toBe(false);

  // a second tap within SNAP_PX of the shown snap commits that snap
  tapPoint(viewer, CORNER_A);
  tapPoint(viewer, CORNER_A, 5, -4);
  expect(mode.pinCount()).toBe(1);
  expect(onPins).toHaveBeenCalledTimes(1);
  expect(snapShown()).toBe(false);
  expect(startDot()?.visible).toBe(true);
  expect(itemIds().every((id) => id === "overall")).toBe(true);

  // the second point the same way: one distance
  tapPoint(viewer, CORNER_C);
  expect(mode.pinCount()).toBe(1);
  tapPoint(viewer, CORNER_C, -3, 3);
  expect(mode.pinCount()).toBe(2);
  const span = dimGroup().children.filter((c) => c.userData.pfDimItemId === "span");
  expect(span.map((c) => c.userData.pfDimValue)).toEqual([20]);
  mode.detach();
});

test("touch drag from the shown snap adjusts then commits on lift", () => {
  const { viewer, mode, snapLabel, snapShown, dimGroup } = setup();
  mode.setEnabled(true);
  // stands in for OrbitControls: a bubble listener registered after the mode
  const orbitDown = vi.fn();
  viewer.domElement.addEventListener("pointerdown", orbitDown);
  tapPoint(viewer, CORNER_A);
  orbitDown.mockClear();

  const a = screenOf(viewer, CORNER_A);
  const e = screenOf(viewer, ON_EDGE);
  const dom = viewer.domElement;
  dom.dispatchEvent(finger("pointerdown", a.x, a.y));
  expect(orbitDown).not.toHaveBeenCalled(); // the drag is the snap's, not the camera's
  dom.dispatchEvent(finger("pointermove", (a.x + e.x) / 2, a.y));
  dom.dispatchEvent(finger("pointermove", e.x, e.y));
  expect(mode.pinCount()).toBe(0); // adjusting commits nothing yet
  expect(snapShown()).toBe(true);
  expect(snapLabel().textContent).toBe("top face · edge");
  dom.dispatchEvent(finger("pointerup", e.x, e.y));
  expect(mode.pinCount()).toBe(1);
  expect(snapShown()).toBe(false);
  const first = dimGroup().children.filter((c) => c.userData.pfDimItemId === "first");
  expect(first.map((c) => c.userData.pfDimValue)).toEqual([20]); // the edge's length
  // the click the lift may trail is the commit's, not a new tap
  dom.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: e.x, clientY: e.y }));
  expect(mode.pinCount()).toBe(1);
  expect(snapShown()).toBe(false);
  // and the next real tap is a tap again
  tapPoint(viewer, CORNER_C);
  expect(snapShown()).toBe(true);
  expect(mode.pinCount()).toBe(1);
  mode.detach();
});

test("Clear during a touch drag ends it: the lift commits nothing", () => {
  const { viewer, mode, snapShown } = setup();
  mode.setEnabled(true);
  tapPoint(viewer, CORNER_A);
  const a = screenOf(viewer, CORNER_A);
  const e = screenOf(viewer, ON_EDGE);
  const dom = viewer.domElement;
  dom.dispatchEvent(finger("pointerdown", a.x, a.y));
  dom.dispatchEvent(finger("pointermove", (a.x + e.x) / 2, a.y));
  mode.clearPins();
  dom.dispatchEvent(finger("pointermove", e.x, e.y)); // the finger is still down
  dom.dispatchEvent(finger("pointerup", e.x, e.y));
  expect(mode.pinCount()).toBe(0);
  expect(snapShown()).toBe(false);
  mode.detach();
});

test("a corner hidden by the cutaway is not snapped", () => {
  const { viewer, mode, snapLabel } = setup();
  mode.setEnabled(true);
  // a cut that keeps x > 1: the hit (on the face) is kept, CORNER_A is not
  viewer.isWorldPointVisible = (p) => {
    const local = viewer.__parts.worldToLocal(p.clone());
    return local.x > 1;
  };
  const a = screenOf(viewer, [1.5, 0.5, 2]); // near CORNER_A on screen, on the kept side
  move(viewer.domElement, a.x, a.y);
  expect(snapLabel().textContent).not.toBe("top face · corner");
  delete viewer.isWorldPointVisible;
  move(viewer.domElement, a.x, a.y + 0.01);
  expect(snapLabel().textContent).toBe("top face · corner");
  mode.detach();
});

test("touch drag elsewhere does not commit", () => {
  const { viewer, mode, snapLabel, snapShown } = setup();
  mode.setEnabled(true);
  const orbitDown = vi.fn();
  viewer.domElement.addEventListener("pointerdown", orbitDown);
  const dom = viewer.domElement;
  const c = screenOf(viewer, CORNER_C);

  // no preview yet: an orbit drag neither commits nor previews
  dom.dispatchEvent(finger("pointerdown", c.x, c.y));
  dom.dispatchEvent(finger("pointermove", c.x - 30, c.y));
  dom.dispatchEvent(finger("pointerup", c.x - 30, c.y));
  dom.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: c.x - 30, clientY: c.y }));
  expect(mode.pinCount()).toBe(0);
  expect(snapShown()).toBe(false);

  // with a preview at A, a drag that starts away from it orbits, keeps the preview
  tapPoint(viewer, CORNER_A);
  orbitDown.mockClear();
  dom.dispatchEvent(finger("pointerdown", c.x, c.y));
  expect(orbitDown).toHaveBeenCalledTimes(1);
  dom.dispatchEvent(finger("pointermove", c.x - 30, c.y));
  dom.dispatchEvent(finger("pointerup", c.x - 30, c.y));
  dom.dispatchEvent(finger("pointerleave", c.x - 30, c.y));
  dom.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: c.x - 30, clientY: c.y }));
  expect(mode.pinCount()).toBe(0);
  expect(snapShown()).toBe(true);
  expect(snapLabel().textContent).toBe("top face · corner");

  // a second finger mid-adjust is a pinch: nothing commits
  const a = screenOf(viewer, CORNER_A);
  dom.dispatchEvent(finger("pointerdown", a.x, a.y));
  dom.dispatchEvent(finger("pointerdown", a.x + 40, a.y, { pointerId: 8, isPrimary: false }));
  dom.dispatchEvent(finger("pointerup", a.x + 40, a.y, { pointerId: 8, isPrimary: false }));
  dom.dispatchEvent(finger("pointerup", a.x, a.y));
  expect(mode.pinCount()).toBe(0);
  mode.detach();
});

// ---- second and third clicks --------------------------------------------------

test("second click draws one span; pinCount is 2", () => {
  const { viewer, mode, dimGroup, itemIds, revealParams, startDot } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C);
  expect(mode.pinCount()).toBe(2);
  expect(onPins).toHaveBeenCalledTimes(2);
  const span = dimGroup().children.filter((c) => c.userData.pfDimItemId === "span");
  // one dimension, along the dominant axis (X: 20 of the 20×10 diagonal)
  expect(span.map((c) => c.userData.pfDimValue)).toEqual([20]);
  expect(itemIds()).not.toContain("first");
  expect(revealParams).not.toHaveBeenCalled(); // distances never flash
  expect(startDot()?.visible).toBe(true); // a no-reading start point stays marked
  mode.detach();
});

test("a distance replaces the first reading on screen", () => {
  const { viewer, mode, itemIds, revealParams } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement); // the face: W × H, with the clicked point as the start
  revealParams.mockClear();
  clickPoint(viewer, CORNER_C);
  expect(mode.pinCount()).toBe(2);
  expect(itemIds()).not.toContain("first");
  expect(itemIds().filter((id) => id === "span").length).toBe(1);
  expect(revealParams).not.toHaveBeenCalled();
  mode.detach();
});

test("Shift click gives the straight-line distance", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C, { shiftKey: true });
  const span = dimGroup().children.filter((c) => c.userData.pfDimItemId === "span");
  expect(span.map((c) => c.userData.pfDimValue)).toEqual([22.36]);
  mode.detach();
});

test("setStraight makes a plain click straight-line", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  expect(mode.isStraight()).toBe(false);
  mode.setStraight(true);
  expect(mode.isStraight()).toBe(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C);
  const span = dimGroup().children.filter((c) => c.userData.pfDimItemId === "span");
  expect(span.map((c) => c.userData.pfDimValue)).toEqual([22.36]);
  mode.detach();
});

test("the straight toggle redraws a distance already on screen", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C);
  const spanValues = () => dimGroup().children
    .filter((c) => c.userData.pfDimItemId === "span").map((c) => c.userData.pfDimValue);
  expect(spanValues()).toEqual([20]);
  mode.setStraight(true);
  expect(spanValues()).toEqual([22.36]);
  expect(mode.pinCount()).toBe(2);
  mode.setStraight(false);
  expect(spanValues()).toEqual([20]);
  mode.detach();
});

test("a toggle that turns the distance under MIN_SPAN_MM clears it and tells pin listeners", () => {
  const { viewer, mode, itemIds, startDot } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C, { shiftKey: true }); // straight
  expect(mode.pinCount()).toBe(2);
  // as for a straight span of ~0.006 mm: its axis form falls under MIN_SPAN_MM
  spanOverride = (real, a, b, opts) => (opts.straight ? real(a, b, opts) : null);
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setStraight(false);
  expect(mode.pinCount()).toBe(0);
  expect(onPins).toHaveBeenCalledTimes(1);
  expect(itemIds().every((id) => id === "overall")).toBe(true);
  expect(startDot()?.visible ?? false).toBe(false);
  mode.detach();
});

test("third click starts over", () => {
  const { viewer, mode, itemIds, revealParams } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C);
  expect(mode.pinCount()).toBe(2);
  clickAt(viewer.domElement); // the face again
  expect(mode.pinCount()).toBe(1);
  expect(itemIds()).not.toContain("span");
  expect(itemIds()).toContain("first");
  expect(revealParams).toHaveBeenCalledWith(["plate_w"], null);
  expect(onPins).toHaveBeenCalledTimes(3);
  mode.detach();
});

test("second click on the first point does nothing", () => {
  const { viewer, mode, itemIds } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_A);
  expect(mode.pinCount()).toBe(1);
  expect(itemIds()).not.toContain("span");
  expect(onPins).toHaveBeenCalledTimes(1);
  mode.detach();
});

test("click on background keeps the reading", () => {
  const { viewer, mode, itemIds } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  clickAt(viewer.domElement, 2, 2); // off the plate
  expect(mode.pinCount()).toBe(1);
  expect(itemIds()).toContain("first");
  expect(onPins).toHaveBeenCalledTimes(1);
  mode.detach();
});

// ---- clearing -----------------------------------------------------------------

test("Clear keeps the overall dims", () => {
  const { viewer, mode, itemIds, startDot } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C);
  onPins.mockClear();
  mode.clearPins();
  expect(mode.pinCount()).toBe(0);
  expect(onPins).toHaveBeenCalledTimes(1);
  expect(itemIds()).toContain("overall");
  expect(itemIds()).not.toContain("span");
  expect(startDot()?.visible ?? false).toBe(false);
  mode.detach();
});

test("leaving the mode clears; re-entering shows only the overall", () => {
  const { viewer, mode, itemIds, snapShown } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  onPins.mockClear();
  mode.setEnabled(false);
  expect(mode.pinCount()).toBe(0);
  expect(onPins).toHaveBeenCalledTimes(1);
  expect(snapShown()).toBe(false);
  mode.setEnabled(true);
  expect(itemIds().every((id) => id === "overall")).toBe(true);
  mode.detach();
});

test("a regenerate clears and fires onPinsChange", () => {
  const { viewer, mode, itemIds, snapShown, startDot } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  move(viewer.domElement);
  expect(snapShown()).toBe(true);
  onPins.mockClear();

  viewer._subMeshes.plate.geometry = plateMesh().geometry; // new geometry instance
  viewer.frame();
  expect(mode.pinCount()).toBe(0);
  expect(onPins).toHaveBeenCalledTimes(1);
  expect(itemIds().every((id) => id === "overall")).toBe(true);
  expect(snapShown()).toBe(false); // the marker pointed into the old geometry
  expect(startDot()?.visible ?? false).toBe(false);
  mode.detach();
});

test("a clear also hides the hover snap, even when its mesh stays", () => {
  const { viewer, mode, ctx, snapShown } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  move(viewer.domElement);
  expect(snapShown()).toBe(true);
  ctx.view = "alt"; // same mesh, still visible: only the view moved
  viewer.frame();
  expect(mode.pinCount()).toBe(0);
  expect(snapShown()).toBe(false);

  move(viewer.domElement);
  expect(snapShown()).toBe(true);
  mode.clearPins();
  expect(snapShown()).toBe(false);
  mode.detach();
});

test("a cylinder's first click reads ⌀ only and flashes on the diameter", () => {
  const { viewer, mode, dimGroup, ctx, revealParams } = setup({ mesh: cylinderMesh() });
  ctx.params = { boss_d: 6, boss_len: 10 };
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  const first = dimGroup().children.filter((c) => c.userData.pfDimItemId === "first");
  expect(first.map((c) => c.userData.pfDimValue)).toEqual([6]); // no depth dim
  expect(revealParams).toHaveBeenCalledWith(["boss_d"], null);
  mode.detach();
});

test("a hidden sub-part clears the reading", () => {
  const { mesh, viewer, mode } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  onPins.mockClear();
  mesh.visible = false;
  viewer.frame();
  expect(mode.pinCount()).toBe(0);
  expect(onPins).toHaveBeenCalledTimes(1);
  mode.detach();
});

test("a pose-only change keeps the reading and moves it", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  viewer.frame();
  const before = labelPositions("first");
  expect(before.length).toBe(2);
  onPins.mockClear();

  poseSubMesh(mesh, new THREE.Matrix4().makeRotationZ(Math.PI / 6));
  viewer.frame();
  const after = labelPositions("first");
  expect(mode.pinCount()).toBe(1);
  expect(onPins).not.toHaveBeenCalled();
  expect(after.length).toBe(2);
  expect(after).not.toEqual(before);
  mode.detach();
});

test("a pose-only change moves a distance with its sub-part", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C);
  viewer.frame();
  const before = labelPositions("span");
  expect(before.length).toBe(1);
  poseSubMesh(mesh, new THREE.Matrix4().makeTranslation(5, 0, 0));
  viewer.frame();
  const after = labelPositions("span");
  expect(mode.pinCount()).toBe(2);
  expect(after[0][0]).toBeCloseTo(before[0][0] + 5, 5);
  expect(after[0][1]).toBeCloseTo(before[0][1], 5);
  mode.detach();
});

test("a view change clears", () => {
  const { viewer, mode, ctx, itemIds } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  onPins.mockClear();
  ctx.view = "alt"; // same meshes, same poses, same geometry — only the view moved
  viewer.frame();
  expect(mode.pinCount()).toBe(0);
  expect(onPins).toHaveBeenCalledTimes(1);
  expect(itemIds()).not.toContain("first");
  ctx.view = "main";
  viewer.frame();
  expect(mode.pinCount()).toBe(0); // nothing comes back
  mode.detach();
});

// ---- label picks ----------------------------------------------------------------

test("a reading's label click flashes the matching param and changes nothing", () => {
  const { viewer, mode, dimGroup, revealParams } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  revealParams.mockClear();
  viewer.frame();
  const w = dimGroup().children.find((c) => c.userData.pfDimItemId === "first" && c.userData.pfDimValue === 20);
  expect(w).toBeDefined();
  const { x, y } = labelScreen(viewer, w);
  clickAt(viewer.domElement, x, y);
  expect(revealParams).toHaveBeenCalledWith(["plate_w"], null);
  expect(mode.pinCount()).toBe(1); // no fall-through into a second click
  mode.detach();
});

test("a label click with no matching value flashes nothing", () => {
  const { viewer, mode, dimGroup, revealParams } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  revealParams.mockClear();
  viewer.frame();
  const h = dimGroup().children.find((c) => c.userData.pfDimItemId === "first" && c.userData.pfDimValue === 10);
  const { x, y } = labelScreen(viewer, h);
  clickAt(viewer.domElement, x, y);
  expect(revealParams).not.toHaveBeenCalled();
  expect(mode.pinCount()).toBe(1);
  mode.detach();
});

test("several matching params all flash, none takes focus", () => {
  const { viewer, mode, ctx, revealParams } = setup();
  ctx.params.wall = 20;
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  const [keys, focus] = revealParams.mock.calls.at(-1);
  expect(keys.sort()).toEqual(["plate_w", "wall"]);
  expect(focus).toBe(null);
  mode.detach();
});

test("an angle or percent param never flashes for a length, and nothing takes focus", () => {
  const { viewer, mode, ctx, revealParams } = setup();
  ctx.params = { plate_w: 20, tilt: 20, rad_t: 20, fill: 20 };
  mode.setEnabled(true);
  clickAt(viewer.domElement); // W 20 × H 10
  const [keys, focus] = revealParams.mock.calls.at(-1);
  expect(keys).toEqual(["plate_w"]);
  expect(focus).toBe(null);
  mode.detach();
});

test("a touch commit flashes without a focus key", () => {
  const { viewer, mode, revealParams } = setup();
  mode.setEnabled(true);
  tapAt(viewer.domElement, 50, 50);
  tapAt(viewer.domElement, 50, 50); // a second tap on the preview commits it
  expect(mode.pinCount()).toBe(1);
  expect(revealParams).toHaveBeenCalledWith(["plate_w"], null);
  mode.detach();
});

test("a distance's label click flashes nothing", () => {
  const { viewer, mode, dimGroup, revealParams } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, CORNER_A);
  clickPoint(viewer, CORNER_C);
  viewer.frame();
  const s = dimGroup().children.find((c) => c.userData.pfDimItemId === "span");
  const { x, y } = labelScreen(viewer, s);
  clickAt(viewer.domElement, x, y); // value 20 matches plate_w, but distances never flash
  expect(revealParams).not.toHaveBeenCalled();
  expect(mode.pinCount()).toBe(2);
  mode.detach();
});

test("a pointer over a dim label hides the snap marker and shows a pointer cursor", () => {
  const { viewer, mode, dimGroup, snapShown } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  viewer.frame();
  const w = dimGroup().children.find((c) => c.userData.pfDimItemId === "first");
  const { x, y } = labelScreen(viewer, w);
  move(viewer.domElement, x, y);
  expect(snapShown()).toBe(false);
  expect(viewer.domElement.style.cursor).toBe("pointer");
  move(viewer.domElement, 2, 2);
  expect(viewer.domElement.style.cursor).toBe("");
  mode.detach();
});

// ---- frames -----------------------------------------------------------------------

// Open tube (wall triangles only, one labeled feature), axis along Y, crosswise
// to the fixed camera ray so a click at (50, 50) hits its wall.
function cylinderMesh({ r = 3, length = 10, seg = 24, cx = 10, cz = 2, id = 1, label = "boss" } = {}) {
  const pos = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (2 * Math.PI * i) / seg, a1 = (2 * Math.PI * (i + 1)) / seg;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    pos.push(cx + p0[0], 0, cz + p0[1], cx + p1[0], 0, cz + p1[1], cx + p1[0], length, cz + p1[1]);
    pos.push(cx + p0[0], 0, cz + p0[1], cx + p1[0], length, cz + p1[1], cx + p0[0], length, cz + p0[1]);
  }
  const positions = new Float32Array(pos);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.featureIds = new Uint16Array(positions.length / 9).fill(id);
  geo.userData.features = [label];
  return new THREE.Mesh(geo);
}

// transformSpec's cylinder branch under a real ROTATION, pivoted on the
// feature's own centre so the ⌀ direction choice is untouched by the pose.
test("a posed mesh rotates a CYLINDER reading's ⌀ label through transformSpec", () => {
  const mesh = cylinderMesh();
  const { viewer, mode, itemIds, labelPositions } = setup({ mesh });
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);
  expect(itemIds()).toContain("first");
  viewer.frame();
  const before = labelPositions("first");

  const rawSpec = classifyFeature(
    { positions: mesh.geometry.getAttribute("position").array, featureIds: mesh.geometry.userData.featureIds },
    1,
  );
  const [cx, cy, cz] = rawSpec.anchors.center;
  const pose = new THREE.Matrix4()
    .makeTranslation(cx, cy, cz)
    .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
    .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, -cz));
  poseSubMesh(mesh, pose);
  viewer.frame();
  const after = labelPositions("first");
  expect(after.length).toBe(before.length);
  const [bx, by, bz] = before[0];
  const [ax, ay, az] = after[0];
  expect(ax - cx).toBeCloseTo(-(by - cy), 3);
  expect(ay - cy).toBeCloseTo(bx - cx, 3);
  expect(az - cz).toBeCloseTo(bz - cz, 3);
  mode.detach();
});

test("an edge reading rides a translation through transformSpec", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, ON_EDGE);
  viewer.frame();
  const before = labelPositions("first");
  expect(before.length).toBe(1);
  poseSubMesh(mesh, new THREE.Matrix4().makeTranslation(0, 3, 0));
  viewer.frame();
  const after = labelPositions("first");
  expect(after[0][0]).toBeCloseTo(before[0][0], 5);
  expect(after[0][1]).toBeCloseTo(before[0][1] + 3, 5);
  mode.detach();
});

test("an edge reading on a posed sub-part squares to that sub-part's axes", () => {
  const { mesh, viewer, mode } = setup();
  mode.setEnabled(true);
  clickPoint(viewer, ON_EDGE);
  const pose = new THREE.Matrix4().makeRotationZ(Math.PI / 6);
  poseSubMesh(mesh, pose);
  placeDims.mockClear();
  viewer.frame();
  const items = placeDims.mock.calls.flatMap(([list]) => list).filter((i) => i.id === "first");
  expect(items.length).toBeGreaterThan(0);
  const axes = items.at(-1).spec.anchors.axes;
  const e = pose.elements;
  expect(axes).toHaveLength(3);
  [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]].forEach((col, i) => {
    for (let k = 0; k < 3; k++) expect(axes[i][k]).toBeCloseTo(col[k], 6);
  });
  mode.detach();
});

test("an opposite-sign pose rotation is not mistaken for the same pose", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  const posed = (t) => new THREE.Matrix4().makeRotationX(t).setPosition(1, 2, 3);
  poseSubMesh(mesh, posed(Math.PI / 6));
  viewer.frame();
  const plus = labelPositions("first");
  expect(plus.length).toBeGreaterThan(0);
  poseSubMesh(mesh, posed(-Math.PI / 6));
  viewer.frame();
  const minus = labelPositions("first");
  expect(minus.length).toBe(plus.length);
  expect(minus).not.toEqual(plus);
  mode.detach();
});

// ---- placement caching ------------------------------------------------------------

test("a steady frame does not re-place; only a side-choice flip does", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  const kids = () => [...dimGroup().children];
  const same = (a, b) => a.length === b.length && a.every((o, i) => o === b[i]);
  const first = kids();
  expect(first.length).toBeGreaterThan(0);
  for (let i = 0; i < 5; i++) viewer.frame();
  expect(same(kids(), first)).toBe(true);
  viewer.camera.position.set(10.5, 5.2, 40);
  viewer.frame();
  expect(same(kids(), first)).toBe(true);
  viewer.camera.position.set(10, 5, -40);
  viewer.frame();
  expect(same(kids(), first)).toBe(true);
  viewer.camera.position.set(150, 5, 2);
  viewer.frame();
  expect(same(kids(), first)).toBe(false);
  expect(kids().length).toBe(first.length);
  mode.detach();
});

test("an orbit that revisits angles it has already placed re-places nothing", () => {
  const { viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement); // with a reading on screen too
  const orbit = () => {
    for (const p of [[150, 5, 2], [10, 5, 40], [5, 150, 2], [10, 5, 40]]) {
      viewer.camera.position.set(...p);
      viewer.frame();
    }
  };
  orbit();
  const home = labelPositions("");
  expect(home.length).toBeGreaterThan(0);
  placeDims.mockClear();
  orbit();
  expect(placeDims.mock.calls).toEqual([]);
  expect(labelPositions("")).toEqual(home);
  mode.detach();
});

// placeBox scans every vertex of the meshes it covers, so a click must place
// its one measurement and reuse the cached overall drawings.
test("a click places only its measurement, reusing the overall drawings", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  expect(placeDims.mock.calls.at(-1)[0].map((i) => i.id)).toEqual(["overall"]);
  placeDims.mockClear();
  clickAt(viewer.domElement);
  expect(placeDims.mock.calls.map((c) => c[0].map((i) => i.id))).toEqual([["first"]]);
  placeDims.mockClear();
  clickPoint(viewer, CORNER_C);
  expect(placeDims.mock.calls.map((c) => c[0].map((i) => i.id))).toEqual([["span"]]);
  placeDims.mockClear();
  mode.clearPins(); // back to the overall alone: already placed
  expect(placeDims.mock.calls).toEqual([]);
  mode.detach();
});

test("hover moves never re-place, even with a reading on screen", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  placeDims.mockClear();
  for (const [x, y] of [[50, 50], [30, 60], [70, 40], [2, 2]]) move(viewer.domElement, x, y);
  expect(placeDims.mock.calls).toEqual([]);
  mode.detach();
});

// ---- speed: per-geometry work happens once, in idle time ---------------------------

// Every BVH buildBVH made for `geometry` (matched by its position array).
const bvhBuildsFor = (geometry) =>
  buildBVH.mock.calls.filter(([m]) => m.positions === geometry.getAttribute("position").array).length;
const snapBuildsFor = (geometry) =>
  buildSnapIndex.mock.calls.filter(([m]) => m.positions === geometry.getAttribute("position").array).length;

// The plate plus enough small triangles hidden under its top face to cross the
// BVH floor (BVH_MIN_TRIANGLES = 100,000). They are unlabelled and sit at
// 0 < z < 1, so every ray from the fixture camera still meets the top face
// first, and the plate's edges, feature and snaps are unchanged.
const BIG_EXTRA = 100_000;
function bigPlateMesh() {
  const base = plateMesh();
  const plate = base.geometry.getAttribute("position").array;
  const positions = new Float32Array(plate.length + BIG_EXTRA * 9);
  positions.set(plate);
  for (let t = 0; t < BIG_EXTRA; t++) {
    const o = plate.length + t * 9;
    const x = 1 + (t % 300) * 0.06, y = 1 + Math.floor(t / 300) * 0.024, z = 0.5;
    positions.set([x, y, z, x + 0.02, y, z, x, y + 0.02, z], o);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeBoundingBox();
  const featureIds = new Uint16Array(2 + BIG_EXTRA);
  featureIds[0] = 1;
  featureIds[1] = 1;
  geo.userData = { ...base.geometry.userData, featureIds };
  return new THREE.Mesh(geo);
}
const bigGeometry = () => bigPlateMesh().geometry;

test("the measure BVH is built once per geometry", () => {
  const { viewer, mode, runIdle, snapLabel } = setup({ mesh: bigPlateMesh() });
  mode.setEnabled(true);
  runIdle();
  for (let i = 0; i < 5; i++) {
    move(viewer.domElement, 40 + i, 50);
    expect(snapLabel().textContent).toBe("top face · face");
  }
  expect(buildBVH).toHaveBeenCalledTimes(1);

  const next = bigGeometry();
  viewer._subMeshes.plate.geometry = next; // a regenerate
  viewer.frame();
  runIdle();
  for (let i = 0; i < 5; i++) move(viewer.domElement, 40 + i, 50);
  expect(buildBVH).toHaveBeenCalledTimes(2);
  expect(bvhBuildsFor(next)).toBe(1);
  mode.detach();
});

test("a geometry under the BVH floor gets no BVH; its snap index and specs are still pre-built", () => {
  const { viewer, mode, runIdle, snapLabel } = setup(); // the 2-triangle plate
  mode.setEnabled(true);
  runIdle();
  expect(buildBVH).not.toHaveBeenCalled();
  expect(buildSnapIndex).toHaveBeenCalledTimes(1);
  expect(classifyFeature).toHaveBeenCalledTimes(1);
  const a = screenOf(viewer, CORNER_A);
  move(viewer.domElement, a.x, a.y);
  clickPoint(viewer, CORNER_A);
  expect(snapLabel().textContent).toBe("top face · corner");
  expect(mode.pinCount()).toBe(1);
  // nothing more was built, and a pose change does not queue it all again
  viewer.frame();
  runIdle();
  expect(buildSnapIndex).toHaveBeenCalledTimes(1);
  expect(classifyFeature).toHaveBeenCalledTimes(1);
  expect(buildBVH).not.toHaveBeenCalled();
  mode.detach();
});

test("after the idle pre-build, hover and click build nothing and cast no three ray", () => {
  const { viewer, mode, runIdle, snapLabel } = setup({ mesh: bigPlateMesh() });
  mode.setEnabled(true);
  expect(buildSnapIndex).not.toHaveBeenCalled(); // entering the mode builds nothing itself
  runIdle();
  expect(buildSnapIndex).toHaveBeenCalledTimes(1);
  expect(classifyFeature).toHaveBeenCalledTimes(1); // the plate's one named feature
  const raycast = vi.spyOn(THREE.Mesh.prototype, "raycast");
  try {
    const a = screenOf(viewer, CORNER_A);
    move(viewer.domElement, a.x, a.y);
    expect(snapLabel().textContent).toBe("top face · corner");
    clickPoint(viewer, CORNER_A);
    clickPoint(viewer, CORNER_C);
    expect(mode.pinCount()).toBe(2);
    expect(raycast.mock.contexts.filter((m) => m === viewer._subMeshes.plate)).toEqual([]);
  } finally {
    raycast.mockRestore();
  }
  expect(buildSnapIndex).toHaveBeenCalledTimes(1);
  expect(classifyFeature).toHaveBeenCalledTimes(1);
  expect(buildBVH).toHaveBeenCalledTimes(1);
  mode.detach();
});

test("before the pre-build runs, hover still works on three's ray and builds no BVH", () => {
  const { viewer, mode, snapLabel } = setup({ mesh: bigPlateMesh() });
  mode.setEnabled(true);
  const a = screenOf(viewer, CORNER_A);
  move(viewer.domElement, a.x, a.y);
  expect(snapLabel().textContent).toBe("top face · corner");
  expect(buildBVH).not.toHaveBeenCalled(); // only idle time builds one
  mode.detach();
});

test("turning the mode off releases the BVH; re-entry rebuilds it in idle time", () => {
  const { viewer, mode, runIdle, snapLabel } = setup({ mesh: bigPlateMesh() });
  const geometry = viewer._subMeshes.plate.geometry;
  mode.setEnabled(true);
  runIdle();
  expect(bvhBuildsFor(geometry)).toBe(1);
  mode.setEnabled(false);
  mode.setEnabled(true);
  const raycast = vi.spyOn(THREE.Mesh.prototype, "raycast");
  try {
    move(viewer.domElement); // before the idle rebuild: three's ray again
    expect(snapLabel().textContent).toBe("top face · face");
    expect(raycast.mock.contexts).toContain(viewer._subMeshes.plate);
    expect(buildBVH).toHaveBeenCalledTimes(1); // hover never builds one
    runIdle();
    expect(bvhBuildsFor(geometry)).toBe(2);
    raycast.mockClear();
    move(viewer.domElement, 45, 50);
    expect(raycast.mock.contexts).not.toContain(viewer._subMeshes.plate);
  } finally {
    raycast.mockRestore();
  }
  mode.detach();
});

test("a failing pre-build step is contained; hover stays on the old path and the rest still runs", () => {
  const { viewer, mode, runIdle, snapLabel } = setup({ mesh: bigPlateMesh() });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  buildSnapIndex.mockImplementationOnce(() => { throw new Error("boom"); });
  try {
    mode.setEnabled(true);
    expect(() => runIdle()).not.toThrow();
    expect(err).toHaveBeenCalledWith("measure pre-build failed", "snap index", expect.any(Error));
    expect(classifyFeature).toHaveBeenCalledTimes(1); // the later steps still ran
    expect(buildBVH).toHaveBeenCalledTimes(1);
    const a = screenOf(viewer, CORNER_A);
    move(viewer.domElement, a.x, a.y); // builds its snap index itself, as before
    expect(snapLabel().textContent).toBe("top face · corner");
    expect(buildSnapIndex).toHaveBeenCalledTimes(2);
  } finally {
    err.mockRestore();
  }
  mode.detach();
});

test("a failing BVH build leaves hover on three's ray", () => {
  const { viewer, mode, runIdle, snapLabel } = setup({ mesh: bigPlateMesh() });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  buildBVH.mockImplementationOnce(() => { throw new Error("out of memory"); });
  const raycast = vi.spyOn(THREE.Mesh.prototype, "raycast");
  try {
    mode.setEnabled(true);
    expect(() => runIdle()).not.toThrow();
    move(viewer.domElement);
    expect(snapLabel().textContent).toBe("top face · face");
    expect(raycast.mock.contexts).toContain(viewer._subMeshes.plate);
  } finally {
    raycast.mockRestore();
    err.mockRestore();
  }
  mode.detach();
});

test("a pre-build is dropped when the mode turns off before its idle callback runs", () => {
  const { viewer, mode, idleQueue, runIdle } = setup({ mesh: bigPlateMesh() });
  mode.setEnabled(true);
  const pending = [...idleQueue];
  expect(pending.length).toBe(1);
  mode.setEnabled(false);
  expect(idleQueue).toEqual([]); // cancelled
  // a browser that fires the callback anyway (or late) must not do the work
  for (const cb of pending) cb({ timeRemaining: () => 50 });
  expect(buildBVH).not.toHaveBeenCalled();
  expect(buildSnapIndex).not.toHaveBeenCalled();
  expect(classifyFeature).not.toHaveBeenCalled();

  mode.setEnabled(true); // a new session queues again
  runIdle();
  expect(bvhBuildsFor(viewer._subMeshes.plate.geometry)).toBe(1);
  mode.detach();
  expect(idleQueue).toEqual([]);
});

test("a regenerate before the idle callback runs: only the new geometry is built", () => {
  const { viewer, mode, runIdle } = setup({ mesh: bigPlateMesh() });
  const old = viewer._subMeshes.plate.geometry;
  mode.setEnabled(true);
  const next = bigGeometry();
  viewer._subMeshes.plate.geometry = next;
  viewer.frame(); // queues the new geometry
  runIdle();
  expect(bvhBuildsFor(old)).toBe(0);
  expect(bvhBuildsFor(next)).toBe(1);
  expect(snapBuildsFor(old)).toBe(0);
  expect(snapBuildsFor(next)).toBe(1);
  mode.detach();
});

test("a sub-part hidden before its pre-build runs is built once it shows again", () => {
  const { viewer, mode, runIdle } = setup();
  const mesh = viewer._subMeshes.plate;
  mode.setEnabled(true);
  mesh.visible = false;
  viewer.frame();
  runIdle();
  expect(buildSnapIndex).not.toHaveBeenCalled();
  mesh.visible = true;
  viewer.frame();
  runIdle();
  expect(snapBuildsFor(mesh.geometry)).toBe(1);
  mode.detach();
});

// ---- lifecycle ----------------------------------------------------------------------

test("onModeChange fires on enable and disable", () => {
  const { mode } = setup();
  const cb = vi.fn();
  mode.onModeChange(cb);
  mode.setEnabled(true);
  mode.setEnabled(false);
  expect(cb).toHaveBeenCalledTimes(2);
  mode.detach();
});

test("a theme change repaints the dims and detach removes the group and marker", () => {
  const { viewer, mode, dimGroup, snapLabel } = setup();
  mode.setEnabled(true);
  move(viewer.domElement);
  expect(() => viewer.fireTheme("light")).not.toThrow();
  expect(dimGroup().children.length).toBeGreaterThan(0);
  mode.detach();
  expect(dimGroup()).toBeUndefined();
  expect(snapLabel()).toBeNull();
});

test("frame ticks are harmless before and after the mode is enabled", () => {
  const { viewer, mode } = setup();
  expect(() => viewer.frame()).not.toThrow();
  mode.setEnabled(true);
  expect(() => viewer.frame()).not.toThrow();
  mode.detach();
});
