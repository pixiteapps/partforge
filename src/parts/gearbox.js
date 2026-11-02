// A three-gear train on a base plate: the reference part for rotary handles and the
// mechanisms domain (docs/domains/mechanisms.md). Grab any gear in Pose mode and turn
// it: every gear follows at its own ratio, past 360° with no stop. The crank on the input
// gear turns the same train.
//
// How it fits together:
// - derive() calls gearTrain once with the one motion parameter, driveAngle. The train
//   answers each gear's angle, the points a handle grabs (`<gear>.rim`) and each gear's
//   axis, and places each gear's solid.
// - Every gear is built once about +Z at the origin and placed with d.train.place, so
//   turning the train is matrix-only: no gear rebuilds while you drag or play `spin`.
// - Each gear's teeth start at a phase (`PHASE`) that makes them mesh at driveAngle 0.
//   The phase is fixed, so it lives in the build; the train's ratios keep the teeth in
//   mesh at every other angle.
// - Every handle writes driveAngle, a `wrap: true` parameter: a drag through two turns
//   stores 720, and the slider shows it reduced into 0..360.
import { gearTrain } from "partforge/mechanisms";
import { circleProfile } from "partforge/geometry";

const MODULE = 2;
const T = 8;             // gear thickness
const PLATE_T = 6;       // base plate thickness
const WASHER = 1;        // gap between the plate and a gear
const GEAR_Z = PLATE_T + WASHER + T / 2; // gear mid-plane
const AXLE_R = 4;
const BORE_R = AXLE_R + 0.3;
const CRANK_R = 15;      // the crank knob's distance from the input axis
const KNOB_H = 14;

const pitchR = (teeth) => (MODULE * teeth) / 2;
const polar = (c, r, deg) => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180)];

// Centres: gear2 beside gear1, gear3 up and to the right of gear2, each at the sum of
// the pitch radii from the gear it meshes with.
const MESH3 = 35; // degrees: the direction from gear2 to gear3
const C1 = [0, 0];
const C2 = polar(C1, pitchR(20) + pitchR(30), 0);
const C3 = polar(C2, pitchR(30) + pitchR(40), MESH3);
const GEARS = [
  { name: "gear1", label: "Input gear", teeth: 20, at: C1 },
  { name: "gear2", label: "Idler gear", teeth: 30, at: C2, meshesWith: "gear1", dir: 0 },
  { name: "gear3", label: "Output gear", teeth: 40, at: C3, meshesWith: "gear2", dir: MESH3 },
];

// Tooth phase, degrees: the angle of one tooth's centre at driveAngle 0. A tooth of A
// at δ before the line to B meets B at δ·NA/NB past the opposite direction, so B puts
// a gap there: its tooth sits half a pitch on.
const mod = (a, m) => ((a % m) + m) % m;
const PHASE = {};
for (const g of GEARS) {
  if (!g.meshesWith) { PHASE[g.name] = 0; continue; }
  const a = GEARS.find((o) => o.name === g.meshesWith);
  const delta = mod(g.dir - PHASE[a.name], 360 / a.teeth);
  PHASE[g.name] = mod(g.dir + 180 + (delta * a.teeth) / g.teeth + 180 / g.teeth, 360 / g.teeth);
}

/** A spur gear's outline: straight-flanked teeth between the root and tip circles. */
function gearOutline(teeth, phase) {
  const r = pitchR(teeth), ra = r + MODULE, rr = r - 1.25 * MODULE, p = 360 / teeth;
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const c = phase + i * p;
    pts.push(polar([0, 0], rr, c - 0.32 * p), polar([0, 0], ra, c - 0.13 * p), polar([0, 0], ra, c),
      polar([0, 0], ra, c + 0.13 * p), polar([0, 0], rr, c + 0.32 * p), polar([0, 0], rr, c + 0.5 * p));
  }
  return pts;
}

/** A gear about +Z, centred on z = 0: the toothed rim, a bore, and lightening holes on the larger gears. */
function gear(k, teeth, phase) {
  const holes = [circleProfile(BORE_R)];
  const rr = pitchR(teeth) - 1.25 * MODULE;
  if (teeth >= 30) {
    const ring = (rr + BORE_R) / 2, hr = Math.min((rr - BORE_R - 10) / 2, 9);
    for (let i = 0; i < 5; i++) holes.push(circleProfile(hr, polar([0, 0], ring, 36 + i * 72)));
  }
  return k.extrude({ profile: { outer: gearOutline(teeth, phase), holes }, h: T }).translate([0, 0, -T / 2]);
}

/** The crank, in the input gear's frame: a hub, an arm along +X and a knob standing on its end. */
function crank(k) {
  const z0 = T / 2, arm = 5;
  return k.union([
    k.cylinder({ r: 7, h: arm }).translate([0, 0, z0]),
    k.box({ min: [0, -4, z0], max: [CRANK_R, 4, z0 + arm] }),
    k.cylinder({ r: 5, h: arm }).translate([CRANK_R, 0, z0]),
    k.cylinder({ r: 3.5, h: KNOB_H }).translate([CRANK_R, 0, z0 + arm]),
  ]);
}

/** The base plate: a slab under all three gears with an axle under each. */
function plate(k) {
  const margin = 10;
  const xs = GEARS.flatMap((g) => [g.at[0] - pitchR(g.teeth), g.at[0] + pitchR(g.teeth)]);
  const ys = GEARS.flatMap((g) => [g.at[1] - pitchR(g.teeth), g.at[1] + pitchR(g.teeth)]);
  const slab = k.box({ min: [Math.min(...xs) - margin, Math.min(...ys) - margin, 0], max: [Math.max(...xs) + margin, Math.max(...ys) + margin, PLATE_T] });
  const axles = GEARS.map((g) => k.cylinder({ r: AXLE_R, h: GEAR_Z + T / 2 - PLATE_T + (g.name === "gear1" ? 0 : 2) }).translate([g.at[0], g.at[1], PLATE_T]));
  return k.union([slab, ...axles]);
}

const ROT = (name) => (s, p, d) => d.train.place(name, s);

export default {
  meta: { title: "Gearbox", units: "mm" },
  parameters: [
    { id: "motion", title: "Motion", description: "Turn the input. In Pose mode, grab any gear or the crank and turn it instead.", controls: [
      { key: "driveAngle", label: "Input angle", unit: "°", min: 0, max: 360, step: 0.1, wrap: true,
        description: "The input gear's angle. It turns without end: the idler follows at -20/30 and the output at 20/40." },
      { type: "readout", label: "Output angle", derivedKey: "outputAngle" },
    ] },
  ],
  defaults: { driveAngle: 0 },
  derive: (p) => {
    const train = gearTrain({
      gears: GEARS.map((g) => ({ name: g.name, teeth: g.teeth, module: MODULE, center: [g.at[0], g.at[1], GEAR_Z], meshesWith: g.meshesWith })),
      drive: { gear: "gear1", angle: p.driveAngle },
    });
    const a = train.angleOf("gear1");
    const knob = polar(C1, CRANK_R, a);
    return {
      train,
      crankKnob: [knob[0], knob[1], GEAR_Z + T / 2 + 5 + KNOB_H],
      outputAngle: `${(Math.round(train.angleOf("gear3") * 10) / 10).toFixed(1)}°`,
    };
  },
  parts: {
    plate: { label: "Base plate", build: (k) => plate(k), views: { gearbox: (s) => s } },
    gear1: { label: "Input gear (20 teeth)", build: (k) => gear(k, 20, PHASE.gear1), views: { gearbox: ROT("gear1") } },
    gear2: { label: "Idler gear (30 teeth)", build: (k) => gear(k, 30, PHASE.gear2), views: { gearbox: ROT("gear2") } },
    gear3: { label: "Output gear (40 teeth)", build: (k) => gear(k, 40, PHASE.gear3), views: { gearbox: ROT("gear3") } },
    crank: { label: "Crank", build: (k) => crank(k), views: { gearbox: ROT("gear1") } },
  },
  views: {
    gearbox: {
      label: "Gearbox",
      animations: {
        spin: {
          label: "Spin",
          description: "One turn of the input. Pose-only: the gears turn by matrix, never rebuilt.",
          duration: 6, loop: true, easing: "linear",
          tracks: { driveAngle: [[0, 0], [1, 360]] },
        },
      },
    },
  },
  // At driveAngle 0 the teeth mesh with a little backlash and each gear runs free on
  // its axle: no sub-parts interpenetrate, and those near misses are intended.
  verify: {
    expect: { _view: { overlaps: 0, clearance: {
      "plate×gear1": ">=0.29", "plate×gear2": ">=0.29", "plate×gear3": ">=0.29",
      "gear1×gear2": ">=0.1", "gear2×gear3": ">=0.1",
    } } },
  },
  handles: {
    ...Object.fromEntries(GEARS.map((g) => [g.name, {
      on: "train", at: `${g.name}.rim`, params: ["driveAngle"], drag: "rotary", label: g.label, showOn: g.name,
    }])),
    crank: {
      point: (p, d) => d.crankKnob, params: ["driveAngle"], drag: "rotary",
      axis: { origin: [C1[0], C1[1], GEAR_Z], direction: [0, 0, 1] }, label: "Crank", showOn: "crank",
    },
  },
};
