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
  // One number for a cylinder: ⌀ (or R when partial), never its depth — the
  // depth is reachable through a second click.
  // `at` is the axis point level with the click; a centre click has no side
  const diameterOnly = {
    ...holeSpec, values: { diameter: 6, partial: false },
    anchors: { ...holeSpec.anchors, at: [0, 0, 4] },
  };
  test("circle target reads the cylinder's diameter only", () => {
    expect(firstReading(circle, holeSpec)).toEqual(diameterOnly);
    expect("depth" in firstReading(circle, holeSpec).values).toBe(false);
    expect(holeSpec.values.depth).toBe(4); // the cached feature spec is not mutated
  });
  test("an edge on a cylinder reads the cylinder's diameter", () => {
    expect(firstReading(edgeT(5, false), holeSpec).values).toEqual(diameterOnly.values);
  });
  test("the wall face of a cylinder reads its diameter AND its depth", () => {
    const s = firstReading({ kind: "face", point: [0, -3, 3], featureId: 2 }, holeSpec);
    expect(s.values).toEqual({ diameter: 6, depth: 4, partial: false });
    expect(s).not.toBe(holeSpec); // still a copy
  });
  test("a cylinder reading is anchored at the clicked depth and side", () => {
    // the wall, 1 mm down from the top, on the -Y side
    const s = firstReading({ kind: "edge", point: [0, -3, 3], featureId: 2 }, holeSpec);
    expect(s.anchors.at).toEqual([0, 0, 3]);
    expect(s.anchors.clickDir).toEqual([0, -1, 0]);
    // a click past either end of the wall stays on the wall
    const above = firstReading({ kind: "circle", point: [3, 0, 9], featureId: 2 }, holeSpec);
    expect(above.anchors.at).toEqual([0, 0, 4]);
    expect(above.anchors.clickDir).toEqual([1, 0, 0]);
  });
  test("a rim snap on the centre takes its side from the raw hit point", () => {
    // the snap is the rim's centre; the pointer was over the rim on the +Y side
    const s = firstReading(circle, holeSpec, { hitPoint: [0.2, 3.1, 4] });
    expect(s.anchors.at).toEqual([0, 0, 4]); // the rim's level, from the snap
    expect(s.anchors.clickDir[1]).toBeCloseTo(0.998, 3);
    expect(s.anchors.clickDir[2]).toBe(0);
  });
  test("a cylinder whose axis points down still anchors at the click", () => {
    const flipped = { ...holeSpec, anchors: { ...holeSpec.anchors, axis: [0, 0, -1], top: [0, 0, 0], bottom: [0, 0, 4] } };
    expect(firstReading({ kind: "circle", point: [0, 3, 4], featureId: 2 }, flipped).anchors.at).toEqual([0, 0, 4]);
  });
  test("a partial cylinder keeps its partial flag (R)", () => {
    const arc = { ...holeSpec, values: { diameter: 6, depth: 4, partial: true } };
    expect(firstReading(circle, arc).values).toEqual({ diameter: 6, partial: true });
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
  test("two points on one face (no gap) fall through to the dominant axis", () => {
    const s = spanSpec([0, 0, 0], [9, 3, 0.003], { axes: PARTS, straight: false, faceNormals: [[0, 0, 1], [0, 0, 1]] });
    expect(s.values.distance).toBe(9); expect(s.anchors.axis).toEqual([1, 0, 0]);
  });
  test("two coplanar faces, straight on, give the straight distance", () => {
    const s = spanSpec([0, 0, 2], [3, 4, 2], { axes: PARTS, straight: true, faceNormals: [[0, 0, 1], [0, 0, -1]] });
    expect(s.values.distance).toBe(5);
  });
  test("coplanar faces on the same point are still no span", () =>
    expect(spanSpec([0, 0, 0], [0.001, 0, 0.003], { axes: PARTS, straight: false, faceNormals: [[0, 0, 1], [0, 0, 1]] })).toBeNull());
  test("values are q2-rounded", () => {
    expect(spanSpec([0, 0, 0], [12.3456, 0, 0], { axes: PARTS, straight: false, faceNormals: [null, null] }).values.distance).toBe(12.35);
  });
});

describe("spanSpec does not share mutable frame arrays", () => {
  test("mutating one span's axis/axes leaves the next span intact", () => {
    const first = spanSpec([0, 0, 0], [30, 4, 1]);
    first.anchors.axis[0] = 99;
    first.anchors.axes[1][1] = 99;
    first.anchors.axes.push([7, 7, 7]);
    const next = spanSpec([0, 0, 0], [30, 4, 1]);
    expect(next.anchors.axis).toEqual([1, 0, 0]);
    expect(next.anchors.axes).toEqual(PARTS);
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
