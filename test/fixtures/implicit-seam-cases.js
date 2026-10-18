// test/fixtures/implicit-seam-cases.js
// The seam fixtures of docs/superpowers/specs/2026-10-16-implicit-contact-seams-design.md
// ("Testing"): two pressed capsules, a capsule near miss, three pressed spheres and the
// hand, each a root `contact` node (compile with `exactContact: true` for clean seams).
import { handSpec, HAND_POSES } from "./implicit-trees.js";

/**
 * Two capsules along z at x = ±(r − overlap/2), labelled `a` (−x) and `b` (+x): they overlap
 * by `overlap` mm at the middle (a negative overlap is a near miss that far apart).
 */
export function capsulePress({ overlap, gap = 0, bulge = 0, r = 8, half = 20 }) {
  const x = r - overlap / 2;
  return {
    root: {
      kind: "contact", gap, bulge, children: [
        { kind: "capsule", a: [-x, 0, -half], b: [-x, 0, half], r, label: "a" },
        { kind: "capsule", a: [x, 0, -half], b: [x, 0, half], r, label: "b" },
      ],
    },
  };
}

/** Three spheres r 6, pairwise overlapping by 1 (centres 11 apart, in an equilateral triangle), labelled a, b, c. */
export function threePress({ gap }) {
  const R = 11 / Math.sqrt(3);
  const at = (deg) => [R * Math.cos((deg * Math.PI) / 180), R * Math.sin((deg * Math.PI) / 180), 0];
  return {
    root: {
      kind: "contact", gap, bulge: 0, children: [
        { kind: "sphere", r: 6, at: at(90), label: "a" },
        { kind: "sphere", r: 6, at: at(210), label: "b" },
        { kind: "sphere", r: 6, at: at(330), label: "c" },
      ],
    },
  };
}

/**
 * Two finger capsules (r 4, along z 0-20, labelled a and b) with a true gap `fingerGap` between
 * them (their axes at x = ±(4 + fingerGap/2) + offset), both overlapping a palm capsule below.
 * A mesh that bridges the finger gap has triangles crossing x = offset above the palm (z >= 9).
 */
export function fingersOnPalm({ gap = 0, fingerGap, offset = 0 }) {
  const r = 4, x = r + fingerGap / 2;
  return {
    root: {
      kind: "contact", gap, bulge: 0, children: [
        { kind: "capsule", a: [-x + offset, 0, 0], b: [-x + offset, 0, 20], r, label: "a" },
        { kind: "capsule", a: [x + offset, 0, 0], b: [x + offset, 0, 20], r, label: "b" },
        { kind: "capsule", a: [-14, 0, -1], b: [14, 0, -1], r: 5, label: "palm" },
      ],
    },
  };
}

/** The press overlap the seam fixtures use (the spike's default press). */
export const PRESS_OVERLAP = 1.2;

export const SEAM_CASES = [
  ...[0, 0.05, 0.2].map((gap) => ({ name: `press gap ${gap}`, spec: capsulePress({ overlap: PRESS_OVERLAP, gap }) })),
  { name: "near miss 0.3 gap 0", spec: capsulePress({ overlap: -0.3, gap: 0 }) },
  ...["default", "fist", "nearMiss"].flatMap((pose) => [0, 0.2].map((contactGap) => ({
    name: `hand ${pose} gap ${contactGap}`,
    spec: handSpec({ ...(pose === "default" ? {} : HAND_POSES[pose]), contactGap }),
  }))),
];

/** The spec with its root contact's children listed in reverse (the hand: palm last). */
export function reversedChildren(spec) {
  const out = structuredClone(spec);
  out.root.children.reverse();
  return out;
}

/** Gate-only fixtures beyond SEAM_CASES: child order, and two fingers on a palm. */
export const GATE_EXTRA_CASES = [
  { name: "hand nearMiss gap 0 (palm last)", spec: reversedChildren(SEAM_CASES.find((c) => c.name === "hand nearMiss gap 0").spec) },
  { name: "hand fist gap 0.2 (palm last)", spec: reversedChildren(SEAM_CASES.find((c) => c.name === "hand fist gap 0.2").spec) },
  { name: "fingers on palm 0.3", spec: fingersOnPalm({ gap: 0, fingerGap: 0.3 }) },
  { name: "fingers on palm 0.3 offset 0.37", spec: fingersOnPalm({ gap: 0, fingerGap: 0.3, offset: 0.37 }) },
];
