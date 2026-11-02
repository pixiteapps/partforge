// partforge/mechanisms — gear trains, belts, racks and crank-sliders: the motion of parts
// that move together, computed in derive. Each helper is a point source for handles and
// places its members' solids. Worker-safe: plain maths, no geometry built.

import type { Point3 } from "./geometry.js";

/** Anything `place` can turn and move: a Solid. */
export interface Placeable<T> {
  rotate(deg: number, center: Point3, axis: Point3): T;
  translate(v: Point3): T;
}

/** A point source's plain-JSON description (the `handleInfo()` contract handles read). */
export interface MechanismPoints {
  kind: "partforge.points";
  /** Named points, part coordinates. */
  points: Record<string, Point3>;
  /** Named axes; a rotary handle at "<name>.<point>" turns about `axes[name]`. */
  axes: Record<string, { origin: Point3; direction: Point3 }>;
  /** Point-name pairs Pose mode draws as a skeleton with the handles. */
  lines: Array<[string, string]>;
}

export interface Gear {
  /** No "." in the name: points are "<name>.center" and "<name>.rim". */
  name: string;
  teeth: number;
  /** Pitch radius is `module * teeth / 2`, mm. */
  module: number;
  center: Point3;
  /** Default [0, 0, 1]. A positive angle turns the gear counter-clockwise about it. */
  axis?: Point3;
  /** The gear(s) this one meshes with. */
  meshesWith?: string | string[];
  /** A ring gear: its meshes keep the turning direction. */
  internal?: boolean;
}

export interface GearTrain {
  /** The gear's angle, degrees, unreduced. */
  angleOf(name: string): number;
  /** `<gear>.center`, `<gear>.rim`; an axis per gear; a line per mesh. */
  handleInfo(): MechanismPoints;
  /** A solid built about +Z through the origin, turned to the gear's angle and set on its axis at its centre. */
  place<T extends Placeable<T>>(name: string, solid: T): T;
}

/**
 * Every gear's angle from one drive angle: across a mesh it scales by `-teethA / teethB`
 * (`+` when either gear is internal). Throws on an unknown `meshesWith`, a gear not
 * connected to the drive, or a loop of meshes whose ratios disagree.
 */
export function gearTrain(def: { gears: Gear[]; drive: { gear: string; angle: number } }): GearTrain;

export interface Pulley {
  name: string;
  /** Pitch diameter, mm. */
  diameter: number;
  center: Point3;
  /** Default [0, 0, 1]. */
  axis?: Point3;
}

export interface BeltDrive {
  angleOf(name: string): number;
  /** `<pulley>.center`, `<pulley>.rim`, and `belt` (the top of the first pulley's pitch circle). */
  handleInfo(): MechanismPoints;
  place<T extends Placeable<T>>(name: string, solid: T): T;
}

/** Pulleys on one belt, all turning the same way: a pulley's angle is `angle * dDrive / d`. */
export function beltDrive(def: { pulleys: Pulley[]; drive: { pulley: string; angle: number } }): BeltDrive;

export interface Rack {
  /** How far the rack has moved along `direction`, mm: `rad(angle) * module * teeth / 2`. */
  travel: number;
  /** `<pinion>.center`, `<pinion>.rim`, `<rack>.pitch`. */
  handleInfo(): MechanismPoints;
  /** The pinion: turned about its axis and set at its centre. The rack (built where it sits at travel 0): slid by `travel`. */
  place<T extends Placeable<T>>(name: string, solid: T): T;
}

/** A pinion and a straight rack. The rack meshes on the side `direction × axis`. */
export function rack(def: {
  pinion: { name: string; teeth: number; module: number; center: Point3; axis?: Point3; angle: number };
  /** Where the rack moves for a positive pinion angle; at right angles to the axis. */
  direction: Point3;
  /** The rack's name, default "rack". */
  name?: string;
}): Rack;

export interface CrankSlider {
  crankPin: Point3;
  slider: Point3;
  /** `crank.center`, `crank.pin`, `slider`; the axis `crank`. */
  handleInfo(): MechanismPoints;
  /** "crank" (from its pivot), "rod" (from the crank pin, along +X), "slider" (centred), each built with the slide direction along +X. */
  place<T extends Placeable<T>>(name: "crank" | "rod" | "slider", solid: T): T;
}

/** An in-line slider-crank from the closed form. Throws when `rod` is shorter than the crank. */
export function crankSlider(def: {
  crank: { center: Point3; axis?: Point3; length: number; angle: number };
  rod: number;
  slideDirection: Point3;
}): CrankSlider;
