// test/fixtures/implicit-small-trees.js
// Small IR-coverage trees: every node kind, nested placements, blends of 3+
// children, shared children (repeat, mirror). Kept small so per-point tests are fast.
// The contact* trees are new in the contact work: the native core learns the CONTACT op in a
// later task, so the native suites skip them until then (NATIVE_PENDING).
export const NATIVE_PENDING = (name) => name.startsWith("contact");
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
  bendCut: { root: { kind: "round", r: 6, child: { kind: "bend", radius: 10, child: { kind: "capsule", a: [0, 0, -27], b: [0, 0, -20], r: 1 } } } },
  formula: { root: { kind: "union", k: 1, children: [
    { kind: "expr", box: [[-6, -6, -6], [6, 6, 6]], lipschitz: 3.5, sdf: "float g = sin(p.x)*cos(p.y) + sin(p.y)*cos(p.z) + sin(p.z)*cos(p.x); return max(length(p) - 5.0, abs(g) - 0.4);" },
    { kind: "displace", amount: 0.5, by: { expr: "return sin(p.x * 2.0) * cos(p.y * 2.0);" }, at: [12, 0, 0], child: { kind: "sphere", r: 4 } },
  ] } },
  contactNearMiss: { root: { kind: "contact", gap: 0.01, children: [{ kind: "sphere", r: 5, at: [-5.25, 0, 0] }, { kind: "sphere", r: 5, at: [5.25, 0, 0] }] } },
  contactOverlap: { root: { kind: "contact", children: [{ kind: "sphere", r: 5, at: [-4, 0, 0] }, { kind: "sphere", r: 4, at: [4, 1, 0] }] } },
  contactGap: { root: { kind: "contact", gap: 0.5, children: [{ kind: "sphere", r: 5, at: [-4, 0, 0] }, { kind: "box", size: [8, 8, 8], at: [4, 0, 0], round: 1 }] } },
  // A far third child listed first, so the attachments' slot indices must be re-indexed when it is pruned.
  contactAttach: { frames: { joint: { at: [0, 0, 2] }, tip: { at: [9, 0, 6] } }, root: { kind: "contact", gap: 0.2, attach: [
    { a: "finger", b: "palm", near: "joint", radius: 4, band: 2, k: 2 },
    { a: "knob", b: "palm", near: "tip", radius: 1.5, band: 1, k: 1 },
  ], children: [
    { kind: "sphere", r: 2, at: [9, 0, 6], label: "knob" },
    { kind: "capsule", a: [0, 0, 1], b: [0, 0, 12], r: 2, label: "finger" },
    { kind: "box", size: [14, 10, 4], label: "palm" },
  ] } },
  // bulge 0: the first capsule's tip reaches through the second to within the coarse grid's
  // clearance of its far side, and a bulge there puts the clearance cut's crease on that far
  // surface (cleanup's vertex bound fails at 0.8 mm). Bulge is covered by the gap-0 trees and
  // contactGap; the profile is tuned on the hand (Task 5).
  contactThree: { root: { kind: "contact", gap: 0.3, bulge: 0, children: [
    { kind: "capsule", a: [-9, 0, 0], b: [-1, 0, 0], r: 2 },
    { kind: "capsule", a: [1, -6, 0], b: [1, 6, 0], r: 2 },
    { kind: "capsule", a: [10, 0, -5], b: [10, 0, 5], r: 1.5 },
  ] } },
  // Gap 0: a, b fused by a 2 mm overlap; c passes 0.5 mm from both, beside their pad.
  contactPassBy: { root: { kind: "contact", children: [
    { kind: "sphere", r: 5, at: [-4, 0, 0] }, { kind: "sphere", r: 5, at: [4, 0, 0] },
    { kind: "sphere", r: 2, at: [0, 0, -6.344288770224761] },
  ] } },
  contactIdentical: { root: { kind: "contact", children: [{ kind: "sphere", r: 4, at: [1, 0, 0] }, { kind: "sphere", r: 4, at: [1, 0, 0] }] } },
};
