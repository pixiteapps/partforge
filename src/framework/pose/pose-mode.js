// Posing's orchestrator: pointer and orbit arbitration, hover, and the drag loop
// that feeds pose-session.js. The one pose module that touches the DOM and three.js
// together (pose-scene.js draws; pose-session.js decides; this file listens).
//
// Posing is ALWAYS ON in the viewer's normal click mode: it is "live" while the host
// has not switched it off (setEnabled) and mount has not suppressed it (setSuppressed:
// measure, sketch, cutaway or a cached preview is on). At rest nothing is drawn but pin
// badges, one at each pinned point. A mouse pointer within NEAR_LIMB_PX of a limb's projected bones shows that
// limb's dots (the closest limb wins); a dot under the pointer is highlighted and takes
// a grab cursor, and while one is, mount suppresses the model's hover tooltip
// (claimsHover / onHoverChange). Touch has no hover: a touch press within TOUCH_HIT_PX
// of any limb's dot grabs it.
//
// A goal handle with `aim` shows the AIM GIZMO (aim-gizmo.js, built on the cutaway
// control's shared gizmo code) instead of a plain dot: a centre ball on the goal point
// and a rotate ring per aim parameter, each with the cutaway's hover state. It shows
// while its limb is hovered and stays up while any of its parts is dragged. Dragging the
// ball is dragging the dot (the drag plane through the point); dragging a ring
// writes that aim angle (session.ringFrame) through the shared rotate-drag math. Touch:
// a touch on the goal point (a tap or a drag) leaves the gizmo up until a touch lands
// anywhere else, so a finger can reach the rings; the first tap only shows it, a tap on
// the ball while it is up toggles the pin as a mouse click does.
//
// PINS: a click (no drag) on ANY dot — a tip, a joint, a goal handle's point (the aim
// ball), a ring-only joint — toggles a pin on that point (pin id "<handle>:<at>",
// pinIdOf). A pinned point holds still through every IK drag (pose-session.js); joint
// rings ignore pins. Touch: a tap on a dot whose gizmo or rings are already up toggles
// its pin; the first tap that only puts them up does not.
//
// JOINT RINGS (the joint gizmo, aim-gizmo.js's createJointGizmo): a joint dot whose joint
// has a parameter to turn — a goal handle's `seed` entry, an angles handle's `joints`
// entry (param-solve's jointRings) — shows a rotate ring about that joint's axis while it
// is hovered (a ball joint: bend, spread and twist rings). Dragging a ring turns that one
// joint (forward kinematics, session.jointFrame); dragging the dot itself is the IK drag it
// always was. A joint of a goal handle, or of a limb only a `joints` entry names (a parent
// palm), is a ring-only dot: hovering it shows its ring, a press on it is not a grab (a
// drag from it orbits) and a click on it toggles its pin.
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
// drag-tracker.js tells a click (toggle a pin on the dot) from a drag (begin a session):
// the session begins only once the pointer has moved past the threshold, so a click
// never snapshots, holds or commits anything.
//
// GENERIC HANDLES (`on` / `point`, spec 2026-11-02 section 5) ride the same machinery as a
// pseudo-limb: handle-source.js's handleRecord, named "handle:<id>", with one dot (its
// "tip") and the source's `lines` as bones. One shows while the mouse is within
// NEAR_LIMB_PX of its point, or over a sub-part its `showOn` names (mount's
// hoveredSubPart, re-read per frame, since the hover pick lands a frame after the move).
// Hovering its dot draws its guides (handle-guides.js: the plane square or rotary ring,
// and a one-param handle's path); its drag turns the pointer into a target by its drag
// kind (drag-kinds.js) and shows the readout. A click pins it ("<handle>:<at>" or
// "<handle>:point"). It has no rings and no miss line (the session exposes no miss).
// An AXIS handle has no dot and no guides: it draws as a two-sided arrow along its axis
// (pose-scene.js), which shows the way it slides by itself. The arrow is its grab target,
// picked through the arrow's hit proxy (gizmo/gizmo-handles.js's arrowHitGeometry, by
// gizmo-pick.js's pickGizmoHandle, its centre as the dot's): a press anywhere on it starts
// the axis drag. Its proxy is ARROW_HIT_PX thick for a mouse, TOUCH_HIT_PX for a finger.
//
// THE RESTING CUE: handles show only on hover, so a first look finds none. The first frame
// posing is live with the part on screen (a build delivered, no cached preview) shows every
// shown handle's dot (an axis handle's arrow) dimmed (CUE_OPACITY) for CUE_HOLD_MS, then fades it out over
// CUE_FADE_MS — once per mount: never again on a param change, a view switch or a suppress
// round trip. A touch-only device (`(hover: none)`) has no hover to find them by: there the
// dimmed dots stay until the first drag of any handle, then the hover rules alone apply.
// The dots are pose-scene's (setCue), in its capture-hidden group.
//
// Frames: the overlay and every limb point are in PART coordinates (the sub-meshes'
// shared parent — the pivot stands model Z up and recentres per view). Pointer rays come
// from the camera in WORLD coordinates and are carried into the parts frame through that
// parent's inverse world matrix; part points go the other way for projectPoint.
import * as THREE from "three";
import { createDragTracker } from "../selection/drag-tracker.js";
import { worldPerPx, orthoWorldPerPx } from "../measure/dim3-scene.js";
import { createPoseScene, PIN_HEAD_PX, PIN_LIFT_PX } from "./pose-scene.js";
import { createAimGizmo, createJointGizmo, AIM_RING_PX, AIM_RING_HIT_PX, JOINT_RING_PX, JOINT_GIZMO_PARTS } from "./aim-gizmo.js";
import { beginRotateDrag, rotateDragAngle } from "../gizmo/gizmo-rotate.js";
import { ARROW_HALF_LENGTH, ARROW_UNIT_PX, arrowHitGeometry, hitMaterial } from "../gizmo/gizmo-handles.js";
import { pickGizmoHandle } from "../gizmo/gizmo-pick.js";
import { createPoseSession, pinId, pinTarget } from "./pose-session.js";
import { dragPlaneNormal, dragPlanePoint, hitHandle } from "./pose-geom.js";
import { limbInfo, jointRings, goalGrabJoints } from "./param-solve.js";
import { handleKind, handleAt, handleRecord } from "./handle-source.js";
import { startDrag as startKindDrag, dragTarget } from "./drag-kinds.js";
import { planeGuide, rotaryGuide, sweepPath, pathKey, pathParam, readoutText, readoutItems } from "./handle-guides.js";
import { resolveParams } from "../part-model.js";
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
/** An axis handle's arrow picks this far (CSS px) from its line for a mouse (a finger: TOUCH_HIT_PX). */
export const ARROW_HIT_PX = 10;
/** The resting cue: its dots' opacity, how long they hold, and how long they fade (ms). */
export const CUE_OPACITY = 0.45;
export const CUE_HOLD_MS = 2000;
export const CUE_FADE_MS = 400;
/** A hinge this near (degrees) its range end reads as clamped. */
const CLAMP_EPS_DEG = 1e-3;
const AIM_NAMES = ["pitch", "yaw", "roll"];
/** Guides are re-drawn when the scale at their point moves this much (a zoom). */
const GUIDE_RESCALE = 0.02;
const isGeneric = (h) => handleKind(h) === "on" || handleKind(h) === "point";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** An axis handle's record: its unit slide direction (its arrow's), else null. */
function arrowDir(info) {
  const d = info?.drag === "axis" ? info.axis?.direction : null;
  return Array.isArray(d) && d.length === 3 && d.every(Number.isFinite) && len(d) > 1e-12 ? unit(d) : null;
}

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
 * @param opts.hoveredSubPart () => the sub-part under the mouse, or null: reveals a generic
 *   handle whose `showOn` names it.
 * @param opts.cueBlocked () => true while the resting cue must wait (mount: the opening
 *   view's autoplay is pending or playing). Default: never.
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
  hoveredSubPart = () => null,
  schedule = (cb) => requestAnimationFrame(cb),
  // the resting cue's clock, and whether this device has no hover (touch only)
  now = () => performance.now(),
  hoverNone = () => !!globalThis.matchMedia?.("(hover: none)")?.matches,
  // true while the cue must wait: mount's, while the opening view's autoplay is
  // pending or playing (the cue starts once it ends; a loop nobody stops: never)
  cueBlocked = () => false,
  createScene = createPoseScene,
  createGizmo = createAimGizmo,
  createJointRings = createJointGizmo,
}) {
  const handles = part?.handles && typeof part.handles === "object" ? part.handles : {};
  const dom = viewer.domElement;
  const modeListeners = new Set();
  const pinListeners = new Set();
  const dragEndListeners = new Set();
  const readoutListeners = new Set();
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
  // A press on a ring-only dot: left to orbit, and a pin toggle if it ends as a click.
  let tap = null;          // { pointerId, x, y, hit }
  let clickClaimed = false; // the last press grabbed a handle: its click is not a pick
  let lastParams = null;   // shallow copy, to notice outside param changes per frame
  let pendingMove = null;
  let moveScheduled = false;
  let cursorSet = false;
  const hoverListeners = new Set();
  // generic handles
  const showOnAny = Object.values(handles).some((h) => isGeneric(h) && h.showOn != null);
  let lastPt = null;       // the mouse's last canvas point (showOn re-reads the hover per frame)
  let lastSub = null;      // hoveredSubPart() as the last hover read it
  let guideScale = null;   // mm per px the shown guides were drawn at (null: none shown)
  const paths = new Map(); // handleId -> { key, guide } (handle-guides' sweepPath, cached)
  // the resting cue: "pending" until the first live frame with the part on screen (and
  // no opening autoplay pending or playing — cueBlocked), then { start, touch } while it
  // shows, then "done" (once per mount)
  let cue = Object.keys(handles).length ? "pending" : "done";

  const session = createPoseSession({
    part, getParams, write, commit, restore, staleSubParts, ghost, unghost, hold,
    onCancel: () => finishPress(),
    onPinsChange: () => { if (!syncPins()) notify(pinListeners); },
    pinActive: (id) => !!pinPoint(id),
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
    shownIds = new Set(ids);
    const seen = new Set();
    shown = [];
    const infos = [];
    const byKey = new Map(); // derive key -> ikInfo (null: none)
    const infoOf = (key) => {
      if (!byKey.has(key)) byKey.set(key, limbInfo(part, params, { on: key }));
      return byKey.get(key);
    };
    const limbIds = ids.filter((id) => !isGeneric(handles[id]));
    for (const handleId of limbIds) {
      const handle = handles[handleId];
      const info = infoOf(handle.on);
      if (!info) continue;
      shown.push({ handleId, handle, limbKey: handle.on, info });
      if (!seen.has(info.name)) { seen.add(info.name); infos.push(info); }
    }
    rings = new Map();
    const extras = [];
    for (const ring of jointRings({ part, params, ids: limbIds, infoOf })) {
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
    readGeneric(params, ids.filter((id) => isGeneric(handles[id])), infos);
    dropStaleHover();
    scene.setLimbs(infos);
    syncPins();
    syncRings();
    syncGuides();
    syncCue();
  }
  /**
   * A hover, focus or touch focus on a limb this re-read no longer shows (a view switch, a
   * relevance change) is dropped, with its cursor and claim: left set, it kept a grab
   * cursor, hid the model's tooltip and claimed a press over a handle no longer drawn.
   * A press keeps its own (the session cancels a drag the view outdates).
   */
  function dropStaleHover() {
    const names = new Set(shown.map((e) => e.info.name));
    const gone = (limb) => limb != null && !names.has(limb);
    if (touchFocus && gone(touchFocus.limb)) touchFocus = null;
    if (press) return;
    if (gone(hoverLimb) || gone(hoverHit?.limb) || gone(hoverFocus?.limb)) {
      setHover(null, null, null);
      setCursor("");
    }
  }
  /** One pseudo-limb record per shown generic handle (handleRecord), from one derive. */
  function readGeneric(params, ids, infos) {
    if (!ids.length) return;
    let d;
    try { ({ d } = resolveParams(part, params)); } catch { return; }
    for (const handleId of ids) {
      const info = handleRecord(part, params, d, handleId);
      if (!info) continue;
      shown.push({ handleId, handle: handles[handleId], limbKey: null, info, generic: true });
      infos.push(info);
    }
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
  const drawsAnything = () => !!(hoverLimb || press || session.pins.length || touchFocus || typeof cue === "object");

  function paramsMoved() {
    if (!lastParams) return true;
    const p = getParams();
    const keys = new Set([...Object.keys(p), ...Object.keys(lastParams)]);
    for (const k of keys) if (!Object.is(p[k], lastParams[k])) return true;
    return false;
  }

  /**
   * Where pin `id` points in this view: `{ limb (its name), at, point }`, or null when its
   * handle or limb is not shown here — such a pin has no badge, and holds nothing (the
   * session's pinActive).
   */
  function pinPoint(id) {
    const t = pinTarget(id, handles);
    if (!t || !shownIds.has(t.handleId)) return null;
    if (t.ref) {
      // a generic handle's one point
      const g = shown.find((e) => e.generic && e.handleId === t.handleId);
      const p = g?.info.points.tip;
      return Array.isArray(p) ? { limb: g.info.name, at: "tip", point: p } : null;
    }
    const entry = shown.find((e) => e.limbKey === t.limb);
    const point = entry?.info.points[t.at];
    return Array.isArray(point) ? { limb: entry.info.name, at: t.at, point } : null;
  }
  let pinnedPoints = []; // [{ limb, at, point }] as badged now (syncPins)
  let shownIds = new Set(); // the handles this view shows (readLimbs)
  /**
   * The scene's pin badges: one per pinned point shown, `{ limb (its name), at }`.
   * Returns whether the badged count moved, in which case pin listeners were told.
   */
  function syncPins() {
    const before = pinnedPoints.length;
    pinnedPoints = [];
    for (const id of session.pins) {
      const p = pinPoint(id);
      if (p && !pinnedPoints.some((q) => q.limb === p.limb && q.at === p.at)) pinnedPoints.push(p);
    }
    scene?.setPins(pinnedPoints.map(({ limb, at }) => ({ limb, at })));
    // A view switch can show or hide pinned points with no pin changing: tell the
    // chrome, whose Release pins counts what is badged (pinCount).
    if (pinnedPoints.length === before) return false;
    notify(pinListeners);
    return true;
  }
  /** The dot `hit` stands on a pinned point (a coincident joint's pin counts: one badge). */
  function pinnedDot(hit) {
    const info = shown.find((e) => e.info.name === hit.limb)?.info;
    const p = info?.points[hit.at];
    return Array.isArray(p) && pinnedPoints.some((q) => q.limb === hit.limb && len(sub(q.point, p)) <= COINCIDENT_MM);
  }
  /**
   * The pointer is on the dot's core (DOT_CORE_PX) or, for a pinned dot, on its badge's
   * head (PIN_LIFT_PX straight up the screen): there the dot beats any ring under the
   * pointer, so a click on the badge unpins rather than grabbing a ring seen edge-on.
   */
  function onDotCore(hit, x, y) {
    const d = screen().dots.find((c) => c.hit === hit);
    if (!d) return false;
    if (Math.hypot(d.x - x, d.y - y) <= DOT_CORE_PX) return true;
    return pinnedDot(hit) && Math.hypot(d.x - x, d.y - PIN_LIFT_PX - y) <= PIN_HEAD_PX + 3;
  }
  /**
   * The pin id a click on the dot `hit` toggles: "<handle>:<at>" for a dot of a handle's own
   * limb; for a limb only a `joints` entry shows, the handle naming that joint and
   * "<limb>.<joint>" (pose-session's pinTarget). Null for anything else.
   */
  function pinIdOf(hit) {
    if (hit?.kind !== "dot") return null;
    if (hit.generic) return pinId(hit.handleId, handleAt(handles[hit.handleId]));
    if (hit.handleId != null) return pinId(hit.handleId, hit.at);
    const ring = rings.get(ringKey(hit.limb, hit.at));
    const h = ring && handles[ring.handleId];
    if (!h) return null;
    return pinId(ring.handleId, h.on === ring.limb ? hit.at : `${ring.limb}.${hit.at}`);
  }

  const goalAt = (handle) => (typeof handle.at === "string" ? handle.at : "tip");
  const hasAim = (handle) => handle?.drag === "goal" && Array.isArray(handle.params?.aim) && handle.params.aim.length >= 2;

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
   * goal handle's `at`, plus its joints with rings (a grab when a driven joint above moves
   * it, param-solve's goalGrabJoints); an extra limb's joints with rings. A ring-only dot
   * shows its rings when hovered but is not a grab.
   */
  function dotsOf({ handle, info, extra, generic }) {
    if (generic) return [{ at: "tip", ringOnly: false }];
    if (extra) return ringJoints(info).map((at) => ({ at, ringOnly: true }));
    if (handle.drag === "goal") {
      const at = goalAt(handle);
      // a joint some driven joint above it moves is a grab too (a mid-joint drag); the rest
      // (the first driven joint, one on a twist axis above it) stay ring-only
      const grabs = new Set(goalGrabJoints(info, handle));
      return [{ at, ringOnly: false }, ...ringJoints(info).filter((n) => n !== at).map((n) => ({ at: n, ringOnly: !grabs.has(n) }))];
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
      // an axis handle's arrow: [centre, one tip, the other] (the tip to tip segment is
      // what NEAR_LIMB_PX measures to; the centre stays first, showOnAt's anchor)
      const arrow = entry.generic ? arrowScreen(info) : null;
      if (!limbs.has(info.name)) limbs.set(info.name, arrow ? [arrow.center, arrow.a, arrow.b] : chainOf(info).map(toScreen));
      for (const { at, ringOnly } of dotsOf(entry)) {
        const s = toScreen(info.points[at]);
        if (!s || s.visible === false) continue;
        const hit = { kind: "dot", handleId, at, limb: info.name };
        if (ringOnly) hit.ringOnly = true;
        if (entry.generic) hit.generic = true;
        dots.push(arrow ? { x: s.x, y: s.y, hit, arrow } : { x: s.x, y: s.y, hit });
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
    return best ?? showOnAt(x, y);
  }
  /** The generic handle a `showOn` reveals for the sub-part under the mouse (the nearest, if several), else null. */
  function showOnAt(x, y) {
    if (!showOnAny) return null;
    const sub = hoveredSubPart();
    if (sub == null) return null;
    let best = null, bestD = Infinity;
    for (const e of shown) {
      const on = e.generic ? e.handle.showOn : null;
      if (!(on === sub || (Array.isArray(on) && on.includes(sub)))) continue;
      const s = screen().limbs.get(e.info.name)?.[0];
      const d = s ? Math.hypot(x - s.x, y - s.y) : Infinity;
      if (!best || d < bestD) { bestD = d; best = e.info.name; }
    }
    return best;
  }

  /**
   * The dot nearest (x, y) within `radius`, among `limb`'s dots (null: every limb's). An
   * axis handle's dot is its arrow: picked by its hit proxy (arrowPicks), a finger's
   * (`radius` TOUCH_HIT_PX or more) fatter, and its distance is to the arrow's line.
   */
  function dotAt(x, y, limb, radius) {
    const all = screen().dots.filter((d) => limb === null || d.hit.limb === limb);
    const cands = all.filter((d) => !d.arrow).map((d, id) => ({ id, x: d.x, y: d.y, hit: d.hit }));
    const id = hitHandle(cands, x, y, radius);
    let best = id === null ? null : { hit: cands[id].hit, dist: Math.hypot(cands[id].x - x, cands[id].y - y) };
    for (const d of all) {
      if (!d.arrow || !arrowPicks(d, x, y, radius >= TOUCH_HIT_PX)) continue;
      const dist = arrowDistance(d.arrow, x, y);
      if (!best || dist < best.dist) best = { hit: d.hit, dist };
    }
    return best?.hit ?? null;
  }
  /** How far (px) the canvas point is from where the dot `hit` sits on screen (an arrow: its line). */
  function dotDistance(hit, x, y) {
    const d = screen().dots.find((c) => c.hit === hit);
    if (d?.arrow) return arrowDistance(d.arrow, x, y);
    return d ? Math.hypot(d.x - x, d.y - y) : Infinity;
  }

  // ---- axis handles' arrows -------------------------------------------------
  /**
   * An axis handle's arrow on the canvas: `{ at, dir, center, a, b }` — its point and unit
   * direction (part coordinates), and its centre and two head tips on screen (a tip off the
   * depth range: null). Null for any other record, or a point off screen.
   */
  function arrowScreen(info) {
    const dir = arrowDir(info);
    const at = info.points.tip;
    const center = dir && Array.isArray(at) ? toScreen(at) : null;
    if (!center || center.visible === false) return null;
    const reach = ARROW_HALF_LENGTH * ARROW_UNIT_PX * mmPerPx(at);
    const tip = (sign) => toScreen(at.map((q, i) => q + dir[i] * reach * sign));
    return { at, dir, center, a: tip(-1), b: tip(1) };
  }
  /** How far (px) the canvas point is from the arrow's line on screen (its centre, if a tip is off screen). */
  function arrowDistance(arrow, x, y) {
    return arrow.a && arrow.b ? segDist(x, y, arrow.a, arrow.b) : Math.hypot(arrow.center.x - x, arrow.center.y - y);
  }
  // The arrows' hit proxies (one shared by every arrow, posed per pick): a mouse's, a finger's.
  const arrowProxies = {};
  const _pq = new THREE.Quaternion();
  const _pp = new THREE.Vector3();
  const _ps = new THREE.Vector3();
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  function arrowProxy(touch) {
    const key = touch ? "touch" : "mouse";
    arrowProxies[key] ??= new THREE.Mesh(arrowHitGeometry((touch ? TOUCH_HIT_PX : ARROW_HIT_PX) / ARROW_UNIT_PX), hitMaterial());
    return arrowProxies[key];
  }
  /**
   * The arrow of screen dot `d` is under the canvas point: its hit proxy, posed on the
   * arrow as pose-scene draws it, meets the pointer's ray, or the point is within the dot's
   * radius of its centre (gizmo-pick.js's proxy-then-centre order).
   */
  function arrowPicks(d, x, y, touch) {
    const m = worldMatrix();
    const { width: w, height: h } = dom.getBoundingClientRect();
    if (!m || !(w > 0) || !(h > 0)) return false;
    const proxy = arrowProxy(touch);
    const { at, dir } = d.arrow;
    _pq.setFromUnitVectors(Z_AXIS, _ps.set(dir[0], dir[1], dir[2]));
    proxy.matrix.compose(_pp.set(at[0], at[1], at[2]), _pq, _ps.setScalar(ARROW_UNIT_PX * mmPerPx(at)));
    proxy.matrixWorld.multiplyMatrices(m, proxy.matrix);
    const cam = viewer.camera;
    cam.updateMatrixWorld?.();
    raycaster.setFromCamera({ x: (x / w) * 2 - 1, y: -(y / h) * 2 + 1 }, cam);
    return pickGizmoHandle({
      raycaster,
      proxies: [proxy],
      handleOf: (i) => (i ? d.hit : null),
      pointer: { x, y },
      center: d.arrow.center,
      centerRadiusPx: touch ? TOUCH_HIT_PX : HANDLE_HIT_PX,
      centerHandle: d.hit,
    }) !== null;
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
   * shown aim gizmo's ball; the nearest dot of any limb (taking the focus to its aim gizmo or
   * its joint's rings, or dropping it); the shown gizmo's rings (they reach past
   * NEAR_LIMB_PX); the inside of the shown gizmo (it stays); else the nearest limb alone.
   * `hit` is `{ kind: "dot", handleId, at, limb, gizmo?, ringOnly? }`,
   * `{ kind: "ring", handleId, limb, axis, name, at, gizmo }` (an aim ring),
   * `{ kind: "jring", ... }` (a joint ring, jointRingHit) or null.
   */
  function hoverAt(pt, { pressing = false } = {}) {
    const { x, y } = pt;
    const focus = hoverFocus ?? touchFocus;
    const aim = focus?.kind === "aim" ? gizmoTarget(focus.limb) : null;
    const onAim = gizmoHit(aim, pt);
    if (onAim?.gizmo === "ball") return { limb: onAim.limb, hit: onAim, focus };
    // The nearest dot of ANY limb, its limb then the one shown: where the knuckles crowd
    // (a zoomed-out hand), another finger's bones can pass nearer a dot than its own
    // limb's do at a pixel's tie, and restricting the dot to the bone-nearest limb left a
    // dot that hovering its own centre never reached (the index mcp gave the middle's).
    let dotHit = dotAt(x, y, null, HANDLE_HIT_PX);
    const limb = dotHit?.limb ?? nearestLimb(x, y);
    const jt = jointTarget(focus);
    const onJoint = onAim ? null : jointRingHit(jt, pt);
    const onRing = onAim ?? onJoint;
    // Inside a shown gizmo's rings another joint's dot takes over only on its core: on the
    // way from a joint out to its ring the pointer often passes near a neighbour's dot (a
    // finger's next knuckle, the thumb's tip), and handing it the focus there would flash
    // the gizmo away. The gizmo's own dots keep their full target, and so does every dot
    // at a PRESS with no ring under the pointer: a grab there is meant for the dot (an IK
    // drag of a knuckle beside a spread ring), and a press cannot flash anything.
    if (dotHit && focus && !(pressing && !onRing) && !ownDot(focus, dotHit) && insideFocus(focus, x, y) && !onDotCore(dotHit, x, y)) dotHit = null;
    // a dot and the shown ring both under the pointer (a ring crossing a neighbouring
    // joint's dot): the nearer wins, a tie to the ring that is up — so moving from a joint
    // out to its ring never hands the focus to a dot the ring runs over (that dot is
    // reached from outside the rings, or where it is nearer than the ring)
    // — except on the gizmo's own dot's core: a ring seen edge-on runs through its centre,
    // and the centre is the joint's dot (a click there pins it)
    if (dotHit && onRing && !(ownDot(focus, dotHit) && onDotCore(dotHit, x, y))) {
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
    if (hitChanged) syncGuides();
    if (claimsHover() !== claimed) notify(hoverListeners);
  }

  // ---- the resting cue --------------------------------------------------------
  /**
   * Every shown handle's grab point (part coordinates), as handlePoints lists them:
   * `{ points, arrows }` — an axis handle's as `{ point, direction }` (its arrow).
   */
  function cueMarks() {
    const points = [], arrows = [];
    for (const { handle, info, extra, generic } of shown) {
      if (extra) continue;
      const p = info.points[generic ? "tip" : handle.drag === "goal" ? goalAt(handle) : "tip"];
      if (!Array.isArray(p)) continue;
      const direction = generic ? arrowDir(info) : null;
      if (direction) arrows.push({ point: p, direction });
      else points.push(p);
    }
    return { points, arrows };
  }
  /** The cue's opacity now (0 once it has faded), from its start. */
  function cueOpacity() {
    if (typeof cue !== "object") return 0;
    if (cue.touch) return CUE_OPACITY;
    const t = now() - cue.start;
    if (t <= CUE_HOLD_MS) return CUE_OPACITY;
    const f = (t - CUE_HOLD_MS) / CUE_FADE_MS;
    return f >= 1 ? 0 : CUE_OPACITY * 0.5 * (1 + Math.cos(Math.PI * f)); // an eased fade
  }
  /** Hand the scene the cue's dots (they follow the handles), or none. */
  function syncCue() {
    if (!scene) return;
    scene.setCue?.(typeof cue === "object" && live ? { ...cueMarks(), opacity: cueOpacity() } : null);
  }
  /** Per frame: start the cue on the first live frame with the part on screen and no
   *  opening autoplay to wait out; fade it. */
  function tickCue() {
    if (cue === "pending") {
      if (!partsFrame()) return; // nothing built yet: the handles have nowhere to show
      if (cueBlocked()) return;  // the opening autoplay has the stage until it ends
      cue = { start: now(), touch: hoverNone() };
      syncCue();
      return;
    }
    if (typeof cue !== "object" || cue.touch) return;
    const o = cueOpacity();
    if (o <= 0) { endCue(); return; }
    if (o < CUE_OPACITY) {
      scene.setCueOpacity?.(o);
      viewer.requestRender?.();
    }
  }
  function endCue() {
    if (cue === "done") return;
    cue = "done";
    scene?.setCue?.(null);
    viewer.requestRender?.();
  }

  // ---- generic handles' guides ----------------------------------------------
  /**
   * The generic handle whose guides show: the one dragged, else the one whose dot is
   * hovered. Never an axis handle: its arrow already shows the line it slides on, and its
   * one-param path would be that same line.
   */
  function guideEntry() {
    const hit = press?.started ? press.hit : hoverHit;
    if (!hit?.generic) return null;
    const e = shown.find((s) => s.generic && s.handleId === hit.handleId) ?? null;
    return e && e.info.drag !== "axis" ? e : null;
  }
  /** A one-param handle's path, swept once per params other than its own (handle-guides' pathKey). */
  function pathOf({ handleId, handle }) {
    const swept = pathParam(handle);
    if (!swept) return null;
    const params = { ...part.defaults, ...getParams() };
    const key = pathKey(params, swept);
    const hit = paths.get(handleId);
    if (hit && key !== null && hit.key === key) return hit.guide;
    const guide = withDeriveMemo(() => sweepPath(part, params, handle));
    paths.set(handleId, { key, guide });
    return guide;
  }
  function syncGuides() {
    const e = guideEntry();
    const out = [];
    if (e) {
      const { info } = e;
      const at = info.points.tip;
      const s = mmPerPx(at);
      guideScale = s;
      const g = info.drag === "plane" && info.axis ? planeGuide(at, info.axis.direction, s)
        : info.drag === "rotary" && info.axis ? rotaryGuide(at, info.axis, s)
        : null;
      if (g) out.push(g);
      const path = pathOf(e);
      if (path) out.push(path);
    } else if (guideScale === null) return; // nothing shown, nothing to clear
    else guideScale = null;
    scene?.setGuides?.(out);
  }
  /** The cursor over a hover hit: grab on anything a press drags; a ring-only dot is a click (a pin). */
  const hoverCursor = (hit) => (!hit ? "" : hit.ringOnly ? "pointer" : "grab");

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
    if (ending.drag) setReadout(null);
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
    syncGuides();
    notify(hoverListeners);
  }

  /** Cross the drag threshold: snapshot, hold, and fix the drag plane / ring frame. */
  function startDrag(ev) {
    const { hit } = press;
    if (hit.ringOnly) { finishPress(); return false; } // a ring-only dot is not a grab
    const s = shown.find((e) => e.handleId === hit.handleId);
    const grab = hit.kind === "dot" ? s?.info.points[hit.at] : null;
    if (!s || (hit.kind === "dot" && !Array.isArray(grab))) { finishPress(); return false; }
    if (s.generic) return startGenericDrag(s, grab);
    const grabName = hit.kind === "ring" ? "ring" : hit.kind === "jring" ? `ring:${hit.joint}` : hit.at;
    if (!session.begin(hit.handleId, grabName)) { finishPress(); return false; }
    press.started = true;
    if (cue?.touch) endCue(); // touch: the first drag ends the cue
    setCursor("grabbing");
    notify(hoverListeners); // a drag began (mount closes a selection popover)
    const ray = press.ray;
    if (hit.kind === "dot") {
      const maxDist = 4 * Math.max(chainLength(s.info), 1);
      // A plane that holds the limb's line from its base joint to the grabbed point
      // (pose-geom's dragPlaneNormal), fixed for the whole drag: a pull along the limb's
      // on-screen line is a pull along the limb, so a finger seen end-on still straightens.
      const normal = dragPlaneNormal(ray.forward, sub(grab, chainOf(s.info)[0] ?? grab));
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

  /**
   * A generic handle's drag: the session solves through solveHandle; the pointer becomes a
   * target by the handle's drag kind (drag-kinds.js), from the press. An axis, plane or
   * rotary drag with no axis to move on is no grab.
   */
  function startGenericDrag(s, grab) {
    const kind = s.info.drag;
    if (kind !== "point" && !s.info.axis) { finishPress(); return false; }
    let drag;
    try {
      drag = startKindDrag(kind, { point: grab, axis: s.info.axis, ray: press.ray, screen: { x: press.x, y: press.y, project: toScreen } });
    } catch { finishPress(); return false; }
    if (!session.begin(s.handleId, handleAt(s.handle))) { finishPress(); return false; }
    press.started = true;
    if (cue?.touch) endCue(); // touch: the first drag ends the cue
    press.drag = drag;
    setCursor("grabbing");
    notify(hoverListeners); // a drag began (mount closes a selection popover)
    syncRings();
    syncGuides();
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
    if (press.drag) { genericStep(ev, ray); return; }
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

  function genericStep(ev, ray) {
    const { x, y } = local(ev);
    if (!session.frame(dragTarget(press.drag, { ray, screen: { x, y, project: toScreen } }))) return;
    refresh(); // the guides follow (readLimbs -> syncGuides)
    const s = shown.find((e) => e.generic && e.handleId === press.hit.handleId);
    if (!s) return;
    scene?.setActive({ limb: s.info.name, grab: "tip", clamped: [] });
    const params = { ...part.defaults, ...getParams() };
    setReadout({ handleId: s.handleId, text: readoutText(part, params, s.handle), items: readoutItems(part, params, s.handle) });
    viewer.requestRender?.();
  }

  // The live drag readout: the dragged generic handle's values, or null. Not drawn in the
  // scene: the bottom readout slot (drag-readout.js) shows it, as measure shows its X/Y/Z.
  let readout = null;
  function setReadout(r) {
    if (!r && !readout) return;
    readout = r;
    notify(readoutListeners, r ? { ...r, items: r.items.map((i) => ({ ...i })) } : null);
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
    tap = null;
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
      const dotHit = dotAt(x, y, null, TOUCH_HIT_PX);
      // the up gizmo's own dot, on its core, beats a ring seen edge-on through it (a pin tap)
      const onCore = dotHit && tf && ownDot(tf, dotHit) && onDotCore(dotHit, x, y);
      hit = (onCore ? null : tf?.kind === "aim" ? gizmoHit(gizmoTarget(tf.limb), pt, true) : jointRingHit(jointTarget(tf), pt, true))
        ?? dotHit;
      focus = hit?.kind === "dot" ? focusOfDot(hit) : hit ? tf : null;
      if (hit?.kind === "dot" && !hit.gizmo && focus?.kind === "aim") hit = { ...hit, gizmo: "ball" };
      if (tf && !sameFocus(focus, tf)) {
        // a touch anywhere else puts the gizmo away
        touchFocus = null;
        if (!hit) { setHover(null, null, null); return; }
      }
      if (hit?.ringOnly) {
        // A ring-only dot is not a grab: the press is left to orbit (a drag orbits). The
        // first touch puts that joint's rings up for the next touch to grab; a tap on it
        // while they are up toggles its pin. Its click is claimed either way, so a tap
        // never also picks the model.
        if (tf && sameFocus(focus, tf)) tap = { pointerId: ev.pointerId, x, y, hit };
        touchFocus = focus;
        clickClaimed = true;
        setHover(null, null, null);
        syncRings();
        return;
      }
    } else {
      // fresh from this press (a press need not follow a move)
      const h = hoverAt(pt, { pressing: true });
      setHover(h.limb, h.hit, h.focus);
      hit = h.hit;
      focus = h.focus;
      // a ring-only dot (a joint shown for its rings) is not a grab: a drag still orbits,
      // and a click toggles its pin (onPointerUp) — never a pick
      if (hit?.ringOnly) {
        tap = { pointerId: ev.pointerId, x, y, hit };
        clickClaimed = true;
        return;
      }
    }
    if (!hit) return;
    const ray = partRay(ev);
    if (!ray) return;
    press = {
      pointerId: ev.pointerId, hit, limb: hit.limb, focus, ray, x, y, touch,
      // touch: was this gizmo already up? (a first tap on the aim point only shows it)
      gizmoWasUp: touch && !!focus && sameFocus(touchFocus, focus),
      orbitEnabled: orbitControls?.enabled, started: false, plane: null, ring: null, drag: null,
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
    if (tap && ev.pointerId === tap.pointerId) {
      const { x, y } = local(ev);
      if ((x - tap.x) ** 2 + (y - tap.y) ** 2 > 16) tap = null; // an orbit, not a click
    }
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
    lastPt = local(ev);
    lastSub = showOnAny ? hoveredSubPart() : null;
    const { hit, limb, focus } = hoverAt(lastPt);
    setHover(limb, hit, focus);
    setCursor(hoverCursor(hit));
  }

  function onPointerUp(ev) {
    if (tap && (ev.pointerId == null || ev.pointerId === tap.pointerId)) {
      // a click on a ring-only dot: toggle its pin
      const id = pinIdOf(tap.hit);
      tap = null;
      if (id && live) session.togglePin(id);
      return;
    }
    if (!press || (ev.pointerId != null && ev.pointerId !== press.pointerId)) return;
    tracker.onUp(ev);
    const wasDrag = tracker.consumeClick() || press.started;
    const { hit, focus } = press;
    // A touch on an aim handle's goal point or gizmo, or on a joint with rings or its
    // rings, leaves that gizmo up.
    const touchGizmo = press.touch && !!focus;
    let ended = null;
    if (press.started) {
      flushMove();
      ended = session.end();
    } else if (!wasDrag && hit.kind === "dot" && !(focus && press.touch && !press.gizmoWasUp)) {
      // a click on any dot (a tip, a joint, a goal handle's point) toggles its pin. A
      // touch's first tap on a dot with a gizmo (the aim point, a joint with rings) only
      // shows the gizmo; a tap while it is up toggles the pin.
      const id = pinIdOf(hit);
      if (id) session.togglePin(id);
    }
    if (touchGizmo) touchFocus = focus;
    finishPress(press.touch ? null : local(ev));
    if (ended) {
      notify(dragEndListeners, {
        handleId: ended.handleId,
        generic: isGeneric(handles[ended.handleId]),
        changed: ended.changed,
        // nothing written, no frame moved anything, and a pin was holding: the pin did it
        pinHeld: ended.changed.length === 0 && !ended.moved && ended.held,
      });
    }
  }

  /** Abandon the press: a started drag reverts (session.cancel -> onCancel -> finishPress). */
  function abort() {
    tap = null;
    if (!press) return;
    tracker.onCancel({ pointerId: press.pointerId });
    if (press.started && session.isActive()) session.cancel();
    else finishPress();
  }

  function onPointerCancel(ev) {
    if (tap && (ev.pointerId == null || ev.pointerId === tap.pointerId)) tap = null;
    if (!press || (ev.pointerId != null && ev.pointerId !== press.pointerId)) return;
    abort();
  }
  function onLostPointerCapture(ev) {
    if (!press || (ev.pointerId != null && ev.pointerId !== press.pointerId)) return;
    abort();
  }
  function onBlur() { abort(); }
  function onPointerLeave() {
    lastPt = null;
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
    // The hover pick (mount's hoveredSubPart) lands after the move that asked for it: a
    // showOn handle is revealed on the frame it changes, under a still pointer.
    if (showOnAny && !press && lastPt) {
      const sub = hoveredSubPart();
      if (sub !== lastSub) {
        lastSub = sub;
        ensureFresh();
        const h = hoverAt(lastPt);
        setHover(h.limb, h.hit, h.focus);
        setCursor(hoverCursor(h.hit));
      }
    }
    // a zoom resizes the screen-constant guides
    if (guideScale !== null && !press?.started) {
      const e = guideEntry();
      const s = e && mmPerPx(e.info.points.tip);
      if (s && Math.abs(s - guideScale) > guideScale * GUIDE_RESCALE) syncGuides();
    }
    tickCue();
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
      guideScale = null;
      lastPt = null;
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
  /**
   * Mount: the view changed. Whatever the old layout left under a still pointer — hover,
   * focus, a touch's gizmo, a pending tap, the grab cursor and the claim — is dropped (the
   * model under it moved, or is gone), then the incoming view's handles are read.
   */
  function viewChanged() {
    if (detached) return;
    tap = null;
    lastPt = null;
    lastSub = null;
    if (touchFocus) { touchFocus = null; if (live) syncRings(); }
    if (!press) {
      setHover(null, null, null);
      setCursor("");
    }
    screenCache = null;
    stale = true;
    refresh();
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
    /** Re-read every shown limb (mount: when the shown set changes; param edits are noticed per frame). */
    refresh,
    /** Mount: the view switched — drop the old layout's hover state and re-read (viewChanged). */
    viewChanged,
    /** Mount: a sub-part's new mesh was shown — lift its ghost (same frame as setSubGeometry). */
    delivered: (name) => session.delivered(name),
    /** Mount: params were written from outside mid-drag (setParams) — revert the drag. */
    externalWrite: () => session.externalWrite(),
    /**
     * Where each shown handle's always-grabbable point (an angles limb's tip, a goal
     * handle's `at`, a generic handle's point — `at` "point" or its source's `at`) sits
     * on the canvas: `[{ handleId, at, x, y }]`, CSS px from the
     * canvas's top-left. An axis handle adds `arrow: { from, to }`, its arrow's two head
     * tips on the canvas. Drawn or not (at rest they are hidden until hovered). Empty
     * while posing is not live. `{ offscreen: true }` also lists a shown handle whose point
     * is off screen (behind the camera), with `visible: false` (the readout chip's test of
     * "still in this view"). For a host's coach marks and the
     * browser check (scripts/check-pose.mjs).
     */
    handlePoints({ offscreen = false } = {}) {
      ensureFresh();
      const out = [];
      for (const { handleId, handle, info, extra, generic } of shown) {
        if (extra) continue; // a limb shown only for its joint rings has no handle point
        const at = generic ? "tip" : handle.drag === "goal" ? goalAt(handle) : "tip";
        const s = toScreen(info.points[at]);
        // a generic handle reports its own point name ("point", or its source's `at`)
        const name = generic ? handleAt(handle) : at;
        // an axis handle: where its arrow's two head tips sit too (a press anywhere between grabs it)
        const arrow = generic && s && s.visible !== false ? arrowScreen(info) : null;
        if (arrow?.a && arrow.b) out.push({ handleId, at: name, x: s.x, y: s.y, arrow: { from: { x: arrow.a.x, y: arrow.a.y }, to: { x: arrow.b.x, y: arrow.b.y } } });
        else if (s && s.visible !== false) out.push({ handleId, at: name, x: s.x, y: s.y });
        else if (offscreen) out.push({ handleId, at: name, x: s?.x ?? null, y: s?.y ?? null, visible: false });
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
    /**
     * Every pin badge the scene draws: `[{ limb, at, point, x, y }]` — `point` the pinned
     * point in part coordinates, (x, y) where it sits on the canvas, CSS px. For the browser
     * check (scripts/check-pose.mjs) and tests.
     */
    pinPoints() {
      ensureFresh();
      return (scene?.pinBadges?.() ?? []).map((b) => {
        const s = toScreen(b.point);
        return { ...b, x: s?.x ?? null, y: s?.y ?? null };
      });
    },
    /** How many objects the pose overlay draws now (dots, bones, badges, guides). For the browser check. */
    drawnObjects: () => (scene?.group?.children.length ?? 0) + (scene?.guideGroup?.children.length ?? 0),
    /** The pinned points badged in this view; a pin whose handle this view hides holds nothing and counts for nothing. */
    pinCount: () => pinnedPoints.length,
    getPins: () => session.pins,
    setPins: (ids) => session.setPins(ids),
    releasePins: () => session.releasePins(),
    onPinsChange: (cb) => { pinListeners.add(cb); return () => pinListeners.delete(cb); },
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    /**
     * Fires when a drag is released (not cancelled): `{ handleId, generic, changed, pinHeld }`
     * — `changed` the keys it committed; `pinHeld` when it wrote nothing because a pin held it
     * (no frame moved a value and a pin was holding). The readout chip listens.
     */
    onDragEnd: (cb) => { dragEndListeners.add(cb); return () => dragEndListeners.delete(cb); },
    /**
     * Fires on every frame of a generic handle's drag with `{ handleId, text, items }`
     * (handle-guides' readoutText / readoutItems), and with null when the drag ends.
     * The bottom readout (drag-readout.js) listens.
     */
    onReadout: (cb) => { readoutListeners.add(cb); return () => readoutListeners.delete(cb); },
    /** The live drag readout now, as onReadout last gave it, or null. */
    getReadout: () => (readout ? { ...readout, items: readout.items.map((i) => ({ ...i })) } : null),
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
      for (const p of Object.values(arrowProxies)) { p.geometry.dispose(); p.material.dispose(); }
      setCursor("");
      modeListeners.clear();
      pinListeners.clear();
      dragEndListeners.clear();
      readoutListeners.clear();
      hoverListeners.clear();
    },
  };
}
