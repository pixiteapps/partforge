// A domain whose id names an existing measure row key would overwrite a core fact —
// `holes` is a gate metric — so the stamp refuses it by name. (validateDomains reserves
// the common keys up front; this is the complete guard, at the row.)
import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([{ ...fixture, id: "holes", oracle: { ...fixture.oracle, metrics: {} } }]) };
});
const { measure } = await import("../src/framework/oracle/measure.js");
const { bootManifoldKernel } = await import("../src/testing.js");
const { default: demo } = await import("./fixtures/demo-part.js");

test("a domain id that is a row key throws at the stamp, naming it", async () => {
  const k = await bootManifoldKernel();
  expect(() => measure(k, demo, "all", {}, { now: () => 0 })).toThrow(/measure: domain "holes" collides with a sub-part fact of that name/);
});
