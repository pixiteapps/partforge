// Group 4 — the verify block's own well-formedness. Each condition here currently
// throws from verify() mid-run, AFTER measure has printed and the kernel has booted,
// which is also the documented reason CLI stdout isn't pure JSON in that case.
// Catching them statically removes both the wasted boot and the stdout caveat.
import { err } from "./finding.js";
import { SUBPART_METRICS, VIEW_METRICS } from "../verify-metrics.js";
import { PROFILES, ORIENTATIONS } from "../oracle/dfm-profiles.js";
import { parseAssertion } from "../oracle/assert-dsl.js";
import { suggest } from "../geometry/op-options.js";

// Resolve `expect` to a plain object. The function form (p, d) => ({…}) is invoked
// once with the probe's params so per-preset topology can be linted like any other.
// Returns { expect, threw }.
//
// Exported so `lintContext` (index.js) can memoize a single call per lint pass and
// share it across every Group 4 rule below — `expect` is user-supplied code, and
// without memoization a function-form `expect` that throws only on its first call
// would fire both `verify-expect-throws` (first call) and whatever rule calls it
// next (second call succeeds), a cascading double-report.
export function resolveExpect(verify, p, d) {
  if (typeof verify?.expect !== "function") return { expect: verify?.expect, threw: null };
  try { return { expect: verify.expect(p, d), threw: null }; }
  catch (e) { return { expect: null, threw: e?.message || String(e) }; }
}

const isExpectation = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && "expr" in v;
const exprOf = (v) => (isExpectation(v) ? v.expr : v);

// `contacts` (must-touch pairs) and `clearance` (free-fit gaps) live under
// `verify.expect._view` but are pair-wise checks, not scalar VIEW_METRICS — mirror
// verify.js's own peel (verify.js:143) so they never hit the scalar-metric /
// assertion-expression checks below. Validated for real by `verify-bad-pair-check`.
const peelPairKeys = (metrics) => {
  const { contacts, clearance, ...rest } = metrics;
  return rest;
};

// `JSON.stringify` can itself throw (BigInt, circular refs) — lintPart must never
// throw, so fall back to `String` for anything that won't serialize.
const describe = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

// `suggest` calls `.toLowerCase()` on the key; guard against non-string pair names
// (a runtime `contacts`/`clearance` entry can contain anything).
const safeSuggest = (key, valid) => (typeof key === "string" ? suggest(key, valid) : null);

// `requirePair` (verify.js:41) throws before it even looks at `part.parts` when a
// pair names the same sub-part twice — a pair describes a relationship between two
// distinct sub-parts, so self-pairs are never legal.
function checkSameName(a, b, path) {
  return a === b
    ? [err("verify-bad-pair-check",
        `\`${path}\` names the same sub-part twice ("${a}")`,
        "A pair must name two different sub-parts. Change one side to the other sub-part it should be checked against, or remove the entry if it doesn't describe a real relationship.",
        path)]
    : [];
}

// Both `contacts` pairs and `clearance` keys ultimately name two sub-parts; a name
// absent from `part.parts` is what the runtime `requirePair` throws for.
function checkPairNames(a, b, names, path) {
  const out = [];
  for (const n of [a, b]) {
    if (names.includes(n)) continue;
    const hint = safeSuggest(n, names);
    out.push(err("verify-unknown-subpart",
      `\`${path}\` references "${n}", which is not a sub-part`,
      `Use one of the sub-part names (${names.join(", ")})${hint ? ` — did you mean "${hint}"?` : "."}`,
      path));
  }
  return out;
}

// Static analogue of verify.js's `pairGapChecks` contacts handling (verify.js:61-66).
function checkContacts(contacts, names, path) {
  if (contacts === undefined || contacts === null) return [];
  if (!Array.isArray(contacts)) {
    return [err("verify-bad-pair-check",
      `\`${path}\` must be an array of ["a", "b"] pairs, got ${describe(contacts)}`,
      `Set \`contacts\` to an array of two-element sub-part name pairs, e.g. \`contacts: [["lid", "body"]]\`.`,
      path)];
  }
  const out = [];
  contacts.forEach((pair, i) => {
    const pairPath = `${path}[${i}]`;
    if (!Array.isArray(pair) || pair.length !== 2) {
      out.push(err("verify-bad-pair-check",
        `\`${pairPath}\` must be an ["a", "b"] pair, got ${describe(pair)}`,
        `Each \`contacts\` entry must be a two-element array naming the two sub-parts that should touch, e.g. \`["lid", "body"]\`.`,
        pairPath));
      return;
    }
    out.push(...checkSameName(pair[0], pair[1], pairPath));
    // `requirePair` (verify.js:41) checks the same-name case first and throws
    // before ever looking at `part.parts` — so a same-name pair never reaches the
    // unknown-name check at runtime either. Skip it here too, or an unknown
    // self-paired name would double-report (once per identical position).
    if (pair[0] !== pair[1]) out.push(...checkPairNames(pair[0], pair[1], names, pairPath));
  });
  return out;
}

// Static analogue of verify.js's `pairGapChecks` clearance handling (verify.js:85-87).
// Note the separator is the multiplication sign "×" (U+00D7), not the letter x.
function checkClearance(clearance, names, path) {
  if (clearance === undefined || clearance === null || typeof clearance !== "object") return [];
  const out = [];
  for (const key of Object.keys(clearance)) {
    const pairPath = `${path}[${JSON.stringify(key)}]`;
    const pair = key.split("×").map((s) => s.trim());
    if (pair.length !== 2 || !pair[0] || !pair[1]) {
      out.push(err("verify-bad-pair-check",
        `\`${pairPath}\` key must be "a×b" (sub-part names joined by the multiplication sign ×), got ${JSON.stringify(key)}`,
        `Rename the key to \`"a×b"\` using the two sub-part names that should have a declared clearance, e.g. \`"lid×body"\`. The separator is U+00D7 (×), not the letter x.`,
        pairPath));
      continue;
    }
    out.push(...checkSameName(pair[0], pair[1], pairPath));
    // Same short-circuit as `checkContacts` above: a same-name pair never reaches
    // the unknown-name check at runtime (or here), so it can't double-report.
    if (pair[0] !== pair[1]) out.push(...checkPairNames(pair[0], pair[1], names, pairPath));
  }
  return out;
}

// `clearance`'s values genuinely are assertion expressions run through the DSL
// (verify.js:96), unlike `contacts` (pair arrays with nothing to parse). Mirror
// verify.js's own normalization — a bare value or an `{ expr, hint }` wrapper,
// via `normalizeExpectation` (verify.js:91) — using the same `isExpectation` /
// `exprOf` helpers the scalar-metric loop below uses. Reported under
// `verify-bad-expr`, not `verify-bad-pair-check`: a malformed key is a pair-naming
// problem, but a malformed value is an assertion-DSL problem, same as any other
// metric's expectation.
function checkClearanceExprs(clearance, path) {
  if (clearance === undefined || clearance === null || typeof clearance !== "object") return [];
  const out = [];
  for (const [key, spec] of Object.entries(clearance)) {
    try { parseAssertion(exprOf(spec)); }
    catch (e) {
      out.push(err("verify-bad-expr",
        `the expectation for _view.clearance["${key}"] is not a valid assertion: ${e?.message || String(e)}`,
        "Use the assertion DSL: a bare value for equality, a comparison like `>=3`, a range like `2..5`, or a componentwise vector like `<=[60,60,60]` (with `*` to skip an axis).",
        `${path}[${JSON.stringify(key)}]`));
    }
  }
  return out;
}

// Static walk of `resolveProfile`'s (dfm-profiles.js) `base` chain, mirroring its
// exact throw conditions at every level: a string not in `PROFILES` ("unknown
// process profile"), or — recursively — a bad `base` nested inside a `base`
// object. A falsy `base` resolves to `{}` at runtime (`spec.base ? … : {}`) and
// is never reached, so it's left alone here too. `seen` records every `base`
// value already visited so a self-referential or cyclic chain (`base.base ===
// base`) cannot recurse forever — `lintPart` must always terminate. `depth` is a
// second, cheap belt-and-suspenders cap for the same reason.
function checkProcessSpec(spec, path, valid, seen, depth = 0) {
  if (depth > 50) return []; // pathological chain — bail rather than hang
  if (typeof spec === "string") {
    if (valid.includes(spec)) return [];
    const hint = suggest(spec, valid);
    return [err("verify-unknown-process",
      `\`${path}\` names "${spec}", which is not a known DFM profile`,
      `Use one of: ${valid.join(", ")}${hint ? ` — did you mean "${hint}"?` : ""}, or pass an inline profile object such as \`{ bed: [220, 220, 250], minWall: 1.2 }\`.`,
      path)];
  }
  if (spec && typeof spec === "object") {
    if (!spec.base) return []; // no base (or a falsy one) — nothing further to resolve
    if (seen.has(spec.base)) return []; // already visited — self-referential/cyclic, stop
    seen.add(spec.base);
    return checkProcessSpec(spec.base, `${path}.base`, valid, seen, depth + 1);
  }
  // Anything else truthy (number, boolean, …) is what resolveProfile's final
  // branch throws "invalid process profile" for.
  return [err("verify-unknown-process",
    `\`${path}\` is not a valid DFM profile: ${describe(spec)}`,
    `Use one of: ${valid.join(", ")}, or an inline profile object such as \`{ bed: [220, 220, 250], minWall: 1.2 }\`.`,
    path)];
}

export const VERIFY_RULES = [
  {
    id: "verify-expect-throws",
    run: ({ resolveExpectOnce }) => {
      const { threw } = resolveExpectOnce();
      return threw ? [err("verify-expect-throws",
        `\`verify.expect(p, d)\` threw: ${threw}`,
        "The function form of `expect` must return an expectation object for any parameter set. Guard whatever it reads, or switch to the static object form.",
        "verify.expect")] : [];
    },
  },
  {
    id: "verify-unknown-subpart",
    run: ({ part, resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      if (!expect || typeof expect !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      return Object.keys(expect)
        .filter((key) => key !== "_view" && !names.includes(key))
        .map((key) => {
          const hint = suggest(key, names);
          return err("verify-unknown-subpart",
            `\`verify.expect\` targets "${key}", which is not a sub-part`,
            `Use one of the sub-part names (${names.join(", ")}) or the literal \`_view\` for whole-assembly metrics${hint ? ` — did you mean "${hint}"?` : "."}`,
            `verify.expect.${key}`);
        });
    },
  },
  {
    id: "verify-unknown-metric",
    run: ({ part, resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      if (!expect || typeof expect !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      const out = [];
      for (const [target, metricsRaw] of Object.entries(expect)) {
        if (target !== "_view" && !names.includes(target)) continue; // reported by verify-unknown-subpart
        if (!metricsRaw || typeof metricsRaw !== "object") continue;
        // contacts/clearance are pair checks, not scalar view metrics — validated
        // separately by verify-bad-pair-check, and excluded here.
        const metrics = target === "_view" ? peelPairKeys(metricsRaw) : metricsRaw;
        const registry = target === "_view" ? VIEW_METRICS : SUBPART_METRICS;
        const valid = Object.keys(registry);
        for (const metric of Object.keys(metrics)) {
          if (valid.includes(metric)) continue;
          const hint = suggest(metric, valid);
          out.push(err("verify-unknown-metric",
            `"${metric}" is not a ${target === "_view" ? "view" : "sub-part"} metric`,
            `Valid ${target === "_view" ? "view" : "sub-part"} metrics are: ${valid.join(", ")}${hint ? ` — did you mean "${hint}"?` : "."}`,
            `verify.expect.${target}.${metric}`));
        }
      }
      return out;
    },
  },
  {
    id: "verify-bad-expr",
    run: ({ resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      if (!expect || typeof expect !== "object") return [];
      const out = [];
      for (const [target, metricsRaw] of Object.entries(expect)) {
        if (!metricsRaw || typeof metricsRaw !== "object") continue;
        // `contacts` is pair arrays with no expression to parse, and `clearance`'s
        // values are keyed by pair name rather than metric name — both are peeled
        // from this scalar-metric loop. `clearance`'s values are still assertions
        // though, so they get their own pass (with a pair-shaped path) below.
        const metrics = target === "_view" ? peelPairKeys(metricsRaw) : metricsRaw;
        const registry = target === "_view" ? VIEW_METRICS : SUBPART_METRICS;
        for (const [metric, spec] of Object.entries(metrics)) {
          let parsed;
          try { parsed = parseAssertion(exprOf(spec)); }
          catch (e) {
            out.push(err("verify-bad-expr",
              `the expectation for ${target}.${metric} is not a valid assertion: ${e?.message || String(e)}`,
              "Use the assertion DSL: a bare value for equality, a comparison like `>=3`, a range like `2..5`, or a componentwise vector like `<=[60,60,60]` (with `*` to skip an axis).",
              `verify.expect.${target}.${metric}`));
            continue;
          }
          const form = registry[metric]?.form;
          if (form === "range" && parsed.op !== "range") {
            out.push(err("verify-bad-expr",
              `the expectation for ${target}.${metric} must be a range like "1.8..2.2" — the ${metric} metric needs both ends of its band`,
              `Write ${metric} as \`"<min>..<max>"\` in mm.`,
              `verify.expect.${target}.${metric}`));
          } else if (form === "range" && parsed.op === "range" && parsed.min > parsed.max) {
            out.push(err("verify-bad-expr",
              `the expectation for ${target}.${metric} must be a range with min <= max, got "${exprOf(spec)}"`,
              `Write ${metric} as \`"<min>..<max>"\` with min <= max, in mm.`,
              `verify.expect.${target}.${metric}`));
          }
        }
      }
      out.push(...checkClearanceExprs(expect?._view?.clearance, "verify.expect._view.clearance"));
      return out;
    },
  },
  {
    id: "verify-bad-pair-check",
    run: ({ part, resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      const view = expect?._view;
      if (!view || typeof view !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      return [
        ...checkContacts(view.contacts, names, "verify.expect._view.contacts"),
        ...checkClearance(view.clearance, names, "verify.expect._view.clearance"),
      ];
    },
  },
  {
    id: "verify-unknown-process",
    run: ({ part }) => {
      const process = part?.verify?.process;
      // verify.js:163-164 — `profileSpec ?? part.verify?.process` then
      // `profileSpec ? resolveProfile(profileSpec) : null` — that second check is
      // truthiness, not a null/undefined check, so ANY falsy `process` (undefined,
      // null, "", 0, false) never reaches `resolveProfile` and can't throw.
      if (!process) return [];
      const valid = Object.keys(PROFILES);
      return checkProcessSpec(process, "verify.process", valid, new Set());
    },
  },
  {
    // dfm-profiles.js overhangAngleFor throws on an orientation outside
    // ORIENTATIONS — the overhang opt-in's one legal value — with the same
    // mid-run loudness as an unknown profile name, so it gets the same rule.
    id: "verify-unknown-orientation",
    run: ({ part }) => {
      const orientation = part?.verify?.orientation;
      if (orientation == null) return [];
      if (typeof orientation === "string" && ORIENTATIONS.includes(orientation)) return [];
      const hint = safeSuggest(orientation, ORIENTATIONS);
      return [err("verify-unknown-orientation",
        `\`verify.orientation\` is ${describe(orientation)}, which is not a known orientation`,
        `Use ${ORIENTATIONS.map((o) => `"${o}"`).join(", ")}${hint ? ` — did you mean "${hint}"?` : ""} (declares the part is laid out for its print bed, arming the profile's overhang check), or omit the key.`,
        "verify.orientation")];
    },
  },
];
