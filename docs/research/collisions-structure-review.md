# Review: IK collision detection + sweeps — structure and maintainability

Branch `claude/ik-collision-detection-826468` (committed work plus the uncommitted slide
changes). Read-only; file:line cites are against the working tree.

> **Status, 2026-11-03.** Steps 1-3 of the plan below are done. Step 4 was decided: the rows
> are deleted, after a comparison through the real session, rows on (unlimited budget) against
> off. The arm's tool onto a block reached x = 170 both ways, 2 mm apart in height. The elbow
> under a block ended about 3 mm closer without rows, at 19.1 ms a frame against 11.5. The
> hand's index into the middle finger missed by 7.45 mm at 7.0 ms a frame without rows, 9.07 mm
> at 21.3 ms with. Step 5 is done in that form: `exemptions.js` is split out, there is no
> `guard-rows.js`, and `COLLIDE_BAND_MM` became `SETTLE_STEP_MM` (part of step 8). Line numbers
> below are from before these changes.

## The short version

The feature is sound and the hard guarantee (`settle` never moves a blocked pair from
clear to inside) is well isolated. The maintainability problem is that **four** ways of
"not pushing into a surface" now coexist, and the one that is OFF is the largest body of
code in the module. Five changes would do most of the good:

1. **Split guard.js along the on/off line.** ~245 of its 537 lines (the lazy-row machinery,
   `budgetFrame`, `beginFrame`/`linearise`/`rows`/`active`) only run when
   `COLLIDE_IN_SOLVE` is true, and it is false. Move them to `collide/guard-rows.js` (or
   delete them, see 2). What stays — `check`/exemptions, `walk`, `settle`, `slideStep`,
   `readContacts` — is the shipped guard, about 290 lines, and reads top to bottom.
   *Do now.*
2. **Decide the fate of the solver rows, and make the decision visible.** The rows were
   gated off by a bench (guard.js:23-27) and the settle-side slide has since caught up with
   their one advantage (sliding) in two of the three reference tests
   (test/pose-param-solve-collide.test.js:151-154 shows settle's own slide reaching the
   target). Either delete the rows (and `budgetFrame`, `collisionRows` in param-solve.js,
   `collideFramed`, `collideInSolve`, `collideBudget`, the goal-drag "near an obstacle"
   branch in `defaultSolve`, the lazy-rows test, two wiring tests and a perf test) or keep
   them as an explicit experiment behind a flag whose consumers are named in ONE place. Today
   the flag is read in guard.js, pose-session.js:65/195, scripts/check-pose.mjs:842 and
   pinned by a test (test/collide-guard.test.js:34). *Do now (the decision); the deletion is
   a single PR afterwards.*
3. **Fix settle's hidden state mutation before calling it twice.** `walk` calls `accept`
   (guard.js:526, 530), which rewrites the guard's `exempt` map. pose-session.js:257 then
   discards the first settle and re-runs a stop-dead one from the same `from`. A "near"
   exemption the slide dropped (the pair opened past clearance along the projected path)
   is gone when the second walk re-checks the original path, where the pair is still inside
   clearance at t≈0, so the frame can stop at `from` instead of at contact. The pins test
   uses a fake guard (test/pose-collide-wiring.test.js:119-139), so no test exercises this.
   Fix: have settle snapshot `exempt` at entry and commit only on return (or take a
   `commit` step), or move the pin check into settle so it runs once. *Do now (correctness).*
4. **One rigid-pair toolkit instead of three copies.** "Box under a matrix", "relative
   placement R", "point in mesh frame" and "gap along a fixed normal" are each written two
   to four times across guard.js, world.js and sweep.js (list below). Put them in
   `collide/motion.js` (which already holds `applyMat`/`cornerTravel`) and import.
   *Worth doing; mechanical.*
5. **Give the settle result and the guard a written contract** in one place
   (`types/` is the house convention). `{ params, blocked, contacts? }` is read by
   pose-session (normal only), re-oriented by pose-collide (blocked only, not
   `contacts[].moving`) and produced by two code paths in settle. `contacts[].moving` and
   the wrapper's `moving` (pose-collide.js:193) have no reader. *Worth doing.*

## 1. Layering: is this the right decomposition?

The four mechanisms, where each lives, and what runs in the shipped build:

| Mechanism | Where | Shipped? | Role |
|---|---|---|---|
| Solver rows (DLS residuals, lazy rows, per-iteration linearise, frame budget) | guard.js:187-405, 54-81; param-solve.js:229-262, 880-907; pose-session.js:236 | **off** (`COLLIDE_IN_SOLVE=false`) | smooth slide inside the solve |
| Stop-at-contact (`walk`: sub-step + bisect) | guard.js:504-536 | on | the hard guarantee |
| Param-space slide (`slideStep`: read contacts, FD gradients, project remaining step, re-walk) | guard.js:409-502 | on (`COLLIDE_SLIDE=true`) | slide within one frame |
| Target projection (`tangentTarget`) + pin post-check (`pinDrift`) | pose-session.js:243-277, 313-338 | on | slide across frames; undo a slide that broke a pin |

Observations:

- **Stop + param slide is a coherent pair** and belongs in the guard: both are "given a
  path in param space, how far can I go". Good.
- **`tangentTarget` is a different thing** — it edits the *input* of the solve, in world
  space, using normals from the *previous* frame. It is the right place (the session owns
  the target; the guard knows nothing about pointers), but it is only applied to limb drags
  (pose-session.js:360), not generic handles (line 350-353 passes `t` untouched). The
  guide (AUTHORING-PARTS.md:3734-3736) says "later frames of the same drag slide the
  pointer's target" without that qualifier. Either apply it to generic point drags too or
  say "a limb drag" in the guide (AGENTS.md:796 already does).
- **The pin post-check is a patch over a layering gap**: the slide runs where pins are
  not constraints, so the session checks afterwards and throws the frame away. Two
  cleaner options: (a) pass the holds into settle as "params the slide may not move" —
  the projection already works in param space, so the slide could zero the gradient
  columns of params a pin depends on (cheap approximation) — or (b) accept the patch but
  make it one settle call (`settle(from, end, { blend, pinDrift })`), which also removes
  the double-mutation bug in (3). I would take (b) now and (a) later.
- **The goal-drag "near an obstacle, switch to solveGoalPinned" branch**
  (pose-session.js:126-137, spec lines 206-224) is dead in the shipped build: `solveGuard()`
  returns null when `collideInSolve` is false, so `collide` is null in `defaultSolve`. The
  arm therefore settles along a *linear blend of goal params*
  (pose-session.js:143), which the spec explicitly calls wrong ("Interpolating goal params
  would let derive's goal solve jump to another arm shape between checks", spec:188-190).
  `walk`'s "a blend that jumps lags rather than tunnels" guard (guard.js:511-518) makes it
  safe but laggy. If the rows go, this branch and `collideFramed` go with them; if they
  stay, document that the arm's slide is the settle slide over goal+seed params.

### What is dead or off-by-default (quantified)

- guard.js: lines 54-81 (`budgetFrame`, 28 lines), 187-345 (rows state, `seen`/`known`
  bounds, `store`, lazy `order`/`resolve`/`defer`, `beginEager`/`beginLazy`, 159 lines),
  347-405 (`rowCount`/`active`/`beginFrame`/`linearise`/`rows`, 58 lines): **~245 of 537
  lines (46%)** run only with `COLLIDE_IN_SOLVE` on. Of the ten exported constants, five
  (`COLLIDE_WEIGHT`, `MAX_ROWS`, `COLLIDE_IN_SOLVE`, `COLLIDE_FRAME_BUDGET_MS`, and
  `COLLIDE_BAND_MM`'s "rows start this far out" meaning) describe the off path.
  `COLLIDE_BAND_MM` itself is still live: `half` sizes the sub-step (guard.js:134, 507) and
  sweep.js:375 reuses it as the rigid step bound — a shared constant with two meanings.
- param-solve.js: `collisionRows` (229-262) and the row hooks in `solveAngles` (317, 329),
  `solveHandle` (407, 437), `solveGoalPinned` (880-907) — live code paths that receive null.
- pose-session.js: `solveGuard`, `collideBudget`, `collideInSolve` options (193-195, 236).
- world.js: `limit`, `upper`, `pairs` (used by rows and by `readContacts`'s cousin
  `resolve`), `bounds` (used by `check` — live), `candidates` (rows + sweep — live). Only
  `limit`/`upper` are rows-only.
- Tests pinned to the off path: test/collide-guard-lazy.test.js (whole file, 149 lines),
  test/collide-guard.test.js:42-110 ("drag guard rows", 6 tests),
  test/pose-collide-wiring.test.js:141-177 and 346-401 (`budgetFrame`, 3 tests),
  test/collide-perf.test.js:77-105 (two timed solves *with* rows),
  test/pose-param-solve-collide.test.js:47-88 ("re-runs re-linearise") and the `collided`
  arm of 119-155.

That is roughly 500 lines of tests holding roughly 350 lines of source that is switched
off. Keeping it is a legitimate choice (the spec's "Fallback" section and the bench data
in docs/research/collisions-pose-after.json justify it), but it is currently paid for on
every refactor of guard.js because it shares the file, the `exempt` map, the `matsAt`
memo and `world.distances`' option surface with the live path.

## 2. Module boundaries and size

### guard.js (537 lines)

Natural seams, in order of how cleanly they cut:

- **`guard-rows.js`** (the solver rows + `budgetFrame`): depends on `exempt`, `guardOnly`,
  `matsAt`, `moving`, `world`, `clearance` — all available at `createDragGuard` time.
  Build it as `createRowGuard({ world, matsAt, moving, exempt, guardOnly, margin })` and
  spread its three methods onto the guard object. Nothing on the live path reads
  `seen`/`known`.
- **`exemptions`** (`exempt`/`guardOnly`/`check`/`accept`, guard.js:135-185): the one
  piece of state that both the walk and the rows read. It is the thing that should be
  made transactional (finding 3). Worth a small named object `createExemptions(...)` with
  `check(mats) -> {clear, blocked, next}` and `accept(next)` — then "snapshot/commit"
  becomes one method pair.
- **`slide.js`**? I would NOT split `slideStep` out: it reads the same `readContacts`,
  `matsAt` and `walk`. Keep it in the guard, below `settle`.
- The doc comment at guard.js:434-440 ("Where the rest of a blocked move can go…") is
  attached to `readContacts`, not `slideStep` — the two JSDoc blocks are stacked. Fix when
  touching.

### pose-session.js (534 lines)

The session is doing three jobs: drag lifecycle + ghosts (its original one), pins, and
collision glue (`settled`, `pinDrift`, `tangentTarget`, `releaseValues`'s clear checks,
`releaseGuard`). The collision glue is ~90 lines and is the part that changed in every
slide iteration. A `pose/drag-collide.js` with `createDragCollide({ guard, locate, part,
holds, blockedChange })` exposing `settle(result, from)`, `target(params, point)`,
`releaseValues(touched, snapshot, lastClear)` and `release()` would leave the session's
`apply`/`frame`/`end` reading like they did before collisions. The existing injection style
(effects in, pure out) makes this an easy cut, and the session tests can keep driving it
through the session.

### oracle/sweep.js (493 lines)

Two seams:

- `pairTravel`, `arcFactor`, `turnOf`, `movedBox` (sweep.js:57-66, 125-162) are a
  "screw-motion bound" leaf that imports only motion.js and geometry/pose.js. They belong
  in `collide/motion.js` (or a `collide/advance.js`), where `world.js`'s and `guard.js`'s
  copies of `movedBox`/`relOf` can join them.
- `closingDriver`, `mergeContacts`, `freeRange` (sweep.js:427-493) are report shaping,
  not stepping. They could sit under `sweepOne` in a `sweep-report.js`, but the gain is
  smaller; the engine's closures (`measure`, `advance`, `scan`, `transitions`) are the
  real bulk and are tightly coupled by design. I would leave sweep.js alone beyond the
  first move.

### Duplicated concepts (concrete)

| Concept | Copies |
|---|---|
| point under mat4 | motion.js:11 `applyMat`; world.js:56 `apply` (identical body, no identity fallback) |
| AABB under mat4 | guard.js:85 `boxUnder`; world.js:62 `movedBox`; sweep.js:126 `movedBox` |
| box corners | world.js:50 `cornersOf`; inlined loops in guard.js:88, sweep.js:128, motion.js:25 |
| relative placement R = inv(Ma)·Mb | guard.js:204 `relOf`; world.js:199; sweep.js:144-145, 259 |
| closest points into mesh frames | guard.js:238-239 (`store`), 309-310 (start), 448 (`readContacts`); sweep.js:475 |
| gap along a fixed normal n·(A·pa − B·pb) | guard.js:399-402 (`rows`); guard.js:471-474 (`gapAt`); sweep.js:476-479 (`sep`) |

One `contactFrame(r, ma, mb)` → `{ a, b, pa, pb, n }` and one `gapAlong(c, mats)` in
motion.js would replace the last two rows and make the slide, the rows and
`closingDriver` provably compute the same linearisation.

Pair *exemption* is NOT duplicated: the guard exempts (pairs inside at start may open),
the sweep never does (sweep.js:28-30), by design. Keep that difference, but say it once in
the guide — it is currently in the sweep header and in AGENTS.md but not under "Other
rules" in AUTHORING-PARTS.md.

## 3. Interfaces and contracts

- **Settle result.** Produced at guard.js:411 (`{params, blocked}`), 416
  (`{...first, contacts}`), 430 (`{params, blocked, contacts?}`). `contacts[]` is
  `{ a, b, normal, moving }`; only `normal` is read (pose-session.js:271). `moving` is
  dead output. pose-collide's wrapper re-orients `blocked` (pose-collide.js:195-196) but
  not `contacts` — harmless today, inconsistent if anyone starts reading `contacts.a`.
  Recommend: `contacts: [{ a, b, normal }]`, documented in a `DragSettle` type.
- **Guard object.** Two shapes exist: `createDragGuard`'s (guard.js:347) and
  pose-collide's wrapper (pose-collide.js:186-204), which adds `moving` (unread) and
  `release`. pose-session documents `release?.()` as optional (pose-session.js:46). A
  `DragGuard` interface in `types/` (internal module; a `types/internal.d.ts` or a JSDoc
  `@typedef` in guard.js) with `settle`, `isClear`, `release?` as the live surface — and
  `beginFrame`/`linearise`/`rows`/`rowCount`/`active` marked as the rows extension — would
  make finding 1's split a non-event for callers.
- **mats contract** (missing = identity, null = excluded) is stated well in world.js:6-8
  and repeated in guard.js:10-11, motion.js:3, part-guard.js:36. Fine; it is the one
  contract that IS written once and referenced.
- **settle options.** `{ blend, slide }` — `slide` is only passed `false`, and only by the
  pin post-check. If finding 3's fix moves the pin check inside, `slide` as a public
  option can go (tests use it at test/pose-param-solve-collide.test.js:138; they can pass
  a `holds`-shaped arg instead).
- **`defaultSolve({ collide })`** and `collideFramed` (param-solve.js:825-828) are the
  rows' interface into the solver. They stand or fall with finding 2.

## 4. Constants

Fourteen tuning constants over three files, two clocks of "bisections", two of
"how far before it counts":

| Live | Off-path | Where |
|---|---|---|
| `COLLIDE_BAND_MM` (sub-step = half; sweep's step bound) | `COLLIDE_BAND_MM` (rows start) | guard.js:18 |
| `MAX_SUBSTEPS`, `SETTLE_BISECTIONS`, `SLIDE_BISECTIONS`, `SLIDE_SKIN_MM`, `SLIDE_ROUNDS`, `SLIDE_WITHIN_MM`, `SLIDE_FD`, `COLLIDE_SLIDE` | `COLLIDE_WEIGHT`, `MAX_ROWS`, `COLLIDE_IN_SOLVE`, `COLLIDE_FRAME_BUDGET_MS`, `LAZY_SLACK_MM` | guard.js:19-50, 266 |
| `PIN_SLIDE_MM` | | pose-session.js:69 |
| `CONTACT_EPS` | | pairs.js |
| `SWEEP_REBUILD_STEPS`, `SWEEP_MAX_STEPS`, `BISECT_TOL`, `STILL_MM`, `MIN_RES_MM`, `MAX_TURN`, `ADVANCE_FLOOR` | | sweep.js:43-69 |
| `WITHIN_FIRST_MM`, `BOUND_PAD_MM`, … | | world.js:86-92 |

Suggestions:
- Rename `COLLIDE_BAND_MM` on the live path to what it is: `SETTLE_STEP_MM = 1` (the
  sub-step travel bound) and let sweep.js import that; keep `COLLIDE_BAND_MM` as the rows'
  margin in guard-rows.js. Today a reader has to know the band is "2, halved" in two files.
- `SLIDE_WITHIN_MM` (0.25) is the one constant with no comment on how it was picked;
  with `CONTACT_EPS` 0.001 and skin 0.05, a pair 0.2 mm away counts as a contact to slide
  along — is that "pairs the bisection could not quite reach" (6 bisections of a 1 mm step
  → 16 µm, so no) or "a second contact the slide would meet"? Say which.
- The "exports the tuning values" test (test/collide-guard.test.js:27-40) pins all ten
  values. It catches nothing a reader would not see in the diff and fails on every tune.
  Drop it, or keep only the two that are switches (`COLLIDE_IN_SOLVE`, `COLLIDE_SLIDE`)
  since the docs state them.

## 5. Tests

Good: the guard tests drive `settle` on real small meshes (`collideBarTwo`) and assert
geometry (`world.distances(...).length === 0`), not internals; the sweep tests assert
report rows; the wiring tests fake the guard at its API. Specific notes:

- **Obsolete / brittle now:** `collide-guard-lazy.test.js` and "drag guard rows" test the
  off path bit-for-bit against an eager re-implementation — valuable only if the rows
  ship. Decide with finding 2.
- **"by default the solve gets rows exactly when COLLIDE_IN_SOLVE is on"**
  (wiring:166-177) asserts `x === FLAG` — tautological whichever way the flag goes.
- **Pin post-check** (wiring:119-139) reads `guard.calls.map(c => c.slide)`: it tests
  that settle was called twice with `slide:false` the second time, i.e. the mechanism,
  not the outcome ("the pinned point did not move more than 0.5 mm"). After finding 3's
  fix this test changes anyway; rewrite it to assert the written params on a real
  `createPartGuard` over `collideBarTwo` with a pinned point.
- **The double-settle on a real guard is untested** (finding 3).
- **collide-perf.test.js** pins timings (with uncommitted loosening 16 → 20 ms for the
  bisect+slide frame). Perf pins at 2× target on a CPU-paced clock are reasonable; but two
  of the four time the rows path. If the rows go, the file shrinks to "settle+slide on
  the hand" and "arm goal frame", which is what ships.
- `test/pose-param-solve-collide.test.js:119-155` runs three drags (`dead`, `slid` with
  rows, `settled` with slide) and asserts the two sliding ones beat dead by 5 mm. That is
  the right behavioural test for sliding; it survives any refactor.

## 6. Docs drift (verified)

- `src/parts/hand.js:362-364`: "stops at its surface rather than passing through (and
  will slide along it once collide/guard.js's COLLIDE_IN_SOLVE is on)". It slides now.
- `docs/AUTHORING-PARTS.md:3702-3703` (section intro): "a drag that would push one sub-part
  into another stops at its surface" — the detailed paragraph at 3727 says stop-and-slide;
  make the intro match.
- `docs/AUTHORING-PARTS.md:3734-3736`: "later frames … slide the pointer's target" — limb
  drags only (pose-session.js:350 vs 360).
- `scripts/bench-pose.mjs:21-23`: "settle bisects back to contact each frame" — now
  bisects then slides; the dragContact scenario's cost changed (perf test loosened).
- `src/framework/pose/pose-session.js:23-45` header: still describes "stops at contact";
  the slide, `tangentTarget` and the pin check are documented only inline (and the
  `tangentTarget` JSDoc at 305-312 is attached to `pinDrift` at 314 — two stacked JSDoc
  blocks, same slip as guard.js:434-440).
- `src/framework/pose/readout-chip.js:7-8, 24` and `pose-mode.js:1221-1222, 1241`: "stopped
  at contact" wording is still right in meaning (the chip shows when the frame ended
  blocked), but "a drag of any handle whose last frame stopped at contact" now means
  "whose slide could not take the whole move" — one clause each.
- Spec `docs/superpowers/specs/2026-11-02-collisions-design.md` has no section for the
  settle slide or `tangentTarget`; its "Fallback: stop at contact" (241) is what shipped,
  plus two layers it does not mention. A short "What shipped (2026-11-03)" block at the
  top, pointing at the AGENTS.md paragraph, would stop a future reader implementing the
  spec's solver-rows design a second time.
- AGENTS.md:665-669 and 785-802 are current (updated in the working tree). The second
  paragraph is one 18-line sentence-run; it will read better once finding 1 gives it file
  names to point at.

## Correctness risks noticed in passing

1. **Settle is not transactional** (finding 3 above). guard.js:185 `accept` rewrites
   `exempt`; pose-session.js:257 calls settle twice on one frame. Affects drags that start
   with a pair inside clearance (preset poses, saved poses) and pins set.
2. **`slideStep`'s projection uses the step itself as the FD scale** (guard.js:480:
   `h = SLIDE_FD * step[j]`). On a goal-param drag the "params" include the six seeds,
   which `derive`'s IK re-solves — a 1e-3 nudge of a seed through an IK solve can land on
   a different local answer, so the gradient column is not of the function being walked.
   The walk's own check keeps it safe; it just may refuse to slide. Low; note it in the
   comment.
3. **Stale normals across frames**: `drag.normals` is only replaced when a settle reports
   contacts (pose-session.js:271) and only dropped when the pointer reverses (330). After
   sliding round a curved neighbour the stored world-frame normal no longer matches the
   surface under the piece, so the target projection removes the wrong component until the
   next stop refreshes it. Behavioural, not a crash; the next contact self-corrects.
4. `facing()` (guard.js:455) re-derives `matsAt(end)` — memoised, fine — but on the
   `slide:false` path it is called with `blend(1)` while the walk stopped much earlier;
   "the side that moved more" is judged on the whole intended move, which is what you want.
   No bug; worth a comment since it looks like one.

## Proposed refactor plan (small, independently landable)

1. **Make settle transactional** (guard.js): snapshot `exempt` at entry, apply on return;
   add a test on a real guard with a pair inside clearance at start and a discarded first
   settle. Fixes risk 1; no API change. *~40 lines.*
2. **Move the pin check into one settle call**: `settle(from, end, { blend, pinDrift })`
   where `pinDrift(params) → mm` is supplied by the session; settle re-walks stop-dead
   itself. Delete the `slide` option. Rewrite wiring:119 as a behavioural test. *~60 lines.*
3. **Doc pass**: hand.js:362, AUTHORING-PARTS.md:3702 and 3734, bench-pose.mjs:21,
   pose-session.js header, the two stacked JSDoc blocks, a "what shipped" note in the spec.
   *No code.*
4. **Decide the rows.** Write the decision in guard.js's header (keep as experiment /
   delete). If delete: one PR removing guard.js:54-81, 187-405, param-solve.js
   `collisionRows` + call sites + `collideFramed`, pose-session.js `solveGuard`/
   `collideBudget`/`collideInSolve`/the near-obstacle goal branch, scripts/check-pose.mjs:842,
   the lazy test, the rows tests, two perf tests, `limit`/`upper` in world.js. If keep: step 5.
5. **Split guard.js**: `guard-rows.js` (rows + `budgetFrame`) spread onto the guard
   behind the flag; `createExemptions` named. Guard tests move with their code. *Pure
   move; diff large but mechanical.*
6. **One rigid-pair toolkit** in motion.js: `movedBox`, `cornersOf`, `relativeOf`,
   `contactFrame`, `gapAlong`; replace the six copies. world.js drops its private `apply`.
   *Mechanical; the bit-exact tests (`collide-world`, `oracle-sweep`) will catch any
   arithmetic reorder.*
7. **Extract `pose/drag-collide.js`** from pose-session (settle glue, target projection,
   release values). Session tests unchanged. *~120 lines moved.*
8. **Rename `COLLIDE_BAND_MM`'s live meaning** to `SETTLE_STEP_MM`; sweep.js imports that.
   Drop the constants-pinning test or trim it to the two switches. Comment
   `SLIDE_WITHIN_MM`.
9. **Types**: `DragGuard`, `DragSettle`, `SettleContact` typedefs (JSDoc or
   `types/internal.d.ts`), drop `contacts[].moving` and the wrapper's `moving`.
10. **(Later) move the screw-motion bound** (`pairTravel`/`arcFactor`/`turnOf`) out of
    sweep.js into `collide/advance.js`, and consider feeding holds into the slide as
    frozen gradient columns, which would retire the pin post-check from step 2.

Steps 1-3 are safe to land before the branch merges; 4 is a decision the branch should
record even if the deletion lands after.
