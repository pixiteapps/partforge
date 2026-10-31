import * as THREE from "three";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "./cutaway-render.js";
import { handleMaterial, hitMaterial as createHitMaterial, hoverGeometryPair } from "./gizmo/gizmo-handles.js";

// +10: above the caps/highlight tier AND above measure mode's dims
// (dim3-scene renders at +2/+3) — an actively-dragged control outranks ink.
const GIZMO_RENDER_ORDER = CUTAWAY_OVERLAY_RENDER_ORDER + 10;

/**
 * Builds the cutaway gizmo's three.js scene graph: the ghost plane, the
 * translate arrow, the two rotation arcs, and the invisible hit proxies that
 * stand in for them while picking.
 *
 * Pure construction - the objects come back detached, so mounting them into a
 * scene, posing them, and reacting to the pointer all stay in
 * `createCutawayGizmo`.
 *
 * `theme` is one palette out of the gizmo's theme table. Colors are baked in
 * here rather than written as literals so the very first rendered frame
 * already agrees with the palette that later appearance updates re-derive.
 */
export function buildGizmoScene(theme) {
  const geometries = new Set();
  const materials = new Set();

  const group = new THREE.Group();

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: theme.fill,
      opacity: 0.18,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  geometries.add(fill.geometry);
  materials.add(fill.material);

  const borderGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, -0.5, 0),
    new THREE.Vector3(0.5, -0.5, 0),
    new THREE.Vector3(0.5, 0.5, 0),
    new THREE.Vector3(-0.5, 0.5, 0),
  ]);
  const borderMaterial = new THREE.LineBasicMaterial({
    color: theme.border,
    opacity: 1,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const border = new THREE.LineLoop(borderGeometry, borderMaterial);
  border.renderOrder = GIZMO_RENDER_ORDER;
  geometries.add(borderGeometry);
  materials.add(borderMaterial);

  const handleRoot = new THREE.Group();
  const translateVisualRoot = new THREE.Group();
  const arcRoot = new THREE.Group();
  const translateMaterial = handleMaterial(theme.translate);
  const rotateXMaterial = handleMaterial(theme.rotateX);
  const rotateYMaterial = handleMaterial(theme.rotateY);
  materials.add(translateMaterial);
  materials.add(rotateXMaterial);
  materials.add(rotateYMaterial);

  const shaftPair = hoverGeometryPair((k) => new THREE.CylinderGeometry(0.025 * k, 0.025 * k, 0.58, 12));
  const shaftGeometry = shaftPair.normal;
  const shaftHoverGeometry = shaftPair.hovered;
  const shaft = new THREE.Mesh(shaftGeometry, translateMaterial);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.29;
  const conePair = hoverGeometryPair((k) => new THREE.ConeGeometry(0.075 * k, 0.2, 16));
  const coneGeometry = conePair.normal;
  const coneHoverGeometry = conePair.hovered;
  const cone = new THREE.Mesh(coneGeometry, translateMaterial);
  cone.rotation.x = Math.PI / 2;
  cone.position.z = 0.68;
  geometries.add(shaftGeometry);
  geometries.add(shaftHoverGeometry);
  geometries.add(coneGeometry);
  geometries.add(coneHoverGeometry);

  // A half ring: the arc of a rotate handle, thickened by `k` when hovered.
  const halfRing = (k) => new THREE.TorusGeometry(0.42, 0.015 * k, 8, 64, Math.PI);
  const ringXPair = hoverGeometryPair(halfRing);
  const ringXGeometry = ringXPair.normal;
  const ringX = new THREE.Mesh(ringXGeometry, rotateXMaterial);
  const ringXHoverGeometry = ringXPair.hovered;
  ringX.quaternion
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
    .multiply(new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    ));
  const ringYPair = hoverGeometryPair(halfRing);
  const ringYGeometry = ringYPair.normal;
  const ringY = new THREE.Mesh(ringYGeometry, rotateYMaterial);
  const ringYHoverGeometry = ringYPair.hovered;
  ringY.rotation.x = -Math.PI / 2;
  geometries.add(ringXGeometry);
  geometries.add(ringXHoverGeometry);
  geometries.add(ringYGeometry);
  geometries.add(ringYHoverGeometry);

  const hitMaterial = createHitMaterial();
  materials.add(hitMaterial);
  const translateHitGeometry = new THREE.CylinderGeometry(0.1, 0.1, 0.95, 10);
  const translateHit = new THREE.Mesh(translateHitGeometry, hitMaterial);
  translateHit.rotation.x = Math.PI / 2;
  translateHit.position.z = 0.38;
  translateHit.userData.cutawayHandle = "translate";
  const rotateXHitGeometry = new THREE.TorusGeometry(
    0.42,
    0.12,
    8,
    48,
    Math.PI,
  );
  const rotateXHit = new THREE.Mesh(rotateXHitGeometry, hitMaterial);
  rotateXHit.quaternion.copy(ringX.quaternion);
  rotateXHit.userData.cutawayHandle = "rotate-x";
  const rotateYHitGeometry = new THREE.TorusGeometry(
    0.42,
    0.12,
    8,
    48,
    Math.PI,
  );
  const rotateYHit = new THREE.Mesh(rotateYHitGeometry, hitMaterial);
  rotateYHit.quaternion.copy(ringY.quaternion);
  rotateYHit.userData.cutawayHandle = "rotate-y";
  geometries.add(translateHitGeometry);
  geometries.add(rotateXHitGeometry);
  geometries.add(rotateYHitGeometry);

  translateVisualRoot.add(shaft, cone);
  arcRoot.add(ringX, ringY, rotateXHit, rotateYHit);
  handleRoot.add(translateVisualRoot, translateHit, arcRoot);
  group.add(fill, border);

  const handles = {
    translate: translateHit,
    rotateX: rotateXHit,
    rotateY: rotateYHit,
  };
  const handleVisuals = {
    translate: translateVisualRoot,
    rotateX: ringX,
    rotateY: ringY,
  };
  const handleAppearance = {
    translate: {
      visual: translateVisualRoot,
      material: translateMaterial,
      geometryPairs: [
        { mesh: shaft, normal: shaftGeometry, hovered: shaftHoverGeometry },
        { mesh: cone, normal: coneGeometry, hovered: coneHoverGeometry },
      ],
    },
    "rotate-x": {
      visual: ringX,
      material: rotateXMaterial,
      geometryPairs: [
        { mesh: ringX, normal: ringXGeometry, hovered: ringXHoverGeometry },
      ],
    },
    "rotate-y": {
      visual: ringY,
      material: rotateYMaterial,
      geometryPairs: [
        { mesh: ringY, normal: ringYGeometry, hovered: ringYHoverGeometry },
      ],
    },
  };

  // Every geometry and material above - including the thickened hover variants
  // that are swapped in and out of the meshes - is owned by this scene and
  // nothing else. The caller disposes it exactly once, at teardown.
  function dispose() {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  return {
    group,
    fill,
    border,
    handleRoot,
    arcRoot,
    handles,
    handleVisuals,
    handleAppearance,
    dispose,
  };
}
