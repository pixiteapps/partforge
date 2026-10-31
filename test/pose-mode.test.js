// @vitest-environment happy-dom
// Pose mode's pointer loop against a fake viewer that keeps the real frame stack: a
// pivot turned -90° about X with the parts group under it, so a part point must go
// through the parts frame to land under the pointer (and a ray back through it).
import { describe, it, expect, afterEach } from "vitest";
import * as THREE from "three";
import { createPoseMode, aimAxes } from "../src/framework/pose/pose-mode.js";
import { limbInfo } from "../src/framework/pose/param-solve.js";
import { aimFromAngles } from "../src/framework/domains/kinematics/goals.js";
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
    setHover: (limb, dot = null) => calls.setHover.push([limb, dot]),
    cleared: 0,
    setActive: (x) => calls.setActive.push(x),
    setPins: (x) => calls.setPins.push(x),
    setAimRings: (x) => calls.setAimRings.push(x),
    setTheme() {}, tick() {}, dispose() {},
    clear() { this.cleared++; },
  };
}

const live = [];
function setup(part = hand) {
  const viewer = fakeViewer();
  const scene = fakeScene();
  const orbit = { enabled: true };
  const params = { ...part.defaults };
  const log = { write: [], commit: [], hold: [], restore: [] };
  const mode = createPoseMode(viewer, {
    part,
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
  const info = (limb) => limbInfo(part, params, part.handles[limb]);
  const tipScreen = (limb) => screenOf(info(limb).points.tip);
  const pointScreen = (limb, at) => screenOf(info(limb).points[at]);
  const fire = (type, x, y, extra = {}) => viewer.domElement.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "mouse", bubbles: true, ...extra,
  }));
  return { viewer, scene, orbit, params, log, mode, fire, tipScreen, pointScreen };
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

  it("outside param edits re-read the limbs per frame only while something is drawn", () => {
    const t = setup();
    const n = t.scene.calls.setLimbs.length;
    t.viewer.tick();
    expect(t.scene.calls.setLimbs).toHaveLength(n);
    // at rest (nothing hovered, no pins): marked stale, not derived per frame
    t.params.aCurl = 0.6;
    t.viewer.tick();
    expect(t.scene.calls.setLimbs).toHaveLength(n);
    // the next hover reads them fresh
    const s = t.tipScreen("a");
    t.fire("pointermove", s.x, s.y);
    expect(t.scene.calls.setLimbs).toHaveLength(n + 1);
    // while a limb shows, a frame after an edit re-reads at once
    t.params.aCurl = 0.4;
    t.viewer.tick();
    expect(t.scene.calls.setLimbs).toHaveLength(n + 2);
  });
});

describe("always-on posing: hover, pick arbitration, suppression, touch", () => {
  const far = { x: 3, y: 3 };

  it("is live from creation: nothing hovered, every limb read", () => {
    const t = setup();
    expect(t.mode.isEnabled()).toBe(true);
    expect(t.mode.isLive()).toBe(true);
    expect(t.scene.calls.setLimbs.at(-1).map((i) => i.name).sort()).toEqual(["a", "b"]);
    expect(t.scene.calls.setHover).toEqual([]); // at rest nothing shows
  });

  it("near a limb's bones shows that limb's dots, and leaving hides them", () => {
    const t = setup();
    // halfway along finger a's first bone, 20 px off it on the side away from finger b
    const j0 = t.pointScreen("a", "mcp"), j1 = t.pointScreen("a", "pip");
    const away = Math.sign(j0.x - t.pointScreen("b", "mcp").x);
    const mid = { x: (j0.x + j1.x) / 2 + 20 * away, y: (j0.y + j1.y) / 2 };
    t.fire("pointermove", mid.x, mid.y);
    expect(t.scene.calls.setHover.at(-1)).toEqual(["a", null]);
    expect(t.mode.claimsHover()).toBe(false); // near a limb, not on a dot: the model's tooltip stays
    expect(t.viewer.domElement.style.cursor).toBe("");
    t.fire("pointermove", far.x, far.y);
    expect(t.scene.calls.setHover.at(-1)).toEqual([null, null]);
    t.fire("pointermove", mid.x, mid.y);
    t.fire("pointerleave", mid.x, mid.y);
    expect(t.scene.calls.setHover.at(-1)).toEqual([null, null]);
  });

  it("a hovered dot is highlighted, takes a grab cursor and claims the hover", () => {
    const t = setup();
    let changes = 0;
    t.mode.onHoverChange(() => changes++);
    const pip = t.pointScreen("a", "pip");
    t.fire("pointermove", pip.x + 3, pip.y);
    expect(t.scene.calls.setHover.at(-1)).toEqual(["a", "pip"]);
    expect(t.mode.claimsHover()).toBe(true);
    expect(changes).toBe(1);
    expect(t.viewer.domElement.style.cursor).toBe("grab");
    t.fire("pointermove", far.x, far.y);
    expect(t.mode.claimsHover()).toBe(false);
    expect(changes).toBe(2);
    expect(t.viewer.domElement.style.cursor).toBe("");
  });

  it("a click on a tip dot pins it and claims the click; a press elsewhere claims nothing", () => {
    const t = setup();
    const s = t.tipScreen("b");
    t.fire("pointermove", s.x, s.y);
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.getPins()).toEqual(["b:tip"]);
    expect(t.mode.takeClick()).toBe(true); // the picker's guard: no pick for this click
    expect(t.mode.takeClick()).toBe(false); // spent
    t.fire("pointerdown", far.x, far.y);
    t.fire("pointerup", far.x, far.y);
    expect(t.orbit.enabled).toBe(true);
    expect(t.mode.takeClick()).toBe(false); // a plain click on the model still picks
  });

  it("a drag claims its click, so release never picks", () => {
    const t = setup();
    const s = t.tipScreen("a");
    t.fire("pointerdown", s.x, s.y);
    for (let i = 1; i <= 4; i++) t.fire("pointermove", s.x, s.y - i * 8);
    t.fire("pointerup", s.x, s.y - 32);
    expect(t.log.commit).toHaveLength(1);
    expect(t.mode.takeClick()).toBe(true);
    // a stale claim never outlives the next press
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    t.fire("pointerdown", far.x, far.y);
    expect(t.mode.takeClick()).toBe(false);
  });

  it("suppressed (measure, sketch or cutaway on): hidden, presses fall through; back on when lifted", () => {
    const t = setup();
    let modeChanges = 0;
    t.mode.onModeChange(() => modeChanges++);
    const s = t.tipScreen("a");
    t.fire("pointermove", s.x, s.y);
    t.mode.setSuppressed(true);
    expect(t.mode.isLive()).toBe(false);
    expect(t.mode.isEnabled()).toBe(true);
    expect(t.scene.cleared).toBe(1);
    expect(t.mode.claimsHover()).toBe(false);
    expect(t.mode.handlePoints()).toEqual([]);
    expect(modeChanges).toBe(1);
    t.fire("pointerdown", s.x, s.y);
    expect(t.orbit.enabled).toBe(true); // orbit keeps the press
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.getPins()).toEqual([]);
    expect(t.mode.takeClick()).toBe(false);
    t.mode.setSuppressed(false);
    expect(t.mode.isLive()).toBe(true);
    expect(t.mode.handlePoints().length).toBe(2);
    // the host switch is independent: off stays off when suppression lifts
    t.mode.setEnabled(false);
    t.mode.setSuppressed(true);
    t.mode.setSuppressed(false);
    expect(t.mode.isLive()).toBe(false);
  });

  it("a touch press near any limb's dot drags it with no hover first; a touch far away does nothing", () => {
    const t = setup();
    const touch = { pointerType: "touch" };
    t.fire("pointerdown", far.x, far.y, touch);
    expect(t.orbit.enabled).toBe(true);
    expect(t.mode.takeClick()).toBe(false);
    const s = t.tipScreen("b");
    t.fire("pointerdown", s.x + 20, s.y, touch); // inside the 24 px touch reach, outside the mouse's 14
    expect(t.orbit.enabled).toBe(false);
    for (let i = 1; i <= 4; i++) t.fire("pointermove", s.x + 20, s.y - i * 8, touch);
    expect(t.mode.isDragging()).toBe(true);
    t.fire("pointerup", s.x + 20, s.y - 32, touch);
    expect(t.log.commit).toHaveLength(1);
    expect(t.orbit.enabled).toBe(true);
    expect(t.scene.calls.setHover.at(-1)).toEqual([null, null]); // the finger lifted: hidden again
  });

  it("a mouse press must be on a dot: 20 px off a tip is not a grab", () => {
    const t = setup();
    const s = t.tipScreen("b");
    t.fire("pointerdown", s.x + 20, s.y);
    expect(t.orbit.enabled).toBe(true);
  });
});

describe("aim rings on a goal handle", () => {
  // Finger a's tip as a goal handle aimed by pitch/yaw/roll from a +X rest toward.
  const aimed = (pitch) => ({
    ...hand,
    defaults: { ...hand.defaults, gx: 0, gy: 0, gz: 0, gPitch: pitch, gYaw: 0, gRoll: 0 },
    handles: { a: { limb: "a", at: "tip", mode: "goal", toward: [1, 0, 0],
      params: { position: ["gx", "gy", "gz"], aim: ["gPitch", "gYaw", "gRoll"] } } },
  });
  for (const pitch of [-90, 90, -89]) {
    it(`turn about the parameters' axes at pitch ${pitch}, not the posed bone's`, () => {
      const t = setup(aimed(pitch));
      t.mode.setEnabled(true);
      const s = t.tipScreen("a");
      t.fire("pointermove", s.x, s.y);
      const rings = t.scene.calls.setAimRings.at(-1);
      expect(rings).toBeTruthy();
      expect(rings.axes).toHaveLength(3);
      rings.axes[0].forEach((v, i) => expect(v).toBeCloseTo([0, -1, 0][i], 9));
      rings.axes[1].forEach((v, i) => expect(v).toBeCloseTo([0, 0, 1][i], 9));
    });
  }
  it("show no rings for a goal handle without a toward", () => {
    const part = aimed(0);
    delete part.handles.a.toward;
    const t = setup(part);
    t.mode.setEnabled(true);
    const s = t.tipScreen("a");
    t.fire("pointermove", s.x, s.y);
    expect(t.scene.calls.setAimRings.filter(Boolean)).toEqual([]);
  });
});

describe("aimAxes", () => {
  const close = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
  const X = [1, 0, 0];

  it("follows aimFromAngles: pitch about aim x up, yaw about +Z, roll about the aim", () => {
    const [pitch, yaw, roll] = aimAxes(X, [0, 0, 0]);
    close(pitch, [0, -1, 0]);
    close(yaw, [0, 0, 1]);
    close(roll, [1, 0, 0]);
    expect(aimAxes(X, [0, 0])).toHaveLength(2);
  });

  // The robot arm's tool aim: toward +X, pitch -90 points it straight down.
  for (const p of [-90, 90, -89]) {
    it(`keeps the pitch ring about the yawed horizontal at pitch ${p}`, () => {
      const [pitch, yaw, roll] = aimAxes(X, [p, 0, 0]);
      close(pitch, [0, -1, 0]);
      close(yaw, [0, 0, 1]);
      close(roll, aimFromAngles({ toward: X, pitch: p, yaw: 0, roll: 0 }).aim);
      const [pitch30] = aimAxes(X, [p, 30, 0]);
      close(pitch30, [Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6), 0]);
    });
  }

  it("turns each angle about its ring's axis, as aimFromAngles does (including at +-90)", () => {
    const eps = 1e-4;
    for (const toward of [[1, 0, 0], [0.3, -0.5, 0.8], [0, 0, 1]]) {
      for (const [pitch, yaw, roll] of [[0, 0, 0], [-90, 20, 10], [90, -45, 30], [-89, 120, -60], [35, 170, 5]]) {
        const axes = aimAxes(toward, [pitch, yaw, roll]);
        const base = aimFromAngles({ toward, pitch, yaw, roll });
        const bumps = [
          aimFromAngles({ toward, pitch: pitch + eps, yaw, roll }),
          aimFromAngles({ toward, pitch, yaw: yaw + eps, roll }),
          aimFromAngles({ toward, pitch, yaw, roll: roll + eps }),
        ];
        const rad = (eps * Math.PI) / 180;
        bumps.forEach((b, i) => {
          // a small turn about the ring axis k moves v by (k x v) * angle
          const k = axes[i];
          for (const key of ["aim", "up"]) {
            const v = base[key];
            const kv = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
            b[key].forEach((c, j) => expect((c - v[j]) / rad).toBeCloseTo(kv[j], 3));
          }
        });
      }
    }
  });

  it("returns no axes for a bad toward", () => {
    expect(aimAxes(null, [0, 0])).toEqual([]);
    expect(aimAxes([0, 0, 0], [0, 0])).toEqual([]);
  });
});
