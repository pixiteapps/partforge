// @vitest-environment happy-dom
// captureView(): the off-loop offscreen thumbnail on the mount handle (Task 4C).
// It ties together the capture-build channel (4A, capture-build.js) and
// viewer.renderMeshPayloads (4B) to render a NAMED (or default) view without
// disturbing the active tab / live scene. Kept in its own file: mount.test.js
// already covers the rest of the handle shape, and every framework-mount test
// mocks viewer.js wholesale (no real WebGL/kernel boot here either) — this file
// just adds a `renderMeshPayloads` spy to that same fake viewer.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fakeViewers = [];
vi.mock("../../src/framework/viewer.js", () => ({
  createViewer: vi.fn(() => {
    const built = new Set();
    const frameCbs = new Set();
    const orbitCbs = new Set();
    const themeCbs = new Set();
    const projectionCbs = new Set();
    let projection = "perspective";
    const v = {
      onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
      onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
      tweenCameraTo: vi.fn((view, { onComplete } = {}) => onComplete?.()),
      cancelCameraTween: vi.fn(),
      tickFrame: (dt) => { for (const cb of [...frameCbs]) cb(dt); },
      domElement: document.createElement("div"),
      showAssembly: vi.fn(),
      hideAssembly: vi.fn(),
      setSubGeometry: vi.fn((name) => built.add(name)),
      setSubPose: vi.fn(),
      hasSubMesh: (name) => built.has(name),
      subTriangles: () => 0,
      frame: vi.fn(),
      setTheme: vi.fn(),
      getCameraState: vi.fn(() => ({ pos: [0, 0, 0], target: [0, 0, 0] })),
      setCameraState: vi.fn(),
      onCameraEnd: vi.fn(),
      // The view cube (mounted for every part now — Task 12) subscribes to all
      // three and reads the camera's quaternion every frame through its dirty
      // check; see mount.test.js's identical fake for the full rationale.
      camera: { quaternion: { x: 0, y: 0, z: 0, w: 1 }, isOrthographicCamera: false, zoom: 1 },
      onThemeChange: (cb) => { themeCbs.add(cb); return () => themeCbs.delete(cb); },
      getTheme: () => "dark",
      getProjection: () => projection,
      setProjection: vi.fn((mode) => {
        projection = mode === "orthographic" ? "orthographic" : "perspective";
        for (const cb of [...projectionCbs]) cb(projection);
        return projection;
      }),
      onProjectionChange: (cb) => { projectionCbs.add(cb); return () => projectionCbs.delete(cb); },
      // Realistic mode's surface (mount wires the toggle, the environment
      // picker and the handle to it); mount-realistic.test.js runs the real one.
      getRenderMode: () => "cad",
      setRenderMode: vi.fn(async () => "cad"),
      onRenderModeChange: () => () => {},
      // Feature lines' surface (mount restores/persists it, and wires the
      // handle); mount-realistic.test.js exercises the real machinery.
      getFeatureLines: () => true,
      getFeatureLinesPrefs: vi.fn(() => ({})),
      setFeatureLines: vi.fn(),
      setFeatureLinesPrefs: vi.fn(),
      onFeatureLinesChange: () => () => {},
      getEnvironment: () => "studio",
      setEnvironment: vi.fn(async (id) => id),
      onEnvironmentChange: () => () => {},
      setPrintFrames: vi.fn(),
      orbitBy: vi.fn(),
      _subMeshes: {},
      flashPoint: vi.fn(),
      cutawaySupported: vi.fn(() => true),
      cutawayEnabled: vi.fn(() => false),
      setCutawayEnabled: vi.fn(() => true),
      flipCutaway: vi.fn(),
      resetCutaway: vi.fn(),
      isWorldPointVisible: vi.fn(() => true),
      registerCutawayMaterial: vi.fn(() => vi.fn()),
      // The seam under test: renderMeshPayloads is a pure offscreen render in
      // the real viewer (see viewer-capture-view.test.js), never touching the
      // live scene. Faked here as a spy so this file stays GL-free like the
      // rest of the mount suite — the "real render" contract is 4B's job.
      renderMeshPayloads: vi.fn((meshes) => `data:image/jpeg;base64,FAKE-${meshes.map((m) => m.name).join(",")}`),
      dispose: vi.fn(),
    };
    fakeViewers.push(v);
    return v;
  }),
}));

vi.mock("../../src/framework/selection/index.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    attachHoverLabels: vi.fn(() => ({ detach: vi.fn() })),
    attachPickToggle: vi.fn(() => ({ detach: vi.fn() })),
    attachPicker: vi.fn(() => ({ setActive: vi.fn(), detach: vi.fn() })),
  };
});

vi.mock("../../src/framework/pick-request/index.js", async () => ({
  ...(await import("../../src/framework/pick-request/endpoint.js")),
  createPickRequestClient: vi.fn(() => ({ detach: vi.fn() })),
}));

vi.mock("../../src/framework/tooltip.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createTooltipPresenter: vi.fn(() => ({
      showPointer: vi.fn(() => Symbol("pointer")),
      showAnchor: vi.fn(() => Symbol("anchor")),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
  };
});

vi.mock("../../src/framework/cutaway-controls.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, attachCutawayControls: vi.fn(real.attachCutawayControls) };
});

vi.mock("../../src/framework/viewer-controls.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, attachViewerControls: vi.fn(real.attachViewerControls) };
});

import { mount } from "../../src/framework/mount.js";

// Two views, deliberately unbalanced so resolveDefaultView (default-view.js:
// biggest placement wins) picks "assembly" — it places both sub-parts, "detail"
// only one — while the test starts the active TAB on "detail" via a pre-seeded
// sessionStorage entry (view-state.js's per-part session key), the same
// mechanism a returning browser tab uses. That gap between "active tab" and
// "resolved default" is exactly what proves captureView() targets the default,
// not the active view.
const PART_TITLE = "Capture View Fixture";
const makePart = () => ({
  meta: { title: PART_TITLE, backend: "manifold" }, // pinned backend: no probe run
  defaults: { h: 4 },
  views: { assembly: { label: "Assembly" }, detail: { label: "Detail" } },
  parts: {
    body: {
      label: "Body", views: ["assembly", "detail"],
      build: (k, p) => k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] }),
    },
    // Only placed in "assembly" — the sub-part that gives it the win over
    // "detail" in resolveDefaultView's placement count, and the name we
    // assert appears in the capture-generate job's subparts.
    bracket: {
      label: "Bracket", views: ["assembly"],
      build: (k, p) => k.box({ min: [0, 0, 0], max: [1, 1, p.h] }),
    },
  },
  parameters: [{ id: "size", title: "Size", advanced: [{ key: "h", label: "Height", min: 1, max: 10, step: 1 }] }],
});

function makeWorkers() {
  const workers = {};
  const createWorker = (name) => {
    const w = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null };
    workers[name] = w;
    return w;
  };
  return { workers, createWorker };
}

function makeElements() {
  const mk = (tag = "div") => document.createElement(tag);
  const els = {
    viewer: mk(), controls: mk(), rail: mk(),
    status: { status: mk(), busy: mk(), phase: mk() },
    tabs: mk(),
    exports: { stl: mk("button"), step: mk("button"), threeMf: mk("button") },
    chrome: {
      reframe: mk("button"),
      theme: mk("button"),
      cutaway: mk("button"),
      railToggle: mk("button"),
    },
  };
  document.body.append(els.viewer, els.controls, els.rail, els.tabs,
    els.status.status, els.status.busy, els.status.phase,
    els.exports.stl, els.exports.step, els.exports.threeMf,
    els.chrome.reframe, els.chrome.theme, els.chrome.cutaway,
    els.chrome.railToggle);
  return els;
}

// Seeds the session-saved active view to "detail" (view-state.js's key format)
// BEFORE mount() runs, so createViewTabs opens on "detail" instead of the
// resolved default "assembly" — mirroring a returning browser tab.
function seedActiveViewToDetail() {
  sessionStorage.setItem(`partforge:view:${PART_TITLE}`, "detail");
}

// Drive the fake manifold worker through kernel-ready + one successful build of
// whatever the active view currently needs, so `runtime.ready` settles.
function finishFirstBuild(workers, subparts, ms = 42) {
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({
    data: { type: "meshes", meshes: subparts.map((name) => ({ name })), ms },
  });
}

// Finds the capture-generate job most recently posted to the manifold worker
// and resolves it with a capture-meshes reply carrying the given sub-part names.
function resolveCaptureBuild(workers, meshNames) {
  const calls = workers.manifold.postMessage.mock.calls
    .map(([m]) => m)
    .filter((m) => m.type === "capture-generate");
  const job = calls.at(-1);
  expect(job).toBeTruthy();
  workers.manifold.onmessage({
    data: { type: "capture-meshes", jobId: job.jobId, meshes: meshNames.map((name) => ({ name })) },
  });
  return job;
}

async function mountFixture() {
  seedActiveViewToDetail();
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers, ["body"]); // "detail" view only needs "body"
  await runtime.ready;
  return { runtime, workers };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  fakeViewers.length = 0;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

test("captureView() builds and renders the DEFAULT view, not the active tab", async () => {
  const { runtime, workers } = await mountFixture();
  expect(runtime.getView()).toBe("detail"); // seeded active tab, confirmed distinct from default

  const promise = runtime.captureView(); // no name -> resolveDefaultView(part) === "assembly"
  const job = resolveCaptureBuild(workers, ["body", "bracket"]);
  const url = await promise;

  // Targeted the default view's sub-parts (includes "bracket", "detail" excludes it).
  expect(job.view).toBe("assembly");
  expect(job.subparts.sort()).toEqual(["body", "bracket"]);
  expect(job.cache).toBe(true);

  // Rendered via the real seam (viewer.renderMeshPayloads), fed the capture reply.
  const viewer = fakeViewers[0];
  expect(viewer.renderMeshPayloads).toHaveBeenCalledOnce();
  const [meshes, opts] = viewer.renderMeshPayloads.mock.calls[0];
  expect(meshes.map((m) => m.name).sort()).toEqual(["body", "bracket"]);
  expect(opts).toMatchObject({ size: 640, quality: 0.8, angle: "iso" });
  expect(url).toBe(`data:image/jpeg;base64,FAKE-${meshes.map((m) => m.name).join(",")}`);

  runtime.dispose();
});

test("captureView() never mutates the active view or the live scene", async () => {
  const { runtime, workers } = await mountFixture();
  const viewer = fakeViewers[0];
  const activeBefore = runtime.getView();
  const liveCallsBefore = viewer.setSubGeometry.mock.calls.length;
  const showAssemblyBefore = viewer.showAssembly.mock.calls.length;

  const promise = runtime.captureView();
  resolveCaptureBuild(workers, ["body", "bracket"]);
  await promise;

  expect(runtime.getView()).toBe(activeBefore); // active tab untouched
  expect(viewer.setSubGeometry.mock.calls.length).toBe(liveCallsBefore); // no live cache writes
  expect(viewer.showAssembly.mock.calls.length).toBe(showAssemblyBefore); // no live redraw
  expect(viewer.hasSubMesh("bracket")).toBe(false); // "bracket" never entered the live scene

  runtime.dispose();
});

test("captureView(unknownName) falls back to the default view", async () => {
  const { runtime, workers } = await mountFixture();

  const promise = runtime.captureView("no-such-view");
  const job = resolveCaptureBuild(workers, ["body", "bracket"]);
  const url = await promise;

  expect(job.view).toBe("assembly"); // fell back to resolveDefaultView(part)
  expect(url).toMatch(/^data:image\/jpeg;base64,/);
  expect(runtime.getView()).toBe("detail"); // still untouched

  runtime.dispose();
});

test("captureView() resolves null when the build channel reports a worker failure", async () => {
  const { runtime, workers } = await mountFixture();

  const promise = runtime.captureView();
  const calls = workers.manifold.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === "capture-generate");
  const job = calls.at(-1);
  // capture-build.js resolves to null (not a throw) on an "error"/"needs-occt"
  // reply — the resolved-null path the try/catch alone would NOT cover.
  workers.manifold.onmessage({ data: { type: "error", jobId: job.jobId, message: "boom" } });

  await expect(promise).resolves.toBeNull();
  expect(fakeViewers[0].renderMeshPayloads).not.toHaveBeenCalled();

  runtime.dispose();
});

// Fix round (task-9 review): a needs-import-mesh reply tagged with the capture
// job's own jobId must be claimed by capture-build.js and never reach mount's
// live-loop crossover case. Proven two ways: (1) no tessellate-imports request
// ever goes to the OCCT worker for this off-loop capture failure, and (2) the
// live crossover's importMeshState latch is left untouched — a SUBSEQUENT
// live-generate needs-import-mesh (no jobId, exactly like the mount.test.js
// coverage) still requests tessellation for the first time, which it could not
// do if the capture reply had already flipped the latch to "requested".
test("captureView()'s needs-import-mesh reply never touches the live crossover state", async () => {
  const { runtime, workers } = await mountFixture();

  const promise = runtime.captureView();
  const calls = workers.manifold.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === "capture-generate");
  const job = calls.at(-1);
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: job.jobId, subparts: ["body"] } });

  await expect(promise).resolves.toBeNull();
  expect(fakeViewers[0].renderMeshPayloads).not.toHaveBeenCalled();
  // No stray tessellation request from the off-loop capture failure.
  expect(workers.occt.postMessage).not.toHaveBeenCalled();

  // A genuine LIVE needs-import-mesh (no jobId) still triggers a fresh
  // tessellate-imports request — proof the capture reply above left
  // importMeshState alone rather than pre-latching it to "requested".
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", subparts: ["body"] } });
  expect(workers.occt.postMessage).toHaveBeenCalledTimes(1);
  expect(workers.occt.postMessage.mock.calls[0][0]).toMatchObject({ type: "tessellate-imports" });

  runtime.dispose();
});
