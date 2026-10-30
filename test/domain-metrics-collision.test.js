// A domain metric named like a core, print or sheet metric is a LOAD error naming
// both sides — never a silent overwrite of SUBPART_METRICS. Its own file: vi.mock
// is per file, and this mock's domain collides on purpose.
import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([{ ...fixture, oracle: { ...fixture.oracle, metrics: { volume: fixture.oracle.metrics.fixtureSeen } } }]) };
});

test("a domain metric named like a core metric fails at load, naming both", async () => {
  await expect(import("../src/framework/verify-metrics.js")).rejects.toThrow(/verify-metrics: domain "fixture" metric "volume" collides/);
});
