// The CLI's `sweeps:` line (bin/cli.js), one row of oracle/sweep.js at a time, as a pure
// function so a test can hold its wording. A row's `ms` is never printed.
import { pairKey, sweepContactBlocks } from "../src/framework/collide/pairs.js";

const fmtV = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const mm = (d) => `${d.toFixed(2)}mm`;

/**
 * Clear with its tightest pair, then (a sweep that may touch or press in) its first allowed
 * rub with its depth; or a contact with where it starts, its pair (and, on a sweep that
 * may touch, how deep it presses), the param driving it and (a param sweep) the
 * contact-free range; or why it stopped short.
 */
export function sweepText(s) {
  if (s.skipped) return `${s.name} skipped (${s.skipped})`;
  const capped = s.capped ? " (capped)" : "";
  const touching = s.clearance <= 0;
  if (s.clear) {
    const m = s.minClearance;
    const rubs = (s.contacts ?? []).filter((c) => c.allowed);
    const rub = rubs.length
      ? `, rub at ${fmtV(rubs[0].from)} ${pairKey(rubs[0].a, rubs[0].b)} (${mm(rubs[0].depth)}, allowed)${rubs.length > 1 ? ` (+${rubs.length - 1} more)` : ""}`
      : "";
    return `${s.name} clear${m ? ` (min ${mm(m.distance)} ${pairKey(m.a, m.b)})` : ""}${rub}${capped}`;
  }
  const blocking = s.contacts.filter((x) => sweepContactBlocks(s, x));
  const c = blocking[0] ?? s.contacts[0];
  const free = s.freeRange ? `, free [${s.freeRange.map(fmtV).join(", ")}]` : "";
  const more = blocking.length > 1 ? ` (+${blocking.length - 1} more)` : "";
  const deep = touching && c.depth != null ? ` (${mm(c.depth)} deep)` : "";
  return `${s.name} CONTACT at ${fmtV(c.from)} ${pairKey(c.a, c.b)}${deep}${c.unresolved ? " (unresolved)" : ""} driven by ${c.driver ?? "?"}${free}${more}${capped}`;
}
