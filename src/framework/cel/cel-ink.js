// The cel ink pass: outlines (depth silhouettes, normal creases) and the optional
// halftone field, found as masks by one fullscreen quad and composited, the ink
// anti-aliased, over the scene the viewer already rendered by a second. Live-scene only: it needs the real canvas and the sub-part layer, and
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

  // Every radius is floored at one texel: the target is NearestFilter, so an
  // offset under half a texel samples the centre texel itself and the line
  // vanishes (the thin crease radius at pixelScale < ~1.67). No ink line is
  // thinner than one device pixel.
  // silhouettes: second difference of linear depth (zero on a plane), at the thick radius
  float edgeD = 0.0; float outer = 0.0;
  if (uThick > 0.0) {
    vec2 r = px * max(uThick * uPx, 1.0);
    float dL = rawD(vUv - vec2(r.x, 0.0)), dR = rawD(vUv + vec2(r.x, 0.0));
    float dD = rawD(vUv - vec2(0.0, r.y)), dU = rawD(vUv + vec2(0.0, r.y));
    float zL = linZ(dL), zR = linZ(dR), zD = linZ(dD), zU = linZ(dU);
    float lap = max(abs(zL + zR - 2.0 * zC), abs(zU + zD - 2.0 * zC)) / max(abs(zC), 1e-4);
    bool anyBg = dL >= 0.99999 || dR >= 0.99999 || dD >= 0.99999 || dU >= 0.99999;
    bool allBg = dL >= 0.99999 && dR >= 0.99999 && dD >= 0.99999 && dU >= 0.99999;
    if (bgC) {
      // a background pixel next to a part: the outer contour, drawn outward
      vec2 ro = px * max(uThick * uOuter * uPx, 1.0);
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
    vec2 r = px * max(uThin * uPx, 1.0);
    vec3 nC = nrm(vUv);
    float m = 0.0;
    m = max(m, 1.0 - dot(nC, nrm(vUv - vec2(r.x, 0.0))));
    m = max(m, 1.0 - dot(nC, nrm(vUv + vec2(r.x, 0.0))));
    m = max(m, 1.0 - dot(nC, nrm(vUv - vec2(0.0, r.y))));
    m = max(m, 1.0 - dot(nC, nrm(vUv + vec2(0.0, r.y))));
    edgeN = smoothstep(uNormalT, uNormalT * 1.6, m);
  }

  float ink = max(edgeD, edgeN);

  // the halftone screen on the empty frame (uBgDots = 0: transparent field, nothing drawn)
  float dots = 0.0;
  if (bgC && uBgDots > 0.0) {
    mat2 R = mat2(0.7071, -0.7071, 0.7071, 0.7071);
    vec2 g = (R * gl_FragCoord.xy) / (uBgDotScale * uPx);
    float d = length(fract(g) - 0.5);
    dots = (1.0 - smoothstep(0.18, 0.30, d)) * uBgDots;
  }
  // Masks, not colours: R the ink's coverage, G the field dot's. The resolve
  // pass smooths R and colours both.
  gl_FragColor = vec4(ink, dots, 0.0, 1.0);
}`;

// The resolve: the ink mask is a hard per-pixel decision (the prepass is
// NearestFilter and the canvas's MSAA never reaches a fullscreen quad), so its
// lines stair-step. An FXAA-style filter on the mask alone (R) smooths them
// along the edge direction; the field dots (G) are already smoothstepped and
// pass through. Then both are coloured and composited over the frame.
const RESOLVE_FRAG = /* glsl */`
uniform sampler2D tInk;
uniform vec2 uRes;
uniform vec3 uInk, uBgDot;
varying vec2 vUv;
float L(vec2 uv) { return texture2D(tInk, uv).r; }
void main() {
  vec2 px = 1.0 / uRes;
  vec2 m = texture2D(tInk, vUv).rg;
  float lM = m.r;
  float lNW = L(vUv + vec2(-1.0, -1.0) * px), lNE = L(vUv + vec2(1.0, -1.0) * px);
  float lSW = L(vUv + vec2(-1.0, 1.0) * px), lSE = L(vUv + vec2(1.0, 1.0) * px);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  float ink = lM;
  if (lMax - lMin > 0.05) {
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    float reduce = max((lNW + lNE + lSW + lSE) * (0.25 / 8.0), 1.0 / 128.0);
    float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * px;
    float a = 0.5 * (L(vUv + dir * (1.0 / 3.0 - 0.5)) + L(vUv + dir * (2.0 / 3.0 - 0.5)));
    float b = a * 0.5 + 0.25 * (L(vUv - dir * 0.5) + L(vUv + dir * 0.5));
    ink = (b < lMin || b > lMax) ? a : b;
  }
  float dots = m.g;
  float alpha = ink + dots * (1.0 - ink);
  if (alpha < 0.002) discard;
  vec3 col = (uInk * ink + uBgDot * dots * (1.0 - ink)) / alpha;
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}`;

// The prepass: view-space normals packed to RGB, plus depth, double-sided. A
// cutaway clips the meshes, and the cap that closes the cut is drawn by
// stencil in the scene pass only; here, through the opening, the clipped mesh
// would show its own inside, and the ink would outline the inside faces'
// edges straight across the cap. So a BACK face that survives the clip, which
// is exactly where the cap sits on a closed mesh, is written as the cap: the
// plane's normal (turned toward the camera) at the plane's depth, found by
// casting the fragment's view ray onto the plane.
const PREPASS_VERT = /* glsl */`
#include <clipping_planes_pars_vertex>
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  vNormalV = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const PREPASS_FRAG = /* glsl */`
#include <packing>
#include <clipping_planes_pars_fragment>
uniform mat4 uProj;
uniform float uOrtho;
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  #include <clipping_planes_fragment>
  vec3 n = normalize(vNormalV) * (gl_FrontFacing ? 1.0 : -1.0);
  float depth = gl_FragCoord.z;
  #if NUM_CLIPPING_PLANES > 0
  if (!gl_FrontFacing) {
    // three's clip test keeps dot(-p, plane.xyz) <= plane.w (view space),
    // so the plane itself is dot(p, plane.xyz) = -plane.w.
    vec4 plane = clippingPlanes[0];
    vec3 origin = uOrtho > 0.5 ? vec3(vViewPos.xy, 0.0) : vec3(0.0);
    vec3 dir = uOrtho > 0.5 ? vec3(0.0, 0.0, -1.0) : normalize(vViewPos);
    float den = dot(dir, plane.xyz);
    if (abs(den) > 1e-6) {
      float t = (-plane.w - dot(origin, plane.xyz)) / den;
      vec4 clip = uProj * vec4(origin + dir * t, 1.0);
      depth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
      n = normalize(plane.xyz) * (den > 0.0 ? -1.0 : 1.0);
    }
  }
  #endif
  gl_FragDepth = depth;
  gl_FragColor = vec4(packNormalToRGB(n), 1.0);
}`;

function createPrepassMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: PREPASS_VERT, fragmentShader: PREPASS_FRAG,
    side: THREE.DoubleSide, clipping: true,
    uniforms: { uProj: { value: new THREE.Matrix4() }, uOrtho: { value: 0 } },
  });
}

export function createCelInk() {
  const { ink: I, field: F } = CEL;
  const normalMat = createPrepassMaterial();
  const inkMat = new THREE.ShaderMaterial({
    vertexShader: INK_VERT, fragmentShader: INK_FRAG, blending: THREE.NoBlending, depthTest: false, depthWrite: false,
    uniforms: {
      tNormal: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 }, uFar: { value: 1000 }, uOrtho: { value: 0 }, uPx: { value: 1 },
      uThick: { value: I.thickPx }, uThin: { value: I.thinPx }, uOuter: { value: I.outerBoost },
      uDepthT: { value: I.depthThreshold }, uNormalT: { value: I.normalThreshold },
      uBgDots: { value: 0 }, uBgDotScale: { value: F.dotCellPx },
    },
  });
  const resolveMat = new THREE.ShaderMaterial({
    vertexShader: INK_VERT, fragmentShader: RESOLVE_FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: {
      tInk: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
      uInk: { value: new THREE.Color(I.color) }, uBgDot: { value: new THREE.Color(F.color).multiplyScalar(F.dotDarken) },
    },
  });
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const quadScene = new THREE.Scene(), resolveScene = new THREE.Scene();
  quadScene.add(new THREE.Mesh(quadGeometry, inkMat));
  resolveScene.add(new THREE.Mesh(quadGeometry, resolveMat));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2(), clearColor = new THREE.Color();
  // One prepass target for the canvas and one for captures: a capture is
  // rarely the canvas's size, and one shared target would be reallocated (a
  // float depth texture included) around every capture and again on the next
  // live frame.
  // Each slot also holds the ink mask the resolve reads (linear-filtered: the
  // smoothing samples between texels).
  const targets = { live: null, capture: null };
  const masks = { live: null, capture: null };

  function ensureTarget(slot, w, h) {
    let target = targets[slot];
    if (!target || target.width !== w || target.height !== h) {
      target?.dispose();
      target?.depthTexture?.dispose();
      masks[slot]?.dispose();
      const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
      target = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture, depthBuffer: true,
      });
      targets[slot] = target;
      masks[slot] = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
      });
    }
    inkMat.uniforms.tNormal.value = target.texture;
    inkMat.uniforms.tDepth.value = target.depthTexture;
    inkMat.uniforms.uRes.value.set(w, h);
    resolveMat.uniforms.tInk.value = masks[slot].texture;
    resolveMat.uniforms.uRes.value.set(w, h);
    return target;
  }

  /** Draw the ink over what was just rendered. Call after the scene's own render. */
  function render(renderer, scene, camera, opts = {}) {
    const { pixelScale = 1, field = null, clippingPlanes } = opts;
    // Draw into whatever is bound now: the canvas (null) or a capture's target.
    const bound = renderer.getRenderTarget();
    if (bound) size.set(bound.width, bound.height); else renderer.getDrawingBufferSize(size);
    if (size.x < 2 || size.y < 2) return; // a parked viewer's canvas is 1x1
    const slot = bound ? "capture" : "live";
    const rt = ensureTarget(slot, size.x, size.y);
    const clearWas = renderer.getClearColor(clearColor).clone(), clearAlphaWas = renderer.getClearAlpha();
    const layersWas = camera.layers.mask, overrideWas = scene.overrideMaterial, backgroundWas = scene.background;
    const autoClearWas = renderer.autoClear;
    try {
      // 1. normals + depth of the sub-parts alone
      normalMat.clippingPlanes = clippingPlanes ?? [];
      normalMat.uniforms.uProj.value.copy(camera.projectionMatrix);
      normalMat.uniforms.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
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
      // 2. the ink and dot masks
      const u = inkMat.uniforms;
      u.uNear.value = camera.near; u.uFar.value = camera.far;
      u.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
      u.uPx.value = pixelScale;
      u.uBgDots.value = field && field.dots ? F.dots : 0;
      // The dot: the caller's (celField's, per theme), else the field darkened.
      if (field?.dot) resolveMat.uniforms.uBgDot.value.copy(field.dot);
      else if (field) resolveMat.uniforms.uBgDot.value.copy(field.color).multiplyScalar(F.dotDarken);
      renderer.autoClear = false;
      renderer.setRenderTarget(masks[slot]);
      renderer.render(quadScene, quadCam);
      // 3. smoothed ink and dots over the frame
      renderer.setRenderTarget(bound);
      renderer.render(resolveScene, quadCam);
    } finally {
      renderer.autoClear = autoClearWas;
      renderer.setRenderTarget(bound);
    }
  }

  function dispose() {
    for (const slot of Object.keys(targets)) {
      targets[slot]?.dispose();
      targets[slot]?.depthTexture?.dispose();
      targets[slot] = null;
      masks[slot]?.dispose();
      masks[slot] = null;
    }
    normalMat.dispose();
    inkMat.dispose();
    resolveMat.dispose();
    quadGeometry.dispose();
  }

  return {
    render,
    dispose,
    /** The ink pass's ShaderMaterial (its uniforms are what tests read). */
    get material() { return inkMat; },
    /** The resolve pass (smooths the ink mask, colours it, composites it). */
    get resolveMaterial() { return resolveMat; },
    /** The prepass override (normals, double-sided), for the viewer's pre-compile. */
    get prepassMaterial() { return normalMat; },
  };
}
