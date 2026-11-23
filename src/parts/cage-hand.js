// A posable hand from one subdivision cage: the organic domain's reference part for Pose
// mode on a k.subdiv body, and the worked example "a hand that curls" in
// docs/domains/organic.md, which shows this file's code from the import to bendsOf
// (test/organic-docs.test.js holds the two equal). Each digit's bends come from a limb
// posed in derive, so Pose mode can drag a fingertip.
//
// Authoring frame: the palm faces -Y, the fingers point to +Z, the thumb leaves the +X side.
// One cage, no mirror. The palm is a box three rows tall: the two lower rows of the thumb's
// side swell into the pad the thumb grows from, the top row thins toward the knuckles and
// drops at the pinky side.
// Each finger is a limb of three joints (mcp, pip, and dip following pip by 0.75); the
// thumb is a limb of two (mcp, and ip following it). A knuckle in the cage is three rings
// centred on its joint, each turning a third of the joint's angle about the centre of the
// face it grew from, so the cage bends where the limb does and its tip follows the limb's
// tip. A pose moves the cage's points and never changes its faces.
//
// The limbs are not placed by hand. The cage is built once straight (REST) and each limb
// reads its base and direction off its own digit, so reshaping the palm moves the limbs
// with it.
import { limb } from "partforge/kinematics";
import { cage } from "partforge/organic";

const RING = 5;                     // a knuckle ring's length (mm); three per knuckle
const PALM = { size: [88, 26, 90], center: [0, 0, 57], segs: [4, 1, 3] };
// Per finger: the column of the palm's top face it grows from, its neck out of the palm
// (mm; the necks' lengths draw the arc of the knuckles), its width against the face, its
// splay about Y (degrees, positive toward the thumb side), and the limb's segment lengths.
const FINGERS = {
  index:  { col: 3, neck: 6, width: 0.94, splay: 3,  lengths: [29, 20, 17] },
  middle: { col: 2, neck: 9, width: 0.96, splay: 0,  lengths: [32, 22, 18] },
  ring:   { col: 1, neck: 6, width: 0.92, splay: -4, lengths: [29, 20, 17] },
  pinky:  { col: 0, neck: 3, width: 0.8,  splay: 0,  lengths: [22, 16, 16] },
};

// The thumb's side: the two lower rows of the +X side push out `pad` mm and swing out
// `padOut` degrees as one pad. The thumb grows from the pad's lower face: a root that
// turns up and toward the palm side, a run to its first joint, and two segments. It curls
// across the palm.
const THUMB = { pad: 9, padOut: -26, root: 8, run: 10, lengths: [25, 22], up: -30, inward: -8, follow: 0.8 };
const PALMWARD = [0, -1, 0];        // the fingers curl toward the palm side
const THUMB_CURL = [-0.75, -1, 0];   // the thumb curls toward the palm's middle

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => v.map((x) => x / Math.hypot(...v));
// The part of `v` square to the unit vector `n`: a limb's bendToward for a digit along n.
const squareTo = (v, n) => { const along = v[0] * n[0] + v[1] * n[1] + v[2] * n[2]; return unit(v.map((x, i) => x - along * n[i])); };

// The curl stops at 80°: with every knuckle at 90°, a curl near 90° presses the pinky's tip
// into the palm, and a cage may not pass through itself. Every pose within these ranges
// builds, all of them at their max at once included.
const RANGE = { knuckle: [-10, 90], curl: [0, 80], thumbCurl: [0, 60] };
const DIGITS = [...Object.keys(FINGERS), "thumb"];
// The flat under the wrist sits this far above the cage's lowest point (mm).
const FLAT_ABOVE = 2.4;
const LABEL = { index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky", thumb: "Thumb" };

/**
 * The hand's cage. `make` is k.cage (or partforge/organic's cage); `bends` maps each digit
 * to its posed limb's `values`: the joint angles in degrees, in the limb's joint order
 * (a finger's [mcp, pip, dip], the thumb's [mcp, ip]). Without `bends` the digits are left
 * off: the palm with a cap where each digit starts, which is what the limbs are placed from.
 */
export function cageHand(make, p, bends) {
  const c = make({ box: { size: PALM.size, center: PALM.center, segs: PALM.segs } });
  // The palm: thinner and a little wider at the knuckles, the pinky side lower, and a pad
  // on each side of the heel (the thumb's is the bigger one).
  c.scale(c.faces("+z:"), [1.08, 0.82, 1]);
  c.move("-x:0,2", [0, 0, -5]);
  c.move("+x:0,2", [0, 0, -2]);
  c.scale(c.faces("-z:"), [0.88, 1, 1]);
  c.move("-y:3,0", [0, -7, 0]);
  c.move("-y:0,0", [0, -3, 0]);
  const w = c.extrude(c.faces("-z:"), { by: 12, scale: [0.74, 1.08, 1], id: "wrist" });
  c.extrude(w, { by: 24, scale: 1.04, id: "arm" });
  // One ring of a bend: extrude, then swing the new cap about the centre of the face it
  // grew from. The next extrude follows the turned cap.
  const ring = (cur, deg, axis, opts) => {
    const hinge = c.centroid(cur);
    const cap = c.extrude(cur, { by: RING, ...opts });
    if (deg) c.rotate(cap, { axis, deg, about: hinge });
    return cap;
  };
  // A knuckle: three rings centred on the joint, each a third of its angle. Past a digit's
  // middle knuckle the first ring widens and the last narrows, which draws the joint.
  const knuckle = (cur, tag, deg, axis, wide) => {
    cur = ring(cur, deg / 3, axis, { id: `${tag}a`, scale: wide ? 1.1 : 1 });
    cur = ring(cur, deg / 3, axis, { id: `${tag}b` });
    return ring(cur, deg / 3, axis, { id: `${tag}c`, scale: wide ? 0.92 : 1 });
  };
  // A digit from the cap `cur` on: a knuckle and a segment per length, then a blunt tip.
  // It bends about its own direction × the way it curls, as its limb does.
  const digit = (cur, name, lengths, angles, curlToward) => {
    const axis = unit(cross(c.normal(cur), curlToward));
    lengths.forEach((L, i) => {
      cur = knuckle(cur, `${name}K${i}`, angles[i], axis, i === 1);
      // From the knuckle's last ring to the next knuckle's first: L less a whole knuckle.
      cur = c.extrude(cur, { by: L - 3 * RING, scale: 0.95, id: `${name}P${i}` });
    });
    c.extrude(cur, { by: RING, scale: 0.55, id: `${name}Tip` });
  };
  for (const [name, f] of Object.entries(FINGERS)) {
    const face = `+z:${f.col},0`;
    const hinge = c.centroid(face);
    const neck = c.extrude(face, { by: f.neck, scale: [f.width, 1, 1], id: `${name}Neck` });
    if (f.splay) c.rotate(neck, { axis: "y", deg: f.splay, about: hinge });
    if (bends) digit(neck, name, f.lengths, bends[name], PALMWARD);
  }
  // The thumb's side of the palm: the two lower rows of the +X side push out as one pad,
  // hinged on their top edge, so the pad is widest near the wrist and runs up to a web
  // under the index finger. The thumb grows from the pad's lower face, hinged on the edge
  // it shares with the web.
  const row = PALM.size[2] / PALM.segs[2];
  const top = (face) => c.centroid(face).map((v, i) => v + (i === 2 ? row / 2 : 0));
  const padHinge = top("+x:0,1");
  const pad = c.extrude(["+x:0,0", "+x:0,1"], { by: THUMB.pad, scale: [1, 0.85, 1], id: "thenar" });
  c.rotate(pad, { axis: "y", deg: THUMB.padOut, about: padHinge });
  const web = top(pad[0]);
  let t = c.extrude(pad[0], { by: THUMB.root, id: "thumbRoot" });
  c.rotate(t, { axis: "y", deg: THUMB.up, about: web });
  c.rotate(t, { axis: "z", deg: THUMB.inward });
  t = c.extrude(t, { by: THUMB.run, scale: 0.9, id: "thumb1" });
  if (bends) digit(t, "thumb", THUMB.lengths, bends.thumb, THUMB_CURL);
  return c;
}

// Each limb's base, read off the palm: a digit's first joint is one ring past the cap its
// first knuckle grows from, and the limb runs along that cap's normal.
const REST = (() => {
  const c = cageHand(cage, null, null);
  const base = (cap, curlToward) => {
    const toward = c.normal(cap);
    return { at: c.centroid(cap).map((v, i) => v + RING * toward[i]), toward, bendToward: squareTo(curlToward, toward) };
  };
  return {
    ...Object.fromEntries(Object.keys(FINGERS).map((n) => [n, base(`${n}Neck`, PALMWARD)])),
    thumb: base("thumb1", THUMB_CURL),
  };
})();

/** Every digit posed: the four fingers on the palm's top, the thumb on its side. */
function poseDigits(p) {
  const out = {};
  for (const [name, f] of Object.entries(FINGERS)) {
    out[name] = limb(name, {
      ...REST[name],
      joints: [
        { name: "mcp", range: RANGE.knuckle },
        { name: "pip", range: RANGE.curl },
        { name: "dip", range: [0, RANGE.curl[1] * 0.75], follow: { joint: "pip", ratio: 0.75 } },
      ],
      lengths: f.lengths,
    }).pose({ bend: { mcp: p[`${name}Knuckle`], pip: p[`${name}Curl`] } });
  }
  out.thumb = limb("thumb", {
    ...REST.thumb,
    joints: [
      { name: "mcp", range: RANGE.thumbCurl },
      { name: "ip", range: [0, RANGE.thumbCurl[1] * THUMB.follow], follow: { joint: "mcp", ratio: THUMB.follow } },
    ],
    lengths: THUMB.lengths,
  }).pose({ bend: { mcp: p.thumbCurl } });
  return out;
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
      deg("thumbCurl", "Thumb curl", RANGE.thumbCurl, "The thumb's base joint, curling it across the palm; the tip joint follows at 0.8."),
    ] },
  ],
  defaults: {
    // A relaxed hand: each finger a little more curled than the one before it.
    ...Object.fromEntries(Object.keys(FINGERS).flatMap((f, i) => [[`${f}Knuckle`, 10 + 4 * i], [`${f}Curl`, 16 + 4 * i]])),
    thumbCurl: 12,
  },
  derive: (p) => poseDigits(p),
  parts: {
    hand: {
      label: "Hand",
      // The smooth body, then an ordinary boolean: a flat under the wrist to stand on. The
      // flat is placed from the cage (its lowest point is the arm's end, which no slider
      // moves) and never from the body's own bounding box, so the build asks its solid no
      // question. The smooth surface lies inside the cage, so the flat sits FLAT_ABOVE
      // above the cage's lowest point: it removes a slab about 1.5 mm thick.
      build: (k, p, d) => {
        const c = cageHand(k.cage, p, bendsOf(d));
        const flat = c.bounds().min[2] + FLAT_ABOVE;
        return k.subdiv(c).cut(k.box({ min: [-200, -200, flat - 8], max: [200, 200, flat] }));
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
