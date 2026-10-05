// src/framework/stale-touch-guard.js
// Keeps the viewer from holding onto a finger that has already left the
// screen.
//
// OrbitControls tracks every pointer that goes down on the canvas and forgets
// one only on its pointerup or pointercancel, and the view cube, the cutaway
// handles and measure mode track pointers the same way on their own elements.
// When the page is embedded in a host that runs its own gestures (a chat app's
// WKWebView, which scrolls the conversation on a vertical drag), the host can
// take a drag over and the page never hears that finger lift. Whatever it went
// down on then keeps it as down forever: for the controls the next one-finger
// drag reads as a two-finger pinch (it zooms), and with two stuck, no drag
// moves the camera at all; the view cube keeps its press, so a hover over it
// spins the camera.
//
// Two measures, both on the root's document and both passive:
//
// 1. Do-nothing touchstart/touchend/touchcancel listeners. WebKit on iOS hands
//    a touch to the page only where the page listens for TOUCH events, and the
//    viewer listens for pointer events alone, so without these the host's
//    gesture recognizers could claim a drag the page itself was handling.
//
// 2. Stale fingers are cancelled on arrival. Every touch that goes down inside
//    the viewer's root is recorded with the element it went down on (a touch
//    outside the root is the host's business and is never recorded). A touch
//    pointerdown marked isPrimary is the first finger of a brand-new gesture,
//    so no other touch can really be down; every touch id still recorded is
//    sent the pointercancel it missed, on the element it went down on and
//    carrying the isPrimary it went down with (the view cube ignores a
//    non-primary pointer, cancel included), from a capture listener on the
//    document (which runs before any listener inside the root). A second
//    finger of the same gesture is never primary, so pinch and two-finger pan
//    are untouched.
//
// Whatever receives the cancel releases pointer capture for that id, and that
// call throws for an id the browser has already forgotten, aborting the
// cleanup half way (OrbitControls would keep its move listeners and gesture
// state live; the view cube would keep its press). So while a cancel is being
// dispatched, its element's releasePointerCapture ignores that one failure,
// and is put back the moment the dispatch returns.
const TOUCH_TYPES = ["touchstart", "touchend", "touchcancel"];

export function guardStaleTouches(root) {
  const doc = root.ownerDocument;
  if (!doc) return () => {};
  const noop = () => {};
  const touchesDown = new Map(); // pointerId -> { target, isPrimary } it went down with

  const onDown = (event) => {
    if (event.pointerType !== "touch") return;
    if (event.isPrimary && touchesDown.size) {
      for (const [pointerId, down] of [...touchesDown]) {
        if (pointerId === event.pointerId) continue;
        touchesDown.delete(pointerId);
        cancelStale(down, pointerId);
      }
    }
    if (root.contains(event.target)) {
      touchesDown.set(event.pointerId, { target: event.target, isPrimary: event.isPrimary });
    }
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
    touchesDown.clear();
  };
}

function cancelStale({ target, isPrimary }, pointerId) {
  const release = target.releasePointerCapture;
  const ownRelease = Object.hasOwn(target, "releasePointerCapture");
  if (typeof release === "function") {
    target.releasePointerCapture = function releaseIfHeld(id) {
      try {
        release.call(this, id);
      } catch {
        // Already released: the finger is gone, which is all the caller wanted.
      }
    };
  }
  try {
    target.dispatchEvent(new PointerEvent("pointercancel", { pointerId, pointerType: "touch", isPrimary, bubbles: true }));
  } finally {
    if (typeof release === "function") {
      if (ownRelease) target.releasePointerCapture = release;
      else delete target.releasePointerCapture;
    }
  }
}
