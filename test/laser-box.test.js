// The sheet-parts reference part (src/parts/laser-box.js), and the guide's worked
// example: five fingerBox panels and a lid as sheetPart sub-parts, two printed hinges
// keyed into slots. Each "checked by hand" claim in the design spec (A.4) is a test here.
import { beforeAll, describe, expect, test } from "vitest";
import part from "../src/parts/laser-box.js";
import { bootManifoldKernel, measure } from "../src/testing.js";
import { buildPosed, resolveParams } from "../src/framework/part-model.js";
import { probeSubPartPose } from "../src/framework/pose-probe-core.js";
import { subPartReadKeys, RELEVANT_ALL } from "../src/framework/param-deps.js";
import { isSheetPart } from "../src/framework/sheet/constants.js";
import { poseSteps, worldToSheet } from "../src/framework/sheet/pose.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

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
  for (const hx of d.hingeX) {
    expect(worldToSheet(d.box.back.pose, [hx, D / 2, d.axisZ - 11])[1]).toBeCloseTo(H - 7.75, 12);
    expect(worldToSheet(d.lidPose, [hx, D / 2, d.axisZ + 11])[1]).toBeCloseTo(D - 7.75, 12);
  }
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
