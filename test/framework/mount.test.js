// @vitest-environment happy-dom
// The mount() embedding contract: element refs, { ready, dispose }, onBuild, onPick.
// The viewer and selection adapters are mocked (WebGL + raycasting are browser-only);
// everything else — status-ui, view-tabs, controls, regen-loop, mesh-cache,
// geometry-service — runs for real against fake workers.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fakeViewers = [];
const fakeTooltips = [];
vi.mock("../../src/framework/viewer.js", () => ({
  createViewer: vi.fn(() => {
    const built = new Set();
    let cutawayOn = false;
    // Animation-driver surface: the transport bar subscribes to the frame loop
    // and to orbit starts. tickFrame(dt) is the test's hand on that loop.
    const frameCbs = new Set();
    const orbitCbs = new Set();
    const themeCbs = new Set();
    const projectionCbs = new Set();
    const flashAnchorCbs = new Set();
    let projection = "perspective";
    const v = {
      onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
      onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
      tweenCameraTo: vi.fn((view, { onComplete } = {}) => onComplete?.()), // settles instantly
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
      // The view cube subscribes to all three and reads the camera's
      // quaternion every frame through its dirty check.
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
      holdFlashPoint: vi.fn(() => true),
      releaseFlashPoints: vi.fn(),
      onFlashAnchorChange: (cb) => { flashAnchorCbs.add(cb); return () => flashAnchorCbs.delete(cb); },
      // The test's hand on the viewer's anchor stream, as tickFrame is on the
      // frame loop — the real one fires from the render loop.
      emitFlashAnchor: (anchor) => { for (const cb of [...flashAnchorCbs]) cb(anchor); },
      cutawaySupported: vi.fn(() => true),
      cutawayEnabled: vi.fn(() => cutawayOn),
      setCutawayEnabled: vi.fn((on) => {
        cutawayOn = on;
        return true;
      }),
      // State carry-over across a remount. `cutawayOn` is shared with
      // cutawayEnabled above, so a restore here really does light the button
      // the way the real viewer would.
      getCutawayState: vi.fn(() => (cutawayOn
        ? { enabled: true, flipped: false, pose: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] } }
        : { enabled: false, flipped: false, pose: null })),
      setCutawayState: vi.fn((state) => {
        if (!state?.enabled) return true;
        cutawayOn = true;
        return true;
      }),
      flipCutaway: vi.fn(),
      resetCutaway: vi.fn(),
      isWorldPointVisible: vi.fn(() => true),
      registerCutawayMaterial: vi.fn(() => vi.fn()),
      // Opacity overrides: an animation's fade writes them, and handing a view
      // back must clear them (see the view-switch test at the end of the file).
      setSubPartOpacity: vi.fn(),
      clearSubPartOpacities: vi.fn(),
      dispose: vi.fn(),
    };
    fakeViewers.push(v);
    return v;
  }),
}));

vi.mock("../../src/framework/selection/index.js", async (importOriginal) => {
  const real = await importOriginal(); // keep formatSelection real — the prompt text matters
  return {
    ...real,
    // setSuppressed: real hover.js's toggle for measure/annotate mode, exercised
    // now that a mount.test.js test actually flips Sketch on inside a full mount.
    attachHoverLabels: vi.fn(() => ({ detach: vi.fn(), setSuppressed: vi.fn() })),
    attachPickToggle: vi.fn(() => ({ detach: vi.fn() })),
    attachPicker: vi.fn(() => ({ setActive: vi.fn(), detach: vi.fn() })),
  };
});

// Only the client is faked — the loopback gate mount() applies to ?pickserver is the
// real one, so the tests below exercise the actual URL validation.
vi.mock("../../src/framework/pick-request/index.js", async () => ({
  ...(await import("../../src/framework/pick-request/endpoint.js")),
  createPickRequestClient: vi.fn(() => ({ detach: vi.fn() })),
}));

vi.mock("../../src/framework/tooltip.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createTooltipPresenter: vi.fn(() => {
      const presenter = {
        showPointer: vi.fn(() => Symbol("pointer")),
        showAnchor: vi.fn(() => Symbol("anchor")),
        hide: vi.fn(),
        dispose: vi.fn(),
      };
      fakeTooltips.push(presenter);
      return presenter;
    }),
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

// Delegates to the real transport (makePart declares no animations, so it
// returns null either way) purely to capture the crowding callback mount wires
// into it. Driving that callback by hand is the only deterministic way to reach
// mount's OR of the two hide reasons: real crowding needs layout, which
// happy-dom does not have. The geometry side is pinned in
// animation-controls.test.js.
// lastAnimCtl: the real handle attachAnimationControls returns, stashed the
// same way crowdedHook.report captures opts.onCrowded — lets a test spy on
// the real notifyUserEdit/setHidden to pin call ORDER for the sketch-mode
// wiring in mount.js, without adding any new fake surface.
const crowdedHook = { report: null };
let lastAnimCtl = null;
vi.mock("../../src/framework/animation-controls.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    attachAnimationControls: vi.fn((viewer, part, opts) => {
      crowdedHook.report = opts.onCrowded;
      lastAnimCtl = real.attachAnimationControls(viewer, part, opts);
      return lastAnimCtl;
    }),
  };
});

import { mount, makeHandle } from "../../src/framework/mount.js";
import { attachPicker, attachPickToggle, attachHoverLabels } from "../../src/framework/selection/index.js";
import { attachCutawayControls } from "../../src/framework/cutaway-controls.js";
import { attachViewerControls } from "../../src/framework/viewer-controls.js";
import { createTooltipPresenter } from "../../src/framework/tooltip.js";

// `build` is written like a real part (options-form box + rigid rotateAbout), not
// against a null kernel: the pose probe and the relevance probe both RUN it for
// real against their stub kernels, and `tilt` is the pose-only param the fast
// path repairs without a rebuild.
const makePart = () => ({
  meta: { title: "Test Part", backend: "manifold" }, // pinned backend: no probe run
  defaults: { h: 4, tilt: 0 },
  views: { main: { label: "Main" } },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) =>
    k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] })
      .rotateAbout({ axis: "X", deg: p.tilt, through: [0, 0, 0] }) } },
  parameters: [{ id: "size", title: "Size",
    advanced: [
      { key: "h", label: "Height", min: 1, max: 10, step: 1 },
      { key: "tilt", label: "Tilt", min: 0, max: 90, step: 1 },
    ] }],
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
      measure: mk("button"),
      annotate: mk("button"),
      railToggle: mk("button"),
    },
  };
  document.body.append(els.viewer, els.controls, els.rail, els.tabs,
    els.status.status, els.status.busy, els.status.phase,
    els.exports.stl, els.exports.step, els.exports.threeMf,
    els.chrome.reframe, els.chrome.theme, els.chrome.cutaway, els.chrome.measure,
    els.chrome.annotate, els.chrome.railToggle);
  return els;
}

// Drive the fake manifold worker: kernel ready, then one successful build.
function finishFirstBuild(workers, ms = 42) {
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms } });
}

// mount() with elements.rail reparented under a real .pf-shell wrapper before
// mounting — attachMobileTabs (like attachRail) resolves its shell as
// rail.parentElement, so the bar needs a real ancestor to land on, not the
// bare document.body every other test's makeElements() leaves it in.
async function mountFixture() {
  const els = makeElements();
  const shell = document.createElement("div");
  shell.className = "pf-shell";
  shell.append(els.viewer, els.rail); // reparent before mount() resolves the shell
  document.body.append(shell);
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  return { runtime, shell };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  fakeViewers.length = 0;
  fakeTooltips.length = 0;
  crowdedHook.report = null; // never let one test's callback stand in for another's
  lastAnimCtl = null;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

test("ready resolves after the first successful build; no getElementById with full refs", () => {
  const spy = vi.spyOn(document, "getElementById");
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  expect(spy).not.toHaveBeenCalled();
  finishFirstBuild(workers);
  return expect(runtime.ready).resolves.toBeUndefined();
});

test("mount creates one tooltip presenter and shares it with every viewer consumer", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const part = makePart();

  const runtime = mount(part, { createWorker, elements: els });

  expect(createTooltipPresenter).toHaveBeenCalledOnce();
  expect(createTooltipPresenter).toHaveBeenCalledWith({ id: null });
  const tooltip = fakeTooltips[0];
  const viewer = fakeViewers[0];
  expect(attachCutawayControls).toHaveBeenCalledWith(
    viewer,
    { cutaway: els.chrome.cutaway },
    { tooltip, escapeGuard: expect.any(Function) },
  );
  expect(attachHoverLabels).toHaveBeenCalledWith(viewer, { part, tooltip });
  expect(attachViewerControls).toHaveBeenCalledWith(viewer, els.chrome, { tooltip });
  runtime.dispose();
});

test("runtime.attachTooltips joins a host button to the shared tooltip and detaches on dispose", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const tooltip = fakeTooltips[0];

  const button = document.createElement("button");
  button.title = "Send feedback";
  document.body.append(button);
  const binding = runtime.attachTooltips([{ element: button }]);

  // The title is absorbed while attached (it would double up as a native
  // tooltip beside the shared one) and stands in as the shown label.
  expect(button.hasAttribute("title")).toBe(false);
  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(tooltip.showAnchor).toHaveBeenCalledWith({ title: "Send feedback" }, button);
  button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));

  // A disabled button never presents; sync() after re-enabling is enough.
  button.disabled = true;
  tooltip.showAnchor.mockClear();
  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(tooltip.showAnchor).not.toHaveBeenCalled();
  button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
  button.disabled = false;
  binding.sync();
  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(tooltip.showAnchor).toHaveBeenCalledWith({ title: "Send feedback" }, button);

  runtime.dispose(); // detaches the binding: title restored, listeners gone
  expect(button.title).toBe("Send feedback");
  tooltip.showAnchor.mockClear();
  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(tooltip.showAnchor).not.toHaveBeenCalled();
  expect(() => binding.detach()).not.toThrow(); // idempotent after dispose()
});

test("mount detaches tooltip consumers before disposing the shared presenter once", () => {
  const order = [];
  const cutaway = { reset: vi.fn(), detach: vi.fn(() => order.push("cutaway")) };
  const hover = { detach: vi.fn(() => order.push("hover")) };
  const chrome = { detach: vi.fn(() => order.push("chrome")) };
  const tooltip = {
    showPointer: vi.fn(), showAnchor: vi.fn(), hide: vi.fn(),
    dispose: vi.fn(() => order.push("tooltip")),
  };
  attachCutawayControls.mockImplementationOnce(() => cutaway);
  attachHoverLabels.mockImplementationOnce(() => hover);
  attachViewerControls.mockImplementationOnce(() => chrome);
  createTooltipPresenter.mockImplementationOnce(() => tooltip);
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  fakeViewers[0].dispose.mockImplementationOnce(() => order.push("viewer"));

  runtime.dispose();
  runtime.dispose();

  expect(cutaway.detach).toHaveBeenCalledOnce();
  expect(hover.detach).toHaveBeenCalledOnce();
  expect(chrome.detach).toHaveBeenCalledOnce();
  expect(tooltip.dispose).toHaveBeenCalledOnce();
  expect(order.indexOf("tooltip")).toBeGreaterThan(order.indexOf("cutaway"));
  expect(order.indexOf("tooltip")).toBeGreaterThan(order.indexOf("hover"));
  expect(order.indexOf("tooltip")).toBeGreaterThan(order.indexOf("chrome"));
  expect(order.indexOf("tooltip")).toBeLessThan(order.indexOf("viewer"));
});

test("construction failure unwinds every resource acquired before worker creation", () => {
  const cutaway = { reset: vi.fn(), detach: vi.fn() };
  const hover = { detach: vi.fn() };
  const tooltip = {
    showPointer: vi.fn(), showAnchor: vi.fn(), hide: vi.fn(), dispose: vi.fn(),
  };
  attachCutawayControls.mockImplementationOnce(() => cutaway);
  attachHoverLabels.mockImplementationOnce(() => hover);
  createTooltipPresenter.mockImplementationOnce(() => tooltip);
  const manifold = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null };
  const createWorker = vi.fn((name) => {
    if (name === "manifold") return manifold;
    throw new Error("occt worker failed");
  });
  const els = makeElements();

  expect(() => mount(makePart(), { createWorker, elements: els }))
    .toThrow("occt worker failed");

  expect(manifold.terminate).toHaveBeenCalledOnce();
  expect(hover.detach).toHaveBeenCalledOnce();
  expect(cutaway.detach).toHaveBeenCalledOnce();
  expect(tooltip.dispose).toHaveBeenCalledOnce();
  expect(fakeViewers[0].dispose).toHaveBeenCalledOnce();
  expect(els.tabs.children.length).toBe(0);
  expect(els.status.status.textContent).toBe("");
});

test("dispose reports a detach error only after all other resources are released", () => {
  const detachError = new Error("hover detach failed");
  const cutaway = { reset: vi.fn(), detach: vi.fn() };
  const hover = { detach: vi.fn(() => { throw detachError; }) };
  const chrome = { detach: vi.fn() };
  const tooltip = {
    showPointer: vi.fn(), showAnchor: vi.fn(), hide: vi.fn(), dispose: vi.fn(),
  };
  attachCutawayControls.mockImplementationOnce(() => cutaway);
  attachHoverLabels.mockImplementationOnce(() => hover);
  attachViewerControls.mockImplementationOnce(() => chrome);
  createTooltipPresenter.mockImplementationOnce(() => tooltip);
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });

  expect(() => runtime.dispose()).toThrow(detachError);

  expect(chrome.detach).toHaveBeenCalledOnce();
  expect(cutaway.detach).toHaveBeenCalledOnce();
  expect(tooltip.dispose).toHaveBeenCalledOnce();
  expect(workers.manifold.terminate).toHaveBeenCalledOnce();
  expect(workers.occt.terminate).toHaveBeenCalledOnce();
  expect(els.controls.children.length).toBe(0);
  expect(els.tabs.children.length).toBe(0);
  expect(fakeViewers[0].dispose).toHaveBeenCalledOnce();
  expect(() => runtime.dispose()).not.toThrow();
});

test("full element refs wire cutaway without getElementById lookup", () => {
  const spy = vi.spyOn(document, "getElementById");
  const els = makeElements();
  const { createWorker } = makeWorkers();

  mount(makePart(), { createWorker, elements: els });
  els.chrome.cutaway.click();

  expect(spy).not.toHaveBeenCalled();
  expect(fakeViewers[0].setCutawayEnabled).toHaveBeenCalledWith(true);
});

test("legacy host page resolves the #cutaway fallback", () => {
  document.body.innerHTML = `
    <div id="app"></div><div id="controls"></div>
    <div id="status"></div><div id="busy"><div id="phase"></div></div>
    <div id="part"></div>
    <button id="download"></button><button id="download-step"></button>
    <button id="cutaway"></button>`;
  const { createWorker } = makeWorkers();

  mount(makePart(), { createWorker });
  document.getElementById("cutaway").click();

  expect(fakeViewers[0].setCutawayEnabled).toHaveBeenCalledWith(true);
});

test("legacy host page resolves the #rail-toggle fallback and it collapses the rail", () => {
  document.body.innerHTML = `
    <div id="app"></div><div id="controls"></div>
    <div id="status"></div><div id="busy"><div id="phase"></div></div>
    <div id="part"></div>
    <button id="download"></button><button id="download-step"></button>
    <div id="panel"></div>
    <button id="rail-toggle"></button>`;
  const { createWorker } = makeWorkers();

  mount(makePart(), { createWorker });
  const toggle = document.getElementById("rail-toggle");
  // attachRail labels the button on attach — proof mount handed it over.
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  toggle.click();
  expect(document.getElementById("panel").hasAttribute("inert")).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--pf-rail-w")).toBe("0px");
});

test("legacy host page mounts with no #rail-toggle — the rail still attaches without one", () => {
  document.body.innerHTML = `
    <div id="app"></div><div id="controls"></div>
    <div id="status"></div><div id="busy"><div id="phase"></div></div>
    <div id="part"></div>
    <button id="download"></button><button id="download-step"></button>
    <div id="panel"></div>`;
  // A host driving the rail from its own UI (partforge-cloud hides #theme for
  // exactly this reason) must not be forced to supply this button.
  expect(document.getElementById("rail-toggle")).toBeNull();
  const { createWorker } = makeWorkers();

  expect(() => mount(makePart(), { createWorker })).not.toThrow();

  expect(document.querySelector(".pf-rail-seam")).not.toBeNull();
});

test("cutaway UI interactions never dispatch geometry worker jobs", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  workers.manifold.postMessage.mockClear();
  workers.occt.postMessage.mockClear();

  els.chrome.cutaway.click();
  const [flip, reset] = els.chrome.cutaway.nextElementSibling.querySelectorAll("button");
  flip.click();
  reset.click();

  expect(workers.manifold.postMessage).not.toHaveBeenCalled();
  expect(workers.occt.postMessage).not.toHaveBeenCalled();
});

test("switching views disables cutaway and resets its control UI immediately", () => {
  const part = makePart();
  part.views.other = { label: "Other" };
  part.parts.body.views = ["main", "other"];
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(part, { createWorker, elements: els });
  finishFirstBuild(workers);
  els.chrome.cutaway.click();
  const actions = els.chrome.cutaway.nextElementSibling;
  expect(els.chrome.cutaway.getAttribute("aria-pressed")).toBe("true");
  expect(actions.hidden).toBe(false);
  fakeViewers[0].setCutawayEnabled.mockClear();

  [...els.tabs.querySelectorAll("button")]
    .find((button) => button.textContent === "Other")
    .click();

  expect(fakeViewers[0].setCutawayEnabled).toHaveBeenCalledWith(false);
  expect(els.chrome.cutaway.getAttribute("aria-pressed")).toBe("false");
  expect(els.chrome.cutaway.classList.contains("on")).toBe(false);
  expect(actions.hidden).toBe(true);
});

test("dispose detaches the cutaway control before disposing the viewer", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const viewer = fakeViewers[0];

  els.chrome.cutaway.click();
  expect(viewer.setCutawayEnabled).toHaveBeenCalledWith(true);
  runtime.dispose();
  viewer.setCutawayEnabled.mockClear();
  els.chrome.cutaway.click();

  expect(viewer.setCutawayEnabled).not.toHaveBeenCalled();
  expect(els.chrome.cutaway.nextElementSibling?.classList.contains("pf-cutaway-actions")).not.toBe(true);
});

test("ready rejects when the first build errors", () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "error", message: "boom" } });
  return expect(runtime.ready).rejects.toThrow("boom");
});

test("legacy host page: default IDs still resolve (no elements option)", () => {
  document.body.innerHTML = `
    <div id="app"></div><div id="controls"></div>
    <div id="status"></div><div id="busy"><div id="phase"></div></div>
    <div id="part"></div>
    <button id="download"></button><button id="download-step"></button>`;
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker });
  finishFirstBuild(workers);
  // The phase text proves the default IDs resolved and were written through;
  // the status line ends the build cleared (triangle counts go to the console).
  expect(document.getElementById("phase").textContent).toContain("generating");
  expect(document.getElementById("status").textContent).toBe("");
  return expect(runtime.ready).resolves.toBeUndefined();
});

test("a successful build clears the status line and logs triangles/time to the console", () => {
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers, 1234);
  expect(els.status.status.textContent).toBe("");
  expect(debug).toHaveBeenCalledWith(expect.stringMatching(/triangles in 1\.2 s/));
  debug.mockRestore();
});

test("a build that delivers no geometry says so in the status line, naming the sub-part", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els });
  workers.manifold.onmessage({ data: { type: "ready" } });
  // Manifold booleans return an EMPTY solid rather than throwing (a bore wider
  // than its body), so a typed out-of-range value can "succeed" into nothing —
  // the status line has to say so, after refreshView's clear, like an error.
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body", triangles: 0 }], ms: 5 } });
  expect(els.status.status.textContent).toBe("empty: body produced no geometry at these values");
  expect(els.status.status.classList.contains("err")).toBe(true);
  // the next build with geometry clears it
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body", triangles: 12 }], ms: 5 } });
  expect(els.status.status.textContent).toBe("");
  expect(els.status.status.classList.contains("err")).toBe(false);
});

test("a build error lands in the status line even when the view is still current", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  // Geometry is all current, so refreshView's clear runs — the failure text
  // must be written after it, not wiped by it.
  workers.manifold.onmessage({ data: { type: "error", message: "boom" } });
  expect(els.status.status.textContent).toBe("failed: boom");
  expect(els.status.status.classList.contains("err")).toBe(true);
});

test("onBuild reports success with ms, and error with the message", () => {
  const onBuild = vi.fn();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onBuild });
  finishFirstBuild(workers, 42);
  expect(onBuild).toHaveBeenCalledWith({ status: "success", ms: 42 });
  workers.manifold.onmessage({ data: { type: "error", message: "later failure" } });
  expect(onBuild).toHaveBeenCalledWith({ status: "error", error: "later failure" });
});

test("onBuild skips a stale build (param changed mid-flight)", () => {
  const onBuild = vi.fn();
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els, onBuild });
  workers.manifold.onmessage({ data: { type: "ready" } }); // build 1 in flight
  // edit the Height param while the build is in flight → the result is stale
  const box = els.controls.querySelector("input.num");
  box.value = "7";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 9 } });
  expect(onBuild).not.toHaveBeenCalled(); // stale result discarded silently
  // the loop re-kicks; the redo build completes and reports
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 11 } });
  expect(onBuild).toHaveBeenCalledWith({ status: "success", ms: 11 });
});

// STEP-on-Manifold crossover (spec 2026-08-16, Task 9): a Manifold build that
// hits an unprimed STEP import throws NEEDS_IMPORT_MESH; mount asks the OCCT
// worker to tessellate, forwards the meshes to Manifold as a prime, and
// retries — mirroring the needs-occt reroute's buildDone()/kick() pairing.
test("needs-import-mesh requests tessellation from OCCT exactly once while a request is outstanding", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els });
  workers.manifold.onmessage({ data: { type: "ready" } }); // build 1 dispatched
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 1, subparts: ["body"] } });
  expect(workers.occt.postMessage).toHaveBeenCalledTimes(1);
  expect(workers.occt.postMessage.mock.calls[0][0]).toMatchObject({ type: "tessellate-imports" });
  // a second needs-import-mesh while the tessellation request is still outstanding
  // must not fire a duplicate request
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 1, subparts: ["body"] } });
  expect(workers.occt.postMessage).toHaveBeenCalledTimes(1);
});

test("import-meshes primes Manifold with the transfer list and retries the build", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 1, subparts: ["body"] } });
  workers.manifold.postMessage.mockClear();
  const positions = new Float32Array([0, 0, 0]);
  const indices = new Uint32Array([0]);
  const meshes = { body: { digest: "abc123", positions, indices } };
  workers.occt.onmessage({ data: { type: "import-meshes", jobId: 1, meshes } });
  expect(workers.manifold.postMessage).toHaveBeenCalledWith(
    { type: "prime-imports", meshes },
    [positions.buffer, indices.buffer],
  );
  // the retry: a fresh generate job goes back to Manifold now that it's primed
  const generateCalls = workers.manifold.postMessage.mock.calls.filter(([m]) => m.type === "generate");
  expect(generateCalls.length).toBeGreaterThan(0);
});

test("a needs-import-mesh after priming surfaces a build error instead of looping", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 1, subparts: ["body"] } });
  const meshes = { body: { digest: "abc123", positions: new Float32Array(), indices: new Uint32Array() } };
  workers.occt.onmessage({ data: { type: "import-meshes", jobId: 1, meshes } });
  workers.occt.postMessage.mockClear();
  // broken state: tessellation already delivered a mesh, but Manifold still can't
  // satisfy the import (digest mismatch) — must not loop back into another request
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 2, subparts: ["body"] } });
  expect(workers.occt.postMessage).not.toHaveBeenCalled();
  expect(els.status.status.textContent).toMatch(/STEP import tessellation failed/);
  expect(els.status.status.classList.contains("err")).toBe(true);
  return expect(runtime.ready).rejects.toThrow(/STEP import tessellation failed/);
});

// A failed tessellate-imports request (malformed STEP, etc.) is a DIFFERENT
// failure from the digest-mismatch case above: the OCCT job throws before
// delivering any mesh, so jobs.js's shared catch posts a plain `{type:"error"}`
// carrying the jobId mount attached to the request. Without correlating that
// jobId, the crossover latch (importMeshState) would strand at "requested"
// forever — every later regen would hit needs-import-mesh, see "requested",
// settle silently, and never re-request, i.e. an endless busy spinner.
test("a tessellate-imports error clears the crossover latch and surfaces the failure, without looping", async () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 1, subparts: ["body"] } });
  expect(workers.occt.postMessage).toHaveBeenCalledTimes(1);
  const tessellateMsg = workers.occt.postMessage.mock.calls[0][0];
  expect(tessellateMsg.type).toBe("tessellate-imports");
  expect(tessellateMsg.jobId).not.toBeUndefined(); // mount must attach a correlatable jobId

  // The OCCT worker's job throws — jobs.js's shared catch echoes msg.jobId.
  workers.occt.onmessage({ data: { type: "error", jobId: tessellateMsg.jobId, message: "malformed STEP" } });
  expect(els.status.status.textContent).toBe("failed: STEP import tessellation failed — malformed STEP");
  expect(els.status.status.classList.contains("err")).toBe(true);
  await expect(runtime.ready).rejects.toThrow(/STEP import tessellation failed — malformed STEP/);

  // The latch must be reset, not stranded — a later needs-import-mesh (e.g. a
  // fresh build after a param change) retries tessellation instead of
  // settling silently forever.
  workers.occt.postMessage.mockClear();
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 2, subparts: ["body"] } });
  expect(workers.occt.postMessage).toHaveBeenCalledTimes(1);
  expect(workers.occt.postMessage.mock.calls[0][0]).toMatchObject({ type: "tessellate-imports" });
});

test("an unrelated build error does not disturb an outstanding tessellate-imports request", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 1, subparts: ["body"] } });
  workers.occt.postMessage.mockClear();
  // A plain build error (no jobId, as a "generate" job's does) arrives while
  // tessellation is still outstanding — it must not be mistaken for the
  // correlated tessellate-imports failure and must not clear the latch.
  workers.manifold.onmessage({ data: { type: "error", message: "unrelated failure" } });
  expect(els.status.status.textContent).toBe("failed: unrelated failure");
  // the tessellate-imports request is still outstanding — a second
  // needs-import-mesh must not fire a duplicate request
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 1, subparts: ["body"] } });
  expect(workers.occt.postMessage).not.toHaveBeenCalled();
});

// Re-review finding: the tessellate-imports request and a headless STEP
// export both post to the OCCT worker and both allocate their jobId from a
// counter starting at 1 (export-controller.js's `nextId`, mount's own
// `importTessellateJobSeq`). mount's onWorkerMessage gives exportCtl first
// refusal on every message (`exportCtl.handleMessage(data, ...)` runs before
// mount's own switch) via a raw `pending.get(m.jobId)` — a bare numeric
// tessellate jobId colliding with a pending export's jobId would let the
// export controller wrongly claim the tessellate worker's error reply,
// rejecting the unrelated export AND leaving mount's own crossover latch
// stranded at "requested" (its switch, which resets the latch, never runs).
// The string-namespaced "tess-N" id (mirroring capture-build.js's "cap-N")
// makes that collision structurally impossible; this test proves it by
// forcing the exact numeric-collision setup and checking both jobs settle
// independently and correctly.
test("a tessellate-imports request never collides with a pending export's numeric jobId", async () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const onDownload = vi.fn(); // sink, so triggerDownload never touches real DOM download APIs
  const runtime = mount(makePart(), { createWorker, elements: els, onDownload });
  finishFirstBuild(workers);

  // A headless STEP export is in flight — export-controller.js hands it
  // jobId 1 (its counter starts fresh at 1 for this mount instance), posted
  // to the OCCT worker (STEP always routes there).
  const exportPromise = runtime.exportParts({ parts: ["body"], format: "step", onProgress: vi.fn() });
  const exportJobId = workers.occt.postMessage.mock.calls
    .find(([m]) => m.type === "export-step")[0].jobId;
  expect(exportJobId).toBe(1); // pins the exact collision this test defends against

  // A STEP-on-Manifold crossover kicks off concurrently — mount's own jobId
  // counter also starts at 1, so WITHOUT the "tess-" namespace this would be
  // the identical id `1` on the same worker's message channel as the export above.
  workers.manifold.onmessage({ data: { type: "needs-import-mesh", jobId: 2, subparts: ["body"] } });
  const tessellateMsg = workers.occt.postMessage.mock.calls.find(([m]) => m.type === "tessellate-imports")[0];
  expect(tessellateMsg.jobId).toBe("tess-1");
  expect(tessellateMsg.jobId).not.toBe(exportJobId); // never numerically equal, even by coincidence

  // The OCCT worker's tessellate job fails. If the export controller wrongly
  // claimed this (a numeric-collision bug), it would reject exportPromise
  // with the tessellation message and delete its pending entry.
  workers.occt.onmessage({ data: { type: "error", jobId: tessellateMsg.jobId, message: "malformed STEP" } });
  expect(els.status.status.textContent).toBe("failed: STEP import tessellation failed — malformed STEP");

  // The export is untouched — completing it normally still resolves cleanly,
  // proving its pending entry was never claimed or deleted by the tessellate error.
  workers.occt.onmessage({
    data: { type: "download", jobId: exportJobId, data: new ArrayBuffer(4), filename: "body.step", mime: "application/step" },
  });
  await expect(exportPromise).resolves.toBeUndefined();
});

test("dispose() tears everything down and is idempotent", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  runtime.dispose();
  runtime.dispose(); // idempotent
  expect(workers.manifold.terminate).toHaveBeenCalledTimes(1);
  expect(workers.occt.terminate).toHaveBeenCalledTimes(1);
  expect(fakeViewers[0].dispose).toHaveBeenCalledTimes(1);
  expect(attachHoverLabels.mock.results[0].value.detach).toHaveBeenCalled();
  expect(document.body.querySelector(".popover")).toBeNull(); // controls panel disposed
  expect(els.controls.children.length).toBe(0);               // host emptied, not removed
  expect(els.tabs.children.length).toBe(0);
  // export listeners removed: a click after dispose posts nothing
  workers.manifold.postMessage.mockClear();
  els.exports.stl.click();
  expect(workers.manifold.postMessage).not.toHaveBeenCalled();
});

test("deprecated container/controls aliases still work", () => {
  document.body.innerHTML = `
    <div id="status"></div><div id="busy"><div id="phase"></div></div><div id="part"></div>`;
  const viewerEl = document.createElement("div");
  const controlsEl = document.createElement("div");
  document.body.append(viewerEl, controlsEl);
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, container: viewerEl, controls: controlsEl });
  expect(controlsEl.querySelector("input.num")).not.toBeNull(); // panel built into the alias target
  finishFirstBuild(workers);
  return expect(runtime.ready).resolves.toBeUndefined();
});

test("onPick arms the picker permanently and delivers label/prompt/token/anchor", () => {
  const onPick = vi.fn();
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick });

  expect(attachPicker).toHaveBeenCalledTimes(1);
  const pickerHandle = attachPicker.mock.results[0].value;
  expect(pickerHandle.setActive).toHaveBeenCalledWith(true); // always-on

  // simulate a click resolving to a Selection (the picker core is tested elsewhere)
  const armed = attachPicker.mock.calls[0][1];
  armed.onPick({ subPart: "body", point: [0, 0, 1.5], normal: [0, 0, -1],
                 params: { h: 4 }, feature: { label: "Drainage hole" } },
               { x: 137, y: 82 });

  expect(onPick).toHaveBeenCalledTimes(1);
  const payload = onPick.mock.calls[0][0];
  // The picker's second argument reaches the host verbatim. Asserted here
  // because this join is the only thing between a covered producer (pick.js)
  // and a covered consumer: drop it and every host silently gets undefined.
  expect(payload.anchor).toEqual({ x: 137, y: 82 });
  expect(payload.label).toBe("Drainage hole"); // feature label wins
  expect(payload.prompt).toBe(
    "On sub-part **body**, the user pointed at **Drainage hole**, local point (0, 0, 1.5), normal -Z, with params {h: 4}."
  );
  expect(payload.token).toBe("@body · Drainage hole · pt(0,0,1.5) n(-Z) · {h:4}");
  expect(payload.selection.subPart).toBe("body");
});

test("label falls back to the sub-part label, then the sub-part name", () => {
  const onPick = vi.fn();
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick });
  const armed = attachPicker.mock.calls[0][1];

  armed.onPick({ subPart: "body", point: [0, 0, 0], normal: [0, 0, 1], params: {} });
  expect(onPick.mock.calls[0][0].label).toBe("Body"); // part.parts.body.label

  armed.onPick({ subPart: "ghost", point: [0, 0, 0], normal: [0, 0, 1], params: {} });
  expect(onPick.mock.calls[1][0].label).toBe("ghost"); // unknown sub-part → name
});

test("onPick wins over ?pick and ?pickserver (one click listener ever live)", async () => {
  vi.stubGlobal("location", { search: "?pick&pickserver" });
  const { createPickRequestClient } = await import("../../src/framework/pick-request/index.js");
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn() });
  expect(attachPicker).toHaveBeenCalledTimes(1);
  expect(attachPickToggle).not.toHaveBeenCalled();
  expect(createPickRequestClient).not.toHaveBeenCalled();
});

test("?pickserver passes the loopback URL and ?picktoken through to the client", async () => {
  vi.stubGlobal("location", { search: "?pickserver=http://localhost:9999&picktoken=abc123" });
  const { createPickRequestClient } = await import("../../src/framework/pick-request/index.js");
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements() });
  expect(createPickRequestClient).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: "http://localhost:9999", token: "abc123" }),
  );
});

// A link is all it takes to set ?pickserver, and every click carries the user's live
// parameter values — a non-loopback target must never be dialled.
test("a non-loopback ?pickserver is refused and falls back to the default", async () => {
  vi.stubGlobal("location", { search: "?pickserver=https://evil.example&picktoken=abc123" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createPickRequestClient } = await import("../../src/framework/pick-request/index.js");
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements() });
  expect(createPickRequestClient).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: "http://127.0.0.1:4518" }),
  );
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("evil.example"));
  warn.mockRestore();
});

test("without onPick, ?pick still enables the clipboard toggle", () => {
  vi.stubGlobal("location", { search: "?pick" });
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements() });
  expect(attachPickToggle).toHaveBeenCalledTimes(1);
  expect(attachPicker).not.toHaveBeenCalled();
});

test("dispose() detaches the onPick picker", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els, onPick: vi.fn() });
  runtime.dispose();
  expect(attachPicker.mock.results[0].value.detach).toHaveBeenCalled();

  // Task 9 review follow-up: dispose() must also detach the viewer chrome —
  // a reframe click after dispose must not reach the (now-disposed) viewer.
  els.chrome.reframe.click();
  expect(fakeViewers.at(-1).frame).not.toHaveBeenCalled();
});

test("a pose-only param edit re-poses in the viewer and sends no build job", () => {
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makePart(), { createWorker, elements: makeElements() });
  finishFirstBuild(workers);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  // drive the tilt slider like a user drag
  const tilt = document.querySelectorAll('input[type="range"]')[1];
  tilt.value = "45";
  tilt.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(250); // let the regen debounce fire — it must find nothing missing

  expect(fakeViewers[0].setSubPose).toHaveBeenCalledWith("body", expect.any(Array));
  expect(workers.manifold.postMessage.mock.calls.length).toBe(jobsBefore); // no new job
  handle.dispose();
  vi.useRealTimers();
});

test("a geometry param edit still sends a build job", () => {
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makePart(), { createWorker, elements: makeElements() });
  finishFirstBuild(workers);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  const height = document.querySelectorAll('input[type="range"]')[0];
  height.value = "6";
  height.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(250);

  const jobs = workers.manifold.postMessage.mock.calls.slice(jobsBefore).map(([m]) => m);
  expect(jobs.some((m) => m.type === "generate")).toBe(true);
  handle.dispose();
  vi.useRealTimers();
});

// The ?debug caching toggle calls forceRegen(), which forgets every stamp WITHOUT
// bumping the params version. repair() must therefore never run in that path: it
// would re-stamp everything current off the memoized probe and the forced rebuild
// would silently no-op. This pins repair() to onParamChange only.
test("the ?debug caching toggle still forces a rebuild after a pose repair", () => {
  vi.stubGlobal("location", { search: "?debug" });
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makePart(), { createWorker, elements: makeElements() });
  finishFirstBuild(workers);

  const tilt = document.querySelectorAll('input[type="range"]')[1];
  tilt.value = "45";
  tilt.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(250); // repaired by the fast path: body is stamped current again
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  const cb = document.querySelector("#pf-debug input[type=checkbox]");
  cb.checked = false;
  cb.dispatchEvent(new Event("change")); // → forceRegen()

  const jobs = workers.manifold.postMessage.mock.calls.slice(jobsBefore).map(([m]) => m);
  expect(jobs.some((m) => m.type === "generate")).toBe(true);

  // …and the earlier repair is not credited to this unrelated rebuild's report.
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 5 } });
  expect(document.getElementById("pf-debug").textContent).toContain("/ 0 posed");
  handle.dispose();
  vi.useRealTimers();
});

// The other build a repair must not ride along into: a view switch kicks a build
// for whatever the new view is missing, which has nothing to do with the edit.
test("switching views doesn't credit an earlier repair to the new view's build", () => {
  vi.stubGlobal("location", { search: "?debug" });
  vi.useFakeTimers();
  const part = makePart();
  part.views.other = { label: "Other" };
  part.parts.cap = { label: "Cap", views: ["other"],
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.h, 1, 1] }) };
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(part, { createWorker, elements: els });
  finishFirstBuild(workers);

  const tilt = document.querySelectorAll('input[type="range"]')[1];
  tilt.value = "45";
  tilt.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(250); // repaired by the fast path — no build of its own

  [...els.tabs.querySelectorAll("button")]
    .find((button) => button.textContent === "Other")
    .click();
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "cap" }], ms: 5 } });

  expect(document.getElementById("pf-debug").textContent).toContain("/ 0 posed");
  handle.dispose();
  vi.useRealTimers();
});

// A mixed edit: `body` is geometry-only (reads h), `arm` is pose-only (reads tilt).
// Editing both in one dirty cycle must re-pose the arm AND rebuild the body, and
// the build's overlay report must still credit the pose — the repaired count has
// to survive the debounce into the generate it shares a cycle with.
const makeMixedPart = () => {
  const part = makePart();
  part.parts.body.build = (k, p) => k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] });
  part.parts.arm = { label: "Arm", views: ["main"], build: (k, p) =>
    k.box({ min: [0, 0, 0], max: [2, 2, 2] })
      .rotateAbout({ axis: "X", deg: p.tilt, through: [0, 0, 0] }) };
  return part;
};

test("a mixed edit reports the posed sub-part alongside the rebuilt one", () => {
  vi.stubGlobal("location", { search: "?debug" });
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makeMixedPart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }, { name: "arm" }], ms: 42 } });

  const [height, tilt] = document.querySelectorAll('input[type="range"]');
  tilt.value = "45";
  tilt.dispatchEvent(new Event("input", { bubbles: true }));   // arm: pose-only
  height.value = "6";
  height.dispatchEvent(new Event("input", { bubbles: true }));  // body: needs a rebuild
  vi.advanceTimersByTime(250);
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 7 } });

  expect(fakeViewers[0].setSubPose).toHaveBeenCalledWith("arm", expect.any(Array));
  expect(document.getElementById("pf-debug").textContent)
    .toContain("1 skipped / 1 rebuilt / 1 posed");

  // …and that build CONSUMED the count: the next one reports none.
  height.value = "7";
  height.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(250);
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 8 } });

  expect(document.getElementById("pf-debug").textContent)
    .toContain("1 skipped / 1 rebuilt / 0 posed");
  handle.dispose();
  vi.useRealTimers();
});

// The count is of SUB-PARTS re-posed, not of repairs performed: a slider drag
// re-repairs the same sub-part on every input event, and reporting "247 posed"
// for a one-sub-part app would be nonsense.
test("repeated pose edits in one drag report one posed sub-part, not one per edit", () => {
  vi.stubGlobal("location", { search: "?debug" });
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makePart(), { createWorker, elements: makeElements() });
  finishFirstBuild(workers);

  const tilt = document.querySelectorAll('input[type="range"]')[1];
  for (const deg of ["15", "30", "45"]) {
    tilt.value = deg;
    tilt.dispatchEvent(new Event("input", { bubbles: true }));
  }
  vi.advanceTimersByTime(250);

  expect(document.getElementById("pf-debug").textContent).toContain("/ 1 posed");
  handle.dispose();
  vi.useRealTimers();
});

// ?debug&nocache exists to measure true uncached rebuilds; the fast path would
// hide them by re-stamping pose-only edits current, so it's off when caching is.
test("?debug&nocache disables the fast path — a pose-only edit still rebuilds", () => {
  vi.stubGlobal("location", { search: "?debug&nocache" });
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makePart(), { createWorker, elements: makeElements() });
  finishFirstBuild(workers);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  const tilt = document.querySelectorAll('input[type="range"]')[1];
  tilt.value = "45";
  tilt.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(250);

  expect(fakeViewers[0].setSubPose).not.toHaveBeenCalled();
  const jobs = workers.manifold.postMessage.mock.calls.slice(jobsBefore).map(([m]) => m);
  expect(jobs.some((m) => m.type === "generate")).toBe(true);
  handle.dispose();
  vi.useRealTimers();
});

// setParams is the animation-system hook: it runs the same change path as a
// slider edit, so a pose-only edit lands in the viewer synchronously — and the
// panel has to follow, or the sliders drift away from the params they show.
test("setParams applies the fast path synchronously and syncs the panel", () => {
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const els = makeElements();
  const handle = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  handle.setParams({ tilt: 60 });

  expect(fakeViewers[0].setSubPose).toHaveBeenCalledWith("body", expect.any(Array));
  expect(workers.manifold.postMessage.mock.calls.length).toBe(jobsBefore); // synchronous, no job
  const [height, tilt] = els.controls.querySelectorAll('input[type="range"]');
  expect(tilt.value).toBe("60");                                           // UI synced
  expect(els.controls.querySelectorAll("input.num")[1].value).toBe("60");
  expect(height.value).toBe("4");                                          // untouched key
  vi.advanceTimersByTime(250); // …and the debounce still finds nothing missing
  expect(workers.manifold.postMessage.mock.calls.length).toBe(jobsBefore);
  handle.dispose();
  vi.useRealTimers();
});

test("setParams on a geometry param syncs the panel and rebuilds", () => {
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const els = makeElements();
  const handle = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  handle.setParams({ h: 6 });
  vi.advanceTimersByTime(250);

  expect(els.controls.querySelectorAll('input[type="range"]')[0].value).toBe("6");
  const jobs = workers.manifold.postMessage.mock.calls.slice(jobsBefore).map(([m]) => m);
  const generate = jobs.find((m) => m.type === "generate");
  expect(generate?.params.h).toBe(6);
  handle.dispose();
  vi.useRealTimers();
});

test("dispose() before the first build rejects ready instead of hanging", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  runtime.dispose(); // no build ever completed
  return expect(runtime.ready).rejects.toThrow("disposed before first build");
});

// --- narrow-layout pane tabs ----------------------------------------------
// mount() attaches the tab bar the same way it attaches the rail, so a host
// that supplies a rail gets narrow-layout tabs for free — and one that lays the
// framework out itself still gets a callable setHostPane, so the handle's shape
// never varies with the host's markup.
test("mount attaches the pane tab bar and exposes setHostPane", async () => {
  const { runtime, shell } = await mountFixture(); // the file's existing mount helper
  expect(typeof runtime.setHostPane).toBe("function");
  expect(shell.querySelector(".pf-tabbar")).not.toBeNull();
  expect(shell.dataset.pfPane).toBe("stage");

  runtime.setHostPane("rail");
  expect(shell.dataset.pfPane).toBe("rail");
  expect(shell.querySelector(".pf-tabbar").hidden).toBe(true);

  runtime.setHostPane(null);
  expect(shell.querySelector(".pf-tabbar").hidden).toBe(false);
});

test("dispose removes the tab bar", async () => {
  const { runtime, shell } = await mountFixture();
  runtime.dispose();
  expect(shell.querySelector(".pf-tabbar")).toBeNull();
  expect(shell.dataset.pfPane).toBeUndefined();
});

test("makeHandle always exposes a callable setHostPane", () => {
  // Called with no setHostPane at all (the no-rail path, and every existing
  // direct-makeHandle test): the method must still be safe to call.
  const handle = makeHandle({
    ready: Promise.resolve(), dispose() {}, viewer: { captureCanonicalViews: () => [] },
    setParams() {}, listExportableParts: () => [], exportParts: async () => {},
    getView: () => "a", setView: () => true, captureView: async () => null,
  });
  expect(() => handle.setHostPane("rail")).not.toThrow();
  expect(typeof handle.getView).toBe("function");
  expect(typeof handle.setView).toBe("function");
  expect(typeof handle.captureView).toBe("function"); // added in Task 4
  // attachTooltips defaults to a no-op that still hands back a full binding,
  // so a host can hold and call the result without feature-detecting.
  const binding = handle.attachTooltips([{ element: document.createElement("button") }]);
  expect(() => { binding.sync(); binding.hide(); binding.detach(); }).not.toThrow();
  // Same no-op-default stance for the measure API (spec Goal 3): a direct
  // makeHandle caller with no measure mode wired still gets a safe surface.
  expect(handle.measure.isEnabled()).toBe(false);
  expect(() => handle.measure.setEnabled(true)).not.toThrow();
  expect(() => handle.measure.clearPins()).not.toThrow();
  expect(handle.measure.pinCount()).toBe(0);
  // And for pickMarker: hold() reports "nothing held" rather than throwing, and
  // onAnchorChange still hands back an unsubscribe the host can hold and call.
  expect(handle.pickMarker.hold()).toBe(false);
  expect(() => handle.pickMarker.release()).not.toThrow();
  expect(() => handle.pickMarker.onAnchorChange(() => {})()).not.toThrow();
});

test("exposes setRailLayout on the handle, defaulting to a no-op", () => {
  // Same stance as setHostPane above: a mount that resolved no rail (and every
  // direct-makeHandle caller) still hands the host a callable method, so the
  // handle's shape never depends on what this page happened to lay out.
  const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {} });
  expect(typeof handle.setRailLayout).toBe("function");
  expect(() => handle.setRailLayout({ mode: "overlay" })).not.toThrow();
});

// Spec Goal 3 ("Communication"): the measure API must actually be reachable
// off the handle mount() returns, not just internal to measure-mode.js.
// (setEnabled(true) itself isn't exercised here: the fake createViewer has no
// real scene to build dimensions against — exposure of the real measureMode
// methods is what this pins.)
test("mount exposes the measure API on the handle", async () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  expect(typeof runtime.measure.isEnabled).toBe("function");
  expect(typeof runtime.measure.setEnabled).toBe("function");
  expect(typeof runtime.measure.clearPins).toBe("function");
  expect(typeof runtime.measure.pinCount).toBe("function");
  expect(runtime.measure.isEnabled()).toBe(false);
  expect(runtime.measure.pinCount()).toBe(0);
  runtime.dispose();
});

// --- animation playback: best-effort geometry ------------------------------
// Every animation frame bumps the params version, so a worker build dispatched
// at frame N is already "stale" by the time it lands. Discarding it (the plain
// stale rule) freezes the model at its pre-play state for the whole run while
// the worker churns. During playback those meshes must be SHOWN — but never
// recorded, because they were not built at the live params.
const makeAnimatedPart = () => {
  const part = makePart();
  // `h` is the GEOMETRY param (the box is built from it), so every animation
  // frame genuinely needs a worker build — the case the fix is about. Animations
  // are view-owned, so it hangs off the view these tests run in ("main").
  part.views.main.animations = {
    grow: { label: "Grow", duration: 2, easing: "linear", tracks: { h: [[0, 4], [1, 10]] } },
  };
  return part;
};

test("a build made stale only by playback is shown, but not recorded", () => {
  const onBuild = vi.fn();
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makeAnimatedPart(), { createWorker, elements: els, onBuild });
  finishFirstBuild(workers);
  const viewer = fakeViewers[0];
  viewer.setSubGeometry.mockClear();
  onBuild.mockClear();

  handle.animation.play();  // frame-0 apply → version bumps, build dispatched
  viewer.tickFrame(0.5);    // playback moves on while that build is in flight
  viewer.tickFrame(0.5);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 5 } });

  expect(viewer.setSubGeometry).toHaveBeenCalledWith("body", expect.anything()); // shown
  expect(els.exports.stl.disabled).toBe(true);  // NOT recorded — still stale, export stays off
  expect(onBuild).not.toHaveBeenCalled();       // and it is not reported as a build at the live params
  // …and the loop immediately re-kicks a build at the params playback has reached
  const jobs = workers.manifold.postMessage.mock.calls.slice(jobsBefore).map(([m]) => m);
  expect(jobs.some((m) => m.type === "generate" && m.params.h > 4)).toBe(true);
  handle.dispose();
});

test("a user edit mid-playback still discards the stale meshes", () => {
  vi.useFakeTimers();
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makeAnimatedPart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  const viewer = fakeViewers[0];
  viewer.setSubGeometry.mockClear();

  handle.animation.play();     // build in flight at the animation's version
  handle.setParams({ h: 7 });  // the user takes over: playback pauses, version bumps again

  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 5 } });

  expect(viewer.setSubGeometry).not.toHaveBeenCalled(); // user-stale → discarded, as before
  expect(handle.animation.state().status).toBe("paused");
  handle.dispose();
  vi.useRealTimers();
});

test("autoplay still fires on first show when the first build errored", () => {
  // Regression: the kick used to be latched to readySettled, which the error
  // branch also sets — so a part whose first build fails permanently lost
  // autoplay even if a later build for the same view succeeded.
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const part = makeAnimatedPart();
  part.views.main.animations.grow.autoplay = true;
  const handle = mount(part, { createWorker, elements: els });

  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "error", message: "boom" } }); // first build fails
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 5 } }); // retry succeeds

  expect(handle.animation.state().status).toBe("playing"); // autoplay still kicked
  handle.dispose();
});

// Animations are view-owned, so mount's tab onChange has to hand the outgoing
// view's animation back — animCtl.viewChanged() — BEFORE anything reads params
// again. Deleting that one call left the whole suite green: the driver kept
// driving the departed view's animation, its param snapshot was never restored,
// and its opacity overrides stayed on the meshes of a view that never asked for
// a fade. This is the mount-level pin on that wiring.
test("switching views hands the outgoing view's animation back", () => {
  const part = makeAnimatedPart();
  part.views.other = { label: "Other" }; // declares no animations of its own
  part.parts.body.views = ["main", "other"];
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(part, { createWorker, elements: els });
  finishFirstBuild(workers);
  expect(handle.animation.state()).toMatchObject({ view: "main", animation: "grow" });
  fakeViewers[0].clearSubPartOpacities.mockClear(); // attach resets once; ignore that

  [...els.tabs.querySelectorAll("button")]
    .find((button) => button.textContent === "Other")
    .click();

  expect(fakeViewers[0].clearSubPartOpacities).toHaveBeenCalled();
  expect(handle.animation.state()).toMatchObject({ view: "other", animation: null });
  handle.dispose();
});

// Task 2 (sdd 2026-08-20-sketch-composer-slot-and-mirroring): Sketch takes the
// transport bar's slot — the host floats its own composer there — so entering
// must STOP any playing animation before hiding the bar (hiding first would
// leave a frame where a playing animation still drives the model beneath a
// bar that already looks gone), and leaving must not resume it. mount.js
// wires this as a SECOND annotateMode.onModeChange subscription, registered
// after `animCtl` is assigned (the earlier onModeChange, near the view cube,
// runs before animCtl exists).
test("entering sketch mode stops playback before hiding the transport bar; leaving reveals it without resuming", async () => {
  const part = makeAnimatedPart();
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  // Sketch only appears when the host wires a send callback (same gate as the
  // view-cube hide-reason tests above).
  const handle = mount(part, {
    createWorker, elements: els, onAnnotationSend: () => {},
  });
  finishFirstBuild(workers);
  const viewer = fakeViewers[0];
  const bar = els.viewer.querySelector(".pf-anim-bar");
  expect(bar).not.toBeNull();
  expect(bar.style.display).toBe("");

  handle.animation.play();  // "grow" has no camera cue → status goes "playing" immediately
  viewer.tickFrame(0.5);    // move it along so there is something to stop
  expect(handle.animation.state().status).toBe("playing");

  // lastAnimCtl is the REAL handle attachAnimationControls returned to
  // mount.js (captured by the mock above) — spying on it (call-through, not
  // replaced) pins call ORDER on the actual objects mount.js holds, with no
  // new fake surface added.
  const ctl = lastAnimCtl;
  const notifySpy = vi.spyOn(ctl, "notifyUserEdit");
  const hideSpy = vi.spyOn(ctl, "setHidden");
  viewer.cancelCameraTween.mockClear();

  handle.annotate.setEnabled(true);
  await new Promise((r) => requestAnimationFrame(r));

  expect(hideSpy).toHaveBeenCalledWith(true);
  expect(notifySpy).toHaveBeenCalledTimes(1);
  // STOP before hide.
  expect(notifySpy.mock.invocationCallOrder[0]).toBeLessThan(hideSpy.mock.invocationCallOrder[0]);
  expect(viewer.cancelCameraTween).toHaveBeenCalled(); // notifyUserEdit's own stop signal
  expect(handle.animation.state().status).toBe("paused"); // actually stopped, not just told to
  expect(bar.style.display).toBe("none");
  expect(els.viewer.style.getPropertyValue("--pf-anim-clear")).toBe("0px");

  handle.annotate.setEnabled(false);
  await new Promise((r) => requestAnimationFrame(r));

  expect(hideSpy).toHaveBeenCalledWith(false);
  expect(notifySpy).toHaveBeenCalledTimes(1); // leaving does not touch playback again
  expect(bar.style.display).toBe("");         // slot is back
  expect(handle.animation.state().status).toBe("paused"); // and playback did NOT resume

  handle.dispose();
});

// --- onViewChange embedder callback -----------------------------------------
// Fires once synchronously during mount (before any build) with the initial
// resolved view, then again on every subsequent view change.
test("onViewChange fires once on mount with the initial view, then on each change", () => {
  const part = makePart();
  part.views.other = { label: "Other" };
  part.parts.body.views = ["main", "other"];
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const seen = [];

  const runtime = mount(part, {
    createWorker, elements: els,
    onViewChange: (name) => seen.push(name),
  });

  // Synchronous initial emit, before any build has completed.
  expect(seen).toEqual(["main"]);

  [...els.tabs.querySelectorAll("button")]
    .find((button) => button.textContent === "Other")
    .click();

  expect(seen).toEqual(["main", "other"]);
  runtime.dispose();
});

// --- getView / setView on the runtime handle -------------------------------
test("getView returns the active view; setView switches it and rejects unknowns", async () => {
  const part = makePart();
  part.views.other = { label: "Other" };
  part.parts.body.views = ["main", "other"];
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(part, { createWorker, elements: els });
  finishFirstBuild(workers);
  await runtime.ready;

  const start = runtime.getView();
  expect(typeof start).toBe("string");
  expect(start).toBe("main");

  expect(runtime.setView("other")).toBe(true);
  expect(runtime.getView()).toBe("other");

  expect(runtime.setView("does-not-exist")).toBe(false);
  expect(runtime.getView()).toBe("other"); // unchanged

  runtime.dispose();
});

test("makeHandle.animation defaults to null; a supplied runtime passes through", () => {
  const fixture = {
    ready: Promise.resolve(), dispose() {}, viewer: { captureCanonicalViews: () => [] },
    setParams() {}, listExportableParts: () => [], exportParts: async () => {},
  };
  const handle = makeHandle(fixture);
  expect(handle.animation).toBeNull(); // no animation runtime supplied

  const fakeRuntime = { play() {}, pause() {}, seek() {}, stop() {}, state: () => ({}) };
  const withAnimation = makeHandle({ ...fixture, animation: fakeRuntime });
  expect(withAnimation.animation).toBe(fakeRuntime);
});

test("onParamsCommit fires on a finished panel edit with a snapshot, never from setParams", () => {
  const { createWorker } = makeWorkers();
  const els = makeElements();
  const commits = [];
  const runtime = mount(makePart(), { createWorker, elements: els,
    onParamsCommit: (p) => commits.push(p) });

  const slider = els.controls.querySelector('input[type="range"]');
  slider.value = "6";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  expect(commits).toEqual([]);                       // mid-drag
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toHaveLength(1);
  expect(commits[0].changed).toEqual(["h"]);
  expect(commits[0].params).toMatchObject({ h: 6, tilt: 0 });

  // the payload is a snapshot: a later edit must not mutate it
  runtime.setParams({ h: 9 });
  expect(commits[0].params.h).toBe(6);
  expect(commits).toHaveLength(1);                   // setParams never commits
  runtime.dispose();
});

test("mounts the view cube stack inside the stage", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  expect(els.viewer.querySelector(".pf-viewcube-stack")).not.toBeNull();
  // The view style button took the projection toggle's place in the stack.
  expect(els.viewer.querySelector(".pf-viewcube-stack #view-style")).not.toBeNull();
  expect(els.viewer.querySelector("#projection")).toBeNull();
  runtime.dispose();
  expect(els.viewer.querySelector(".pf-viewcube-stack")).toBeNull();
  expect(els.viewer.querySelector("#view-style")).toBeNull();
  expect(els.viewer.querySelector("#pf-view-style-popover")).toBeNull();
});

test("exposes projection on the runtime and drives the viewer with it", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const viewer = fakeViewers.at(-1);
  expect(runtime.projection.get()).toBe("perspective");
  runtime.projection.set("orthographic");
  expect(viewer.setProjection).toHaveBeenCalledWith("orthographic");
  expect(runtime.projection.get()).toBe("orthographic");
  runtime.dispose();
});

test("runtime.pickMarker drives the viewer's held marker", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const viewer = fakeViewers.at(-1);

  expect(runtime.pickMarker.hold()).toBe(true);
  expect(viewer.holdFlashPoint).toHaveBeenCalledTimes(1);

  const seen = [];
  const off = runtime.pickMarker.onAnchorChange((a) => seen.push(a));
  viewer.emitFlashAnchor({ x: 5, y: 6, visible: true });
  expect(seen).toEqual([{ x: 5, y: 6, visible: true }]);
  off();
  viewer.emitFlashAnchor(null); // unsubscribed: nothing more arrives
  expect(seen).toHaveLength(1);

  runtime.pickMarker.release();
  expect(viewer.releaseFlashPoints).toHaveBeenCalledTimes(1);
  runtime.dispose();
});

test("hides the whole cube stack while Sketch is on", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  // Sketch only appears when the host wires a send callback.
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {},
  });
  const stack = els.viewer.querySelector(".pf-viewcube-stack");
  expect(stack.hidden).toBe(false);
  els.chrome.annotate.click();
  // Ink is pose-locked: an orbit OR a projection swap invalidates it, so the
  // projection button goes away with the cube, not just the cube.
  expect(stack.hidden).toBe(true);
  els.chrome.annotate.click();
  expect(stack.hidden).toBe(false);
  runtime.dispose();
});

// setHidden takes one boolean and there are two independent reasons to hide the
// cube — Sketch mode and a crowded transport bar. Applied straight, whichever
// fires last wins, and leaving Sketch would reveal a cube that crowding still
// wants gone. All four combinations, in the order that catches that.
test("the cube's two hide reasons OR rather than overwrite each other", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {},
  });
  const stack = els.viewer.querySelector(".pf-viewcube-stack");
  const reportCrowded = crowdedHook.report;
  expect(typeof reportCrowded).toBe("function"); // mount wired it

  expect(stack.hidden).toBe(false);            // neither reason
  reportCrowded(true);
  expect(stack.hidden).toBe(true);             // crowded only
  els.chrome.annotate.click();
  expect(stack.hidden).toBe(true);             // both
  els.chrome.annotate.click();
  expect(stack.hidden).toBe(true);             // still crowded — the regression
  reportCrowded(false);
  expect(stack.hidden).toBe(false);            // neither again

  // And the mirror image: Sketch alone survives crowding clearing.
  els.chrome.annotate.click();
  expect(stack.hidden).toBe(true);
  reportCrowded(false);
  expect(stack.hidden).toBe(true);
  els.chrome.annotate.click();
  expect(stack.hidden).toBe(false);
  runtime.dispose();
});

test("restores a persisted orthographic projection before the first framing", () => {
  localStorage.setItem("partforge:projection", "orthographic");
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const viewer = fakeViewers.at(-1);
  // Set synchronously during mount setup, well before any worker round-trip
  // could resolve — this alone pins "restored before the first build".
  expect(viewer.setProjection).toHaveBeenCalledWith("orthographic");
  finishFirstBuild(workers);
  // showAssembly's first call is the one that actually frames the camera
  // (frame:true on the initial show — see showView in mount.js). Comparing
  // invocation order against it is the real ordering claim: had the restore
  // been moved to fire alongside the camera restore (inside showView, AFTER
  // this call), this assertion would catch it. viewer.frame() (the reframe
  // BUTTON's handler) is a different function and is never called on this
  // path, so it can't stand in for "framing happened" — that was the flaw in
  // the previous version of this test.
  expect(viewer.showAssembly).toHaveBeenCalledWith(expect.anything(), { frame: true });
  const firstFrameCall = viewer.showAssembly.mock.calls.findIndex(([, opts]) => opts?.frame);
  expect(firstFrameCall).toBeGreaterThanOrEqual(0);
  expect(viewer.setProjection.mock.invocationCallOrder[0])
    .toBeLessThan(viewer.showAssembly.mock.invocationCallOrder[firstFrameCall]);
  localStorage.clear();
  runtime.dispose();
});

// --- Sketch toolbar wiring (sdd 2026-08-27-sketch-tools, Task 10) ----------
// The toolbar (sketch-toolbar.js, Task 9) replaces #viewbar as the top-of-stage
// chrome while sketch mode is on, and is only attached at all when annotateMode
// exists — same gate as the view-cube hide-reason tests above. makeElements()
// carries no #viewbar (no test until now needed one); these tests add their
// own so the hide/restore wiring has something real to toggle.
function withViewbar(els) {
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  els.viewer.append(viewbar);
  return viewbar;
}

test("no sketch toolbar without onAnnotationSend — nothing for it to drive", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  expect(els.viewer.querySelector(".pf-sketch-toolbar")).toBeNull();
  runtime.dispose();
});

test("sketch mode hides the viewbar and shows the toolbar; exit restores both", () => {
  const els = makeElements();
  const viewbar = withViewbar(els);
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {},
  });
  const toolbar = els.viewer.querySelector(".pf-sketch-toolbar");
  expect(toolbar).not.toBeNull();
  expect(toolbar.hidden).toBe(true);
  expect(viewbar.hidden).toBe(false);

  runtime.annotate.setEnabled(true);
  expect(viewbar.hidden).toBe(true);
  expect(toolbar.hidden).toBe(false);

  runtime.annotate.setEnabled(false);
  expect(viewbar.hidden).toBe(false);
  expect(toolbar.hidden).toBe(true);

  runtime.dispose();
  expect(els.viewer.querySelector(".pf-sketch-toolbar")).toBeNull();
});

// Restore honors whatever hidden state the host had set BEFORE entering, not
// a hardcoded "always reveal" — a host that had its own reason to hide
// #viewbar must see that reason survive a sketch round-trip.
test("leaving sketch mode restores the viewbar's PRIOR hidden state, not just false", () => {
  const els = makeElements();
  const viewbar = withViewbar(els);
  viewbar.hidden = true; // host already had it hidden for an unrelated reason
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {},
  });

  runtime.annotate.setEnabled(true);
  expect(viewbar.hidden).toBe(true); // still hidden, now for sketch's reason
  runtime.annotate.setEnabled(false);
  expect(viewbar.hidden).toBe(true); // restored to the host's prior state, not forced visible

  runtime.dispose();
});

// The toolbar floats at the stage's top centre — the same slot the view tabs
// float in — and the two are not the same width. A part with several views left
// its tabs peeking out either side of the toolbar (measured in Chromium: 78px
// each side for a five-view part on a 1400px stage), which is what "the sketch
// UI takes over that spot" is supposed to mean and did not.
test("sketch mode hides the view tabs too; exit restores them", () => {
  const els = makeElements();
  withViewbar(els);
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {},
  });
  expect(els.tabs.hidden).toBe(false);

  runtime.annotate.setEnabled(true);
  expect(els.tabs.hidden).toBe(true);

  runtime.annotate.setEnabled(false);
  expect(els.tabs.hidden).toBe(false);

  runtime.dispose();
});

// `hidden` alone is not enough here, and that is not theoretical: app.css gives
// the tab pill `display: flex`, which is author-origin and beats the UA's
// [hidden] rule — the same trap #viewbar[hidden] already has an explicit rule
// for. A host that restyles the pill under its own id (partforge-cloud's
// `#viewer #part`) would beat any rule this framework could ship, so the hide
// rides on the element itself.
test("the view-tab hide survives a host stylesheet that gives the pill its own display", () => {
  const els = makeElements();
  withViewbar(els);
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {},
  });

  runtime.annotate.setEnabled(true);
  expect(els.tabs.style.display).toBe("none");

  runtime.annotate.setEnabled(false);
  expect(els.tabs.style.display).toBe("");

  runtime.dispose();
});

test("leaving sketch mode restores the view tabs' PRIOR hidden state, not just false", () => {
  const els = makeElements();
  withViewbar(els);
  els.tabs.hidden = true; // a host with its own reason to hide the tabs
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {},
  });

  runtime.annotate.setEnabled(true);
  expect(els.tabs.hidden).toBe(true);
  runtime.annotate.setEnabled(false);
  expect(els.tabs.hidden).toBe(true); // the host's reason survives the round-trip

  runtime.dispose();
});

test("annotateSend: 'host' keeps Send out of the sketch toolbar", () => {
  const els = makeElements();
  withViewbar(els);
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {}, annotateSend: "host",
  });
  expect(els.viewer.querySelector('.pf-sketch-toolbar [data-action="send"]')).toBeNull();
  runtime.dispose();
});

// --- viewer state carry-over across a remount -------------------------------
// partforge-cloud applies EVERY edit by remounting — the agent's, an undo, a
// settings commit — so without a handoff the camera snaps back and the cutaway
// closes on every turn. getViewerState() is the snapshot; mount's `viewerState`
// option is the restore.

test("getViewerState reports the live camera, projection and cutaway", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const viewer = fakeViewers.at(-1);
  els.chrome.cutaway.click(); // the user slices the part open

  const state = runtime.getViewerState();
  expect(state.camera).toEqual({ pos: [0, 0, 0], target: [0, 0, 0] });
  expect(state.projection).toBe("perspective");
  expect(state.cutaway.enabled).toBe(true);
  // Structured-cloneable, so a host may store or post it rather than only
  // handing it straight back.
  expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  expect(viewer.getCameraState).toHaveBeenCalled();
  runtime.dispose();
});

test("a carried camera outranks the persisted one", () => {
  // The persisted pose is only written at the end of an orbit drag, so it can
  // be older than what is on screen. The carried one is the live answer.
  localStorage.setItem("partforge:camera", JSON.stringify({ pos: [9, 9, 9], target: [0, 0, 0] }));
  const carried = { pos: [1, 2, 3], target: [4, 5, 6] };
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, viewerState: { camera: carried, projection: "perspective", cutaway: null },
  });
  const viewer = fakeViewers.at(-1);
  finishFirstBuild(workers);

  expect(viewer.setCameraState).toHaveBeenCalledWith(carried);
  expect(viewer.setCameraState).toHaveBeenCalledTimes(1);
  runtime.dispose();
});

test("without a carried state the persisted camera still applies", () => {
  // The first mount of a session has nothing to carry, and must behave exactly
  // as it did before this option existed.
  const stored = { pos: [9, 9, 9], target: [0, 0, 0] };
  localStorage.setItem("partforge:camera", JSON.stringify(stored));
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const viewer = fakeViewers.at(-1);
  finishFirstBuild(workers);

  expect(viewer.setCameraState).toHaveBeenCalledWith(stored);
  runtime.dispose();
});

test("a carried cutaway comes back on, with its button in step", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const cutaway = { enabled: true, flipped: true, pose: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] } };
  const runtime = mount(makePart(), {
    createWorker, elements: els, viewerState: { camera: null, projection: "perspective", cutaway },
  });
  const viewer = fakeViewers.at(-1);
  // Not before the build: enabling needs the sub-parts registered and real
  // bounds to size the plane against.
  expect(viewer.setCutawayState).not.toHaveBeenCalled();
  finishFirstBuild(workers);

  expect(viewer.setCutawayState).toHaveBeenCalledWith(cutaway);
  // The button was not what turned it on, so mount has to sync the chrome or
  // the part comes back sliced open under a control still reading "off".
  expect(els.chrome.cutaway.getAttribute("aria-pressed")).toBe("true");
  expect(els.chrome.cutaway.classList.contains("on")).toBe(true);
  runtime.dispose();
});

test("the camera is restored before the cutaway", () => {
  // The cutaway's fallback pose is seeded from the camera direction, so a
  // restore in the other order would square the plane up with the wrong view.
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker,
    elements: els,
    viewerState: {
      camera: { pos: [1, 2, 3], target: [0, 0, 0] },
      projection: "perspective",
      cutaway: { enabled: true, flipped: false, pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } },
    },
  });
  const viewer = fakeViewers.at(-1);
  finishFirstBuild(workers);

  expect(viewer.setCameraState.mock.invocationCallOrder[0])
    .toBeLessThan(viewer.setCutawayState.mock.invocationCallOrder[0]);
  runtime.dispose();
});

test("a cutaway that was off carries nothing and leaves the button alone", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker,
    elements: els,
    viewerState: {
      camera: null,
      projection: "perspective",
      cutaway: { enabled: false, flipped: false, pose: null },
    },
  });
  const viewer = fakeViewers.at(-1);
  finishFirstBuild(workers);

  expect(viewer.setCutawayState).not.toHaveBeenCalled();
  expect(els.chrome.cutaway.getAttribute("aria-pressed")).toBe("false");
  runtime.dispose();
});

test("a carried projection outranks the persisted one", () => {
  localStorage.setItem("partforge:projection", "orthographic");
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), {
    createWorker, elements: els, viewerState: { camera: null, projection: "perspective", cutaway: null },
  });
  const viewer = fakeViewers.at(-1);
  expect(viewer.setProjection).toHaveBeenCalledWith("perspective");
  localStorage.clear();
  runtime.dispose();
});

test("mount carries files and panelState into custom controls and reads state/errors back", () => {
  const { workers, createWorker } = makeWorkers();
  const part = makePart();
  part.defaults.tiles = [{ q: 0 }];
  let host;
  part.parameters = [{ id: "t", title: "Tiles", controls: [
    { key: "tiles", type: "custom", label: "Tiles", widget: (h) => { host = h; } },
    { key: "bad", type: "custom", label: "Bad", widget: () => { throw new Error("nope"); } },
  ] }];
  part.defaults.bad = [];
  const runtime = mount(part, {
    createWorker, elements: makeElements(),
    files: { "assets/a.svg": "<svg/>" },
    panelState: { tiles: { selected: 2 } },
  });
  finishFirstBuild(workers);
  expect(host.file("assets/a.svg")).toBe("<svg/>");
  expect(host.state).toEqual({ selected: 2 });
  host.setState({ selected: 4 });
  expect(runtime.getPanelState()).toEqual({ tiles: { selected: 4 } });
  expect(runtime.getPanelErrors()).toEqual([{ key: "bad", label: "Bad", phase: "create", message: "nope" }]);
  runtime.dispose();
});

test("makeHandle defaults getPanelState/getPanelErrors when a mount resolves no panel", () => {
  const h = makeHandle({ ready: Promise.resolve(), dispose() {}, viewer: {}, setParams() {} });
  expect(h.getPanelState()).toEqual({});
  expect(h.getPanelErrors()).toEqual([]);
});
