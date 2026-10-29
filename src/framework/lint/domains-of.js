// The host-facing half of the domain registry (src/framework/domains/registry.js),
// published through partforge/lint:
//
//   - DOMAINS: the registry projected to NAMES ONLY (id, title, when, subpath, guide,
//     the tagged kernel op names) — no functions, so a host can JSON it into a prompt
//     or a corpus generator can read it instead of regex-parsing kernel.js.
//   - domainsOf(sources): the domains a part's SOURCE uses, so a host opening an
//     existing part knows which domain guides to load. A domain counts when any file
//     statically imports (or re-exports from) its subpath, or calls one of its tagged
//     ops. Prose, string literals and dynamic import() do not count: a comment or a
//     string that names a subpath is not a use.
//
// Deliberately forgiving on input, like the rest of lint: malformed sources mean
// "no domains", never a throw.
import { DOMAINS as REGISTRY } from "../domains/registry.js";
import { stripNonCode } from "./source-scan.js";

export const DOMAINS = Object.freeze(REGISTRY.map((d) => Object.freeze({
  id: d.id, title: d.title, when: d.when, subpath: d.subpath, guide: d.guide,
  kernelOps: d.kernelOps.map((op) => op.name),
})));

// Comments only (strings stay, since the import specifier IS a string). The same
// rule test/helpers/import-graph.js uses: the `[^:"'`\\]` guard keeps a `//` inside
// a URL literal from eating the rest of the line.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `import … from "<subpath>"`, `export … from "<subpath>"`, `import "<subpath>"` —
// static forms only, at a statement start.
const importsSubpath = (code, subpath) => {
  const q = `["']${escapeRe(subpath)}["']`;
  return new RegExp(`^\\s*(?:import|export)\\b[^;]*?\\bfrom\\s*${q}`, "m").test(code)
    || new RegExp(`^\\s*import\\s*${q}`, "m").test(code);
};

const callsOp = (code, name) => new RegExp(`\\.${escapeRe(name)}\\s*\\(`).test(code);

export function domainsOf(sources) {
  let files;
  try {
    const raw = sources?.files;
    if (!raw || typeof raw !== "object") return [];
    files = Object.values(raw).filter((t) => typeof t === "string");
  } catch {
    return [];
  }
  if (!files.length) return [];
  const found = new Set();
  for (const text of files) {
    const noComments = stripComments(text);
    const codeOnly = stripNonCode(text);
    for (const d of REGISTRY) {
      if (found.has(d.id)) continue;
      if (importsSubpath(noComments, d.subpath) || d.kernelOps.some((op) => callsOp(codeOnly, op.name))) found.add(d.id);
    }
  }
  return [...found].sort();
}
