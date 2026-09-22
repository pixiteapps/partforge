import { parseAssertion, evaluateAssertion } from "./assert-dsl.js";
import { measure as defaultMeasure } from "./measure.js";
import { pairKey, CONTACT_EPS } from "./gaps.js";
import { resolveProfile, overhangAngleFor } from "./dfm-profiles.js";
import { expandExpectations, partGatesMinWall } from "./gates.js";
import { subPartReadKeys, relevanceHash, RELEVANT_ALL } from "../param-deps.js";
import { byteAwareReplacer } from "../geometry/solid-hash.js";
import { SUBPART_METRICS, VIEW_METRICS } from "../verify-metrics.js";

// Re-exported for backwards compatibility: the registries moved to framework/ so
// the linter can read the metric vocabulary without importing a geometry kernel.
export { SUBPART_METRICS, VIEW_METRICS };

// An expectation is a bare expression (string/number/boolean) or { expr, hint }.
const normalizeExpectation = (spec) =>
  spec !== null && typeof spec === "object" && !Array.isArray(spec) && "expr" in spec
    ? { expr: spec.expr, hint: spec.hint }
    : { expr: spec, hint: undefined };

const PAIR_HINTS = {
  contact: "the pair should touch but doesn't — grow the joining feature or move the mating datum so the faces meet",
  clearance: "the pair's free-fit gap is out of the declared range — adjust the mating dimensions or the declared clearance",
  nearMiss: "sub-parts nearly touch here — if they should meet, declare the pair in verify.expect._view.contacts and close the gap; if a free fit is intended, declare it under clearance",
};

// Pair-wise view checks: `contacts` (must touch), `clearance` (assertion DSL vs
// the measured pair distance), and warnings for undeclared near misses. These are
// per-pair, so they live outside the scalar VIEW_METRICS registry but emit the
// same structured check objects.
function pairGapChecks(facts, { contacts, clearance }, subPartNames) {
  const checks = [];
  const declared = new Set();
  const names = new Set(facts.subparts.map((s) => s.name));
  // The part's full sub-part vocabulary (when the caller knows it): a declared
  // name absent from THIS case's facts but present in the part is an
  // enabled()-gated sub-part that is off for this case → skip, don't throw.
  // A name in neither set is a typo → throw. Without the vocabulary (bare
  // evaluateCase callers) the case's own names are the vocabulary.
  const known = subPartNames ? new Set(subPartNames) : names;
  const requirePair = (a, b, what) => {
    if (a === b) throw new Error(`${what}: a pair must name two different sub-parts, got ["${a}", "${b}"]`);
    let absent = false;
    for (const n of [a, b]) {
      if (names.has(n)) continue;
      if (!known.has(n)) throw new Error(`${what}: unknown sub-part "${n}" (view has: ${[...names].join(", ")})`);
      absent = true;
    }
    return absent; // true = valid pair, but a sub-part is disabled in this case
  };
  const gapFor = (a, b) => facts.gaps?.find((g) => pairKey(g.a, g.b) === pairKey(a, b));
  const disabledSkip = (base) => ({ ...base, actual: null, status: "skip", pass: null, message: "sub-part disabled in this case" });
  // No gap table at all = legacy facts → skip. A table that MERELY LACKS the pair
  // = the sub-part built empty (meshGaps skips empty meshes) → a declared gate
  // must fail loudly, not skip, or verify.ok would vouch for an unverified pair.
  // `measuredGaps === false` says the pass was deliberately skipped (a quick lap);
  // an absent stamp is a legacy result, whose skip stays exactly as untagged as it
  // has always been rather than retroactively withholding verdicts.
  const gapsSkipped = facts.measuredGaps === false;
  const noReading = (base) => (facts.gaps
    ? { ...base, actual: null, status: "fail", pass: false,
        message: "no measured distance for the pair",
        hint: "one sub-part produced no mesh (an empty solid?) — fix the build before trusting this gate" }
    : { ...base, actual: null, status: "skip", pass: null,
        ...(gapsSkipped
          ? { unevaluated: true, message: "not measured (quick check)",
              hint: "re-run this check without `quick` to measure pair distances" }
          : { message: "unavailable" }) });

  if (contacts != null && !Array.isArray(contacts)) {
    throw new Error(`contacts: must be an array of ["a", "b"] pairs, got ${JSON.stringify(contacts)}`);
  }
  for (const pair of contacts ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`contacts: each entry must be an ["a", "b"] pair, got ${JSON.stringify(pair)}`);
    }
    const [a, b] = pair;
    const disabled = requirePair(a, b, "contacts");
    declared.add(pairKey(a, b));
    const base = { scope: "view", subpart: `${a}×${b}`, metric: "contact", kind: "gate", expr: "touching" };
    if (disabled) { checks.push(disabledSkip(base)); continue; }
    const g = gapFor(a, b);
    if (!g) { checks.push(noReading(base)); continue; }
    const overlapping = (facts.overlaps ?? []).some((o) => pairKey(o.a, o.b) === pairKey(a, b));
    if (overlapping || g.distance <= CONTACT_EPS) {
      checks.push({ ...base, actual: g.distance, status: "pass", pass: true, message: overlapping ? "in contact (overlapping)" : "in contact" });
    } else {
      checks.push({ ...base, actual: g.distance, status: "fail", pass: false,
        message: `${g.distance.toFixed(3)}mm apart, expected touching`,
        hint: PAIR_HINTS.contact, pattern: "near-miss-gap", location: g.at });
    }
  }

  for (const [key, spec] of Object.entries(clearance ?? {})) {
    const pair = key.split("×").map((s) => s.trim());
    if (pair.length !== 2 || !pair[0] || !pair[1]) throw new Error(`clearance: pair key must be "a×b", got "${key}"`);
    const [a, b] = pair;
    const disabled = requirePair(a, b, "clearance");
    declared.add(pairKey(a, b));
    const { expr, hint: partHint } = normalizeExpectation(spec);
    const base = { scope: "view", subpart: `${a}×${b}`, metric: "clearance", kind: "gate", expr: String(expr) };
    if (disabled) { checks.push(disabledSkip(base)); continue; }
    const g = gapFor(a, b);
    if (!g) { checks.push(noReading(base)); continue; }
    const { pass, message } = evaluateAssertion(parseAssertion(expr), g.distance);
    const out = { ...base, actual: g.distance, status: pass ? "pass" : "fail", pass, message };
    if (!pass) { out.hint = partHint ?? PAIR_HINTS.clearance; out.pattern = "near-miss-gap"; out.location = g.at; }
    checks.push(out);
  }

  for (const g of facts.nearMisses ?? []) {
    if (declared.has(pairKey(g.a, g.b))) continue;
    checks.push({ scope: "view", subpart: `${g.a}×${g.b}`, metric: "nearMiss", kind: "warn",
      expr: "intent undeclared", actual: g.distance, status: "warn", pass: false,
      message: `${g.distance.toFixed(3)}mm gap`, hint: PAIR_HINTS.nearMiss,
      pattern: "near-miss-gap", location: g.at });
  }
  return checks;
}

function check(scope, subpart, metric, spec, registry, factsObj) {
  const reg = registry[metric];
  if (!reg) throw new Error(`unknown ${scope} metric "${metric}"${subpart ? ` on sub-part "${subpart}"` : ""}`);
  const { expr, hint: partHint } = normalizeExpectation(spec);
  const actual = reg.extract(factsObj);
  const base = { scope, subpart, metric, kind: reg.kind, expr: String(expr) };
  if (actual === null || actual === undefined) {
    if (reg.manifoldOnly) return { ...base, actual, status: "skip", pass: null, message: "n/a (OCCT backend)" };
    if (metric === "minWall") {
      const out = { ...base, actual, status: "warn", pass: null, message: "min wall unavailable",
        hint: partHint ?? "no min-wall reading for this mesh — treat thin features as unverified" };
      // A missing reading still has a HOW: a sampled run whose rays all missed says
      // so here, rather than reading like a mesh min-wall never looked at.
      const note = reg.note?.(factsObj);
      if (note) out.note = note;
      return out;
    }
    return { ...base, actual, status: "skip", pass: null, message: reg.unavailable ?? "unavailable" };
  }
  const { pass, message } = evaluateAssertion(parseAssertion(expr), actual);
  const status = pass ? "pass" : reg.kind === "warn" ? "warn" : "fail";
  const out = { ...base, actual, status, pass, message };
  // A measurement caveat rides along whatever the verdict — a min-wall reading
  // taken from a sample still passed, but the reader should know it was a sample.
  const note = reg.note?.(factsObj);
  if (note) out.note = note;
  if (!pass) {
    out.hint = partHint ?? reg.hint;
    if (reg.pattern) out.pattern = reg.pattern;
    const loc = reg.locate?.(factsObj);
    if (loc) out.location = loc;
  }
  return out;
}

// Pure policy: profile rules + per-part expect → checks for one case's facts.
// `overhang` is the angle the part opted into (dfm-profiles.js overhangAngleFor),
// or null/undefined: only then does the profile's overhang rule apply, as a
// 1 mm² warning floor — a chamfer sitting exactly on the angle sheds slivers.
export function evaluateCase(facts, { profile, expect, subPartNames, overhang = null }) {
  const checks = [];
  // contacts/clearance are per-pair, not scalar view metrics — peel them off
  // before the registry loop and hand them to pairGapChecks.
  const { contacts, clearance, ...viewScalarExp } = expect?._view ?? {};
  const viewExp = {
    ...(profile?.bed ? { bbox: `<=[${profile.bed.join(",")}]` } : {}),
    ...viewScalarExp,
  };
  for (const [metric, expr] of Object.entries(viewExp)) checks.push(check("view", null, metric, expr, VIEW_METRICS, facts));
  checks.push(...pairGapChecks(facts, { contacts, clearance }, subPartNames));

  // Same rule as gapsSkipped above, one metric over: a min-wall gate with no reading
  // is a warn ("min wall unavailable"), which does not move `ok` — right when the
  // rays were cast and all missed, wrong when they were never cast. The stamp is
  // what tells those apart, and it is measure()'s own, never a caller's claim.
  const minWallSkipped = facts.measuredMinWall === false;
  // Same shape for overhang: the rule is armed but these facts were measured
  // without the pass (a quick lap reusing a seed that had no angle), so the check
  // is withheld rather than read as "unavailable" — which would count as answered.
  const overhangSkipped = overhang != null && (facts.measuredOverhang ?? null) === null;
  for (const s of facts.subparts) {
    const merged = {
      ...(profile?.minWall != null ? { minWall: `>=${profile.minWall}` } : {}),
      ...(overhang != null ? { overhangArea: "<=1" } : {}),
      ...(expect?.[s.name] ?? {}),
    };
    for (const [metric, expr] of Object.entries(merged)) {
      const c = check("subpart", s.name, metric, expr, SUBPART_METRICS, s);
      if (minWallSkipped && (metric === "minWall" || metric === "wall") && c.actual == null) {
        checks.push({ ...c, unevaluated: true, message: "not measured (quick check)",
          hint: `re-run this check without \`quick\` to measure ${metric === "wall" ? "the wall band" : "min wall"}` });
        continue;
      }
      if (overhangSkipped && metric === "overhangArea" && c.actual == null) {
        checks.push({ ...c, unevaluated: true, message: "not measured (quick check)",
          hint: "re-run this check without `quick` to measure overhang" });
        continue;
      }
      checks.push(c);
    }
  }
  return checks;
}

// `seed` lets a caller that has ALREADY measured this part hand the result in so
// verify does not recompute it — see the seeding block below for the shape and
// the one correctness rule that governs it.
// `quick` is the fast lap (see jobs.js): evaluate everything the seed already
// supports and MEASURE NOTHING. What that leaves unchecked is reported as
// `unevaluated` rather than quietly downgraded, and one unevaluated gate withholds
// `ok` — a fast lap yields facts, never a verdict.
export function verify(kernel, part, { process, view, measureFn = defaultMeasure, seed, quick = false } = {}) {
  view = view ?? Object.keys(part.views)[0];
  const profileSpec = process ?? part.verify?.process;
  const profile = profileSpec ? resolveProfile(profileSpec) : null;

  // `expect` can be a pure function of the case's resolved params — (p, d) →
  // expect object — so topology that legitimately changes with a preset (an
  // optional drain or bore flipping the genus) can be pinned per case instead
  // of one static number that some presets must violate. The expansion lives in
  // gates.js because measure() needs the same answer (it sizes the min-wall sample
  // budget by it) and must not derive it separately — see there.
  const expanded = expandExpectations(part);
  const needMinWall = partGatesMinWall(part, { process, expanded });
  // Throws on a bad `verify.orientation`, the same loudness as a bad profile name.
  const overhangAngle = overhangAngleFor(part, process, { expanded });
  const readKeys = subPartReadKeys(part, view, part.defaults);
  // byteAwareReplacer on the RELEVANT_ALL branch too: an unattributable derive()
  // still might read a byte-valued image param, and this memo key gates whether
  // a case's geometry gets rebuilt or an earlier result reused (see the seeding
  // block below) — the same collision the relevanceHash branch guards against.
  const signature = (params) =>
    readKeys === RELEVANT_ALL
      ? JSON.stringify(params, byteAwareReplacer)
      : [...readKeys.entries()].map(([name, keys]) => `${name}:${relevanceHash([...keys], params)}`).join("|");

  const memo = new Map();

  // SEEDING. expandCases always yields a "defaults" case, and the inspect job
  // (framework/jobs.js) measures those exact params immediately before calling
  // verify — so without this the oracle rebuilds the same geometry, casts the
  // same min-wall rays and re-indexes the same meshes a second time. On a
  // single-case part that is half the job.
  //   seed = { params, result } — the params the result was measured with, and
  //   the measure() output itself. Nothing else: every fact the rule below needs
  //   is read off the artifact, so a caller cannot assert it wrongly.
  //
  // THE MIN-WALL SUPERSET RULE, which is the trap here. measureCase asks for
  // `{ minWall: needMinWall }`, and needMinWall is false whenever no profile and
  // no expectation mentions min wall. A result measured WITH min wall is a strict
  // superset of one measured without: the extra fields are only ever read by the
  // minWall metric, which by definition this run never checks. Reuse in that
  // direction is free. The reverse is NOT safe — a seed taken without min wall
  // carries `minWall: null` on every sub-part, which the registry reports as
  // "min wall unavailable", silently downgrading a real gate to a warning. So the
  // seed is consulted only when `seed.result.measuredMinWall || !needMinWall` —
  // and `measuredMinWall` is stamped by measure() itself, not claimed by whoever
  // holds the result. Otherwise the seed is ignored and the case measured properly.
  //
  // ALIASING. A consulted seed is memoized BY REFERENCE, so the caller's result
  // and every case that hits it are the same object — the inspect job's
  // `report.measure` and `report.verify.cases[0]`'s facts included. Nothing here
  // mutates facts (evaluateCase only reads), and that is what makes the sharing
  // safe; a future check that wants to annotate a fact must copy first.
  //
  // Keyed through the SAME signature() the memo uses, never a JSON compare of the
  // raw params — a separate compare would miss cases that share a signature (a
  // preset touching only params the build never reads) and, worse, could hit on
  // params that merely look equal. The seed's params are layered over
  // part.defaults first because a caller's `{}` and the defaults case's
  // `{...part.defaults}` build identical geometry but hash differently
  // (JSON.stringify({}) is not JSON.stringify(defaults), and relevanceHash reads
  // params[k] straight through). The view is checked too: measure()'s output is
  // per-view, and a seed from another view would be a silent wrong answer.
  //
  // Non-default measure options (a custom `gapThreshold`) are the caller's
  // responsibility: seed only a measurement taken the way verify would take it.
  // Under `quick` the superset rule is not waived so much as satisfied differently:
  // a min-wall-less seed is reused, and the min-wall gate it cannot answer becomes
  // `unevaluated` instead of being re-measured. The rule exists to stop a coarse
  // reading standing in for a gate's verdict, and a withheld verdict does that too.
  // The overhang half of the same rule: a seed is admitted only when it was
  // measured against the angle THIS run needs (both null when neither checks) —
  // `measuredOverhang` is stamped by measure() itself. A `process` override that
  // changes the angle therefore re-measures rather than reusing the inspect
  // job's seed, which was taken against the part's own profile.
  const overhangMatches = (seed?.result?.measuredOverhang ?? null) === (overhangAngle ?? null);
  if (seed?.result && (quick || seed.result.measuredMinWall || !needMinWall) && (quick || overhangMatches) && seed.result.view === view) {
    memo.set(signature({ ...part.defaults, ...(seed.params ?? {}) }), seed.result);
  }

  const measureCase = (params) => {
    const key = signature(params);
    if (memo.has(key)) return memo.get(key);
    if (quick) return null;   // a case the seed does not cover — reported, never built
    // `probes: false` — no gate reads probe values, so re-running their booleans
    // for every case buys nothing. (A seed measured WITH probes is a superset in
    // the same way a min-wall seed is: the extra key is simply never read here.)
    memo.set(key, measureFn(kernel, part, view, params, { minWall: needMinWall, probes: false, overhang: overhangAngle }));
    return memo.get(key);
  };

  const subPartNames = Object.keys(part.parts);
  // An unmeasured case gets ONE check standing for the whole case rather than a
  // silent absence: "this preset was not checked" has to be visible in the same
  // list every other verdict lives in, or a reader counting passes sees a shorter
  // list and no reason.
  const notMeasured = (name) => [{
    scope: "case", subpart: null, metric: "measured", kind: "gate", expr: "measured",
    actual: null, status: "skip", pass: null, unevaluated: true,
    message: "not measured (quick check)",
    hint: "re-run this check without `quick` to evaluate this case",
  }];
  const caseResults = expanded.map(({ name, params, expect }) => {
    const facts = measureCase(params);
    return { name, params, checks: facts ? evaluateCase(facts, { profile, expect, subPartNames, overhang: overhangAngle }) : notMeasured(name) };
  });
  // VACUOUS VERIFY. A part that declares nothing — no profile, an empty or absent
  // `expect` — used to come back `ok: true` with zero checks, and every reader
  // (the CLI's exit code, the cloud agent's "verify passes" stop rule) took that
  // as verified. Nothing was. Two counts, and the difference between them is a
  // second thing this used to hide:
  //   `declared`  — checks the part or its profile asked for, as produced: the
  //                 undeclared near-miss warnings are facts the oracle volunteers
  //                 and the quick-lap "not measured" marker stands for a case,
  //                 so neither counts;
  //   `evaluated` — the declared checks that were actually answered. A check
  //                 that SKIPPED (a `ref*` metric on a sub-part with no
  //                 reference, `holes` on the OCCT backend, a pair on a disabled
  //                 sub-part) was declared, but it verified nothing.
  // Zero evaluated withholds the verdict — the same `null` a quick lap uses for
  // "could not check", because that is what it is. Whether anything was DECLARED
  // is decided from the declaration itself (`profile`, the expanded `expect`
  // maps, an armed overhang angle), never from the produced checks: on a quick
  // lap whose seed matches no case there are no checks at all, and counting
  // those would print "no expectations declared" at a part that declares plenty.
  // The notice rides `warnings`, the channel every host already shows, and is
  // deliberately NOT pushed into any case's check list — it is about the part,
  // not about `defaults`. A quick lap that withheld gates explains itself through
  // `unevaluated` and gets no notice.
  const isDeclared = (c) => c.scope !== "case" && c.metric !== "nearMiss";
  const all = caseResults.flatMap((c) => c.checks.map((ch) => ({ case: c.name, ...ch })));
  let declared = 0, evaluated = 0;
  for (const c of all) {
    if (!isDeclared(c)) continue;
    declared++;
    if (c.status !== "skip" && !c.unevaluated) evaluated++;
  }
  const declaresAnything = profile != null || overhangAngle != null
    || expanded.some(({ expect }) => Object.values(expect ?? {}).some((o) => o && typeof o === "object" && Object.keys(o).length > 0));
  const failures = all.filter((c) => c.status === "fail");
  const unevaluated = all.filter((c) => c.unevaluated);
  const warnings = all.filter((c) => c.status === "warn");
  if (evaluated === 0 && unevaluated.length === 0) {
    warnings.push({ case: null, scope: "part", subpart: null, metric: "expectations", kind: "warn", expr: "evaluated",
      actual: 0, status: "warn", pass: null,
      message: declaresAnything ? "no expectation could be evaluated" : "no expectations declared",
      hint: declaresAnything
        ? "every declared check skipped — see the skip reasons above (a metric this backend cannot read, a reference the sub-part does not declare, a disabled sub-part) and declare something this run can answer"
        : "nothing was verified — pin the dimensions and features the part is meant to have in verify.expect (and a process profile for bed fit and min wall), so every edit re-checks them" });
  }
  return {
    // Tri-state, and the order matters: a real failure is still a failure even on a
    // lap that skipped other gates, so `false` outranks the withheld `null`; and a
    // part on which nothing was evaluated has no verdict to give.
    ok: failures.length ? false : unevaluated.length || evaluated === 0 ? null : true,
    view,
    cases: caseResults,
    failures,
    warnings,
    unevaluated,
    declared,
    evaluated,
  };
}
