// The CLI's sweep budget (bin/cli.js), as a pure function so a test can hold its parsing.
export const DEFAULT_SWEEP_BUDGET_MS = 60_000;

/**
 * PARTFORGE_SWEEP_BUDGET_MS → the budget in ms: a positive number (ms), or "Infinity" (no
 * deadline). Anything else — unset, "", "0", a negative, garbage — is the default minute.
 */
export function parseSweepBudget(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_SWEEP_BUDGET_MS;
  const n = Number(raw);
  return n > 0 ? n : DEFAULT_SWEEP_BUDGET_MS;
}
