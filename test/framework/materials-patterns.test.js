import * as THREE from "three";
import { expect, test } from "vitest";
import { applyPattern } from "../../src/framework/materials/patterns.js";
import { ensureBoxUVs } from "../../src/framework/materials/uv.js";
import { applyBrushFrame, grainAxisFor, grainSwaps, setGrainAxis } from "../../src/framework/materials/patterns.js";
import { buildPhysicalMaterial } from "../../src/framework/materials/physical.js";

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

// Brushed metal follows the tangent attribute. Without one three derives the frame
// per triangle from UV derivatives, and a curved surface (a fillet, a sphere
// corner) brushed as a patchwork of flat facets.
test("ensureBoxUVs adds smooth unit brush tangents in the tangent plane", () => {
  const g = new THREE.SphereGeometry(10, 48, 32).toNonIndexed();
  ensureBoxUVs(g);
  const t = g.attributes.tangent, n = g.attributes.normal;
  expect(t.itemSize).toBe(4);
  expect(t.count).toBe(g.attributes.position.count);
  // coincident corners on a smooth surface share a normal — they must share a
  // tangent too, or the brush would step at the shared edge
  const byPos = new Map();
  for (let i = 0; i < t.count; i++) {
    const tv = [t.getX(i), t.getY(i), t.getZ(i)];
    expect(Math.hypot(...tv)).toBeCloseTo(1, 5);
    expect(Math.abs(tv[0] * n.getX(i) + tv[1] * n.getY(i) + tv[2] * n.getZ(i))).toBeLessThan(1e-5);
    const key = [0, 1, 2].map((j) => g.attributes.position.array[i * 3 + j].toFixed(4)).join();
    const prev = byPos.get(key);
    if (prev) tv.forEach((q, j) => expect(q).toBeCloseTo(prev[j], 5)); else byPos.set(key, tv);
  }
  const before = t;
  ensureBoxUVs(g);
  expect(g.attributes.tangent).toBe(before);
});

// The brush direction is picked per pixel, so where it has to turn it follows the
// smooth dominant-axis contour instead of the triangulation (a staircase across a
// fillet corner's small facets when it rode the per-vertex tangent).
test("brushed metal rebuilds its tangent frame per pixel, after any pattern injection", () => {
  const m = buildPhysicalMaterial({ material: "brushed-stainless" });
  const s = { uniforms: {}, vertexShader: "#include <common>\nvoid main(){\n#include <begin_vertex>\n}",
    fragmentShader: "#include <common>\nvoid main(){\n#include <lights_physical_fragment>\n}" };
  m.onBeforeCompile(s);
  expect(s.vertexShader).toContain("vPfBrushN = normal;");
  const f = s.fragmentShader;
  expect(f.indexOf("tbn[0] = pfT;")).toBeGreaterThan(-1);
  expect(f.indexOf("tbn[0] = pfT;")).toBeLessThan(f.indexOf("#include <lights_physical_fragment>"));
  expect(m.customProgramCacheKey()).toContain("pf-brush");
  // non-brushed presets are untouched
  expect(buildPhysicalMaterial({ material: "polished-chrome" }).customProgramCacheKey()).not.toContain("pf-brush");
  // composes with an existing injection instead of replacing it
  const p = new THREE.MeshPhysicalMaterial();
  let ran = false;
  p.onBeforeCompile = () => { ran = true; };
  applyBrushFrame(p).onBeforeCompile({ uniforms: {}, vertexShader: "", fragmentShader: "" });
  expect(ran).toBe(true);
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
  expect(s.fragmentShader).toContain("diffuseColor.rgb *= pfTriplanarWood(pfPatternMap");
  expect(s.fragmentShader).toContain("pfTriplanarWood(pfRoughMap");
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

test("grainAxisFor picks the longest bounding-box axis, X on a tie", () => {
  const box = (x, y, z) => new THREE.Box3(new THREE.Vector3(-1, -2, -3), new THREE.Vector3(x - 1, y - 2, z - 3));
  expect(grainAxisFor(box(30, 30, 12))).toBe(0); // the swatch: X and Y tie
  expect(grainAxisFor(box(10, 50, 12))).toBe(1);
  expect(grainAxisFor(box(10, 10, 40))).toBe(2);
  expect(grainAxisFor(box(10, 40, 40))).toBe(1); // Y/Z tie goes to the lower axis
  expect(grainAxisFor(new THREE.Box3())).toBe(0);
  expect(grainAxisFor(null)).toBe(0);
});

// Each projection samples (u, v) = X-faces (y, z), Y-faces (x, z), Z-faces (x, y).
// A face containing the grain axis is transposed when that axis would otherwise
// land on the texture axis the grain does NOT run along; the face across the
// grain axis (end grain) is left alone.
test("grainSwaps lays the texture's grain along the grain axis on every face containing it", () => {
  const along = (axis, grain) => grainSwaps(axis, grain).map((swap, face) => {
    if (face === axis) return null;
    const uv = [[1, 2], [0, 2], [0, 1]][face];
    const [u, v] = swap ? [uv[1], uv[0]] : uv;
    return grain === "v" ? v : u; // the object axis the texture's grain runs along
  });
  for (const grain of ["u", "v"]) {
    for (const axis of [0, 1, 2]) {
      expect(along(axis, grain).filter((a) => a !== null), `${grain} ${axis}`).toEqual([axis, axis]);
      expect(grainSwaps(axis, grain)[axis]).toBe(0);
    }
  }
});

test("wood transposes each projection's UVs and normal-map slopes together", () => {
  const m = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "wood", scale: 250, texture: new THREE.Texture(), normalMap: new THREE.Texture(), grain: "v" });
  const s = { uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>" };
  m.onBeforeCompile(s);
  expect(s.fragmentShader).toContain("pfTriplanarWood(pfPatternMap");
  expect(s.fragmentShader).toContain("pfTriplanarWood(pfRoughMap");
  expect(s.fragmentShader).toContain("pfGrainUv(p.yz, pfGrainSwap.x)");
  expect(s.fragmentShader).toContain("tx.xy = pfGrainUv(tx.xy, pfGrainSwap.x)");
  // shared uniforms: a later axis change reaches the compiled program
  setGrainAxis(m, 2);
  expect(s.uniforms.pfGrainSwap.value.toArray()).toEqual(grainSwaps(2, "v"));
  // other kinds carry no grain uniform, and setGrainAxis leaves them alone
  const c = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "carbon", scale: 10, texture: new THREE.Texture() });
  setGrainAxis(c, 1);
  expect(c.userData.patternUniforms.pfGrainSwap).toBeUndefined();
});
