// The control-type registry. Declaring a type here is what makes it real: the
// renderer looks up its DOM factory by type, and partforge/lint derives its
// accepted-field list from `fields` instead of hardcoding one.
//
// Before this existed, rules-schema.js carried three hand-maintained allow-lists
// (CONTROL_FIELDS / FEATURE_FIELDS / TOGGLE_FIELDS) that had to be edited in
// lockstep with the renderer — and when they weren't, `unknown-control-field`
// warned on legitimate fields. Adding a type or a field is now one edit here.
//
// The lists deliberately mirror the legacy lint allow-lists EXACTLY: `when`,
// `whenFalse` and `type` are NOT accepted yet — they join when the phases that
// make them functional land (type: phase 4; when/whenFalse: phase 6). Accepting
// a field the panel ignores would trade one silent-dead-field bug for another.
//
// Imports nothing: lint consumes this and test/lint-purity.test.js requires a
// dependency-free closure.

// What legacy rules-schema.js called CONTROL_FIELDS: every descriptor that can
// appear in `advanced` or a feature's `sliders`, whatever its `control` value.
const LEGACY_CONTROL = ["key", "label", "unit", "min", "max", "step", "control", "hidden", "description"];
// What it called TOGGLE_FIELDS.
const LEGACY_TOGGLE = ["key", "label", "on", "hidden", "description"];

// The authored shape (author.js's normalized node tree): every control carries
// `type`, and `when`/`whenFalse` are real fields there (phase 6 landed them for
// this shape only — the legacy lists above stay frozen so a legacy `when` still
// warns). select/radio are new-shape-only types (no legacy equivalent), so
// their WIDGET_SPECS `fields` use this list directly rather than a legacy one.
const AUTHOR_COMMON = ["key", "type", "label", "description", "hidden", "when", "whenFalse"];

export const WIDGET_SPECS = [
  { type: "slider", kind: "control", fields: LEGACY_CONTROL },
  { type: "number", kind: "control", fields: LEGACY_CONTROL },
  { type: "text", kind: "control", fields: LEGACY_CONTROL },
  { type: "textarea", kind: "control", fields: LEGACY_CONTROL },
  { type: "checkbox", kind: "control", fields: LEGACY_TOGGLE },
  { type: "select", kind: "control", fields: [...AUTHOR_COMMON, "options"] },
  { type: "radio", kind: "control", fields: [...AUTHOR_COMMON, "options"] },
  { type: "font", kind: "control", fields: [...AUTHOR_COMMON, "allow", "preview", "sourceField"] },
  { type: "image", kind: "control", fields: [...AUTHOR_COMMON, "allow", "sourceField"] },
  { type: "vector", kind: "control", fields: [...AUTHOR_COMMON, "allow", "sourceField"] },
  { type: "custom", kind: "control", fields: [...AUTHOR_COMMON, "widget", "keys"] },
  { type: "readout", kind: "display", fields: ["type", "label", "description", "unit", "derivedKey", "hidden", "when", "whenFalse"] },
];

const BY_TYPE = new Map(WIDGET_SPECS.map((s) => [s.type, s]));

export const WIDGET_TYPES = WIDGET_SPECS.map((s) => s.type);
export const specFor = (type) => BY_TYPE.get(type);
export const fieldsFor = (type) => BY_TYPE.get(type)?.fields ?? [];

// Per-type extras beyond AUTHOR_COMMON.
const AUTHOR_EXTRAS = {
  slider: ["unit", "min", "max", "step", "scale", "ticks", "snap", "recommended"],
  number: ["unit", "min", "max", "step", "scale", "ticks", "snap", "recommended"],
  text: [],
  textarea: [],
  checkbox: ["on"],
  select: ["options"],
  radio: ["options"],
  font: ["allow", "preview", "sourceField"],
  image: ["allow", "sourceField"],
  vector: ["allow", "sourceField"],
  custom: ["widget", "keys"],
};
const AUTHOR_FIELDS = new Map(Object.entries(AUTHOR_EXTRAS).map(
  ([type, extra]) => [type, [...AUTHOR_COMMON, ...extra]]));
// readout is a display, not a control — it has no `key`, so it doesn't compose
// with AUTHOR_COMMON like the control types above. Its author-facing fields
// are exactly its WIDGET_SPECS fields.
AUTHOR_FIELDS.set("readout", specFor("readout").fields);
// An unrecognised type (a typo like "sldier") falls back to AUTHOR_COMMON
// rather than []: with [], every field on the descriptor — including "key"
// and "label" — reads as unrecognised, so a single typo cascades into a wall
// of unknown-control-field warnings with nothing pointing at the real cause.
// lint's unknown-control-type rule (rules-schema.js) is what actually names
// the typo; this fallback just keeps the field-level noise from drowning it.
export const authorFieldsFor = (type) => AUTHOR_FIELDS.get(type) ?? AUTHOR_COMMON;

// Container node types in the authored tree. Not widget types — no DOM factory
// looks them up — so, like the legacy FEATURE_FIELDS/TOGGLE_FIELDS, they keep
// explicit field lists here rather than living in WIDGET_SPECS.
export const GROUP_FIELDS = ["type", "id", "title", "collapsed", "bare", "when", "whenFalse", "hidden", "controls"];
// NB: no "description" — renderGroup has nowhere to hang an info glyph (the
// toggle is itself a button). Sections keep descriptions (SECTION_FIELDS).
export const PRESET_FIELDS = ["type", "id", "label", "presets", "when", "whenFalse", "hidden"];
// A section itself, in the authored shape — collectDescriptors pushes it as a
// descriptor only when it carries a `when`, so `when-key-not-in-defaults` and
// `when-unknown-operator` cover section-level conditions too.
export const SECTION_FIELDS = ["id", "title", "description", "hidden", "collapsed", "when", "whenFalse", "controls"];

// select/radio option normalization: long form [{ value, label?, description? }]
// or shorthand ["round", 8, ...] where each entry is both value and label. Lives
// here rather than in the select widget because lint's validators consume it
// and must stay DOM-free (widgets/select.js imports info.js -> markdown.js).
export function normalizeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .filter((o) => o != null)
    .map((o) => (typeof o === "object"
      ? { value: o.value, label: o.label ?? String(o.value), description: o.description }
      : { value: o, label: String(o) }));
}
