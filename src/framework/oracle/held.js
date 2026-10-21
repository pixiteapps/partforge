// `_view.held`: every exportable sub-part in the view must be connected, through
// contact or overlap, to a base. A pair-derived check like `contacts` — it reads
// the gap table and overlap list measure already computed and never touches a
// mesh — so it lives beside pairGapChecks, outside the scalar VIEW_METRICS
// registry, and emits the same structured check object.
//
// Topological only: a part balanced on a point passes. Load path and strength
// are not this check's business (AUTHORING-PARTS.md, "Self-verification").
import { CONTACT_EPS } from "./gaps.js";

export const HELD_HINT = "sub-part touches nothing — seat it on a mating face or add the fastener that holds it";

// `held` is `true` (base = the lowest sub-part by bounds.min z) or a sub-part
// name. `subPartNames` is the part's whole vocabulary (so a base that is
// enabled()-off in this case skips rather than throws); `exportableNames` bounds
// the graph to printed sub-parts — a reference ghost neither counts nor holds.
export function heldCheck(facts, held, { subPartNames, exportableNames } = {}) {
  if (held === undefined || held === null) return null;
  if (held !== true && typeof held !== "string") {
    throw new Error(`held: must be true or a sub-part name, got ${JSON.stringify(held)}`);
  }
  const base = {
    scope: "view", subpart: null, metric: "held", kind: "gate",
    expr: held === true ? "connected" : `connected to ${held}`,
  };
  const inView = facts.subparts.map((s) => s.name);
  const known = subPartNames ? new Set(subPartNames) : new Set(inView);
  if (typeof held === "string" && !known.has(held)) {
    throw new Error(`held: unknown sub-part "${held}" (view has: ${inView.join(", ")})`);
  }
  const printed = exportableNames ? new Set(exportableNames) : null;
  const nodes = inView.filter((n) => !printed || printed.has(n));
  if (typeof held === "string" && !nodes.includes(held)) {
    return { ...base, actual: null, status: "skip", pass: null, message: "sub-part disabled in this case" };
  }
  if (nodes.length < 2) {
    return { ...base, actual: 0, status: "pass", pass: true, message: `${nodes.length} sub-part, nothing to hold` };
  }
  // Same rule as pairGapChecks' noReading: a deliberately skipped pass (quick lap)
  // is unevaluated; a legacy result with no table stays an untagged skip.
  if (!facts.gaps) {
    return facts.measuredGaps === false
      ? { ...base, actual: null, status: "skip", pass: null, unevaluated: true,
          message: "not measured (quick check)", hint: "re-run this check without `quick` to measure pair distances" }
      : { ...base, actual: null, status: "skip", pass: null, message: "unavailable" };
  }
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  const join = (a, b) => {
    if (!adj.has(a) || !adj.has(b)) return;
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const o of facts.overlaps ?? []) join(o.a, o.b);
  for (const g of facts.gaps) if (g.distance <= CONTACT_EPS) join(g.a, g.b);
  const rowOf = (n) => facts.subparts.find((s) => s.name === n);
  const zOf = (n) => rowOf(n)?.bounds?.min?.[2];
  const root = held === true
    ? nodes.reduce((best, n) => (zOf(n) != null && (zOf(best) == null || zOf(n) < zOf(best)) ? n : best), nodes[0])
    : held;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    for (const m of adj.get(n)) if (!seen.has(m)) { seen.add(m); queue.push(m); }
  }
  const floating = nodes.filter((n) => !seen.has(n));
  if (floating.length === 0) {
    return { ...base, actual: 0, status: "pass", pass: true, message: `${nodes.length} sub-parts connected to ${root}` };
  }
  const first = rowOf(floating[0]);
  const location = first?.centerOfMass
    ?? (first?.bounds ? first.bounds.min.map((v, i) => (v + first.bounds.max[i]) / 2) : null);
  return {
    ...base, actual: floating.length, status: "fail", pass: false,
    message: `${floating.join(", ")} not connected to ${root}`,
    hint: HELD_HINT, pattern: "floating-subpart",
    ...(location ? { location } : {}),
  };
}
