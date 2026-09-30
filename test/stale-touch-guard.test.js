// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { guardStaleTouches } from "../src/framework/stale-touch-guard.js";

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
  canvas.releasePointerCapture = (id) => {
    if (!held.delete(id)) throw new DOMException("no capture", "NotFoundError");
  };
  const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas);
  const dispose = guarded ? guardStaleTouches(canvas) : () => {};
  const touch = (type, pointerId, isPrimary, x = 10, y = 10) =>
    canvas.dispatchEvent(new PointerEvent(type, {
      pointerId, pointerType: "touch", isPrimary, bubbles: true, pageX: x, pageY: y, clientX: x, clientY: y,
    }));
  const teardown = () => { dispose(); controls.dispose(); canvas.remove(); };
  return { canvas, controls, touch, held, teardown };
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

  it("stops cancelling and restores the canvas's own capture release once disposed", () => {
    const canvas = document.createElement("canvas");
    const original = () => {};
    canvas.releasePointerCapture = original;
    document.body.appendChild(canvas);
    const cancels = [];
    canvas.addEventListener("pointercancel", (e) => cancels.push(e.pointerId));
    const dispose = guardStaleTouches(canvas);
    expect(canvas.releasePointerCapture).not.toBe(original);
    dispose();
    expect(canvas.releasePointerCapture).toBe(original);
    const touch = (pointerId) => canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId, pointerType: "touch", isPrimary: true, bubbles: true }));
    touch(1);
    touch(2);
    expect(cancels).toEqual([]);
    canvas.remove();
  });
});
