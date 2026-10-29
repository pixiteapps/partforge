// The domain registry (docs/superpowers/specs/2026-10-29-domain-modules-design.md):
// DOMAINS is the one table core reads, and validateDomains refuses a manifest that
// would confuse a consumer — a duplicate or malformed id, a missing field, a process
// with no kind, an id that collides with a measure row key.
import { expect, test } from "vitest";
import { DOMAINS, domainOfOp, validateDomains } from "../src/framework/domains/registry.js";
import fixture from "./fixtures/domain-fixture/manifest.js";

test("DOMAINS is a frozen array (empty until a domain lands)", () => {
  expect(Array.isArray(DOMAINS)).toBe(true);
  expect(Object.isFrozen(DOMAINS)).toBe(true);
});

test("validateDomains accepts the fixture and freezes the list", () => {
  const list = validateDomains([fixture]);
  expect(Object.isFrozen(list)).toBe(true);
  expect(list[0].id).toBe("fixture");
});

test("validateDomains rejects a duplicate id by name", () => {
  expect(() => validateDomains([fixture, { ...fixture }])).toThrow(/^domains: duplicate id "fixture"/);
});

test("validateDomains rejects a manifest missing a required field", () => {
  const { when, ...noWhen } = fixture;
  expect(() => validateDomains([noWhen])).toThrow(/^domains: "fixture" is missing "when"/);
});

test("validateDomains rejects an id that is not kebab-case", () => {
  expect(() => validateDomains([{ ...fixture, id: "Fixture Domain" }])).toThrow(/^domains: id "Fixture Domain"/);
});

test("validateDomains rejects a reserved id (a measure row key)", () => {
  for (const id of ["sheet", "print", "name", "bbox", "bounds", "volume"]) {
    expect(() => validateDomains([{ ...fixture, id }])).toThrow(new RegExp(`^domains: id "${id}" is reserved`));
  }
});

test("validateDomains rejects a process descriptor with no kind", () => {
  const bad = { ...fixture, processes: [{ id: "x", metrics: {}, lintRules: [], profiles: {} }] };
  expect(() => validateDomains([bad])).toThrow(/^domains: "fixture" process "x" has no kind "sheet" \| "print"/);
});

test("domainOfOp names the domain that tagged an op, null for a core op", () => {
  const list = validateDomains([fixture]);
  expect(domainOfOp("tappedBore", list)).toBe("fixture");
  expect(domainOfOp("cylinder", list)).toBeNull();
  expect(domainOfOp("tappedBore")).toBeNull(); // main's DOMAINS is empty
});

test("validateDomains refuses oracle.checks until verify runs them", () => {
  const bad = { ...fixture, oracle: { ...fixture.oracle, checks: [{ id: "x" }] } };
  expect(() => validateDomains([bad])).toThrow(/^domains: "fixture" declares oracle\.checks, which nothing runs yet/);
});
