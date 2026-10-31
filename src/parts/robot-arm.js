// A 6-axis robot arm with a two-finger gripper, posed by inverse kinematics: the
// reference part for goal-mode handles. You (or an agent) set WHERE the tool point goes
// and which way it points; derive() solves the six joint angles; the `tool` probe says in
// one line whether the arm got there, or how far it missed.
//
// How it fits together:
// - derive() declares one limb (base, shoulder, elbow, then a spherical wrist: pitch,
//   yaw, roll) and poses it with `goals`: the tool point at (toolX, toolY, toolZ),
//   pointing along aimFromAngles(toolPitch, toolYaw, toolRoll).
// - The solve starts from the six joint parameters (the SEED). They are ordinary
//   parameters in the collapsed "Joint angles" section. In Pose mode, dragging the tool
//   point writes the goal AND writes the solved angles back into the seed every frame,
//   so each frame starts from the last and the arm never flips to another solution.
//   derive() stays a pure function of the parameters.
// - Every link is built once in its own joint frame (joint at the origin, the link along
//   +Y, the hinge axis along X) and placed with d.arm.place — so posing is matrix-only:
//   no link rebuilds while you drag. Only upperLen / foreLen rebuild a link.
//
// Ranges, in degrees: base ±170, shoulder ±90, elbow 10..150, wrist pitch ±120, wrist yaw
// ±120, wrist roll ±180. The elbow stops 10° short of straight on purpose: a straight
// elbow is the arm's singular pose, where the solve can sit stuck and then jump when the
// goal comes back in reach. The stop keeps every drag smooth near full stretch.
import { limb, aimFromAngles } from "partforge/kinematics";

// Fixed geometry, mm.
const BASE_H = 30;        // pedestal height: the base joint sits on top of it
const SHOULDER_H = 80;    // base joint to the shoulder axis
const TOOL = 70;          // wrist centre to the tool point (between the fingertips)
const GAP = 0.4;          // running clearance between neighbouring links
const WRIST_R = 10;       // the wrist ball, centred on the arm's axis
// The links sit side by side along the hinge axis (local X), each in its own slab, the
// way most real arms are laid out: a link turning about a shared axis then never sweeps
// into its neighbour, at any bend. The forearm sits clear of the wrist ball, so the hand
// stays centred on the axis and the tool point lies between the fingers.
const SLAB = {
  turret: [-36, -16 - GAP],
  upper: [-16, WRIST_R],
  fore: [WRIST_R + GAP, WRIST_R + GAP + 18],
};
const R = { turret: 22, upper: 20, fore: 16 };   // half-thickness of each link (its end bosses' radius)
// Gripper: a palm and two fingers that open along the hinge axis.
const PALM = { w: 56, d: 18, y0: 20, y1: 30 };
const FINGER = { t: 6, d: 16, len: TOOL + 6 - 30 };

const RANGE = {
  base: [-170, 170], shoulder: [-90, 90], elbow: [10, 150],
  wristPitch: [-120, 120], wristYaw: [-120, 120], wristRoll: [-180, 180],
};
const JOINTS = Object.keys(RANGE);

const ARM = (p) => limb("arm", {
  at: [0, 0, BASE_H],
  toward: [0, 0, 1],          // the straight arm stands up
  bendToward: [1, 0, 0],      // a positive shoulder / elbow bend leans it toward +X
  joints: [
    { name: "base", axis: "twist", range: RANGE.base },
    { name: "shoulder", range: RANGE.shoulder },
    { name: "elbow", range: RANGE.elbow },
    { name: "wristPitch", range: RANGE.wristPitch },
    { name: "wristYaw", axis: "spread", range: RANGE.wristYaw },
    { name: "wristRoll", axis: "twist", range: RANGE.wristRoll },
  ],
  lengths: [SHOULDER_H, p.upperLen, p.foreLen, 0, 0, TOOL],
});

// A boss about the X axis (the hinge axis), centred at height y, across the slab [x0, x1].
const boss = (k, y, [x0, x1], r) => k.cylinder({ r, h: x1 - x0 }).along("+X").at([x0, y, 0]);
const box = (k, min, max) => k.box({ min, max });

/** A link of length `len` in its joint frame: a slab rounded about both of its joints. */
function link(k, len, slab, r) {
  return k.union([box(k, [slab[0], 0, -r], [slab[1], len, r]), boss(k, 0, slab, r), boss(k, len, slab, r)]);
}

/** Turret, in the base joint's frame: a turntable disc and the post carrying the shoulder. */
function turret(k) {
  const disc = 18, [x0, x1] = SLAB.turret, r = R.turret;
  return k.union([
    k.cylinder({ r: 46, h: disc }).along("+Y"),
    box(k, [x0, disc, -r], [x1, SHOULDER_H, r]),
    boss(k, SHOULDER_H, SLAB.turret, r),
  ]);
}

/** Wrist ball, flange and palm, in the wrist-roll frame (the tool point is at y = TOOL). */
function hand(k) {
  return k.union([
    k.sphere({ r: WRIST_R }),
    k.cylinder({ r: 9, h: PALM.y0 - 5 }).along("+Y").at([0, 5, 0]),
    box(k, [-PALM.w / 2, PALM.y0, -PALM.d / 2], [PALM.w / 2, PALM.y1, PALM.d / 2]),
  ]);
}

/** One finger at x = 0, from the palm to just past the tool point. */
function finger(k) {
  const { t, d, len } = FINGER;
  return box(k, [-t / 2, PALM.y1, -d / 2], [t / 2, PALM.y1 + len, d / 2]);
}

/** A finger's view: slid out along the hinge axis by half the opening, then posed. */
const fingerAt = (side) => (s, p, d) => d.arm.place(s.translate([side * (p.gripper / 2 + FINGER.t / 2), 0, 0]), "wristRoll");

const deg = (key, label, range, description) => ({ key, label, unit: "°", min: range[0], max: range[1], step: 1, description });
const seed = (key, label) => ({ key, label, unit: "°", min: RANGE[key][0], max: RANGE[key][1], step: 0.01 });

export default {
  meta: { title: "Robot arm", units: "mm" },
  parameters: [
    { id: "tool", title: "Tool goal", description: "Where the tool point (between the fingertips) goes, and which way it points. The arm solves its joints to get there. In Pose mode, drag the tool dot instead.", controls: [
      { key: "toolX", label: "X", unit: "mm", min: -400, max: 400, step: 1 },
      { key: "toolY", label: "Y", unit: "mm", min: -400, max: 400, step: 1 },
      { key: "toolZ", label: "Z", unit: "mm", min: -50, max: 500, step: 1 },
      deg("toolPitch", "Pitch", [-90, 90], "0 points the tool along +X (after yaw); -90 points it straight down."),
      deg("toolYaw", "Yaw", [-180, 180], "Turns the tool's heading about the vertical."),
      deg("toolRoll", "Roll", [-180, 180], "Turns the gripper about its own axis; 0 opens the fingers sideways."),
      { type: "readout", label: "Reach", derivedKey: "reach" },
    ] },
    { id: "gripper", title: "Gripper", controls: [
      { key: "gripper", label: "Opening", unit: "mm", min: 0, max: 40, step: 0.5, description: "Gap between the fingers. Pose-only: it never rebuilds a finger." },
    ] },
    { id: "links", title: "Links", controls: [
      { key: "upperLen", label: "Upper arm", unit: "mm", min: 100, max: 220, step: 1, description: "Shoulder axis to elbow axis. The tool goal holds when it changes." },
      { key: "foreLen", label: "Forearm", unit: "mm", min: 100, max: 200, step: 1, description: "Elbow axis to wrist centre." },
    ] },
    { id: "joints", title: "Joint angles (seed)", collapsed: true,
      description: "Where the solve starts. Pose mode writes the solved angles back here as you drag, so the arm never flips to another solution. Leave them alone: set the tool goal instead. One exception: for a goal behind the arm, set Base to the goal's heading, atan2(y, x) in degrees.",
      controls: [
        seed("base", "Base"), seed("shoulder", "Shoulder"), seed("elbow", "Elbow"),
        seed("wristPitch", "Wrist pitch"), seed("wristYaw", "Wrist yaw"), seed("wristRoll", "Wrist roll"),
      ] },
  ],
  defaults: {
    toolX: 220, toolY: 0, toolZ: 60, toolPitch: -60, toolYaw: 0, toolRoll: 0,
    gripper: 24, upperLen: 160, foreLen: 140,
    // The solved pose for the default goal, so the default solve starts at its answer.
    base: 0, shoulder: 39.58, elbow: 104.03, wristPitch: 6.39, wristYaw: 0, wristRoll: 0,
  },
  derive: (p) => {
    const aim = aimFromAngles({ toward: [1, 0, 0], pitch: p.toolPitch, yaw: p.toolYaw, roll: p.toolRoll });
    const arm = ARM(p).pose({
      bend: Object.fromEntries(JOINTS.map((j) => [j, p[j]])),
      goals: [{ at: "tip", position: [p.toolX, p.toolY, p.toolZ], ...aim }],
    });
    const g = arm.report.goals[0];
    const reach = g.status === "reached" ? "reached" : `${g.status}, ${g.residual.toFixed(1)} mm off`;
    return { arm, reach };
  },
  parts: {
    pedestal: {
      label: "Pedestal",
      build: (k) => k.cylinder({ r: 56, h: BASE_H }),
      views: { assembly: (s) => s },
    },
    turret: {
      label: "Turret",
      build: (k) => turret(k),
      views: { assembly: (s, p, d) => d.arm.place(s, "base") },
    },
    upperArm: {
      label: "Upper arm",
      build: (k, p) => link(k, p.upperLen, SLAB.upper, R.upper),
      views: { assembly: (s, p, d) => d.arm.place(s, "shoulder") },
    },
    forearm: {
      label: "Forearm",
      build: (k, p) => link(k, p.foreLen, SLAB.fore, R.fore),
      views: { assembly: (s, p, d) => d.arm.place(s, "elbow") },
    },
    hand: {
      label: "Wrist and palm",
      build: (k) => hand(k),
      views: { assembly: (s, p, d) => d.arm.place(s, "wristRoll") },
    },
    fingerL: {
      label: "Finger (left)",
      build: (k) => finger(k),
      views: { assembly: fingerAt(-1) },
    },
    fingerR: {
      label: "Finger (right)",
      build: (k) => finger(k),
      views: { assembly: fingerAt(1) },
    },
  },
  views: { assembly: { label: "Assembly" } },
  handles: {
    tool: {
      limb: "arm", at: "tip", mode: "goal",
      params: { position: ["toolX", "toolY", "toolZ"], aim: ["toolPitch", "toolYaw", "toolRoll"] },
      seed: JOINTS,
    },
  },
  // At the default pose the links never interpenetrate, and each keeps its running
  // clearance (GAP) to the neighbour it turns against: those near misses are intended.
  verify: {
    expect: { _view: { overlaps: 0, clearance: { "turret×upperArm": ">=0.3", "upperArm×forearm": ">=0.3", "forearm×hand": ">=0.3" } } },
  },
  // The agent's one-line read-out: { at, residual, aimResidual, status }.
  probes: { tool: (k, p, d) => d.arm.report.goals[0] },
};
