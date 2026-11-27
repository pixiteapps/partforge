// @vitest-environment happy-dom
// Mount's half of drawing declared lines (framework/line-scene.js): a part with a `lines` block
// gets a line scene, updated from the change's own (memoized) derive, so a param change
// costs no extra derive; a part with none gets no scene and never reaches lineMeshes. The
// viewer is faked (mount-cage-drag.test.js's fake); the meshes are real (handle(...)).
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
      displayObjects: [],
      addDisplayObject: vi.fn((o) => { v.displayObjects.push(o); return vi.fn(); }),
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
      projectPoint: () => ({ x: 0, y: 0, visible: true }), // the release chip places itself by it
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


// The line scene, real behind a spy: its update is counted.
const scenes = vi.hoisted(() => []);
vi.mock("../src/framework/line-scene.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createLineScene: vi.fn((viewer, part) => {
      const s = real.createLineScene(viewer, part);
      const stub = { ...s, update: vi.fn(s.update), dispose: vi.fn(s.dispose) };
      scenes.push(stub);
      return stub;
    }),
  };
});
// Pose mode, real behind a spy: the options mount hands it, and its onDragEnd listeners.
const poseModes = vi.hoisted(() => []);
vi.mock("../src/framework/pose/pose-mode.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createPoseMode: vi.fn((viewer, opts) => {
      const mode = real.createPoseMode(viewer, opts);
      const ends = new Set();
      const rec = { opts, ends };
      poseModes.push(rec);
      return { ...mode, onDragEnd: (cb) => { ends.add(cb); const off = mode.onDragEnd(cb); return () => { ends.delete(cb); off(); }; } };
    }),
  };
});
vi.mock("../src/framework/lines/meshes.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, lineMeshes: vi.fn(real.lineMeshes) };
});

import * as THREE from "three";
import { mount } from "../src/framework/mount.js";
import { viewSubParts } from "../src/framework/part-model.js";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { createLineScene, LINE_LIMIT_COLOR } from "../src/framework/line-scene.js";
import { lineMeshes } from "../src/framework/lines/meshes.js";
import { decodePreviewGlb } from "../src/framework/gltf/decode-preview.js";
import { resolveDerived } from "../src/framework/derive.js";
import { concentricCapstan, slackCapstan } from "./fixtures/capstan-fixtures.js";
import demo from "../src/parts/demo.js";

const withBackend = (part) => ({ ...part, meta: { ...part.meta, backend: "manifold" } });
const capstanPart = () => withBackend(concentricCapstan);

let k;
beforeAll(async () => { k = await bootManifoldKernel({ quality: "preview" }); }, 120_000);
const gen = async (part, view, params) => {
  const post = vi.fn();
  const subparts = viewSubParts(part, view, params);
  await handle(k, part, { type: "generate", subparts, view, params }, post);
  const msgs = post.mock.calls.map(([m]) => m);
  const err = msgs.find((m) => m.type === "error");
  if (err) throw new Error(err.message ?? JSON.stringify(err));
  return msgs.find((m) => m.type === "meshes").meshes;
};

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

async function setup(part, view) {
  vi.useRealTimers();
  const meshes = await gen(part, view, { ...part.defaults });
  vi.useFakeTimers();
  const workers = {};
  const createWorker = (name) => (workers[name] = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null });
  const runtime = mount(part, { createWorker, elements: makeElements() });
  const v = fakeViewers.at(-1);
  // The scene hands its group over as a display object; parent it, as the viewer does under partsGroup.
  const parts = new THREE.Group();
  for (const o of v.displayObjects) parts.add(o);
  const w = workers.manifold;
  w.onmessage({ data: { type: "ready" } });
  w.onmessage({ data: { type: "meshes", meshes, ms: 5 } });
  return { runtime, v, w, parts };
}

beforeEach(() => {
  scenes.length = 0;
  poseModes.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
  fakeViewers.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

// derive calls for one setParams on `part`, after the first build is shown.
async function deriveCountForChange(part) {
  const derive = vi.fn(part.derive);
  const { runtime } = await setup({ ...part, derive }, "assembly");
  derive.mockClear();
  runtime.setParams({ motorAngle: 30 });
  const n = derive.mock.calls.length;
  runtime.dispose();
  return n;
}

describe("mount draws a part's declared lines", () => {
  test("a part with lines gets a line scene, updated once per change from the change's own derive", async () => {
    const { runtime } = await setup(capstanPart(), "assembly");
    expect(createLineScene).toHaveBeenCalledTimes(1);
    const [scene] = scenes;
    // the first show drew the view's lines
    expect(scene.update).toHaveBeenCalled();
    expect(scene.update.mock.calls.at(-1)[0]).toBe("assembly");

    scene.update.mockClear();
    runtime.setParams({ motorAngle: 30 });
    expect(scene.update).toHaveBeenCalledTimes(1);
    const [view, d] = scene.update.mock.calls[0];
    expect(view).toBe("assembly");
    expect(d.drive.angleOf("drum")).toBeCloseTo(30, 6);

    runtime.dispose();
    expect(scene.dispose).toHaveBeenCalled();
  });

  test("drawing the lines costs a change no extra derive", async () => {
    const withLines = await deriveCountForChange(capstanPart());
    const without = await deriveCountForChange({ ...capstanPart(), lines: undefined });
    expect(withLines).toBeGreaterThan(0);
    expect(withLines).toBe(without);
  });

  test("a view switch waiting for its builds hides the last view's rope; the new view's first show brings it back", async () => {
    // "other" shows a spare block as well, so switching to it must wait for that build.
    const part = withBackend({
      ...concentricCapstan,
      parts: {
        ...concentricCapstan.parts,
        spare: { label: "Spare", build: (k) => k.box({ min: [0, 50, 0], max: [5, 55, 5] }), views: ["other"] },
      },
      views: { assembly: { label: "Assembly" }, other: { label: "Other" } },
    });
    const { runtime, w, parts } = await setup(part, "assembly");
    const rope = () => parts.getObjectByName("line:rope");
    expect(rope().visible).toBe(true);

    runtime.setView("other");
    expect(runtime.getView()).toBe("other");
    expect(rope().visible).toBe(false);
    // a param change while the view waits draws nothing either
    runtime.setParams({ motorAngle: 20 });
    expect(rope().visible).toBe(false);

    vi.useRealTimers();
    const meshes = await gen(part, "other", { ...part.defaults, motorAngle: 20 });
    vi.useFakeTimers();
    // The switch's job (at motorAngle 0) answers stale, since the edit outdated it; the
    // re-kicked job at 20 answers fresh.
    vi.advanceTimersByTime(1000);
    w.onmessage({ data: { type: "meshes", meshes, ms: 5 } });
    vi.advanceTimersByTime(1000);
    expect(rope().visible).toBe(false);
    w.onmessage({ data: { type: "meshes", meshes, ms: 5 } });
    expect(rope().visible).toBe(true);
    runtime.dispose();
  });

  // The slack drive with a handle on the drum and the rope's drift gated under 0.2 mm.
  const posedSlack = (extra = {}) => withBackend({
    ...slackCapstan,
    handles: { drum: { on: "drive", at: "drum.rim", params: ["motorAngle"], drag: "rotary" } },
    verify: { expect: { _view: { lineDrift: "<=0.2" } } },
    ...extra,
  });

  test("a drag's readout carries the rope's length and drift; past the bound it is tinted until the drag ends", async () => {
    const part = posedSlack();
    const derive = vi.fn(part.derive);
    const { runtime, parts } = await setup({ ...part, derive }, "assembly");
    const [{ opts, ends }] = poseModes;
    expect(typeof opts.extraReadout).toBe("function");
    const rope = () => parts.getObjectByName("line:rope");
    const press = { ...part.defaults };
    const at0 = slackCapstan.derive(press).drive.lineInfo().lines.rope.length;

    // the drag's first frame: the lines at the press are read once, from one derive
    runtime.setParams({ motorAngle: 90 });
    derive.mockClear();
    const items = opts.extraReadout({ ...press, motorAngle: 90 }, press);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive.mock.calls[0][0]).toMatchObject({ motorAngle: 0 });
    const at90 = slackCapstan.derive({ motorAngle: 90 }).drive.lineInfo().lines.rope.length;
    expect(Math.abs(at90 - at0)).toBeGreaterThan(0.2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "line:rope", label: "rope", unit: "mm" });
    expect(items[0].value).toBeCloseTo(at90, 9);
    expect(rope().material.color.getHex()).toBe(LINE_LIMIT_COLOR);

    // a later frame of the same drag derives nothing more for the press
    runtime.setParams({ motorAngle: 1 });
    derive.mockClear();
    opts.extraReadout({ ...press, motorAngle: 1 }, press);
    expect(derive).not.toHaveBeenCalled();
    expect(rope().material.color.getHex()).not.toBe(LINE_LIMIT_COLOR);

    runtime.setParams({ motorAngle: 90 });
    opts.extraReadout({ ...press, motorAngle: 90 }, press);
    expect(rope().material.color.getHex()).toBe(LINE_LIMIT_COLOR);
    for (const cb of ends) cb({ handleId: "drum", generic: true, changed: ["motorAngle"], pinHeld: false, blocked: null });
    expect(rope().material.color.getHex()).not.toBe(LINE_LIMIT_COLOR);
    runtime.dispose();
  });

  test("with no lineDrift bound the readout shows and nothing is tinted", async () => {
    const { runtime, parts } = await setup(posedSlack({ verify: undefined }), "assembly");
    const [{ opts }] = poseModes;
    runtime.setParams({ motorAngle: 90 });
    expect(opts.extraReadout({ motorAngle: 90 }, { motorAngle: 0 })).toHaveLength(1);
    expect(parts.getObjectByName("line:rope").material.color.getHex()).not.toBe(LINE_LIMIT_COLOR);
    runtime.dispose();
  });

  test("a posed part with no lines passes pose mode no extraReadout", async () => {
    const { runtime } = await setup(posedSlack({ lines: undefined }), "assembly");
    expect(poseModes).toHaveLength(1);
    expect(poseModes[0].opts.extraReadout).toBeUndefined();
    runtime.dispose();
  });

  test("exportPreview writes the view's rope as a line node at the file's params", async () => {
    const part = capstanPart();
    const { runtime } = await setup(part, "assembly");
    const glb = await runtime.exportPreview();
    const decoded = await decodePreviewGlb(glb);
    expect(decoded.meshes.map((m) => m.name)).not.toContain("line:rope");
    expect(decoded.lines.map((l) => l.name)).toEqual(["line:rope"]);
    const [want] = lineMeshes(part, "assembly", resolveDerived(part, { ...part.defaults, ...decoded.params }));
    expect(decoded.lines[0].mesh.positions.length).toBeGreaterThan(0);
    expect(decoded.lines[0].display).toEqual(want.display);
    runtime.dispose();
  });

  test("a part with no lines creates no line scene and never reaches lineMeshes", async () => {
    lineMeshes.mockImplementation(() => { throw new Error("lineMeshes must not be called"); });
    const part = withBackend(demo);
    const { runtime } = await setup(part, Object.keys(part.views)[0]);
    runtime.setParams({ ...part.defaults });
    expect(createLineScene).not.toHaveBeenCalled();
    expect(lineMeshes).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
