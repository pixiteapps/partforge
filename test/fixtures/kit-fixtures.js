// The forges the kit tests build, shared so a new test can compare against the same part
// an older one pinned: a laser forge (two identical sides, a front with a score line and
// an engraved block, a panel whose export name collides with the front's, two identical
// printed spacers) and a board forge (one routed plinth, one laser lid).
import { sheetPart, sheetHole, routedPart } from "../../src/framework/geometry/polygon.js";

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const ply = { views: ["all"], material: "Birch Plywood", thickness: (p) => p.t };

export const laserFixture = {
  meta: { title: "Kit Fixture" },
  parameters: [{ id: "stock", title: "Stock", controls: [
    { key: "t", label: "Sheet thickness", unit: "mm", min: 1, max: 6, step: 0.05 },
    { key: "fit", label: "Finger clearance", unit: "mm", min: 0, max: 0.4, step: 0.02 },
  ] }],
  defaults: { t: 3, fit: 0.1 },
  views: { all: { label: "All" } },
  parts: {
    left: sheetPart({ ...ply, label: "Side (L)",
      profile: (kk) => kk.shape2d(rect(80, 50)).cut(sheetHole({ d: 6, at: [40, 25] })) }),
    right: sheetPart({ ...ply, label: "Side\u0007 (R)",
      profile: (kk) => kk.shape2d(rect(80, 50)).cut(sheetHole({ d: 6, at: [40, 25] })) }),
    front: sheetPart({ ...ply, label: "Front",
      profile: (kk) => kk.shape2d(rect(120, 50)),
      score: () => [[[10, 10], [110, 10]]],
      engrave: (kk) => kk.shape2d(rect(20, 10)).translate([50, 20]) }),
    lower: sheetPart({ ...ply, label: "=Lower front", export: { name: "Front" },
      profile: (kk) => kk.shape2d(rect(60, 40)) }),
    spacer: { label: "Spacer", views: ["all"], display: { material: "pla-print" }, build: (kk) => kk.box({ size: [10, 12, 8] }) },
    spacer2: { label: "Spacer copy", views: ["all"], display: { material: "pla-print" }, build: (kk) => kk.box({ size: [10, 12, 8] }) },
  },
};

export const boardFixture = {
  meta: { title: "Board" },
  parameters: [{ id: "stock", title: "Stock", controls: [{ key: "t", label: "Board thickness", unit: "mm", min: 6, max: 30, step: 1 }] }],
  defaults: { t: 18 },
  views: { all: { label: "All" } },
  parts: {
    plinth: routedPart({ views: ["all"], label: "Plinth", material: "walnut", thickness: (p) => p.t, export: { name: "plinth" },
      profile: (kk) => kk.shape2d(rect(100, 60)),
      pockets: () => [{ region: rect(30, 20).map(([x, y]) => [x + 10, y + 10]), depth: 11.43, label: "vault" }],
      drills: () => [{ at: [50, 30], d: 3.4, depth: 10 }, { at: [60, 30], d: 3.4, depth: 10 }],
      extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([85, 15, 13]), footprint: rect(10, 10).map(([x, y]) => [x + 80, y + 10]), label: "notch", method: "chisel, 10 mm" }],
      reference: () => [[[0, 30], [100, 30]]] }),
    lid: sheetPart({ views: ["all"], label: "Lid", material: "birch plywood", thickness: 3,
      profile: (kk) => kk.shape2d(rect(40, 40)), score: () => [[[5, 5], [35, 5]]] }),
  },
};
