// partforge/mechanisms' capstan(): a rope drive between a drum and a pulley (spec
// 2026-11-20-lines-rope-and-cable-design.md). Ratio and signs, the rope's length held
// through the drum's travel, fleet from the drum's lead, travel limits, and plain JSON.
import { describe, it, expect } from "vitest";
import { capstan, beltDrive } from "../src/framework/domains/mechanisms/index.js";

const roundTrip = (v) => JSON.parse(JSON.stringify(v));
const make = (angle, { input = {}, output = {}, rope = {}, ...top } = {}) => capstan({
  rope: { d: 1.2, ...rope },
  input: { name: "drum", radius: 6, center: [0, 0, 0], turns: 3, ...input },
  output: { name: "pulley", radius: 30, center: [40, 0, 0], ...output },
  drive: { member: "drum", angle },
  ...top,
});
const recorder = (ops = []) => ({
  ops,
  rotate(deg, center, axis) { ops.push(["rotate", deg, center, axis]); return recorder(ops); },
  translate(v) { ops.push(["translate", v]); return recorder(ops); },
});

describe("capstan: ratio and angles", () => {
  it("the ratio is the PITCH radii's: rope centre to rope centre", () => {
    expect(make(0).ratio).toBeCloseTo(30.6 / 6.6, 12);
    expect(make(0).report().ratio).toBe(4.636);
  });
  it("crossed (the default) the members turn opposite ways; open, the same way", () => {
    expect(make(90).angleOf("pulley")).toBeCloseTo((-90 * 6.6) / 30.6, 12);
    expect(make(90, { cross: false }).angleOf("pulley")).toBeCloseTo((90 * 6.6) / 30.6, 12);
    expect(make(90).angleOf("drum")).toBe(90);
  });
  it("either member can drive", () => {
    const byPulley = capstan({ rope: { d: 1.2 }, input: { name: "drum", radius: 6, center: [0, 0, 0] }, output: { name: "pulley", radius: 30, center: [40, 0, 0] }, drive: { member: "pulley", angle: -20 } });
    expect(byPulley.angleOf("drum")).toBeCloseTo((20 * 30.6) / 6.6, 9);
  });
  it("a driving output keeps its own angle when its axis points the other way", () => {
    const flipped = capstan({ rope: { d: 1.2 }, input: { name: "drum", radius: 6, center: [0, 0, 0] }, output: { name: "pulley", radius: 30, center: [40, 0, 0], axis: [0, 0, -1] }, drive: { member: "pulley", angle: -20 } });
    expect(flipped.angleOf("pulley")).toBe(-20);
    // the same turn seen about the drum's axis is +20, so the crossed drum goes the other way
    expect(flipped.angleOf("drum")).toBeCloseTo((-20 * 30.6) / 6.6, 9);
  });
  it("open, it turns as a belt on the same pitch circles does", () => {
    const belt = beltDrive({ pulleys: [{ name: "drum", diameter: 13.2, center: [0, 0, 0] }, { name: "pulley", diameter: 61.2, center: [40, 0, 0] }], drive: { pulley: "drum", angle: 77 } });
    expect(make(77, { cross: false }).angleOf("pulley")).toBeCloseTo(belt.angleOf("pulley"), 12);
  });
  it("place turns a member to its angle about its axis and sets it at its centre", () => {
    const { ops } = make(90).place("drum", recorder());
    expect(ops[0][0]).toBe("rotate");
    expect(ops[0][1]).toBeCloseTo(90, 9);
    expect(ops.at(-1)).toEqual(["translate", [0, 0, 0]]);
  });
});

describe("capstan: the rope", () => {
  it("with no lead the rope's length is the same at every angle inside its travel", () => {
    for (const cross of [true, false]) {
      const rest = make(0, { cross, input: { lead: 0 } }).report();
      for (const a of [-400, -123.4, 37, 250, 400]) {
        const r = make(a, { cross, input: { lead: 0 } }).report();
        expect(r.travel.inside).toBe(true);
        expect(Math.abs(r.length - rest.length)).toBeLessThan(1e-3);
        expect(r.drift).toBe(0);
      }
    }
  });
  it("a lead walks the rope along the drum: fleet and drift grow with the angle", () => {
    const at = (a) => make(a).report();
    expect(at(0).halves.map((h) => h.fleet)).toEqual([0, 0]); // the grooves sit where the rope leaves at rest
    expect(at(0).drift).toBe(0);
    expect(at(360).halves[0].fleet).toBeGreaterThan(at(90).halves[0].fleet);
    expect(at(360).drift).toBeGreaterThan(at(90).drift);
    // one drum turn moves the rope one lead (the rope's own diameter by default) along it
    const span = at(360).halves[0].span;
    expect(at(360).halves[0].fleet).toBeCloseTo((Math.asin(1.2 / span) * 180) / Math.PI, 2);
  });
  it("winding on one side is winding off the other", () => {
    const r0 = make(0).report(), r = make(200).report();
    expect(r.halves[0].drum.wrap + r.halves[1].drum.wrap).toBeCloseTo(r0.halves[0].drum.wrap * 2, 2);
    expect(Math.abs(r.halves[0].drum.wrap - r0.halves[0].drum.wrap)).toBeCloseTo(200, 2);
    expect(r.halves[0].pulley.wrap + r.halves[1].pulley.wrap).toBeCloseTo(180, 2);
  });
  it("travel ends where a side runs out of rope on either member", () => {
    const r = make(0).report();
    // the pulley's 90 degrees a side run out first: 90 * 30.6 / 6.6 of drum
    expect(r.travel.drum[1]).toBeCloseTo((90 * 30.6) / 6.6, 2);
    expect(r.travel.pulley).toEqual([-90, 90]);
    const past = make(r.travel.drum[1] + 30).report();
    expect(past.travel.inside).toBe(false);
    expect(past.halves.some((h) => h.runOff)).toBe(true);
    // with plenty on the pulley the drum's own turns are the limit
    const wide = make(0, { output: { wrap: 170 } }).report();
    expect(wide.travel.drum[1]).toBeCloseTo(wide.halves[0].drum.wrap, 2);
  });
  it("the drum must be as wide as the band its rope covers over the whole travel", () => {
    // the rope is pinned at M, so turning the drum shifts the wound band along it: at the
    // travel's end one side holds its rest turns plus the travel
    const r = make(0).report();
    const limit = r.travel.drum[1];
    expect(r.drumWidth).toBeCloseTo((1.2 * (r.halves[0].drum.wrap + r.halves[1].drum.wrap + 2 * limit)) / 360 + 1.2, 2);
    expect(make(200).report().drumWidth).toBe(r.drumWidth); // a property of the joint, not the pose
    // and it covers every point the rope reaches on the drum, end to end of the travel
    const zs = [-limit, 0, limit].flatMap((a) => make(a).lineInfo().lines.rope.points.filter((q) => Math.hypot(q[0], q[1]) < 6.7).map((q) => q[2]));
    expect(Math.max(...zs) - Math.min(...zs) + 1.2).toBeCloseTo(r.drumWidth, 2);
  });
  it("a pulley set along the axis from the drum leans the spans, also at rest", () => {
    const level = make(0).report(), off = make(0, { output: { center: [40, 0, 5] } });
    const r = off.report();
    expect(level.halves.map((h) => h.fleet)).toEqual([0, 0]);
    for (const h of r.halves) expect(h.fleet).toBeCloseTo((Math.atan2(5, Math.sqrt(h.span ** 2 - 25)) * 180) / Math.PI, 2);
    expect(r.length).toBeGreaterThan(level.length);
    // the rope ends on the pulley where the pulley is placed
    const pts = off.lineInfo().lines.rope.points;
    expect(Math.abs(pts[0][2] - 5)).toBeLessThan(3);
    expect(Math.abs(pts.at(-1)[2] - 5)).toBeLessThan(3);
  });
  it("bend ratios are drum diameter over rope diameter, judged only against a declared limit", () => {
    expect(make(0).report().bend).toEqual({ drum: 10, pulley: 50 });
    expect(make(0, { rope: { minBendRatio: 12 } }).report().bend).toEqual({ drum: 10, pulley: 50, required: 12, ok: false });
  });
  it("a friction capstan reports what its least wrap holds", () => {
    expect(make(0).report().holding).toBeUndefined();
    expect(make(0, { fixed: false }).report().holding).toEqual({ needs: "rope.mu" });
    const h = make(0, { fixed: false, rope: { mu: 0.2 } }).report().holding;
    expect(h.ratio).toBeCloseTo(Math.exp((0.2 * h.wrap * Math.PI) / 180), 2);
  });
  it("stiffness and tension need the rope's EA; a preset's is marked an upper bound", () => {
    expect(make(90).report().stiffness).toBeUndefined();
    const r = make(90, { rope: { EA: 4000 }, pretension: 20 }).report();
    expect(r.stiffness.rope[0]).toBeCloseTo(4000 / r.halves[0].length, 2);
    expect(r.stiffness.upperBound).toBe(false);
    expect(r.tensionChange).toBeCloseTo((4000 * r.drift) / r.restLength, 2);
    expect(r.slack).toBe(false);
    expect(make(90, { rope: { material: "uhmwpe" } }).report().stiffness.upperBound).toBe(true);
  });
});

describe("capstan: plain data", () => {
  it("handleInfo is the point-source contract", () => {
    const info = make(90).handleInfo();
    expect(info.kind).toBe("partforge.points");
    expect(Object.keys(info.points)).toEqual(["drum.center", "drum.rim", "pulley.center", "pulley.rim"]);
    expect(info.points["drum.rim"][1]).toBeCloseTo(6.6, 9); // the pitch radius, turned 90
    expect(info.axes.pulley).toEqual({ origin: [40, 0, 0], direction: [0, 0, 1] });
    expect(roundTrip(info)).toEqual(info);
  });
  it("lineInfo is one open taut line that starts and ends on the pulley", () => {
    const info = make(90).lineInfo();
    expect(info.kind).toBe("partforge.lines");
    const { rope } = info.lines;
    expect(rope).toMatchObject({ mode: "taut", d: 1.2, closed: false });
    const fromPulley = (q) => Math.hypot(q[0] - 40, q[1]);
    expect(fromPulley(rope.points[0])).toBeCloseTo(30.6, 2);
    expect(fromPulley(rope.points.at(-1))).toBeCloseTo(30.6, 2);
    expect(roundTrip(info)).toEqual(info);
    expect(roundTrip(make(90).report())).toEqual(make(90).report());
  });
  it("the two halves meet at one point on the drum", () => {
    // no jump where half 1's last point and half 2's first were joined
    const pts = make(137).lineInfo().lines.rope.points;
    for (let i = 1; i < pts.length; i++) expect(Math.hypot(...pts[i].map((c, j) => c - pts[i - 1][j]))).toBeLessThan(16);
  });
});

describe("capstan: refusals", () => {
  const bad = (over, re) => expect(() => make(0, over)).toThrow(re);
  it("names the helper and the field", () => {
    expect(() => capstan()).toThrow(/capstan: takes \{ rope, input, output, drive \}/);
    bad({ rope: { d: -1 } }, /capstan: rope\.d: must be a positive number/);
    bad({ rope: { material: "twine" } }, /capstan: rope\.material: unknown material "twine"/);
    bad({ input: { turns: 1.5 } }, /capstan: input\.turns/);
    bad({ output: { name: "drum" } }, /capstan: output\.name: duplicate name "drum"/);
    bad({ output: { axis: [0, 1, 0] } }, /capstan: output\.axis: must be parallel/);
    bad({ output: { center: [5, 0, 0] } }, /capstan: output\.center: the members overlap/);
    bad({ cross: false, output: { center: [28, 0, 0] } }, /capstan: output\.center: the members overlap/);
    expect(() => make(0, { output: { center: [37.3, 0, 0] } })).not.toThrow(); // pitch radii 6.6 + 30.6
    // a member's name is a key of the report, beside the report's own
    for (const name of ["length", "span", "fleet", "runOff", "required", "ok", "inside"]) {
      bad({ input: { name } }, new RegExp(`capstan: input\\.name: "${name}" is a field of the report`));
      bad({ output: { name } }, new RegExp(`capstan: output\\.name: "${name}" is a field of the report`));
    }
    expect(() => make(0).angleOf("motor")).toThrow(/capstan: angleOf: unknown member "motor"/);
    expect(() => capstan({ rope: { d: 1 }, input: { name: "a", radius: 5, center: [0, 0, 0] }, output: { name: "b", radius: 9, center: [30, 0, 0] }, drive: { member: "c", angle: 0 } })).toThrow(/capstan: drive\.member/);
  });
});
