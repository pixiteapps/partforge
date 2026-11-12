// Pair identity and the contact tolerance, import-free so lint, the oracle and the
// collision check share them without a cycle. oracle/gaps.js re-exports both.

// A measured pair distance at or below this (mm) counts as touching — absorbs
// posing float error while staying far below any real print clearance.
export const CONTACT_EPS = 1e-3;

// Canonical order-insensitive pair identity — the one rule for "the same pair"
// shared by measure's overlap exclusion and verify's declared-pair matching.
export const pairKey = (a, b) => [a, b].sort().join("×");

// Whether a sweep row's contact (oracle/sweep.js) counts against the row: on a sweep that
// lets pieces touch or press in (clearance <= 0), only one whose depth was read past the
// allowance (`allowed: false`) — a contact a timed-out row never read is not known to; on
// any other sweep, every contact.
export const sweepContactBlocks = (row, c) => (row.clearance <= 0 ? c.allowed === false : true);
