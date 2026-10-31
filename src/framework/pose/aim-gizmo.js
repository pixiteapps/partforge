// Pose mode's aim gizmo: the widget on a goal handle that declares `aim` — a centre
// ball on the tool point and a rotate ring per aim parameter (pitch red, yaw blue,
// roll green; roll only with three aim parameters). Built from the cutaway control's
// shared gizmo code (../gizmo/): the same palette, the same normal/hovered geometry
// pairs and hover rule (a hovered part lifts toward white, thickens and draws at full
// opacity — steady styling, never a blink), and the same proxy/centre picking.
//
// This module draws and picks; pose-mode.js decides when it shows and what a drag does
// (the ball drags the tool point, a ring writes its aim angle through the shared
// rotate-drag math). Like pose-scene.js it lives under the sub-meshes' shared parent
// (PART coordinates), is hidden from canonical captures, draws over the model
// (depthTest off) and keeps a constant on-screen size: one local unit is one CSS px.
import * as THREE from "three";
import {
  GIZMO_PALETTE,
  applyHandleAppearance,
  handleMaterial,
  hitMaterial,
  hoverGeometryPair,
} from "../gizmo/gizmo-handles.js";
import { pickGizmoHandle } from "../gizmo/gizmo-pick.js";
import { worldPerPx, orthoWorldPerPx } from "../measure/dim3-scene.js";
import { RENDER_ORDER_POSE } from "./pose-scene.js";

/** The rings' radius, CSS px. */
export const AIM_RING_PX = 36;
/** A ring's tube radius, CSS px (hovered: x HANDLE_HOVER_THICKNESS). */
export const AIM_RING_TUBE_PX = 1.25;
/** A ring's hit proxy tube radius: a 24 CSS px band seen from any side. */
export const AIM_RING_HIT_PX = 12;
/** The centre ball's radius, CSS px (hovered: x HANDLE_HOVER_THICKNESS). */
export const AIM_BALL_PX = 6;
/** The centre ball's pick radius for a mouse: a 28 CSS px target. */
export const AIM_BALL_HIT_PX = 14;
/** ...and for a finger. */
export const AIM_BALL_TOUCH_HIT_PX = 24;

/** The gizmo's parts, in aim-parameter order after the ball. */
export const AIM_GIZMO_PARTS = ["ball", "pitch", "yaw", "roll"];
const RINGS = ["pitch", "yaw", "roll"];
const PALETTE_KEY = { ball: "fill", pitch: "red", yaw: "blue", roll: "green" };
const Z = new THREE.Vector3(0, 0, 1);

/**
 * @param viewer camera, domElement, projectPoint, _subMeshes, requestRender,
 *   registerCanonicalCaptureHidden, getTheme.
 */
export function createAimGizmo(viewer) {
  const redraw = () => viewer.requestRender?.();
  const group = new THREE.Group();
  group.name = "pf-pose-aim-gizmo";
  group.visible = false;
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

  let theme = GIZMO_PALETTE[viewer.getTheme?.()] ? viewer.getTheme() : "dark";
  const geometries = new Set();
  const materials = new Set();
  const own = (g) => { geometries.add(g); return g; };
  const overlay = { depthTest: false, depthWrite: false };

  // ---- the parts -------------------------------------------------------------
  const appearance = {};
  const ringRoots = {};
  const proxies = {};

  const ballPair = hoverGeometryPair((k) => new THREE.SphereGeometry(AIM_BALL_PX * k, 18, 12));
  own(ballPair.normal); own(ballPair.hovered);
  const ballMaterial = handleMaterial(GIZMO_PALETTE[theme].fill, overlay);
  materials.add(ballMaterial);
  const ball = new THREE.Mesh(ballPair.normal, ballMaterial);
  ball.renderOrder = RENDER_ORDER_POSE + 4; // over the rings it sits inside
  ball.frustumCulled = false;
  group.add(ball);
  appearance.ball = { visual: ball, material: ballMaterial, geometryPairs: [{ mesh: ball, ...ballPair }] };

  const proxyMaterial = hitMaterial();
  materials.add(proxyMaterial);
  for (const name of RINGS) {
    // a full ring in the root's XY plane: the root turns its +Z onto the axis
    const pair = hoverGeometryPair((k) => new THREE.TorusGeometry(AIM_RING_PX, AIM_RING_TUBE_PX * k, 8, 96));
    own(pair.normal); own(pair.hovered);
    const material = handleMaterial(GIZMO_PALETTE[theme][PALETTE_KEY[name]], overlay);
    materials.add(material);
    const ring = new THREE.Mesh(pair.normal, material);
    ring.renderOrder = RENDER_ORDER_POSE + 3;
    ring.frustumCulled = false;
    const proxy = new THREE.Mesh(own(new THREE.TorusGeometry(AIM_RING_PX, AIM_RING_HIT_PX, 8, 48)), proxyMaterial);
    proxy.visible = false; // raycast only (the raycaster does not consult visibility)
    proxy.userData.aimPart = name;
    const root = new THREE.Group();
    root.add(ring, proxy);
    group.add(root);
    ringRoots[name] = root;
    proxies[name] = proxy;
    appearance[name] = { visual: ring, material, geometryPairs: [{ mesh: ring, ...pair }] };
  }

  // ---- state -----------------------------------------------------------------
  let shown = null;   // { at: [x, y, z], axes: [[x, y, z], ...] } in part coordinates
  let hovered = null; // one of AIM_GIZMO_PARTS, or null

  function updateAppearance() {
    const P = GIZMO_PALETTE[theme];
    for (const name of AIM_GIZMO_PARTS) {
      applyHandleAppearance(appearance[name], { color: P[PALETTE_KEY[name]], hovered: name === hovered });
    }
  }
  updateAppearance();

  /** Place the parts at `target` (the shown pose, or a candidate a pick tries). */
  function place(target) {
    group.position.set(target.at[0], target.at[1], target.at[2]);
    RINGS.forEach((name, i) => {
      const axis = target.axes[i];
      const root = ringRoots[name];
      root.visible = Array.isArray(axis);
      if (root.visible) root.quaternion.setFromUnitVectors(Z, new THREE.Vector3(...axis).normalize());
    });
    sizeForCamera();
  }

  const _wp = new THREE.Vector3();
  /** One local unit = one CSS px at the centre. */
  function sizeForCamera() {
    if (!attached) return;
    const cam = viewer.camera;
    const h = viewer.domElement?.clientHeight || 1;
    let wpp;
    if (cam.isOrthographicCamera) wpp = orthoWorldPerPx(cam.top, cam.bottom, cam.zoom, h);
    else {
      group.parent.updateWorldMatrix(true, false);
      _wp.copy(group.position).applyMatrix4(group.parent.matrixWorld);
      wpp = worldPerPx(cam.position.distanceTo(_wp), cam.fov ?? 45, h);
    }
    group.scale.setScalar(Math.max(wpp, 1e-9));
  }

  /** Show the gizmo at `{ at, axes }` (part coordinates), or hide it with null. */
  function show(target) {
    const next = target && Array.isArray(target.at) && Array.isArray(target.axes) && target.axes.length ? target : null;
    if (!next) {
      if (!shown && !group.visible) return;
      shown = null;
      group.visible = false;
      setHovered(null);
      redraw();
      return;
    }
    if (!ensureAttached()) { shown = next; return; }
    shown = next;
    place(shown);
    group.visible = true;
    redraw();
  }

  function setHovered(part) {
    const next = AIM_GIZMO_PARTS.includes(part) && (part === "ball" || shown?.axes?.[RINGS.indexOf(part)]) ? part : null;
    if (next === hovered) return;
    hovered = next;
    updateAppearance();
    redraw();
  }

  /** The part's centre, CSS px from the canvas's top-left, or null. */
  function centerOnScreen(target) {
    group.parent.updateWorldMatrix(true, false);
    const w = new THREE.Vector3(...target.at).applyMatrix4(group.parent.matrixWorld);
    const s = viewer.projectPoint(w.toArray());
    return s && Number.isFinite(s.x) && Number.isFinite(s.y) && s.visible !== false ? s : null;
  }

  const raycaster = new THREE.Raycaster();
  /**
   * The gizmo part under the canvas point (x, y) (CSS px from its top-left; w, h the
   * canvas size) for the gizmo placed at `target` (default: the one shown), or null.
   * The ball wins inside its radius — a ring seen edge-on crosses it — then the rings'
   * proxies. Leaves the shown gizmo where it was.
   */
  function pick({ x, y, w, h }, { target = shown, touch = false } = {}) {
    if (!target || !(w > 0) || !(h > 0) || !ensureAttached()) return null;
    place(target);
    group.updateWorldMatrix(true, true);
    const cam = viewer.camera;
    cam.updateMatrixWorld?.();
    raycaster.setFromCamera({ x: (x / w) * 2 - 1, y: -(y / h) * 2 + 1 }, cam);
    const part = pickGizmoHandle({
      raycaster,
      proxies: RINGS.filter((n) => ringRoots[n].visible).map((n) => proxies[n]),
      handleOf: (hit) => hit?.object?.userData?.aimPart ?? null,
      pointer: { x, y },
      center: centerOnScreen(target),
      centerRadiusPx: touch ? AIM_BALL_TOUCH_HIT_PX : AIM_BALL_HIT_PX,
      centerHandle: "ball",
      centerFirst: true,
    });
    if (shown && shown !== target) place(shown);
    return part;
  }

  /** Re-size for the camera (once per frame, from pose mode's frame hook). */
  function tick() {
    if (!shown) return;
    if (!group.visible) {
      // shown before the parts existed: place it now they do
      if (!ensureAttached()) return;
      place(shown);
      group.visible = true;
      redraw();
      return;
    }
    sizeForCamera();
  }

  function setTheme(mode) {
    if (!GIZMO_PALETTE[mode] || mode === theme) return;
    theme = mode;
    updateAppearance();
    redraw();
  }

  function dispose() {
    redraw();
    unregisterCapture();
    if (attached) group.parent?.remove(group);
    attached = false;
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
  }

  return {
    show,
    setHovered,
    pick,
    tick,
    setTheme,
    dispose,
    group,
    /** For tests and the browser check: what is shown and hovered, and each part's mesh. */
    get state() {
      return {
        visible: group.visible && !!shown,
        at: shown?.at ?? null,
        axes: shown?.axes ?? null,
        hovered,
        parts: Object.fromEntries(AIM_GIZMO_PARTS.map((n) => [n, {
          mesh: appearance[n].visual,
          material: appearance[n].material,
          shown: n === "ball" ? group.visible : group.visible && ringRoots[n].visible,
          thick: appearance[n].visual.geometry === appearance[n].geometryPairs[0].hovered,
        }])),
      };
    },
  };
}
