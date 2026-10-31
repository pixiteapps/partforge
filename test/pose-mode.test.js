// @vitest-environment happy-dom
// Pose mode's pointer loop against a fake viewer that keeps the real frame stack: a
// pivot turned -90° about X with the parts group under it, so a part point must go
// through the parts frame to land under the pointer (and a ray back through it).
import { describe, it, expect, afterEach } from "vitest";
import * as THREE from "three";
import { createPoseMode, aimAxes } from "../src/framework/pose/pose-mode.js";
import { createAimGizmo, AIM_RING_PX } from "../src/framework/pose/aim-gizmo.js";
import { GIZMO_PALETTE } from "../src/framework/gizmo/gizmo-handles.js";
import { worldPerPx } from "../src/framework/measure/dim3-scene.js";
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
  const calls = { setLimbs: [], setHover: [], setActive: [], setPins: [], setAimGizmo: [] };
  return {
    calls,
    setLimbs: (x) => calls.setLimbs.push(x),
    setHover: (limb, dot = null) => calls.setHover.push([limb, dot]),
    cleared: 0,
    setActive: (x) => calls.setActive.push(x),
    setPins: (x) => calls.setPins.push(x),
    setAimGizmo: (x) => calls.setAimGizmo.push(x),
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
  let gizmo = null;
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
    createGizmo: (v) => (gizmo = createAimGizmo(v)),
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
  return { viewer, scene, orbit, params, log, mode, fire, tipScreen, pointScreen, screenOf, info, gizmo: () => gizmo };
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

describe("the aim gizmo on a goal handle", () => {
  // Finger a's tip as a goal handle aimed by pitch/yaw/roll from a +X rest toward.
  const aimed = (pitch, aim = ["gPitch", "gYaw", "gRoll"]) => ({
    ...hand,
    defaults: { ...hand.defaults, gx: 0, gy: 0, gz: 0, gPitch: pitch, gYaw: 0, gRoll: 0 },
    handles: { a: { limb: "a", at: "tip", mode: "goal", toward: [1, 0, 0],
      params: { position: ["gx", "gy", "gz"], aim } } },
  });
  const close = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
  const hoverTip = (t) => { const s = t.tipScreen("a"); t.fire("pointermove", s.x, s.y); return s; };
  // A point on a ring's circle (part coordinates), `deg` round from its reference.
  function ringPoint(t, axis, deg) {
    const at = t.info("a").points.tip;
    const world = new THREE.Vector3(...at).applyMatrix4(t.viewer.partsGroup.matrixWorld);
    const r = AIM_RING_PX * worldPerPx(t.viewer.camera.position.distanceTo(world), 45, H);
    const a = new THREE.Vector3(...axis).normalize();
    const u = new THREE.Vector3(1, 0, 0).projectOnPlane(a);
    if (u.lengthSq() < 1e-6) u.set(0, 0, 1).projectOnPlane(a);
    u.normalize();
    const v = a.clone().cross(u);
    const th = (deg * Math.PI) / 180;
    const p = new THREE.Vector3(...at).addScaledVector(u, r * Math.cos(th)).addScaledVector(v, r * Math.sin(th));
    return t.screenOf(p.toArray());
  }

  for (const pitch of [-90, 90, -89]) {
    it(`turns about the parameters' axes at pitch ${pitch}, not the posed bone's`, () => {
      const t = setup(aimed(pitch));
      hoverTip(t);
      const g = t.gizmo().state;
      expect(g.visible).toBe(true);
      expect(g.axes).toHaveLength(3);
      close(g.axes[0], [0, -1, 0]);
      close(g.axes[1], [0, 0, 1]);
      close(g.at, t.info("a").points.tip);
    });
  }

  it("shows no gizmo for a goal handle without a toward", () => {
    const part = aimed(0);
    delete part.handles.a.toward;
    const t = setup(part);
    hoverTip(t);
    expect(t.gizmo().state.visible).toBe(false);
    expect(t.scene.calls.setAimGizmo.filter(Boolean)).toEqual([]);
  });

  it("shows on hover of its limb (the ball replaces the tip dot) and goes when the mouse leaves", () => {
    const t = setup(aimed(0));
    expect(t.gizmo().state.visible).toBe(false);
    hoverTip(t);
    expect(t.gizmo().state.visible).toBe(true);
    expect(t.scene.calls.setAimGizmo.at(-1)).toEqual({ limb: "a", at: "tip" });
    t.fire("pointermove", 3, 3);
    expect(t.gizmo().state.visible).toBe(false);
    expect(t.scene.calls.setAimGizmo.at(-1)).toBeNull();
  });

  it("each part has the shared hover state: lifted colour, thick geometry, a grab cursor", () => {
    const t = setup(aimed(-60));
    hoverTip(t);
    const pts = t.mode.aimGizmoPoints();
    expect(Object.keys(pts.rings)).toEqual(["pitch", "yaw", "roll"]);
    const P = GIZMO_PALETTE.dark;
    const base = { ball: P.fill, pitch: P.red, yaw: P.blue, roll: P.green };
    for (const [part, at] of [["ball", pts.center], ...Object.entries(pts.rings)]) {
      t.fire("pointermove", at.x, at.y);
      const g = t.gizmo().state;
      expect(g.hovered).toBe(part);
      expect(t.mode.aimGizmoPoints().hovered).toBe(part);
      expect(t.viewer.domElement.style.cursor).toBe("grab");
      expect(t.mode.claimsHover()).toBe(true);
      for (const [name, p] of Object.entries(g.parts)) {
        const on = name === part;
        expect(p.thick).toBe(on);
        expect(p.material.opacity).toBe(1);
        if (on) expect(p.material.color.getHex()).not.toBe(base[name]);
        else expect(p.material.color.getHex()).toBe(base[name]);
      }
    }
    // between the ball and the rings, clear of the edge-on yaw and roll rings' bands
    // (horizontal, and 30 degrees up from it): still shown, nothing hovered, no grab
    const c = pts.center;
    t.fire("pointermove", c.x, c.y - 22);
    expect(t.gizmo().state.visible).toBe(true);
    expect(t.gizmo().state.hovered).toBeNull();
    expect(t.viewer.domElement.style.cursor).toBe("");
  });

  it("has no roll ring with two aim parameters", () => {
    const t = setup(aimed(0, ["gPitch", "gYaw"]));
    hoverTip(t);
    const g = t.gizmo().state;
    expect(g.axes).toHaveLength(2);
    expect(g.parts.roll.shown).toBe(false);
    expect(g.parts.pitch.shown).toBe(true);
    expect(Object.keys(t.mode.aimGizmoPoints().rings)).toEqual(["pitch", "yaw"]);
  });

  for (const pitch of [-60, -90]) {
    it(`dragging the pitch ring at pitch ${pitch} writes gPitch with the turn's sign, one commit`, () => {
      const t = setup(aimed(pitch));
      hoverTip(t);
      const axis = t.gizmo().state.axes[0];
      // 120 degrees round: clear of where the edge-on yaw and roll rings cross it
      const p0 = ringPoint(t, axis, 120);
      t.fire("pointermove", p0.x, p0.y);
      expect(t.gizmo().state.hovered).toBe("pitch");
      t.fire("pointerdown", p0.x, p0.y);
      expect(t.orbit.enabled).toBe(false);
      for (let d = 5; d <= 20; d += 5) {
        const p = ringPoint(t, axis, 120 + d);
        t.fire("pointermove", p.x, p.y);
        expect(t.gizmo().state.hovered).toBe("pitch"); // steady while dragging
      }
      expect(t.viewer.domElement.style.cursor).toBe("grabbing");
      const p1 = ringPoint(t, axis, 140);
      t.fire("pointerup", p1.x, p1.y);
      expect(t.params.gPitch).toBeCloseTo(pitch + 20, 1);
      expect(t.params.gYaw).toBe(0);
      expect(t.log.commit).toEqual([["gPitch"]]);
      expect(t.orbit.enabled).toBe(true);
      // and back the other way: a negative turn lowers it
      hoverTip(t);
      const axis2 = t.gizmo().state.axes[0];
      const q0 = ringPoint(t, axis2, 120);
      t.fire("pointermove", q0.x, q0.y);
      t.fire("pointerdown", q0.x, q0.y);
      for (let d = 5; d <= 10; d += 5) { const q = ringPoint(t, axis2, 120 - d); t.fire("pointermove", q.x, q.y); }
      t.fire("pointerup", q0.x, q0.y);
      expect(t.params.gPitch).toBeCloseTo(pitch + 10, 1);
    });
  }

  it("an edge-on ring turns by pointer travel across it (the shared screen fallback)", () => {
    const t = setup(aimed(-60));
    hoverTip(t);
    // the yaw axis is part +Z, straight up the screen: edge-on
    const p0 = t.mode.aimGizmoPoints().rings.yaw;
    t.fire("pointermove", p0.x, p0.y);
    expect(t.gizmo().state.hovered).toBe("yaw");
    t.fire("pointerdown", p0.x, p0.y);
    for (let i = 1; i <= 4; i++) t.fire("pointermove", p0.x + i * 10, p0.y);
    t.fire("pointerup", p0.x + 40, p0.y);
    expect(t.params.gYaw).toBeCloseTo(30, 6); // 0.75 degrees per px
    expect(t.log.commit).toEqual([["gYaw"]]);
  });

  it("dragging the centre ball moves the tool point in the camera-facing plane", () => {
    const t = setup(aimed(-60));
    const s = hoverTip(t);
    const tip = t.info("a").points.tip;
    expect(t.gizmo().state.hovered).toBe("ball");
    t.fire("pointerdown", s.x, s.y);
    for (let i = 1; i <= 5; i++) t.fire("pointermove", s.x, s.y - i * 6);
    expect(t.gizmo().state.hovered).toBe("ball");
    expect(t.gizmo().state.visible).toBe(true);
    t.fire("pointerup", s.x, s.y - 30);
    // up the screen is part +Z (the pivot stands Z up); x and y stay with the point
    expect(t.params.gz).toBeGreaterThan(tip[2] + 5);
    expect(t.params.gx).toBeCloseTo(tip[0], 6);
    expect(t.params.gy).toBeCloseTo(tip[1], 6);
    expect(t.params.gPitch).toBe(-60);
    expect(t.log.commit).toHaveLength(1);
    expect(t.log.commit[0].sort()).toEqual(["gx", "gy", "gz"]);
  });

  it("a mouse click on the ball still pins the goal point", () => {
    const t = setup(aimed(0));
    const s = hoverTip(t);
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.getPins()).toEqual(["a:tip"]);
    expect(t.log.write).toEqual([]);
  });

  it("touch: a tap on the goal point shows the gizmo, so a finger can drag a ring; a tap elsewhere hides it", () => {
    const t = setup(aimed(-60));
    const touch = { pointerType: "touch" };
    const s = t.tipScreen("a");
    t.fire("pointerdown", s.x + 15, s.y, touch); // inside a finger's reach
    t.fire("pointerup", s.x + 15, s.y, touch);
    expect(t.gizmo().state.visible).toBe(true);
    expect(t.mode.getPins()).toEqual([]); // the first tap only shows it
    expect(t.log.write).toEqual([]);
    expect(t.mode.takeClick()).toBe(true);
    // a finger on the pitch ring drags it
    const axis = t.gizmo().state.axes[0];
    const p0 = ringPoint(t, axis, 120);
    t.fire("pointerdown", p0.x, p0.y, touch);
    expect(t.gizmo().state.hovered).toBe("pitch");
    for (let d = 5; d <= 20; d += 5) { const p = ringPoint(t, axis, 120 + d); t.fire("pointermove", p.x, p.y, touch); }
    t.fire("pointerup", p0.x, p0.y, touch);
    expect(t.params.gPitch).toBeCloseTo(-40, 1);
    expect(t.log.commit).toEqual([["gPitch"]]);
    expect(t.gizmo().state.visible).toBe(true); // still up after the drag
    expect(t.gizmo().state.hovered).toBeNull(); // touch has no hover
    // a tap on the ball while it is up pins, as a mouse click does
    const c = t.tipScreen("a");
    t.fire("pointerdown", c.x, c.y, touch);
    t.fire("pointerup", c.x, c.y, touch);
    expect(t.mode.getPins()).toEqual(["a:tip"]);
    expect(t.gizmo().state.visible).toBe(true);
    // a tap anywhere else puts it away, and that press is left to orbit
    t.fire("pointerdown", 3, 3, touch);
    expect(t.orbit.enabled).toBe(true);
    t.fire("pointerup", 3, 3, touch);
    expect(t.gizmo().state.visible).toBe(false);
  });

  it("is hidden from captures, follows the theme and goes with detach", () => {
    const t = setup(aimed(0));
    hoverTip(t);
    const g = t.gizmo();
    expect(g.group.parent).toBe(t.viewer.partsGroup);
    g.setTheme("light");
    expect(g.state.parts.pitch.material.color.getHex()).toBe(GIZMO_PALETTE.light.red);
    t.mode.setSuppressed(true);
    expect(g.state.visible).toBe(false);
    t.mode.setSuppressed(false);
    t.mode.detach();
    expect(g.group.parent).toBeNull();
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
