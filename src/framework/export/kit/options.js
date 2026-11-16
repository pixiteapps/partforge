// The kit's sections and their options. A section is one kind of output: `3d` (model
// files of any part), and one CUT section per sheet process that has an exporter and a
// folder — `laser` and `cnc-router` today. Each section's options are checked here,
// MEANING included, before anything is built; every refusal starts with
// KIT_OPTIONS_ERROR and names the section, so a host can send the person back to that
// section's settings.
//
// No geometry and no paper: process/exporters.js is a table of lazy loaders.
import { EXPORTER_LOADERS } from "../../process/exporters.js";
import {
  KIT_OPTIONS_ERROR, KIT_DEFAULTS, KIT_LIMITS, isPlainObject, inRange, normalizeStock,
} from "../formats.js";

// A cut section's folder in the kit. A process with an exporter but no folder here has
// no section: its parts are in the 3D section only.
export const SECTION_FOLDERS = Object.freeze({ laser: "laser", "cnc-router": "cnc" });

// How a section is shown, and the word for one of its parts (`none of the checked
// parts is a laser-cut part`).
export const SECTION_LABELS = Object.freeze({ "3d": "3D files", laser: "Laser-cut parts", "cnc-router": "CNC-routed parts" });
export const SECTION_NOUNS = Object.freeze({ "3d": "3D", laser: "laser-cut", "cnc-router": "CNC-routed" });

// The cut sections, in the process registry's order.
export const cutSectionIds = () => Object.keys(EXPORTER_LOADERS).filter((id) => Object.hasOwn(SECTION_FOLDERS, id));
export const sectionIds = () => ["3d", ...cutSectionIds()];

// Each section's options: a key's allowed `values` or numeric `range` (mm), and its
// default. `stock` is checked by normalizeStock and has neither.
const SHEET_LAYOUT = {
  stock: { default: KIT_DEFAULTS.stock },
  margin: { range: KIT_LIMITS.margin, default: KIT_DEFAULTS.margin },
  spacing: { range: KIT_LIMITS.spacing, default: KIT_DEFAULTS.spacing },
};
const SCHEMAS = {
  "3d": { format: { values: ["stl", "3mf", "step"], default: "stl" } },
  laser: {
    destination: { values: ["own-laser", "service"], default: KIT_DEFAULTS.destination },
    kerf: { range: KIT_LIMITS.kerf, default: KIT_DEFAULTS.kerf },
    colors: { values: ["lightburn"], default: KIT_DEFAULTS.colors },
    ...SHEET_LAYOUT,
  },
  "cnc-router": {
    ...SHEET_LAYOUT,
    flip: { values: ["left-right", "end-over-end"], default: KIT_DEFAULTS.flip },
    twoSided: { values: ["one-file", "two-files"], default: KIT_DEFAULTS.twoSided },
  },
};

const fail = (message) => new Error(`${KIT_OPTIONS_ERROR} ${message}`);

function schemaOf(id) {
  if (typeof id === "string" && sectionIds().includes(id) && Object.hasOwn(SCHEMAS, id)) return SCHEMAS[id];
  throw fail(`unknown section ${JSON.stringify(id)} — the sections are ${sectionIds().join(", ")}`);
}

// "a" / "a" or "b" / "a", "b" or "c", each JSON-quoted — validateKitOptions' wording.
const choices = (values) => {
  const q = values.map((v) => JSON.stringify(v));
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} or ${q.at(-1)}` : q[0];
};

// A section's schema as plain data, a fresh copy each call.
export function sectionOptionSchema(id) {
  return structuredClone(schemaOf(id));
}

// A section's options, checked, as a fresh, fully populated object. `undefined` means
// every default.
export function validateSectionOptions(id, options) {
  const schema = schemaOf(id);
  const refuse = (message) => fail(`${SECTION_LABELS[id]}: ${message}`);
  const opts = options === undefined ? {} : options;
  if (!isPlainObject(opts)) throw refuse("options must be an object");
  const keys = Object.keys(schema);
  for (const key of Object.keys(opts))
    if (!keys.includes(key)) throw refuse(`unknown option ${JSON.stringify(key)} — the options are ${keys.join(", ")}`);
  const out = {};
  for (const [key, spec] of Object.entries(schema)) {
    const v = opts[key] === undefined ? spec.default : opts[key];
    if (key === "stock") out.stock = normalizeStock(v, refuse);
    else if (spec.values && !spec.values.includes(v)) throw refuse(`${key} must be ${choices(spec.values)}, got ${JSON.stringify(v)}`);
    else if (spec.range && !inRange(v, spec.range))
      throw refuse(`${key} must be a number from ${spec.range[0]} to ${spec.range[1]} mm, got ${JSON.stringify(v)}`);
    else out[key] = v;
  }
  return out;
}

// How many of each cut piece: one kit-wide number, 1 by default.
export function validateSets(sets) {
  const v = sets === undefined ? KIT_DEFAULTS.sets : sets;
  const [lo, hi] = KIT_LIMITS.sets;
  if (!Number.isInteger(v) || v < lo || v > hi) throw fail(`sets must be a whole number from ${lo} to ${hi}, got ${JSON.stringify(v)}`);
  return v;
}
