// Animated preview-GLB fixtures, shared by the encoder's animation suite and the
// decoder's: two flat squares ("base" still, "lid" baked 24mm up), the lid
// swinging −110° about X mid-animation, and a reader for the GLB's JSON chunk.
import { composePose } from "../../src/framework/geometry/pose.js";

// A 10×10 square of soup at height dz.
export const box = (name, dz = 0) => ({
  name,
  positions: new Float32Array([0, 0, dz, 10, 0, dz, 0, 10, dz, 10, 0, dz, 10, 10, dz, 0, 10, dz]),
});
export const T = (z) => composePose([{ t: "translate", v: [0, 0, z] }]);
export const R = (deg) => composePose([{ t: "rotate", deg, center: [0, 0, 0], axis: [1, 0, 0] }]);

export const anim = {
  name: "cycle",
  label: "Open / close",
  loop: true,
  totalDuration: 2,
  cues: [{ t: 0, view: "front", sweep: null }],
  steps: [{ label: null, duration: 2 }],
  stepStarts: [0],
};

// A fresh PreviewAnimationInput each call (tests mutate it).
export const input = () => ({
  anim,
  base: { base: T(0), lid: T(24) },
  samples: [
    { t: 0, poses: { base: T(0), lid: T(24) }, opacity: {} },
    { t: 0.5, poses: { base: T(0), lid: R(-110) }, opacity: {} },
    { t: 1, poses: { base: T(0), lid: T(24) }, opacity: {} },
  ],
});

// The GLB's JSON chunk, parsed.
export const readJson = (glb) =>
  JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
