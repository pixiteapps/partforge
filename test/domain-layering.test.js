// Domain modules' layering (docs/superpowers/specs/2026-10-29-domain-modules-design.md,
// "The layering test"). A domain is src/framework/domains/<id>/; core reads it only
// through domains/registry.js. Held:
//   1. no module outside a domain folder imports from inside one, except the registry,
//   2. every domain folder is registered under its own name,
//   3. every registered domain ships its guide, types, package subpath and reference parts,
//   4. a domain entry's import closure is worker-safe (no three, paper, node:, ingest, testing),
//   5. a domain never imports another domain,
//   6. a manifest's import closure never reaches a module that imports the registry
//      (process/registry.js, verify-metrics.js, oracle/measure.js, lint/index.js,
//      kernel-front.js, and anything above them such as geometry/polygon.js or
//      geometry/probe.js) — that is an import cycle through domains/registry.js, a
//      ReferenceError on DOMAINS that depends on which entry point loads first.
// Rule 2 reads `[]` against `[]` until the first domain lands — the test must pass on
// a tree with nothing under domains/ but registry.js.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, importsOf } from "./helpers/import-graph.js";
import { DOMAINS } from "../src/framework/domains/registry.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const DOMAINS_DIR = `${ROOT}/src/framework/domains`;
const rel = (p) => relative(ROOT, p);
const jsFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? jsFiles(p) : name.endsWith(".js") ? [p] : [];
});
const domainFolder = (p) => p.match(/^src\/framework\/domains\/([^/]+)\//)?.[1] ?? null;
// A relative specifier resolved against its importer, as a repo path.
const target = (file, spec) => rel(join(file, "..", spec));
const folders = () => readdirSync(DOMAINS_DIR).filter((n) => statSync(join(DOMAINS_DIR, n)).isDirectory());
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));

test("1. only the registry imports from a domain folder", () => {
  for (const file of jsFiles(`${ROOT}/src`)) {
    const from = rel(file);
    if (domainFolder(from) || from === "src/framework/domains/registry.js") continue;
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      expect(domainFolder(target(file, spec)), `${from} imports ${spec}`).toBeNull();
    }
  }
});

test("2. every domain folder is registered under its own name", () => {
  expect(folders().sort()).toEqual(DOMAINS.map((d) => d.id).sort());
});

test("3. every registered domain ships its guide, types, subpath and reference parts", () => {
  for (const d of DOMAINS) {
    expect(existsSync(`${ROOT}/${d.guide}`), d.guide).toBe(true);
    expect(existsSync(`${ROOT}/types/${d.id}.d.ts`), `types/${d.id}.d.ts`).toBe(true);
    expect(pkg.exports[`./${d.id}`]?.default, `exports ./${d.id}`).toBe(`./src/framework/domains/${d.id}/index.js`);
    expect(pkg.typesVersions["*"][d.id], `typesVersions ${d.id}`).toEqual([`./types/${d.id}.d.ts`]);
    for (const part of d.referenceParts) expect(existsSync(`${ROOT}/${part}`), part).toBe(true);
  }
});

const NODE_BUILTINS = ["fs", "path", "url", "module", "os", "crypto", "child_process", "worker_threads", "process", "util", "stream", "zlib"];
const bannedBare = (b) => b === "three" || b === "paper" || b.startsWith("paper/") || NODE_BUILTINS.includes(b.replace(/^node:/, ""));

test("4. a domain entry's closure is worker-safe", () => {
  for (const d of DOMAINS) {
    const { bare, files } = walk(`${DOMAINS_DIR}/${d.id}/index.js`, `${d.id} walk`);
    expect([...bare].filter(bannedBare), `${d.id} reaches a banned package`).toEqual([]);
    for (const f of files) {
      const r = rel(f);
      expect(r.startsWith("src/framework/ingest/") || r.startsWith("src/testing/"), `${d.id} reaches ${r}`).toBe(false);
    }
  }
});

test("5. a domain never imports another domain", () => {
  for (const d of DOMAINS) {
    for (const file of jsFiles(`${DOMAINS_DIR}/${d.id}`)) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue;
        const other = domainFolder(target(file, spec));
        expect(other === null || other === d.id, `${rel(file)} imports ${spec}`).toBe(true);
      }
    }
  }
});

// The modules that import the registry at load: a manifest reaching any of them
// closes a cycle. Derived from the tree, so a new consumer is covered the day it is
// written.
const registryConsumers = () => jsFiles(`${ROOT}/src`).filter((file) =>
  rel(file) !== "src/framework/domains/registry.js"
  && importsOf(readFileSync(file, "utf8")).some((spec) => spec.startsWith(".") && target(file, spec) === "src/framework/domains/registry.js"));

// The consumers a manifest's closure reaches, as repo paths (empty when clean).
export const manifestCycleHits = (manifestPath) => {
  const consumers = new Set(registryConsumers().map(rel));
  const { files } = walk(manifestPath, "manifest walk");
  return [...files].map(rel).filter((f) => consumers.has(f)).sort();
};

test("6. a manifest's closure never reaches a module that imports the registry", () => {
  expect(registryConsumers().length, "the registry has consumers").toBeGreaterThan(0);
  for (const d of DOMAINS) {
    expect(manifestCycleHits(`${DOMAINS_DIR}/${d.id}/manifest.js`), `${d.id}'s manifest closes an import cycle`).toEqual([]);
  }
});

test("6. the rule sees the fixture manifest as clean and a manifest importing a consumer as a cycle", () => {
  expect(manifestCycleHits(`${ROOT}/test/fixtures/domain-fixture/manifest.js`)).toEqual([]);
  expect(manifestCycleHits(`${ROOT}/test/fixtures/domain-fixture/cyclic-manifest.js`)).toEqual(["src/framework/process/registry.js"]);
});
