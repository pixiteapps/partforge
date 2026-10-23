// The process registry: every manufacturing process a sheet part can name. Adding a
// process is one folder under process/, one line here and one line in
// process/exporters.js.
//
// Import-free apart from the descriptors and sheet/constants.js, for the same reason
// the descriptors are: lint and the oracle read this file.
import { isSheetPart } from "../sheet/constants.js";
import { LASER } from "./laser/descriptor.js";
import { ROUTER } from "./cnc-router/descriptor.js";
import { FDM } from "./fdm/descriptor.js";
import { RESIN } from "./resin/descriptor.js";

export const PROCESSES = [LASER, ROUTER];
export const PROCESS_IDS = PROCESSES.map((d) => d.id);

export const processById = (id) => PROCESSES.find((d) => d.id === id) ?? null;

// The process a sub-part is made by, or null for a printed (non-sheet) sub-part.
export const processFor = (sp) => (isSheetPart(sp) ? processById(sp.sheet.process) : null);

// Every process's verify metrics as one flat vocabulary; verify-metrics.js spreads it
// into SUBPART_METRICS. Process metric names must not collide with each other or with
// a print metric (test/verify-metrics.test.js).
export const SHEET_METRICS = Object.assign({}, ...PROCESSES.map((d) => d.metrics));

// Every process's own lint rules; lint/rules-sheet.js appends them to SHEET_RULES.
export const PROCESS_LINT_RULES = PROCESSES.flatMap((d) => d.lintRules);

// Print processes are their own list: PROCESSES stays the SHEET list (exporters,
// destinations, SHEET_METRICS and sheet/part.js's PROCESS_IDS check all read it), so
// fdm and resin never pass as a sheet part's process.
export const PRINT_PROCESSES = [FDM, RESIN];
export const PRINT_PROCESS_IDS = PRINT_PROCESSES.map((d) => d.id);
export const ALL_PROCESSES = [...PROCESSES, ...PRINT_PROCESSES];

export const printProcessById = (id) => PRINT_PROCESSES.find((d) => d.id === id) ?? null;

// The DFM profiles of every print process as one map, keyed by profile id.
export const PRINT_PROFILES = Object.freeze(Object.assign({}, ...PRINT_PROCESSES.map((d) => d.profiles)));

// The print process owning a profile spec: a profile id, or an inline object whose
// `base` (recursively) names one. Anything else is null.
export function printProcessFor(spec) {
  let id = spec;
  while (id && typeof id === "object") id = id.base;
  if (typeof id !== "string") return null;
  return PRINT_PROCESSES.find((d) => Object.hasOwn(d.profiles, id)) ?? null;
}
