// test/sheet-part-views-map.test.js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { sheetPart } from "../src/framework/sheet/part.js";
import { buildPosed, resolveParams, viewSubParts } from "../src/framework/part-model.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const spec = { material: "birch plywood", thickness: 3, profile: (kk) => kk.shape2d([[0, 0], [40, 0], [40, 20], [0, 20]]),
  pose: { face: "-Y", up: "+Z", at: [0, 0, 0] } };

const partWith = (views) => ({
  meta: { title: "S" }, defaults: {}, views: { box: { label: "Box" } },
  parts: { panel: sheetPart({ ...spec, views }) },
});

test("a sheet part takes a views map and poses exactly like the array form", () => {
  const mapPart = partWith({ box: true });
  const arrPart = partWith(["box"]);
  expect(viewSubParts(mapPart, "box", {})).toEqual(["panel"]);
  for (const purpose of ["display", "export"]) {
    const a = buildPosed(k, mapPart, "panel", { purpose, view: "box", ...resolveParams(mapPart, {}) }).boundingBox();
    const b = buildPosed(k, arrPart, "panel", { purpose, view: "box", ...resolveParams(arrPart, {}) }).boundingBox();
    for (const key of ["min", "max"]) for (let i = 0; i < 3; i++) expect(a[key][i]).toBeCloseTo(b[key][i], 6);
  }
});
