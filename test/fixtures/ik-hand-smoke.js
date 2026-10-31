// The pose-smoke page's part (pose-smoke.html, scripts/check-pose.mjs): the IK hand
// fixture plus one bead chain per finger, BUILT from the posed finger. A bead chain's
// build reads p.aCurl (or p.bCurl) — directly and through d.a / d.b — so the pose fast
// path cannot move it by matrix: a drag ghosts it, holds its rebuild, and the one regen
// on release replaces it. The palm stays rigid (its view only turns it by p.wrist), so
// the same drag also moves a sub-part by matrix. Until a real reference part builds
// from the pose (the implicit hand), this is the only page on the ghost path.
import fixture from "./ik-hand-fixture.js";

const JOINTS = ["mcp", "pip", "dip", "tip"];
const RADII = [7, 6, 5, 4.5];

/** A bead at each joint and the tip of `finger`, in part coordinates. */
function beads(k, finger, curl) {
  // `curl` is read here on purpose: the bead size breathes with it, so the build reads
  // the pose parameter itself and not only through derive's attribution.
  const grow = 1 + 0.15 * curl;
  return k.union(JOINTS.map((j, i) => k.sphere({ r: RADII[i] * grow }).translate(finger.world(j).origin)));
}

export default {
  ...fixture,
  meta: { title: "Pose smoke", units: "mm" },
  parts: {
    ...fixture.parts,
    fingerA: {
      label: "Finger A",
      build: (k, p, d) => beads(k, d.a, p.aCurl),
      views: { hand: (s) => s },
    },
    fingerB: {
      label: "Finger B",
      build: (k, p, d) => beads(k, d.b, p.bCurl),
      views: { hand: (s) => s },
    },
  },
};
