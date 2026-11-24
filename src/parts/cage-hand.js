// A posable hand from one subdivision cage: the organic domain's reference part for Pose
// mode on a k.subdiv body, and the worked example "a hand that follows its limbs" in
// docs/domains/organic.md, which shows this file's code from the import to poseDigits
// (test/organic-docs.test.js holds the two equal).
//
// Authoring frame: the palm faces -Y, the fingers point to +Z, the thumb leaves the +X side.
// One cage, no mirror, built straight: every digit at rest. A limb per digit is posed in
// derive, and one cage.skin call makes the cage follow them. No face is turned by hand.
//
// The palm is a box seven columns across: a column per finger and a narrow strip between
// each pair, so two fingers never share a point and one can bend alone. Its top three
// rings are the base knuckles, which are inside the palm as a hand's are. The two lower
// rows of the thumb's side push out as a short web ring and then a pad, which is the
// thumb's first bone, and the thumb grows from the pad's top.
import { limb } from "partforge/kinematics";
import { cage } from "partforge/organic";

const RING = 5;                     // a knuckle ring's length (mm); three per knuckle
const PALM = { size: [88, 26, 90], center: [0, 0, 57], segs: [7, 1, 3] };
// The palm's columns, by the X of their edges: pinky, strip, ring, strip, middle, strip, index.
const COLUMNS = [-44, -28, -23, -4, 1, 20, 25, 44];
// The base knuckles: the top `rows` rings of the palm. Each finger's joint is `rise` mm
// above the lowest of them and `depth` mm behind the palm's front face, where a palm creases.
const KNUCKLE = { rows: 3, rise: 4, depth: 5 };
// Per finger: its palm column, its neck out of the palm (mm; the necks draw the arc of the
// finger webs), its splay about Y (degrees, positive toward the thumb side), its three
// bones' lengths past the neck, and its limb's radii (at each joint, then the tip).
const FINGERS = {
  index:  { col: 6, neck: 6, splay: 3,  lengths: [29, 20, 17], r: [18, 18, 17, 17] },
  middle: { col: 4, neck: 9, splay: 0,  lengths: [32, 22, 18], r: [18, 18, 17, 17] },
  ring:   { col: 2, neck: 6, splay: -4, lengths: [29, 20, 17], r: [18, 18, 17, 17] },
  pinky:  { col: 0, neck: 3, splay: 0,  lengths: [22, 16, 16], r: [16, 16, 15, 15] },
};

// The thumb's side: the two lower rows of the +X side push out `web` mm as a ring of soft
// flesh and then on to `pad` mm as the pad, `thick` times the palm's thickness, which swings
// in `tuck` degrees at the wrist and whose wrist end comes in and up by `foot` mm. The
// thumb grows from the pad's top: it leans out `lean` degrees and toward the palm side
// `forward` degrees, then a short root (scaled by `neck`) and two segments.
// The thumb's limb starts at the wrist end of the pad, `hinge` mm from the middle of the
// pad's root ([toward the palm's middle, toward the palm side]) and `cmc` mm up the palm,
// where a thumb's first bone pivots. It has two joints there: abduction swings the thumb
// forward out of the palm, and opposition turns it about its own direction, round to the
// palm's front and across it.
const THUMB = {
  pad: 32, web: 10, thick: 1.05, tuck: 14, foot: [2, 6], lean: 23, root: 5, neck: [1, 0.92, 1], forward: 10,
  lengths: [25, 20], follow: 0.8, hinge: [2, 9], cmc: 16, r: [26, 26, 19, 19, 19, 19, 18, 18], base: 60
};
// How long each kind of joint's bend is spread along its digit (mm). A sharper bend needs
// a longer stretch, or the skin on its inner side folds.
const BLEND = { knuckle: 14, curl: 24, tip: 18 };
const PALMWARD = [0, -1, 0];        // the fingers curl toward the palm side
const THUMB_CURL = [-0.75, -1, 0];   // the thumb curls toward the palm's middle

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => v.map((x) => x / Math.hypot(...v));
const along = (p, n, d) => p.map((v, i) => v + d * n[i]);
// The part of `v` square to the unit vector `n`: a limb's bendToward for a digit along n.
const squareTo = (v, n) => unit(v.map((x, i) => x - dot(v, n) * n[i]));

const RANGE = { knuckle: [-10, 90], curl: [0, 80], thumbCurl: [0, 50], thumbOppose: [0, 120], thumbAbduct: [0, 70] };
const DIGITS = [...Object.keys(FINGERS), "thumb"];
// The flat under the wrist sits this far above the cage's lowest point (mm).
const FLAT_ABOVE = 2.4;
const LABEL = { index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky", thumb: "Thumb" };

// The palm before anything grows from it. The box's seven equal columns take their widths
// from COLUMNS, left to right: each is scaled about its left edge, which is already placed.
// Then it is thinner and a little wider at the knuckles, the pinky side lower, with a pad
// on each side of the heel (the thumb's is the bigger one).
const palm = (make) => {
  const c = make({ box: { size: PALM.size, center: PALM.center, segs: PALM.segs } });
  const step = PALM.size[0] / PALM.segs[0];
  for (let i = 0; i < PALM.segs[0] - 1; i++) {
    const left = COLUMNS[i], right = -PALM.size[0] / 2 + step * (i + 1);
    const column = c.faces().filter((f) => { const x = c.centroid(f)[0]; return x > left + 1e-6 && x < right - 1e-6; });
    c.scale(column, [(COLUMNS[i + 1] - left) / (right - left), 1, 1], { about: [left, 0, 0] });
  }
  c.scale(c.faces("+z:"), [1.08, 0.82, 1]);
  c.move("-x:0,2", [0, 0, -5]);
  c.move("+x:0,2", [0, 0, -2]);
  c.scale(c.faces("-z:"), [0.88, 1, 1]);
  c.move(["-y:5,0", "-y:6,0"], [0, -7, 0]);
  c.move(["-y:0,0", "-y:1,0"], [0, -3, 0]);
  // The top comes down by the knuckle rings' height: cageHand grows them back as rings.
  c.move(c.faces("+z:"), [0, 0, -KNUCKLE.rows * RING]);
  return c;
};

/**
 * The hand's cage. `make` is k.cage (or partforge/organic's cage); `posed` maps each digit
 * to its posed limb, and the cage follows them. Without `posed` it is the cage at rest,
 * which is what the limbs are placed from.
 */
export function cageHand(make, posed) {
  const c = palm(make);
  // The pad's root, before anything grows from it: where the thumb's limb starts.
  const w = c.extrude(c.faces("-z:"), { by: 12, scale: [0.78, 1.08, 1], id: "wrist" });
  c.extrude(w, { by: 24, scale: 1.04, id: "arm" });
  // A knuckle is three short rings, so the surface has points to bend with. Past a digit's
  // middle knuckle the first ring widens and the last narrows, which draws the joint.
  const knuckle = (cur, tag, wide) => {
    cur = c.extrude(cur, { by: RING, id: `${tag}a`, scale: wide ? 1.1 : 1 });
    cur = c.extrude(cur, { by: RING, id: `${tag}b` });
    return c.extrude(cur, { by: RING, id: `${tag}c`, scale: wide ? 0.92 : 1 });
  };
  // A digit from the cap `cur` on, straight: a knuckle and a segment per length, then a
  // blunt tip. A finger starts at its second knuckle (`from` 1): its first is in the palm.
  const digit = (cur, name, lengths, from = 0) => {
    lengths.forEach((L, i) => {
      if (i >= from) cur = knuckle(cur, `${name}K${i}`, i === 1);
      // From a knuckle's last ring to the next knuckle's first: L less a whole knuckle.
      cur = c.extrude(cur, { by: i >= from ? L - 3 * RING : L, scale: 0.95, id: `${name}P${i}` });
    });
    c.extrude(cur, { by: RING, scale: 0.55, id: `${name}Tip` });
  };
  // The base knuckles: the palm's top grows back as three rings across all seven columns.
  let caps = Array.from({ length: PALM.segs[0] }, (_, col) => `+z:${col},0`);
  for (let r = 0; r < KNUCKLE.rows; r++) caps = c.extrude(caps, { by: RING, id: `knuckle${"abc"[r]}` });
  for (const [name, f] of Object.entries(FINGERS)) {
    const hinge = c.centroid(caps[f.col]);
    const neck = c.extrude(caps[f.col], { by: f.neck, id: `${name}Neck` });
    if (f.splay) c.rotate(neck, { axis: "y", deg: f.splay, about: hinge });
    digit(neck, name, f.lengths, 1);
  }
  // The thumb's side of the palm. The two lower rows of the +X side push out twice: a short
  // ring (the web, the flesh between the palm and the thumb's first bone) and then the pad,
  // which is that bone. Both swing in about their top edges so the pad is narrow at the
  // wrist. The thumb grows from the pad's top (the side that faces the fingers), leaning
  // out about its inner edge.
  const row = PALM.size[2] / PALM.segs[2];
  const boneLength = THUMB.pad - THUMB.web;
  const topOf = (face) => c.centroid(face).map((v, i) => v + (i === 2 ? row / 2 : 0));
  const webCap = c.extrude(["+x:0,0", "+x:0,1"], { by: THUMB.web, id: "thenarWeb" });
  const webTopEdge = topOf(webCap[1]);
  const pad = c.extrude(webCap, { by: boneLength, scale: [1, THUMB.thick, 1], id: "thenar" });
  const sides = c.faces("thenar.s");
  const tuckWeb = (THUMB.tuck * THUMB.web) / THUMB.pad;
  c.rotate([...pad, ...sides], { axis: "y", deg: tuckWeb, about: webTopEdge });
  c.rotate(pad, { axis: "y", deg: THUMB.tuck - tuckWeb, about: topOf(pad[1]) });
  // The pad's wrist end lifts and comes in, so the ball of the thumb runs into the wrist as
  // a slope and not a step.
  const lowest = (faces) => faces.reduce((best, f) => (c.normal(f)[2] < c.normal(best)[2] ? f : best));
  const topmost = (faces) => faces.reduce((best, f) => (c.normal(f)[2] > c.normal(best)[2] ? f : best));
  c.move(lowest(sides), [-THUMB.foot[0], 0, THUMB.foot[1]]);
  const shelf = topmost(sides);
  const inner = c.centroid(shelf).map((v, i) => v - (i === 0 ? boneLength / 2 : 0));
  c.rotate(shelf, { axis: "y", deg: THUMB.lean, about: inner });
  const base = c.centroid(shelf);
  const t = c.extrude(shelf, { by: THUMB.root, scale: THUMB.neck, id: "thumbRoot" });
  c.rotate(t, { axis: "x", deg: THUMB.forward, about: base });
  digit(t, "thumb", THUMB.lengths);
  // The cage follows the limbs. A point follows a limb whose line it is near and can see,
  // so each finger takes its own column of the palm at its knuckle, and the thumb takes the
  // pad, the web and the front of the palm beside it: the ball of the thumb moves with it.
  if (posed) c.skin(DIGITS.map((n) => posed[n]), {
    blend: {
      // The thumb's two base joints bend the whole pad, from the wrist up.
      "thumb.abduct": THUMB.base, "thumb.oppose": THUMB.base, "thumb.mcp": BLEND.curl, "thumb.ip": BLEND.tip,
      ...Object.fromEntries(Object.keys(FINGERS).flatMap((f) => [[`${f}.mcp`, BLEND.knuckle], [`${f}.pip`, BLEND.curl], [`${f}.dip`, BLEND.tip]])),
    },
  });
  return c;
}

// Each limb is placed from the cage at rest. A digit's last cap is its tip: its normal is
// the digit's direction, and its joints are back along that line.
// A joint sits in the middle of its knuckle's middle ring, so a ring of points lies on each
// side of the line it bends on and none lies on it: a ring on the line creases.
const MID = RING / 2;
const REST = cageHand(cage, null);
const restLine = (name, lengths) => {
  const toward = REST.normal(`${name}Tip`), tip = REST.centroid(`${name}Tip`);
  // The limb's tip is the tip cap's middle; the joint before the last two bones is back
  // by their lengths.
  return { toward, tip, joint: along(tip, toward, MID - (lengths[lengths.length - 1] + lengths[lengths.length - 2])) };
};
// A limb whose joint `index` sits `step` (a part-coordinate vector) off the limb's straight
// line: the step is given to the limb as that joint's offset, in the limb's own frame.
const steppedLimb = (name, def, index, stepOf) => {
  const shape = (offset) => limb(name, { ...def, joints: def.joints.map((j, i) => (i === index ? { ...j, offset } : j)) });
  const frame = shape([0, 0, 0]).pose({}).bones.joints[index - 1].rest;
  const step = stepOf(frame);
  return shape([dot(step, frame.x), dot(step, frame.y), dot(step, frame.z)]);
};
// A finger's first joint is inside the palm, near its front face, and its middle joint is
// back on the finger's own line. Its first bone runs between the two.
const knuckleAt = (() => { const p0 = palm(cage); return [p0.centroid("-y:4,2")[1] + KNUCKLE.depth, p0.centroid("+z:4,0")[2] + KNUCKLE.rise]; })();
const FINGER_LIMB = Object.fromEntries(Object.entries(FINGERS).map(([name, f]) => {
  const { toward, joint: pip } = restLine(name, f.lengths);
  const onLine = along(pip, toward, -(pip[2] - knuckleAt[1]) / toward[2]);
  const at = [onLine[0], knuckleAt[0], knuckleAt[1]];
  const reach = dot(pip.map((v, i) => v - at[i]), toward);
  return [name, steppedLimb(name, {
    at, toward, bendToward: squareTo(PALMWARD, toward),
    joints: [
      { name: "mcp", range: RANGE.knuckle },
      { name: "pip", range: RANGE.curl },
      { name: "dip", range: [0, RANGE.curl[1] * 0.75], follow: { joint: "pip", ratio: 0.75 } },
    ],
    lengths: [reach, f.lengths[1], f.lengths[2] - MID], r: f.r,
  }, 1, () => pip.map((v, i) => v - along(at, toward, reach)[i]))];
}));
// The thumb's limb starts at the wrist end of the pad and runs straight up the hand, so
// opposition (a turn about that line) carries the thumb round the palm's edge and abduction
// (a bend there) swings it forward. The thumb itself leans away from that line, so three
// joints that never move sit at its root: a lean to the side, a tilt forward, and a roll
// that sets the way it curls. A limb's rest pose has them, and the cage is built with them.
const DEG = 180 / Math.PI;
const THUMB_LIMB = (() => {
  const { toward, joint: mcp } = restLine("thumb", THUMB.lengths);
  const p0 = palm(cage), a = p0.centroid("+x:0,0"), b = p0.centroid("+x:0,1");
  const at = [(a[0] + b[0]) / 2 - THUMB.hinge[0], (a[1] + b[1]) / 2 - THUMB.hinge[1], THUMB.cmc];
  const height = mcp[2] - at[2];
  const lean = Math.atan2(toward[0], toward[2]) * DEG, tilt = Math.asin(-toward[1]) * DEG;
  const fixed = (name, axis, deg) => ({ name, ...(axis ? { axis } : {}), range: [deg, deg] });
  const shape = (roll) => steppedLimb("thumb", {
    at, toward: [0, 0, 1], bendToward: PALMWARD,
    joints: [
      { name: "abduct", range: RANGE.thumbAbduct },
      { name: "oppose", axis: "twist", range: [-RANGE.thumbOppose[1], RANGE.thumbOppose[1]] },
      fixed("lean", "spread", lean), fixed("tilt", null, tilt), fixed("roll", "twist", roll),
      { name: "mcp", range: RANGE.thumbCurl },
      { name: "ip", range: [0, RANGE.thumbCurl[1] * THUMB.follow], follow: { joint: "mcp", ratio: THUMB.follow } },
    ],
    lengths: [0, height, 0, 0, 0, THUMB.lengths[0], THUMB.lengths[1] - MID], r: THUMB.r,
  }, 2, () => mcp.map((v, i) => v - [at[0], at[1], at[2] + height][i]));
  // The roll that makes the thumb curl toward THUMB_CURL: read the way it curls with no
  // roll (its middle joint's rest frame; a bend goes toward -z), then turn by the angle between.
  const want = squareTo(THUMB_CURL, toward);
  const curlOf = (limbShape) => limbShape.pose({}).bones.joints[5].rest.z.map((v) => -v);
  const angle = (from) => Math.atan2(dot(cross(from, want), toward), dot(from, want)) * DEG;
  const roll = angle(curlOf(shape(0)));
  return [roll, -roll].map(shape).reduce((best, l) => (Math.abs(angle(curlOf(l))) < Math.abs(angle(curlOf(best))) ? l : best));
})();

/** Every digit posed: the four fingers from their knuckles in the palm, the thumb from the wrist. */
function poseDigits(p) {
  const out = {};
  for (const name of Object.keys(FINGERS)) out[name] = FINGER_LIMB[name].pose({ bend: { mcp: p[`${name}Knuckle`], pip: p[`${name}Curl`] } });
  out.thumb = THUMB_LIMB.pose({ bend: { abduct: p.thumbAbduct, oppose: -p.thumbOppose, mcp: p.thumbCurl } });
  return out;
}

const deg = (key, label, range, description) => ({ key, label, unit: "°", min: range[0], max: range[1], step: 0.1, description });

export default {
  meta: { title: "Cage hand", units: "mm", backend: "manifold" },
  parameters: [
    { id: "fingers", title: "Fingers", description: "In Pose mode, drag a fingertip instead.", controls: Object.keys(FINGERS).flatMap((f) => [
      deg(`${f}Knuckle`, `${LABEL[f]} knuckle`, RANGE.knuckle, "The base knuckle's bend, inside the palm: 0 is in line with the palm."),
      deg(`${f}Curl`, `${LABEL[f]} curl`, RANGE.curl, "The middle joint's bend; the tip joint follows at 0.75."),
    ]) },
    { id: "thumb", title: "Thumb", controls: [
      deg("thumbCurl", "Thumb curl", RANGE.thumbCurl, "The thumb's middle joint, curling it across the palm; the tip joint follows at 0.8."),
      deg("thumbOppose", "Thumb opposition", RANGE.thumbOppose, "Swings the thumb from the side of the palm round to its front, to face the fingers."),
      deg("thumbAbduct", "Thumb abduction", RANGE.thumbAbduct, "Swings the thumb's base forward out of the palm, pivoting at the wrist, to open the hand round an object."),
    ] },
  ],
  defaults: {
    // A relaxed hand: each finger a little more curled than the one before it.
    ...Object.fromEntries(Object.keys(FINGERS).flatMap((f, i) => [[`${f}Knuckle`, 10 + 4 * i], [`${f}Curl`, 16 + 4 * i]])),
    thumbCurl: 12,
    thumbOppose: 0,
    thumbAbduct: 0,
  },
  derive: (p) => poseDigits(p),
  parts: {
    hand: {
      label: "Hand",
      // The smooth body, then an ordinary boolean: a flat under the wrist to stand on. The
      // flat is placed from the cage (its lowest point is the arm's end, which no limb
      // pulls) and never from the body's own bounding box, so the build asks its solid no
      // question. The smooth surface lies inside the cage, so the flat sits FLAT_ABOVE
      // above the cage's lowest point: it removes a slab about 1.5 mm thick.
      build: (k, p, d) => {
        const c = cageHand(k.cage, d);
        const flat = c.bounds().min[2] + FLAT_ABOVE;
        return k.subdiv(c).cut(k.box({ min: [-200, -200, flat - 8], max: [200, 200, flat] }));
      },
      views: { assembly: true, print: true },
    },
  },
  views: { assembly: { label: "Hand" }, print: { label: "Print" } },
  // One angles-mode handle per digit: drag a fingertip and the drag solves that digit's
  // joints. `joints` gives each named joint its own rotate ring.
  handles: {
    ...Object.fromEntries(Object.keys(FINGERS).map((f) => [f, { on: f, drag: "angles", params: [`${f}Knuckle`, `${f}Curl`], joints: { mcp: `${f}Knuckle`, pip: `${f}Curl` } }])),
    thumb: { on: "thumb", drag: "angles", params: ["thumbCurl"], joints: { abduct: "thumbAbduct", oppose: "thumbOppose", mcp: "thumbCurl" } },
  },
  verify: { expect: { hand: { watertight: true } } },
};
