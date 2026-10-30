// The process registry (process/registry.js) derives domain processes from the domain
// registry by each descriptor's kind: "sheet" joins PROCESSES, "print" joins
// PRINT_PROCESSES, in-repo descriptors first. (A descriptor with no kind is refused by
// validateDomains, test/domain-registry.test.js.)
import { expect, test, vi } from "vitest";

const SHEETISH = { id: "fixture-cut", kind: "sheet", metrics: {}, lintRules: [], profiles: {} };
const PRINTISH = { id: "fixture-print", kind: "print", metrics: {}, lintRules: [], profiles: { "fixture-print": { base: null } }, costs: {} };
vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([{ ...fixture, processes: [SHEETISH, PRINTISH] }]) };
});
const { PROCESS_IDS, PRINT_PROCESS_IDS, printProcessFor, processById } = await import("../src/framework/process/registry.js");

test("a domain's sheet process joins PROCESSES and its print process joins PRINT_PROCESSES", () => {
  expect(PROCESS_IDS).toEqual(["laser", "cnc-router", "fixture-cut"]);
  expect(PRINT_PROCESS_IDS).toEqual(["fdm", "resin", "fixture-print"]);
  expect(processById("fixture-cut")?.id).toBe("fixture-cut");
  expect(printProcessFor("fixture-print")?.id).toBe("fixture-print");
});
