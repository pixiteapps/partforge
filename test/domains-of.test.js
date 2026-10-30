// partforge/lint's host-facing domain surface: `domainsOf(sources)` reads the domains
// a part uses from its SOURCE (a static import of the domain's subpath, or a call of
// an op the domain tagged), and `DOMAINS` is the registry projected to names only, so
// a host can JSON it into a prompt. The registry is mocked to carry the fixture.
import { expect, test, vi } from "vitest";

vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([fixture]) };
});
const { domainsOf, DOMAINS } = await import("../src/lint.js");

const src = (text) => ({ files: { "part.js": text }, entrypoint: "part.js" });

test("a static import of the subpath counts", () => {
  expect(domainsOf(src('import { thing } from "partforge/fixture";\nexport default {};'))).toEqual(["fixture"]);
});

test("a re-export from the subpath counts", () => {
  expect(domainsOf(src("export { thing } from 'partforge/fixture';"))).toEqual(["fixture"]);
});

test("a tagged op call counts", () => {
  expect(domainsOf(src("export default { parts: { a: { build: (k) => k.tappedBore({ od: 5, h: 3 }) } } };"))).toEqual(["fixture"]);
});

test("prose, a string literal and a dynamic import do not count", () => {
  expect(domainsOf(src('// see partforge/fixture, and k.tappedBore(\nconst s = "partforge/fixture";\nconst t = "k.tappedBore(";\nconst m = import("partforge/fixture");'))).toEqual([]);
});

test("a domain found in any file counts once, sorted", () => {
  const sources = { files: { "a.js": 'import "partforge/fixture";', "b.js": "k.tappedBore({})" }, entrypoint: "a.js" };
  expect(domainsOf(sources)).toEqual(["fixture"]);
});

test("malformed sources give []", () => {
  expect(domainsOf(null)).toEqual([]);
  expect(domainsOf({ files: { a: 3 } })).toEqual([]);
  expect(domainsOf({ files: null })).toEqual([]);
});

test("DOMAINS carries names only", () => {
  expect(DOMAINS[0]).toEqual({ id: "fixture", title: "Fixture", when: "a test-only domain; never in a real part", subpath: "partforge/fixture", guide: "test/fixtures/domain-fixture/guide.md", kernelOps: ["tappedBore"] });
  expect(Object.isFrozen(DOMAINS)).toBe(true);
  expect(() => JSON.stringify(DOMAINS)).not.toThrow();
});

test("a template literal holding an import line does not count", () => {
  expect(domainsOf(src("const doc = `import { x } from \"partforge/fixture\"`;"))).toEqual([]);
});

test("without semicolons, a later string does not count against an earlier import", () => {
  expect(domainsOf(src("import { a } from './a'\nconst s = \"… from 'partforge/fixture'\"\nexport default {}"))).toEqual([]);
});

test("export default followed by a string naming the subpath does not count", () => {
  expect(domainsOf(src("export default { title: \"x\" }\nconst s = \"from 'partforge/fixture'\""))).toEqual([]);
});

test("a real import between strings that look like comment delimiters still counts", () => {
  expect(domainsOf(src("const a = \"src/*\";\nimport { x } from \"partforge/fixture\";\nconst b = \"*/\";"))).toEqual(["fixture"]);
});

test("a multi-line import counts", () => {
  expect(domainsOf(src("import {\n  x,\n  y,\n} from \"partforge/fixture\";"))).toEqual(["fixture"]);
});
