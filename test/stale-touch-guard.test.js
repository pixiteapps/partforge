// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { guardStaleTouches } from "../src/framework/stale-touch-guard.js";
import { createViewcubeMode } from "../src/framework/viewcube/viewcube-mode.js";

// Drives three's REAL OrbitControls, since the bug lives in its pointer
// bookkeeping: a touch whose lift never arrives (a host app's own gesture took
// the drag over) stays in `_pointers`, and the next one-finger drag then reads
// as a two-finger pinch.
function setup({ guarded }) {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  // happy-dom has no pointer capture. The browser's releasePointerCapture
  // throws for an id it no longer holds, which is exactly what the controls
  // hit when they drop a finger the browser already forgot.
  const held = new Set();
  canvas.setPointerCapture = (id) => { held.add(id); };
  const ownRelease = (id) => {
    if (!held.delete(id)) throw new DOMException("no capture", "NotFoundError");
  };
  canvas.releasePointerCapture = ownRelease;
  const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas);
  const dispose = guarded ? guardStaleTouches(canvas) : () => {};
  const touch = (type, pointerId, isPrimary, x = 10, y = 10) =>
    canvas.dispatchEvent(new PointerEvent(type, {
      pointerId, pointerType: "touch", isPrimary, bubbles: true, pageX: x, pageY: y, clientX: x, clientY: y,
    }));
  const teardown = () => { dispose(); controls.dispose(); canvas.remove(); };
  return { canvas, controls, touch, held, ownRelease, teardown };
}

let active = null;
afterEach(() => { active?.teardown(); active = null; });

describe("guardStaleTouches", () => {
  it("reproduces the bug without the guard: a swallowed lift leaves two fingers tracked", () => {
    active = setup({ guarded: false });
    const { controls, touch, held } = active;
    touch("pointerdown", 1, true);
    held.delete(1); // the host's gesture took the drag over; the lift never arrives
    touch("pointerdown", 2, true);
    expect(controls._pointers).toEqual([1, 2]); // the next drag is read as a pinch
  });

  it("drops the swallowed finger when a new gesture starts, so the next drag is one finger", () => {
    active = setup({ guarded: true });
    const { controls, touch, held } = active;
    touch("pointerdown", 1, true);
    held.delete(1);
    touch("pointerdown", 2, true);
    expect(controls._pointers).toEqual([2]);
    // The cancel ran the controls' whole cleanup (the capture release for an
    // id the browser forgot no longer aborts it), so the new drag started
    // from a clean state and ends cleanly.
    touch("pointerup", 2, true);
    expect(controls._pointers).toEqual([]);
  });

  it("leaves a real pinch alone: a second finger of the same gesture is not primary", () => {
    active = setup({ guarded: true });
    const { controls, touch } = active;
    touch("pointerdown", 1, true, 10, 10);
    touch("pointerdown", 2, false, 60, 60);
    expect(controls._pointers).toEqual([1, 2]);
    touch("pointerup", 2, false);
    touch("pointerup", 1, true);
    expect(controls._pointers).toEqual([]);
  });

  it("leaves a mouse alone: only touch pointers are ever cancelled", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const cancels = [];
    canvas.addEventListener("pointercancel", (e) => cancels.push(e.pointerId));
    const dispose = guardStaleTouches(canvas);
    const down = (pointerId, pointerType) =>
      canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId, pointerType, isPrimary: true, bubbles: true }));
    down(7, "mouse"); // held, never lifted
    down(2, "touch"); // a fresh touch gesture must not cancel the mouse
    expect(cancels).toEqual([]);
    dispose();
    canvas.remove();
  });

  it("leaves an element's own capture release in place after the cancel is sent", () => {
    active = setup({ guarded: true });
    const { canvas, touch, held, ownRelease } = active;
    touch("pointerdown", 1, true);
    held.delete(1);
    touch("pointerdown", 2, true);
    expect(canvas.releasePointerCapture).toBe(ownRelease);
  });

  it("stops cancelling once disposed", () => {
    const canvas = document.createElement("canvas");
    const original = () => {};
    canvas.releasePointerCapture = original;
    document.body.appendChild(canvas);
    const cancels = [];
    canvas.addEventListener("pointercancel", (e) => cancels.push(e.pointerId));
    const dispose = guardStaleTouches(canvas);
    dispose();
    expect(canvas.releasePointerCapture).toBe(original);
    const touch = (pointerId) => canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId, pointerType: "touch", isPrimary: true, bubbles: true }));
    touch(1);
    touch(2);
    expect(cancels).toEqual([]);
    canvas.remove();
  });
});

// The orbit canvas is not the only thing in the viewer that holds a finger:
// the view cube keeps its own `press` on its own canvas, and so do the cutaway
// handles and measure mode. A swallowed lift there sticks just the same, so
// the guard watches every element under the viewer's root, and sends each
// stale finger its cancel on the element it went down on.
describe("guardStaleTouches over the viewer's root", () => {
  // A browser-like pointer capture: releasing an id the browser has already
  // forgotten throws, which is what the view cube hits in its cancel handler.
  function withCapture(element) {
    const held = new Set();
    element.setPointerCapture = (id) => { held.add(id); };
    element.releasePointerCapture = (id) => {
      if (!held.delete(id)) throw new DOMException("no capture", "NotFoundError");
    };
    return held;
  }

  function setupViewer() {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const canvas = document.createElement("canvas");
    root.appendChild(canvas);
    const canvasHeld = withCapture(canvas);
    const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas);

    const viewer = {
      camera: { quaternion: { x: 0, y: 0, z: 0, w: 1 }, isOrthographicCamera: false, zoom: 1 },
      onFrame: () => () => {},
      onThemeChange: () => () => {},
      getTheme: () => "dark",
      tweenCameraTo: vi.fn(),
      orbitBy: vi.fn(),
    };
    let cube, cubeHeld;
    const cubeMode = createViewcubeMode(viewer, {
      host: root,
      matchMedia: null,
      createCanvas: (wrap) => {
        cube = document.createElement("canvas");
        wrap.appendChild(cube);
        cube.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 90 });
        cubeHeld = withCapture(cube);
        return { element: cube, draw: () => {}, setTheme: () => {}, size: 90, dispose: () => {} };
      },
    });

    const dispose = guardStaleTouches(root);
    const press = (element, type, pointerId, { isPrimary = true, pointerType = "touch", x = 10, y = 10 } = {}) =>
      element.dispatchEvent(new PointerEvent(type, {
        pointerId, pointerType, isPrimary, bubbles: true, pageX: x, pageY: y, clientX: x, clientY: y,
      }));
    const teardown = () => { dispose(); cubeMode.detach(); controls.dispose(); root.remove(); };
    return { root, canvas, canvasHeld, controls, cube, cubeHeld, viewer, press, teardown };
  }

  let viewerActive = null;
  afterEach(() => { viewerActive?.teardown(); viewerActive = null; });

  it("cancels a swallowed view-cube finger on the cube, so the cube lets go of it", () => {
    viewerActive = setupViewer();
    const { cube, cubeHeld, canvas, controls, viewer, press } = viewerActive;
    // A drag on the cube orbits the camera, then the host takes it over (a
    // vertical drag scrolls the chat) and the lift never arrives.
    press(cube, "pointerdown", 1, { x: 10, y: 10 });
    press(cube, "pointermove", 1, { x: 10, y: 40 });
    expect(viewer.orbitBy).toHaveBeenCalledTimes(1);
    cubeHeld.delete(1);
    // The next gesture starts on the stage.
    press(canvas, "pointerdown", 2);
    expect(controls._pointers).toEqual([2]);
    // The cube dropped its press: a hover over it no longer spins the camera.
    press(cube, "pointermove", 3, { pointerType: "mouse", x: 60, y: 60 });
    expect(viewer.orbitBy).toHaveBeenCalledTimes(1);
  });

  it("cancels a swallowed stage finger when the next gesture starts on the cube", () => {
    viewerActive = setupViewer();
    const { cube, canvas, canvasHeld, controls, viewer, press } = viewerActive;
    press(canvas, "pointerdown", 1);
    canvasHeld.delete(1);
    press(cube, "pointerdown", 2, { x: 45, y: 45 });
    expect(controls._pointers).toEqual([]);
    // The cube's own press is the new finger, and its tap still lands.
    press(cube, "pointerup", 2, { x: 45, y: 45 });
    expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(1);
  });

  it("never cancels a touch that went down outside the viewer's root", () => {
    viewerActive = setupViewer();
    const { canvas, press } = viewerActive;
    const hostButton = document.createElement("button");
    document.body.appendChild(hostButton);
    const cancels = [];
    hostButton.addEventListener("pointercancel", (e) => cancels.push(e.pointerId));
    press(hostButton, "pointerdown", 1); // the host's own control, lift swallowed
    press(canvas, "pointerdown", 2);
    expect(cancels).toEqual([]);
    hostButton.remove();
  });
});
