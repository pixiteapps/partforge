// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";
import { attachHoverLabels } from "../src/framework/selection/hover.js";
import {
  attachButtonTooltips,
  createTooltipPresenter,
} from "../src/framework/tooltip.js";

const part = { parts: { one: { label: "Planter", views: ["v"] } }, views: { v: {} } };
const sync = (cb) => cb(); // run raycasts synchronously in tests

function makeViewer({ featured = true, handleHover = false } = {}) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const geo = new THREE.BoxGeometry(4, 4, 4).toNonIndexed();
  if (featured) {
    const nTri = geo.getAttribute("position").count / 3;
    geo.userData.featureIds = new Uint16Array(nTri).fill(1);
    geo.userData.features = ["Drainage hole"];
  }
  const mesh = new THREE.Mesh(geo);
  mesh.name = "one";
  mesh.visible = true;
  const group = new THREE.Group();
  group.add(mesh);
  group.updateMatrixWorld(true);
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);
  const viewer = { camera, domElement, _subMeshes: { one: mesh }, _group: group };
  if (handleHover) {
    const listeners = new Set();
    const unsubscribe = vi.fn((listener) => listeners.delete(listener));
    viewer.onCutawayHandleHover = vi.fn((listener) => {
      listeners.add(listener);
      listener(null);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        unsubscribe(listener);
      };
    });
    viewer.emitCutawayHandleHover = (handle) => {
      for (const listener of listeners) listener(handle);
    };
    viewer.hoverUnsubscribe = unsubscribe;
  }
  return viewer;
}

const move = (el, x, y) => el.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function makeTooltip() {
  return {
    showPointer: vi.fn(() => Symbol("feature tooltip")),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

test("an injected presenter receives feature content and pointer coordinates", () => {
  const viewer = makeViewer();
  const tooltip = makeTooltip();
  const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });

  move(viewer.domElement, 100, 100);

  expect(tooltip.showPointer).toHaveBeenCalledWith(
    { title: "Drainage hole", subtitle: "Planter" },
    100,
    100,
  );
  hover.detach();
  expect(tooltip.dispose).not.toHaveBeenCalled();
});

test("an injected presenter receives unlabeled sub-part content", () => {
  const viewer = makeViewer({ featured: false });
  const tooltip = makeTooltip();
  const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });

  move(viewer.domElement, 100, 100);

  expect(tooltip.showPointer).toHaveBeenCalledWith(
    { title: "Planter", subtitle: "" },
    100,
    100,
  );
  hover.detach();
});

test("hide and detach use only the token returned for feature hover", () => {
  const viewer = makeViewer();
  const token = Symbol("owned feature tooltip");
  const tooltip = makeTooltip();
  tooltip.showPointer.mockReturnValue(token);
  const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });

  move(viewer.domElement, 100, 100);
  move(viewer.domElement, 1, 1);
  expect(tooltip.hide).toHaveBeenCalledOnce();
  expect(tooltip.hide).toHaveBeenCalledWith(token);

  hover.detach();
  expect(tooltip.hide).toHaveBeenCalledOnce();
  expect(tooltip.dispose).not.toHaveBeenCalled();
});

test("detach cannot hide a newer presentation from another tooltip consumer", () => {
  const viewer = makeViewer();
  const tooltip = createTooltipPresenter();
  const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });

  move(viewer.domElement, 100, 100);
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  tooltip.showAnchor({ title: "Re-frame model" }, anchor);

  hover.detach();

  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Re-frame model");
  tooltip.dispose();
});

test("feature hover restores a focused control when the pointer misses", () => {
  const viewer = makeViewer();
  const tooltip = createTooltipPresenter();
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Focused control");
  document.body.appendChild(button);
  const binding = attachButtonTooltips(tooltip, [{ element: button }]);
  const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });
  button.dispatchEvent(new FocusEvent("focus"));

  move(viewer.domElement, 100, 100);
  move(viewer.domElement, 1, 1);

  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Focused control");
  hover.detach();
  binding.detach();
  tooltip.dispose();
});

test("repeated feature moves replace their claim before restoring a focused control", () => {
  const viewer = makeViewer();
  const tooltip = createTooltipPresenter();
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Focused control");
  document.body.appendChild(button);
  const binding = attachButtonTooltips(tooltip, [{ element: button }]);
  const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });
  button.dispatchEvent(new FocusEvent("focus"));

  move(viewer.domElement, 100, 100);
  move(viewer.domElement, 110, 100);
  move(viewer.domElement, 1, 1);

  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Focused control");
  hover.detach();
  binding.detach();
  tooltip.dispose();
});

test("touch-only standalone and injected usage are inert", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  const viewer = makeViewer();
  const tooltip = makeTooltip();

  const injected = attachHoverLabels(viewer, { part, tooltip });
  const standalone = attachHoverLabels(viewer, { part });
  injected.detach();
  standalone.detach();

  expect(tooltip.dispose).not.toHaveBeenCalled();
  expect(document.getElementById("pf-hover-tip")).toBeNull();
});

test("touch-only hover still answers the whole interface", () => {
  // mount.js calls setSuppressed from measure's and annotate's mode-change
  // listeners without asking which device it is on. On a phone the old stub
  // had no such method, so every pencil tap threw inside notifyMode and the
  // listeners registered after it — the embedding app's own relay — never
  // heard the mode change (partforge-cloud: the sketch composer never opened,
  // and a Send left "couldn't send" up with the ink already discarded).
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  const hover = attachHoverLabels(makeViewer(), { part });
  expect(typeof hover.setSuppressed).toBe("function");
  expect(() => hover.setSuppressed(true)).not.toThrow();
  expect(() => hover.setSuppressed(false)).not.toThrow();
  hover.detach();
});

test("hovering a labeled feature shows 'feature · sub-part' and a highlight overlay", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Drainage hole");
  expect(tip.querySelector(".pf-hover-sub").textContent).toBe("Planter");
  // overlay mesh added as a child of the sub-mesh
  const [overlay] = viewer._subMeshes.one.children;
  expect(overlay).toBeDefined();
  expect(overlay.visible).toBe(true);
  h.detach();
});

test("the highlight overlay inherits a posed sub-part's transform", () => {
  // The overlay's geometry is a subset of the sub-part's, in the delivered mesh's
  // own frame. Parenting it to the mesh (not the group) is what makes it follow
  // viewer.setSubPose's fast-path matrix instead of drawing at the stale spot.
  const viewer = makeViewer();
  const mesh = viewer._subMeshes.one;
  mesh.matrixAutoUpdate = false;
  mesh.matrix.makeTranslation(0, 0, 1); // along the view axis, so the centre ray still hits
  viewer._group.updateMatrixWorld(true);
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);

  const overlay = mesh.children.find((c) => c.visible);
  expect(overlay).toBeDefined();
  expect(overlay.parent).toBe(mesh);
  viewer._group.updateMatrixWorld(true);
  const posed = new THREE.Vector3().setFromMatrixPosition(overlay.matrixWorld);
  expect(posed.z).toBeCloseTo(1, 5); // un-posed (group-parented) overlay would sit at z = 0
  h.detach();
  expect(mesh.children).toEqual([]);
});

test("hovering unlabeled geometry highlights the whole sub-part", () => {
  const viewer = makeViewer({ featured: false });
  const sourceGeometry = viewer._subMeshes.one.geometry;
  const disposeSourceGeometry = vi.spyOn(sourceGeometry, "dispose");
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Planter");
  const overlay = viewer._subMeshes.one.children.find((c) => c.visible);
  expect(overlay).toBeDefined();
  expect(overlay.geometry).toBe(sourceGeometry);
  h.detach();
  expect(disposeSourceGeometry).not.toHaveBeenCalled();
  disposeSourceGeometry.mockRestore();
});

test("a miss hides the tooltip and overlay", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  move(viewer.domElement, 1, 1); // corner → miss
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  h.detach();
});

test("pointerdown (orbiting) suppresses the tooltip until the next move", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  h.detach();
});

test("detach removes the tooltip element and listeners", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  h.detach();
  expect(document.getElementById("pf-hover-tip")).toBeNull();
});

test("hover overlay material follows cutaway clipping until detach", () => {
  const viewer = makeViewer();
  const unregister = vi.fn();
  viewer.registerCutawayMaterial = vi.fn(() => unregister);

  const hover = attachHoverLabels(viewer, { part, schedule: sync });

  expect(viewer.registerCutawayMaterial).toHaveBeenCalledTimes(1);
  const material = viewer.registerCutawayMaterial.mock.calls[0][0];
  expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);

  move(viewer.domElement, 100, 100);
  const [overlay] = viewer._subMeshes.one.children;
  expect(overlay.material).toBe(material);
  // Cutaway feature lines start at render order 2,000,000; the translucent
  // highlight must render after them so it remains legible on retained faces.
  expect(overlay.renderOrder).toBeGreaterThan(2_000_000);

  const disposeMaterial = vi.spyOn(material, "dispose");
  const disposeSubset = vi.spyOn(overlay.geometry, "dispose");
  hover.detach();
  hover.detach();
  expect(unregister).toHaveBeenCalledTimes(1);
  expect(disposeMaterial).toHaveBeenCalledTimes(1);
  expect(disposeSubset).toHaveBeenCalledTimes(1);
});

test("detach completes hover cleanup before reporting aggregated failures", () => {
  const viewer = makeViewer();
  const hideError = new Error("tooltip hide failed");
  const unregisterError = new Error("cutaway unregister failed");
  const unregister = vi.fn(() => { throw unregisterError; });
  viewer.registerCutawayMaterial = vi.fn(() => unregister);
  const tooltip = makeTooltip();
  tooltip.hide.mockImplementation(() => { throw hideError; });
  const removeEventListener = vi.spyOn(viewer.domElement, "removeEventListener");
  const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });
  const material = viewer.registerCutawayMaterial.mock.calls[0][0];
  const disposeMaterial = vi.spyOn(material, "dispose");

  move(viewer.domElement, 100, 100);
  const [overlay] = viewer._subMeshes.one.children;
  const disposeGeometry = vi.spyOn(overlay.geometry, "dispose");

  let thrown;
  try { hover.detach(); } catch (error) { thrown = error; }

  expect(thrown).toBeInstanceOf(AggregateError);
  expect(thrown.errors).toEqual([hideError, unregisterError]);
  expect(viewer._subMeshes.one.children).toEqual([]); // no overlay left parented to the sub-part
  expect(disposeGeometry).toHaveBeenCalledTimes(1);
  expect(disposeMaterial).toHaveBeenCalledTimes(1);
  expect(unregister).toHaveBeenCalledTimes(1);
  for (const type of ["pointermove", "pointerdown", "pointerup", "pointerleave"]) {
    expect(removeEventListener).toHaveBeenCalledWith(type, expect.any(Function));
  }
  expect(tooltip.dispose).not.toHaveBeenCalled();
  expect(() => hover.detach()).not.toThrow();
});

test("a queued hover frame has no effect after detach", () => {
  const viewer = makeViewer();
  let runFrame;
  const hover = attachHoverLabels(viewer, {
    part,
    schedule: (callback) => { runFrame = callback; },
  });

  move(viewer.domElement, 100, 100);
  expect(runFrame).toBeTypeOf("function");
  hover.detach();
  runFrame();

  expect(document.getElementById("pf-hover-tip")).toBeNull();
  expect(viewer._subMeshes.one.children).toEqual([]); // no overlay left parented to the sub-part
});

test("pointerleave invalidates a queued hover frame", () => {
  const viewer = makeViewer();
  let runFrame;
  const hover = attachHoverLabels(viewer, {
    part,
    schedule: (callback) => { runFrame = callback; },
  });

  move(viewer.domElement, 100, 100);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
  runFrame();

  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  expect(viewer._subMeshes.one.children).toEqual([]); // no overlay left parented to the sub-part
  hover.detach();
});

test("a quick pointerdown and pointerup invalidates a queued hover frame", () => {
  const viewer = makeViewer();
  let runFrame;
  const hover = attachHoverLabels(viewer, {
    part,
    schedule: (callback) => { runFrame = callback; },
  });

  move(viewer.domElement, 100, 100);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  runFrame();

  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  expect(viewer._subMeshes.one.children).toEqual([]); // no overlay left parented to the sub-part
  hover.detach();
});

test("detach disposes the initial empty overlay geometry before any hover", () => {
  const viewer = makeViewer();
  const disposeGeometry = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
  const hover = attachHoverLabels(viewer, { part, schedule: sync });

  hover.detach();

  expect(disposeGeometry).toHaveBeenCalledTimes(1);
  disposeGeometry.mockRestore();
});

test("cutaway handle ownership immediately hides feature hover and suppresses moves", () => {
  const viewer = makeViewer({ handleHover: true });
  const hover = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  const [overlay] = viewer._subMeshes.one.children;
  expect(tip.classList.contains("show")).toBe(true);
  expect(overlay.visible).toBe(true);

  viewer.emitCutawayHandleHover("translate");
  expect(tip.classList.contains("show")).toBe(false);
  expect(overlay.visible).toBe(false);

  move(viewer.domElement, 100, 100);
  expect(tip.classList.contains("show")).toBe(false);
  expect(overlay.visible).toBe(false);

  viewer.emitCutawayHandleHover(null);
  expect(tip.classList.contains("show")).toBe(false);
  move(viewer.domElement, 100, 100);
  expect(tip.classList.contains("show")).toBe(true);
  expect(overlay.visible).toBe(true);
  hover.detach();
});

test("cutaway ownership invalidates a queued frame even after ownership clears", () => {
  const viewer = makeViewer({ handleHover: true });
  const frames = [];
  const hover = attachHoverLabels(viewer, {
    part,
    schedule: (callback) => frames.push(callback),
  });

  move(viewer.domElement, 100, 100);
  viewer.emitCutawayHandleHover("rotate-x");
  viewer.emitCutawayHandleHover(null);
  frames[0]();
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);

  move(viewer.domElement, 100, 100);
  expect(frames).toHaveLength(2);
  frames[1]();
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(true);
  hover.detach();
});

test("detach unsubscribes cutaway ownership once and ignores later emissions", () => {
  const viewer = makeViewer({ handleHover: true });
  const hover = attachHoverLabels(viewer, { part, schedule: sync });

  hover.detach();
  hover.detach();
  expect(viewer.hoverUnsubscribe).toHaveBeenCalledOnce();
  expect(() => viewer.emitCutawayHandleHover("rotate-y")).not.toThrow();
  expect(document.getElementById("pf-hover-tip")).toBeNull();
});
