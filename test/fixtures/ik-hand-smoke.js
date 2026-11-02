// The pose-smoke page's part (pose-smoke.html, scripts/check-pose.mjs): the IK hand
// fixture plus one bead chain per finger, BUILT from the posed finger. A bead chain's
// build reads p.aCurl (or p.bCurl) — directly and through d.a / d.b — so the pose fast
// path cannot move it by matrix: a drag ghosts it, holds its rebuild, and the one regen
// on release replaces it.
//
// The chains are deliberately SLOW to build: a bead at each joint and FILL overlapping
// beads along each bone, about 70 sphere unions a finger, so one chain takes well over
// mount's LIVE_REBUILD_MS (120 ms). That keeps this page on the ghost path; a cheap part
// would rebuild live during the drag instead (drawer-box.html is the check's cheap part).
// The cost is all in the kernel: the geometry-free probe the main thread runs answers
// every sphere and union with a placeholder, so the drag itself stays smooth. The palm stays rigid (its view only turns it by p.wrist), so
// the same drag also moves a sub-part by matrix. Until a real reference part builds
// from the pose (the implicit hand), this is the only page on the ghost path.
import fixture from "./ik-hand-fixture.js";

const JOINTS = ["mcp", "pip", "dip", "tip"];
const RADII = [7, 6, 5, 4.5];
const FILL = 22; // beads between each pair of joints (see the header: they make the build slow)

/** A bead at each joint and the tip of `finger`, and FILL along each bone, in part coordinates. */
function beads(k, finger, curl) {
  // `curl` is read here on purpose: the bead size breathes with it, so the build reads
  // the pose parameter itself and not only through derive's attribution.
  const grow = 1 + 0.15 * curl;
  const at = JOINTS.map((j) => finger.world(j).origin);
  const out = JOINTS.map((j, i) => k.sphere({ r: RADII[i] * grow }).translate(at[i]));
  for (let i = 0; i + 1 < at.length; i++) {
    for (let f = 1; f <= FILL; f++) {
      const t = f / (FILL + 1);
      const c = at[i].map((v, n) => v + (at[i + 1][n] - v) * t);
      out.push(k.sphere({ r: 0.6 * (RADII[i] + (RADII[i + 1] - RADII[i]) * t) * grow }).translate(c));
    }
  }
  return k.union(out);
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
