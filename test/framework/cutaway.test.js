// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

import { OUTLINE_SLICE_BUDGET_MS, createCutaway } from "../../src/framework/cutaway.js";
import { cutawayPoseSize } from "../../src/framework/cutaway-math.js";

const controllers = [];
const CENTER_HANDLE = "rotate-y";

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose?.();
  document.body.innerHTML = "";
});

function makeRenderer(stencil = true) {
  const getContextAttributes = stencil === "throw"
    ? vi.fn(() => { throw new Error("context lost"); })
    : vi.fn(() => ({ stencil }));
  return {
    localClippingEnabled: false,
    autoClear: true,
    getContext: vi.fn(() => ({ getContextAttributes })),
    getContextAttributes,
    clearDepth: vi.fn(),
    render: vi.fn(),
  };
}

function makeSchedule() {
  const entries = [];
  const schedule = vi.fn((callback, delay) => {
    const entry = { callback, delay, cancelled: false };
    entries.push(entry);
    return () => { entry.cancelled = true; };
  });
  return { schedule, entries };
}

function createFixture({
  stencil = true,
  box,
  schedule: providedSchedule,
  localClippingEnabled = false,
  edgeColor = 0x1c232d,
  now,
} = {}) {
  const renderer = makeRenderer(stencil);
  renderer.localClippingEnabled = localClippingEnabled;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1_000);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const orbitControls = { enabled: true };
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 200,
    bottom: 200,
    width: 200,
    height: 200,
  });
  document.body.appendChild(domElement);
  let bounds = box ?? new THREE.Box3(
    new THREE.Vector3(-5, -4, -3),
    new THREE.Vector3(5, 4, 3),
  );
  const timer = providedSchedule ? null : makeSchedule();
  const controller = createCutaway({
    renderer,
    scene,
    camera,
    orbitControls,
    domElement,
    getBounds: () => bounds,
    schedule: providedSchedule ?? timer.schedule,
    edgeColor,
    now,
  });
  controllers.push(controller);
  return {
    renderer,
    scene,
    camera,
    orbitControls,
    domElement,
    timer,
    controller,
    setBounds(next) { bounds = next; },
  };
}

function addSubpart(fixture, name = "body", options = {}) {
  const geometry = options.geometry ?? new THREE.BoxGeometry(4, 6, 8);
  const material = options.material ?? new THREE.MeshStandardMaterial({
    color: 0x336699,
    opacity: 0.7,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const edgeGeometry = new THREE.EdgesGeometry(geometry);
  const edgeMaterial = options.edgeMaterial
    ?? new THREE.LineBasicMaterial({ color: 0x111111 });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  fixture.scene.add(mesh, edgeLines);
  fixture.controller.setSubpart(name, mesh, edgeLines);
  return { geometry, material, mesh, edgeGeometry, edgeMaterial, edgeLines };
}

function findGizmo(scene) {
  return scene.children.find(
    (child) => child.isGroup && child.children.some((entry) => entry.isLineLoop),
  );
}

function findCap(scene) {
  return scene.children.find((child) => child.isMesh && child.material?.isShaderMaterial);
}

function findCaps(scene) {
  return scene.children.filter(
    (child) => child.isMesh && child.material?.isShaderMaterial,
  );
}

// The section helpers a subpart mesh carries: the two stencil passes. The
// cut-face outline is also a child, but it is a LineSegments2 and has its own
// visibility rules, so it is not part of what these assertions describe.
function stencilPasses(mesh) {
  return mesh.children.filter((entry) => !entry.isLineSegments2);
}

function movePointer(element, x = 100, y = 100) {
  element.dispatchEvent(new PointerEvent("pointermove", {
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: "mouse",
  }));
}

describe("createCutaway capability", () => {
  test.each([
    [true, true],
    [false, false],
    ["throw", false],
  ])("reports stencil capability %s as %s after one query", (stencil, expected) => {
    const fixture = createFixture({ stencil });

    expect(fixture.controller.isSupported).toBe(expected);
    expect(fixture.renderer.getContext).toHaveBeenCalledOnce();
    expect(fixture.renderer.getContextAttributes).toHaveBeenCalledOnce();
    expect(fixture.controller.isSupported).toBe(expected);
    expect(fixture.renderer.getContext).toHaveBeenCalledOnce();
    expect(fixture.renderer.getContextAttributes).toHaveBeenCalledOnce();
  });

  test("refuses unsupported activation without throwing or changing clipping state", () => {
    const fixture = createFixture({ stencil: false });
    addSubpart(fixture);

    expect(fixture.controller.setEnabled(true)).toBe(false);
    expect(fixture.controller.isEnabled).toBe(false);
    expect(fixture.renderer.localClippingEnabled).toBe(false);
    expect(findGizmo(fixture.scene).visible).toBe(false);
  });
});

test("handle hover subscriptions start at null, forward transitions, and unsubscribe", () => {
  const fixture = createFixture();
  const listener = vi.fn();
  const unsubscribe = fixture.controller.onHandleHoverChange(listener);

  expect(listener).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenLastCalledWith(null);

  fixture.controller.setEnabled(true);
  movePointer(fixture.domElement);
  movePointer(fixture.domElement);
  movePointer(fixture.domElement, 1, 1);

  expect(listener.mock.calls.map(([handle]) => handle)).toEqual([
    null,
    CENTER_HANDLE,
    null,
  ]);

  unsubscribe();
  unsubscribe();
  movePointer(fixture.domElement);
  expect(listener).toHaveBeenCalledTimes(3);
});

test("disabling and disposing publish null and reject late subscriptions safely", () => {
  const fixture = createFixture();
  const listener = vi.fn();
  fixture.controller.onHandleHoverChange(listener);
  fixture.controller.setEnabled(true);
  movePointer(fixture.domElement);

  fixture.controller.setEnabled(false);
  expect(listener).toHaveBeenLastCalledWith(null);

  fixture.controller.setEnabled(true);
  movePointer(fixture.domElement);
  fixture.controller.dispose();
  expect(listener.mock.calls.map(([handle]) => handle)).toEqual([
    null,
    CENTER_HANDLE,
    null,
    CENTER_HANDLE,
    null,
  ]);

  const lateListener = vi.fn();
  const lateUnsubscribe = fixture.controller.onHandleHoverChange(lateListener);
  expect(lateListener).not.toHaveBeenCalled();
  expect(() => {
    lateUnsubscribe();
    lateUnsubscribe();
  }).not.toThrow();
});

test("a throwing initial handle subscriber is rolled back", () => {
  const fixture = createFixture();
  const throwing = vi.fn(() => { throw new Error("initial delivery failed"); });

  expect(() => fixture.controller.onHandleHoverChange(throwing))
    .toThrow("initial delivery failed");

  const healthy = vi.fn();
  fixture.controller.onHandleHoverChange(healthy);
  fixture.controller.setEnabled(true);
  movePointer(fixture.domElement);

  expect(throwing).toHaveBeenCalledOnce();
  expect(healthy.mock.calls.map(([handle]) => handle)).toEqual([null, CENTER_HANDLE]);
});

test("a throwing handle subscriber is reported without blocking later subscribers", () => {
  const fixture = createFixture();
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const throwing = vi.fn((handle) => {
    if (handle) throw new Error("transition delivery failed");
  });
  const healthy = vi.fn();
  fixture.controller.onHandleHoverChange(throwing);
  fixture.controller.onHandleHoverChange(healthy);

  fixture.controller.setEnabled(true);
  expect(() => movePointer(fixture.domElement)).not.toThrow();

  expect(healthy).toHaveBeenLastCalledWith(CENTER_HANDLE);
  expect(reported).toHaveBeenCalledWith(
    "Cutaway handle hover subscriber failed",
    expect.any(Error),
  );
  reported.mockRestore();
});

test("a subscriber added during fanout receives only its immediate current delivery", () => {
  const fixture = createFixture();
  const late = vi.fn();
  fixture.controller.onHandleHoverChange((handle) => {
    if (handle === CENTER_HANDLE) fixture.controller.onHandleHoverChange(late);
  });

  fixture.controller.setEnabled(true);
  movePointer(fixture.domElement);

  expect(late).toHaveBeenCalledOnce();
  expect(late).toHaveBeenCalledWith(CENTER_HANDLE);
});

test("unsubscribing a later subscriber during fanout skips its snapshot turn", () => {
  const fixture = createFixture();
  const later = vi.fn();
  let unsubscribeLater;
  fixture.controller.onHandleHoverChange((handle) => {
    if (handle === CENTER_HANDLE) unsubscribeLater();
  });
  unsubscribeLater = fixture.controller.onHandleHoverChange(later);

  fixture.controller.setEnabled(true);
  movePointer(fixture.domElement);

  expect(later.mock.calls.map(([handle]) => handle)).toEqual([null]);
});

test("throwing final subscribers cannot interrupt disable or dispose cleanup", () => {
  const disableFixture = createFixture();
  const disabledPart = addSubpart(disableFixture);
  disableFixture.controller.setEnabled(true);
  movePointer(disableFixture.domElement);
  const disableError = vi.spyOn(console, "error").mockImplementation(() => {});
  disableFixture.controller.onHandleHoverChange((handle) => {
    if (handle == null) throw new Error("disable delivery failed");
  });

  expect(() => disableFixture.controller.setEnabled(false)).not.toThrow();
  expect(disableFixture.controller.isEnabled).toBe(false);
  expect(disableFixture.renderer.localClippingEnabled).toBe(false);
  expect(disabledPart.mesh.material).toBe(disabledPart.material);
  expect(findGizmo(disableFixture.scene).visible).toBe(false);

  const disposeFixture = createFixture();
  disposeFixture.controller.setEnabled(true);
  disposeFixture.controller.renderOverlay(disposeFixture.renderer, disposeFixture.camera);
  movePointer(disposeFixture.domElement);
  const handleRoot = disposeFixture.renderer.render.mock.calls[0][0].children[0];
  const resources = new Set();
  handleRoot.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    if (object.material) resources.add(object.material);
  });
  const disposals = [...resources].map((resource) => vi.spyOn(resource, "dispose"));
  disposeFixture.controller.onHandleHoverChange((handle) => {
    if (handle == null) throw new Error("dispose delivery failed");
  });

  expect(() => disposeFixture.controller.dispose()).not.toThrow();
  expect(disposeFixture.controller.isEnabled).toBe(false);
  expect(handleRoot.parent).toBeNull();
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
  expect(disableError).toHaveBeenCalledTimes(2);
  disableError.mockRestore();
});

test("reentrant dispose from final hover delivery does not double-dispose resources", () => {
  const fixture = createFixture();
  addSubpart(fixture);
  fixture.controller.setEnabled(true);
  fixture.controller.renderOverlay(fixture.renderer, fixture.camera);
  movePointer(fixture.domElement);
  const handleRoot = fixture.renderer.render.mock.calls[0][0].children[0];
  const resources = new Set();
  handleRoot.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    if (object.material) resources.add(object.material);
  });
  const disposals = [...resources].map((resource) => vi.spyOn(resource, "dispose"));
  const capDispose = vi.spyOn(findCap(fixture.scene).geometry, "dispose");
  fixture.controller.onHandleHoverChange((handle) => {
    if (handle == null) fixture.controller.dispose();
  });

  fixture.controller.dispose();

  expect(handleRoot.parent).toBeNull();
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
  expect(capDispose).toHaveBeenCalledOnce();
});

test("dispose during hover fanout still delivers final null before clearing subscribers", () => {
  const fixture = createFixture();
  const disposing = vi.fn((handle) => {
    if (handle === CENTER_HANDLE) fixture.controller.dispose();
  });
  const later = vi.fn();
  fixture.controller.onHandleHoverChange(disposing);
  fixture.controller.onHandleHoverChange(later);
  fixture.controller.setEnabled(true);

  movePointer(fixture.domElement);

  expect(disposing.mock.calls.map(([handle]) => handle)).toEqual([
    null,
    CENTER_HANDLE,
    null,
  ]);
  expect(later.mock.calls.map(([handle]) => handle)).toEqual([null, null]);
});

test("empty bounds refuse activation without changing materials or scheduling fade", () => {
  const fixture = createFixture({ box: new THREE.Box3() });
  const { mesh, material } = addSubpart(fixture);

  expect(fixture.controller.setEnabled(true)).toBe(false);

  expect(fixture.controller.isEnabled).toBe(false);
  expect(fixture.renderer.localClippingEnabled).toBe(false);
  expect(mesh.material).toBe(material);
  expect(fixture.timer.entries).toHaveLength(0);
  expect(findGizmo(fixture.scene).visible).toBe(false);
});

test("restores a borrowed renderer clipping flag after an enabled session", () => {
  const fixture = createFixture({ localClippingEnabled: true });

  expect(fixture.controller.setEnabled(true)).toBe(true);
  expect(fixture.renderer.localClippingEnabled).toBe(true);
  expect(fixture.controller.setEnabled(false)).toBe(true);
  expect(fixture.renderer.localClippingEnabled).toBe(true);

  expect(fixture.controller.setEnabled(true)).toBe(true);
  fixture.controller.dispose();
  expect(fixture.renderer.localClippingEnabled).toBe(true);
});

test("disable and dispose without activation leave the renderer clipping flag untouched", () => {
  const disabled = createFixture({ localClippingEnabled: true });
  expect(disabled.controller.setEnabled(false)).toBe(true);
  expect(disabled.renderer.localClippingEnabled).toBe(true);

  const disposed = createFixture({ localClippingEnabled: true });
  disposed.controller.dispose();
  expect(disposed.renderer.localClippingEnabled).toBe(true);
});

test("renderOverlay does nothing while disabled or disposed", () => {
  const fixture = createFixture();

  expect(fixture.controller.renderOverlay(fixture.renderer, fixture.camera)).toBe(false);
  expect(fixture.renderer.clearDepth).not.toHaveBeenCalled();
  expect(fixture.renderer.render).not.toHaveBeenCalled();

  fixture.controller.dispose();

  expect(fixture.controller.renderOverlay(fixture.renderer, fixture.camera)).toBe(false);
  expect(fixture.renderer.clearDepth).not.toHaveBeenCalled();
  expect(fixture.renderer.render).not.toHaveBeenCalled();
});

test.each([true, false])("renderOverlay clears only depth, renders the handle scene, and restores autoClear=%s", (autoClear) => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  fixture.renderer.autoClear = autoClear;
  const calls = [];
  fixture.renderer.clearDepth.mockImplementation(() => {
    expect(fixture.renderer.autoClear).toBe(false);
    calls.push("clearDepth");
  });
  fixture.renderer.render.mockImplementation((scene, camera) => {
    expect(fixture.renderer.autoClear).toBe(false);
    calls.push({ scene, camera });
  });

  expect(fixture.controller.renderOverlay(fixture.renderer, fixture.camera)).toBe(true);

  expect(calls[0]).toBe("clearDepth");
  expect(calls[1].camera).toBe(fixture.camera);
  expect(calls[1].scene).toBeInstanceOf(THREE.Scene);
  expect(calls[1].scene).not.toBe(fixture.scene);
  expect(calls[1].scene.children).toHaveLength(1);
  expect(calls[1].scene.children[0].isGroup).toBe(true);
  expect(fixture.renderer.autoClear).toBe(autoClear);
  expect(findGizmo(fixture.scene).children.some((child) => child.isGroup)).toBe(false);
});

test.each([true, false])("renderOverlay restores autoClear=%s and propagates a renderer failure", (autoClear) => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  fixture.renderer.autoClear = autoClear;
  fixture.renderer.clearDepth.mockImplementation(() => {
    expect(fixture.renderer.autoClear).toBe(false);
  });
  fixture.renderer.render.mockImplementation(() => {
    expect(fixture.renderer.autoClear).toBe(false);
    throw new Error("overlay failed");
  });

  expect(() => fixture.controller.renderOverlay(fixture.renderer, fixture.camera))
    .toThrow("overlay failed");
  expect(fixture.renderer.clearDepth).toHaveBeenCalledOnce();
  expect(fixture.renderer.autoClear).toBe(autoClear);
});

test("dispose empties the owned overlay scene and disposes handle resources only once", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  fixture.controller.renderOverlay(fixture.renderer, fixture.camera);
  const overlayScene = fixture.renderer.render.mock.calls[0][0];
  const handleRoot = overlayScene.children[0];
  const resources = new Set();
  handleRoot.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    if (object.material) resources.add(object.material);
  });
  const disposals = [...resources].map((resource) => vi.spyOn(resource, "dispose"));

  fixture.controller.dispose();
  fixture.controller.dispose();

  expect(overlayScene.children).toHaveLength(0);
  expect(handleRoot.parent).toBeNull();
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
});

test("repeated enable does not overwrite the renderer clipping snapshot", () => {
  const fixture = createFixture({ localClippingEnabled: true });

  expect(fixture.controller.setEnabled(true)).toBe(true);
  fixture.renderer.localClippingEnabled = false;
  expect(fixture.controller.setEnabled(true)).toBe(true);
  expect(fixture.controller.setEnabled(false)).toBe(true);

  expect(fixture.renderer.localClippingEnabled).toBe(true);
});

test("enable sections visible subparts at a centered camera-facing plane", () => {
  const fixture = createFixture();
  const { mesh, material, edgeLines, edgeMaterial } = addSubpart(fixture);
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);

  expect(fixture.controller.setEnabled(true)).toBe(true);

  const plane = auxiliary.clippingPlanes[0];
  const center = new THREE.Vector3();
  expect(plane).toBeInstanceOf(THREE.Plane);
  expect(plane.distanceToPoint(center)).toBeCloseTo(0);
  expect(plane.normal.dot(fixture.camera.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(1);
  expect(fixture.renderer.localClippingEnabled).toBe(true);
  expect(mesh.material).not.toBe(material);
  expect(mesh.material.clippingPlanes).toEqual([plane]);
  expect(edgeLines.material).not.toBe(edgeMaterial);
  expect(stencilPasses(mesh).every((entry) => entry.visible)).toBe(true);
  expect(findCap(fixture.scene).visible).toBe(true);
  expect(findGizmo(fixture.scene).visible).toBe(true);
});

test("flip reverses point visibility without moving the geometric plane", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);
  const plane = auxiliary.clippingPlanes[0];
  const coplanar = plane.coplanarPoint(new THREE.Vector3());
  const before = coplanar.clone();
  const survivingPoint = coplanar.clone().addScaledVector(plane.normal, 2);

  expect(fixture.controller.isPointVisible(survivingPoint)).toBe(true);
  expect(fixture.controller.flip()).toBe(true);
  expect(fixture.controller.isPointVisible(survivingPoint)).toBe(false);
  expect(plane.coplanarPoint(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-9);
});

test("enable, flip, and reset synchronize the visual-only ghost offset without moving the plane pose", () => {
  const fixture = createFixture();
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);

  fixture.controller.setEnabled(true);

  const plane = auxiliary.clippingPlanes[0];
  const gizmo = findGizmo(fixture.scene);
  const fill = gizmo.children.find((child) => child.isMesh);
  const border = gizmo.children.find((child) => child.isLineLoop);
  const groupPosition = gizmo.position.clone();
  const planePoint = plane.coplanarPoint(new THREE.Vector3());
  expect(fill.position.z).toBeLessThan(0);
  expect(border.position.z).toBe(fill.position.z);

  fixture.controller.flip();

  expect(fill.position.z).toBeGreaterThan(0);
  expect(border.position.z).toBe(fill.position.z);
  expect(gizmo.position.toArray()).toEqual(groupPosition.toArray());
  expect(plane.coplanarPoint(new THREE.Vector3()).distanceTo(planePoint)).toBeLessThan(1e-9);

  fixture.controller.reset();

  expect(fill.position.z).toBeLessThan(0);
  expect(border.position.z).toBe(fill.position.z);
  expect(gizmo.position.toArray()).toEqual(groupPosition.toArray());
  expect(plane.coplanarPoint(new THREE.Vector3()).distanceTo(planePoint)).toBeLessThan(1e-9);
});

test("reset recomputes the pose from changed world bounds and camera", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);
  const plane = auxiliary.clippingPlanes[0];
  const identity = plane;
  fixture.setBounds(new THREE.Box3(
    new THREE.Vector3(8, 16, 24),
    new THREE.Vector3(12, 24, 36),
  ));
  fixture.camera.position.set(20, 20, 30);
  fixture.camera.lookAt(10, 20, 30);
  fixture.camera.updateMatrixWorld(true);

  expect(fixture.controller.reset()).toBe(true);

  expect(plane).toBe(identity);
  expect(plane.distanceToPoint(new THREE.Vector3(10, 20, 30))).toBeCloseTo(0);
  expect(plane.normal.dot(fixture.camera.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(1);
});

test("setVisible isolates section helpers to selected names", () => {
  const fixture = createFixture();
  const first = addSubpart(fixture, "first");
  const second = addSubpart(fixture, "second");
  fixture.controller.setVisible(["second"]);
  fixture.controller.setEnabled(true);

  expect(stencilPasses(first.mesh).every((entry) => !entry.visible)).toBe(true);
  expect(stencilPasses(second.mesh).every((entry) => entry.visible)).toBe(true);

  fixture.controller.setVisible(new Set(["first"]));
  expect(stencilPasses(first.mesh).every((entry) => entry.visible)).toBe(true);
  expect(stencilPasses(second.mesh).every((entry) => !entry.visible)).toBe(true);
});

test("geometry replacement is shared by stencil passes and remains caller-owned", () => {
  const fixture = createFixture();
  const { mesh, geometry } = addSubpart(fixture);
  const replacement = new THREE.SphereGeometry(3);
  const originalDispose = vi.spyOn(geometry, "dispose");
  const replacementDispose = vi.spyOn(replacement, "dispose");

  fixture.controller.updateGeometry("body", replacement);

  expect(stencilPasses(mesh).map((entry) => entry.geometry)).toEqual([replacement, replacement]);
  fixture.controller.dispose();
  expect(originalDispose).not.toHaveBeenCalled();
  expect(replacementDispose).not.toHaveBeenCalled();
});

test("geometry-only updates preserve prepared clipped materials without disposal", () => {
  const fixture = createFixture();
  const { mesh, edgeLines } = addSubpart(fixture);
  const replacementGeometry = new THREE.SphereGeometry(2);
  fixture.controller.setEnabled(true);
  const preparedMeshMaterial = mesh.material;
  const preparedEdgeMaterial = edgeLines.material;
  const meshDispose = vi.spyOn(preparedMeshMaterial, "dispose");
  const edgeDispose = vi.spyOn(preparedEdgeMaterial, "dispose");
  fixture.controller.setEnabled(false);

  fixture.controller.updateGeometry("body", replacementGeometry);
  fixture.controller.setEnabled(true);

  expect(mesh.material).toBe(preparedMeshMaterial);
  expect(edgeLines.material).toBe(preparedEdgeMaterial);
  expect(stencilPasses(mesh).map((entry) => entry.geometry)).toEqual([
    replacementGeometry,
    replacementGeometry,
  ]);
  expect(meshDispose).not.toHaveBeenCalled();
  expect(edgeDispose).not.toHaveBeenCalled();
});

test("viewport size updates prepared cutaway LineMaterial clones", () => {
  const fixture = createFixture();
  const edgeMaterial = new LineMaterial({ color: 0x111111, linewidth: 1 });
  edgeMaterial.resolution.set(1, 1);
  const { edgeLines } = addSubpart(fixture, "body", { edgeMaterial });

  expect(fixture.controller.setViewportSize).toBeTypeOf("function");
  fixture.controller.setViewportSize(640, 480);
  fixture.controller.setEnabled(true);
  expect(edgeLines.material).not.toBe(edgeMaterial);
  expect(edgeLines.material.resolution.toArray()).toEqual([640, 480]);

  fixture.controller.setViewportSize(900, 700);
  expect(edgeLines.material.resolution.toArray()).toEqual([900, 700]);
});

test("viewport screen scale is retained for existing, replacement, and future caps", () => {
  const fixture = createFixture();
  fixture.controller.setViewportSize(640, 480, 2);

  const first = addSubpart(fixture, "body");
  expect(findCaps(fixture.scene)).toHaveLength(1);
  expect(findCap(fixture.scene).material.uniforms.uPixelRatio.value).toBe(2);

  fixture.controller.setViewportSize(900, 700, 1.5);
  expect(findCap(fixture.scene).material.uniforms.uPixelRatio.value).toBe(1.5);

  const replacementMesh = new THREE.Mesh(
    first.geometry,
    new THREE.MeshStandardMaterial({ color: 0xabcdef }),
  );
  const replacementLines = new THREE.LineSegments(
    first.edgeGeometry,
    new THREE.LineBasicMaterial({ color: 0x222222 }),
  );
  fixture.scene.add(replacementMesh, replacementLines);
  fixture.controller.setSubpart("body", replacementMesh, replacementLines);

  expect(findCaps(fixture.scene)).toHaveLength(1);
  expect(findCap(fixture.scene).material.uniforms.uPixelRatio.value).toBe(1.5);

  addSubpart(fixture, "detail");
  expect(findCaps(fixture.scene)).toHaveLength(2);
  expect(findCaps(fixture.scene).map(
    (cap) => cap.material.uniforms.uPixelRatio.value,
  )).toEqual([1.5, 1.5]);

  fixture.controller.setViewportSize(320, 240, Number.NaN);
  expect(findCaps(fixture.scene).map(
    (cap) => cap.material.uniforms.uPixelRatio.value,
  )).toEqual([1, 1]);
});

test("enable, flip, and reset preserve screen-space hatch sizing without model density state", () => {
  const fixture = createFixture();
  addSubpart(fixture);
  fixture.controller.setViewportSize(640, 480, 2);

  fixture.controller.setEnabled(true);
  const cap = findCap(fixture.scene);
  expect(cap.material.uniforms.uPixelRatio.value).toBe(2);
  expect(cap.material.uniforms.uScale).toBeUndefined();
  expect(cap.material.userData.setHatch).toBeUndefined();

  fixture.controller.flip();
  expect(cap.material.uniforms.uPixelRatio.value).toBe(2);
  expect(cap.material.uniforms.uScale).toBeUndefined();

  fixture.controller.reset();
  expect(cap.material.uniforms.uPixelRatio.value).toBe(2);
  expect(cap.material.uniforms.uScale).toBeUndefined();
  expect(cap.material.userData.setHatch).toBeUndefined();
});

test("theme refresh forwards exact feature-edge hatch colors and preserves exact originals", () => {
  const fixture = createFixture();
  const { mesh, material, edgeLines, edgeMaterial } = addSubpart(fixture);
  const cap = findCap(fixture.scene);
  fixture.controller.setEnabled(true);
  const oldClippedMesh = mesh.material;
  const oldClippedEdge = edgeLines.material;
  const oldMeshDispose = vi.spyOn(oldClippedMesh, "dispose");
  const oldEdgeDispose = vi.spyOn(oldClippedEdge, "dispose");
  material.color.set(0x16a34a);
  edgeMaterial.color.set(0xf8fafc);

  fixture.controller.setTheme("dark", 0x1c232d);
  expect(cap.material.uniforms.uInk.value.getHex()).toBe(0x1c232d);

  fixture.controller.setTheme("light", 0x33414f);

  expect(oldMeshDispose).toHaveBeenCalledOnce();
  expect(oldEdgeDispose).toHaveBeenCalledOnce();
  expect(mesh.material).not.toBe(oldClippedMesh);
  expect(mesh.material.color.getHex()).toBe(0x16a34a);
  expect(edgeLines.material).not.toBe(oldClippedEdge);
  expect(edgeLines.material.color.getHex()).toBe(0xf8fafc);
  expect(cap.material.uniforms.uInk.value.getHex()).toBe(0x33414f);
  fixture.controller.setEnabled(false);
  expect(mesh.material).toBe(material);
  expect(edgeLines.material).toBe(edgeMaterial);
});

test("uses the explicitly injected initial edge color for the first subpart", () => {
  const fixture = createFixture({ edgeColor: 0x2468ac });

  addSubpart(fixture);

  expect(findCap(fixture.scene).material.uniforms.uInk.value.getHex()).toBe(0x2468ac);
});

test("retains the feature-edge hatch color for future and replacement subparts", () => {
  const fixture = createFixture();
  fixture.controller.setTheme("light", 0x33414f);

  addSubpart(fixture);
  const firstCap = findCap(fixture.scene);
  expect(firstCap.material.uniforms.uInk.value.getHex()).toBe(0x33414f);

  addSubpart(fixture);
  const replacementCap = findCap(fixture.scene);
  expect(replacementCap).not.toBe(firstCap);
  expect(replacementCap.material.uniforms.uInk.value.getHex()).toBe(0x33414f);
});

test("auxiliary material registration preserves borrowed clipping state across sessions", () => {
  const fixture = createFixture();
  const material = new THREE.MeshBasicMaterial();
  const foreignPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -3);
  const originalClippingPlanes = [foreignPlane];
  material.clippingPlanes = originalClippingPlanes;
  const initialVersion = material.version;
  const unregister = fixture.controller.registerClippableMaterial(material);
  const duplicateUnregister = fixture.controller.registerClippableMaterial(material);
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
  expect(material.version).toBe(initialVersion);

  fixture.controller.setEnabled(true);
  const plane = material.clippingPlanes[0];
  expect(material.clippingPlanes).not.toBe(originalClippingPlanes);
  expect(plane).not.toBe(foreignPlane);
  const activeVersion = material.version;
  fixture.controller.flip();
  fixture.controller.reset();
  expect(material.clippingPlanes).toEqual([plane]);
  expect(material.version).toBe(activeVersion);

  fixture.controller.setEnabled(false);
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
  expect(material.version).toBe(activeVersion + 1);
  fixture.controller.setEnabled(true);
  expect(material.clippingPlanes).toEqual([plane]);
  expect(material.version).toBe(activeVersion + 2);

  duplicateUnregister();
  expect(material.clippingPlanes).toEqual([plane]);
  expect(material.version).toBe(activeVersion + 2);
  unregister();
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
  expect(material.version).toBe(activeVersion + 3);
  unregister();
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
  expect(material.version).toBe(activeVersion + 3);
});

test.each([null, []])(
  "dispose restores an exact %s auxiliary clipping value",
  (originalClippingPlanes) => {
    const fixture = createFixture();
    const material = new THREE.MeshBasicMaterial();
    material.clippingPlanes = originalClippingPlanes;
    fixture.controller.registerClippableMaterial(material);
    fixture.controller.setEnabled(true);

    expect(material.clippingPlanes).not.toBe(originalClippingPlanes);
    fixture.controller.dispose();

    expect(material.clippingPlanes).toBe(originalClippingPlanes);
  },
);

test("failed activation preserves renderer and auxiliary clipping state", () => {
  const originalClippingPlanes = [new THREE.Plane()];
  const fixture = createFixture({
    box: new THREE.Box3(),
    localClippingEnabled: true,
  });
  const material = new THREE.MeshBasicMaterial();
  material.clippingPlanes = originalClippingPlanes;
  fixture.controller.registerClippableMaterial(material);

  expect(fixture.controller.setEnabled(true)).toBe(false);
  expect(fixture.renderer.localClippingEnabled).toBe(true);
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
});

test("updateForCamera delegates observable screen scaling to the gizmo", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  fixture.controller.renderOverlay(fixture.renderer, fixture.camera);
  const overlayScene = fixture.renderer.render.mock.calls[0][0];
  const handleRoot = overlayScene.children[0];
  fixture.controller.updateForCamera();
  const nearScale = handleRoot.scale.x;

  fixture.camera.position.z = 80;
  fixture.camera.updateMatrixWorld(true);
  fixture.controller.updateForCamera();

  expect(handleRoot.scale.x).toBeGreaterThan(nearScale);
});

test("updateForCamera skips viewport work while the cutaway is disabled", () => {
  const fixture = createFixture();
  const getViewport = vi.spyOn(fixture.domElement, "getBoundingClientRect");

  fixture.controller.updateForCamera();
  expect(getViewport).not.toHaveBeenCalled();

  fixture.controller.setEnabled(true);
  getViewport.mockClear();
  fixture.controller.updateForCamera();
  expect(getViewport).toHaveBeenCalledOnce();

  fixture.controller.setEnabled(false);
  getViewport.mockClear();
  fixture.controller.updateForCamera();
  expect(getViewport).not.toHaveBeenCalled();
});

test("active appearance schedules an 800ms fade and disable cancels it", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const gizmo = findGizmo(fixture.scene);
  const fill = gizmo.children.find((child) => child.isMesh);
  expect(fill.material.opacity).toBeGreaterThan(0.1);
  expect(fixture.timer.entries).toHaveLength(1);
  expect(fixture.timer.entries[0].delay).toBe(800);

  fixture.timer.entries[0].callback();
  expect(fill.material.opacity).toBeLessThan(0.1);
  fixture.controller.reset();
  const pending = fixture.timer.entries.at(-1);
  fixture.controller.setEnabled(false);

  expect(pending.cancelled).toBe(true);
  expect(gizmo.visible).toBe(false);
});

test("hover and focus restore active appearance and reschedule fade without moving the plane", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const gizmo = findGizmo(fixture.scene);
  const fill = gizmo.children.find((child) => child.isMesh);
  fixture.timer.entries[0].callback();
  expect(fill.material.opacity).toBeLessThan(0.1);

  fixture.domElement.dispatchEvent(new PointerEvent("pointerenter"));

  expect(fill.material.opacity).toBeGreaterThan(0.1);
  expect(fixture.timer.entries).toHaveLength(2);
  expect(fixture.timer.entries[1].delay).toBe(800);
  fixture.timer.entries[1].callback();
  expect(fill.material.opacity).toBeLessThan(0.1);

  fixture.domElement.dispatchEvent(new FocusEvent("focus"));

  expect(fill.material.opacity).toBeGreaterThan(0.1);
  expect(fixture.timer.entries).toHaveLength(3);
  expect(fixture.timer.entries[2].delay).toBe(800);
});

test("replacing a subpart refreshes source display properties and restores exact materials", () => {
  const fixture = createFixture();
  const first = addSubpart(fixture);
  const firstOwned = first.mesh.children.map((entry) => entry.material);
  const replacementMaterial = new THREE.MeshStandardMaterial({
    color: 0xf97316,
    opacity: 0.4,
    transparent: true,
    depthWrite: false,
  });
  const replacementMesh = new THREE.Mesh(first.geometry, replacementMaterial);
  const replacementLineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
  const replacementLines = new THREE.LineSegments(first.edgeGeometry, replacementLineMaterial);
  fixture.scene.add(replacementMesh, replacementLines);
  const firstOwnedDisposals = firstOwned.map((material) => vi.spyOn(material, "dispose"));

  fixture.controller.setSubpart("body", replacementMesh, replacementLines);
  fixture.controller.setEnabled(true);

  expect(firstOwnedDisposals.every((spy) => spy.mock.calls.length === 1)).toBe(true);
  expect(findCap(fixture.scene).material.uniforms.uBase.value.getHex()).toBe(0xf97316);
  expect(findCap(fixture.scene).material.uniforms.uOpacity.value).toBe(0.4);
  fixture.controller.setEnabled(false);
  expect(replacementMesh.material).toBe(replacementMaterial);
  expect(replacementLines.material).toBe(replacementLineMaterial);
});

test("disable restores exact source state and dispose is idempotent and ownership-safe", () => {
  const fixture = createFixture();
  const { geometry, material, mesh, edgeGeometry, edgeMaterial, edgeLines } = addSubpart(fixture);
  const geometryDispose = vi.spyOn(geometry, "dispose");
  const materialDispose = vi.spyOn(material, "dispose");
  const edgeGeometryDispose = vi.spyOn(edgeGeometry, "dispose");
  const edgeMaterialDispose = vi.spyOn(edgeMaterial, "dispose");
  fixture.controller.setEnabled(true);

  expect(fixture.controller.setEnabled(false)).toBe(true);
  expect(fixture.controller.isEnabled).toBe(false);
  expect(fixture.renderer.localClippingEnabled).toBe(false);
  expect(mesh.material).toBe(material);
  expect(edgeLines.material).toBe(edgeMaterial);

  fixture.controller.dispose();
  fixture.controller.dispose();
  expect(geometryDispose).not.toHaveBeenCalled();
  expect(materialDispose).not.toHaveBeenCalled();
  expect(edgeGeometryDispose).not.toHaveBeenCalled();
  expect(edgeMaterialDispose).not.toHaveBeenCalled();
});

test("world-space recentered parent bounds place the initial plane through the world-box center", () => {
  const parent = new THREE.Group();
  parent.position.set(12, -7, 5);
  parent.rotation.set(0.4, 0.7, -0.2);
  const child = new THREE.Mesh(new THREE.BoxGeometry(3, 5, 7));
  child.position.set(4, 2, -3);
  parent.add(child);
  parent.updateWorldMatrix(true, true);
  const worldBounds = new THREE.Box3().setFromObject(parent);
  const fixture = createFixture({ box: worldBounds });
  fixture.controller.setEnabled(true);
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);

  expect(auxiliary.clippingPlanes[0].distanceToPoint(
    worldBounds.getCenter(new THREE.Vector3()),
  )).toBeCloseTo(0);
});

test("viewer supplies visible transformed meshes as world-space cutaway bounds", async () => {
  class FakeRenderer {
    constructor(options) {
      this.options = options;
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio(value) { this.pixelRatio = value; }
    getPixelRatio() { return this.pixelRatio; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    dispose() {}
  }

  vi.doMock("three", async (importOriginal) => ({
    ...(await importOriginal()),
    WebGLRenderer: FakeRenderer,
  }));

  let cutawayOptions;
  const fakeCutaway = {
    isSupported: true,
    isEnabled: false,
    setSubpart: vi.fn(),
    updateGeometry: vi.fn(),
    setVisible: vi.fn(),
    setEnabled: vi.fn((on) => {
      fakeCutaway.isEnabled = !!on;
      return true;
    }),
    flip: vi.fn(),
    reset: vi.fn(),
    setTheme: vi.fn(),
    setViewportSize: vi.fn(),
    isPointVisible: vi.fn(() => true),
    registerClippableMaterial: vi.fn(),
    updateForCamera: vi.fn(),
    dispose: vi.fn(),
  };
  vi.doMock("../../src/framework/cutaway.js", () => ({
    createCutaway: vi.fn((options) => {
      cutawayOptions = options;
      return fakeCutaway;
    }),
  }));

  const { createViewer } = await import("../../src/framework/viewer.js");
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  document.body.appendChild(container);
  const viewer = createViewer(container, {
    meta: {},
    parts: { body: {}, hidden: {} },
  });
  const payload = (offset) => ({
    positions: new Float32Array([
      offset, 0, 0,
      offset + 2, 0, 0,
      offset, 4, 0,
    ]),
    triangles: 1,
  });
  viewer.setSubGeometry("body", payload(10));
  viewer.setSubGeometry("hidden", payload(100));
  viewer.showAssembly(["body"], { frame: true });

  const actual = cutawayOptions.getBounds();
  const expected = new THREE.Box3().setFromObject(viewer._subMeshes.body);

  expect(actual.min.distanceTo(expected.min)).toBeLessThan(1e-9);
  expect(actual.max.distanceTo(expected.max)).toBeLessThan(1e-9);
  expect(actual.max.x).toBeLessThan(50);
  expect(fakeCutaway.setSubpart).toHaveBeenCalledTimes(2);
  viewer.dispose();
  vi.doUnmock("three");
  vi.doUnmock("../../src/framework/cutaway.js");
});

describe("section outlines", () => {
  test("updateForCamera re-slices outlines while enabled", () => {
    const fixture = createFixture();
    const { mesh } = addSubpart(fixture);
    fixture.controller.setEnabled(true);

    const outline = fixture.controller._renderSetFor("body").outline;
    fixture.controller.updateForCamera();
    expect(outline.object.visible).toBe(true);

    // A world-fixed plane with a moved part still changes the section.
    const before = outline.object.geometry;
    mesh.position.set(0, 0, 1.5);
    mesh.updateMatrixWorld(true);
    fixture.controller.updateForCamera();
    expect(outline.object.geometry).not.toBe(before);
  });

  test("updateForCamera does not re-slice while disabled", () => {
    const fixture = createFixture();
    addSubpart(fixture);
    // Spy on the render set, not the outline: refreshSections looks the method
    // up on the render set at call time, so a spy there is what intercepts.
    const renderSet = fixture.controller._renderSetFor("body");
    const refresh = vi.spyOn(renderSet, "refreshOutline");

    fixture.controller.updateForCamera();

    expect(refresh).not.toHaveBeenCalled();
  });

  test("flipping leaves the outline segments alone", () => {
    const fixture = createFixture();
    addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    const before = outline.object.geometry.attributes.instanceStart.data.array.slice();

    fixture.controller.flip();
    fixture.controller.updateForCamera();

    const after = outline.object.geometry.attributes.instanceStart.data.array;
    expect([...after]).toEqual([...before]);
  });

  test("outlines keep tracking the plane during a cheap drag", () => {
    let clock = 0;
    const fixture = createFixture({ now: () => (clock += 0.5) });
    addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    expect(outline.sliceCost()).toBeLessThan(OUTLINE_SLICE_BUDGET_MS);

    fixture.controller._setDragging(true);
    expect(outline.object.visible).toBe(true);
  });

  test("outlines hide for the drag when the last slice blew the budget", () => {
    let clock = 0;
    const fixture = createFixture({ now: () => (clock += 25) });
    addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    expect(outline.sliceCost()).toBeGreaterThan(OUTLINE_SLICE_BUDGET_MS);
    expect(outline.object.visible).toBe(true);

    fixture.controller._setDragging(true);
    expect(outline.object.visible).toBe(false);

    fixture.controller._setDragging(false);
    expect(outline.object.visible).toBe(true);
  });

  test("deselecting an expensive subpart does not suppress a cheap sibling's outline", () => {
    // Costs are attributed to whichever slice is running when they land, so
    // the second `now()` call of each pair (the one that lands on the "end"
    // timestamp) carries the intended cost: 50ms for the first subpart's
    // slice, 1ms for the second's.
    const increments = [1, 50, 1, 1];
    let index = 0;
    let clock = 0;
    const now = () => {
      clock += increments[index] ?? 1;
      index += 1;
      return clock;
    };
    const fixture = createFixture({ now });
    addSubpart(fixture, "expensive");
    addSubpart(fixture, "cheap");
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const expensiveOutline = fixture.controller._renderSetFor("expensive").outline;
    const cheapOutline = fixture.controller._renderSetFor("cheap").outline;
    expect(expensiveOutline.sliceCost()).toBeGreaterThan(OUTLINE_SLICE_BUDGET_MS);
    expect(cheapOutline.sliceCost()).toBeLessThan(OUTLINE_SLICE_BUDGET_MS);

    // Deselect the expensive subpart. Its outline is now hidden, but its
    // last-measured cost is still sitting in the map, stale.
    fixture.controller.setVisible(["cheap"]);
    expect(cheapOutline.object.visible).toBe(true);

    // Only the cheap subpart is visible, and it is well under budget on its
    // own - the stale cost of the hidden subpart must not count against it.
    fixture.controller._setDragging(true);
    expect(cheapOutline.object.visible).toBe(true);
  });

  test("a drag that ends re-slices whatever moved while outlines were hidden", () => {
    let clock = 0;
    const fixture = createFixture({ now: () => (clock += 25) });
    const { mesh } = addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    fixture.controller._setDragging(true);
    const stale = outline.object.geometry;
    mesh.position.set(0, 0, 1.5);
    mesh.updateMatrixWorld(true);
    fixture.controller._setDragging(false);

    expect(outline.object.geometry).not.toBe(stale);
  });

  // Every other suppression test above drives dragging through the
  // `_setDragging` test hook, which bypasses the gizmo entirely. The only
  // thing that actually wires the gizmo to drag suppression in production is
  // `onDragChange: setDragging` in the createCutawayGizmo call — a real
  // pointer drag has to prove that connection, or a deleted wire would pass
  // every test above and still ship dead.
  test("a real pointer drag on a gizmo handle suppresses an over-budget outline", () => {
    let clock = 0;
    const fixture = createFixture({ now: () => (clock += 25) });
    addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    expect(outline.sliceCost()).toBeGreaterThan(OUTLINE_SLICE_BUDGET_MS);
    expect(outline.object.visible).toBe(true);

    // (100, 100) is the viewport center, where the "handle hover subscriptions"
    // test above confirms CENTER_HANDLE ("rotate-y") picks up a real pointer.
    fixture.domElement.dispatchEvent(new PointerEvent("pointerdown", {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
    }));

    expect(outline.object.visible).toBe(false);

    fixture.domElement.dispatchEvent(new PointerEvent("pointerup", {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
    }));

    expect(outline.object.visible).toBe(true);
  });
});

describe("setCamera", () => {
  test("re-points the cutaway at a swapped camera", () => {
    // A cutaway built against one camera must follow a projection swap, or its
    // plane math and its gizmo keep sizing against a camera nobody renders.
    const { controller } = createFixture();
    const ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
    ortho.position.set(0, 0, 20);
    ortho.lookAt(0, 0, 0);
    ortho.updateMatrixWorld(true);
    expect(() => controller.setCamera(ortho)).not.toThrow();
    // The swap must survive a real render pass, which is where a stale camera
    // reference would surface as a wrong section rather than an exception.
    expect(() => controller.renderOverlay(makeRenderer(), ortho)).not.toThrow();
  });

  test("ignores a null camera rather than blanking its reference", () => {
    const { controller, camera } = createFixture();
    controller.setCamera(null);
    expect(() => controller.renderOverlay(makeRenderer(), camera)).not.toThrow();
  });
});

describe("getState / setState", () => {
  // A remount is how partforge-cloud applies every edit, so a cutaway that
  // cannot cross one closes itself on every agent turn. These pin the carry.
  const boxFrom = (max) => new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(...max));

  test("reports nothing to carry while disabled", () => {
    const { controller } = createFixture();
    expect(controller.getState()).toEqual({ enabled: false, flipped: false, pose: null });
  });

  test("round-trips the plane's pose and flip as plain JSON", () => {
    const fixture = createFixture({ box: boxFrom([10, 8, 6]) });
    addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.flip();

    const state = fixture.controller.getState();
    expect(state.enabled).toBe(true);
    expect(state.flipped).toBe(true);
    expect(state.pose.position).toEqual([5, 4, 3]); // the box's centre
    expect(state.pose.quaternion).toHaveLength(4);
    // The snapshot outlives the mount that produced it, so a live THREE object
    // would point into a disposed scene — and a host free to store or post it
    // needs something structured-cloneable.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  test("restores the pose onto a part whose bounds changed, re-deriving only the size", () => {
    const before = createFixture({ box: boxFrom([10, 8, 6]) });
    addSubpart(before);
    before.controller.setEnabled(true);
    const carried = before.controller.getState();

    // The rebuild: the user's cut, against a part twice the size.
    const grown = boxFrom([20, 16, 12]);
    const after = createFixture({ box: grown });
    addSubpart(after);
    expect(after.controller.setState(carried)).toBe(true);

    const restored = after.controller.getState();
    expect(restored.enabled).toBe(true);
    expect(restored.pose.position).toEqual(carried.pose.position);
    expect(restored.pose.quaternion).toEqual(carried.pose.quaternion);
    // The cap is sized for the NEW geometry, not the part the snapshot came from.
    expect(findCap(after.scene).scale.x).toBeCloseTo(cutawayPoseSize(grown));
  });

  test("carries the flip, which decides which half survives", () => {
    const box = boxFrom([10, 8, 6]);
    const before = createFixture({ box });
    addSubpart(before);
    before.controller.setEnabled(true);
    const unflipped = before.controller.getPlane().normal.clone();
    before.controller.flip();

    const after = createFixture({ box });
    addSubpart(after);
    after.controller.setState(before.controller.getState());
    expect(after.controller.getState().flipped).toBe(true);
    // Same plane, opposite keep-side: the flip is the whole difference.
    expect(after.controller.getPlane().normal.dot(unflipped)).toBeCloseTo(-1);
  });

  test("leaves the cutaway off for a snapshot taken while it was off", () => {
    const before = createFixture();
    const after = createFixture();
    addSubpart(after);
    expect(after.controller.setState(before.controller.getState())).toBe(true);
    expect(after.controller.isEnabled).toBe(false);
  });

  test("enables at the fresh pose rather than refusing a malformed snapshot", () => {
    // Fail-soft: a snapshot we cannot read still means "the user had this open".
    const box = boxFrom([10, 8, 6]);
    const fixture = createFixture({ box });
    addSubpart(fixture);
    expect(fixture.controller.setState({
      enabled: true,
      flipped: false,
      pose: { position: [Number.NaN, 0, 0], quaternion: [0, 0, 0, 1] },
    })).toBe(true);
    expect(fixture.controller.getState().pose.position).toEqual([5, 4, 3]);
  });

  test("refuses a restore the new part cannot support", () => {
    const before = createFixture({ box: boxFrom([10, 8, 6]) });
    addSubpart(before);
    before.controller.setEnabled(true);
    const carried = before.controller.getState();

    // No stencil buffer: the same refusal setEnabled gives, surfaced to the
    // caller so a host can tell "restored" from "could not".
    const unsupported = createFixture({ stencil: false });
    addSubpart(unsupported);
    expect(unsupported.controller.setState(carried)).toBe(false);
    expect(unsupported.controller.isEnabled).toBe(false);
  });
});

// onChange: anything caching a picture of the part (the view style popover's
// thumbnails) has to hear that the section changed — on, off, or moved.
test("onChange fires when the cutaway turns on or off and whenever the plane moves", () => {
  const fixture = createFixture();
  addSubpart(fixture);
  const listener = vi.fn();
  const off = fixture.controller.onChange(listener);

  fixture.controller.setEnabled(true);
  expect(listener).toHaveBeenCalled();
  listener.mockClear();

  fixture.controller.flip();
  expect(listener).toHaveBeenCalledTimes(1);
  listener.mockClear();
  fixture.controller.reset();
  expect(listener).toHaveBeenCalled();
  listener.mockClear();
  fixture.controller.setState({
    enabled: true,
    flipped: false,
    pose: { position: [1, 0, 0], quaternion: [0, 0, 0, 1] },
  });
  expect(listener).toHaveBeenCalled();
  listener.mockClear();

  fixture.controller.setEnabled(false);
  expect(listener).toHaveBeenCalledTimes(1);
  listener.mockClear();
  fixture.controller.setEnabled(false); // already off: nothing changed
  expect(listener).not.toHaveBeenCalled();

  off();
  fixture.controller.setEnabled(true);
  expect(listener).not.toHaveBeenCalled();
});

test("a throwing onChange listener is reported and does not stop the change or later listeners", () => {
  const fixture = createFixture();
  addSubpart(fixture);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const later = vi.fn();
  fixture.controller.onChange(() => { throw new Error("boom"); });
  fixture.controller.onChange(later);
  expect(fixture.controller.setEnabled(true)).toBe(true);
  expect(fixture.controller.isEnabled).toBe(true);
  expect(later).toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test("captureExcluded names the gizmo's in-scene group (the ghost plane), not the section", () => {
  const fixture = createFixture();
  addSubpart(fixture);
  expect(fixture.controller.captureExcluded).toEqual([findGizmo(fixture.scene)]);
  expect(fixture.controller.captureExcluded).not.toContain(findCap(fixture.scene));
});
