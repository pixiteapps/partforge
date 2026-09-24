// @vitest-environment happy-dom
// Realistic mode through mount(): the runtime handle's renderMode/environment/
// declaresMaterials/renderViews, viewer-state carry-over, the stored
// preference, the viewbar controls, and the print frames the layer-line
// pattern reads. Unlike the rest of the mount suite this runs the REAL viewer
// (on a fake WebGLRenderer, as viewer-realistic.test.js does) so the handle is
// exercised against the actual render-mode machinery; the environment rig is
// mocked (no GL, no network). The harness otherwise follows
// mount-capture-view.test.js.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
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
    render() {}
    get capabilities() { return { maxTextureSize: 8192, textureTypeReadable: () => true }; }
    setRenderTarget() {}
    getRenderTarget() { return null; }
    getClearAlpha() { return 1; }
    setClearAlpha() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

const rigState = vi.hoisted(() => ({ loads: [], rigs: [], fail: false, gate: null }));
vi.mock("../../src/framework/materials/environment.js", async () => {
  const THREE = await import("three");
  return {
    loadEnvironmentRig: async (_r, id) => {
      rigState.loads.push(id);
      if (rigState.gate) await rigState.gate;
      if (rigState.fail) throw new Error("asset 404");
      const rig = {
        id, exposure: 1, envMap: new THREE.Texture(), background: new THREE.Color(0xffffff), backgroundBlurriness: 0,
        ground: new THREE.Mesh(), shadow: { group: new THREE.Group(), render: vi.fn(), setSize: vi.fn(), dispose: vi.fn() },
        setGround: vi.fn(), dispose: vi.fn(),
      };
      rigState.rigs.push(rig);
      return rig;
    },
  };
});

vi.mock("../../src/framework/selection/index.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    attachHoverLabels: vi.fn(() => ({ detach: vi.fn(), setSuppressed: vi.fn() })),
    attachPickToggle: vi.fn(() => ({ detach: vi.fn() })),
    attachPicker: vi.fn(() => ({ setActive: vi.fn(), detach: vi.fn() })),
  };
});

vi.mock("../../src/framework/pick-request/index.js", async () => ({
  ...(await import("../../src/framework/pick-request/endpoint.js")),
  createPickRequestClient: vi.fn(() => ({ detach: vi.fn() })),
}));

// The real viewer, captured so a test can read the live material's uniforms.
const viewers = vi.hoisted(() => []);
vi.mock("../../src/framework/viewer.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, createViewer: (...args) => { const v = real.createViewer(...args); viewers.push(v); return v; } };
});

// Counts the (probe-running) print-frame computations mount asks for.
const printFrameCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/framework/materials/print-frame.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, printFrameMatrix: (...args) => { printFrameCalls.count++; return real.printFrameMatrix(...args); } };
});

import { mount } from "../../src/framework/mount.js";

const OriginalResizeObserver = globalThis.ResizeObserver;

const makePart = (display) => ({
  meta: { title: "Realistic Fixture", backend: "manifold" },
  defaults: { h: 4 },
  views: { main: { label: "Main" } },
  parts: {
    body: {
      label: "Body", views: ["main"],
      ...(display ? { display } : {}),
      build: (k, p) => k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] }),
    },
  },
  parameters: [{ id: "size", title: "Size", advanced: [{ key: "h", label: "Height", min: 1, max: 10, step: 1 }] }],
});

// A real volume, so the viewer has bounds to frame and a ground to place.
const payload = (name) => ({
  name,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]),
  normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, -1, 0, 0, -1, 0, 0, -1, 0]),
  triangles: 2,
  edges: new Float32Array(0),
});

function makeElements({ realistic = false } = {}) {
  const mk = (tag = "div") => document.createElement(tag);
  const els = {
    viewer: mk(), controls: mk(), rail: mk(),
    status: { status: mk(), busy: mk(), phase: mk() },
    tabs: mk(),
    exports: { stl: mk("button"), step: mk("button"), threeMf: mk("button") },
    chrome: {
      reframe: mk("button"), theme: mk("button"), cutaway: mk("button"), railToggle: mk("button"),
      ...(realistic ? { realistic: mk("button"), environment: mk("select") } : {}),
    },
  };
  Object.defineProperties(els.viewer, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  document.body.append(els.viewer, els.controls, els.rail, els.tabs);
  return els;
}

function mountFixture(display, { viewerState, realistic } = {}) {
  const workers = {};
  const createWorker = (name) => {
    const w = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null };
    workers[name] = w;
    return w;
  };
  const els = makeElements({ realistic });
  const runtime = mount(makePart(display), { createWorker, elements: els, viewerState });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("body")], ms: 1 } });
  return { runtime, els };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  rigState.loads = [];
  rigState.rigs = [];
  rigState.fail = false;
  rigState.gate = null;
  viewers.length = 0;
  printFrameCalls.count = 0;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test("the runtime exposes renderMode/environment and carries them in viewer state", async () => {
  const { runtime } = mountFixture({ material: "brass" });
  await runtime.ready;
  expect(runtime.declaresMaterials).toBe(true);
  expect(runtime.renderMode.get()).toBe("cad");
  expect(runtime.environment.list().map((e) => e.id)).toEqual(["studio", "workshop", "print-bed", "outdoor"]);
  expect(runtime.environment.list()[2]).toEqual({ id: "print-bed", label: "Print bed" });
  expect(await runtime.renderMode.set("realistic")).toBe("realistic");
  expect(runtime.getViewerState()).toMatchObject({ renderMode: "realistic" });
  expect(runtime.getViewerState()).not.toHaveProperty("environment"); // the default, never chosen
  await runtime.environment.set("studio");
  expect(runtime.getViewerState()).toMatchObject({ renderMode: "realistic", environment: "studio" });
  runtime.dispose();
});

test("renderMode.onChange and environment.onChange relay the viewer's events", async () => {
  const { runtime } = mountFixture({ material: "brass" });
  await runtime.ready;
  const modes = [];
  const envs = [];
  const offMode = runtime.renderMode.onChange((e) => modes.push(e));
  runtime.environment.onChange((id) => envs.push(id));
  await runtime.renderMode.set("realistic");
  expect(modes).toEqual([
    { mode: "cad", busy: true, error: null },
    { mode: "realistic", busy: false, error: null },
  ]);
  expect(await runtime.environment.set("outdoor")).toBe("outdoor");
  expect(runtime.environment.get()).toBe("outdoor");
  expect(envs).toEqual(["outdoor"]);
  expect(modes.at(-1)).toEqual({ mode: "realistic", busy: false, error: null }); // the rig swap reports too
  const heard = modes.length;
  offMode();
  await runtime.renderMode.set("cad");
  expect(runtime.renderMode.get()).toBe("cad");
  expect(modes).toHaveLength(heard);
  runtime.dispose();
});

test("viewerState.renderMode restores on mount", async () => {
  const { runtime } = mountFixture({ material: "brass" }, { viewerState: { renderMode: "realistic", environment: "workshop" } });
  await runtime.ready;
  await vi.waitFor(() => expect(runtime.renderMode.get()).toBe("realistic"));
  expect(runtime.environment.get()).toBe("workshop");
  expect(rigState.loads).toEqual(["workshop"]); // the carried env, never the default first
  runtime.dispose();
});

test("the stored preference applies when no viewer state is carried", async () => {
  localStorage.setItem("partforge:renderMode", "realistic");
  localStorage.setItem("partforge:environment", "print-bed");
  const { runtime } = mountFixture({ material: "brass" });
  await runtime.ready;
  await vi.waitFor(() => expect(runtime.renderMode.get()).toBe("realistic"));
  expect(runtime.environment.get()).toBe("print-bed");
  runtime.dispose();
});

test("carried viewer state outranks the stored preference", async () => {
  localStorage.setItem("partforge:renderMode", "realistic");
  const { runtime } = mountFixture({ material: "brass" }, { viewerState: { renderMode: "cad" } });
  await runtime.ready;
  await Promise.resolve();
  expect(runtime.renderMode.get()).toBe("cad");
  expect(rigState.loads).toEqual([]);
  runtime.dispose();
});

test("the part's meta.environment is the default environment", async () => {
  const workers = {};
  const part = { ...makePart({ material: "brass" }), meta: { title: "Env Fixture", backend: "manifold", environment: "outdoor" } };
  const runtime = mount(part, {
    createWorker: (name) => (workers[name] = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }),
    elements: makeElements(),
  });
  expect(runtime.environment.get()).toBe("outdoor");
  runtime.dispose();
});

test("a part without materials reports declaresMaterials false", async () => {
  const { runtime } = mountFixture(undefined);
  expect(runtime.declaresMaterials).toBe(false);
  runtime.dispose();
});

test("renderViews renders through the viewer in the requested mode", async () => {
  const { runtime } = mountFixture({ material: "brass" });
  await runtime.ready;
  const shots = await runtime.renderViews(["front"], { renderMode: "realistic" });
  expect(shots.map((s) => s.view)).toEqual(["front"]);
  expect(shots[0].dataUrl).toMatch(/^data:image\//);
  expect(runtime.renderMode.get()).toBe("cad"); // a capture borrows, never switches
  runtime.dispose();
});

test("the viewbar toggle and environment menu drive the viewer", async () => {
  const { runtime, els } = mountFixture({ material: "brass" }, { realistic: true });
  await runtime.ready;
  const { realistic: toggle, environment: menu } = els.chrome;
  expect(menu.options.length).toBe(4);
  expect(menu.hidden).toBe(true);
  toggle.click();
  await vi.waitFor(() => expect(runtime.renderMode.get()).toBe("realistic"));
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(menu.hidden).toBe(false);
  menu.value = "workshop";
  menu.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(runtime.environment.get()).toBe("workshop"));
  await vi.waitFor(() => expect(localStorage.getItem("partforge:environment")).toBe("workshop"));
  expect(localStorage.getItem("partforge:renderMode")).toBe("realistic");
  runtime.dispose();
});

test("a layer-line material gets its print frame from the delivered pose", async () => {
  const workers = {};
  const part = makePart({ material: "pla-print" });
  // Displayed stood up a quarter turn about X, printed as built: display →
  // export is the inverse quarter turn, so the frame cannot be the identity.
  part.parts.body.place = (s, { purpose }) => (purpose === "export" ? s : s.rotate(90, [0, 0, 0], [1, 0, 0]));
  const runtime = mount(part, {
    createWorker: (name) => (workers[name] = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }),
    elements: makeElements(),
  });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("body")], ms: 1 } });
  await runtime.ready;
  expect(printFrameCalls.count).toBeGreaterThan(0);
  await runtime.renderMode.set("realistic");
  const m = viewers[0].__subMesh("body").material.userData.patternUniforms.pfPrintFrame.value.elements;
  // A display-frame point 1mm up (+Z) is, in the export frame, 1mm along +Y.
  const q = [m[8], m[9], m[10]].map((v) => Math.round(v * 1e9) / 1e9 + 0);
  expect(q).toEqual([0, 1, 0]);
  runtime.dispose();
});

test("a part with no layer-line material never probes for print frames", async () => {
  const { runtime } = mountFixture({ material: "brass" });
  await runtime.ready;
  expect(printFrameCalls.count).toBe(0);
  runtime.dispose();
});

// partforge-cloud remounts on EVERY edit, handing getViewerState() back, so
// what that state carries decides what survives an edit.
function mountPart(part, { viewerState, build = true } = {}) {
  const workers = {};
  const runtime = mount(part, {
    createWorker: (name) => (workers[name] = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }),
    elements: makeElements(),
    viewerState,
  });
  if (build) {
    workers.manifold.onmessage({ data: { type: "ready" } });
    workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("body")], ms: 1 } });
  }
  return runtime;
}
const withMetaEnv = (environment) => {
  const part = makePart({ material: "brass" });
  part.meta = { ...part.meta, environment };
  return part;
};

test("an environment nobody chose is not carried, so a later meta.environment applies", async () => {
  const first = mountPart(makePart({ material: "brass" }));
  await first.ready;
  const carried = first.getViewerState();
  first.dispose();
  expect(carried.environment).toBeUndefined();
  const second = mountPart(withMetaEnv("outdoor"), { viewerState: carried });
  expect(second.environment.get()).toBe("outdoor");
  second.dispose();
});

test("a chosen environment is carried and outranks meta.environment", async () => {
  const first = mountPart(makePart({ material: "brass" }));
  await first.ready;
  await first.environment.set("workshop");
  const carried = first.getViewerState();
  first.dispose();
  expect(carried.environment).toBe("workshop");
  const second = mountPart(withMetaEnv("outdoor"), { viewerState: carried });
  expect(second.environment.get()).toBe("workshop");
  // …and stays chosen, so it carries again on the next remount.
  expect(second.getViewerState().environment).toBe("workshop");
  second.dispose();
});

test("a carried realistic mode survives a remount before the first build", () => {
  const runtime = mountPart(makePart({ material: "brass" }), { viewerState: { renderMode: "realistic" }, build: false });
  expect(runtime.renderMode.get()).toBe("cad");
  expect(runtime.getViewerState().renderMode).toBe("realistic");
  runtime.dispose();
});

test("a realistic switch still loading is reported as realistic", async () => {
  let open;
  rigState.gate = new Promise((r) => { open = r; });
  const runtime = mountPart(makePart({ material: "brass" }), { viewerState: { renderMode: "realistic" } });
  await runtime.ready;
  await vi.waitFor(() => expect(rigState.loads).toHaveLength(1));
  expect(runtime.renderMode.get()).toBe("cad");
  expect(runtime.getViewerState().renderMode).toBe("realistic");
  open();
  await vi.waitFor(() => expect(runtime.renderMode.get()).toBe("realistic"));
  runtime.dispose();
});

test("a restore whose assets fail settles to CAD in viewer state", async () => {
  rigState.fail = true;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const runtime = mountPart(makePart({ material: "brass" }), { viewerState: { renderMode: "realistic" } });
  await runtime.ready;
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("partforge: the realistic view failed to load", expect.any(Error)));
  expect(runtime.renderMode.get()).toBe("cad");
  expect(runtime.getViewerState().renderMode).toBe("cad");
  runtime.dispose();
});

test("an explicit CAD before the first build cancels the carried realistic", async () => {
  let open;
  rigState.gate = new Promise((r) => { open = r; });
  const runtime = mountPart(makePart({ material: "brass" }), { viewerState: { renderMode: "realistic" }, build: false });
  await runtime.renderMode.set("cad");
  expect(runtime.getViewerState().renderMode).toBe("cad");
  open(); // the restore's load lands after the explicit CAD: it must not win
  await vi.waitFor(() => expect(rigState.loads).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 0));
  expect(runtime.renderMode.get()).toBe("cad");
  expect(runtime.getViewerState().renderMode).toBe("cad");
  runtime.dispose();
});

// Every remount has a fresh renderer, so a carried realistic view has to load
// its environment again: starting that at mount (not at the first build) runs
// it alongside the build, instead of showing CAD until the build and then
// waiting on the assets.
test("a carried realistic mode starts loading its environment before the first build", () => {
  const runtime = mountPart(makePart({ material: "brass" }), { viewerState: { renderMode: "realistic", environment: "workshop" }, build: false });
  expect(rigState.loads).toEqual(["workshop"]);
  expect(runtime.getViewerState().renderMode).toBe("realistic");
  runtime.dispose();
});

test("a stored realistic preference starts loading before the first build too", () => {
  localStorage.setItem("partforge:renderMode", "realistic");
  const runtime = mountPart(makePart({ material: "brass" }), { build: false });
  expect(rigState.loads).toEqual(["studio"]);
  runtime.dispose();
});

test("a realistic view that lands before the first build still grounds the part once it arrives", async () => {
  const workers = {};
  const runtime = mount(makePart({ material: "brass" }), {
    createWorker: (name) => (workers[name] = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }),
    elements: makeElements(),
    viewerState: { renderMode: "realistic" },
  });
  await vi.waitFor(() => expect(runtime.renderMode.get()).toBe("realistic"));
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("body")], ms: 1 } });
  await runtime.ready;
  const rig = rigState.rigs[0];
  expect(rig.setGround).toHaveBeenCalled(); // the ground came to the part when it arrived
  expect(rig.setGround.mock.calls.at(-1)[0].radius).toBeGreaterThan(0);
  expect(runtime.renderMode.get()).toBe("realistic");
  runtime.dispose();
});

// partforge-cloud's sandbox frame has an opaque origin, where merely touching
// localStorage throws. A carried realistic view still has to mount, restore
// and report — including before the first build, which is when a host that
// remounts per edit may ask for the state again.
test("with storage that throws on every access, a carried realistic view mounts, restores and reports", async () => {
  const STORES = ["localStorage", "sessionStorage"];
  const ownerOf = (key) => (Object.hasOwn(window, key) ? window : Object.getPrototypeOf(window));
  const saved = STORES.map((key) => [key, ownerOf(key), Object.getOwnPropertyDescriptor(ownerOf(key), key)]);
  const denied = () => { throw new DOMException("denied", "SecurityError"); };
  for (const key of STORES) Object.defineProperty(window, key, { configurable: true, get: denied });
  try {
    expect(() => localStorage).toThrow("denied"); // the bare globals the modules read
    expect(() => sessionStorage).toThrow("denied");
    const workers = {};
    const runtime = mount(makePart({ material: "brass" }), {
      createWorker: (name) => (workers[name] = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }),
      elements: makeElements({ realistic: true }),
      viewerState: { renderMode: "realistic", environment: "workshop" },
    });
    // Before the first build.
    expect(runtime.getViewerState()).toMatchObject({ renderMode: "realistic", environment: "workshop" });
    workers.manifold.onmessage({ data: { type: "ready" } });
    workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("body")], ms: 1 } });
    await runtime.ready;
    await vi.waitFor(() => expect(runtime.renderMode.get()).toBe("realistic"));
    expect(runtime.environment.get()).toBe("workshop");
    expect(rigState.loads).toEqual(["workshop"]);
    expect(runtime.getViewerState()).toMatchObject({ renderMode: "realistic", environment: "workshop" });
    // Choosing again (which tries to persist) must not throw either.
    await expect(runtime.environment.set("outdoor")).resolves.toBe("outdoor");
    await expect(runtime.renderMode.set("cad")).resolves.toBe("cad");
    runtime.dispose();
  } finally {
    for (const [key, owner, descriptor] of saved) {
      delete window[key];
      if (descriptor && !Object.getOwnPropertyDescriptor(owner, key)) Object.defineProperty(owner, key, descriptor);
    }
  }
});
