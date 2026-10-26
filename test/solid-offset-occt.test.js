// OCCT side of Solid.offset: one gated BRepOffsetAPI_MakeOffsetShape step
// (occt-roundall.js occtOffset). The Manifold twin is test/solid-offset.test.js;
// the two kernels never boot in one process. Where the mesh class's faceted ball
// runs a little under the exact Steiner volume, the B-rep arcs land on it.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

const box = () => k.box({ min: [0, 0, 0], max: [30, 20, 10] });
const steinerBox = (a, b, c, d) =>
  a * b * c + 2 * (a * b + b * c + c * a) * d + Math.PI * d * d * (a + b + c) + (4 / 3) * Math.PI * d ** 3;

test("offset(+2) grows a box by the exact ball offset", () => {
  const out = box().offset(2);
  // OCCT's bounding box is loose around curved faces (it pads by the surface
  // tolerance), so the bounds are checked to 0.15 mm and the volume does the work
  const bb = out.boundingBox();
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(bb.min[i] + 2)).toBeLessThan(0.15);
    expect(Math.abs(bb.max[i] - ([30, 20, 10][i] + 2))).toBeLessThan(0.15);
  }
  expect(Math.abs(out.volume() - steinerBox(30, 20, 10, 2))).toBeLessThan(0.002 * steinerBox(30, 20, 10, 2));
});

test("offset(-2) shrinks a box to the inner box", () => {
  const out = box().offset(-2);
  expect(out.volume()).toBeCloseTo(26 * 16 * 6, 0);
});

test("a sphere skin has the volume of a 2 mm shell", () => {
  const body = k.sphere(20);
  const skin = body.cut(body.offset(-2));
  const exact = (4 / 3) * Math.PI * (20 ** 3 - 18 ** 3);
  expect(Math.abs(skin.volume() - exact)).toBeLessThan(0.002 * exact);
});

test("options form and the zero identity", () => {
  expect(box().offset({ d: 2 }).volume()).toBeCloseTo(box().offset(2).volume(), 3);
  expect(box().offset(0).volume()).toBeCloseTo(6000, 3);
});

test("an offset OCCT cannot build throws offset-failed instead of returning the input", () => {
  // eroding past half the thinnest wall has no B-rep offset result
  expect(() => box().offset(-6).volume()).toThrow(/offset-failed/);
});
