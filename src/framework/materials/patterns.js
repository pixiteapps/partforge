// The ONE shader-injection module (onBeforeCompile). Everything a future TSL /
// WebGPU port would have to rewrite lives here and nowhere else.
//
// All patterns work in OBJECT space (the sub-part's delivered mesh frame), so
// they move with the sub-part under animation and never slide when the camera
// moves. Layer lines additionally map object space through `pfPrintFrame`
// (print-frame.js: display→export), so they run the way the part will print.
import * as THREE from "three";

const VERT_DECL = "varying vec3 vPfObjPos;\nvarying vec3 vPfObjNormal;\n";
const VERT_BODY = "vPfObjPos = position;\nvPfObjNormal = normal;\n";

const FRAG_DECL = `
varying vec3 vPfObjPos;
varying vec3 vPfObjNormal;
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
    diffuseColor.rgb *= mix(0.8, 1.0, groove);
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
  // Wood and carbon sample luminance MASKS (raw, not sRGB-decoded: physical.js)
  // and modulate around the texture's own mean (0.238 wood, 0.171 carbon; their
  // spread is ~0.11 and ~0.06), so a mipmapped far swatch keeps its preset
  // colour and the grain/weave reads at full contrast up close.
  wood: `
  {
    vec3 t = pfTriplanar(pfPatternMap, vPfObjPos, vPfObjNormal, pfPatternScale);
    float l = dot(t, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb *= clamp(1.0 + (l - 0.238) * 4.0, 0.35, 1.6);
  }`,
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

export function applyPattern(material, { kind, scale = 1, printFrame, texture } = {}) {
  if (!kind || !FRAG_BODY[kind]) return material;
  const uniforms = {
    pfPatternScale: { value: scale },
    pfPrintFrame: { value: new THREE.Matrix4().fromArray(printFrame ?? new THREE.Matrix4().toArray()) },
    pfPatternMap: { value: texture ?? null },
  };
  material.userData.patternUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_DECL}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_DECL}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${FRAG_BODY[kind]}`);
  };
  material.customProgramCacheKey = () => `pf-pattern:${kind}`;
  material.needsUpdate = true;
  return material;
}
