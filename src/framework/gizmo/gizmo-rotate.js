// The rotate-drag math a gizmo ring uses: turn the pointer into an angle about the
// ring's axis. Looking down the axis, the ray meets the ring's plane and the angle is
// the turn of the radial from the centre. Edge-on, that plane is nearly parallel to
// the view and the intersection is useless, so the angle comes from pointer travel
// perpendicular to the axis's on-screen direction instead. Shared by the cutaway
// control and Pose mode's aim gizmo; pure three.js math, no DOM.
import * as THREE from "three";

const PARALLEL_EPSILON = 1e-6;
const SCREEN_AXIS_EPSILON_SQ = 1e-8;

/** Below this |axis . view| the ring is edge-on and the screen fallback turns it. */
export const ROTATION_SCREEN_ALIGNMENT = 0.15;
/** Screen fallback: a 120 px perpendicular drag turns 90 degrees. */
export const SCREEN_ROTATION_RADIANS_PER_PIXEL = Math.PI / 240;

/** Where along the axis line the ray passes closest, or null when they are parallel. */
export function axisParameterFromRay(ray, axisOrigin, axisDirection) {
  const axis = axisDirection.clone().normalize();
  const w0 = ray.origin.clone().sub(axisOrigin);
  const b = ray.direction.dot(axis);
  const d = ray.direction.dot(w0);
  const e = axis.dot(w0);
  const denominator = 1 - b * b;

  if (Math.abs(denominator) < PARALLEL_EPSILON) return null;
  return (e - b * d) / denominator;
}

/** The signed angle (radians) turning `from` onto `to` about `axis`. */
export function signedAngleAroundAxis(from, to, axis) {
  const fromDirection = from.clone().normalize();
  const toDirection = to.clone().normalize();
  return Math.atan2(
    axis.dot(fromDirection.clone().cross(toDirection)),
    fromDirection.dot(toDirection),
  );
}

/**
 * The screen direction pointer travel must take to turn positively about `axis`: the
 * axis's on-screen direction turned a quarter, as a unit Vector2. `projectToClient`
 * maps a Vector3 to the pointer's screen space (or null). Null when the axis has no
 * on-screen direction.
 */
export function screenRotationDirection(center, axis, projectToClient) {
  const centerClient = projectToClient(center);
  const axisClient = projectToClient(center.clone().add(axis));
  if (!centerClient || !axisClient) return null;
  const screenAxis = axisClient.sub(centerClient);
  if (screenAxis.lengthSq() < SCREEN_AXIS_EPSILON_SQ) return null;
  screenAxis.normalize();
  return new THREE.Vector2(-screenAxis.y, screenAxis.x);
}

/**
 * Start a rotate drag about `axis` (unit Vector3) through `center` (Vector3), from the
 * press's `ray`. `alignment` is |axis . view direction| at the centre.
 * Returns `{ mode: "plane-rotate", rotationPlane, startRadial }` or
 * `{ mode: "screen-rotate", screenRotationDirection }`, or null when neither route
 * works (which aborts the press).
 */
export function beginRotateDrag({ ray, center, axis, alignment, projectToClient }) {
  if (alignment >= ROTATION_SCREEN_ALIGNMENT) {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, center);
    const point = ray.intersectPlane(plane, new THREE.Vector3());
    const radial = point?.sub(center);
    if (radial && radial.lengthSq() >= 1e-12) {
      const startRadial = radial.normalize();
      return {
        mode: "plane-rotate",
        rotationPlane: plane,
        startRadial,
        lastRadial: startRadial.clone(),
        turned: 0,
        screenRotationDirection: null,
      };
    }
  }
  const direction = screenRotationDirection(center, axis, projectToClient);
  if (!direction) return null;
  return {
    mode: "screen-rotate",
    rotationPlane: null,
    startRadial: null,
    screenRotationDirection: direction,
  };
}

/**
 * The drag's angle (radians) since the press, about `axis` through `center`, or null
 * for a frame to skip. `pointerDelta` (Vector2) is the pointer's travel since the
 * press, for the screen route. With `unwrap`, the plane route accumulates each step so
 * a turn past ±180 keeps counting; without it, the angle is from the press radial
 * (-180..180), which is all a quaternion needs.
 */
export function rotateDragAngle(drag, { ray, center, axis, pointerDelta, unwrap = false }) {
  if (drag.mode === "screen-rotate") {
    const angle = pointerDelta.dot(drag.screenRotationDirection) * SCREEN_ROTATION_RADIANS_PER_PIXEL;
    return Number.isFinite(angle) ? angle : null;
  }
  const point = ray.intersectPlane(drag.rotationPlane, new THREE.Vector3());
  if (!point) return null;
  const radial = point.sub(center);
  if (radial.lengthSq() < 1e-12) return null;
  radial.normalize();
  if (!unwrap) {
    const angle = signedAngleAroundAxis(drag.startRadial, radial, axis);
    return Number.isFinite(angle) ? angle : null;
  }
  const step = signedAngleAroundAxis(drag.lastRadial, radial, axis);
  if (!Number.isFinite(step)) return null;
  drag.turned += step;
  drag.lastRadial = radial;
  return drag.turned;
}
