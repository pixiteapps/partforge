// src/framework/materials/physical.js
// three.js materials from resolved library data. The CAD half keeps the viewer's
// MeshStandardMaterial and only swaps its numbers; the realistic half (Task 8)
// builds MeshPhysicalMaterial. Both read resolve.js, so the two modes can never
// disagree about which preset a sub-part is.
import * as THREE from "three";
import { cadAppearance } from "./resolve.js";

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
