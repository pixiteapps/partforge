// test/framework/materials-physical.test.js
import * as THREE from "three";
import { expect, test } from "vitest";
import { buildPhysicalMaterial } from "../../src/framework/materials/physical.js";
import { grainAxisFor, setGrainAxis } from "../../src/framework/materials/patterns.js";

const loadTexture = () => new THREE.Texture();

test("a preset becomes a MeshPhysicalMaterial with its measured values", () => {
  const m = buildPhysicalMaterial({ material: "brass" }, { loadTexture });
  expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial);
  expect(m.color.getHex()).toBe(0xf8dc82);
  expect(m.metalness).toBe(1);
  expect(m.roughness).toBeCloseTo(0.28);
});

test("tint and overrides apply; opacity makes a ghost", () => {
  const m = buildPhysicalMaterial({ material: "abs-plastic", color: 0xff0000, roughness: 0.2, opacity: 0.3 }, { loadTexture });
  expect(m.color.getHex()).toBe(0xff0000);
  expect(m.roughness).toBeCloseTo(0.2);
  expect(m.transparent).toBe(true);
  expect(m.opacity).toBeCloseTo(0.3);
  expect(m.depthWrite).toBe(false);
});

test("clear acrylic uses transmission and IOR", () => {
  const m = buildPhysicalMaterial({ material: "clear-acrylic" }, { loadTexture });
  expect(m.transmission).toBe(1);
  expect(m.ior).toBeCloseTo(1.49);
});

test("brushed presets are anisotropic and flag their geometry for UVs", () => {
  const m = buildPhysicalMaterial({ material: "brushed-aluminum" }, { loadTexture });
  expect(m.anisotropy).toBeCloseTo(0.7);
  expect(m.userData.pfAnisotropic).toBe(true);
});

test("wood presets load a full PBR set: colour as sRGB, normal and roughness as data", () => {
  for (const material of ["oak", "walnut"]) {
    const seen = {};
    const m = buildPhysicalMaterial({ material }, { loadTexture: (f) => (seen[f] = new THREE.Texture()) });
    expect(Object.keys(seen).sort()).toEqual([`pattern-${material}-color.jpg`, `pattern-${material}-normal.jpg`, `pattern-${material}-rough.jpg`]);
    expect(seen[`pattern-${material}-color.jpg`].colorSpace).toBe(THREE.SRGBColorSpace);
    expect(seen[`pattern-${material}-normal.jpg`].colorSpace).toBe(THREE.NoColorSpace);
    expect(seen[`pattern-${material}-rough.jpg`].colorSpace).toBe(THREE.NoColorSpace);
    for (const t of Object.values(seen)) expect(t.wrapS).toBe(THREE.RepeatWrapping);
    const u = m.userData.patternUniforms;
    expect(u.pfPatternMap.value).toBe(seen[`pattern-${material}-color.jpg`]);
    expect(u.pfNormalMap.value).toBe(seen[`pattern-${material}-normal.jpg`]);
    expect(u.pfRoughMap.value).toBe(seen[`pattern-${material}-rough.jpg`]);
  }
});

// The colour map carries the wood's colour; the preset colour is its average,
// kept for CAD and 3MF. An explicit colour still tints the map.
test("a wood material starts white so the map shows, and an explicit colour tints it", () => {
  expect(buildPhysicalMaterial({ material: "oak" }, { loadTexture }).color.getHex()).toBe(0xffffff);
  expect(buildPhysicalMaterial({ material: "walnut", color: 0x808080 }, { loadTexture }).color.getHex()).toBe(0x808080);
});

test("no display → the default look, as a physical material", () => {
  const m = buildPhysicalMaterial(undefined, { loadTexture });
  expect(m.color.getHex()).toBe(0x9fb4cc);
});

// The carbon texture is a luminance MASK, not a colour: decoding it as sRGB
// crushed its range to a few hundredths of linear light, and the weave vanished
// at swatch distance.
test("the carbon mask is sampled raw, not decoded as sRGB colour", () => {
  const seen = [];
  buildPhysicalMaterial({ material: "carbon-fiber" }, { loadTexture: (f) => { const t = new THREE.Texture(); seen.push([f, t]); return t; } });
  expect(seen.map(([f]) => f)).toEqual(["pattern-carbon.jpg"]);
  expect(seen[0][1].colorSpace).toBe(THREE.NoColorSpace);
  expect(seen[0][1].wrapS).toBe(THREE.RepeatWrapping);
});

test("prints are lit less by the environment and reflect less, so their colour holds", () => {
  const pla = buildPhysicalMaterial({ material: "pla-print", color: 0xe0592a }, { loadTexture });
  expect(pla.envMapIntensity).toBeCloseTo(0.6);
  expect(pla.specularIntensity).toBeCloseTo(0.5);
  const brass = buildPhysicalMaterial({ material: "brass" }, { loadTexture });
  expect(brass.envMapIntensity).toBe(1);
  expect(brass.specularIntensity).toBe(1);
});

// One grain direction per sub-part: a long-in-Y board lays each scan's figure
// along Y on every face that contains Y. Oak's figure runs up its image (v),
// walnut's across it (u), so the same board transposes different projections.
test("wood shaders receive the grain axis of a long-in-Y sub-part", () => {
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 80, 10));
  const swapsFor = (material) => {
    const m = buildPhysicalMaterial({ material }, { loadTexture });
    setGrainAxis(m, grainAxisFor(box));
    const s = { uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>" };
    m.onBeforeCompile(s);
    expect(m.userData.pfGrainAxis).toBe(1);
    return s.uniforms.pfGrainSwap.value.toArray();
  };
  expect(swapsFor("oak")).toEqual([1, 0, 0]);    // X-faces sample (y, z): y must go to v
  expect(swapsFor("walnut")).toEqual([0, 0, 1]); // Z-faces sample (x, y): y must go to u
});
