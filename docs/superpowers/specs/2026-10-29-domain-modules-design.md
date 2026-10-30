# Domain modules — design

Date: 2026-10-29. Status: proposed. Follows the limb-helper design
(`2026-10-29-limb-helper-design.md`, on `feat/implicit-limb`) and the implicit organic
parts design (`2026-10-14-implicit-organic-parts-design.md`, on `feat/implicit`). Decided
in conversation with Scott the same day; the decisions are marked below.

## Problem

partforge keeps gaining depth: sheet parts and the laser kit, routed parts for the CNC
router, FDM and resin DFM profiles, text, vector art, height maps, imports, the implicit
organic engine, and now a kinematic limb helper with URDF-shaped joints. Each depth is a
real domain with its own vocabulary, checks and guide, and each one is wired into the
framework by hand in six places:

| What a domain contributes | Where it is wired today |
|---|---|
| Helper functions a part imports | re-exported from `src/framework/geometry/polygon.js` (`partforge/geometry`) |
| Kernel ops (`k.text2d`, `k.implicit`, …) | `KERNEL_OPS` in `geometry/kernel.js`, attached in `kernel-front.js` |
| Lint rules | `lint/index.js` imports each `rules-*.js` by name |
| Oracle facts and checks | `oracle/measure.js` imports `sheet/resolve.js`; `verify-metrics.js` spreads `SHEET_METRICS` and carries `PRINT_ONLY` |
| Manufacturing process | `process/registry.js` (`PROCESSES`, `PRINT_PROCESSES`) and `process/exporters.js` |
| Guide text | one section of the 5,100-line `docs/AUTHORING-PARTS.md` (32 top-level sections) |

Routed parts touched all six. The limb helper's design puts its code under
`geometry/limb/` and its exports on `partforge/geometry`, which is the same pattern again.

Two costs follow.

**The code's direction is wrong.** Core modules name domains: the geometry entry knows
sheet, the oracle knows sheet, the metric table knows print, the lint index knows every
rules file. The layering tests that hold the structure together today
(`worker-layering`, `kit-layering`, `sheet-layering`, `oracle-entry`, `kernel-contract`,
`lint-purity`) each pin one seam; none states the rule that core must not depend on a
domain, so every new domain re-invents its wiring and its guards.

**Agents see everything at once.** partforge-cloud's compact prompt is ~60 KB and its
full guide ~250 KB, hand-curated from `AUTHORING-PARTS.md` by a section list
(`scripts/generate-authoring-prompt.mjs`'s `GUIDE_SECTIONS`) that carries a paragraph of
justification per entry, and an op index built by regex-parsing `kernel.js`'s op arrays.
Every new domain grows the always-on prompt or has to be argued out of it. The implicit
design already chose a separate, on-demand organic guide for this reason; nothing
generalises that choice.

## Decisions

| Question | Decision |
|---|---|
| Open or closed | A cloned forge must build and export with only the open `partforge` package installed (Scott, 2026-10-29). So everything a part calls on its way to a mesh or an export is open. Closed-source code may only *read* geometry and return a judgment or an optimization, behind an open seam with an open fallback, the way the semantic mesh oracle does today. |
| One package or many | One npm package with one subpath export per domain. Not a package per domain: releases are already a quiet-failure zone (AGENTS.md "Releasing"), partforge-cloud regenerates its corpus against one installed version, and the native core is one WebAssembly module whose JS twin must stay bit-identical. |
| Import surface | Each domain publishes its own subpath, `partforge/<domain>` (Scott, 2026-10-29). `partforge/geometry` keeps the core helpers only. The sheet re-exports on `partforge/geometry` are untouched by this design; the sheet migration creates `partforge/sheet` and starts their two-minor-version deprecation window (my call: a deprecation cannot name a subpath that does not exist yet). |
| Kernel ops | Stay flat on `k` (my call). `k.implicit`, `k.text2d`, `k.vector2d`, `k.heightfield`, `k.import` keep their names: the kernel contract is versioned on them and `feat/implicit` is built on them. The registry tags each op with its domain; that tag is what groups the op index and what the compact prompt reads. |
| Scope of this design | The domain contract, the registries core reads, the guide tiers, and kinematics as the first domain built on the contract (Scott, 2026-10-29). The existing domains migrate afterwards in the order given under "Later migrations", designed in their own documents. |

## Goals

- Adding a domain is one directory, one manifest, one guide, one line in a table, and a
  test that fails until all four agree.
- Core never names a domain. A test walks the import graph and holds it.
- An agent always has the core guide, and gets a domain guide when the request or the
  part file calls for one, through the host's existing search and read tools.
- A host can tell which domains a part uses by reading the part file alone.
- The limb helper lands as a domain from the start, with no later move.

## Non-goals

- Moving any existing domain in this design. Sheet, print, text, vector, image, import and
  organic stay where they are until their own migration documents.
- Changing `k`'s shape, the kernel contract version, or any op's name.
- A plugin system for third-party domains. The registry is a table in the repo, not a
  discovery mechanism. (A closed package registers worker jobs through `runWorker(part,
  { jobs })` as it does today, and nothing here changes that seam.)
- Splitting the npm package, the WebAssembly core, or the test suite per domain.
- Any change to partforge-cloud. The cloud-side consumer (corpus generator, prompt,
  `search_docs`/`read_docs`) is a follow-up PR there, after this ships.

## Anti-goals

- **A domain that breaks a cloned forge.** No domain may require anything but the open
  package to build or export. A closed package may add checks or optimizations, never a
  build step.
- **A second way to declare a domain.** The manifest is the only description of a domain.
  If the corpus generator, the lint index, the op index and the guide index each had their
  own list, the drift this design exists to end would return.
- **Discovery that lives only in the docs.** An agent that has never heard of a domain
  must still find it from the core guide's index, and a host must find a part's domains
  from the part file.
- **Churn on the in-flight branches.** Nothing here moves a file `feat/implicit` touches.

## The domain contract

### Layout

```
src/framework/domains/<id>/
  manifest.js        plain data + registrations; imports nothing with side effects
  index.js           the subpath entry: what `partforge/<id>` exports
  ...                the domain's own modules, any layout
docs/domains/<id>.md the domain guide
types/<id>.d.ts      the subpath's types
```

`src/framework/domains/registry.js` is the one table: an array of manifests in a fixed
order. Core reads the registry; nothing in core imports `domains/<id>/` directly.

### The manifest

```js
// src/framework/domains/kinematics/manifest.js
export default {
  id: "kinematics",
  title: "Kinematics",
  // One line, written as a request class. The core guide's domain index prints it verbatim.
  when: "jointed limbs, fingers, arms, robot hands; posing links about joints; reach and grip",
  subpath: "partforge/kinematics",
  guide: "docs/domains/kinematics.md",
  referenceParts: ["src/parts/robot-finger.js"],
  // Kernel ops this domain adds to `k`. Names are the op's name on `k`; `attach` is the
  // function kernel-front.js calls with the kernel. The names must appear in KERNEL_OPS.
  kernelOps: [],
  // Surface markers lint's source scan looks for in a part file to say "this part uses
  // the domain": imports from the subpath, and calls of the kernel ops above.
  lintRules: KINEMATICS_RULES,
  // Per-sub-part facts the oracle computes, verify metrics, volunteered checks.
  oracle: { facts: null, metrics: {}, checks: [] },
  processes: [],
  // Worker-safety class (test/worker-layering.test.js walks every domain's index.js).
  workerSafe: true,
};
```

Rules the manifest must hold to:

- It is plain data plus functions; importing it runs nothing. Lint, the oracle, the
  CLI, the worker and the corpus generator all import the registry, so a manifest that
  booted a kernel or touched the DOM would break each of them.
- `kernelOps` names only ops that are in `KERNEL_OPS` (or its optional list). The op
  arrays stay in `kernel.js` and stay the kernel contract; the manifest tags them.
  `test/kernel-contract.test.js` gains one assertion: every tagged op exists, and every op
  with a domain tag is tagged by exactly one domain.
- `oracle.facts`, if present, is `(subPart, ctx) => object | null`, called by `measure()`
  per sub-part and stamped under the domain id, the way `sheet` facts are stamped today.
  `oracle.metrics` is spread into `SUBPART_METRICS` and must not collide with another
  domain's or a print metric's name (the existing `verify-metrics` test extends to cover
  all domains). `oracle.checks` are volunteered: they never count toward
  `declared`/`evaluated`.
- `processes` is a list of process descriptors. The process registry becomes a derived
  view over all domains' `processes`, keeping its `PROCESSES` / `PRINT_PROCESSES` split
  by each descriptor's `kind: "sheet" | "print"`.
- Nothing in the manifest, and nothing `index.js` reaches, imports `three`, the DOM, a
  `node:` builtin, or paper. A domain that needs any of those (a viewer overlay, a
  writer) reaches it through the same dynamic-import seams core uses today
  (`process/exporters.js`, `jobs.js`'s lazy loads).

### What core does with the registry

| Core module | Today | After |
|---|---|---|
| `geometry/polygon.js` | re-exports sheet by name | unchanged here; the sheet migration moves the names to `partforge/sheet` and leaves a two-minor-version deprecation shim behind |
| `geometry/kernel-front.js` | attaches `text2d`, `vector2d`, … inline | after its own ops, calls each manifest's `kernelOps[].attach(k, ctx)` |
| `lint/index.js` | `RULES = [...SHAPE_RULES, …, ...SHEET_RULES]` | core rules, then `registry.flatMap((d) => d.lintRules)` |
| `lint/source-scan.js` | finds `defaults` literals | also reports the domains a source uses: subpath imports and tagged-op calls |
| `oracle/measure.js` | imports `sheet/resolve.js` | calls each manifest's `oracle.facts` |
| `verify-metrics.js` | spreads `SHEET_METRICS`, carries `PRINT_ONLY` | spreads every manifest's `oracle.metrics`; `PRINT_ONLY` becomes a per-metric `appliesTo` tag the print domain's metrics carry |
| `process/registry.js` | imports four descriptors | derives its lists from manifests' `processes` |
| `package.json` `exports` / `typesVersions` | hand-edited | still hand-edited, but `test/types-surface.test.js` asserts one entry per registered domain |

The sheet, print, text, vector, image, import and organic domains do **not** move in this
design. Their current wiring keeps working beside the registry: `RULES` is core rules
plus the existing `rules-*.js` files plus the registry's rules, and so on. Each later
migration deletes its by-name lines as it moves into a manifest.

### The layering test

`test/domain-layering.test.js` walks the import graph (`test/helpers/import-graph.js`)
and holds:

1. No module outside `src/framework/domains/<id>/` imports from inside it, except
   `domains/registry.js` (the manifest) and `package.json`'s subpath entry (`index.js`).
2. Every `domains/<id>/` folder is in the registry and its manifest's `id` is its folder.
3. Every registered domain has its `guide` file, its `types/<id>.d.ts`, its `package.json`
   subpath and `typesVersions` entry, and every `referenceParts` file.
4. Every domain's `index.js` closure is free of `three`, DOM globals, `node:` builtins and
   paper (the worker-layering rules, applied per domain).
5. A domain imports core freely, and never another domain. (The limb helper's implicit
   adapter is the known exception in waiting: it writes `k.implicit` frames, which is a
   kernel op, so it depends on the op's data shape and not on the organic domain's
   modules. The organic migration must keep that shape in core or in the kernel contract.)

### Docs

`docs/AUTHORING-PARTS.md` stays the core guide for now, with one addition: a
**"Domains"** section near the top, generated from the registry by a script
(`scripts/generate-domain-index.mjs`, output committed, drift held by a test the way the
corpus is held in the cloud). It is one line per domain: the title, the `when` text, the
subpath, and the guide path. This is the index an agent that has never heard of a domain
reads.

Each domain guide (`docs/domains/<id>.md`) is self-contained: what the domain is for, the
import line, its ops and helpers, a worked example naming its reference part, what lint
and verify check, and gotchas. It is written for an agent that has the core guide in
context and nothing else. The existing per-domain docs tests (`sheet-docs`, `routed-docs`,
`kit-docs`) are the model: a guide test holds the guide's claims to the code.

`package.json`'s `files` gains `docs/domains/`.

Shrinking `AUTHORING-PARTS.md` itself is each later migration's job: when a domain moves,
its section leaves the core guide for the domain guide, and the core guide keeps a
one-paragraph "when to use" pointer. The target after all migrations is a core guide near
a quarter of today's length. This design does not set a number.

### What a host gets

Nothing in partforge-cloud changes in this design, but the design fixes what the follow-up
there reads, so it is stated here:

- `partforge/lint` exports `domainsOf(sources)`: the domain ids a part's source uses,
  from the source scan. The host loads those guides into context when it opens an
  existing part.
- The registry is importable from `partforge/lint` as `DOMAINS` (id, title, when,
  subpath, guide, kernel op names), so the corpus generator reads data instead of
  regex-parsing `kernel.js` for domain ops and keeping a hand list of guide sections.
- The compact prompt carries the core guide and the domain index. A domain guide is
  fetched through `search_docs` / `read_docs`, which already serve sections by id.

## Kinematics: the first domain

The limb helper design stands as written, with these changes to where it lives and how it
is reached. Everything else in that document (the API, frame conventions, solvers,
mirroring, outputs, errors, costs, tests) is unchanged.

| Limb design says | This design says |
|---|---|
| `src/framework/geometry/limb/` (`tree.js`, `core.js`, `implicit.js`, `solid.js`, `rotations.js`) | `src/framework/domains/kinematics/` with the same files, plus `manifest.js` and `index.js` |
| exported from `partforge/geometry` | exported from `partforge/kinematics`: `limb`, and later `skeleton` |
| `deg`, `rad`, `euler`, `toEuler`, `applyRotation` on `partforge/geometry` | unchanged: these are general rotation helpers, not kinematics, and stay on the geometry entry as the limb design says |
| types in `types/geometry.d.ts` | `types/kinematics.d.ts` |
| guide: a section of the organic guide and of `AUTHORING-PARTS.md` | `docs/domains/kinematics.md`, and one line in the domain index |

The manifest for kinematics is the minimal one: no kernel ops, no process, no oracle
facts, and no lint rules (my call: `limb()` already throws a spec error at construction,
which happens in `derive`, and lint already surfaces that as `derive-throws`; a source-text
reading of `joints`/`follow`/`bend` literals would be a parser of its own and is not worth
it for one domain). `when` is as quoted above. Because the only real domain registers
nothing but a guide and a subpath, the registry plumbing is exercised by a test-only
fixture manifest under `test/fixtures/` that declares a kernel op, a metric, a process and
a lint rule, so `attach`, the collision checks, the process derivation and the op-tag
assertions all run against something.

Since `rotations.js` is re-exported from `partforge/geometry`, it stays under
`src/framework/geometry/` and never moves into the domain folder, or layering rule 1
would fail.

Every lint rule id, a domain's included, must still appear in `docs/AUTHORING-PARTS.md`'s
rule catalog (`test/lint-registry.test.js`); a domain adds its lines there rather than
loosening the test. Its reference part is a printed robot finger: three links as
sub-parts, a `print` view laying them flat, an `assembly` view placing each with
`d.finger.place(s, "<joint>")`, and an animation driving `p.curl`. The organic hand
fixture stays a test fixture on `feat/implicit`, where it already is.

### Decoupling from the implicit engine

The limb code on `feat/implicit-limb` imports three things from `geometry/implicit/`,
which does not exist on `main`: the rigid-transform maths in `frames.js`, the
`ImplicitSpecError` class, and the compiled distance evaluator `grip` uses for its
contact test. The limb session is splitting the feature into PR A (to `main`) and PR B
(to `feat/implicit`), and the split follows these rules:

- **The frame maths moves to core.** The 3×4 rigid-transform functions and
  `resolveFrames` for `{ parent, at, rotate }` trees become
  `src/framework/geometry/xform.js`. That frame data shape is what both engines share,
  so it lives in core and never inside the organic engine; `implicit/frames.js` imports it
  from there once PR B lands.
- **A generic spec error in core.** `geometry/errors.js` gains a `SpecError` with the
  "name the field and the fix" message style; `ImplicitSpecError` extends it on
  `feat/implicit`.
- **`grip.around` is a function seam, not a registration.** It accepts a signed distance
  function `(x, y, z) => mm`, or a plain-data primitive in the `k.implicit` primitive
  vocabulary (sphere, ellipsoid, capsule, box, cylinder, torus, tube, halfspace, and a
  plain union of those) evaluated by the domain's own closed-form `shapes.js`. Any node
  beyond that vocabulary throws and names the fix: pass a distance function, which
  `implicitDistance(node)` on `partforge/geometry` makes. PR B adds `implicitDistance`
  beside `k.implicit` and a parity test holding `shapes.js` equal to the compiled
  evaluator on every primitive. Neither module imports the other; a part author composes
  them. No module-level hook: mutable module state fails the two-instance rule and the
  purity rule.
- **`posed.frames`, `flesh()` and `attach()` produce plain data** in the `k.implicit`
  grammar without importing the engine, so they may ship in PR A with shape tests; the
  "meshes to the same hash as the hand fixture" test waits for PR B. Keeping them out of
  `main` until the grammar is released is a product call, not a layering one.

With that, the kinematics domain imports only core (`geometry/xform.js`,
`geometry/rotations.js`, `geometry/errors.js`, `geometry/js-math.js`) and honours rule 5
of the layering test from the start. The organic migration must keep `xform.js` and
`implicitDistance` where they are when it moves.

### Where it lands

Two PRs on two branches, in either order:

- **This branch → `main`:** `domains/registry.js`, the layering test, the registry's
  consumers in core, the fixture domain, the domain index and its generator, the
  `partforge/lint` exports (`DOMAINS`, `domainsOf`).
- **PR A (`feat/implicit-limb` rebased on `main`) → `main`:** `domains/kinematics/`
  with its manifest, subpath, types, guide and reference part. It needs nothing from the
  registry PR; whichever merges second adds the one registry line.
- **PR B → `feat/implicit`:** `implicitDistance`, `ImplicitSpecError extends SpecError`,
  `frames.js` over `xform.js`, the fixture port and hash test, the organic guide's
  cross-reference to the kinematics guide.

URDF export is still a non-goal, as in the limb design. When it comes it is a domain
writer, reached through the exporter seam, so a cloned forge can produce it with the open
package.

## Later migrations (order, not design)

Each is its own design document and PR, after `feat/implicit` and `feat/implicit-limb`
merge. Order, chosen so each step's seam is already tested by the one before:

1. **sheet** (laser, router, joinery, the kit): the richest wiring and the one with
   layering tests to inherit. Deletes the `polygon.js` re-exports at the end of the
   deprecation window.
2. **print** (FDM and resin descriptors, DFM profiles): small; proves `processes` and
   `appliesTo`.
3. **text**, **vector**, **image**, **import**: the op-only domains; proves `kernelOps`
   and the source scan's op detection.
4. **organic** (`k.implicit`): last, once its own branch is stable, and the largest move.

## Constraints

- Node 24, Vite consumer, plain ESM, as today.
- Every layering test that exists keeps passing; the new one is additive.
- `npm run build`, `npm test`, `npm run check` and `npm run typecheck` are green at each
  PR; `test/core-parity.test.js` is untouched (no ported pass changes).
- A minor version bump on each of the two `main` PRs (the registry, and PR A).
- The deprecation window for a moved helper is two minor versions, announced by a lint
  `warn` (`deprecated-import`) naming the new subpath. The first use is the sheet
  migration; nothing deprecates in this design.

## Left to the builder

- The exact shape of `kernelOps[].attach` and what `ctx` carries (today kernel-front
  closes over the part's declared fonts and vectors; a domain op needs the same access).
- Whether `domainsOf` runs on the parsed `PartDefinition`, the source text, or both. The
  source scan is the obvious place since imports are text; a part object has no imports.
- The generator for the domain index: a standalone script or a step of an existing one.
- File names inside `domains/kinematics/` beyond those the limb design names.
- Whether the registry's order is alphabetical or declared. (Declared, if order ever
  matters for lint output; otherwise alphabetical.)
- Import-cycle guard: `verify-metrics.js` spreads every manifest's `oracle.metrics` at
  module top level, so no manifest's `lintRules` may reach `lint/rules-verify.js` or
  `verify-metrics.js`, even transitively, or the registry is read before it is
  initialised. A manifest's rules import `lint/finding.js` and nothing else from lint.
- The reference part follows the `laser-box.js` precedent: a fixture and the guide's
  worked example, no HTML page and no CI smoke entry; AGENTS.md's parts list gains it.

## Testing

- `test/domain-layering.test.js` as specified above.
- `test/kernel-contract.test.js`: the two new assertions on domain tags.
- `test/verify-metrics.test.js`: no metric name collides across core, print and every
  domain.
- `test/types-surface.test.js`: one subpath, one `typesVersions` entry and one `.d.ts` per
  registered domain.
- `test/domain-index.test.js`: the committed domain index matches the registry.
- `test/kinematics-guide.test.js`: the guide's import line, op names and example resolve
  against the code, in the style of `sheet-guide.test.js`.
- The limb design's own tests, unchanged in content, moved with the code.
- `test/worker-layering.test.js` walks every domain's `index.js` in addition to
  `worker.js`.
