// A capstan rope joint: a small motor drum and a large output pulley, roped together. The
// reference part for the lines core and the capstan section of docs/domains/mechanisms.md.
// Turn the motor and the pulley turns the other way, 6.6/30.6 as far, with no teeth and no
// backlash.
//
// How it fits together:
// - derive() calls capstan once with the one motion parameter, motorAngle. The drive
//   answers each member's angle, the rope's path (lineInfo) and the rope report.
// - Both members are built once about +Z, centred on z = 0, and placed with d.drive.place,
//   so turning the joint is matrix-only: nothing rebuilds while it turns.
// - `lines` names the rope, so measure reports its length and bend ratio at the pose, and
//   the motorAngle sweep reads how far its length moves over the whole travel. The
//   `lineDrift` gate holds that under 0.2 mm: a rope that changes length goes slack, or
//   pulls itself tight, as the joint turns.
// - The `rope` probe returns the full report (wraps, fleet, travel, stiffness) at the pose.
import { capstan } from "partforge/mechanisms";

const ROPE_D = 1.2;
const DRUM_R = 6;        // groove radius the rope sits on
const PULLEY_R = 30;
const CENTER = 40;       // drum axis to pulley axis
const FLANGE = 1.5;      // flange height above each groove
const FLANGE_T = 1;
const DRUM_W = 9;        // the wound band reaches 8.6 mm along the drum over the travel (report.drumWidth)
const PULLEY_W = 7;      // its two grooves sit 2.3 mm either side of the middle
const BORE_R = 2.5;

const drive = (angle) => capstan({
  rope: { d: ROPE_D, material: "uhmwpe" },
  input: { name: "drum", radius: DRUM_R, center: [0, 0, 0], turns: 3 },
  output: { name: "pulley", radius: PULLEY_R, center: [CENTER, 0, 0] },
  drive: { member: "drum", angle },
});

/** A grooved wheel about +Z, centred on z = 0: a core at the groove radius between two flanges, and a bore. */
function wheel(k, r, w) {
  const flange = (z) => k.cylinder({ r: r + FLANGE, h: FLANGE_T }).translate([0, 0, z]);
  return k.union([
    k.cylinder({ r, h: w }).translate([0, 0, -w / 2]),
    flange(-w / 2 - FLANGE_T),
    flange(w / 2),
  ]).cut(k.cylinder({ r: BORE_R, h: w + 4 * FLANGE_T }).translate([0, 0, -w / 2 - 2 * FLANGE_T]));
}

const PLACE = (name) => (s, p, d) => d.drive.place(name, s);

export default {
  meta: { title: "Capstan joint", units: "mm" },
  parameters: [
    { id: "motion", title: "Motion", description: "Turn the motor drum; the pulley follows the other way.", controls: [
      { key: "motorAngle", label: "Motor angle", unit: "°", min: -200, max: 200, step: 1,
        description: "The drum's angle. The rope runs off a member at about ±417°, so this range stays well inside it." },
      { type: "readout", label: "Pulley angle", derivedKey: "pulleyAngle" },
    ] },
  ],
  defaults: { motorAngle: 0 },
  derive: (p) => {
    const d = drive(p.motorAngle);
    return { drive: d, pulleyAngle: `${(Math.round(d.angleOf("pulley") * 10) / 10).toFixed(1)}°` };
  },
  parts: {
    drum: { label: "Motor drum", build: (k) => wheel(k, DRUM_R, DRUM_W), views: { assembly: PLACE("drum") } },
    pulley: { label: "Output pulley", build: (k) => wheel(k, PULLEY_R, PULLEY_W), views: { assembly: PLACE("pulley") } },
  },
  views: { assembly: { label: "Assembly" } },
  // The rope, read off derive().drive.lineInfo(): measure().lines, and each sweep row's `lines`.
  lines: { rope: { on: "drive" } },
  probes: { rope: (k, p, d) => d.drive.report() },
  // Over the motor's whole range: the flanges never touch (1 mm apart across the axis), and
  // the rope's length moves by less than 0.2 mm.
  verify: {
    sweeps: { drive: { param: "motorAngle" } },
    expect: { _view: { lineDrift: "<=0.2", sweepContacts: 0 } },
  },
  handles: {
    drum: { on: "drive", at: "drum.rim", params: ["motorAngle"], drag: "rotary", label: "Motor drum", showOn: "drum" },
  },
};
