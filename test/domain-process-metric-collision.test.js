import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([{ ...fixture, oracle: { ...fixture.oracle, metrics: {} }, processes: [
    { id: "fixture-cut", kind: "sheet", metrics: { volume: { kind: "warn", extract: () => 1, hint: "h", doc: "x" } }, lintRules: [], profiles: {} },
  ] }]) };
});

test("a process metric named like a core metric fails at load, naming both", async () => {
  await expect(import("../src/framework/verify-metrics.js")).rejects.toThrow(/verify-metrics: process "fixture-cut" metric "volume" collides/);
});
