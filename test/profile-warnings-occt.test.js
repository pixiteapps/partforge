// OCCT twin of profile-warnings.test.js. OCCT and Manifold must not boot in the
// same process (AGENTS.md), so this file boots OCCT only and asserts parity
// against the shared PURE function (`profileWarningMessages`) instead of a live
// Manifold boot — both backends route through that same function by
// construction, so matching it is matching Manifold's output, and
// profile-warnings.test.js already pins the Manifold side directly.
import { beforeAll, beforeEach, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { profileWarningMessages } from "../src/framework/geometry/profile-warnings.js";

const BOW = [[0, 0], [10, 10], [10, 0], [0, 10]];
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];

let occt;
beforeAll(async () => { occt = await bootOcctKernel(); });
beforeEach(() => { occt.takeBuildWarnings(); });

test("extrude/prism/loft/shape2d warn per the shared pure function", () => {
  const run = (k) => {
    k.extrude({ profile: BOW, h: 5 });
    k.prism({ points: BOW, h: 5 });
    k.loft({ rings: [{ polygon: SQUARE, z: 0 }, { polygon: BOW, z: 10 }] });
    k.shape2d(SQUARE).union(BOW);
    return k.takeBuildWarnings();
  };
  const occtWarnings = run(occt);
  const expected = [
    ...profileWarningMessages("extrude: profile", BOW),
    ...profileWarningMessages("prism: profile", BOW),
    ...profileWarningMessages("loft: ring 1", BOW),
    ...profileWarningMessages("shape2d: profile", BOW),
  ];
  expect(occtWarnings).toHaveLength(4);
  expect(occtWarnings).toEqual(expected);
});

test("OCCT: one warning per distinct message per drain, none for a clean profile", () => {
  for (let i = 0; i < 3; i++) occt.extrude({ profile: BOW, h: 5 });
  expect(occt.takeBuildWarnings()).toHaveLength(1);
  occt.extrude({ profile: SQUARE, h: 5 });
  expect(occt.takeBuildWarnings()).toEqual([]);
});
