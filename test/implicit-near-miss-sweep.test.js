// test/implicit-near-miss-sweep.test.js
// The near-miss robustness sweep: the hand's index/middle near miss (HAND_POSES.nearMiss is one
// bisected spread, 0.75 mm at the closest) over a band of spreads around it, the three finger
// blends the hand has shipped with, and the part both at the origin and moved through its root
// (test/fixtures/implicit-seam-cases.js's movedRoot: the fingers then run oblique to the grid).
//
// Why: the seam gate's hand fixtures passed with the old hand by grid alignment. A finger lying
// along a grid axis rarely has a grid edge cross the thin air gap at a slant, so no linear
// crossing lands by the other finger; rotate the part and many do. Those crossings must be
// carried home by cleanup's owner projection (project.js), whatever the alignment — a stray that
// stays on the other finger's skin bridges the gap (gapHolds' spans, a bisector crossing). One
// pose passing says nothing about its neighbours, so a reshaped hand could pass by luck again:
// this sweep holds every point of the band.
import { describe, test, expect } from "vitest";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { SHARP_TOL } from "../src/framework/geometry/implicit/sharpen.js";
import { edgeCheck } from "./helpers/mesh-topology.js";
import { gapHolds, bisectorCrossings } from "./helpers/seam-quality.js";
import { sharpenMesh } from "../src/framework/geometry/implicit/sharpen.js";
import { jsStages } from "./helpers/implicit-stages.js";
import { movedRoot } from "./fixtures/implicit-seam-cases.js";
import { handSpec, HAND_POSES } from "./fixtures/implicit-trees.js";

const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };
const EDGE = 1.5, GAP = 0.2;
// The bisected spread and its neighbours a few tenths of a degree either way (the gap then
// runs about 0.55–1 mm), plus the spread the old hand was bisected to.
const SPREADS = [-0.3, -0.1, 0, 0.1, 0.3].map((d) => Math.round((HAND_POSES.nearMiss.spread + d) * 1e4) / 1e4).concat([-1.3742]);
const BLENDS = [1, 2, 3];

describe("near-miss sweep: spreads × finger blends × moved root, gap 0.2 at the preview grid", () => {
  for (const fingerBlend of BLENDS) for (const spread of SPREADS) for (const moved of [false, true]) {
    test(`fingerBlend ${fingerBlend}, spread ${spread}${moved ? ", moved root" : ""}: closed, every gap holds, no bisector crossing`, () => {
      const base = handSpec({ spread, fingerBlend, contactGap: GAP });
      const compiled = compileImplicit(moved ? movedRoot(base) : base);
      const mesh = meshImplicit(compiled, EDGE, { tier: "preview" });
      expect(edgeCheck(mesh.indices)).toEqual(CLOSED);
      const { spans, shortfall } = gapHolds(compiled, mesh, GAP);
      expect(spans, "triangles joining two pieces across the gap").toBe(0);
      expect(shortfall).toBeLessThanOrEqual(0.01);
      expect(bisectorCrossings(compiled, mesh, "index", "middle"), "triangles across the near miss's bisector").toBe(0);
      // No vertex left floating in the gap: a share step accepted as transit on the last
      // projection pass would leave one in air (the field there is the distance to the skin).
      // Skin detail (creases) only carves inward, so it never lifts the field above zero.
      // The limit is the sharpen stage's own (sharpen.js): it keeps a corner point within
      // SHARP_TOL cells of the field, 0.075 mm here. The palm is a smooth union of four
      // children, and where a third child is within k its field has a crease. At fingerBlend 2,
      // spread −3.4718, moved, three such creases meet on the palm. The stage's corner point
      // there is 0.25 mm from where they meet and 0.0504 mm off the field. The limit is still
      // under half the gap (0.1 mm), the field at a vertex floating midway across it.
      let highest = -Infinity;
      for (let i = 0; i < mesh.positions.length; i += 3) highest = Math.max(highest, evalReference(compiled, mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
      expect(highest, "the field at the vertex farthest off the surface (mm)").toBeLessThan(SHARP_TOL * EDGE);
    }, 120_000);
  }
});

// At fingerBlend 2, spread −3.4718, moved, three creases of the palm (a smooth union of four
// children: where a third child is within k its field has a crease) meet on the surface at
// (5.8486, −31.3302, 13.1309), where the box, hypothenar and wrist children tie. The faces meet at
// 24.7°, 26.8° and 45.9°. The sharpen stage's one corner point there is solved on those faces.
test("near-miss corner: the palm's corner point lies where its three faces meet", () => {
  const spec = movedRoot(handSpec({ spread: -3.4718, fingerBlend: 2, contactGap: GAP }));
  const { store, cleaned } = jsStages(spec, EDGE, { tier: "preview" });
  const mesh = sharpenMesh(store, cleaned), corner = [5.8486, -31.3302, 13.1309], cs = [];
  for (let v = 0; v < mesh.sharp.length; v++) if (mesh.sharp[v] === 2) cs.push([mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]]);
  expect(cs.length).toBe(1);
  expect(Math.hypot(cs[0][0] - corner[0], cs[0][1] - corner[1], cs[0][2] - corner[2]), "mm from the corner").toBeLessThanOrEqual(0.02);
}, 120_000);
