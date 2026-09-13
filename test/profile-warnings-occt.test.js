// OCCT twin of profile-warnings.test.js: the warning is computed in the shared
// kernel front / Shape2D factory, so the B-rep backend must emit the IDENTICAL
// message for the identical input.
import { beforeAll, beforeEach, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";

const BOW = [[0, 0], [10, 10], [10, 0], [0, 10]];
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];

let occt, manifold;
beforeAll(async () => { occt = await bootOcctKernel(); manifold = await bootManifoldKernel(); });
beforeEach(() => { occt.takeBuildWarnings(); manifold.takeBuildWarnings(); });

test("extrude/prism/loft/shape2d warn identically on both backends", () => {
  const run = (k) => {
    k.extrude({ profile: BOW, h: 5 });
    k.prism({ points: BOW, h: 5 });
    k.loft({ rings: [{ polygon: SQUARE, z: 0 }, { polygon: BOW, z: 10 }] });
    k.shape2d(SQUARE).union(BOW);
    return k.takeBuildWarnings();
  };
  const a = run(occt), b = run(manifold);
  expect(a).toHaveLength(4);
  expect(a).toEqual(b);
});

test("OCCT: one warning per distinct message per drain, none for a clean profile", () => {
  for (let i = 0; i < 3; i++) occt.extrude({ profile: BOW, h: 5 });
  expect(occt.takeBuildWarnings()).toHaveLength(1);
  occt.extrude({ profile: SQUARE, h: 5 });
  expect(occt.takeBuildWarnings()).toEqual([]);
});
