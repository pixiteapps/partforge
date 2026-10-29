// Measure mode's hover marker: draws exactly what a click would grab, and
// nothing more, for one SnapTarget (snaps.js):
//   face             -> the feature highlight (selection/feature-highlight.js)
//   edge / midpoint  -> the target's chain as a LineSegments2 in the strong dim ink
//   circle           -> the target's chain when it has one, else a 48-point rim
//                       loop built from target.circle { centre, axis, radius }
//                       (findSnap always sets it on a circle target)
//   corner / midpoint / circle / point -> a screen-constant dot at target.point
// plus a DOM label (class pf-measure-snap) in the stage, 12 px up-right of the
// projected point; its text is the caller's.
//
// Points are in the mesh's GEOMETRY frame and everything is parented under
// that mesh, so the pose fast path and animations carry the marker. Every 3D
// object is registered with registerCaptureHidden, like the highlight: pointer
// feedback never appears in a capture. setStart(point|null, mesh) keeps a
// second, persistent dot for a first click's start point, untouched by
// show/clear. show() with the same target (kind, point within 1e-6, mesh)
// does nothing, so a resting pointer costs nothing. Chains are read-only.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { createFeatureHighlight, HIGHLIGHT_COLOR } from "../selection/feature-highlight.js";
import {
  DIM_THEME, RENDER_ORDER_DIMS, RENDER_ORDER_LABELS, worldPerPx, orthoWorldPerPx,
} from "./dim3-scene.js";
import { runCleanupSteps } from "../teardown.js";

export const RIM_SEGMENTS = 48;
export const LABEL_OFFSET_PX = 12;
const DOT_PX = 4;      // core radius, CSS px
const HALO_PX = 6;     // halo radius, CSS px
const SAME_EPS = 1e-6;
const HALO = { dark: 0x080b10, light: 0xffffff };
const DOT_KINDS = new Set(["corner", "midpoint", "circle", "point"]);

function rimLoop({ centre, axis, radius }) {
  const ax = new THREE.Vector3(...axis).normalize();
  const helper = Math.abs(ax.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(ax, helper).normalize();
  const v = new THREE.Vector3().crossVectors(ax, u);
  const out = [];
  for (let i = 0; i < RIM_SEGMENTS; i++) {
    for (const k of [i, i + 1]) {
      const a = (2 * Math.PI * k) / RIM_SEGMENTS;
      const c = Math.cos(a) * radius, s = Math.sin(a) * radius;
      out.push(centre[0] + u.x * c + v.x * s, centre[1] + u.y * c + v.y * s, centre[2] + u.z * c + v.z * s);
    }
  }
  return out;
}

function chainSegments(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) out.push(...points[i - 1], ...points[i]);
  return out;
}

function sameTarget(a, meshA, b, meshB) {
  if (!a || !b || meshA !== meshB || a.kind !== b.kind || a.featureId !== b.featureId) return false;
  for (let i = 0; i < 3; i++) if (Math.abs(a.point[i] - b.point[i]) > SAME_EPS) return false;
  return true;
}

export function createSnapMarker(viewer, { stage = viewer.stageElement } = {}) {
  const redraw = () => viewer.requestRender?.();
  let theme = viewer.getTheme?.() ?? "dark";
  const highlight = createFeatureHighlight(viewer);

  // Overlay ink: drawn over the model, never depth-written, never cut away.
  const overlay = (m) => { m.depthTest = false; m.depthWrite = false; m.transparent = true; return m; };
  const lineMat = overlay(new LineMaterial({ color: DIM_THEME[theme].strong, linewidth: 2.5 }));
  const coreMat = overlay(new THREE.MeshBasicMaterial({ color: HIGHLIGHT_COLOR }));
  const haloMat = overlay(new THREE.MeshBasicMaterial({ color: HALO[theme] ?? HALO.dark }));
  const unitSphere = new THREE.SphereGeometry(1, 16, 8);

  function makeDot(name) {
    const dot = new THREE.Group();
    dot.name = name;
    const halo = new THREE.Mesh(unitSphere, haloMat);
    halo.scale.setScalar(HALO_PX / DOT_PX);
    halo.renderOrder = RENDER_ORDER_LABELS;
    const core = new THREE.Mesh(unitSphere, coreMat);
    core.renderOrder = RENDER_ORDER_LABELS + 1;
    for (const m of [halo, core]) { m.frustumCulled = false; dot.add(m); }
    return dot;
  }

  // One group per mark, each parented to whichever mesh it currently marks.
  const marks = new THREE.Group();
  marks.name = "pf-measure-snap";
  marks.visible = false;
  const lineGeo = new LineSegmentsGeometry();
  const line = new LineSegments2(lineGeo, lineMat);
  line.renderOrder = RENDER_ORDER_DIMS;
  line.frustumCulled = false;
  line.visible = false;
  const dot = makeDot("pf-measure-snap-dot");
  dot.visible = false;
  marks.add(line, dot);

  const start = new THREE.Group();
  start.name = "pf-measure-start";
  start.visible = false;
  const startDot = makeDot("pf-measure-start-dot");
  start.add(startDot);

  const unregisterCapture = [
    viewer.registerCaptureHidden?.(marks) ?? (() => {}),
    viewer.registerCaptureHidden?.(start) ?? (() => {}),
  ];

  const label = document.createElement("div");
  label.className = "pf-measure-snap";
  label.hidden = true;
  stage?.appendChild(label);

  const reparent = (obj, mesh) => { if (obj.parent !== mesh) mesh.add(obj); };

  let last = null, lastMesh = null;

  // Screen-constant dot radius at its own world position, in the mesh's local units.
  const _wp = new THREE.Vector3();
  const _ws = new THREE.Vector3();
  function sizeDot(d) {
    const cam = viewer.camera;
    const h = viewer.domElement?.clientHeight || 1;
    d.getWorldPosition(_wp);
    const wpp = cam.isOrthographicCamera
      ? orthoWorldPerPx(cam.top, cam.bottom, cam.zoom, h)
      : worldPerPx(cam.position.distanceTo(_wp), cam.fov ?? 45, h);
    d.parent?.getWorldScale(_ws);
    const s = (_ws?.x || 1);
    if (wpp > 0) d.scale.setScalar((DOT_PX * wpp) / s);
  }

  const _p = new THREE.Vector3();
  function placeLabel() {
    if (!last || !lastMesh || !stage) return;
    const dom = viewer.domElement.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    lastMesh.updateWorldMatrix(true, false);
    _p.set(...last.point).applyMatrix4(lastMesh.matrixWorld).project(viewer.camera);
    if (_p.z > 1 || _p.z < -1) { label.hidden = true; return; }
    const x = dom.left - st.left + ((_p.x + 1) / 2) * dom.width;
    const y = dom.top - st.top + ((1 - _p.y) / 2) * dom.height;
    label.style.left = `${x + LABEL_OFFSET_PX}px`;
    label.style.top = `${y - LABEL_OFFSET_PX}px`;
    label.hidden = false;
  }

  function tick() {
    const el = viewer.domElement;
    lineMat.resolution.set(el?.clientWidth || 1, el?.clientHeight || 1);
    if (marks.visible && dot.visible) sizeDot(dot);
    if (start.visible) sizeDot(startDot);
    if (marks.visible || !label.hidden) placeLabel();
  }
  const offFrame = viewer.onFrame?.(tick) ?? (() => {});

  const offTheme = viewer.onThemeChange?.((mode) => {
    if (!DIM_THEME[mode] || mode === theme) return;
    theme = mode;
    lineMat.color.set(DIM_THEME[theme].strong);
    haloMat.color.set(HALO[theme] ?? HALO.dark);
    redraw();
  }) ?? (() => {});

  function show(target, mesh, text) {
    if (!target || !mesh) { clear(); return; }
    if (sameTarget(target, mesh, last, lastMesh)) {
      if (label.textContent !== text) label.textContent = text ?? "";
      return;
    }
    last = target;
    lastMesh = mesh;
    redraw();

    if (target.kind === "face" && target.featureId > 0) {
      highlight.show({ mesh, subPart: mesh, feature: { id: target.featureId } });
    } else {
      highlight.clear();
    }

    let segs = null;
    if ((target.kind === "edge" || target.kind === "midpoint" || target.kind === "circle") && target.chain) {
      segs = chainSegments(target.chain.points);
    } else if (target.kind === "circle" && target.circle) {
      segs = rimLoop(target.circle);
    }
    if (segs) {
      lineGeo.setPositions(segs);
      line.visible = true;
    } else {
      line.visible = false;
    }

    dot.visible = DOT_KINDS.has(target.kind);
    if (dot.visible) dot.position.set(...target.point);

    reparent(marks, mesh);
    marks.visible = true;
    label.textContent = text ?? "";
    tick();
  }

  function clear() {
    if (!last && !marks.visible && label.hidden) return;
    last = null;
    lastMesh = null;
    marks.visible = false;
    label.hidden = true;
    highlight.clear();
    redraw();
  }

  function setStart(point, mesh) {
    redraw();
    if (!point || !mesh) { start.visible = false; return; }
    startDot.position.set(...point);
    reparent(start, mesh);
    start.visible = true;
    sizeDot(startDot);
  }

  function dispose() {
    runCleanupSteps([
      offFrame,
      offTheme,
      () => highlight.dispose(),
      () => marks.parent?.remove(marks),
      () => start.parent?.remove(start),
      ...unregisterCapture,
      () => label.remove(),
      () => lineGeo.dispose(),
      () => unitSphere.dispose(),
      () => lineMat.dispose(),
      () => coreMat.dispose(),
      () => haloMat.dispose(),
      redraw,
    ], "snap marker cleanup failed");
  }

  return { show, clear, setStart, dispose };
}
