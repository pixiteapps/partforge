// The cel ground shadow: a zero-intensity shadow-map light that only darkens a
// ShadowMaterial plane under the part, soft through a VSM blur. Two VSM pitfalls
// shape it. The plane must sit strictly inside the shadow map's xy bounds (at the
// edge the blur mixes the plane's depth with cleared texels and draws a stripe),
// so its side is fitted to the frustum for any azimuth. And VSM stores depth in
// half floats, so the near/far slab is as thin as the far light allows, and the
// plane never crosses either end of it. The light's world elevation is clamped so
// a camera looking down never puts the sun below the shadow-casting range.
import * as THREE from "three";
import { CEL } from "./cel-style.js";

export function createCelGround({ mapSize = CEL.ground.mapSize } = {}) {
  const G = CEL.ground;
  const light = new THREE.DirectionalLight(0xffffff, 0);
  light.castShadow = true;
  light.shadow.bias = G.bias;
  light.shadow.blurSamples = 25;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ color: G.color, opacity: G.opacity, transparent: true, depthWrite: false }),
  );
  plane.name = "pfCelGround";
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;

  const centre = new THREE.Vector3();
  let radius = 1;
  let casters = [];
  const dir = new THREE.Vector3(), right = new THREE.Vector3();

  const applyMapSize = (n) => {
    light.shadow.mapSize.set(n, n);
    light.shadow.radius = G.penumbra * n / (2 * G.frustumR);
  };
  applyMapSize(mapSize);

  /** Size the plane and the shadow frustum to the part's rest-pose bounds. */
  function fit(bounds) {
    bounds.getCenter(centre);
    radius = Math.max(1e-3, bounds.getSize(dir).length() / 2);
    const span = (G.frustumR * radius * 2) / Math.SQRT2 * G.planeFill;
    plane.geometry.dispose();
    plane.geometry = new THREE.PlaneGeometry(span, span);
    plane.position.set(centre.x, bounds.min.y - 1e-3 * radius, centre.z);
    const sc = light.shadow.camera, half = G.frustumR * radius;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = G.nearR * radius; sc.far = G.farR * radius;
    sc.updateProjectionMatrix();
  }

  /** Point the light along a camera-relative direction, clamped above the world horizon. */
  function aim(camera, { azimuthDeg, elevationDeg }) {
    const az = THREE.MathUtils.degToRad(azimuthDeg), el = THREE.MathUtils.degToRad(elevationDeg);
    dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).transformDirection(camera.matrixWorld);
    const minY = Math.sin(THREE.MathUtils.degToRad(G.minWorldElevationDeg));
    if (dir.y < minY) {
      let x = dir.x, z = dir.z;
      let h = Math.hypot(x, z);
      if (h < 1e-9) {
        right.setFromMatrixColumn(camera.matrixWorld, 0);
        x = right.x; z = right.z; h = Math.hypot(x, z);
        if (h < 1e-9) { x = 1; z = 0; h = 1; }
      }
      const k = Math.sqrt(1 - minY * minY) / h;
      dir.set(x * k, minY, z * k);
    }
    light.position.copy(centre).addScaledVector(dir, radius * G.lightDistanceR);
    light.target.position.copy(centre);
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
  }

  function setMapSize(n) {
    applyMapSize(n);
    // three reallocates a map at the new size the next time the light renders
    if (light.shadow.map) { light.shadow.map.dispose(); light.shadow.map = null; }
    if (light.shadow.mapPass) { light.shadow.mapPass.dispose(); light.shadow.mapPass = null; }
  }

  function setCasters(meshes) {
    const next = new Set(meshes);
    for (const m of casters) if (!next.has(m)) m.castShadow = false;
    for (const m of next) m.castShadow = true;
    casters = [...next];
  }

  function dispose() {
    plane.geometry.dispose();
    plane.material.dispose();
    light.shadow.dispose();
  }

  return { light, plane, fit, aim, setMapSize, setCasters, dispose };
}
