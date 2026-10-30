import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([{ ...fixture, oracle: { ...fixture.oracle, metrics: {} }, processes: [
    { id: "fixture-print", kind: "print", metrics: {}, lintRules: [], profiles: { "fdm-pla": { base: null } }, costs: {} },
  ] }]) };
});

test("a domain print profile with an existing profile id fails at load, naming it", async () => {
  await expect(import("../src/framework/process/registry.js")).rejects.toThrow(/process registry: duplicate profile id "fdm-pla"/);
});
