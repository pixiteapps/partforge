// Viewer adapter for click-to-select: arms a click listener, raycasts via the shared
// selection raycast, and hands a resolved Selection to onPick.
import { raycastViewer, worldToSubPartLocal } from "./raycast.js";
import { resolveSelection } from "./resolve.js";
import { createDragTracker } from "./drag-tracker.js";
import { projectToScreen } from "../pick-flash.js";

export { worldToSubPartLocal };

// `suppressed` is an optional pull-based guard checked per click, for a caller
// whose suppression condition lives elsewhere (mount passes measure mode's
// isEnabled): while it returns true a click neither raycasts, flashes, nor
// picks — no resync bookkeeping the way an event-driven setActive would need.
// onPick receives (selection, anchor): where the marker this click flashed
// landed on the canvas, in CSS px from its top-left, and the raw hit (internal:
// subPart, triIndex, onCutPlane) — the public Selection gains nothing.
export function attachPicker(viewer, { part, getContext, onPick, suppressed }) {
  let active = false;
  const drag = createDragTracker();

  function onClick(ev) {
    // consumeClick() first, unconditionally — the drag tracker is stateful and
    // a suppressed click must still clear its just-dragged flag.
    const wasDragged = drag.consumeClick();
    if (!active || wasDragged || suppressed?.()) return;
    // includeSection: in a cutaway the flat cut face is the biggest thing on
    // screen, and it is the one surface with no geometry behind it to hit.
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY, { includeSection: true });
    if (!hit) return;
    const selection = resolveSelection(part, getContext(), hit);
    viewer.flashPoint([hit.pointWorld.x, hit.pointWorld.y, hit.pointWorld.z]);
    // The anchor is the MARKER's projection, not the pointer's position, even
    // though the two coincide at this instant: the host's follow-the-camera
    // stream projects the same world point through the same function every
    // frame after, so the first answer is of a piece with the rest.
    // Sized from the rect the raycast just used, which is what makes this
    // anchor land back on the pixel the user clicked. The stream sizes from the
    // renderer's last setSize instead — also CSS px, but the CONTAINER's
    // integer clientWidth/Height as of the last ResizeObserver call, and 1x1
    // while the viewer is parked. They agree in steady state; the divergence is
    // staleness, never units.
    const rect = viewer.domElement.getBoundingClientRect();
    const anchor = projectToScreen(viewer.camera, hit.pointWorld, rect.width, rect.height);
    onPick(selection, { x: anchor.x, y: anchor.y }, hit);
  }

  viewer.domElement.addEventListener("pointerdown", drag.onDown);
  viewer.domElement.addEventListener("pointermove", drag.onMove);
  viewer.domElement.addEventListener("pointerup", drag.onUp);
  viewer.domElement.addEventListener("pointercancel", drag.onCancel);
  viewer.domElement.addEventListener("click", onClick);
  return {
    setActive: (on) => { active = !!on; },
    detach: () => {
      viewer.domElement.removeEventListener("pointerdown", drag.onDown);
      viewer.domElement.removeEventListener("pointermove", drag.onMove);
      viewer.domElement.removeEventListener("pointerup", drag.onUp);
      viewer.domElement.removeEventListener("pointercancel", drag.onCancel);
      viewer.domElement.removeEventListener("click", onClick);
    },
  };
}
