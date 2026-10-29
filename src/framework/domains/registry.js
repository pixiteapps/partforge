// The domain registry: the ONE table core reads to learn what domains exist
// (docs/superpowers/specs/2026-10-29-domain-modules-design.md). A domain is a folder
// under src/framework/domains/<id>/ with a manifest (plain data plus functions) and an
// index.js published as `partforge/<id>`; core folds the manifests in through this
// list and never imports a domain folder by name (test/domain-layering.test.js).
//
// Import-free apart from the manifests, because lint, the oracle, the worker and the
// CLI all load it: a manifest that booted a kernel or touched the DOM on import would
// break every one of them.
const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const STRING_FIELDS = ["title", "when", "subpath", "guide"];
const ARRAY_FIELDS = ["referenceParts", "kernelOps", "lintRules", "processes"];
// A domain's facts land on every measure() row under its id, so an id that names an
// existing row key would overwrite a core fact.
const RESERVED_IDS = new Set(["sheet", "print", "name", "bbox", "bounds", "volume"]);
const PROCESS_KINDS = new Set(["sheet", "print"]);

const fail = (msg) => { throw new Error(`domains: ${msg}`); };

// Validates a list of manifests and returns it frozen. Every refusal names the
// manifest and the field, since the message is what a domain author reads.
export function validateDomains(list) {
  const seen = new Set();
  for (const m of list) {
    if (!m || typeof m !== "object") fail(`a manifest is not an object`);
    const { id } = m;
    if (typeof id !== "string" || !ID_RE.test(id)) fail(`id ${JSON.stringify(id)} is not kebab-case`);
    if (RESERVED_IDS.has(id)) fail(`id "${id}" is reserved (a measure row key)`);
    if (seen.has(id)) fail(`duplicate id "${id}"`);
    seen.add(id);
    for (const f of STRING_FIELDS) {
      if (typeof m[f] !== "string" || !m[f]) fail(`"${id}" is missing "${f}"`);
    }
    for (const f of ARRAY_FIELDS) {
      if (!Array.isArray(m[f])) fail(`"${id}" is missing "${f}" (an array)`);
    }
    const o = m.oracle;
    if (!o || typeof o !== "object") fail(`"${id}" is missing "oracle"`);
    if (o.facts !== null && typeof o.facts !== "function") fail(`"${id}" oracle.facts must be null or a function`);
    if (!o.metrics || typeof o.metrics !== "object") fail(`"${id}" is missing "oracle.metrics"`);
    if (!Array.isArray(o.checks)) fail(`"${id}" is missing "oracle.checks"`);
    if (typeof m.workerSafe !== "boolean") fail(`"${id}" is missing "workerSafe"`);
    for (const op of m.kernelOps) {
      if (typeof op?.name !== "string" || typeof op?.attach !== "function") fail(`"${id}" kernelOps entries are { name, attach }`);
    }
    for (const p of m.processes) {
      if (!PROCESS_KINDS.has(p?.kind)) fail(`"${id}" process ${JSON.stringify(p?.id)} has no kind "sheet" | "print"`);
    }
  }
  return Object.freeze([...list]);
}

// Empty on main: the kinematics domain (the limb helper's PR) adds the first line.
export const DOMAINS = validateDomains([]);
