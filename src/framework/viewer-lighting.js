import * as THREE from "three";
import { RENDER_STYLES } from "./renderStyles.js";

const CAD = RENDER_STYLES.cad.lights;

// The persistent sky/ground ambient. Shared with the offscreen thumbnail path
// (viewer.js renderMeshPayloads), which builds its own throwaway scene and so needs
// the same hemisphere fill to avoid rendering faces outside the key/fill cones near-black.
export function createHemisphereLight(lights = CAD) {
  const h = lights.hemisphere;
  return new THREE.HemisphereLight(h.sky, h.ground, h.intensity);
}

export function addViewerLights(scene) {
  const hemisphere = createHemisphereLight();
  const key = new THREE.DirectionalLight(CAD.key.color, CAD.key.intensity);
  key.position.set(8, 14, 10);
  const fill = new THREE.DirectionalLight(CAD.fill.color, CAD.fill.intensity);
  fill.position.set(-10, 6, -8);

  scene.add(hemisphere, key, fill);

  return { hemisphere, key, fill };
}

// The key/fill above are fixed in WORLD space, which is right for a user who orbits
// into the lit hemisphere and wrong for an offscreen canonical-view capture: `bottom`,
// `back`, and `left` stare at faces the key at (8,14,10) never reaches, so they come
// back flat — hemisphere ambient only, with no shading gradient to reveal a chamfer or
// a 1 mm snap barb. These two lights are the capture-time stand-ins, swapped in for the
// duration of one offscreen render (see viewer.js renderOffscreen) and posed relative to
// the view axis, so every canonical view is exposed and shaded the same way.
export function createCaptureLights(lights = CAD) {
  const key = new THREE.DirectionalLight(lights.key.color, lights.key.intensity);
  const fill = new THREE.DirectionalLight(lights.fill.color, lights.fill.intensity);
  return { key, fill };
}

// The offsets (renderStyles.js) are camera-space multiples of the camera-to-target
// distance: the key sits over the viewer's shoulder (up and to the right, ~41° off the
// view axis), the fill opposes it from the left at eye level. Both still shine mostly
// ALONG the view direction, so whatever the camera can see is lit.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (v) => Math.hypot(v[0], v[1], v[2]);
const norm = (v) => {
  const l = length(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// World-space positions for the capture key/fill, given a camera pose (the same
// `{position, up, target}` shape cameraPoseForView returns). Pure — no THREE, no scene.
export function captureLightPoses({ position, up, target }, lights = CAD) {
  const forward = norm(sub(target, position));
  // Camera basis. A canonical view never passes an `up` parallel to its own view axis,
  // but a caller could, and a degenerate basis would put NaN into the light positions.
  let right = cross(forward, up);
  if (length(right) < 1e-6) right = cross(forward, [0, 0, 1]);
  if (length(right) < 1e-6) right = cross(forward, [0, 1, 0]);
  right = norm(right);
  const trueUp = norm(cross(right, forward));
  const dist = length(sub(target, position)) || 1;
  const place = (offset) => [0, 1, 2].map(
    (i) => position[i] + (right[i] * offset.right + trueUp[i] * offset.up) * dist,
  );
  return { key: place(lights.key.offset), fill: place(lights.fill.offset) };
}
