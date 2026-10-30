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
  /** Default "bend". */
  axis?: LimbAxis;
  /** Distance to the next joint (or the tip), mm; falls back to `lengths[i]`. */
  length?: number;
  /** Allowed values, degrees. */
  range?: [number, number];
  /** Drive this joint from an earlier one: value = ratio * that joint + offset (degrees). */
  follow?: { joint: string; ratio?: number; offset?: number };
  type?: "hinge";
}

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
  /** Driven-joint values in order, or by joint name; degrees. */
  bend?: number[] | Record<string, number>;
  /** 0..1 from each bend joint's straightest in-range value (nearest 0) to its closing end (range[1], or range[0] for an all-negative range); equals curl × range[1] for ranges containing 0. Not together with `bend`. */
  curl?: number;
  /** Sideways swing of the limb at its base, degrees. */
  spread?: number;
  /** Roll of the limb about its own length, degrees. */
  twist?: number;
  /** Aim the tip at this point (part coordinates, mm). Not with `grip`. */
  reach?: Point3;
  /** Close the bend joints on a shape until contact. Not with `reach`. */
  grip?: LimbGripOptions;
}

export type LimbReachStatus = "reached" | "too-far" | "too-close" | "out-of-range";

export interface LimbReport {
  /** Final joint values, degrees. */
  bend: number[];
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
}

/** The rigid frame of a joint in part coordinates: its origin and unit axes. */
export interface LimbWorldFrame { origin: Point3; x: Point3; y: Point3; z: Point3 }

export interface PosedLimb {
  /** Final joint values, one per joint, degrees. */
  values: number[];
  /** One frame per joint plus `<name>.tip`. */
  frames: Record<string, LimbFrame>;
  /** The joints' FRAME names (`<limb>.<joint>`), in order; `place` and `world` also take the bare joint name. */
  joints: string[];
  /** The tip's frame name (`<limb>.tip`). */
  tip: string;
  report: LimbReport;
  /** Move a solid (built at the origin, along +y) into a frame of the limb. `joint` is a joint name, a frame name, or "tip"; default the base joint. */
  place<T extends { rotate(deg: number, center: Point3, axis: Point3): T; translate(v: Point3): T }>(x: T, joint?: string): T;
  /** A frame of the limb in part coordinates. `joint` is a joint name, a frame name, or "tip"; default the base joint. */
  world(joint?: string): LimbWorldFrame;
}

export interface Limb {
  name: string;
  /** The joints' frame names (`<name>.<joint>`), in order. */
  joints: string[];
  /** The tip's frame name (`<name>.tip`). */
  tip: string;
  /** `frames` are the parent's frames, needed by reach, grip, place, world and tip when the limb has a `parent`. */
  pose(opts?: LimbPoseOptions, frames?: Record<string, LimbFrame>): PosedLimb;
}

/** Declare a jointed chain once; pose it as often as needed. */
export function limb(name: string, def: LimbDefinition): Limb;
