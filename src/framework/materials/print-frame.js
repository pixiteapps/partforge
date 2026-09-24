// The frame 3D-print layer lines are drawn in. Delivered display meshes carry
// the DISPLAY pose (place(..., {purpose:"display"})); the part is printed in the
// EXPORT pose. partforge already requires the two to differ by a rigid motion
// (lint place-not-rigid), and the geometry-free pose probe reports each as a
// list of rigid steps — so the display→export map is E · D⁻¹, with no geometry.
// Three-free and DOM-free: the pose probe and pose.js are pure.
import { probeSubPartPose } from "../pose-probe-core.js";
import { composePose, invertRigid } from "../geometry/pose.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(A, B) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = A[r] * B[c * 4] + A[4 + r] * B[c * 4 + 1] + A[8 + r] * B[c * 4 + 2] + A[12 + r] * B[c * 4 + 3];
  return o;
}

export function printFrameMatrix(subPart, { view, p, d }) {
  if (!subPart?.place) return [...IDENTITY];
  const disp = probeSubPartPose(subPart, { view, purpose: "display", p, d });
  const exp = probeSubPartPose(subPart, { view, purpose: "export", p, d });
  if (!disp.trusted || !exp.trusted || disp.baseHash !== exp.baseHash) return [...IDENTITY];
  return mul(composePose(exp.pose), invertRigid(composePose(disp.pose)));
}
