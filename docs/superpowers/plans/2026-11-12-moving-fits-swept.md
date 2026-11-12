# Moving Fits Are Swept (partforge half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** partforge holds `verify.ok` at `null` while a param moves one piece against another with no sweep declared, and a sweep's `clearance` may be `0` (touch, never press in) or negative (press in up to that depth).

**Architecture:** A new BVH-free leaf (`collide/motion-coverage.js`) finds motion params and which are covered, reusing `scanMotion`/`readSweep`; lint and verify both read it. The collision world gains a penetration-depth reading used only on contact intervals; the sweep engine classifies each contact by depth against the sweep's allowance.

**Tech Stack:** Plain ESM JavaScript, vitest (`npx vitest run test/<file>`), eslint (`npm run lint`), knip (`npm run lint:dead`).

**Spec:** `docs/superpowers/specs/2026-11-12-moving-fits-swept-design.md` (sections A–D and G apply here; E and F are the cloud repo's).

## Global Constraints

- No sweep runs that the part did not declare.
- No new top-level part key and no new `verify` key; the only vocabulary change is sweep `clearance` accepting `0` and negatives.
- `collisions.clearance` still rejects negatives (`collisions-bad-clearance` unchanged).
- Lint findings added here are warnings: a stored forge must still load.
- Verify never throws on a malformed part; a motion that cannot be probed is skipped, not an error.
- `collide/motion-coverage.js` must stay loadable by the lint closure and the worker's eager closure (`test/worker-layering.test.js`): no BVH, native core or `oracle/` import.
- A declared sweep that timed out stays today's volunteered warning; coverage is satisfied by the declaration.
- The hint text always suggests `clearance: 0`.
- Version: `0.191.0` (or the next minor if main moved). Regenerate anything `npm test` says is stale (doc/domain indexes).
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. A posing param whose control has no finite `min`/`max` (a typed number, a `wrap` angle with a range, a select): never crash; a rangeless numeric param that poses a piece is reported uncovered with a hint that says to give the control a range. (Task 1)
2. A `place()` that throws or returns an unreadable transform at one end of the range, or a sub-part `enabled` only part of the way: the scan skips that param in that view silently; verify and lint still return. (Task 1)
3. Cost: a part with 60 controls and 6 views must scan in well under the quick-lap budget. Only params that some view's placement actually reads are stepped; assert the scan of `hand.js` takes < 150 ms and probes no param that poses nothing. (Task 1)
4. A full turn (`wrap` rotary, ends place alike) and a param that moves every shown piece together: the first IS a motion, the second is not. (Task 1)
5. A sweep at `clearance: 0` over a lid resting on its base at one end and a pin running in a bore: resting and the running gap read clear; the same lid driven 1 mm into the base reads a contact with `depth` near 1. (Task 5)

---

### Task 1: Motion detection and coverage (`collide/motion-coverage.js`)

**Files:**
- Create: `src/framework/collide/motion-coverage.js`
- Test: `test/motion-coverage.test.js`
- Read first: `src/framework/collide/sweep-targets.js` (`scanMotion`, `readSweep`, `sweepsInView`, `motionOf`), `src/framework/part-model.js` (exportable sub-parts in a view), `src/framework/pose/param-solve.js` (`rangesOf`).

**Interfaces:**
- Produces:
  - `motionParams(part, view, full) → Array<{ param: string, range: [number, number] | null, moving: string[], against: string[] }>` — params that, stepped over their control range with the others at `full`, rebuild NO sub-part shown in `view` and move at least one exportable sub-part relative to another exportable sub-part shown there. `moving` = pieces whose placement changes; `against` = exportable pieces shown that do not move with them. `range: null` for a numeric param with no finite range that a placement reads (detected by probing `full[param]` ± a nominal step of 1 and 10).
  - `coveredParams(part, view, full) → Set<string>` — params moved by some declared `verify.sweeps` entry that runs in `view` (param sweep; handle sweep's params; path/preset waypoints' changed keys; animation tracks' params).
  - `uncoveredMotions(part, full) → Array<{ view, param, range, moving, against }>` — over every key of `part.views`, `motionParams` minus `coveredParams`, one entry per (param) keeping the FIRST view it is a motion in; `[]` for a part with no `views` map or one exportable piece.
  - `MOTION_HINT(entry) → string` — the exact hint:
    `"<param>" moves <moving, comma-joined> against <against, comma-joined> in view "<view>" and no sweep checks that motion. Add verify.sweeps: { <param>: { param: "<param>", clearance: 0 } } and verify.expect._view: { sweepContacts: 0 }.`
    With `range: null` it ends instead: `Give the "<param>" control a min and max first, so the sweep has a range.`
- "Moves relative to": two pieces move together when their placement deltas between samples are the same matrix (use `sameMat` on `m_i · inverse(m_0)`); a param under which every moving piece shares one delta AND no shown exportable piece stays still is not a motion.

- [ ] **Step 1: Write failing tests** in `test/motion-coverage.test.js`, with inline parts (two boxes, `views` map):
  - `hinge`: lid `rotateAbout` by `p.open` (0..110) → `[{ param: "open", moving: ["lid"], against: ["base"] }]`.
  - `slide`: drawer translated by `p.out` → motion.
  - `explode`: lid lifted by `p.explode` → motion (spec C).
  - `size`: `p.height` read by base `build` and lid placement → `[]`.
  - `together`: both pieces translated by `p.shift` → `[]`.
  - `single`: view showing one piece → `[]`.
  - `ghost`: the only still piece is `exportable: false` → `[]`.
  - `turn`: `wrap` control 0..360 rotating a gear → motion.
  - `noRange`: control with no min/max posing the lid → entry with `range: null`.
  - `throws`: placement throws for `open > 90` → `motionParams` returns without throwing and omits `open`.
  - coverage: each of `{param}`, `{handle}`, `{from,to}`, `{path}`, `{animation}` covering `open` empties `uncoveredMotions`; a sweep with `views: ["print"]` does not cover the assembly view.
  - `uncoveredMotions` on a part whose motion lives in the THIRD view returns it with that view's name.
  - `MOTION_HINT` equals the exact strings above.
  - `src/parts/hand.js`: scan completes in < 150 ms (Review Focus 3).
- [ ] **Step 2:** Run `npx vitest run test/motion-coverage.test.js` — expect failures (module missing).
- [ ] **Step 3:** Implement. Pre-filter candidate params cheaply: a param is a candidate in a view only if changing it changes some placement matrix at one probe (min vs max, plus mid); only candidates get the full `scanMotion`.
- [ ] **Step 4:** Run the test file, `npx vitest run test/worker-layering.test.js`, `npm run lint`. Expect PASS.
- [ ] **Step 5:** Commit `Find motion params and which a declared sweep covers`.

### Task 2: Lint warning `motion-unswept`

**Files:**
- Modify: `src/framework/lint/rules-collisions.js` (add to `COLLISION_RULES`), `docs/ERROR-PATTERNS.md` (new `motion-unswept` entry in the house Symptom/Cause/Fix shape)
- Test: `test/lint-collisions.test.js`; whatever registry test lists rule ids (`test/lint-registry.test.js`)

**Interfaces:**
- Consumes: `uncoveredMotions(part, p)`, `MOTION_HINT(entry)` from Task 1.
- Produces: finding `warn("motion-unswept", '"<param>" moves <moving> against <against> in view "<view>" and no sweep checks that motion', <MOTION_HINT's second sentence onward>, "verify.sweeps")`, one per uncovered motion.

- [ ] **Step 1:** Failing tests: the Task 1 `hinge` part gives one `motion-unswept` warning (severity warning, not error) with the hint; adding `verify.sweeps.open` removes it; `hinged-box.js` as it stands today gives one for its lid angle (it is fixed in Task 7); a part with malformed `views` gives none and does not throw.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run `npx vitest run test/lint-collisions.test.js test/lint-registry.test.js test/lint-parts.test.js` and fix any reference part the new warning surprises ONLY by noting it for Task 7 (reference parts gain sweeps there); if a test asserts "no warnings" on a reference part, move that part's fix forward into this task.
- [ ] **Step 5:** Commit `Lint: warn when a moving piece has no sweep`.

### Task 3: Verify withholds the verdict (`sweepCoverage`)

**Files:**
- Modify: `src/framework/oracle/verify.js` (near the `// ── sweeps ──` block and where view checks are assembled, ~lines 280–300 and 619–640)
- Test: `test/verify.test.js` (or a new `test/verify-sweep-coverage.test.js`)

**Interfaces:**
- Consumes: `uncoveredMotions`, `MOTION_HINT`.
- Produces: one check per uncovered motion, appended once per verify (like `sweepNotices`), full AND quick laps:
  `{ scope: "view", subpart: null, metric: "sweepCoverage", expr: "<param>", actual: null, status: "skip", pass: null, unevaluated: true, message: 'no sweep declared for "<param>"', hint: MOTION_HINT(entry) }`.
  It counts as DECLARED (so it reaches `verify.unevaluated` and holds `ok` at `null`), unlike `sweepNotices`' volunteered warnings. A part with no `verify` block at all still gets the check (its `ok` is already `null`).

- [ ] **Step 1:** Failing tests:
  - hinge part with `expect: { base: { watertight: true } }` and no sweep → `ok === null`, `unevaluated` has one entry with `metric: "sweepCoverage"` and the exact hint; `evaluated` still counts the watertight check.
  - same on `{ quick: true }`.
  - adding `verify.sweeps: { open: { param: "open", clearance: 0 } }` → `ok === true` (no `sweepContacts` expectation declared: reported, not gated).
  - a declared sweep that times out (pass an already-expired `deadline`) → `ok === true`, one `sweeps` warning, no `sweepCoverage` entry (decision 4).
  - motion only in a non-verified view → still withheld, hint names that view.
  - the `size`/`together`/`single` parts from Task 1 → no `sweepCoverage` check.
- [ ] **Step 2:** Run, FAIL. **Step 3:** Implement; replace the comment at ~line 216 context only if it now misstates the rule for motion (add one sentence, do not delete the sheet rule). **Step 4:** Run `npx vitest run test/verify*.test.js test/measure-sweeps.test.js`; golden files that change because a reference part now reads `null` are deferred to Task 7 only if Task 7 fixes that part — otherwise update the golden here and say why in the commit.
- [ ] **Step 5:** Commit `Verify: hold the verdict while a moving piece is unswept`.

### Task 4: Penetration depth in the collision world

**Files:**
- Modify: `src/framework/collide/world.js` (or create `src/framework/collide/depth.js` if `world.js` would pass ~300 lines)
- Test: `test/collide-world.test.js`

**Interfaces:**
- Produces: `world.depth(a, b, mats) → number` — millimetres the two named sub-parts press into each other at placements `mats`; `0` when separated or merely touching. Estimate: the largest distance from a vertex of one mesh that lies inside the other to that other's surface, taken in both directions (existing BVH closest-point plus a parity/containment test). Export `TOUCH_TOL_MM = 0.02`: a depth at or below it is "touching".
- Accuracy contract (the tests): within ±0.05 mm for box-in-box and cylinder-in-bore presses of 0.1–2 mm; a thin (0.4 mm) wall pressed 0.3 mm into a block reads 0.25–0.35.

- [ ] **Step 1:** Failing tests: two 10 mm boxes overlapping by 0.3 mm along X → 0.25..0.35; face-to-face touching → ≤ `TOUCH_TOL_MM`; 1 mm apart → 0; a 3 mm pin in a 2.8 mm bore (press 0.1 radial) → 0.05..0.15; a small cube wholly inside a large one, 2 mm from the nearest wall → about 2 plus its half-size reading per the vertex rule (assert ≥ 2); a coarse mesh edge crossing with no vertex inside (two long thin crossed bars) → > `TOUCH_TOL_MM` (handle the no-vertex-inside case, e.g. by sampling edge midpoints or the intersection segment).
- [ ] **Step 2–4:** Run/implement/run (`npx vitest run test/collide-world.test.js test/collide-perf.test.js`).
- [ ] **Step 5:** Commit `Collision world: read how deep two pieces press in`.

### Task 5: Sweep clearance of zero and below

**Files:**
- Modify: `src/framework/collide/sweep-targets.js` (`readSweep`: accept any finite `clearance`), `src/framework/oracle/sweep.js` (contact classification, row fields), `src/framework/oracle/verify.js` (the `sweepContacts` count), the CLI line that prints sweeps (find with `grep -rn "CONTACT at" src bin`)
- Test: `test/oracle-sweep.test.js`, `test/measure-sweeps.test.js`, `test/sweep.test.js`; fixtures `test/fixtures/hinge-frame-knuckles.js`, `test/fixtures/hinge-buried-axis.js`, `test/fixtures/hinge-detent.js`

**Interfaces:**
- Consumes: `world.depth`, `TOUCH_TOL_MM`.
- Produces (row shape additions, everything else unchanged):
  - A sweep whose `clearance <= 0` runs the engine at contact threshold `TOUCH_TOL_MM`; its row still reports `clearance` as declared.
  - Every contact gains `depth` (mm, deepest over its interval, sampled at the interval's ends and at least 5 interior points) — on positive-clearance sweeps too.
  - `allowed: true` on a contact when `clearance <= 0` and `depth <= -clearance + TOUCH_TOL_MM`. `row.clear` is `true` when every contact is allowed; `sweepContacts` counts rows with at least one contact that is not allowed; `freeRange` treats allowed contacts as free.
  - `minClearance.distance` is `-depth` at the deepest contact when pieces press in.
  - CLI: an allowed contact prints `rub at <v> a×b (0.30mm, allowed)` and the row reads `clear`.
- Fixtures (reduced from the two real forges in the spec, each a `views`-map part with an `open` control 0..110 and `verify.sweeps.open` at `clearance: 0`):
  - `hinge-frame-knuckles.js`: two plates, knuckle cylinders centred on the axis at the plate corner with no relief → contact with `depth > 1`.
  - `hinge-buried-axis.js`: two thick halves, axis 5 mm inside the back wall at the seam → clear at 0°, contact starting within the first 20°, `driver: "open"`.
  - `hinge-detent.js`: a working hinge (axis outside, relief cut) with a 0.3 mm bump that rubs between 40° and 50°.

- [ ] **Step 1:** Failing tests:
  - closed lid resting on its base, pin with 0.175 mm running gap, `clearance: 0` → `clear: true`, `contacts` all `allowed` or empty (Review Focus 5); the same lid placed 1 mm into the base at 0° → contact, `depth` 0.9..1.1, not allowed.
  - `hinge-detent`: at `clearance: -0.3` → `clear: true`, one contact `allowed: true`, `depth` 0.25..0.35, `sweepContacts` reads 0; at `clearance: 0` → `clear: false`, `sweepContacts` 1; at `-0.1` → not allowed.
  - `hinge-frame-knuckles` and `hinge-buried-axis` read as described above, and with `_view: { sweepContacts: 0 }` verify fails (`ok === false`).
  - a positive-clearance sweep that touched before still reports the same `from`/`to` and now carries `depth`.
  - `readSweep`: `clearance: -0.3` kept; `clearance: NaN` / `"x"` falls back to the declared default.
  - existing golden rows for `gearbox.js`, `drawer-box.js`, `hand.js` unchanged apart from added `depth` on contacts.
- [ ] **Step 2–4:** Run/implement/run `npx vitest run test/oracle-sweep.test.js test/measure-sweeps.test.js test/sweep.test.js test/verify*.test.js test/cli-sweep-budget.test.js`.
- [ ] **Step 5:** Commit `Sweeps: clearance 0 may touch, a negative clearance may press in`.

### Task 6: Sweeps run where the motion is, whatever view is verified

**Files:**
- Modify: `src/framework/oracle/verify.js` (the sweep case, ~lines 565–640), `src/framework/oracle/measure.js` only if a rows-for-other-view entry point is needed (`runSweeps` already takes `view`)
- Test: `test/verify.test.js` / `test/measure-sweeps.test.js`, `test/inspect-changes-sweeps.test.js`

**Interfaces:**
- Produces: on a full (non-quick) verify of view V, after V's own sweeps, each declared sweep that moves nothing in V but moves something in another view W is run in W (first such W in `part.views` order), within the same deadline, and its row is appended to the sweep rows with an added `view: "<W>"` field. `sweepContacts` on V counts those rows. Rows run in V itself carry no `view` field (unchanged shape). `measure()` called directly keeps today's behaviour (its own view only).
- A quick lap still never sweeps.

- [ ] **Step 1:** Failing tests: a part with views `{ base, lid, assembly, print }` (assembly third) and the `hinge-buried-axis` geometry, `verify.sweeps.open`, `_view: { sweepContacts: 0 }`: `verify(part, "base")` → `ok === false`, the failing check's rows include one with `view: "assembly"` and a contact; with the working hinge → `ok === true`; with an expired deadline → today's timeout warning and `sweepContacts` unevaluated; a single-view part's rows have no `view` key.
- [ ] **Step 2–4:** Run/implement/run `npx vitest run test/verify*.test.js test/measure-sweeps.test.js test/inspect-changes-sweeps.test.js test/jobs*.test.js`.
- [ ] **Step 5:** Commit `Verify: run a declared sweep in the view where it moves something`.

### Task 7: Docs, reference parts, release

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` ("Collisions and sweeps"), `docs/ERROR-PATTERNS.md` (`sweep-contact-at-start` rewritten; new `sweep-contact-detent`; `motion-unswept` from Task 2 cross-linked), `src/parts/hinged-box.js`, `docs/REFERENCE-PARTS.md`, `package.json` + `package-lock.json` (version), any generated index a test pins
- Test: existing doc/reference tests (`npm test`), plus assertions added to the test that already imports `hinged-box.js` (`test/examples-views-map.test.js`)

**Content fixed by the spec (wording is yours):**
- The clearance table (`> 0` never closer; `0` may touch, never press in; `< 0` may press in up to this depth), `depth`/`allowed` on contact rows, negative `minClearance.distance`, the row's optional `view`.
- "A pair that starts seated": use `clearance: 0`; `sweep-contact-at-start` now says the same.
- The unswept-motion rule: what a motion is (place-only, one exportable piece against another, every view scanned), that the verdict is held until a sweep is declared, that a timed-out sweep is a warning, and the exact hint.
- A **hinge recipe** paragraph: put the axis outside both bodies or cut the swing relief; give knuckles a gap along the axis and a relief in the opposite leaf; sweep the angle at `clearance: 0`; write `freeRange` back as the control's range when the stop is intended; fix geometry rather than narrowing the range to hide a contact.
- A **detent** paragraph: two sweeps with `range` — the whole travel at minus the bump height, the span between detents at `0`; `collisions.allow` is never the answer for a detent.
- `hinged-box.js`: add `collisions: {}`, a rotary handle on the lid, `verify.sweeps` for its angle at `clearance: 0`, `_view: { sweepContacts: 0 }`. If its hinge really collides, fix the geometry (that is the point); record what changed in the commit.

- [ ] **Step 1:** Add failing assertions: `hinged-box.js` lints with no `motion-unswept`, verifies `ok === true` with a sweep row `clear: true`, and has a handle with `drag: "rotary"`.
- [ ] **Step 2:** Write docs and the part; bump to `0.191.0`.
- [ ] **Step 3:** Run the WHOLE suite: `npm test`, `npm run lint`, `npm run lint:dead`. Every reference part must lint without `motion-unswept` or verify-null surprises: give each affected reference part its sweep (expect `drawer-box`, `gearbox`, `hand`, robot/limb parts to be covered already or need one line; the hand's unswept digits get sweeps only if they fit its budget — otherwise leave the warning and say so in `REFERENCE-PARTS.md`).
- [ ] **Step 4:** Commit `Docs and reference parts for swept moving fits; 0.191.0`.
