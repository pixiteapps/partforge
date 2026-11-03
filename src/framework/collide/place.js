// One sub-part's place() as a rigid matrix. An import-light leaf (pose-probe-core and
// geometry/pose only) so the main-thread bundle can share the rule with the collision
// world without carrying the BVH or the native core.
import { CANONICAL, probeSubPartPose } from "../pose-probe-core.js";
import { composePose, isRigid } from "../geometry/pose.js";

/** One sub-part's place() as a rigid mat4, or null when it is not a trusted rigid motion. */
export function placeMatrix(sp, view, p, d) {
  const probe = probeSubPartPose(sp, { view, purpose: "display", p, d }, { scope: "place" });
  if (!probe?.trusted || probe.baseHash !== CANONICAL) return null;
  const m = Array.from(composePose(probe.pose));
  return isRigid(m) ? m : null;
}
