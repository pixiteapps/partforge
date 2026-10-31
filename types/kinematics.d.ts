// partforge/kinematics — jointed limbs: declare a chain once, pose it, place solids on it.
// Worker-safe: plain JS over core's rigid-transform frames, no three.js, no DOM, no implicit engine.

import type { Point3, RotateStep } from "./geometry.js";

/** A joint's rotation axis: a named hinge axis of the limb's frame, or an explicit direction. */
export type LimbAxis = "bend" | "spread" | "twist" | Point3;

/** One frame in core's shared frame shape: where it sits in its parent, and how it is turned. */
export interface LimbFrame {
  /** Name of the parent frame; absent for a root frame in part coordinates. */
  parent?: string;
  at: Point3;
  /** Frame-style steps, each about the CURRENT axes. */
  rotate?: RotateStep[];
}

/** One joint of a limb; a bare string is a joint with the default options. */
export interface LimbJoint {
  name: string;
  /** Default "bend". Not on a ball joint. */
  axis?: LimbAxis;
  /** Distance to the next joint (or the tip), mm; falls back to `lengths[i]`. */
  length?: number;
  /** Allowed values, degrees. Not on a ball joint (it takes `cone`). */
  range?: [number, number];
  /** Drive this joint from an earlier hinge: value = ratio * that joint + offset (degrees). Not on a ball joint. */
  follow?: { joint: string; ratio?: number; offset?: number };
  /** Default "hinge". A "ball" turns about any axis through its centre and is posed with a `LimbBallValue`. */
  type?: "hinge" | "ball";
  /** A ball joint's largest swing from rest, degrees (0 < cone ≤ 180, default 180). */
  cone?: number;
  /** Where this joint sits, mm, in the previous joint's frame, added to the end of the previous segment ([0, length, 0]). Not on the base joint. */
  offset?: Point3;
}

/** A ball joint's pose: one swing of √(bend² + spread²) degrees, then a twist about the swung segment; absent keys 0. */
export interface LimbBallValue { bend?: number; spread?: number; twist?: number }

/** A ball joint's final value, every key present. */
export interface LimbBallResult { bend: number; spread: number; twist: number }

export interface LimbDefinition {
  /** Frame the limb hangs from; omit for part coordinates. */
  parent?: string;
  /** Where the limb's base sits in its parent frame (or part coordinates), mm. */
  at?: Point3;
  /** Direction the limb points at rest, and the direction its bends curl toward. */
  toward?: Point3;
  bendToward?: Point3;
  /** Escape hatch instead of toward/bendToward. */
  rotate?: RotateStep | RotateStep[];
  /** Reflect the limb across a plane (needs toward/bendToward). */
  mirror?: "XY" | "XZ" | "YZ";
  joints: Array<string | LimbJoint>;
  /** Distance to the next joint (or the tip) per joint, mm. */
  lengths?: number[];
  /** Radius per joint, then the tip, mm. */
  r?: number[];
}

/**
 * A plain shape grip can close on, in part coordinates (never a `frame`): `{ kind, ...fields }`
 * with k.implicit's field names. sphere, ellipsoid, capsule, box, cylinder, torus, tube,
 * halfspace, and an unblended `union` of those. Any other kind, or a union with `k > 0`, throws
 * and asks for a distance function instead.
 */
export interface LimbShapeNode {
  kind: "sphere" | "ellipsoid" | "capsule" | "box" | "cylinder" | "torus" | "tube" | "halfspace" | "union";
  [field: string]: unknown;
}

/** A signed distance in mm (negative inside), finite everywhere; called as `around(x, y, z)`. */
export type LimbDistanceFunction = (x: number, y: number, z: number) => number;

export interface LimbGripOptions {
  /** The shape to close on: a plain shape node or a distance function, in part coordinates. */
  around: LimbShapeNode | LimbDistanceFunction;
  /** Gap left between the links and the shape, mm. */
  clearance?: number;
  /** Radius per joint, then the tip, mm; defaults to the limb's `r`. */
  r?: number[];
}

export interface LimbPoseOptions {
  /** Driven-joint values in order, or by joint name; degrees, or a `LimbBallValue` for a ball joint. */
  bend?: Array<number | LimbBallValue> | Record<string, number | LimbBallValue>;
  /** 0..1 from each bend joint's straightest in-range value (nearest 0) to its closing end (range[1], or range[0] for an all-negative range); equals curl × range[1] for ranges containing 0. Not together with `bend`. */
  curl?: number;
  /** Sideways swing of the limb at its base, degrees. */
  spread?: number;
  /** Roll of the limb about its own length, degrees. */
  twist?: number;
  /** Aim the tip at this point (part coordinates, mm). Not with `grip` or `goals`. */
  reach?: Point3;
  /** Close the bend joints on a shape until contact. Not with `reach` or `goals`. */
  grip?: LimbGripOptions;
  /**
   * Pose joints or the tip toward positions and directions by damped least squares, warm-started
   * from `bend`/`curl` (joints the solve does not move keep those values). Not with `reach` or `grip`.
   */
  goals?: LimbGoal[];
  /** Joints `goals` may not move: held at their `bend` value; their followers still follow. Needs `goals`. */
  pins?: string[];
}

/**
 * One goal for `pose({ goals })`, in part coordinates (never reflected). At least one of
 * `position`, `aim`, `up`. Direction misses count as (unit difference × 100) mm, so 1° ≈ 1.75 mm.
 */
export interface LimbGoal {
  /** A joint name, its frame name, or "tip". A goal at a joint moves only the joints above it. */
  at: string;
  /** Where the frame's origin should be, mm. */
  position?: Point3;
  /** The direction the frame's +Y (its segment, `toward` at rest) should point. */
  aim?: Point3;
  /** The direction the frame's −Z (the side `bendToward` names) should point; fixes the roll about `aim`. */
  up?: Point3;
  /** Default 1; scales this goal's residuals against the others. */
  weight?: number;
}

/**
 * `reached`: within 0.01 mm and 0.1°. `too-far`: the position lies beyond the segments from the first
 * moving joint. `conflict`: with two or more goals, this one is better met alone. `out-of-range`: anything else.
 */
export type LimbGoalStatus = "reached" | "too-far" | "out-of-range" | "conflict";

export type LimbReachStatus = "reached" | "too-far" | "too-close" | "out-of-range";

export interface LimbReport {
  /** Final joint values, degrees (a ball joint's as an object). */
  bend: Array<number | LimbBallResult>;
  clamped: boolean[];
  /** Tip in part coordinates; absent for a parented limb posed without frames. */
  tip?: Point3;
  reach?: { target: Point3; residual: number; status: LimbReachStatus };
  /**
   * One entry per driven bend joint. `skipped`: grip did not close it (an earlier joint's contact
   * already holds the limb), so `bend` is its start value and `touched` is false. Otherwise
   * `touched`: its own close made contact that still holds in the final pose.
   */
  grip?: { touching: boolean; gap: number; joints: Array<{ joint: string; bend: number; touched: boolean; skipped: boolean }> };
  /** One entry per goal: position miss in mm; `aimResidual` (degrees, the larger of the aim and up misses) only for a goal with `aim` or `up`. */
  goals?: Array<{ at: string; residual: number; aimResidual?: number; status: LimbGoalStatus }>;
}

/** The rigid frame of a joint in part coordinates: its origin and unit axes. */
export interface LimbWorldFrame { origin: Point3; x: Point3; y: Point3; z: Point3 }

export interface PosedLimb {
  /** Final joint values, one per joint, degrees (a ball joint's as an object). */
  values: Array<number | LimbBallResult>;
  /** One frame per joint plus `<name>.tip`. */
  frames: Record<string, LimbFrame>;
  /** The joints' FRAME names (`<limb>.<joint>`), in order; `place` and `world` also take the bare joint name. */
  joints: string[];
  /** The tip's frame name (`<limb>.tip`). */
  tip: string;
  report: LimbReport;
  /**
   * Move a solid into a frame of the limb. `joint` is a joint name, a frame name, or "tip"; default the base joint.
   * `from: "joint"` (default): the solid was built at the origin, along +y. `from: "rest"`: it was built in part
   * coordinates with the whole chain at rest (every joint 0), and moves by that joint's rest-to-posed motion.
   */
  place<T extends { rotate(deg: number, center: Point3, axis: Point3): T; translate(v: Point3): T }>(x: T, joint?: string, opts?: { from?: "joint" | "rest" }): T;
  /** A frame of the limb in part coordinates. `joint` is a joint name, a frame name, or "tip"; default the base joint. */
  world(joint?: string): LimbWorldFrame;
}

/** What a limb hangs from: fixed frames, a posed limb, or a list of them. */
export type LimbParents = Record<string, LimbFrame> | PosedLimb | Array<Record<string, LimbFrame> | PosedLimb>;

export interface Limb {
  name: string;
  /** The joints' frame names (`<name>.<joint>`), in order. */
  joints: string[];
  /** The tip's frame name (`<name>.tip`). */
  tip: string;
  /**
   * `frames` are the parent's frames, needed by reach, grip, goals, place, world and tip when the limb has a `parent`:
   * a `{ name: frame }` object, a posed limb (its whole chain), or an array of them, later entries winning.
   */
  pose(opts?: LimbPoseOptions, frames?: LimbParents): PosedLimb;
}

/** Declare a jointed chain once; pose it as often as needed. */
export function limb(name: string, def: LimbDefinition): Limb;

/**
 * Pitch, yaw and roll (degrees) → unit `aim` and `up` for a goal. Zero is `toward`; yaw turns about part +Z,
 * then pitch about the yawed horizontal axis at right angles to the aim (positive lifts it toward `up`).
 * `up` starts as part +Z (or +Y when `toward` is vertical); `roll`, when given, turns it about the aim and
 * `up` is returned.
 */
export function aimFromAngles(opts: { toward: Point3; pitch?: number; yaw?: number; roll?: number }): { aim: Point3; up?: Point3 };
