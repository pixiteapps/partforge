// Public entry for `partforge/lint`. Deliberately separate from `partforge/testing`,
// whose entry pulls in the WASM kernels and cannot load in a browser sandbox.
export { lintPart, RULES } from "./framework/lint/index.js";
// The ids of the rules that read SOURCE rather than the evaluated part. Hosts
// that gate rendering on lint errors (partforge-cloud's sandbox loader) use
// this to keep source findings REPORTED but non-blocking: a persistence
// defect must not stop a legacy part from rendering.
export { SOURCE_RULE_IDS } from "./framework/lint/rules-source.js";
// The domain registry for hosts: `DOMAINS` as names only (JSON-able), and
// `domainsOf(sources)`, the domains a part's source uses — what tells a host which
// domain guides to load for an existing part (docs/superpowers/specs/
// 2026-10-29-domain-modules-design.md, "What a host gets").
export { DOMAINS, domainsOf } from "./framework/lint/domains-of.js";
