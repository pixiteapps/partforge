// The ONE shader-injection module (onBeforeCompile). Everything a future TSL /
// WebGPU port would have to rewrite lives here and nowhere else.
//
// All patterns work in OBJECT space (the sub-part's delivered mesh frame), so
// they move with the sub-part under animation and never slide when the camera
// moves. Layer lines additionally map object space through `pfPrintFrame`
// (print-frame.js: display→export), so they run the way the part will print.
import * as THREE from "three";

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
varying vec3 vPfNmX;
varying vec3 vPfNmY;
varying vec3 vPfNmZ;
vec3 pfTriplanarWeights(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
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
  vec3 tx = texture2D(pfNormalMap, p.yz / scale).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(pfNormalMap, p.xz / scale).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(pfNormalMap, p.xy / scale).xyz * 2.0 - 1.0;
  tx.xy *= pfNormalStrength; ty.xy *= pfNormalStrength; tz.xy *= pfNormalStrength;
  tx = vec3(tx.xy + n.yz, abs(tx.z) * n.x);   // uv = (y, z), face axis x
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);   // uv = (x, z), face axis y
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);   // uv = (x, y), face axis z
  return normalize(tx.zxy * w.x + ty.xzy * w.y + tz.xyz * w.z);
}
`;

// Per-kind fragment code, injected after <roughnessmap_fragment> so it can
// modulate both diffuseColor (already written by <map_fragment>) and roughnessFactor.
const FRAG_BODY = {
  "layer-lines": `
  {
    float h = (pfPrintFrame * vec4(vPfObjPos, 1.0)).z / pfPatternScale;
    float ridge = abs(fract(h) - 0.5) * 2.0;            // 0 at a layer seam, 1 mid-layer
    float groove = smoothstep(0.0, 0.35, ridge);
    // Anti-alias: fwidth(h) is layers per pixel. Where a layer spans fewer
    // than ~6 px the band fades to its mean over a period (0.825: the groove
    // ramps over 35% of it, the rest is flat), and past ~2.5 px it is gone —
    // point-sampling finer layers than that is what aliased into moiré.
    groove = mix(0.825, groove, 1.0 - smoothstep(0.16, 0.4, fwidth(h)));
    diffuseColor.rgb *= mix(0.9, 1.0, groove); // the normal map (FRAG_NORMAL) carries most of the relief
    roughnessFactor = clamp(roughnessFactor + (1.0 - groove) * 0.18, 0.0, 1.0);
    // Filament mottling: a fine grain (~0.17 mm) over slow blotches (~2 mm),
    // fixed to the part, so a print doesn't read as flat injection-moulded plastic.
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
  wood: `
  {
    vec3 pfN = normalize(vPfObjNormal);
    diffuseColor.rgb *= pfTriplanar(pfPatternMap, vPfObjPos, pfN, pfPatternScale);
    float r = pfTriplanar(pfRoughMap, vPfObjPos, pfN, pfPatternScale).g;
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
// (tops and bottoms) get no ridges, as on a real print. Same fwidth fade as the
// colour bands, so far-away layers don't alias.
const FRAG_NORMAL = {
  "layer-lines": `
  {
    float h = (pfPrintFrame * vec4(vPfObjPos, 1.0)).z / pfPatternScale;
    float aa = 1.0 - smoothstep(0.16, 0.4, fwidth(h));
    float t = fract(h) * 2.0 - 1.0;                       // -1 at a seam, 0 bead crest, 1 next seam
    float slope = clamp(t / sqrt(max(1.0 - t * t, 0.04)), -3.0, 3.0);
    vec3 up = normalize(vPfPrintUpView);
    // NOT normalised: its length is how steeply the surface cuts across the
    // layers (1 on a vertical wall, 0 on a face parallel to them), so ridges fade
    // out on tops and bottoms. Normalising it once made a flat top pick up a
    // full-strength tilt in a direction set by rounding noise, flipping sign
    // wherever the face sat on a layer boundary — a visible patch.
    vec3 along = up - normal * dot(normal, up);
    normal = normalize(normal + along * slope * 0.35 * aa);
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

export function applyPattern(material, { kind, scale = 1, printFrame, texture, normalMap, roughnessMap, roughnessMean = 0.5, normalScale = 1 } = {}) {
  if (!kind || !FRAG_BODY[kind]) return material;
  const wood = kind === "wood";
  const uniforms = {
    pfPatternScale: { value: scale },
    pfPrintFrame: { value: new THREE.Matrix4().fromArray(printFrame ?? new THREE.Matrix4().toArray()) },
    pfPatternMap: { value: texture ?? null },
    ...(wood ? {
      pfNormalMap: { value: normalMap ?? null },
      pfRoughMap: { value: roughnessMap ?? null },
      pfRoughMean: { value: roughnessMean },
      pfNormalStrength: { value: normalScale },
    } : {}),
  };
  material.userData.patternUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_DECL}${wood ? VERT_DECL_NM : ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERT_BODY}${wood ? VERT_BODY_NM : ""}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_DECL}${wood ? FRAG_DECL_WOOD : ""}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${FRAG_BODY[kind]}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${FRAG_NORMAL[kind] ?? ""}`);
  };
  material.customProgramCacheKey = () => `pf-pattern:${kind}`;
  material.needsUpdate = true;
  return material;
}
