// Sheet frames and poses — pure math, no kernel, no paper (lint and the oracle read it).
//
// A sheet part is authored in its CANONICAL frame: the profile in XY, the solid
// extruded over z ∈ [0, t], the laser face at z = t. A SheetPose { face, up, at } says
// where that piece sits in the assembly:
//   face  the laser face's outward normal, as an axis word ("+X", "-Y", …)
//   up    the drawing's +y, an axis word perpendicular to face
//   at    where drawing [0, 0] lands (on the laser face); the material extends along −face
// The drawing's +x maps to X = up × face, so R = [X | Y | F] (columns) is always a
// proper rotation (det +1) and an engraving can never come out mirrored. A canonical
// point [u, v, z] lands at  at + u·X + v·Y + (z − t)·F.
import { AXIS_WORDS } from "./constants.js";

const AXIS_VEC = {
  "+X": [1, 0, 0], "-X": [-1, 0, 0],
  "+Y": [0, 1, 0], "-Y": [0, -1, 0],
  "+Z": [0, 0, 1], "-Z": [0, 0, -1],
};
const WORDS = AXIS_WORDS.join(", ");
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const finiteN = (v, n) => Array.isArray(v) && v.length === n && v.every((c) => typeof c === "number" && Number.isFinite(c));
// `+ 0` folds a -0 component to 0, so frames and steps serialize cleanly.
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1] + 0, a[2] * b[0] - a[0] * b[2] + 0, a[0] * b[1] - a[1] * b[0] + 0];

// null when `pose` is a valid SheetPose, else the reason (callers add their prefix).
export function validatePose(pose) {
  if (!isPlainObject(pose)) return "pose must be a { face, up, at } object";
  if (!AXIS_WORDS.includes(pose.face)) return `face must be one of ${WORDS}, got ${JSON.stringify(pose.face)}`;
  if (!AXIS_WORDS.includes(pose.up)) return `up must be one of ${WORDS}, got ${JSON.stringify(pose.up)}`;
  if (pose.up[1] === pose.face[1]) return `up (${pose.up}) must be perpendicular to face (${pose.face})`;
  if (!finiteN(pose.at, 3)) return `at must be a finite [x, y, z], got ${JSON.stringify(pose.at)}`;
  return null;
}

function checkPose(pose, prefix) {
  const reason = validatePose(pose);
  if (reason) throw new Error(`${prefix}: ${reason}`);
}

// The pose's world frame: X = up × face (drawing +x), Y = up (drawing +y), F = face.
export function poseFrame(pose) {
  checkPose(pose, "sheet pose");
  const F = [...AXIS_VEC[pose.face]], Y = [...AXIS_VEC[pose.up]];
  return { X: cross(Y, F), Y, F, at: [...pose.at] };
}

// Axis-angle of R = [X | Y | F], or null for the identity. R is a signed permutation
// matrix, so the angle is 90°, 120° or 180°; the axis is scaled so its largest
// component is ±1 (the backends normalize it), which keeps basis rotations exact.
function axisAngle(X, Y, F) {
  // R[i][j] = component i of column j
  const R = [[X[0], Y[0], F[0]], [X[1], Y[1], F[1]], [X[2], Y[2], F[2]]];
  const trace = R[0][0] + R[1][1] + R[2][2];
  if (trace > 2.5) return null; // identity (trace 3)
  const cos = Math.max(-1, Math.min(1, (trace - 1) / 2));
  const deg = Math.round((Math.acos(cos) * 180) / Math.PI * 1e9) / 1e9;
  let axis;
  if (trace < -0.5) {
    // 180°: R + I = 2·a·aᵀ — take the column with the largest diagonal entry
    const i = [0, 1, 2].reduce((best, k) => (R[k][k] > R[best][best] ? k : best), 0);
    axis = [0, 1, 2].map((r) => R[r][i] + (r === i ? 1 : 0));
  } else {
    axis = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
  }
  const m = Math.max(...axis.map(Math.abs));
  return { deg, axis: axis.map((c) => c / m + 0) };
}

// The rigid steps that carry the canonical solid (z ∈ [0, t]) to the pose:
// translate [0, 0, −t] (laser face to z = 0), rotate by R about the origin (omitted
// when R = I), translate `at`. Exactly the step vocabulary the pose probe records
// (pose-probe-core.js), so a posed sheet part stays probe-trusted.
export function poseSteps(pose, t) {
  const { X, Y, F, at } = poseFrame(pose);
  const steps = [{ t: "translate", v: [0, 0, -t] }];
  const rot = axisAngle(X, Y, F);
  if (rot) steps.push({ t: "rotate", deg: rot.deg, center: [0, 0, 0], axis: rot.axis });
  steps.push({ t: "translate", v: at });
  return steps;
}
