// test/fixtures/implicit-trees.js
// Reference fixtures for the implicit engine: the posable hand (src/parts/hand.js, the
// organic reference part, re-exported here so the engine's tests keep one import), a
// textured vase that touches every grammar feature at once, a few adversarial trees, and a
// seeded random-tree generator for fuzzing.

export { FINGERS, THUMB, FAN, HAND_DEFAULTS, HAND_POSES, handSpec, nailSpecs } from "../../src/parts/hand.js";

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

/**
 * A ball (r 20) pressed 4 mm by a rounded board (80×80×6, round 1) from above, as one contact
 * root, with no grid set: a simple shape whose 1 mm rounds a 1.5 mm grid cannot resolve.
 */
export const BALL_BOARD = { root: { kind: "contact", gap: 0, bulge: 1, children: [
  { kind: "sphere", r: 20, label: "ball" },
  { kind: "box", size: [80, 80, 6], round: 1, at: [0, 0, 19], label: "board" },
] } };

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
