// @vitest-environment happy-dom
// Pose mode's pointer loop against a fake viewer that keeps the real frame stack: a
// pivot turned -90° about X with the parts group under it, so a part point must go
// through the parts frame to land under the pointer (and a ray back through it).
import { describe, it, expect, afterEach } from "vitest";
import * as THREE from "three";
import { createPoseMode, aimAxes } from "../src/framework/pose/pose-mode.js";
import { limbInfo } from "../src/framework/pose/param-solve.js";
import hand from "./fixtures/ik-hand-fixture.js";

const W = 400, H = 400;

function fakeViewer() {
  const scene = new THREE.Scene();
  const pivot = new THREE.Group();
  pivot.rotation.x = -Math.PI / 2;
  scene.add(pivot);
  const partsGroup = new THREE.Group();
  partsGroup.position.set(0, 0, -80); // a per-view recentring
  pivot.add(partsGroup);
  const palm = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  partsGroup.add(palm);
  const camera = new THREE.PerspectiveCamera(45, W / H, 1, 5000);
  camera.position.set(0, 0, 400);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  scene.updateMatrixWorld(true);
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 });
  Object.defineProperty(canvas, "clientHeight", { value: H });
  Object.defineProperty(canvas, "clientWidth", { value: W });
  document.body.append(canvas);
  const frames = [];
  return {
    camera,
    domElement: canvas,
    _subMeshes: { palm },
    partsGroup,
    projectPoint(world) {
      const v = new THREE.Vector3(...world).project(camera);
      return { x: (v.x * 0.5 + 0.5) * W, y: (0.5 - v.y * 0.5) * H, visible: true };
    },
    onFrame(cb) { frames.push(cb); return () => {}; },
    tick() { for (const f of frames) f(); },
    onThemeChange: () => () => {},
    getTheme: () => "dark",
    requestRender() {},
  };
}

function fakeScene() {
  const calls = { setLimbs: [], setHover: [], setActive: [], setPins: [], setAimRings: [] };
  return {
    calls,
    setLimbs: (x) => calls.setLimbs.push(x),
    setHover: (x) => calls.setHover.push(x),
    setActive: (x) => calls.setActive.push(x),
    setPins: (x) => calls.setPins.push(x),
    setAimRings: (x) => calls.setAimRings.push(x),
    setTheme() {}, tick() {}, clear() {}, dispose() {},
  };
}

const live = [];
function setup() {
  const viewer = fakeViewer();
  const scene = fakeScene();
  const orbit = { enabled: true };
  const params = { ...hand.defaults };
  const log = { write: [], commit: [], hold: [], restore: [] };
  const mode = createPoseMode(viewer, {
    part: hand,
    orbitControls: orbit,
    getParams: () => params,
    write: (v) => { log.write.push({ ...v }); Object.assign(params, v); },
    commit: (keys) => log.commit.push(keys),
    restore: (v) => { log.restore.push(v); Object.assign(params, v); },
    staleSubParts: () => [],
    ghost() {}, unghost() {},
    hold: (on) => log.hold.push(on),
    schedule: (cb) => cb(),
    createScene: () => scene,
  });
  live.push(mode);
  const screenOf = (p) => {
    const w = new THREE.Vector3(...p).applyMatrix4(viewer.partsGroup.matrixWorld);
    return viewer.projectPoint(w.toArray());
  };
  const tipScreen = (limb) => screenOf(limbInfo(hand, params, hand.handles[limb]).points.tip);
  const fire = (type, x, y, extra = {}) => viewer.domElement.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "mouse", bubbles: true, ...extra,
  }));
  return { viewer, scene, orbit, params, log, mode, fire, tipScreen };
}

afterEach(() => { for (const m of live.splice(0)) m.detach(); document.body.innerHTML = ""; });

describe("createPoseMode", () => {
  it("dragging a fingertip yields orbit, writes per frame, and commits once on release", () => {
    const t = setup();
    t.mode.setEnabled(true);
    expect(t.scene.calls.setLimbs.at(-1).map((i) => i.name).sort()).toEqual(["a", "b"]);
    const s = t.tipScreen("a");
    expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(W);
    t.fire("pointerdown", s.x + 5, s.y); // inside the generous target, off the dot
    expect(t.orbit.enabled).toBe(false);
    expect(t.log.hold).toEqual([]); // a press is not yet a drag
    for (let i = 1; i <= 6; i++) t.fire("pointermove", s.x + 5, s.y - i * 6);
    expect(t.mode.isDragging()).toBe(true);
    expect(t.log.write.length).toBeGreaterThanOrEqual(5);
    expect(t.log.hold).toEqual([true]);
    t.fire("pointerup", s.x + 5, s.y - 36);
    expect(t.orbit.enabled).toBe(true);
    expect(t.log.hold).toEqual([true, false]);
    expect(t.log.commit).toHaveLength(1);
    for (const k of t.log.commit[0]) expect(hand.handles.a.params).toContain(k);
    expect(t.scene.calls.setActive.at(-1)).toBeNull();
    // the dragged tip moved up the screen, toward the cursor
    expect(t.tipScreen("a").y).toBeLessThan(s.y - 5);
  });

  it("the first drag frame does not jump the grabbed point to the cursor", () => {
    const t = setup();
    t.mode.setEnabled(true);
    const s = t.tipScreen("a");
    t.fire("pointerdown", s.x + 10, s.y);
    t.fire("pointermove", s.x + 10, s.y - 5); // just past the threshold
    const active = t.scene.calls.setActive.at(-1);
    const after = t.tipScreen("a");
    expect(Math.hypot(after.x - s.x, after.y - s.y)).toBeLessThan(7);
    expect(active.limb).toBe("a");
    expect(active.grab).toBe("tip");
    expect(active.clamped).toHaveLength(3);
  });

  it("a click on a tip pins it; no hold, write or commit", () => {
    const t = setup();
    t.mode.setEnabled(true);
    const s = t.tipScreen("b");
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.getPins()).toEqual(["b:tip"]);
    expect(t.scene.calls.setPins.at(-1)).toEqual(["b"]);
    expect(t.log.hold).toEqual([]);
    expect(t.log.write).toEqual([]);
    expect(t.orbit.enabled).toBe(true);
    t.mode.releasePins();
    expect(t.mode.pinCount()).toBe(0);
  });

  it("a press off every handle leaves orbit alone", () => {
    const t = setup();
    t.mode.setEnabled(true);
    t.fire("pointerdown", 5, 5);
    expect(t.orbit.enabled).toBe(true);
  });

  it("Escape mid-drag reverts the drag with no commit", () => {
    const t = setup();
    t.mode.setEnabled(true);
    const before = { ...t.params };
    const s = t.tipScreen("a");
    t.fire("pointerdown", s.x, s.y);
    for (let i = 1; i <= 3; i++) t.fire("pointermove", s.x, s.y - i * 10);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(t.params).toEqual(before);
    expect(t.log.commit).toHaveLength(0);
    expect(t.log.hold).toEqual([true, false]);
    expect(t.orbit.enabled).toBe(true);
    expect(t.mode.isDragging()).toBe(false);
  });

  for (const [name, end] of [
    ["pointercancel", (t, s) => t.fire("pointercancel", s.x, s.y - 30)],
    ["lostpointercapture", (t, s) => t.fire("lostpointercapture", s.x, s.y - 30)],
    ["window blur", () => window.dispatchEvent(new Event("blur"))],
  ]) {
    it(`${name} mid-drag reverts the drag with no commit and gives orbit back`, () => {
      const t = setup();
      t.mode.setEnabled(true);
      const before = { ...t.params };
      const s = t.tipScreen("a");
      t.fire("pointerdown", s.x, s.y);
      for (let i = 1; i <= 3; i++) t.fire("pointermove", s.x, s.y - i * 10);
      expect(t.mode.isDragging()).toBe(true);
      expect(t.orbit.enabled).toBe(false);
      end(t, s);
      expect(t.params).toEqual(before);
      expect(t.log.commit).toHaveLength(0);
      expect(t.log.hold).toEqual([true, false]);
      expect(t.orbit.enabled).toBe(true);
      expect(t.mode.isDragging()).toBe(false);
      t.fire("pointerup", s.x, s.y - 30); // a late up after the revert commits nothing
      expect(t.log.commit).toHaveLength(0);
    });
  }

  it("externalWrite mid-drag reverts and ends the press", () => {
    const t = setup();
    t.mode.setEnabled(true);
    const s = t.tipScreen("a");
    t.fire("pointerdown", s.x, s.y);
    for (let i = 1; i <= 3; i++) t.fire("pointermove", s.x, s.y - i * 10);
    t.mode.externalWrite();
    expect(t.orbit.enabled).toBe(true);
    expect(t.mode.isDragging()).toBe(false);
    t.fire("pointerup", s.x, s.y - 30);
    expect(t.log.commit).toHaveLength(0);
  });

  it("outside param edits re-read the limbs on the next frame", () => {
    const t = setup();
    t.mode.setEnabled(true);
    const n = t.scene.calls.setLimbs.length;
    t.viewer.tick();
    expect(t.scene.calls.setLimbs).toHaveLength(n);
    t.params.aCurl = 0.6;
    t.viewer.tick();
    expect(t.scene.calls.setLimbs).toHaveLength(n + 1);
  });
});

describe("aimAxes", () => {
  it("follows aimFromAngles: pitch about aim x up, yaw about +Z, roll about the aim", () => {
    const info = { joints: [{ name: "j" }], points: { j: [0, 0, 0], tip: [10, 0, 0] } };
    const [pitch, yaw, roll] = aimAxes(info, 3);
    expect(pitch.map((v) => v + 0)).toEqual([0, -1, 0]);
    expect(yaw).toEqual([0, 0, 1]);
    expect(roll).toEqual([1, 0, 0]);
    expect(aimAxes(info, 2)).toHaveLength(2);
  });
});
