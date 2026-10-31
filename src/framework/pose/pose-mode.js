// Posing's orchestrator: pointer and orbit arbitration, hover, and the drag loop
// that feeds pose-session.js. The one pose module that touches the DOM and three.js
// together (pose-scene.js draws; pose-session.js decides; this file listens).
//
// Posing is ALWAYS ON in the viewer's normal click mode: it is "live" while the host
// has not switched it off (setEnabled) and mount has not suppressed it (setSuppressed:
// measure, sketch, cutaway or a cached preview is on). At rest nothing is drawn but pin
// badges. A mouse pointer within NEAR_LIMB_PX of a limb's projected bones shows that
// limb's dots (the closest limb wins); a dot under the pointer is highlighted and takes
// a grab cursor, and while one is, mount suppresses the model's hover tooltip
// (claimsHover / onHoverChange). Touch has no hover: a touch press within TOUCH_HIT_PX
// of any limb's dot grabs it.
//
// A goal handle with `aim` shows the AIM GIZMO (aim-gizmo.js, built on the cutaway
// control's shared gizmo code) instead of a plain dot: a centre ball on the goal point
// and a rotate ring per aim parameter, each with the cutaway's hover state. It shows
// while its limb is hovered and stays up while any of its parts is dragged. Dragging the
// ball is dragging the dot (the camera-facing plane through the point); dragging a ring
// writes that aim angle (session.ringFrame) through the shared rotate-drag math. Touch:
// a touch on the goal point (a tap or a drag) leaves the gizmo up until a touch lands
// anywhere else, so a finger can reach the rings; the first tap only shows it, a tap on
// the ball while it is up toggles the pin as a mouse click does.
//
// Arbitration copies cutaway-gizmo.js: a CAPTURE-phase pointerdown on the canvas that,
// on a handle hit, turns orbit off and takes pointer capture before OrbitControls sees
// the press; orbit comes back on pointerup, pointercancel, lostpointercapture and window
// blur. A press that misses every handle is left alone, so orbit and click-to-pick never
// notice posing. A press that hit a handle claims its click: the picker asks takeClick()
// and opens nothing, whether the press was a click (a pin toggle) or a drag.
// drag-tracker.js tells a click (toggle a pin on a tip) from a drag (begin a session):
// the session begins only once the pointer has moved past the threshold, so a click
// never snapshots, holds or commits anything.
//
// Frames: the overlay and every limb point are in PART coordinates (the sub-meshes'
// shared parent — the pivot stands model Z up and recentres per view). Pointer rays come
// from the camera in WORLD coordinates and are carried into the parts frame through that
// parent's inverse world matrix; part points go the other way for projectPoint.
import * as THREE from "three";
import { createDragTracker } from "../selection/drag-tracker.js";
import { worldPerPx, orthoWorldPerPx } from "../measure/dim3-scene.js";
import { createPoseScene } from "./pose-scene.js";
import { createAimGizmo, AIM_RING_PX, AIM_RING_HIT_PX } from "./aim-gizmo.js";
import { beginRotateDrag, rotateDragAngle } from "../gizmo/gizmo-rotate.js";
import { createPoseSession, pinId, parsePinId } from "./pose-session.js";
import { dragPlanePoint, hitHandle } from "./pose-geom.js";
import { limbInfo } from "./param-solve.js";
import { aimTurn } from "../solve/aim.js";

/** A dot's hit radius, CSS px: a 28 px target around a 12 px dot. */
export const HANDLE_HIT_PX = 14;
/** How near a limb's projected bones the mouse must be to show that limb's dots. */
export const NEAR_LIMB_PX = 32;
/** A touch press this near any limb's dot grabs it (touch has no hover to show dots first). */
export const TOUCH_HIT_PX = 24;
/** A hinge this near (degrees) its range end reads as clamped. */
const CLAMP_EPS_DEG = 1e-3;
const AIM_NAMES = ["pitch", "yaw", "roll"];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Distance in px from (px, py) to the segment a-b. */
function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

/** The chain's points in order: each joint, then the tip. */
const chainOf = (info) => [...info.joints.map((j) => info.points[j.name]), info.points.tip].filter(Array.isArray);

/** Joint to joint to tip, mm. */
function chainLength(info) {
  const c = chainOf(info);
  let l = 0;
  for (let i = 1; i < c.length; i++) l += len(sub(c[i], c[i - 1]));
  return l;
}

/** Per-joint "on its range end" flags, in the limb's joint order (hinges only). */
function clampedFlags(info) {
  return info.joints.map((j, i) => {
    const v = info.values?.[i];
    if (j.type === "ball" || !Array.isArray(j.range) || typeof v !== "number") return false;
    return v <= j.range[0] + CLAMP_EPS_DEG || v >= j.range[1] - CLAMP_EPS_DEG;
  });
}

/**
 * The aim rings' axes at a goal handle: `[pitch, yaw, roll]` (as many as `angles` has),
 * the axis each of the handle's aim parameters turns the aim about, from the handle's
 * rest `toward` and the parameters' current values (the aimFromAngles convention,
 * solve/aim.js). Read from the values, never from the posed limb: at pitch ±90 the aim is
 * vertical and the pitch axis cannot be recovered from it. Empty for a bad `toward`.
 */
export function aimAxes(toward, angles) {
  if (!Array.isArray(toward) || toward.length !== 3 || !toward.every(Number.isFinite) || !(len(toward) > 0)) return [];
  if (!Array.isArray(angles)) return [];
  const [pitch = 0, yaw = 0, roll = 0] = angles.map((v) => (Number.isFinite(v) ? v : 0));
  return aimTurn(toward, { pitch, yaw, roll }).axes.slice(0, Math.min(3, angles.length));
}

/**
 * @param viewer the viewer (camera, domElement, projectPoint, onFrame, onThemeChange,
 *   _subMeshes, requestRender).
 * @param opts.part the PartDefinition (its `handles`).
 * @param opts.orbitControls the viewer's OrbitControls (createViewer's `orbitControls`).
 * @param opts.visibleHandles () => handle ids to show in the current view (default: all).
 * Session effects, passed through to createPoseSession: getParams, write, commit,
 * restore, staleSubParts, ghost, unghost, hold. Optional: schedule (rAF), createScene,
 * createGizmo (the aim gizmo).
 */
export function createPoseMode(viewer, {
  part,
  orbitControls = null,
  getParams,
  write,
  commit,
  restore,
  staleSubParts,
  ghost,
  unghost,
  hold,
  visibleHandles = () => Object.keys(part?.handles ?? {}),
  schedule = (cb) => requestAnimationFrame(cb),
  createScene = createPoseScene,
  createGizmo = createAimGizmo,
}) {
  const handles = part?.handles && typeof part.handles === "object" ? part.handles : {};
  const dom = viewer.domElement;
  const modeListeners = new Set();
  const pinListeners = new Set();
  const notify = (set, ...args) => {
    for (const cb of [...set]) {
      try { cb(...args); } catch (err) { console.error("pose mode listener failed", err); }
    }
  };

  let enabled = true;       // the host's switch (runtime.pose.setEnabled)
  let suppressed = false;   // mount's: measure, sketch, cutaway or a cached preview is on
  let live = false;         // enabled && !suppressed && !detached — applied by applyLive
  let detached = false;
  let scene = null;
  let gizmo = null;        // the aim gizmo (created with the scene)
  let touchGizmoLimb = null; // touch: the limb whose aim gizmo a touch left up
  let shown = [];          // [{ handleId, handle, info }] — one per handle with a posed limb
  let stale = true;        // params moved since `shown` was read; re-read lazily (ensureFresh)
  let screenCache = null;  // shown limbs projected to the canvas; dropped every frame
  let hoverLimb = null;
  let hoverHit = null;     // the dot or ring under the mouse (null: none)
  let press = null;        // the pointer press on a handle; `started` once it is a drag
  let clickClaimed = false; // the last press grabbed a handle: its click is not a pick
  let lastParams = null;   // shallow copy, to notice outside param changes per frame
  let pendingMove = null;
  let moveScheduled = false;
  let cursorSet = false;
  const hoverListeners = new Set();

  const session = createPoseSession({
    part, getParams, write, commit, restore, staleSubParts, ghost, unghost, hold,
    onCancel: () => finishPress(),
    onPinsChange: () => { syncPins(); notify(pinListeners); },
  });
  const tracker = createDragTracker();

  function setCursor(c) {
    if (c) { dom.style.cursor = c; cursorSet = true; }
    else if (cursorSet) { dom.style.cursor = ""; cursorSet = false; }
  }

  // ---- frames ---------------------------------------------------------------
  const partsFrame = () => Object.values(viewer._subMeshes ?? {})[0]?.parent ?? null;
  const _v = new THREE.Vector3();
  const _inv = new THREE.Matrix4();
  const raycaster = new THREE.Raycaster();

  function worldMatrix() {
    const f = partsFrame();
    if (!f) return null;
    f.updateWorldMatrix(true, false);
    return f.matrixWorld;
  }
  /** A part point on the canvas, CSS px relative to the canvas's top-left. */
  function toScreen(p) {
    const m = worldMatrix();
    if (!m || !Array.isArray(p)) return null;
    _v.set(p[0], p[1], p[2]).applyMatrix4(m);
    const s = viewer.projectPoint([_v.x, _v.y, _v.z]);
    return s && Number.isFinite(s.x) && Number.isFinite(s.y) ? s : null;
  }
  function local(ev) {
    const r = dom.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width, h: r.height };
  }
  /** The pointer's ray in part coordinates: { origin, dir, forward } (forward: camera look). */
  function partRay(ev) {
    const m = worldMatrix();
    const { x, y, w, h } = local(ev);
    if (!m || !(w > 0) || !(h > 0)) return null;
    const cam = viewer.camera;
    cam.updateMatrixWorld?.();
    raycaster.setFromCamera({ x: (x / w) * 2 - 1, y: -(y / h) * 2 + 1 }, cam);
    _inv.copy(m).invert();
    const o = raycaster.ray.origin.clone().applyMatrix4(_inv);
    const d = raycaster.ray.direction.clone().transformDirection(_inv);
    const f = cam.getWorldDirection(new THREE.Vector3()).transformDirection(_inv);
    return { origin: o.toArray(), dir: d.toArray(), forward: f.toArray() };
  }
  /** Part mm per CSS px at a part point — the scale pose-scene sizes its rings by. */
  function mmPerPx(p) {
    const m = worldMatrix();
    const cam = viewer.camera;
    const h = dom.clientHeight || 1;
    if (cam.isOrthographicCamera) return orthoWorldPerPx(cam.top, cam.bottom, cam.zoom, h);
    if (!m) return 1;
    _v.set(p[0], p[1], p[2]).applyMatrix4(m);
    return worldPerPx(cam.position.distanceTo(_v), cam.fov ?? 45, h);
  }

  // ---- model ----------------------------------------------------------------
  function refresh() {
    if (!live || !scene) return;
    stale = false;
    screenCache = null;
    const params = getParams();
    lastParams = { ...params };
    const ids = (visibleHandles() ?? []).filter((id) => handles[id]);
    const seen = new Set();
    shown = [];
    const infos = [];
    for (const handleId of ids) {
      const handle = handles[handleId];
      const info = limbInfo(part, params, handle);
      if (!info) continue;
      shown.push({ handleId, handle, info });
      if (!seen.has(info.name)) { seen.add(info.name); infos.push(info); }
    }
    scene.setLimbs(infos);
    syncPins();
    syncRings();
  }
  /** Re-read the limbs if params moved since the last read (hit tests call this first). */
  function ensureFresh() {
    if (live && scene && (stale || paramsMoved())) refresh();
  }
  /** Anything pose-related on screen that a param change must move. */
  const drawsAnything = () => !!(hoverLimb || press || session.pins.length);

  function paramsMoved() {
    if (!lastParams) return true;
    const p = getParams();
    const keys = new Set([...Object.keys(p), ...Object.keys(lastParams)]);
    for (const k of keys) if (!Object.is(p[k], lastParams[k])) return true;
    return false;
  }

  function syncPins() {
    if (!scene) return;
    const limbs = [];
    for (const id of session.pins) {
      const pin = parsePinId(id);
      const limb = pin && handles[pin.handleId]?.limb;
      if (limb && !limbs.includes(limb)) limbs.push(limb);
    }
    scene.setPins(limbs);
  }

  const goalAt = (handle) => (typeof handle.at === "string" ? handle.at : "tip");
  const hasAim = (handle) => handle.mode === "goal" && Array.isArray(handle.params?.aim) && handle.params.aim.length >= 2;

  /** The aim gizmo's target on `limb`'s goal handle with `aim`: `{ handleId, handle, info, at, axes }`, or null. */
  function gizmoTarget(limb) {
    if (!limb) return null;
    const s = shown.find((e) => e.info.name === limb && hasAim(e.handle));
    if (!s) return null;
    const at = s.info.points[goalAt(s.handle)];
    if (!Array.isArray(at)) return null;
    const params = getParams?.() ?? {};
    const angles = s.handle.params.aim.map((k) => (Number.isFinite(params[k]) ? params[k] : part.defaults?.[k]));
    const axes = aimAxes(s.handle.toward, angles);
    return axes.length ? { ...s, at, axes } : null;
  }
  /** The aim gizmo that shows: the pressed limb's, else the hovered one's, else a touch's. */
  const ringTarget = () => gizmoTarget(press ? press.limb : hoverLimb ?? touchGizmoLimb);
  function syncRings() {
    const r = ringTarget();
    gizmo?.show(r ? { at: r.at, axes: r.axes } : null);
    scene?.setAimGizmo(r ? { limb: r.info.name, at: goalAt(r.handle) } : null);
    syncGizmoHover();
  }
  /** The gizmo part to style as hovered: the pressed one, else the one under the mouse. */
  function syncGizmoHover() {
    const h = press?.hit ?? hoverHit;
    gizmo?.setHovered(h?.gizmo ?? null);
  }

  // ---- hit testing ----------------------------------------------------------
  /** The dot names a handle offers: a goal handle's `at`; an angles limb's tip and joints. */
  const dotsOf = (handle, info) => (handle.mode === "goal" ? [goalAt(handle)] : ["tip", ...info.joints.map((j) => j.name)]);

  /**
   * Every shown limb on the canvas, projected at most once per frame (the frame hook
   * drops the cache) and once per refresh: `{ limbs: Map(name -> [screen pts of its
   * bones]), dots: [{ x, y, hit }] }`. Pointer moves read this — never derive.
   */
  function screen() {
    if (screenCache) return screenCache;
    const limbs = new Map();
    const dots = [];
    for (const { handleId, handle, info } of shown) {
      if (!limbs.has(info.name)) limbs.set(info.name, chainOf(info).map(toScreen));
      for (const at of dotsOf(handle, info)) {
        const s = toScreen(info.points[at]);
        if (s && s.visible !== false) dots.push({ x: s.x, y: s.y, hit: { kind: "dot", handleId, at, limb: info.name } });
      }
    }
    screenCache = { limbs, dots };
    return screenCache;
  }

  /** The limb whose projected bones run nearest (x, y), within NEAR_LIMB_PX, else null. */
  function nearestLimb(x, y) {
    let best = null, bestD = NEAR_LIMB_PX;
    for (const [name, pts] of screen().limbs) {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[i + 1] ?? null;
        if (!a) continue;
        const d = b ? segDist(x, y, a, b) : Math.hypot(x - a.x, y - a.y);
        if (d <= bestD) { bestD = d; best = name; }
      }
    }
    return best;
  }

  /** The dot nearest (x, y) within `radius`, among `limb`'s dots (null: every limb's). */
  function dotAt(x, y, limb, radius) {
    const cands = screen().dots
      .filter((d) => limb === null || d.hit.limb === limb)
      .map((d, id) => ({ id, x: d.x, y: d.y, hit: d.hit }));
    const id = hitHandle(cands, x, y, radius);
    return id === null ? null : cands[id].hit;
  }

  /**
   * The aim gizmo part at the canvas point for `target` (gizmoTarget), as a hit: the
   * ball is the goal point's dot `{ kind: "dot", handleId, at, limb, gizmo: "ball" }`,
   * a ring `{ kind: "ring", handleId, limb, axis, name, at, gizmo: name }`.
   */
  function gizmoHit(target, pt, touch = false) {
    if (!target || !gizmo) return null;
    const part = gizmo.pick(pt, { target: { at: target.at, axes: target.axes }, touch });
    if (!part) return null;
    const limb = target.info.name;
    if (part === "ball") return { kind: "dot", handleId: target.handleId, at: goalAt(target.handle), limb, gizmo: "ball" };
    const i = AIM_NAMES.indexOf(part);
    return { kind: "ring", handleId: target.handleId, limb, axis: target.axes[i], name: part, at: target.at, gizmo: part };
  }

  /** Inside the gizmo's rings, so they do not vanish on the way to one. */
  function insideGizmo(target, x, y) {
    if (!target) return null;
    const s = toScreen(target.at);
    return s && Math.hypot(x - s.x, y - s.y) <= AIM_RING_PX + AIM_RING_HIT_PX ? target.info.name : null;
  }

  /**
   * What the mouse at the canvas point `pt` hovers: `{ limb, hit }`. The shown aim
   * gizmo is tried first (its rings reach past NEAR_LIMB_PX), then the nearest limb —
   * its aim gizmo if it has one, else its dots — then the inside of the shown gizmo.
   * `hit` is `{ kind: "dot", handleId, at, limb, gizmo? }`,
   * `{ kind: "ring", handleId, limb, axis, name, at, gizmo }` or null.
   */
  function hoverAt(pt) {
    const { x, y } = pt;
    const cur = ringTarget();
    const onGizmo = gizmoHit(cur, pt);
    if (onGizmo) return { limb: onGizmo.limb, hit: onGizmo };
    const limb = nearestLimb(x, y);
    if (limb) {
      const near = limb === cur?.info.name ? null : gizmoTarget(limb);
      const hit = gizmoHit(near, pt);
      return { limb, hit: hit ?? dotAt(x, y, limb, HANDLE_HIT_PX) };
    }
    return { limb: insideGizmo(cur, x, y), hit: null };
  }

  const sameHit = (a, b) => (a === b) || (!!a && !!b && a.kind === b.kind && a.handleId === b.handleId && a.at === b.at && a.name === b.name && a.gizmo === b.gizmo);

  function setHover(limb, hit = null) {
    const limbChanged = limb !== hoverLimb;
    const hitChanged = !sameHit(hit, hoverHit);
    if (!limbChanged && !hitChanged) return;
    const claimed = claimsHover();
    hoverLimb = limb;
    hoverHit = hit;
    scene?.setHover(limb, hit?.kind === "dot" ? hit.at : null);
    if (limbChanged) syncRings();
    else syncGizmoHover();
    if (claimsHover() !== claimed) notify(hoverListeners);
  }

  /** A pose dot or ring is under the mouse, or a pose press is on: the model's hover tooltip stands down. */
  function claimsHover() { return !!(hoverHit || press); }

  // ---- the drag -------------------------------------------------------------
  function safeCapture(id) { try { dom.setPointerCapture?.(id); } catch { /* pointer already gone */ } }
  function safeRelease(id) { try { dom.releasePointerCapture?.(id); } catch { /* already lost */ } }

  /** Undo the press's UI hold (orbit, capture, overlay). Idempotent; never touches the session. */
  function finishPress() {
    if (!press) return;
    const ending = press;
    press = null;
    pendingMove = null;
    if (orbitControls) orbitControls.enabled = ending.orbitEnabled;
    safeRelease(ending.pointerId);
    window.removeEventListener("keydown", onKeyDown, true);
    setCursor(ending.touch ? "" : hoverHit ? "grab" : "");
    scene?.setActive(null);
    refresh();
    // Touch has no hover: the limb its press showed goes away with the finger — unless
    // the touch left its aim gizmo up (touchGizmoLimb), which stays until a touch elsewhere.
    if (ending.touch) setHover(touchGizmoLimb);
    syncRings();
    notify(hoverListeners);
  }

  /** Cross the drag threshold: snapshot, hold, and fix the drag plane / ring frame. */
  function startDrag(ev) {
    const { hit } = press;
    const s = shown.find((e) => e.handleId === hit.handleId);
    const grab = hit.kind === "dot" ? s?.info.points[hit.at] : null;
    if (!s || (hit.kind === "dot" && !Array.isArray(grab))) { finishPress(); return false; }
    if (!session.begin(hit.handleId, hit.kind === "ring" ? "ring" : hit.at)) { finishPress(); return false; }
    press.started = true;
    setCursor("grabbing");
    notify(hoverListeners); // a drag began (mount closes a selection popover)
    const ray = press.ray;
    if (hit.kind === "dot") {
      const maxDist = 4 * Math.max(chainLength(s.info), 1);
      const normal = ray.forward;
      // The press may sit up to HANDLE_HIT_PX off the dot: carry that offset, so the
      // point does not jump to the cursor on the first frame.
      const pressHit = dragPlanePoint(ray.origin, ray.dir, grab, normal, maxDist);
      press.plane = { point: grab, normal, maxDist, offset: sub(grab, pressHit) };
    } else {
      // the shared rotate drag (gizmo/gizmo-rotate.js), in part coordinates
      const axis = new THREE.Vector3(...unit(hit.axis));
      const center = new THREE.Vector3(...hit.at);
      const rotate = beginRotateDrag({
        ray: new THREE.Ray(new THREE.Vector3(...ray.origin), new THREE.Vector3(...unit(ray.dir))),
        center,
        axis,
        alignment: Math.abs(dot(unit(ray.dir), axis.toArray())),
        projectToClient: (v) => { const p = toScreen(v.toArray()); return p ? new THREE.Vector2(p.x, p.y) : null; },
      });
      if (!rotate) { session.cancel(); return false; }
      press.ring = { ...rotate, axis, center, name: hit.name };
    }
    syncRings();
    return true;
  }

  function dragFrame(ev) {
    if (!press?.started || !session.isActive()) return;
    const ray = partRay(ev);
    if (!ray) return;
    const { hit } = press;
    let target = null;
    if (hit.kind === "dot") {
      const { point, normal, maxDist, offset } = press.plane;
      target = add(dragPlanePoint(ray.origin, ray.dir, sub(point, offset), normal, maxDist), offset);
      if (!session.frame(target)) return;
    } else {
      const ring = press.ring;
      const { x, y } = local(ev);
      const angle = rotateDragAngle(ring, {
        ray: new THREE.Ray(new THREE.Vector3(...ray.origin), new THREE.Vector3(...unit(ray.dir))),
        center: ring.center,
        axis: ring.axis,
        pointerDelta: new THREE.Vector2(x - press.x, y - press.y),
        unwrap: true, // a turn past ±180 keeps counting
      });
      if (angle == null || !session.ringFrame(ring.name, (angle * 180) / Math.PI)) return;
    }
    refresh();
    const s = shown.find((e) => e.handleId === hit.handleId);
    if (!s) return;
    const grabbed = hit.kind === "dot" ? s.info.points[hit.at] : null;
    scene?.setActive({
      limb: s.info.name,
      grab: hit.kind === "dot" ? hit.at : goalAt(s.handle),
      clamped: clampedFlags(s.info),
      target: target ?? undefined,
      residual: target && grabbed ? len(sub(grabbed, target)) : undefined,
    });
    viewer.requestRender?.();
  }

  function flushMove() {
    const ev = pendingMove;
    pendingMove = null;
    if (ev) dragFrame(ev);
  }

  // ---- listeners ------------------------------------------------------------
  function onPointerDown(ev) {
    // Every press starts unclaimed: a claim lives from a handle press to its click.
    clickClaimed = false;
    if (!live || detached || press || (ev.button != null && ev.button !== 0)) return;
    ensureFresh();
    const pt = local(ev);
    const { x, y } = pt;
    const touch = ev.pointerType === "touch";
    let hit;
    if (touch) {
      // No hover came before: the aim gizmo a touch left up, else any limb's dot within
      // the finger's reach (an aim handle's goal point counts as its ball).
      hit = gizmoHit(gizmoTarget(touchGizmoLimb), pt, true) ?? dotAt(x, y, null, TOUCH_HIT_PX);
      if (hit?.kind === "dot" && !hit.gizmo && gizmoTarget(hit.limb)?.handleId === hit.handleId) hit = { ...hit, gizmo: "ball" };
      if (touchGizmoLimb && hit?.limb !== touchGizmoLimb) {
        // a touch anywhere else puts the gizmo away
        touchGizmoLimb = null;
        if (!hit) { setHover(null); return; }
      }
    } else {
      // fresh from this press (a press need not follow a move)
      const h = hoverAt(pt);
      setHover(h.limb, h.hit);
      hit = h.hit;
    }
    if (!hit) return;
    const ray = partRay(ev);
    if (!ray) return;
    press = {
      pointerId: ev.pointerId, hit, limb: hit.limb, ray, x, y, touch,
      // touch: was this limb's aim gizmo already up? (a first tap only shows it)
      gizmoWasUp: touch && touchGizmoLimb === hit.limb,
      orbitEnabled: orbitControls?.enabled, started: false, plane: null, ring: null,
    };
    clickClaimed = true;
    if (touch) setHover(hit.limb, hit);
    syncGizmoHover();
    tracker.onDown(ev);
    if (orbitControls) orbitControls.enabled = false;
    safeCapture(ev.pointerId);
    window.addEventListener("keydown", onKeyDown, true);
    ev.preventDefault();
    notify(hoverListeners);
  }

  function onPointerMove(ev) {
    if (!live || detached) return;
    if (press) {
      if (ev.pointerId !== press.pointerId) return;
      tracker.onMove(ev);
      if (!press.started) {
        // drag-tracker's flag is read through consumeClick only; mirror its threshold
        const { x, y } = local(ev);
        if ((x - press.x) ** 2 + (y - press.y) ** 2 <= 16) return;
        if (!startDrag(ev)) return;
      }
      pendingMove = ev;
      if (moveScheduled) return;
      moveScheduled = true;
      schedule(() => { moveScheduled = false; flushMove(); });
      return;
    }
    if (ev.pointerType === "touch") return;
    if (touchGizmoLimb) { touchGizmoLimb = null; syncRings(); } // a mouse took over
    ensureFresh();
    const { hit, limb } = hoverAt(local(ev));
    setHover(limb, hit);
    setCursor(hit ? "grab" : "");
  }

  function onPointerUp(ev) {
    if (!press || (ev.pointerId != null && ev.pointerId !== press.pointerId)) return;
    tracker.onUp(ev);
    const wasDrag = tracker.consumeClick() || press.started;
    const { hit } = press;
    // A touch on an aim handle's goal point or gizmo leaves its gizmo up.
    const touchGizmo = press.touch && !!hit.gizmo;
    if (press.started) {
      flushMove();
      session.end();
    } else if (!wasDrag && hit.kind === "dot" && !(touchGizmo && !press.gizmoWasUp)) {
      // a click pins a tip (or a goal handle's point); a click on a joint does nothing.
      // A touch's first tap on an aim handle's point only shows its gizmo.
      const handle = handles[hit.handleId];
      if (hit.at === "tip" || (handle?.mode === "goal" && hit.at === goalAt(handle))) session.togglePin(pinId(hit.handleId, hit.at));
    }
    if (touchGizmo) touchGizmoLimb = hit.limb;
    finishPress();
  }

  /** Abandon the press: a started drag reverts (session.cancel -> onCancel -> finishPress). */
  function abort() {
    if (!press) return;
    tracker.onCancel({ pointerId: press.pointerId });
    if (press.started && session.isActive()) session.cancel();
    else finishPress();
  }

  function onPointerCancel(ev) {
    if (!press || (ev.pointerId != null && ev.pointerId !== press.pointerId)) return;
    abort();
  }
  function onLostPointerCapture(ev) {
    if (!press || (ev.pointerId != null && ev.pointerId !== press.pointerId)) return;
    abort();
  }
  function onBlur() { abort(); }
  function onPointerLeave() {
    if (press || !live) return;
    setHover(null);
    setCursor("");
  }
  // Window capture, armed only during a press: Escape reverts the drag and is consumed,
  // so nothing else on the page (a cutaway's or measure's Escape) also acts on it.
  function onKeyDown(ev) {
    if (ev.key !== "Escape" || !press) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    abort();
  }

  const listeners = [
    [dom, "pointerdown", onPointerDown, { capture: true }],
    [dom, "pointermove", onPointerMove],
    [dom, "pointerup", onPointerUp],
    [dom, "pointercancel", onPointerCancel],
    [dom, "lostpointercapture", onLostPointerCapture],
    [dom, "pointerleave", onPointerLeave],
    [window, "blur", onBlur],
  ];
  for (const [t, type, fn, o] of listeners) t.addEventListener(type, fn, o);

  const offFrame = viewer.onFrame?.(() => {
    if (!live || !scene) return;
    // The camera may have moved: projections are re-taken on the next hit test.
    screenCache = null;
    // An outside param edit (a slider, setParams, playback) moves the limbs. Re-read
    // them now only while something pose-related is drawn; at rest just mark them
    // stale, so a slider drag does not derive every limb per frame for nothing.
    if (!press?.started && paramsMoved()) {
      if (drawsAnything()) refresh();
      else stale = true;
    }
    scene.tick();
    gizmo?.tick();
  }) ?? (() => {});
  const offTheme = viewer.onThemeChange?.((mode) => { scene?.setTheme(mode); gizmo?.setTheme(mode); }) ?? (() => {});

  /** Bring `live` in line with enabled/suppressed; notify on a change. */
  function applyLive() {
    const next = enabled && !suppressed && !detached;
    if (next === live) return;
    live = next;
    if (live) {
      scene ??= createScene(viewer);
      gizmo ??= createGizmo(viewer);
      const theme = viewer.getTheme?.();
      if (theme) { scene.setTheme(theme); gizmo.setTheme(theme); }
      refresh();
    } else {
      abort();
      const claimed = claimsHover();
      hoverLimb = null;
      hoverHit = null;
      touchGizmoLimb = null;
      shown = [];
      screenCache = null;
      stale = true;
      lastParams = null;
      scene?.clear();
      gizmo?.show(null);
      setCursor("");
      if (claimed) notify(hoverListeners);
    }
    notify(modeListeners);
  }
  function setEnabled(on) {
    if (detached || !!on === enabled) return;
    enabled = !!on;
    applyLive();
  }
  /** Mount: measure, sketch, cutaway or a cached preview is on — posing stands down. */
  function setSuppressed(on) {
    if (detached || !!on === suppressed) return;
    suppressed = !!on;
    applyLive();
  }
  applyLive();

  return {
    setEnabled,
    /** The host's switch (default on). Posing is live only while it is on AND not suppressed. */
    isEnabled: () => enabled,
    setSuppressed,
    /** Handles can be hovered and dragged right now. */
    isLive: () => live,
    /** A pose dot or ring is hovered, or a pose press is on (mount: hide the model's hover tooltip). */
    claimsHover,
    /** Fires when claimsHover() or isDragging() may have changed. */
    onHoverChange: (cb) => { hoverListeners.add(cb); return () => hoverListeners.delete(cb); },
    /**
     * The picker's guard: true once for the click that ends a press on a handle (a pin
     * toggle or a drag), so it never opens a pick. Cleared by the next pointerdown.
     */
    takeClick() { const c = clickClaimed; clickClaimed = false; return c; },
    /** A drag (past the threshold) is in progress. */
    isDragging: () => !!press?.started,
    /** Re-read every shown limb (mount: after a view switch; param edits are noticed per frame). */
    refresh,
    /** Mount: a sub-part's new mesh was shown — lift its ghost (same frame as setSubGeometry). */
    delivered: (name) => session.delivered(name),
    /** Mount: params were written from outside mid-drag (setParams) — revert the drag. */
    externalWrite: () => session.externalWrite(),
    /**
     * Where each shown handle's always-grabbable point (an angles limb's tip, a goal
     * handle's `at`) sits on the canvas: `[{ handleId, at, x, y }]`, CSS px from the
     * canvas's top-left. Drawn or not (at rest they are hidden until hovered). Empty
     * while posing is not live. For a host's coach marks and the
     * browser check (scripts/check-pose.mjs).
     */
    handlePoints() {
      ensureFresh();
      const out = [];
      for (const { handleId, handle, info } of shown) {
        const at = handle.mode === "goal" ? goalAt(handle) : "tip";
        const s = toScreen(info.points[at]);
        if (s && s.visible !== false) out.push({ handleId, at, x: s.x, y: s.y });
      }
      return out;
    },
    /**
     * The aim gizmo on screen, or null when none shows: `{ handleId, hovered, center,
     * rings: { pitch, yaw, roll? } }`, each a grabbable canvas point (CSS px from its
     * top-left) — a ring's is the point of it that picks that ring (not where another
     * ring crosses it) farthest from the centre on screen, with `ahead`, the ring's
     * point 20 degrees further round (a drag there turns it). For the browser check
     * (scripts/check-pose.mjs) and tests.
     */
    aimGizmoPoints() {
      const r = ringTarget();
      if (!r || !gizmo?.state.visible) return null;
      const c = toScreen(r.at);
      if (!c) return null;
      const { width: w, height: h } = dom.getBoundingClientRect();
      const radius = AIM_RING_PX * mmPerPx(r.at);
      const rings = {};
      r.axes.forEach((axis, i) => {
        const a = unit(axis);
        const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const u = unit([ref[0] - a[0] * dot(ref, a), ref[1] - a[1] * dot(ref, a), ref[2] - a[2] * dot(ref, a)]);
        const v = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
        const round = (t) => toScreen(r.at.map((q, j) => q + (u[j] * Math.cos(t) + v[j] * Math.sin(t)) * radius));
        let best = null;
        for (let k = 0; k < 48; k++) {
          const t = (k / 48) * Math.PI * 2;
          const s = round(t);
          if (!s) continue;
          const d = Math.hypot(s.x - c.x, s.y - c.y);
          if (best && d <= best.d) continue;
          if (gizmo.pick({ x: s.x, y: s.y, w, h }) === AIM_NAMES[i]) best = { x: s.x, y: s.y, d, t };
        }
        const ahead = best && round(best.t + Math.PI / 9);
        if (best) rings[AIM_NAMES[i]] = { x: best.x, y: best.y, ahead: ahead ? { x: ahead.x, y: ahead.y } : null };
      });
      return { handleId: r.handleId, hovered: gizmo.state.hovered, center: { x: c.x, y: c.y }, rings };
    },
    pinCount: () => session.pins.length,
    getPins: () => session.pins,
    setPins: (ids) => session.setPins(ids),
    releasePins: () => session.releasePins(),
    onPinsChange: (cb) => { pinListeners.add(cb); return () => pinListeners.delete(cb); },
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    session,
    detach() {
      if (detached) return;
      abort();
      detached = true;
      live = false;
      for (const [t, type, fn, o] of listeners) t.removeEventListener(type, fn, o);
      window.removeEventListener("keydown", onKeyDown, true);
      offFrame();
      offTheme();
      scene?.dispose();
      scene = null;
      gizmo?.dispose();
      gizmo = null;
      setCursor("");
      modeListeners.clear();
      pinListeners.clear();
      hoverListeners.clear();
    },
  };
}
