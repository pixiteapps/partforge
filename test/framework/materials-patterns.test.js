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
