// The view cube's chrome: the bottom-right stack (the cube, and whatever sits
// over its bottom-right corner), and the visually-hidden per-view buttons that
// stand in for the DOM focus a canvas cannot give us. Generated, not declared —
// no part's HTML carries this, and partforge-cloud's scaffold does not either
// (the mobile-tabs.js and animation-controls.js precedent).
//
// Through 2026-09-23 this file also generated the projection toggle (#projection),
// a small bare circle laid OVER the cube's bottom-right corner — absolutely
// positioned, so the stack stayed exactly as wide as the canvas (135px, or 101
// below the rail's narrow breakpoint) and the size published below was the
// canvas's alone. On 2026-09-24 the projection control moved into the view
// style popover (view-style-controls.js), whose button sits BESIDE the cube, to
// its left. That module appends it into `element` (the stack), so it hides
// with the cube; it is absolutely positioned OUTSIDE the stack's box, so the
// stack's published size is still the canvas's. History of the toggle's earlier homes
// (a `.pf-viewcube-pill` card below the cube, then a circle beside it) is in
// chrome.css/app.css's viewcube sections.
import { runCleanupSteps } from "../teardown.js";
import { createViewcubeMode } from "./viewcube-mode.js";

// One hidden button per canonical FACE view. Edges and corners are reachable by
// pointer only — six targets is a usable keyboard surface; twenty-six is a
// tab-stop thicket.
const KEY_VIEWS = [
  ["front", "View from the front"],
  ["back", "View from the back"],
  ["left", "View from the left"],
  ["right", "View from the right"],
  ["top", "View from the top"],
  ["bottom", "View from the bottom"],
];

export function attachViewcubeControls(viewer, { stage } = {}) {
  const stack = document.createElement("div");
  stack.className = "pf-viewcube-stack";
  stage.appendChild(stack);

  const mode = createViewcubeMode(viewer, { host: stack });

  const keys = document.createElement("div");
  keys.className = "pf-viewcube-key";
  const keyButtons = KEY_VIEWS.map(([view, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.view = view;
    b.textContent = label;
    b.setAttribute("aria-label", label);
    keys.appendChild(b);
    return b;
  });
  stack.appendChild(keys);

  const keyHandlers = keyButtons.map((b) => {
    // Same user intent as clicking the face on the canvas, so the same
    // `refit` — these buttons ARE the keyboard route to that click.
    const handler = () => viewer.tweenCameraTo(b.dataset.view, { duration: 0.6, refit: true });
    b.addEventListener("click", handler);
    return handler;
  });

  // Publish the stack's size on the element itself, in the data-pf-* convention
  // the shell already uses (data-pf-pane). animation-controls.js reads it to
  // decide whether the transport bar is crowded, and that decision has to come
  // out the same whether or not the stack is on screen — otherwise hiding the
  // cube un-crowds the bar, the bar un-hides the cube, and the two oscillate a
  // frame at a time (see nominalClusterRect for the full argument). A
  // display:none element measures all zeros, so the size cannot be read live;
  // it has to have been written down.
  //
  // Only ever written from a REAL measured size, so the last real values survive
  // a hide. They change only at the rail's narrow breakpoint, which leaves one
  // stale case: a breakpoint change that happens WHILE hidden leaves the
  // full-size value published. That is benign and deliberately not "fixed" — it
  // is the conservative direction (it keeps the cube hidden rather than
  // flickering it back), and the next real measurement corrects it.
  //
  // A dataset write affects no layout, so this observer cannot feed itself.
  const publishSize = () => {
    const { width, height } = stack.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    stack.dataset.pfW = String(Math.round(width));
    stack.dataset.pfH = String(Math.round(height));
  };
  const sizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(publishSize) : null;
  sizeObserver?.observe(stack);
  publishSize(); // the observer's first callback is a frame away; the reader may not be

  function setHidden(flag) {
    const next = !!flag;
    stack.hidden = next;
    // Stand the frame subscription's work down too, not just the pixels.
    mode.setHidden(next);
  }

  let detached = false;
  return {
    element: stack,
    mode,
    setHidden,
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        () => sizeObserver?.disconnect(),
        ...keyButtons.map((b, i) => () => b.removeEventListener("click", keyHandlers[i])),
        () => mode.detach(),
        () => stack.remove(),
      ], "viewcube control cleanup failed");
    },
  };
}
