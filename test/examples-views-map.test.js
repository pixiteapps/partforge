// test/examples-views-map.test.js — the parts the docs teach from use the views map.
import { beforeAll, expect, test } from "vitest";
import hingedBox from "../src/parts/hinged-box.js";
import laserBox from "../src/parts/laser-box.js";
import latticeBox from "../src/parts/lattice-box.js";
import mixedSmoke from "../src/parts/mixed-smoke.js";
import { lintPart } from "../src/framework/lint/index.js";
import { isSheetPart } from "../src/framework/sheet/constants.js";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";

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

// hinged-box.js is the docs' worked example of a moving fit: a rotary handle on the lid,
// `collisions: {}`, and both pose params swept at clearance 0 and gated. The closed lid
// rests on the base along the hinge line: allowed at clearance 0, never a contact.
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("hinged-box declares its motion: no motion-unswept, a rotary handle, collisions", () => {
  expect(lintPart(hingedBox).warnings.map((w) => w.rule)).not.toContain("motion-unswept");
  expect(hingedBox.handles.lid).toMatchObject({ drag: "rotary", params: ["lidAngle"] });
  expect(hingedBox.collisions).toEqual({});
});

test("hinged-box verifies true and both its sweeps read clear", () => {
  const v = verify(k, hingedBox);
  expect(v.ok).toBe(true);
  expect(v.unevaluated).toEqual([]);
  const rows = measure(k, hingedBox, "box").sweeps;
  expect(rows.map((r) => [r.name, r.clear])).toEqual([["lidAngle", true], ["lidLift", true]]);
  for (const r of rows) expect(r.contacts.every((c) => c.allowed === true), r.name).toBe(true);
});
