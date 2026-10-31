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
// JOINT RINGS (the joint gizmo, aim-gizmo.js's createJointGizmo): a joint dot whose joint
// has a parameter to turn — a goal handle's `seed` entry, an angles handle's `joints`
// entry (param-solve's jointRings) — shows a rotate ring about that joint's axis while it
// is hovered (a ball joint: bend, spread and twist rings). Dragging a ring turns that one
// joint (forward kinematics, session.jointFrame); dragging the dot itself is the IK drag it
// always was. A joint of a goal handle, or of a limb only a `joints` entry names (a parent
// palm), is a ring-only dot: hovering it shows its ring, a press on it is not a grab.
// One gizmo shows at a time — the focused one (`focus`): the aim gizmo once its goal point
// is hovered, or the hovered joint's rings; it stays while the pointer is inside its rings,
// and a dot under the pointer (other than the aim ball) takes the focus over.
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
import { createAimGizmo, createJointGizmo, AIM_RING_PX, AIM_RING_HIT_PX, JOINT_RING_PX, JOINT_GIZMO_PARTS } from "./aim-gizmo.js";
import { beginRotateDrag, rotateDragAngle } from "../gizmo/gizmo-rotate.js";
import { createPoseSession, pinId, parsePinId } from "./pose-session.js";
import { dragPlanePoint, hitHandle } from "./pose-geom.js";
import { limbInfo, jointRings } from "./param-solve.js";
import { aimTurn } from "../solve/aim.js";
import { withDeriveMemo } from "../derive-memo.js";

/** A dot's hit radius, CSS px: a 28 px target around a 12 px dot. */
export const HANDLE_HIT_PX = 14;
/** How near a limb's projected bones the mouse must be to show that limb's dots. */
export const NEAR_LIMB_PX = 32;
/**
 * Inside a shown gizmo's rings, another joint's dot takes the hover only this near (CSS px):
 * its core, so the way out to a ring does not hand the focus to a dot the pointer passes.
 */
export const DOT_CORE_PX = 8;
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
 * createGizmo (the aim gizmo), createJointRings (the joint gizmo).
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
  createJointRings = createJointGizmo,
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
  let jointGizmo = null;   // the joint rings (created with the scene)
  let touchFocus = null;   // touch: the gizmo a touch left up (a focus, below)
  // [{ handleId, handle, limbKey, info, extra? }] — one per handle with a posed limb, then
  // one per limb only a `joints` entry names (extra: handleId and handle null)
  let shown = [];
  let rings = new Map();   // "<limb name>\0<joint>" -> a jointRings entry (+ `info`)
  let stale = true;        // params moved since `shown` was read; re-read lazily (ensureFresh)
  let rereadThisFrame = false; // ensureFresh re-read on a param change this frame (at most once)
  let screenCache = null;  // shown limbs projected to the canvas; dropped every frame
  let hoverLimb = null;
  let hoverHit = null;     // the dot or ring under the mouse (null: none)
  // The gizmo that shows: { kind: "aim", limb } or { kind: "joint", limb, joint }, or null.
  let hoverFocus = null;
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
  // Every shown handle's limb comes from one derive of the same params: memoized, so a
  // part with six handles derives once, not six times (derive-memo.js).
  function refresh() {
    if (!live || !scene) return;
    withDeriveMemo(readLimbs);
  }
  function readLimbs() {
    stale = false;
    screenCache = null;
    const params = getParams();
    lastParams = { ...params };
    const ids = (visibleHandles() ?? []).filter((id) => handles[id]);
    const seen = new Set();
    shown = [];
    const infos = [];
    const byKey = new Map(); // derive key -> ikInfo (null: none)
    const infoOf = (key) => {
      if (!byKey.has(key)) byKey.set(key, limbInfo(part, params, { limb: key }));
      return byKey.get(key);
    };
    for (const handleId of ids) {
      const handle = handles[handleId];
      const info = infoOf(handle.limb);
      if (!info) continue;
      shown.push({ handleId, handle, limbKey: handle.limb, info });
      if (!seen.has(info.name)) { seen.add(info.name); infos.push(info); }
    }
    rings = new Map();
    const extras = [];
    for (const ring of jointRings({ part, params, ids, infoOf })) {
      const info = infoOf(ring.limb);
      if (!info) continue;
      rings.set(`${info.name}\0${ring.joint}`, { ...ring, info });
      if (!seen.has(info.name)) {
        seen.add(info.name);
        extras.push(info);
        shown.push({ handleId: null, handle: null, limbKey: ring.limb, info, extra: true });
      }
    }
    // a limb shown only for its rings draws no tip and only the dots of its joints with rings
    for (const info of extras) infos.push({ ...info, ringsOnly: info.joints.map((j) => j.name).filter((n) => rings.has(`${info.name}\0${n}`)) });
    scene.setLimbs(infos);
    syncPins();
    syncRings();
  }
  /**
   * Re-read the limbs if params moved since the last read (hit tests call this first). While
   * params change every frame (playback, a slider drag) a param change re-reads at most once
   * per animation frame (the frame hook clears the flag), so hover never derives more often.
   */
  function ensureFresh() {
    if (!live || !scene) return;
    if (stale) { refresh(); return; }
    if (rereadThisFrame || !paramsMoved()) return;
    rereadThisFrame = true;
    refresh();
  }
  /** Anything pose-related on screen that a param change must move. */
  const drawsAnything = () => !!(hoverLimb || press || session.pins.length || touchFocus);

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
  const hasAim = (handle) => handle?.mode === "goal" && Array.isArray(handle.params?.aim) && handle.params.aim.length >= 2;

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
  const ringKey = (limb, joint) => `${limb}\0${joint}`;
  /** Joints this near each other (mm) share one gizmo: a spherical wrist's pitch, yaw and roll. */
  const COINCIDENT_MM = 1e-6;
  /**
   * The joints with rings at `joint`'s point on `limb` (itself included), in limb order —
   * one gizmo shows them all, each in its own ring (the first joint to claim a ring keeps it).
   */
  function coincident(limb, joint) {
    const info = shown.find((e) => e.info.name === limb)?.info;
    const p = info?.points[joint];
    if (!Array.isArray(p)) return [];
    return info.joints
      .map((j) => j.name)
      .filter((n) => rings.has(ringKey(limb, n)) && Array.isArray(info.points[n]) && len(sub(info.points[n], p)) <= COINCIDENT_MM);
  }
  /**
   * The joint gizmo's target for a joint focus: `{ limb, joint, at, axes, slots }` — `axes`
   * one per JOINT_GIZMO_PARTS ring (null where none shows): a hinge's world axis (ikInfo
   * `axes`), a ball's bend/spread/twist axes (ikInfo `ballAxes`); `slots[ring]` is `{ ring
   * (the jointRings entry), joint }`, the joint that ring turns. The focus's joint and every
   * joint with rings at the same point share it. Null when it has no ring.
   */
  function jointTarget(focus) {
    if (focus?.kind !== "joint") return null;
    const info = shown.find((e) => e.info.name === focus.limb)?.info;
    const at = info?.points[focus.joint];
    if (!Array.isArray(at)) return null;
    const slots = {};
    for (const name of coincident(focus.limb, focus.joint)) {
      const ring = rings.get(ringKey(focus.limb, name));
      const ball = info.ballAxes?.[name];
      for (const slot of JOINT_GIZMO_PARTS) {
        if (!ring.slots[slot] || slots[slot]) continue;
        const a = ball ? ball[slot] : info.axes?.[name];
        if (Array.isArray(a) && len(a) > 0) slots[slot] = { ring, joint: name, axis: a };
      }
    }
    const axes = JOINT_GIZMO_PARTS.map((slot) => slots[slot]?.axis ?? null);
    return axes.some(Boolean) ? { limb: focus.limb, joint: focus.joint, at, axes, slots } : null;
  }
  const sameFocus = (a, b) => a === b || (!!a && !!b && a.kind === b.kind && a.limb === b.limb && a.joint === b.joint);
  /** The gizmo that shows: the press's, else the hovered one, else the one a touch left up. */
  const currentFocus = () => (press ? press.focus : hoverFocus ?? touchFocus);
  /** The aim gizmo that shows (gizmoTarget), or null. */
  const ringTarget = () => { const f = currentFocus(); return f?.kind === "aim" ? gizmoTarget(f.limb) : null; };
  /** The focus a hovered (or touched) dot gives: its aim gizmo, or its joint's rings, or null. */
  function focusOfDot(hit) {
    if (hit?.kind !== "dot") return null;
    const s = hit.handleId != null ? shown.find((e) => e.handleId === hit.handleId) : null;
    if (s && hasAim(s.handle) && hit.at === goalAt(s.handle) && gizmoTarget(hit.limb)) return { kind: "aim", limb: hit.limb };
    // coincident joints share one gizmo, named by the first of them (so the focus is steady)
    const group = coincident(hit.limb, hit.at);
    return group.length ? { kind: "joint", limb: hit.limb, joint: group[0] } : null;
  }
  function syncRings() {
    const f = currentFocus();
    const r = f?.kind === "aim" ? gizmoTarget(f.limb) : null;
    const j = jointTarget(f);
    gizmo?.show(r ? { at: r.at, axes: r.axes } : null);
    jointGizmo?.show(j ? { at: j.at, axes: j.axes } : null);
    scene?.setAimGizmo(r ? { limb: r.info.name, at: goalAt(r.handle) } : null);
    syncGizmoHover();
  }
  /** The gizmo part to style as hovered: the pressed one, else the one under the mouse. */
  function syncGizmoHover() {
    const h = press?.hit ?? hoverHit;
    gizmo?.setHovered(h?.kind === "jring" ? null : h?.gizmo ?? null);
    jointGizmo?.setHovered(h?.kind === "jring" ? h.gizmo : null);
  }

  // ---- hit testing ----------------------------------------------------------
  /** A limb's joints with rings. */
  const ringJoints = (info) => info.joints.map((j) => j.name).filter((n) => rings.has(ringKey(info.name, n)));
  /**
   * The dots a shown entry offers, `[{ at, ringOnly }]`: an angles limb's tip and joints; a
   * goal handle's `at`, plus its joints with rings; an extra limb's joints with rings. A
   * ring-only dot shows its rings when hovered but is not a grab.
   */
  function dotsOf({ handle, info, extra }) {
    if (extra) return ringJoints(info).map((at) => ({ at, ringOnly: true }));
    if (handle.mode === "goal") {
      const at = goalAt(handle);
      return [{ at, ringOnly: false }, ...ringJoints(info).filter((n) => n !== at).map((n) => ({ at: n, ringOnly: true }))];
    }
    return ["tip", ...info.joints.map((j) => j.name)].map((at) => ({ at, ringOnly: false }));
  }

  /**
   * Every shown limb on the canvas, projected at most once per frame (the frame hook
   * drops the cache) and once per refresh: `{ limbs: Map(name -> [screen pts of its
   * bones]), dots: [{ x, y, hit }] }`. Pointer moves read this — never derive.
   */
  function screen() {
    if (screenCache) return screenCache;
    const limbs = new Map();
    const dots = [];
    for (const entry of shown) {
      const { handleId, info } = entry;
      if (!limbs.has(info.name)) limbs.set(info.name, chainOf(info).map(toScreen));
      for (const { at, ringOnly } of dotsOf(entry)) {
        const s = toScreen(info.points[at]);
        if (!s || s.visible === false) continue;
        const hit = { kind: "dot", handleId, at, limb: info.name };
        if (ringOnly) hit.ringOnly = true;
        dots.push({ x: s.x, y: s.y, hit });
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
  /** How far (px) the canvas point is from where the dot `hit` sits on screen. */
  function dotDistance(hit, x, y) {
    const d = screen().dots.find((c) => c.hit === hit);
    return d ? Math.hypot(d.x - x, d.y - y) : Infinity;
  }
  /** How far (px) the canvas point is from ring `i` of a gizmo at `at` (its circle, projected). */
  function ringDistance(at, axis, radiusPx, x, y) {
    const pts = ringScreenPoints(at, axis, radiusPx, 48);
    let best = Infinity;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      if (a && b) best = Math.min(best, segDist(x, y, a, b));
    }
    return best;
  }
  /** `n` points round the ring about `axis` at `at` of `radiusPx` on screen (null: off screen), from t = 0. */
  function ringScreenPoints(at, axis, radiusPx, n, t0 = 0) {
    const a = unit(axis);
    const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = unit([ref[0] - a[0] * dot(ref, a), ref[1] - a[1] * dot(ref, a), ref[2] - a[2] * dot(ref, a)]);
    const v = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
    const radius = radiusPx * mmPerPx(at);
    return Array.from({ length: n }, (_, k) => {
      const t = t0 + (k / n) * Math.PI * 2;
      return toScreen(at.map((q, j) => q + (u[j] * Math.cos(t) + v[j] * Math.sin(t)) * radius));
    });
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

  /**
   * The joint ring under the canvas point for `target` (jointTarget), as a hit:
   * `{ kind: "jring", handleId, limb, joint, ring, axis, name, at, gizmo: name }`.
   */
  function jointRingHit(target, pt, touch = false) {
    if (!target || !jointGizmo) return null;
    const name = jointGizmo.pick(pt, { target: { at: target.at, axes: target.axes }, touch });
    const slot = name && target.slots[name];
    if (!slot) return null;
    return { kind: "jring", handleId: slot.ring.handleId, limb: target.limb, joint: slot.joint, ring: slot.ring, axis: slot.axis, name, at: target.at, gizmo: name };
  }

  /** The focused gizmo's limb and centre, or null. */
  function focusAnchor(focus) {
    if (focus?.kind === "aim") { const t = gizmoTarget(focus.limb); return t ? { limb: t.info.name, at: t.at, radius: AIM_RING_PX } : null; }
    const j = jointTarget(focus);
    return j ? { limb: j.limb, at: j.at, radius: JOINT_RING_PX } : null;
  }
  /** A dot of the focused gizmo itself: the aim's goal point, or one of the joints it turns. */
  function ownDot(focus, hit) {
    if (hit.limb !== focus.limb) return false;
    if (focus.kind === "aim") { const t = gizmoTarget(focus.limb); return !!t && hit.handleId === t.handleId && hit.at === goalAt(t.handle); }
    return coincident(focus.limb, focus.joint).includes(hit.at);
  }
  /** Inside the focused gizmo's rings, so they do not vanish on the way to one. */
  function insideFocus(focus, x, y) {
    const a = focusAnchor(focus);
    const s = a && toScreen(a.at);
    return s && Math.hypot(x - s.x, y - s.y) <= a.radius + AIM_RING_HIT_PX ? a.limb : null;
  }

  /**
   * What the mouse at the canvas point `pt` hovers: `{ limb, hit, focus }`. In order: the
   * shown aim gizmo's ball; a dot of the nearest limb (taking the focus to its aim gizmo or
   * its joint's rings, or dropping it); the shown gizmo's rings (they reach past
   * NEAR_LIMB_PX); the inside of the shown gizmo (it stays); else the nearest limb alone.
   * `hit` is `{ kind: "dot", handleId, at, limb, gizmo?, ringOnly? }`,
   * `{ kind: "ring", handleId, limb, axis, name, at, gizmo }` (an aim ring),
   * `{ kind: "jring", ... }` (a joint ring, jointRingHit) or null.
   */
  function hoverAt(pt) {
    const { x, y } = pt;
    const focus = hoverFocus ?? touchFocus;
    const aim = focus?.kind === "aim" ? gizmoTarget(focus.limb) : null;
    const onAim = gizmoHit(aim, pt);
    if (onAim?.gizmo === "ball") return { limb: onAim.limb, hit: onAim, focus };
    const limb = nearestLimb(x, y);
    let dotHit = limb ? dotAt(x, y, limb, HANDLE_HIT_PX) : null;
    const jt = jointTarget(focus);
    // Inside a shown gizmo's rings another joint's dot takes over only on its core: on the
    // way from a joint out to its ring the pointer often passes near a neighbour's dot (a
    // finger's next knuckle, the thumb's tip), and handing it the focus there would flash
    // the gizmo away. The gizmo's own dots keep their full target.
    if (dotHit && focus && !ownDot(focus, dotHit) && insideFocus(focus, x, y) && dotDistance(dotHit, x, y) > DOT_CORE_PX) dotHit = null;
    const onJoint = onAim ? null : jointRingHit(jt, pt);
    const onRing = onAim ?? onJoint;
    // a dot and the shown ring both under the pointer (a ring crossing a neighbouring
    // joint's dot): the nearer wins, a tie to the ring that is up — so moving from a joint
    // out to its ring never hands the focus to a dot the ring runs over (that dot is
    // reached from outside the rings, or where it is nearer than the ring)
    if (dotHit && onRing) {
      const radius = onAim ? AIM_RING_PX : JOINT_RING_PX;
      if (ringDistance(onRing.at, onRing.axis, radius, x, y) <= dotDistance(dotHit, x, y)) return { limb: onRing.limb, hit: onRing, focus };
    }
    if (dotHit) {
      const f = focusOfDot(dotHit);
      return { limb: dotHit.limb, hit: f?.kind === "aim" ? { ...dotHit, gizmo: "ball" } : dotHit, focus: f };
    }
    if (onRing) return { limb: onRing.limb, hit: onRing, focus };
    const inside = focus ? insideFocus(focus, x, y) : null;
    if (inside) return { limb: inside, hit: null, focus };
    return { limb, hit: null, focus: null };
  }

  const sameHit = (a, b) => (a === b) || (!!a && !!b && a.kind === b.kind && a.handleId === b.handleId && a.at === b.at && a.name === b.name && a.gizmo === b.gizmo && a.joint === b.joint && a.limb === b.limb);

  function setHover(limb, hit = null, focus = hoverFocus) {
    const limbChanged = limb !== hoverLimb;
    const hitChanged = !sameHit(hit, hoverHit);
    const focusChanged = !sameFocus(focus, hoverFocus);
    if (!limbChanged && !hitChanged && !focusChanged) return;
    const claimed = claimsHover();
    hoverLimb = limb;
    hoverHit = hit;
    hoverFocus = focus;
    scene?.setHover(limb, hit?.kind === "dot" ? hit.at : null);
    if (limbChanged || focusChanged) syncRings();
    else syncGizmoHover();
    if (claimsHover() !== claimed) notify(hoverListeners);
  }
  /** The cursor over a hover hit: grab on anything a press drags (a ring-only dot is not). */
  const hoverCursor = (hit) => (hit && !hit.ringOnly ? "grab" : "");

  /** A pose dot or ring is under the mouse, or a pose press is on: the model's hover tooltip stands down. */
  function claimsHover() { return !!(hoverHit || press); }

  // ---- the drag -------------------------------------------------------------
  function safeCapture(id) { try { dom.setPointerCapture?.(id); } catch { /* pointer already gone */ } }
  function safeRelease(id) { try { dom.releasePointerCapture?.(id); } catch { /* already lost */ } }

  /**
   * Undo the press's UI hold (orbit, capture, overlay). Idempotent; never touches the session.
   * `pt`: where a mouse press ended (pointerup) — hover is taken afresh there, since the
   * limb moved under a still pointer; without it the hover the press began with stays.
   */
  function finishPress(pt = null) {
    if (!press) return;
    const ending = press;
    press = null;
    pendingMove = null;
    if (orbitControls) orbitControls.enabled = ending.orbitEnabled;
    safeRelease(ending.pointerId);
    window.removeEventListener("keydown", onKeyDown, true);
    scene?.setActive(null);
    refresh();
    if (ending.touch) {
      // Touch has no hover: the limb its press showed goes away with the finger — unless
      // the touch left a gizmo up (touchFocus), which stays until a touch elsewhere.
      setCursor("");
      const a = focusAnchor(touchFocus);
      setHover(a?.limb ?? null, null, null);
    } else if (pt && live) {
      const h = hoverAt(pt);
      setHover(h.limb, h.hit, h.focus);
      setCursor(hoverCursor(h.hit));
    } else setCursor(hoverCursor(hoverHit));
    syncRings();
    notify(hoverListeners);
  }

  /** Cross the drag threshold: snapshot, hold, and fix the drag plane / ring frame. */
  function startDrag(ev) {
    const { hit } = press;
    if (hit.ringOnly) { finishPress(); return false; } // a ring-only dot is not a grab
    const s = shown.find((e) => e.handleId === hit.handleId);
    const grab = hit.kind === "dot" ? s?.info.points[hit.at] : null;
    if (!s || (hit.kind === "dot" && !Array.isArray(grab))) { finishPress(); return false; }
    const grabName = hit.kind === "ring" ? "ring" : hit.kind === "jring" ? `ring:${hit.joint}` : hit.at;
    if (!session.begin(hit.handleId, grabName)) { finishPress(); return false; }
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
      press.ring = { ...rotate, axis, center, name: hit.name, joint: hit.kind === "jring" };
    }
    syncRings();
    return true;
  }

  // One drag frame resolves the same params several times — the solve's (or goal seed's)
  // last derive, then mount's write (pose repair, panel relevance), then refresh — so the
  // whole frame runs with derive memoized (derive-memo.js).
  function dragFrame(ev) {
    if (!press?.started || !session.isActive()) return;
    withDeriveMemo(() => dragStep(ev));
  }
  function dragStep(ev) {
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
      if (angle == null) return;
      const deg = (angle * 180) / Math.PI;
      if (ring.joint) {
        // a joint ring: turn that one joint (forward kinematics)
        const result = session.jointFrame(hit.ring, hit.name, deg);
        if (!result) return;
        refresh();
        const info = shown.find((e) => e.info.name === hit.limb)?.info;
        if (!info) return;
        const clamped = clampedFlags(info);
        const i = info.joints.findIndex((j) => j.name === hit.joint);
        if (i >= 0 && result.clamped) clamped[i] = true;
        scene?.setActive({ limb: info.name, grab: hit.joint, clamped });
        syncRings();
        viewer.requestRender?.();
        return;
      }
      if (!session.ringFrame(ring.name, deg)) return;
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
    let hit, focus;
    if (touch) {
      // No hover came before: the gizmo a touch left up, else any limb's dot within the
      // finger's reach (an aim handle's goal point counts as its ball).
      const tf = touchFocus;
      hit = (tf?.kind === "aim" ? gizmoHit(gizmoTarget(tf.limb), pt, true) : jointRingHit(jointTarget(tf), pt, true))
        ?? dotAt(x, y, null, TOUCH_HIT_PX);
      focus = hit?.kind === "dot" ? focusOfDot(hit) : hit ? tf : null;
      if (hit?.kind === "dot" && !hit.gizmo && focus?.kind === "aim") hit = { ...hit, gizmo: "ball" };
      if (tf && !sameFocus(focus, tf)) {
        // a touch anywhere else puts the gizmo away
        touchFocus = null;
        if (!hit) { setHover(null, null, null); return; }
      }
    } else {
      // fresh from this press (a press need not follow a move)
      const h = hoverAt(pt);
      setHover(h.limb, h.hit, h.focus);
      hit = h.hit;
      focus = h.focus;
      // a ring-only dot (a joint shown for its rings) is not a grab: orbit and pick keep it
      if (hit?.ringOnly) return;
    }
    if (!hit) return;
    const ray = partRay(ev);
    if (!ray) return;
    press = {
      pointerId: ev.pointerId, hit, limb: hit.limb, focus, ray, x, y, touch,
      // touch: was this gizmo already up? (a first tap on the aim point only shows it)
      gizmoWasUp: touch && !!focus && sameFocus(touchFocus, focus),
      orbitEnabled: orbitControls?.enabled, started: false, plane: null, ring: null,
    };
    clickClaimed = true;
    if (touch) setHover(hit.limb, hit, focus);
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
    if (touchFocus) { touchFocus = null; syncRings(); } // a mouse took over
    ensureFresh();
    const { hit, limb, focus } = hoverAt(local(ev));
    setHover(limb, hit, focus);
    setCursor(hoverCursor(hit));
  }

  function onPointerUp(ev) {
    if (!press || (ev.pointerId != null && ev.pointerId !== press.pointerId)) return;
    tracker.onUp(ev);
    const wasDrag = tracker.consumeClick() || press.started;
    const { hit, focus } = press;
    // A touch on an aim handle's goal point or gizmo, or on a joint with rings or its
    // rings, leaves that gizmo up.
    const touchGizmo = press.touch && !!focus;
    if (press.started) {
      flushMove();
      session.end();
    } else if (!wasDrag && hit.kind === "dot" && !hit.ringOnly && !(focus?.kind === "aim" && press.touch && !press.gizmoWasUp)) {
      // a click pins a tip (or a goal handle's point); a click on a joint does nothing.
      // A touch's first tap on an aim handle's point only shows its gizmo.
      const handle = handles[hit.handleId];
      if (hit.at === "tip" || (handle?.mode === "goal" && hit.at === goalAt(handle))) session.togglePin(pinId(hit.handleId, hit.at));
    }
    if (touchGizmo) touchFocus = focus;
    finishPress(press.touch ? null : local(ev));
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
    rereadThisFrame = false;
    // An outside param edit (a slider, setParams, playback) moves the limbs. Re-read
    // them now only while something pose-related is drawn; at rest just mark them
    // stale, so a slider drag does not derive every limb per frame for nothing.
    if (!press?.started && paramsMoved()) {
      if (drawsAnything()) refresh();
      else stale = true;
    }
    scene.tick();
    gizmo?.tick();
    jointGizmo?.tick();
  }) ?? (() => {});
  const offTheme = viewer.onThemeChange?.((mode) => { scene?.setTheme(mode); gizmo?.setTheme(mode); jointGizmo?.setTheme(mode); }) ?? (() => {});

  /** Bring `live` in line with enabled/suppressed; notify on a change. */
  function applyLive() {
    const next = enabled && !suppressed && !detached;
    if (next === live) return;
    live = next;
    if (live) {
      scene ??= createScene(viewer);
      gizmo ??= createGizmo(viewer);
      jointGizmo ??= createJointRings(viewer);
      const theme = viewer.getTheme?.();
      if (theme) { scene.setTheme(theme); gizmo.setTheme(theme); jointGizmo.setTheme(theme); }
      refresh();
    } else {
      abort();
      const claimed = claimsHover();
      hoverLimb = null;
      hoverHit = null;
      hoverFocus = null;
      touchFocus = null;
      shown = [];
      rings = new Map();
      screenCache = null;
      stale = true;
      lastParams = null;
      scene?.clear();
      gizmo?.show(null);
      jointGizmo?.show(null);
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

  /**
   * A shown gizmo's grabbable points: `{ hovered, center, rings: { name: { x, y, ahead } } }`
   * — per ring the point of it that picks that ring (not where another crosses it) farthest
   * from the centre on screen, and `ahead`, 20 degrees further round.
   */
  function gizmoPoints(g, at, axes, names, radiusPx) {
    const c = toScreen(at);
    if (!c) return null;
    const { width: w, height: h } = dom.getBoundingClientRect();
    const out = {};
    axes.forEach((axis, i) => {
      if (!Array.isArray(axis)) return;
      const pts = ringScreenPoints(at, axis, radiusPx, 48);
      let best = null;
      pts.forEach((s, k) => {
        if (!s) return;
        const d = Math.hypot(s.x - c.x, s.y - c.y);
        if (best && d <= best.d) return;
        // a point the gizmo picks as this ring and the hover rules give to it (not a dot's)
        if (g.pick({ x: s.x, y: s.y, w, h }) !== names[i]) return;
        if (hoverAt({ x: s.x, y: s.y, w, h }).hit?.gizmo !== names[i]) return;
        best = { x: s.x, y: s.y, d, k };
      });
      const ahead = best && ringScreenPoints(at, axis, radiusPx, 1, ((best.k / 48) * Math.PI * 2) + Math.PI / 9)[0];
      if (best) out[names[i]] = { x: best.x, y: best.y, ahead: ahead ? { x: ahead.x, y: ahead.y } : null };
    });
    return { hovered: g.state.hovered, center: { x: c.x, y: c.y }, rings: out };
  }

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
      for (const { handleId, handle, info, extra } of shown) {
        if (extra) continue; // a limb shown only for its joint rings has no handle point
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
      const out = gizmoPoints(gizmo, r.at, r.axes, AIM_NAMES, AIM_RING_PX);
      return out && { handleId: r.handleId, ...out };
    },
    /**
     * The joint gizmo on screen, or null when none shows: `{ limb, joint, hovered, center,
     * rings: { bend?, spread?, twist? } }`, the points as aimGizmoPoints gives them. For the
     * browser check (scripts/check-pose.mjs) and tests.
     */
    jointGizmoPoints() {
      const j = jointTarget(currentFocus());
      if (!j || !jointGizmo?.state.visible) return null;
      const out = gizmoPoints(jointGizmo, j.at, j.axes, JOINT_GIZMO_PARTS, JOINT_RING_PX);
      return out && { limb: j.limb, joint: j.joint, ...out };
    },
    /**
     * Every joint with rings on the canvas: `[{ limb, joint, x, y, rings: [names] }]` (limb:
     * the limb's name), CSS px from the canvas's top-left — where to hover to show them.
     */
    jointRingPoints() {
      ensureFresh();
      const out = [];
      for (const [, ring] of rings) {
        const s = toScreen(ring.info.points[ring.joint]);
        if (s && s.visible !== false) out.push({ limb: ring.info.name, joint: ring.joint, x: s.x, y: s.y, rings: Object.keys(ring.slots) });
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
      gizmo?.dispose();
      gizmo = null;
      jointGizmo?.dispose();
      jointGizmo = null;
      setCursor("");
      modeListeners.clear();
      pinListeners.clear();
      hoverListeners.clear();
    },
  };
}
