// The sheet-parts reference part (src/parts/laser-box.js), and the guide's worked
// example: five fingerBox panels and a lid as sheetPart sub-parts, two printed hinges
// keyed into slots. Each "checked by hand" claim in the design spec (A.4) is a test here.
import { beforeAll, describe, expect, test } from "vitest";
import part from "../src/parts/laser-box.js";
import { bootManifoldKernel, measure } from "../src/testing.js";
import { verify } from "../src/framework/oracle/verify.js";
import { buildPosed, resolveParams } from "../src/framework/part-model.js";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { subPartReadKeys, RELEVANT_ALL } from "../src/framework/param-deps.js";
import { isSheetPart } from "../src/framework/sheet/constants.js";
import { poseSteps, worldToSheet } from "../src/framework/sheet/pose.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const HINGE_LIFT = 0.25;   // laser-box.js HINGE.lift
const SHEETS = ["bottom", "left", "right", "front", "back", "lid"];
const PRINTED = ["hingeL", "hingeR"];

test("six sheet parts, two printed parts", () => {
  expect(Object.keys(part.parts).filter((n) => isSheetPart(part.parts[n]))).toEqual(SHEETS);
  expect(Object.keys(part.parts).filter((n) => !isSheetPart(part.parts[n]))).toEqual(PRINTED);
  for (const n of SHEETS) expect(part.parts[n].sheet).toMatchObject({ process: "laser", material: "birch plywood" });
});

test("fingerBox panel poses: right-handed, material inward (spec A.4 table)", () => {
  const { d } = resolveParams(part, {});
  const W = 160, D = 110;
  expect(d.box.front.pose).toEqual({ face: "-Y", up: "+Z", at: [-W / 2, -D / 2, 0] });
  expect(d.box.back.pose).toEqual({ face: "+Y", up: "+Z", at: [W / 2, D / 2, 0] });
  expect(d.box.left.pose).toEqual({ face: "-X", up: "+Z", at: [-W / 2, D / 2, 0] });
  expect(d.box.right.pose).toEqual({ face: "+X", up: "+Z", at: [W / 2, -D / 2, 0] });
  expect(d.box.bottom.pose).toEqual({ face: "-Z", up: "+Y", at: [W / 2, -D / 2, 0] });
});

test("builds and measures clean at defaults: nothing interpenetrates in the display assembly", () => {
  const r = measure(k, part, "box");
  expect(r.ok).toBe(true);
  expect(r.subparts.map((s) => s.name)).toEqual([...SHEETS, ...PRINTED]);
  expect(r.overlaps).toEqual([]);
});

test("the sheet panels' EXPORT assembly is the assembled box — zero pairwise overlap (decision 10)", () => {
  // The printed hinges export in their print pose at the origin (so the kit counts
  // them ×2); the sheets keep their assembled pose, so a STEP of the box opens assembled.
  const { p, d } = resolveParams(part, {});
  const solids = SHEETS.map((n) => buildPosed(k, part, n, { purpose: "export", view: "box", p, d }));
  for (let i = 0; i < solids.length; i++)
    for (let j = i + 1; j < solids.length; j++)
      expect(solids[i].intersect(solids[j]).volume(), `${SHEETS[i]} ∩ ${SHEETS[j]}`).toBeLessThan(1e-6);
  const box = k.union(solids.slice(0, 5)).boundingBox();
  expect(box.min.map((v) => +v.toFixed(6) + 0)).toEqual([-80, -55, 0]);
  expect(box.max.map((v) => +v.toFixed(6) + 0)).toEqual([80, 55, 80]);
});

describe("every sheet panel's pose is probe-trusted, the same for display and export", () => {
  test.each(SHEETS)("%s", (name) => {
    const { p, d } = resolveParams(part, {});
    const display = probeSubPartPose(part.parts[name], { view: "box", purpose: "display", p, d });
    const exportP = probeSubPartPose(part.parts[name], { view: "box", purpose: "export", p, d });
    expect(display.trusted).toBe(true);
    const pose = name === "lid" ? d.lidPose : d.box[name].pose;
    expect(display.pose).toEqual(poseSteps(pose, p.t));
    expect(exportP).toEqual(display);
  });
});

test("per-sub-part reads: the label rebuilds only the front, the tab clearance only what carries a tab", () => {
  const reads = subPartReadKeys(part, "box", part.defaults);
  expect(reads).not.toBe(RELEVANT_ALL);
  const readers = (key) => [...reads].filter(([, keys]) => keys.has(key)).map(([name]) => name);
  expect(readers("label")).toEqual(["front"]);
  expect(readers("printFit")).toEqual(["back", "lid", "hingeL", "hingeR"]);
  expect(readers("t")).toEqual([...SHEETS, ...PRINTED]);
});

test("tongue slots sit where the tongues land: v = H − 7.75 on the back, D − 7.75 on the lid", () => {
  const { p, d } = resolveParams(part, {});
  const H = p.height, D = p.depth;
  expect(d.axisZ).toBeCloseTo(H + 3.25, 12);
  expect(d.tongueY).toBe(11);
  for (const hx of d.hingeX) {
    expect(worldToSheet(d.box.back.pose, [hx, D / 2, d.axisZ - 11])[1]).toBeCloseTo(H - 7.75, 12);
    expect(worldToSheet(d.lidPose, [hx, D / 2, d.axisZ + 11])[1]).toBeCloseTo(D - 7.75, 12);
  }
});

// Thick stock raises the knuckle axis (the shut lid must clear the walls, below); the
// tongues ride down the leaf by the same amount, so the back panel's slots stay put and
// the web above them stays above the laser floor.
test("on thick stock the axis rises, and the back panel's slots stay where they were", () => {
  const { p, d } = resolveParams(part, { t: 6.5 });
  expect(d.axisZ).toBeCloseTo(p.height + 0.25 + 6.5, 12);
  expect(d.tongueY).toBeCloseTo(11 + 3.5, 12);
  for (const hx of d.hingeX)
    expect(worldToSheet(d.box.back.pose, [hx, p.depth / 2, d.axisZ - d.tongueY])[1]).toBeCloseTo(p.height - 7.75, 12);
  const v = verify(k, { ...part, defaults: { ...part.defaults, t: 6.5 } },
    { measureFn: (kk, pt, vw, pr, o) => measure(kk, pt, vw, pr, { ...o, now: () => 0 }) });   // a stopped clock: the budget never trips
  expect(v.failures).toEqual([]);
  expect(v.warnings.filter((c) => c.volunteered)).toEqual([]);
});

test("each hinge keys two tongues into the back panel and two into the lid (rotateX(90) turns them inward)", () => {
  // A hinge rotated the wrong way still overlaps nothing, so the overlap checks alone
  // cannot see it: assert the tongues are really there. Each 8 × 3 × t tongue lies in a
  // panel's plane (its slab) and touches none of that panel's material — it sits in a slot.
  const { p, d } = resolveParams(part, {});
  const W = p.width, D = p.depth, H = p.height, t = p.t;
  const lidZ = d.lidPose.at[2] - D;                                  // the open lid's hinge edge
  const backSlab = k.box({ min: [-W / 2, D / 2 - t, 0], max: [W / 2, D / 2, H] });
  const lidSlab = k.box({ min: [-W / 2, D / 2 - t, lidZ], max: [W / 2, D / 2, lidZ + D] });
  const back = buildPosed(k, part, "back", { purpose: "display", view: "box", p, d });
  const lid = buildPosed(k, part, "lid", { purpose: "display", view: "box", p, d });
  for (const name of PRINTED) {
    const hinge = buildPosed(k, part, name, { purpose: "display", view: "box", p, d });
    expect(hinge.intersect(backSlab).volume(), `${name} through the back panel`).toBeCloseTo(2 * 8 * 3 * t, 3);
    expect(hinge.intersect(lidSlab).volume(), `${name} through the lid`).toBeCloseTo(2 * 8 * 3 * t, 3);
    expect(hinge.intersect(back).volume(), `${name} ∩ back`).toBeLessThan(1e-6);
    expect(hinge.intersect(lid).volume(), `${name} ∩ lid`).toBeLessThan(1e-6);
  }
});

test("the knuckles clear the back wall by the hinge's 0.25 mm lift", () => {
  const { p, d } = resolveParams(part, {});
  const hinge = buildPosed(k, part, "hingeL", { purpose: "display", view: "box", p, d });
  const H = p.height, D = p.depth;
  const slab = (z0, z1) => k.box({ min: [-80, D / 2 - p.t, z0], max: [80, D / 2, z1] });  // over the back wall
  expect(hinge.intersect(slab(H, H + 0.25)).volume()).toBeLessThan(1e-6);
  expect(hinge.intersect(slab(H + 0.25, H + 0.5)).volume()).toBeGreaterThan(0);
});

test("at the extremes of the sliders the box still assembles cleanly", () => {
  for (const params of [
    { width: 100, depth: 80, height: 50, t: 6.5, fit: 0.4 },
    { width: 400, depth: 300, height: 200, t: 2, fit: 0, printFit: 0.8 },
  ]) {
    const r = measure(k, part, "box", params);
    expect(r.overlaps, JSON.stringify(params)).toEqual([]);
  }
});

// The display shows the lid open 90°; closing it is a quarter turn about the knuckle
// axis (x, y = D/2, z = axisZ). The lid's material runs t mm in from that plane, so the
// axis must sit max(R, t) above the walls (plus the lift) or thick stock jams the lid
// on the back wall's inside edge short of shut — at t = 6.5 it stopped 37° open.
test("the lid swings shut about the knuckle axis without meeting a wall, on any stock", () => {
  const WALLS = ["bottom", "left", "right", "front", "back"];
  for (const params of [
    {},
    { t: 6 },
    { width: 100, depth: 80, height: 50, t: 6.5, fit: 0.4, printFit: 0.8 },
    { width: 400, depth: 300, height: 200, t: 2, fit: 0, printFit: 0.8 },
  ]) {
    const { p, d } = resolveParams(part, params);
    const ctx = { purpose: "display", view: "box", p, d };
    const lid = buildPosed(k, part, "lid", ctx);
    const walls = WALLS.map((n) => [n, buildPosed(k, part, n, ctx)]);
    for (const deg of [15, 30, 45, 60, 75, 90]) {
      const swung = lid.rotate(deg, [0, p.depth / 2, d.axisZ], [1, 0, 0]);
      for (const [n, wall] of walls)
        expect(swung.intersect(wall).volume(), `${JSON.stringify(params)} ${n} at ${deg}°`).toBeLessThan(1e-6);
    }
    // Shut, it really is a lid: from the front wall back to the knuckle strip (the wall,
    // or the 3 mm barrel on thinner stock, plus the lift), resting just above the walls.
    const { min, max } = lid.rotate(90, [0, p.depth / 2, d.axisZ], [1, 0, 0]).boundingBox();
    expect(min[1]).toBeLessThanOrEqual(-p.depth / 2 + 1e-6);
    expect(max[1]).toBeGreaterThanOrEqual(p.depth / 2 - Math.max(p.t, 3) - HINGE_LIFT - 1e-6);
    expect(min[2]).toBeGreaterThanOrEqual(p.height);
    expect(min[2]).toBeLessThanOrEqual(p.height + HINGE_LIFT + 3 + 1e-6);
  }
}, 60_000);

// The Label control is free text; a label of only spaces is no label, not a throw from
// text2d that stops the Front panel building.
test("a label of only spaces engraves nothing, and the front still builds", () => {
  const front = (label) => {
    const { p, d } = resolveParams(part, { label });
    return buildPosed(k, part, "front", { purpose: "display", view: "box", p, d }).volume();
  };
  expect(front("   ")).toBeCloseTo(front(""), 6);
  expect(front("TOOLS")).toBeLessThan(front(""));
});

describe("export layout leaves sheet pieces assembled", () => {
  test("layoutExportPieces moves the printed hinges but not a sheet panel", async () => {
    const { layoutExportPieces } = await import("../src/framework/export/bed-layout.js");
    const { p, d } = resolveParams(part, {});
    const pieces = [...SHEETS, ...PRINTED].map((name) => ({
      name, solid: buildPosed(k, part, name, { purpose: "export", view: "box", p, d }),
    }));
    const out = layoutExportPieces(part, pieces);
    for (const n of SHEETS) {
      const before = pieces.find((x) => x.name === n).solid.boundingBox();
      const after = out.find((x) => x.name === n).solid.boundingBox();
      expect(after, n).toEqual(before);
    }
    const moved = PRINTED.filter((n) => JSON.stringify(out.find((x) => x.name === n).solid.boundingBox())
      !== JSON.stringify(pieces.find((x) => x.name === n).solid.boundingBox()));
    expect(moved.length).toBeGreaterThan(0);
  });
});
