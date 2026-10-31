// Which gizmo handle is under the pointer: the nearest hit proxy the ray meets, or the
// gizmo's centre when the pointer is within a screen radius of it. Shared by the
// cutaway control and Pose mode's aim gizmo.
import * as THREE from "three";

/**
 * @param o.raycaster a Raycaster already set from the camera at the pointer.
 * @param o.proxies the hit proxies to raycast (visibility is not consulted).
 * @param o.handleOf (intersection) => the handle it names, or null.
 * @param o.pointer the pointer, `{ x, y }`, in the same screen space as `center`.
 * @param o.center the gizmo centre on screen `{ x, y }`, or null (behind the camera).
 * @param o.centerRadiusPx the centre's pick radius, px.
 * @param o.centerHandle the handle the centre picks.
 * @param o.centerFirst true: the centre wins over a proxy under it (a ring seen edge-on
 *   crosses the centre); false: proxies first, the centre only when none is hit.
 * @returns the picked handle, or null.
 */
export function pickGizmoHandle({
  raycaster,
  proxies,
  handleOf,
  pointer,
  center,
  centerRadiusPx,
  centerHandle,
  centerFirst = false,
}) {
  const atCenter = () => {
    if (!center) return false;
    const dx = pointer.x - center.x;
    const dy = pointer.y - center.y;
    return Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= centerRadiusPx;
  };
  if (centerFirst && atCenter()) return centerHandle;
  const intersection = raycaster.intersectObjects(proxies, false)[0];
  const handle = handleOf(intersection);
  if (handle) return handle;
  if (!centerFirst && atCenter()) return centerHandle;
  return null;
}

/** `point` (a Vector3, world) on the canvas: client px of `rect`, or null off the depth range. */
export function projectToRect(point, camera, rect) {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const projected = point.clone().project(camera);
  if (![projected.x, projected.y, projected.z].every(Number.isFinite)) return null;
  if (projected.z < -1 || projected.z > 1) return null;
  const client = new THREE.Vector2(
    rect.left + (projected.x + 1) * 0.5 * rect.width,
    rect.top + (1 - projected.y) * 0.5 * rect.height,
  );
  return Number.isFinite(client.x) && Number.isFinite(client.y) ? client : null;
}
