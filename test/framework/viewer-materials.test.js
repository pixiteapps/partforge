// @vitest-environment happy-dom
// Per-sub-part CAD material: a sub-part with no `display` (or a legacy
// color/opacity display) renders byte-for-byte as before; a sub-part naming a
// library `material` gets that preset's colour flattened for the CAD view
// (materials/resolve.js cadAppearance) — buildCadMaterial (materials/physical.js)
// is the seam that turns `display` into the MeshStandardMaterial the mesh uses.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null }));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.frames = 0;
      this.toneMapping = 0;
      this.toneMappingExposure = 1;
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() { this.frames += 1; }
    compileAsync() { return Promise.resolve(); }
    get capabilities() { return { maxTextureSize: 8192 }; }
    setRenderTarget() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

import { createViewer } from "../../src/framework/viewer.js";
import { unzipSync, strFromU8 } from "fflate";
import { NO_MATERIAL_COLOR } from "../../src/framework/materials/resolve.js";
import { meshTo3MF } from "../../src/framework/geometry/threemf.js";

function createContainer() {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  document.body.appendChild(container);
  return container;
}

const partWith = (display) => ({
  meta: { title: "t" },
  parts: { body: { build: () => null, display } },
});

beforeEach(() => {
  state.renderer = null;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test("a sub-part without display shares the default material", () => {
  const v = createViewer(createContainer(), partWith(undefined));
  const m = v.__subMesh("body").material;
  expect(m.color.getHex()).toBe(0x9fb4cc);
  expect(m.metalness).toBe(0.25);
  v.dispose();
});

test("a legacy color display renders exactly as before", () => {
  const v = createViewer(createContainer(), partWith({ color: 0x1e88e5 }));
  const m = v.__subMesh("body").material;
  expect(m.color.getHex()).toBe(0x1e88e5);
  expect(m.roughness).toBe(0.55);
  v.dispose();
});

test("a material shows its flattened CAD colour", () => {
  const v = createViewer(createContainer(), partWith({ material: "brass" }));
  const m = v.__subMesh("body").material;
  expect(m.color.getHex()).toBe(0xf8dc82);
  expect(m.metalness).toBeLessThanOrEqual(0.5);
  v.dispose();
});

// The no-material blue-grey is written three times — resolve.js (the one named
// constant), viewer.js's base CAD material and threemf.js's uncoloured-object
// colour (a literal there to keep that module's import closure fflate-only).
// This pins the copies together without widening either module's exports.
test("the viewer's base colour and the 3MF default colour equal resolve.js's NO_MATERIAL_COLOR", () => {
  const v = createViewer(createContainer(), partWith(undefined));
  expect(v.__subMesh("body").material.color.getHex()).toBe(NO_MATERIAL_COLOR);
  v.dispose();
  const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const model = strFromU8(unzipSync(new Uint8Array(meshTo3MF([{ name: "a", ...tri, color: 0x123456 }, { name: "b", ...tri }])))["3D/3dmodel.model"]);
  const hex = NO_MATERIAL_COLOR.toString(16).padStart(6, "0").toUpperCase();
  expect(model).toContain(`displaycolor="#${hex}FF"`);
});
