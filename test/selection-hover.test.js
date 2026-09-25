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

test("hovering a labeled feature shows 'feature · sub-part' and no surface highlight", () => {
  // A tint on just the feature under the pointer read as "only this spot is
  // clickable", so hover names the part and leaves the surface alone.
  const viewer = makeViewer();
  viewer.registerCutawayMaterial = vi.fn(() => () => {});
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Drainage hole");
  expect(tip.querySelector(".pf-hover-sub").textContent).toBe("Planter");
  expect(viewer._subMeshes.one.children).toEqual([]);
  expect(viewer.registerCutawayMaterial).not.toHaveBeenCalled();
  h.detach();
});

test("hovering unlabeled geometry names the sub-part without a highlight", () => {
  const viewer = makeViewer({ featured: false });
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Planter");
  expect(viewer._subMeshes.one.children).toEqual([]);
  h.detach();
});

test("a hint adds a call-to-action line under the name", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync, hint: "Click to edit" });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.querySelector("b").textContent).toBe("Drainage hole");
  expect(tip.querySelector(".pf-hover-hint").textContent).toBe("Click to edit");
  h.detach();
});

test("an injected presenter receives the hint with the content", () => {
  const viewer = makeViewer({ featured: false });
  const tooltip = makeTooltip();
  const h = attachHoverLabels(viewer, { part, schedule: sync, tooltip, hint: "Click to edit" });
  move(viewer.domElement, 100, 100);
  expect(tooltip.showPointer).toHaveBeenCalledWith(
    { title: "Planter", subtitle: "", hint: "Click to edit" }, 100, 100,
  );
  h.detach();
});

test("without a hint the hint line stays empty", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  expect(document.querySelector("#pf-hover-tip .pf-hover-hint").textContent).toBe("");
  h.detach();
});

test("a miss hides the tooltip", () => {
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

test("detach completes hover cleanup before reporting a failure", () => {
  const viewer = makeViewer();
  const hideError = new Error("tooltip hide failed");
  const tooltip = makeTooltip();
  tooltip.hide.mockImplementation(() => { throw hideError; });
  const removeEventListener = vi.spyOn(viewer.domElement, "removeEventListener");
  const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });

  move(viewer.domElement, 100, 100);

  let thrown;
  try { hover.detach(); } catch (error) { thrown = error; }

  expect(thrown).toBe(hideError);
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
  hover.detach();
});

test("cutaway handle ownership immediately hides feature hover and suppresses moves", () => {
  const viewer = makeViewer({ handleHover: true });
  const hover = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);

  viewer.emitCutawayHandleHover("translate");
  expect(tip.classList.contains("show")).toBe(false);

  move(viewer.domElement, 100, 100);
  expect(tip.classList.contains("show")).toBe(false);

  viewer.emitCutawayHandleHover(null);
  expect(tip.classList.contains("show")).toBe(false);
  move(viewer.domElement, 100, 100);
  expect(tip.classList.contains("show")).toBe(true);
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
