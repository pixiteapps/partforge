// Shared fixtures for the pose-drag work (docs/superpowers/plans/2026-10-31-implicit-pose-drag.md):
// a two-bone capsule chain whose child frame bends about x, and a ball that can ride either frame.

/** Two capsules on a root → child frame chain, blended; `bend` rotates the child frame (degrees about x). */
export const TWO_BONE = (bend = 0) => ({
  frames: {
    root: { at: [0, 0, 0] },
    child: { parent: "root", at: [0, 20, 0], rotate: { axis: "x", deg: bend } },
  },
  root: {
    kind: "union", k: 2,
    children: [
      { kind: "capsule", frame: "root", b: [0, 20, 0], r: 4 },
      { kind: "capsule", frame: "child", b: [0, 20, 0], r: 4 },
    ],
  },
  preview: 1,
  resolution: 1,
});

/** A small sphere in one of TWO_BONE's frames. */
export const BALL = (frame = "child", at = [0, 24, 6]) => ({
  frames: TWO_BONE(0).frames,
  root: { kind: "sphere", frame, at, r: 3 },
  preview: 1,
});
