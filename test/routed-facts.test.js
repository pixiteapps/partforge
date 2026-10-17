import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { routedPart } from "../src/framework/sheet/routed.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { ROUTER } from "../src/framework/process/cnc-router/descriptor.js";
import { SUBPART_METRICS } from "../src/framework/verify-metrics.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const RECT = [[0, 0], [100, 0], [100, 60], [0, 60]];
const facts = (over) => ROUTER.facts(resolveSheet(k, routedPart({ views: ["main"], label: "Plinth", material: "walnut", thickness: 18,
  profile: (kk) => kk.shape2d(RECT), ...over }), {}, {}));

describe("facts", () => {
  test("the stock and profile facts, in the laser facts' shape, evaluated", () => {
    const f = facts({});
    expect(f).toMatchObject({ process: "cnc-router", material: "walnut", thickness: 18, group: "walnut|18.00", flat: [100, 60], area: 6000, pieces: 1, customBuild: false, evaluated: true });
    expect(f.at2d).toEqual({ bridge: null, gap: null, marks: null, outside: null });
    expect(f.readErrors).toEqual({ bridge: null, gap: null, marks: null, marksArea: null });
    expect(f.routed).toEqual({ profile: { w: 100, h: 60 }, pockets: [], drills: [], extra: [], outside: 0, empty: 0, breakthrough: 0 });
  });

  test("the operations table: pockets per entry, drills grouped by (d, depth, through), extras with max depth", () => {
    const f = facts({
      pockets: () => [{ region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 11.43, label: "vault" }],
      drills: () => [{ at: [50, 30], d: 3.4, depth: 10 }, { at: [60, 30], d: 3.4, depth: 10 }, { at: [70, 30], d: 6, depth: 18, label: "bolt" }],
      extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([65, 25, 13]), footprint: [[60, 20], [70, 20], [70, 30], [60, 30]], label: "notch", method: "chisel" }],
    });
    expect(f.routed.pockets).toEqual([{ label: "vault", depth: 11.43, w: 30, h: 20, area: 600, face: "near" }]);
    expect(f.routed.drills).toEqual([
      { label: null, d: 3.4, depth: 10, through: false, count: 2, face: "near" },
      { label: "bolt", d: 6, depth: 18, through: true, count: 1, face: "near" },
    ]);
    expect(f.routed.extra).toEqual([{ label: "notch", method: "chisel", w: 10, h: 10, maxDepth: 5, face: "near" }]);
    expect(f.routed.outside).toBe(0);
  });

  test("outside counts regions that leave the profile, with a 2-D location", () => {
    const f = facts({ pockets: () => [{ region: [[90, 50], [110, 50], [110, 70], [90, 70]], depth: 3 }], drills: () => [{ at: [100, 0], d: 4, depth: 3 }] });
    expect(f.routed.outside).toBe(2);
    expect(f.at2d.outside).not.toBeNull();
  });

  test("an empty pocket counts, never throws", () => {
    const f = facts({ pockets: (kk) => [{ region: kk.shape2d([[10, 10], [20, 10], [20, 20], [10, 20]]).cut([[0, 0], [30, 0], [30, 30], [0, 30]]), depth: 3 }] });
    expect(f.routed.empty).toBe(1);
    expect(f.routed.pockets).toEqual([]);
  });
});

describe("empty extra ops", () => {
  const EMPTY = (kk) => kk.shape2d([[10, 10], [20, 10], [20, 20], [10, 20]]).cut([[0, 0], [30, 0], [30, 30], [0, 30]]);
  test("an extra whose footprint is empty is counted under empty, never a row, never a throw", () => {
    const f = facts({ extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([65, 25, 13]), footprint: EMPTY(kk), label: "notch", method: "chisel" }] });
    expect(f.routed.empty).toBe(1);
    expect(f.routed.extra).toEqual([]);
  });
  test("an extra whose solid is empty reaches no depth", () => {
    const f = facts({ extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).cut(kk.box({ size: [20, 20, 20] }).translate([-5, -5, -5])), footprint: [[60, 20], [70, 20], [70, 30], [60, 30]], label: "notch", method: "chisel" }] });
    expect(f.routed.extra).toEqual([{ label: "notch", method: "chisel", w: 10, h: 10, maxDepth: 0, face: "near" }]);
  });
  test("measure() reads a routed part with an empty extra footprint", () => {
    const part = {
      meta: { title: "Plinth" }, defaults: {}, views: { main: { label: "Main" } },
      parts: { plinth: routedPart({ views: ["main"], label: "Plinth", material: "walnut", thickness: 18, profile: (kk) => kk.shape2d(RECT),
        extra: (kk) => [{ solid: kk.box({ size: [10, 10, 10] }).translate([65, 25, 13]), footprint: EMPTY(kk), label: "notch", method: "chisel" }] }) },
    };
    const row = measure(k, part, "main").subparts.find((s) => s.name === "plinth");
    expect(row.sheet.routed.empty).toBe(1);
    expect(row.sheet.routed.extra).toEqual([]);
  });
});

describe("checks and metrics", () => {
  test("four volunteered checks, all warnings carrying the routed doc id", () => {
    expect(ROUTER.checks(facts({}))).toEqual({ routedOutside: "0", routedEmpty: "0", routedPieces: "1", routedBreakthrough: "0" });
    for (const m of ["routedOutside", "routedEmpty", "routedPieces", "routedBreakthrough"]) {
      expect(SUBPART_METRICS[m].kind).toBe("warn");
      expect(SUBPART_METRICS[m].doc).toBe("routed-parts");
      expect(typeof SUBPART_METRICS[m].hint).toBe("string");
    }
    const s = { sheet: facts({ pockets: () => [{ region: [[90, 50], [110, 50], [110, 70], [90, 70]], depth: 3 }] }) };
    expect(SUBPART_METRICS.routedOutside.extract(s)).toBe(1);
    expect(SUBPART_METRICS.routedPieces.extract(s)).toBe(1);
    expect(SUBPART_METRICS.routedEmpty.extract(s)).toBe(0);
  });
});

test("measure() stamps the routed row with sheet.routed and verify volunteers the four checks", () => {
  const part = {
    meta: { title: "Plinth" }, defaults: { t: 18 }, views: { main: { label: "Main" } },
    parts: { plinth: routedPart({ views: ["main"], label: "Plinth", material: "walnut", thickness: (p) => p.t,
      profile: (kk) => kk.shape2d(RECT), drills: () => [{ at: [50, 30], d: 3.4, depth: 10 }] }) },
  };
  const report = measure(k, part, "main");
  const row = report.subparts.find((s) => s.name === "plinth");
  expect(row.sheet.process).toBe("cnc-router");
  expect(row.sheet.routed.drills).toEqual([{ label: null, d: 3.4, depth: 10, through: false, count: 1, face: "near" }]);
  const v = verify(k, part);
  const volunteered = v.cases.flatMap((c) => c.checks).filter((c) => c.volunteered).map((c) => c.metric).sort();
  expect(volunteered).toEqual(["routedBreakthrough", "routedEmpty", "routedOutside", "routedPieces"]);
});

test("a pocket outside the profile: measure lifts its spot to 3-D and verify's volunteered routedOutside carries a location", () => {
  const part = {
    meta: { title: "Plinth" }, defaults: {}, views: { main: { label: "Main" } },
    parts: { plinth: routedPart({ views: ["main"], label: "Plinth", material: "walnut", thickness: 18, profile: (kk) => kk.shape2d(RECT),
      pockets: () => [{ region: [[90, 50], [110, 50], [110, 70], [90, 70]], depth: 3 }] }) },
  };
  const row = measure(k, part, "main").subparts.find((s) => s.name === "plinth");
  expect(row.sheet.at.outside).toHaveLength(3);
  const v = verify(k, part);
  const check = v.cases.flatMap((c) => c.checks).find((c) => c.metric === "routedOutside");
  expect(check.pass).toBe(false);
  expect(check.location).not.toBeNull();
  expect(check.location).toHaveLength(3);
});

describe("face", () => {
  test("rows carry face; drills group by face too; a far extra's maxDepth is its reach above z = 0", () => {
    const f = facts({
      pockets: () => [{ region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 3 }, { region: [[10, 10], [40, 10], [40, 30], [10, 30]], depth: 4, face: "far", label: "recess" }],
      drills: () => [{ at: [50, 30], d: 3.4, depth: 10 }, { at: [60, 30], d: 3.4, depth: 10, face: "far" }],
      extra: (kk) => [{ solid: kk.box({ size: [10, 10, 6] }).translate([65, 25, 0]), footprint: [[60, 20], [70, 20], [70, 30], [60, 30]], label: "scoop", method: "core box", face: "far" }],
    });
    expect(f.routed.pockets.map((r) => [r.label, r.depth, r.face])).toEqual([[null, 3, "near"], ["recess", 4, "far"]]);
    expect(f.routed.drills).toEqual([
      { label: null, d: 3.4, depth: 10, through: false, count: 1, face: "near" },
      { label: null, d: 3.4, depth: 10, through: false, count: 1, face: "far" },
    ]);
    expect(f.routed.extra[0]).toMatchObject({ label: "scoop", face: "far", maxDepth: 6 });
    expect(f.routed.breakthrough).toBe(0);
  });
  test("breakthrough: overlapping near and far pockets deeper than the stock together, never an exact window", () => {
    const R = [[10, 10], [40, 10], [40, 30], [10, 30]];
    const over = facts({ pockets: () => [{ region: R, depth: 10 }, { region: R, depth: 9, face: "far" }] });
    expect(over.routed.breakthrough).toBe(1);
    const window = facts({ pockets: () => [{ region: R, depth: 10 }, { region: R, depth: 8, face: "far" }] });
    expect(window.routed.breakthrough).toBe(0);
    const apart = facts({ pockets: () => [{ region: R, depth: 10 }, { region: [[50, 10], [80, 10], [80, 30], [50, 30]], depth: 9, face: "far" }] });
    expect(apart.routed.breakthrough).toBe(0);
    expect(ROUTER.checks()).toMatchObject({ routedBreakthrough: "0" });
    expect(ROUTER.metrics.routedBreakthrough).toMatchObject({ kind: "warn", doc: "routed-parts" });
    expect(SUBPART_METRICS.routedBreakthrough.extract({ sheet: over })).toBe(1);
  });
});
