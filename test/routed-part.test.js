// routedPart(): what it accepts, what it refuses at module load, and the sheet record
// it hands sheetPart.
import { describe, expect, test } from "vitest";
import { routedPart } from "../src/framework/sheet/routed.js";
import { routedPart as viaGeometry } from "../src/framework/geometry/polygon.js";
import { sheetPart } from "../src/framework/sheet/part.js";
import { isSheetPart } from "../src/framework/sheet/constants.js";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { resolveParams } from "../src/framework/part-model.js";

const RECT = [[0, 0], [100, 0], [100, 60], [0, 60]];
const base = {
  views: ["main"], label: "Plinth", material: "walnut", thickness: (p) => p.t,
  profile: (k) => k.shape2d(RECT),
};

describe("routedPart accepts", () => {
  test("the minimum: material, thickness, profile — and is a sheet part with process cnc-router", () => {
    const sp = routedPart(base);
    expect(isSheetPart(sp)).toBe(true);
    expect(sp.sheet.process).toBe("cnc-router");
    expect(typeof sp.build).toBe("function");
    expect(sp.sheet.pockets).toBeNull();
    expect(sp.sheet.drills).toBeNull();
    expect(sp.sheet.extra).toBeNull();
    expect(sp.sheet.score).toBeNull();
    expect(sp.sheet.engrave).toBeNull();
    expect(sp.label).toBe("Plinth");
  });

  test("pockets, drills, extra and reference, stored on the record (reference as score)", () => {
    const pockets = (k) => [{ region: k.shape2d([[10, 10], [40, 10], [40, 30], [10, 30]]), depth: 5, label: "vault" }];
    const drills = () => [{ at: [50, 30], d: 3.4, depth: 10 }];
    const extra = (k) => [{ solid: k.box({ size: [10, 10, 10] }), footprint: [[60, 10], [70, 10], [70, 20], [60, 20]], label: "slot", method: "table saw" }];
    const reference = () => [[[0, 30], [100, 30]]];
    const sp = routedPart({ ...base, pockets, drills, extra, reference });
    expect(sp.sheet.pockets).toBe(pockets);
    expect(sp.sheet.drills).toBe(drills);
    expect(sp.sheet.extra).toBe(extra);
    expect(sp.sheet.score).toBe(reference);
    expect(sp.sheet).not.toHaveProperty("reference");
  });

  test("is exported from partforge/geometry", () => {
    expect(viaGeometry).toBe(routedPart);
  });
});

describe("routedPart refuses at module load", () => {
  const throws = (spec, message) => expect(() => routedPart(spec)).toThrow(message);
  test("score and engrave, naming reference", () => {
    throws({ ...base, score: () => [] }, 'routedPart: "score" is not a routedPart key — centerlines and layout marks go in `reference`');
    throws({ ...base, engrave: () => null }, 'routedPart: "engrave" is not a routedPart key — a routed part has no engraving; a shallow pocket is `pockets`');
  });
  test("process", () => {
    throws({ ...base, process: "laser" }, 'routedPart: "process" is not a routedPart key — routedPart is always the cnc-router process');
  });
  test("non-function pockets/drills/extra/reference", () => {
    throws({ ...base, pockets: [] }, "routedPart: pockets must be a function (k, p, d) => [{ region, depth, label? }], or omitted");
    throws({ ...base, drills: {} }, "routedPart: drills must be a function (p, d) => [{ at: [x, y], d, depth, label? }], or omitted");
    throws({ ...base, extra: 3 }, "routedPart: extra must be a function (k, p, d) => [{ solid, footprint, label, method }], or omitted");
    throws({ ...base, reference: "x" }, "routedPart: reference must be a function (k, p, d) => [[x, y], [x, y]] lines and shapes, or omitted");
  });
  test("sheetPart's own refusals still apply (kerf, build, unknown keys)", () => {
    throws({ ...base, kerf: 0.2 }, "kerf is chosen when you download the kit");
    throws({ ...base, build: () => null }, "supplies build");
    throws({ ...base, bogus: 1 }, 'unknown key "bogus"');
  });
});

test("sheetPart's unknown-process error now names routedPart", () => {
  expect(() => sheetPart({ ...base, process: "cnc" }))
    .toThrow('sheetPart: unknown process "cnc" — valid: laser, cnc-router; for CNC-routed stock with pockets and drills at depth use routedPart()');
});

test("sheetPart with process cnc-router directly admits the router keys", () => {
  const drills = () => [];
  const sp = sheetPart({ ...base, process: "cnc-router", drills });
  expect(sp.sheet.drills).toBe(drills);
  expect(sp.sheet.pockets).toBeNull();
});

describe("the pose probe", () => {
  test("a posed routed part with every op family is probe-trusted, and a pose-only change keeps its baseHash", () => {
    const sp = routedPart({ ...base,
      pose: (p) => ({ face: "-Y", up: "+Z", at: [p.x, 0, 0] }),
      pockets: (k) => [{ region: k.shape2d([[10, 10], [40, 10], [40, 30], [10, 30]]), depth: 6 }],
      drills: () => [{ at: [50, 30], d: 3.4, depth: 10 }, { at: [70, 30], d: 6, depth: 18 }],
      extra: (k) => [{ solid: k.box({ size: [10, 10, 10] }).translate([85, 15, 13]), footprint: [[80, 10], [90, 10], [90, 20], [80, 20]], label: "notch", method: "chisel" }],
      reference: () => [[[0, 30], [100, 30]]] });
    const part = { meta: { title: "Plinth" }, parameters: [{ id: "s", title: "S", controls: [
      { key: "t", label: "Thickness", min: 6, max: 30, step: 1 }, { key: "x", label: "X", min: -50, max: 50, step: 1 }] }],
    defaults: { t: 18, x: 0 }, views: { main: { label: "Main" } }, parts: { plinth: sp } };
    const probe = (x) => { const { p, d } = resolveParams(part, { x }); return probeSubPartPose(sp, { view: "main", purpose: "display", p, d }); };
    const a = probe(0), b = probe(25);
    expect(a.trusted).toBe(true);
    expect(b.trusted).toBe(true);
    expect(b.baseHash).toBe(a.baseHash);
    expect(b.pose).not.toEqual(a.pose);
  });
});
