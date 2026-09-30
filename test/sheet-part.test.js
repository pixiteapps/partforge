// sheetPart: load-time errors that name the fix, an ordinary sub-part with a plain-data
// `sheet` marker, a preview build whose volume is exactly A·t − MARK_DEPTH·marks, and a
// pose that stays rigid and probe-trusted for display AND export. The OCCT half of the
// volume identity is sheet-part-occt.test.js (the two kernels never share a process).
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { buildPosed, resolveParams } from "../src/framework/part-model.js";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { lintPart } from "../src/lint.js";
import { sheetPart } from "../src/framework/sheet/part.js";
import { resolveSheet } from "../src/framework/sheet/resolve.js";
import { poseSteps } from "../src/framework/sheet/pose.js";
import { MARK_DEPTH, SCORE_WIDTH, isSheetPart } from "../src/framework/sheet/constants.js";
import { processFor } from "../src/framework/process/registry.js";
import { sheetFrameFor } from "../src/framework/materials/sheet-look.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const POSE = { face: "-Y", up: "+Z", at: [-40, 0, 0] };

// An 80 × 50 panel with a square hole, an engraved block, a score line that runs off
// both ends of the profile, and a closed square score.
const panelSpec = (extra = {}) => ({
  label: "Panel",
  views: ["main"],
  display: { material: "oak" },
  material: "birch plywood",
  thickness: (p) => p.t,
  profile: (kk) => kk.shape2d(rect(0, 0, 80, 50)).cut(rect(10, 10, 20, 20)),
  engrave: (kk) => kk.shape2d(rect(30, 10, 60, 20)),
  score: () => [[[-5, 40], [95, 40]], rect(65, 25, 75, 35)],
  pose: POSE,
  ...extra,
});
const partWith = (sp) => ({
  meta: { title: "Sheet fixture", units: "mm" },
  parameters: [{ id: "stock", title: "Stock", controls: [
    { key: "t", label: "Sheet thickness", unit: "mm", min: 1, max: 6, step: 0.05, description: "Measured." },
  ] }],
  defaults: { t: 3 },
  views: { main: { label: "Main" } },
  parts: { panel: sp },
});

describe("load-time errors name the fix", () => {
  const base = { material: "birch plywood", thickness: 3, profile: () => rect(0, 0, 10, 10), views: ["main"] };
  test.each([
    [42, "sheetPart: expected an options object — sheetPart({ material, thickness, profile, views, … })"],
    [{ ...base, kerf: 0.1 }, "sheetPart: kerf is chosen when you download the kit — use a clearance control"],
    [{ ...base, outline: [] }, 'sheetPart: "outline" is not a sheetPart key — use profile'],
    [{ ...base, cut: [] }, 'sheetPart: "cut" is not a sheetPart key — use profile'],
    [{ ...base, quantity: 2 }, 'sheetPart: "quantity" is not a sheetPart key — the kit counts identical pieces'],
    [{ ...base, build: () => null }, "sheetPart: sheetPart supplies build — draw the part with profile, score and engrave"],
    [{ ...base, folds: [] }, 'sheetPart: "folds" is reserved for a future process and not supported yet'],
    [{ ...base, grain: "x" }, 'sheetPart: "grain" is reserved for a future process and not supported yet'],
    [{ ...base, colour: "red" }, 'sheetPart: unknown key "colour" — the keys are material, thickness, profile, score, engrave, pose, process, plus the sub-part keys label, views, display, export, enabled, exportable, reference, place'],
    [{ ...base, process: "cnc" }, 'sheetPart: unknown process "cnc" — valid: laser'],
    [{ ...base, material: "" }, 'sheetPart: material must be a non-empty string or a (p, d) => string function — a stock label like "birch plywood"'],
    [{ ...base, thickness: 0 }, "sheetPart: thickness must be a number > 0 or a (p, d) => number function — the MEASURED sheet thickness in mm"],
    [{ ...base, profile: rect(0, 0, 1, 1) }, "sheetPart: profile must be a function (k, p, d) => Shape2D or profile"],
    [{ ...base, score: [] }, "sheetPart: score must be a function (k, p, d) => [[x, y], [x, y]] lines and shapes, or omitted"],
    [{ ...base, engrave: "LABEL" }, "sheetPart: engrave must be a function (k, p, d) => Shape2D or profile (or null), or omitted"],
    [{ ...base, pose: "front" }, "sheetPart: pose must be a { face, up, at } object or a (p, d) => pose function"],
    [{ ...base, pose: { face: "+Z", up: "+Z", at: [0, 0, 0] } }, "sheetPart: up (+Z) must be perpendicular to face (+Z)"],
    [{ ...base, place: { x: 1 } }, "sheetPart: place must be a function (solid, ctx) => solid"],
    // precedence: the wrong-word keys are reported before any field
    [{ ...base, kerf: 0.1, outline: [], material: "" }, "sheetPart: kerf is chosen when you download the kit — use a clearance control"],
  ])("%#", (spec, message) => {
    expect(() => sheetPart(spec)).toThrow(message);
  });
});

describe("an ordinary sub-part with a plain-data marker", () => {
  test("passthrough keys, a generated build, place only when needed", () => {
    const sp = sheetPart(panelSpec());
    expect(Object.keys(sp)).toEqual(["label", "views", "display", "build", "place", "sheet"]);
    expect(sp.build).toBe(sp.sheet.generatedBuild);
    expect(Object.isFrozen(sp.sheet)).toBe(true);
    expect(sp.sheet).toMatchObject({ process: "laser", material: "birch plywood", pose: POSE });
    const flat = sheetPart(panelSpec({ pose: undefined }));
    expect("place" in flat).toBe(false);
    expect(flat.sheet.pose).toBeNull();
    expect(sheetPart(panelSpec({ pose: null, place: (s) => s })).place).toBeTypeOf("function");
  });

  // The realistic look (materials/sheet-look.js) trusts a sheet's canonical frame only
  // when it sits exactly on its pose: no author place, and sheetPart's own place still
  // installed. So the record names both, the way generatedBuild names the build.
  test("the record names the author's place and the place sheetPart installed", () => {
    const own = (s) => s.translate([0, 0, 5]);
    const posed = sheetPart(panelSpec());
    expect(posed.sheet.place).toBeNull();
    expect(posed.sheet.generatedPlace).toBe(posed.place);
    const placed = sheetPart(panelSpec({ place: own }));
    expect(placed.sheet.place).toBe(own);
    expect(placed.sheet.generatedPlace).toBe(placed.place);
    const flat = sheetPart(panelSpec({ pose: undefined }));
    expect(flat.sheet.place).toBeNull();
    expect(flat.sheet.generatedPlace).toBeNull();
    expect("place" in flat).toBe(false);
  });

  test("recognition is plain data: no class, no Symbol, survives a copy", () => {
    const sp = sheetPart(panelSpec());
    expect(Object.getPrototypeOf(sp.sheet)).toBe(Object.prototype);
    expect(Object.getOwnPropertySymbols(sp)).toEqual([]);
    expect(Object.getOwnPropertySymbols(sp.sheet)).toEqual([]);
    // what another module instance (the cloud part worker's framework) would see
    const copy = { ...sp, sheet: { ...sp.sheet } };
    expect(isSheetPart(copy)).toBe(true);
    expect(processFor(copy)?.id).toBe("laser");
    expect(isSheetPart(JSON.parse(JSON.stringify(sp)))).toBe(true);
    expect(isSheetPart({ build: () => null })).toBe(false);
    expect(processFor({ build: () => null })).toBeNull();
  });

  test("a second instance of the constants module recognizes it too", async () => {
    const second = await import("../src/framework/sheet/constants.js?instance=second");
    expect(second.isSheetPart).not.toBe(isSheetPart);
    expect(second.isSheetPart(sheetPart(panelSpec()))).toBe(true);
  });

  test("replacing build afterwards is visible as a custom build", () => {
    const sp = sheetPart(panelSpec());
    const custom = { ...sp, build: (kk) => kk.box({ size: [80, 50, 3] }) };
    const { p, d } = resolveParams(partWith(custom), {});
    expect(resolveSheet(k, sp, p, d).customBuild).toBe(false);
    expect(resolveSheet(k, custom, p, d).customBuild).toBe(true);
  });

  // The process checks rebuild the profile from its own rings with it (the laser
  // descriptor's hole plan); a kernel without one (a probe) gives null.
  test("the resolved sheet carries the kernel's trusted lift, or null", () => {
    const sp = sheetPart(panelSpec());
    const { p, d } = resolveParams(partWith(sp), {});
    expect(resolveSheet(k, sp, p, d).trustedShape2d).toBe(k.shape2d.trusted);
    const { trusted: _, ...plain } = k.shape2d;
    const bare = { ...k, shape2d: Object.assign((x) => k.shape2d(x), plain) };
    expect(resolveSheet(bare, sp, p, d).trustedShape2d).toBeNull();
  });
});

describe("the preview build (Manifold)", () => {
  test.each([3, 2.7])("t = %s: V = A·t − MARK_DEPTH·area(marks ∩ profile), in the canonical frame", (t) => {
    const part = partWith(sheetPart(panelSpec({ pose: undefined })));
    const { p, d } = resolveParams(part, { t });
    const s = resolveSheet(k, part.parts.panel, p, d);
    const marks = [s.engrave, ...s.grooves].reduce((a, b) => a.union(b)).intersect(s.profile).area();
    const solid = buildPosed(k, part, "panel", { purpose: "display", view: "main", p, d });
    expect(solid.volume()).toBeCloseTo(s.profile.area() * t - MARK_DEPTH * marks, 3);
    const bb = solid.boundingBox();
    expect(bb.min.map((v) => +v.toFixed(9) + 0)).toEqual([0, 0, 0]);
    expect(bb.max.map((v) => +v.toFixed(9) + 0)).toEqual([80, 50, t]);
    expect(s.grooves).toHaveLength(2);                       // the line first, then the square
    // each groove is SCORE_WIDTH wide: the line's over its whole 100 mm (off both ends of
    // the profile too), the closed square's straddling its 40 mm boundary
    expect(s.grooves[0].area()).toBeCloseTo(SCORE_WIDTH * 100, 6);
    expect(s.grooves[1].area()).toBeCloseTo(SCORE_WIDTH * 40, 1);
  });

  test("a mark that turns out empty is dropped, not fatal", () => {
    const empty = (kk) => kk.shape2d(rect(0, 0, 1, 1)).intersect(rect(5, 5, 6, 6));
    const part = partWith(sheetPart(panelSpec({ pose: undefined, engrave: empty, score: () => [[[1, 1], [1, 1]], rect(40, 25, 40.1, 25.1)] })));
    const { p, d } = resolveParams(part, {});
    const solid = buildPosed(k, part, "panel", { purpose: "display", view: "main", p, d });
    // the zero-length line is skipped; the 0.1 mm square is too small for an inside, so it is scored solid
    const s = resolveSheet(k, part.parts.panel, p, d);
    expect(s.score.lines).toEqual([]);                        // so the cut file draws no dot either
    expect(s.grooves).toHaveLength(1);
    expect(solid.volume()).toBeCloseTo(s.profile.area() * 3 - MARK_DEPTH * s.grooves[0].area(), 3);
  });

  test("build-time values that cannot be used throw with the part's label", () => {
    const part = partWith(sheetPart(panelSpec({ thickness: (p) => p.missing })));
    const { p, d } = resolveParams(part, {});
    expect(() => part.parts.panel.build(k, p, d)).toThrow('sheet part "Panel": thickness must be a finite number > 0 (mm), got undefined');
    const noProfile = partWith(sheetPart(panelSpec({ profile: () => null })));
    expect(() => noProfile.parts.panel.build(k, p, d)).toThrow('sheet part "Panel": profile(k, p, d) returned nothing — return a Shape2D or profile');
    const badScore = partWith(sheetPart(panelSpec({ score: () => "line" })));
    expect(() => badScore.parts.panel.build(k, p, d)).toThrow('sheet part "Panel": score(k, p, d) must return an array of lines [[x, y], [x, y]] and shapes');
    const badPose = partWith(sheetPart(panelSpec({ pose: () => ({ face: "+X", up: "-X", at: [0, 0, 0] }) })));
    expect(() => badPose.parts.panel.build(k, p, d)).toThrow('sheet part "Panel": up (-X) must be perpendicular to face (+X)');
  });
});

describe("the pose: rigid, identical for display and export, probe-trusted", () => {
  test("probeSubPartPose trusts it and records exactly the pose steps", () => {
    const part = partWith(sheetPart(panelSpec()));
    const { p, d } = resolveParams(part, {});
    const display = probeSubPartPose(part.parts.panel, { view: "main", purpose: "display", p, d });
    const exportP = probeSubPartPose(part.parts.panel, { view: "main", purpose: "export", p, d });
    expect(display.trusted).toBe(true);
    expect(display.pose).toEqual(poseSteps(POSE, 3));
    expect(exportP).toEqual(display);
  });

  test("an author place runs after the pose", () => {
    const part = partWith(sheetPart(panelSpec({ place: (s) => s.translate([0, 0, 5]) })));
    const { p, d } = resolveParams(part, {});
    const probe = probeSubPartPose(part.parts.panel, { view: "main", purpose: "display", p, d });
    expect(probe.pose).toEqual([...poseSteps(POSE, 3), { t: "translate", v: [0, 0, 5] }]);
  });

  test("a thickness-only change keeps the pose trusted (the fast path can re-pose)", () => {
    const part = partWith(sheetPart(panelSpec()));
    for (const t of [2.5, 3.3]) {
      const { p, d } = resolveParams(part, { t });
      expect(probeSubPartPose(part.parts.panel, { view: "main", purpose: "display", p, d }).trusted).toBe(true);
    }
  });

  test("the posed solid lands where the pose says", () => {
    const part = partWith(sheetPart(panelSpec()));
    const { p, d } = resolveParams(part, {});
    const bb = buildPosed(k, part, "panel", { purpose: "export", view: "main", p, d }).boundingBox();
    // face −Y, up +Z, at [−40, 0, 0]: u → +X, v → +Z, material toward +Y
    expect(bb.min.map((v) => +v.toFixed(9) + 0)).toEqual([-40, 0, 0]);
    expect(bb.max.map((v) => +v.toFixed(9) + 0)).toEqual([40, 3, 50]);
  });

  // One spec object reused for the next panel, changed in between: everything the first
  // panel's place and frame read was fixed when it was made, like its build. A place that
  // read the spec live would move the exported panel and put the burn's frame off its mesh.
  test("a spec object changed after the call moves neither the panel nor its frame", () => {
    const spec = panelSpec({ thickness: 3 });
    const a = sheetPart(spec);
    Object.assign(spec, { thickness: 6, pose: { face: "+Z", up: "+Y", at: [0, 0, 10] }, place: (s) => s.translate([0, 0, 5]) });
    sheetPart(spec);
    const fresh = sheetPart(panelSpec({ thickness: 3 }));
    const { p, d } = resolveParams(partWith(a), {});
    const box = (sp) => {
      const bb = buildPosed(k, partWith(sp), "panel", { purpose: "export", view: "main", p, d }).boundingBox();
      return [...bb.min, ...bb.max].map((v) => +v.toFixed(9) + 0);
    };
    expect(box(a)).toEqual(box(fresh));
    expect(box(a)).toEqual([-40, 0, 0, 40, 3, 50]);
    const frame = sheetFrameFor(a, { p, d });
    expect(frame.t).toBe(3);
    expect(frame.frame).toEqual(sheetFrameFor(fresh, { p, d }).frame);
    expect(probeSubPartPose(a, { view: "main", purpose: "export", p, d }).pose).toEqual(poseSteps(POSE, 3));
  });

  test("a part made of sheet parts lints clean (validating probe, place rules)", () => {
    const report = lintPart(partWith(sheetPart(panelSpec())));
    expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
  });
});
