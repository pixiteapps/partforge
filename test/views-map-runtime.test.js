import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { viewSubParts, buildPosed, resolveParams } from "../src/framework/part-model.js";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { subPartReadKeys } from "../src/framework/param-deps.js";
import { resolveDefaultView } from "../src/framework/default-view.js";
import { printFrameMatrix, displayToPrintMatrix } from "../src/framework/materials/print-frame.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const plate = (kk, p) => kk.box({ min: [0, 0, 0], max: [p.w, p.d, 2] });
const hinge = (s, p) => s.translate([0, 0, p.h]).rotate(-p.angle, [0, p.d, p.h], [1, 0, 0]);
const views = { assembly: { label: "Assembly" }, lid: { label: "Lid" }, print: { label: "Print" } };
const defaults = { w: 30, d: 20, h: 15, angle: 30 };

// The same lid, written both ways.
const mapPart = {
  meta: { title: "M" }, defaults, views,
  parts: {
    lid: { build: plate, views: { assembly: (s, p) => hinge(s, p), lid: true, print: (s, p) => s.translate([p.w + 10, 0, 0]) } },
  },
};
const legacyPart = {
  meta: { title: "L" }, defaults, views,
  parts: {
    lid: {
      build: plate, views: ["assembly", "lid", "print"],
      place: (s, { purpose, view, p }) => (purpose === "export" ? s
        : view === "print" ? s.translate([p.w + 10, 0, 0])
        : view === "assembly" ? hinge(s, p) : s),
    },
  },
};

const bboxOf = (part, purpose, view) => {
  const { p, d } = resolveParams(part, {});
  return buildPosed(k, part, "lid", { purpose, view, p, d }).boundingBox();
};

test("a map-form piece poses exactly like its legacy twin, per view and purpose", () => {
  for (const view of ["assembly", "lid", "print"]) {
    for (const purpose of ["display", "export"]) {
      const a = bboxOf(mapPart, purpose, view), b = bboxOf(legacyPart, purpose, view);
      for (const key of ["min", "max"]) for (let i = 0; i < 3; i++) expect(a[key][i]).toBeCloseTo(b[key][i], 6);
    }
  }
});

test("viewSubParts reads map keys, and an invalid entry leaves the piece out", () => {
  expect(viewSubParts(mapPart, "print", defaults)).toEqual(["lid"]);
  const hidden = { ...mapPart, parts: { lid: { ...mapPart.parts.lid, views: { assembly: true, lid: false } } } };
  expect(viewSubParts(hidden, "lid", defaults)).toEqual([]);
  expect(viewSubParts(hidden, "assembly", defaults)).toEqual(["lid"]);
});

test("one part may mix forms: each sub-part keeps its own", () => {
  const mixed = { ...mapPart, parts: { lid: mapPart.parts.lid, base: { build: plate, views: ["assembly"] } } };
  expect(viewSubParts(mixed, "assembly", defaults)).toEqual(["lid", "base"]);
  expect(viewSubParts(mixed, "lid", defaults)).toEqual(["lid"]);
});

test("the place probe reads a map entry as a rigid pose, and export as canonical", () => {
  const { p, d } = resolveParams(mapPart, {});
  const sp = mapPart.parts.lid;
  const disp = probeSubPartPose(sp, { view: "assembly", purpose: "display", p, d }, { scope: "place" });
  expect(disp.trusted).toBe(true);
  expect(disp.pose.length).toBeGreaterThan(0);
  const exp = probeSubPartPose(sp, { view: "assembly", purpose: "export", p, d }, { scope: "place" });
  expect(exp.trusted).toBe(true);
  expect(exp.pose).toEqual([]);
});

test("a param read only by a pose entry is a read of that view", () => {
  const reads = subPartReadKeys(mapPart, "assembly", defaults);
  expect([...reads.get("lid")]).toContain("angle");
  expect([...subPartReadKeys(mapPart, "lid", defaults).get("lid")]).not.toContain("angle");
});

test("the default view counts map-form pieces", () => {
  const part = {
    meta: { title: "D" }, defaults: {}, views: { lid: { label: "Lid" }, assembly: { label: "Assembly" } },
    parts: {
      lid: { build: (kk) => kk.box({ size: [1, 1, 1] }), views: { lid: true, assembly: true } },
      base: { build: (kk) => kk.box({ size: [1, 1, 1] }), views: { assembly: true } },
    },
  };
  expect(resolveDefaultView(part)).toBe("assembly");
});

test("a map-form canonical delivery's print frame is identity, and display→print undoes the entry", () => {
  const { p, d } = resolveParams(mapPart, {});
  const sp = mapPart.parts.lid;
  expect(printFrameMatrix(sp, { view: "assembly", p, d, frame: "canonical" })).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  expect(displayToPrintMatrix(sp, { view: "lid", p, d })).toBeNull();
  expect(displayToPrintMatrix(sp, { view: "print", p, d })).not.toBeNull();
});

test("a pose entry that throws fails the build with its own message", () => {
  const bad = { ...mapPart, parts: { lid: { build: plate, views: { assembly: () => { throw new Error("pose broke"); } } } } };
  const { p, d } = resolveParams(bad, {});
  expect(() => buildPosed(k, bad, "lid", { purpose: "display", view: "assembly", p, d })).toThrow("pose broke");
});
