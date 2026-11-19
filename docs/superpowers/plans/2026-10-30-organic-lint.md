# Organic Lint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lint checks `k.implicit` specs, `partforge measure` reports build warnings, and the organic domain ships `src/parts/hand.js`.

**Architecture:** Six rules in `src/framework/domains/organic/lint.js`, listed in the organic manifest's `lintRules`. They read the specs the geometry-free probe already records and run the engine's pure-JS compiler on them. `buildView` drains `takeBuildWarnings` per sub-part and `measure()` returns them. The hand builders move from the test fixture into the part, and the fixture re-exports them.

**Tech Stack:** plain ESM JS, vitest, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-30-organic-lint-design.md`

## Global Constraints

- Run vitest as `/Users/scottsykora/.nvm/versions/node/v24.19.0/bin/node node_modules/.bin/vitest run <files>`. Plain single shell commands only.
- No version bump (`feat/implicit` is unreleased).
- The organic lint module may import `../../lint/finding.js` and nothing else from lint. It may import the engine's pure modules: `geometry/implicit/{compile,preview-edge,errors,expr-lower}.js` and `geometry/kernel.js`. It must NOT import `geometry/implicit/index.js` (that loads the mesher and the native core). `test/domain-layering.test.js` must stay green.
- Lint ERRORS only for what the build would also throw. Heuristics are warnings or notes. Findings are deterministic.
- Rule ids, verbatim: `implicit-spec-invalid`, `implicit-needs-manifold`, `implicit-thin-feature`, `implicit-blend-eats-child`, `implicit-lipschitz-low`, `implicit-csg-in-disguise`.
- Moving the hand builders must change no spec byte: every pinned hash suite stays green unchanged.
- Never commit `hand-dev.html`, `src/app-hand-dev.js`, `src/hand-dev-worker.js` or `src/hand-dev-part.js`.

## Review Focus

1. A part whose `images` is a function, or that has no `images`, with a textured spec: no false `implicit-spec-invalid` (skip the image check; lower with stubs only for declared names). Test in Task 1.
2. A spec that is valid but whose recorded JSON lost something (a `NaN`/`Infinity` value becomes `null`): must not produce a false error. Skip specs whose JSON contains a value the build could not have had; test with a spec using `Infinity` is not possible in the grammar, so test that a param-driven spec at defaults lints clean. Test in Task 1.
3. A build that calls `k.implicit` many times with the same spec (a repeat loop): one finding, not N. Test in Task 1.
4. An `expr` with a kink (`abs`, `max`) at exactly a lattice point: no `implicit-lipschitz-low` on a true distance with kinks (a box SDF written as an expr). Test in Task 3.
5. `measure()` on a part whose kernel has no `takeBuildWarnings` (a stub kernel in tests): no throw, `warnings: []`. Test in Task 4.

---

### Task 1: The rule module, `implicit-spec-invalid` and `implicit-needs-manifold`

**Files:**
- Create: `src/framework/domains/organic/lint.js`
- Modify: `src/framework/domains/organic/manifest.js` (`lintRules: ORGANIC_LINT_RULES`)
- Modify: `src/framework/geometry/implicit/index.js` and `src/framework/geometry/implicit/compile.js` (move `IMPLICIT_DEFAULTS` into `compile.js`; `index.js` re-exports it, so no importer changes)
- Test: `test/organic-lint.test.js`

**Interfaces:**
- Produces: `export const ORGANIC_LINT_RULES` (array of `{ id, run(ctx) }`); internal helper `implicitCalls(ctx) → [{ op: "implicit" | "implicitFrames", spec, compiled | null, error | null }]`, one entry per distinct spec JSON, memoised per `ctx` (a `WeakMap` keyed on the ctx's `probe` function result). `compiled` is `compileImplicit(spec, { images })` with `images` a `Map` of 1×1 stub images (`{ width: 1, height: 1, data: Uint16Array.of(0) }`, the shape `makeTexture` takes; check `textures.js`) for each key of a static `part.images` object. When `part.images` is a function or absent-but-referenced, the image check is skipped: run `validateSpec` with `imageNames: null` semantics (check grammar.js for how a null set behaves; if it rejects, catch an `unknown image` issue and drop it) and do not lower a spec that names an image.
- Produces: `IMPLICIT_DEFAULTS` exported from `compile.js`.

- [ ] **Step 1: Write the failing tests** in `test/organic-lint.test.js`, using a `partWith(build, extra)` helper modelled on `test/lint-images.test.js`:
  - `implicit-spec-invalid` fires (error) for `{ root: { kind: "spher", r: 5 } }`, message contains `unknown kind`; for a frame cycle; for an `expr` with `sdf: "lenght(p)"`; for a contact below the root. Path is `parts`.
  - quiet for `{ root: { kind: "sphere", r: 5 } }` and for a `k.implicitFrames` call on a valid spec.
  - a textured spec naming image `"skin"` with `images: { skin: new URL("file:///x.png") }` is quiet; naming `"nope"` fires; with `images: (p) => ({})` it is quiet.
  - three identical `k.implicit` calls give one finding.
  - `implicit-needs-manifold` fires (error) with `meta: { title: "T", backend: "occt" }` and a `k.implicit` call; fires when the build also calls `.shell(...)` on a solid; quiet with `backend: "manifold"`.
- [ ] **Step 2: Run them** — `vitest run test/organic-lint.test.js`. Expected: FAIL (no findings).
- [ ] **Step 3: Implement** `lint.js` with the helper and the two rules; wire `lintRules`. Messages state the engine's issues for the first rule; the second says `k.implicit` is mesh-native and OCCT throws on it, hint: remove `meta.backend: "occt"` / the `shell`, or build the OCCT feature in a separate part.
- [ ] **Step 4: Run** `vitest run test/organic-lint.test.js test/domain-layering.test.js test/organic-domain.test.js test/lint-purity.test.js test/lint-parts.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(organic): lint compiles k.implicit specs; implicit-needs-manifold`.

### Task 2: `implicit-thin-feature`, `implicit-blend-eats-child`, `implicit-csg-in-disguise`

**Files:** Modify `src/framework/domains/organic/lint.js`; Test `test/organic-lint.test.js`.

**Interfaces:**
- Consumes: `implicitCalls(ctx)` (Task 1); `compiled.thin`, `compiled.ir.nodes[i].{kind,k,children,thin,path,prim.code}`; `choosePreviewEdge(compiled)` from `preview-edge.js`; `IMPLICIT_DEFAULTS.resolution` from `compile.js`; `PRIM` codes (find where `PRIM` is defined in `implicit/`).

- [ ] **Step 1: Failing tests:**
  - thin: `{ root: { kind: "union", children: [{ kind: "sphere", r: 10 }, { kind: "box", size: [20, 20, 0.5], at: [0, 0, 12] }] } }` fires a warning naming both tiers (preview and print) and `0.50`; `{ root: { kind: "sphere", r: 10 }, resolution: 0.6, preview: 1.5 }` is quiet; a spec with `preview: 0.2, resolution: 0.2` and a 0.5 mm plate is quiet.
  - blend: `{ root: { kind: "union", k: 4, children: [{ kind: "sphere", r: 10 }, { kind: "sphere", r: 1, at: [11, 0, 0] }] } }` fires naming `root.children[1]`; the same with `k: 1` is quiet; a contact whose `attach[0].k` exceeds a piece's `thin` fires.
  - csg: `{ root: { kind: "subtract", children: [{ kind: "box", size: [20, 20, 20] }, { kind: "cylinder", r: 3, h: 30 }] } }` gives a NOTE (in `report.notes`); the same with `k: 1` on the subtract, or a `round` wrapper, or a sphere child, is quiet.
  - A spec that failed to compile (Task 1) produces none of these.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.** Thin: preview edge `spec.preview ?? choosePreviewEdge(compiled)` (skip the probe when `preview` is set), print edge `spec.resolution ?? IMPLICIT_DEFAULTS.resolution`; fire when `compiled.thin < 2 * edge` for either; one finding per spec, listing the tiers that fail. CSG: walk the raw spec (any object with a `kind`, through `root`, `children`, `child`), allowed kinds `box` (no `round`), `cylinder` (no `round`), `halfspace`, and `union`/`intersect`/`subtract` with `k` absent or 0; no `detail`. Blend: IR walk as in the spec; contact `attach` entries matched to child pieces by label.
- [ ] **Step 4: Run** the Task 1 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(organic): thin-feature, blend-eats-child and csg-in-disguise lint`.

### Task 3: `implicit-lipschitz-low`

**Files:** Modify `src/framework/domains/organic/lint.js`; Test `test/organic-lint.test.js`.

**Interfaces:** Consumes `compileExprSource(src, { uniforms })` and `evalExprScalar(L, x, y, z, textures, sample)` from `expr-lower.js`; the raw spec's `expr` nodes (`sdf`, `box`, `uniforms`, `textures`, `lipschitz`).

- [ ] **Step 1: Failing tests:**
  - `{ kind: "expr", sdf: "length(p) * 3 - 10", box: [[-12,-12,-12],[12,12,12]] }` fires (sampled gradient ≈ 3 > 1.1); with `lipschitz: 3` it is quiet; `length(p) - 10` is quiet.
  - A box SDF written as an expr with `max`/`abs` kinks is quiet (Review Focus 4).
  - An expr with `textures` is skipped (quiet).
  - Two runs of `lintPart` give identical findings.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.** For each `expr` node (raw spec walk, at most 8 per lint run): evaluate on an 8×8×8 lattice spanning the box, central differences with step `h = 1e-3 × box diagonal`, gradient norm per point; take the 5th-largest norm (robust to kink spikes) and fire when it exceeds `1.1 × (lipschitz ?? 1)`. Message gives the measured and declared values and the node path; hint says it is a spot check.
- [ ] **Step 4: Run** the Task 1 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(organic): lipschitz spot check for expr nodes`.

### Task 4: Build warnings on the CLI path

**Files:** Modify `src/framework/oracle/build.js`, `src/framework/oracle/measure.js`, `bin/cli.js` (`printMeasure`), `types/oracle.d.ts` if it declares the report; Test `test/measure-warnings.test.js`.

**Interfaces:** Produces `measure(...).warnings: { part: string, message: string }[]` (always present). `buildView` returns entries `{ name, solid, mesh, warnings: string[] }`.

- [ ] **Step 1: Failing tests:** boot Manifold; a part whose build is `k.implicit({ root: union of a sphere r 10 and a 0.5 mm plate }, preview 1.5)` → `measure(k, part, view).warnings` has one entry with `part: "body"` and a message containing `thinnest feature`; a plain `k.box` part → `[]`; a stub kernel without `takeBuildWarnings` passed to `buildView` → entries with `warnings: []`, no throw.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement.** In `buildView`, call `kernel.takeBuildWarnings?.()` once before the loop (discard stragglers, as `jobs.js:520` does) and after each sub-part's build+place; attach to the entry. `measure()` flattens them into `warnings`. `printMeasure` prints a `warnings:` block when non-empty. `opts.built` callers still work (missing `warnings` → treat as `[]`).
- [ ] **Step 4: Run** `vitest run test/measure-warnings.test.js test/measure.test.js test/verify-golden.test.js test/cli*.test.js`. Expected: PASS (the golden must not change; if it records the measure report, re-record only after reading the diff).
- [ ] **Step 5: Commit** `feat(oracle): measure reports the kernel's build warnings`.

### Task 5: The hand reference part

**Files:** Create `src/parts/hand.js`; Modify `test/fixtures/implicit-trees.js` (hand section replaced by a re-export), `src/framework/domains/organic/manifest.js` (`referenceParts: ["src/parts/hand.js"]`), `test/organic-domain.test.js` if it pins the manifest; Test `test/hand-part.test.js`.

**Interfaces:** `src/parts/hand.js` named exports `FINGERS, THUMB, FAN, HAND_DEFAULTS, HAND_POSES, handSpec, nailSpecs` (moved verbatim; `bulge: 1` literal replaces `BULGE_DEFAULT`, the test pins equality), and a default `PartDefinition`.

- [ ] **Step 1: Failing tests** in `test/hand-part.test.js`: `HAND_DEFAULTS.bulge === BULGE_DEFAULT`; the fixture's `handSpec` is the part's (same function); `lintPart(part)` has no errors and no warnings; `measure(k, part, "assembly")` (Manifold) is watertight, `ok`, has `warnings: []`, and its `probes.pinch` is a finite number of mm; the bbox matches the part's `verify` block.
- [ ] **Step 2: Run** — expected FAIL (no part).
- [ ] **Step 3: Implement.** Move lines 13–155 of the fixture (hand section) into the part; the fixture imports and re-exports them. Part: `meta: { title: "Hand", units: "mm", backend: "manifold" }`; params: curl 0–100, spread −5–15, flex per finger 0–110 and thumb 0–90, oppose 0–60, handLength 150–230 (defaults = `HAND_DEFAULTS`); one sub-part `hand` building `k.implicit(handSpec(pose))` unioned with each `k.implicit(nailSpecs(pose)[i])`; `probes.pinch`: distance between the `index.tip` and `thumb.tip` frame origins from `k.implicitFrames(handSpec(pose)).report()` — check the probe return rules in AUTHORING-PARTS ("probes") first; `verify.expect`: watertight and a bbox range read from a first measure. AGENTS.md parts list gains the hand.
- [ ] **Step 4: Run** `vitest run test/hand-part.test.js test/lint-parts.test.js test/core-parity.test.js test/implicit-topology.test.js test/organic-domain.test.js test/domain-layering.test.js test/domain-index.test.js`. Expected: PASS, no pinned hash changes. Regenerate the domain index if `domain-index` fails (`npm run docs:domains`).
- [ ] **Step 5: Commit** `feat(organic): the hand reference part`.

### Task 6: Docs

**Files:** `docs/AUTHORING-PARTS.md` (one catalog line per rule id), `docs/domains/organic.md` ("What lint and verify check" rewritten; pointer to `src/parts/hand.js`; fix the measure-warnings claim), `docs/ERROR-PATTERNS.md` (entries for thin features, blob joints / blend eats child, low lipschitz — follow the file's entry format and `test/error-patterns.test.js`), `test/organic-docs.test.js` (update anything it pins about lint).

- [ ] **Step 1:** Run `vitest run test/lint-registry.test.js test/organic-docs.test.js test/error-patterns.test.js` — expected FAIL on the catalog (rule ids undocumented).
- [ ] **Step 2:** Write the docs.
- [ ] **Step 3:** Rerun — expected PASS. Then the full suite and `npm run typecheck` and `npm run lint`.
- [ ] **Step 4: Commit** `docs(organic): lint rules, measure warnings, the hand part`.
