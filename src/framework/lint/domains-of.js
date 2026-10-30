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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The static import/export-from statements of a file, as specifier strings. Statement
// starts are found on stripNonCode(text) — strings, template literals and comments
// masked to spaces at the SAME offsets, so a `from "…"` inside a string or a template
// can never start or end a match, and a quote always terminates the clause — then each
// specifier is read out of the original text at the opening quote's offset.
const STATIC_IMPORT = /^[ \t]*(?:import|export)\b[^;"'`]*?\bfrom[ \t]*(["'])|^[ \t]*import[ \t]*(["'])/gm;
function staticSpecifiers(text, masked) {
  const out = [];
  for (const m of masked.matchAll(STATIC_IMPORT)) {
    const quote = m[1] ?? m[2];
    const open = m.index + m[0].length - 1;
    const close = text.indexOf(quote, open + 1);
    if (close === -1) continue;
    out.push(text.slice(open + 1, close));
  }
  return out;
}

const callsOp = (masked, name) => new RegExp(`\\.${escapeRe(name)}\\s*\\(`).test(masked);

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
    const masked = stripNonCode(text);
    const specifiers = new Set(staticSpecifiers(text, masked));
    for (const d of REGISTRY) {
      if (found.has(d.id)) continue;
      if (specifiers.has(d.subpath) || d.kernelOps.some((op) => callsOp(masked, op.name))) found.add(d.id);
    }
  }
  return [...found].sort();
}
