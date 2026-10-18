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
