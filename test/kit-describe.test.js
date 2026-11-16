// describeKitRows (export/kit/describe.js): the kit's sections and their parts, read on
// the main thread at the live params with no geometry built — the data a host draws its
// download dialog from before it asks for a kit.
import { expect, test } from "vitest";
import { describeKitRows } from "../src/framework/export/kit/describe.js";
import { sectionOptionSchema } from "../src/framework/export/kit/options.js";
import { laserFixture, boardFixture } from "./fixtures/kit-fixtures.js";

// The board forge (a routed plinth, a laser lid) plus one printed part.
const mixed = {
  ...boardFixture,
  parts: { ...boardFixture.parts, foot: { label: "Foot", views: ["all"], build: (kk) => kk.box({ size: [8, 8, 4] }) } },
};
const printedOnly = {
  meta: { title: "Printed" }, defaults: {}, views: { all: { label: "All" } },
  parts: { a: { label: "A", views: ["all"], build: (kk) => kk.box({ size: [1, 1, 1] }) } },
};

test("a printed + laser + routed forge gives 3d, laser and cnc-router, in that order", () => {
  const kit = describeKitRows(mixed, {});
  expect(kit.sets).toEqual({ range: [1, 20], default: 1 });
  expect(kit.sections.map((s) => [s.id, s.label]))
    .toEqual([["3d", "3D files"], ["laser", "Laser-cut parts"], ["cnc-router", "CNC-routed parts"]]);
});

test("the 3D section lists every exportable part; sheet parts are off by default", () => {
  const three = describeKitRows(mixed, {}).sections[0];
  expect(three.parts.map(({ name, default: on }) => [name, on]))
    .toEqual([["plinth", false], ["lid", false], ["foot", true]]);
  expect(three.parts[0].sheet).toEqual({ process: "cnc-router", material: "walnut", thickness: 18, group: "walnut|18.00" });
  expect(three.options).toEqual(sectionOptionSchema("3d"));
});

test("a cut section lists only its own process's parts, all on, with their stock groups", () => {
  const [, laser, router] = describeKitRows(mixed, { t: 12 }).sections;
  expect(laser.parts).toEqual([{ name: "lid", label: "Lid", default: true,
    sheet: { process: "laser", material: "birch plywood", thickness: 3, group: "birch plywood|3.00" } }]);
  expect(laser.options.stock.groups).toEqual([{ group: "birch plywood|3.00", label: "birch plywood 3 mm" }]);
  // The live params decide the stock: thickness 12, not the default 18.
  expect(router.parts.map((r) => r.name)).toEqual(["plinth"]);
  expect(router.options.stock.groups).toEqual([{ group: "walnut|12.00", label: "walnut 12 mm" }]);
  const { stock: _stock, ...rest } = router.options;
  const { stock: _schemaStock, ...schemaRest } = sectionOptionSchema("cnc-router");
  expect(rest).toEqual(schemaRest);
});

test("parts sharing a stock group list it once", () => {
  const laser = describeKitRows(laserFixture, {}).sections.find((s) => s.id === "laser");
  expect(laser.parts.map((r) => r.name)).toEqual(["left", "right", "front", "lower"]);
  expect(laser.options.stock.groups).toEqual([{ group: "birch plywood|3.00", label: "Birch Plywood 3 mm" }]);
});

test("a printed-only forge gives the 3D section alone", () => {
  const kit = describeKitRows(printedOnly, {});
  expect(kit.sections.map((s) => s.id)).toEqual(["3d"]);
  expect(kit.sections[0].parts).toEqual([{ name: "a", label: "A", default: true }]);
});

test("no geometry is built", () => {
  const trap = { ...printedOnly, parts: { a: { label: "A", views: ["all"], build: () => { throw new Error("built"); } } } };
  expect(() => describeKitRows(trap, {})).not.toThrow();
});

test("a laser part whose stock cannot be evaluated is still a laser part: listed in its cut section, unticked in 3D", () => {
  const broken = {
    ...laserFixture,
    parts: { ...laserFixture.parts, left: { ...laserFixture.parts.left, sheet: { ...laserFixture.parts.left.sheet, thickness: () => { throw new Error("no thickness"); } } } },
  };
  const kit = describeKitRows(broken, {});
  const three = kit.sections.find((s) => s.id === "3d");
  expect(three.parts.find((r) => r.name === "left")).toEqual({ name: "left", label: "Side (L)", default: false });
  const laser = kit.sections.find((s) => s.id === "laser");
  const left = laser.parts.find((r) => r.name === "left");
  expect(left).toEqual({ name: "left", label: "Side (L)", default: true });
  expect(laser.options.stock.groups).toEqual([{ group: "birch plywood|3.00", label: "Birch Plywood 3 mm" }]);
});

test("a sheet part whose process has no cut section is a 3D part: ticked in 3D, in no cut section", () => {
  const plasma = {
    ...laserFixture,
    parts: { ...laserFixture.parts, left: { ...laserFixture.parts.left, sheet: { ...laserFixture.parts.left.sheet, process: "plasma" } } },
  };
  const kit = describeKitRows(plasma, {});
  const three = kit.sections.find((s) => s.id === "3d");
  expect(three.parts.find((r) => r.name === "left").default).toBe(true);
  expect(three.parts.find((r) => r.name === "right").default).toBe(false);
  expect(kit.sections.map((s) => s.id)).toEqual(["3d", "laser"]);
  expect(kit.sections[1].parts.map((r) => r.name)).not.toContain("left");
});
