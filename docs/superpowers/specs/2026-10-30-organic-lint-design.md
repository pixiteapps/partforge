# Organic lint, CLI warnings and the hand reference part

Date: 2026-10-30. Branch `feat/implicit-lint`, a PR into `feat/implicit` (#297).
Replaces §6 "Lint" and "Reports" of `2026-10-14-implicit-organic-parts-design.md` (PR 5 of
its list) and the lint line of `2026-10-15-implicit-contact-design.md`. Written from a
review of that design against the code at `88169de4`
(the review notes are summarised here; numbers below were measured on that commit).

## Why

Today `partforge lint` checks only the option keys of a `k.implicit` call. A spec with an
unknown node, a frame cycle, a bad formula or an attach naming a missing label lints
clean and fails only when a kernel builds it. And the engine's own warnings (a feature
thinner than the grid, a clipped tree) reach only the browser app: `jobs.js` drains
`takeBuildWarnings`, but `oracle/build.js` and the CLI never do, so `partforge measure`
never shows them. The cloud agent works through lint and measure, so today it is blind to
both. The organic domain also ships no reference part, unlike every other domain.

## Goals

1. Lint reports a bad `k.implicit` / `k.implicitFrames` spec as an error, with the
   engine's own message, without booting a kernel.
2. Lint warns about the authoring mistakes that build fine but come out wrong: a feature
   the grid cannot resolve, a blend wider than the child it blends, an `expr` whose
   declared `lipschitz` is too low, and a part that pins a backend `k.implicit` cannot run on.
3. `partforge measure` (and anything on `oracle/build.js`) reports the build warnings the
   app already shows.
4. `src/parts/hand.js` is the organic domain's reference part.

## Non-goals

- Tessellated STEP and the "which sub-parts export tessellated" report (design PR 4).
- The kernel-contract entry and contract-version decision: they go in the release PR
  (#297), together with PR 4's outcome. The contract stays at v4 meanwhile.
- Frame assertions in `verify` (the frame-report design's non-goal).
- A demo page or CI smoke entry for the hand (the `robot-finger.js` / `laser-box.js`
  precedent: reference part, no page).
- The vase as a reference part: its texture is synthesised in code, and a shipped part
  must declare images as assets. Deferred.

## Anti-goals

- No false errors. Every lint ERROR is something the build would also throw. Heuristics
  are warnings or notes, never errors.
- No kernel boot, mesher or native core in lint. Lint runs in the cloud's sandbox.
- No nondeterminism: two lint runs of one part give the same findings.

## Dropped from the old design, and why

- **Contact gap smaller than two cells.** Obsolete: the owner mesher (`mesher-owners.js`)
  now resolves sub-cell gaps and slits as closed sheets, so a small `gap` works.
- **Detail too fine to print (DFM 0.1 / 0.5 mm).** Those minimums exist nowhere in the
  print profiles, lint does not know which profile a part prints under, and the
  reference hand's own creases (0.5 mm amplitude) would trip it. The guide keeps the advice.

## The rules

All live in the organic domain: `src/framework/domains/organic/lint.js`, listed in the
manifest's `lintRules`. They may import `lint/finding.js` (and nothing else from lint)
and the engine's pure-JS modules under `geometry/implicit/` (`compile.js`,
`preview-edge.js`, the grammar, the IR). The layering walk already allows that: those
closures reach no registry consumer, no bare dependency, no mesher and no native core.

**Where the specs come from.** The geometry-free probe records every kernel call with its
arguments as JSON (`probe.js` `describe`). A rule iterates `probe().calls`, keeps
`scope === "kernel"` with op `implicit` or `implicitFrames`, and parses `args[0]`: the
same seam `heightfield-unknown-image` uses. Specs are taken at the lint params (defaults
plus `--params`), so lint judges the default pose; the hints say so. The same spec seen
twice is judged once. Image names come from a static `part.images` object only (a
function form is skipped, as in `rules-images.js`); textures are lowered with a 1×1 stub
image per declared name, after `validateSpec` has checked the names.

| Rule id | Severity | Fires when |
|---|---|---|
| `implicit-spec-invalid` | error | `compileImplicit` throws `ImplicitSpecError` / `ImplicitSizeError` on the recorded spec (an `implicitFrames` call: `implicitFrames(spec)`). Message: the engine's issues. Covers unknown kinds and fields, frame cycles, expr syntax and names, contact below the root, unbounded root, attach labels, an undeclared image, the texture budget. One finding per distinct spec. |
| `implicit-needs-manifold` | error | A `k.implicit` call is recorded AND the part would build on OCCT: `meta.backend === "occt"`, or the probe recorded a probe-routed op (`ROUTED_CAD_OPS`, i.e. `shell` on a Solid). The OCCT build throws on `implicit`. |
| `implicit-thin-feature` | warning | `compiled.thin < 2 × edge` for either tier: preview `edge = spec.preview ?? choosePreviewEdge(compiled)`, print `edge = spec.resolution ?? IMPLICIT_DEFAULTS.resolution`. The same test the runtime warning makes (`implicit/result.js`). Names the tier(s), the thinnest size and the grid. Hint: give the fine feature its own `k.implicit` with a finer grid (the nail pattern), or raise the grid. |
| `implicit-blend-eats-child` | warning | A `union` / `intersect` / `subtract` IR node with `k > 0` has a child whose `thin < k`; or a contact `attach` entry whose `k` exceeds either piece's `thin`. Names the node path and the child. |
| `implicit-lipschitz-low` | warning | For each `expr` node: on a fixed lattice inside the node's box (8 × 8 × 8 points, central differences), the largest sampled gradient exceeds `1.1 × (lipschitz ?? 1)`. Deterministic: a fixed lattice, no randomness. Skipped for exprs that read a texture (the stub would mislead). A per-lint budget caps the work (at most 8 expr nodes; the rest are skipped silently). The hint says this is a spot check, not a proof. |
| `implicit-csg-in-disguise` | note | Every primitive is a `box`, `cylinder` or `halfspace`, no blend has `k > 0`, and the tree has no `round`, `onion`, `displace`, warp, `expr`, `detail` or `contact`. Hint: the standard ops build this exactly and export a true STEP. |

Every rule gets an entry in the AUTHORING-PARTS rule catalog (the lint-registry test
requires it), and `implicit-thin-feature`, `implicit-blend-eats-child` and
`implicit-lipschitz-low` get `docs/ERROR-PATTERNS.md` entries. The lint warning for thin
features is worded differently from the runtime warning, and both point at the same
ERROR-PATTERNS entry, so an app user who sees both is not confused.

**Cost.** Measured on the fixtures: `compileImplicit` 0.2–11 ms (the fist pose's
contact-region search is the slow case), the preview-edge choice 0.1–12 ms. The preview
choice is skipped when the spec sets `preview`. The lipschitz lattice costs ~3,600
evaluations per expr node. Lint of the hand stays well under 100 ms.

## Build warnings on the CLI path

`oracle/build.js` drains `kernel.takeBuildWarnings()` per sub-part, as `jobs.js` does,
and `measure()` reports them (a `warnings` list of `{ part, message }`, the shape the
app's meshes message already uses). The CLI prints them. This is generic, not
organic-only: fillet skips and profile warnings surface the same way. The organic guide's
claim that measure shows thin-feature warnings becomes true.

## The hand reference part

- `src/parts/hand.js`, default-exporting a `PartDefinition`: the fixture hand (palm,
  thumb and four fingers in contact, creases) plus the nails as their own fine-grid
  `k.implicit` sub-trees, unioned on: the "thin feature gets its own grid" pattern the
  thin-feature hint recommends.
- The hand builders (`handSpec`, `nailSpecs`, `FINGERS`, `THUMB`, `FAN`, `HAND_DEFAULTS`,
  `HAND_POSES` and their helpers) move from `test/fixtures/implicit-trees.js` into the
  part module unchanged, and the fixture re-exports them, so the ~25 tests that import
  them do not change and every pinned mesh hash stays bit-identical. A shipped part must
  not import test code.
- Params: a handful of sliders from the dev part's pose map (curl, spread, per-finger
  flex, thumb oppose, hand length), no spike knobs. `meta.backend: "manifold"`.
- `probes.pinch`: the gap between the index and thumb tips from `k.implicitFrames` label
  boxes, so the part shows the reports story. `verify.expect`: watertight and a bbox.
- Listed in the organic manifest's `referenceParts`, in AGENTS.md's parts list, and linted
  clean by `lint-parts.test.js`. One part test measures it once at the default pose;
  pose sweeps stay in the existing fixture tests (the suite already takes 12–15 min on CI).

## Docs

- `docs/domains/organic.md` "What lint and verify check": rewritten to list the rules,
  the default-pose caveat, and the measure warnings. A short pointer to `src/parts/hand.js`.
- `docs/AUTHORING-PARTS.md`: rule catalog lines; the generated domain index picks up the
  reference part.
- `docs/ERROR-PATTERNS.md`: three entries (above).
- AGENTS.md: the hand in the parts list; the organic domain's reference part.

## Testing

- One firing and one quiet case per rule, through `lintPart` on small inline parts.
- The reference hand lints with no errors and no warnings.
- The lint cost on the hand is checked by a loose timing bound (CPU-paced, as the other
  timing tests do).
- `measure` reports a build warning on a part with a thin feature, and none on the hand.
- Moving the hand builders changes no pinned hash (`core-parity`, `implicit-*` suites green).

## Left to the builder

- The exact wording of messages and hints, within the rules above.
- The lipschitz lattice's exact shape and the per-node box padding.
- The hand part's slider set and ranges, and its `verify` bbox numbers.
- Where the 1×1 image stubs are built (a helper in the domain's lint module is fine).

## Calls I made (not discussed)

- Dropped the DFM detail check and the contact-gap check (reasons above).
- `implicit-csg-in-disguise` is a note, not a warning (notes reach the CLI agent; the
  cloud drops them).
- The CLI warning drain is in this PR and is generic, not organic-only.
- The hand ships with nails; the vase is deferred.
- The contract entry waits for the release PR.
