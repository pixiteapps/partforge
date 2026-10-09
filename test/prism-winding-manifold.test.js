// A prism's outline winding must not matter on the mesh kernel. Under
// Manifold's default Positive fill rule a CLOCKWISE outline filled nothing:
// the extrude came back InvalidConstruction, and the next union or cut was
// refused by the boolean result gate as an "impossible result" (0 mm³), with
// coaching about tangent contacts that were not there. In partforge cloud that
// was 118 failed builds in two weeks. `extrude` and the OCCT prism were always
// winding-agnostic; the OCCT half is pinned in prism-winding-occt.test.js.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const CCW = [[0, 0], [10, 0], [0, 10]];
const CW = [...CCW].reverse();

test("a clockwise prism outline builds the same solid as the counter-clockwise one", () => {
  expect(k.prism({ points: CW, h: 10 }).volume()).toBeCloseTo(500, 6);
  expect(k.prism({ points: CW, h: 10 }).volume()).toBeCloseTo(k.prism({ points: CCW, h: 10 }).volume(), 6);
  expect(k.prism({ points: CW, h: 10, twist: 30, scaleTop: 0.5 }).volume())
    .toBeCloseTo(k.prism({ points: CCW, h: 10, twist: 30, scaleTop: 0.5 }).volume(), 6);
});

test("a clockwise prism unions and cuts like any other solid (no gate refusal)", () => {
  const box = k.box({ size: [20, 20, 5] });
  expect(box.union(k.prism({ points: CW, h: 10 })).volume()).toBeCloseTo(2000 + 250, 6);
  expect(box.cut(k.prism({ points: CW, h: 10 })).volume()).toBeCloseTo(2000 - 250, 6);
});

test("a prism or extrude whose outline encloses no area throws at the op", () => {
  const flat = [[0, 0], [5, 0], [10, 0]];
  expect(() => k.prism({ points: flat, h: 5 })).toThrow(/prism: the profile encloses no area/);
  expect(() => k.extrude({ profile: flat, h: 5 })).toThrow(/extrude: the profile encloses no area/);
});

test("a boolean on an operand that built nothing names the operand, not an impossible result", () => {
  const nothing = k.cylinder({ r: 0, h: 1 });
  expect(() => k.box({ size: [1, 1, 1] }).union(nothing))
    .toThrow(/union: operand 1 is not a valid solid \(Manifold status \w+\)/);
  expect(() => k.box({ size: [1, 1, 1] }).cut(nothing)).toThrow(/cut: operand 1 is not a valid solid/);
});
