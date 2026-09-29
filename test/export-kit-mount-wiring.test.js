// The runtime's two export lists (contract §5.8): exportable rows — a sheet part's row
// carrying its stock — and the format list, plus the handle's default for a
// makeHandle caller that wires no export. mount() itself needs DOM + workers; its real
// wiring is covered in test/framework/mount.test.js.
import { expect, test } from "vitest";
import { exportableRows, exportFormatList } from "../src/framework/export-rows.js";
import { EXPORT_FORMATS } from "../src/framework/export/formats.js";
import { makeHandle } from "../src/framework/mount.js";
import { sheetPart } from "../src/framework/geometry/polygon.js";

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const makePart = (overrides = {}) => ({
  meta: { title: "Rows" },
  defaults: { t: 3, lid: 1 },
  derive: (p) => ({ inner: p.t * 2 }),
  views: { all: { label: "All" } },
  parts: {
    base: { label: "Base", views: ["all"], build: (k) => k.box({ size: [10, 10, 2] }) },
    panel: sheetPart({ label: "Panel", views: ["all"], material: "Birch Plywood", thickness: (p) => p.t,
      profile: (k) => k.shape2d(rect(40, 20)) }),
    lid: sheetPart({ label: "Lid", views: ["all"], enabled: (p) => p.lid > 0, material: "acrylic",
      thickness: (p, d) => d.inner / 2, profile: (k) => k.shape2d(rect(40, 20)) }),
    ghost: { label: "Ghost", views: ["all"], exportable: false, build: (k) => k.box({ size: [1, 1, 1] }) },
  },
  ...overrides,
});

test("a sheet part's row carries its stock; a printed part's row has no sheet key", () => {
  const part = makePart();
  expect(exportableRows(part, { ...part.defaults })).toStrictEqual([
    { name: "base", label: "Base" },
    { name: "panel", label: "Panel", sheet: { process: "laser", material: "Birch Plywood", thickness: 3, group: "birch plywood|3.00" } },
    { name: "lid", label: "Lid", sheet: { process: "laser", material: "acrylic", thickness: 3, group: "acrylic|3.00" } },
  ]);
});

test("rows follow enabled() and exportable:false exactly as before", () => {
  const part = makePart();
  expect(exportableRows(part, { ...part.defaults, lid: 0 }).map((r) => r.name)).toEqual(["base", "panel"]);
});

test("a sheet part whose thickness throws keeps its row and loses only the tag", () => {
  const part = makePart();
  part.parts.panel = sheetPart({ label: "Panel", views: ["all"], material: "ply",
    thickness: () => { throw new Error("no thickness"); }, profile: (k) => k.shape2d(rect(40, 20)) });
  const panel = exportableRows(part, { ...part.defaults }).find((r) => r.name === "panel");
  expect(panel).toStrictEqual({ name: "panel", label: "Panel" });
});

test("a derive() that throws drops every tag — no stock group is trustworthy then", () => {
  const part = makePart({ derive: () => { throw new Error("bad derive"); } });
  expect(exportableRows(part, { ...part.defaults }).every((r) => !("sheet" in r))).toBe(true);
});

test("the format list is a fresh copy of EXPORT_FORMATS on every call", () => {
  const list = exportFormatList();
  expect(list).toEqual(EXPORT_FORMATS.map((f) => ({ ...f })));
  expect(list.map((f) => f.id)).toEqual(["stl", "step", "3mf", "bundle"]);
  list[0].label = "edited";
  expect(exportFormatList()[0].label).toBe("STL");
});

test("makeHandle lists no formats unless the mount wires them", () => {
  const base = { ready: Promise.resolve(), dispose() {}, viewer: {}, setParams() {} };
  expect(makeHandle(base).listExportFormats()).toEqual([]);
  expect(makeHandle({ ...base, listExportFormats: exportFormatList }).listExportFormats().map((f) => f.id))
    .toEqual(["stl", "step", "3mf", "bundle"]);
});
