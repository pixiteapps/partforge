// PURE heuristic linking a measured dimension to the schema param driving it.
// Candidates come from the sub-part's read keys (param-deps.subPartReadKeys,
// resolved by the caller); a candidate links when its current value matches a
// measured value within the display quantum (0.01), or at value*2 for
// radius-style params against measured diameters. Unique match or nothing —
// never guess between two.
const QUANTUM = 0.005; // half the 0.01 display quantum: |a-b| < 0.005 rounds equal

// A measurement is a length: a control in degrees, radians or percent can only
// match one by coincidence (a ⌀30 is not a 30° tilt), so it never matches.
const NOT_A_LENGTH = /^(°|deg|degs?|degrees?|rad|rads|radians?|%)$/i;
const isNotLength = (unit) => typeof unit === "string" && NOT_A_LENGTH.test(unit.trim());

// Every candidate whose current value matches a measured value (or matches
// diameter at value*2, the radius-style rule) — the set a measurement click
// flashes. linkParam keeps the stricter unique-or-nothing rule for focus.
// `unitOf(key)` (optional) returns the control's unit; angle and percent
// controls are skipped.
export function paramMatches(keys, params, values, unitOf = null) {
  const measured = Object.entries(values)
    .filter(([k, v]) => typeof v === "number" && k !== "partial")
    .map(([, v]) => v);
  const hasDiameter = "diameter" in values;
  const matches = new Set();
  for (const key of keys) {
    const pv = params[key];
    if (typeof pv !== "number") continue;
    if (unitOf && isNotLength(unitOf(key))) continue;
    for (const mv of measured) {
      if (Math.abs(pv - mv) < QUANTUM) { matches.add(key); break; }
      if (hasDiameter && Math.abs(pv * 2 - values.diameter) < QUANTUM) { matches.add(key); break; }
    }
  }
  return [...matches];
}

export function linkParam(keys, params, values, unitOf = null) {
  const matches = paramMatches(keys, params, values, unitOf);
  return matches.length === 1 ? matches[0] : null;
}
