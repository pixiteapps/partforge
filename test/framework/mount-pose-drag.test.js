// @vitest-environment happy-dom
// Dragging the pose of an organic part (docs/superpowers/specs/2026-10-31-implicit-pose-drag-design.md
// §4): a frames-only slider input deforms the last exact mesh in place with no job, and the
// exact build runs on release or after a 150 ms pause. The viewer is faked (mount.test.js's
// fake plus the skin surface); the probe, regen loop, mesh cache and panel run for real.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fakeViewers = [];
// An async renderViews the test releases by hand (realistic mode awaits assets there).
const renderGate = { release: null, seen: null };
vi.mock("../../src/framework/viewer.js", () => ({
  createViewer: vi.fn(() => {
    const built = new Set();
    const payloads = new Map(); // name -> the delivered payload (setSubVertices writes into it)
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
      emitCameraStart: () => { for (const cb of [...orbitCbs]) cb(); }, // the user grabbed the camera
      domElement: document.createElement("div"),
      showAssembly: vi.fn(),
      hideAssembly: vi.fn(),
      setSubGeometry: vi.fn((name) => built.add(name)),
      setSubPose: vi.fn(),
      hasSubMesh: (name) => built.has(name),
      // exportPreview's read: one 1mm triangle for every sub-part delivered.
      getSubMeshPayload: vi.fn((name) => (built.has(name) ? {
        name, triangles: 1, indices: null,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      } : null)),
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
      getEnvironment: () => "studio",
      setEnvironment: vi.fn(async (id) => id),
      onEnvironmentChange: () => () => {},
      setPrintFrames: vi.fn(),
      setSheetFrames: vi.fn(),
      setFrameSource: vi.fn(),
      invalidateFrames: vi.fn(),
      orbitBy: vi.fn(),
      _subMeshes: {},
      flashPoint: vi.fn(),
      holdFlashPoint: vi.fn(() => true),
      releaseFlashPoints: vi.fn(),
      getHeldAnchorPoint: vi.fn(() => [1, 2, 3]),
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
      // The pose-drag surface. setSubGeometry keeps the delivered payload and
      // setSubVertices writes INTO its arrays, as the real viewer does (buildGeometry
      // wraps them without copying): a skin that read its base from the payload
      // would drift.
      setSubVertices: vi.fn((name, { positions, normals }) => {
        const p = payloads.get(name);
        if (!p) return false;
        p.positions.set(positions);
        p.normals.set(normals);
        return true;
      }),
      captureCanonicalViews: vi.fn(() => []),
      captureCurrent: vi.fn(() => "data:image/jpeg;base64,"),
      renderViews: vi.fn(async () => {
        await new Promise((r) => { renderGate.release = r; });
        renderGate.seen = Array.from(payloads.get("body").positions); // what the capture draws
        return [];
      }),
      dispose: vi.fn(),
    };
    v.setSubGeometry = vi.fn((name, payload) => { built.add(name); payloads.set(name, payload); });
    fakeViewers.push(v);
    return v;
  }),
}));

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

import { mount } from "../../src/framework/mount.js";
import { frameMotions, skinVertices } from "../../src/framework/skin/deform.js";
import { implicitCallId } from "../../src/framework/geometry/implicit/call-id.js";
import { TWO_BONE } from "../fixtures/skin-fixtures.js";

// TWO_BONE with its first capsule's radius set: `r` is a non-frame change.
const withRadius = (r) => ({
  ...TWO_BONE(0).root,
  children: [{ ...TWO_BONE(0).root.children[0], r }, TWO_BONE(0).root.children[1]],
});
const spec = (bend, r = 4) => ({ ...TWO_BONE(bend), root: withRadius(r) });
const id = implicitCallId(spec(0), []);
const FRAMES = [null, `${id}:root`, `${id}:child`];

const makePart = ({ lid = false, images = false } = {}) => ({
  meta: { title: "Drag Part", backend: "manifold" },
  defaults: { bend: 0, r: 4, img: 1 },
  views: { v: { label: "V" }, w: { label: "W" } },
  // An asset the build never names in its specs: swapping it changes no k.implicit spec.
  ...(images ? { images: (p) => ({ tex: `tex-${p.img}.png` }) } : {}),
  parts: {
    body: { label: "Body", views: ["v", "w"], build: (k, p) => k.implicit(spec(p.bend, p.r)) },
    ...(lid ? { lid: { label: "Lid", views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [1, 1, 1 + p.bend] }) } } : {}),
  },
  parameters: [{ id: "pose", title: "Pose", advanced: [
    { key: "bend", label: "Bend", min: 0, max: 90, step: 1 },
    { key: "r", label: "Radius", min: 2, max: 6, step: 1 },
    { key: "img", label: "Image", min: 1, max: 3, step: 1 },
  ] }],
});

// Two triangles: corners 0-2 on root, 3-5 on child (one blended). Offset by `bend`, so two
// deliveries are told apart.
const basePositions = (bend) => Float32Array.of(0, 1, 0, 1, 2, 0, 0, 3, 1, 0, 25, 0, 1, 26, 0, 0, 27, 1).map((x, i) => (i % 3 === 0 ? x + bend / 100 : x));
const baseNormals = () => Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 1);
const bindings = () => ({
  frameA: Uint16Array.of(1, 1, 1, 2, 2, 2),
  frameB: Uint16Array.of(0, 0, 0, 1, 1, 1),
  weight: Float32Array.of(1, 1, 1, 0.75, 0.5, 1),
  frames: FRAMES,
});
const delivery = (bend, over = {}) => ({
  name: "body", frame: "canonical", triangles: 2,
  positions: basePositions(bend), normals: baseNormals(),
  edges: new Float32Array(0), reads: ["bend", "r"], bindings: bindings(),
  ...over,
});
const lidDelivery = () => ({
  name: "lid", frame: "canonical", triangles: 1,
  positions: new Float32Array(9), normals: new Float32Array(9), edges: new Float32Array(0), reads: ["bend"],
});
// A fresh skin of delivery(fromBend) to the pose at `toBend`.
const skinOf = (fromBend, toBend) => skinVertices(
  { positions: basePositions(fromBend), normals: baseNormals(), bindings: bindings() },
  frameMotions([spec(fromBend)], [spec(toBend)], FRAMES),
  { positions: new Float32Array(18), normals: new Float32Array(18) },
).positions;

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
    chrome: { reframe: mk("button"), theme: mk("button"), cutaway: mk("button"), measure: mk("button"), annotate: mk("button"), railToggle: mk("button") },
  };
  document.body.append(els.viewer, els.controls, els.rail, els.tabs,
    els.status.status, els.status.busy, els.status.phase,
    els.exports.stl, els.exports.step, els.exports.threeMf,
    els.chrome.reframe, els.chrome.theme, els.chrome.cutaway, els.chrome.measure,
    els.chrome.annotate, els.chrome.railToggle);
  return els;
}

const generates = (w) => w.postMessage.mock.calls.filter(([m]) => m?.type === "generate");

function setup({ lid = false, images = false, first = null, onParamsCommit } = {}) {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart({ lid, images }), { createWorker, elements: els, ...(onParamsCommit ? { onParamsCommit } : {}) });
  const v = fakeViewers[0];
  const w = workers.manifold;
  const reply = (meshes) => w.onmessage({ data: { type: "meshes", meshes, ms: 1 } });
  w.onmessage({ data: { type: "ready" } });
  const firstDelivery = first ?? delivery(0);
  reply(lid ? [firstDelivery, lidDelivery()] : [firstDelivery]);
  const slider = (key) => els.controls.querySelectorAll('input[type="range"]')[{ bend: 0, r: 1, img: 2 }[key]];
  const input = (key, value) => {
    const s = slider(key);
    s.value = String(value);
    s.dispatchEvent(new Event("input"));
  };
  const release = (key) => slider(key).dispatchEvent(new Event("change"));
  return { runtime, v, w, els, reply, input, release, firstDelivery };
}

beforeEach(() => {
  renderGate.release = null; renderGate.seen = null;
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  fakeViewers.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

test("a frames-only slider input deforms in place with no job; the exact build goes out after 150 ms", () => {
  const { v, w, input } = setup();
  const n = w.postMessage.mock.calls.length;
  input("bend", 30);
  expect(v.setSubVertices).toHaveBeenCalledTimes(1);
  expect(v.setSubVertices.mock.calls[0][0]).toBe("body");
  expect(v.setSubVertices.mock.calls[0][2]).toEqual({ deformed: true });
  expect(Array.from(v.setSubVertices.mock.calls[0][1].positions)).toEqual(Array.from(skinOf(0, 30)));
  expect(w.postMessage.mock.calls.length).toBe(n);
  vi.advanceTimersByTime(149);
  expect(w.postMessage.mock.calls.length).toBe(n);
  vi.advanceTimersByTime(1);
  expect(w.postMessage.mock.calls.length).toBe(n + 1);
  expect(generates(w).at(-1)[0].params.bend).toBe(30);
});

test("two drag inputs skin from the same base: no drift, and never from the delivered payload's arrays", () => {
  const { v, input, firstDelivery } = setup();
  input("bend", 30);
  // The fake viewer wrote the deformed positions into the delivered payload's own arrays.
  expect(Array.from(firstDelivery.positions)).toEqual(Array.from(skinOf(0, 30)));
  input("bend", 45);
  expect(v.setSubVertices).toHaveBeenCalledTimes(2);
  const second = v.setSubVertices.mock.calls[1][1];
  expect(second.positions).not.toBe(firstDelivery.positions);
  expect(Array.from(second.positions)).toEqual(Array.from(skinOf(0, 45)));
});

test("release dispatches the exact build at once", () => {
  const onParamsCommit = vi.fn();
  const { w, input, release } = setup({ onParamsCommit });
  const n = generates(w).length;
  input("bend", 30);
  release("bend");
  expect(generates(w).length).toBe(n + 1);
  expect(generates(w).at(-1)[0].params.bend).toBe(30);
  expect(onParamsCommit).toHaveBeenCalledWith({ changed: ["bend"], params: expect.objectContaining({ bend: 30 }) });
  vi.runAllTimers();
  expect(generates(w).length).toBe(n + 1); // nothing armed behind it
});

test("the exact delivery replaces the deformed mesh and becomes the new base", () => {
  const { v, input, release, reply } = setup();
  input("bend", 30);
  release("bend");
  const exact = delivery(30);
  reply([exact]);
  expect(v.setSubGeometry).toHaveBeenLastCalledWith("body", exact);
  input("bend", 40);
  const last = v.setSubVertices.mock.calls.at(-1);
  expect(last[2]).toEqual({ deformed: true });
  expect(Array.from(last[1].positions)).toEqual(Array.from(skinOf(30, 40)));
});

test("a stale-but-exact delivery during a drag becomes the skin base; a sub-part without bindings is discarded", () => {
  const { v, w, input, reply } = setup({ lid: true });
  input("bend", 30);
  vi.advanceTimersByTime(150); // the pause: the exact build at 30 goes out
  const n = generates(w).length;
  expect(generates(w).at(-1)[0].subparts.sort()).toEqual(["body", "lid"]);
  input("bend", 40); // mid-flight
  const geoCalls = v.setSubGeometry.mock.calls.length;
  const vertCalls = v.setSubVertices.mock.calls.length;
  const exact = delivery(30);
  reply([exact, lidDelivery()]);
  const newGeo = v.setSubGeometry.mock.calls.slice(geoCalls);
  expect(newGeo.map(([name]) => name)).toEqual(["body"]);
  expect(newGeo[0][1]).toBe(exact);
  const newVerts = v.setSubVertices.mock.calls.slice(vertCalls);
  expect(newVerts.length).toBe(1);
  expect(newVerts[0][0]).toBe("body");
  expect(v.setSubVertices.mock.invocationCallOrder[vertCalls]).toBeGreaterThan(v.setSubGeometry.mock.invocationCallOrder.at(-1));
  expect(Array.from(newVerts[0][1].positions)).toEqual(Array.from(skinOf(30, 40)));
  expect(generates(w).length).toBe(n);
  vi.advanceTimersByTime(150);
  expect(generates(w).length).toBe(n + 1);
  expect(generates(w).at(-1)[0].params.bend).toBe(40);
});

test("a stale delivery after the drag was released is discarded as before", () => {
  const { v, input, release, reply } = setup();
  input("bend", 30);
  vi.advanceTimersByTime(150); // built at 30
  input("bend", 40);
  release("bend");
  const geoCalls = v.setSubGeometry.mock.calls.length;
  reply([delivery(30)]); // stale, and no drag in progress
  expect(v.setSubGeometry.mock.calls.length).toBe(geoCalls);
});

test("setParams during a drag restores the exact base and takes the ordinary rebuild", () => {
  const { runtime, v, w, input } = setup();
  input("bend", 30);
  const n = generates(w).length;
  runtime.setParams({ bend: 50 });
  const last = v.setSubVertices.mock.calls.at(-1);
  expect(Array.from(last[1].positions)).toEqual(Array.from(basePositions(0)));
  expect(last[2]).toEqual({ deformed: false });
  vi.advanceTimersByTime(150);
  expect(generates(w).length).toBe(n);
  vi.advanceTimersByTime(30);
  expect(generates(w).length).toBe(n + 1);
  expect(generates(w).at(-1)[0].params.bend).toBe(50);
});

test("a change that is not frames-only restores the base and rebuilds", () => {
  const { v, w, input } = setup();
  input("bend", 30);
  const n = generates(w).length;
  input("r", 5);
  const last = v.setSubVertices.mock.calls.at(-1);
  expect(Array.from(last[1].positions)).toEqual(Array.from(basePositions(0)));
  expect(last[2]).toEqual({ deformed: false });
  vi.advanceTimersByTime(150);
  expect(generates(w).length).toBe(n);
  vi.advanceTimersByTime(30);
  expect(generates(w).length).toBe(n + 1);
});

test("dragging back to the delivered pose shows the exact base, not an identity skin", () => {
  const { v, w, input, release } = setup();
  input("bend", 30);
  input("bend", 0);
  const last = v.setSubVertices.mock.calls.at(-1);
  expect(last[2]).toEqual({ deformed: false });
  expect(Array.from(last[1].positions)).toEqual(Array.from(basePositions(0)));
  const n = generates(w).length;
  release("bend");
  vi.runAllTimers();
  expect(generates(w).length).toBe(n); // the exact mesh is current: nothing to build
});

test("captureViews during a drag captures the exact base", () => {
  const { runtime, v, input } = setup();
  input("bend", 30);
  runtime.captureViews(["iso"]);
  const restoreAt = v.setSubVertices.mock.calls.length - 1;
  expect(v.setSubVertices.mock.calls[restoreAt][2]).toEqual({ deformed: false });
  expect(Array.from(v.setSubVertices.mock.calls[restoreAt][1].positions)).toEqual(Array.from(basePositions(0)));
  expect(v.setSubVertices.mock.invocationCallOrder[restoreAt]).toBeLessThan(v.captureCanonicalViews.mock.invocationCallOrder[0]);
});

test("a posed delivery never becomes a skin base", () => {
  const { v, w, input } = setup({ first: delivery(0, { frame: "posed" }) });
  const n = generates(w).length;
  input("bend", 30);
  expect(v.setSubVertices).not.toHaveBeenCalled();
  vi.advanceTimersByTime(179);
  expect(generates(w).length).toBe(n);
  vi.advanceTimersByTime(1);
  expect(generates(w).length).toBe(n + 1);
});

test("exportPreview during a drag rejects as not fully built", async () => {
  const { runtime, input } = setup();
  input("bend", 30);
  await expect(runtime.exportPreview()).rejects.toThrow(/not fully built/);
});

// Fix round 1.

test("an async renderViews holds the drag off: an input while it waits deforms nothing, and the capture draws the base", async () => {
  const { runtime, v, input } = setup();
  input("bend", 30); // deformed
  const pending = runtime.renderViews(["iso"], { renderMode: "realistic" });
  await Promise.resolve(); await Promise.resolve();
  expect(v.renderViews).toHaveBeenCalledTimes(1); // waiting on its assets
  const vertCalls = v.setSubVertices.mock.calls.length;
  expect(v.setSubVertices.mock.calls.at(-1)[2]).toEqual({ deformed: false }); // restored before it started
  input("bend", 45); // mid-capture
  expect(v.setSubVertices.mock.calls.slice(vertCalls).some(([, , o]) => o?.deformed)).toBe(false);
  renderGate.release();
  await pending;
  expect(renderGate.seen).toEqual(Array.from(basePositions(0)));
  input("bend", 50); // released: the drag deforms again
  expect(v.setSubVertices.mock.calls.at(-1)[2]).toEqual({ deformed: true });
});

test("an input held off by a capture takes the ordinary debounce", async () => {
  const { runtime, w, input } = setup();
  const pending = runtime.renderViews(["iso"]);
  await Promise.resolve();
  const n = generates(w).length;
  input("bend", 30);
  vi.advanceTimersByTime(150);
  expect(generates(w).length).toBe(n);
  vi.advanceTimersByTime(30);
  expect(generates(w).length).toBe(n + 1);
  renderGate.release();
  await pending;
});

test("captureCurrent during a drag captures the exact base", () => {
  const { runtime, v, input } = setup();
  input("bend", 30);
  runtime.captureCurrent({ size: 256 });
  const restoreAt = v.setSubVertices.mock.calls.length - 1;
  expect(v.setSubVertices.mock.calls[restoreAt][2]).toEqual({ deformed: false });
  expect(Array.from(v.setSubVertices.mock.calls[restoreAt][1].positions)).toEqual(Array.from(basePositions(0)));
  expect(v.setSubVertices.mock.invocationCallOrder[restoreAt]).toBeLessThan(v.captureCurrent.mock.invocationCallOrder[0]);
  input("bend", 40); // a sync capture's hold is released at once
  expect(v.setSubVertices.mock.calls.at(-1)[2]).toEqual({ deformed: true });
});

test("a tab switch mid-drag restores the exact base and ends the drag", () => {
  const { v, w, els, input, release } = setup();
  input("bend", 30);
  const tab = [...els.tabs.querySelectorAll("button")].find((b) => b.textContent.includes("W"));
  tab.click();
  const last = v.setSubVertices.mock.calls.at(-1);
  expect(last[2]).toEqual({ deformed: false }); // the viewer shows its edge lines again
  expect(Array.from(last[1].positions)).toEqual(Array.from(basePositions(0)));
  const n = generates(w).length;
  release("bend"); // no drag left to flush
  expect(generates(w).length).toBe(n);
});

test("a stale reply mid-drag waits only for the rest of the pause since the last input", () => {
  const { w, input, reply } = setup();
  input("bend", 30);
  vi.advanceTimersByTime(150); // exact build at 30 goes out
  const n = generates(w).length;
  input("bend", 40);
  vi.advanceTimersByTime(100); // the reply lands 100 ms after the last input
  reply([delivery(30)]);
  vi.advanceTimersByTime(49);
  expect(generates(w).length).toBe(n);
  vi.advanceTimersByTime(1);
  expect(generates(w).length).toBe(n + 1);
});

test("returning the slider to its start ends the drag: release flushes nothing", () => {
  const { w, input, release } = setup();
  input("bend", 30);
  input("bend", 0);
  const n = generates(w).length;
  release("bend");
  expect(generates(w).length).toBe(n);
});

test("an asset swap with identical implicit specs is not skinnable: base restored, ordinary rebuild", () => {
  const { v, w, input } = setup({ images: true, first: delivery(0, { reads: ["bend", "r", "img"] }) });
  input("bend", 30);
  expect(v.setSubVertices.mock.calls.at(-1)[2]).toEqual({ deformed: true });
  const n = generates(w).length;
  input("img", 2);
  const last = v.setSubVertices.mock.calls.at(-1);
  expect(last[2]).toEqual({ deformed: false });
  expect(Array.from(last[1].positions)).toEqual(Array.from(basePositions(0)));
  vi.advanceTimersByTime(150);
  expect(generates(w).length).toBe(n);
  vi.advanceTimersByTime(30);
  expect(generates(w).length).toBe(n + 1);
});
