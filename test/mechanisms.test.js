// partforge/mechanisms: gear trains, belts, racks and crank-sliders as derive-time point
// sources (spec 2026-11-02 section 6). Ratios and signs, the points and axes a handle
// reads, place() turning a solid, and handleInfo() as plain JSON.
import { describe, it, expect } from "vitest";
import { gearTrain, beltDrive, rack, crankSlider } from "../src/framework/domains/mechanisms/index.js";

const rad = (d) => (d * Math.PI) / 180;
const roundTrip = (v) => JSON.parse(JSON.stringify(v));
const close = (a, b, eps = 1e-9) => a.forEach((c, i) => expect(Math.abs(c - b[i])).toBeLessThan(eps));

// A recording stand-in for a Solid: the ops place() applies, in order.
const recorder = (ops = []) => ({
  ops,
  rotate(deg, center, axis) { ops.push(["rotate", deg, center, axis]); return recorder(ops); },
  translate(v) { ops.push(["translate", v]); return recorder(ops); },
});

const train = (angle = 90) => gearTrain({
  gears: [
    { name: "gear1", teeth: 20, module: 2, center: [0, 0, 5] },
    { name: "gear2", teeth: 30, module: 2, center: [50, 0, 5], meshesWith: "gear1" },
    { name: "gear3", teeth: 40, module: 2, center: [120, 0, 5], meshesWith: ["gear2"] },
  ],
  drive: { gear: "gear1", angle },
});

describe("gearTrain", () => {
  it("a 20/30/40 train at a 90 degree drive turns 90, -60, 45", () => {
    const t = train(90);
    expect(t.angleOf("gear1")).toBeCloseTo(90, 12);
    expect(t.angleOf("gear2")).toBeCloseTo(-60, 12);
    expect(t.angleOf("gear3")).toBeCloseTo(45, 12);
  });

  it("an internal ring gear turns the same way as its pinion", () => {
    const t = gearTrain({
      gears: [
        { name: "pinion", teeth: 20, module: 1, center: [0, 0, 0] },
        { name: "ring", teeth: 60, module: 1, center: [20, 0, 0], internal: true, meshesWith: "pinion" },
      ],
      drive: { gear: "pinion", angle: 90 },
    });
    expect(t.angleOf("ring")).toBeCloseTo(30, 12);
  });

  it("points sit on the pitch circle, turned by each gear's angle; axes and mesh lines", () => {
    const info = train(90).handleInfo();
    expect(info.kind).toBe("partforge.points");
    close(info.points["gear1.center"], [0, 0, 5]);
    close(info.points["gear1.rim"], [0, 20, 5]);                         // r 20, turned 90
    close(info.points["gear2.rim"], [50 + 30 * Math.cos(rad(-60)), 30 * Math.sin(rad(-60)), 5]);
    close(info.points["gear3.rim"], [120 + 40 * Math.cos(rad(45)), 40 * Math.sin(rad(45)), 5]);
    expect(info.axes.gear2).toEqual({ origin: [50, 0, 5], direction: [0, 0, 1] });
    expect(info.lines).toEqual([["gear2.center", "gear1.center"], ["gear3.center", "gear2.center"]]);
  });

  it("handleInfo() is plain JSON", () => {
    const info = train(33.3).handleInfo();
    expect(roundTrip(info)).toEqual(info);
    const info0 = train(0).handleInfo();
    expect(roundTrip(info0)).toEqual(info0);
  });

  it("place turns a solid by its gear's angle about the axis, then moves it to the centre", () => {
    const s = train(90).place("gear2", recorder());
    expect(s.ops[0][0]).toBe("rotate");
    expect(s.ops[0][1]).toBeCloseTo(60, 9);
    close(s.ops[0][3], [0, 0, -1]);
    expect(s.ops[1]).toEqual(["translate", [50, 0, 5]]);
    // at angle 0 the solid is only moved
    expect(train(0).place("gear1", recorder()).ops).toEqual([["translate", [0, 0, 5]]]);
  });

  it("a gear on a tilted axis: its rim stays in the gear's plane", () => {
    const t = gearTrain({ gears: [{ name: "g", teeth: 10, module: 2, center: [0, 0, 0], axis: [1, 0, 0] }], drive: { gear: "g", angle: 37 } });
    const rim = t.handleInfo().points["g.rim"];
    expect(Math.abs(rim[0])).toBeLessThan(1e-9);
    expect(Math.hypot(...rim)).toBeCloseTo(10, 9);
  });

  it("throws on an unknown meshesWith, an unconnected gear and an unknown drive", () => {
    expect(() => gearTrain({ gears: [{ name: "a", teeth: 10, module: 1, center: [0, 0, 0], meshesWith: "nope" }], drive: { gear: "a", angle: 0 } }))
      .toThrow(/meshesWith.*"nope"/);
    expect(() => gearTrain({
      gears: [{ name: "a", teeth: 10, module: 1, center: [0, 0, 0] }, { name: "b", teeth: 10, module: 1, center: [30, 0, 0] }],
      drive: { gear: "a", angle: 0 },
    })).toThrow(/"b" is not connected/);
    expect(() => gearTrain({ gears: [{ name: "a", teeth: 10, module: 1, center: [0, 0, 0] }], drive: { gear: "x", angle: 0 } })).toThrow(/drive/);
    expect(() => train().place("nope", recorder())).toThrow(/unknown gear/);
  });
});

describe("beltDrive", () => {
  it("a 20 mm pulley driving a 40 mm one: 360 turns it 180, the same way", () => {
    const b = beltDrive({
      pulleys: [
        { name: "small", diameter: 20, center: [0, 0, 0], axis: [0, 0, 1] },
        { name: "big", diameter: 40, center: [80, 0, 0], axis: [0, 0, 1] },
      ],
      drive: { pulley: "small", angle: 360 },
    });
    expect(b.angleOf("big")).toBeCloseTo(180, 12);
    const info = b.handleInfo();
    close(info.points.belt, [0, 10, 0]);
    close(info.points["big.rim"], [60, 0, 0]);
    expect(info.axes.big).toEqual({ origin: [80, 0, 0], direction: [0, 0, 1] });
    expect(roundTrip(info)).toEqual(info);
  });
});

describe("rack", () => {
  it("a 20 tooth module 1 pinion turned 360 moves its rack 20 pi", () => {
    const r = rack({ pinion: { name: "pinion", teeth: 20, module: 1, center: [0, 0, 0], axis: [0, 0, 1], angle: 360 }, direction: [1, 0, 0] });
    expect(r.travel).toBeCloseTo(20 * Math.PI, 9);
    const info = r.handleInfo();
    // the rack meshes at direction x axis = -Y, so its pitch mark starts at [0, -10, 0]
    close(info.points["rack.pitch"], [20 * Math.PI, -10, 0]);
    expect(roundTrip(info)).toEqual(info);
    expect(r.place("rack", recorder()).ops).toEqual([["translate", [r.travel, 0, 0]]]);
  });
});

describe("crankSlider", () => {
  const L = 20, R = 50;
  const at = (angle) => crankSlider({ crank: { center: [1, 2, 3], axis: [0, 0, 1], length: L, angle }, rod: R, slideDirection: [1, 0, 0] });
  const closed = (deg) => {
    const a = rad(deg);
    return { pin: [1 + L * Math.cos(a), 2 + L * Math.sin(a), 3], x: L * Math.cos(a) + Math.sqrt(R * R - L * L * Math.sin(a) ** 2) };
  };
  for (const deg of [0, 90, 180]) {
    it(`matches the closed form at ${deg} degrees`, () => {
      const c = at(deg), want = closed(deg);
      close(c.crankPin, want.pin);
      close(c.slider, [1 + want.x, 2, 3]);
      const info = c.handleInfo();
      close(info.points["crank.pin"], want.pin);
      close(info.points.slider, [1 + want.x, 2, 3]);
      expect(roundTrip(info)).toEqual(info);
    });
  }

  it("throws when the rod is shorter than the crank", () => {
    expect(() => crankSlider({ crank: { center: [0, 0, 0], length: 30, angle: 0 }, rod: 20, slideDirection: [1, 0, 0] })).toThrow(/rod/);
  });
});
