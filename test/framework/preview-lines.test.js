// @vitest-environment happy-dom
// Lines in the cached preview (lines phase 3b, encoder version 8): a declared line's tube
// rides in the GLB as a partforgeLine node, decodes into `lines` (never a sub-part), and
// mountPreview draws it — the file's still tube without the part; with the part, re-solved
// from derive at the preview's params, on every write and every frame of the baked
// animation, so it matches what the live mount draws at the same params.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null }));
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor(options = {}) {
      this.options = options;
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.toneMapping = 0;
      this.toneMappingExposure = 1;
      this.clearAlpha = options.alpha ? 0 : 1;
      this.compileAsync = vi.fn(async () => {});
      state.renderer ??= this;
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
    setClearColor(color, alpha) { if (alpha !== undefined) this.clearAlpha = alpha; }
    getClearAlpha() { return this.clearAlpha; }
    setClearAlpha(a) { this.clearAlpha = a; }
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

// The line scene, real behind a spy.
const scenes = vi.hoisted(() => []);
vi.mock("../../src/framework/line-scene.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createLineScene: vi.fn((viewer, part) => {
      // the group the scene hands the viewer, so a test can read the rope's mesh
      let group = null;
      const add = viewer.addDisplayObject;
      viewer.addDisplayObject = (o, opts) => { group ??= o; return add(o, opts); };
      const s = real.createLineScene(viewer, part);
      const stub = { ...s, group: () => group, update: vi.fn(s.update), draw: vi.fn(s.draw), dispose: vi.fn(s.dispose) };
      scenes.push(stub);
      return stub;
    }),
  };
});

// Pose mode, real unless a test makes its creation throw (a part attach failing midway).
const poseFail = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/framework/pose/pose-mode.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createPoseMode: vi.fn((...args) => {
      if (poseFail.on) throw new Error("pose mode failed");
      return real.createPoseMode(...args);
    }),
  };
});

import { mountPreview } from "../../src/framework/mount-preview.js";
import { encodePreviewGlb, PREVIEW_ENCODER_VERSION } from "../../src/framework/gltf/encode-preview.js";
import { decodePreviewGlb } from "../../src/framework/gltf/decode-preview.js";
import { samplePreviewAnimation } from "../../src/framework/preview-animation.js";
import { resolveDerived } from "../../src/framework/derive.js";
import { lineMeshes, lineReadings } from "../../src/framework/lines/meshes.js";
import { boxSoup, boundsOf } from "../helpers/preview-glb.js";
import capstan from "../../src/parts/capstan-joint.js";

const VIEW = "assembly";
const fixture = (name) => new Uint8Array(readFileSync(fileURLToPath(new NodeURL(`../fixtures/${name}`, import.meta.url))));

// The capstan's two wheels as boxes at its rest placement (the placer moves them by
// matrix from there), and its rope at `params` as exportPreview writes it.
const wheels = () => [boxSoup("drum", [-12, -12, -4], [12, 12, 4]), boxSoup("pulley", [48, -40, -4], [128, 40, 4])];
function ropeAt(params) {
  const [l] = lineMeshes(capstan, VIEW, resolveDerived(capstan, params));
  return { name: l.name, line: l.line, ...l.mesh, triangles: l.mesh.indices.length / 3, edges: new Float32Array(0), display: l.display };
}
const glbAt = (params, extra = {}) => encodePreviewGlb({ meshes: [...wheels(), ropeAt(params)], part: capstan, view: VIEW, params, ...extra });
// The capstan with a baked animation: the motor turns from -120° to 120°.
const animated = {
  ...capstan,
  views: { [VIEW]: { ...capstan.views[VIEW], animations: { turn: { duration: 2, autoplay: true, easing: "linear", tracks: { motorAngle: [[0, -120], [1, 120]] } } } } },
};

function makeStage() {
  const stage = document.createElement("div");
  Object.defineProperties(stage, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  stage.append(viewbar);
  document.body.append(stage);
  return stage;
}
let clockMs = 0;
function runFrames(seconds) {
  const loop = state.renderer.animationLoop;
  for (let i = 0; i <= Math.round(seconds * 10); i++) loop((clockMs += 100));
}
const OriginalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  poseFail.on = false;
  scenes.length = 0;
  state.renderer = null;
  clockMs = 0;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const lengthAt = (part, params) => lineReadings(part, VIEW, resolveDerived(part, params)).get("rope").length;

// --- the file ----------------------------------------------------------------------

test("PREVIEW_ENCODER_VERSION is 8 (a declared line's tube rides in the file)", () => {
  expect(PREVIEW_ENCODER_VERSION).toBe(8);
});

test("a line decodes into `lines`, never into `meshes`, at the file's pose and colour", async () => {
  const rope = ropeAt({ motorAngle: 40 });
  const out = await decodePreviewGlb(await glbAt({ motorAngle: 40 }));
  expect(out.meshes.map((m) => m.name).sort()).toEqual(["drum", "pulley"]);
  expect(out.lines).toHaveLength(1);
  const [l] = out.lines;
  expect(l).toMatchObject({ name: "line:rope", line: "rope", display: { color: rope.display.color } });
  expect(l.mesh.indices.length).toBeGreaterThan(0);
  expect(l.mesh.normals.length).toBe(l.mesh.positions.length);
  const got = boundsOf(l.mesh.positions), want = boundsOf(rope.positions);
  for (let a = 0; a < 3; a++) {
    expect(got.min[a]).toBeCloseTo(want.min[a], 1);
    expect(got.max[a]).toBeCloseTo(want.max[a], 1);
  }
});

test("a line's node carries partforgeLine and its display, and no partforgeSubPart", async () => {
  const glb = await glbAt({ motorAngle: 0 });
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
  const node = json.nodes.find((n) => n.name === "line:rope");
  expect(node.extras).toEqual({ partforgeLine: "rope", partforgeDisplay: { color: ropeAt({ motorAngle: 0 }).display.color } });
});

test("a line may carry no edges or ties, and an animation may not name it", async () => {
  const rope = ropeAt({ motorAngle: 0 });
  await expect(encodePreviewGlb({ meshes: [...wheels(), { ...rope, edges: new Float32Array(6) }] })).rejects.toThrow(/may carry no edges or ties/);
  await expect(encodePreviewGlb({ meshes: [...wheels(), { ...rope, line: "" }] })).rejects.toThrow(/line must be a non-empty string/);
  const animation = samplePreviewAnimation(animated, VIEW, { motorAngle: 0 }, { buildReads: () => new Set() });
  const named = { ...animation, base: { ...animation.base, "line:rope": animation.base.drum } };
  await expect(encodePreviewGlb({ meshes: [...wheels(), rope], animation: named })).rejects.toThrow(/which has no mesh/);
});

test("an older file decodes with no lines", async () => {
  for (const name of ["preview-v1.glb", "preview-v2.glb", "preview-v6.glb", "preview-v6-animated.glb"]) {
    expect((await decodePreviewGlb(fixture(name))).lines).toEqual([]);
  }
});

// --- mountPreview --------------------------------------------------------------------

test("without the part, the preview draws the file's still tube and never re-solves it", async () => {
  const handle = mountPreview(makeStage(), { glb: await glbAt({ motorAngle: 40 }) });
  await handle.ready;
  expect(scenes).toHaveLength(1);
  const [scene] = scenes;
  expect(scene.draw).toHaveBeenCalledTimes(1);
  expect(scene.draw.mock.calls[0][0].map((l) => l.line)).toEqual(["rope"]);
  expect(scene.update).not.toHaveBeenCalled();
  expect([...scene.readings().keys()]).toEqual(["rope"]);
  handle.dispose();
  expect(scene.dispose).toHaveBeenCalled();
});

test("a file with no lines and no part makes no line scene", async () => {
  const handle = mountPreview(makeStage(), { glb: await encodePreviewGlb({ meshes: wheels(), view: VIEW }) });
  await handle.ready;
  expect(scenes).toHaveLength(0);
  handle.dispose();
});

test("with the part, the rope is re-solved at the file's params, as the live mount draws it there", async () => {
  const handle = mountPreview(makeStage(), { glb: await glbAt({ motorAngle: 40 }), part: capstan });
  await handle.ready;
  const [scene] = scenes;
  expect(scene.update).toHaveBeenCalled();
  expect(scene.readings().get("rope").length).toBeCloseTo(lengthAt(capstan, { motorAngle: 40 }), 9);
  handle.dispose();
});

test("with the part, an older file with no line still shows the part's rope", async () => {
  const handle = mountPreview(makeStage(), { glb: await encodePreviewGlb({ meshes: wheels(), part: capstan, view: VIEW, params: { motorAngle: -30 } }), part: capstan });
  await handle.ready;
  const [scene] = scenes;
  expect(scene.readings().get("rope").length).toBeCloseTo(lengthAt(capstan, { motorAngle: -30 }), 9);
  handle.dispose();
});

test("with the part, the rope follows the baked animation frame by frame, and restart puts it back", async () => {
  const opening = { motorAngle: -120 };
  const animation = samplePreviewAnimation(animated, VIEW, { motorAngle: 0 }, { buildReads: () => new Set() });
  expect(animation).not.toBeNull();
  const handle = mountPreview(makeStage(), { glb: await glbAt(opening, { part: animated, animation }), part: animated });
  await handle.ready;
  const [scene] = scenes;
  expect(scene.readings().get("rope").length).toBeCloseTo(lengthAt(animated, opening), 9);
  const calls = scene.update.mock.calls.length;
  runFrames(1);
  expect(scene.update.mock.calls.length).toBeGreaterThan(calls);
  const { t } = handle.animation.state();
  expect(t).toBeGreaterThan(0);
  const angle = -120 + 240 * t;
  expect(scene.readings().get("rope").length).toBeCloseTo(lengthAt(animated, { motorAngle: angle }), 6);
  expect(scene.readings().get("rope").length).not.toBeCloseTo(lengthAt(animated, opening), 3);
  handle.motion.restart();
  expect(scene.readings().get("rope").length).toBeCloseTo(lengthAt(animated, opening), 9);
  handle.dispose();
});

test("a part that does not declare the file's view leaves the file's tube as it is", async () => {
  const other = { ...capstan, views: { other: { label: "Other" } } };
  const handle = mountPreview(makeStage(), { glb: await glbAt({ motorAngle: 10 }), part: other });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await handle.ready;
  const [scene] = scenes;
  expect(scene.update).not.toHaveBeenCalled();
  expect(scene.draw).toHaveBeenCalledTimes(1);
  handle.dispose();
});

test("a part attach that fails midway leaves the file's tube and adds no frame hook", async () => {
  poseFail.on = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const animation = samplePreviewAnimation(animated, VIEW, { motorAngle: 0 }, { buildReads: () => new Set() });
  const handle = mountPreview(makeStage(), { glb: await glbAt({ motorAngle: -120 }, { part: animated, animation }), part: animated });
  await handle.ready;
  expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/preview part ignored/));
  const [scene] = scenes;
  expect(scene.draw).toHaveBeenCalledTimes(1);
  runFrames(1);
  expect(scene.update).not.toHaveBeenCalled();
  handle.dispose();
});

test("with the part, the part's colour replaces the one the file baked", async () => {
  const recoloured = { ...capstan, lines: { rope: { ...capstan.lines.rope, display: { color: 0x123456 } } } };
  const handle = mountPreview(makeStage(), { glb: await glbAt({ motorAngle: 0 }), part: recoloured });
  await handle.ready;
  const [scene] = scenes;
  expect(scene.group().getObjectByName("line:rope").material.color.getHex()).toBe(0x123456);
  handle.dispose();
});

test("a part that shows the view but no longer declares the line hides the file's tube", async () => {
  const lineless = { ...capstan, lines: undefined };
  const handle = mountPreview(makeStage(), { glb: await glbAt({ motorAngle: 0 }), part: lineless });
  await handle.ready;
  expect(scenes).toHaveLength(0);
  handle.dispose();
});
