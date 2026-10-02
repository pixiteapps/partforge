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

export { captureLightPoses } from "./style-camera.js";
