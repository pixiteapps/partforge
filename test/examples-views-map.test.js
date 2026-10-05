// test/examples-views-map.test.js — the parts the docs teach from use the views map.
import { expect, test } from "vitest";
import hingedBox from "../src/parts/hinged-box.js";
import laserBox from "../src/parts/laser-box.js";
import latticeBox from "../src/parts/lattice-box.js";
import mixedSmoke from "../src/parts/mixed-smoke.js";
import { lintPart } from "../src/framework/lint/index.js";
import { isSheetPart } from "../src/framework/sheet/constants.js";

for (const [name, part] of Object.entries({ hingedBox, laserBox, latticeBox, mixedSmoke })) {
  test(`${name} writes every sub-part as a views map with no author place`, () => {
    for (const [sub, sp] of Object.entries(part.parts)) {
      expect(Array.isArray(sp.views), `${name}.${sub}`).toBe(false);
      const generated = isSheetPart(sp) && sp.place === sp.sheet.generatedPlace && sp.sheet.place == null;
      expect(sp.place === undefined || generated, `${name}.${sub} place`).toBe(true);
    }
  });
  test(`${name} lints clean`, () => {
    expect(lintPart(part).errors).toEqual([]);
  });
}
