// @vitest-environment happy-dom
// viewer.addDisplayObject, driven through a real viewer (a declared line's tube is the one
// caller): the object is parented with the sub-part meshes, its visible meshes count in the
// bounds the depth planes are sized from, onLook hears every look change (cel and back), and
// the remover takes it out again.
import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";

const state = vi.hoisted(() => ({ renderer: null }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.toneMapping = 0;
      this.toneMappingExposure = 1;
      this.shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
      this.compileAsync = vi.fn(async () => {});
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    getSize(target) { return target.set(400, 300); }
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    clearDepth() {}
    get capabilities() { return { maxTextureSize: 8192 }; }
    setRenderTarget() {}
    getRenderTarget() { return null; }
    getClearAlpha() { return 1; }
    setClearAlpha() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

import { createViewer } from "../../src/framework/viewer.js";

const viewers = [];
afterEach(() => { for (const v of viewers.splice(0)) v.dispose(); document.body.innerHTML = ""; });

function newViewer() {
  const container = document.createElement("div");
  Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  document.body.appendChild(container);
  const v = createViewer(container, { meta: {}, parts: { body: {} } });
  viewers.push(v);
  return v;
}
function cube(mm) {
  const geo = new THREE.BoxGeometry(mm, mm, mm);
  const positions = new Float32Array(geo.attributes.position.array);
  return { positions, normals: new Float32Array(positions.length), triangles: positions.length / 9 };
}
// A display object: one small box `at` mm along model X.
function farBox(at) {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(10, 10, 10);
  geo.translate(at, 0, 0);
  geo.computeBoundingBox();
  group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
  return group;
}

test("parents the object with the sub-part meshes; the remover takes it out", () => {
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(20));
  viewer.showAssembly(["body"], { frame: true });
  const object = farBox(0);
  const remove = viewer.addDisplayObject(object);
  expect(object.parent).toBe(viewer.__subMesh("body").parent);
  remove();
  expect(object.parent).toBe(null);
});

test("its visible meshes count in the depth planes' bounds; a hidden one does not", () => {
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(20));
  viewer.showAssembly(["body"], { frame: true });
  state.renderer.animationLoop(0);
  const farWithout = viewer.camera.far;
  const object = farBox(5000);
  viewer.addDisplayObject(object);
  state.renderer.animationLoop(0);
  expect(viewer.camera.far).toBeGreaterThan(5000);
  object.visible = false;
  viewer.requestRender();
  state.renderer.animationLoop(0);
  expect(viewer.camera.far).toBeLessThan(5000);
  expect(viewer.camera.far).toBeCloseTo(farWithout, 0);
});

test("onLook hears the mode at once and on every change, cel and back", async () => {
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(20));
  viewer.showAssembly(["body"], { frame: true });
  const onLook = vi.fn();
  viewer.addDisplayObject(farBox(0), { onLook });
  expect(onLook.mock.calls.map((c) => c[0])).toEqual(["cad"]);
  await viewer.setRenderMode("cel");
  expect(viewer.getRenderMode()).toBe("cel");
  expect(onLook.mock.calls.at(-1)[0]).toBe("cel");
  await viewer.setRenderMode("cad");
  expect(onLook.mock.calls.at(-1)[0]).toBe("cad");
});
