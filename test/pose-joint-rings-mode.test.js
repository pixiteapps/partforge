// @vitest-environment happy-dom
// Joint rings in Pose mode's pointer loop: hover a joint dot to show its ring, drag the
// ring to turn that one joint. Same fake viewer as test/pose-mode.test.js (a pivot turned
// -90 degrees about X, the parts group under it): the camera looks along part +Y, so a
// bend axis of a limb standing up +Z and bending toward +X faces the camera.
import { describe, it, expect, afterEach } from "vitest";
import * as THREE from "three";
import { createPoseMode } from "../src/framework/pose/pose-mode.js";
import { createAimGizmo, createJointGizmo, JOINT_RING_PX } from "../src/framework/pose/aim-gizmo.js";
import { PIN_LIFT_PX } from "../src/framework/pose/pose-scene.js";
import { worldPerPx } from "../src/framework/measure/dim3-scene.js";
import { limbInfo } from "../src/framework/pose/param-solve.js";
import { resolveParams } from "../src/framework/part-model.js";
import { limb } from "../src/framework/domains/kinematics/index.js";
import hand from "../src/parts/hand.js";
import robotArm from "../src/parts/robot-arm.js";

const W = 400, H = 400;

function fakeViewer() {
  const scene = new THREE.Scene();
  const pivot = new THREE.Group();
  pivot.rotation.x = -Math.PI / 2;
  scene.add(pivot);
  const partsGroup = new THREE.Group();
  partsGroup.position.set(0, 0, -80);
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
    camera, domElement: canvas, _subMeshes: { palm }, partsGroup,
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
    setHover: (l, dot = null) => calls.setHover.push([l, dot]),
    setActive: (x) => calls.setActive.push(x),
    setPins: (x) => calls.setPins.push(x),
    setAimGizmo: (x) => calls.setAimGizmo.push(x),
    setTheme() {}, tick() {}, dispose() {}, clear() {},
  };
}

// A two-joint arm standing up +Z, bending toward +X: shoulder then elbow.
const ARM = limb("arm", {
  at: [0, 0, 0], toward: [0, 0, 1], bendToward: [1, 0, 0],
  joints: [{ name: "shoulder", range: [-90, 90] }, { name: "elbow", range: [0, 120] }],
  lengths: [60, 50],
});
const counter = { derives: 0 };
const control = (key, min, max) => ({ key, label: key, unit: "°", min, max, step: 0.1 });
const base = {
  meta: { title: "Joint ring fixture", units: "mm" },
  parameters: [{ id: "p", title: "P", controls: [
    control("sh", -90, 90), control("el", 0, 120), control("elN", -120, 0),
    { key: "gx", label: "x", min: -400, max: 400, step: 0.1 }, { key: "gy", label: "y", min: -400, max: 400, step: 0.1 }, { key: "gz", label: "z", min: -400, max: 400, step: 0.1 },
    control("gp", -90, 90), control("gyaw", -180, 180),
    { key: "lk", label: "Lock", type: "checkbox" },
  ] }],
  defaults: { sh: 20, el: 40, elN: -40, gx: 0, gy: 0, gz: 0, gp: 0, gyaw: 0, lk: 0 },
  parts: { palm: { label: "Palm", build: (k) => k.box({ min: [-5, -5, -5], max: [5, 5, 5] }), views: { main: (s) => s } } },
  views: { main: { label: "Main" } },
};
const anglesPart = (joints = { shoulder: "sh", elbow: "el" }, derive = (p) => ARM.pose({ bend: { shoulder: p.sh, elbow: p.el } })) => ({
  ...base,
  derive: (p) => { counter.derives++; return { arm: derive(p) }; },
  handles: { arm: { limb: "arm", mode: "angles", params: ["sh", "el"], lock: "lk", joints } },
});
// A goal handle at the tip, seeded by the two joints (so both get rings), the goal at the
// default pose's tip; with `aim`, an aim gizmo too.
const goalPart = (aim = false) => {
  const tip = ARM.pose({ bend: { shoulder: 20, elbow: 40 } }).ikForward({});
  const part = {
    ...base,
    defaults: { ...base.defaults, gx: tip.origin[0], gy: tip.origin[1], gz: tip.origin[2] },
    derive: (p) => ({ arm: ARM.pose({ bend: { shoulder: p.sh, elbow: p.el }, goals: [{ at: "tip", position: [p.gx, p.gy, p.gz] }] }) }),
    handles: { arm: { limb: "arm", at: "tip", mode: "goal", params: { position: ["gx", "gy", "gz"] }, seed: ["sh", "el"] } },
  };
  if (aim) {
    part.handles.arm.params.aim = ["gp", "gyaw"];
    part.handles.arm.toward = [1, 0, 0];
  }
  return part;
};

const live = [];
function setup(part, over = {}, limbKey = "arm", opts = {}) {
  const viewer = fakeViewer();
  const scene = fakeScene();
  const orbit = { enabled: true };
  const params = { ...part.defaults, ...over };
  const log = { write: [], commit: [] };
  let jointGizmo = null, aimGizmo = null;
  const mode = createPoseMode(viewer, {
    part, orbitControls: orbit,
    getParams: () => params,
    write: (v) => { log.write.push({ ...v }); Object.assign(params, v); },
    commit: (keys) => log.commit.push(keys),
    restore: (v) => Object.assign(params, v),
    staleSubParts: () => [], ghost() {}, unghost() {}, hold() {},
    schedule: (cb) => cb(),
    createScene: () => scene,
    createGizmo: (v) => (aimGizmo = createAimGizmo(v)),
    createJointRings: (v) => (jointGizmo = createJointGizmo(v)),
    ...opts,
  });
  live.push(mode);
  const info = (key = limbKey) => limbInfo(part, params, { limb: key });
  const screenOf = (p) => viewer.projectPoint(new THREE.Vector3(...p).applyMatrix4(viewer.partsGroup.matrixWorld).toArray());
  const fire = (type, x, y, extra = {}) => viewer.domElement.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "mouse", bubbles: true, ...extra,
  }));
  const hover = (at) => { const s = screenOf(info().points[at]); fire("pointermove", s.x, s.y); return s; };
  /** A point on the joint ring about `axis` at the joint `at`, `deg` round (right-handed about the axis). */
  function ringPoint(at, axis, deg) {
    const c = info().points[at];
    const world = new THREE.Vector3(...c).applyMatrix4(viewer.partsGroup.matrixWorld);
    const r = JOINT_RING_PX * worldPerPx(viewer.camera.position.distanceTo(world), 45, H);
    const a = new THREE.Vector3(...axis).normalize();
    const u = new THREE.Vector3(1, 0, 0).projectOnPlane(a);
    if (u.lengthSq() < 1e-6) u.set(0, 0, 1).projectOnPlane(a);
    u.normalize();
    const v = a.clone().cross(u);
    const th = (deg * Math.PI) / 180;
    return screenOf(new THREE.Vector3(...c).addScaledVector(u, r * Math.cos(th)).addScaledVector(v, r * Math.sin(th)).toArray());
  }
  /** Hover the joint, then drag its ring from `from` degrees round by `by`, in 5-degree steps. */
  function dragRing(at, by, from = 60) {
    hover(at);
    const axis = jointGizmo.state.axes.find(Boolean);
    const p0 = ringPoint(at, axis, from);
    fire("pointermove", p0.x, p0.y);
    expect(jointGizmo.state.hovered).not.toBeNull();
    fire("pointerdown", p0.x, p0.y);
    const steps = Math.max(1, Math.round(Math.abs(by) / 5));
    let p = p0;
    for (let i = 1; i <= steps; i++) { p = ringPoint(at, axis, from + (by * i) / steps); fire("pointermove", p.x, p.y); }
    return p;
  }
  return { viewer, scene, orbit, params, log, mode, fire, info, hover, screenOf, ringPoint, dragRing, joint: () => jointGizmo, aim: () => aimGizmo };
}

afterEach(() => { for (const m of live.splice(0)) m.detach(); document.body.innerHTML = ""; });

describe("joint rings in Pose mode", () => {
  it("hovering a joint dot with a mapped parameter shows its ring about the joint's axis; the tip shows none", () => {
    const t = setup(anglesPart());
    expect(t.mode.jointRingPoints().map((p) => p.joint)).toEqual(["shoulder", "elbow"]);
    t.hover("elbow");
    const g = t.joint().state;
    expect(g.visible).toBe(true);
    expect(g.axes[0]).toEqual(t.info().axes.elbow); // a bend hinge: the bend (red) ring
    expect(g.axes[1]).toBeNull();
    expect(g.axes[2]).toBeNull();
    expect(g.at).toEqual(t.info().points.elbow);
    expect(t.viewer.domElement.style.cursor).toBe("grab"); // the dot itself still drags (IK)
    t.hover("tip");
    expect(t.joint().state.visible).toBe(false);
    t.fire("pointermove", 3, 3);
    expect(t.joint().state.visible).toBe(false);
  });

  it("dragging the ring turns that joint by the ring's angle, positive about its axis, one commit", () => {
    const t = setup(anglesPart());
    const p = t.dragRing("elbow", 20);
    expect(t.joint().state.hovered).toBe("bend"); // steady while dragging
    expect(t.viewer.domElement.style.cursor).toBe("grabbing");
    expect(t.orbit.enabled).toBe(false);
    t.fire("pointerup", p.x, p.y);
    expect(t.params.el).toBeCloseTo(60, 1);
    expect(t.params.sh).toBe(20); // only that joint
    expect(t.log.commit).toEqual([["el"]]);
    expect(t.orbit.enabled).toBe(true);
    // the other way
    const q = t.dragRing("elbow", -30);
    t.fire("pointerup", q.x, q.y);
    expect(t.params.el).toBeCloseTo(30, 1);
  });

  it("clamps at the joint's range, with the limit arc's warning on that joint", () => {
    const t = setup(anglesPart());
    const p = t.dragRing("elbow", 120);
    expect(t.params.el).toBe(120);
    const active = t.scene.calls.setActive.filter(Boolean).at(-1);
    expect(active).toMatchObject({ limb: "arm", grab: "elbow" });
    expect(active.clamped).toEqual([false, true]);
    t.fire("pointerup", p.x, p.y);
    expect(t.params.el).toBe(120);
  });

  it("a { param, scale } entry writes value / scale: a negated parameter turns the other way", () => {
    const t = setup(anglesPart({ elbow: { param: "elN", scale: -1 } }, (p) => ARM.pose({ bend: { shoulder: p.sh, elbow: -p.elN } })));
    const p = t.dragRing("elbow", 20);
    t.fire("pointerup", p.x, p.y);
    expect(t.params.elN).toBeCloseTo(-60, 1);
    expect(t.log.commit).toEqual([["elN"]]);
  });

  it("a locked handle's joints show no ring", () => {
    const t = setup(anglesPart(), { lk: 1 });
    expect(t.mode.jointRingPoints()).toEqual([]);
    t.hover("elbow");
    expect(t.joint().state.visible).toBe(false);
  });

  it("a ball joint shows three rings: bend, spread and twist", () => {
    const BALL = limb("arm", { toward: [0, 0, 1], bendToward: [1, 0, 0], joints: [{ name: "shoulder", type: "ball", cone: 90 }, { name: "elbow", range: [0, 120] }], lengths: [60, 50] });
    const part = {
      ...anglesPart({ shoulder: { bend: "sh", spread: "gp", twist: "gyaw" } }),
      derive: (p) => ({ arm: BALL.pose({ bend: { shoulder: { bend: p.sh, spread: p.gp, twist: p.gyaw }, elbow: p.el } }) }),
    };
    const t = setup(part);
    t.hover("shoulder");
    const g = t.joint().state;
    const axes = t.info().ballAxes.shoulder;
    expect(g.axes).toEqual([axes.bend, axes.spread, axes.twist]);
    expect(Object.keys(t.mode.jointGizmoPoints().rings).sort()).toEqual(["bend", "spread", "twist"].sort());
  });

  it("goal mode: a seeded joint is a ring-only dot; its ring turns it and the goal follows, no spring-back", () => {
    const part = goalPart();
    const t = setup(part);
    t.hover("elbow");
    expect(t.joint().state.visible).toBe(true);
    expect(t.viewer.domElement.style.cursor).toBe("pointer"); // not a grab (a drag orbits): a click pins
    const s = t.screenOf(t.info().points.elbow);
    t.fire("pointerdown", s.x, s.y);
    expect(t.orbit.enabled).toBe(true);
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.takeClick()).toBe(true);
    expect(t.mode.getPins()).toEqual(["arm:elbow"]);
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y); // again: unpinned
    expect(t.mode.getPins()).toEqual([]);
    const before = { ...t.params };
    const p = t.dragRing("elbow", 20);
    t.fire("pointerup", p.x, p.y);
    expect(t.params.el).toBeCloseTo(before.el + 20, 1);
    expect(t.params.sh).toBe(before.sh);
    expect(Math.hypot(t.params.gx - before.gx, t.params.gz - before.gz)).toBeGreaterThan(5); // the goal moved
    expect(t.log.commit).toHaveLength(1);
    expect(t.log.commit[0]).toEqual(expect.arrayContaining(["el", "gx", "gz"]));
    expect(t.log.commit[0]).not.toContain("sh");
    // derive keeps it: the solved elbow is where the ring left it (to the release snap of the
    // goal to its 0.1 mm step, which moves this 50 mm forearm a tenth of a degree or so)
    const arm = resolveParams(part, t.params).d.arm;
    expect(arm.report.goals[0].status).toBe("reached");
    expect(Math.abs(arm.values[1] - t.params.el)).toBeLessThan(0.3);
  });

  it("one gizmo at a time: the aim gizmo on the tool point, a joint's rings on its dot", () => {
    const t = setup(goalPart(true));
    t.hover("tip");
    expect(t.aim().state.visible).toBe(true);
    expect(t.joint().state.visible).toBe(false);
    t.hover("elbow");
    expect(t.aim().state.visible).toBe(false);
    expect(t.joint().state.visible).toBe(true);
    expect(t.scene.calls.setAimGizmo.at(-1)).toBeNull();
    t.hover("shoulder");
    expect(t.joint().state.at).toEqual(t.info().points.shoulder);
    t.hover("tip");
    expect(t.aim().state.visible).toBe(true);
    expect(t.joint().state.visible).toBe(false);
  });

  it("the rings stay up while the pointer moves from the dot out to them", () => {
    const t = setup(anglesPart());
    const s = t.hover("elbow");
    // halfway to the ring, off the limb's bones (the forearm runs up and to the right)
    t.fire("pointermove", s.x - 14, s.y + 10);
    expect(t.joint().state.visible).toBe(true);
    expect(t.joint().state.hovered).toBeNull();
  });

  it("after a mouse drag, hover is taken afresh where the pointer was released", () => {
    const t = setup(anglesPart());
    t.dragRing("elbow", 20);
    expect(t.mode.claimsHover()).toBe(true);
    t.fire("pointerup", 3, 3); // released far from everything
    expect(t.viewer.domElement.style.cursor).toBe("");
    expect(t.mode.claimsHover()).toBe(false);
    expect(t.joint().state.visible).toBe(false);
  });

  it("while params change every frame, hover re-reads the limbs at most once per frame", () => {
    const t = setup(anglesPart());
    t.hover("tip");
    counter.derives = 0;
    for (let i = 1; i <= 4; i++) {
      t.params.sh = 20 + i; // playback / a slider: a new value before every move
      t.fire("pointermove", 3 + i, 3);
    }
    expect(counter.derives).toBe(1);
    t.viewer.tick(); // a new frame: nothing drawn now (the pointer left), so only marked stale
    t.params.sh = 30;
    t.fire("pointermove", 4, 3);
    expect(counter.derives).toBe(2);
  });

  it("hand: the wrist (on the palm limb) and a spread get rings; a curl-driven knuckle does not", () => {
    const t = setup(hand, {}, "palm");
    const joints = t.mode.jointRingPoints().map((p) => `${p.limb}.${p.joint}`);
    expect(joints).toEqual(expect.arrayContaining(["palm.wristPitch", "palm.wristYaw", "index.spread", "thumb.oppose"]));
    expect(joints.some((j) => /\.(mcp|pip|dip|ip)$/.test(j))).toBe(false);
    // the palm is shown for its rings only: it adds no handle point
    expect(t.mode.handlePoints().map((h) => h.handleId).sort()).toEqual(["index", "middle", "pinky", "ring", "thumb"]);
    // the wrist pitch turns about part X: edge-on to this camera, so the ring turns by
    // pointer travel along it (the shared screen fallback, 0.75 degrees per px)
    t.hover("wristPitch");
    const r = t.mode.jointGizmoPoints().rings.bend;
    t.fire("pointermove", r.x, r.y);
    expect(t.joint().state.hovered).toBe("bend");
    t.fire("pointerdown", r.x, r.y);
    for (let i = 1; i <= 4; i++) t.fire("pointermove", r.x, r.y - i * 5); // along the edge-on ring
    t.fire("pointerup", r.x, r.y - 20);
    expect(Math.abs(t.params.wristPitch)).toBeCloseTo(15, 6);
    expect(t.log.commit).toEqual([["wristPitch"]]);
    // a knuckle dot shows no rings
    const knuckle = t.screenOf(t.info("index").points.mcp);
    t.fire("pointermove", knuckle.x, knuckle.y);
    expect(t.joint().state.visible).toBe(false);
  });

  it("joints at one point share one gizmo: the arm's wrist pitch, yaw and roll, each its own ring", () => {
    const t = setup(robotArm);
    const wrist = t.screenOf(t.info().points.wristRoll);
    t.fire("pointermove", wrist.x, wrist.y);
    const g = t.joint().state;
    expect(g.visible).toBe(true);
    const info = t.info();
    expect(g.axes).toEqual([info.axes.wristPitch, info.axes.wristYaw, info.axes.wristRoll]);
    const pts = t.mode.jointGizmoPoints();
    expect(Object.keys(pts.rings).sort()).toEqual(["bend", "spread", "twist"]);
    // the spread ring turns the wrist yaw
    const r = pts.rings.spread;
    t.fire("pointermove", r.x, r.y);
    expect(t.joint().state.hovered).toBe("spread");
    t.fire("pointerdown", r.x, r.y);
    for (let i = 1; i <= 4; i++) t.fire("pointermove", r.x + ((r.ahead.x - r.x) * i) / 4, r.y + ((r.ahead.y - r.y) * i) / 4);
    t.fire("pointerup", r.ahead.x, r.ahead.y);
    expect(t.log.commit).toHaveLength(1);
    expect(t.log.commit[0]).toContain("wristYaw");
    expect(t.log.commit[0]).not.toContain("wristPitch");
    expect(t.params.wristYaw).not.toBe(robotArm.defaults.wristYaw);
  });

  it("a ring crossing a neighbouring joint's dot: the nearer wins, so both stay reachable", () => {
    const t = setup(hand, {}, "index");
    t.hover("spread");
    expect(t.joint().state.visible).toBe(true);
    // the knuckle piece is 20 mm: the next dot (mcp) sits near the 30 px ring
    const mcp = t.screenOf(t.info().points.mcp);
    const c = t.screenOf(t.info().points.spread);
    // 10 px short of the mcp dot, on the way out from the spread joint: inside the rings,
    // off the dot's core, so the spread ring stays up (no flash)
    const back = Math.hypot(mcp.x - c.x, mcp.y - c.y);
    t.fire("pointermove", mcp.x - ((mcp.x - c.x) * 10) / back, mcp.y - ((mcp.y - c.y) * 10) / back);
    expect(t.joint().state.visible).toBe(true);
    t.fire("pointermove", mcp.x, mcp.y); // right on the dot: the dot (it has no rings)
    expect(t.joint().state.visible).toBe(false);
    t.hover("spread");
    expect(t.mode.jointGizmoPoints().rings.spread).toBeTruthy(); // still a grabbable point on the ring
  });

  it("a press near a neighbour's dot, off every ring, grabs that dot (the 8 px core is for hover only)", () => {
    const t = setup(hand, {}, "index");
    t.hover("spread");
    const mcp = t.screenOf(t.info().points.mcp);
    const c = t.screenOf(t.info().points.spread);
    // 10 px off the mcp dot, inside the spread rings, with no ring under it
    const p = Array.from({ length: 24 }, (_, k) => ({ x: mcp.x + 10 * Math.cos((k * Math.PI) / 12), y: mcp.y + 10 * Math.sin((k * Math.PI) / 12) }))
      .find((q) => Math.hypot(q.x - c.x, q.y - c.y) < JOINT_RING_PX && !t.joint().pick({ x: q.x, y: q.y, w: W, h: H }));
    expect(p).toBeTruthy();
    t.fire("pointermove", p.x, p.y);
    expect(t.joint().state.visible).toBe(true); // hover: off the core, the rings stay
    t.fire("pointerdown", p.x, p.y);
    expect(t.orbit.enabled).toBe(false); // the press grabbed the mcp dot
    for (let i = 1; i <= 5; i++) t.fire("pointermove", p.x - i * 6, p.y + i * 6);
    // an IK drag of the mcp dot (it carries a target), not a turn of the spread ring
    expect(t.scene.calls.setActive.filter(Boolean).at(-1)).toMatchObject({ limb: "index", grab: "mcp", target: expect.any(Array) });
    t.fire("pointerup", p.x - 30, p.y + 30);
    expect(t.log.commit).toHaveLength(1);
  });

  it("touch on a ring-only dot puts its rings up and leaves the press to orbit; the tap picks nothing and pins nothing", () => {
    const t = setup(goalPart());
    const s = t.screenOf(t.info().points.elbow);
    t.fire("pointerdown", s.x, s.y, { pointerType: "touch" });
    expect(t.orbit.enabled).toBe(true);
    expect(t.mode.isDragging()).toBe(false);
    expect(t.joint().state.visible).toBe(true);
    t.fire("pointerup", s.x, s.y, { pointerType: "touch" });
    expect(t.mode.takeClick()).toBe(true);
    expect(t.mode.getPins()).toEqual([]); // the first tap only shows the rings
    // a tap on the dot while its rings are up toggles its pin
    t.fire("pointerdown", s.x, s.y, { pointerType: "touch" });
    t.fire("pointerup", s.x, s.y, { pointerType: "touch" });
    expect(t.mode.getPins()).toEqual(["arm:elbow"]);
    expect(t.joint().state.visible).toBe(true); // the rings stay up
    t.fire("pointerdown", s.x, s.y, { pointerType: "touch" });
    t.fire("pointerup", s.x, s.y, { pointerType: "touch" });
    expect(t.mode.getPins()).toEqual([]);
    // the next touch can take the ring
    const r = t.mode.jointGizmoPoints().rings.bend;
    t.fire("pointerdown", r.x, r.y, { pointerType: "touch" });
    expect(t.orbit.enabled).toBe(false);
    t.fire("pointerup", r.x, r.y, { pointerType: "touch" });
  });
});

// A pin on any dot: a click on a joint (a goal handle's ring-only joint too) pins it, the
// scene badges that point, and an IK drag of the goal holds it.
describe("joint pins", () => {
  const elbowOf = (part, params) => resolveParams(part, params).d.arm.world("elbow").origin;

  it("robot arm: a click on the elbow dot pins it (no write, no pick), badged at the elbow; a second click unpins", () => {
    const t = setup(robotArm);
    const s = t.hover("elbow");
    expect(t.viewer.domElement.style.cursor).toBe("pointer");
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.takeClick()).toBe(true); // the picker opens nothing
    expect(t.mode.getPins()).toEqual(["tool:elbow"]);
    expect(t.scene.calls.setPins.at(-1)).toEqual([{ limb: "arm", at: "elbow" }]);
    expect(t.log.write).toEqual([]);
    expect(t.log.commit).toEqual([]);
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.getPins()).toEqual([]);
    expect(t.scene.calls.setPins.at(-1)).toEqual([]);
  });

  it("a drag from a ring-only dot is not a click: it pins nothing", () => {
    const t = setup(robotArm);
    const s = t.hover("elbow");
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointermove", s.x + 20, s.y + 5); // an orbit
    t.fire("pointerup", s.x + 20, s.y + 5);
    expect(t.mode.getPins()).toEqual([]);
  });

  it("angles mode: a click on a joint pins it, and a tip drag holds it", () => {
    const part = anglesPart();
    const t = setup(part);
    const s = t.hover("elbow");
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.getPins()).toEqual(["arm:elbow"]);
    const before = elbowOf(part, t.params);
    const tip = t.hover("tip");
    t.fire("pointerdown", tip.x, tip.y);
    for (let i = 1; i <= 6; i++) t.fire("pointermove", tip.x - i * 4, tip.y + i * 3);
    t.fire("pointerup", tip.x - 24, tip.y + 18);
    expect(t.log.commit).toHaveLength(1);
    const after = elbowOf(part, t.params);
    expect(Math.hypot(...after.map((v, i) => v - before[i]))).toBeLessThan(0.5);
  });

  it("robot arm, elbow pinned: a tool drag keeps the elbow put, moves the tool toward the cursor, and derive reproduces the pose", () => {
    const t = setup(robotArm);
    t.mode.setPins(["tool:elbow"]);
    const elbow0 = elbowOf(robotArm, t.params);
    const tip0 = t.info().points.tip;
    const s = t.hover("tip");
    expect(t.aim().state.visible).toBe(true);
    t.fire("pointerdown", s.x, s.y);
    // toward the base: the tool tucks in (screen left and up = part -X, +Z)
    const steps = 8;
    for (let i = 1; i <= steps; i++) t.fire("pointermove", s.x - i * 3, s.y - i * 2);
    // mid-drag: seed + goal written so derive's goal solve lands on the pinned pose
    const arm = resolveParams(robotArm, t.params).d.arm;
    const g = arm.report.goals[0];
    expect(g.status).toBe("reached");
    const tip = arm.world("tip").origin;
    expect(Math.hypot(tip[0] - t.params.toolX, tip[1] - t.params.toolY, tip[2] - t.params.toolZ)).toBeLessThan(0.01);
    const elbowMid = arm.world("elbow").origin;
    expect(Math.hypot(...elbowMid.map((v, i) => v - elbow0[i]))).toBeLessThan(0.5);
    t.fire("pointerup", s.x - steps * 3, s.y - steps * 2);
    expect(t.log.commit).toHaveLength(1);
    // after the release snap the elbow is still held, and the tool moved toward the cursor
    const elbow1 = elbowOf(robotArm, t.params);
    expect(Math.hypot(...elbow1.map((v, i) => v - elbow0[i]))).toBeLessThan(0.5);
    const tip1 = t.info().points.tip;
    expect(tip1[0]).toBeLessThan(tip0[0] - 3); // toward the cursor: -X
    expect(t.mode.getPins()).toEqual(["tool:elbow"]); // a drag never toggles a pin
  });

  it("robot arm without a pin: the tool drag writes the goal directly, as before (the elbow moves)", () => {
    const t = setup(robotArm);
    const elbow0 = elbowOf(robotArm, t.params);
    const s = t.hover("tip");
    t.fire("pointerdown", s.x, s.y);
    for (let i = 1; i <= 8; i++) t.fire("pointermove", s.x - i * 3, s.y - i * 2);
    t.fire("pointerup", s.x - 24, s.y - 16);
    const elbow1 = elbowOf(robotArm, t.params);
    expect(Math.hypot(...elbow1.map((v, i) => v - elbow0[i]))).toBeGreaterThan(1);
  });

  it("robot arm, elbow pinned: an aim ring turn holds the elbow too", () => {
    const t = setup(robotArm);
    t.mode.setPins(["tool:elbow"]);
    const elbow0 = elbowOf(robotArm, t.params);
    t.hover("tip");
    const r = t.mode.aimGizmoPoints().rings.pitch;
    t.fire("pointermove", r.x, r.y);
    t.fire("pointerdown", r.x, r.y);
    for (let i = 1; i <= 4; i++) t.fire("pointermove", r.x + ((r.ahead.x - r.x) * i) / 4, r.y + ((r.ahead.y - r.y) * i) / 4);
    t.fire("pointerup", r.ahead.x, r.ahead.y);
    expect(t.log.commit).toHaveLength(1);
    expect(t.params.toolPitch).not.toBeCloseTo(robotArm.defaults.toolPitch, 0);
    const elbow1 = elbowOf(robotArm, t.params);
    expect(Math.hypot(...elbow1.map((v, i) => v - elbow0[i]))).toBeLessThan(0.5);
    expect(resolveParams(robotArm, t.params).d.arm.report.goals[0].status).toBe("reached");
  });

  it("touch: a tap on the aim point first shows the gizmo, a tap while it is up pins the tool", () => {
    const t = setup(robotArm);
    const s = t.screenOf(t.info().points.tip);
    t.fire("pointerdown", s.x, s.y, { pointerType: "touch" });
    t.fire("pointerup", s.x, s.y, { pointerType: "touch" });
    expect(t.mode.getPins()).toEqual([]);
    expect(t.aim().state.visible).toBe(true);
    t.fire("pointerdown", s.x, s.y, { pointerType: "touch" });
    t.fire("pointerup", s.x, s.y, { pointerType: "touch" });
    expect(t.mode.getPins()).toEqual(["tool:tip"]);
  });

  it("a click on a pinned dot's badge head unpins it, even with its ring seen edge-on through the head", () => {
    // the palm's wrist pitch turns about part X: edge-on to this camera, its ring is a
    // vertical line on screen straight through the dot and the badge head above it
    const t = setup(hand, {}, "palm");
    const s = t.hover("wristPitch");
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    expect(t.mode.getPins()).toHaveLength(1);
    const head = { x: s.x, y: s.y - PIN_LIFT_PX };
    expect(t.joint().pick({ x: head.x, y: head.y, w: W, h: H })).toBe("bend"); // the ring is under the head
    t.fire("pointermove", head.x, head.y);
    expect(t.joint().state.hovered).toBeNull(); // the dot, not the ring
    t.fire("pointerdown", head.x, head.y);
    t.fire("pointerup", head.x, head.y);
    expect(t.mode.getPins()).toEqual([]);
    expect(t.log.commit).toEqual([]);
    // unpinned, the same point is the ring's again
    t.fire("pointermove", head.x + 1, head.y);
    t.fire("pointermove", head.x, head.y);
    expect(t.joint().state.hovered).toBe("bend");
  });

  it("touch: a tap on the badge head of a pinned joint with its rings up unpins it", () => {
    const t = setup(hand, {}, "palm");
    const s = t.screenOf(t.info().points.wristPitch);
    const tap = (p) => { t.fire("pointerdown", p.x, p.y, { pointerType: "touch" }); t.fire("pointerup", p.x, p.y, { pointerType: "touch" }); };
    tap(s); // rings up
    tap(s); // pinned
    expect(t.mode.getPins()).toHaveLength(1);
    tap({ x: s.x, y: s.y - PIN_LIFT_PX });
    expect(t.mode.getPins()).toEqual([]);
  });

  it("a pin on a handle this view does not show has no badge and holds nothing", () => {
    const part = anglesPart();
    part.handles.other = { limb: "arm", mode: "angles", params: ["sh"] };
    const elbowMoves = (visible) => {
      const t = setup(part, {}, "arm", { visibleHandles: () => visible });
      t.mode.setPins(["other:elbow"]);
      const badges = t.scene.calls.setPins.at(-1);
      const before = elbowOf(part, t.params);
      const tip = t.hover("tip");
      t.fire("pointerdown", tip.x, tip.y);
      for (let i = 1; i <= 6; i++) t.fire("pointermove", tip.x - i * 4, tip.y + i * 3);
      t.fire("pointerup", tip.x - 24, tip.y + 18);
      const after = elbowOf(part, t.params);
      return { badges, moved: Math.hypot(...after.map((v, i) => v - before[i])) };
    };
    const shownBoth = elbowMoves(["arm", "other"]);
    expect(shownBoth.badges).toEqual([{ limb: "arm", at: "elbow" }]);
    expect(shownBoth.moved).toBeLessThan(0.5);
    const hidden = elbowMoves(["arm"]);
    expect(hidden.badges).toEqual([]);
    expect(hidden.moved).toBeGreaterThan(1);
  });

  it("hand: a click on the palm's wrist (a limb only a joints entry shows) pins it as <limb>.<joint>", () => {
    const t = setup(hand, {}, "palm");
    const s = t.hover("wristPitch");
    t.fire("pointerdown", s.x, s.y);
    t.fire("pointerup", s.x, s.y);
    const [id] = t.mode.getPins();
    expect(id).toMatch(/:palm\.wristPitch$/);
    expect(t.scene.calls.setPins.at(-1)).toEqual([{ limb: t.info().name, at: "wristPitch" }]);
  });
});
