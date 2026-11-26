// The CLI's `sweeps:` line (bin/cli.js), one row of oracle/sweep.js at a time, as a pure
// function so a test can hold its wording. A row's `ms` is never printed.
import { pairKey, sweepContactBlocks } from "../src/framework/collide/pairs.js";
import { TOUCH_TOL_MM } from "../src/framework/collide/depth.js";

const fmtV = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const mm = (d) => `${d.toFixed(2)}mm`;
const moreText = (n) => (n > 0 ? ` (+${n} more)` : "");

/**
 * Clear with its tightest pair, then (a sweep that may touch or press in) its first allowed
 * rub deeper than TOUCH_TOL_MM, with its depth; or a contact with where it starts, its pair
 * (and, on a sweep that may touch, how deep it presses), the param driving it and (a param
 * sweep) the contact-free range; or why it stopped short.
 */
export function sweepText(s) {
  if (s.skipped) return `${s.name} skipped (${s.skipped})`;
  const capped = s.capped ? " (capped)" : "";
  // contacts the row's cap left off (oracle/sweep.js capContacts) are more of them too
  const omitted = s.contactsOmitted ?? 0;
  const touching = s.clearance <= 0;
  if (s.clear) {
    const m = s.minClearance;
    // an allowed stretch that only touches (a lid resting closed) is not a rub
    const rubs = (s.contacts ?? []).filter((c) => c.allowed && c.depth > TOUCH_TOL_MM);
    const rub = rubs.length
      ? `, rub at ${fmtV(rubs[0].from)} ${pairKey(rubs[0].a, rubs[0].b)} (${mm(rubs[0].depth)}, allowed)${moreText(rubs.length - 1 + omitted)}`
      : "";
    return `${s.name} clear${m ? ` (min ${mm(m.distance)} ${pairKey(m.a, m.b)})` : ""}${rub}${capped}`;
  }
  const blocking = s.contacts.filter((x) => sweepContactBlocks(s, x));
  const c = blocking[0] ?? s.contacts[0];
  const free = s.freeRange ? `, free [${s.freeRange.map(fmtV).join(", ")}]` : "";
  const more = moreText(blocking.length - 1 + omitted);
  const deep = touching && c.depth != null ? ` (${mm(c.depth)} deep)` : "";
  return `${s.name} CONTACT at ${fmtV(c.from)} ${pairKey(c.a, c.b)}${deep}${c.unresolved ? " (unresolved)" : ""} driven by ${c.driver ?? "?"}${free}${more}${capped}`;
}

/** One declared line's reading: `rope 212.40mm, bend 10.0 (min 8)`, or why it could not be read. */
export function lineText(l) {
  if (l.error) return `${l.name} unreadable: ${l.error}`;
  const bend = l.bendRatio != null
    ? `, bend ${l.bendRatio.toFixed(1)}${l.minBendRatio != null ? ` (min ${l.minBendRatio})` : ""}`
    : "";
  return `${l.name} ${mm(l.length)}${bend}`;
}
