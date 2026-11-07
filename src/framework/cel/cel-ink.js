// The cel ink pass: outlines (depth silhouettes, normal creases) and the optional
// halftone field, drawn as a fullscreen quad over the scene the viewer already
// rendered. Live-scene only: it needs the real canvas and the sub-part layer, and
// whatever it borrows from the renderer (clear colour and alpha, camera layers,
// override material, background, autoClear) it puts back in `finally`.
import * as THREE from "three";
import { CEL } from "./cel-style.js";

/** The camera layer the sub-part meshes sit on; the prepass draws only this. */
export const CEL_LAYER = 1;

const INK_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const INK_FRAG = /* glsl */`
#include <packing>
uniform sampler2D tNormal, tDepth;
uniform vec2 uRes; uniform float uNear, uFar, uOrtho, uPx;
uniform vec3 uInk, uBgDot;
uniform float uThick, uThin, uOuter, uDepthT, uNormalT, uBgDots, uBgDotScale;
varying vec2 vUv;
float rawD(vec2 uv) { return texture2D(tDepth, uv).x; }
float linZ(float d) { return uOrtho > 0.5 ? orthographicDepthToViewZ(d, uNear, uFar) : perspectiveDepthToViewZ(d, uNear, uFar); }
vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
void main() {
  vec2 px = 1.0 / uRes;
  float dC = rawD(vUv);
  bool bgC = dC >= 0.99999;
  float zC = linZ(dC);

  // silhouettes: second difference of linear depth (zero on a plane), at the thick radius
  float edgeD = 0.0; float outer = 0.0;
  if (uThick > 0.0) {
    vec2 r = px * uThick * uPx;
    float dL = rawD(vUv - vec2(r.x, 0.0)), dR = rawD(vUv + vec2(r.x, 0.0));
    float dD = rawD(vUv - vec2(0.0, r.y)), dU = rawD(vUv + vec2(0.0, r.y));
    float zL = linZ(dL), zR = linZ(dR), zD = linZ(dD), zU = linZ(dU);
    float lap = max(abs(zL + zR - 2.0 * zC), abs(zU + zD - 2.0 * zC)) / max(abs(zC), 1e-4);
    bool anyBg = dL >= 0.99999 || dR >= 0.99999 || dD >= 0.99999 || dU >= 0.99999;
    bool allBg = dL >= 0.99999 && dR >= 0.99999 && dD >= 0.99999 && dU >= 0.99999;
    if (bgC) {
      // a background pixel next to a part: the outer contour, drawn outward
      vec2 ro = px * uThick * uOuter * uPx;
      bool near = rawD(vUv - vec2(ro.x, 0.0)) < 0.99999 || rawD(vUv + vec2(ro.x, 0.0)) < 0.99999
               || rawD(vUv - vec2(0.0, ro.y)) < 0.99999 || rawD(vUv + vec2(0.0, ro.y)) < 0.99999;
      edgeD = near ? 1.0 : 0.0;
    } else {
      edgeD = smoothstep(uDepthT, uDepthT * 2.0, lap);
      if (anyBg && !allBg) edgeD = 1.0;
    }
  }

  // creases: normal disagreement at the thin radius
  float edgeN = 0.0;
  if (uThin > 0.0 && !bgC) {
    vec2 r = px * uThin * uPx;
    vec3 nC = nrm(vUv);
    float m = 0.0;
    m = max(m, 1.0 - dot(nC, nrm(vUv - vec2(r.x, 0.0))));
    m = max(m, 1.0 - dot(nC, nrm(vUv + vec2(r.x, 0.0))));
    m = max(m, 1.0 - dot(nC, nrm(vUv - vec2(0.0, r.y))));
    m = max(m, 1.0 - dot(nC, nrm(vUv + vec2(0.0, r.y))));
    edgeN = smoothstep(uNormalT, uNormalT * 1.6, m);
  }

  float ink = max(edgeD, edgeN);
  if (ink > 0.001) { gl_FragColor = vec4(uInk, ink);
    #include <colorspace_fragment>
    return; }

  // the halftone screen on the empty frame (uBgDots = 0: transparent field, nothing drawn)
  if (bgC && uBgDots > 0.0) {
    mat2 R = mat2(0.7071, -0.7071, 0.7071, 0.7071);
    vec2 g = (R * gl_FragCoord.xy) / (uBgDotScale * uPx);
    float d = length(fract(g) - 0.5);
    float dots = 1.0 - smoothstep(0.18, 0.30, d);
    gl_FragColor = vec4(uBgDot, dots * uBgDots);
    #include <colorspace_fragment>
    return;
  }
  discard;
}`;

export function createCelInk() {
  const { ink: I, field: F } = CEL;
  const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const inkMat = new THREE.ShaderMaterial({
    vertexShader: INK_VERT, fragmentShader: INK_FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: {
      tNormal: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 }, uFar: { value: 1000 }, uOrtho: { value: 0 }, uPx: { value: 1 },
      uInk: { value: new THREE.Color(I.color) }, uBgDot: { value: new THREE.Color(F.color).multiplyScalar(F.dotDarken) },
      uThick: { value: I.thickPx }, uThin: { value: I.thinPx }, uOuter: { value: I.outerBoost },
      uDepthT: { value: I.depthThreshold }, uNormalT: { value: I.normalThreshold },
      uBgDots: { value: 0 }, uBgDotScale: { value: F.dotCellPx },
    },
  });
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const quadScene = new THREE.Scene();
  quadScene.add(new THREE.Mesh(quadGeometry, inkMat));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2(), clearColor = new THREE.Color();
  let target = null;

  function ensureTarget(w, h) {
    if (target && target.width === w && target.height === h) return target;
    target?.dispose();
    target?.depthTexture?.dispose();
    const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture, depthBuffer: true,
    });
    inkMat.uniforms.tNormal.value = target.texture;
    inkMat.uniforms.tDepth.value = depthTexture;
    inkMat.uniforms.uRes.value.set(w, h);
    return target;
  }

  /** Draw the ink over what was just rendered. Call after the scene's own render. */
  function render(renderer, scene, camera, opts = {}) {
    const { pixelScale = 1, field = null, clippingPlanes } = opts;
    // Draw into whatever is bound now: the canvas (null) or a capture's target.
    const bound = renderer.getRenderTarget();
    if (bound) size.set(bound.width, bound.height); else renderer.getDrawingBufferSize(size);
    if (size.x < 2 || size.y < 2) return; // a parked viewer's canvas is 1x1
    const rt = ensureTarget(size.x, size.y);
    const clearWas = renderer.getClearColor(clearColor).clone(), clearAlphaWas = renderer.getClearAlpha();
    const layersWas = camera.layers.mask, overrideWas = scene.overrideMaterial, backgroundWas = scene.background;
    const autoClearWas = renderer.autoClear;
    try {
      // 1. normals + depth of the sub-parts alone
      normalMat.clippingPlanes = clippingPlanes ?? [];
      camera.layers.set(CEL_LAYER);
      scene.overrideMaterial = normalMat;
      scene.background = null;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x808080, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.setRenderTarget(bound);
    } finally {
      renderer.setRenderTarget(bound);
      renderer.setClearColor(clearWas, clearAlphaWas);
      camera.layers.mask = layersWas;
      scene.overrideMaterial = overrideWas;
      scene.background = backgroundWas;
    }
    try {
      // 2. ink over the frame
      const u = inkMat.uniforms;
      u.uNear.value = camera.near; u.uFar.value = camera.far;
      u.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
      u.uPx.value = pixelScale;
      u.uBgDots.value = field && field.dots ? F.dots : 0;
      if (field) u.uBgDot.value.copy(field.color).multiplyScalar(F.dotDarken);
      renderer.autoClear = false;
      renderer.render(quadScene, quadCam);
    } finally {
      renderer.autoClear = autoClearWas;
      renderer.setRenderTarget(bound);
    }
  }

  function dispose() {
    target?.dispose();
    target?.depthTexture?.dispose();
    target = null;
    normalMat.dispose();
    inkMat.dispose();
    quadGeometry.dispose();
  }

  return { render, dispose };
}
