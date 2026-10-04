// The frame 3D-print layer lines are drawn in. Delivered display meshes carry
// the DISPLAY pose (place(..., {purpose:"display"})); the part is printed in the
// EXPORT pose. partforge already requires the two to differ by a rigid motion
// (lint place-not-rigid), and the geometry-free pose probe reports each as a
// list of rigid steps — so the display→export map is E · D⁻¹, with no geometry.
// Three-free and DOM-free: the pose probe and pose.js are pure.
import { probeSubPartPose } from "../pose-probe-core.js";
import { poseDelta, composePose } from "../geometry/pose.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// `frame` is the delivery's frame. A "canonical" mesh is the build before place(), so its
// map to the printed part is the export pose itself (place-scope: no geometry is read, so a
// build that queries its solid cannot make it untrusted); a "posed" mesh already carries the
// display pose, so the map is E · D⁻¹.
export function printFrameMatrix(subPart, { view, p, d, frame = "posed" }) {
  if (!subPart?.place) return [...IDENTITY];
  if (frame === "canonical") {
    const exp = probeSubPartPose(subPart, { view, purpose: "export", p, d }, { scope: "place" });
    return exp.trusted ? composePose(exp.pose) : [...IDENTITY];
  }
  const disp = probeSubPartPose(subPart, { view, purpose: "display", p, d });
  const exp = probeSubPartPose(subPart, { view, purpose: "export", p, d });
  if (!disp.trusted || !exp.trusted || disp.baseHash !== exp.baseHash) return [...IDENTITY];
  return poseDelta(exp.pose, disp.pose);
}

const isIdentity = (m) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12);

// The map from a DISPLAY-posed solid to the same piece in its print (export) pose, for
// the oracle's overhang reading — or null when the two poses are the same (no place(),
// or a place() that moves nothing between purposes) or cannot be read. Place-scope
// probes first: both poses are place(build), so E · D⁻¹ needs only place() to be
// readable, and a build that queries its solid cannot make it untrusted. A place()
// that only the full-scope probe reads falls back to printFrameMatrix's posed branch.
export function displayToPrintMatrix(subPart, { view, p, d }) {
  if (!subPart?.place) return null;
  const disp = probeSubPartPose(subPart, { view, purpose: "display", p, d }, { scope: "place" });
  const exp = probeSubPartPose(subPart, { view, purpose: "export", p, d }, { scope: "place" });
  const m = disp.trusted && exp.trusted
    ? poseDelta(exp.pose, disp.pose)
    : printFrameMatrix(subPart, { view, p, d, frame: "posed" });
  return isIdentity(m) ? null : m;
}
