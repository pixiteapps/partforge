// A posable human hand: the organic domain's reference part. One contact k.implicit
// (palm, thumb and four fingers pressing against each other, webbing blended into the
// palm, crease detail over the knuckles), plus a fine-grid nail on every digit.
//
// Authoring frame: palm facing -Z, fingers toward +Y, thumb toward -X — a right hand seen
// from above. Every bone is a capsule along its frame's +Y; flexion is a negative rotation
// about the frame's X. The builders are named exports too: the engine's tests use this hand
// as their fixture (test/fixtures/implicit-trees.js re-exports them), so a change here moves
// pinned mesh hashes.

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
  handLength: 190, slender: 1, knuckles: 0.5, fingerBlend: 3, palmBlend: 8, creases: true, creaseDepth: 0.5,
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
  const bulge = 1 + 0.18 * knuckles;
  const distal = { kind: "capsule", frame: `${name}.dip`, b: [0, L[2], 0], r: [R[2], R[3]] };
  const flesh = {
    kind: "union", k: blend, label: name, children: [
      { kind: "capsule", frame: `${name}.mcp`, b: [0, L[0], 0], r: [R[0], R[1]] },
      { kind: "capsule", frame: `${name}.pip`, b: [0, L[1], 0], r: [R[1], R[2]] },
      distal,
      { kind: "ellipsoid", frame: `${name}.mcp`, at: [0, 0, R[0] * 0.25], r: [R[0] * 0.95, R[0] * 1.1, R[0] * 0.85 * bulge] },
      { kind: "ellipsoid", frame: `${name}.pip`, r: [R[1] * 1.02 * bulge, R[1] * 1.25, R[1] * 1.02 * bulge] },
    ],
  };
  return { frames, flesh, distal, tipR: R[3], tipFrame: `${name}.tip`, dorsal: { pip: R[1] * 1.02 * bulge, dip: R[2] } };
}

/** A fingernail: a shell section around the distal phalanx clipped to an oval footprint, meshed on its own fine grid. */
function nail(frames, distal, tipFrame, tipR, s) {
  const w = tipR * 1.35, len = 11 * s;
  const shell = { kind: "onion", t: 0.7, child: { kind: "round", r: 0.1, child: { ...distal } } };
  const footprint = { kind: "ellipsoid", frame: tipFrame, at: [0, -len * 0.5, tipR * 0.75], r: [w / 2, len / 2, tipR * 1.1] };
  return { frames, root: { kind: "intersect", k: 0.3, children: [shell, footprint] }, resolution: 0.25, preview: 0.35 };
}

function buildHand(pose = {}) {
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

/**
 * Contact poses. `fist`: every finger curled until its tip pads against the palm (all four
 * press 2.4–5.7 mm deep). `nearMiss`: the index and middle fingers 0.75 mm apart at their
 * closest — the spread found by bisecting min max(d_index, d_middle) (half their gap) over
 * their middle and distal phalanges. A spread sweep brings these two closest at their PIP
 * knuckles, the fattest part, not at their tips (test/implicit-topology.test.js).
 */
export const HAND_POSES = {
  fist: { curl: 100, flex: { index: 105, middle: 105, ring: 105, pinky: 105, thumb: 50 } },
  nearMiss: { spread: -0.1086 },
};

/** The spike's hand as one k.implicit spec (no nails; see nailSpecs). */
export function handSpec(pose = {}) {
  const { frames, body, detail } = buildHand(pose);
  return { frames, root: body, detail, preview: 1.5, resolution: 0.8 };
}

/** One fine-grid nail spec per digit (index, middle, ring, pinky, thumb), to union onto handSpec's solid. */
export function nailSpecs(pose = {}) {
  return buildHand(pose).nails.map((make) => make());
}

// The part's params, flat, to the pose handSpec takes.
const pose = (p) => ({
  curl: p.curl, spread: p.spread, oppose: p.oppose, handLength: p.handLength,
  flex: { index: p.flexIndex, middle: p.flexMiddle, ring: p.flexRing, pinky: p.flexPinky, thumb: p.flexThumb },
});
const D = HAND_DEFAULTS;
const flexControl = (key, label, max) => ({ key, label, unit: "%", min: 0, max, step: 1, description: `${label}'s bend, as a share of a full curl.` });

export default {
  meta: { title: "Hand", units: "mm", backend: "manifold" },
  parameters: [
    { id: "pose", title: "Pose", controls: [
      { key: "curl", label: "Curl", unit: "%", min: 0, max: 100, step: 1, description: "How far every finger closes, scaling each finger's flex." },
      { key: "spread", label: "Spread", unit: "°", min: -5, max: 15, step: 0.5, description: "How far the fingers fan apart." },
      { key: "oppose", label: "Thumb opposition", unit: "°", min: 0, max: 60, step: 1, description: "How far the thumb swings across the palm." },
    ] },
    { id: "fingers", title: "Fingers", controls: [
      flexControl("flexIndex", "Index", 110), flexControl("flexMiddle", "Middle", 110),
      flexControl("flexRing", "Ring", 110), flexControl("flexPinky", "Pinky", 110),
      flexControl("flexThumb", "Thumb", 90),
    ] },
    { id: "size", title: "Size", controls: [
      { key: "handLength", label: "Hand length", unit: "mm", min: 150, max: 230, step: 1, description: "Wrist to middle fingertip; everything scales with it." },
    ] },
  ],
  defaults: {
    curl: D.curl, spread: D.spread, oppose: D.oppose, handLength: D.handLength,
    flexIndex: D.flex.index, flexMiddle: D.flex.middle, flexRing: D.flex.ring, flexPinky: D.flex.pinky, flexThumb: D.flex.thumb,
  },
  parts: {
    hand: {
      label: "Hand",
      // The body is one contact k.implicit. The nails are each their own k.implicit on a
      // 0.25 mm grid, unioned on: a feature too thin for the body's grid gets its own.
      build: (k, p) => k.union([k.implicit(handSpec(pose(p))), ...nailSpecs(pose(p)).map((s) => k.implicit(s))]),
      views: ["assembly"],
    },
  },
  views: { assembly: { label: "Hand" } },
  // Where every joint and fingertip ends up: measure writes the frame report out.
  probes: { frames: (k, p) => k.implicitFrames(handSpec(pose(p))) },
  verify: { expect: { hand: { watertight: true } } },
};
