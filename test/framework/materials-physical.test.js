// test/framework/materials-physical.test.js
import * as THREE from "three";
import { expect, test } from "vitest";
import { buildPhysicalMaterial } from "../../src/framework/materials/physical.js";

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

test("textured presets load their pattern texture through the injected loader", () => {
  const seen = [];
  buildPhysicalMaterial({ material: "oak" }, { loadTexture: (f) => { seen.push(f); return new THREE.Texture(); } });
  expect(seen).toEqual(["pattern-wood.jpg"]);
});

test("no display → the default look, as a physical material", () => {
  const m = buildPhysicalMaterial(undefined, { loadTexture });
  expect(m.color.getHex()).toBe(0x9fb4cc);
});
