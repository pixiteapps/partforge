// The shared look of a draggable gizmo handle: the palette, the materials, the
// normal/hovered geometry pairs and the hover rule. The cutaway control
// (cutaway-gizmo.js) and Pose mode's aim gizmo (pose/aim-gizmo.js) both build their
// handles from here, so a handle under the pointer reads the same way in both: its
// colour lifts toward white, its geometry swaps to a thicker twin, and it draws at full
// opacity. Hover is steady styling, never a blink.
import * as THREE from "three";

/** How far a hovered handle's colour lifts toward white (Color.lerp's alpha). */
export const HANDLE_HOVER_WHITE_MIX = 0.28;
/** A hovered handle's geometry is built this much thicker (tube / shaft / cone radius). */
export const HANDLE_HOVER_THICKNESS = 1.6;

const WHITE = new THREE.Color(0xffffff);

/**
 * The gizmo palette, per viewer theme. `fill`/`border` are the cutaway plane's blues
 * (and Pose mode's handle blue); `red`, `blue` and `green` are the axis colours a
 * gizmo gives its handles — the cutaway's X ring, Y ring and translate arrow, and the
 * aim gizmo's pitch, yaw and roll rings.
 */
export const GIZMO_PALETTE = {
  dark: {
    fill: 0x65bff5,
    border: 0xa8dcff,
    red: 0xff6b7a,
    blue: 0x5aa9ff,
    green: 0x36d399,
  },
  light: {
    fill: 0x1479b8,
    border: 0x075985,
    red: 0xc92a3b,
    blue: 0x1769aa,
    green: 0x087f5b,
  },
};

/**
 * A handle's material. Transparent so the hover rule can set its opacity. Depth is
 * tested and written by default (the cutaway draws its handles in an overlay scene);
 * an overlay drawn in the model's scene passes `{ depthTest: false, depthWrite: false }`.
 */
export function handleMaterial(color, { depthTest = true, depthWrite = true } = {}) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    depthTest,
    depthWrite,
  });
}

/** The invisible material of a hit proxy: a fatter stand-in that is raycast, not seen. */
export function hitMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    opacity: 0,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * A handle's normal and hovered geometry: `make(1)` and `make(HANDLE_HOVER_THICKNESS)`.
 * `make(k)` builds the geometry with its thickness scaled by `k`.
 */
export function hoverGeometryPair(make) {
  return { normal: make(1), hovered: make(HANDLE_HOVER_THICKNESS) };
}

/**
 * The hover rule. `entry` is `{ visual, material, geometryPairs: [{ mesh, normal,
 * hovered }] }`. Sets the material to `color`, lifted toward white when hovered; full
 * opacity when hovered, else `idleOpacity`; and swaps each mesh to its hovered or
 * normal geometry.
 */
export function applyHandleAppearance(entry, { color, hovered, idleOpacity = 1 }) {
  const { visual, material, geometryPairs } = entry;
  material.color.set(color);
  if (hovered) material.color.lerp(WHITE, HANDLE_HOVER_WHITE_MIX);
  material.transparent = true;
  material.opacity = hovered ? 1 : idleOpacity;
  visual?.scale.setScalar(1);
  for (const pair of geometryPairs) {
    pair.mesh.geometry = hovered ? pair.hovered : pair.normal;
  }
}
