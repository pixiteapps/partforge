// A printable articulated hand: the inverse-kinematics reference part for angles-mode
// handles. Five limbs — four fingers and a thumb — hang off a palm limb's wrist frame.
// Every segment is a rigid printed piece on pin joints, placed by matrix, so every pose
// (a slider, a preset, a drag in Pose mode) moves the pieces and rebuilds none. The print
// view is a flat kit: the pose never reaches it, and you pose the printed hand yourself.
//
// How it fits together:
// - derive() poses the palm limb (wristPitch, then wristYaw) and hands the posed palm to
//   each finger and the thumb as their parent frames (`pose(…, palm)`).
// - A finger is spread, mcp, pip and dip, with dip following pip by 0.75. The spread
//   joint is its own pin, square to the palm, through a short knuckle piece (20 mm)
//   that carries the mcp pin: a real two-pin universal joint, not a ball. `<f>Curl`
//   (0..1) closes mcp and pip; `<f>Spread` (degrees) swings the knuckle, positive
//   fanning away from the middle finger (for the middle finger: toward the index).
// - The thumb is oppose, mcp and ip. Oppose is a pin in the palm's plane, square to the
//   thumb: it swings the thumb's metacarpal out of the palm plane toward the palm side,
//   and then thumbCurl closes mcp and ip across the front of the palm.
// - Pose mode: one angles-mode handle per digit. A drag solves that digit's curl and
//   spread plus the wrist. `<f>Lock` (a checkbox the presets never write) leaves every
//   param that digit's handle lists out of any drag — the wrist included, so a locked
//   finger also holds still in space while you drag another.
// - Each piece is built once in its own joint frame (pin at the origin, the piece along
//   +Y, its bending side toward -Z), never reading a pose param.
import { limb } from "partforge/kinematics";

// Section and joint geometry, mm. A finger piece is W wide (along its bend pin) and 2R
// thick; the thumb is WT wide. GAP is the running clearance at every pin.
const W = 16, WT = 12, R = 6, GAP = 0.4, PIN_R = 1.6;
const SLAB = R / 3;        // half-thickness of a tongue that turns about a pin square to the piece's face
const KNUCKLE = 20;        // spread pin to mcp pin
const STAND_H = 45;        // the wrist (pitch) pin's height above the table
const CARPAL = 20;         // pitch pin to yaw pin: the short wrist piece between them
const PALM_LEN = 69;       // yaw pin to the middle finger's spread pin
const PALM_BOTTOM = 30, PALM_TOP = 38;   // the palm plate's half-widths at its bottom and top
const PALM_BASE = W / 2 + 2 * GAP;        // where the plate starts: clear of the wrist piece's yaw cheeks

// The digits, in palm coordinates (x across, thumb side negative; y along the palm from
// the yaw pin; z out of the back of the hand). `sign` makes a positive spread fan out.
const FINGERS = [
  { id: "index", label: "Index", x: -28.5, y: 66, sign: 1, lengths: [38, 24, 20] },
  { id: "middle", label: "Middle", x: -9.5, y: PALM_LEN, sign: 1, lengths: [42, 27, 22] },
  { id: "ring", label: "Ring", x: 9.5, y: 66, sign: -1, lengths: [40, 26, 21] },
  { id: "pinky", label: "Pinky", x: 28.5, y: 59, sign: -1, lengths: [32, 21, 19] },
];
const THUMB_AT = [-41, 24, 0];
const THUMB_TOWARD = [-0.5, Math.sqrt(3) / 2, 0];        // up and out, in the palm's plane
const THUMB_BEND = [Math.sqrt(3) / 2, 0.5, 0];           // curls across the palm, toward the fingers
const THUMB_LENGTHS = [28, 26, 22];                       // metacarpal, proximal, distal

const RANGE = {
  wristPitch: [-60, 60], wristYaw: [-20, 20],
  spread: [-15, 15], mcp: [0, 90], pip: [0, 90], dip: [0, 80],
  oppose: [0, 80], thumbMcp: [0, 60], ip: [0, 80],
};

const PALM = limb("palm", {
  at: [0, 0, STAND_H],
  toward: [0, 0, 1],          // the hand stands up off its wrist
  bendToward: [0, 1, 0],      // the palm faces +Y: wrist pitch and every curl close toward it
  joints: [
    { name: "wristPitch", range: RANGE.wristPitch },
    { name: "wristYaw", axis: "spread", range: RANGE.wristYaw },
  ],
  lengths: [CARPAL, PALM_LEN],
});
const PALM_FRAME = "palm.wristYaw";
// The wrist's rings in Pose mode: its joints on the palm limb (derive's `palm`) and the
// parameters that drive them.
const WRIST_JOINTS = { "palm.wristPitch": "wristPitch", "palm.wristYaw": "wristYaw" };

const fingerLimb = (f) => limb(f.id, {
  parent: PALM_FRAME,
  at: [f.x, f.y, 0],
  toward: [0, 1, 0],
  bendToward: [0, 0, -1],     // toward the palm side
  joints: [
    { name: "spread", axis: "spread", range: RANGE.spread },
    { name: "mcp", range: RANGE.mcp },
    { name: "pip", range: RANGE.pip },
    { name: "dip", range: RANGE.dip, follow: { joint: "pip", ratio: 0.75 } },
  ],
  lengths: [KNUCKLE, ...f.lengths],
});
const FINGER_LIMBS = Object.fromEntries(FINGERS.map((f) => [f.id, fingerLimb(f)]));

const THUMB = limb("thumb", {
  parent: PALM_FRAME,
  at: THUMB_AT,
  toward: THUMB_TOWARD,
  bendToward: THUMB_BEND,
  joints: [
    // A pin in the palm's plane, square to the thumb: a positive oppose swings the thumb
    // out toward the palm side.
    { name: "oppose", axis: "spread", range: RANGE.oppose },
    { name: "mcp", range: RANGE.thumbMcp },
    { name: "ip", range: RANGE.ip },
  ],
  lengths: THUMB_LENGTHS,
});
// The thumb at rest on a palm frame at the origin: where its base pin sits in the palm's
// own coordinates, for building the palm's thumb bracket.
const THUMB_IN_PALM = THUMB.pose({}, { [PALM_FRAME]: { at: [0, 0, 0] } });

// ----- geometry --------------------------------------------------------------------

const box = (k, min, max) => k.box({ min, max });
/** A boss about the X axis centred at height y, across x0..x1. */
const xBoss = (k, y, x0, x1, r) => k.cylinder({ r, h: x1 - x0 }).along("+X").at([x0, y, 0]);
/** A boss about the Z axis centred at height y, across z0..z1. */
const zBoss = (k, y, z0, z1, r) => k.cylinder({ r, h: z1 - z0 }).at([0, y, z0]);

/**
 * A piece on an X pin: a tongue (the middle third of width w) rounded about its own pin at
 * the origin, then the body along +Y. With `fork`, the far end carries the next X pin's
 * cheeks (the outer thirds); without, it ends in a rounded tip at y = len.
 */
function link(k, len, fork, w) {
  const t = w / 6, near = R + GAP;
  const parts = [box(k, [-t, 0, -R], [t, near, R]), xBoss(k, 0, -t, t, R)];
  if (fork) parts.push(box(k, [-w / 2, near, -R], [w / 2, len - R - GAP, R]), ...xFork(k, len, w));
  else parts.push(box(k, [-w / 2, near, -R], [w / 2, len - R, R]), xBoss(k, len - R, -w / 2, w / 2, R));
  let s = k.union(parts).cut(xBoss(k, 0, -w, w, PIN_R));
  if (fork) s = s.cut(xBoss(k, len, -w, w, PIN_R));
  return s;
}

/** The two cheeks of an X-pin fork at height y, for a tongue of width w / 3. */
function xFork(k, y, w) {
  const t = w / 6, far = y - R - GAP;
  return [[-w / 2, -t - GAP], [t + GAP, w / 2]].flatMap(([x0, x1]) => [box(k, [x0, far, -R], [x1, y, R]), xBoss(k, y, x0, x1, R)]);
}

/**
 * A swivel piece (a finger's knuckle, the thumb's metacarpal): a thin tongue (|z| <= SLAB)
 * rounded about a Z pin at the origin, then the full-thickness body, ending in an X-pin
 * fork at y = len.
 */
function swivel(k, len, w) {
  const rz = w / 2, near = rz + GAP;
  return k.union([
    zBoss(k, 0, -SLAB, SLAB, rz),
    box(k, [-w / 2, 0, -SLAB], [w / 2, near, SLAB]),
    box(k, [-w / 2, near, -R], [w / 2, len - R - GAP, R]),
    ...xFork(k, len, w),
  ]).cut(zBoss(k, 0, -R - 1, R + 1, PIN_R)).cut(xBoss(k, len, -w, w, PIN_R));
}

/** A Z-pin fork's cheeks for a swivel of width w (its round end, full thickness)… */
const zCheeks = (k, w) => zBoss(k, 0, -R, R, w / 2);
/**
 * …and what the swivel's tongue needs cut out of them: the pin, and the running slot.
 * The slot's radius `r` is the tongue's round end plus the clearance; a joint that turns
 * far (the thumb's oppose) needs it out to the tongue's corners, which sweep behind the
 * pin. Past the point where the circle has left 1.25 mm of wall beside it, the slot runs
 * straight out through the sides: a circle crossing a flat side would leave a knife edge.
 */
function zSlot(k, w, r = w / 2 + GAP) {
  const from = -Math.sqrt(r * r - (w / 2 - 1.25) ** 2);
  return k.union([
    zBoss(k, 0, -SLAB - GAP, SLAB + GAP, r),
    box(k, [-w / 2 - 1.5, from, -SLAB - GAP], [w / 2 + 1.5, r, SLAB + GAP]),
    zBoss(k, 0, -R - 1, R + 1, PIN_R),
  ]);
}

/** The palm, in the wrist-yaw frame: a yaw tongue, the plate, a Z-pin fork per finger, and the thumb's bracket. */
function palm(k) {
  const plate = k.extrude({
    profile: [[-PALM_BOTTOM, PALM_BASE], [PALM_BOTTOM, PALM_BASE], [PALM_TOP, PALM_LEN - 12], [-PALM_TOP, PALM_LEN - 12]],
    h: 2 * R,
  }).translate([0, 0, -R]);
  const add = [
    plate,
    // The yaw tongue: the palm swivels on the wrist piece's Z-pin fork.
    zBoss(k, 0, -SLAB, SLAB, W / 2),
    box(k, [-W / 2, 0, -SLAB], [W / 2, PALM_BASE, SLAB]),
  ];
  const cut = [zBoss(k, 0, -R - 1, R + 1, PIN_R)];
  for (const f of FINGERS) {
    add.push(box(k, [f.x - W / 2, PALM_LEN - 14, -R], [f.x + W / 2, f.y, R]), zCheeks(k, W).translate([f.x, f.y, 0]));
    cut.push(zSlot(k, W).translate([f.x, f.y, 0]));
  }
  // The thumb's bracket, built in its base frame and placed where the thumb sits at rest.
  add.push(THUMB_IN_PALM.place(k.union([zCheeks(k, WT), box(k, [-WT / 2, -18, -R], [WT / 2, 0, R])]), "oppose"));
  cut.push(THUMB_IN_PALM.place(zSlot(k, WT, Math.hypot(WT / 2, WT / 2 + GAP) + GAP), "oppose"));
  return k.union(add).cut(k.union(cut));
}

/** The wrist piece, in the wrist-pitch frame: a tongue on the pitch pin, a Z-pin fork for the palm's yaw tongue. */
function carpal(k) {
  const t = W / 6;
  return k.union([
    box(k, [-t, 0, -R], [t, R + GAP, R]), xBoss(k, 0, -t, t, R),
    box(k, [-W / 2, R + GAP, -R], [W / 2, CARPAL, R]),
    zCheeks(k, W).translate([0, CARPAL, 0]),
  ]).cut(xBoss(k, 0, -W, W, PIN_R)).cut(zSlot(k, W).translate([0, CARPAL, 0]));
}

/** The stand, in part coordinates: a foot, a forearm post and the pitch pin's fork on top. */
function stand(k) {
  const t = W / 6, top = STAND_H - R - GAP;
  const cheeks = [[-W / 2, -t - GAP], [t + GAP, W / 2]].flatMap(([x0, x1]) => [
    box(k, [x0, -R, top - 4], [x1, R, STAND_H]),
    k.cylinder({ r: R, h: x1 - x0 }).along("+X").at([x0, 0, STAND_H]),
  ]);
  return k.union([
    k.cylinder({ r: 34, h: 5 }),
    k.cylinder({ r: 13, h: top }),
    ...cheeks,
  ]).cut(k.cylinder({ r: PIN_R, h: 2 * W }).along("+X").at([-W, 0, STAND_H]));
}

// ----- the pieces and the print kit ------------------------------------------------

const DIGITS = ["thumb", ...FINGERS.map((f) => f.id)];
const SEGMENTS = [["Knuckle", "spread"], ["Proximal", "mcp"], ["Middle", "pip"], ["Distal", "dip"]];

// Each digit's pieces, base first: { name, joint, len, w, kind }. A swivel turns on a Z
// pin (knuckle, metacarpal); a link on an X pin, with a fork for the next one unless it is
// the tip.
const DIGIT_PIECES = {
  thumb: [["Metacarpal", "oppose"], ["Proximal", "mcp"], ["Distal", "ip"]].map(([name, joint], i) => ({
    name, joint, len: THUMB_LENGTHS[i], w: WT, kind: i === 0 ? "swivel" : i < 2 ? "fork" : "tip",
  })),
  ...Object.fromEntries(FINGERS.map((f) => [f.id, SEGMENTS.map(([name, joint], i) => ({
    name, joint, len: i === 0 ? KNUCKLE : f.lengths[i - 1], w: W, kind: i === 0 ? "swivel" : i < 3 ? "fork" : "tip",
  }))])),
};
const buildPiece = ({ kind, len, w }) => (k) => (kind === "swivel" ? swivel(k, len, w) : link(k, len, kind === "fork", w));
/** A piece's extent along its own +Y (its length on the bed once laid out). */
const span = ({ kind, len, w }) => (kind === "swivel" ? [-w / 2, len + R] : [-R, kind === "fork" ? len + R : len]);

// The kit fits a 220 mm bed. Every piece is built with its faces at z = ±R, so `flat`
// puts its -Z face on the bed. The stand, palm and wrist piece share the bottom row;
// above them each digit is one row, its pieces turned to lie along X, base first.
const flat = (x, y) => (s) => s.translate([x, y, R]);
const KIT_LEFT = -110, KIT_SPACE = 4, KIT_ROW0 = -8, KIT_ROW = 20;
const KIT = {};
DIGITS.forEach((id, row) => {
  let x = KIT_LEFT;
  for (const piece of DIGIT_PIECES[id]) {
    const [y0, y1] = span(piece), at = [x - y0, KIT_ROW0 + row * KIT_ROW, R];
    KIT[`${id}${piece.name}`] = (s) => s.rotate(-90, [0, 0, 0], [0, 0, 1]).translate(at);
    x += y1 - y0 + KIT_SPACE;
  }
});

// ----- the part --------------------------------------------------------------------

const parts = {
  stand: {
    label: "Stand",
    build: (k) => stand(k),
    views: { assembly: (s) => s, print: (s) => s.translate([-76, -71, 0]) },
  },
  palm: {
    label: "Palm",
    build: (k) => palm(k),
    views: { assembly: (s, p, d) => d.palm.place(s, "wristYaw"), print: flat(13, -97) },
  },
  carpal: {
    label: "Wrist",
    build: (k) => carpal(k),
    views: { assembly: (s, p, d) => d.palm.place(s, "wristPitch"), print: flat(66, -99) },
  },
};
for (const id of DIGITS) {
  for (const piece of DIGIT_PIECES[id]) {
    const name = `${id}${piece.name}`;
    parts[name] = {
      label: `${id[0].toUpperCase()}${id.slice(1)} ${piece.name.toLowerCase()}`,
      build: buildPiece(piece),
      views: { assembly: (s, p, d) => d[id].place(s, piece.joint), print: KIT[name] },
    };
  }
}

// Every pair of pieces that share a pin.
const JOINT_PAIRS = [
  "stand×carpal", "carpal×palm", "palm×thumbMetacarpal", "thumbMetacarpal×thumbProximal", "thumbProximal×thumbDistal",
  ...FINGERS.flatMap((f) => [`palm×${f.id}Knuckle`, ...SEGMENTS.slice(1).map(([name], i) => `${f.id}${SEGMENTS[i][0]}×${f.id}${name}`)]),
];

// Fine steps: Pose mode snaps every param a drag wrote to its step on release, and every
// digit's handle writes the wrist. At 1° (or a 0.01 curl) that snap moved a fingertip
// 0.5–0.85 mm in one frame; at 0.1° and 0.001 it stays under 0.2 mm, which reads as still.
const deg = (key, label, range, description) => ({ key, label, unit: "°", min: range[0], max: range[1], step: 0.1, description });
const curl = (key, label) => ({ key, label, min: 0, max: 1, step: 0.001 });

// A preset is a hand shape: every digit's curl and spread, never the wrist or a lock.
const shape = (curls, spreads, thumbOppose, thumbCurl) => ({
  ...Object.fromEntries(FINGERS.flatMap((f, i) => [[`${f.id}Curl`, curls[i]], [`${f.id}Spread`, spreads[i]]])),
  thumbOppose, thumbCurl,
});
const PRESETS = {
  relaxed: shape([0.2, 0.28, 0.35, 0.42], [3, 0, 3, 6], 25, 0.2),
  open: shape([0, 0, 0, 0], [8, 0, 6, 12], 0, 0),
  // The thumb wraps across the curled fingers, as far as it goes without touching them.
  fist: shape([0.9, 0.9, 0.9, 0.9], [0, 0, 0, 0], 80, 0.5),
  point: shape([0, 0.9, 0.9, 0.9], [0, 0, 0, 0], 80, 0.5),
  peace: shape([0, 0, 0.9, 0.9], [12, -4, 0, 0], 80, 0.7),
  // The thumb and index tips meet (8 mm apart, tip point to tip point).
  ok: shape([0.65, 0.12, 0.18, 0.25], [0, 2, 5, 10], 60, 0.4),
};

export default {
  meta: { title: "Hand", units: "mm" },
  parameters: [
    { id: "pose", title: "Pose", description: "Pose-only: nothing here rebuilds a piece. In Pose mode, drag a fingertip instead.", controls: [
      { type: "preset", label: "Shape", presets: PRESETS },
      ...FINGERS.flatMap((f) => [
        curl(`${f.id}Curl`, `${f.label} curl`),
        deg(`${f.id}Spread`, `${f.label} spread`, RANGE.spread, f.id === "middle" ? "Positive leans it toward the index finger." : "Positive fans it away from the middle finger."),
      ]),
      deg("thumbOppose", "Thumb oppose", RANGE.oppose, "0 is the thumb in the palm's plane; higher swings it out in front of the palm."),
      curl("thumbCurl", "Thumb curl"),
    ] },
    { id: "wrist", title: "Wrist", controls: [
      deg("wristPitch", "Pitch", RANGE.wristPitch, "Positive bends the hand toward its palm."),
      deg("wristYaw", "Yaw", RANGE.wristYaw, "Positive turns the hand toward the thumb."),
    ] },
    { id: "locks", title: "Locks", collapsed: true,
      description: "A locked digit is left out of every drag in Pose mode — along with the wrist, so it holds still while you drag another. The shapes still set it.",
      controls: DIGITS.map((id) => ({ key: `${id}Lock`, type: "checkbox", label: `Lock ${id}` })) },
  ],
  defaults: {
    ...PRESETS.relaxed,
    wristPitch: 0, wristYaw: 0,
    ...Object.fromEntries(DIGITS.map((id) => [`${id}Lock`, 0])),
  },
  derive: (p) => {
    const palm = PALM.pose({ bend: { wristPitch: p.wristPitch, wristYaw: p.wristYaw } });
    const out = { palm };
    for (const f of FINGERS) {
      out[f.id] = FINGER_LIMBS[f.id].pose({ curl: p[`${f.id}Curl`], bend: { spread: f.sign * p[`${f.id}Spread`] } }, palm);
    }
    out.thumb = THUMB.pose({ curl: p.thumbCurl, bend: { oppose: p.thumbOppose } }, palm);
    return out;
  },
  parts,
  views: {
    assembly: { label: "Assembly" },
    print: { label: "Print" },
  },
  // `joints` gives a joint a rotate ring in Pose mode (hover its dot): the parameter that
  // turns it directly. The wrist (on the palm limb) is named by every digit's handle, so a
  // locked digit hides the wrist rings, as it holds the wrist out of every drag. A ring and
  // pinky spread is the negated parameter (`scale: -1`: positive fans away from the middle
  // finger). The knuckles are curl-driven — one parameter for two joints — so they get no ring.
  handles: {
    thumb: {
      limb: "thumb", mode: "angles", params: ["thumbCurl", "thumbOppose", "wristPitch", "wristYaw"], lock: "thumbLock",
      joints: { oppose: "thumbOppose", ...WRIST_JOINTS },
    },
    ...Object.fromEntries(FINGERS.map((f) => [f.id, {
      limb: f.id, mode: "angles", params: [`${f.id}Curl`, `${f.id}Spread`, "wristPitch", "wristYaw"], lock: `${f.id}Lock`,
      joints: { spread: f.sign === 1 ? `${f.id}Spread` : { param: `${f.id}Spread`, scale: f.sign }, ...WRIST_JOINTS },
    }])),
  },
  // No two pieces interpenetrate, and every pin joint keeps its running clearance (GAP)
  // between the pieces it joins: those near misses are intended. The assembled hand
  // stands under 250 mm, so even the assembly view fits the bed it is never printed on.
  verify: {
    process: "fdm-pla",
    expect: { _view: { overlaps: 0, clearance: Object.fromEntries(JOINT_PAIRS.map((pair) => [pair, ">=0.3"])) } },
  },
  // The agent's read-out: each digit's joint values, clamps and fingertip.
  probes: {
    digits: (k, p, d) => Object.fromEntries(DIGITS.map((id) => [id, d[id].report])),
  },
};
