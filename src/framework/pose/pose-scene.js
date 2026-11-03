// Pose mode's in-scene overlay: handle dots, the live skeleton, limit arcs, the
// out-of-reach line and pin badges. Modelled on measure/dim3-scene.js:
// one group parented under the sub-meshes' shared frame (so part coordinates map
// straight in and the pivot / recentring / pose fast path apply for free),
// hidden from canonical captures, drawn over the model (depthTest:false) and
// never cutaway-clipped.
//
// At rest it draws nothing but pin badges — one AT each pinned point (setPins takes
// points, `{ limb, at }`: a pin-coloured dot on the point and a head on a short stem above
// it), following the posed point on every setLimbs — while a limb's skeleton and dots show
// only while it is hovered (setHover) or dragged (setActive) — posing is always on
// in the normal click mode, so an idle overlay would sit on every part with handles.
//
// Steady by design (no flashing, no jumping): the state setters rebuild the
// objects; tick() only re-sizes the screen-constant pieces (dots, badges, dashes) from
// the camera, and a camera move is already a frame. It draws no text: a drag's values,
// and how far an out-of-reach drag misses, show in the bottom readout (drag-readout.js).
// A clamped joint is a steady warning colour, never a blink. Hit testing is not
// done here - Task 7 runs `hitHandle` over `viewer.projectPoint` positions with a
// 24 CSS px target, so the visuals can stay small.
//
// A limb pose mode shows only for its joint rings (a parent palm an angles handle's
// `joints` names) arrives with `ringsOnly`, the joints whose dots to draw: no tip dot.
//
// A goal handle with `aim` gets the aim gizmo (aim-gizmo.js: a centre ball and rotate
// rings, drawn and picked there). setAimGizmo tells this scene which limb's goal point
// the gizmo's ball stands on, so its dot is not drawn twice.
//
// A generic handle (`on` / `point`) arrives as a pseudo-limb (handle-source.js's
// handleRecord): no joints, one "tip" dot, and its source's `lines` (point pairs) drawn as
// bones. Its guides (setGuides: the axis arrow, plane square, rotary ring and path, in part
// coordinates) live in a second group beside the first, so a drag frame redraws them without
// rebuilding the limbs. Its drag values are not drawn here: they read out in the DOM, in the
// viewbar's readout slot (drag-readout.js).
//
// An AXIS handle (`drag: "axis"`, a record whose `axis` has a direction) draws as a
// two-sided arrow instead of a dot: the cutaway's translate arrow with a head at each end
// (gizmo/gizmo-handles.js's arrowGeometryPairs / arrowMeshes), centred on its point, turned
// onto its axis and ARROW_UNIT_PX per arrow unit on screen. Hovered or dragged it follows
// the gizmo hover rule (colour lifted toward white, thicker geometry); pinned it takes the
// pin colour. pose-mode picks it through the same arrow's hit proxy (arrowHitGeometry).
//
// The RESTING CUE (setCue, pose-mode.js decides when): a dimmed tip-sized dot at every
// shown handle's point — a dimmed arrow for an axis handle — in the limbs' group (so never
// in a capture), with a material of its own whose opacity setCueOpacity fades without a
// rebuild.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "../cutaway-render.js";
import { worldPerPx, orthoWorldPerPx } from "../measure/dim3-scene.js";
import { limitArc } from "./pose-geom.js";
import { ARROW_UNIT_PX, applyHandleAppearance, arrowGeometryPairs, arrowMeshes } from "../gizmo/gizmo-handles.js";

// Match the measure / cutaway chrome: handle = the cutaway fill blue, active =
// its border blue, skeleton = the dimension ink, warn = a steady amber, pin = a pink no
// other pose or cutaway chrome uses (a pinned point's dot and its badge).
export const POSE_THEME = {
  dark: {
    handle: 0x65bff5, strong: 0xa8dcff, bone: 0x7d93b8, warn: 0xffb454, target: 0xa8dcff, pin: 0xf472b6,
  },
  light: {
    handle: 0x1479b8, strong: 0x075985, bone: 0x5a6c8a, warn: 0xc2410c, target: 0x075985, pin: 0xbe185d,
  },
};

// Above the dimension ink, below nothing: pose mode and measure mode are exclusive.
export const RENDER_ORDER_POSE = CUTAWAY_OVERLAY_RENDER_ORDER + 4;

// Screen-constant sizes, CSS px (radius for dots).
export const TIP_DOT_PX = 6;
export const TIP_DOT_ACTIVE_PX = 7.5;
export const JOINT_DOT_PX = 3.5;
export const GRAB_HALO_PX = 11;
export const TARGET_RING_PX = 7;
export const PIN_HEAD_PX = 4.5;
// The head sits within a dot's 14 px hit radius, so clicking the badge hits the pinned dot.
export const PIN_LIFT_PX = 10;
/** The pin-coloured dot on a pinned point at rest (shown limbs draw the point's own dot pinned). */
export const PIN_BASE_PX = 3;
export const DASH_PX = 5;
export const GAP_PX = 4;

function polyline(points, closed = false) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) out.push(...points[i], ...points[i + 1]);
  if (closed && points.length > 2) out.push(...points.at(-1), ...points[0]);
  return out;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

export function createPoseScene(viewer) {
  const redraw = () => viewer.requestRender?.();
  const group = new THREE.Group();
  group.name = "pf-pose";
  // the guides (setGuides), redrawn on their own
  const guideGroup = new THREE.Group();
  guideGroup.name = "pf-pose-guides";
  let attached = false;
  let unregisterCapture = () => {};
  function ensureAttached() {
    if (attached) return true;
    const parent = Object.values(viewer._subMeshes ?? {})[0]?.parent;
    if (!parent) return false;
    parent.add(group);
    parent.add(guideGroup);
    const offs = [group, guideGroup].map((g) => viewer.registerCanonicalCaptureHidden?.(g) ?? (() => {}));
    unregisterCapture = () => { for (const off of offs) off(); };
    attached = true;
    return true;
  }

  let theme = viewer.getTheme?.() ?? "dark";
  if (!POSE_THEME[theme]) theme = "dark";

  // ---- materials (shared, recoloured on theme change) ------------------------
  const colorKeys = ["handle", "strong", "bone", "warn", "target", "pin"];
  const fillMats = {};
  const lineMats = {};
  const prep = (m) => { m.depthTest = false; m.depthWrite = false; m.transparent = true; return m; };
  for (const k of colorKeys) {
    const c = POSE_THEME[theme][k];
    fillMats[k] = prep(new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    lineMats[k] = prep(new LineMaterial({ color: c, linewidth: 2 }));
  }
  // quieter lines: rings at the limb radii, and arcs that are not the active ones
  lineMats.faint = prep(new LineMaterial({ color: POSE_THEME[theme].bone, linewidth: 1, opacity: 0.55 }));
  lineMats.dashed = prep(new LineMaterial({ color: POSE_THEME[theme].warn, linewidth: 1.5, dashed: true, dashSize: 5, gapSize: 4 }));
  // a generic handle's guides: the handle colour, lighter than a bone
  lineMats.guide = prep(new LineMaterial({ color: POSE_THEME[theme].handle, linewidth: 1.5, opacity: 0.8 }));
  // the resting cue's dots: the handle colour, faded by opacity alone (setCueOpacity)
  const cueMat = prep(new THREE.MeshBasicMaterial({ color: POSE_THEME[theme].handle, opacity: 0 }));
  // an axis handle's arrow, one material per look (the hover rule paints them): the handle
  // colour, and pinned, each plain and hovered
  const arrowMats = {
    handle: prep(new THREE.MeshBasicMaterial()),
    hot: prep(new THREE.MeshBasicMaterial()),
    pin: prep(new THREE.MeshBasicMaterial()),
    pinHot: prep(new THREE.MeshBasicMaterial()),
  };
  const arrowLook = (key) => ({ color: POSE_THEME[theme][key.startsWith("pin") ? "pin" : "handle"], hovered: key.endsWith("ot") });
  const paintArrowMats = () => {
    for (const [key, material] of Object.entries(arrowMats)) applyHandleAppearance({ material, geometryPairs: [] }, arrowLook(key));
  };
  paintArrowMats();
  const allMats = () => [...Object.values(fillMats), ...Object.values(lineMats), ...Object.values(arrowMats), cueMat];
  const paintMats = () => {
    const P = POSE_THEME[theme];
    for (const k of colorKeys) { fillMats[k].color.set(P[k]); lineMats[k].color.set(P[k]); }
    lineMats.faint.color.set(P.bone);
    lineMats.dashed.color.set(P.warn);
    lineMats.guide.color.set(P.handle);
    cueMat.color.set(P.handle);
    paintArrowMats();
  };

  // shared unit geometries (scaled per frame); never disposed per rebuild
  const unitDot = new THREE.SphereGeometry(1, 14, 10);
  const unitRing = new THREE.RingGeometry(0.62, 1, 28);
  const arrowPairs = arrowGeometryPairs({ twoSided: true });
  const shared = new Set([unitDot, unitRing, ...Object.values(arrowPairs).flatMap((p) => [p.normal, p.hovered])]);

  // ---- state -----------------------------------------------------------------
  let limbs = [];
  let hover = null;
  let hoverDot = null; // the hovered limb's dot under the pointer (a joint name or "tip")
  let active = null;
  let pins = [];       // pinned points: [{ limb, at }]
  let aimGizmo = null; // { limb, at }: that limb's goal point is the aim gizmo's ball
  let guides = [];     // [{ kind, points }] (setGuides)
  let cue = [];        // the resting cue's points (setCue)
  let cueArrows = [];  // ...and its axis handles' arrows: [{ point, direction }]
  let dirty = false;

  // ---- per-build records, sized in tick() -------------------------------------
  let dots = [];       // { mesh, pos: Vector3, px }
  let billboards = []; // { mesh, pos, px }   (rings that face the camera)
  let pinRecs = [];    // { head, stem, pos }
  let arrows = [];     // { root, pos, direction, look }   (axis handles' arrows)
  let dashRec = null;  // { line, a, b }

  function addDot(matKey, pos, px) {
    const mesh = new THREE.Mesh(unitDot, matKey === "cue" ? cueMat : fillMats[matKey]);
    mesh.renderOrder = RENDER_ORDER_POSE + 1;
    mesh.frustumCulled = false;
    mesh.position.copy(pos);
    group.add(mesh);
    dots.push({ mesh, pos, px });
    return mesh;
  }
  function addBillboard(matKey, pos, px) {
    const mesh = new THREE.Mesh(unitRing, fillMats[matKey]);
    mesh.renderOrder = RENDER_ORDER_POSE + 1;
    mesh.frustumCulled = false;
    mesh.position.copy(pos);
    group.add(mesh);
    billboards.push({ mesh, pos, px });
    return mesh;
  }
  const _z = new THREE.Vector3(0, 0, 1);
  /** A two-sided arrow at `pos` along `direction`, in the look `look` (an arrowMats key, or "cue"). */
  function addArrow(look, pos, direction) {
    const material = look === "cue" ? cueMat : arrowMats[look];
    const { root, meshes, geometryPairs } = arrowMeshes(arrowPairs, material, { twoSided: true });
    for (const m of meshes) { m.renderOrder = RENDER_ORDER_POSE + 1; m.frustumCulled = false; }
    if (look !== "cue") applyHandleAppearance({ material, geometryPairs }, arrowLook(look));
    root.position.copy(pos);
    root.quaternion.setFromUnitVectors(_z, new THREE.Vector3(...direction).normalize());
    group.add(root);
    arrows.push({ root, pos, direction: [...direction], look });
    return root;
  }
  function addLine(matKey, flat, order = RENDER_ORDER_POSE, into = group) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(flat);
    const line = new LineSegments2(geo, lineMats[matKey]);
    line.renderOrder = order;
    line.frustumCulled = false;
    into.add(line);
    return line;
  }

  function disposeGroup(g) {
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse((o) => {
        if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose?.();
        const m = o.material;
        if (m && !allMats().includes(m)) m.dispose?.();
      });
    }
  }
  function disposeChildren() {
    disposeGroup(group);
    dots = []; billboards = []; pinRecs = []; arrows = []; dashRec = null;
  }

  // ---- build -----------------------------------------------------------------
  const vec = (a) => new THREE.Vector3(...a);

  function orderedPoints(info) {
    const names = [...info.joints.map((j) => j.name), "tip"];
    return names.map((n) => info.points[n]);
  }

  // Rotate v about unit axis by deg degrees (Rodrigues) - used to recover the
  // joint's zero direction so a limit arc spans [lo, hi] in the limb's own angles.
  function rotateAbout(v, axis, deg) {
    const a = new THREE.Vector3(...axis).normalize();
    return new THREE.Vector3(...v).applyAxisAngle(a, (deg * Math.PI) / 180).toArray();
  }

  const isPinned = (limb, at) => pins.some((p) => p.limb === limb && p.at === at);
  /** An axis handle's record: its arrow's direction, else null (it draws a dot). */
  const arrowDirection = (info) => (info.drag === "axis" && validDirection(info.axis?.direction) ? info.axis.direction : null);

  function buildShownLimb(info, act) {
    const pts = orderedPoints(info);
    // the grabbed point while dragging, else the hovered one: same strong dot + halo
    const grab = act?.grab ?? hoverDot;
    const clamped = act?.clamped ?? [];
    // skeleton (a generic handle's record has no joints: only its source's lines)
    if (pts.length > 1) addLine("bone", polyline(pts));
    const lines = Array.isArray(info.lines) ? info.lines.flatMap(([a, b]) => [...a, ...b]) : [];
    if (lines.length) addLine("bone", lines);
    // rings at the limb's radii, perpendicular to the local bone direction
    if (info.r) {
      pts.forEach((p, i) => {
        const r = info.r[i];
        if (!(r > 0)) return;
        const next = pts[i + 1] ?? null, prev = pts[i - 1] ?? null;
        const dir = next ? sub(next, p) : sub(p, prev ?? p);
        if (len(dir) < 1e-9) return;
        addLine("faint", polyline(limitArc(p, dir, [1, 0, 0], [0, 360], r, 36)));
      });
    }
    // limit arcs of the moving hinges (only while a drag is on)
    if (act) {
      info.joints.forEach((j, i) => {
        if (j.type === "ball" || !j.range || !info.axes?.[j.name]) return;
        const p = pts[i], next = pts[i + 1], prev = pts[i - 1];
        const bone = next ? sub(next, p) : sub(p, prev ?? p);
        if (!(len(bone) > 1e-9)) return;
        const radius = len(bone) * 0.45;
        const axis = info.axes[j.name];
        const value = typeof info.values?.[i] === "number" ? info.values[i] : 0;
        const along = (bone[0] * axis[0] + bone[1] * axis[1] + bone[2] * axis[2]) / (len(axis) || 1);
        const perp = [bone[0] - axis[0] * along / (len(axis) || 1), bone[1] - axis[1] * along / (len(axis) || 1), bone[2] - axis[2] * along / (len(axis) || 1)];
        const ref = rotateAbout(perp, axis, -value);
        const arc = limitArc(p, axis, ref, j.range, radius, 32);
        addLine(clamped[i] ? "warn" : "faint", polyline(arc));
        // closing spokes at both ends so the allowed sweep reads as a wedge
        addLine(clamped[i] ? "warn" : "faint", [...p, ...arc[0], ...p, ...arc.at(-1)]);
      });
    }
    // joint dots (not the one the aim gizmo's ball stands on)
    const owned = aimGizmo?.limb === info.name ? aimGizmo.at : null;
    info.joints.forEach((j, i) => {
      if (j.name === owned) return;
      if (info.ringsOnly && !info.ringsOnly.includes(j.name)) return; // shown for its rings only
      const isGrab = grab === j.name;
      const pinned = isPinned(info.name, j.name);
      // a pinned joint: a bigger dot in the pin colour (a tip's size), its halo pin-coloured too
      addDot(clamped[i] ? "warn" : pinned ? "pin" : isGrab ? "strong" : "handle", vec(pts[i]), pinned ? TIP_DOT_PX : JOINT_DOT_PX);
      if (isGrab) addBillboard(clamped[i] ? "warn" : pinned ? "pin" : "strong", vec(pts[i]), GRAB_HALO_PX);
    });
  }

  /** The shown limb draws its own dot at `at` (so a pin badge adds no base dot there). */
  function drawsDot(info, at, shownName) {
    if (info.name !== shownName) return false;
    if (aimGizmo?.limb === info.name && aimGizmo.at === at) return true; // the gizmo's ball
    if (at === "tip") return !info.ringsOnly;
    return !info.ringsOnly || info.ringsOnly.includes(at);
  }

  function rebuild() {
    dirty = false;
    if (!ensureAttached()) { dirty = true; return; }
    disposeChildren();
    const shown = active?.limb ?? hover;
    // the resting cue, under everything else
    for (const p of cue) addDot("cue", vec(p), TIP_DOT_PX);
    for (const a of cueArrows) addArrow("cue", vec(a.point), a.direction);
    for (const info of limbs) {
      const isShown = info.name === shown;
      if (!isShown) continue; // at rest: nothing but the pin badges below
      const isActive = active?.limb === info.name;
      buildShownLimb(info, isActive ? active : null);
      if (aimGizmo?.limb === info.name && aimGizmo.at === "tip") continue;
      if (info.ringsOnly) continue; // a limb shown for its joint rings has no tip handle
      const tip = vec(info.points.tip);
      const isGrab = isActive ? active.grab === "tip" : hoverDot === "tip";
      const pinned = isPinned(info.name, "tip");
      const direction = arrowDirection(info);
      if (direction) {
        // an axis handle: its arrow is the grab target (hovered or dragged: the hover look)
        addArrow(pinned ? (isGrab ? "pinHot" : "pin") : isGrab ? "hot" : "handle", tip, direction);
        continue;
      }
      addDot(pinned ? "pin" : isGrab ? "strong" : "handle", tip, isGrab ? TIP_DOT_ACTIVE_PX : TIP_DOT_PX);
      if (isGrab) addBillboard(pinned ? "pin" : "strong", tip, GRAB_HALO_PX);
    }
    // reach miss: hollow target + dashed line (how far it misses: the bottom readout). The
    // caller decides `missed` (pose-geom's reachMissed), the same test the readout's
    // "Out of reach" uses, so the two show together.
    const act = active && limbs.find((l) => l.name === active.limb);
    if (act && active.target && active.missed === true) {
      // from the grabbed point (a joint in angles mode, a goal's `at`), the tip if it has none
      const from = Array.isArray(act.points[active.grab]) ? act.points[active.grab] : act.points.tip;
      const a = vec(from), b = vec(active.target);
      addBillboard("warn", b, TARGET_RING_PX);
      const line = addLine("dashed", [...a.toArray(), ...b.toArray()]);
      line.computeLineDistances();
      dashRec = { line, a, b };
    }
    // pin badges, at each pinned point: a pin-coloured dot on it (unless the shown limb
    // already draws that point's dot pinned), and a head floating above it on a stem
    for (const pin of pins) {
      const info = limbs.find((l) => l.name === pin.limb);
      const p = info?.points[pin.at];
      if (!Array.isArray(p)) continue;
      const pos = vec(p);
      if (!drawsDot(info, pin.at, shown)) addDot("pin", pos, PIN_BASE_PX);
      const head = new THREE.Mesh(unitDot, fillMats.pin);
      head.renderOrder = RENDER_ORDER_POSE + 2;
      head.frustumCulled = false;
      group.add(head);
      const stem = addLine("pin", [0, 0, 0, 0, 0, 0], RENDER_ORDER_POSE + 1);
      pinRecs.push({ head, stem, pos, limb: pin.limb, at: pin.at });
    }
    redraw();
  }

  /** The guides, in their own group. */
  function rebuildGuides() {
    if (!ensureAttached()) { dirty = true; return; }
    disposeGroup(guideGroup);
    for (const g of guides) {
      const closed = g.kind === "plane" || g.kind === "rotary";
      const flat = polyline(g.points, closed);
      if (flat.length) addLine("guide", flat, RENDER_ORDER_POSE, guideGroup);
    }
    redraw();
  }

  // ---- per-frame sizing ------------------------------------------------------
  const _wp = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _gq = new THREE.Quaternion();
  const _up = new THREE.Vector3();
  const _a = new THREE.Vector3();
  function tick() {
    if (dirty) { rebuild(); rebuildGuides(); }
    if (!attached || (!group.children.length && !guideGroup.children.length)) return;
    const el = viewer.domElement;
    const h = el?.clientHeight || 1;
    const w = el?.clientWidth || 1;
    for (const m of Object.values(lineMats)) m.resolution.set(w, h);
    const cam = viewer.camera;
    cam.updateMatrixWorld?.();
    const ortho = cam.isOrthographicCamera;
    const wppAt = (local) => {
      if (ortho) return orthoWorldPerPx(cam.top, cam.bottom, cam.zoom, h);
      group.localToWorld(_wp.copy(local));
      return worldPerPx(cam.position.distanceTo(_wp), cam.fov ?? 45, h);
    };
    group.getWorldQuaternion(_gq);
    // a billboard faces the camera: local = groupWorld^-1 * cameraWorld
    cam.getWorldQuaternion(_q);
    _q.premultiply(_gq.invert()); // _gq is re-read every tick: invert it in place
    for (const d of dots) d.mesh.scale.setScalar(Math.max(d.px * wppAt(d.pos), 1e-6));
    for (const a of arrows) a.root.scale.setScalar(Math.max(ARROW_UNIT_PX * wppAt(a.pos), 1e-6));
    for (const b of billboards) {
      b.mesh.scale.setScalar(Math.max(b.px * wppAt(b.pos), 1e-6));
      b.mesh.quaternion.copy(_q);
    }
    _up.set(0, 1, 0).applyQuaternion(_q);
    for (const p of pinRecs) {
      const wpp = wppAt(p.pos);
      p.head.scale.setScalar(Math.max(PIN_HEAD_PX * wpp, 1e-6));
      p.head.position.copy(p.pos).addScaledVector(_up, PIN_LIFT_PX * wpp);
      const data = p.stem.geometry.attributes.instanceStart.data;
      data.array.set([p.pos.x, p.pos.y, p.pos.z, p.head.position.x, p.head.position.y, p.head.position.z]);
      data.needsUpdate = true;
    }
    if (dashRec) {
      const wpp = wppAt(_a.copy(dashRec.a).add(dashRec.b).multiplyScalar(0.5));
      lineMats.dashed.dashSize = DASH_PX * wpp;
      lineMats.dashed.gapSize = GAP_PX * wpp;
    }
  }

  // ---- public state setters --------------------------------------------------
  function setLimbs(infos) { limbs = Array.isArray(infos) ? infos : []; rebuild(); }
  /** The hovered limb (null: none) and, optionally, its dot under the pointer. */
  function setHover(name, dot = null) {
    const next = name ?? null;
    const nextDot = next ? dot ?? null : null;
    if (next === hover && nextDot === hoverDot) return;
    hover = next;
    hoverDot = nextDot;
    rebuild();
  }
  function setActive(a) { active = a ?? null; rebuild(); }
  /** The pinned points, `[{ limb (a limb's name), at (a joint name or "tip") }]`: a badge at each. */
  function setPins(points) {
    pins = (Array.isArray(points) ? points : [])
      .filter((p) => p && typeof p.limb === "string" && typeof p.at === "string")
      .map((p) => ({ limb: p.limb, at: p.at }));
    rebuild();
  }
  /** The limb whose goal point (`at`: a joint name or "tip") the aim gizmo draws, or null. */
  function setAimGizmo(a) {
    const next = a && a.limb ? { limb: a.limb, at: a.at ?? "tip" } : null;
    if (next?.limb === aimGizmo?.limb && next?.at === aimGizmo?.at) return;
    aimGizmo = next;
    rebuild();
  }
  const validPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
  function validDirection(v) { return validPoint(v) && Math.hypot(v[0], v[1], v[2]) > 1e-12; }
  /** A generic handle's guides, `[{ kind: "axis"|"plane"|"rotary"|"path", points }]` in part coordinates (plane and rotary close). */
  function setGuides(list) {
    const next = (Array.isArray(list) ? list : [])
      .filter((g) => g && Array.isArray(g.points) && g.points.length > 1 && g.points.every(validPoint))
      .map((g) => ({ kind: g.kind, points: g.points.map((p) => [...p]) }));
    if (!next.length && !guides.length) return;
    guides = next;
    rebuildGuides();
  }
  /**
   * The resting cue: `{ points: [[x, y, z], ...], arrows: [{ point, direction }], opacity }`
   * (part coordinates), or null. A dimmed dot at each point and a dimmed arrow for each axis
   * handle, drawn under the limbs; pose-mode fades them (setCueOpacity).
   */
  function setCue(c) {
    const next = c && Array.isArray(c.points) ? c.points.filter(validPoint).map((p) => [...p]) : [];
    const nextArrows = c && Array.isArray(c.arrows)
      ? c.arrows.filter((a) => validPoint(a?.point) && validDirection(a.direction)).map((a) => ({ point: [...a.point], direction: [...a.direction] }))
      : [];
    if (c && Number.isFinite(c.opacity)) cueMat.opacity = c.opacity;
    if (!next.length && !cue.length && !nextArrows.length && !cueArrows.length) return;
    cue = next;
    cueArrows = nextArrows;
    rebuild();
  }
  /** The cue's opacity, 0..1: a material change, no rebuild. */
  function setCueOpacity(o) {
    if (!Number.isFinite(o) || o === cueMat.opacity) return;
    cueMat.opacity = Math.max(0, Math.min(1, o));
    if (cue.length || cueArrows.length) redraw();
  }
  function clear() {
    limbs = []; hover = null; hoverDot = null; active = null; pins = []; aimGizmo = null;
    guides = []; cue = []; cueArrows = [];
    disposeGroup(guideGroup);
    disposeChildren();
    redraw();
  }

  function setTheme(mode) {
    if (!POSE_THEME[mode] || mode === theme) return;
    theme = mode;
    paintMats();
    rebuild();
  }

  function dispose() {
    redraw();
    disposeChildren();
    disposeGroup(guideGroup);
    unregisterCapture();
    if (attached) { group.parent?.remove(group); guideGroup.parent?.remove(guideGroup); }
    attached = false;
    for (const m of allMats()) m.dispose();
    for (const g of shared) g.dispose();
  }

  /** The pin badges drawn now: `[{ limb, at, point }]` (point: part coordinates). For tests and the browser check. */
  function pinBadges() {
    return pinRecs.map((r) => ({ limb: r.limb, at: r.at, point: r.pos.toArray() }));
  }

  /**
   * The arrows drawn now: `[{ point, direction, look, hovered }]` — look "handle", "hot",
   * "pin", "pinHot" or "cue"; `hovered` whether it wears the hovered (thick) geometry. For tests.
   */
  function arrowState() {
    return arrows.map((a) => ({
      point: a.pos.toArray(), direction: [...a.direction], look: a.look,
      hovered: a.root.children[0].geometry === arrowPairs.shaft.hovered,
    }));
  }

  /** The guides drawn now: `{ guides: [{ kind, points }] }`. For tests. */
  const guideState = () => ({ guides: guides.map((g) => ({ ...g })) });

  return { setLimbs, setHover, setActive, setPins, setAimGizmo, setGuides, setCue, setCueOpacity, clear, tick, setTheme, group, guideGroup, dispose, pinBadges, guideState, arrowState };
}
