// organicExportParts: which sub-parts of an export are organic (their build calls
// k.implicit), found with the geometry-free probe — the ones a STEP export meshes on
// Manifold instead of building on OCCT.
import { expect, test } from "vitest";
import { organicExportParts } from "../src/framework/backend-select.js";

const SPHERE = { root: { kind: "sphere", r: 5 } };
const part = (parts) => ({
  meta: { title: "T" }, defaults: { r: 5 },
  parts,
  views: { all: { label: "All" }, plain: { label: "Plain" } },
});

test("names the sub-parts that call k.implicit, among the export's sub-parts", () => {
  const p = part({
    grip: { views: ["all"], build: (k) => k.implicit(SPHERE) },
    plate: { views: ["all", "plain"], build: (k) => k.box({ size: [10, 10, 2] }) },
    blob: { views: ["all"], build: (k) => k.box({ size: [4, 4, 4] }).union(k.implicit(SPHERE)) },
  });
  expect(organicExportParts(p, { view: "all", params: {} })).toEqual(["grip", "blob"]);
  expect(organicExportParts(p, { view: "plain", params: {} })).toEqual([]);
  expect(organicExportParts(p, { view: "all", params: {}, parts: ["plate", "grip"] })).toEqual(["grip"]);
});

test("the probe runs with the export's params", () => {
  const p = part({ maybe: { views: ["all"], build: (k, q) => (q.r > 4 ? k.implicit(SPHERE) : k.box({ size: [1, 1, 1] })) } });
  expect(organicExportParts(p, { view: "all", params: {} })).toEqual(["maybe"]);
  expect(organicExportParts(p, { view: "all", params: { r: 1 } })).toEqual([]);
});

test("a sub-part that is organic and shelled fails, naming it and suggesting onion", () => {
  const p = part({ cup: { views: ["all"], build: (k) => k.implicit(SPHERE).union(k.box({ size: [4, 4, 4] }).shell({ thickness: 1 })) } });
  expect(() => organicExportParts(p, { view: "all", params: {} })).toThrow(/"cup".*k\.implicit.*shell.*onion/s);
});
