// routedPart(spec) — a sub-part CNC-routed from flat stock: the profile is the through
// cut, pockets are flat-floored regions at a depth, drills are round holes at a depth
// (through when depth >= thickness), and `extra` entries are operations the operator
// does with another tool after the flat milling (a tilted slot, a scooped thumb hold):
// a solid for the preview and the STEP, a footprint for the drawing, a label and a
// method for the README. It is sheetPart with process "cnc-router": one model, so the
// assembly, the renders, the STEP and the kit all read the same declaration.
//
// Every mistake throws here, at module load, naming the fix. The per-(p, d) shapes are
// resolved in resolveRouted (./routed-resolve.js), called by sheet/resolve.js for this process.
import { sheetPart } from "./part.js";
import { ROUTED_KEYS } from "./constants.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const optionalFn = (v) => v === undefined || v === null || typeof v === "function";

const SIGNATURES = {
  pockets: "pockets must be a function (k, p, d) => [{ region, depth, label? }], or omitted",
  drills: "drills must be a function (p, d) => [{ at: [x, y], d, depth, label? }], or omitted",
  extra: "extra must be a function (k, p, d) => [{ solid, footprint, label, method }], or omitted",
  reference: "reference must be a function (k, p, d) => [[x, y], [x, y]] lines and shapes, or omitted",
};

export function checkRoutedSpec(spec) {
  if (!isPlainObject(spec)) throw new Error("routedPart: expected an options object — routedPart({ material, thickness, profile, pockets, drills, views, … })");
  const keys = Object.keys(spec);
  if (keys.includes("score")) throw new Error('routedPart: "score" is not a routedPart key — centerlines and layout marks go in `reference`');
  if (keys.includes("engrave")) throw new Error('routedPart: "engrave" is not a routedPart key — a routed part has no engraving; a shallow pocket is `pockets`');
  if (keys.includes("process")) throw new Error('routedPart: "process" is not a routedPart key — routedPart is always the cnc-router process');
  for (const key of ROUTED_KEYS) {
    if (!optionalFn(spec[key])) throw new Error(`routedPart: ${SIGNATURES[key]}`);
  }
}

export function routedPart(spec) {
  checkRoutedSpec(spec);
  const { reference, ...rest } = spec;
  try {
    return sheetPart({ ...rest, process: "cnc-router", ...(reference ? { score: reference } : {}) });
  } catch (e) {
    // sheetPart's own refusals, re-labelled so the author sees the helper they called.
    throw new Error(String(e.message).replace(/^sheetPart:/, "routedPart:"), { cause: e });
  }
}
