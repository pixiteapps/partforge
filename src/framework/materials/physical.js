// src/framework/materials/physical.js
// three.js materials from resolved library data. The CAD half keeps the viewer's
// MeshStandardMaterial and only swaps its numbers; the realistic half (Task 8)
// builds MeshPhysicalMaterial. Both read resolve.js, so the two modes can never
// disagree about which preset a sub-part is.
import * as THREE from "three";
import { cadAppearance, resolveMaterial } from "./resolve.js";
import { applyPattern } from "./patterns.js";
import { PATTERN_TEXTURES } from "./assets.js";

const APPEARANCE_KEYS = ["color", "opacity", "material", "roughness", "metalness", "clearcoat", "clearcoatRoughness", "anisotropy", "textureScale"];
const hasAppearance = (display) => !!display && APPEARANCE_KEYS.some((k) => display[k] != null);

export function buildCadMaterial(display, base) {
  if (!hasAppearance(display)) return base;
  const a = cadAppearance(display);
  const m = base.clone();
  m.color = new THREE.Color(a.color);
  m.metalness = a.metalness;
  m.roughness = a.roughness;
  if (a.opacity < 1) { m.transparent = true; m.opacity = a.opacity; m.depthWrite = false; }
  return m;
}

// Realistic-mode material. `loadTexture(fileName)` is injected (the viewer owns
// a caching TextureLoader), so this stays unit-testable without a network.
export function buildPhysicalMaterial(display, { printFrame, loadTexture } = {}) {
  const { params } = resolveMaterial(display);
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(params.color),
    metalness: params.metalness,
    roughness: params.roughness,
    clearcoat: params.clearcoat,
    clearcoatRoughness: params.clearcoatRoughness,
    transmission: params.transmission,
    thickness: params.thickness,
    ior: params.ior,
    anisotropy: params.anisotropy,
    envMapIntensity: params.envIntensity,
    specularIntensity: params.specularIntensity,
  });
  if (params.opacity < 1) { m.transparent = true; m.opacity = params.opacity; m.depthWrite = false; }
  m.userData.pfAnisotropic = params.anisotropy > 0;
  const textureFile = PATTERN_TEXTURES[params.pattern];
  const texture = textureFile && loadTexture ? loadTexture(textureFile) : undefined;
  // Wood and carbon textures are luminance masks, read raw; decoding them as
  // sRGB crushed their contrast to nothing. Concrete is a colour map.
  if (texture) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = params.pattern === "concrete" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  }
  applyPattern(m, { kind: params.pattern, scale: params.textureScale, printFrame, texture });
  return m;
}
