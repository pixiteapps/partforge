// Public entry for `partforge/panel-values`: the value contract of a
// `type: "custom"` control, for hosts that persist panel settings (partforge-
// cloud rewrites `defaults` with these). Dependency-free, DOM-free, tiny — a
// host imports this without pulling partforge/lint's rule set into its bundle.
export { isJsonValue, jsonValueProblem, CUSTOM_VALUE_MAX_BYTES, CUSTOM_VALUE_MAX_DEPTH } from "./framework/panel/json-value.js";
export { readJsonLiteral, writeJsonLiteral } from "./framework/lint/source-scan.js";
