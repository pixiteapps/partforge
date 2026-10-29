// Pure readings: what one click reads, and what two clicks measure.
import { describe, expect, test } from "vitest";
import { firstReading, spanSpec, frameAxesFor } from "../../../src/framework/measure/readings.js";

const PARTS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

const holeSpec = {
  kind: "cylinder",
  values: { diameter: 6, depth: 4, partial: false },
  anchors: { center: [0, 0, 2], axis: [0, 0, 1], bottom: [0, 0, 0], top: [0, 0, 4], rimDir: [1, 0, 0] },
};
const planeSpec = {
  kind: "plane",
  values: { width: 20, height: 10 },
  anchors: { center: [10, 5, 2], normal: [0, 0, 1] },
};
const bboxSpec = { kind: "bbox", values: { w: 1, d: 1, h: 1 }, anchors: {} };

const circle = { kind: "circle", point: [0, 0, 4], featureId: 2 };
const corner = { kind: "corner", point: [0, 0, 0], featureId: 1 };
const edgeT = (l, straight = true) => ({
  kind: "edge", point: [l / 2, 0, 2], featureId: 1,
  chain: { points: [[0, 0, 2], [l / 3, 0, 2], [l, 0, 2]], straight, length: l, mid: [l / 2, 0, 2], owners: [1] },
});

// 30° about z.
const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
const rotated30 = () => ({ elements: [c30, s30, 0, 0, -s30, c30, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] });

describe("firstReading", () => {
  test("circle target reads the cylinder's diameter", () => expect(firstReading(circle, holeSpec)).toBe(holeSpec));
  test("face or edge on a cylinder reads the cylinder", () => {
    expect(firstReading({ kind: "face", point: [0, 0, 4], featureId: 2 }, holeSpec)).toBe(holeSpec);
    expect(firstReading(edgeT(5, false), holeSpec)).toBe(holeSpec);
  });
  test("face on a plane reads the plane", () =>
    expect(firstReading({ kind: "face", point: [1, 1, 2], featureId: 1 }, planeSpec)).toBe(planeSpec));
  test("straight edge reads its length", () => expect(firstReading(edgeT(20), planeSpec).values.length).toBe(20));
  test("straight edge anchors at the chain's ends, length q2-rounded", () => {
    const s = firstReading(edgeT(20.004), planeSpec);
    expect(s).toEqual({ kind: "edge", values: { length: 20 }, anchors: { a: [0, 0, 2], b: [20.004, 0, 2] } });
  });
  test("corner reads nothing", () => expect(firstReading(corner, planeSpec)).toBeNull());
  test("midpoint, point and curved edges read nothing", () => {
    expect(firstReading({ kind: "midpoint", point: [1, 0, 0], featureId: 1 }, planeSpec)).toBeNull();
    expect(firstReading({ kind: "point", point: [1, 0, 0], featureId: 1 }, planeSpec)).toBeNull();
    expect(firstReading(edgeT(5, false), planeSpec)).toBeNull();
  });
  test("bbox feature or no spec reads nothing", () => {
    expect(firstReading({ kind: "face", point: [0, 0, 0], featureId: 3 }, bboxSpec)).toBeNull();
    expect(firstReading({ kind: "face", point: [0, 0, 0], featureId: 0 }, null)).toBeNull();
  });
});

describe("spanSpec", () => {
  test("axis-aligned span takes the dominant axis", () => {
    const s = spanSpec([0, 0, 0], [30, 4, 1], { axes: PARTS, straight: false, faceNormals: [null, null] });
    expect(s.values.distance).toBe(30); expect(s.anchors.axis).toEqual([1, 0, 0]);
    expect(s.kind).toBe("span");
    expect(s.anchors).toMatchObject({ a: [0, 0, 0], b: [30, 4, 1], axes: PARTS, straight: false });
  });
  test("dominant axis distance is unsigned", () => {
    const s = spanSpec([0, 0, 0], [-2, -9, 1], { axes: PARTS, straight: false, faceNormals: [null, null] });
    expect(s.values.distance).toBe(9); expect(s.anchors.axis).toEqual([0, 1, 0]);
  });
  test("straight span is the true distance", () => {
    const s = spanSpec([0, 0, 0], [3, 4, 0], { axes: PARTS, straight: true, faceNormals: [null, null] });
    expect(s.values.distance).toBe(5);
    expect(s.anchors.axis[0]).toBeCloseTo(0.6); expect(s.anchors.axis[1]).toBeCloseTo(0.8);
  });
  test("parallel faces give the gap along the normal", () => {
    const s = spanSpec([0, 0, 0], [7, 2, 5], { axes: PARTS, straight: true, faceNormals: [[0, 0, 1], [0, 0, -1]] });
    expect(s.values.distance).toBe(5); expect(s.anchors.axis).toEqual([0, 0, 1]);
  });
  test("non-parallel faces fall back to the dominant axis", () => {
    const s = spanSpec([0, 0, 0], [7, 2, 5], { axes: PARTS, straight: false, faceNormals: [[0, 0, 1], [1, 0, 0]] });
    expect(s.values.distance).toBe(7);
  });
  test("same point is no span", () => expect(spanSpec([1, 1, 1], [1, 1, 1.004], { axes: PARTS, straight: false, faceNormals: [null, null] })).toBeNull());
  test("a tiny gap between parallel faces is no span", () =>
    expect(spanSpec([0, 0, 0], [9, 0, 0.003], { axes: PARTS, straight: false, faceNormals: [[0, 0, 1], [0, 0, 1]] })).toBeNull());
  test("values are q2-rounded", () => {
    expect(spanSpec([0, 0, 0], [12.3456, 0, 0], { axes: PARTS, straight: false, faceNormals: [null, null] }).values.distance).toBe(12.35);
  });
});

describe("frameAxesFor", () => {
  test("different sub-parts use the parts frame even if one is rotated", () => {
    expect(frameAxesFor("a", "b", rotated30)).toEqual(PARTS);
    const x = frameAxesFor("a", "a", rotated30)[0];
    expect(x[0]).toBeCloseTo(Math.cos(Math.PI / 6)); expect(x[1]).toBeCloseTo(Math.sin(Math.PI / 6));
  });
  test("same sub-part with no matrix uses the parts frame", () => {
    expect(frameAxesFor("a", "a", () => null)).toEqual(PARTS);
  });
  test("a plain 16-element array is read column-major and normalised", () => {
    const m = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1];
    expect(frameAxesFor("a", "a", () => m)).toEqual(PARTS);
  });
});
