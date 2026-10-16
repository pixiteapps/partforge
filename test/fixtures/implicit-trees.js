// test/fixtures/implicit-trees.js
// Reference fixtures for the implicit engine: the posable hand from the spike
// (c0b5b5d3:src/parts/hand-spike.js), ported to the final grammar as plain specs,
// a textured vase that touches every grammar feature at once, a few adversarial
// trees, and a seeded random-tree generator for fuzzing.
//
// Hand authoring frame (as in the spike): palm facing −Z, fingers toward +Y,
// thumb toward −X — a right hand seen from above. Every bone is a capsule along
// its frame's +Y; flexion is a negative rotation about the frame's X.

// Segment lengths (mm) and radii at a 190 mm hand. r = radius at MCP, PIP, DIP, tip.
const FINGERS = {
  index:  { mcp: [-30, 96, 2],  len: [42, 25, 22], r: [9.5, 8.5, 7.4, 6.4] },
  middle: { mcp: [-10, 101, 3], len: [46, 29, 23], r: [9.6, 8.6, 7.5, 6.5] },
  ring:   { mcp: [10, 97, 2],   len: [43, 27, 22], r: [9.0, 8.0, 7.0, 6.2] },
  pinky:  { mcp: [30, 88, 0],   len: [34, 20, 19], r: [7.8, 7.0, 6.2, 5.5] },
};
const THUMB = { cmc: [-24, 12, -5], len: [46, 32, 27], r: [13, 11, 9.5, 7.8] };
const FAN = { index: 1, middle: 0.33, ring: -0.33, pinky: -1 };

const HAND_DEFAULTS = {
  curl: 30, spread: 8, flex: { index: 60, middle: 60, ring: 60, pinky: 60, thumb: 50 }, oppose: 20,
  handLength: 190, slender: 1, knuckles: 0.5, fingerBlend: 3, palmBlend: 8, creases: true, creaseDepth: 0.5,
};

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
  return { frames, flesh, distal, tipR: R[3], tipFrame: `${name}.tip` };
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
    if (p.creases) for (const joint of ["pip", "dip"]) {
      detail.push({ kind: "creases", frame: `${name}.${joint}`, amplitude: p.creaseDepth, wavelength: 1.6 * s, radius: 6 * s, axis: "y", side: [0, 0, 1] });
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
  if (p.creases) detail.push({ kind: "creases", frame: "thumb.ip", amplitude: p.creaseDepth, wavelength: 1.8 * s, radius: 7 * s, axis: "y", side: [0, 0, 1] });

  const palm = {
    kind: "union", k: 10 * s, label: "palm", children: [
      { kind: "box", frame: "palm", at: [0, 50 * s, 0], size: [78 * s, 92 * s, 20 * s], round: 9 * s },
      { kind: "ellipsoid", frame: "thumb.cmc", at: [0, 20 * s, -1 * s], r: [15 * s, 27 * s, 11 * s], label: "thenar" },
      { kind: "ellipsoid", frame: "palm", at: [-28 * s, 42 * s, -2 * s], r: [13 * s, 36 * s, 12 * s], label: "hypothenar" },
      { kind: "box", frame: "palm", at: [0, -4 * s, 0], size: [62 * s, 44 * s, 21 * s], round: 9 * s, label: "wrist" },
    ],
  };
  const body = {
    kind: "union", k: p.palmBlend * s, children: [
      palm,
      { kind: "union", k: 0, children: fingers },   // fingers never blend into each other
      thumb,
    ],
  };
  return { frames, body, detail, nails };
}

/** The spike's hand as one k.implicit spec (no nails; see nailSpecs). */
export function handSpec(pose = {}) {
  const { frames, body, detail } = buildHand(pose);
  return { frames, root: body, detail, preview: 1.5, resolution: 0.8 };
}

/** One fine-grid nail spec per digit (index, middle, ring, pinky, thumb), to union onto handSpec's solid. */
export function nailSpecs(pose = {}) {
  return buildHand(pose).nails.map((make) => make());
}

/** A textured vase: taper, twist, onion, polar repeat, an expr gyroid, a blend, and texture detail. */
export function vaseSpec() {
  const n = 64, data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = ((x >> 3) + (y >> 3)) % 2 ? 65535 : 0;   // checker
  const images = new Map([["checker", { digest: "checker-64", width: n, height: n, data }]]);
  const spec = {
    root: { kind: "union", k: 2, children: [
      { kind: "taper", from: [0, 1], to: [60, 0.55], child: { kind: "twist", degPerMm: 1.5, child: {
        kind: "onion", t: 1.6, child: { kind: "union", k: 3, children: [
          { kind: "cylinder", h: 60, r: 20, at: [0, 0, 30], round: 4 },
          { kind: "repeat", polar: { count: 12 }, child: { kind: "capsule", a: [20, 0, 4], b: [20, 0, 56], r: 2.2 } },
        ] } } } },
      { kind: "intersect", children: [
        { kind: "expr", box: [[-12, 14, 10], [12, 26, 40]], lipschitz: 1.8,
          sdf: "float g = sin(p.x*k)*cos(p.y*k) + sin(p.y*k)*cos(p.z*k) + sin(p.z*k)*cos(p.x*k); return abs(g)/k - t;", uniforms: { k: 0.9, t: 0.35 } },
        { kind: "box", size: [20, 8, 26], at: [0, 20, 25], round: 2 },
      ] },
    ] },
    detail: [{ kind: "texture", image: "checker", amplitude: 0.4, projection: "cylindrical", axis: "z", size: [40, 60], at: [0, 0, 30], radius: 30 }],
    preview: 1.2, resolution: 0.6,
  };
  return { spec, images };
}

export const ADVERSARIAL = {
  tangentSpheres: { root: { kind: "union", children: [{ kind: "sphere", r: 5 }, { kind: "sphere", r: 5, at: [10, 0, 0] }] }, preview: 1 },
  coincidentFaces: { root: { kind: "union", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [10, 10, 10], at: [10, 0, 0] }] }, preview: 1 },
  thinPlate: { root: { kind: "box", size: [30, 30, 1.6] }, preview: 1 },   // under 2 cells: warned, still meshes
  highLipschitz: { root: { kind: "expr", box: [[-10, -10, -10], [10, 10, 10]], lipschitz: 3,
    sdf: "return max(length(p) - 9.0, (sin(p.x*3.0)+sin(p.y*3.0)+sin(p.z*3.0)) * 0.33);" }, preview: 0.8 },
  displaceAtLimit: { root: { kind: "displace", amount: 2, by: { expr: "return sin(p.x) * sin(p.y) * sin(p.z) > 0.0 ? 1.0 : -1.0;" }, child: { kind: "sphere", r: 8 } }, preview: 1 },
};

/** Under one cell with its face on a grid plane: may vanish (warned, never an open mesh or a crash). */
export const SUB_CELL_PLATE = { root: { kind: "box", size: [30, 30, 0.9] }, preview: 1 };

/** Seeded random trees: unions/intersections/subtractions of placed primitives, warps and repeats. */
export function randomSpec(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const v3 = (r) => [(rnd() * 2 - 1) * r, (rnd() * 2 - 1) * r, (rnd() * 2 - 1) * r];
  const leaf = () => pick([
    () => ({ kind: "sphere", r: 2 + rnd() * 4, at: v3(6) }),
    () => ({ kind: "box", size: [2 + rnd() * 8, 2 + rnd() * 8, 2 + rnd() * 8], round: rnd() * 0.9, at: v3(6) }),
    () => ({ kind: "capsule", a: v3(6), b: v3(6), r: [1.5 + rnd() * 2, 1.5 + rnd() * 2] }),
    () => ({ kind: "torus", R: 4 + rnd() * 3, r: 1.2 + rnd(), at: v3(4), axis: pick(["x", "y", "z"]) }),
  ])();
  const node = (depth) => {
    if (depth === 0) return leaf();
    const kind = pick(["union", "union", "intersect", "subtract", "twist", "repeat"]);
    if (kind === "twist") return { kind, degPerMm: rnd() * 8 - 4, child: node(depth - 1) };
    if (kind === "repeat") return { kind, polar: { count: 2 + Math.floor(rnd() * 4) }, child: { ...leaf(), at: [7, 0, 0] } };
    return { kind, k: rnd() * 3, children: [node(depth - 1), node(depth - 1), ...(rnd() < 0.5 ? [leaf()] : [])] };
  };
  return { root: node(2), preview: 1 };
}
