// sheetPart's preview build on OCCT — its own file because OCCT and Manifold must not
// boot in one process. A sheet part lands on OCCT whenever its forge routes there, and
// OCCT's coplanar booleans are the fragile case the overcut mark tools exist for (every
// tool rises MARK_OVERCUT above the laser face). The volume identity must hold here
// exactly as on Manifold, including a mark over the hole and one off the edge.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import { buildPosed, resolveParams } from "../src/framework/part-model.js";
import { sheetPart } from "../src/framework/sheet/part.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { EMPTY_MARK_RE, MARK_DEPTH } from "../src/framework/sheet/constants.js";
import { sheetHole } from "../src/framework/sheet/joinery.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 60000);

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const part = {
  meta: { title: "Sheet fixture (OCCT)", units: "mm", backend: "occt" },
  defaults: { t: 3 },
  views: { main: { label: "Main" } },
  parts: {
    panel: sheetPart({
      label: "Panel",
      views: ["main"],
      material: "clear acrylic",
      thickness: (p) => p.t,
      profile: (kk) => kk.shape2d(rect(0, 0, 80, 50)).cutAll([rect(10, 10, 20, 20), sheetHole({ d: 8, at: [60, 35] })]),
      engrave: (kk) => kk.shape2d(rect(30, 10, 60, 20)),
      score: () => [[[-5, 35], [95, 35]], rect(5, 5, 25, 25)],    // across the round hole and off both ends; around the square one
      pose: { face: "+X", up: "+Z", at: [0, -40, 0] },
    }),
  },
};

test("V = A·t − MARK_DEPTH·area(marks ∩ profile) on OCCT, posed", () => {
  const { p, d } = resolveParams(part, {});
  const s = resolveSheet(k, part.parts.panel, p, d);
  const marks = [s.engrave, ...s.grooves].reduce((a, b) => a.union(b)).intersect(s.profile).area();
  const solid = buildPosed(k, part, "panel", { purpose: "export", view: "main", p, d });
  // B-rep volume against curve-exact areas: they agree to well under 0.001 mm³
  expect(solid.volume()).toBeCloseTo(s.profile.area() * 3 - MARK_DEPTH * marks, 3);
  const bb = solid.boundingBox();
  // face +X, up +Z, at [0, −40, 0]: u → +Y, v → +Z, material toward −X
  expect(bb.min.map((v) => +v.toFixed(3) + 0)).toEqual([-3, -40, 0]);
  expect(bb.max.map((v) => +v.toFixed(3) + 0)).toEqual([0, 40, 50]);
});

test("OCCT's empty-shape error is one EMPTY_MARK_RE drops (an empty engraving never fails a build)", () => {
  let message = null;
  try { k.shape2d(rect(0, 0, 1, 1)).intersect(rect(5, 5, 6, 6)).extrude({ h: 1 }); } catch (e) { message = e.message; }
  expect(message).toMatch(EMPTY_MARK_RE);
});
