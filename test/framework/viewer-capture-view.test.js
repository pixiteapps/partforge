// @vitest-environment happy-dom
// renderMeshPayloads assembles a THROWAWAY scene from worker mesh payloads and
// renders it offscreen from a canonical angle — the seam a non-active view uses
// for a thumbnail without disturbing the live scene/camera. Exercised through the
// same faked-WebGLRenderer harness as viewer-frame-guard/viewer-pose (no real GL).
//
// happy-dom has no 2D canvas (getContext("2d") === null), so the real
// renderOffscreen readback path can't produce real pixels here. We shim a minimal
// 2D context + toDataURL so the real code completes, then assert the BEHAVIOURAL
// contract from the real render: which scene was drawn, that live state is
// untouched, and that every temp geometry is disposed. No pixels are asserted.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  renderer: null,
  lastRenderScene: null,
  lastCamera: null,
  disposeCounts: null,
  disposedMaterials: null,
}));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.frames = 0;
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    // Record which scene was handed to render(), and arm dispose counters on the
    // meshes present at draw time — the finally-block disposal fires afterwards.
    render(scene, camera) {
      this.frames += 1;
      state.lastRenderScene = scene;
      state.lastCamera = camera;
      state.disposeCounts = { geo: 0, edges: 0 };
      state.disposedMaterials = new Set();
      scene.traverse((o) => {
        if (o.isLineSegments2) return; // edge lines (LineSegments2 extends Mesh) — counted via their surface mesh's userData.edges
        if (!o.isMesh || !o.geometry) return;
        o.geometry.addEventListener("dispose", () => { state.disposeCounts.geo += 1; });
        o.geometry.userData.edges?.addEventListener("dispose", () => { state.disposeCounts.edges += 1; });
        o.material?.addEventListener("dispose", () => { state.disposedMaterials.add(o.material); });
      });
    }
    get capabilities() { return { maxTextureSize: 8192 }; }
    setRenderTarget() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

import { createViewer } from "../../src/framework/viewer.js";
import { cameraPoseForView } from "../../src/framework/view-angles.js";

function createContainer() {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  document.body.appendChild(container);
  return container;
}

// A 1mm triangle in the XY plane — a real bbox for framing, real edges for buildGeometry.
const cubePayload = (name) => ({
  name,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
});

// Parts must be declared (materialFor reads part.parts[name]); "a" is never given
// live geometry, so hasSubMesh("a") staying false proves the live cache untouched.
const newViewer = () => createViewer(createContainer(), { meta: {}, parts: { a: {}, b: {} } });

let origGetContext;
let origToDataURL;

beforeEach(() => {
  state.renderer = null;
  state.lastRenderScene = null;
  state.lastCamera = null;
  state.disposeCounts = null;
  state.disposedMaterials = null;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  // Shim the 2D canvas the headless env lacks so the real readback path completes.
  origGetContext = HTMLCanvasElement.prototype.getContext;
  origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.getContext = function getContext(type) {
    if (type !== "2d") return null;
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    };
  };
  HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,TEST";
});

afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toDataURL = origToDataURL;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test("renderMeshPayloads returns a JPEG data URL and never touches the live scene/camera", () => {
  const viewer = newViewer();
  // The live scene is subMesh -> partsGroup -> pivot -> scene.
  const liveScene = viewer._subMeshes.a.parent.parent.parent;
  const cameraBefore = viewer.camera.position.toArray();

  const url = viewer.renderMeshPayloads([cubePayload("a")], { angle: "iso", size: 64, style: "cad" });

  // (contract) returns a JPEG data URL
  expect(url).toMatch(/^data:image\/jpeg;base64,/);

  // (a) live state untouched: camera unmoved, nothing added to the live sub-cache
  expect(viewer.camera.position.toArray()).toEqual(cameraBefore);
  expect(viewer.hasSubMesh("a")).toBe(false);

  // (c) it rendered the TEMP scene, not the live one — and that temp scene carried
  // the built payload geometry (userData.triangles from buildGeometry).
  expect(state.renderer.frames).toBe(1);
  expect(state.lastRenderScene).not.toBe(liveScene);
  const rendered = [];
  state.lastRenderScene.traverse((o) => { if (o.isMesh && o.geometry && !o.isLineSegments2) rendered.push(o); });
  expect(rendered).toHaveLength(1);
  expect(rendered[0].geometry.userData.triangles).toBe(1);

  // (b) every temp resource disposed: the mesh geometry AND its edge lines.
  expect(state.disposeCounts).toEqual({ geo: 1, edges: 1 });

  viewer.dispose();
});

test("renderMeshPayloads disposes geometry even for multiple payloads", () => {
  const viewer = newViewer();

  viewer.renderMeshPayloads([cubePayload("a"), cubePayload("b")], { size: 64, style: "cad" });

  expect(state.disposeCounts).toEqual({ geo: 2, edges: 2 });
  expect(viewer.hasSubMesh("a")).toBe(false);
  expect(viewer.hasSubMesh("b")).toBe(false);

  viewer.dispose();
});

test("renderMeshPayloads disposes a display-override clone material but not the shared singleton", () => {
  // A part with a `display` override makes materialFor return a fresh material.clone();
  // a plain part reuses the shared singleton. The clone must be disposed (else it leaks
  // one MeshStandardMaterial + its compiled program per call); the singleton must not.
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { a: {}, ghost: { display: { color: 0xff2244 } } },
  });
  // "a" is plain, so its live sub-mesh material IS the shared singleton.
  const sharedMaterial = viewer._subMeshes.a.material;

  viewer.renderMeshPayloads([cubePayload("a"), cubePayload("ghost")], { size: 64, style: "cad" });

  const meshes = [];
  state.lastRenderScene.traverse((o) => { if (o.isMesh && o.geometry && !o.isLineSegments2) meshes.push(o); });
  const plain = meshes.filter((m) => m.material === sharedMaterial);
  const clones = meshes.filter((m) => m.material !== sharedMaterial);
  expect(plain).toHaveLength(1);   // the "a" payload reused the singleton
  expect(clones).toHaveLength(1);  // the "ghost" payload got a clone

  // the clone is disposed; the shared singleton is left intact for the live view
  expect(state.disposedMaterials.has(clones[0].material)).toBe(true);
  expect(state.disposedMaterials.has(sharedMaterial)).toBe(false);
  // geometry disposal unaffected by the material fix
  expect(state.disposeCounts).toEqual({ geo: 2, edges: 2 });

  viewer.dispose();
});

// Review fix 1: the throwaway scene must carry its own ambient hemisphere + camera-relative
// key/fill. renderOffscreen's capture lights (and the persistent hemisphere) live in the LIVE
// scene, which is never rendered here, so without these the thumbnail comes back near-black.
test("renderMeshPayloads lights the temp scene with a hemisphere plus key/fill", () => {
  const viewer = newViewer();

  viewer.renderMeshPayloads([cubePayload("a")], { size: 64 });

  const lights = [];
  state.lastRenderScene.traverse((o) => { if (o.isLight) lights.push(o); });
  expect(lights.some((l) => l.isHemisphereLight)).toBe(true);
  expect(lights.filter((l) => l.isDirectionalLight)).toHaveLength(2);

  viewer.dispose();
});

// Review fix 2: geometry is rotated by tmpPivot (-90° X), so the camera must be framed on the
// WORLD-space centre. A model-space bbox centre would aim at the wrong point and render an
// off-origin part off-centre or blank. This triangle sits at model z=10 → world y=10 after the
// pivot, so a model-space bug would target z≈10 instead.
test("renderMeshPayloads frames the camera on the world-space centre (after the pivot)", () => {
  const viewer = newViewer();
  const atZ10 = {
    name: "a",
    positions: new Float32Array([0, 0, 10, 1, 0, 10, 0, 1, 10]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    triangles: 1,
  };

  viewer.renderMeshPayloads([atZ10], { angle: "iso", size: 64, style: "cad" });

  // model bbox centre (0.5,0.5,10) maps to world (0.5,10,-0.5) under (x,y,z)->(x,z,-y);
  // The cad style frames canonically (stylePose): radius is half the MAX extent, as the
  // live viewer's own framing does, not half the diagonal.
  const expected = cameraPoseForView("iso", { center: [0.5, 10, -0.5], radius: 0.5 });
  const round = (v) => v.map((n) => +n.toFixed(3));
  expect(round(state.lastCamera.position.toArray())).toEqual(round(expected.position));

  viewer.dispose();
});

// Review fix 3: same disposed-guard the sibling capture functions carry — never render through
// a torn-down WebGLRenderer; captureView's documented contract is "resolves null on a disposed
// runtime".
test("renderMeshPayloads returns null after the viewer is disposed", () => {
  const viewer = newViewer();
  viewer.dispose();

  expect(viewer.renderMeshPayloads([cubePayload("a")], { size: 64 })).toBeNull();
  expect(state.lastRenderScene).toBeNull(); // never reached the renderer
});

// Review fix 6: the thumbnail must carry the part's CAD feature-edge outlines, like the
// live viewer — the surface mesh alone loses hole/seam/chamfer lines.
test("renderMeshPayloads adds feature-edge lines to the temp scene", () => {
  const viewer = newViewer();

  viewer.renderMeshPayloads([cubePayload("a")], { size: 64, style: "cad" });

  const lines = [];
  state.lastRenderScene.traverse((o) => { if (o.isLineSegments2) lines.push(o); });
  expect(lines).toHaveLength(1); // one edge-line object for the one payload
  // the edge geometry is still disposed with its surface mesh (no double count)
  expect(state.disposeCounts).toEqual({ geo: 1, edges: 1 });

  viewer.dispose();
});

// Review fix 7: render at the live camera's fov (45°, which cameraPoseForView's distance is
// tuned to), not the old 35° that cropped long, thin parts.
test("renderMeshPayloads renders at the live camera's fov, not a narrower one", () => {
  const viewer = newViewer();

  viewer.renderMeshPayloads([cubePayload("a")], { size: 64 });

  expect(state.lastCamera.fov).toBe(viewer.camera.fov); // 45, matching captureViews/captureCurrent
  expect(state.lastCamera.fov).toBe(45);

  viewer.dispose();
});
