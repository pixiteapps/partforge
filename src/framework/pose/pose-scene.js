// Pose mode's in-scene overlay: handle dots, the live skeleton, limit arcs, the
// out-of-reach line, pin badges and aim rings. Modelled on measure/dim3-scene.js:
// one group parented under the sub-meshes' shared frame (so part coordinates map
// straight in and the pivot / recentring / pose fast path apply for free),
// hidden from canonical captures, drawn over the model (depthTest:false) and
// never cutaway-clipped.
//
// Steady by design (no flashing, no jumping): the state setters rebuild the
// objects; tick() only re-sizes the screen-constant pieces (dots, badges, labels,
// dashes, aim rings) from the camera, and a camera move is already a frame.
// A clamped joint is a steady warning colour, never a blink. Hit testing is not
// done here - Task 7 runs `hitHandle` over `viewer.projectPoint` positions with a
// 24 CSS px target, so the visuals can stay small.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "../cutaway-render.js";
import { DIM_THEME, defaultPaintLabel, worldPerPx, orthoWorldPerPx, LABEL_SCREEN_PX } from "../measure/dim3-scene.js";
import { limitArc } from "./pose-geom.js";

// Match the measure / cutaway chrome: handle = the cutaway fill blue, active =
// its border blue, skeleton = the dimension ink, warn = a steady amber.
export const POSE_THEME = {
  dark: {
    handle: 0x65bff5, strong: 0xa8dcff, bone: 0x7d93b8, warn: 0xffb454, target: 0xa8dcff,
    pitch: 0xff6b7a, yaw: 0x5aa9ff, roll: 0x36d399,
  },
  light: {
    handle: 0x1479b8, strong: 0x075985, bone: 0x5a6c8a, warn: 0xc2410c, target: 0x075985,
    pitch: 0xc92a3b, yaw: 0x1769aa, roll: 0x087f5b,
  },
};

// Above the dimension ink, below nothing: pose mode and measure mode are exclusive.
export const RENDER_ORDER_POSE = CUTAWAY_OVERLAY_RENDER_ORDER + 4;
export const RENDER_ORDER_POSE_LABEL = CUTAWAY_OVERLAY_RENDER_ORDER + 5;

// Screen-constant sizes, CSS px (radius for dots).
export const TIP_DOT_PX = 6;
export const TIP_DOT_ACTIVE_PX = 7.5;
export const JOINT_DOT_PX = 3.5;
export const GRAB_HALO_PX = 11;
export const TARGET_RING_PX = 7;
export const PIN_HEAD_PX = 4.5;
export const PIN_LIFT_PX = 16;
export const AIM_RING_PX = 36;
export const DASH_PX = 5;
export const GAP_PX = 4;
const LABEL_LIFT_PX = 14;
const RESIDUAL_MIN = 0.01;

function polyline(points, closed = false) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) out.push(...points[i], ...points[i + 1]);
  if (closed && points.length > 2) out.push(...points.at(-1), ...points[0]);
  return out;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

export function createPoseScene(viewer, { paintLabel = defaultPaintLabel } = {}) {
  const redraw = () => viewer.requestRender?.();
  const group = new THREE.Group();
  group.name = "pf-pose";
  let attached = false;
  let unregisterCapture = () => {};
  function ensureAttached() {
    if (attached) return true;
    const parent = Object.values(viewer._subMeshes ?? {})[0]?.parent;
    if (!parent) return false;
    parent.add(group);
    unregisterCapture = viewer.registerCanonicalCaptureHidden?.(group) ?? (() => {});
    attached = true;
    return true;
  }

  let theme = viewer.getTheme?.() ?? "dark";
  if (!POSE_THEME[theme]) theme = "dark";

  // ---- materials (shared, recoloured on theme change) ------------------------
  const colorKeys = ["handle", "strong", "bone", "warn", "target", "pitch", "yaw", "roll"];
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
  const allMats = () => [...Object.values(fillMats), ...Object.values(lineMats)];
  const paintMats = () => {
    const P = POSE_THEME[theme];
    for (const k of colorKeys) { fillMats[k].color.set(P[k]); lineMats[k].color.set(P[k]); }
    lineMats.faint.color.set(P.bone);
    lineMats.dashed.color.set(P.warn);
  };

  // shared unit geometries (scaled per frame); never disposed per rebuild
  const unitDot = new THREE.SphereGeometry(1, 14, 10);
  const unitRing = new THREE.RingGeometry(0.62, 1, 28);
  const shared = new Set([unitDot, unitRing]);

  // ---- state -----------------------------------------------------------------
  let limbs = [];
  let hover = null;
  let active = null;
  let pins = [];
  let aim = null;
  let dirty = false;

  // ---- per-build records, sized in tick() -------------------------------------
  let dots = [];       // { mesh, pos: Vector3, px }
  let billboards = []; // { mesh, pos, px }   (rings that face the camera)
  let pinRecs = [];    // { head, stem, pos }
  let aimRoot = null;
  let dashRec = null;  // { line, a, b }
  let labelRec = null; // { mesh, a, b }
  const textureCache = new Map();

  function labelTexture(text) {
    const k = `${theme}|${text}`;
    let tex = textureCache.get(k);
    if (!tex) {
      tex = new THREE.CanvasTexture(paintLabel({ text, palette: DIM_THEME[theme] }));
      tex.colorSpace = THREE.SRGBColorSpace;
      textureCache.set(k, tex);
    }
    return tex;
  }

  function addDot(matKey, pos, px) {
    const mesh = new THREE.Mesh(unitDot, fillMats[matKey]);
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
  function addLine(matKey, flat, order = RENDER_ORDER_POSE) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(flat);
    const line = new LineSegments2(geo, lineMats[matKey]);
    line.renderOrder = order;
    line.frustumCulled = false;
    group.add(line);
    return line;
  }

  function disposeChildren() {
    for (const child of [...group.children]) {
      group.remove(child);
      // traverse: aim rings are nested under aimRoot, not direct children
      child.traverse((o) => {
        if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose?.();
        const m = o.material;
        if (m && !allMats().includes(m)) m.dispose?.();
      });
    }
    dots = []; billboards = []; pinRecs = []; aimRoot = null; dashRec = null; labelRec = null;
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

  function buildShownLimb(info, act) {
    const pts = orderedPoints(info);
    const grab = act?.grab ?? null;
    const clamped = act?.clamped ?? [];
    // skeleton
    addLine("bone", polyline(pts));
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
    // joint dots
    info.joints.forEach((j, i) => {
      const isGrab = grab === j.name;
      addDot(clamped[i] ? "warn" : isGrab ? "strong" : "handle", vec(pts[i]), JOINT_DOT_PX);
      if (isGrab) addBillboard(clamped[i] ? "warn" : "strong", vec(pts[i]), GRAB_HALO_PX);
    });
  }

  function rebuild() {
    dirty = false;
    if (!ensureAttached()) { dirty = true; return; }
    disposeChildren();
    const shown = active?.limb ?? hover;
    for (const info of limbs) {
      const isShown = info.name === shown;
      const isActive = active?.limb === info.name;
      if (isShown) buildShownLimb(info, isActive ? active : null);
      // tip dot: always
      const tip = vec(info.points.tip);
      const isGrab = isActive && active.grab === "tip";
      addDot(isGrab ? "strong" : "handle", tip, isShown ? TIP_DOT_ACTIVE_PX : TIP_DOT_PX);
      if (isGrab) addBillboard("strong", tip, GRAB_HALO_PX);
    }
    // reach miss: hollow target + dashed, labelled line
    const act = active && limbs.find((l) => l.name === active.limb);
    if (act && active.target && typeof active.residual === "number" && active.residual > RESIDUAL_MIN) {
      const a = vec(act.points.tip), b = vec(active.target);
      addBillboard("warn", b, TARGET_RING_PX);
      const line = addLine("dashed", [...a.toArray(), ...b.toArray()]);
      line.computeLineDistances();
      dashRec = { line, a, b };
      const tex = labelTexture(`${active.residual.toFixed(1)} mm`);
      const img = tex.image;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(img && img.height ? img.width / img.height : 4, 1),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
      );
      mesh.renderOrder = RENDER_ORDER_POSE_LABEL;
      mesh.frustumCulled = false;
      group.add(mesh);
      labelRec = { mesh, a, b };
    }
    // pin badges: a head floating above the pinned limb's tip, on a stem
    for (const id of pins) {
      const info = limbs.find((l) => l.name === String(id).split(".")[0]);
      if (!info) continue;
      const pos = vec(info.points.tip);
      const head = new THREE.Mesh(unitDot, fillMats.strong);
      head.renderOrder = RENDER_ORDER_POSE + 2;
      head.frustumCulled = false;
      group.add(head);
      const stem = addLine("strong", [0, 0, 0, 0, 0, 0], RENDER_ORDER_POSE + 1);
      pinRecs.push({ head, stem, pos });
    }
    // aim rings about the tool frame's axes: pitch, yaw, (roll only with 3 axes)
    if (aim?.at && Array.isArray(aim.axes) && aim.axes.length) {
      aimRoot = new THREE.Group();
      aimRoot.position.copy(vec(aim.at));
      const names = ["pitch", "yaw", "roll"];
      aim.axes.slice(0, 3).forEach((ax, i) => {
        const ref = Math.abs(ax[0]) < 0.9 * (len(ax) || 1) ? [1, 0, 0] : [0, 1, 0];
        const ring = limitArc([0, 0, 0], ax, ref, [0, 360], 1, 48);
        const line = addLine(names[i], polyline(ring));
        group.remove(line);
        aimRoot.add(line);
      });
      group.add(aimRoot);
    }
    sweepTextures();
    redraw();
  }

  function sweepTextures() {
    const live = labelRec ? new Set([`${theme}|${active.residual.toFixed(1)} mm`]) : new Set();
    for (const [k, tex] of textureCache) {
      if (live.has(k)) continue;
      tex.dispose();
      textureCache.delete(k);
    }
  }

  // ---- per-frame sizing ------------------------------------------------------
  const _wp = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _gq = new THREE.Quaternion();
  const _up = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  function tick() {
    if (dirty) rebuild();
    if (!attached || !group.children.length) return;
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
    _q.premultiply(_gq.clone().invert());
    for (const d of dots) d.mesh.scale.setScalar(Math.max(d.px * wppAt(d.pos), 1e-6));
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
    if (labelRec) {
      _b.copy(labelRec.a).add(labelRec.b).multiplyScalar(0.5);
      const wpp = wppAt(_b);
      labelRec.mesh.scale.setScalar(LABEL_SCREEN_PX * wpp);
      labelRec.mesh.position.copy(_b).addScaledVector(_up, LABEL_LIFT_PX * wpp);
      labelRec.mesh.quaternion.copy(_q);
    }
    if (aimRoot) aimRoot.scale.setScalar(AIM_RING_PX * wppAt(aimRoot.position));
  }

  // ---- public state setters --------------------------------------------------
  function setLimbs(infos) { limbs = Array.isArray(infos) ? infos : []; rebuild(); }
  function setHover(name) {
    const next = name ?? null;
    if (next === hover) return;
    hover = next;
    rebuild();
  }
  function setActive(a) { active = a ?? null; rebuild(); }
  function setPins(ids) { pins = Array.isArray(ids) ? [...ids] : []; rebuild(); }
  function setAimRings(a) { aim = a ?? null; rebuild(); }
  function clear() {
    limbs = []; hover = null; active = null; pins = []; aim = null;
    disposeChildren();
    sweepTextures();
    redraw();
  }

  function setTheme(mode) {
    if (!POSE_THEME[mode] || mode === theme) return;
    theme = mode;
    paintMats();
    rebuild(); // label textures are theme-keyed
  }

  function dispose() {
    redraw();
    disposeChildren();
    unregisterCapture();
    if (attached) group.parent?.remove(group);
    attached = false;
    for (const m of allMats()) m.dispose();
    unitDot.dispose();
    unitRing.dispose();
    for (const t of textureCache.values()) t.dispose();
    textureCache.clear();
  }

  return { setLimbs, setHover, setActive, setPins, setAimRings, clear, tick, setTheme, group, dispose };
}
