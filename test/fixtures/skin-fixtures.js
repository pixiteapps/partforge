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

/** A frame root (b) below a twist placed by frame a: b does not start a binding unit, a does. */
export const TWIST_FRAMES = {
  frames: { a: { at: [0, 0, 0] }, b: { parent: "a", at: [0, 10, 0] } },
  root: { kind: "twist", frame: "a", degPerMm: 1, child: { kind: "capsule", frame: "b", b: [0, 10, 0], r: 3 } },
  preview: 1,
};

/** A frame root (b) below a repeat placed by frame a. */
export const REPEAT_FRAMES = {
  frames: { a: { at: [0, 0, 0] }, b: { parent: "a", at: [0, 10, 0] } },
  root: { kind: "repeat", frame: "a", linear: { step: [12, 0, 0], count: 2 }, child: { kind: "capsule", frame: "b", b: [0, 10, 0], r: 3 } },
  preview: 1,
};

/** A frame root (b) below a mirror placed by frame a. */
export const MIRROR_FRAMES = {
  frames: { a: { at: [0, 0, 0] }, b: { parent: "a", at: [6, 10, 0] } },
  root: { kind: "mirror", frame: "a", plane: "yz", child: { kind: "capsule", frame: "b", b: [0, 10, 0], r: 3 } },
  preview: 1,
};

/**
 * A NESTED unit: a finger-framed union holding a tip-framed capsule (finger 0–20 in y, tip
 * 20–35). `k` is the union's blend.
 */
export const NESTED_FINGER = (k = 0) => ({
  frames: { finger: { at: [0, 0, 0] }, tip: { parent: "finger", at: [0, 20, 0] } },
  root: { kind: "union", k, frame: "finger", children: [
    { kind: "capsule", b: [0, 20, 0], r: 4 },
    { kind: "capsule", frame: "tip", b: [0, 15, 0], r: 4 },
  ] },
  preview: 1,
});

/** A small sphere in one of TWO_BONE's frames. */
export const BALL = (frame = "child", at = [0, 24, 6]) => ({
  frames: TWO_BONE(0).frames,
  root: { kind: "sphere", frame, at, r: 3 },
  preview: 1,
});
