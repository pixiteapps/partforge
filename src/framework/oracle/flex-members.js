// src/framework/oracle/flex-members.js
// The shape of `verify.flex`: the part's flexing members, as declared, normalized to one
// record each. Import-free and pure — the linter reads it at boot (rules-verify.js's
// verify-bad-flex and verify-flex-unknown-label), so it must stay a leaf the worker can
// load eagerly, apart from flex-root.js's reading, which loads with the rest of the
// oracle on the first inspect job (test/worker-layering.test.js).

/**
 * The flexing members `verify.flex` declares, one record each: `{ feature, labels,
 * deflection, thickness }`. An entry is a label, a list of labels read as one member
 * (named by its first), or an object `{ feature, labels?, deflection?, thickness? }` —
 * `deflection` the travel in mm the member is designed to flex through (arms the strain
 * reading), `thickness` its bending thickness in mm when the author knows it better than
 * the mesh does. A malformed entry is dropped (lint's verify-bad-flex reports it).
 */
export function flexMembers(flex) {
  if (!Array.isArray(flex)) return [];
  const label = (l) => typeof l === "string" && l.length > 0;
  const labels = (ls) => Array.isArray(ls) && ls.length > 0 && ls.every(label);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const out = [];
  for (const e of flex) {
    if (label(e)) out.push({ feature: e, labels: [e], deflection: null, thickness: null });
    else if (labels(e)) out.push({ feature: e[0], labels: [...e], deflection: null, thickness: null });
    else if (e && typeof e === "object" && !Array.isArray(e) && label(e.feature)) {
      out.push({ feature: e.feature, labels: labels(e.labels) ? [...e.labels] : [e.feature],
        deflection: num(e.deflection), thickness: num(e.thickness) });
    }
  }
  return out;
}

/** The label groups of `flex`, as measure() stamps them (`measuredFlex`). */
export const flexGroups = (flex) => flexMembers(flex).map((m) => m.labels);

