// @vitest-environment happy-dom
// Stopping a cage drag at the last valid pose (docs/superpowers/specs/2026-11-22-cage-pose-
// drag-design.md, "Stopping at the last valid pose"), through mount: a handle frame that
// would pass the body through itself holds at the last clear pose, a slider held at such a
// pose builds at the last valid one, and a full build after a drag that warns the body
// passes through itself is not shown and is replaced by one at the last clean build's
// params. The viewer is faked (mount-pose-drag.test.js's fake); the meshes, ties and probe
// are real (handle(..., generate)), and so are the pose session, the regen loop and the
// panel. The last block drives the skin controller (skin-drag.js) directly.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const fakeViewers = [];
vi.mock("../src/framework/viewer.js", () => ({
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
      renderViews: vi.fn(async () => []),
      dispose: vi.fn(),
    };
    v.setSubGeometry = vi.fn((name, payload) => { built.add(name); payloads.set(name, payload); });
    fakeViewers.push(v);
    return v;
  }),
}));

vi.mock("../src/framework/selection/index.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    attachHoverLabels: vi.fn(() => ({ detach: vi.fn(), setSuppressed: vi.fn() })),
    attachPickToggle: vi.fn(() => ({ detach: vi.fn() })),
    attachPicker: vi.fn(() => ({ setActive: vi.fn(), detach: vi.fn() })),
  };
});

vi.mock("../src/framework/pick-request/index.js", async () => ({
  ...(await import("../src/framework/pick-request/endpoint.js")),
  createPickRequestClient: vi.fn(() => ({ detach: vi.fn() })),
}));

// Pose mode, stubbed, with the REAL session behind it: the test drives begin / frame / end
// as the pointer would, and the session reaches mount only through the effects mount hands
// createPoseMode (write, hold, commit, collide, ...). The solve is the test's: a frame's
// target x is the swing.
const poseStubs = vi.hoisted(() => []);
vi.mock("../src/framework/pose/pose-mode.js", async () => {
  const { createPoseSession } = await import("../src/framework/pose/pose-session.js");
  return {
    createPoseMode: vi.fn((viewer, opts) => {
      const session = createPoseSession({
        part: opts.part, getParams: opts.getParams, write: opts.write, restore: opts.restore,
        commit: opts.commit, hold: opts.hold, staleSubParts: opts.staleSubParts,
        ghost: opts.ghost, unghost: opts.unghost, collide: opts.collide,
        solve: ({ target }) => ({ values: { swing: target.point[0] }, error: 0 }),
      });
      const stub = {
        opts, session,
        delivered: vi.fn(), externalWrite: vi.fn(), refresh: vi.fn(), detach: vi.fn(),
        setPins: vi.fn(), getPins: () => [], pinCount: () => 0, releasePins: vi.fn(),
        handlePoints: () => [], isEnabled: () => true, setEnabled: vi.fn(), isLive: () => true,
        onModeChange: () => () => {}, setSuppressed: vi.fn(), claimsHover: vi.fn(() => false),
        onHoverChange: () => () => {}, takeClick: vi.fn(() => false), isDragging: vi.fn(() => false),
        viewChanged: vi.fn(),
      };
      poseStubs.push(stub);
      return stub;
    }),
  };
});
vi.mock("../src/framework/pose/pose-controls.js", () => ({
  attachPoseControls: vi.fn(() => ({ detach: () => {} })),
}));

// The check, spied: a part with no cage base must never reach it.
const spies = vi.hoisted(() => ({}));
vi.mock("../src/framework/skin/cage-deform.js", async (importOriginal) => {
  const real = await importOriginal();
  spies.validity = vi.fn(real.cagePoseValidity);
  return { ...real, cagePoseValidity: spies.validity };
});

import { mount } from "../src/framework/mount.js";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { createSkinDrag } from "../src/framework/skin/skin-drag.js";

// A box with an arm out of +x; `swing` turns the arm's last segment about its hinge. At 60°
// it is clear; at 140° it is back through the arm, and the drag check refuses it; at 120°
// the drag check passes it but the full build warns that it passes through itself.
const armCage = (make, deg) => {
  const c = make({ box: { size: [20, 20, 20] } });
  let a = c.extrude("+x:0,0", { by: 8 });
  a = c.extrude(a, { by: 8 });
  const hinge = c.centroid(a);
  a = c.extrude(a, { by: 25 });
  c.rotate(a, { axis: "z", deg, about: hinge });
  return c;
};
const makePart = ({ handles = false } = {}) => ({
  meta: { title: "Swing", backend: "manifold" },
  defaults: { swing: 0 },
  ...(handles ? { handles: { arm: { point: () => [0, 0, 0], drag: "point", params: ["swing"] } } } : {}),
  views: { v: { label: "V" } },
  parts: { body: { label: "Body", views: ["v"], build: (k, p) => k.subdiv(armCage(k.cage, p.swing)) } },
  parameters: [{ id: "pose", title: "Pose", controls: [{ key: "swing", label: "Swing", min: 0, max: 170, step: 1 }] }],
});
// No cage: a box whose height a slider sets.
const plainPart = () => ({
  meta: { title: "Plain", backend: "manifold" },
  defaults: { swing: 0 },
  handles: { arm: { point: () => [0, 0, 0], drag: "point", params: ["swing"] } },
  views: { v: { label: "V" } },
  parts: { body: { label: "Body", views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [1, 1, 1 + p.swing] }) } },
  parameters: [{ id: "pose", title: "Pose", controls: [{ key: "swing", label: "Swing", min: 0, max: 170, step: 1 }] }],
});

let k;
const built = {}; // swing -> the real delivered mesh at that swing (with ties)
const gen = async (part, params) => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts: ["body"], view: "v", params }, post);
  const msgs = post.mock.calls.map(([m]) => m);
  const err = msgs.find((m) => m.type === "error");
  if (err) throw new Error(err.message ?? JSON.stringify(err));
  return msgs.find((m) => m.type === "meshes").meshes[0];
};
beforeAll(async () => {
  k = await bootManifoldKernel({ quality: "preview" });
  for (const swing of [0, 5, 60]) built[swing] = await gen(makePart(), { swing });
  built.plain = await gen(plainPart(), { swing: 0 });
}, 120_000);
// A fresh copy of a delivery: the fake viewer writes deformed poses into the payload's arrays.
const delivery = (key) => {
  const m = built[key];
  return { ...m, positions: m.positions.slice(), normals: m.normals.slice() };
};

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
const THROUGH = "subdiv: the body passes through itself between +x:0,0>>.s1 and +x:0,0>>>.s1";

function setup({ part = makePart(), first = delivery(0), onParamsCommit = vi.fn(), ms = 2000 } = {}) {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(part, { createWorker, elements: els, onParamsCommit });
  const v = fakeViewers[0];
  const w = workers.manifold;
  // Slow, as the hand is: a handle drag of a cheap part would rebuild as it goes instead.
  const reply = (meshes, extra = {}) => w.onmessage({ data: { type: "meshes", meshes, ms, ...extra } });
  w.onmessage({ data: { type: "ready" } });
  reply([first]);
  const slider = () => els.controls.querySelector('input[type="range"]');
  const input = (value) => {
    const s = slider();
    s.value = String(value);
    s.dispatchEvent(new Event("input"));
  };
  const release = () => slider().dispatchEvent(new Event("change"));
  const pose = poseStubs[0];
  return { runtime, v, w, els, reply, input, release, slider, onParamsCommit, pose, params: () => pose?.opts.getParams() };
}

beforeEach(() => {
  poseStubs.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  fakeViewers.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

// The positions of every setSubVertices call since `from`, as plain arrays.
const drawsSince = (v, from) => v.setSubVertices.mock.calls.slice(from).map(([, { positions }, opts]) => ({ p: Array.from(positions), opts }));

describe("a handle drag on a cage body", () => {
  test("Review Focus 3: a move into an invalid pose draws nothing new, writes the last valid params, commits none of it; a valid move draws", () => {
    const { v, w, pose, params, onParamsCommit } = setup({ part: makePart({ handles: true }) });
    const s = pose.session;
    expect(s.begin("arm")).toBe(true);
    s.frame([60, 0, 0]);
    expect(params().swing).toBe(60);
    const drawn = v.setSubVertices.mock.calls.length;
    expect(drawn).toBeGreaterThan(0);
    const at60 = drawsSince(v, drawn - 1)[0];
    expect(at60.opts).toEqual({ deformed: true });

    s.frame([140, 0, 0]);   // the arm through itself
    expect(params().swing).toBe(60);
    // Whatever was drawn since is the 60° pose again, never the 140° one.
    for (const d of drawsSince(v, drawn)) expect(d.p).toEqual(at60.p);
    expect(onParamsCommit).not.toHaveBeenCalled();

    s.frame([50, 0, 0]);    // back into valid poses: the body moves again
    expect(params().swing).toBe(50);
    const last = drawsSince(v, 0).at(-1);
    expect(last.opts).toEqual({ deformed: true });
    expect(last.p).not.toEqual(at60.p);

    const n = generates(w).length;
    s.end();
    expect(onParamsCommit).toHaveBeenCalledTimes(1);
    expect(onParamsCommit.mock.calls[0][0]).toEqual({ changed: ["swing"], params: expect.objectContaining({ swing: 50 }) });
    expect(generates(w).length).toBe(n + 1);
    expect(generates(w).at(-1)[0].params.swing).toBe(50);
  });

  test("a drag released while held at the last valid pose commits that pose", () => {
    const { w, pose, onParamsCommit } = setup({ part: makePart({ handles: true }) });
    const s = pose.session;
    s.begin("arm");
    s.frame([60, 0, 0]);
    s.frame([140, 0, 0]);
    s.end();
    expect(onParamsCommit).toHaveBeenCalledTimes(1);
    expect(onParamsCommit.mock.calls[0][0].params.swing).toBe(60);
    expect(generates(w).at(-1)[0].params.swing).toBe(60);
  });
});

describe("a slider drag on a cage body", () => {
  test("held at an invalid pose the body does not move; the release builds and commits the last valid pose, and the slider shows it", () => {
    const { v, w, input, release, slider, onParamsCommit } = setup();
    input(60);
    const drawn = v.setSubVertices.mock.calls.length;
    expect(drawn).toBe(1);
    input(140);
    expect(v.setSubVertices.mock.calls.length).toBe(drawn); // held: nothing drawn
    const n = generates(w).length;
    release();
    expect(generates(w).length).toBe(n + 1);
    expect(generates(w).at(-1)[0].params.swing).toBe(60);
    expect(onParamsCommit).toHaveBeenCalledTimes(1);
    expect(onParamsCommit.mock.calls[0][0].params.swing).toBe(60);
    expect(slider().value).toBe("60");
    vi.runAllTimers();
    expect(generates(w).length).toBe(n + 1);
  });

  test("the pause build at an invalid pose goes out at the last valid one", () => {
    const { w, input, slider, onParamsCommit } = setup();
    input(60);
    input(140);
    const n = generates(w).length;
    vi.advanceTimersByTime(SKIN_PAUSE);
    expect(generates(w).length).toBe(n + 1);
    expect(generates(w).at(-1)[0].params.swing).toBe(60);
    expect(slider().value).toBe("60");
    expect(onParamsCommit).not.toHaveBeenCalled();
  });

  test("an invalid first move holds the exact base: the build goes out at the base's params", () => {
    const { v, w, input, release } = setup();
    input(140);
    expect(v.setSubVertices).not.toHaveBeenCalled();
    release();
    // Back at the delivered pose: nothing is missing, so nothing is built.
    vi.runAllTimers();
    expect(generates(w).every(([m]) => m.params.swing !== 140)).toBe(true);
  });
});

describe("a full build after a cage drag that passes through itself", () => {
  test("is not shown: the params go back to the last clean build's, whose mesh is still on screen", () => {
    const { v, w, input, release, reply, slider, onParamsCommit } = setup();
    input(5);
    release();
    expect(generates(w).at(-1)[0].params.swing).toBe(5);
    const geo = v.setSubGeometry.mock.calls.length;
    const n = generates(w).length;
    reply([delivery(5)], { warnings: [{ part: "body", message: THROUGH }] });
    expect(v.setSubGeometry.mock.calls.length).toBe(geo); // the refused mesh is never drawn
    expect(slider().value).toBe("0");
    expect(onParamsCommit.mock.calls.at(-1)[0]).toEqual({ changed: ["swing"], params: expect.objectContaining({ swing: 0 }) });
    // The clean build is the skin's base: the exact mesh goes back, and nothing is missing.
    expect(v.setSubVertices.mock.calls.at(-1)[2]).toEqual({ deformed: false });
    vi.runAllTimers();
    expect(generates(w).length).toBe(n);
  });

  test("one build runs at the last clean build's params when its mesh is gone, and that build is shown even if it warns", () => {
    const { runtime, v, w, input, release, reply, onParamsCommit } = setup();
    // An ordinary edit whose build warns is shown, and is not a clean build.
    runtime.setParams({ swing: 60 });
    vi.advanceTimersByTime(200);
    reply([delivery(60)], { warnings: [{ part: "body", message: THROUGH }] });
    input(5);
    release();
    expect(generates(w).at(-1)[0].params.swing).toBe(5);
    const geo = v.setSubGeometry.mock.calls.length;
    const n = generates(w).length;
    reply([delivery(5)], { warnings: [{ part: "body", message: THROUGH }] });
    expect(v.setSubGeometry.mock.calls.length).toBe(geo);
    expect(generates(w).length).toBe(n + 1);
    expect(generates(w).at(-1)[0].params.swing).toBe(0);
    expect(onParamsCommit.mock.calls.at(-1)[0].params.swing).toBe(0);
    // One revert per release: the revert's own build is shown, warning or not.
    reply([delivery(0)], { warnings: [{ part: "body", message: THROUGH }] });
    expect(v.setSubGeometry.mock.calls.length).toBe(geo + 1);
    vi.runAllTimers();
    expect(generates(w).length).toBe(n + 1);
  });

  test("after a handle drag too", () => {
    const { v, w, pose, reply, onParamsCommit } = setup({ part: makePart({ handles: true }) });
    pose.session.begin("arm");
    pose.session.frame([5, 0, 0]);
    pose.session.end();
    expect(generates(w).at(-1)[0].params.swing).toBe(5);
    const geo = v.setSubGeometry.mock.calls.length;
    reply([delivery(5)], { warnings: [{ part: "body", message: THROUGH }] });
    expect(v.setSubGeometry.mock.calls.length).toBe(geo);
    expect(pose.opts.getParams().swing).toBe(0);
    expect(onParamsCommit.mock.calls.at(-1)[0].params.swing).toBe(0);
  });

  test("an ordinary setParams build that warns is shown as before", () => {
    const { runtime, v, w, reply } = setup();
    runtime.setParams({ swing: 5 });
    vi.advanceTimersByTime(200);
    expect(generates(w).at(-1)[0].params.swing).toBe(5);
    const geo = v.setSubGeometry.mock.calls.length;
    const n = generates(w).length;
    reply([delivery(5)], { warnings: [{ part: "body", message: THROUGH }] });
    expect(v.setSubGeometry.mock.calls.length).toBe(geo + 1);
    vi.runAllTimers();
    expect(generates(w).length).toBe(n);
  });
});

test("a part with no cage base: the check never runs, and a handle drag gets no guard", () => {
  const plain = delivery("plain");
  expect(plain.ties).toBeFalsy();
  const { w, input, release, reply, pose, onParamsCommit } = setup({ part: plainPart(), first: plain });
  expect(pose.opts.collide({ handle: plainPart().handles.arm, handleId: "arm", snapshot: { swing: 0 } })).toBeNull();
  input(140);
  release();
  expect(generates(w).at(-1)[0].params.swing).toBe(140);
  expect(onParamsCommit.mock.calls.at(-1)[0].params.swing).toBe(140);
  reply([{ ...plain }], { warnings: [{ part: "body", message: THROUGH }] });
  pose.session.begin("arm");
  pose.session.frame([30, 0, 0]);
  pose.session.end();
  expect(generates(w).at(-1)[0].params.swing).toBe(30);
  expect(spies.validity).not.toHaveBeenCalled();
});

describe("the skin controller with a cage base", () => {
  const fakeViewer = () => ({ hasSubMesh: () => true, setSubVertices: vi.fn(() => true) });
  function controller({ probe = probePoses } = {}) {
    const part = makePart();
    const params = { ...part.defaults };
    let version = 0;
    const viewer = fakeViewer();
    const skin = createSkinDrag(part, viewer, { params, getView: () => "v", getParamsVersion: () => version, probe });
    skin.recordDelivered("body", delivery(0), { view: "v", params: { ...part.defaults } });
    const edit = (patch) => { Object.assign(params, patch); version++; };
    return { skin, viewer, edit, params };
  }

  test("an invalid pose is held, not drawn; lastValidParams names the last pose drawn", () => {
    const { skin, viewer, edit } = controller();
    expect(skin.hasBase("body")).toBe(true);
    expect(skin.lastValidParams()).toEqual({ swing: 0 });
    edit({ swing: 60 });
    expect(skin.deform()).toEqual(["body"]);
    expect(viewer.setSubVertices).toHaveBeenCalledTimes(1);
    expect(skin.holdsInvalid()).toBe(false);
    expect(skin.lastValidParams()).toEqual({ swing: 60 });
    edit({ swing: 140 });
    expect(skin.deform()).toEqual(["body"]);   // still shown by the skin, at 60°
    expect(viewer.setSubVertices).toHaveBeenCalledTimes(1);
    expect(skin.holdsInvalid()).toBe(true);
    expect(skin.isDeformed("body") && skin.isDragging() && skin.cageDragActive()).toBe(true);
    expect(skin.lastValidParams()).toEqual({ swing: 60 });
    edit({ swing: 50 });
    skin.deform();
    expect(viewer.setSubVertices).toHaveBeenCalledTimes(2);
    expect(skin.holdsInvalid()).toBe(false);
    expect(skin.lastValidParams()).toEqual({ swing: 50 });
  });

  test("a live entry the cage code threw on is held as invalid", () => {
    let fail = false;
    const probe = (part, view, p, opts) => {
      const map = probePoses(part, view, p, opts);
      if (fail) for (const name of map.keys()) map.set(name, { trusted: false });
      return map;
    };
    const { skin, viewer, edit } = controller({ probe });
    // Before the drag is live an untrusted entry is an ordinary change: nothing is held.
    fail = true;
    edit({ swing: 19 });
    expect(skin.deform()).toEqual([]);
    expect(skin.holdsInvalid()).toBe(false);
    fail = false;
    edit({ swing: 20 });
    skin.deform();
    expect(viewer.setSubVertices).toHaveBeenCalledTimes(1);
    fail = true;
    edit({ swing: 21 });
    skin.deform();
    expect(viewer.setSubVertices).toHaveBeenCalledTimes(1);
    expect(skin.holdsInvalid()).toBe(true);
    expect(skin.lastValidParams()).toEqual({ swing: 20 });
  });

  test("validityGuard: the inner guard itself with no cage base, else a guard that stops at the last clear pose", () => {
    const { skin } = controller();
    const inner = { settle: vi.fn((from, to) => ({ params: { ...to }, blocked: null })), isClear: vi.fn(() => true), release: vi.fn() };
    const g = skin.validityGuard(inner);
    expect(g).not.toBe(inner);
    expect(g.settle({ swing: 0 }, { swing: 60 }).params).toEqual({ swing: 60 });
    expect(g.settle({ swing: 60 }, { swing: 140 })).toEqual({ params: { swing: 60 }, blocked: null });
    expect(g.isClear({ swing: 60 })).toBe(true);
    expect(g.isClear({ swing: 140 })).toBe(false);
    g.release();
    expect(inner.release).toHaveBeenCalled();
    expect(skin.validityGuard(null)).not.toBeNull();
    skin.forget("body");
    expect(skin.validityGuard(inner)).toBe(inner);
    expect(skin.validityGuard(null)).toBeNull();
  });
});

const SKIN_PAUSE = 150;
