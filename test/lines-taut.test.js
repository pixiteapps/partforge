// The lines core's taut solver (spec 2026-11-20-lines-rope-and-cable-design.md): closed
// forms held to hand-worked cases, plus the lines folder's layering.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { solveTaut, ARC_STEP_DEG } from "../src/framework/lines/taut.js";
import { ROPE_MATERIALS, resolveRope } from "../src/framework/lines/materials.js";
import { importsOf } from "./helpers/import-graph.js";

const drum = (name, center, radius, side, extra = {}) => ({ kind: "drum", name, center, radius, side, ...extra });
const D = 1e-9; // a rope this thin puts the pitch circle on the drum, so textbook numbers apply

describe("solveTaut: open lines", () => {
  it("anchor to anchor is the straight distance", () => {
    const r = solveTaut({ d: 1, through: [{ kind: "anchor", at: [0, 0, 0] }, { kind: "anchor", at: [3, 4, 12] }] });
    expect(r.length).toBeCloseTo(13, 12);
    expect(r.wraps).toEqual([]);
    expect(r.spans[0].fleet).toBeCloseTo(Math.atan2(12, 5) * 180 / Math.PI, 9);
  });

  it("a rope over one drum: two tangents and the arc between them", () => {
    // anchors level with the top of a radius-10 drum, 20 either side: the rope lies flat
    // on top, touching at one point, so the wrap is 0 and the length the 40 between them
    const flat = solveTaut({ d: D, through: [{ kind: "anchor", at: [-20, 10, 0] }, drum("a", [0, 0, 0], 10, "cw"), { kind: "anchor", at: [20, 10, 0] }] });
    expect(flat.length).toBeCloseTo(40, 6);
    expect(flat.wraps[0].angle).toBeLessThan(1e-4);
    // three equal drums in a row: the rope grazes the middle one. Rounding puts its exit a
    // hair before its entry, which must read as no wrap, not a whole turn
    const row = solveTaut({ d: 1.3, through: [
      drum("a", [12.330333112801348, 125.73277147386383, 0], 10, "ccw", { fixed: { wrap: 0 } }),
      drum("b", [72.33878382124882, 97.9396837288233, 0], 10, "ccw"),
      drum("c", [121.46575989344427, 75.18638247702431, 0], 10, "ccw", { fixed: { wrap: 0 } }),
    ] });
    expect(row.wraps[1].angle).toBeLessThan(1e-6);
    expect(row.length).toBeCloseTo(120.273, 2);
    // anchors straight below each side of the drum: a half turn over the top
    const over = solveTaut({ d: D, through: [{ kind: "anchor", at: [-10, -30, 0] }, drum("a", [0, 0, 0], 10, "cw"), { kind: "anchor", at: [10, -30, 0] }] });
    expect(over.wraps[0].angle).toBeCloseTo(180, 6);
    expect(over.length).toBeCloseTo(30 + Math.PI * 10 + 30, 6);
  });

  it("the centreline runs at the pitch radius, half a rope outside the drum", () => {
    const r = solveTaut({ d: 2, through: [{ kind: "anchor", at: [-11, -30, 0] }, drum("a", [0, 0, 0], 10, "cw"), { kind: "anchor", at: [11, -30, 0] }] });
    expect(r.wraps[0].radius).toBe(11);
    expect(r.wraps[0].bendRatio).toBe(10);
    expect(r.length).toBeCloseTo(30 + Math.PI * 11 + 30, 9);
  });

  it("whole turns add 360 degrees each, and a lead makes the wrap a helix", () => {
    const base = [{ kind: "anchor", at: [-10, -30, 0] }, null, { kind: "anchor", at: [10, -30, 0] }];
    const at = (extra) => solveTaut({ d: D, through: [base[0], drum("a", [0, 0, 0], 10, "cw", extra), base[2]] });
    expect(at({ turns: 2 }).wraps[0].angle).toBeCloseTo(180 + 720, 6);
    const helix = at({ turns: 2, lead: 3 });
    const theta = (900 * Math.PI) / 180;
    expect(helix.wraps[0].length).toBeCloseTo(Math.hypot(10 * theta, 3 * 2.5), 6);
    expect(helix.wraps[0].w[1] - helix.wraps[0].w[0]).toBeCloseTo(7.5, 6);
    // the far anchor is 7.5 mm off the helix's end axially, 30 away in the plane
    expect(helix.spans[1].fleet).toBeCloseTo(Math.atan2(7.5, 30) * 180 / Math.PI, 6);
  });

  it("a drum at an end holds a termination: its wrap is given, not solved", () => {
    const r = solveTaut({ d: D, through: [drum("a", [0, 0, 0], 10, "ccw", { fixed: { wrap: 90 } }), { kind: "anchor", at: [10, 50, 0] }] });
    expect(r.wraps[0].angle).toBe(90);
    expect(r.length).toBeCloseTo((Math.PI / 2) * 10 + 50, 6);
    const off = solveTaut({ d: D, through: [drum("a", [0, 0, 0], 10, "ccw", { fixed: { wrap: -5 } }), { kind: "anchor", at: [10, 50, 0] }] });
    expect(off.wraps[0]).toMatchObject({ angle: 0, runOff: true });
  });

  it("points trace the centreline, arcs sampled finely", () => {
    const r = solveTaut({ d: D, through: [{ kind: "anchor", at: [-10, -30, 0] }, drum("a", [0, 0, 0], 10, "cw"), { kind: "anchor", at: [10, -30, 0] }] });
    const arcPoints = 180 / ARC_STEP_DEG + 1;
    expect(r.points.length - 2 - arcPoints).toBeLessThanOrEqual(1); // a wrap an ulp past 180 takes one more step
    expect(r.points.length).toBeGreaterThanOrEqual(2 + arcPoints);
    let len = 0;
    for (let i = 1; i < r.points.length; i++) len += Math.hypot(...r.points[i].map((c, j) => c - r.points[i - 1][j]));
    expect(len).toBeLessThan(r.length);
    expect(len).toBeGreaterThan(r.length - 0.05); // chords of a 10 degree arc
  });

  it("does not depend on which way the axis is drawn or where it points", () => {
    const up = solveTaut({ d: 1, through: [{ kind: "anchor", at: [-10, -30, 0] }, drum("a", [0, 0, 0], 10, "cw", { turns: 1 }), { kind: "anchor", at: [10, -30, 0] }] });
    // the same scene turned so the axis is +X (x→y, y→z, z→x)
    const turned = solveTaut({ d: 1, through: [{ kind: "anchor", at: [0, -10, -30] }, drum("a", [0, 0, 0], 10, "cw", { turns: 1, axis: [1, 0, 0] }), { kind: "anchor", at: [0, 10, -30] }] });
    expect(turned.length).toBeCloseTo(up.length, 9);
  });
});

describe("solveTaut: closed loops (a belt)", () => {
  it("two equal pulleys, open: two straights and two half turns", () => {
    const r = solveTaut({ d: D, closed: true, through: [drum("a", [0, 0, 0], 10, "ccw"), drum("b", [50, 0, 0], 10, "ccw")] });
    expect(r.length).toBeCloseTo(2 * 50 + 2 * Math.PI * 10, 6);
    expect(r.wraps.map((w) => w.angle)).toEqual([expect.closeTo(180, 6), expect.closeTo(180, 6)]);
    expect(r.points[0]).toEqual(r.points.at(-1));
  });

  it("unequal pulleys, open: the textbook belt length", () => {
    const R = 30, r0 = 10, C = 80;
    const r = solveTaut({ d: D, closed: true, through: [drum("a", [0, 0, 0], r0, "ccw"), drum("b", [C, 0, 0], R, "ccw")] });
    const beta = Math.asin((R - r0) / C);
    expect(r.length).toBeCloseTo(2 * C * Math.cos(beta) + (Math.PI + 2 * beta) * R + (Math.PI - 2 * beta) * r0, 6);
  });

  it("crossed: the pulleys are wrapped opposite ways and both wraps grow", () => {
    const R = 30, r0 = 10, C = 80;
    const r = solveTaut({ d: D, closed: true, through: [drum("a", [0, 0, 0], r0, "ccw"), drum("b", [C, 0, 0], R, "cw")] });
    const beta = Math.asin((R + r0) / C);
    expect(r.length).toBeCloseTo(2 * C * Math.cos(beta) + (Math.PI + 2 * beta) * (R + r0), 6);
  });
});

describe("solveTaut: refusals", () => {
  const bad = (spec, re) => expect(() => solveTaut(spec)).toThrow(re);
  it("names the field", () => {
    bad({ d: 0, through: [] }, /line: d: must be a positive number/);
    bad({ d: 1, through: [{ kind: "anchor", at: [0, 0, 0] }] }, /through: must list at least two/);
    bad({ d: 1, through: [{ kind: "hook" }, { kind: "anchor", at: [0, 0, 0] }] }, /through\[0\]\.kind/);
    bad({ d: 1, through: [drum("a", [0, 0, 0], 5, "left", { fixed: { wrap: 0 } }), { kind: "anchor", at: [9, 0, 0] }] }, /through\[0\]\.side/);
    bad({ d: 1, through: [drum("a", [0, 0, 0], 5, "ccw"), { kind: "anchor", at: [9, 0, 0] }] }, /through\[0\]\.fixed\.wrap: a drum at the end/);
    bad({ d: 1, through: [{ kind: "anchor", at: [0, 0, 0] }, drum("a", [9, 0, 0], 5, "ccw", { fixed: { wrap: 1 } }), { kind: "anchor", at: [20, 0, 0] }] }, /only a drum at the end/);
    bad({ d: 1, closed: true, through: [{ kind: "anchor", at: [0, 0, 0] }, drum("a", [9, 0, 0], 5, "ccw")] }, /a closed line runs over drums only/);
  });
  it("refuses a skew pair of axes and overlapping drums", () => {
    bad({ d: 1, closed: true, through: [drum("a", [0, 0, 0], 5, "ccw"), drum("b", [30, 0, 0], 5, "ccw", { axis: [0, 1, 0] })] }, /not parallel to the first drum's axis/);
    bad({ d: 1, closed: true, through: [drum("a", [0, 0, 0], 5, "ccw"), drum("b", [3, 0, 0], 5, "cw")] }, /no tangent between/);
  });
});

describe("rope materials", () => {
  const fail = (field, msg) => { throw new Error(`${field}: ${msg}`); };
  it("explicit numbers win over a preset; a preset's EA is an upper bound", () => {
    const p = resolveRope(fail, { d: 2, material: "uhmwpe" });
    expect(p.mu).toBe(ROPE_MATERIALS.uhmwpe.mu);
    expect(p.EA).toBeCloseTo(ROPE_MATERIALS.uhmwpe.modulus * Math.PI, 6);
    expect(p.bound).toBe(true);
    expect(resolveRope(fail, { d: 2, material: "uhmwpe", mu: 0.2, EA: 5000 })).toMatchObject({ mu: 0.2, EA: 5000, bound: false });
    expect(resolveRope(fail, { d: 2 })).toMatchObject({ mu: null, EA: null, bound: false });
  });
  it("an unknown material is an error, never a guess", () => {
    expect(() => resolveRope(fail, { d: 2, material: "string" })).toThrow(/rope\.material: unknown material "string" \(known: uhmwpe\)/);
  });
});

it("the lines folder is core: it imports no domain, no three, no node:", () => {
  const dir = fileURLToPath(new URL("../src/framework/lines/", import.meta.url));
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    for (const spec of importsOf(readFileSync(dir + name, "utf8"))) {
      expect(spec.startsWith("."), `${name} imports ${spec}`).toBe(true);
      expect(spec.includes("domains/"), `${name} imports ${spec}`).toBe(false);
    }
  }
});
