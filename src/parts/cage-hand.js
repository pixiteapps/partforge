// A posable hand from one subdivision cage: the organic domain's reference part for Pose
// mode on a k.subdiv body. The cage is the guide's handCage (docs/domains/organic.md,
// "Worked example: a hand that curls"); here each digit's bends come from a limb posed in
// derive instead of one curl param, so Pose mode can drag a fingertip.
//
// Authoring frame: the palm faces -Y, the fingers point to +Z, the thumb leaves the +X side.
// One cage, no mirror. Each finger is a limb of three joints (mcp, pip, and dip following
// pip by 0.75) whose segment lengths are the cage's own, starting at the middle of the
// first knuckle; the thumb is a limb of one joint. A knuckle in the cage is three 6 mm
// rings centred on its joint, each turning a third of the joint's angle about the centre
// of the face it grew from, so the cage bends where the limb does and its tip follows the
// limb's tip. A pose moves the cage's points and never changes its faces.
import { limb } from "partforge/kinematics";

const RING = 6;                     // a knuckle ring's length (mm); three per knuckle
const NECK = 5;                     // each finger's neck out of the palm (mm)
const PALM = { size: [78, 28, 80], center: [0, 0, 60], segs: [4, 1, 2], topScale: 1.08 };
const PALM_TOP = PALM.center[2] + PALM.size[2] / 2;
// Per finger: the column of the palm's top face it grows from, and the cage's segment
// lengths, which are the limb's. The face's centre along X follows from its column: the
// four top faces split the palm's width, then the top row is widened by topScale about X = 0.
const FINGERS = {
  index:  { col: 3, lengths: [37, 27, 23] },
  middle: { col: 2, lengths: [41, 30, 24] },
  ring:   { col: 1, lengths: [38, 28, 23] },
  pinky:  { col: 0, lengths: [30, 23, 21] },
};
for (const f of Object.values(FINGERS)) {
  f.face = `+z:${f.col},0`;
  f.x = (-PALM.size[0] / 2 + (PALM.size[0] / PALM.segs[0]) * (f.col + 0.5)) * PALM.topScale;
}
// The thumb: a root out of the palm's lower +X face, turned 45° about Y so it points up
// and out, then a straight run to its one joint and one segment past it, curling toward
// the palm side (-Y).
const THUMB_ROOT = 8;
const THUMB_RUN = 20;               // root face to joint (mm)
const THUMB_LENGTH = 30;            // joint to tip (mm)
const THUMB_DIR = [Math.SQRT1_2, 0, Math.SQRT1_2];
// The root cap's centre: the lower +X face's centre, THUMB_ROOT out (the turn is about it).
const THUMB_ROOT_AT = [PALM.size[0] / 2 + THUMB_ROOT, 0, PALM.center[2] - PALM.size[2] / 4];
const THUMB_BEND = [0, -1, 0];
// The cage turns a bend about toward × bendToward, as a limb bends.
const THUMB_AXIS = [
  THUMB_DIR[1] * THUMB_BEND[2] - THUMB_DIR[2] * THUMB_BEND[1],
  THUMB_DIR[2] * THUMB_BEND[0] - THUMB_DIR[0] * THUMB_BEND[2],
  THUMB_DIR[0] * THUMB_BEND[1] - THUMB_DIR[1] * THUMB_BEND[0],
];

const RANGE = { knuckle: [-10, 90], curl: [0, 110], thumbCurl: [0, 60] };
const DIGITS = [...Object.keys(FINGERS), "thumb"];
const LABEL = { index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky", thumb: "Thumb" };

/** Every digit posed: the four fingers on the palm's top, the thumb on its side. */
function poseDigits(p) {
  const out = {};
  for (const [name, f] of Object.entries(FINGERS)) {
    out[name] = limb(name, {
      // The first knuckle's rings start at the neck's end, so its middle ring (the joint)
      // starts one ring further out.
      at: [f.x, 0, PALM_TOP + NECK + RING],
      toward: [0, 0, 1],
      bendToward: [0, -1, 0],
      joints: [
        { name: "mcp", range: RANGE.knuckle },
        { name: "pip", range: RANGE.curl },
        { name: "dip", range: [0, RANGE.curl[1] * 0.75], follow: { joint: "pip", ratio: 0.75 } },
      ],
      lengths: f.lengths,
    }).pose({ bend: { mcp: p[`${name}Knuckle`], pip: p[`${name}Curl`] } });
  }
  out.thumb = limb("thumb", {
    at: THUMB_ROOT_AT.map((v, i) => v + THUMB_RUN * THUMB_DIR[i]),
    toward: THUMB_DIR,
    bendToward: THUMB_BEND,
    joints: [{ name: "ip", range: RANGE.thumbCurl }],
    lengths: [THUMB_LENGTH],
  }).pose({ bend: { ip: p.thumbCurl } });
  return out;
}

/**
 * The hand's cage. `make` is k.cage (or partforge/organic's cage); `bends` maps each digit
 * to its posed limb's `values`: the joint angles in degrees, in the limb's joint order
 * (a finger's [mcp, pip, dip], the thumb's [ip]).
 */
export function cageHand(make, p, bends) {
  const c = make({ box: { size: PALM.size, center: PALM.center, segs: PALM.segs } });
  c.scale(c.faces("+z:"), [PALM.topScale, 1, 1]);
  const w = c.extrude(c.faces("-z:"), { by: 14, scale: [0.62, 0.85, 1], id: "wrist" });
  c.extrude(w, { by: 22, id: "arm" });
  // One ring of a bend: extrude, then swing the new cap about the centre of the face it
  // grew from. The next extrude follows the turned cap.
  const ring = (cur, deg, axis, opts) => {
    const hinge = c.centroid(cur);
    const cap = c.extrude(cur, { by: RING, ...opts });
    if (deg) c.rotate(cap, { axis, deg, about: hinge });
    return cap;
  };
  // A knuckle: three rings centred on the joint, each a third of its angle. Past the first
  // knuckle (which sits in the palm) the first ring widens and the last narrows, which
  // draws the joint.
  const knuckle = (cur, tag, deg, axis, wide) => {
    cur = ring(cur, deg / 3, axis, { id: `${tag}a`, scale: wide ? 1.12 : 1 });
    cur = ring(cur, deg / 3, axis, { id: `${tag}b` });
    return ring(cur, deg / 3, axis, { id: `${tag}c`, scale: wide ? 0.9 : 1 });
  };
  for (const [name, f] of Object.entries(FINGERS)) {
    const angles = bends[name];   // [mcp, pip, dip]
    let cur = c.extrude(f.face, { by: NECK, scale: [0.82, 0.85, 1], id: `${name}Neck` });
    f.lengths.forEach((L, i) => {
      cur = knuckle(cur, `${name}K${i}`, angles[i], "x", i > 0);
      // From the knuckle's last ring to the next knuckle's first: L less a whole knuckle.
      cur = c.extrude(cur, { by: L - 3 * RING, scale: 0.94, id: `${name}P${i}` });
    });
    c.extrude(cur, { by: 5, scale: 0.6, id: `${name}Tip` });
  }
  let t = c.extrude("+x:0,0", { by: THUMB_ROOT, scale: [1, 0.85, 0.6], id: "thumbRoot" });
  c.rotate(t, { axis: "y", deg: -45 });
  t = c.extrude(t, { by: THUMB_RUN - RING, scale: 0.9, id: "thumb1" });
  t = knuckle(t, "thumbK", bends.thumb[0], THUMB_AXIS, true);
  t = c.extrude(t, { by: THUMB_LENGTH - 3 * RING, scale: 0.92, id: "thumb2" });
  c.extrude(t, { by: 5, scale: 0.6, id: "thumbTip" });
  return c;
}

const bendsOf = (d) => Object.fromEntries(DIGITS.map((n) => [n, d[n].values]));
const deg = (key, label, range, description) => ({ key, label, unit: "°", min: range[0], max: range[1], step: 0.1, description });

export default {
  meta: { title: "Cage hand", units: "mm", backend: "manifold" },
  parameters: [
    { id: "fingers", title: "Fingers", description: "In Pose mode, drag a fingertip instead.", controls: Object.keys(FINGERS).flatMap((f) => [
      deg(`${f}Knuckle`, `${LABEL[f]} knuckle`, RANGE.knuckle, "The base knuckle's bend: 0 is in line with the palm."),
      deg(`${f}Curl`, `${LABEL[f]} curl`, RANGE.curl, "The middle joint's bend; the tip joint follows at 0.75."),
    ]) },
    { id: "thumb", title: "Thumb", controls: [
      deg("thumbCurl", "Thumb curl", RANGE.thumbCurl, "The thumb's joint, curling it across the palm side."),
    ] },
  ],
  defaults: {
    ...Object.fromEntries(Object.keys(FINGERS).flatMap((f) => [[`${f}Knuckle`, 15], [`${f}Curl`, 20]])),
    thumbCurl: 10,
  },
  derive: (p) => poseDigits(p),
  parts: {
    hand: {
      label: "Hand",
      // The smooth body, then an ordinary boolean: a flat under the wrist to stand on.
      build: (k, p, d) => {
        const body = k.subdiv(cageHand(k.cage, p, bendsOf(d)));
        const { min, max } = body.boundingBox();
        return body.cut(k.box({ min: [min[0] - 1, min[1] - 1, min[2] - 1], max: [max[0] + 1, max[1] + 1, min[2] + 1.5] }));
      },
      views: { assembly: true, print: true },
    },
  },
  views: { assembly: { label: "Hand" }, print: { label: "Print" } },
  // One angles-mode handle per digit: drag a fingertip and the drag solves that digit's
  // knuckle and curl (the thumb's curl).
  handles: {
    ...Object.fromEntries(Object.keys(FINGERS).map((f) => [f, { on: f, drag: "angles", params: [`${f}Knuckle`, `${f}Curl`] }])),
    thumb: { on: "thumb", drag: "angles", params: ["thumbCurl"] },
  },
  verify: { expect: { hand: { watertight: true } } },
};
