// The cel band material: a ShaderMaterial that draws a sub-part in three flat
// tones (lit / shadow / deep) with a hard highlight and a pale rim. It owns two
// wiring invariants: it takes part in clipping (the cutaway clips it like any
// CAD material, via the clipping chunks), and its `opacity` and `color` stay
// live on every clone (`wireCelOpacity`) because three's clone() copies data
// properties, not the accessors the fade and cap code read and write.
import * as THREE from "three";
import { CEL, celBase, celTones, celLightView, celLightWorld } from "./cel-style.js";

const CEL_VERT = /* glsl */`
#include <clipping_planes_pars_vertex>
varying vec3 vN; varying vec3 vV;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vV = projectionMatrix[2][3] == 0.0 ? vec3(0.0, 0.0, 1.0) : normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const CEL_FRAG = /* glsl */`
#include <clipping_planes_pars_fragment>
uniform vec3 uLit, uShadow, uDeep, uLight;
uniform float uBands, uEdgeLit, uEdgeDeep, uSoft, uOpacity;
uniform float uSpecStr, uSpecSize, uShininess, uRim, uRimWidth;
varying vec3 vN; varying vec3 vV;
float band(float x, float e, float s) { return smoothstep(e - s, e + s, x); }
void main() {
  #include <clipping_planes_fragment>
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vV);
  vec3 L = normalize(uLight);
  float ndl = dot(N, L);
  float s = max(uSoft, 0.0005);
  float lit = band(ndl, uEdgeLit, s);
  float deep = uBands > 2.5 ? 1.0 - band(ndl, uEdgeDeep, s) : 0.0;

  vec3 col = mix(uShadow, uLit, lit);
  col = mix(col, uDeep, deep * (1.0 - lit));

  // hard-edged highlight
  vec3 H = normalize(L + V);
  float lobe = pow(max(dot(N, H), 0.0), uShininess);
  float spec = band(lobe, uSpecSize, 0.04) * lit;
  col = mix(col, vec3(1.0), spec * uSpecStr);

  // pale rim on the shadow side
  float f = 1.0 - max(dot(N, V), 0.0);
  float rimMask = band(f, 1.0 - uRimWidth, 0.03) * (1.0 - lit) * band(-ndl, -0.6, 0.2);
  col = mix(col, mix(uLit, vec3(1.0), 0.6), rimMask * uRim);

  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}`;

// The light, in view space. ONE Vector3 shared by every band material and every
// clone of one (wireCelOpacity re-points a clone's copy at it, since three's
// clone() deep-copies uniform values), so aiming it once a frame reaches them
// all. It rests at the camera-relative key (what a capture lights by); the live
// frame aims it at the world-fixed key's view-space image (aimCelLight).
const REST = new THREE.Vector3(...celLightView());
const WORLD = new THREE.Vector3(...celLightWorld());
const sharedLight = REST.clone();
const _q = new THREE.Quaternion();

/** Point the band shaders' key at the world-fixed direction, as `camera` sees it. */
export function aimCelLight(camera) {
  camera.getWorldQuaternion(_q).invert();
  sharedLight.copy(WORLD).applyQuaternion(_q);
}
/** Back to the camera-relative key (captures; the rest state). */
export function restCelLight() { sharedLight.copy(REST); }
/** The direction the band shaders light by right now (view space; read-only). */
export function celLightNow() { return sharedLight; }

/**
 * Keeps `opacity` (-> uOpacity), `color` (-> uLit) and `clone()` consistent on a cel
 * material. buildCelMaterial calls it; the viewer calls it on every fade clone it makes.
 */
export function wireCelOpacity(material) {
  const u = material.uniforms;
  u.uOpacity.value = typeof material.opacity === "number" ? material.opacity : 1;
  Object.defineProperty(material, "opacity", {
    configurable: true, enumerable: false,
    get: () => u.uOpacity.value,
    set: (v) => { u.uOpacity.value = v; },
  });
  Object.defineProperty(material, "color", { configurable: true, enumerable: false, get: () => u.uLit.value });
  u.uLight.value = sharedLight;
  material.clone = function clone() {
    const c = THREE.ShaderMaterial.prototype.clone.call(this);
    wireCelOpacity(c);
    return c;
  };
  return material;
}

/** The band material for one sub-part's `display` block. */
export function buildCelMaterial(display) {
  const tones = celTones(celBase(display));
  const { bands, highlight, rim } = CEL;
  const m = new THREE.ShaderMaterial({
    vertexShader: CEL_VERT, fragmentShader: CEL_FRAG, clipping: true,
    uniforms: {
      uLit: { value: new THREE.Color(tones.lit) },
      uShadow: { value: new THREE.Color(tones.shadow) },
      uDeep: { value: new THREE.Color(tones.deep) },
      uOpacity: { value: 1 },
      uLight: { value: sharedLight },
      uBands: { value: bands.count }, uEdgeLit: { value: bands.lit }, uEdgeDeep: { value: bands.deep }, uSoft: { value: bands.softness },
      uSpecStr: { value: highlight.strength }, uSpecSize: { value: highlight.size }, uShininess: { value: highlight.shininess },
      uRim: { value: rim.strength }, uRimWidth: { value: rim.width },
    },
  });
  m.userData.pfCel = true;
  const opacity = display?.opacity ?? 1;
  if (opacity < 1) { m.transparent = true; m.depthWrite = false; }
  wireCelOpacity(m);
  m.opacity = opacity;
  return m;
}
