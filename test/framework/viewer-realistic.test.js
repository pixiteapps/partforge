// @vitest-environment happy-dom
// Realistic render mode: physical materials, environment lighting, a ground
// that comes to the part, no feature lines — and a clean way back to CAD. The
// environment rig is mocked (no GL, no network); everything else is the real
// viewer on a fake renderer.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as THREE from "three";

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
      this.compileAsync = vi.fn(async () => {});
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    getSize(target) { return target.set(400, 300); }
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() { this.frames += 1; }
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

const rigState = vi.hoisted(() => ({ fail: false, loads: 0, rigs: [], throwOnGround: false, gate: null }));
vi.mock("../../src/framework/materials/environment.js", async () => {
  const THREE = await import("three");
  return {
    loadEnvironmentRig: async (_r, id) => {
      rigState.loads++;
      if (rigState.gate) await rigState.gate;
      if (rigState.fail) throw new Error("asset 404");
      const rig = {
        id: id ?? "studio", exposure: 1.1, envMap: new THREE.Texture(), background: new THREE.Color(0xffffff), backgroundBlurriness: 0,
        ground: new THREE.Mesh(), shadow: { group: new THREE.Group(), render: vi.fn(), setSize: vi.fn(), dispose: vi.fn() },
        setGround: vi.fn(() => { if (rigState.throwOnGround) throw new Error("ground boom"); }), dispose: vi.fn(),
      };
      rigState.rigs.push(rig);
      return rig;
    },
  };
});

import { createViewer } from "../../src/framework/viewer.js";

function createContainer() {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  document.body.appendChild(container);
  return container;
}

const part = {
  meta: { title: "t" },
  parts: {
    body: { build: () => null, display: { material: "brass" } },
    ghost: { build: () => null, display: { opacity: 0.3 } },
    printed: { build: () => null, display: { material: "pla-print" } },
  },
};
// A real volume (a unit tetrahedron), so the cutaway has bounds to seed its plane from.
const payload = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]),
  normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, -1, 0, 0, -1, 0, 0, -1, 0]),
  triangles: 2,
  edges: new Float32Array(0),
});
function shown() {
  const v = createViewer(createContainer(), part);
  for (const n of Object.keys(part.parts)) v.setSubGeometry(n, payload());
  v.showAssembly(Object.keys(part.parts), { frame: true });
  return v;
}
const lastRig = () => rigState.rigs.at(-1);

beforeEach(() => {
  state.renderer = null;
  Object.assign(rigState, { fail: false, loads: 0, rigs: [], throwOnGround: false, gate: null });
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

test("starts in CAD with lines visible", () => {
  const v = shown();
  expect(v.getRenderMode()).toBe("cad");
  expect(v.__subLines("body").visible).toBe(true);
  v.dispose();
});

test("realistic swaps in physical materials, hides lines, never moves the part", async () => {
  const v = shown();
  const before = v.__subMesh("body").getWorldPosition(new THREE.Vector3()).toArray();
  expect(await v.setRenderMode("realistic")).toBe("realistic");
  expect(v.__subMesh("body").material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
  expect(v.__subLines("body").visible).toBe(false);
  expect(v.__subMesh("body").getWorldPosition(new THREE.Vector3()).toArray()).toEqual(before);
  expect(state.renderer.toneMapping).toBe(THREE.NeutralToneMapping);
  expect(state.renderer.toneMappingExposure).toBe(1.1);
  v.dispose();
});

test("realistic lights the scene from the environment only and drops the grid", async () => {
  const v = shown();
  await v.setRenderMode("realistic");
  const rig = lastRig();
  const scene = v.__subMesh("body").parent.parent.parent;
  expect(scene.environment).toBe(rig.envMap);
  expect(scene.background).toBe(rig.background);
  expect(rig.ground.parent).toBe(scene);
  expect(rig.shadow.group.parent).toBe(scene);
  const lights = scene.children.filter((o) => o.isLight);
  expect(lights.length).toBeGreaterThan(0);
  expect(lights.every((l) => !l.visible)).toBe(true);
  expect(scene.children.find((o) => o.type === "GridHelper").visible).toBe(false);
  v.dispose();
});

test("the ground comes to the part and only opaque parts cast", async () => {
  const v = shown();
  await v.setRenderMode("realistic");
  const rig = lastRig();
  expect(rig.setGround).toHaveBeenCalled();
  const { y } = rig.setGround.mock.calls.at(-1)[0];
  // The part's lowest world point, after the pivot stands it up.
  const box = new THREE.Box3();
  for (const n of Object.keys(part.parts)) box.union(new THREE.Box3().setFromObject(v.__subMesh(n)));
  expect(y).toBeCloseTo(box.min.y);
  const casters = rig.shadow.render.mock.calls.at(-1)[1];
  expect(casters).toContain(v.__subMesh("body"));
  expect(casters).not.toContain(v.__subMesh("ghost"));
  v.dispose();
});

test("back to CAD restores the CAD material, lines, lights, background and tone mapping", async () => {
  const v = shown();
  const cadMat = v.__subMesh("body").material;
  await v.setRenderMode("realistic");
  const rig = lastRig();
  await v.setRenderMode("cad");
  expect(v.__subMesh("body").material).toBe(cadMat);
  expect(v.__subMesh("body").material).toBeInstanceOf(THREE.MeshStandardMaterial);
  expect(v.__subMesh("body").material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  expect(v.__subLines("body").visible).toBe(true);
  expect(state.renderer.toneMapping).toBe(THREE.NoToneMapping);
  expect(state.renderer.toneMappingExposure).toBe(1);
  const scene = v.__subMesh("body").parent.parent.parent;
  expect(scene.environment).toBe(null);
  expect(scene.background.getHex()).toBe(0x15181d);
  expect(rig.ground.parent).toBe(null);
  expect(scene.children.filter((o) => o.isLight).every((l) => l.visible)).toBe(true);
  expect(scene.children.find((o) => o.type === "GridHelper").visible).toBe(true);
  expect(rig.dispose).not.toHaveBeenCalled(); // cached for the way back
  v.dispose();
  await vi.waitFor(() => expect(rig.dispose).toHaveBeenCalled()); // the cache holds promises
});

test("the far plane holds the realistic ground disc", async () => {
  const v = shown();
  state.renderer.animationLoop();
  const farCad = v.camera.far;
  await v.setRenderMode("realistic");
  lastRig().ground.geometry = new THREE.BoxGeometry(4000, 1, 4000);
  state.renderer.animationLoop();
  expect(v.camera.far).toBeGreaterThan(Math.max(farCad, 2000));
  v.dispose();
});

test("a theme change in realistic keeps the environment backdrop and no grid", async () => {
  const v = shown();
  await v.setRenderMode("realistic");
  v.setTheme("light");
  const scene = v.__subMesh("body").parent.parent.parent;
  expect(scene.background).toBe(lastRig().background);
  expect(scene.children.find((o) => o.type === "GridHelper").visible).toBe(false);
  expect(v.__subMesh("body").material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
  await v.setRenderMode("cad");
  expect(scene.background.getHex()).toBe(0xe9edf2);
  v.dispose();
});

test("a failed asset load stays in CAD and reports it", async () => {
  rigState.fail = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const v = shown();
  const events = [];
  v.onRenderModeChange((e) => events.push(e));
  expect(await v.setRenderMode("realistic")).toBe("cad");
  expect(v.__subMesh("body").material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  expect(state.renderer.toneMapping).toBe(THREE.NoToneMapping);
  expect(events[0]).toEqual({ mode: "cad", busy: true, error: null });
  expect(events.at(-1)).toEqual({ mode: "cad", busy: false, error: expect.stringContaining("couldn't load") });
  expect(console.warn).toHaveBeenCalled();
  // Not memoized: a retry loads again.
  rigState.fail = false;
  expect(await v.setRenderMode("realistic")).toBe("realistic");
  v.dispose();
});

test("a throw while swapping leaves a consistent CAD view", async () => {
  rigState.throwOnGround = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const v = shown();
  const cadMat = v.__subMesh("body").material;
  expect(await v.setRenderMode("realistic")).toBe("cad");
  expect(v.getRenderMode()).toBe("cad");
  expect(v.__subMesh("body").material).toBe(cadMat);
  expect(v.__subLines("body").visible).toBe(true);
  expect(state.renderer.toneMapping).toBe(THREE.NoToneMapping);
  const scene = v.__subMesh("body").parent.parent.parent;
  expect(scene.environment).toBe(null);
  expect(scene.children.filter((o) => o.isLight).every((l) => l.visible)).toBe(true);
  v.dispose();
});

test("switching environment reuses a cached rig on the way back", async () => {
  const v = shown();
  const envs = [];
  v.onEnvironmentChange((id) => envs.push(id));
  await v.setRenderMode("realistic");
  await v.setEnvironment("workshop");
  expect(lastRig().id).toBe("workshop");
  await v.setEnvironment("studio");
  expect(v.getEnvironment()).toBe("studio");
  expect(rigState.loads).toBe(2);
  const scene = v.__subMesh("body").parent.parent.parent;
  expect(scene.environment).toBe(rigState.rigs[0].envMap);
  expect(envs).toEqual(["workshop", "studio"]);
  v.dispose();
});

test("an unknown environment id falls back to the default", async () => {
  const v = shown();
  expect(await v.setEnvironment("moon")).toBe("studio");
  v.dispose();
});

test("an environment chosen while realistic is loading is the one that lands", async () => {
  let open;
  rigState.gate = new Promise((r) => { open = r; });
  const v = shown();
  const a = v.setRenderMode("realistic");
  const b = v.setEnvironment("outdoor");
  open();
  await Promise.all([a, b]);
  expect(v.getRenderMode()).toBe("realistic");
  const scene = v.__subMesh("body").parent.parent.parent;
  expect(scene.environment).toBe(rigState.rigs.find((r) => r.id === "outdoor").envMap);
  v.dispose();
});

test("the cutaway keeps working across a mode switch", async () => {
  const v = shown();
  expect(v.setCutawayEnabled(true)).toBe(true);
  await v.setRenderMode("realistic");
  expect(v.__subMesh("body").material.clippingPlanes?.length).toBeGreaterThan(0);
  expect(v.__subMesh("body").material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
  await v.setRenderMode("cad");
  expect(v.__subMesh("body").material.clippingPlanes?.length).toBeGreaterThan(0);
  expect(v.__subMesh("body").material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  v.dispose();
});

test("a patterned material keeps its shader hooks through the cutaway and fade clones", async () => {
  const v = shown();
  await v.setRenderMode("realistic");
  const base = v.__subMesh("printed").material;
  expect(base.userData.patternUniforms).toBeTruthy();
  v.setCutawayEnabled(true);
  const clipped = v.__subMesh("printed").material;
  expect(clipped).not.toBe(base);
  expect(clipped.onBeforeCompile).toBe(base.onBeforeCompile);
  expect(clipped.customProgramCacheKey()).toBe(base.customProgramCacheKey());
  v.setSubPartOpacity("printed", 0.5);
  const faded = v.__subMesh("printed").material;
  expect(faded.onBeforeCompile).toBe(base.onBeforeCompile);
  expect(faded.userData.patternUniforms).toBe(base.userData.patternUniforms);
  v.dispose();
});

test("a fade survives a mode switch on the new material", async () => {
  const v = shown();
  v.setSubPartOpacity("body", 0.5);
  await v.setRenderMode("realistic");
  const m = v.__subMesh("body").material;
  expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial);
  expect(m.opacity).toBeCloseTo(0.5);
  expect(v.__subLines("body").visible).toBe(false);
  await v.setRenderMode("cad");
  expect(v.__subMesh("body").material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  expect(v.__subMesh("body").material.opacity).toBeCloseTo(0.5);
  expect(v.__subLines("body").visible).toBe(true);
  v.dispose();
});

test("a later call supersedes an in-flight one", async () => {
  const v = shown();
  const a = v.setRenderMode("realistic");
  const b = v.setRenderMode("cad");
  await Promise.all([a, b]);
  expect(v.getRenderMode()).toBe("cad");
  expect(v.__subMesh("body").material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  expect(state.renderer.toneMapping).toBe(THREE.NoToneMapping);
  v.dispose();
});

test("shaders compile under the realistic tone mapping without leaking it into CAD", async () => {
  const v = shown();
  let during;
  state.renderer.compileAsync.mockImplementation(async () => { during = state.renderer.toneMapping; });
  let open;
  const gate = new Promise((r) => { open = r; });
  state.renderer.compileAsync.mockImplementationOnce((scene) => {
    during = state.renderer.toneMapping;
    expect(scene.environment).toBe(lastRig().envMap);
    return gate;
  });
  const p = v.setRenderMode("realistic");
  await vi.waitFor(() => expect(state.renderer.compileAsync).toHaveBeenCalled());
  expect(during).toBe(THREE.NeutralToneMapping);
  expect(state.renderer.toneMapping).toBe(THREE.NoToneMapping); // CAD still on screen while compiling
  open();
  await p;
  expect(state.renderer.toneMapping).toBe(THREE.NeutralToneMapping);
  v.dispose();
});

test("while an animation moves a part the shadow re-renders low-res, then once full on settle", async () => {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const v = shown();
  await v.setRenderMode("realistic");
  const render = lastRig().shadow.render;
  render.mockClear();
  v.setSubPose("body", new THREE.Matrix4().makeTranslation(0, 0, 1).toArray());
  state.renderer.animationLoop();
  expect(render).toHaveBeenCalledTimes(1);
  expect(render.mock.calls[0][2]).toEqual({ lowRes: true });
  now += 50; // inside the 100 ms throttle
  v.setSubPose("body", new THREE.Matrix4().makeTranslation(0, 0, 2).toArray());
  state.renderer.animationLoop();
  expect(render).toHaveBeenCalledTimes(1);
  now += 60;
  state.renderer.animationLoop();
  expect(render).toHaveBeenCalledTimes(2);
  now += 250; // settled
  state.renderer.animationLoop();
  expect(render).toHaveBeenCalledTimes(3);
  expect(render.mock.calls[2][2]).toBeUndefined();
  now += 500;
  state.renderer.animationLoop();
  expect(render).toHaveBeenCalledTimes(3); // nothing moved: no more renders
  v.dispose();
});

test("print frames reach the patterned material's uniform", async () => {
  const v = shown();
  await v.setRenderMode("realistic");
  const frame = new THREE.Matrix4().makeTranslation(1, 2, 3).toArray();
  v.setPrintFrames({ printed: frame });
  expect(v.__subMesh("printed").material.userData.patternUniforms.pfPrintFrame.value.toArray()).toEqual(frame);
  v.dispose();
});

test("whenRealisticReady resolves once the environment is loaded", async () => {
  const v = shown();
  await v.whenRealisticReady();
  expect(rigState.loads).toBe(1);
  await v.setRenderMode("realistic");
  expect(rigState.loads).toBe(1); // the same cached rig
  v.dispose();
});

test("a capture while realistic leaves the live CAD key/fill lights off", async () => {
  // happy-dom has no 2D canvas; stub just enough for the capture to complete.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => "data:image/jpeg;base64,TEST");
  const v = shown();
  await v.setRenderMode("realistic");
  expect(v.captureCanonicalViews(["iso"])).toHaveLength(1);
  const scene = v.__subMesh("body").parent.parent.parent;
  expect(scene.children.filter((o) => o.isLight).every((l) => !l.visible)).toBe(true);
  v.dispose();
});
