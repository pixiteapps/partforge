import { expect, test } from "vitest";
import { groupInteractingRegions } from "../src/framework/geometry/region-interaction.js";

const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const R = (outer, holes = []) => ({ outer, holes });
const sizes = (g) => g.map((x) => x.length);

test("disjoint, island-in-hole and bbox-overlapping-but-apart regions stay separate", () => {
  const plate = R(sq(0, 0, 20), [sq(2, 2, 10)]);
  const island = R(sq(5, 5, 2));
  const far = R(sq(30, 0, 4));
  const L = R([[0, 22], [6, 22], [0, 28]]);          // bbox overlaps `plate`'s column? no: apart in y
  expect(sizes(groupInteractingRegions([plate, island, far, L], 8))).toEqual([1, 1, 1, 1]);
});

test("overlap, containment in material, and edge contact group together", () => {
  const a = R(sq(0, 0, 10));
  expect(sizes(groupInteractingRegions([a, R(sq(5, 5, 10))], 8))).toEqual([2]);
  expect(sizes(groupInteractingRegions([a, R(sq(2, 2, 3))], 8))).toEqual([2]);
  expect(sizes(groupInteractingRegions([a, R(sq(10, 0, 10)), R(sq(50, 50, 1))], 8))).toEqual([2, 1]);
});
