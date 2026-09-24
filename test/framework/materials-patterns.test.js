import * as THREE from "three";
import { expect, test } from "vitest";
import { applyPattern } from "../../src/framework/materials/patterns.js";
import { ensureBoxUVs } from "../../src/framework/materials/uv.js";

const fakeShader = () => ({
  uniforms: {},
  vertexShader: "#include <common>\nvoid main(){\n#include <begin_vertex>\n#include <worldpos_vertex>\n}",
  fragmentShader: "#include <common>\nvoid main(){\n#include <map_fragment>\n#include <roughnessmap_fragment>\n}",
});

test("layer-lines injects object-space varyings and a print-frame uniform", () => {
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "layer-lines", scale: 0.2, printFrame: new Array(16).fill(0).map((_, i) => (i % 5 ? 0 : 1)) });
  const s = fakeShader();
  m.onBeforeCompile(s);
  expect(s.vertexShader).toContain("vPfObjPos");
  expect(s.fragmentShader).toContain("pfPrintFrame");
  expect(s.uniforms.pfPrintFrame.value).toBeInstanceOf(THREE.Matrix4);
  expect(s.uniforms.pfPatternScale.value).toBe(0.2);
  expect(m.customProgramCacheKey()).toContain("layer-lines");
});

test("triplanar kinds sample a texture with object-space blend weights", () => {
  const tex = new THREE.Texture();
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "wood", scale: 80, texture: tex });
  const s = fakeShader();
  m.onBeforeCompile(s);
  expect(s.fragmentShader).toContain("pfTriplanar");
  expect(s.uniforms.pfPatternMap.value).toBe(tex);
});

test("no pattern leaves the material alone", () => {
  const m = new THREE.MeshPhysicalMaterial();
  applyPattern(m, { kind: null });
  expect(m.onBeforeCompile.toString()).not.toContain("pf");
});

test("different kinds get different program cache keys", () => {
  const a = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "layer-lines", scale: 0.2 });
  const b = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "sls-grain", scale: 0.15 });
  expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
});

test("ensureBoxUVs adds a uv per vertex once and leaves positions alone", () => {
  const g = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  g.deleteAttribute("uv");
  const before = g.attributes.position.array.slice();
  ensureBoxUVs(g);
  expect(g.attributes.uv.count).toBe(g.attributes.position.count);
  expect(g.attributes.position.array).toEqual(before);
  const uv = g.attributes.uv;
  ensureBoxUVs(g);
  expect(g.attributes.uv).toBe(uv);
});

// Layers are 0.2 mm: at an ordinary viewing distance several fall in one
// pixel, and point-sampling them aliased into moiré. The shader filters by
// screen-space frequency (fwidth), fading each band to the period's mean.
test("layer lines fade to their mean where a layer is too fine for the pixel grid", () => {
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "layer-lines", scale: 0.2 });
  const s = fakeShader();
  m.onBeforeCompile(s);
  expect(s.fragmentShader).toMatch(/fwidth\(\s*h\s*\)/);
  // The fade target is the band's exact average over one period: grooves over
  // 35% of it ramp 0→1 (mean 0.5), the rest is flat 1 — 0.175 + 0.65.
  expect(s.fragmentShader).toContain("mix(0.825, groove,");
});

// A mask's modulation is centred on the texture's own mean, so where the
// texture is mipmapped down to its average (a far swatch) the multiplier is 1
// and the preset colour shows as defined.
test("carbon modulates around its texture's mean", () => {
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "carbon", scale: 10, texture: new THREE.Texture() });
  const s = fakeShader();
  m.onBeforeCompile(s);
  expect(s.fragmentShader).toContain("(l - 0.171)");
});

test("wood samples its colour and roughness maps triplanar, roughness around the map's mean", () => {
  const maps = { texture: new THREE.Texture(), normalMap: new THREE.Texture(), roughnessMap: new THREE.Texture() };
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "wood", scale: 250, ...maps, roughnessMean: 0.53, normalScale: 2.5 });
  const s = fakeShader();
  m.onBeforeCompile(s);
  expect(s.fragmentShader).toContain("diffuseColor.rgb *= pfTriplanar(pfPatternMap");
  expect(s.fragmentShader).toContain("pfTriplanar(pfRoughMap");
  expect(s.fragmentShader).toContain("/ pfRoughMean");
  expect(s.uniforms.pfPatternMap.value).toBe(maps.texture);
  expect(s.uniforms.pfNormalMap.value).toBe(maps.normalMap);
  expect(s.uniforms.pfRoughMap.value).toBe(maps.roughnessMap);
  expect(s.uniforms.pfRoughMean.value).toBeCloseTo(0.53);
  expect(s.uniforms.pfNormalStrength.value).toBeCloseTo(2.5);
});

test("layer lines carry filament mottling noise", () => {
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "layer-lines", scale: 0.2 });
  const s = fakeShader();
  m.onBeforeCompile(s);
  expect(s.fragmentShader).toContain("mottle");
});

test("layer lines tilt the surface normal along the print direction (a procedural normal map)", () => {
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "layer-lines", scale: 0.2 });
  const s = {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main(){\n#include <begin_vertex>\n}",
    fragmentShader: "#include <common>\nvoid main(){\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n}",
  };
  m.onBeforeCompile(s);
  expect(s.vertexShader).toContain("vPfPrintUpView = normalMatrix *");
  const afterNormals = s.fragmentShader.slice(s.fragmentShader.indexOf("#include <normal_fragment_maps>"));
  expect(afterNormals).toContain("normal = normalize(normal +");
  // The tilt scales with how steeply the surface cuts across the layers. A
  // normalised direction gave flat tops a full-strength tilt from rounding noise.
  expect(afterNormals).toContain("normal + along * slope");
  expect(afterNormals).not.toContain("along / alongLen");
});

// Wood's normal map is triplanar too: three tangent-space samples, whiteout-
// blended into an OBJECT-space normal, carried to view space (where three's
// \`normal\` lives after <normal_fragment_maps>) by the normal matrix, which the
// fragment stage only has through varyings.
test("wood replaces the view-space normal with a triplanar, whiteout-blended normal map", () => {
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "wood", scale: 250, texture: new THREE.Texture(), normalMap: new THREE.Texture() });
  const s = { uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>" };
  m.onBeforeCompile(s);
  expect(s.vertexShader).toContain("vPfNmX = normalMatrix[0]");
  expect(s.fragmentShader).toContain("pfTriplanarNormal");
  expect(s.fragmentShader).toContain("abs(tx.z) * n.x");
  const afterNormals = s.fragmentShader.slice(s.fragmentShader.indexOf("#include <normal_fragment_maps>"));
  expect(afterNormals).toContain("normal = normalize(mat3(vPfNmX, vPfNmY, vPfNmZ) * pfObjN)");
  expect(afterNormals).toContain("faceDirection");
});

test("only wood declares the normal and roughness samplers", () => {
  for (const kind of ["layer-lines", "sls-grain", "carbon"]) {
    const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind, scale: 1, texture: new THREE.Texture() });
    const s = fakeShader();
    m.onBeforeCompile(s);
    expect(s.fragmentShader, kind).not.toContain("pfNormalMap");
    expect(s.vertexShader, kind).not.toContain("vPfNmX");
  }
});
