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
import { BURN, DEFAULT_STOCK_LOOK, STOCK_LOOKS, burnAlbedo, burnsFor, classifySheetSurface, plyCount, realisticDisplay, sheetFrameFor, sheetStockLook, srgbToLinear, stockLook } from "../../src/framework/materials/sheet-look.js";
import { PRESETS } from "../../src/framework/materials/presets.js";

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

// Where the posed mesh's LASER side lands under `frame`: the class of every triangle whose
// world normal is the pose's `face` (the laser face and any mark floors).
const AXIS = { "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0], "+Z": [0, 0, 1], "-Z": [0, 0, -1] };
function laserSide(solid, frame, t, face) {
  const world = Float64Array.from(solid.toMesh().positions);
  const pos = Float64Array.from(world);
  transformPositions(pos, frame);
  const classes = {};
  for (let i = 0; i < world.length; i += 9) {
    const u = [world[i + 3] - world[i], world[i + 4] - world[i + 1], world[i + 5] - world[i + 2]];
    const v = [world[i + 6] - world[i], world[i + 7] - world[i + 1], world[i + 8] - world[i + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9 || (n[0] * face[0] + n[1] * face[1] + n[2] * face[2]) / len < 0.99) continue;
    const cu = [pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]];
    const cv = [pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]];
    const cn = [cu[1] * cv[2] - cu[2] * cv[1], cu[2] * cv[0] - cu[0] * cv[2], cu[0] * cv[1] - cu[1] * cv[0]];
    const cls = classifySheetSurface([0, 0, (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3], cn.map((c) => c / len), t);
    classes[cls] = (classes[cls] ?? 0) + 1;
  }
  return classes;
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
    // …the right way up. On a panel with no marks the histogram is symmetric: a frame that
    // turned it over (z → t − z) swaps face@t and back@0 one for one and matches. So the
    // side the laser hits — every triangle facing the pose's `face` — must land as the
    // laser face (or a mark's floor), never as the back.
    const pose = typeof sp.sheet.pose === "function" ? sp.sheet.pose(p, d) : sp.sheet.pose;
    const side = laserSide(posed, f.frame, p.t, AXIS[pose.face]);
    expect(side.face).toBeGreaterThan(0);
    expect(side.back ?? 0).toBe(0);
    expect(side.wall ?? 0).toBe(0);
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

// "Clearly visible" is judged the only way that cannot be fooled by lighting: the SAME
// pixel with the burn on and off. At the albedo level the two differ only by the burn (the
// diffuse lighting multiplies both alike), so each wood's char is held to a floor at 3 mm —
// the laser box's default, the thin end of the ramp — at the lightest point of a wall (the
// laser-face end, zFrac 1). Never wall against face: studio light darkens walls anyway.
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function lab(rgb) {
  const [r, g, b] = rgb;
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = luma(rgb), z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (q) => (q > 216 / 24389 ? Math.cbrt(q) : (24389 / 27 * q + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const dE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const WOODS = ["oak", "walnut", "plywood"];

describe("the burn is clearly visible: the same pixel, burn on vs off", () => {
  test.each(WOODS)("%s at 3 mm", (id) => {
    const face = srgbToLinear(PRESETS[id].color);          // the unburnt pixel's albedo: the texture's average
    const edge = burnAlbedo(face, 3);
    const mark = burnAlbedo(face, 3, { kind: "engrave" });
    expect(dE(face, edge)).toBeGreaterThanOrEqual(12);
    expect(luma(edge)).toBeLessThanOrEqual(0.7 * luma(face));
    expect(dE(face, mark)).toBeGreaterThanOrEqual(10);
    expect(luma(mark)).toBeLessThanOrEqual(0.8 * luma(face));
  });

  // What this guarantees, and what it does not. The char is mixed from ONE colour, the face's
  // AVERAGE (the preset colour, which is its texture's average, times any tint — the shader's
  // pfFace), toward a per-channel target; this holds that result no lighter than that average
  // in any channel. The bug it guards, in the twin: a face reddish enough that one channel
  // (walnut's blue) already sits below raw `charcoal`'s own, which the old luminance-only cap
  // then RAISED while the dE/luma floors above still passed (on camera: a flat, lighter char on
  // one of walnut's walls; the render itself is checked by eye, not here). It says nothing per
  // texel: the char is flat, so a texel darker than it — walnut's darkest grain, about 6% of
  // its texels under a 3 mm edge and 9% under an engrave, by luma — reads lighter burnt. That
  // flat char is the chosen look, a residual in the spec.
  test.each(WOODS)("%s: no channel of the char reads lighter than the face average it is mixed from", (id) => {
    const face = srgbToLinear(PRESETS[id].color);
    for (const kind of ["edge", "engrave"]) {
      const result = burnAlbedo(face, 3, { kind });
      result.forEach((c, i) => expect(c, `${kind} channel ${i}`).toBeLessThanOrEqual(face[i]));
    }
  });

  // This is an ALBEDO ordering, guaranteed by kThin < kThick alone — it holds for any
  // roughness and is not proof the RENDER orders the same way: the specular term (the same
  // at every thickness, set by BURN.roughness) adds light the albedo cannot take away, and a
  // retune once let it invert the render while this passed. Treat a green run as "the mix math
  // ramps the right way", never as "the render does": that needs a capture compared at the
  // SAME place (two swatches elsewhere on the contact sheet reflect different light), per
  // the design spec's calibration section.
  test("thicker stock chars darker, and the exit side darker than the laser face", () => {
    const face = srgbToLinear(PRESETS.oak.color);
    const at = (t, zFrac = 1) => luma(burnAlbedo(face, t, { zFrac }));
    expect(at(9)).toBeLessThan(at(6));
    expect(at(6)).toBeLessThan(at(3));
    expect(at(3, 0)).toBeLessThan(at(3, 1));
  });

  test("char is darker than its own face under any tint, and never below its floor", () => {
    for (const hex of [0x202020, 0x101010, 0x3a1c10]) {
      const face = srgbToLinear(hex);
      expect(luma(burnAlbedo(face, 3)), hex.toString(16)).toBeLessThan(luma(face));
    }
    const oak = srgbToLinear(PRESETS.oak.color);
    expect(luma(burnAlbedo(oak, 12, { zFrac: 0 }))).toBeGreaterThanOrEqual(luma(srgbToLinear(BURN.charcoal)) - 1e-12);
  });
});

test("a plywood sheet shows its plies: 3 mm → 3, 6 → 5, 9 → 7; other woods none", () => {
  for (const [t, plies] of [[3, 3], [6, 5], [9, 7]]) {
    expect(sheetFrameFor(panel({ display: { material: "plywood" }, thickness: t }), P).plies, `${t} mm`).toBe(plies);
  }
  expect(sheetFrameFor(panel(), P).plies).toBe(0);
});

describe("a laser sheet with no usable material takes its stock's look", () => {
  test("one keyword table: acrylic-like stock is clear acrylic, everything else plywood", () => {
    for (const stock of ["clear acrylic", "3 mm Perspex", "Plexiglas", "plexiglass", "PMMA", "3mm PMMA", "polycarbonate sheet",
      "Cast ACRYLIC", "clear-acrylic", "Acrylite FF", "Acrylglas 3mm", "acrylique", "polymethyl methacrylate", "Lexan",
      "Makrolon", "Lucite", "Poly-carbonate", "polycarb", "Perspex®"]) {
      expect(stockLook(stock), stock).toBe("clear-acrylic");
    }
    // Words, not substrings: a stem has to START a word of the label.
    for (const stock of ["birch plywood", "basswood", "poplar ply", "MDF", "hardboard", "wood", "cardboard", "", "?",
      "perplexing birch", "nonacrylic veneer", "duplex board"]) {
      expect(stockLook(stock), stock).toBe("plywood");
    }
    // A residual, named: stock that is neither wood nor acrylic takes the plywood look too.
    for (const stock of ["felt", "leather", "card", "cork"]) expect(stockLook(stock), stock).toBe("plywood");
    expect(stockLook((p) => p.stock)).toBe(DEFAULT_STOCK_LOOK);   // a function label is not read
    for (const { look } of STOCK_LOOKS) expect(Object.keys(PRESETS)).toContain(look);
    expect(Object.keys(PRESETS)).toContain(DEFAULT_STOCK_LOOK);
  });

  test("realisticDisplay: an explicit known material wins; none, or an unknown one, takes the stock's look", () => {
    const oak = panel();
    expect(realisticDisplay(oak)).toBe(oak.display);
    expect(realisticDisplay(panel({ display: undefined }))).toEqual({ material: "plywood" });
    expect(realisticDisplay(panel({ display: { color: 0x2e8b3d } }))).toEqual({ color: 0x2e8b3d, material: "plywood" });
    expect(realisticDisplay(panel({ display: { material: "birch" } }))).toEqual({ material: "plywood" });
    expect(realisticDisplay(panel({ display: undefined, material: "clear acrylic" }))).toEqual({ material: "clear-acrylic" });
    const block = { views: ["main"], build: () => null };
    expect(realisticDisplay(block)).toBeUndefined();              // not a sheet: still a PLA print
    expect(sheetStockLook(block)).toBeNull();
  });

  test("a default-plywood sheet burns and shows its plies; a default-acrylic one does not burn", () => {
    const ply = panel({ display: undefined });
    expect(burnsFor(ply)).toBe(true);
    expect(sheetFrameFor(ply, P).plies).toBe(3);
    expect(burnsFor(panel({ display: undefined, material: "clear acrylic" }))).toBe(false);
  });
});
