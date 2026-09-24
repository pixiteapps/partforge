// test/framework/materials-contact-shadow.test.js
import * as THREE from "three";
import { expect, test } from "vitest";
import { createContactShadow } from "../../src/framework/materials/contact-shadow.js";

// A minimal fake renderer exposing only the methods render() uses.
// three's WebGLRenderTarget constructs fine without a real GL context, so
// createContactShadow itself needs no GPU.
function fakeRenderer({ renderThrows = false } = {}) {
  let clearAlpha = 1;
  let renderTarget = null;
  return {
    getClearAlpha: () => clearAlpha,
    setClearAlpha: (a) => { clearAlpha = a; },
    getRenderTarget: () => renderTarget,
    setRenderTarget: (rt) => { renderTarget = rt; },
    render: () => { if (renderThrows) throw new Error("context lost"); },
  };
}

test("render() restores scene and renderer state even when renderer.render() throws", () => {
  const renderer = fakeRenderer({ renderThrows: true });
  const shadow = createContactShadow({ renderer, sizeMm: 200 });

  const scene = new THREE.Scene();
  const otherMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  scene.add(otherMesh);
  const caster = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  scene.add(caster);

  const priorOverride = new THREE.MeshBasicMaterial();
  scene.overrideMaterial = priorOverride;
  const priorBackground = new THREE.Color(0x123456);
  scene.background = priorBackground;

  const priorRT = new THREE.WebGLRenderTarget(4, 4);
  renderer.setRenderTarget(priorRT);

  expect(() => shadow.render(scene, [caster])).toThrow("context lost");

  expect(otherMesh.visible).toBe(true);
  expect(scene.overrideMaterial).toBe(priorOverride);
  expect(scene.background).toBe(priorBackground);
  expect(renderer.getRenderTarget()).toBe(priorRT);

  shadow.dispose();
});

// three (r15x+) leaves SCALE out of a camera's view matrix, so a depth camera
// sized by scaling its parent group saw a 1 mm square and the shadow texture
// stayed empty in every environment. The frustum has to be sized itself.
test("the depth camera's frustum covers the shadow's footprint and height", () => {
  const shadow = createContactShadow({ renderer: fakeRenderer(), sizeMm: 200 });
  const scene = new THREE.Scene();
  scene.add(shadow.group);
  shadow.group.position.set(10, -20, 5);
  shadow.setSize(100, 60);
  scene.updateMatrixWorld(true);
  const cam = shadow.group.children.find((o) => o.isCamera);
  const ndc = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
  const inside = (v) => Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && Math.abs(v.z) <= 1;

  // A part sitting on the ground, near the footprint's corner, casts.
  expect(inside(ndc(10 + 45, -20 + 30, 5 - 45))).toBe(true);
  expect(inside(ndc(10 - 45, -20 + 55, 5 + 45))).toBe(true);
  // Outside the footprint, above the height, or below the ground: not seen.
  expect(inside(ndc(10 + 55, -20 + 30, 5))).toBe(false);
  expect(inside(ndc(10, -20 + 65, 5))).toBe(false);
  expect(inside(ndc(10, -21, 5))).toBe(false);

  // …and the plane it lands on is the same footprint.
  const box = new THREE.Box3().setFromObject(shadow.group.children.find((o) => o.isMesh && o.visible));
  expect(box.max.x - box.min.x).toBeCloseTo(100);
  expect(box.max.z - box.min.z).toBeCloseTo(100);
  shadow.dispose();
});
