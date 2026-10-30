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

// Pass-through spy on the placement entry point: behaviour is untouched, but
// "which items were re-placed, and when" becomes observable.
vi.mock("../../../src/framework/measure/dim3-place.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, placeDims: vi.fn(actual.placeDims) };
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
beforeEach(() => { paintLog.length = 0; placeDims.mockClear(); });

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
  parts: { plate: { label: "Plate", build: () => {} } },
  views: { main: { parts: ["plate"] }, alt: { parts: ["plate"] } },
};
const pointerOpts = { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 };

function setup({ parts, mesh = plateMesh() } = {}) {
  const viewer = fakeViewer(mesh, parts);
  const revealParams = vi.fn();
  const ctx = { view: "main", params: { plate_w: 20, wall: 3 } };
  const mode = createMeasureMode(viewer, {
    part,
    getContext: () => ctx,
    revealParams,
    stage: viewer.stage,
    schedule: (cb) => cb(), // synchronous for tests
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
  return { mesh, viewer, mode, ctx, revealParams, dimGroup, itemIds, snapLabel, snapShown, startDot, labelPositions };
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
  expect(revealParams).toHaveBeenCalledWith(["plate_w"], "plate_w");
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
  expect(revealParams).toHaveBeenCalledWith(["plate_w"], "plate_w");
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
  expect(revealParams).toHaveBeenCalledWith(["boss_d"], "boss_d");
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
  expect(revealParams).toHaveBeenCalledWith(["plate_w"], "plate_w");
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
