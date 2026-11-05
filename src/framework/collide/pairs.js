// Pair identity and the contact tolerance, import-free so lint, the oracle and the
// collision check share them without a cycle. oracle/gaps.js re-exports both.

// A measured pair distance at or below this (mm) counts as touching — absorbs
// posing float error while staying far below any real print clearance.
export const CONTACT_EPS = 1e-3;

// Canonical order-insensitive pair identity — the one rule for "the same pair"
// shared by measure's overlap exclusion and verify's declared-pair matching.
export const pairKey = (a, b) => [a, b].sort().join("×");
