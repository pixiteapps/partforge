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
import { isSheetPart, sheetMeta, MARK_DEPTH } from "../sheet/constants.js";
import { poseSteps, validatePose } from "../sheet/pose.js";
import { composePose, invertRigid } from "../geometry/pose.js";
import { resolveMaterial } from "./resolve.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// The burn's numbers, ONE statement: patterns.js templates the GLSL from them, and the JS
// twins below (classifySheetSurface, and Task 2's burnAlbedo) read the same object.
//   wallNz      a surface whose canonical |n.z| is below this band is a cut wall (the
//               shader blends across the band; the JS twin splits at its middle). Creased
//               normals are hard at a sheet's 90° arris, so real walls sit at n.z = 0.
//   floorDepth  an up-facing surface at least this far below the laser face is an engrave
//               or score floor: half the preview's MARK_DEPTH, so the laser face (z = t) is
//               never one and a mark's floor (z = t − MARK_DEPTH) always is.
export const BURN = Object.freeze({
  wallNz: Object.freeze([0.35, 0.65]),
  floorDepth: MARK_DEPTH / 2,
});

// Plies in a birch-plywood sheet t mm thick: 3 mm → 3, 6 → 5, 9 → 7, 12 → 9. Always odd, so
// both outer plies run with the face grain.
const PLY_STEPS = Object.freeze([[4.5, 3], [7.5, 5], [10.5, 7]]);
export function plyCount(t) {
  for (const [below, plies] of PLY_STEPS) if (t < below) return plies;
  return 9;
}

// The material realistic mode draws this sub-part in.
const lookOf = (sp) => resolveMaterial(sp.display);

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
