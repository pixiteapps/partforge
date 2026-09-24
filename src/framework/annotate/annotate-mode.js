// Annotation-mode orchestrator — the one annotate module touching both the DOM
// and the viewer (the measure-mode.js stance). Owns pointer -> tool state
// machine -> elements, the mode lifecycle, and payload assembly. The overlay
// canvas is lazy-created on first enable and kept across toggles; the ELEMENT
// LIST is not — exiting the mode discards it, because screen-space ink is only
// meaningful against the camera pose it was drawn over (deliberately unlike
// measure pins). The active tool and color DO persist across an enable cycle
// within a session — cheap continuity, no spec reason to reset them.
import * as THREE from "three";
import {
  createElementStore, DEFAULT_STROKE_WIDTH, INK_COLORS,
  rectFromDrag, ellipseFromDrag, lineFromDrag, appendThinned,
  probe, handlesOf, centerOf, translateElement, rectAnchorFor,
  resizeRectFromAnchor, resizeEllipseHandle, applyRotation,
  eraseSegment, describeElement, elementAnchors, visibleFraction,
} from "./elements.js";
import { createInkCanvas } from "./ink-canvas.js";
import { raycastViewer } from "../selection/raycast.js";

// v3: strokes -> typed elements (rect/ellipse/line/freehand), each carrying
// its own params, gaps (eraser spans) and a plain-language description — the
// payload shape this file assembles in send() below. A consumer that reads
// `strokes`/`anchors[].stroke` off the old shape must be told loudly, hence
// the version bump rather than an additive field.
export const ANNOTATION_VERSION = 3;
// Self-describing coordinate legend, shipped verbatim in every payload as
// `frames`. Three frames coexist in the payload (params are stage-space,
// anchor screens are per-axis normalized, descriptions are viewport
// percentages) — this block is what stops a consumer from conflating them.
// Keys mirror the payload paths they describe.
const FRAME_LEGEND = Object.freeze({
  "elements[].params":
    "stage space: y 0..1 top-down, x 0..aspect (see viewport.aspect); sizes and radii in the same units; rot in radians (rotDeg is the same angle in degrees)",
  "elements[].anchors[].screen":
    "[x, y] normalized to the viewport (0..1 inside it; values outside mean the point sits off-stage) — x = stage x / aspect",
  "elements[].anchors[].ray":
    "origin (mm) and unit dir in the parts frame — intersect with a plane (partforge/oracle's rayPlane) to place sketch geometry; present only when the model had meshes at send time",
  "elements[].description":
    "positions and sizes as % of viewport width/height, radii as % of the short edge, angles in degrees",
  "elements[].erased":
    "[start, end] spans 0..1 in the element's own domain — line/freehand: fraction along the path; rect: perimeter clockwise from the top-left corner; ellipse: fraction of a full turn from 3 o'clock, screen-clockwise, before rotation",
  "elements[].anchors[].hit":
    "pointLocal is millimetres in the named sub-part's local frame; null means the anchor points at empty space",
  camera:
    "pos/target in millimetres — world replays against this exact build, parts is pinned to the CAD geometry and survives rebuilds",
});
// Long-edge bound on BOTH pictures in the payload. The ink canvas is stage
// sized × devicePixelRatio, so an unbounded send on a large hi-DPI display
// hands the host a multi-megabyte pair of base64 strings — slow to encode,
// and past the ceiling a host that ships them anywhere has to enforce. 2048
// is captureCurrent's own default and comfortably above what any reviewer
// (human or model) reads a sketch at; a smaller stage exports at its own size
// and pays nothing.
const SEND_MAX_EDGE = 2048;

// Pixel thresholds for the hand tool's hit-testing and the eraser brush,
// converted to stage units per event by dividing by rect.height (the same
// factor stagePoint uses for both axes — see elements.js's header comment on
// why stage space is aspect-uniform under that convention).
const HANDLE_PX = 8;
const ROTATE_BAND_PX = 22;
const ERASER_PX = 16;
// One cursor-distance magnet for every snap: the line's 0/45/90° snap, the
// rect/ellipse 1:1 snap while drawing, and the hand-tool resize snaps all
// engage when the cursor is within this many CSS pixels of the snapped shape.
const SNAP_PX = 8;
const MIN_DRAG_PX = 6; // sub-6px shape drags commit nothing
const FREEHAND_MIN_DIST = 0.003; // stage units (~ink.js's old thinning at aspect 1)

const stagePoint = (event, rect) => [
  Math.min(rect.width / rect.height, Math.max(0, (event.clientX - rect.left) / rect.height)),
  Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
];
const stageUnits = (px, rect) => px / rect.height;
const strokeWidthPx = (rect) => DEFAULT_STROKE_WIDTH * Math.min(rect.width, rect.height);

export function createAnnotateMode(viewer, { stage, getContext, onSend, createCanvas = createInkCanvas } = {}) {
  const store = createElementStore();
  let canvas = null; // lazy; created on first enable
  let enabled = false;
  let tool = "pen";
  let color = "red";
  let gesture = null; // the in-flight pointer gesture, or null between gestures
  let hoverProbe = null; // hand tool: what's under the pointer right now (no gesture)
  const modeListeners = new Set();
  const toolListeners = new Set();
  // Every listener hears every transition: the host application registers its
  // relay AFTER mount.js's own listeners, so a throw in one of ours must not
  // end the loop before the host is told — and must never escape setEnabled,
  // which send() calls after the ink is already discarded.
  const notifyMode = () => {
    for (const cb of [...modeListeners]) {
      try { cb(); } catch (err) { console.error("mode listener failed", err); }
    }
  };
  const notifyTool = () => { for (const cb of [...toolListeners]) cb(); };

  const rectOf = () => canvas.element.getBoundingClientRect();

  // ---- scene sync ------------------------------------------------------
  // One function, called on every store change (via the subscription below)
  // AND every gesture frame that doesn't touch the store — a draw-tool
  // preview, the eraser ring following the pointer, hover feedback.
  function syncScene() {
    canvas?.setScene({
      elements: gesture?.preview ? [...store.list(), gesture.preview] : store.list(),
      overlay: buildOverlay(),
    });
  }
  const offStore = store.onChange(syncScene);

  function reachParams(rect) {
    return {
      reach: Math.max(stageUnits(10, rect), 1.5 * strokeWidthPx(rect) / rect.height),
      handleR: stageUnits(HANDLE_PX, rect),
      band: stageUnits(ROTATE_BAND_PX, rect),
    };
  }

  // ---- draw-tool preview + overlay label helpers ------------------------
  function buildPreview(kind, x0, y0, x, y, event) {
    if (kind === "rect") {
      const { params } = rectFromDrag(x0, y0, x, y, { force: event.shiftKey, snapDistance: stageUnits(SNAP_PX, rectOf()) });
      return { type: "rect", color, width: DEFAULT_STROKE_WIDTH, params, gaps: [] };
    }
    if (kind === "ellipse") {
      const { params } = ellipseFromDrag(x0, y0, x, y, { force: event.shiftKey, snapDistance: stageUnits(SNAP_PX, rectOf()) });
      return { type: "ellipse", color, width: DEFAULT_STROKE_WIDTH, params, gaps: [] };
    }
    const { params } = lineFromDrag(x0, y0, x, y, {
      force: event.shiftKey,
      snapDistance: stageUnits(SNAP_PX, rectOf()),
    });
    return { type: "line", color, width: DEFAULT_STROKE_WIDTH, params, gaps: [] };
  }

  // Pixel-value label text, distinct from describeElement (which is
  // percentage-based and lives in the send() payload) — the brief wants the
  // live overlay readable at a glance while dragging.
  function shapeLabelText(el, rect) {
    const toPx = (v) => Math.round(v * rect.height);
    const p = el.params;
    if (el.type === "rect") {
      return p.w === p.h ? `${toPx(p.w)} · square` : `${toPx(p.w)} × ${toPx(p.h)}`;
    }
    if (el.type === "ellipse") {
      return p.rx === p.ry ? `r ${toPx(p.rx)}` : `rx ${toPx(p.rx)} ry ${toPx(p.ry)}`;
    }
    if (el.type === "line") {
      const len = Math.round(Math.hypot(p.x2 - p.x1, p.y2 - p.y1) * rect.height);
      const angle = Math.round(Math.atan2(p.y2 - p.y1, p.x2 - p.x1) * 180 / Math.PI);
      return `${len} · ${angle}°`;
    }
    return null;
  }

  function shapeGuide(el) {
    const p = el.params;
    if (el.type === "rect") return { kind: "rect", cx: p.cx, cy: p.cy, w: p.w, h: p.h };
    if (el.type === "ellipse") return { kind: "rect", cx: p.cx, cy: p.cy, w: p.rx * 2, h: p.ry * 2 };
    if (el.type === "line") return { kind: "cross", cx: p.x2, cy: p.y2 };
    return null;
  }

  function shapeLabelAnchor(el) {
    const p = el.params;
    if (el.type === "rect") return [p.cx + p.w / 2, p.cy - p.h / 2];
    if (el.type === "ellipse") return [p.cx + p.rx, p.cy - p.ry];
    // Line: the MIDPOINT, like a CAD dimension riding the line — the endpoint
    // is exactly the cursor, so a label anchored there always fights it.
    return [(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2];
  }

  function activeHandlePos(el, handleId) {
    // A dragged line endpoint IS the cursor; keep line labels at the midpoint.
    if (el.type === "line") return shapeLabelAnchor(el);
    const h = handlesOf(el).find((candidate) => candidate.id === handleId);
    return h ? [h.x, h.y] : shapeLabelAnchor(el);
  }

  function drawPreviewOverlay() {
    const rect = rectOf();
    const el = gesture.preview;
    const text = shapeLabelText(el, rect);
    const [lx, ly] = shapeLabelAnchor(el);
    return { guide: shapeGuide(el), label: text ? { x: lx, y: ly, text } : undefined };
  }

  function handEditOverlay() {
    const rect = rectOf();
    const text = shapeLabelText(gesture.el, rect);
    let label;
    if (text) {
      // Anchor at the handle actually being dragged when there is one, so the
      // label tracks the corner/endpoint under the pointer rather than a
      // fixed corner of the shape.
      const [lx, ly] = gesture.handleId
        ? activeHandlePos(gesture.el, gesture.handleId)
        : shapeLabelAnchor(gesture.el);
      label = { x: lx, y: ly, text };
    }
    return { glowEl: gesture.el, handlesEl: gesture.el, label };
  }

  function rotateOverlay() {
    const deg = Math.round((gesture.total || 0) * 180 / Math.PI);
    const sign = deg > 0 ? "+" : "";
    const [cx, cy] = gesture.center;
    return {
      glowEl: gesture.el,
      label: { x: cx, y: cy, text: `${sign}${deg}°` },
    };
  }

  function buildOverlay() {
    if (gesture) {
      switch (gesture.kind) {
        case "line": case "rect": case "ellipse":
          return drawPreviewOverlay();
        case "hand-move": case "hand-endpoint": case "hand-resize-rect": case "hand-resize-ellipse":
          return handEditOverlay();
        case "hand-rotate":
          return rotateOverlay();
        default:
          return {};
      }
    }
    if (tool === "hand" && hoverProbe) {
      const overlay = { glowEl: hoverProbe.el };
      if (hoverProbe.kind === "handle" || hoverProbe.kind === "outline") overlay.handlesEl = hoverProbe.el;
      return overlay;
    }
    return {};
  }

  // ---- hand-tool gesture construction ------------------------------------
  function buildHandGesture(p, x, y) {
    if (p.kind === "outline") {
      return { kind: "hand-move", el: p.el, lastX: x, lastY: y, mutatesStore: true };
    }
    if (p.kind === "handle") {
      if (p.el.type === "line") {
        return { kind: "hand-endpoint", el: p.el, handleId: p.handle.id, mutatesStore: true };
      }
      if (p.el.type === "rect") {
        return {
          kind: "hand-resize-rect", el: p.el,
          anchor: rectAnchorFor(p.el, p.handle), rot: p.el.params.rot || 0,
          handleId: p.handle.id, mutatesStore: true,
        };
      }
      return { kind: "hand-resize-ellipse", el: p.el, handleId: p.handle.id, mutatesStore: true }; // ellipse
    }
    // rotate
    const center = centerOf(p.el);
    const a0 = Math.atan2(y - center[1], x - center[0]);
    return { kind: "hand-rotate", el: p.el, center, a0, orig: structuredClone(p.el.params), mutatesStore: true };
  }

  function sameProbe(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.kind === b.kind && a.el === b.el && a.handle?.id === b.handle?.id;
  }

  function updateHover(x, y, rect) {
    const next = probe(store.list(), x, y, reachParams(rect));
    if (sameProbe(hoverProbe, next)) return;
    hoverProbe = next;
    syncScene();
    syncCursorClasses();
  }

  // ---- ink-canvas cursor classes -----------------------------------------
  // Chrome-only (no geometry here): sketch-toolbar.css keys off these to draw
  // the hand tool's grab/handle/rotate/grabbing states and the eraser's blank
  // cursor. `dragging` is deliberately narrower than "any hand gesture in
  // flight" — it means specifically a translate (hand-move); a resize/
  // endpoint/rotate gesture leaves whatever handle/rotate class was already
  // set by the hover that started it, because updateHover() is only called
  // between gestures (see onPointerMove) and hoverProbe is never cleared when
  // a gesture begins or ends.
  function syncCursorClasses() {
    if (!canvas) return;
    const cl = canvas.element.classList;
    cl.toggle("hand", tool === "hand");
    cl.toggle("erasing", tool === "eraser");
    const dragging = gesture?.kind === "hand-move";
    cl.toggle("dragging", dragging);
    const kind = tool === "hand" && !dragging ? hoverProbe?.kind : null;
    cl.toggle("over", kind === "outline");
    cl.toggle("handle", kind === "handle");
    cl.toggle("rotate", kind === "rotate");
  }

  // ---- pointer routing ---------------------------------------------------
  function beginGesture(x, y, event, rect) {
    if (tool === "pen") {
      store.snapshot();
      const el = { type: "freehand", color, width: DEFAULT_STROKE_WIDTH, params: { points: [[x, y]] }, gaps: [] };
      store.add(el);
      // Pen snapshots and mutates at pointerdown exactly like a hand edit —
      // the in-progress points ARE the committed element the whole time —
      // so Escape must roll it back the same way, not just drop it.
      return { kind: "pen", el, mutatesStore: true };
    }
    if (tool === "line" || tool === "rect" || tool === "ellipse") {
      return { kind: tool, x0: x, y0: y, preview: buildPreview(tool, x, y, x, y, event) };
    }
    if (tool === "eraser") {
      store.snapshot();
      return { kind: "eraser", lastX: x, lastY: y, mutatesStore: true };
    }
    // hand
    const p = probe(store.list(), x, y, reachParams(rect));
    if (!p) return null;
    store.snapshot();
    return buildHandGesture(p, x, y);
  }

  function handleGestureMove(x, y, event, rect) {
    switch (gesture.kind) {
      case "pen": {
        const added = appendThinned(gesture.el.params.points, x, y, FREEHAND_MIN_DIST);
        if (added) store.touch(gesture.el);
        return;
      }
      case "line": case "rect": case "ellipse": {
        gesture.preview = buildPreview(gesture.kind, gesture.x0, gesture.y0, x, y, event);
        syncScene();
        return;
      }
      case "eraser": {
        const radius = stageUnits(ERASER_PX, rect);
        const halfWidth = stageUnits(strokeWidthPx(rect) / 2, rect);
        const result = eraseSegment(store.list(), gesture.lastX, gesture.lastY, x, y, { radius, halfWidth });
        if (result.changed) store.setList(result.list); // notifies -> syncScene
        gesture.lastX = x; gesture.lastY = y;
        return;
      }
      case "hand-move": {
        translateElement(gesture.el, x - gesture.lastX, y - gesture.lastY);
        gesture.lastX = x; gesture.lastY = y;
        store.touch(gesture.el);
        return;
      }
      case "hand-endpoint": {
        const p = gesture.el.params;
        if (gesture.handleId === "p1") { p.x1 = x; p.y1 = y; } else { p.x2 = x; p.y2 = y; }
        store.touch(gesture.el);
        return;
      }
      case "hand-resize-rect": {
        resizeRectFromAnchor(gesture.el, gesture.anchor[0], gesture.anchor[1], gesture.rot, x, y, { force: event.shiftKey, snapDistance: stageUnits(SNAP_PX, rectOf()) });
        store.touch(gesture.el);
        return;
      }
      case "hand-resize-ellipse": {
        resizeEllipseHandle(gesture.el, gesture.handleId, x, y, { force: event.shiftKey, snapDistance: stageUnits(SNAP_PX, rectOf()) });
        store.touch(gesture.el);
        return;
      }
      case "hand-rotate": {
        const a = Math.atan2(y - gesture.center[1], x - gesture.center[0]);
        let total = a - gesture.a0;
        if (event.shiftKey) total = Math.round(total / (Math.PI / 12)) * (Math.PI / 12);
        gesture.total = total;
        applyRotation(gesture.el, gesture.orig, gesture.center, total);
        store.touch(gesture.el);
        return;
      }
      default:
    }
  }

  // isPrimary === false (a second simultaneous touch) is ignored; undefined
  // (plain MouseEvent, some test environments) behaves normally.
  const onPointerDown = (event) => {
    if (!enabled || event.isPrimary === false || gesture) return;
    const rect = rectOf();
    if (!rect.width || !rect.height) return;
    const [x, y] = stagePoint(event, rect);
    const next = beginGesture(x, y, event, rect);
    if (!next) return;
    gesture = next;
    canvas.element.setPointerCapture?.(event.pointerId);
    syncScene();
    syncCursorClasses();
  };

  const onPointerMove = (event) => {
    if (!enabled || event.isPrimary === false) return;
    const rect = rectOf();
    if (!rect.width || !rect.height) return;
    const [x, y] = stagePoint(event, rect);
    if (gesture) { handleGestureMove(x, y, event, rect); return; }
    if (tool === "hand") updateHover(x, y, rect);
    // eraser hover needs no per-move work: the brush ring is a CSS cursor
  };

  const onPointerEnd = (event) => {
    if (!gesture || event.isPrimary === false) return;
    const rect = rectOf();
    const [x, y] = stagePoint(event, rect);
    canvas.element.releasePointerCapture?.(event.pointerId);
    if (gesture.kind === "line" || gesture.kind === "rect" || gesture.kind === "ellipse") {
      const dxPx = (x - gesture.x0) * rect.height;
      const dyPx = (y - gesture.y0) * rect.height;
      if (Math.hypot(dxPx, dyPx) >= MIN_DRAG_PX) {
        store.snapshot();
        store.add(gesture.preview);
      }
    }
    gesture = null;
    syncScene();
    syncCursorClasses();
  };

  // Escape cancels an in-flight gesture, or — with none in flight — exits the
  // mode outright. Hand edits, the eraser, and pen all snapshot and mutate
  // the store at pointerdown, so they roll back via store.undo(); a draw-tool
  // preview never touches the store (that only happens at pointerup), so
  // dropping the gesture is enough there.
  //
  // The ink canvas (.pf-ink-canvas) is never focusable — it has no tabindex
  // and is never document.activeElement — so a keydown listener on
  // canvas.element itself can never fire from a real keystroke. Real Escape
  // keystrokes land wherever focus actually is and reach us only via
  // capture, which is why this listens on the canvas's ownerDocument in the
  // CAPTURE phase: document is the outermost node, so this runs before any
  // phase happens anywhere else in the tree.
  //
  // This mode now OWNS Escape-driven exit, rather than deferring to the
  // chrome (annotate-controls.js's bubble-phase handler on
  // viewer.domElement/button). While sketch mode is on, the sketch toolbar
  // replaces #viewbar at the top of the stage (sketch-toolbar.js / mount.js),
  // so the pencil toggle that used to hold that Escape handler is hidden and
  // unreachable — focus has nowhere to land that bubbles through it. This
  // document-capture listener is the only reliable keyboard path left, so it
  // has to do the exiting itself: when there is no gesture, and the mode is
  // enabled, Escape exits the mode. Either way (gesture cancelled, or mode
  // exited) the event is consumed here (preventDefault + stopPropagation, the
  // latter during capture halting capture/target/bubble entirely) so it can
  // never also reach downstream chrome that treats Escape as ITS exit key
  // (cutaway, measure) — a single Escape press must resolve to exactly one
  // effect.
  const onEscapeCapture = (event) => {
    if (event.key !== "Escape") return;
    // A host composer (partforge-cloud shows one during sketch, to gather
    // notes alongside the drawing) can be focused while sketch mode is still
    // enabled. Escape there is the user editing text, not a request to leave
    // sketch mode — since exiting calls store.reset() and discards the whole
    // drawing irrecoverably, this guard must not act or consume the event,
    // so it falls through to the field's own (or the browser's) handling.
    const target = event.target;
    const tag = target?.tagName;
    if (target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (gesture) {
      if (gesture.mutatesStore) store.undo();
      gesture = null;
      syncScene();
      syncCursorClasses();
    } else {
      // This listener is only attached while enabled (see setEnabled below),
      // so reaching here with no gesture means: exit the mode.
      setEnabled(false);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  let escapeDoc = null; // the document currently holding the capture-phase Escape listener

  function ensureCanvas() {
    if (canvas) return;
    canvas = createCanvas(stage);
    canvas.element.addEventListener("pointerdown", onPointerDown);
    canvas.element.addEventListener("pointermove", onPointerMove);
    canvas.element.addEventListener("pointerup", onPointerEnd);
    canvas.element.addEventListener("pointercancel", onPointerEnd);
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      ensureCanvas();
      canvas.show();
      escapeDoc = canvas.element.ownerDocument;
      escapeDoc?.addEventListener("keydown", onEscapeCapture, true);
    } else {
      gesture = null;
      hoverProbe = null;
      store.reset(); // spec: ink never survives an exit; tool/color do
      canvas?.hide();
      escapeDoc?.removeEventListener("keydown", onEscapeCapture, true);
      escapeDoc = null;
    }
    syncCursorClasses();
    notifyMode();
  }

  // The camera pose in two frames. World replays exactly against THIS build;
  // the parts frame (through the inverse of the shared parts parent's
  // matrixWorld — the measure-mode idiom) stays pinned to the CAD geometry, so
  // it survives the per-view bbox recentring when the model is rebuilt later.
  // The shared parts parent's inverse world matrix, or null when no meshes
  // exist. cameraBlock() and send()'s anchor-ray loop both map through this —
  // one definition keeps the payload's parts frame single-sourced.
  function partsInverse() {
    const parent = Object.values(viewer._subMeshes ?? {})[0]?.parent ?? null;
    if (!parent) return null;
    parent.updateWorldMatrix(true, false);
    return parent.matrixWorld.clone().invert();
  }

  function cameraBlock(inv) {
    // The target from getCameraState, the position from the LIVE camera: under
    // ortho getCameraState reports a perspective-equivalent position (for
    // restoring a framing), while this block describes the camera that
    // actually drew the frame.
    const { target } = viewer.getCameraState();
    const cam = viewer.camera;
    const pos = cam.position.toArray();
    const ortho = !!cam.isOrthographicCamera;
    // 4 decimals ≈ 0.1 µm at mm scale — far below anything a sketch encodes,
    // and it keeps float dust (1e-16 up-vector components) out of what an LLM
    // reads.
    const r4 = (v) => v.map((q) => +q.toFixed(4));
    const world = {
      pos: r4(pos),
      target: r4(target),
      up: r4(cam.up.toArray()),
      projection: ortho ? "orthographic" : "perspective",
      fov: ortho ? null : +cam.fov.toFixed(4),
      orthoHeight: ortho ? +(Math.abs(cam.top - cam.bottom) / Math.max(cam.zoom, 1e-6)).toFixed(4) : null,
    };
    if (!inv) return { world, parts: null };
    const map = (v) => r4(new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(inv).toArray());
    const up = r4(new THREE.Vector3(world.up[0], world.up[1], world.up[2]).transformDirection(inv).toArray());
    return {
      world,
      parts: {
        pos: map(world.pos),
        target: map(world.target),
        up,
        // Camera intrinsics, not coordinates: they describe the lens, so they
        // cross frames unchanged. `fov` alone would leave a consumer reading
        // only this frame with a null and no way to know an ortho camera
        // caused it — the exact hole ANNOTATION_VERSION 2 exists to close.
        projection: world.projection,
        fov: world.fov,
        orthoHeight: world.orthoHeight,
      },
    };
  }

  function send() {
    if (!enabled || store.isEmpty()) return false;
    const rect = rectOf();
    if (!rect.width || !rect.height) return false;
    const { width, height, dpr } = canvas.size();
    // Model render FIRST: on a lost WebGL context captureCurrent returns null
    // and we abort with the elements intact — nothing is silently dropped.
    const model = viewer.captureCurrent({ size: Math.min(Math.max(width, height), SEND_MAX_EDGE) });
    if (!model) return false;
    const aspect = rect.width / rect.height;
    const round4 = (v) => +v.toFixed(4);
    const roundParams = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) =>
      [k, Array.isArray(v) ? v.map((q) => q.map(round4)) : round4(v)]));
    // rot ships in both units: radians (`rot`, the internal representation)
    // and degrees folded to (-180, 180] (`rotDeg`, matching the description).
    const withRotDeg = (p) => {
      if (!("rot" in p)) return p;
      let d = (p.rot * 180) / Math.PI % 360;
      if (d > 180) d -= 360;
      if (d <= -180) d += 360;
      return { ...p, rotDeg: +d.toFixed(2) };
    };
    const inv = partsInverse();
    // Per-anchor pick rays, from the LIVE camera (the exact code path that
    // produces `hit`), origin canonicalized to the point on the ray line
    // nearest the camera position — a no-op for perspective, and for
    // orthographic it slides three's near-plane origin onto the plane through
    // the camera position, making the embedded ray definitionally identical
    // to annotationRay's reconstruction (spec: annotation-ray design).
    const rayCaster = new THREE.Raycaster();
    const anchorRay = (screen) => {
      if (!inv) return null; // no parts frame → no ray (same rule as hits)
      rayCaster.setFromCamera(new THREE.Vector2(2 * screen[0] - 1, 1 - 2 * screen[1]), viewer.camera);
      const { origin, direction } = rayCaster.ray;
      const along = viewer.camera.position.clone().sub(origin).dot(direction);
      origin.add(direction.clone().multiplyScalar(along));
      origin.applyMatrix4(inv);
      direction.transformDirection(inv); // rigid → exact for directions
      return { origin: origin.toArray().map(round4), dir: direction.toArray().map(round4) };
    };
    const elements = store.list().map((el, i) => ({
      id: `e${i + 1}`, // stable within this payload — how a reply names an element
      type: el.type,
      color: { name: el.color, hex: INK_COLORS[el.color] },
      width: el.width,
      params: withRotDeg(el.type === "ellipse" && el.params.rx === el.params.ry
        ? { cx: round4(el.params.cx), cy: round4(el.params.cy), r: round4(el.params.rx), rot: round4(el.params.rot || 0), circle: true }
        : el.type === "rect"
          ? { ...roundParams(el.params), square: el.params.w === el.params.h }
          : roundParams(el.params)),
      erased: el.gaps.map(([a, b]) => [round4(a), round4(b)]),
      visibleFraction: +visibleFraction(el).toFixed(3),
      description: `${el.color} ${describeElement(el, aspect)}`,
      anchors: elementAnchors(el).map(({ at, run, x, y }) => {
        const screen = [x / aspect, y]; // per-axis normalized, the v2 screen frame
        const hit = raycastViewer(viewer,
          rect.left + screen[0] * rect.width, rect.top + screen[1] * rect.height);
        const ray = anchorRay(screen);
        return {
          at,
          ...(run !== undefined ? { run } : {}), // center anchors span all runs
          screen: screen.map(round4),
          ...(ray ? { ray } : {}), // omitted, not null, when no parts frame
          hit: hit ? { subPart: hit.subPart, pointLocal: hit.pointLocal } : null,
        };
      }),
    }));
    const { view, params } = getContext();
    onSend?.({
      version: ANNOTATION_VERSION,
      summary: `${elements.length} annotation${elements.length === 1 ? "" : "s"}: ${elements.map((e) => e.description).join("; ")}`,
      frames: FRAME_LEGEND,
      elements,
      images: { drawing: canvas.toDataUrl({ maxEdge: SEND_MAX_EDGE }), model },
      camera: cameraBlock(inv),
      viewport: { width: rect.width, height: rect.height, aspect: round4(aspect), dpr },
      context: { view, params: { ...params } },
    });
    setEnabled(false); // sent: exit and discard
    return true;
  }

  let detached = false;
  return {
    setEnabled,
    isEnabled: () => enabled,
    undo: () => store.undo(),
    clear: () => store.clear(),
    strokeCount: () => store.count(),
    send,
    setTool(next) {
      if (next === tool) return;
      tool = next;
      gesture = null;
      hoverProbe = null;
      syncScene();
      syncCursorClasses();
      notifyTool();
    },
    tool: () => tool,
    setColor(next) {
      if (next === color) return;
      color = next;
      notifyTool();
    },
    color: () => color,
    canUndo: () => store.canUndo(),
    onInkChange: (cb) => store.onChange(cb),
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    onToolChange: (cb) => { toolListeners.add(cb); return () => toolListeners.delete(cb); },
    detach() {
      if (detached) return;
      detached = true;
      // Leave the state machine honest: a detach while enabled must not
      // strand isEnabled() at true forever. Runs before listeners/canvas
      // teardown below — setEnabled(false) notifies mode listeners and hides
      // the canvas, both of which still need to be live for this call.
      setEnabled(false);
      offStore();
      if (!canvas) return;
      canvas.element.removeEventListener("pointerdown", onPointerDown);
      canvas.element.removeEventListener("pointermove", onPointerMove);
      canvas.element.removeEventListener("pointerup", onPointerEnd);
      canvas.element.removeEventListener("pointercancel", onPointerEnd);
      canvas.dispose();
    },
  };
}
