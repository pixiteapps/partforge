// The view cube's orchestrator — the only viewcube file that touches both the
// viewer and the DOM (the annotate-mode.js / measure-mode.js stance). Owns the
// frame subscription, the dirty check that keeps idle frames free, pointer
// input, and the drag/click split.
import { projectCube, hitRegion, CUBE_DOWN_BIAS_PX } from "./cube-geom.js";
import { createCubeCanvas, CUBE_SIZE, CUBE_SIZE_NARROW, CUBE_RENDER } from "./cube-canvas.js";
import { RAIL_NARROW_BREAKPOINT } from "../rail-state.js";
import { runCleanupSteps } from "../teardown.js";

// Past this many px of travel a press is an orbit, not a click. 4px is the
// usual "did they mean to drag" threshold and comfortably above the jitter a
// trackpad tap produces.
const DRAG_THRESHOLD_PX = 4;

export function createViewcubeMode(viewer, {
  host,
  createCanvas = createCubeCanvas,
  dragThreshold = DRAG_THRESHOLD_PX,
  matchMedia = (typeof window !== "undefined" && typeof window.matchMedia === "function")
    ? window.matchMedia.bind(window)
    : null,
} = {}) {
  const wrap = document.createElement("div");
  wrap.className = "pf-viewcube";
  host.appendChild(wrap);

  // Below the rail's narrow breakpoint the shell shows one pane at a time
  // (rail.js) and the stage is a lot tighter, so the cube shrinks back to its
  // previous size. This is a BREAKPOINT, not an element size, so it is a media
  // query rather than a ResizeObserver — this renderer deliberately owns no
  // observer of its own.
  const narrowQuery = matchMedia ? matchMedia(`(max-width: ${RAIL_NARROW_BREAKPOINT}px)`) : null;
  const sizeForViewport = () => (narrowQuery?.matches ? CUBE_SIZE_NARROW : CUBE_SIZE);

  const canvas = createCanvas(wrap, { size: sizeForViewport() });
  canvas.setTheme?.(viewer.getTheme?.() ?? "dark");

  let hidden = false;
  let hover = null;
  let projected = null;
  // The dirty check. An unchanged camera must cost nothing — no clear, no
  // fills — because this runs inside the viewer's rAF callback alongside the
  // cutaway's outline re-slice and the main render.
  let lastKey = null;

  const cameraKey = () => {
    const cam = viewer.camera;
    const q = cam.quaternion;
    // Zoom is part of the key because an ortho dolly changes camera.zoom
    // without touching the quaternion, and the cube's scale follows neither —
    // but the projection SWAP repaints, and a zoom change is the cheapest
    // signal that one happened.
    return `${q.x.toFixed(6)},${q.y.toFixed(6)},${q.z.toFixed(6)},${q.w.toFixed(6)},${cam.isOrthographicCamera ? cam.zoom : 0}`;
  };

  function redraw() {
    if (hidden) return;
    const cam = viewer.camera;
    const q = cam.quaternion;
    // outerPad reserves screen-pixel room for everything cube-canvas.js draws
    // past the cube's model geometry: the fixed-size arrowhead, the gap
    // beyond it, and the axis label glyph (drawn centred on its anchor, so it
    // still sticks out a few px past that point — one font-size's worth of
    // slack comfortably covers a single uppercase character at this size).
    const outerPad = CUBE_RENDER.headLengthPx + CUBE_RENDER.labelGapPx + CUBE_RENDER.labelPx;
    // downBias spends part of that same reservation on ONE side, so the cube
    // sits lower in its box and reads closer to the viewbar (the other half of
    // that change is chrome.css's stack offset). Passed rather than defaulted
    // inside projectCube because the two knobs are one budget: the bias is only
    // safe against the pad this call just reserved. Hit-testing rides along for
    // free — it reads the same projection.
    projected = projectCube([q.x, q.y, q.z, q.w], {
      size: canvas.size,
      outerPad,
      downBias: CUBE_DOWN_BIAS_PX,
    });
    canvas.draw(projected, { hover });
  }

  function onFrame() {
    if (hidden) return;
    const key = cameraKey();
    if (key === lastKey) return;
    lastKey = key;
    redraw();
  }

  // --- pointer ---------------------------------------------------------------
  let press = null; // { x, y, dragging, id }

  const localPoint = (event) => {
    const rect = canvas.element.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const onPointerDown = (event) => {
    if (event.isPrimary === false || hidden) return;
    press = { x: event.clientX, y: event.clientY, dragging: false, id: event.pointerId };
    canvas.element.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (event.isPrimary === false || hidden) return;
    if (press) {
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.dragging && Math.hypot(dx, dy) < dragThreshold) return;
      press.dragging = true;
      press.x = event.clientX;
      press.y = event.clientY;
      // Hover is meaningless mid-drag and would flicker as the cube spins.
      if (hover !== null) hover = null;
      viewer.orbitBy(dx, dy);
      return;
    }
    const next = hitRegion(...localPoint(event), projected);
    if (next === hover) return;
    hover = next;
    redraw();
  };

  const onPointerUp = (event) => {
    if (!press || event.isPrimary === false) return;
    const wasDrag = press.dragging;
    canvas.element.releasePointerCapture?.(press.id);
    press = null;
    if (wasDrag) return;
    const id = hitRegion(...localPoint(event), projected);
    // refit: clicking a region is now the only reframe control the framework's
    // own pages ship, so it has to actually refit — under orthographic a tween
    // alone changes the angle and leaves the user's dolly in place.
    // autoProjection: a FACE click settles into orthographic, an edge or corner
    // click is perspective (Fusion 360's "Perspective with Ortho Faces"). Only
    // the cube passes it — animation cues never do. See viewer.js's tweenCameraTo.
    if (id) viewer.tweenCameraTo(id, { duration: 0.6, refit: true, autoProjection: true });
  };

  const onPointerLeave = () => {
    if (press || hover === null) return;
    hover = null;
    redraw();
  };

  canvas.element.addEventListener("pointerdown", onPointerDown);
  canvas.element.addEventListener("pointermove", onPointerMove);
  canvas.element.addEventListener("pointerup", onPointerUp);
  canvas.element.addEventListener("pointercancel", onPointerUp);
  canvas.element.addEventListener("pointerleave", onPointerLeave);

  const offFrame = viewer.onFrame(onFrame);
  const offTheme = viewer.onThemeChange((mode) => {
    canvas.setTheme(mode);
    redraw();
  });

  const onNarrowChange = () => {
    canvas.setSize(sizeForViewport());
    // The projection itself is size-dependent (the scale), so the dirty-check
    // key alone won't force a real reproject here — clear it and redraw.
    lastKey = null;
    redraw();
  };
  narrowQuery?.addEventListener?.("change", onNarrowChange);

  lastKey = cameraKey();
  redraw(); // never show a blank box before the first camera movement

  function setHidden(flag) {
    const next = !!flag;
    if (next === hidden) return;
    hidden = next;
    wrap.hidden = hidden;
    if (!hidden) {
      // The camera almost certainly moved while we were away, and the dirty
      // check would otherwise hold the stale drawing until it moves again.
      lastKey = cameraKey();
      redraw();
    }
  }

  let detached = false;
  return {
    element: wrap,
    setHidden,
    isHidden: () => hidden,
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offFrame,
        offTheme,
        () => narrowQuery?.removeEventListener?.("change", onNarrowChange),
        () => canvas.element.removeEventListener("pointerdown", onPointerDown),
        () => canvas.element.removeEventListener("pointermove", onPointerMove),
        () => canvas.element.removeEventListener("pointerup", onPointerUp),
        () => canvas.element.removeEventListener("pointercancel", onPointerUp),
        () => canvas.element.removeEventListener("pointerleave", onPointerLeave),
        () => canvas.dispose(),
        () => wrap.remove(),
      ], "viewcube mode cleanup failed");
    },
  };
}
