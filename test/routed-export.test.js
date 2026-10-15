import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import router from "../src/framework/process/cnc-router/export.js";
import { routedPart } from "../src/framework/sheet/routed.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { validateKitOptions } from "../src/framework/export/formats.js";
import { routedLayerName } from "../src/framework/export/drawing.js";
import { renderDxf } from "../src/framework/export/dxf.js";
import { renderSvg } from "../src/framework/export/svg.js";
import { parseDxf } from "./helpers/dxf-subset.js";
import { parseSvg } from "./helpers/svg-subset.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const RECT = [[0, 0], [100, 0], [100, 60], [0, 60]];
const draw = (over, options = {}) => router.drawing(
  resolveSheet(k, routedPart({ views: ["main"], label: "Plinth", material: "walnut", thickness: 18, profile: (kk) => kk.shape2d(RECT), ...over }), {}, {}),
  validateKitOptions(options), k, { label: "Plinth" });
const piece = (drawing) => ({ title: "t", size: [drawing.bounds.max[0] - drawing.bounds.min[0], drawing.bounds.max[1] - drawing.bounds.min[1]], placements: [{ drawing, at: [0, 0], rotated: false }] });
const FULL = {
  pockets: () => [{ region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 11.43, label: "vault" }, { region: [[10, 35], [40, 35], [40, 50], [10, 50]], depth: 11.431 }, { region: [[50, 40], [60, 40], [60, 50], [50, 50]], depth: 3 }],
  drills: () => [{ at: [50, 30], d: 3.4, depth: 10 }, { at: [60, 30], d: 3.4, depth: 10 }, { at: [70, 30], d: 6, depth: 18 }],
  extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([85, 15, 13]), footprint: [[80, 10], [90, 10], [90, 20], [80, 20]], label: "notch", method: "chisel" }],
  reference: () => [[[0, 30], [100, 30]]],
};

test("routedLayerName formats depths with up to two decimals and no trailing zeros", () => {
  expect(routedLayerName("pocket", { depth: 11.43 })).toBe("POCKET_11.43MM");
  expect(routedLayerName("pocket", { depth: 11.431 })).toBe("POCKET_11.43MM");
  expect(routedLayerName("pocket", { depth: 3 })).toBe("POCKET_3MM");
  expect(routedLayerName("drill", { d: 3.4, depth: 10, through: false })).toBe("DRILL_D3.4_10MM");
  expect(routedLayerName("drill", { d: 6, depth: 18, through: true })).toBe("DRILL_D6_THRU");
});

describe("the drawing", () => {
  test("layer order, names and colours; pockets within 0.01 mm share a layer; pockets sorted by ascending depth", () => {
    const d = draw(FULL);
    expect(d.layers.map((l) => l.id)).toEqual(["reference", "secondary", "drill-D3.4-10", "drill-D6-THRU", "pocket-3", "pocket-11.43", "cut-outer"]);
    expect(d.layers.map((l) => l.name ?? null)).toEqual(["REFERENCE", "SECONDARY", "DRILL_D3.4_10MM", "DRILL_D6_THRU", "POCKET_3MM", "POCKET_11.43MM", null]);
    expect(d.layers.map((l) => l.color ?? null)).toEqual([8, 6, 3, 4, 30, 40, null]);
    expect(d.layers.find((l) => l.id === "pocket-11.43").paths).toHaveLength(2);
    expect(d.layers.find((l) => l.id === "drill-D3.4-10").paths).toHaveLength(2);
    expect(d.kerf).toBe(0);
    expect(d.nominal).toEqual([100, 60]);
  });

  test("an empty pocket draws nothing; a missing list draws no layer", () => {
    const d = draw({ pockets: (kk) => [{ region: kk.shape2d([[1, 1], [2, 1], [2, 2], [1, 2]]).cut([[0, 0], [3, 0], [3, 3], [0, 3]]), depth: 3 }] });
    expect(d.layers.map((l) => l.id)).toEqual(["cut-outer"]);
  });

  test("kerf is refused for a routed drawing", () => {
    expect(() => draw({}, { kerf: 0.2 })).toThrow("cut kit options: kerf does not apply to a CNC router");
  });
});

describe("the writers", () => {
  test("DXF declares the custom layers by name and colour, writes drills as CIRCLE, keeps cut-outer last", () => {
    const dxf = parseDxf(renderDxf(piece(draw(FULL))));
    expect(dxf.layers).toEqual([
      { name: "REFERENCE", color: 8, linetype: "CONTINUOUS" }, { name: "SECONDARY", color: 6, linetype: "CONTINUOUS" },
      { name: "DRILL_D3.4_10MM", color: 3, linetype: "CONTINUOUS" }, { name: "DRILL_D6_THRU", color: 4, linetype: "CONTINUOUS" },
      { name: "POCKET_3MM", color: 30, linetype: "CONTINUOUS" }, { name: "POCKET_11.43MM", color: 40, linetype: "CONTINUOUS" },
      { name: "CUT", color: 1, linetype: "CONTINUOUS" },
    ]);
    const drills = dxf.entities.filter((e) => e.layer.startsWith("DRILL"));
    expect(drills.every((e) => e.type === "CIRCLE")).toBe(true);
    expect(drills.map((e) => e.r)).toEqual([1.7, 1.7, 3]);
    expect(dxf.entities[0]).toMatchObject({ type: "LINE", layer: "REFERENCE" });
    expect(dxf.entities.at(-1)).toMatchObject({ type: "POLYLINE", layer: "CUT", closed: true });
  });

  test("a cut-only include leaves the custom layers out; the default include writes them", () => {
    const cutOnly = parseDxf(renderDxf(piece(draw(FULL)), { include: ["cut"] }));
    expect(cutOnly.layers.map((l) => l.name)).toEqual(["CUT"]);
    expect(() => renderDxf(piece(draw(FULL)), { include: ["cut", "POCKET_3MM"] })).toThrow("renderDxf: include lists");
  });

  test("SVG strokes a custom layer in its colour with no fill", () => {
    const svg = parseSvg(renderSvg(piece(draw(FULL))));
    const pocket = svg.groups.flatMap((g) => g.paths).find((p) => p.attrs.stroke === "#E0A000");
    expect(pocket).toBeDefined();
    expect(pocket.attrs.fill).toBe("none");
  });
});
