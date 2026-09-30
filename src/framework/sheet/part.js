// sheetPart(spec) — a sub-part cut from flat stock (laser-cut plywood, acrylic, MDF).
// It returns an ORDINARY sub-part: `build` and (when there is a pose or an author
// place) `place` are filled in, and a plain-data `sheet` declaration is attached. So
// `build` stays required everywhere, and nothing that reads `sp.build` has to change.
//
// `sp.sheet` is the ONLY marker (isSheetPart in constants.js): a shallow-frozen plain
// object, never a class instance, Symbol() or WeakMap entry — the cloud part worker
// has two module instances of this code and identity would never match across them.
// `sp.sheet.generatedBuild` is the build made here; an author who replaces `build`
// afterwards is detectable as `sp.build !== sp.sheet.generatedBuild`.
//
// Likewise `sp.sheet.generatedPlace` is the place made here (the pose, then the author's
// own) and `sp.sheet.place` the author's own place, or null: the realistic look
// (materials/sheet-look.js) trusts a sheet's canonical frame only with no author place
// and `sp.place === sp.sheet.generatedPlace`.
//
// Placement (decision 10): the pose applies for display AND export, then the author's
// own `place` — so STEP/3MF/STL files of a sheet forge come out assembled.
import { RENAMED_KEYS, RESERVED_KEYS, SHEET_KEYS, SUBPART_PASSTHROUGH_KEYS } from "./constants.js";
import { validatePose } from "./pose.js";
import { applyPose, resolveSheet, sheetPreview } from "./resolve.js";
import { PROCESSES, PROCESS_IDS, processById } from "../process/registry.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const KNOWN = [...SHEET_KEYS, ...SUBPART_PASSTHROUGH_KEYS];
const KEY_LIST = `${SHEET_KEYS.join(", ")}, plus the sub-part keys ${SUBPART_PASSTHROUGH_KEYS.join(", ")}`;
const optionalFn = (v) => v === undefined || v === null || typeof v === "function";

// Every mistake throws here, at module load, naming the fix — in the order a reader
// would want them: the wrong-word keys first, then each field.
function checkSpec(spec) {
  if (!isPlainObject(spec)) throw new Error("sheetPart: expected an options object — sheetPart({ material, thickness, profile, views, … })");
  const keys = Object.keys(spec);
  if (keys.includes("kerf")) throw new Error("sheetPart: kerf is chosen when you download the kit — use a clearance control");
  const renamed = keys.find((key) => Object.hasOwn(RENAMED_KEYS, key));
  if (renamed) throw new Error(`sheetPart: "${renamed}" is not a sheetPart key — use ${RENAMED_KEYS[renamed]}`);
  if (keys.includes("quantity")) throw new Error('sheetPart: "quantity" is not a sheetPart key — the kit counts identical pieces');
  if (keys.includes("build")) throw new Error("sheetPart: sheetPart supplies build — draw the part with profile, score and engrave");
  const reservedKeys = [...RESERVED_KEYS, ...PROCESSES.flatMap((proc) => proc.reservedKeys ?? [])];
  const reserved = keys.find((key) => reservedKeys.includes(key));
  if (reserved) throw new Error(`sheetPart: "${reserved}" is reserved for a future process and not supported yet`);
  const unknown = keys.find((key) => !KNOWN.includes(key));
  if (unknown) throw new Error(`sheetPart: unknown key "${unknown}" — the keys are ${KEY_LIST}`);

  const process = spec.process ?? "laser";
  if (!processById(process)) throw new Error(`sheetPart: unknown process ${JSON.stringify(process)} — valid: ${PROCESS_IDS.join(", ")}`);
  const { material: m, thickness: t } = spec;
  if (!(typeof m === "function" || (typeof m === "string" && m.trim() !== "")))
    throw new Error('sheetPart: material must be a non-empty string or a (p, d) => string function — a stock label like "birch plywood"');
  if (!(typeof t === "function" || (typeof t === "number" && Number.isFinite(t) && t > 0)))
    throw new Error("sheetPart: thickness must be a number > 0 or a (p, d) => number function — the MEASURED sheet thickness in mm");
  if (typeof spec.profile !== "function") throw new Error("sheetPart: profile must be a function (k, p, d) => Shape2D or profile");
  if (!optionalFn(spec.score)) throw new Error("sheetPart: score must be a function (k, p, d) => [[x, y], [x, y]] lines and shapes, or omitted");
  if (!optionalFn(spec.engrave)) throw new Error("sheetPart: engrave must be a function (k, p, d) => Shape2D or profile (or null), or omitted");
  const pose = spec.pose;
  if (pose !== undefined && pose !== null && typeof pose !== "function") {
    if (!isPlainObject(pose)) throw new Error("sheetPart: pose must be a { face, up, at } object or a (p, d) => pose function");
    const reason = validatePose(pose);
    if (reason) throw new Error(`sheetPart: ${reason}`);
  }
  if (spec.place !== undefined && typeof spec.place !== "function") throw new Error("sheetPart: place must be a function (solid, ctx) => solid");
  return process;
}

export function sheetPart(spec) {
  const process = checkSpec(spec);
  const sub = {};
  for (const key of SUBPART_PASSTHROUGH_KEYS)
    if (key !== "place" && spec[key] !== undefined) sub[key] = spec[key];

  const generatedBuild = (k, p, d) => {
    const s = resolveSheet(k, sub, p, d);
    return (processById(s.process).preview ?? sheetPreview)(k, s);
  };

  // Placement (decision 10): the pose applies for display AND export, then the author's own
  // place. Made BEFORE the record is frozen, so the record can name it.
  const pose = spec.pose ?? null;
  const authorPlace = spec.place ?? null;
  const generatedPlace = pose !== null || authorPlace ? (solid, ctx) => {
    const resolved = typeof pose === "function" ? pose(ctx.p, ctx.d) : pose;
    let posed = solid;
    if (resolved !== null) {
      const reason = validatePose(resolved);
      if (reason) throw new Error(`sheet pose: ${reason}`);
      const t = typeof spec.thickness === "function" ? spec.thickness(ctx.p, ctx.d) : spec.thickness;
      posed = applyPose(solid, resolved, t);
    }
    return authorPlace ? authorPlace(posed, ctx) : posed;
  } : null;

  const sheet = Object.freeze({
    process,
    material: spec.material,
    thickness: spec.thickness,
    profile: spec.profile,
    score: spec.score ?? null,
    engrave: spec.engrave ?? null,
    pose,
    place: authorPlace,
    generatedBuild,
    generatedPlace,
  });
  sub.build = generatedBuild;
  if (generatedPlace) sub.place = generatedPlace;
  sub.sheet = sheet;
  return sub;
}
