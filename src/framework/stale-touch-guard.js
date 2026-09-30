// src/framework/stale-touch-guard.js
// Keeps the camera controls from holding onto a finger that has already left
// the screen.
//
// OrbitControls tracks every pointer that goes down on the canvas and forgets
// one only on its pointerup or pointercancel. When the page is embedded in a
// host that runs its own gestures (a chat app's WKWebView, which scrolls the
// conversation on a vertical drag), the host can take a drag over and the page
// never hears that finger lift. The controls then keep it as down forever: the
// next one-finger drag reads as a two-finger pinch (it zooms), and with two
// stuck, no drag moves the camera at all.
//
// Two measures, both on the canvas's document and both passive:
//
// 1. Do-nothing touchstart/touchend/touchcancel listeners. WebKit on iOS hands
//    a touch to the page only where the page listens for TOUCH events, and the
//    controls listen for pointer events alone, so without these the host's
//    gesture recognizers could claim a drag the page itself was handling.
//
// 2. Stale fingers are cancelled on arrival. A touch pointerdown marked
//    isPrimary is the first finger of a brand-new gesture, so no other touch
//    can really be down; every touch id still recorded as down on the canvas is
//    sent the pointercancel it missed, from a capture listener on the document
//    (which runs before the controls' own listener on the canvas). A second
//    finger of the same gesture is never primary, so pinch and two-finger pan
//    are untouched.
//
// The controls release pointer capture for the id they remove, and that call
// throws for an id the browser has already forgotten, aborting their cleanup
// half way (the move listeners and the gesture state would stay live). So the
// canvas's releasePointerCapture is wrapped to ignore that one failure.
const TOUCH_TYPES = ["touchstart", "touchend", "touchcancel"];

export function guardStaleTouches(element) {
  const doc = element.ownerDocument;
  if (!doc) return () => {};
  const noop = () => {};
  const touchesDown = new Set();

  const release = element.releasePointerCapture;
  if (typeof release === "function") {
    element.releasePointerCapture = function releaseIfHeld(pointerId) {
      try {
        release.call(this, pointerId);
      } catch {
        // Already released: the finger is gone, which is all the caller wanted.
      }
    };
  }

  const onDown = (event) => {
    if (event.pointerType !== "touch") return;
    if (event.isPrimary && touchesDown.size) {
      for (const pointerId of [...touchesDown]) {
        if (pointerId === event.pointerId) continue;
        touchesDown.delete(pointerId);
        element.dispatchEvent(new PointerEvent("pointercancel", { pointerId, pointerType: "touch", bubbles: true }));
      }
    }
    if (event.target === element) touchesDown.add(event.pointerId);
  };
  const onEnd = (event) => { touchesDown.delete(event.pointerId); };

  for (const type of TOUCH_TYPES) doc.addEventListener(type, noop, { capture: true, passive: true });
  doc.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  doc.addEventListener("pointerup", onEnd, { capture: true, passive: true });
  doc.addEventListener("pointercancel", onEnd, { capture: true, passive: true });

  return function dispose() {
    for (const type of TOUCH_TYPES) doc.removeEventListener(type, noop, { capture: true });
    doc.removeEventListener("pointerdown", onDown, { capture: true });
    doc.removeEventListener("pointerup", onEnd, { capture: true });
    doc.removeEventListener("pointercancel", onEnd, { capture: true });
    if (typeof release === "function") element.releasePointerCapture = release;
    touchesDown.clear();
  };
}
