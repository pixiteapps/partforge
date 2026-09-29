// The laser exporter (process/laser/export.js): a resolved sheet piece → one Drawing in
// its canonical frame. Most cases hand-build the ResolvedSheet (contract §5.2) so each
// layer can be varied alone; the last one goes through a real sheetPart and resolveSheet.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import laser from "../src/framework/process/laser/export.js";
import { refitRing } from "../src/framework/export/drawing.js";
import { validateKitOptions } from "../src/framework/export/formats.js";
import { arcCenterAndSweep } from "../src/framework/geometry/arc-math.js";
import { circleProfile, roundedRectPolygon } from "../src/framework/geometry/polygon.js";
import { sheetPart } from "../src/framework/sheet/part.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { sheetHole } from "../src/framework/sheet/joinery.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const RECT = [[0, 0], [40, 0], [40, 30], [0, 30]];
const hole = (x, y, r) => ({ start: [x + r, y], segments: [{ to: [x - r, y], via: [x, y + r] }, { to: [x + r, y], via: [x, y - r] }] });
const kinds = (path) => path.segments.map((s) => (s.via ? "a" : s.c1 ? "c" : "l")).join("");
const resolved = ({ profile, lines = [], shapes = [], engrave = null, label = "Front" }) => ({
  process: "laser", material: "birch plywood", thickness: 3, group: "birch plywood|3.00", label, pose: null,
  profile: k.shape2d(profile), score: { lines, shapes: shapes.map((s) => k.shape2d(s)) },
  engrave: engrave ? k.shape2d(engrave) : null, grooves: [], customBuild: false,
});
const plate = () => resolved({
  profile: k.shape2d(RECT).cutAll([hole(20, 15, 5)]),
  lines: [[[5, 5], [35, 5]]],
  shapes: [[[30, 20], [36, 20], [36, 26], [30, 26]]],
  engrave: k.shape2d([[8, 18], [16, 18], [16, 26], [8, 26]]).cut([[10, 20], [14, 20], [14, 24], [10, 24]]),
});
const draw = (s, options = {}, ctx = { label: "Front" }) => laser.drawing(s, validateKitOptions(options), k, ctx);
const expectOnCircle = (path, [cx, cy], r) => {
  let from = path.start;
  for (const s of path.segments) {
    const g = arcCenterAndSweep(from, s.via, s.to);
    expect(g.center[0]).toBeCloseTo(cx, 6); expect(g.center[1]).toBeCloseTo(cy, 6); expect(g.r).toBeCloseTo(r, 6);
    from = s.to;
  }
};

describe("layers", () => {
  test("cut order, one layer per mark kind, in the canonical frame", () => {
    const d = draw(plate());
    expect(d.layers.map((l) => l.id)).toEqual(["engrave", "score", "cut-inner", "cut-outer"]);
    const byId = Object.fromEntries(d.layers.map((l) => [l.id, l.paths]));
    expect(byId["cut-outer"]).toHaveLength(1);
    expect(kinds(byId["cut-outer"][0])).toBe("llll");
    expect(byId["cut-inner"]).toHaveLength(1);
    expect(kinds(byId["cut-inner"][0])).toMatch(/^a+$/);          // the cutAll hole, refit from cubics
    expect(byId.score.map((p) => p.closed)).toEqual([false, true]); // the line, then the shape's ring
    expect(byId.score[0]).toEqual({ start: [5, 5], segments: [{ to: [35, 5] }], closed: false });
    expect(byId.engrave).toHaveLength(2);                           // the frame's outer ring and its hole
    expect(d.layers.every((l) => l.paths.every((p) => p.closed === false || p.segments.at(-1).to.every((v, i) => v === p.start[i])))).toBe(true);
    expect(d).toMatchObject({ bounds: { min: [0, 0], max: [40, 30] }, nominal: [40, 30], kerf: 0 });
  });

  test("a piece with no marks writes only its cut layers", () => {
    expect(draw(resolved({ profile: RECT })).layers.map((l) => l.id)).toEqual(["cut-outer"]);
  });

  test("faceted outlines come out as arcs", () => {
    expect(kinds(draw(resolved({ profile: circleProfile(15, [15, 15]) })).layers[0].paths[0])).toBe("aa");
    expect(kinds(draw(resolved({ profile: roundedRectPolygon(40, 20, 5) })).layers[0].paths[0])).toBe("alalalal");
  });

  test("an empty profile is refused by name", () => {
    const empty = resolved({ profile: k.shape2d(RECT).cut([[-1, -1], [41, -1], [41, 31], [-1, 31]]) });
    expect(() => draw(empty)).toThrow('cut kit: "Front" has an empty profile — nothing to cut');
  });

  test("the label comes from ctx, else the sheet", () => {
    const empty = resolved({ profile: k.shape2d(RECT).cut([[-1, -1], [41, -1], [41, 31], [-1, 31]]), label: "Lid" });
    expect(() => laser.drawing(empty, validateKitOptions({}), k, {})).toThrow('cut kit: "Lid" has an empty profile');
  });
});

describe("kerf", () => {
  test("moves the cut layer only: outline out, hole in, by kerf/2; marks and nominal unchanged", () => {
    const d0 = draw(plate()), d = draw(plate(), { kerf: 0.2 });
    expect(d.kerf).toBe(0.2);
    expect(d.nominal).toEqual([40, 30]);
    expect(d.bounds.min[0]).toBeCloseTo(-0.1, 9); expect(d.bounds.max[1]).toBeCloseTo(30.1, 9);
    const layer = (x, id) => x.layers.find((l) => l.id === id).paths;
    expect(layer(d, "score")).toEqual(layer(d0, "score"));
    expect(layer(d, "engrave")).toEqual(layer(d0, "engrave"));
    expectOnCircle(layer(d, "cut-inner")[0], [20, 15], 4.9);
    // kerf is its own question, not a destination (spec decision 9): a service kit gets the same cut
    expect(draw(plate(), { destination: "service", kerf: 0.2 })).toEqual(d);
  });

  test("kerf 0 is byte-identical to the refit profile, and to no kerf option at all", () => {
    const s = plate();
    const d = draw(s, { kerf: 0 });
    const rings = s.profile.toContours().flatMap((rg) => [rg.outer, ...rg.holes]).map(refitRing);
    const cut = d.layers.filter((l) => l.id.startsWith("cut-")).flatMap((l) => l.paths);
    expect(JSON.stringify(cut.map(({ start, segments }) => ({ start, segments }))))
      .toBe(JSON.stringify([rings[1], rings[0]].map(({ start, segments }) => ({ start, segments }))));
    expect(JSON.stringify(draw(s, {}))).toBe(JSON.stringify(d));
  });

  test("a closed slot names the piece and its measured gap; a capped gap is not a measurement", () => {
    const slotted = resolved({ profile: k.shape2d(RECT).cut([[10, 10], [10.15, 10], [10.15, 20], [10, 20]]) });
    expect(() => draw(slotted, { kerf: 0.2 }, { label: "Front", facts: { gap: 0.15, gapCapped: false } }))
      .toThrow('cut kit options: kerf 0.20 mm closes a 0.15 mm slot in "Front" — widen it or lower kerf');
    expect(() => draw(slotted, { kerf: 0.2 }, { label: "Front", facts: { gap: 3, gapCapped: true } }))
      .toThrow('cut kit options: kerf 0.20 mm closes a slot in "Front" — widen it or lower kerf');
  });
});

describe("from a real sheetPart", () => {
  test("the resolved declaration is drawn in its canonical frame — the pose moves nothing", () => {
    const sp = sheetPart({
      label: "Front", views: ["v"], material: "birch plywood", thickness: (p) => p.t,
      profile: (kk, p) => kk.shape2d([[0, 0], [p.w, 0], [p.w, 30], [0, 30]]).cutAll([sheetHole({ d: 10, at: [20, 15] })]),
      score: (kk, p) => [[[5, 5], [p.w - 5, 5]]],
      engrave: (kk) => kk.shape2d([[10, 20], [14, 20], [14, 24], [10, 24]]),
      pose: { face: "-Y", up: "+Z", at: [-20, -15, 0] },
    });
    const d = draw(resolveSheet(k, sp, { t: 3, w: 40 }, {}));
    expect(d.layers.map((l) => l.id)).toEqual(["engrave", "score", "cut-inner", "cut-outer"]);
    expect(d).toMatchObject({ bounds: { min: [0, 0], max: [40, 30] }, nominal: [40, 30], kerf: 0 });
    expectOnCircle(d.layers.find((l) => l.id === "cut-inner").paths[0], [20, 15], 5);
    expect(d.layers.find((l) => l.id === "score").paths).toEqual([{ start: [5, 5], segments: [{ to: [35, 5] }], closed: false }]);
  });
});
