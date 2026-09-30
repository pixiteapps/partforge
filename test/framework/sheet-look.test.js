// A laser sheet part's canonical frame, from data (materials/sheet-look.js): the matrix
// that carries its DELIVERED display mesh back into the frame it was drawn in — profile in
// XY, material over z ∈ [0, t], laser face at z = t — which the burn pass classifies
// surfaces in. Held against real geometry: every laser-box panel is built posed (as the
// viewer receives it) and flat (sheetPart's own build), and the frame must land the one
// exactly on the other.
import { beforeAll, describe, expect, test } from "vitest";
import laserBox from "../../src/parts/laser-box.js";
import { bootManifoldKernel } from "../../src/testing.js";
import { buildPosed, resolveParams } from "../../src/framework/part-model.js";
import { sheetPart } from "../../src/framework/sheet/part.js";
import { MARK_DEPTH } from "../../src/framework/sheet/constants.js";
import { poseSteps } from "../../src/framework/sheet/pose.js";
import { composePose, invertRigid, transformPositions } from "../../src/framework/geometry/pose.js";
import { BURN, burnsFor, classifySheetSurface, plyCount, sheetFrameFor } from "../../src/framework/materials/sheet-look.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SHEETS = ["bottom", "left", "right", "front", "back", "lid"];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const P = { p: {}, d: {} };

// Class histogram of a mesh after `frame`: walls by count, caps by class AND height (to
// 0.001 mm), so a frame that lands a panel anywhere but on its canonical self fails.
function histogram(solid, frame, t) {
  const pos = Float64Array.from(solid.toMesh().positions);
  transformPositions(pos, frame);
  const h = {};
  for (let i = 0; i < pos.length; i += 9) {
    const u = [pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]];
    const v = [pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;                                  // a boolean's sliver
    const z = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
    const cls = classifySheetSurface([0, 0, z], n.map((c) => c / len), t);
    const key = cls === "wall" ? "wall" : `${cls}@${Math.round(z * 1000) / 1000 + 0}`;
    h[key] = (h[key] ?? 0) + 1;
  }
  return h;
}

describe("every laser-box panel's frame lands its display mesh on its canonical solid", () => {
  test.each(SHEETS)("%s", (name) => {
    const { p, d } = resolveParams(laserBox, {});
    const sp = laserBox.parts[name];
    const f = sheetFrameFor(sp, { p, d });
    expect(f).not.toBeNull();
    expect(f.t).toBe(p.t);
    const posed = buildPosed(k, laserBox, name, { purpose: "display", view: "box", p, d });
    const got = histogram(posed, f.frame, p.t);
    expect(got).toEqual(histogram(sp.build(k, p, d), IDENTITY, p.t));   // sheetPart's own build IS canonical
    expect(got[`face@${p.t}`]).toBeGreaterThan(0);
    expect(got["back@0"]).toBeGreaterThan(0);
    expect(got.wall).toBeGreaterThan(0);
  });

  test("the front panel's frame is the inverse of its pose, and its label and score are floors", () => {
    const { p, d } = resolveParams(laserBox, {});
    const f = sheetFrameFor(laserBox.parts.front, { p, d });
    expect(f.frame).toEqual(invertRigid(composePose(poseSteps(d.box.front.pose, p.t))));
    const h = histogram(buildPosed(k, laserBox, "front", { purpose: "display", view: "box", p, d }), f.frame, p.t);
    expect(h[`floor@${Math.round((p.t - MARK_DEPTH) * 1000) / 1000}`]).toBeGreaterThan(0);
  });

  test("a thickness change moves the frame with the laser face", () => {
    const at = (t) => { const { p, d } = resolveParams(laserBox, { t }); return sheetFrameFor(laserBox.parts.front, { p, d }); };
    expect(at(6).t).toBe(6);
    expect(at(6).frame).not.toEqual(at(3).frame);
  });
});

const panel = (extra = {}) => sheetPart({
  label: "Panel", views: ["main"], display: { material: "oak" }, material: "birch plywood", thickness: 3,
  profile: (kk) => kk.shape2d(rect(0, 0, 40, 30)), ...extra,
});

describe("who burns: a laser sheet in a wood, on its own build and pose", () => {
  test("a flat oak sheet burns with the identity frame and no plies", () => {
    const sp = panel();
    expect(burnsFor(sp)).toBe(true);
    expect(sheetFrameFor(sp, P)).toEqual({ frame: IDENTITY, t: 3, plies: 0 });
  });

  test("walnut burns; acrylic, PLA and a non-sheet oak part do not", () => {
    expect(burnsFor(panel({ display: { material: "walnut" } }))).toBe(true);
    expect(burnsFor(panel({ display: { material: "clear-acrylic" } }))).toBe(false);
    expect(burnsFor(panel({ display: { material: "pla-print" } }))).toBe(false);
    expect(burnsFor({ views: ["main"], build: () => null, display: { material: "oak" } })).toBe(false);
    expect(sheetFrameFor(panel({ display: { material: "clear-acrylic" } }), P)).toBeNull();
  });

  // The frame is only exact while the delivered mesh is the canonical solid carried by the
  // pose. Anything else draws plain wood rather than a frame that could char a face.
  test("a custom build, an author place (mirrored or not) and a replaced place show plain wood", () => {
    const sp = panel();
    expect(burnsFor({ ...sp, build: (kk) => kk.box({ size: [40, 30, 3] }) })).toBe(false);
    expect(burnsFor(panel({ place: (s) => s.translate([0, 0, 5]) }))).toBe(false);
    expect(burnsFor(panel({ place: (s) => s.mirror("YZ") }))).toBe(false);
    expect(burnsFor({ ...sp, place: (s) => s })).toBe(false);
    expect(sheetFrameFor({ ...sp, place: (s) => s }, P)).toBeNull();
  });

  test("a hand-written sheet declaration never gets a frame", () => {
    const sp = panel();
    expect(burnsFor({ views: ["main"], build: sp.build, display: { material: "oak" }, sheet: { ...sp.sheet, generatedBuild: undefined } })).toBe(false);
  });

  test("a pose or thickness that cannot be read gives no frame; a null pose is flat", () => {
    const throwing = panel({ pose: () => { throw new Error("boom"); } });
    expect(burnsFor(throwing)).toBe(true);
    expect(sheetFrameFor(throwing, P)).toBeNull();
    expect(sheetFrameFor(panel({ pose: () => null }), P).frame).toEqual(IDENTITY);
    expect(sheetFrameFor(panel({ thickness: () => Number.NaN }), P)).toBeNull();
  });
});

test("plies: 3 mm → 3, 6 → 5, 9 → 7, 12 → 9", () => {
  expect([0.5, 3, 4.4, 4.5, 6, 7.5, 9, 10.5, 12].map(plyCount)).toEqual([3, 3, 3, 5, 5, 7, 7, 9, 9]);
});

test("classifySheetSurface: walls by the normal, floors by depth under the laser face", () => {
  expect(BURN.floorDepth).toBe(MARK_DEPTH / 2);
  expect(classifySheetSurface([0, 0, 1.5], [1, 0, 0], 3)).toBe("wall");
  expect(classifySheetSurface([0, 0, 1.5], [0.9, 0, 0.4], 3)).toBe("wall");      // |n.z| below the band's middle (0.5)
  expect(classifySheetSurface([0, 0, 3], [0.8, 0, 0.6], 3)).toBe("face");        // above it: a cap
  expect(classifySheetSurface([0, 0, 3], [0, 0, 1], 3)).toBe("face");
  expect(classifySheetSurface([0, 0, 3 - MARK_DEPTH], [0, 0, 1], 3)).toBe("floor");
  expect(classifySheetSurface([0, 0, 0], [0, 0, -1], 3)).toBe("back");
});
