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

// k.subdiv is mesh-native like k.implicit: a STEP export meshes it on Manifold too.
const cageBody = (k) => k.subdiv(k.cage({ box: { size: [10, 10, 10] } }));

test("names the sub-parts that call k.subdiv, beside the k.implicit ones", () => {
  const p = part({
    grip: { views: ["all"], build: (k) => k.implicit(SPHERE) },
    whale: { views: ["all"], build: cageBody },
    plate: { views: ["all", "plain"], build: (k) => k.box({ size: [10, 10, 2] }) },
  });
  expect(organicExportParts(p, { view: "all", params: {} })).toEqual(["grip", "whale"]);
  expect(organicExportParts(p, { view: "all", params: {}, parts: ["whale"] })).toEqual(["whale"]);
});

test("a sub-part that is subdivided and shelled fails, naming k.subdiv and a boolean hollow", () => {
  const p = part({ cup: { views: ["all"], build: (k) => cageBody(k).union(k.box({ size: [4, 4, 4] }).shell({ thickness: 1 })) } });
  let err;
  try { organicExportParts(p, { view: "all", params: {} }); } catch (e) { err = e; }
  expect(err?.message).toMatch(/"cup" calls k\.subdiv and shell, which no backend can build together/);
  expect(err.message).toMatch(/subtract a smaller body/);
  expect(err.message).not.toMatch(/implicit|onion/);
});

test("a sub-part that calls both mesh-native ops and shell names both", () => {
  const p = part({ cup: { views: ["all"], build: (k) => cageBody(k).union(k.implicit(SPHERE)).union(k.box({ size: [4, 4, 4] }).shell({ thickness: 1 })) } });
  expect(() => organicExportParts(p, { view: "all", params: {} })).toThrow(/"cup" calls k\.implicit, k\.subdiv and shell.*onion.*subtract a smaller body/s);
});

test("the k.implicit-only shell message is unchanged", () => {
  const p = part({ cup: { views: ["all"], build: (k) => k.implicit(SPHERE).union(k.box({ size: [4, 4, 4] }).shell({ thickness: 1 })) } });
  expect(() => organicExportParts(p, { view: "all", params: {} })).toThrow(
    'sub-part "cup" calls k.implicit and shell, which no backend can build together — for a hollow organic body use an onion node inside the k.implicit spec instead of shell');
});
