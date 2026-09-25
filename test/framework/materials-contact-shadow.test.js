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

// The blur plane lives in the shadow group, which is in the user's scene: a
// blur render that throws must not leave it drawn there.
test("a blur render that throws still hides the blur plane", () => {
  const renderer = fakeRenderer();
  const shadow = createContactShadow({ renderer, sizeMm: 200 });
  const scene = new THREE.Scene();
  const caster = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  scene.add(caster, shadow.group);
  renderer.render = (obj) => { if (obj !== scene) throw new Error("blur failed"); };
  const blurPlane = shadow.group.children.find((o) => o.isMesh && !o.material.map);

  expect(() => shadow.render(scene, [caster])).toThrow("blur failed");

  expect(blurPlane.visible).toBe(false);
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

// The shadow is two layers: a tight one that follows the part's outline (its
// blur a fixed reach in millimetres, not a fraction of however large the plane
// is) over a soft one. While a part moves only the soft layer is redrawn, and
// the tight outline is hidden rather than left where the part was.
test("the tight layer's blur is millimetres whatever the plane size, and it hides while the part moves", () => {
  const renderer = fakeRenderer();
  const steps = [];
  const shadow = createContactShadow({ renderer, sizeMm: 200 });
  const scene = new THREE.Scene();
  const caster = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  scene.add(caster, shadow.group);
  const [soft, tight] = shadow.group.children.filter((o) => o.isMesh && o.material.map);
  renderer.render = (obj) => {
    const m = obj.material;
    if (m?.uniforms?.h) steps.push({ target: renderer.getRenderTarget(), h: m.uniforms.h.value });
  };
  const tightSteps = () => steps.filter((s) => s.target?.width === 1024).map((s) => s.h);

  shadow.setSize(100);
  shadow.render(scene, [caster]);
  const at100 = tightSteps()[0];
  steps.length = 0;
  shadow.setSize(400);
  shadow.render(scene, [caster]);
  // same millimetre reach on a plane 4x larger is a quarter of the UV step
  expect(tightSteps()[0]).toBeCloseTo(at100 / 4);
  expect(tight.visible).toBe(true);

  steps.length = 0;
  shadow.render(scene, [caster], { lowRes: true });
  expect(tightSteps()).toHaveLength(0);
  expect(tight.visible).toBe(false);
  expect(soft.visible).toBe(true);
  shadow.dispose();
});

test("clippingPlanes clip the casters' depth pass, and a render without them clips nothing", () => {
  const renderer = fakeRenderer();
  const seen = [];
  const shadow = createContactShadow({ renderer, sizeMm: 200 });
  const scene = new THREE.Scene();
  const caster = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  scene.add(caster, shadow.group);
  renderer.render = (obj) => { if (obj === scene) seen.push(scene.overrideMaterial.clippingPlanes); };
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  shadow.render(scene, [caster], { clippingPlanes: [plane] });
  expect(seen).toHaveLength(2);
  expect(seen.every((p) => p?.length === 1 && p[0] === plane)).toBe(true);
  seen.length = 0;
  shadow.render(scene, [caster]);
  expect(seen).toEqual([null, null]);
  shadow.dispose();
});
