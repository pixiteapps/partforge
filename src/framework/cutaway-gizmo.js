import * as THREE from "three";
import { snapQuaternionToAxis } from "./cutaway-math.js";
import { buildGizmoScene } from "./cutaway-gizmo-scene.js";
import { GIZMO_PALETTE, applyHandleAppearance } from "./gizmo/gizmo-handles.js";
import { pickGizmoHandle, projectToRect } from "./gizmo/gizmo-pick.js";
import {
  axisParameterFromRay,
  beginRotateDrag as beginSharedRotateDrag,
  rotateDragAngle,
} from "./gizmo/gizmo-rotate.js";

// The single source of truth for gizmo colors: the scene is constructed from
// `dark` and `updateAppearance` re-derives from whichever mode is active, so a
// palette edit here reaches the first frame as well as every later one.
// The colours themselves come from the shared gizmo palette (gizmo/gizmo-handles.js):
// the translate arrow is its green, the X ring its red, the Y ring its blue.
const cutawayTheme = (p) => ({
  fill: p.fill,
  border: p.border,
  translate: p.green,
  rotateX: p.red,
  rotateY: p.blue,
});
const THEMES = {
  dark: cutawayTheme(GIZMO_PALETTE.dark),
  light: cutawayTheme(GIZMO_PALETTE.light),
};

export { THEMES as CUTAWAY_GIZMO_THEMES };

const TRANSLATION_SCREEN_ALIGNMENT = 0.9;
// Reserve the visually shared center for the end-on translation handle.
const TRANSLATE_CENTER_RADIUS_PX = 22;
const GHOST_OFFSET_FACTOR = 0.001;
const MIN_GHOST_OFFSET = 0.01;
const MAX_GHOST_OFFSET = 0.25;

export function createCutawayGizmo({
  scene,
  overlayScene,
  camera: initialCamera,
  domElement,
  orbitControls,
  onPoseChange = () => {},
  onActivity = () => {},
  onHandleHoverChange = () => {},
  onDragChange = () => {},
  pickHandle,
}) {
  // Reassignable: the viewer swaps cameras when the projection changes (a view
  // cube face view settling into ortho, a rotation leaving it),
  // and this module holds fifteen references to it. One binding to move beats
  // threading a getter through all of them.
  let camera = initialCamera;
  const sceneGraph = buildGizmoScene(THEMES.dark);
  const {
    group,
    fill,
    border,
    handleRoot,
    arcRoot,
    handles,
    handleVisuals,
    handleAppearance,
  } = sceneGraph;
  scene.add(group);
  overlayScene.add(handleRoot);

  let disposed = false;
  let poseSize = 1;
  let flipped = false;
  let drag = null;
  let hoveredHandle = null;
  let activeAppearance = true;
  let themeMode = "dark";
  const raycaster = new THREE.Raycaster();
  const _snapped = new THREE.Quaternion();
  const hitProxies = Object.values(handles);

  function rayFromEvent(event) {
    const rect = domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    raycaster.setFromCamera({
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    }, camera);
    return raycaster.ray;
  }

  function normalizeHandle(handle) {
    return handle === "translate" || handle === "rotate-x" || handle === "rotate-y"
      ? handle
      : null;
  }

  function resolveHandle(picked) {
    if (typeof picked === "string") return normalizeHandle(picked);
    const object = picked?.object ?? picked;
    return normalizeHandle(object?.userData?.cutawayHandle);
  }

  function pick(event, ray) {
    if (pickHandle) return resolveHandle(pickHandle(event, handles, ray));
    handleRoot.updateWorldMatrix(true, true);
    // Proxies first; the centre only when no proxy is under the pointer.
    return pickGizmoHandle({
      raycaster,
      proxies: hitProxies,
      handleOf: resolveHandle,
      pointer: { x: event.clientX, y: event.clientY },
      get center() { return projectToClient(group.position); },
      centerRadiusPx: TRANSLATE_CENTER_RADIUS_PX,
      centerHandle: "translate",
    });
  }

  function safeCapture(pointerId) {
    try {
      domElement.setPointerCapture?.(pointerId);
    } catch {
      // Capture can fail when the browser has already ended the pointer.
    }
  }

  function safeRelease(pointerId) {
    try {
      domElement.releasePointerCapture?.(pointerId);
    } catch {
      // Releasing a pointer that was already lost is harmless.
    }
  }

  function endDrag() {
    if (!drag) return;
    const ending = drag;
    drag = null;
    if (orbitControls) orbitControls.enabled = ending.orbitEnabled;
    safeRelease(ending.pointerId);
    onDragChange(false);
  }

  function updateAppearance() {
    const theme = THEMES[themeMode] ?? THEMES.dark;
    fill.material.color.set(theme.fill);
    fill.material.opacity = activeAppearance ? 0.18 : 0.055;
    border.material.color.set(theme.border);
    border.material.opacity = activeAppearance ? 1 : 0.72;

    for (const [handle, entry] of Object.entries(handleAppearance)) {
      const themeKey = handle === "rotate-x"
        ? "rotateX"
        : handle === "rotate-y"
          ? "rotateY"
          : "translate";
      applyHandleAppearance(entry, {
        color: theme[themeKey],
        hovered: handle === hoveredHandle,
        idleOpacity: activeAppearance ? 1 : 0.48,
      });
    }
  }

  function setHoveredHandle(handle) {
    const normalized = normalizeHandle(handle);
    if (normalized === hoveredHandle) return;
    hoveredHandle = normalized;
    updateAppearance();
    onHandleHoverChange(normalized);
  }

  // Rotation lands on a canonical axis when it gets close to one. Shift is read
  // per move rather than latched at pointer-down, so it can be pressed and
  // released mid-drag; it is unbound during a gizmo drag because orbit controls
  // are already disabled.
  function snapRotation(candidate, event) {
    candidate.normalize();
    return event.shiftKey ? candidate : snapQuaternionToAxis(candidate, undefined, _snapped);
  }

  function notifyPose() {
    onPoseChange({
      position: group.position.clone(),
      quaternion: group.quaternion.clone(),
      size: poseSize,
    });
  }

  function syncHandleTransform() {
    handleRoot.position.copy(group.position);
    handleRoot.quaternion.copy(group.quaternion);
  }

  function viewDirectionAt(position) {
    if (camera.isPerspectiveCamera) {
      const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
      const direction = position.clone().sub(cameraPosition);
      if (direction.lengthSq() > 1e-12) return direction.normalize();
    }
    return camera.getWorldDirection(new THREE.Vector3()).normalize();
  }

  // |axis . view|: 1 when we are staring straight down the axis, 0 when the
  // axis lies flat in the screen plane. Both drag families branch on it.
  function axisViewAlignment(position, axis) {
    return Math.abs(axis.dot(viewDirectionAt(position)));
  }

  function projectToClient(point) {
    return projectToRect(point, camera, domElement.getBoundingClientRect());
  }

  // The fields every drag carries, before the mode-specific ones are filled in
  // by beginTranslateDrag / beginRotateDrag.
  function baseDrag(event, handle) {
    const startPosition = group.position.clone();
    const startQuaternion = group.quaternion.clone();
    const localAxis = handle === "rotate-x"
      ? new THREE.Vector3(1, 0, 0)
      : handle === "rotate-y"
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
    return {
      pointerId: event.pointerId,
      handle,
      orbitEnabled: orbitControls?.enabled,
      startPosition,
      startQuaternion,
      startClientX: event.clientX,
      startClientY: event.clientY,
      unitsPerPixel: worldUnitsPerPixelAt(startPosition),
      axis: localAxis.applyQuaternion(startQuaternion).normalize(),
      mode: null,
      startParameter: null,
      rotationPlane: null,
      startRadial: null,
      screenRotationDirection: null,
    };
  }

  // Sliding along the plane normal. Pointing the normal at the camera leaves
  // the axis almost no screen travel to slide along - and the ray may miss it
  // outright - so vertical pointer motion drives the offset instead.
  function beginTranslateDrag(record, ray) {
    const alignment = axisViewAlignment(record.startPosition, record.axis);
    record.startParameter = axisParameterFromRay(ray, record.startPosition, record.axis);
    record.mode = alignment > TRANSLATION_SCREEN_ALIGNMENT
      || record.startParameter == null
      ? "screen-translate"
      : "axis-translate";
    return record;
  }

  // Spinning about a ring axis: the shared rotate drag (gizmo/gizmo-rotate.js)
  // resolves against the rotation plane when we look down the axis and falls back
  // to pointer travel perpendicular to the on-screen axis when edge-on. Returns
  // null when neither route is usable, which aborts the press.
  function beginRotateDrag(record, ray) {
    const rotate = beginSharedRotateDrag({
      ray,
      center: record.startPosition,
      axis: record.axis,
      alignment: axisViewAlignment(record.startPosition, record.axis),
      projectToClient,
    });
    return rotate ? Object.assign(record, rotate) : null;
  }

  function onPointerDown(event) {
    if (disposed || drag || !group.visible || (event.button != null && event.button !== 0)) return;
    const ray = rayFromEvent(event);
    if (!ray) return;
    const handle = pick(event, ray);
    if (!handle) return;

    const record = baseDrag(event, handle);
    const nextDrag = handle === "translate"
      ? beginTranslateDrag(record, ray)
      : beginRotateDrag(record, ray);
    if (!nextDrag) return;

    setHoveredHandle(handle);
    onActivity();
    drag = nextDrag;
    onDragChange(true);
    if (orbitControls) orbitControls.enabled = false;
    safeCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!disposed && group.visible) onActivity();
    if (!drag) {
      if (disposed || !group.visible || event.pointerType === "touch") return;
      const ray = rayFromEvent(event);
      if (!ray) return;
      setHoveredHandle(pick(event, ray));
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    const ray = rayFromEvent(event);
    if (!ray) return;

    if (drag.handle === "translate") {
      let delta;
      if (drag.mode === "screen-translate") {
        delta = (drag.startClientY - event.clientY) * drag.unitsPerPixel;
      } else {
        const parameter = axisParameterFromRay(ray, drag.startPosition, drag.axis);
        if (parameter == null) return;
        delta = parameter - drag.startParameter;
      }
      if (!Number.isFinite(delta)) return;
      group.position.copy(drag.startPosition).addScaledVector(drag.axis, delta);
      group.quaternion.copy(drag.startQuaternion);
      syncHandleTransform();
      notifyPose();
      return;
    }

    const angle = rotateDragAngle(drag, {
      ray,
      center: drag.startPosition,
      axis: drag.axis,
      pointerDelta: new THREE.Vector2(
        event.clientX - drag.startClientX,
        event.clientY - drag.startClientY,
      ),
    });
    if (angle == null) return;
    const delta = new THREE.Quaternion().setFromAxisAngle(drag.axis, angle);
    group.quaternion.copy(snapRotation(delta.multiply(drag.startQuaternion), event));
    group.position.copy(drag.startPosition);
    syncHandleTransform();
    notifyPose();
  }

  function onPointerUp(event) {
    if (!drag || (event.pointerId != null && event.pointerId !== drag.pointerId)) return;
    endDrag();
  }

  function onPointerCancel(event) {
    if (drag && event.pointerId != null && event.pointerId !== drag.pointerId) return;
    endDrag();
    setHoveredHandle(null);
  }

  function onLostPointerCapture(event) {
    if (!drag || (event.pointerId != null && event.pointerId !== drag.pointerId)) return;
    endDrag();
    setHoveredHandle(null);
  }

  function onPointerLeave(event) {
    if (drag && event.pointerId != null && event.pointerId !== drag.pointerId) return;
    endDrag();
    setHoveredHandle(null);
  }

  function onWindowBlur() {
    endDrag();
    setHoveredHandle(null);
  }

  function onPassiveActivity() {
    if (!disposed && group.visible) onActivity();
  }

  const listeners = [
    [domElement, "pointerdown", onPointerDown, { capture: true }],
    [domElement, "pointermove", onPointerMove],
    [domElement, "pointerenter", onPassiveActivity],
    [domElement, "focus", onPassiveActivity],
    [domElement, "pointerup", onPointerUp],
    [domElement, "pointercancel", onPointerCancel],
    [domElement, "lostpointercapture", onLostPointerCapture],
    [domElement, "pointerleave", onPointerLeave],
    [window, "blur", onWindowBlur],
  ];
  for (const [target, type, listener, options] of listeners) {
    target.addEventListener(type, listener, options);
  }

  function setPose({ position, quaternion, size }) {
    group.position.copy(position);
    group.quaternion.copy(quaternion);
    syncHandleTransform();
    poseSize = size;
    fill.scale.setScalar(size);
    border.scale.setScalar(size);
    handleRoot.scale.setScalar(size * 0.15);
    updateEmptySideVisuals();
  }

  function updateEmptySideVisuals() {
    const emptySideSign = flipped ? 1 : -1;
    const ghostOffset = THREE.MathUtils.clamp(
      poseSize * GHOST_OFFSET_FACTOR,
      MIN_GHOST_OFFSET,
      MAX_GHOST_OFFSET,
    );
    fill.position.z = emptySideSign * ghostOffset;
    border.position.z = emptySideSign * ghostOffset;
    arcRoot.rotation.x = flipped ? Math.PI : 0;
  }

  function setFlipped(nextFlipped) {
    flipped = Boolean(nextFlipped);
    updateEmptySideVisuals();
  }

  function setVisible(on) {
    if (!on) {
      endDrag();
      setHoveredHandle(null);
    }
    group.visible = Boolean(on);
    handleRoot.visible = Boolean(on);
  }

  function setActiveAppearance(active) {
    activeAppearance = Boolean(active);
    updateAppearance();
  }

  function setTheme(mode) {
    themeMode = THEMES[mode] ? mode : "dark";
    updateAppearance();
  }

  function worldUnitsPerPixelAt(position) {
    const height = Math.max(domElement.getBoundingClientRect().height, 1);
    if (camera.isOrthographicCamera) {
      return Math.abs(camera.top - camera.bottom) / Math.max(camera.zoom, 1e-6) / height;
    }
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const depth = Math.max(
      Math.abs(position.clone().sub(cameraPosition).dot(forward)),
      camera.near || 1e-3,
    );
    const effectiveFov = camera.getEffectiveFOV();
    return 2 * depth
      * Math.tan(THREE.MathUtils.degToRad(effectiveFov) / 2)
      / height;
  }

  function updateForCamera() {
    if (disposed) return;
    const screenScale = worldUnitsPerPixelAt(group.position) * 72;
    handleRoot.scale.setScalar(THREE.MathUtils.clamp(
      screenScale,
      poseSize * 0.06,
      poseSize * 0.55,
    ));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      endDrag();
      setHoveredHandle(null);
    } finally {
      for (const [target, type, listener, options] of listeners) {
        target.removeEventListener(type, listener, options);
      }
      scene.remove(group);
      overlayScene.remove(handleRoot);
      sceneGraph.dispose();
    }
  }

  return {
    group,
    fill,
    border,
    handles,
    handleVisuals,
    handleRoot,
    setPose,
    setFlipped,
    setVisible,
    setActiveAppearance,
    setTheme,
    updateForCamera,
    setCamera(next) { if (next) camera = next; },
    dispose,
  };
}
