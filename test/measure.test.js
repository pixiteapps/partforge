import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/framework/oracle/measure.js";
import { buildView } from "../src/framework/oracle/build.js";
import gapPart from "./fixtures/gap-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const boxPart = {
  meta: { title: "Box", units: "mm" },
  defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 20, 5] }) } },
  views: { v: { label: "V" } },
};
const tubePart = {
  meta: { title: "Tube", units: "mm" },
  defaults: {},
  parts: { tube: { views: ["v"], build: (kk) => kk.cylinder({ r: 10, h: 20 }).cut(kk.cylinder({ r: 4, h: 30 }).translate([0, 0, -5])) } },
  views: { v: { label: "V" } },
};

test("measure reports box facts: genus 0, watertight, volume ~1000, bbox ~[10,20,5]", () => {
  const r = measure(k, boxPart, "v");
  expect(r.subparts).toHaveLength(1);
  const s = r.subparts[0];
  expect(s.holes).toBe(0);
  expect(s.watertight).toBe(true);
  expect(s.volume).toBeCloseTo(1000, 0);
  expect(s.bbox[0]).toBeCloseTo(10, 1);
  expect(s.bbox[1]).toBeCloseTo(20, 1);
  expect(s.bbox[2]).toBeCloseTo(5, 1);
  expect(s.surfaceArea).toBeGreaterThan(0);
  expect(s.triangleCount).toBeGreaterThan(0);
  expect(r.overlaps).toEqual([]);
  expect(r.ok).toBe(true);
});

test("measure reports a through-bore tube as genus 1", () => {
  expect(measure(k, tubePart, "v").subparts[0].holes).toBe(1);
});

test("measure aggregate volume equals the single sub-part volume", () => {
  const r = measure(k, boxPart, "v");
  expect(r.aggregate.volume).toBeCloseTo(r.subparts[0].volume, 5);
});

test("measure defaults to the first declared view", () => {
  expect(measure(k, boxPart).view).toBe("v");
});

test("minWall is null unless opts.minWall is set, then it is the measured thickness", () => {
  expect(measure(k, boxPart, "v").subparts[0].minWall).toBe(null);                 // off by default
  const w = measure(k, boxPart, "v", {}, { minWall: true }).subparts[0].minWall;   // boxPart is 10x20x5
  expect(w).toBeCloseTo(5, 1);                                                      // thinnest dimension
});

test("min-wall facts carry the sample accounting, so a report can tell exact from sampled", () => {
  const s = measure(k, boxPart, "v", {}, { minWall: true }).subparts[0];
  expect(s.minWallSampled).toBe(false);
  expect(s.minWallSamples.total).toBe(s.triangleCount);
  expect(s.minWallSamples.sampled).toBe(s.triangleCount);
  const off = measure(k, boxPart, "v").subparts[0];                 // measurement not requested
  expect(off.minWallSampled).toBe(false);
  expect(off.minWallSamples).toBe(null);
});

test("measure reports the near-miss pair with distance and location", () => {
  const r = measure(k, gapPart, "v");                     // gap 0.2
  expect(r.nearMisses).toHaveLength(1);
  expect(r.nearMisses[0]).toMatchObject({ a: "left", b: "right" });
  expect(r.nearMisses[0].distance).toBeCloseTo(0.2, 5);
  expect(r.nearMisses[0].at[0]).toBeCloseTo(10.1, 4);
  expect(r.gaps).toHaveLength(1);                          // raw pair table
  expect(r.ok).toBe(true);                                 // near misses never gate measure.ok
});

test("separated and touching pairs produce no near-miss noise", () => {
  expect(measure(k, gapPart, "v", { gap: 5 }).nearMisses).toEqual([]);
  expect(measure(k, gapPart, "v", { gap: 0 }).nearMisses).toEqual([]);
});

test("an overlapping pair is in overlaps, not nearMisses", () => {
  const r = measure(k, gapPart, "v", { gap: -1 });
  expect(r.overlaps).toHaveLength(1);
  expect(r.nearMisses).toEqual([]);
  expect(r.ok).toBe(false);                                // the existing overlap gate
});

test("single-sub-part views report empty gaps and nearMisses", () => {
  const r = measure(k, boxPart, "v");
  expect(r.gaps).toEqual([]);
  expect(r.nearMisses).toEqual([]);
});

test("gapThreshold is configurable", () => {
  expect(measure(k, gapPart, "v", { gap: 0.7 }).nearMisses).toEqual([]);
  expect(measure(k, gapPart, "v", { gap: 0.7 }, { gapThreshold: 1 }).nearMisses).toHaveLength(1);
});

// Deliberately UNEQUAL volumes so the aggregate CoM test distinguishes a
// volume-weighted mean from a plain average of the sub-part centroids.
const twoBoxPart = {
  meta: { title: "TwoBox", units: "mm" }, defaults: {},
  parts: {
    a: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }) },        // vol 1000, com [5,5,5]
    b: { views: ["v"], build: (kk) => kk.box({ min: [30, 0, 0], max: [50, 20, 20] }) },        // vol 8000, com [40,10,10]
  },
  views: { v: { label: "V" } },
};

test("measure reports per-sub-part bounds {min,max}", () => {
  const s = measure(k, boxPart, "v").subparts[0];         // boxPart is [0,0,0]..[10,20,5]
  expect(s.bounds.min[0]).toBeCloseTo(0, 3);
  expect(s.bounds.min[1]).toBeCloseTo(0, 3);
  expect(s.bounds.min[2]).toBeCloseTo(0, 3);
  expect(s.bounds.max[0]).toBeCloseTo(10, 3);
  expect(s.bounds.max[1]).toBeCloseTo(20, 3);
  expect(s.bounds.max[2]).toBeCloseTo(5, 3);
});

test("measure reports per-sub-part centerOfMass", () => {
  const s = measure(k, boxPart, "v").subparts[0];
  expect(s.centerOfMass[0]).toBeCloseTo(5, 2);
  expect(s.centerOfMass[1]).toBeCloseTo(10, 2);
  expect(s.centerOfMass[2]).toBeCloseTo(2.5, 2);
});

test("aggregate bounds spans all sub-parts and centerOfMass is volume-weighted", () => {
  const r = measure(k, twoBoxPart, "v");
  expect(r.aggregate.bounds.min[0]).toBeCloseTo(0, 3);
  expect(r.aggregate.bounds.max[0]).toBeCloseTo(50, 3);
  // (1000·[5,5,5] + 8000·[40,10,10]) / 9000 ≈ [36.11, 9.44, 9.44] — a plain
  // average would give [22.5, 7.5, 7.5], so this catches a dropped volume weight.
  expect(r.aggregate.centerOfMass[0]).toBeCloseTo(36.11, 1);
  expect(r.aggregate.centerOfMass[1]).toBeCloseTo(9.44, 1);
  expect(r.aggregate.centerOfMass[2]).toBeCloseTo(9.44, 1);
});

// `opts.built` — the inspect job builds the view once and shares it with both the
// measurement and the silhouette rasterizer, so measure must consume a build rather
// than always making its own. The seam is worth pinning in both directions: the
// facts read off a supplied build must match a self-built run exactly, and a
// supplied build must actually be the one measured.
test("measure accepts a pre-built view and reads the same facts from it", () => {
  const built = buildView(k, boxPart, "v");
  const supplied = measure(k, boxPart, "v", {}, { built });
  const own = measure(k, boxPart, "v");
  expect(supplied.subparts.map((s) => s.name)).toEqual(own.subparts.map((s) => s.name));
  expect(supplied.subparts[0].volume).toBeCloseTo(own.subparts[0].volume, 6);
  expect(supplied.aggregate.bbox).toEqual(own.aggregate.bbox);
});

test("a supplied build is what gets measured, not a rebuild of the part", () => {
  // A build of the TUBE handed in against the BOX part: the reported sub-part is the
  // tube's, which a rebuild-anyway implementation could not produce.
  const built = buildView(k, tubePart, "v");
  const r = measure(k, boxPart, "v", {}, { built });
  expect(r.subparts.map((s) => s.name)).toEqual(["tube"]);
});

// `probes` — part-declared measurements (docs/superpowers/plans/2026-08-23-part-probes.md).
// A probe is a pure (k, p, d) function like build, but its result lands in the
// measure REPORT instead of the scene: a Solid anywhere in the return value is
// replaced by a fact object, plain JSON passes through, a throw becomes { error }.
const body = (kk, p) => kk.box({ min: [0, 0, 0], max: [p.w, 20, 5] });
const probedPart = {
  meta: { title: "Probed", units: "mm" },
  defaults: { w: 10 },
  parts: { block: { views: ["v", "w2"], build: body } },
  views: { v: { label: "V" }, w2: { label: "W" } },
  probes: {
    slab: (kk, p, d) => body(kk, p).intersect(kk.box({ min: [2, -5, -5], max: [3, 25, 10] })),
    numbers: (kk, p) => ({ width: p.w, halfVol: body(kk, p).volume() / 2, nested: { s: body(kk, p) } }),
    missing: (kk, p) => body(kk, p).intersect(kk.box({ min: [50, 50, 50], max: [51, 51, 51] })),
    boom: () => { throw new Error("probe exploded"); },
  },
};

test("a probe returning a Solid reports standard facts", () => {
  const r = measure(k, probedPart, "v");
  const s = r.probes.slab;
  expect(s.empty).toBe(false);
  expect(s.volume).toBeCloseTo(100, 0);        // 1 × 20 × 5 slab of the block
  expect(s.bbox[0]).toBeCloseTo(1, 1);
  expect(s.bbox[1]).toBeCloseTo(20, 1);
  expect(s.bbox[2]).toBeCloseTo(5, 1);
  expect(s.bounds.min[0]).toBeCloseTo(2, 1);
  expect(s.watertight).toBe(true);
  expect(s.holes).toBe(0);
  expect(s.triangleCount).toBeGreaterThan(0);
});

test("plain probe values pass through, with Solids replaced anywhere in the shape", () => {
  const r = measure(k, probedPart, "v");
  expect(r.probes.numbers.width).toBe(10);
  expect(r.probes.numbers.halfVol).toBeCloseTo(500, 0);
  expect(r.probes.numbers.nested.s.volume).toBeCloseTo(1000, 0);
});

test("probes see the caller's params, not just the defaults", () => {
  const r = measure(k, probedPart, "v", { w: 20 });
  expect(r.probes.numbers.width).toBe(20);
  expect(r.probes.numbers.halfVol).toBeCloseTo(1000, 0);
});

test("an empty probe result reports empty: true rather than infinite bounds", () => {
  const m = measure(k, probedPart, "v").probes.missing;
  expect(m.empty).toBe(true);
  expect(m.volume).toBe(0);
  expect(m.bbox).toBe(null);
});

test("a probe that throws reports { error } and never crashes or gates the measurement", () => {
  const r = measure(k, probedPart, "v");
  expect(r.probes.boom.error).toContain("probe exploded");
  expect(r.ok).toBe(true);
});

test("probes are part-level: every view reports them", () => {
  const r = measure(k, probedPart, "w2");
  expect(r.probes.slab.volume).toBeCloseTo(100, 0);
});

test("no probes block, no probes key; opts.probes: false skips evaluation", () => {
  expect(measure(k, boxPart, "v").probes).toBeUndefined();
  expect(measure(k, probedPart, "v", {}, { probes: false }).probes).toBeUndefined();
});

// A Shape2D anywhere in a probe's return value is summarised into arcs and corners
// (shape-probe.js). This is the numeric channel for "are these two arcs concentric?" —
// partforge-cloud feedback #95 was fifteen edits of eyeballing renders for exactly that.
const shapeProbed = {
  meta: { title: "Shaped", units: "mm" },
  defaults: { r: 2 },
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 5] }) } },
  views: { v: { label: "V" } },
  probes: {
    outline: (kk, p) => kk.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(p.r),
    mixed: (kk, p) => ({ shape: kk.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(p.r), solid: kk.box({ min: [0, 0, 0], max: [1, 1, 1] }) }),
    nothing: (kk) => kk.shape2d([[0, 0], [1, 0], [1, 1], [0, 1]]).cut(kk.shape2d([[-1, -1], [2, -1], [2, 2], [-1, 2]])),
  },
};

test("a probe returning a Shape2D reports its arcs with centre and radius", () => {
  const r = measure(k, shapeProbed, "v");
  const s = r.probes.outline;
  expect(s.kind).toBe("shape2d");
  expect(s.empty).toBe(false);
  expect(s.area).toBeCloseTo(100 - (4 - Math.PI) * 4, 2); // four r=2 corners removed
  const ring = s.regions[0].outer;
  expect(ring.arcs).toHaveLength(4);
  const centres = ring.arcs.map((a) => a.center.join(",")).sort();
  expect(centres).toEqual(["2,2", "2,8", "8,2", "8,8"]);
  for (const a of ring.arcs) expect(a.r).toBeCloseTo(2, 3);
  expect(ring.corners).toHaveLength(0); // every corner is now a smooth joint
});

test("a Shape2D nested beside a Solid is summarised in place", () => {
  const r = measure(k, shapeProbed, "v");
  expect(r.probes.mixed.shape.kind).toBe("shape2d");
  expect(r.probes.mixed.solid.volume).toBeCloseTo(1, 3);
});

test("an empty Shape2D probe reports empty, not an error", () => {
  const r = measure(k, shapeProbed, "v");
  expect(r.probes.nothing).toEqual({ kind: "shape2d", empty: true, area: 0, bbox: null, regions: [], truncated: false });
});

test("probe shape summaries follow the caller's params", () => {
  const r = measure(k, shapeProbed, "v", { r: 3 });
  for (const a of r.probes.outline.regions[0].outer.arcs) expect(a.r).toBeCloseTo(3, 3);
});
