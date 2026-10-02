// src/framework/contact-shadow-plane.js
// The viewer's half of the contact shadow (contact-shadow.js holds the mask):
// a black, unlit, alpha-mapped plane a hair under the floor. MeshBasicMaterial
// so no light touches it; depthWrite off so the part's bottom face never
// z-fights it. The CPU renderer samples the same mask per pixel instead.
import * as THREE from "three";

export function buildContactShadowPlane(mask, shadow) {
  const { width: W, height: H, data, rect, y } = mask;
  // alphaMap reads the GREEN channel. PlaneGeometry's v runs along local +y,
  // which rotation.x = -PI/2 turns into world -z: texture row 0 (v = 0) is
  // world z1, so mask row j (world z0 + ...) goes to texture row H-1-j.
  const px = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const v = Math.round(Math.min(1, Math.max(0, data[j * W + i])) * 255);
    const o = ((H - 1 - j) * W + i) * 4;
    px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const sx = rect.x1 - rect.x0, sz = rect.z1 - rect.z0;
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: shadow.opacity, alphaMap: tex, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((rect.x0 + rect.x1) / 2, y - 1e-3 * Math.max(sx, sz), (rect.z0 + rect.z1) / 2);
  return mesh;
}
