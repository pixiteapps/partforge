// src/framework/materials/sheet-look.js
// How a laser-cut sheet part looks in realistic mode — plain data and pure math, three-free
// and DOM-free like resolve.js, so the viewer, mount, lint and the tests all read ONE
// statement of it. patterns.js turns it into GLSL; nothing here knows about three.
//
// A laser sheetPart in a wood shows its burns: charred cut walls, scorched engrave and
// score floors, faces untouched. The shader tells those surfaces apart in the sheet's
// CANONICAL frame — profile in XY, material over z ∈ [0, t], laser face at z = t — but the
// viewer holds the DELIVERED display mesh. With no author `place`, sheetPart's generated
// place is exactly the rigid steps poseSteps(pose, t) (and there is no place at all with no
// pose), so the delivered mesh is that motion applied to the canonical solid and the frame
// is its inverse: computed from data, with no pose probe and no geometry. A sheet with an
// author place, a replaced place or a custom build is not trusted with a frame — it draws
// plain wood, never a frame that could char a face.
//
// It also says what a laser sheet part with no usable material looks like: not a PLA print
// (resolve.js's default for every other sub-part) but the sheet its stock label names —
// realisticDisplay, from the ONE keyword table STOCK_LOOKS. Realistic-only, like the PLA
// default: the CAD view, 3MF colours and declaresMaterials read sp.display itself.
import { isSheetPart, sheetMeta, MARK_DEPTH } from "../sheet/constants.js";
import { poseSteps, validatePose } from "../sheet/pose.js";
import { composePose, invertRigid } from "../geometry/pose.js";
import { resolveMaterial } from "./resolve.js";
import { PRESETS } from "./presets.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// The burn's numbers, ONE statement: patterns.js templates the GLSL from them, and the JS
// twins below (classifySheetSurface, burnAlbedo) read the same object.
//   wallNz      a surface whose canonical |n.z| is below this band is a cut wall (the
//               shader blends across the band; the JS twin splits at its middle). Creased
//               normals are hard at a sheet's 90° arris, so real walls sit at n.z = 0.
//   floorDepth  an up-facing surface at least this far below the laser face is an engrave
//               or score floor: half the preview's MARK_DEPTH, so the laser face (z = t) is
//               never one and a mark's floor (z = t − MARK_DEPTH) always is.
// Char is RELATIVE to the face, all in linear RGB: a cut wall is the face's average colour
// mixed toward a charcoal TARGET by k — kThin at ≤ tThin mm, kThick at ≥ tThick (thick stock
// takes a longer dwell) — plus up to `exit` more toward the exit side (z = 0); an engrave or
// score floor by `engraveLess` less. The target is PER CHANNEL, not `charcoal` itself: each
// channel is capped at `charOfDark` of the face's OWN channel (burnAlbedo's `target`), so char
// is never lighter than its face in any single channel. A single luminance-derived cap (the
// first cut) is not enough — walnut's face is reddish (high R, low G/B), so `charcoal`'s own,
// more neutral B channel sits ABOVE walnut's near-black B even though charcoal reads darker
// overall, and mixing the whole vector toward it raised that one channel, reading as a flat,
// lighter char on camera despite passing the diffuse-only calibration (dE/luma) floors below.
// Capping every channel at its own face's brightness, not just the vector's, closes that gap.
// Char and scorched floors take `roughness`; on plywood's cut walls a cross ply is `crossPly`
// of a face-grain ply. The colours are starting points from the research, tuned by eye on the
// contact sheet — within the calibration floors that test/framework/sheet-look.test.js holds
// them to. kThin and roughness were retuned (0.55 → 0.8, 0.85 → 0.65) during the
// four-environment sign-off: the per-channel target above already made the burnt ALBEDO
// darker on every wall, but studio/workshop/outdoor carry no key light — IBL alone, so a
// wall's brightness is however much of the environment its own geometric normal happens to
// face — and the unburnt wood's tight clearcoat/normal-mapped specular versus the burnt char's
// broader, flatter one still left walnut's far (non-key-lit) wall reading brighter charred
// than plain in three of the four environments. A deeper kThin (more charcoal mixed in at the
// laser box's own 3 mm) plus a less-diffuse roughness (still clearly matte against walnut's
// 0.5-roughness, clearcoat-3 lacquer) closed it in every environment; see this branch's sign-off
// report for the measured before/after wall ratios per environment.
export const BURN = Object.freeze({
  wallNz: Object.freeze([0.35, 0.65]),
  floorDepth: MARK_DEPTH / 2,
  charcoal: 0x262220,
  kThin: 0.8,
  kThick: 0.85,
  tThin: 3,
  tThick: 9,
  exit: 0.1,
  engraveLess: 0.1,
  charOfDark: 0.5,
  roughness: 0.65,
  crossPly: 0.78,
});

// sRGB 0xRRGGBB → linear [r, g, b]: the conversion three applies to a colour uniform.
export function srgbToLinear(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}

// Plies in a birch-plywood sheet t mm thick: 3 mm → 3, 6 → 5, 9 → 7, 12 → 9. Always odd, so
// both outer plies run with the face grain.
const PLY_STEPS = Object.freeze([[4.5, 3], [7.5, 5], [10.5, 7]]);
export function plyCount(t) {
  for (const [below, plies] of PLY_STEPS) if (t < below) return plies;
  return 9;
}

// The material realistic mode draws this sub-part in.
const lookOf = (sp) => resolveMaterial(realisticDisplay(sp));

// A laser sheet with no usable material takes its look from its stock label: the first row
// whose word the label contains (ignoring case), else DEFAULT_STOCK_LOOK — plywood for
// birch, basswood, poplar, MDF, hardboard, card or anything unlabelled. Only a string label
// is read: a (p, d) function would make a sub-part's look (and its program) depend on the
// params it was first drawn at, so it counts as unlabelled.
export const STOCK_LOOKS = Object.freeze([
  Object.freeze({ look: "clear-acrylic", words: Object.freeze(["acrylic", "perspex", "plexi", "pmma", "polycarbonate"]) }),
]);
export const DEFAULT_STOCK_LOOK = "plywood";

export function stockLook(stock) {
  if (typeof stock !== "string") return DEFAULT_STOCK_LOOK;
  const label = stock.toLowerCase();
  return STOCK_LOOKS.find(({ words }) => words.some((w) => label.includes(w)))?.look ?? DEFAULT_STOCK_LOOK;
}

// The stock's look for a laser sheet part, else null (lint names it in its fallback hint).
export function sheetStockLook(sp) {
  return isSheetPart(sp) && sp.sheet.process === "laser" ? stockLook(sp.sheet.material) : null;
}

// The display realistic mode draws: sp.display itself, except that a laser sheet part
// naming no KNOWN material — none, or one the library does not know, the same "no usable
// material" resolve.js treats as one case — gets its stock's look. A `color` rides along,
// so a bare colour tints that look (stained plywood, coloured acrylic).
export function realisticDisplay(sp) {
  const display = sp?.display;
  const look = sheetStockLook(sp);
  if (!look) return display;
  if (typeof display?.material === "string" && Object.hasOwn(PRESETS, display.material)) return display;
  return { ...(display && typeof display === "object" ? display : {}), material: look };
}

// Does this sub-part carry the burn pass at all? Static — it reads no params — so the
// viewer decides a sub-part's PROGRAM once, and every sub-part that answers false keeps
// exactly the program it had before the burn existed.
export function burnsFor(sp) {
  if (!isSheetPart(sp) || sp.sheet.process !== "laser") return false;
  if (sp.build !== sp.sheet.generatedBuild) return false;                   // a custom build is not the canonical sheet
  if (sp.sheet.place != null) return false;                                 // an author place moves it off its pose
  if ((sp.place ?? null) !== (sp.sheet.generatedPlace ?? null)) return false; // place replaced after sheetPart
  try { return lookOf(sp).params.pattern === "wood"; } catch { return false; }
}

// At (p, d) — a delivery's params — the frame that maps the delivered display mesh's
// object space into the canonical sheet frame, the sheet's thickness, and how many plies
// its cut walls show (0 unless its preset is `laminated`). null when burnsFor says no or
// the pose or thickness cannot be read (the build reports those).
export function sheetFrameFor(sp, { p, d } = {}) {
  if (!burnsFor(sp)) return null;
  const meta = sheetMeta(sp, p, d);
  if (!meta) return null;
  const t = meta.thickness;
  let pose;
  try { pose = typeof sp.sheet.pose === "function" ? sp.sheet.pose(p, d) : sp.sheet.pose; } catch { return null; }
  if (pose != null && validatePose(pose)) return null;
  const frame = pose == null ? [...IDENTITY] : invertRigid(composePose(poseSteps(pose, t)));
  return { frame, t, plies: lookOf(sp).preset.laminated ? plyCount(t) : 0 };
}

// The shader's surface classification, in JS: the frame tests hold real geometry to it.
// `pos` and `normal` are canonical (after the frame); `t` is the thickness.
export function classifySheetSurface(pos, normal, t) {
  if (Math.abs(normal[2]) < (BURN.wallNz[0] + BURN.wallNz[1]) / 2) return "wall";
  if (normal[2] < 0) return "back";
  return pos[2] <= t - BURN.floorDepth ? "floor" : "face";
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// The shader's burnt albedo, in JS (the calibration test's twin — same numbers, same
// formula): `face` is the unburnt face's average colour in linear RGB (the preset's texture
// average times any tint), `t` the sheet thickness (mm), `kind` "edge" — a cut wall, `zFrac`
// of the way from the exit side (0) up to the laser face (1) — or "engrave", a mark's floor.
// Ply bands are left out: they only modulate an edge.
export function burnAlbedo(face, t, { kind = "edge", zFrac = 1 } = {}) {
  const charcoal = srgbToLinear(BURN.charcoal);
  // The mix target, PER CHANNEL: whichever is darker of raw charcoal or charOfDark of this
  // channel's own face value — never the whole vector scaled by one luminance ratio (see the
  // BURN comment above). Multiplicative in the channel that governs it, so charring a face
  // darker than charcoal in that channel still only ever removes light from it.
  const target = charcoal.map((c, i) => Math.min(c, BURN.charOfDark * face[i]));
  const k = BURN.kThin + (BURN.kThick - BURN.kThin) * clamp01((t - BURN.tThin) / (BURN.tThick - BURN.tThin));
  const amount = kind === "engrave" ? k - BURN.engraveLess : Math.min(1, k + BURN.exit * (1 - clamp01(zFrac)));
  return face.map((f, i) => f + (target[i] - f) * amount);
}
