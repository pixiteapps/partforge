# Domain Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the domain-module contract on `main`: the registry core reads, the layering test that holds its direction, the core consumers (kernel front, lint, oracle, metrics, process registry), the domain index in the authoring guide, and the `partforge/lint` exports a host reads — with a test-only fixture domain proving every seam, since the first real domain (kinematics) arrives in the limb session's PR A.

**Architecture:** `src/framework/domains/registry.js` exports `DOMAINS`, an array of plain-data manifests (empty on `main` today). Each core consumer imports `DOMAINS` and folds it in after its own data: kernel-front attaches domain ops, lint appends domain rules, measure stamps domain facts, verify-metrics spreads domain metrics, the process registry derives from domain processes. Tests exercise the seams by `vi.mock`-ing `registry.js` to return the fixture manifest, so no production API grows a test-only parameter. A layering test walks the import graph and holds core out of domain folders.

**Tech Stack:** plain ESM, Node 24, vitest, the `test/helpers/import-graph.js` walker.

**Spec:** `docs/superpowers/specs/2026-10-29-domain-modules-design.md`

## Global Constraints

- Node 24 (`nvm use`); plain ESM; no new runtime dependencies.
- A manifest is plain data plus functions; importing it runs nothing. The registry and every manifest it lists must be loadable by lint (`test/lint-purity.test.js`: no `three`, `manifold-3d`, `replicad`, no bare deps at all), by the worker (`test/worker-layering.test.js`: no `node:` builtins, no DOM globals, no `src/framework/ingest/`, no `src/testing/`), and by the oracle entry.
- No manifest's `lintRules` may import `lint/rules-verify.js` or `verify-metrics.js`, even transitively (TDZ: `verify-metrics.js` reads the registry at module top level).
- Core never imports from `src/framework/domains/<id>/`; only `domains/registry.js` (manifests) and `package.json` (the subpath entry) may.
- Every op a manifest tags in `kernelOps` must be in `KERNEL_OPS` or `KERNEL_OPTIONAL_OPS`; an op is tagged by at most one domain.
- Metric names must not collide across `SUBPART_METRICS`, `SHEET_METRICS` and every domain's `oracle.metrics`.
- Sheet, print, text, vector, image, import and organic do **not** move. Their by-name wiring stays beside the registry.
- `test/verify-golden.test.js` must pass unchanged (no verdict moves).
- `package.json` version bump to `0.171.0` on this PR.
- No partforge-cloud change.

## Review Focus

1. A manifest listed twice, or two manifests sharing an `id`: `DOMAINS` must reject duplicates at load with an error naming the id (test in Task 1).
2. A manifest tagging an op that is not in the kernel contract, or an op tagged by two domains: must fail `test/kernel-contract.test.js`, never silently drop the tag (Task 4).
3. A domain metric whose name equals a print or sheet metric: must fail `test/verify-metrics.test.js` with the colliding name, and `SUBPART_METRICS` must not be silently overwritten (Task 6).
4. A domain `oracle.facts` that throws for one sub-part: the row gets `{ error }` under the domain id and every other row still measures, as `sheetRowFacts` already does for sheet rows (Task 7).
5. `domainsOf` given sources with a dynamic `import("partforge/x")`, a comment mentioning the subpath, or a string literal: only a real static import or a tagged op call counts; prose does not (Task 9).

---

### Task 1: The registry and the fixture manifest

**Files:**
- Create: `src/framework/domains/registry.js`
- Create: `test/fixtures/domain-fixture/manifest.js`
- Create: `test/fixtures/domain-fixture/index.js`
- Create: `test/fixtures/domain-fixture/guide.md` (one heading and one sentence)
- Test: `test/domain-registry.test.js`

**Interfaces:**
- Produces: `DOMAINS: readonly Manifest[]` (frozen; empty on `main`); `validateDomains(list: Manifest[]): Manifest[]` (returns the frozen list or throws `Error` whose message starts with `domains:`); `Manifest` shape as the spec's manifest block: `{ id, title, when, subpath, guide, referenceParts, kernelOps, lintRules, oracle: { facts, metrics, checks }, processes, workerSafe }`.
- Fixture: `test/fixtures/domain-fixture/manifest.js` default-exports a manifest with `id: "fixture"`, `title: "Fixture"`, `when: "a test-only domain; never in a real part"`, `subpath: "partforge/fixture"`, `guide: "test/fixtures/domain-fixture/guide.md"`, `referenceParts: []`, `kernelOps: [{ name: "tappedBore", attach: (k) => { k.fixtureAttached = true; k.tappedBore = "fixture"; } }]` (an existing contract op with a compound default and no backend implementation, so the tag is legal and the attach observably wins), `lintRules: [{ id: "fixture-rule", run: (ctx) => ctx.part?.fixtureFlag ? [warn("fixture-rule", "fixture flag set")] : [] }]` (importing `warn` from `src/framework/lint/finding.js` only), `oracle: { facts: (sp) => ({ seen: sp?.name ?? null }), metrics: { fixtureSeen: { kind: "warn", extract: (s) => s.fixture?.seen, hint: "fixture metric", doc: "fixture" } }, checks: [] }`, `processes: []`, `workerSafe: true`. `index.js` exports `const fixture = true`.

- [ ] **Step 1: Write the failing test**

```js
// test/domain-registry.test.js
import { expect, test } from "vitest";
import { DOMAINS, validateDomains } from "../src/framework/domains/registry.js";
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/domain-registry.test.js`
Expected: FAIL, cannot resolve `../src/framework/domains/registry.js`

- [ ] **Step 3: Implement `registry.js` and the fixture**

`validateDomains(list)` checks, in order: each entry is an object; `id` matches `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`; the required string fields `title`, `when`, `subpath`, `guide` are non-empty strings; `referenceParts`, `kernelOps`, `lintRules`, `processes` are arrays; `oracle` is an object with `facts` null-or-function, `metrics` object, `checks` array; `workerSafe` is boolean; every `processes[]` entry has `kind` `"sheet"` or `"print"`; the id is not one of the reserved measure-row keys `sheet`, `print`, `name`, `bbox`, `bounds`, `volume`; no two ids repeat. It returns `Object.freeze([...list])`. `export const DOMAINS = validateDomains([]);` with a comment that the kinematics domain adds the first line.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/domain-registry.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/framework/domains/registry.js test/fixtures/domain-fixture test/domain-registry.test.js
git commit -m "feat(domains): the domain registry and a test fixture manifest"
```

---

### Task 2: The layering test

**Files:**
- Test: `test/domain-layering.test.js`

**Interfaces:**
- Consumes: `walk`, `importsOf`, `chainTo` from `test/helpers/import-graph.js`; `DOMAINS` from Task 1.

- [ ] **Step 1: Write the test**

The test is the deliverable; it must pass on the current tree (no domain folder exists yet) and keep passing as domains land. Hold the spec's five rules:

```js
// test/domain-layering.test.js
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
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
    expect(pkg.typesVersions["*"][d.id]).toEqual([`./types/${d.id}.d.ts`]);
    for (const part of d.referenceParts) expect(existsSync(`${ROOT}/${part}`), part).toBe(true);
  }
});

test("4. a domain entry's closure is worker-safe", () => {
  const NODE = ["fs", "path", "url", "module", "os", "crypto", "child_process", "worker_threads", "process", "util", "stream", "zlib"];
  for (const d of DOMAINS) {
    const { bare, files } = walk(`${DOMAINS_DIR}/${d.id}/index.js`, `${d.id} walk`);
    expect([...bare].filter((b) => b === "three" || b === "paper" || b.startsWith("paper/") || NODE.includes(b.replace(/^node:/, "")))).toEqual([]);
    for (const f of files) expect(rel(f).startsWith("src/framework/ingest/") || rel(f).startsWith("src/testing/"), rel(f)).toBe(false);
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
```

Rule 2 must tolerate a missing `src/framework/domains/` listing nothing but `registry.js`: `folders()` returns `[]` and `DOMAINS` is `[]`.

- [ ] **Step 2: Run it to verify it passes on the current tree**

Run: `npx vitest run test/domain-layering.test.js`
Expected: PASS (5 tests)

- [ ] **Step 3: Prove it bites**

Temporarily create `src/framework/domains/stub/index.js` (empty file), run the test, expect rule 2 to FAIL naming `stub`; delete the file.

- [ ] **Step 4: Commit**

```bash
git add test/domain-layering.test.js
git commit -m "test(domains): the layering test — core never imports a domain folder"
```

---

### Task 3: Lint reads the registry

**Files:**
- Modify: `src/framework/lint/index.js:26` (the `RULES` line)
- Test: `test/domain-lint.test.js`

**Interfaces:**
- Consumes: `DOMAINS` (Task 1).
- Produces: `RULES` now ends with `...DOMAINS.flatMap((d) => d.lintRules)`.

- [ ] **Step 1: Write the failing test**

```js
// test/domain-lint.test.js
import { expect, test, vi } from "vitest";
vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([fixture]) };
});
const { RULES, lintPart } = await import("../src/lint.js");

test("a domain's lint rules join RULES after the core rules", () => {
  expect(RULES.at(-1).id).toBe("fixture-rule");
});

test("a domain rule runs inside lintPart's guard", async () => {
  const { default: demo } = await import("./fixtures/demo-part.js");
  const report = lintPart({ ...demo, fixtureFlag: true });
  expect(report.warnings.map((w) => w.id)).toContain("fixture-rule");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/domain-lint.test.js`
Expected: FAIL, `RULES.at(-1).id` is a sheet rule id

- [ ] **Step 3: Implement**

In `lint/index.js`, import `DOMAINS` from `../domains/registry.js` and append `...DOMAINS.flatMap((d) => d.lintRules)` to `RULES`.

- [ ] **Step 4: Run the test and the purity guards**

Run: `npx vitest run test/domain-lint.test.js test/lint-purity.test.js test/lint-registry.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/index.js test/domain-lint.test.js
git commit -m "feat(lint): domain rules join RULES from the registry"
```

---

### Task 4: Kernel ops are tagged by domain

**Files:**
- Modify: `src/framework/geometry/kernel-front.js:33` (`finishKernel`)
- Modify: `test/kernel-contract.test.js`
- Test: `test/domain-kernel-ops.test.js`

**Interfaces:**
- Consumes: `DOMAINS`, `KERNEL_OPS`, `KERNEL_OPTIONAL_OPS`.
- Produces: `finishKernel(k)` calls `op.attach(k)` for every `op` in every manifest's `kernelOps` **first**, right after `quietArcs` is defined and before the first compound default (`k.boredCylinder ??=`), so the precedence is backend-native, then domain, then compound default; `attach` runs only when `k[op.name]` is undefined. Running before the `KERNEL_OP_SPECS` wrap loop means a domain op listed in `KERNEL_OP_SPECS` gets the same options validation as a backend-native one.
- Produces: `domainOfOp(name): string | null` exported from `registry.js`.

- [ ] **Step 1: Write the failing tests**

```js
// test/domain-kernel-ops.test.js
import { expect, test, vi } from "vitest";
vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  const actual = await vi.importActual("../src/framework/domains/registry.js");
  return { ...actual, DOMAINS: Object.freeze([fixture]) };
});
const { finishKernel } = await import("../src/framework/geometry/kernel-front.js");
const { domainOfOp } = await import("../src/framework/domains/registry.js");

test("finishKernel runs each domain op's attach", () => {
  const k = finishKernel({});
  expect(k.fixtureAttached).toBe(true);
  expect(k.tappedBore).toBe("fixture");
});

test("domainOfOp answers from the registry", () => {
  expect(domainOfOp("tappedBore")).toBe("fixture");
  expect(domainOfOp("cylinder")).toBeNull();
});
```

Add to `test/kernel-contract.test.js` (unmocked, against the real `DOMAINS`):

```js
test("every domain-tagged op is in the contract, tagged once", () => {
  const legal = new Set([...KERNEL_OPS, ...KERNEL_OPTIONAL_OPS]);
  const seen = new Map();
  for (const d of DOMAINS) for (const op of d.kernelOps) {
    expect(legal.has(op.name), `${d.id} tags "${op.name}", not a contract op`).toBe(true);
    expect(seen.get(op.name), `"${op.name}" tagged by ${seen.get(op.name)} and ${d.id}`).toBeUndefined();
    seen.set(op.name, d.id);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain-kernel-ops.test.js`
Expected: FAIL, `fixtureAttached` undefined; `domainOfOp` not exported

- [ ] **Step 3: Implement**

`registry.js`: `export const domainOfOp = (name) => DOMAINS.find((d) => d.kernelOps.some((op) => op.name === name))?.id ?? null;`.
`kernel-front.js`: immediately after the `quietArcs` definition, `for (const d of DOMAINS) for (const op of d.kernelOps) if (k[op.name] === undefined) op.attach(k);`. The compound defaults are all `??=` lambdas and the wrap loop skips absent ops, so the test's stub kernel `{}` is enough; the fixture tags `tappedBore`, a compound default, and the test additionally asserts `k.tappedBore` is still the fixture's value after `finishKernel` (the default did not overwrite it).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/domain-kernel-ops.test.js test/kernel-contract.test.js test/occt-backend.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/kernel-front.js src/framework/domains/registry.js test/domain-kernel-ops.test.js test/kernel-contract.test.js
git commit -m "feat(kernel): domain ops attach through the registry and carry a domain tag"
```

---

### Task 5: The process registry derives from domains

**Files:**
- Modify: `src/framework/process/registry.js:13-15,30-32`
- Test: `test/domain-processes.test.js`

**Interfaces:**
- Consumes: `DOMAINS`; each process descriptor gains nothing — a domain lists descriptors under `processes`, and the registry sorts them by `descriptor.kind` (`"sheet"` or `"print"`). The four existing descriptors already distinguish by list, so add `kind: "sheet"` to `LASER`/`ROUTER` and `kind: "print"` to `FDM`/`RESIN` (plain data; `test/sheet-layering.test.js` rule 2 still holds since no import is added).
- Produces: `PROCESSES = [LASER, ROUTER, ...domainProcesses("sheet")]`, `PRINT_PROCESSES = [FDM, RESIN, ...domainProcesses("print")]`; `EXPORTER_LOADERS` in `process/exporters.js` is unchanged in this PR (a domain process with an exporter is the sheet migration's problem; `test/kit-export-guards.test.js` keeps pinning the two lists equal).

- [ ] **Step 1: Write the failing test**

```js
// test/domain-processes.test.js
import { expect, test, vi } from "vitest";
const SHEETISH = { id: "fixture-cut", kind: "sheet", metrics: {}, lintRules: [], profiles: {} };
const PRINTISH = { id: "fixture-print", kind: "print", metrics: {}, lintRules: [], profiles: { "fixture-print": { base: null } }, costs: {} };
vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([{ ...fixture, processes: [SHEETISH, PRINTISH] }]) };
});
const { PROCESS_IDS, PRINT_PROCESS_IDS, printProcessFor } = await import("../src/framework/process/registry.js");

test("a domain's sheet process joins PROCESSES and its print process joins PRINT_PROCESSES", () => {
  expect(PROCESS_IDS).toEqual(["laser", "cnc-router", "fixture-cut"]);
  expect(PRINT_PROCESS_IDS).toEqual(["fdm", "resin", "fixture-print"]);
  expect(printProcessFor("fixture-print")?.id).toBe("fixture-print");
});
```

(A descriptor with no `kind` is refused by `validateDomains`, Task 1.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain-processes.test.js`
Expected: FAIL, `PROCESS_IDS` lacks `fixture-cut`

- [ ] **Step 3: Implement**

In `process/registry.js` import `DOMAINS` and compute `const domainProcesses = (kind) => DOMAINS.flatMap((d) => d.processes.filter((p) => p.kind === kind));`. Keep `PROCESSES`/`PRINT_PROCESSES` order: in-repo descriptors first, then domains in registry order. `sheet-layering.test.js` rule 2 ("a descriptor imports nothing but constants and finding") is unaffected; its rule 1 (only `registry.js` and `exporters.js` import a process folder) is unaffected because the domain path is not under `process/`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/domain-processes.test.js test/domain-registry.test.js test/sheet-layering.test.js test/kit-export-guards.test.js test/verify-metrics.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/process/registry.js src/framework/process/*/descriptor.js test/domain-processes.test.js
git commit -m "feat(process): the process registry derives domain processes by kind"
```

---

### Task 6: Verify metrics spread domain metrics

**Files:**
- Modify: `src/framework/verify-metrics.js:16,161`
- Modify: `test/verify-metrics.test.js`
- Test: `test/domain-metrics.test.js`

**Interfaces:**
- Consumes: `DOMAINS`.
- Produces: `SUBPART_METRICS = { …core, ...SHEET_METRICS, ...domainMetrics() }` where `domainMetrics()` throws `Error("verify-metrics: domain "<id>" metric "<name>" collides with …")` on any key already present — a collision is a load error, never a silent overwrite. `PRINT_ONLY` in `oracle/verify.js:218` is unchanged in this PR (the spec's `appliesTo` tag lands with the print migration).

- [ ] **Step 1: Write the failing tests**

```js
// test/domain-metrics.test.js
import { expect, test, vi } from "vitest";
vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([fixture]) };
});
const { SUBPART_METRICS } = await import("../src/framework/verify-metrics.js");

test("a domain metric joins the sub-part vocabulary", () => {
  expect(SUBPART_METRICS.fixtureSeen.kind).toBe("warn");
  expect(SUBPART_METRICS.fixtureSeen.extract({ fixture: { seen: "a" } })).toBe("a");
});
```

```js
// test/domain-metrics-collision.test.js (its own file: vi.mock is per file)
import { expect, test, vi } from "vitest";
vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  return { DOMAINS: Object.freeze([{ ...fixture, oracle: { ...fixture.oracle, metrics: { volume: fixture.oracle.metrics.fixtureSeen } } }]) };
});

test("a domain metric named like a core metric fails at load, naming both", async () => {
  await expect(import("../src/framework/verify-metrics.js")).rejects.toThrow(/verify-metrics: domain "fixture" metric "volume" collides/);
});
```

Add to `test/verify-metrics.test.js`'s existing collision test: every real `DOMAINS` metric name is absent from `PRINT_METRICS` and `SHEET_METRICS` (vacuous today, holds as domains land).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain-metrics.test.js test/domain-metrics-collision.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

In `verify-metrics.js`, build `SUBPART_METRICS` as a `const base = {…}` then `export const SUBPART_METRICS = withDomainMetrics(base)` where `withDomainMetrics` iterates `DOMAINS` and throws on `Object.hasOwn(out, name)`. Keep every existing key and object identity (`verify.js re-exports the same registry objects` test).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/domain-metrics.test.js test/domain-metrics-collision.test.js test/verify-metrics.test.js test/types-surface.test.js test/verify-golden.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/verify-metrics.js test/domain-metrics.test.js test/domain-metrics-collision.test.js test/verify-metrics.test.js
git commit -m "feat(verify): domain metrics join SUBPART_METRICS; a collision is a load error"
```

---

### Task 7: Measure stamps domain facts

**Files:**
- Modify: `src/framework/oracle/measure.js:475-479` (the row object)
- Test: `test/domain-measure.test.js`

**Interfaces:**
- Consumes: `DOMAINS`.
- Produces: each `measure()` sub-part row gains, for every domain with a non-null `oracle.facts`, a key `row[d.id] = facts` where `facts = d.oracle.facts(sp, { name, view, p, d: derived, volume, bbox })` wrapped in try/catch, a throw becoming `{ error: String(e?.message || e).slice(0, 200) }` (the shape `sheetRowFacts` already uses at line 146). A domain id that equals an existing row key is refused by `validateDomains` (Task 1's reserved list).
- The memo key (`memoKey` at line ~372) must include a domain-facts bit: a sub-part with any domain facts is **never memoized** in this PR (the simplest correct rule; the spec's "a fact that reads anything else is never memoized").

- [ ] **Step 1: Write the failing test**

```js
// test/domain-measure.test.js
import { expect, test, vi } from "vitest";
vi.mock("../src/framework/domains/registry.js", async () => {
  const fixture = (await import("./fixtures/domain-fixture/manifest.js")).default;
  const throwing = { ...fixture, id: "fixture-throws", oracle: { ...fixture.oracle, facts: () => { throw new Error("boom"); } } };
  return { DOMAINS: Object.freeze([fixture, throwing]) };
});
const { measure } = await import("../src/framework/oracle/measure.js");
const { bootManifoldKernel } = await import("../src/testing.js");
const { default: demo } = await import("./fixtures/demo-part.js");

test("every row carries each domain's facts under the domain id, a throw as { error }", async () => {
  const k = await bootManifoldKernel();
  const report = measure(k, demo, "all", {}, { now: () => 0 });
  for (const row of report.subparts) {
    expect(row.fixture).toEqual({ seen: row.name });
    expect(row["fixture-throws"]).toEqual({ error: "boom" });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain-measure.test.js`
Expected: FAIL, `row.fixture` undefined

- [ ] **Step 3: Implement**

In `measure.js`, after the `sheet:` entry of the row object, spread `...domainFacts(part.parts[name], { name, view, p: poseParams?.p ?? null, d: poseParams?.d ?? null, volume: vol, bbox: size(b) })` where `domainFacts` is a module-local helper over `DOMAINS`. Add `&& !hasDomainFacts` to the `memoKey` condition.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/domain-measure.test.js test/measure.test.js test/measure-memo.test.js test/verify-golden.test.js test/oracle-entry.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/measure.js test/domain-measure.test.js
git commit -m "feat(oracle): measure stamps each domain's facts on every row"
```

---

### Task 8: The domain index in the authoring guide

**Files:**
- Create: `scripts/generate-domain-index.mjs`
- Modify: `docs/AUTHORING-PARTS.md` (a new `## Domains` section between `## Quickstart` and `## Before geometry: state the engineering intent`)
- Modify: `package.json` (`files` gains `"docs/domains"`; `scripts` gains `"docs:domains": "node scripts/generate-domain-index.mjs"`)
- Test: `test/domain-index.test.js`

**Interfaces:**
- Consumes: `DOMAINS`.
- Produces: `renderDomainIndex(domains): string`, exported from the script, returning exactly:

```
## Domains

partforge's core is the kernel, the part contract and the panel. Everything past that is
a **domain**: a separate guide you read only when a request calls for it. Each line
names the request class, the import, and the guide.

<!-- generated by scripts/generate-domain-index.mjs from src/framework/domains/registry.js; do not edit by hand -->
| Domain | Use it for | Import | Guide |
|---|---|---|---|
| <title> | <when> | `import { … } from "<subpath>"` | `<guide>` |
<!-- end generated -->

---
```

With zero domains the table has its header row only. The script replaces the text between the two markers in `AUTHORING-PARTS.md` in place, creating the section at the position above if absent.

- [ ] **Step 1: Write the failing test**

```js
// test/domain-index.test.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { renderDomainIndex } from "../scripts/generate-domain-index.mjs";
import { DOMAINS } from "../src/framework/domains/registry.js";
import fixture from "./fixtures/domain-fixture/manifest.js";

const guide = readFileSync(fileURLToPath(new URL("../docs/AUTHORING-PARTS.md", import.meta.url)), "utf8");

test("the committed index matches the registry", () => {
  const block = guide.slice(guide.indexOf("<!-- generated by scripts/generate-domain-index.mjs"), guide.indexOf("<!-- end generated -->") + "<!-- end generated -->".length);
  expect(renderDomainIndex(DOMAINS)).toContain(block);
});

test("## Domains sits once, right after Quickstart", () => {
  const h2 = [...guide.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(h2.filter((h) => h === "Domains")).toHaveLength(1);
  expect(h2[h2.indexOf("Domains") - 1]).toBe("Quickstart");
});

test("a domain renders as one row", () => {
  expect(renderDomainIndex([fixture])).toContain('| Fixture | a test-only domain; never in a real part | `import { … } from "partforge/fixture"` | `test/fixtures/domain-fixture/guide.md` |');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domain-index.test.js`
Expected: FAIL, script missing

- [ ] **Step 3: Implement the script, run it, check the guide**

Run: `node scripts/generate-domain-index.mjs` then `git diff docs/AUTHORING-PARTS.md` — expect only the new section.

- [ ] **Step 4: Run the guide tests**

Run: `npx vitest run test/domain-index.test.js test/sheet-guide.test.js test/sheet-docs.test.js test/routed-docs.test.js test/kit-docs.test.js test/lint-registry.test.js`
Expected: PASS (the sheet guide test pins neighbours of `## Sheet parts`, not the top of the file)

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-domain-index.mjs docs/AUTHORING-PARTS.md package.json test/domain-index.test.js
git commit -m "docs: the Domains index in the authoring guide, generated from the registry"
```

---

### Task 9: `partforge/lint` exports `DOMAINS` and `domainsOf`

**Files:**
- Create: `src/framework/lint/domains-of.js`
- Modify: `src/lint.js`
- Modify: `types/lint.d.ts`
- Test: `test/domains-of.test.js`

**Interfaces:**
- Consumes: `DOMAINS`, `stripNonCode` from `lint/source-scan.js`, `importsOf` is NOT available (it is a test helper); write the import regex locally.
- Produces: `domainsOf(sources: { files: Record<string,string>, entrypoint?: string } | null): string[]` — sorted, unique domain ids; a domain counts when any file has a static `import … from "<subpath>"` or `export … from "<subpath>"` after `stripNonCode`, or contains a call `k.<op>(` / `.<op>(` for an op in that domain's `kernelOps`. Malformed input returns `[]` (lint's forgiving convention). `DOMAINS` re-exported as a frozen array of `{ id, title, when, subpath, guide, kernelOps: string[] }` — **names only**, no functions, so a host can JSON it. `types/lint.d.ts` gains `export interface DomainInfo { id: string; title: string; when: string; subpath: string; guide: string; kernelOps: string[] }`, `export const DOMAINS: readonly DomainInfo[]`, `export function domainsOf(sources: LintSources | null): string[]`.

- [ ] **Step 1: Write the failing test**

```js
// test/domains-of.test.js
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
test("a tagged op call counts", () => {
  expect(domainsOf(src("export default { parts: { a: { build: (k) => k.tappedBore({ od: 5, h: 3 }) } } };"))).toEqual(["fixture"]);
});
test("prose, a string literal and a dynamic import do not count", () => {
  expect(domainsOf(src('// see partforge/fixture\nconst s = "partforge/fixture";\nconst m = import("partforge/fixture");'))).toEqual([]);
});
test("malformed sources give []", () => {
  expect(domainsOf(null)).toEqual([]);
  expect(domainsOf({ files: { a: 3 } })).toEqual([]);
});
test("DOMAINS carries names only", () => {
  expect(DOMAINS[0]).toEqual({ id: "fixture", title: "Fixture", when: "a test-only domain; never in a real part", subpath: "partforge/fixture", guide: "test/fixtures/domain-fixture/guide.md", kernelOps: ["tappedBore"] });
  expect(() => JSON.stringify(DOMAINS)).not.toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/domains-of.test.js`
Expected: FAIL, `domainsOf` not exported

- [ ] **Step 3: Implement `domains-of.js` and wire `src/lint.js`, `types/lint.d.ts`**

- [ ] **Step 4: Run the tests and the types guard**

Run: `npx vitest run test/domains-of.test.js test/types-surface.test.js test/lint-purity.test.js && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/domains-of.js src/lint.js types/lint.d.ts test/domains-of.test.js
git commit -m "feat(lint): DOMAINS and domainsOf — a host reads a part's domains from its source"
```

---

### Task 10: Guards, docs, version

**Files:**
- Modify: `test/worker-layering.test.js` (walk every `DOMAINS` entry's `index.js` with the same bans as `worker.js`; vacuous today)
- Modify: `AGENTS.md` (a `src/framework/domains/` paragraph: what a domain is, the five layering rules, the fixture, the `vi.mock` convention for seam tests, and that kinematics is the first real domain, arriving in its own PR)
- Modify: `package.json` version `0.170.0` → `0.171.0`

- [ ] **Step 1: Add the worker-layering walk**

A loop over `DOMAINS` reusing the file's `graph()` helpers against `${ROOT}/src/framework/domains/${d.id}/index.js`.

- [ ] **Step 2: Write the AGENTS.md paragraph and bump the version**

- [ ] **Step 3: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green; `test/verify-golden.test.js` unchanged

- [ ] **Step 4: Commit**

```bash
git add test/worker-layering.test.js AGENTS.md package.json
git commit -m "chore: domain guards in worker-layering, AGENTS.md, bump to 0.171.0"
```
