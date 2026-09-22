import { test, expect } from "vitest";
import { profileCorners, SMOOTH_JOINT_DEG } from "../src/framework/geometry/contour-ops.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

test("a CCW square has 4 convex 90° corners", () => {
  const corners = profileCorners([[0, 0], [10, 0], [10, 10], [0, 10]]);
  expect(corners.length).toBe(4);
  for (const c of corners) {
    expect(c.interiorAngleDeg).toBeCloseTo(90, 6);
    expect(c.convex).toBe(true);
  }
  expect(corners[0].point).toEqual([0, 0]);
});

test("an L-shape has 5 convex + 1 concave corner", () => {
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const corners = profileCorners(L);
  expect(corners.filter((c) => c.convex).length).toBe(5);
  const cc = corners.find((c) => !c.convex);
  expect(cc.point).toEqual([4, 4]);
  expect(cc.interiorAngleDeg).toBeCloseTo(270, 6);
});

test("a G1 cubic-cubic joint is not a corner (SMOOTH_JOINT_DEG)", () => {
  // Two cubics meeting at (10,0) with a shared tangent direction (0,1), closed back to
  // start with a straight line so (0,10) and the closing (0,0) joint are real corners.
  const ct = pathProfile([0, 0])
    .cubicTo([10, 0], [4, 0], [10, -6])   // out-tangent at start (1,0); in-tangent at (10,0) is (10,0)-(10,-6) → (0,1)
    .cubicTo([0, 10], [10, 6], [6, 10])   // out-tangent at (10,0) is (10,6)-(10,0) → (0,1) — matches, smooth joint
    .lineTo([0, 0])
    .close();
  const corners = profileCorners(ct);
  // the (10,0) joint is smooth; the (0,10) and closing (0,0) joints are corners
  expect(corners.some((c) => c.point[0] === 10 && c.point[1] === 0)).toBe(false);
  expect(SMOOTH_JOINT_DEG).toBe(1);
});

test("hole corners report material-relative convexity", () => {
  const region = { outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [[[5, 5], [5, 15], [15, 15], [15, 5]]] };
  const holeCorners = profileCorners(region).filter((c) => typeof c.ring === "object");
  expect(holeCorners.length).toBe(4);
  // A square hole's corners are convex under the material-relative rule: the hole ring is
  // authored CW (opposite the CCW outer), so its right turns satisfy leftTurn === ringIsCCW
  // (false === false) → convex: true, matching how the surrounding material bulges inward.
  for (const c of holeCorners) expect(c.convex).toBe(true);
});

test("each corner carries `position` (its place in the returned list) beside `index` (its vertex number)", () => {
  // (5,0) is a collinear midpoint — a smooth joint, skipped — so vertex numbers and
  // list positions diverge from there on. `{indices}` takes positions.
  const corners = profileCorners([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]]);
  expect(corners.map((c) => c.index)).toEqual([0, 2, 3, 4]);
  expect(corners.map((c) => c.position)).toEqual([0, 1, 2, 3]);
});

test("`position` runs through the flattened region order while `index` restarts per ring", () => {
  const region = { outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [[[5, 5], [5, 15], [15, 15], [15, 5]]] };
  const corners = profileCorners(region);
  expect(corners.map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(corners.map((c) => c.index)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
});
