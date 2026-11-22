// @vitest-environment happy-dom
// The reference compare view: a sub-part and its reference drawn as three
// opaque difference solids (Matches / Missing / Extra) in place of the pair's
// own meshes. The real viewer on a fake renderer (no GL), with the environment
// rig mocked the way viewer-realistic.test.js does it, and the real cutaway.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";

const state = vi.hoisted(() => ({ renderer: null }));
const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.toneMapping = 0;
      this.toneMappingExposure = 1;
      this.autoClear = true;
      this.autoClearColor = true;
      this.shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
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
    clearDepth() {}
    get capabilities() { return { maxTextureSize: 8192, textureTypeReadable: () => true }; }
    setRenderTarget() {}
    getRenderTarget() { return null; }
    getClearAlpha() { return 1; }
    setClearAlpha() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  class FakeTextureLoader {
    load(url, onLoad) { const t = new actual.Texture(); queueMicrotask(() => onLoad?.(t)); return t; }
  }
  return { ...actual, WebGLRenderer: FakeRenderer, TextureLoader: FakeTextureLoader };
});

vi.mock("../src/framework/materials/environment.js", async () => {
  const THREE = await import("three");
  return {
    loadEnvironmentRig: async (_r, id) => ({
      id: id ?? "studio", exposure: 1, envMap: new THREE.Texture(), background: new THREE.Color(0xffffff),
      backgroundBlurriness: 0, backgroundIntensity: 1, rotationY: 0,
      ground: new THREE.Mesh(), lights: [], shadow: { group: new THREE.Group(), render: vi.fn(), setSize: vi.fn(), dispose: vi.fn() },
      setGround: vi.fn(), dispose: vi.fn(), updateForCamera: vi.fn(),
    }),
  };
});

import { createViewer, COMPARE_COLORS } from "../src/framework/viewer.js";
import { raycastViewer } from "../src/framework/selection/raycast.js";
import { resolveSelection } from "../src/framework/selection/resolve.js";
import { formatSelection } from "../src/framework/selection/format.js";

function createContainer() {
  const container = document.createElement("div");
  Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  document.body.appendChild(container);
  return container;
}

// A worker-shaped payload of a box (triangle soup: indices undefined).
function boxPayload(size = 4, at = [0, 0, 0]) {
  const geo = new THREE.BoxGeometry(size, size, size).toNonIndexed();
  geo.translate(...at);
  const positions = new Float32Array(geo.getAttribute("position").array);
  const normals = new Float32Array(geo.getAttribute("normal").array);
  return { positions, normals, indices: undefined, triangles: positions.length / 9, edges: new Float32Array([0, 0, 0, 1, 0, 0]), mm3: size ** 3 };
}

const part = {
  meta: { title: "t" },
  parts: {
    body: { build: () => null, label: "Body" },
    ref: { build: () => null, display: { opacity: 0.4 } },
    other: { build: () => null },
  },
};

function shown() {
  const v = createViewer(createContainer(), part);
  for (const n of Object.keys(part.parts)) v.setSubGeometry(n, boxPayload());
  v.showAssembly(Object.keys(part.parts), { frame: true });
  return v;
}
const pieces = () => ({ common: boxPayload(2), missing: boxPayload(4), excess: boxPayload(1, [3, 0, 0]) });
const materialOf = (v, kind) => v._compareMeshes.find((m) => m.userData.compare === kind).material;

const OriginalGetContext = globalThis.HTMLCanvasElement.prototype.getContext;
const OriginalToDataURL = globalThis.HTMLCanvasElement.prototype.toDataURL;

beforeEach(() => {
  state.renderer = null;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  // happy-dom has no 2D canvas, and renderOffscreen encodes its readback through one.
  globalThis.HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (type !== "2d") return OriginalGetContext.call(this, type, ...rest);
    return { createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }), putImageData: () => {} };
  };
  globalThis.HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,AAAA";
});
afterEach(() => {
  globalThis.HTMLCanvasElement.prototype.getContext = OriginalGetContext;
  globalThis.HTMLCanvasElement.prototype.toDataURL = OriginalToDataURL;
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("setCompare", () => {
  test("draws one opaque mesh per non-null piece, in the compare colours", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: { ...pieces(), excess: null } });
    expect(v._compareMeshes.map((m) => m.userData.compare)).toEqual(["common", "missing"]);
    for (const mesh of v._compareMeshes) {
      expect(mesh.visible).toBe(true);
      expect(mesh.material.transparent).toBe(false);
      expect(mesh.material.opacity).toBe(1);
      expect(mesh.material.color.getHex()).toBe(COMPARE_COLORS[mesh.userData.compare]);
    }
    expect(COMPARE_COLORS).toEqual({ common: 0x9ca3af, missing: 0x3b82f6, excess: 0xec4899 });
    v.dispose();
  });

  test("hides the pair's own meshes and edges, and clearCompare restores them", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    for (const n of ["body", "ref"]) {
      expect(v.__subMesh(n).visible).toBe(false);
      expect(v.__subLines(n).visible).toBe(false);
    }
    expect(v.__subMesh("other").visible).toBe(true);
    expect(v.getCompare()).toEqual({ name: "body", ref: "ref", hidden: { missing: false, excess: false } });
    v.clearCompare();
    expect(v.getCompare()).toBeNull();
    expect(v._compareMeshes).toEqual([]);
    for (const n of ["body", "ref"]) {
      expect(v.__subMesh(n).visible).toBe(true);
      expect(v.__subLines(n).visible).toBe(true);
    }
    v.dispose();
  });

  test("getCompare is null when nothing is set", () => {
    const v = shown();
    expect(v.getCompare()).toBeNull();
    v.dispose();
  });

  test("clearCompare disposes the pieces' geometries and materials", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    const meshes = [...v._compareMeshes];
    const spies = meshes.flatMap((m) => [vi.spyOn(m.geometry, "dispose"), vi.spyOn(m.material, "dispose")]);
    v.clearCompare();
    for (const s of spies) expect(s).toHaveBeenCalled();
    v.dispose();
  });

  test("viewer dispose frees a comparison still standing", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    const spy = vi.spyOn(v._compareMeshes[0].geometry, "dispose");
    v.dispose();
    expect(spy).toHaveBeenCalled();
  });

  test("a view that drops either sub-part of the pair ends the comparison", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    v.showAssembly(["body", "ref", "other"]); // a regen of the same view keeps it
    expect(v.getCompare()).not.toBeNull();
    v.showAssembly(["body", "other"]);
    expect(v.getCompare()).toBeNull();
    v.dispose();
  });
});

describe("setCompareHidden", () => {
  test("hides that piece only, and is reported by getCompare", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    v.setCompareHidden("missing", true);
    const vis = Object.fromEntries(v._compareMeshes.map((m) => [m.userData.compare, m.visible]));
    expect(vis).toEqual({ common: true, missing: false, excess: true });
    expect(v.getCompare().hidden).toEqual({ missing: true, excess: false });
    v.setCompareHidden("missing", false);
    expect(v._compareMeshes.every((m) => m.visible)).toBe(true);
    v.dispose();
  });
});

describe("always opaque", () => {
  test("a user see-through override on either sub-part leaves the pieces opaque", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    v.setSubPartDisplay("body", { opacity: 0.3 });
    v.setSubPartDisplay("ref", { opacity: 0.3 });
    v.setSubPartOpacity("body", 0.5); // an animation / rebuild fade too
    for (const mesh of v._compareMeshes) {
      expect(mesh.material.transparent).toBe(false);
      expect(mesh.material.opacity).toBe(1);
      expect(mesh.visible).toBe(true);
    }
    expect(v.__subMesh("body").visible).toBe(false);
    v.dispose();
  });

  test("realistic and cel keep the flat colours, opaque", async () => {
    const v = shown();
    v.setSubPartDisplay("body", { material: "brass" });
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    for (const mode of ["realistic", "cel", "cad"]) {
      expect(await v.setRenderMode(mode)).toBe(mode);
      for (const kind of ["common", "missing", "excess"]) {
        const m = materialOf(v, kind);
        expect(m.color.getHex()).toBe(COMPARE_COLORS[kind]);
        expect(m.transparent).toBe(false);
        expect(m.opacity).toBe(1);
        expect(m.map ?? null).toBeNull();
      }
    }
    v.dispose();
  });
});

describe("cutaway", () => {
  test("each shown piece is its own section, clipped and capped in its colour, gone after clearCompare", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: { ...pieces(), excess: null } });
    v.setCompareHidden("missing", true);
    expect(v.setCutawayEnabled(true)).toBe(true);
    const common = v.__compareSection("common");
    expect(common).not.toBeNull();
    expect(common.cap.visible).toBe(true);
    expect(common.back.visible && common.front.visible).toBe(true);
    expect(common.cap.material.uniforms.uBase.value.getHex()).toBe(COMPARE_COLORS.common);
    expect(materialOf(v, "common").clippingPlanes?.length).toBeGreaterThan(0);
    // A hidden piece is not sectioned; showing it brings its cap back.
    expect(v.__compareSection("missing").cap.visible).toBe(false);
    v.setCompareHidden("missing", false);
    expect(v.__compareSection("missing").cap.visible).toBe(true);
    expect(v.__compareSection("excess")).toBeNull(); // a null piece has no section
    // The hidden pair is out of the cutaway's set: no cap of its own draws.
    expect(v.__subMesh("body").children.every((c) => !c.visible)).toBe(true);
    const cap = common.cap;
    v.clearCompare();
    expect(v.__compareSection("common")).toBeNull();
    expect(v.__compareSection("missing")).toBeNull();
    expect(cap.parent).toBeNull();
    expect(v.__subMesh("body").material.clippingPlanes?.length).toBeGreaterThan(0); // the pair is sectioned again
    v.setCutawayEnabled(false);
    v.dispose();
  });

  test("a mode switch with the cutaway on keeps the pieces clipped and in their colours", async () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    expect(v.setCutawayEnabled(true)).toBe(true);
    for (const mode of ["cel", "realistic", "cad"]) {
      await v.setRenderMode(mode);
      for (const kind of ["common", "missing", "excess"]) {
        const m = materialOf(v, kind);
        expect(m.clippingPlanes?.length).toBeGreaterThan(0);
        expect(m.color.getHex()).toBe(COMPARE_COLORS[kind]);
        expect(v.__compareSection(kind).cap.material.uniforms.uBase.value.getHex()).toBe(COMPARE_COLORS[kind]);
      }
    }
    v.setCutawayEnabled(false);
    v.dispose();
  });
});

describe("bounds and framing", () => {
  test("the reframe button and the cutaway still count the pair while a comparison hides it", () => {
    const v = createViewer(createContainer(), part);
    v.setSubGeometry("body", boxPayload(4));
    v.setSubGeometry("ref", boxPayload(4, [20, 0, 0]));
    v.setSubGeometry("other", boxPayload(1));
    v.showAssembly(["body", "ref"], { frame: true });
    const framed = v.camera.position.clone();
    v.setCompare({ name: "body", ref: "ref", pieces: { common: boxPayload(1), missing: null, excess: null } });
    v.camera.position.multiplyScalar(5);
    v.frame();
    expect(v.camera.position.distanceTo(framed)).toBeLessThan(1e-6);
    // The cutaway seeds its plane from the visible bounds: enabling it works.
    expect(v.setCutawayEnabled(true)).toBe(true);
    v.setCutawayEnabled(false);
    v.dispose();
  });
});

describe("pick", () => {
  test("a hit on the missing piece reports the PART sub-part with compare: missing", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: { common: null, missing: boxPayload(4), excess: null } });
    v.showAssembly(["body", "ref"], { frame: true });
    v.domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
    // No real render runs here, so bring the world matrices up to date the way one would.
    let root = v._compareMeshes[0];
    while (root.parent) root = root.parent;
    root.updateMatrixWorld(true);
    v.camera.updateMatrixWorld(true);
    const hit = raycastViewer(v, 200, 150);
    expect(hit).not.toBeNull();
    expect(hit.subPart).toBe("body");
    expect(hit.compare).toBe("missing");
    const selection = resolveSelection(part, { params: {} }, hit);
    expect(selection.subPart).toBe("body");
    expect(selection.compare).toBe("missing");
    expect(formatSelection(selection, { style: "prompt" })).toMatch(/material missing from \*\*Body\*\*, near \[/);
    v.dispose();
  });
});

// What each offscreen render (a capture) drew: the pieces' and the pair's visibility.
function recordAtCapture(v) {
  const seen = [];
  let target = null;
  const setRenderTarget = state.renderer.setRenderTarget.bind(state.renderer);
  state.renderer.setRenderTarget = (t) => { target = t; setRenderTarget(t); };
  const render = state.renderer.render.bind(state.renderer);
  state.renderer.render = (scene, camera) => { if (target) seen.push(snapshot(v)); render(scene, camera); };
  return seen;
}
function snapshot(v) {
  return {
    pieces: Object.fromEntries(v._compareMeshes.map((m) => [m.userData.compare, m.visible])),
    body: v.__subMesh("body").visible,
    ref: v.__subMesh("ref").visible,
    bodyLines: v.__subLines("body").visible,
  };
}

describe("setCompareShown", () => {
  test("held off screen: the pair draws as before, the pieces not; on again shows them", () => {
    const v = shown();
    v.setCompareShown(false);
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    expect(v.getCompare()).not.toBeNull();
    expect(snapshot(v)).toEqual({ pieces: { common: false, missing: false, excess: false }, body: true, ref: true, bodyLines: true });
    v.setCompareShown(true);
    expect(snapshot(v)).toEqual({ pieces: { common: true, missing: true, excess: true }, body: false, ref: false, bodyLines: false });
    v.setCompareHidden("missing", true);
    v.setCompareShown(false);
    v.setCompareShown(true);
    expect(snapshot(v).pieces).toEqual({ common: true, missing: false, excess: true });
    v.dispose();
  });

  test("held off screen, the pair is the cutaway's section and the pieces are not", () => {
    const v = shown();
    v.setCompareShown(false);
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    expect(v.setCutawayEnabled(true)).toBe(true);
    expect(v.__compareSection("common").cap.visible).toBe(false);
    expect(v.__subMesh("body").material.clippingPlanes?.length).toBeGreaterThan(0);
    v.setCompareShown(true);
    expect(v.__compareSection("common").cap.visible).toBe(true);
    v.setCutawayEnabled(false);
    v.dispose();
  });
});

describe("captures draw the comparison", () => {
  const forced = { pieces: { common: true, missing: true, excess: true }, body: false, ref: false, bodyLines: false };

  test("captureCanonicalViews draws all three pieces with the toggle off and a piece hidden, then puts the screen back", () => {
    const v = shown();
    v.setCompareShown(false);
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    v.setCompareHidden("missing", true);
    const before = snapshot(v);
    const seen = recordAtCapture(v);
    expect(v.captureCanonicalViews(["iso", "front"])).toHaveLength(2);
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s).toEqual(forced);
    expect(snapshot(v)).toEqual(before);
    expect(v.getCompare().hidden).toEqual({ missing: true, excess: false });
    v.dispose();
  });

  test("captureCurrent with includeHidden (build sight) draws them too; without, it is what the user sees", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    v.setCompareHidden("excess", true);
    const seen = recordAtCapture(v);
    expect(v.captureCurrent({ size: 512, includeHidden: true })).toMatch(/^data:image/);
    expect(seen.at(-1)).toEqual(forced);
    v.captureCurrent({ size: 512 });
    expect(seen.at(-1).pieces).toEqual({ common: true, missing: true, excess: false });
    v.setCompareShown(false);
    v.captureCurrent({ size: 512 });
    expect(seen.at(-1)).toEqual({ pieces: { common: false, missing: false, excess: false }, body: true, ref: true, bodyLines: true });
    v.dispose();
  });

  test("a user see-through on a pair member does not bring it back into the capture", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    v.setSubPartDisplay("body", { opacity: 0.3 });
    v.setSubPartDisplay("ref", { hidden: false, opacity: 0.5 });
    const seen = recordAtCapture(v);
    v.captureCanonicalViews(["iso"]);
    v.captureCurrent({ size: 512, includeHidden: true });
    for (const s of seen) expect(s).toEqual(forced);
    expect(v.__subMesh("body").visible).toBe(false);
    v.dispose();
  });

  test("a capture that throws mid-pass still puts the on-screen compare state back exactly", () => {
    const v = shown();
    v.setCompareShown(false);
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    v.setCompareHidden("missing", true);
    const before = snapshot(v);
    const seen = [];
    state.renderer.render = () => { seen.push(snapshot(v)); throw new Error("render failed"); };
    expect(() => v.captureCanonicalViews(["iso"])).toThrow("render failed");
    expect(seen[0]).toEqual(forced); // it was forced when it threw
    expect(snapshot(v)).toEqual(before);
    expect(v.getCompare().hidden).toEqual({ missing: true, excess: false });
    v.setCompareShown(true);
    expect(snapshot(v).pieces).toEqual({ common: true, missing: false, excess: true });
    v.dispose();
  });

  test("the legend is DOM chrome: no capture reads it", () => {
    const v = shown();
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    const legend = document.createElement("div");
    legend.className = "pf-viewbar-readout pf-compare-legend";
    for (const key of ["hidden", "children", "textContent", "innerHTML", "getBoundingClientRect"]) {
      Object.defineProperty(legend, key, { get() { throw new Error(`capture read the legend's ${key}`); } });
    }
    v.domElement.parentElement.append(legend);
    expect(v.captureCanonicalViews(["iso"])).toHaveLength(1);
    expect(v.captureCurrent({ size: 512, includeHidden: true })).toMatch(/^data:image/);
    v.dispose();
  });

  test("the thumbnail scene (captureView / captureDefault) is its own: no pieces, the live state untouched", () => {
    const v = shown();
    v.setCompareShown(false);
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    const before = snapshot(v);
    const scenes = [];
    const render = state.renderer.render.bind(state.renderer);
    state.renderer.render = (scene, camera) => { scenes.push(scene); render(scene, camera); };
    expect(v.renderMeshPayloads([{ name: "body", ...boxPayload() }])).toMatch(/^data:image/);
    let pieceDrawn = false;
    for (const sc of scenes) sc.traverse((o) => { if (o.userData?.compare) pieceDrawn = true; });
    expect(pieceDrawn).toBe(false);
    expect(snapshot(v)).toEqual(before);
    v.dispose();
  });

  test("with no result held, a capture draws the part and its ghost as today", () => {
    const v = shown();
    const seen = recordAtCapture(v);
    v.captureCanonicalViews(["iso"]);
    expect(seen[0]).toEqual({ pieces: {}, body: true, ref: true, bodyLines: true });
    v.dispose();
  });

  test("a borrowed look (realistic live view) keeps the forced pieces for the capture", async () => {
    const v = shown();
    v.setCompareShown(false);
    v.setCompare({ name: "body", ref: "ref", pieces: pieces() });
    expect(await v.setRenderMode("realistic")).toBe("realistic");
    const seen = recordAtCapture(v);
    v.captureCanonicalViews(["iso"]);
    expect(seen.at(-1)).toEqual(forced);
    expect(snapshot(v).body).toBe(true);
    expect(snapshot(v).pieces.common).toBe(false);
    v.dispose();
  });
});
