// Which declared gates a part actually has — the questions the oracle asks before
// deciding how hard to work. Kept out of verify.js so measure() can ask the same
// question without importing verify (which imports measure), and so there is ONE
// definition of "does this part gate on min wall": measure sizes its sample budget
// by it and verify decides whether to measure it at all. Two derivations that drift
// would put a coarse reading behind a real gate, which is exactly the trap verify's
// seeding block guards against.
//
// Every function here is TOTAL, with one stated exception: `partWallBands` throws
// on a malformed `wall` range (see there). Elsewhere, a part whose profile name is
// unknown, or whose `expect` function throws, is reported as GATED — the
// conservative direction, since that is the full-resolution behaviour every part
// had before budgets existed. The real error surfaces from verify, which is where
// a reader can act on it.
import { resolveProfile, overhangAngleFor } from "./dfm-profiles.js";
import { expandCases } from "./cases.js";
import { resolveParams } from "../part-model.js";
import { parseAssertion } from "./assert-dsl.js";

// `expect` may be a function of a case's resolved params, so the answer is a property
// of the EXPANDED cases, not of the raw spec — which means answering it costs a call
// to the PART'S OWN code, once per case. Both callers here are on hot paths (verify
// expands for its case loop; measure asks the gate question on every call, and verify
// calls measure once per case), so an unmemoized expansion would invoke a part's
// `expect` O(cases²) times per report. Memoized by part identity, and re-derived if
// the spec object behind that identity was swapped — the realistic mutation, and the
// one a bare WeakMap would serve staleness for.
const expansions = new WeakMap();

export function expandExpectations(part) {
  const spec = part?.verify?.expect ?? {};
  const hit = expansions.get(part);
  if (hit && hit.spec === spec) return hit.expanded;
  const expanded = typeof spec !== "function"
    ? expandCases(part).map((c) => ({ ...c, expect: spec }))
    : expandCases(part).map((c) => {
      const { p, d } = resolveParams(part, c.params);
      return { ...c, expect: spec(p, d) ?? {} };
    });
  if (part && typeof part === "object") expansions.set(part, { spec, expanded });
  return expanded;
}

// The overhang angle a part is checked against, or null when it is not checked
// (dfm-profiles.js overhangAngleFor holds the rule). Total, like the rest of this
// file: a malformed orientation or profile answers null here and raises from
// verify, where a reader can act on it. measure() asks so the fact is computed
// for exactly the parts that will be judged on it.
export function partOverhangAngle(part, { process, expanded } = {}) {
  try { return overhangAngleFor(part, process, { expanded: expanded ?? expandExpectations(part) }); } catch { return null; }
}

export function partGatesMinWall(part, { process, expanded } = {}) {
  try {
    const spec = process ?? part?.verify?.process;
    if (spec && resolveProfile(spec)?.minWall != null) return true;
    return (expanded ?? expandExpectations(part)).some(({ expect }) =>
      Object.values(expect ?? {}).some((o) => o && typeof o === "object" && ("minWall" in o || "wall" in o)));
  } catch {
    return true; // unresolvable → measure it properly and let verify report the error
  }
}

// The wall bands a measurement of `params` must track, per sub-part, from the part's
// own `verify.expect` — resolved for exactly these params (a function expect may
// change the band per case). Range form only: the membership window needs both ends.
// Throws on a bad form (a non-range expression, or min > max) so verify reports it
// where a reader can act — measure's caller (Task 6) lets that throw surface as the
// measure error it is; this is the one place in this file that is not total.
// A throw from `spec(p, d)` ITSELF is a different, incidental case — the part's own
// `expect` function failed for a reason that has nothing to do with wall bands (it
// read a param that does not exist for this preset, say). That is not this
// function's throw to report: verify's own `expandExpectations` path calls the same
// spec and already lets that throw surface from `verify()` — reporting it a second
// time here, mid-measure, would be a confusing duplicate. Swallow it and answer "no
// bands", the same as a part that declares none.
export function partWallBands(part, params = {}) {
  const spec = part?.verify?.expect;
  if (!spec) return {};
  let expect;
  if (typeof spec === "function") {
    const { p, d } = resolveParams(part, params);
    try { expect = spec(p, d) ?? {}; } catch { return {}; }
  } else {
    expect = spec;
  }
  const out = {};
  for (const [name, metrics] of Object.entries(expect)) {
    if (name === "_view" || !metrics || typeof metrics !== "object" || !("wall" in metrics)) continue;
    const raw = metrics.wall;
    const expr = raw && typeof raw === "object" && "expr" in raw ? raw.expr : raw;
    let parsed = null;
    try { parsed = parseAssertion(expr); } catch { parsed = null; }
    if (!parsed || parsed.op !== "range" || parsed.min > parsed.max) {
      throw new Error(`wall expectation for "${name}" must be a range like "1.8..2.2" with min <= max`);
    }
    out[name] = { min: parsed.min, max: parsed.max };
  }
  return out;
}
