// partforge/mechanisms — gear trains, belts, capstan rope drives, racks and crank-sliders: the motion of parts
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

/** A line source's plain-JSON description (the `lineInfo()` contract): each line's centreline. */
export interface MechanismLines {
  kind: "partforge.lines";
  lines: Record<string, {
    /** "taut": pulled tight (a rope, a belt). */
    mode: "taut";
    /** The line's diameter, mm. */
    d: number;
    /** A loop (a belt) when true. */
    closed: boolean;
    /** The centreline's length, mm (exact, not rounded). */
    length: number;
    /** The tightest bend's diameter over the line's diameter, when the source knows it. */
    bendRatio?: number | null;
    /** The least bend ratio the line's material allows, or null. */
    minBendRatio?: number | null;
    /** The centreline, part coordinates; arcs are sampled. */
    points: Point3[];
  }>;
}

export interface Rope {
  /** Diameter, mm. */
  d: number;
  /** A preset ("uhmwpe"): supplies `mu` and an upper-bound `EA`. An unknown name throws. */
  material?: string;
  /** Friction coefficient against the drum. Wins over the preset. */
  mu?: number;
  /** Axial stiffness, N (force per unit strain). Wins over the preset. */
  EA?: number;
  /** The least drum diameter / rope diameter the rope allows; the report judges against it. */
  minBendRatio?: number;
}

export interface CapstanHalf {
  length: number;
  /** The free span between the members, mm. */
  span: number;
  /** The span's angle off the plane across the axis, degrees. */
  fleet: number;
  /** True when this side has no rope left on a member (the angle is past the travel). */
  runOff: boolean;
  /** Keyed by member name: degrees of rope on it (and turns, on the drum). */
  [member: string]: { wrap: number; turns?: number } | number | boolean;
}

export interface CapstanReport {
  /** Input turns per output turn. */
  ratio: number;
  /** True for an open (uncrossed) rope: both members turn the same way. */
  turnsTogether: boolean;
  angles: Record<string, number>;
  /** The rope's length at this pose and at drive angle 0, and the difference, mm. */
  length: number;
  restLength: number;
  drift: number;
  halves: [CapstanHalf, CapstanHalf];
  /** Drum diameter / rope diameter per member; `required` and `ok` when the rope gives `minBendRatio`. */
  bend: Record<string, number | boolean>;
  /** The drum length the rope covers over the whole travel, at the lead, mm. The same at every pose. */
  drumWidth: number;
  /** Per member: the angles between which no side runs out of rope; `inside` for this pose. */
  travel: Record<string, [number, number] | boolean>;
  /** Only with `fixed: false`: what the whole wrap on the drum holds, e^(mu · wrap). The same at every angle. */
  holding?: { needs: "rope.mu" } | { mu: number; wrap: number; ratio: number };
  /** Only when the rope's EA is known. `upperBound` when it came from a preset. */
  stiffness?: { rope: [number, number]; joint: number; unit: string; upperBound: boolean };
  /** EA · drift / restLength, N. */
  tensionChange?: number;
  /** Only with `pretension`: the drift has taken the pretension to zero. */
  slack?: boolean;
}

export interface Capstan {
  /** Input turns per output turn: the pitch radii's ratio. */
  ratio: number;
  angleOf(name: string): number;
  /** `<member>.center`, `<member>.rim`; an axis per member; one line between them. */
  handleInfo(): MechanismPoints;
  /** The rope's centreline at this pose, under the name "rope". */
  lineInfo(): MechanismLines;
  /** What the rope is doing at this pose; a probe can return it unchanged. */
  report(): CapstanReport;
  place<T extends Placeable<T>>(name: string, solid: T): T;
}

/**
 * A rope drive: the rope is terminated on the output at both ends and wound round the
 * input drum in between. Radii are groove radii; the rope's centreline runs d / 2 outside.
 * A pulley whose centre sits along the axis from the drum's leans both spans.
 * Throws when the axes are not parallel, when the members' rope circles overlap across the
 * axis, or when a member is named after a report field.
 */
export function capstan(def: {
  rope: Rope;
  /** `turns` (default 3): whole turns on the drum beyond what the tangents leave. `lead` (default `rope.d`): helix advance per turn. */
  input: { name: string; radius: number; center: Point3; axis?: Point3; turns?: number; lead?: number };
  /** `wrap` (default 90): degrees of rope on the output past each tangent point at drive angle 0. */
  output: { name: string; radius: number; center: Point3; axis?: Point3; wrap?: number };
  drive: { member: string; angle: number };
  /** Default true: the spans cross and the members turn opposite ways. */
  cross?: boolean;
  /** Default true: the rope is pinned to the drum. False: friction alone, and the report adds `holding`. */
  fixed?: boolean;
  /** N. With the rope's EA, the report adds `slack`. */
  pretension?: number;
}): Capstan;
