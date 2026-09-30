// The ONE shader-injection module (onBeforeCompile). Everything a future TSL /
// WebGPU port would have to rewrite lives here and nowhere else.
//
// All patterns work in OBJECT space (the sub-part's delivered mesh frame), so
// they move with the sub-part under animation and never slide when the camera
// moves. Layer lines additionally map object space through `pfPrintFrame`
// (print-frame.js: display→export), so they run the way the part will print.
// A laser-cut wood sheet's burn (applyBurn) composes over the wood pass in the sheet's
// canonical frame (sheet-look.js).
import * as THREE from "three";
import { BURN, srgbToLinear } from "./sheet-look.js";

const VERT_DECL = "varying vec3 vPfObjPos;\nvarying vec3 vPfObjNormal;\nvarying vec3 vPfPrintUpView;\nuniform mat4 pfPrintFrame;\n";
// Wood's triplanar normal map builds its normal in OBJECT space; the fragment
// stage has no normalMatrix, so its three columns ride along as varyings.
const VERT_DECL_NM = "varying vec3 vPfNmX;\nvarying vec3 vPfNmY;\nvarying vec3 vPfNmZ;\n";
const VERT_BODY_NM = "vPfNmX = normalMatrix[0];\nvPfNmY = normalMatrix[1];\nvPfNmZ = normalMatrix[2];\n";
// vPfPrintUpView: the print direction (export +Z) in VIEW space — the gradient
// of the layer height, carried by normalMatrix like any other normal — so the
// layer-line normal map can tilt normals along it (identity print frame for the
// other patterns, which never read it).
const VERT_BODY = "vPfObjPos = position;\nvPfObjNormal = normal;\nvPfPrintUpView = normalMatrix * vec3(pfPrintFrame[0].z, pfPrintFrame[1].z, pfPrintFrame[2].z);\n";

const FRAG_DECL = `
varying vec3 vPfObjPos;
varying vec3 vPfObjNormal;
varying vec3 vPfPrintUpView;
uniform float pfPatternScale;
uniform mat4 pfPrintFrame;
uniform sampler2D pfPatternMap;
float pfHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float pfNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(pfHash(i), pfHash(i + vec3(1,0,0)), f.x), mix(pfHash(i + vec3(0,1,0)), pfHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(pfHash(i + vec3(0,0,1)), pfHash(i + vec3(1,0,1)), f.x), mix(pfHash(i + vec3(0,1,1)), pfHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec3 pfTriplanar(sampler2D map, vec3 p, vec3 n, float scale) {
  vec3 w = pow(abs(normalize(n)), vec3(4.0)); w /= (w.x + w.y + w.z);
  return texture2D(map, p.yz / scale).rgb * w.x + texture2D(map, p.xz / scale).rgb * w.y + texture2D(map, p.xy / scale).rgb * w.z;
}
`;

// Extra declarations only the wood kind needs: its normal and roughness maps and
// the normal-matrix varyings. Kept out of FRAG_DECL so the other kinds don't bind
// two empty samplers.
const FRAG_DECL_WOOD = `
uniform sampler2D pfNormalMap;
uniform sampler2D pfRoughMap;
uniform float pfRoughMean;
uniform float pfNormalStrength;
uniform vec3 pfGrainSwap;
varying vec3 vPfNmX;
varying vec3 vPfNmY;
varying vec3 vPfNmZ;
vec3 pfTriplanarWeights(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
// One grain direction on every face: each projection's UV pair is transposed
// where pfGrainSwap says so (grainSwaps below), so the texture's grain lands on
// the sub-part's grain axis. A transpose is a mirror, not a rotation, which is
// what keeps the normal map exact: its slopes just swap axes (t.yx), no signs.
vec2 pfGrainUv(vec2 ab, float s) { return mix(ab, ab.yx, s); }
vec3 pfTriplanarWood(sampler2D map, vec3 p, vec3 n) {
  vec3 w = pfTriplanarWeights(n);
  return texture2D(map, pfGrainUv(p.yz, pfGrainSwap.x) / pfPatternScale).rgb * w.x
       + texture2D(map, pfGrainUv(p.xz, pfGrainSwap.y) / pfPatternScale).rgb * w.y
       + texture2D(map, pfGrainUv(p.xy, pfGrainSwap.z) / pfPatternScale).rgb * w.z;
}
// Triplanar tangent-space normal map, whiteout-blended (Golus, "Normal Mapping
// for a Triplanar Shader"). Each projection's map is read as a height field over
// the two object axes its UVs run along, so its tangent normal (x, y) is a slope
// along those axes and z points along the face's own axis — the whiteout form
// (t.xy + n.<uv axes>, |t.z| * n.<face axis>) needs no per-side sign flips: on
// the back face n.<face axis> is negative and the swizzle follows the same height
// field, so light still catches the same grain. OpenGL-format maps (+Y up), the
// Poly Haven "nor_gl" convention. Returns an OBJECT-space unit normal.
vec3 pfTriplanarNormal(vec3 p, vec3 n, float scale) {
  vec3 w = pfTriplanarWeights(n);
  vec3 tx = texture2D(pfNormalMap, pfGrainUv(p.yz, pfGrainSwap.x) / scale).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(pfNormalMap, pfGrainUv(p.xz, pfGrainSwap.y) / scale).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(pfNormalMap, pfGrainUv(p.xy, pfGrainSwap.z) / scale).xyz * 2.0 - 1.0;
  // a transposed sample's slopes run along the swapped axes
  tx.xy = pfGrainUv(tx.xy, pfGrainSwap.x) * pfNormalStrength;
  ty.xy = pfGrainUv(ty.xy, pfGrainSwap.y) * pfNormalStrength;
  tz.xy = pfGrainUv(tz.xy, pfGrainSwap.z) * pfNormalStrength;
  tx = vec3(tx.xy + n.yz, abs(tx.z) * n.x);   // uv = (y, z), face axis x
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);   // uv = (x, z), face axis y
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);   // uv = (x, y), face axis z
  return normalize(tx.zxy * w.x + ty.xzy * w.y + tz.xyz * w.z);
}
`;

// Layer lines are 0.2 mm, so at an ordinary viewing distance a layer spans a
// few pixels or less, and point-sampling the bead profile per pixel aliased
// into moiré (worst in the specular, through the bead normals). So one layer's
// profile is baked into a small repeating texture sampled by layer height, and
// the GPU's mipmaps band-limit it. Channels: R = groove shade, G = bead slope
// (encoded slope/6 + 0.5), B = slope^2 / 9. A mip level averages G and B
// separately, so B - G^2 is the slope VARIANCE inside the pixel — the ridges it
// can no longer show — which widens the specular lobe instead (Toksvig / LEAN
// mapping), so a far wall keeps its satin sheen rather than turning glossy.
export const LAYER_PROFILE_WIDTH = 256;
// Gradient scale on the profile lookup (+0.58 mip). A box-filtered mip chain at
// 1x still carries the full fundamental at 2 px per layer (its 2-texel level),
// right at Nyquist, which banded across a whole-part view; 1.5 clears that and
// keeps the lines crisp close up (2 visibly softened them).
const LAYER_BLUR = "1.5";

// One layer's bead, t running -1 (a seam) through 0 (the crest) to 1 (the next
// seam): the groove shade darkens the 35% of each half-bead nearest a seam, and
// the slope is a round bead's (t / sqrt(1 - t^2)), clamped to ±3 where it goes
// vertical. (The procedural version darkened the CREST instead — its ridge was
// |t|, not 1 - |t| — half a layer off the valleys its own normals drew.)
export function layerProfileData(width = LAYER_PROFILE_WIDTH) {
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const t = ((i + 0.5) / width) * 2 - 1;
    const g = Math.min(1, (1 - Math.abs(t)) / 0.35);
    const groove = g * g * (3 - 2 * g);
    const slope = Math.min(3, Math.max(-3, t / Math.sqrt(Math.max(1 - t * t, 0.04))));
    data[i * 4] = Math.round(groove * 255);
    data[i * 4 + 1] = Math.round((slope / 6 + 0.5) * 255);
    data[i * 4 + 2] = Math.round((slope * slope / 9) * 255);
    data[i * 4 + 3] = 255;
  }
  return data;
}

// One texture shared by every layer-lines material, built on first use.
let layerProfileTex = null;
function layerProfileTexture() {
  if (layerProfileTex) return layerProfileTex;
  const t = new THREE.DataTexture(layerProfileData(), LAYER_PROFILE_WIDTH, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return (layerProfileTex = t);
}

const FRAG_DECL_LAYERS = "uniform sampler2D pfLayerMap;\n";

// Per-kind fragment code, injected after <roughnessmap_fragment> so it can
// modulate both diffuseColor (already written by <map_fragment>) and roughnessFactor.
const FRAG_BODY = {
  // Declared at main() scope, not in a block: FRAG_NORMAL reads the same
  // profile sample (pfLayer) rather than looking it up again.
  "layer-lines": `
  float pfH = (pfPrintFrame * vec4(vPfObjPos, 1.0)).z / pfPatternScale;   // in layers
  // fract() keeps the texel coordinate small (hundreds of layers x 256 texels
  // loses sub-texel precision in the sampler); the explicit gradients are the
  // unwrapped height's, so the wrap at each seam doesn't drop to the 1x1 mip.
  vec4 pfLayer = textureGrad(pfLayerMap, vec2(fract(pfH), 0.5),
    vec2(dFdx(pfH) * ${LAYER_BLUR}, 0.0), vec2(dFdy(pfH) * ${LAYER_BLUR}, 0.0));
  {
    float groove = pfLayer.r;
    diffuseColor.rgb *= mix(0.9, 1.0, groove); // the normal map (FRAG_NORMAL) carries most of the relief
    roughnessFactor = clamp(roughnessFactor + (1.0 - groove) * 0.18, 0.0, 1.0);
    // Filament mottling: a fine grain (~0.17 mm) over slow blotches (~2 mm),
    // fixed to the part, so a print doesn't read as flat injection-moulded plastic.
    // Hash noise, not a noise volume: a mipmapped 64^3 texture measured ~10%
    // slower per frame on an M1 Max (a filtered 3D fetch reads 16 texels).
    float mottle = pfNoise(vPfObjPos * 6.0) * 0.6 + pfNoise(vPfObjPos * 0.51) * 0.4;
    diffuseColor.rgb *= mix(0.893, 1.047, mottle);
    roughnessFactor = clamp(roughnessFactor + (mottle - 0.5) * 0.084, 0.0, 1.0);
  }`,
  "sls-grain": `
  {
    float g = pfNoise(vPfObjPos / pfPatternScale);
    diffuseColor.rgb *= mix(0.92, 1.04, g);
    roughnessFactor = clamp(roughnessFactor + (g - 0.5) * 0.1, 0.0, 1.0);
  }`,
  // Wood is a full PBR set sampled triplanar in object space: the colour map
  // (sRGB, so already linear here) multiplies diffuseColor — white unless the
  // author tinted it, physical.js — and the roughness map varies roughnessFactor
  // around the preset's value (divided by the map's own mean, so the preset sets
  // the average). Mipmaps (and RepeatWrapping) do the far-distance filtering.
  // All three maps follow the grain axis (pfTriplanarWood / setGrainAxis).
  wood: `
  {
    vec3 pfN = normalize(vPfObjNormal);
    diffuseColor.rgb *= pfTriplanarWood(pfPatternMap, vPfObjPos, pfN);
    float r = pfTriplanarWood(pfRoughMap, vPfObjPos, pfN).g;
    roughnessFactor = clamp(roughnessFactor * r / pfRoughMean, 0.02, 1.0);
  }`,
  // Carbon samples a luminance MASK (raw, not sRGB-decoded: physical.js) and
  // modulates around the texture's own mean (0.171; its spread is ~0.06), so a
  // mipmapped far swatch keeps its preset colour and the weave reads at full
  // contrast up close.
  carbon: `
  {
    vec3 t = pfTriplanar(pfPatternMap, vPfObjPos, vPfObjNormal, pfPatternScale);
    float l = dot(t, vec3(0.2126, 0.7152, 0.0722));
    float n = clamp((l - 0.171) / 0.06, -1.0, 1.0);
    diffuseColor.rgb *= 1.0 + n * 0.75;
    roughnessFactor = clamp(roughnessFactor - n * 0.2, 0.0, 1.0);
  }`,
  concrete: `
  {
    vec3 t = pfTriplanar(pfPatternMap, vPfObjPos, vPfObjNormal, pfPatternScale);
    diffuseColor.rgb *= t * 1.4;
  }`,
};

// Per-kind NORMAL perturbation, injected after <normal_fragment_maps> (where the
// view-space \`normal\` is final). Layer lines are a procedural normal map: each
// layer is a round bead, so across one layer the surface normal swings from
// facing down (bottom of the bead) through straight out to facing up, along
// the print direction projected onto the surface. Faces parallel to the layers
// (tops and bottoms) get no ridges, as on a real print. The slope comes from the
// same mip-filtered profile sample as the colour bands, and the slope variance
// the filter averaged away goes into roughness: alpha^2 += var(tilt).
const FRAG_NORMAL = {
  "layer-lines": `
  {
    float slope = pfLayer.g * 6.0 - 3.0;
    float slopeVar = max(pfLayer.b * 9.0 - slope * slope, 0.0);
    vec3 up = normalize(vPfPrintUpView);
    // NOT normalised: its length is how steeply the surface cuts across the
    // layers (1 on a vertical wall, 0 on a face parallel to them), so ridges fade
    // out on tops and bottoms. Normalising it once made a flat top pick up a
    // full-strength tilt in a direction set by rounding noise, flipping sign
    // wherever the face sat on a layer boundary — a visible patch.
    vec3 along = up - normal * dot(normal, up);
    normal = normalize(normal + along * slope * 0.35);
    // tilt = slope * 0.35 * |along|, so var(tilt) = slopeVar * 0.35^2 * |along|^2
    float a = roughnessFactor * roughnessFactor;
    roughnessFactor = min(sqrt(sqrt(a * a + slopeVar * 0.1225 * dot(along, along))), 1.0);
  }`,
  // Wood replaces the view-space normal with its triplanar normal map, built in
  // object space and carried to view space through the normal matrix. A
  // double-sided back face is flipped the way <normal_fragment_begin> flips it.
  wood: `
  {
    vec3 pfObjN = pfTriplanarNormal(vPfObjPos, normalize(vPfObjNormal), pfPatternScale);
    normal = normalize(mat3(vPfNmX, vPfNmY, vPfNmZ) * pfObjN);
    #ifdef DOUBLE_SIDED
      normal *= faceDirection;
    #endif
  }`,
};

// Wood grain: real wood has ONE grain direction, the board's long axis, but a
// triplanar projection with fixed UVs (X-faces (y, z), Y-faces (x, z), Z-faces
// (x, y)) lands the texture's grain on a different object axis per face — on a
// block, adjacent faces showed grain at right angles. So each sub-part gets a
// grain axis (its longest object-space bounding-box axis, X on a tie) and every
// projection whose face CONTAINS that axis is transposed where needed so the
// texture's grain runs along it. Faces across the axis are end grain; there is
// no end-grain texture, so they keep the default sample.
//
// `grain` is which texture axis a scan's figure runs along ("u" horizontal, "v"
// vertical in the image), declared per texture set in presets.js.
const PLANE_AXES = [[1, 2], [0, 2], [0, 1]]; // each projection's (u, v) object axes
export function grainAxisFor(box) {
  if (!box || box.isEmpty?.()) return 0;
  const s = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
  const eps = Math.max(...s) * 1e-6;
  let axis = 0;
  for (let i = 1; i < 3; i++) if (s[i] > s[axis] + eps) axis = i;
  return axis;
}
export function grainSwaps(axis, grain = "u") {
  const want = grain === "v" ? 1 : 0;
  return PLANE_AXES.map(([u], face) => (face === axis ? 0 : (axis === u ? 0 : 1) !== want ? 1 : 0));
}
// Point a wood material (and every clone sharing its uniforms) at a grain axis.
// A no-op on any other material.
export function setGrainAxis(material, axis) {
  const u = material?.userData?.patternUniforms?.pfGrainSwap;
  if (!u) return;
  material.userData.pfGrainAxis = axis;
  u.value.fromArray(grainSwaps(axis, material.userData.pfGrain));
}

export function applyPattern(material, { kind, scale = 1, printFrame, texture, normalMap, roughnessMap, roughnessMean = 0.5, normalScale = 1, grain = "u" } = {}) {
  if (!kind || !FRAG_BODY[kind]) return material;
  const wood = kind === "wood";
  const layers = kind === "layer-lines";
  const uniforms = {
    ...(layers ? {
      pfLayerMap: { value: layerProfileTexture() },
    } : {}),
    pfPatternScale: { value: scale },
    pfPrintFrame: { value: new THREE.Matrix4().fromArray(printFrame ?? new THREE.Matrix4().toArray()) },
    pfPatternMap: { value: texture ?? null },
    ...(wood ? {
      pfNormalMap: { value: normalMap ?? null },
      pfRoughMap: { value: roughnessMap ?? null },
      pfRoughMean: { value: roughnessMean },
      pfNormalStrength: { value: normalScale },
      pfGrainSwap: { value: new THREE.Vector3() },
    } : {}),
  };
  material.userData.patternUniforms = uniforms;
  if (wood) { material.userData.pfGrain = grain; setGrainAxis(material, 0); }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_DECL}${wood ? VERT_DECL_NM : ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERT_BODY}${wood ? VERT_BODY_NM : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_DECL}${wood ? FRAG_DECL_WOOD : ""}${layers ? FRAG_DECL_LAYERS : ""}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${FRAG_BODY[kind]}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAG_NORMAL[kind] ?? ""}`);
  };
  material.customProgramCacheKey = () => `pf-pattern:${kind}`;
  material.needsUpdate = true;
  return material;
}

// Brush frame for anisotropic (brushed) metal, chosen PER PIXEL. three follows the
// tangent frame `tbn`; built from per-vertex data it interpolates across each
// triangle, so wherever the brush direction has to turn (it must, somewhere, on
// any closed part) the turn followed the triangulation — a jagged staircase across
// a fillet corner's small facets. Here the box-projection rule (brush along object
// X, or along Y where X dominates the normal) runs on the interpolated object
// normal in the fragment, so the turn lands on the smooth |nx| = max(|ny|,|nz|)
// contour instead. The frame is rebuilt from the final shading `normal`, just
// before <lights_physical_fragment> reads it. Composes with a pattern's own
// injection (applied first) rather than replacing it.
const BRUSH_VERT_DECL = "varying vec3 vPfBrushN;\nvarying vec3 vPfBrushNmX;\nvarying vec3 vPfBrushNmY;\nvarying vec3 vPfBrushNmZ;\n";
const BRUSH_VERT_BODY = "vPfBrushN = normal;\nvPfBrushNmX = normalMatrix[0];\nvPfBrushNmY = normalMatrix[1];\nvPfBrushNmZ = normalMatrix[2];\n";
const BRUSH_FRAG_DECL = "varying vec3 vPfBrushN;\nvarying vec3 vPfBrushNmX;\nvarying vec3 vPfBrushNmY;\nvarying vec3 vPfBrushNmZ;\n";
const BRUSH_FRAG_BODY = `
  #ifdef USE_ANISOTROPY
  {
    vec3 pfN = normalize(vPfBrushN);
    vec3 pfA = abs(pfN);
    vec3 pfAxis = (pfA.x > pfA.y && pfA.x > pfA.z) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 pfT = mat3(vPfBrushNmX, vPfBrushNmY, vPfBrushNmZ) * (pfAxis - pfN * dot(pfAxis, pfN));
    pfT = pfT - normal * dot(normal, pfT);
    if (dot(pfT, pfT) > 1e-12) {
      pfT = normalize(pfT);
      tbn[0] = pfT;
      tbn[1] = cross(normal, pfT);
    }
  }
  #endif
`;

export function applyBrushFrame(material) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${BRUSH_VERT_DECL}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${BRUSH_VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${BRUSH_FRAG_DECL}`)
      .replace("#include <lights_physical_fragment>", `${BRUSH_FRAG_BODY}\n#include <lights_physical_fragment>`);
  };
  const base = prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey ? prevKey.call(material) : "";
  material.customProgramCacheKey = () => `${base}|pf-brush`;
  material.needsUpdate = true;
  return material;
}

// --- laser burns ------------------------------------------------------------------
// A laser-cut sheet in a wood shows what the laser did to it (sheet-look.js decides which
// sub-parts, and mount hands the viewer each one's canonical frame): cut walls charred,
// engrave and score floors scorched, faces untouched. Composes over the wood pass the way
// applyBrushFrame does, injecting at three points in three's meshphysical order:
//   (a) colour + roughness, before <normal_fragment_begin>: after wood's body (injected
//       after <roughnessmap_fragment>) and <metalnessmap_fragment>. A second replace of
//       <roughnessmap_fragment> would land IN FRONT of wood's body, so it is not reused.
//       pfBurnWall / pfBurnFloor are declared at main() scope, like pfLayer, for (b), (c).
//   (b) the normal, before <emissivemap_fragment>: after wood's normal map and the
//       clearcoat normals. Char has no grain, so the wood normal fades back to the
//       geometric one (nonPerturbedNormal, set by <normal_fragment_begin>).
//   (c) clearcoat, after <lights_physical_fragment>, which assigns material.clearcoat:
//       walnut's lacquer comes off the char.
// Every snippet sits between `// pf-burn {` and `// } pf-burn` lines: that is how the tests
// prove a burning program is the plain wood program plus these and nothing else. The
// vertex stage is untouched — the pass reads the varyings every pattern already has. With
// pfSheetT = 0 (no frame delivered yet) it draws plain wood. No noise term: an unfiltered
// striation would shimmer at part scale (the layer-lines lesson above).
const glf = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const CHARCOAL = srgbToLinear(BURN.charcoal);
const CHARCOAL_Y = 0.2126 * CHARCOAL[0] + 0.7152 * CHARCOAL[1] + 0.0722 * CHARCOAL[2];
const burnBlock = (glsl) => `// pf-burn {\n${glsl}\n// } pf-burn`;

const BURN_FRAG_DECL = burnBlock(`uniform mat4 pfSheetFrame;
uniform float pfSheetT;
uniform float pfPlies;
uniform vec3 pfFaceAvg;
// 1 on a cross ply (an odd one), 0 on a face-grain ply: the square wave box-filtered over
// the pixel (its integral, differenced across fwidth), so plies too thin to draw average
// out instead of shimmering.
float pfCrossPlyI(float x) { return floor(x * 0.5) + max(0.0, fract(x * 0.5) * 2.0 - 1.0); }
float pfCrossPly(float x) {
  float w = max(fwidth(x), 1e-4);
  return (pfCrossPlyI(x + 0.5 * w) - pfCrossPlyI(x - 0.5 * w)) / w;
}`);

const BURN_FRAG_BODY = burnBlock(`float pfBurnWall = 0.0;
float pfBurnFloor = 0.0;
if (pfSheetT > 0.0) {
  vec3 pfC = (pfSheetFrame * vec4(vPfObjPos, 1.0)).xyz;
  vec3 pfCn = normalize(mat3(pfSheetFrame) * vPfObjNormal);
  pfBurnWall = 1.0 - smoothstep(${glf(BURN.wallNz[0])}, ${glf(BURN.wallNz[1])}, abs(pfCn.z));
  pfBurnFloor = step(0.5, pfCn.z) * step(pfC.z, pfSheetT - ${glf(BURN.floorDepth)});
  float pfK = mix(${glf(BURN.kThin)}, ${glf(BURN.kThick)}, clamp((pfSheetT - ${glf(BURN.tThin)}) / ${glf(BURN.tThick - BURN.tThin)}, 0.0, 1.0));
  float pfZ = clamp(pfC.z / pfSheetT, 0.0, 1.0);
  vec3 pfFace = diffuse * pfFaceAvg;
  vec3 pfChar = vec3(${CHARCOAL.map((c) => c.toFixed(6)).join(", ")}) * min(1.0, ${glf(BURN.charOfDark)} * dot(pfFace, vec3(0.2126, 0.7152, 0.0722)) / ${CHARCOAL_Y.toFixed(6)});
  vec3 pfEdge = mix(pfFace, pfChar, min(1.0, pfK + ${glf(BURN.exit)} * (1.0 - pfZ)));
  if (pfPlies > 0.0) pfEdge *= mix(1.0, ${glf(BURN.crossPly)}, pfCrossPly(pfZ * pfPlies));
  vec3 pfMark = mix(pfFace, pfChar, pfK - ${glf(BURN.engraveLess)});
  diffuseColor.rgb = mix(diffuseColor.rgb, pfEdge, pfBurnWall);
  diffuseColor.rgb = mix(diffuseColor.rgb, pfMark, pfBurnFloor);
  roughnessFactor = mix(roughnessFactor, ${glf(BURN.roughness)}, max(pfBurnWall, pfBurnFloor));
}`);

const BURN_FRAG_NORMAL = burnBlock("normal = normalize(mix(normal, nonPerturbedNormal, max(pfBurnWall, pfBurnFloor)));");

const BURN_FRAG_CLEARCOAT = burnBlock(`#ifdef USE_CLEARCOAT
material.clearcoat *= 1.0 - max(pfBurnWall, pfBurnFloor);
#endif`);

// `faceAvg` is the preset's own colour (0xRRGGBB) — its texture's average, never the tint:
// the tint arrives as `diffuse`, so the shader's face colour is diffuse · pfFaceAvg.
export function applyBurn(material, { faceAvg }) {
  const uniforms = material.userData.patternUniforms;
  if (!uniforms?.pfGrainSwap) return material; // wood only: the burn draws over the wood pass
  Object.assign(uniforms, {
    pfSheetFrame: { value: new THREE.Matrix4() },
    pfSheetT: { value: 0 },
    pfPlies: { value: 0 },
    pfFaceAvg: { value: new THREE.Color(faceAvg) },
  });
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer); // applyPattern's hook copies `uniforms` — burn uniforms included
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${BURN_FRAG_DECL}`)
      .replace("#include <normal_fragment_begin>", `${BURN_FRAG_BODY}\n#include <normal_fragment_begin>`)
      .replace("#include <emissivemap_fragment>", `${BURN_FRAG_NORMAL}\n#include <emissivemap_fragment>`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>\n${BURN_FRAG_CLEARCOAT}`);
  };
  const base = prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey ? prevKey.call(material) : "";
  material.customProgramCacheKey = () => `${base}|pf-burn`;
  material.needsUpdate = true;
  return material;
}
