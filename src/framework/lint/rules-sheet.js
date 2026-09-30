// Group 13 — sheet parts: sub-parts made with sheetPart() (partforge/geometry). A
// sheet part is recognised ONLY by its plain-data `sheet` declaration
// (isSheetPart), never by identity: in partforge-cloud's part worker the part's
// partforge/geometry and this linter are separate module instances, so an
// instanceof or a module-scoped Symbol would silently never match there.
//
// Every finding carries the guide section's id as `pattern` (SHEET_DOC_ID), and a
// hint that stands on its own in at most 500 characters — cloud's sanitizers cut
// message and hint there, and an agent whose copy of the guide was pruned from its
// history still has both. Error or warning only, never a note: cloud's lint
// sanitizer drops notes. The process registry adds each process's own rules
// (PROCESS_LINT_RULES: the laser thickness range today); these seven hold for any
// sheet process.
import { err, warn } from "./finding.js";
import { collectDescriptors } from "./rules-schema.js";
import { SHEET_DOC_ID, isSheetPart, fmtMm } from "../sheet/constants.js";
import { validatePose } from "../sheet/pose.js";
import { PROCESS_IDS, PROCESS_LINT_RULES } from "../process/registry.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const partEntries = (part) => (isPlainObject(part?.parts) ? Object.entries(part.parts) : []);
const messageOf = (e) => e?.message || String(e);
// A number prints as itself (NaN and Infinity included, which JSON would call null);
// anything else as JSON, which quotes a string.
const show = (v) => (typeof v === "number" ? String(v) : v === undefined ? "undefined" : JSON.stringify(v));

// What is wrong with a `sheet` declaration's SHAPE, or null. sheetPart() validates
// every field at module load, so this only ever fires on a hand-written or
// hand-edited declaration.
function sheetDeclarationProblem(sheet) {
  if (!isPlainObject(sheet)) return "sheet must be a plain object";
  if (!PROCESS_IDS.includes(sheet.process)) return `process must be one of: ${PROCESS_IDS.join(", ")}`;
  if (!(typeof sheet.material === "function" || (typeof sheet.material === "string" && sheet.material.trim() !== ""))) {
    return "material must be a non-empty string or a (p, d) => string function";
  }
  if (!(typeof sheet.thickness === "function" || typeof sheet.thickness === "number")) {
    return "thickness must be a number or a (p, d) => number function";
  }
  if (typeof sheet.profile !== "function") return "profile must be a (k, p, d) function";
  if (sheet.score != null && typeof sheet.score !== "function") return "score must be a (k, p, d) function or null";
  if (sheet.engrave != null && typeof sheet.engrave !== "function") return "engrave must be a (k, p, d) function or null";
  if (!(sheet.pose == null || typeof sheet.pose === "function" || isPlainObject(sheet.pose))) {
    return "pose must be a { face, up, at } object, a (p, d) function, or null";
  }
  return null;
}

// The sheet sub-parts whose VALUES the rules below judge: recognised, buildable, and
// well-formed. A malformed declaration is sheet-invalid's one error; judging its
// values as well would report one cause twice.
const judgedSheets = (part) => partEntries(part).filter(([, sp]) =>
  isSheetPart(sp) && typeof sp.build === "function" && sheetDeclarationProblem(sp.sheet) === null);

// `thickness` at lint's params: { value } or { threw }.
function thicknessAt(sheet, p, d) {
  try { return { value: typeof sheet.thickness === "function" ? sheet.thickness(p, d) : sheet.thickness }; }
  catch (e) { return { threw: messageOf(e) }; }
}
const validThickness = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

// The keys of `p` and `d` a thickness function reads, through recording proxies; null
// when it throws (sheet-thickness-invalid's business).
function thicknessReads(fn, p, d) {
  const read = new Set();
  const spy = (obj, tag) => new Proxy(obj ?? {}, {
    get(target, key, receiver) {
      if (typeof key === "string") read.add(`${tag}.${key}`);
      return Reflect.get(target, key, receiver);
    },
  });
  try { fn(spy(p, "p"), spy(d, "d")); } catch { return null; }
  return read;
}

const HINTS = {
  invalid: "Build laser-cut parts with `sheetPart({ material, thickness, profile, … })` from partforge/geometry instead of writing `sheet` by hand — it validates every field and supplies build and place. See \"Sheet parts\" in the authoring guide.",
  thickness: "Bind thickness to a measured-value control, e.g. `thickness: (p) => p.t` with a `t` number control defaulting to the measured sheet thickness (plywood sold as 3 mm is often 2.7–3.3).",
  pose: "A pose is { face, up, at }: face is the laser face's outward normal and up is the drawing's +y, each an axis word (+X, -X, +Y, -Y, +Z, -Z), perpendicular to each other; at is where drawing [0, 0] lands. A box's front panel: { face: \"-Y\", up: \"+Z\", at: [-W/2, -D/2, 0] }. fingerBox() computes every panel's pose.",
  literal: "Sheet stock varies ±0.3–0.5 mm from its nominal size; bind thickness to the measured-value control (thickness: (p) => p.t, with a t control the user sets to what they measured) so every joint fits the sheet they actually have.",
  kerf: "Kerf is chosen when the cut & print kit is downloaded (it offsets the cut lines only), so a kerf control double-counts it. Use a clearance control instead: joinery clearance is the finished joint's total play.",
  customBuild: "The cut file is drawn from profile, score and engrave, never from build, so a custom build can drift from what gets cut; verify compares its volume with the profile (sheetSolidMatch). Change the profile, not the solid.",
  sheetsOnly: "A process profile checks 3D-printed parts (bed fit, min wall); sheet parts get the laser checks automatically. Remove verify.process, or keep it only when the forge also has printed parts. There is no \"laser\" profile.",
};

export const SHEET_RULES = [
  {
    // Skipped when `build` is missing: no-buildable-parts owns that case, and its hint
    // already points at sheetPart(), so one cause never gives two blocking errors.
    id: "sheet-invalid",
    run: ({ part }) => partEntries(part)
      .filter(([, sp]) => isPlainObject(sp) && sp.sheet !== undefined && typeof sp.build === "function")
      .flatMap(([name, sp]) => {
        const reason = sheetDeclarationProblem(sp.sheet);
        return reason ? [err("sheet-invalid", `sub-part "${name}" has a malformed \`sheet\` declaration: ${reason}`,
          HINTS.invalid, `parts.${name}.sheet`, SHEET_DOC_ID)] : [];
      }),
  },
  {
    id: "sheet-thickness-invalid",
    run: ({ part, p, d, deriveError }) => (deriveError ? [] : judgedSheets(part).flatMap(([name, sp]) => {
      const t = thicknessAt(sp.sheet, p, d);
      if ("threw" in t) {
        return [err("sheet-thickness-invalid", `sub-part "${name}": sheet thickness threw at the defaults: ${t.threw}`,
          HINTS.thickness, `parts.${name}.sheet.thickness`, SHEET_DOC_ID)];
      }
      return validThickness(t.value) ? [] : [err("sheet-thickness-invalid",
        `sub-part "${name}": sheet thickness is ${show(t.value)} at the defaults — it must be a finite number above 0 (mm)`,
        HINTS.thickness, `parts.${name}.sheet.thickness`, SHEET_DOC_ID)];
    })),
  },
  {
    // A pose function that throws, or returns nothing, is left to the build rules:
    // the generated build resolves the pose, so build-throws already names it.
    id: "sheet-pose-invalid",
    run: ({ part, p, d, deriveError }) => (deriveError ? [] : judgedSheets(part).flatMap(([name, sp]) => {
      const raw = sp.sheet.pose;
      if (raw == null) return [];
      let pose;
      try { pose = typeof raw === "function" ? raw(p, d) : raw; } catch { return []; }
      if (pose == null) return [];
      const reason = validatePose(pose);
      return reason ? [err("sheet-pose-invalid", `sub-part "${name}": sheet pose is invalid at the defaults — ${reason}`,
        HINTS.pose, `parts.${name}.sheet.pose`, SHEET_DOC_ID)] : [];
    })),
  },
  {
    id: "sheet-thickness-literal",
    run: ({ part, p, d, deriveError }) => (deriveError ? [] : judgedSheets(part).flatMap(([name, sp]) => {
      const t = thicknessAt(sp.sheet, p, d);
      if ("threw" in t || !validThickness(t.value)) return [];   // sheet-thickness-invalid's
      if (typeof sp.sheet.thickness === "function") {
        const read = thicknessReads(sp.sheet.thickness, p, d);
        if (read === null || read.size > 0) return [];
      }
      return [warn("sheet-thickness-literal", `sub-part "${name}": sheet thickness is a fixed number (${fmtMm(t.value)} mm)`,
        HINTS.literal, `parts.${name}.sheet.thickness`, SHEET_DOC_ID)];
    })),
  },
  {
    id: "sheet-kerf-control",
    run: ({ part }) => {
      if (!partEntries(part).some(([, sp]) => isSheetPart(sp))) return [];
      return collectDescriptors(part)
        .filter(({ d: c, container }) => !container && c && [c.key, c.label].some((v) => typeof v === "string" && /kerf/i.test(v)))
        .map(({ d: c, path }) => warn("sheet-kerf-control", `control "${c.key ?? c.label}" looks like a kerf setting`,
          HINTS.kerf, path, SHEET_DOC_ID));
    },
  },
  {
    id: "sheet-custom-build",
    run: ({ part }) => judgedSheets(part)
      .filter(([, sp]) => sp.build !== sp.sheet.generatedBuild)
      .map(([name]) => warn("sheet-custom-build", `sub-part "${name}" replaces the build sheetPart generated`,
        HINTS.customBuild, `parts.${name}.build`, SHEET_DOC_ID)),
  },
  {
    // A process id ("laser") is verify-unknown-process's error, with a sheet hint of
    // its own — not also this warning.
    id: "verify-process-sheets-only",
    run: ({ part }) => {
      const process = part?.verify?.process;
      if (!process) return [];
      if (typeof process === "string" && PROCESS_IDS.includes(process)) return [];
      const exportable = partEntries(part).filter(([, sp]) => isPlainObject(sp) && sp.exportable !== false);
      if (exportable.length === 0 || !exportable.every(([, sp]) => isSheetPart(sp))) return [];
      const named = typeof process === "string" ? `"${process}"` : "an inline profile";
      return [warn("verify-process-sheets-only", `\`verify.process\` is ${named}, but every exportable part is a sheet part`,
        HINTS.sheetsOnly, "verify.process", SHEET_DOC_ID)];
    },
  },
  ...PROCESS_LINT_RULES,
];
