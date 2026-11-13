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
    if (bounds.isEmpty()) return;
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
    place(camera);
  }
  /** Point the light along a WORLD direction (the live view's still key), same clamp. */
  function aimWorld([x, y, z]) {
    dir.set(x, y, z).normalize();
    place(null);
  }
  function place(camera) {
    const minY = Math.sin(THREE.MathUtils.degToRad(G.minWorldElevationDeg));
    if (dir.y < minY) {
      let x = dir.x, z = dir.z;
      let h = Math.hypot(x, z);
      if (h < 1e-9) {
        if (camera) { right.setFromMatrixColumn(camera.matrixWorld, 0); x = right.x; z = right.z; h = Math.hypot(x, z); }
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

  /** The shadow's colour and opacity over the field (celField(theme).shadow). */
  function setLook({ color, opacity }) {
    plane.material.color.set(color);
    plane.material.opacity = opacity;
  }

  function setMapSize(n) {
    applyMapSize(n);
    // three reallocates a map at the new size the next time the light renders
    if (light.shadow.map) { light.shadow.map.dispose(); light.shadow.map = null; }
    if (light.shadow.mapPass) { light.shadow.mapPass.dispose(); light.shadow.mapPass = null; }
  }

  // What the shadow map was last rendered from (shadowChanged). The live view's
  // light is world-fixed, so an orbit, pan or zoom leaves every number here as
  // it was and the map is reused; a capture aims the light camera-relative and
  // always re-renders, leaving the live map stale behind it.
  let lastSig = null;
  let stale = true;
  const sig = [];
  function signature(clipPlane) {
    sig.length = 0;
    sig.push(light.shadow.mapSize.x, light.shadow.map ? 1 : 0);
    const sc = light.shadow.camera;
    sig.push(sc.left, sc.right, sc.top, sc.bottom, sc.near, sc.far);
    light.updateWorldMatrix(true, false);
    light.target.updateWorldMatrix(true, false);
    for (const e of light.matrixWorld.elements) sig.push(e);
    for (const e of light.target.matrixWorld.elements) sig.push(e);
    if (clipPlane) sig.push(1, clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant);
    else sig.push(0);
    sig.push(casters.length);
    for (const m of casters) {
      // three's shadow pass draws a caster only if it and every ancestor are visible
      let shown = 1;
      for (let o = m; o; o = o.parent) if (!o.visible) { shown = 0; break; }
      const pos = m.geometry?.attributes?.position;
      sig.push(m.id, shown, m.geometry?.id ?? -1, pos?.version ?? -1, m.geometry?.index?.version ?? -1);
      m.updateWorldMatrix(true, false);
      for (const e of m.matrixWorld.elements) sig.push(e);
    }
    return sig;
  }
  /**
   * Whether the shadow map must re-render this frame: anything it is rendered
   * from changed since the last render (casters, their visibility, geometry or
   * pose, the light's frame or frustum, the map size, the cutaway's plane), or
   * this render is a capture, or one came after the last live render.
   */
  function shadowChanged({ capture = false, clipPlane = null } = {}) {
    if (capture) { stale = true; lastSig = null; return true; }
    const now = signature(clipPlane);
    let changed = stale || !lastSig || lastSig.length !== now.length;
    if (!changed) for (let i = 0; i < now.length; i++) if (now[i] !== lastSig[i]) { changed = true; break; }
    if (changed) { lastSig = now.slice(); stale = false; }
    return changed;
  }
  /** Forget what the map was rendered from: the next live frame re-renders it. */
  function invalidate() { stale = true; lastSig = null; }

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

  return { light, plane, fit, aim, aimWorld, setLook, setMapSize, setCasters, shadowChanged, invalidate, dispose };
}
