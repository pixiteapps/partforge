// test/fixtures/implicit-small-trees.js
// Small IR-coverage trees: every node kind, nested placements, blends of 3+
// children, shared children (repeat, mirror). Kept small so per-point tests are fast.
export const TREES = {
  blobs: { root: { kind: "union", k: 3, children: [
    { kind: "sphere", r: 4 }, { kind: "sphere", r: 3, at: [5, 1, 0] }, { kind: "ellipsoid", r: [5, 2, 2], at: [-3, 3, 1] },
  ] } },
  carved: { frames: { f: { at: [0, 0, 2], rotate: [{ axis: "x", deg: 30 }, { axis: "z", deg: 20 }] } }, root: { kind: "subtract", k: 1, children: [
    { kind: "box", size: [12, 8, 6], round: 1 }, { kind: "cylinder", r: 2, h: 20, frame: "f" }, { kind: "sphere", r: 2, at: [5, 3, 3] },
  ] } },
  shells: { root: { kind: "intersect", k: 0.5, children: [
    { kind: "onion", t: 0.6, child: { kind: "sphere", r: 6 } }, { kind: "halfspace", normal: "z", offset: 1 },
  ] } },
  warps: { root: { kind: "union", k: 1, children: [
    { kind: "twist", degPerMm: 6, child: { kind: "box", size: [6, 2, 16] } },
    { kind: "bend", radius: 25, at: [8, 0, 0], child: { kind: "capsule", a: [0, 0, -6], b: [0, 0, 10], r: [2, 1] } },
    { kind: "taper", from: [-5, 1.2], to: [5, 0.6], at: [-9, 0, 0], child: { kind: "cylinder", h: 10, r: 3 } },
  ] } },
  repeats: { root: { kind: "union", k: 0.8, children: [
    { kind: "torus", R: 8, r: 1.5 },
    { kind: "repeat", polar: { count: 6 }, child: { kind: "sphere", r: 1.8, at: [8, 0, 0] } },
    { kind: "mirror", plane: "xz", child: { kind: "tube", points: [[0, 3, 0], [4, 6, 2], [8, 6, 5]], r: [1, 1.5, 0.8] } },
  ] } },
  formula: { root: { kind: "union", k: 1, children: [
    { kind: "expr", box: [[-6, -6, -6], [6, 6, 6]], lipschitz: 3.5, sdf: "float g = sin(p.x)*cos(p.y) + sin(p.y)*cos(p.z) + sin(p.z)*cos(p.x); return max(length(p) - 5.0, abs(g) - 0.4);" },
    { kind: "displace", amount: 0.5, by: { expr: "return sin(p.x * 2.0) * cos(p.y * 2.0);" }, at: [12, 0, 0], child: { kind: "sphere", r: 4 } },
  ] } },
};
