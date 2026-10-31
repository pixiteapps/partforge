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
import { createPoseScene, AIM_RING_PX } from "./pose-scene.js";
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
/** How near an aim ring's line counts as on it: a 24 px band. */
export const RING_HIT_PX = 12;
/** Edge-on rings turn by pointer travel instead: degrees per CSS px. */
const RING_DEG_PER_PX = 0.75;
/** Below this |ray . axis| a ring's plane is too edge-on to intersect usefully. */
const RING_PLANE_ALIGNMENT = 0.15;
/** A hinge this near (degrees) its range end reads as clamped. */
const CLAMP_EPS_DEG = 1e-3;
const AIM_NAMES = ["pitch", "yaw", "roll"];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
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
 * restore, staleSubParts, ghost, unghost, hold. Optional: schedule (rAF), createScene.
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

  /** The goal handle whose aim rings show: the one being dragged, else the hovered one. */
  function ringTarget() {
    const limb = press?.started ? press.limb : hoverLimb;
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
  function syncRings() {
    const r = ringTarget();
    scene?.setAimRings(r ? { at: r.at, axes: r.axes } : null);
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

  function ringHit(x, y) {
    const r = ringTarget();
    if (!r) return null;
    const radius = AIM_RING_PX * mmPerPx(r.at);
    let best = null;
    r.axes.forEach((axis, i) => {
      const a = unit(axis);
      const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = unit(cross(a, cross(ref, a)));
      const v = cross(a, u);
      let prev = null;
      for (let k = 0; k <= 48; k++) {
        const t = (k / 48) * Math.PI * 2;
        const p = add(r.at, [
          (u[0] * Math.cos(t) + v[0] * Math.sin(t)) * radius,
          (u[1] * Math.cos(t) + v[1] * Math.sin(t)) * radius,
          (u[2] * Math.cos(t) + v[2] * Math.sin(t)) * radius,
        ]);
        const s = toScreen(p);
        if (prev && s) {
          const dd = segDist(x, y, prev, s);
          if (dd <= RING_HIT_PX && (!best || dd < best.d)) best = { d: dd, i };
        }
        prev = s;
      }
    });
    if (!best) return null;
    return { kind: "ring", handleId: r.handleId, limb: r.info.name, axis: r.axes[best.i], name: AIM_NAMES[best.i], at: r.at };
  }

  /** Inside the hovered goal limb's rings, so they do not vanish on the way to one. */
  function insideRings(x, y) {
    const r = ringTarget();
    if (!r) return null;
    const s = toScreen(r.at);
    return s && Math.hypot(x - s.x, y - s.y) <= AIM_RING_PX + RING_HIT_PX ? r.info.name : null;
  }

  /**
   * What the mouse at (x, y) hovers: `{ limb, hit }`. The hovered limb's aim rings are
   * tried first (they reach past NEAR_LIMB_PX), then the nearest limb's dots, then the
   * inside of the rings. `hit` is `{ kind: "dot", handleId, at, limb }`,
   * `{ kind: "ring", handleId, limb, axis, name, at }` or null.
   */
  function hoverAt(x, y) {
    const ring = ringHit(x, y);
    if (ring) return { limb: ring.limb, hit: ring };
    const limb = nearestLimb(x, y);
    if (limb) return { limb, hit: dotAt(x, y, limb, HANDLE_HIT_PX) };
    const inside = insideRings(x, y);
    return { limb: inside, hit: null };
  }

  const sameHit = (a, b) => (a === b) || (!!a && !!b && a.kind === b.kind && a.handleId === b.handleId && a.at === b.at && a.name === b.name);

  function setHover(limb, hit = null) {
    const limbChanged = limb !== hoverLimb;
    const hitChanged = !sameHit(hit, hoverHit);
    if (!limbChanged && !hitChanged) return;
    const claimed = claimsHover();
    hoverLimb = limb;
    hoverHit = hit;
    scene?.setHover(limb, hit?.kind === "dot" ? hit.at : null);
    if (limbChanged) syncRings();
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
    // Touch has no hover: the limb its press showed goes away with the finger.
    if (ending.touch) setHover(null);
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
      const a = unit(hit.axis);
      const align = Math.abs(dot(unit(ray.dir), a));
      const r0 = align >= RING_PLANE_ALIGNMENT ? ringRadial(ray, hit.at, a) : null;
      if (r0) press.ring = { mode: "plane", axis: a, at: hit.at, last: r0, angle: 0, name: hit.name };
      else {
        const c = toScreen(hit.at), e = toScreen(add(hit.at, a));
        const s = c && e ? { x: e.x - c.x, y: e.y - c.y } : { x: 1, y: 0 };
        const l = Math.hypot(s.x, s.y) || 1;
        press.ring = { mode: "screen", tangent: { x: -s.y / l, y: s.x / l }, name: hit.name };
      }
    }
    syncRings();
    return true;
  }

  /** The unit radial from `at` to the ray's hit on the ring's plane, or null. */
  function ringRadial(ray, at, axis) {
    const d = unit(ray.dir);
    const denom = dot(d, axis);
    if (Math.abs(denom) < 1e-9) return null;
    const t = dot(sub(at, ray.origin), axis) / denom;
    if (!(t >= 0)) return null;
    const r = sub(add(ray.origin, d.map((c) => c * t)), at);
    return len(r) > 1e-9 ? unit(r) : null;
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
    } else if (press.ring.mode === "plane") {
      const ring = press.ring;
      const r1 = ringRadial(ray, ring.at, ring.axis);
      if (!r1) return;
      // unwrap: accumulate the signed step, so a full turn past ±180 keeps counting
      const step = Math.atan2(dot(ring.axis, cross(ring.last, r1)), dot(ring.last, r1));
      ring.angle += (step * 180) / Math.PI;
      ring.last = r1;
      if (!session.ringFrame(ring.name, ring.angle)) return;
    } else {
      const { x, y } = local(ev);
      const deg = ((x - press.x) * press.ring.tangent.x + (y - press.y) * press.ring.tangent.y) * RING_DEG_PER_PX;
      if (!session.ringFrame(press.ring.name, deg)) return;
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
    const { x, y } = local(ev);
    const touch = ev.pointerType === "touch";
    let hit;
    if (touch) {
      // No hover came before: any limb's dot within the finger's reach.
      hit = dotAt(x, y, null, TOUCH_HIT_PX);
    } else {
      // fresh from this press (a press need not follow a move)
      const h = hoverAt(x, y);
      setHover(h.limb, h.hit);
      hit = h.hit;
    }
    if (!hit) return;
    const ray = partRay(ev);
    if (!ray) return;
    press = {
      pointerId: ev.pointerId, hit, limb: hit.limb, ray, x, y, touch,
      orbitEnabled: orbitControls?.enabled, started: false, plane: null, ring: null,
    };
    clickClaimed = true;
    if (touch) setHover(hit.limb, hit);
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
    ensureFresh();
    const { x, y } = local(ev);
    const { hit, limb } = hoverAt(x, y);
    setHover(limb, hit);
    setCursor(hit ? "grab" : "");
  }

  function onPointerUp(ev) {
    if (!press || (ev.pointerId != null && ev.pointerId !== press.pointerId)) return;
    tracker.onUp(ev);
    const wasDrag = tracker.consumeClick() || press.started;
    const { hit } = press;
    if (press.started) {
      flushMove();
      session.end();
    } else if (!wasDrag && hit.kind === "dot") {
      // a click pins a tip (or a goal handle's point); a click on a joint does nothing
      const handle = handles[hit.handleId];
      if (hit.at === "tip" || (handle?.mode === "goal" && hit.at === goalAt(handle))) session.togglePin(pinId(hit.handleId, hit.at));
    }
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
  }) ?? (() => {});
  const offTheme = viewer.onThemeChange?.((mode) => scene?.setTheme(mode)) ?? (() => {});

  /** Bring `live` in line with enabled/suppressed; notify on a change. */
  function applyLive() {
    const next = enabled && !suppressed && !detached;
    if (next === live) return;
    live = next;
    if (live) {
      scene ??= createScene(viewer);
      const theme = viewer.getTheme?.();
      if (theme) scene.setTheme(theme);
      refresh();
    } else {
      abort();
      const claimed = claimsHover();
      hoverLimb = null;
      hoverHit = null;
      shown = [];
      screenCache = null;
      stale = true;
      lastParams = null;
      scene?.clear();
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
      setCursor("");
      modeListeners.clear();
      pinListeners.clear();
      hoverListeners.clear();
    },
  };
}
