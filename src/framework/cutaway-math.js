import * as THREE from "three";

const PLANE_LOCAL_NORMAL = new THREE.Vector3(0, 0, 1);
const POINT_EPSILON = 1e-6;

// Nearest signed canonical axis (+/-X, +/-Y, +/-Z) to `direction`. Axes are
// scanned X, Y, Z and replaced only on a strictly larger |component|, so a tie
// resolves to the earlier axis — the default isometric framing is an exact tie
// between -X and -Z and lands on -X. Degenerate input falls back to +Z.
export function nearestCanonicalAxis(direction, target = new THREE.Vector3()) {
  const components = [direction.x, direction.y, direction.z];
  if (!components.every(Number.isFinite)) return target.set(0, 0, 1);

  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < 3; i++) {
    const score = Math.abs(components[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return target.set(0, 0, 1);

  // Built by setComponent rather than negating a unit axis: multiplying a zero
  // component by -1 yields -0, and toEqual([0, -1, 0]) does not accept -0.
  return target.set(0, 0, 0).setComponent(bestIndex, components[bestIndex] < 0 ? -1 : 1);
}

// The plane's on-screen extent, as a function of the part's bounds ALONE.
// Split out of initialCutawayPose so a restored pose can be re-sized against
// whatever geometry it is landing on without inheriting anything else from the
// pose it came from — see the cutaway's setState.
export function cutawayPoseSize(box) {
  return Math.max(box.getSize(new THREE.Vector3()).length(), 1) * 1.25;
}

export function initialCutawayPose(box, camera) {
  const position = box.getCenter(new THREE.Vector3());
  // Square the cut plane up with the part rather than the camera: the axis
  // nearest the view direction, so the near half is still what gets cut away.
  const normal = nearestCanonicalAxis(
    camera.getWorldDirection(new THREE.Vector3()).normalize(),
  );
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    PLANE_LOCAL_NORMAL,
    normal,
  );

  return {
    position,
    quaternion,
    size: cutawayPoseSize(box),
  };
}

export const AXIS_SNAP_RADIANS = (7 * Math.PI) / 180;

// Pull a plane pose onto the nearest canonical axis once its normal is within
// `maxAngle` of one. The correction is the minimal rotation carrying the normal
// onto the axis, not a rebuilt quaternion, so the plane's in-plane roll survives
// and the gizmo rings do not visibly spin at the moment of snapping. Roll does
// not affect the clip either way.
export function snapQuaternionToAxis(
  quaternion,
  maxAngle = AXIS_SNAP_RADIANS,
  target = new THREE.Quaternion(),
) {
  const normal = PLANE_LOCAL_NORMAL.clone().applyQuaternion(quaternion).normalize();
  const axis = nearestCanonicalAxis(normal);
  if (normal.angleTo(axis) > maxAngle) return target.copy(quaternion);
  return target
    .setFromUnitVectors(normal, axis)
    .multiply(quaternion)
    .normalize();
}

export function planeFromPose(plane, normalTarget, position, quaternion, flipped) {
  normalTarget.copy(PLANE_LOCAL_NORMAL).applyQuaternion(quaternion).normalize();
  if (flipped) normalTarget.negate();
  return plane.setFromNormalAndCoplanarPoint(normalTarget, position);
}

export function pointSurvivesPlane(plane, point, epsilon = POINT_EPSILON) {
  // three.js clipping retains the nonnegative side of a THREE.Plane.
  return plane.distanceToPoint(point) >= -epsilon;
}

// The ray-to-axis and signed-angle helpers moved to the shared gizmo module; they are
// re-exported here for the cutaway's callers.
export { axisParameterFromRay, signedAngleAroundAxis } from "./gizmo/gizmo-rotate.js";
