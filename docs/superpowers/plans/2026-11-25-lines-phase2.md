# Lines phase 2: the `lines` block, readings over sweeps, and the line gates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A part declares its ropes in a top-level `lines` block; `measure()` reports each
line at the measured pose, every declared sweep reports how each line's length and bend
ratio move along the motion, and `lineDrift` / `lineBend` gate them in `verify`.

**Architecture:** Lines stay derive-only. A pure core module (`lines/read.js`) reads one
declared line out of `d`; an oracle module (`oracle/lines.js`) resolves params, reads lines at
a pose and samples them along a sweep's motion. `runSweeps` adds the samples to each row, so
the readings ride the existing sweep wiring (other views, quick laps, the CLI) with no new
plumbing. The gates are core `VIEW_METRICS`, beside `sweepContacts`.

**Tech Stack:** plain ESM, vitest, Node 24 (`export PATH=$HOME/.nvm/versions/node/v24.16.0/bin:$PATH`).

**Spec:** `docs/superpowers/specs/2026-11-20-lines-rope-and-cable-design.md` (sections 2, 4, 8;
the Phases table row 2; Tests "Phase 2").

**Branch:** `claude/lines-phase2`, stacked on `claude/lines-phase1` (PR #360). The PR targets
`claude/lines-phase1` until #360 merges, then `main`.

## Global Constraints

- `src/framework/lines/` imports `geometry/errors.js` and its own files only: no domain, no
  `part-model.js`, no oracle, no three, no `node:` (`test/lines-taut.test.js` holds it).
- A line source is recognised by plain data only: `typeof v?.lineInfo === "function"` and
  `info.kind === "partforge.lines"`, never `instanceof`.
- Lines are never discovered by scanning `derive`: only the `lines` block declares them
  (spec decision 1).
- Line gates are core `VIEW_METRICS` (open decision 4, taking the spec's recommendation).
- A moving line with no sweep is a lint WARNING and never withholds `verify.ok` (open
  decision 6, taking the spec's recommendation). Say both choices in the PR description.
- No sub-part builds because of a line; reading a line never calls the kernel.
- A line that cannot be read never fails `measure()` or a sweep: its entry carries `error`.
- A view with no declared line verifies byte-identically, except for the new reference part
  (`test/verify-golden.test.js` reads every `src/parts/*.js`); re-record the golden in the
  same commit as the part and read the diff.
- Version **0.206.0** in `package.json` and `package-lock.json` (main is at 0.204.0, #360 at
  0.205.0). If main passes it before merge, bump again.

## Review Focus

1. A line source whose `derive` throws at some sample (a solve out of reach) — that line's
   sweep reading carries `error`, other lines and the row's contacts are unchanged, and
   `lineDrift` is withheld (null), never a pass. Test in Task 3.
2. A sweep row the clock stopped (`skipped: "timeout"`) still gets line readings when its
   motion is readable (they cost no kernel work); an `unreadable` row gets none. Test in Task 3.
3. A `lineInfo()` line with no finite `length` — an error naming the line, never a
   polyline length that undercounts by chords. Test in Task 1.
4. Two lines from one source (an antagonistic pair) — `line:` picks which, the block key is
   the default, and an unknown name is a `line-bad-source` lint error. Tests in Tasks 1 and 5.
5. A quick lap with `lineDrift` or `lineBend` declared — withheld as `sweepContacts` is, never
   a skip that lets `ok` stand. Test in Task 4.

---

### Task 1: Read one declared line (`lines/read.js`) and carry the numbers in `lineInfo()`

**Files:**
- Create: `src/framework/lines/read.js`
- Modify: `src/framework/domains/mechanisms/capstan.js` (`lineInfo()`), `types/mechanisms.d.ts`
- Test: `test/lines-read.test.js`, `test/capstan.test.js`

**Interfaces:**
- Produces:
  - `normalizeLines(part) -> Array<{ name, on, line, views: string[] | null }>` — the
    `lines` block in declaration order; `line` defaults to the key, `views` to null (every
    view). Never throws: a malformed entry is left out (lint reports it).
  - `linesInView(part, view) -> same entries` filtered by `views`.
  - `readLine(d, decl) -> { name, on, mode, d, closed, length, bendRatio, minBendRatio, points }`
    — THROWS a `SpecError` (`line "<name>": …`) when `d[on]` is not a line source, has no
    line `decl.line`, or that line has no finite `length`. `bendRatio` and `minBendRatio`
    are numbers or null.
  - capstan's `lineInfo().lines.rope` gains `length` (exact, = `report().length` unrounded),
    `bendRatio` (`min(2·input.radius, 2·output.radius) / rope.d`) and `minBendRatio`
    (`rope.minBendRatio ?? null`).

- [ ] **Step 1: Write the failing tests** — in `test/lines-read.test.js`: `normalizeLines`
  defaults (`{ rope: { on: "drive" } }` → `[{ name: "rope", on: "drive", line: "rope", views: null }]`,
  a non-object entry dropped, no block → `[]`); `linesInView` honours `views`; `readLine`
  over a hand-made source `{ lineInfo: () => ({ kind: "partforge.lines", lines: { a: {...}, b: {...} } }) }`
  picks `line: "b"`; throws `/line "rope": derive\(\)\.drive is not a line source/`, `/has no line "x"/`,
  and `/line "rope": .* has no length/` for a line with `points` but no `length`. In
  `test/capstan.test.js`: `lineInfo().lines.rope.length` equals `report().length` within 1e-3
  and `bendRatio` equals `min` of `report().bend` member values.
- [ ] **Step 2: Run** `npx vitest run test/lines-read.test.js test/capstan.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `read.js` (imports `../geometry/errors.js` only) and the three
  capstan fields; add them to `MechanismLines` in `types/mechanisms.d.ts`.
- [ ] **Step 4: Run** the two files plus `test/lines-taut.test.js` (layering) — expect PASS.
- [ ] **Step 5: Commit** `lines: read a declared line; lineInfo carries length and bend ratio`.

### Task 2: `measure().lines` and the CLI `lines:` line

**Files:**
- Create: `src/framework/oracle/lines.js`
- Modify: `src/framework/oracle/measure.js` (near the `handles` block, ~line 633),
  `bin/cli.js` (after the `sweeps:` line, ~713), `bin/sweep-text.js` (add `lineText`),
  `types/testing.d.ts` (MeasureResult `lines`), `types/part.d.ts` (`lines?: Record<string, LineDecl>` beside `handles`, `LineDecl = { on: string; line?: string; views?: string[] }`)
- Test: `test/oracle-lines.test.js`, `test/sweep-text.test.js` (or the file that holds `sweepText`'s wording)

**Interfaces:**
- Consumes: `linesInView`, `readLine` (Task 1); `resolveParams` from `part-model.js`.
- Produces:
  - `measureLines(part, view, d) -> Array<{ name, on, mode, length, bendRatio, minBendRatio } | { name, on, error }>`
    (no `points`: the report stays small). `measure()` adds `lines` only when the view has a
    declared line, so other reports are unchanged.
  - `lineText(entry) -> string`: `rope 212.40mm, bend 10.0 (min 8)` / `rope unreadable: <error>`.

- [ ] **Step 1: Failing tests** — create `test/fixtures/capstan-fixtures.js` exporting
  `concentricCapstan` (two sub-parts placed by a `capstan` in `derive`,
  `lines: { rope: { on: "drive" } }`, a `motorAngle` slider); it is measured on the Manifold
  kernel (`createManifoldKernel` from `partforge/testing`) has `lines[0]` with `length`
  equal to the capstan's `report().length` (1e-3); a part with no `lines` block has no
  `lines` key; a source that throws gives `{ name, on, error }` and the measure still
  returns. `lineText` wording for both shapes.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; `measure()` wraps the call so nothing it throws escapes.
- [ ] **Step 4: Run** the new tests and `test/measure-memo.test.js` — PASS.
- [ ] **Step 5: Commit** `oracle: measure().lines and the CLI lines line`.

### Task 3: Line readings on every sweep row

**Files:**
- Modify: `src/framework/oracle/lines.js` (add `sweepLines`), `src/framework/oracle/sweep.js`
  (`runSweeps`), `bin/sweep-text.js` (row suffix), `types/testing.d.ts` (sweep row `lines`, `linesSampled`)
- Test: `test/oracle-lines.test.js`

**Interfaces:**
- Consumes: `motionOf(part, view, full, s)` (`collide/sweep-targets.js`), `measureLines`' reader.
- Produces:
  - `export const LINE_SWEEP_SAMPLES = 33` and `sweepLines(part, view, motion, decls) ->
    Array<{ name, lengthMin, lengthMinAt, lengthMax, lengthMaxAt, drift, bendMin, bendMinAt, samples } | { name, error, at }>`.
    `drift = lengthMax − lengthMin` (the range over the motion: the rope's assembly pose is
    unknown, so the gate holds the whole range; this replaces the spec's single `driftAt`
    with the two `…At` values). `…At` are motion values (the param's value, or t for a path
    or animation). Each interior sampled extreme of length is refined by golden-section
    search between its two neighbours to `1e-4 · (hi − lo)`. The first sample that throws
    ends that line's reading as `{ name, error, at }`.
  - `runSweeps` sets `row.lines` and `row.linesSampled = true` on every row whose entry has
    no `s.skip` and whose view has a declared line — including a row the deadline stopped
    or whose collision pass threw (`skipped: "unreadable"` from the try block); a row with
    `s.skip` gets none. The line pass runs in its own try, outside `sweepOne`.
  - `sweepText` appends `, rope drift 0.03mm` per line (`, rope unreadable` for an error).

- [ ] **Step 1: Failing tests** — the Task 2 fixture with `verify.sweeps: { drive: { param: "motorAngle" } }`:
  the row's `lines[0].drift < 0.2`, `lengthMin <= lengthMax`, `samples >= 33`; the slack
  fixture (`slackCapstan`, added to `test/fixtures/capstan-fixtures.js`: an eccentric pulley whose centre moves with `motorAngle`, 2 mm eccentricity)
  reads a drift within 1% of a brute-force 2001-sample scan of `report().length`; a row
  run with `deadline: 0` still has `lines`; a source that throws past `motorAngle > 50`
  gives `{ name, error, at }` with `at > 50` and the row's `contacts` unchanged.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file plus `test/sweep*.test.js` — PASS.
- [ ] **Step 5: Commit** `sweeps: line readings on each row`.

### Task 4: The `lineDrift` and `lineBend` gates

**Files:**
- Modify: `src/framework/verify-metrics.js` (`VIEW_METRICS`), `src/framework/oracle/verify.js`
  (the quick-lap block, ~line 741), `docs/ERROR-PATTERNS.md` (`## line-drift`, `## line-bend`),
  `types/part.d.ts` (view expectations, beside `sweepContacts`)
- Test: `test/verify-lines.test.js`

**Interfaces:**
- Consumes: `r.sweeps[].lines` (Task 3), `r.lines` (Task 2).
- Produces:
  - `lineDrift`: `kind: "gate"`, `pattern: "line-drift"`. Extract: no `r.lines` (no line in
    the view) or no `r.sweeps` → null with `skipMessage`; `r.sweeps` is `[]` → 0; else the
    largest `drift` among readings without `error`, null when there is none or when any
    reading has an `error` (withheld: a line that could not be read along a motion has no
    verdict). `withheld` message names the line and its error. `locate` → null. Hint: the
    span lengths change along the motion — move the termination onto the drum axis, keep
    the pulley concentric, or tension at the pose where it is shortest.
  - `lineBend`: `kind: "gate"`, `pattern: "line-bend"`. Extract: the smallest `bendMin` over
    the rows' readings and every `r.lines[].bendRatio`; null (skip) when none is a number.
  - The quick-lap block withholds `lineDrift` as it does `sweepContacts`; `lineBend` reads
    `r.lines` there, so it is evaluated.

- [ ] **Step 1: Failing tests** — verify on the Task 3 fixtures: concentric with
  `expect._view: { lineDrift: "<=0.2" }` passes, slack fails with `pattern: "line-drift"`
  (spec Tests "Phase 2"); `lineBend: ">=12"` fails on a drum of radius 6 and a 1.2 mm rope
  (ratio 10); a throwing source withholds (`ok: null`); a quick lap withholds `lineDrift`;
  a part with no `lines` and `lineDrift` declared skips with the skip message.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**, plus the two ERROR-PATTERNS entries (symptom, cause, fix).
- [ ] **Step 4: Run** the file plus `test/verify*.test.js` and `test/error-patterns*.test.js` — PASS.
- [ ] **Step 5: Commit** `verify: lineDrift and lineBend gates`.

### Task 5: Lint `line-bad-source` and `line-unswept`

**Files:**
- Create: `src/framework/lint/rules-lines.js`
- Modify: `src/framework/lint/index.js` (append `LINE_RULES` after `COLLISION_RULES`),
  `src/framework/collide/motion-coverage.js` (export `continuousKeys`), `docs/ERROR-PATTERNS.md`
  (`## line-bad-source`, `## line-unswept`)
- Test: `test/lint-lines.test.js`

**Interfaces:**
- Consumes: `normalizeLines`, `readLine` (Task 1); `coveredParams(part, view, full, reads)`,
  `readSweeps`, `continuousKeys(part)` (`collide/motion-coverage.js`).
- Produces:
  - `line-bad-source` (error, field `lines.<name>`): `on` missing or not a string, an
    unknown key in `views`, or `readLine` throws at the defaults.
  - `line-unswept` (warn, field `verify.sweeps`): for each line and each view it shows in,
    each continuous param sampled at 0, 50 and 100% of its range (the others at defaults):
    when the line's `points` differ from the defaults' by more than 1e-6 mm and
    `coveredParams` for that view lacks the param, one finding per (line, param), naming
    the first such view. Hint gives the sweep and gate to add:
    `verify.sweeps: { <param>: { param: "<param>" } }` and `verify.expect._view: { lineDrift: "<=0.2" }`.

- [ ] **Step 1: Failing tests** — the Task 3 fixture without sweeps warns `line-unswept`
  naming `motorAngle`; with the sweep, none; `on: "nope"` and `line: "x"` are
  `line-bad-source` errors; a part with no `lines` block yields nothing.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file plus `test/lint*.test.js` and `npx partforge lint` over every
  `src/parts/*.js` (no new findings on existing parts) — PASS.
- [ ] **Step 5: Commit** `lint: line-bad-source and line-unswept`.

### Task 6: Reference part, docs, golden, version

**Files:**
- Create: `src/parts/capstan-joint.js` (drum and pulley sub-parts placed by one `capstan`,
  `lines: { rope: { on: "drive" } }`, `verify.sweeps: { drive: { param: "motorAngle" } }`,
  `verify.expect._view: { lineDrift: "<=0.2", sweepContacts: 0 }`, rope `material: "uhmwpe"`;
  no demo page)
- Modify: `docs/AUTHORING-PARTS.md` (a short "Lines" section: the block, `measure().lines`,
  the sweep readings, both gates, `line-unswept`), `docs/domains/mechanisms.md` (capstan
  section: declare the rope in `lines`, gate `lineDrift`), `AGENTS.md` (add
  `capstan-joint.js` to the parts list; extend the `src/framework/lines/` paragraph with
  `read.js` and `oracle/lines.js`), the spec ("Phase 2 as built (0.206.0)" after the phase 1
  line, and mark decisions 4 and 6 taken as recommended), `package.json` + lockfile 0.206.0,
  `test/verify-golden.test.js` golden (re-record)
- Test: `test/verify-golden.test.js`, `test/domain-index.test.js`, `test/types-surface.test.js`

- [ ] **Step 1:** `npx partforge measure src/parts/capstan-joint.js` prints `lines:` and the
  sweep's `rope drift …` and passes verify; `npx partforge lint` reports no errors.
- [ ] **Step 2:** `PARTFORGE_RECORD_VERIFY_GOLDEN=1 npx vitest run test/verify-golden.test.js`;
  read the diff — only the new part's entry may appear.
- [ ] **Step 3:** docs, spec, AGENTS.md, version; `npm run docs:domains` if the index moved.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run lint` — all pass.
- [ ] **Step 5: Commit** `capstan-joint reference part; lines phase 2 docs; 0.206.0`.
