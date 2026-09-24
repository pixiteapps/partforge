// The perspective <-> orthographic framing pair. Pure, so the swap's only
// interesting property — that the part does not change size the instant the
// projection swaps (a view cube face click settling into ortho, a rotation
// leaving it) — is unit-testable without a renderer.
//
// Perspective frames by DISTANCE; orthographic frames by a frustum height plus
// a zoom (OrbitControls dollies an ortho camera by changing camera.zoom, not by
// moving it). These two functions convert between the two descriptions.

const halfHeightAt = (fovDeg, distance) => distance * Math.tan((fovDeg * Math.PI) / 360);

export function orthoFrustum({ fovDeg, distance, aspect = 1 }) {
  const halfH = halfHeightAt(fovDeg, distance);
  const halfW = halfH * aspect;
  return { halfW, halfH, left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}

export function perspectiveDistance({ halfH, zoom = 1, fovDeg }) {
  return halfH / (zoom * Math.tan((fovDeg * Math.PI) / 360));
}

// --- automatic projection (Fusion 360's "Perspective with Ortho Faces") -----
// The live view is orthographic only while it looks straight down one of the
// six world axes — a view cube FACE view. These are the tests that decide
// "straight down an axis" and "the user has rotated off it".
//
// Half a degree: comfortably above what OrbitControls itself leaves behind (it
// clamps the polar angle a hair — 1e-6 rad — off the poles, so a settled top
// view is never exactly on +Y) and far below any rotation a person could make
// on purpose and expect to see.
export const FACE_ALIGN_EPS_DEG = 0.5;
const COS_EPS = Math.cos((FACE_ALIGN_EPS_DEG * Math.PI) / 180);

function unit(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

// `dir` is any non-zero vector (the target -> camera offset is what callers
// pass). True when it lies within FACE_ALIGN_EPS_DEG of +/-X, +/-Y or +/-Z.
export function isFaceAligned(dir) {
  const d = Array.isArray(dir) ? unit(dir) : null;
  if (!d || !d.every(Number.isFinite)) return false;
  return Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) >= COS_EPS;
}

// The same test on a { pos, target } camera state (getCameraState's shape,
// and what a host carries in viewerState.camera). A missing or malformed state
// is not aligned — the caller then restores perspective, the safe default.
export function isFaceAlignedState(state) {
  const p = state?.pos, t = state?.target;
  if (!Array.isArray(p) || !Array.isArray(t) || p.length !== 3 || t.length !== 3) return false;
  return isFaceAligned([p[0] - t[0], p[1] - t[1], p[2] - t[2]]);
}

// True once `dir` has turned more than FACE_ALIGN_EPS_DEG away from `axis`
// (both non-zero vectors; neither need be unit length). A pan moves the camera
// and its target together and an orthographic zoom moves neither, so only a
// ROTATION trips this — which is why direction, not OrbitControls' "start"
// event (fired for pan and zoom too), is what ends an ortho face view.
export function hasLeftAxis(dir, axis) {
  const a = unit(dir), b = unit(axis);
  if (!a || !b) return false;
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < COS_EPS;
}
