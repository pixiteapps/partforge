import { describe, it, expect } from "vitest";
import { sameTurn } from "../src/framework/panel/widgets/numeric.js";
import {
  planeGuide, rotaryGuide, sweepPath, pathKey, pathParam, readoutText, readoutKeys, readoutItems, chipValues,
  PATH_SAMPLES, AXIS_ARROW_PX, PLANE_SQUARE_PX,
} from "../src/framework/pose/handle-guides.js";

const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (a) => Math.hypot(...a);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const box = {
  parameters: [{ id: "b", title: "Box", controls: [
    { key: "width", min: 10, max: 400, step: 0.1 },
    { key: "depth", min: 10, max: 200, step: 0.5 },
    { key: "count", min: 1, max: 9, step: 1 },
  ] }],
  defaults: { width: 80, depth: 40, count: 3 },
  derive: () => ({}),
  handles: {
    corner: { point: (p) => [p.width / 2, p.depth / 2, 10], params: ["width", "depth"], drag: "plane", normal: [0, 0, 1] },
    side: { point: (p) => [p.width / 2, 0, 0], params: ["width"], drag: "axis", direction: [1, 0, 0] },
  },
};

const train = {
  parameters: [{ id: "t", title: "Train", controls: [{ key: "driveAngle", min: 0, max: 360, step: 1, wrap: true }] }],
  defaults: { driveAngle: 720 },
  derive: () => ({}),
  handles: {
    rim: { point: (p) => [20 * Math.cos((p.driveAngle * Math.PI) / 180), 20 * Math.sin((p.driveAngle * Math.PI) / 180), 0], params: ["driveAngle"], drag: "rotary", axis: { origin: [0, 0, 0], direction: [0, 0, 1] } },
  },
};

describe("guides", () => {
  it("plane: a PLANE_SQUARE_PX square on the plane, centred on the point", () => {
    const g = planeGuide([5, 5, 10], [0, 0, 1], 2);
    expect(g.kind).toBe("plane");
    expect(g.points).toHaveLength(4);
    for (const p of g.points) expect(p[2]).toBeCloseTo(10, 9);
    expect(len(sub(g.points[0], g.points[1]))).toBeCloseTo(PLANE_SQUARE_PX * 2, 9);
    const c = g.points.reduce((a, p) => a.map((v, i) => v + p[i] / 4), [0, 0, 0]);
    c.forEach((v, i) => expect(v).toBeCloseTo([5, 5, 10][i], 9));
  });

  it("rotary: a ring through the point about the axis; on the axis, a small ring", () => {
    const axis = { origin: [0, 0, 0], direction: [0, 0, 1] };
    const g = rotaryGuide([30, 40, 7], axis, 1);
    expect(g.kind).toBe("rotary");
    for (const p of g.points) {
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(50, 9);
      expect(p[2]).toBeCloseTo(7, 9);
    }
    const onAxis = rotaryGuide([0, 0, 4], axis, 0.5);
    for (const p of onAxis.points) expect(Math.hypot(p[0], p[1])).toBeCloseTo(AXIS_ARROW_PX * 0.5, 9);
  });
});

describe("path preview", () => {
  it("sweeps a one-param handle's param over its range: PATH_SAMPLES points, ends included", () => {
    const g = sweepPath(box, box.defaults, box.handles.side);
    expect(g.kind).toBe("path");
    expect(g.points).toHaveLength(PATH_SAMPLES);
    expect(g.points[0][0]).toBeCloseTo(5, 9);
    expect(g.points.at(-1)[0]).toBeCloseTo(200, 9);
  });

  it("a wrapped param samples one turn, min..max, whatever turn it stands in", () => {
    const g = sweepPath(train, train.defaults, train.handles.rim);
    expect(g.points).toHaveLength(PATH_SAMPLES);
    for (const p of g.points) expect(Math.hypot(p[0], p[1])).toBeCloseTo(20, 9);
    g.points[0].forEach((v, i) => expect(v).toBeCloseTo(g.points.at(-1)[i], 9)); // a closed turn
  });

  it("no path for a handle with two params, or a param without a range", () => {
    expect(pathParam(box.handles.corner)).toBeNull();
    expect(sweepPath(box, box.defaults, box.handles.corner)).toBeNull();
    const loose = { ...box, parameters: [], handles: { side: box.handles.side } };
    expect(sweepPath(loose, box.defaults, loose.handles.side)).toBeNull();
  });

  it("skips samples the point cannot be read at", () => {
    const fragile = { point: (p) => { if (p.width > 200) throw new Error("x"); return [p.width, 0, 0]; }, params: ["width"], drag: "axis", direction: [1, 0, 0] };
    const g = sweepPath(box, box.defaults, fragile);
    expect(g.points.length).toBeLessThan(PATH_SAMPLES);
    for (const p of g.points) expect(p[0]).toBeLessThanOrEqual(200);
  });

  it("its key ignores the swept param, so a drag of it keeps the path", () => {
    expect(pathKey({ width: 80, depth: 40 }, "width")).toBe(pathKey({ width: 120, depth: 40 }, "width"));
    expect(pathKey({ width: 80, depth: 40 }, "width")).not.toBe(pathKey({ width: 80, depth: 41 }, "width"));
  });
});

describe("readoutText", () => {
  it("each param rounded to its step's decimals, joined by a middle dot", () => {
    const part = { ...box, parameters: [{ id: "b", title: "B", controls: [
      { key: "width", min: 10, max: 400, step: 0.1 },
      { key: "depth", min: 10, max: 200, step: 0.1 },
    ] }] };
    expect(readoutText(part, { width: 84.04, depth: 60.46 }, box.handles.corner)).toBe("width 84.0 · depth 60.5");
  });

  it("readout lists override params; integers show as is; missing values are left out", () => {
    expect(readoutText(box, { width: 84, depth: 60.25, count: 4 }, { params: ["width"], readout: ["count", "depth", "nope"] }))
      .toBe("count 4 · depth 60.3");
    expect(readoutText(box, { width: 84 }, { params: ["width"], readout: "width" })).toBe("width 84.0");
    const free = { defaults: {}, parameters: [] };
    expect(readoutText(free, { a: 3, b: 1.23456 }, { params: ["a", "b"] })).toBe("a 3 · b 1.23");
  });

  it("guides stay in the plane they are drawn on", () => {
    const g = planeGuide([0, 0, 0], [1, 1, 0], 1);
    for (const p of g.points) expect(dot(p, [1, 1, 0])).toBeCloseTo(0, 9);
  });
});

describe("the readout chip's values (readoutKeys, chipValues)", () => {
  it("readoutKeys: the readout params, else the handle's params, as readoutText reads them", () => {
    expect(readoutKeys(box.handles.corner)).toEqual(["width", "depth"]);
    expect(readoutKeys({ params: ["width"], readout: "count" })).toEqual(["count"]);
    expect(readoutKeys({ params: ["width"], readout: ["count", 3, "depth"] })).toEqual(["count", "depth"]);
    expect(readoutKeys({})).toEqual([]);
  });

  it("readoutKeys / readoutItems: a goal handle's { position, aim } params, position's then aim's", () => {
    const goal = { on: "arm", drag: "goal", params: { position: ["x", "y", "z"], aim: ["pitch", "yaw"] } };
    expect(readoutKeys(goal)).toEqual(["x", "y", "z", "pitch", "yaw"]);
    expect(readoutKeys({ ...goal, params: { position: ["x", "y", "z"] } })).toEqual(["x", "y", "z"]);
    expect(readoutKeys({ ...goal, readout: "pitch" })).toEqual(["pitch"]);
    const arm = {
      parameters: [{ id: "g", title: "Goal", controls: [
        { key: "x", label: "Tool X", unit: "mm", min: -100, max: 100, step: 0.5 },
        { key: "y", min: -100, max: 100, step: 0.5 },
        { key: "z", min: 0, max: 100, step: 0.5 },
        { key: "pitch", label: "Pitch", unit: "°", min: -90, max: 90, step: 1 },
        { key: "yaw", min: -180, max: 180, step: 1 },
      ] }],
      defaults: { x: 10, y: 0, z: 50, pitch: 0, yaw: 0 },
      derive: () => ({}),
    };
    const items = readoutItems(arm, { ...arm.defaults, x: 12.5, pitch: 30 }, goal);
    expect(items.map((i) => i.key)).toEqual(["x", "y", "z", "pitch", "yaw"]);
    expect(items[0]).toEqual({ key: "x", label: "Tool X", unit: "mm", value: 12.5, text: "12.5" });
    expect(items[3]).toEqual({ key: "pitch", label: "Pitch", unit: "°", value: 30, text: "30" });
  });

  it("clamps and snaps a typed value as the slider does", () => {
    expect(chipValues(box, { width: 80, depth: 40 }, { width: 85.04, depth: 41.3 })).toEqual({ width: 85, depth: 41.5 });
    expect(chipValues(box, { width: 80 }, { width: 9000 })).toEqual({ width: 400 });
    expect(chipValues(box, { width: 80 }, { width: -5 })).toEqual({ width: 10 });
    expect(chipValues(box, { count: 3 }, { count: 4.4 })).toEqual({ count: 4 });
    // not a number: left out
    expect(chipValues(box, { width: 80 }, { width: NaN, depth: "x" })).toEqual({});
  });

  it("stores a wrapped param in the same turn as now (the slider's sameTurn)", () => {
    expect(chipValues(train, { driveAngle: 720 }, { driveAngle: 45 })).toEqual({ driveAngle: 765 });
    expect(chipValues(train, { driveAngle: 720 }, { driveAngle: 350 })).toEqual({ driveAngle: 710 });
    expect(chipValues(train, { driveAngle: 720 }, { driveAngle: 45.4 })).toEqual({ driveAngle: 765 });
    for (const [stored, typed] of [[720, 45], [-30, 200], [1000, 359.5], [5, 0]]) {
      expect(chipValues(train, { driveAngle: stored }, { driveAngle: typed }).driveAngle).toBe(Math.round(sameTurn(stored, typed, 0, 360)));
    }
  });
});
