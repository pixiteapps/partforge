// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";
import { worldToSubPartLocal, attachPicker } from "../src/framework/selection/pick.js";

const view = { v: { label: "V" } };
const part = {
  defaults: { a: 1 }, views: view,
  parts: { one: { views: ["v"], build: (k, p) => k.cylinder({ r: p.a, h: p.a }) } },
};

afterEach(() => { document.body.innerHTML = ""; });

test("worldToSubPartLocal inverts the pivot rotation + recentring", () => {
  // Replicate the viewer's hierarchy: pivot (rot x=-90°) → partsGroup (offset) → mesh.
  const pivot = new THREE.Group();
  pivot.rotation.x = -Math.PI / 2;
  const partsGroup = new THREE.Group();
  partsGroup.position.set(-5, 0, 0); // recentre offset
  pivot.add(partsGroup);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  partsGroup.add(mesh);
  pivot.updateMatrixWorld(true);

  // A CAD-local point (2,0,3) maps to some world point; the helper must round-trip it.
  const local = new THREE.Vector3(2, 0, 3);
  const world = mesh.localToWorld(local.clone());
  const back = worldToSubPartLocal(mesh, world);
  expect(back[0]).toBeCloseTo(2, 5);
  expect(back[1]).toBeCloseTo(0, 5);
  expect(back[2]).toBeCloseTo(3, 5);
});

test("attachPicker raycasts a click and delivers a resolved selection", () => {
  // Camera at +Z looking at origin; a unit box at origin fills the centre of the view.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.name = "one";
  mesh.visible = true;
  mesh.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const flashPoint = vi.fn();
  const viewer = { camera, domElement, _subMeshes: { one: mesh }, flashPoint };
  const onPick = vi.fn();
  const picker = attachPicker(viewer, {
    part,
    getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }),
    onPick,
  });
  picker.setActive(true);

  // Click dead-centre → NDC (0,0) → ray hits the box.
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true }));

  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick.mock.calls[0][0].subPart).toBe("one");
  expect(flashPoint).toHaveBeenCalledTimes(1);
  picker.detach();
});

test("a pick reports where its marker lands on the canvas", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.name = "one";
  mesh.visible = true;
  mesh.updateMatrixWorld(true);

  // Nonzero origin, unlike the other fixtures here: the anchor is CSS px from
  // the CANVAS's top-left, and with the canvas at the page origin an
  // implementation that reported client coordinates would pass unnoticed.
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 40, top: 25, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const onPick = vi.fn();
  const picker = attachPicker({ camera, domElement, _subMeshes: { one: mesh }, flashPoint: vi.fn() }, {
    part,
    getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }),
    onPick,
  });
  picker.setActive(true);

  // Off-centre on purpose too: dead centre is the one click a "return the
  // canvas middle" bug would also satisfy.
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 170, clientY: 105, bubbles: true }));

  expect(onPick).toHaveBeenCalledTimes(1);
  // The marker sits on the ray the click cast, so its projection comes back to
  // the pixel that was clicked — expressed against the canvas, so the rect's
  // origin comes off: (170-40, 105-25).
  const anchor = onPick.mock.calls[0][1];
  expect(anchor.x).toBeCloseTo(130, 0);
  expect(anchor.y).toBeCloseTo(80, 0);
  picker.detach();
});

test("attachPicker suppresses the click emitted after a pointer drag", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.name = "one";
  mesh.visible = true;
  mesh.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const flashPoint = vi.fn();
  const onPick = vi.fn();
  const picker = attachPicker({ camera, domElement, _subMeshes: { one: mesh }, flashPoint }, {
    part,
    getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }),
    onPick,
  });
  picker.setActive(true);

  domElement.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 1, clientX: 100, clientY: 100, bubbles: true,
  }));
  domElement.dispatchEvent(new PointerEvent("pointermove", {
    pointerId: 1, clientX: 110, clientY: 100, bubbles: true,
  }));
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 110, clientY: 100, bubbles: true }));

  expect(onPick).not.toHaveBeenCalled();
  expect(flashPoint).not.toHaveBeenCalled();
  picker.detach();
});

test("attachPicker tolerates small pointer movement during a click", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.name = "one";
  mesh.visible = true;
  mesh.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const flashPoint = vi.fn();
  const onPick = vi.fn();
  const picker = attachPicker({ camera, domElement, _subMeshes: { one: mesh }, flashPoint }, {
    part,
    getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }),
    onPick,
  });
  picker.setActive(true);

  domElement.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 1, clientX: 100, clientY: 100, bubbles: true,
  }));
  domElement.dispatchEvent(new PointerEvent("pointermove", {
    pointerId: 1, clientX: 102, clientY: 102, bubbles: true,
  }));
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 102, clientY: 102, bubbles: true }));

  expect(onPick).toHaveBeenCalledTimes(1);
  expect(flashPoint).toHaveBeenCalledTimes(1);
  picker.detach();
});

test("attachPicker keeps drag suppression when another pointer joins the gesture", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.name = "one";
  mesh.visible = true;
  mesh.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const flashPoint = vi.fn();
  const onPick = vi.fn();
  const picker = attachPicker({ camera, domElement, _subMeshes: { one: mesh }, flashPoint }, {
    part,
    getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }),
    onPick,
  });
  picker.setActive(true);

  domElement.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 1, clientX: 100, clientY: 100, bubbles: true,
  }));
  domElement.dispatchEvent(new PointerEvent("pointermove", {
    pointerId: 1, clientX: 110, clientY: 100, bubbles: true,
  }));
  domElement.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 2, clientX: 100, clientY: 100, bubbles: true,
  }));
  domElement.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
  domElement.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, bubbles: true }));
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 110, clientY: 100, bubbles: true }));

  expect(onPick).not.toHaveBeenCalled();
  expect(flashPoint).not.toHaveBeenCalled();
  picker.detach();
});

test("clicks do nothing when the picker is inactive", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);
  const onPick = vi.fn();
  const picker = attachPicker({ camera, domElement, _subMeshes: {}, flashPoint: () => {} }, {
    part, getContext: () => ({ view: "v", params: {}, derived: {} }), onPick,
  });
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 10, clientY: 10, bubbles: true }));
  expect(onPick).not.toHaveBeenCalled();
  picker.detach();
});

test("active picker with a ray that misses all meshes calls neither onPick nor flashPoint", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const flashPoint = vi.fn();
  const onPick = vi.fn();
  // Empty _subMeshes: no geometry to hit regardless of where the ray points.
  const picker = attachPicker({ camera, domElement, _subMeshes: {}, flashPoint }, {
    part, getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }), onPick,
  });
  picker.setActive(true);

  // Click dead-centre — ray fires but there are no meshes to intersect.
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true }));

  expect(onPick).not.toHaveBeenCalled();
  expect(flashPoint).not.toHaveBeenCalled();
  picker.detach();
});

test("a suppressed picker neither picks nor flashes, and recovers when the guard clears", () => {
  // mount passes measure mode's isEnabled as this guard: while measuring, a
  // click pins a dimension and must not ALSO select-and-flash. Pull-based, so
  // clearing the condition restores picks with no resync call.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.name = "one";
  mesh.visible = true;
  mesh.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const flashPoint = vi.fn();
  const onPick = vi.fn();
  let measuring = true;
  const picker = attachPicker({ camera, domElement, _subMeshes: { one: mesh }, flashPoint }, {
    part,
    getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }),
    onPick,
    suppressed: () => measuring,
  });
  picker.setActive(true);

  domElement.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true }));
  expect(onPick).not.toHaveBeenCalled();
  expect(flashPoint).not.toHaveBeenCalled();

  measuring = false;
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true }));
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(flashPoint).toHaveBeenCalledTimes(1);
  picker.detach();
});

test("a click that hits nothing calls onMiss; a drag or a suppressed click does not", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.name = "one";
  mesh.visible = true;
  mesh.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const onPick = vi.fn();
  const onMiss = vi.fn();
  let measuring = false;
  const picker = attachPicker({ camera, domElement, _subMeshes: { one: mesh }, flashPoint: vi.fn() }, {
    part,
    getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }),
    onPick,
    onMiss,
    suppressed: () => measuring,
  });
  picker.setActive(true);

  // A corner of the view, well clear of the box.
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 2, clientY: 2, bubbles: true }));
  expect(onMiss).toHaveBeenCalledTimes(1);
  expect(onPick).not.toHaveBeenCalled();

  // A hit is a pick, not a miss.
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true }));
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onMiss).toHaveBeenCalledTimes(1);

  // An orbit drag that ends on the background is not a miss.
  domElement.dispatchEvent(new PointerEvent("pointerdown", { clientX: 2, clientY: 2, bubbles: true }));
  domElement.dispatchEvent(new PointerEvent("pointermove", { clientX: 60, clientY: 60, bubbles: true }));
  domElement.dispatchEvent(new PointerEvent("pointerup", { clientX: 60, clientY: 2, bubbles: true }));
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 60, clientY: 2, bubbles: true }));
  expect(onMiss).toHaveBeenCalledTimes(1);

  // Nor is a suppressed click (measure mode).
  measuring = true;
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 2, clientY: 2, bubbles: true }));
  expect(onMiss).toHaveBeenCalledTimes(1);
  picker.detach();
});
