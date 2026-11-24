// A posable hand from one subdivision cage: the organic domain's reference part for Pose
// mode on a k.subdiv body, and the worked example "a hand that follows its limbs" in
// docs/domains/organic.md, which shows this file's code from the import to poseDigits
// (test/organic-docs.test.js holds the two equal).
//
// Authoring frame: the palm faces -Y, the fingers point to +Z, the thumb leaves the +X side.
// One cage, no mirror, built straight: every digit at rest. A limb per digit is posed in
// derive, and one cage.skin call makes the cage follow them. No face is turned by hand to
// pose it.
//
// The palm is a box seven columns across: a column per finger and a narrow strip between
// each pair, so two fingers never share a point and one can bend alone. Its top three
// rings are the base knuckles, which are inside the palm as a hand's are. The two lower
// rows of the thumb's side push out as a short web ring and then a pad, which is the
// thumb's first bone, and the thumb grows from the pad's top.
import { limb } from "partforge/kinematics";
import { cage } from "partforge/organic";

const RING = 5;                     // a knuckle ring's length (mm); three per knuckle
// The palm's seven columns, by their widths across X: pinky, strip, ring, strip, middle,
// strip, index. The strips are 3 mm, so the hand is about 86 mm across the knuckles and the
// fingers lie close together, as a hand's do.
const PALM = { size: [81, 26, 90], center: [0, 0, 57], segs: [[15, 3, 18.5, 3, 19, 3, 19.5], 1, 3] };
// The base knuckles: the top `rows` rings of the palm. Each finger's joint is `rise` mm
// above the lowest of them and `depth` mm behind the palm's front face, where a palm creases.
const KNUCKLE = { rows: 3, rise: 4, depth: 5 };
// Per finger: its palm column, its neck out of the palm (mm; the necks draw the arc of the
// finger webs), its splay about Y (degrees, positive toward the thumb side), its three
// bones' lengths past the neck, and its limb's radii (at each joint, then the tip). The
// lengths follow measured finger bones: knuckle to middle joint about 42, 46, 43 and 34 mm
// (the knuckle is 11 mm inside the palm), then 24, 28, 27 and 19, then 23 to 24 to the tip.
// `arch` moves its knuckle [toward the back of the hand, up] (mm): the knuckles sit on an
// arc, the middle finger's highest and furthest back. `flat` is the finger's depth as a
// share of the palm's, so a finger is a little wider than it is deep. `converge` turns the
// way it curls toward the thumb side (degrees): curled fingers point at the base of the
// thumb. `cup` is how far its palm bone folds forward, as a share of its knuckle's bend.
const FINGERS = {
  index:  { col: 6, neck: 6, splay: 3,  lengths: [17.5, 24, 25.5], r: [18, 18, 17, 17], arch: [0.5, 0],  flat: 0.86, converge: 0 },
  middle: { col: 4, neck: 9, splay: 0,  lengths: [18.5, 28, 26.5], r: [18, 18, 17, 17], arch: [0, 0],    flat: 0.86, converge: 3 },
  ring:   { col: 2, neck: 6, splay: -4, lengths: [18.5, 27, 26.5], r: [18, 18, 17, 17], arch: [-0.5, 0], flat: 0.84, converge: 7, cup: 0.07 },
  pinky:  { col: 0, neck: 3, splay: -2,  lengths: [12.5, 19, 23.5], r: [16, 16, 15, 15], arch: [-3, -1],  flat: 0.76, converge: 2, cup: 0.2 },
};
// A cupping palm bone starts `z` mm up the hand; its fold is spread over `blend` mm.
const CUP = { z: 30, blend: 44 };
// Surface relief (mm). `head` raises the knuckle on the back of the hand over each finger,
// and `mound` the pad on the palm under it. `pad` pushes out the palm side of each finger
// bone, so the joints between them show as creases; `nail` moves the tip cap toward the
// back, so the tip is flat on the nail side and full on the pad side.
const SHAPE = { head: 1, mound: 1.5, pad: [0.5, 0.5, 1.2], nail: 1.5 };

// The thumb's side: the two lower rows of the +X side push out `web` mm as a ring of soft
// flesh and then on to `pad` mm as the pad, `thick` times the palm's thickness, which swings
// in `tuck` degrees at the wrist: the ball of the thumb is a wedge that runs from the wrist
// out to the thumb's root in one slope, with no step where it meets the palm. The thumb
// grows from the pad's top: it leans out `lean` degrees and toward the palm side `forward`
// degrees, then a short root (scaled by `neck`) and two segments.
// The thumb's limb starts at the wrist end of the pad, `hinge` mm from the middle of the
// pad's root ([toward the palm's middle, toward the palm side]) and `cmc` mm up the palm,
// where a thumb's first bone pivots. It has two joints there: abduction swings the thumb
// forward out of the palm, and opposition turns it about its own direction, round to the
// palm's front and across it. The cage is built with the thumb already `rest` degrees round
// toward the front, as a relaxed hand holds it, so the skin at its base stretches less at
// the far end of its travel. `drop` brings the pad's top [in, down] (mm), which sets the
// length of the thumb's first bone: about 45 mm from its pivot to its middle joint.
const THUMB = {
  pad: 32, web: 10, thick: 1.05, tuck: 24, lean: 23, root: 5, neck: [1, 0.92, 1], forward: 10,
  lengths: [30, 25], follow: 0.8, hinge: [2, 15], cmc: 22, drop: [7, 13], rest: 22, r: [26, 26, 19, 18, 18], base: 60
};
// How long each kind of joint's bend is spread along its digit (mm). A sharper bend needs
// a longer stretch, or the skin on its inner side folds.
const BLEND = { knuckle: 22, curl: 24, tip: 18 };
const PALMWARD = [0, -1, 0];        // the fingers curl toward the palm side
// The thumb curls toward the palm's middle: this direction, turned with the thumb's rest.
const THUMB_CURL = ((a) => [-0.75 * Math.cos(a) - Math.sin(a), 0.75 * Math.sin(a) - Math.cos(a), 0])((THUMB.rest * Math.PI) / 180);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => v.map((x) => x / Math.hypot(...v));
const along = (p, n, d) => p.map((v, i) => v + d * n[i]);
// The part of `v` square to the unit vector `n`: a limb's bendToward for a digit along n.
const squareTo = (v, n) => unit(v.map((x, i) => x - dot(v, n) * n[i]));

// Opposition is measured from the thumb's rest: negative lays it flat beside the palm.
const RANGE = { knuckle: [-10, 90], curl: [0, 80], thumbCurl: [0, 50], thumbOppose: [-THUMB.rest, 120 - THUMB.rest], thumbAbduct: [0, 70] };
const DIGITS = [...Object.keys(FINGERS), "thumb"];
// The flat under the wrist sits this far above the cage's lowest point (mm).
const FLAT_ABOVE = 2.4;
const LABEL = { index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky", thumb: "Thumb" };

// The palm before anything grows from it: the box, thinner and a little wider at the
// knuckles, the pinky side lower, with a pad on each side of the heel (the thumb's is the
// bigger one).
const palm = (make) => {
  const c = make({ box: { size: PALM.size, center: PALM.center, segs: PALM.segs } });
  c.scale(c.faces("+z:"), [1.08, 0.82, 1]);
  c.move("-x:0,2", [0, 0, -5]);
  c.move("+x:0,2", [0, 0, -2]);
  c.scale(c.faces("-z:"), [0.88, 1, 1]);
  c.move(["-y:5,0", "-y:6,0"], [0, -7, 0]);
  // The heel of the hand, on the pinky side: forward and a little out.
  c.move(["-y:0,0", "-y:1,0"], [0, -5, 0]);
  c.move("-x:0,0", [-2.5, 0, 0]);
  for (const f of Object.values(FINGERS)) c.move(`+z:${f.col},0`, [0, f.arch[0], f.arch[1]]);
  // The top comes down by the knuckle rings' height: cageHand grows them back as rings.
  c.move(c.faces("+z:"), [0, 0, -KNUCKLE.rows * RING]);
  return c;
};

// Where the thumb pivots, on a palm nothing has grown from yet.
const thumbPivot = (p0) => {
  const a = p0.centroid("+x:0,0"), b = p0.centroid("+x:0,1");
  return [(a[0] + b[0]) / 2 - THUMB.hinge[0], (a[1] + b[1]) / 2 - THUMB.hinge[1], THUMB.cmc];
};

/**
 * The hand's cage. `make` is k.cage (or partforge/organic's cage); `posed` maps each digit
 * to its posed limb, and the cage follows them. Without `posed` it is the cage at rest,
 * which is what the limbs are placed from.
 */
export function cageHand(make, posed) {
  const c = palm(make);
  // Where the thumb's limb starts, read before anything grows from the palm.
  const pivot = thumbPivot(c);
  const w = c.extrude(c.faces("-z:"), { by: 12, scale: [0.72, 1.04, 1], id: "wrist" });
  c.extrude(w, { by: 24, scale: 1.06, id: "arm" });
  // A knuckle is one extrude in three short rings, so the surface has points to bend with.
  // Past a digit's middle knuckle the first ring widens and the last narrows, which draws
  // the joint.
  const knuckle = (cur, tag, wide) => c.extrude(cur, { by: 3 * RING, id: tag, steps: [wide ? 1.1 : 1, 1, wide ? 0.92 : 1] });
  // A digit from the cap `cur` on, straight: a knuckle and a segment per length, then a
  // blunt tip. A finger starts at its second knuckle (`from` 1): its first is in the palm.
  const digit = (cur, name, lengths, from = 0) => {
    lengths.forEach((L, i) => {
      if (i >= from) cur = knuckle(cur, `${name}K${i}`, i === 1);
      // From a knuckle's last ring to the next knuckle's first: L less a whole knuckle.
      cur = c.extrude(cur, { by: i >= from ? L - 3 * RING : L, scale: 0.94, id: `${name}P${i}` });
    });
    c.extrude(cur, { by: RING, scale: 0.55, id: `${name}Tip` });
  };
  // The base knuckles: the palm's top grows back as three rings across all seven columns.
  const top = Array.from({ length: PALM.segs[0].length }, (_, col) => `+z:${col},0`);
  const caps = c.extrude(top, { by: KNUCKLE.rows * RING, steps: KNUCKLE.rows, id: "knuckle" });
  // Each finger's head is the back of its column on the middle ring, and its mound the front
  // on the lowest: the ring's face on that side nearest the column's cap.
  for (const f of Object.values(FINGERS)) {
    const near = c.centroid(caps[f.col]);
    c.move(c.faces("knuckle.2.s", { facing: "+y", near })[0], [0, SHAPE.head, 0]);
    c.move(c.faces("knuckle.1.s", { facing: "-y", near })[0], [0, -SHAPE.mound, 0]);
  }
  for (const [name, f] of Object.entries(FINGERS)) {
    const hinge = c.centroid(caps[f.col]);
    const neck = c.extrude(caps[f.col], { by: f.neck, scale: [1, f.flat, 1], id: `${name}Neck` });
    if (f.splay) c.rotate(neck, { axis: "y", deg: f.splay, about: hinge });
    digit(neck, name, f.lengths, 1);
    SHAPE.pad.forEach((d, i) => c.move(c.faces(`${name}P${i}.s`, { facing: "-y" })[0], [0, -d, 0]));
    c.move(`${name}Tip`, [0, SHAPE.nail, 0]);
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
  // The pad's top: its one side that faces up the hand.
  const [shelf] = c.faces("thenar.s", { facing: "+z" });
  // The pad's top comes down and in, so the thumb's first bone is its real length. The web
  // then slopes from the palm down to the thumb's root, as the skin there does.
  c.move(shelf, [-THUMB.drop[0], 0, -THUMB.drop[1]]);
  const inner = c.centroid(shelf).map((v, i) => v - (i === 0 ? boneLength / 2 : 0));
  c.rotate(shelf, { axis: "y", deg: THUMB.lean, about: inner });
  const base = c.centroid(shelf);
  const t = c.extrude(shelf, { by: THUMB.root, scale: THUMB.neck, id: "thumbRoot" });
  c.rotate(t, { axis: "x", deg: THUMB.forward, about: base });
  digit(t, "thumb", THUMB.lengths);
  // The thumb's rest: a turn about the line up the hand through the thumb's pivot. The
  // web's outer ring goes half way, and the pad and the thumb the whole way.
  const thumbFaces = c.faces("thumb");
  const turn = (faces) => c.rotate([...pad, ...thumbFaces, ...faces], { axis: "z", deg: -THUMB.rest / 2, about: pivot });
  turn(c.faces("thenar.s"));
  turn([]);
  // The cage follows the limbs. A point follows a limb whose line it is near and can see,
  // so each finger takes its own column of the palm at its knuckle, and the thumb takes the
  // pad, the web and the front of the palm beside it: the ball of the thumb moves with it.
  if (posed) c.skin(DIGITS.map((n) => posed[n]), {
    blend: {
      // The thumb's two base joints bend the whole pad, from the wrist up.
      "thumb.abduct": THUMB.base, "thumb.oppose": THUMB.base, "thumb.mcp": BLEND.curl, "thumb.ip": BLEND.tip,
      ...Object.fromEntries(Object.keys(FINGERS).flatMap((f) => [...(FINGERS[f].cup ? [[`${f}.cup`, CUP.blend]] : []), [`${f}.mcp`, BLEND.knuckle], [`${f}.pip`, BLEND.curl], [`${f}.dip`, BLEND.tip]])),
    },
  });
  return c;
}

// Each limb is placed from the cage at rest, by its joints' points. A digit's last cap is its
// tip: its normal is the digit's direction, and its joints are back along that line.
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
// A finger's first joint is inside the palm, near its front face, and its middle joint is
// back on the finger's own line. Its first bone runs between the two. A finger whose palm
// bone cups has one more joint before that, low in the palm. It follows the knuckle by a
// share of its bend: the palm folds as the finger closes. The limb's toward is the
// finger's line, so every joint bends square to it.
const P0 = palm(cage);
const FINGER_LIMB = Object.fromEntries(Object.entries(FINGERS).map(([name, f]) => {
  const { toward, joint: pip } = restLine(name, f.lengths);
  const hinge = [P0.centroid(`-y:${f.col},2`)[1] + KNUCKLE.depth, P0.centroid(`+z:${f.col},0`)[2] + KNUCKLE.rise];
  const onLine = along(pip, toward, -(pip[2] - hinge[1]) / toward[2]);
  const mcp = [onLine[0], hinge[0], hinge[1]];
  const dip = along(pip, toward, f.lengths[1]);
  const cup = f.cup ? [along(mcp, toward, -(mcp[2] - CUP.z) / toward[2])] : [];
  const turn = (f.converge * Math.PI) / 180;
  return [name, limb(name, {
    points: [...cup, mcp, pip, dip, along(dip, toward, f.lengths[2] - MID)],
    toward, bendToward: squareTo([Math.sin(turn), -Math.cos(turn), 0], toward),
    joints: [
      ...(f.cup ? [{ name: "cup", range: [RANGE.knuckle[0] * f.cup, RANGE.knuckle[1] * f.cup], follow: { joint: "mcp", ratio: f.cup } }] : []),
      { name: "mcp", range: RANGE.knuckle },
      { name: "pip", range: RANGE.curl },
      { name: "dip", range: [0, RANGE.curl[1] * 0.75], follow: { joint: "pip", ratio: 0.75 } },
    ],
    r: [...(f.cup ? [f.r[0]] : []), ...f.r],
  })];
}));
// The thumb's limb starts at the wrist end of the pad. Its first two joints sit there and
// aim straight up the hand, so opposition (a turn about that line) carries the thumb round
// the palm's edge and abduction (a bend there) swings it forward. The two after them aim
// down the thumb's own bones and curl toward THUMB_CURL.
const THUMB_LIMB = (() => {
  const { toward, joint: mcp } = restLine("thumb", THUMB.lengths);
  const pivot = thumbPivot(P0);
  const ip = along(mcp, toward, THUMB.lengths[0]);
  return limb("thumb", {
    points: [pivot, pivot, mcp, ip, along(ip, toward, THUMB.lengths[1] - MID)],
    bendToward: THUMB_CURL,
    joints: [
      { name: "abduct", toward: [0, 0, 1], bendToward: PALMWARD, range: RANGE.thumbAbduct },
      { name: "oppose", axis: "twist", toward: [0, 0, 1], range: [-RANGE.thumbOppose[1], -RANGE.thumbOppose[0]] },
      { name: "mcp", range: RANGE.thumbCurl },
      { name: "ip", range: [0, RANGE.thumbCurl[1] * THUMB.follow], follow: { joint: "mcp", ratio: THUMB.follow } },
    ],
    r: THUMB.r,
  });
})();

/** Every digit posed: the four fingers from their knuckles in the palm, the thumb from the wrist. */
function poseDigits(p) {
  const out = {};
  for (const name of Object.keys(FINGERS)) {
    out[name] = FINGER_LIMB[name].pose({ bend: { mcp: p[`${name}Knuckle`], pip: p[`${name}Curl`] } });
  }
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
      deg("thumbOppose", "Thumb opposition", RANGE.thumbOppose, "Turns the thumb round the palm's edge. 0 is the relaxed thumb; negative lays it flat beside the palm, positive carries it across the palm to face the fingers."),
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
    thumb: { on: "thumb", drag: "angles", params: ["thumbCurl"], joints: { abduct: "thumbAbduct", oppose: { param: "thumbOppose", scale: -1 }, mcp: "thumbCurl" } },
  },
  verify: { expect: { hand: { watertight: true } } },
};
