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
