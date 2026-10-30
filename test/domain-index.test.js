// The authoring guide's "## Domains" section is GENERATED from the domain registry by
// scripts/generate-domain-index.mjs and committed; this test holds the committed
// block to the registry (the way partforge-cloud holds its corpus to the installed
// package), and pins the section's place: once, right after Quickstart, so an agent
// that has never heard of a domain meets the index before any geometry.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { renderDomainIndex, GENERATED_START, GENERATED_END } from "../scripts/generate-domain-index.mjs";
import { DOMAINS } from "../src/framework/domains/registry.js";
import fixture from "./fixtures/domain-fixture/manifest.js";

const guide = readFileSync(fileURLToPath(new URL("../docs/AUTHORING-PARTS.md", import.meta.url)), "utf8");

test("the committed index matches the registry", () => {
  const start = guide.indexOf(GENERATED_START);
  const end = guide.indexOf(GENERATED_END);
  expect(start, "generated block start").toBeGreaterThan(-1);
  expect(end, "generated block end").toBeGreaterThan(start);
  const block = guide.slice(start, end + GENERATED_END.length);
  expect(renderDomainIndex(DOMAINS)).toContain(block);
});

test("## Domains sits once, right after Quickstart", () => {
  const h2 = [...guide.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(h2.filter((h) => h === "Domains")).toHaveLength(1);
  expect(h2[h2.indexOf("Domains") - 1]).toBe("Quickstart");
});

test("a domain renders as one row", () => {
  expect(renderDomainIndex([fixture])).toContain(
    '| Fixture | a test-only domain; never in a real part | `import { … } from "partforge/fixture"` | [`test/fixtures/domain-fixture/guide.md`](../test/fixtures/domain-fixture/guide.md) |');
});

test("with no domains the table is its header alone", () => {
  const out = renderDomainIndex([]);
  expect(out).toContain("| Domain | Use it for | Import | Guide |\n|---|---|---|---|\n" + GENERATED_END);
});
