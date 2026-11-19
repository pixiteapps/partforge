// A posable human hand: the organic domain's reference part. One contact k.implicit
// (palm, thumb and four fingers pressing against each other, webbing blended into the
// palm, crease detail over the knuckles), plus a fine-grid nail on every digit.
//
// Authoring frame: palm facing -Z, fingers toward +Y, thumb toward -X — a right hand seen
// from above. Every bone is a capsule along its frame's +Y; flexion is a negative rotation
// about the frame's X. The builders are named exports too: the engine's tests use this hand
// as their fixture (test/fixtures/implicit-trees.js re-exports them), so a change here moves
// pinned mesh hashes. The part itself poses each digit as a limb (below), so Pose mode can
// drag the fingers.
import { limb } from "partforge/kinematics";

// Segment lengths (mm) and radii at a 190 mm hand. r = radius at MCP, PIP, DIP, tip.
export const FINGERS = {
  index:  { mcp: [-30, 96, 2],  len: [42, 25, 22], r: [9.5, 8.5, 7.4, 6.4] },
  middle: { mcp: [-10, 101, 3], len: [46, 29, 23], r: [9.6, 8.6, 7.5, 6.5] },
  ring:   { mcp: [10, 97, 2],   len: [43, 27, 22], r: [9.0, 8.0, 7.0, 6.2] },
  pinky:  { mcp: [30, 88, 0],   len: [34, 20, 19], r: [7.8, 7.0, 6.2, 5.5] },
};
export const THUMB = { cmc: [-24, 12, -5], len: [46, 32, 27], r: [13, 11, 9.5, 7.8] };
export const FAN = { index: 1, middle: 0.33, ring: -0.33, pinky: -1 };

export const HAND_DEFAULTS = {
  curl: 30, spread: 8, flex: { index: 60, middle: 60, ring: 60, pinky: 60, thumb: 50 }, oppose: 20,
  // fingerBlend: a smooth union swells where its members meet by k/4, so at each joint, where
  // two phalanges meet, it alone makes a k/4 ring; 1 mm keeps that ring to 0.25 mm.
  handLength: 190, slender: 1, knuckles: 0.5, fingerBlend: 1, palmBlend: 8, creases: true, creaseDepth: 0.5,
  contactGap: 0, bulge: 1,   // the engine's BULGE_DEFAULT (test/hand-part.test.js holds them equal)
};
// Attachments (mm at a 190 mm hand) around each digit's base frame: within `radius` the
// digit blends into the palm (the webbing); beyond radius + band it presses. A finger's
// radius is a third of its proximal phalanx: in a fist (HAND_POSES.fist) its base overlaps
// the palm out to 12–15 mm from the knuckle and its tip pad starts 15–24 mm out (the
// pinky's 12.3 and 15.3), so radius + band must fall between the two — hence the short
// band (radius/2 would reach the pinky's pad and blend it in). The thumb's metacarpal lies
// in the thenar out to 47 mm from its root frame.
const ATTACH = { fingerFrac: 1 / 3, fingerBand: 3, thumb: 40, thumbBand: 10 };

/** Frames + flesh for one three-jointed digit. `flex` is [mcp, pip, dip] in degrees. */
function finger(name, spec, s, { flex, abduct, slender, knuckles, blend }) {
  const L = spec.len.map((v) => v * s), R = spec.r.map((v) => v * s * slender);
  const frames = {
    [`${name}.mcp`]: { parent: "palm", at: spec.mcp.map((v) => v * s), rotate: [{ axis: "z", deg: abduct }, { axis: "x", deg: -flex[0] }] },
    [`${name}.pip`]: { parent: `${name}.mcp`, at: [0, L[0], 0], rotate: { axis: "x", deg: -flex[1] } },
    [`${name}.dip`]: { parent: `${name}.pip`, at: [0, L[1], 0], rotate: { axis: "x", deg: -flex[2] } },
    [`${name}.tip`]: { parent: `${name}.dip`, at: [0, L[2], 0] },
  };
  // The knuckles stand only a little proud of the finger: ~3% at the MCP, ~2% at the PIP.
  const bulge = 1 + 0.04 * knuckles;
  const distal = { kind: "capsule", frame: `${name}.dip`, b: [0, L[2], 0], r: [R[2], R[3]] };
  const flesh = {
    kind: "union", k: blend, label: name, children: [
      { kind: "capsule", frame: `${name}.mcp`, b: [0, L[0], 0], r: [R[0], R[1]] },
      { kind: "capsule", frame: `${name}.pip`, b: [0, L[1], 0], r: [R[1], R[2]] },
      distal,
      { kind: "ellipsoid", frame: `${name}.mcp`, at: [0, 0, R[0] * 0.04], r: [R[0] * 0.97, R[0] * 1.05, R[0] * 0.97 * bulge] },
      { kind: "ellipsoid", frame: `${name}.pip`, r: [R[1] * bulge, R[1] * 1.1, R[1] * bulge] },
    ],
  };
  return { frames, flesh, distal, tipR: R[3], tipFrame: `${name}.tip`, dorsal: { pip: R[1] * bulge, dip: R[2] } };
}

/**
 * A fingernail: a shell section around the distal phalanx clipped to an oval footprint, meshed
 * on its own fine grid. The shell follows a slimmer copy of the phalanx (`sink` mm in at the DIP,
 * almost none at the tip), so the nail's back edge tucks under the skin like a cuticle while its
 * free edge stands proud near the fingertip.
 */
function nail(frames, distal, tipFrame, tipR, s) {
  // The nail's outer face is its bed + 0.8 mm (round 0.1, onion 0.7). The bed sits ~1.1 mm
  // under the skin at the nail's back edge (outer face 0.3 mm below the skin) and 0.4 mm at the
  // tip (free edge 0.4 mm proud); the nail runs from just over the fingertip's crown back `len`.
  const w = tipR * 1.35, len = 11 * s;
  const bed = { ...distal, r: [distal.r[0] - 2.5 * s, distal.r[1] - 0.4 * s] };
  const shell = { kind: "onion", t: 0.7, child: { kind: "round", r: 0.1, child: bed } };
  const footprint = { kind: "ellipsoid", frame: tipFrame, at: [0, tipR * 0.55 - len / 2, tipR * 0.75], r: [w / 2, len / 2, tipR * 1.1] };
  return { frames, root: { kind: "intersect", k: 0.3, children: [shell, footprint] }, resolution: 0.25, preview: 0.35 };
}

// `digitFrames`, when given, replaces every digit's frames (the part passes its posed limbs'
// frames, the same names); the pose's flex, curl, spread and oppose then pose nothing.
function buildHand(pose = {}, digitFrames = null) {
  const p = { ...HAND_DEFAULTS, ...pose, flex: { ...HAND_DEFAULTS.flex, ...pose.flex } };
  const s = p.handLength / 190;
  const curl = p.curl / 100;
  const flexOf = (pct) => [pct * 0.85, pct * 1.0, pct * 0.75].map((d) => d * curl);
  const frames = { palm: { at: [0, 0, 0] } };
  const fingers = [], nails = [], detail = [];
  for (const [name, spec] of Object.entries(FINGERS)) {
    const f = finger(name, spec, s, {
      flex: flexOf(p.flex[name]), abduct: FAN[name] * p.spread, slender: p.slender,
      knuckles: p.knuckles, blend: p.fingerBlend,
    });
    Object.assign(frames, f.frames);
    fingers.push(f.flesh);
    nails.push(() => nail(frames, f.distal, f.tipFrame, f.tipR, s));
    // A ~6 mm patch of creases on the dorsal skin of each PIP/DIP joint: centred on
    // the skin above the joint (the PIP knuckle ellipsoid's top; the DIP capsule's),
    // so the authored radius reaches it; `side` keeps them off the palm side.
    if (p.creases) for (const joint of ["pip", "dip"]) {
      detail.push({ kind: "creases", frame: `${name}.${joint}`, at: [0, 0, f.dorsal[joint]], amplitude: p.creaseDepth, wavelength: 1.6 * s, radius: 6 * s, axis: "y", side: [0, 0, 1] });
    }
  }
  const tf = flexOf(p.flex.thumb);
  const T = { len: THUMB.len.map((v) => v * s), r: THUMB.r.map((v) => v * s * p.slender) };
  Object.assign(frames, {
    "thumb.cmc": { parent: "palm", at: THUMB.cmc.map((v) => v * s),
      rotate: [{ axis: "z", deg: 55 + p.spread * 0.5 }, { axis: "x", deg: -(12 + p.oppose * 0.4) }, { axis: "y", deg: -(45 + p.oppose) }] },
    "thumb.mcp": { parent: "thumb.cmc", at: [0, T.len[0], 0], rotate: { axis: "x", deg: -tf[1] * 0.6 } },
    "thumb.ip": { parent: "thumb.mcp", at: [0, T.len[1], 0], rotate: { axis: "x", deg: -tf[2] } },
    "thumb.tip": { parent: "thumb.ip", at: [0, T.len[2], 0] },
  });
  const thumbDistal = { kind: "capsule", frame: "thumb.ip", b: [0, T.len[2], 0], r: [T.r[2], T.r[3]] };
  const thumb = {
    kind: "union", k: p.fingerBlend, label: "thumb", children: [
      { kind: "capsule", frame: "thumb.cmc", b: [0, T.len[0], 0], r: [T.r[0], T.r[1]] },
      { kind: "capsule", frame: "thumb.mcp", b: [0, T.len[1], 0], r: [T.r[1], T.r[2]] },
      thumbDistal,
      { kind: "ellipsoid", frame: "thumb.mcp", r: [T.r[1] * 1.05, T.r[1] * 1.25, T.r[1] * 1.0] },
    ],
  };
  nails.push(() => nail(frames, thumbDistal, "thumb.tip", T.r[3], s));
  if (p.creases) detail.push({ kind: "creases", frame: "thumb.ip", amplitude: p.creaseDepth, wavelength: 1.8 * s, at: [0, 0, T.r[2]], radius: 7 * s, axis: "y", side: [0, 0, 1] });
  // Same names, so every key keeps its place in `frames` (a pose drag deforms only when
  // the frame tables differ in values alone) and the nails see the posed frames too.
  if (digitFrames) Object.assign(frames, digitFrames);

  const palm = {
    kind: "union", k: 10 * s, label: "palm", children: [
      { kind: "box", frame: "palm", at: [0, 50 * s, 0], size: [78 * s, 92 * s, 20 * s], round: 9 * s },
      { kind: "ellipsoid", frame: "thumb.cmc", at: [0, 20 * s, -1 * s], r: [15 * s, 27 * s, 11 * s], label: "thenar" },
      { kind: "ellipsoid", frame: "palm", at: [-28 * s, 42 * s, -2 * s], r: [13 * s, 36 * s, 12 * s], label: "hypothenar" },
      { kind: "box", frame: "palm", at: [0, -4 * s, 0], size: [62 * s, 44 * s, 21 * s], round: 9 * s, label: "wrist" },
    ],
  };
  // The palm, thumb and fingers press against each other (contact) instead of bridging:
  // each digit is joined to the palm near its base (the webbing, a palmBlend blend) and
  // pressed elsewhere — a fist's fingertips pad against the palm, neighbours keep clear.
  const attach = [
    { a: "thumb", b: "palm", near: "thumb.cmc", radius: ATTACH.thumb * s, band: ATTACH.thumbBand * s, k: p.palmBlend * s },
    ...Object.entries(FINGERS).map(([name, spec]) => ({
      a: name, b: "palm", near: `${name}.mcp`, radius: spec.len[0] * ATTACH.fingerFrac * s, band: ATTACH.fingerBand * s, k: p.palmBlend * s,
    })),
  ];
  const body = { kind: "contact", gap: p.contactGap, bulge: p.bulge, attach, children: [palm, thumb, ...fingers] };
  return { frames, body, detail, nails };
}

/** The spike's hand as one k.implicit spec (no nails; see nailSpecs). */
export function handSpec(pose = {}, digitFrames = null) {
  const { frames, body, detail } = buildHand(pose, digitFrames);
  return { frames, root: body, detail, preview: 1.5, resolution: 0.8 };
}

/** One fine-grid nail spec per digit (index, middle, ring, pinky, thumb), to union onto handSpec's solid. */
export function nailSpecs(pose = {}, digitFrames = null) {
  return buildHand(pose, digitFrames).nails.map((make) => make());
}

// ----- the part: every digit a limb, posed in derive ---------------------------------
//
// Each digit is a limb() on the palm frame, written with the fixture's own numbers (the
// limb's frames resolve bit for bit to handSpec's — test/kinematics-port.test.js), so
// Pose mode can drag it. A finger is mcp, pip and dip, dip following pip by 0.75 as the
// fixture's flex shares do: `<f>Knuckle` bends the mcp alone and `<f>Curl` closes the two
// outer joints, so a fingertip pulled straight out straightens the finger from the knuckle
// (one curl would leave the tip a single arc). `<f>Spread` turns the finger's base about
// the palm's Z, positive fanning away from the middle finger (the middle leans toward the
// index). The thumb is cmc (fixed), mcp and ip; `thumbOppose` sets its cmc's orientation,
// as the fixture's oppose does.
//
// A pose change reshapes the one k.implicit body, so it rebuilds; a drag in Pose mode
// shows the last exact mesh skinned to the new frames until the rebuild lands.

const PIP_MAX = 100;        // a curl of 1 closes the pip this far; the dip follows at 0.75
const THUMB_IP_MAX = 90;    // thumbCurl 1 closes the thumb's ip this far
const RANGE = { knuckle: [-10, 90], pip: [0, PIP_MAX], dip: [0, PIP_MAX * 0.75], spread: [-10, 20], thumbKnuckle: [0, 60], thumbIp: [0, THUMB_IP_MAX], oppose: [0, 60] };
// +1: a positive spread turns the finger the way the fixture's positive `spread` does
const SPREAD_SIGN = { index: 1, middle: 1, ring: -1, pinky: -1 };
const DIGITS = [...Object.keys(FINGERS), "thumb"];
const LABEL = { index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky", thumb: "Thumb" };

/** Every digit posed on the palm frame, from the part's flat params. */
function poseDigits(p) {
  const s = p.handLength / 190;
  const palm = { palm: { at: [0, 0, 0] } };
  const out = {};
  for (const [name, spec] of Object.entries(FINGERS)) {
    out[name] = limb(name, {
      parent: "palm", at: spec.mcp.map((v) => v * s),
      rotate: [{ axis: "z", deg: SPREAD_SIGN[name] * p[`${name}Spread`] }],
      joints: [
        { name: "mcp", range: RANGE.knuckle },
        { name: "pip", range: RANGE.pip },
        { name: "dip", range: RANGE.dip, follow: { joint: "pip", ratio: 0.75 } },
      ],
      lengths: spec.len.map((v) => v * s),
    }).pose({ bend: { mcp: p[`${name}Knuckle`], pip: p[`${name}Curl`] * PIP_MAX } }, palm);
  }
  out.thumb = limb("thumb", {
    parent: "palm", at: THUMB.cmc.map((v) => v * s),
    rotate: [{ axis: "z", deg: 59 }, { axis: "x", deg: -(12 + p.thumbOppose * 0.4) }, { axis: "y", deg: -(45 + p.thumbOppose) }],
    joints: [
      { name: "cmc", range: [0, 0] },
      { name: "mcp", range: RANGE.thumbKnuckle },
      { name: "ip", range: RANGE.thumbIp },
    ],
    lengths: THUMB.len.map((v) => v * s),
  }).pose({ bend: { mcp: p.thumbKnuckle, ip: p.thumbCurl * THUMB_IP_MAX } }, palm);
  return out;
}

// The posed digits' frames, in the order handSpec writes them.
const digitFrames = (d) => Object.assign({}, ...DIGITS.map((n) => d[n].frames));
const sized = (p) => ({ handLength: p.handLength });

// A shape is every digit's knuckle, curl and spread, never a lock. Each finger is
// [knuckle°, curl, spread°]; the thumb is [oppose°, knuckle°, curl].
const shape = (fingers, [thumbOppose, thumbKnuckle, thumbCurl]) => ({
  ...Object.fromEntries(Object.keys(FINGERS).flatMap((f, i) => [
    [`${f}Knuckle`, fingers[i][0]], [`${f}Curl`, fingers[i][1]], [`${f}Spread`, fingers[i][2]],
  ])),
  thumbOppose, thumbKnuckle, thumbCurl,
});
// `relaxed` is HAND_DEFAULTS' pose (flex 60 at a 30% curl: mcp 15.3°, pip 18°; spread 8
// scaled by FAN; the thumb's mcp 9° and ip 11.25°).
const PRESETS = {
  relaxed: shape([[15.3, 0.18, 8], [15.3, 0.18, 2.64], [15.3, 0.18, 2.64], [15.3, 0.18, 8]], [20, 9, 0.125]),
  open: shape([[0, 0, 10], [0, 0, 3], [0, 0, 3], [0, 0, 10]], [0, 0, 0]),
  // Every fingertip pads against the palm (near HAND_POSES.fist: flex 105 at a full curl).
  fist: shape([[89.3, 1, 8], [89.3, 1, 2.64], [89.3, 1, 2.64], [89.3, 1, 8]], [20, 30, 0.417]),
  point: shape([[0, 0, 8], [89.3, 1, 2.64], [89.3, 1, 2.64], [89.3, 1, 8]], [20, 30, 0.417]),
};

// Fine steps: Pose mode snaps every param a drag wrote to its step on release.
const deg = (key, label, range, description) => ({ key, label, unit: "°", min: range[0], max: range[1], step: 0.1, description });
const curl = (key, label, description) => ({ key, label, min: 0, max: 1, step: 0.001, description });

export default {
  meta: { title: "Organic hand", units: "mm", backend: "manifold" },
  parameters: [
    { id: "pose", title: "Pose", description: "In Pose mode, drag a fingertip or a knuckle instead.", controls: [
      { type: "preset", label: "Shape", presets: PRESETS },
    ] },
    { id: "fingers", title: "Fingers", controls: Object.keys(FINGERS).flatMap((f) => [
      deg(`${f}Knuckle`, `${LABEL[f]} knuckle`, RANGE.knuckle, "The base knuckle's bend: 0 is in line with the palm."),
      curl(`${f}Curl`, `${LABEL[f]} curl`, "Closes the two outer joints, the tip one following the middle one."),
      deg(`${f}Spread`, `${LABEL[f]} spread`, RANGE.spread, f === "middle" ? "Positive leans it toward the index finger." : "Positive fans it away from the middle finger."),
    ]) },
    { id: "thumb", title: "Thumb", controls: [
      deg("thumbOppose", "Thumb opposition", RANGE.oppose, "How far the thumb swings across the palm."),
      deg("thumbKnuckle", "Thumb knuckle", RANGE.thumbKnuckle, "The thumb's base knuckle bend."),
      curl("thumbCurl", "Thumb curl", "Closes the thumb's tip joint."),
    ] },
    { id: "size", title: "Size", controls: [
      { key: "handLength", label: "Hand length", unit: "mm", min: 150, max: 230, step: 1, description: "Wrist to middle fingertip; everything scales with it." },
    ] },
    { id: "locks", title: "Locks", collapsed: true,
      description: "A locked digit is left out of every drag in Pose mode. The shapes still set it.",
      controls: DIGITS.map((id) => ({ key: `${id}Lock`, type: "checkbox", label: `Lock ${id}` })) },
  ],
  defaults: {
    ...PRESETS.relaxed,
    handLength: 190,
    ...Object.fromEntries(DIGITS.map((id) => [`${id}Lock`, 0])),
  },
  derive: (p) => poseDigits(p),
  parts: {
    hand: {
      label: "Hand",
      // The body is one contact k.implicit. The nails are each their own k.implicit on a
      // 0.25 mm grid, unioned on: a feature too thin for the body's grid gets its own.
      build: (k, p, d) => k.union([
        k.implicit(handSpec(sized(p), digitFrames(d))),
        ...nailSpecs(sized(p), digitFrames(d)).map((s) => k.implicit(s)),
      ]),
      views: ["assembly"],
    },
  },
  views: { assembly: { label: "Hand" } },
  // One angles-mode handle per digit: drag a fingertip or joint, and the drag solves that
  // digit's knuckle, curl and spread (the thumb's opposition). The knuckle (mcp) is its
  // own parameter, so it also gets a rotate ring; the curl drives two joints and is left
  // to the drag.
  handles: {
    ...Object.fromEntries(Object.keys(FINGERS).map((f) => [f, {
      on: f, drag: "angles", params: [`${f}Knuckle`, `${f}Curl`, `${f}Spread`], lock: `${f}Lock`,
      joints: { mcp: `${f}Knuckle` },
    }])),
    thumb: {
      on: "thumb", drag: "angles", params: ["thumbKnuckle", "thumbCurl", "thumbOppose"], lock: "thumbLock",
      joints: { mcp: "thumbKnuckle" },
    },
  },
  // Where every joint and fingertip ends up: measure writes the frame report out.
  probes: { frames: (k, p, d) => k.implicitFrames(handSpec(sized(p), digitFrames(d))) },
  verify: { expect: { hand: { watertight: true } } },
};
