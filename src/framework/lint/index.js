// partforge/lint — static PartDefinition validation. Pure: no I/O, no async, and
// (load-bearing) an import closure that never reaches three / manifold-3d / replicad,
// so this runs unchanged in Node, a browser sandbox iframe, and Deno. The purity
// guarantee is enforced by test/lint-purity.test.js — read it before adding an import.
//
// A rule is { id, run(ctx) → Finding[] }, one rule object per finding id, so the
// registry doubles as the documented rule catalog. Rules are cheap and parts are
// tiny; clarity beats sharing a walk between rules.
import { resolveDerived } from "../derive.js";
import { err, warn } from "./finding.js";
import { SHAPE_RULES } from "./rules-shape.js";
import { SCHEMA_RULES } from "./rules-schema.js";
import { runValidatingProbe } from "../geometry/probe.js";
import { BUILD_RULES } from "./rules-build.js";
import { VERIFY_RULES, resolveExpect } from "./rules-verify.js";
import { ANIMATION_RULES } from "./rules-animations.js";
import { PLACE_RULES } from "./rules-place.js";
import { IMPORT_RULES } from "./rules-imports.js";
import { FONT_RULES } from "./rules-fonts.js";
import { IMAGE_RULES } from "./rules-images.js";
import { SOURCE_RULES } from "./rules-source.js";
import { VECTOR_RULES } from "./rules-vector.js";
import { MATERIAL_RULES } from "./rules-materials.js";

export const RULES = [...SHAPE_RULES, ...SCHEMA_RULES, ...BUILD_RULES, ...VERIFY_RULES, ...ANIMATION_RULES, ...PLACE_RULES, ...IMPORT_RULES, ...FONT_RULES, ...IMAGE_RULES, ...SOURCE_RULES, ...VECTOR_RULES, ...MATERIAL_RULES];

// A usable sources input, or null. Deliberately forgiving: lintPart's callers
// include hosted paths handing over user/LLM-authored trees, so a malformed
// shape means "no source rules", never a throw. Non-string file values are
// dropped per entry rather than voiding the whole map.
function normalizeSources(sources) {
  if (!sources || typeof sources !== "object") return null;
  const rawFiles = sources.files;
  if (!rawFiles || typeof rawFiles !== "object") return null;
  // Null-prototype so a file literally keyed `__proto__` is KEPT as an own
  // property: `{}["__proto__"] = text` would set the prototype instead, quietly
  // dropping that file from the scan while still counting toward `any`.
  const files = Object.create(null);
  let any = false;
  for (const [path, text] of Object.entries(rawFiles)) {
    if (typeof text !== "string") continue;
    files[path] = text;
    any = true;
  }
  if (!any) return null;
  const entrypoint = typeof sources.entrypoint === "string" ? sources.entrypoint : Object.keys(files)[0];
  return { files, entrypoint };
}

// The caller's parsed vector files, or null. Deliberately forgiving for the same
// reason normalizeSources is: hosted callers hand over user- and agent-authored
// trees, and a malformed input must mean "no document-dependent findings",
// never a throw. Lint itself never reads a file — it is pure and synchronous by
// contract (see this file's header); the caller does the I/O and passes the
// result in.
function normalizeVectorDocs(docs) {
  if (!docs || typeof docs !== "object") return null;
  const out = Object.create(null);
  let any = false;
  for (const [name, doc] of Object.entries(docs)) {
    if (!doc || typeof doc !== "object") continue;
    out[name] = doc;
    any = true;
  }
  return any ? out : null;
}

// Every rule runs inside a guard. lintPart is called on a user-facing hosted path
// (partforge-cloud's sandbox), and a linter that takes down the preview it exists to
// protect is worse than no linter — so a throwing rule becomes a WARNING, never an
// error, and never blocks a part that would otherwise have built.
export function runRules(rules, ctx) {
  const out = [];
  for (const rule of rules) {
    try {
      const found = rule.run(ctx);
      if (Array.isArray(found)) out.push(...found);
    } catch (e) {
      out.push(warn("internal-rule-error",
        `lint rule "${rule.id}" threw: ${e?.message || String(e)}`,
        "This is a partforge bug rather than a problem with your part; every other rule still ran. Please report it with the part that triggered it."));
    }
  }
  return out;
}

// Build the shared context. A throwing derive() must not abort the lint — the
// throw is captured as `deriveError` (for Group 3's `derive-throws` rule) and `d`
// falls back to {}, so Groups 1/2/4 remain useful without derived values.
//
// Building `p` can itself throw — `part.defaults` may be a getter that throws, or
// `part.defaults` / `params` may be a Proxy whose `ownKeys` trap throws (the spread
// below walks own keys) — so that construction gets the same never-escapes
// treatment as derive(): fall back to `{}` rather than let a hostile/broken input
// take down lintContext (and, by extension, lintPart — see its own guard below).
// The failure is also captured as `pError`, mirroring `deriveError`, so lintPart
// can still surface it as a real finding instead of silently linting against an
// empty `{}` params object as if nothing were wrong.
export function lintContext(part, params) {
  let p;
  let pError = null;
  try { p = { ...(part?.defaults ?? {}), ...(params ?? {}) }; }
  catch (e) { p = {}; pError = e?.message || String(e); }
  let d = {};
  let deriveError = null;
  try { d = resolveDerived(part ?? {}, p) ?? {}; } catch (e) { d = {}; deriveError = e?.message || String(e); }
  let cached = null;
  const probe = () => (cached ??= runValidatingProbe(part, p, d));
  const probeAgain = () => runValidatingProbe(part, p, d);
  // Group 4's several rules all need `verify.expect` resolved; `expect` may be a
  // user-supplied function, so — same reasoning as `probe` above — resolve it once
  // per lint pass and share it, rather than letting each rule invoke it again and
  // risk a cascading double-report from a function that only throws sometimes.
  let cachedExpect = null;
  const resolveExpectOnce = () => (cachedExpect ??= resolveExpect(part?.verify, p, d));
  return { part, p, d, pError, deriveError, probe, probeAgain, resolveExpectOnce };
}

/**
 * Lint a PartDefinition. Never throws.
 * @param {object} part   the default-exported PartDefinition
 * @param {{params?: object, sources?: {files?: Record<string, string>, entrypoint?: string}, vectorDocs?: Record<string, object>}} [opts]
 *   `params` are layered over part.defaults for the probe pass; `sources` is the part's own
 *   source text, which unlocks the source rules (Group 9) — omit it and lint behaves as before.
 *   `vectorDocs` is `{ name: parsedDocument }`, the raw parsed JSON of the part's declared
 *   vector files (see vectors.js's resolveVectorDocs) — omit it and the document-dependent
 *   vector rules (vector-size-missing, vector-unknown-shape) stay silent rather than guess.
 * @returns {{ok: boolean, errors: object[], warnings: object[], notes: object[]}}
 */
export function lintPart(part, opts) {
  // `opts` is defaulted here, not via `= {}` on the parameter, because a default
  // parameter only fires on `undefined` — a caller passing `lintPart(part, null)`
  // (a plausible downstream-harness call) would otherwise throw destructuring
  // `{ params }` out of `null` before this function's body ever runs.
  const { params, sources, vectorDocs } = opts ?? {};
  // lintContext already guards its own internals (see its comment above), but it
  // is user-authored data all the way down — wrap the call itself too, so a
  // failure mode neither of us has thought of still degrades to a report instead
  // of an escaping throw. `lintPart` must never throw; that guarantee is a bigger
  // deal than any one finding.
  let ctx;
  try {
    ctx = lintContext(part, params);
  } catch (e) {
    return {
      ok: false,
      errors: [err("lint-context-error",
        `partforge/lint could not build a lint context: ${e?.message || String(e)}`,
        "This part is too malformed for lint to analyze safely — make sure `defaults`, `params`, and `verify`/`derive` are plain, side-effect-free data rather than throwing getters or hostile Proxies.",
        "")],
      warnings: [],
      notes: [],
    };
  }
  // Deliberately its OWN guard, outside the lintContext try above: a malformed
  // `sources` input means "no source rules", never a broken part. `sources` is
  // caller-supplied data (a throwing `files`/`entrypoint` getter, a Proxy whose
  // `ownKeys` trap throws), and folding it into the block above would turn that
  // into a `lint-context-error` — an id that is NOT in SOURCE_RULE_IDS, so a
  // host filtering source findings out to keep them non-blocking would instead
  // refuse to render a part that builds fine.
  try { ctx.sources = normalizeSources(sources); } catch { ctx.sources = null; }
  // Same deliberate own-guard as sources above: a malformed vectorDocs input
  // means "the document-dependent vector rules stay quiet", never a broken part.
  try { ctx.vectorDocs = normalizeVectorDocs(vectorDocs); } catch { ctx.vectorDocs = null; }
  const findings = runRules(RULES, ctx);
  // `p` (params merged from `defaults`) failed to build — every rule still ran
  // against the `{}` fallback (each guarded individually by runRules), but the
  // part is provably broken independent of whatever those rules happened to
  // notice, so report it directly rather than relying on incidental fallout.
  if (ctx.pError) {
    findings.push(err("lint-context-error",
      `partforge/lint could not read \`defaults\`/\`params\`: ${ctx.pError}`,
      "Make sure `defaults` and any `params` passed to lintPart are plain, side-effect-free data rather than a throwing getter or a hostile Proxy.",
      ""));
  }
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const notes = findings.filter((f) => f.severity === "note");
  return { ok: errors.length === 0, errors, warnings, notes };
}
