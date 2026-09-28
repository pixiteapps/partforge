// The process registry: every manufacturing process a sheet part can name. Adding a
// process is one folder under process/, one line here and one line in
// process/exporters.js.
//
// Import-free apart from the descriptors and sheet/constants.js, for the same reason
// the descriptors are: lint and the oracle read this file.
import { isSheetPart } from "../sheet/constants.js";
import { LASER } from "./laser/descriptor.js";

export const PROCESSES = [LASER];
export const PROCESS_IDS = PROCESSES.map((d) => d.id);

export const processById = (id) => PROCESSES.find((d) => d.id === id) ?? null;

// The process a sub-part is made by, or null for a printed (non-sheet) sub-part.
export const processFor = (sp) => (isSheetPart(sp) ? processById(sp.sheet.process) : null);
