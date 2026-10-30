// A domain process whose id, profile id or metric name repeats an existing one is a
// LOAD error, never a silent shadow: processById would answer with the in-repo
// descriptor, PRINT_PROFILES with the last writer, SHEET_METRICS with the last
// process. Own file: vi.mock is per file and these mocks collide on purpose.
import { expect, test, vi } from "vitest";

const fixtureWith = async (processes) => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([{ ...fixture, oracle: { ...fixture.oracle, metrics: {} }, processes }]) };
};

vi.mock("../src/framework/domains/registry.js", async () => fixtureWith([
  { id: "laser", kind: "sheet", metrics: {}, lintRules: [], profiles: {} },
]));

test("a domain process with an in-repo process id fails at load, naming it", async () => {
  await expect(import("../src/framework/process/registry.js")).rejects.toThrow(/process registry: duplicate process id "laser"/);
});
