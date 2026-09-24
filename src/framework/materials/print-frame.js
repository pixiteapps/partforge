// The frame 3D-print layer lines are drawn in. Delivered display meshes carry
// the DISPLAY pose (place(..., {purpose:"display"})); the part is printed in the
// EXPORT pose. partforge already requires the two to differ by a rigid motion
// (lint place-not-rigid), and the geometry-free pose probe reports each as a
// list of rigid steps — so the display→export map is E · D⁻¹, with no geometry.
// Three-free and DOM-free: the pose probe and pose.js are pure.
import { probeSubPartPose } from "../pose-probe-core.js";
import { poseDelta } from "../geometry/pose.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function printFrameMatrix(subPart, { view, p, d }) {
  if (!subPart?.place) return [...IDENTITY];
  const disp = probeSubPartPose(subPart, { view, purpose: "display", p, d });
  const exp = probeSubPartPose(subPart, { view, purpose: "export", p, d });
  if (!disp.trusted || !exp.trusted || disp.baseHash !== exp.baseHash) return [...IDENTITY];
  return poseDelta(exp.pose, disp.pose);
}
