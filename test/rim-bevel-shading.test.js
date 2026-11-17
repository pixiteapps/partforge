// Regression pin: rim-bevel.js builds its bevel band from the profile's own
// point ring via k.loft(...) (see rim-bevel.js). A plain rectangle profile has
// only 4 points — well under loft's 32-side smooth-inference threshold — so
// left to infer, the internal bevel-band lofts register FACETED. That
// drops the bevel band's own corner crease lines, and label() carries each
// face's policy over 1:1, so a labeled beveled solid would keep that faceted band.
// rim-bevel.js now passes shading: "smooth" on its three internal loft() calls —
// a bevel band inherits the profile's shading intent, not loft's own facet
// inference — so a beveled solid keeps its edge lines both unlabeled and
// labeled.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SQUARE = [[0, 0], [20, 0], [20, 20], [0, 20]];
const H = 10;
const BEVEL = 2;

// `edges.length > 0` alone doesn't pin the bevel-band-crease half of the bug:
// the box's own cap-rim perimeter lines already give a nonzero count even
// pre-fix. Count only the segments that are (a) genuinely vertical-ish (their
// two endpoints differ in z — a purely horizontal cap-rim segment does not)
// and (b) fall within one of the two bevel bands (z in [0, BEVEL] or
// [H - BEVEL, H]) — these are exactly the 4-corner crease lines of the
// bevel band's own sloped wall, one per corner per rim (4 corners * 2 rims =
// 8), which pre-fix (FACETED bevel band, no same-surface lines at all) is 0.
function bevelBandCreaseCount(edges) {
  let count = 0;
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const z1 = edges[i + 2], z2 = edges[i + 5];
    if (Math.abs(z1 - z2) < 1e-6) continue; // horizontal — not a corner crease
    const zMin = Math.min(z1, z2), zMax = Math.max(z1, z2);
    const inBottomBand = zMin >= -1e-6 && zMax <= BEVEL + 1e-6;
    const inTopBand = zMin >= H - BEVEL - 1e-6 && zMax <= H + 1e-6;
    if (inBottomBand || inTopBand) count++;
  }
  return count;
}

test("a beveled extrude keeps edge lines (bevel band inherits smooth shading)", () => {
  const s = k.extrude({ profile: SQUARE, h: H, bevel: BEVEL });
  const edges = s.toMesh().edges;
  expect(edges.length).toBeGreaterThan(0);
  // The bevel-band-specific pin: 4 rectangle corners * 2 rims (bottom + top).
  expect(bevelBandCreaseCount(edges)).toBe(8);
});

test("a beveled extrude keeps edge lines after label() too", () => {
  const s = k.extrude({ profile: SQUARE, h: 10, bevel: 2 }).label("body");
  expect(s.toMesh().edges.length).toBeGreaterThan(0);
});
