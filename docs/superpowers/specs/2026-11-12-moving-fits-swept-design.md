# Moving fits are swept: hinges that open, checked before the agent says done

Date: 2026-11-12. Status: design, awaiting approval.
Repos: `partforge` (the check), `partforge-cloud` (prompt, evals, wire).

## Why

Two published forges have hinges that cannot work as printed parts.

- **Hinged picture frame** (`hinged-picture-frame--73fa6850a23d`). No `// Interfaces:`
  line, no pin, no clearance, no `_view` expectation. Each knuckle is a cylinder centred
  on the hinge axis at the plate's corner, so it sits inside the other plate at every
  angle. `verify` declared one bounding box and passed.
- **Coal AirPods case** (`coal-airpods-case--4546bcdbb08b`). Interfaces lines written,
  `_view: { overlaps: 0 }` declared. That is read at ONE pose (the default, 70° open).
  The hinge axis sits inside the body's outline, so the lid's back edge passes through
  the base as it swings. Nothing checked the swing.

Three gaps produced them:

1. The compact prompt never mentions `verify.sweeps`, `sweepContacts`, `collisions` or
   handles for a mechanism. They are reachable only through `read_docs`.
2. The Interfaces rule lists `hinge` (contact) and `moving` / `printInPlace` (fit), but
   those pin only a static `clearance`. A fit that moves is checked like one that does not.
3. partforge stays silent when a param poses a piece and no sweep covers it.

## What "done" looks like (Scott's words, condensed)

Between writing a hinge and saying it is done, the agent has: checked the rotation works
as a printed part and does not collide with itself; wired controls so the user can see the
mechanism move, and probably an animation; and run the ordinary printability checks. This
must EXTEND the existing held/Interfaces system into one unified system, not sit beside it.

## Goals

- A forge with a moving piece cannot reach `verify.ok: true` until its motion is swept.
- One table in the prompt: how a pair is held decides what `verify` must say. Moving fits
  are a row of that table, not a second rulebook.
- Intended interference (a detent that rubs on purpose) passes, bounded by depth, while a
  lid ploughing through its base fails.
- A hinge whose lid rests on its base when closed can be swept without a false contact.
- Evals that reproduce both failures and a detent, graded without trusting what the model
  declared.

## Non-goals

- No auto-run sweeps. partforge never sweeps a motion the part did not declare.
- No new agent tool, and no new top-level key in a part.
- No change to Pose mode's drag behaviour beyond what falls out of the shared engine.
- Flexure physics (does the detent arm survive the deflection) stays `verify.flex`'s job.
- Not fixing the two published forges themselves (their owners' forges).

## Anti-goals

- A check that fires on forges with no mechanism (an exploded-view slider on a seated
  assembly must have a cheap, obvious answer, not a wall).
- A push that only lives in prompt prose. The frame skipped a prompt rule; the tool must
  be what holds the verdict.
- Vocabulary growth beyond one meaning added to an existing key (`clearance`).

## Decisions Scott made

1. **Change partforge too**, not only the cloud prompt and evals.
2. **Hold back the verify verdict** for an unswept moving piece (not a warning).
   This knowingly overrides the note in `oracle/verify.js` that "a check nobody declared
   must not withhold a verdict", for motion only.
3. **Detents are handled properly in the first version**, not by turning the gate off.
4. **A declared sweep that runs out of time passes with a warning.** The verdict is held
   only for a motion with NO sweep declared. A declared sweep that stopped short keeps
   today's volunteered `sweeps` warning, naming the unchecked motion, and the prompt tells
   the agent to say in its reply which motions were not checked. Many-joint parts (a
   posable figure, the hand reference part) therefore still reach a verdict.

## Design

### A. partforge: the unswept-motion check

**What counts as a motion.** A param is a *motion param* in a view when stepping it over
its schema range (a) changes NO sub-part's build — it is place-only, the existing
place-only-pose idea — and (b) moves at least one exportable sub-part rigidly relative to
another exportable sub-part shown in that view. Rule (a) is what keeps size params out:
`hinged-box.js`'s `height` moves the lid but rebuilds the base, so it is not a motion.
A hinge angle read inside `build()` escapes the check; the prompt already forbids that
and lint's `animation-track-rebuilds` / `sweep-rebuilds` already flag it. Accepted. The detection reuses `collide/sweep-targets.js`
(its `MOTION_SAMPLES` probing through `probePoses`), so lint and the engine agree, as they
do today for `sweep-rebuilds`. Not a motion: a param that moves every shown piece together,
a view showing one exportable piece, a view-only stand-in (non-exportable sub-part), and
the print layout (any view where nothing the param moves is posed relative to a neighbour
it could meet is simply not a motion there).

**What "covered" means.** A motion param is covered in a view when some `verify.sweeps`
entry that runs in that view moves it: a `param` sweep of it, a `handle` sweep whose
handle writes it, a path/preset sweep whose waypoints change it, or an animation sweep
whose tracks drive it.

**What happens when it is not covered.**

- `lint` gains a warning, `motion-unswept`, naming the param, the pieces it moves and the
  exact text to add. Lint stays non-blocking (a stored forge must still load).
- **Every view is scanned, whatever view is being verified.** The cloud verifies only the
  first declared view, and the AirPods case's `assembly` is its third. The coverage check
  is geometry-free, so it runs over all views and reports onto the verified one, naming
  the view the motion is in. For the same reason, the inspect report must run each
  declared sweep in the view(s) where it moves something even when that is not the
  verified view (within the existing report budget), and `sweepContacts` on the verified
  view reads those rows. Without this the goal does not hold in the cloud at all.
- `verify` adds one check per uncovered motion param, at view scope, metric
  `sweepCoverage`: `status: "skip"`, `pass: null`, `unevaluated: true`, with a `hint`
  carrying the same text. It counts as declared-and-unevaluated, so `verify.ok` is `null`
  and the entry appears in `verify.unevaluated` — the channel the agent's stop rule already
  acts on. On a quick lap it is reported the same way (it needs no geometry).
- The hint, verbatim shape:
  `"open" moves lid against base and no sweep checks that motion. Add
  verify.sweeps: { open: { param: "open" } } and _view: { sweepContacts: 0 }.`
  The hint ALWAYS suggests `clearance: 0` (see B and C): "nothing presses into anything"
  is the right default for a mechanism, needs no measurement to choose (so a quick lap
  gives the same hint), and never trips `sweep-contact-at-start`. So the suggested text is
  `verify.sweeps: { open: { param: "open", clearance: 0 } }`.

**Declared but not finished.** Coverage is satisfied by the declaration (decision 4). A
row that timed out is a warning, never `unevaluated` on its own account; `sweepContacts`
keeps today's rule (withheld only when every row stopped short).

**Declared but ungated.** A covered motion with no `sweepContacts` expectation keeps
today's behaviour (reported, not gated). The hand reference part relies on it. The prompt,
not partforge, tells the agent to gate.

### B. partforge: one number for how close a motion may come

Sweep `clearance` (per sweep, default `collisions.clearance`) gains its full range:

| `clearance` | Meaning along the motion |
| --- | --- |
| `> 0` (today) | never closer than this |
| `0` (new) | may touch, never press in |
| `< 0` (new) | may press in up to this depth (a detent, a snap passing over) |

- The engine today measures separation only (`collide/exemptions.js` says so). It gains a
  penetration-depth reading used ONLY on intervals where a pair is in contact: an estimate
  of how far one piece is inside the other (builder's choice of method; vertex
  inside-distance in both directions against the existing BVH is the expected one).
- Mechanics (confirmed against `oracle/sweep.js`: distances are unsigned and the
  advancement proof breaks at a threshold ≤ 0): a sweep with `clearance <= 0` RUNS at a
  small positive contact threshold, then each contact interval is classified by its
  depth. `readSweep` stops dropping a negative `clearance` to the default; only a
  non-finite value falls back.
- Each contact row (on positive-clearance sweeps too) gains `depth` (mm, the deepest along its interval). A contact whose
  depth stays within the allowance is reported with `allowed: true` and does not count
  toward `sweepContacts` or flip `clear`.
- Depth tolerance for "touching, not pressing" at `clearance: 0` is a named constant
  chosen by the builder (order of the mesh tolerance, about 0.02 mm), documented.
- `minClearance.distance` goes negative when pieces press in, so a row always carries the
  number to tune against.
- Per-pair allowance is not added. A sweep's clearance applies to every pair it moves; a
  detent on one pair and a hard rule on another are two sweeps with `views`/range, or the
  detent pair's allowance is accepted for the sweep. (My call; see "Calls I made".)
- Lint: `collisions-bad-clearance` keeps rejecting a negative `collisions.clearance`
  (Pose mode has no use for it); a sweep's own `clearance` accepts any finite number.

### C. partforge: a pair that starts seated

A closed lid rests on its base. Today a sweep from 0° reads `CONTACT at 0`
(`sweep-contact-at-start`). With B this needs no special case: the hint for a pair that
`verify` already lists under `contacts`, or that measures as touching at the range's end,
suggests `clearance: 0` (the hint always does), under which resting is clear and pressing in is a contact. The
`sweep-contact-at-start` error pattern doc is rewritten to say so.

An exploded-view lift on a seated assembly is a motion param by A. Its answer is the same
one line (`{ param: "explode", clearance: 0 }`), which runs in milliseconds for a
translation and reads clear. That is the designed cost of the rule for non-mechanisms.

### D. partforge: docs and reference parts

- `AUTHORING-PARTS.md` "Collisions and sweeps": the clearance table, `depth`/`allowed`,
  the seated-pair paragraph, and a short **hinge recipe** (axis outside both bodies or
  relief cut for the swing; knuckles get a gap along the axis and a relief in the opposite
  leaf; sweep the angle; write `freeRange` back as the control's range).
- `ERROR-PATTERNS.md`: `motion-unswept`, rewritten `sweep-contact-at-start`, a new
  `sweep-contact-detent` pointing at negative clearance.
- `hinged-box.js` (existing reference part) declares a sweep, a `collisions` block and a
  rotary handle, so `read_reference`/docs show the full pattern. A detent variant is added
  to it or as a sibling example, builder's choice.
- Release as a minor version (0.191.0 unless main has moved).

### E. Cloud: the prompt, one unified table

`prompts/authoring-compact-essentials.md`, the "Interfaces before geometry" bullet. The
existing sentence "Each pair pins one `_view` expectation" becomes a table the bullet
already implies, with moving fits as rows:

| The pair is | Pins in `verify` |
| --- | --- |
| press fit | `overlaps` +1 |
| fastened | `contacts` |
| seated (rests, glued, snapped shut) | `contacts`, and `held: true` on the assembly |
| floats with a gap (slip, push) | `clearance` at half the diametral offset |
| **moves** (`hinge`, `moving`, `printInPlace`, a slide) | the static `clearance` above, PLUS a sweep of the param that drives it and `sweepContacts: 0` |

and, for a moving pair, three sentences (wording is the builder's, content is fixed):

- The motion gets a control read only in `views` (already required), a `collisions: {}`
  block, and a handle (`drag: "rotary"` for a hinge, `"axis"` for a slide) so the user can
  move it; an animation when the motion is the point of the part.
- The sweep runs the control's whole range. Read its row: a contact names the pair, the
  angle and the `driver`; fix the geometry (move the axis outside the body, cut the swing
  relief, open the knuckle gap) rather than narrowing the range to hide it, then write
  `freeRange` as the control's range when the stop is intended.
- Intended rubbing is declared, never waved through: `detent 0.3` on the Interfaces line
  and `clearance: -0.3` on the sweep. `collisions.allow` is for gears and bearings only.

The existing `held` sentence stays, including "leave it off when a piece is captured with
running clearance". The Interfaces line grammar gains the optional `detent <mm>` suffix
and `slide` joins the contact list. The compact prompt's size ceiling test moves by the
measured amount.

Also in the cloud:

- `prompts/modules/printed-parts.md`: one sentence that a print-in-place hinge needs the
  swept gap to hold in the PRINT pose too (the pieces print assembled).
- `apply_part_changes` descriptions (both dialects) and the browser preamble: one line
  that `verify.unevaluated` may name an unswept motion and that the hint is the edit.
- `src/sandbox/protocol.js` `sanitizeSweeps`: pass `depth` (number) and `allowed`
  (boolean) on contact rows, and a negative `minClearance.distance`; `sanitizeVerify`
  already carries `unevaluated`/`hint` (confirm the new metric name passes).
- Bump `partforge`, add the version-floor entry in `AGENTS.md` and
  `docs/agents/viewer-and-sandbox.md`, run `npm run docs:generate && npm run
  prompt:generate`, read the prompt diff.
- MCP prompt (`authoring-mcp*.md`) takes the same table through the generator.

### F. Cloud: evals

Four cases, all `tier: "hard"` unless a pilot run says otherwise. Each prompt names the
angle control (`open`) so the harness can drive it, and none mentions sweeps, collisions
or clearance checking — the point is whether the agent does it unasked.

1. `create/hinged-frame-cover` — the frame, restated: two thin plates, knuckles on the
   long edge, a pin, opens 0–180°. Fails today by knuckles inside the opposite plate.
2. `create/hinged-lid-thick-body` — the AirPods shape, restated without the coal: a
   thick two-half box with a back hinge at the seam, lid opens to 110°. Fails today by
   the lid's back edge passing through the base.
3. `create/detent-hinge` — a lid that clicks at 0° and 90° with a bump of a stated
   height. Passes only if the rub stays within that height and nothing else touches.
4. `modify/hinge-wont-open` — seeded with a reduced copy of the AirPods hinge
   (`evals/seeds/`), user message "the lid can't actually open, the back hits". Tests the
   fix path: read the sweep, move the axis or cut relief.

Grading, per case:

- **Harness-run sweep (gate).** A new grade key runs partforge's own sweep engine on the
  graded part over the named control's full range, regardless of what the part declares,
  with the case's allowance (`0` for cases 1, 2, 4; minus the bump height for 3), and
  gates on no disallowed contact. This replaces sampling a handful of angles with the
  existing `grade.sweep` (which stays for its current users); the builder may implement it
  as an extension of `grade.sweep` or a sibling key, whichever keeps `grade.js` readable.
- **Self-check (scored, not gated).** The tree declares a sweep covering `open` and gates
  `sweepContacts`; `verify.ok` was `true` on the final apply.
- **Controls (scored).** A handle on the lid; `collisions` block present.
- **Static fits (existing expect).** Pin×knuckle clearance band, `overlaps: 0`, process.
- **Judge criteria.** Looks like a hinge that opens; knuckles interleave; nothing added.
- Case 3 runs TWO harness sweeps, because one allowance covers every pair a sweep moves:
  the full range at minus the bump height (gate: nothing presses deeper), and the span
  between the detents (about 20–70°) at `0` (gate: nothing touches off the detents). The
  measured rub depth within ±50% of the stated bump is scored. The same two-sweep shape
  (a `range` each) is what the prompt teaches the agent for a detent.

Seeds and prompts go through the repo's existing fixture rules (`fixtureSlug` is for
integration tests, not evals; eval seeds are plain files).

### G. Proving it

- partforge: unit tests for motion detection (hinge, slide, explode, everything-moves-
  together, single-piece view, print view), coverage by each sweep kind, depth on a known
  interference (two boxes pressed 0.3 mm), `clearance` at −0.3 / 0 / +0.3 on the same
  motion, and the two real forges' reduced hinges as fixtures: both must read CONTACT.
- Cloud: sanitizer tests, prompt tests (ceiling, generated artifacts), eval case unit
  tests against a hand-written passing and failing part for each case.
- One paid eval comparison before merge, Sonnet 5.5 at production settings, the four new
  cases plus the existing hinge cases (`pin-hinge-pair`, `hinged-lattice-box`,
  `laser-box-printed-hinges`, `articulated-figure`, `friction/print-in-place-hinge`,
  `iterate/posable-figure-then-hinges`), old prompt + old partforge against new, n = 3.
  **Scott approves the spend before it runs.** Ship rule: new cases' gate pass rises and
  the existing cases do not regress beyond noise in pass rate, cost or turn length.

## Rollout order

1. partforge PR (A–D) → review → release.
2. Cloud PR (E, F): bump, regenerate, prompt, wire, evals. Stale-tab guard already
   refuses a tab on an older partforge than the docs.
3. Paid eval run, then merge (merge deploys).

Effect on existing forges: none at load. On the next apply to a forge with an unswept
moving piece, `verify.ok` reads `null` with the hint until the agent adds the sweep.
Cached previews, published pages and exports are unaffected.

## Calls I made (not Scott's; check these)

- The withheld verdict needs only a DECLARED sweep; gating on `sweepContacts` is a prompt
  rule. Otherwise the hand reference part and any honest "report only" use would break.
- One allowance per sweep, no per-pair allowance.
- Sweep `clearance` default is unchanged (0.001); `0` is suggested by the hint for seated
  pairs rather than made the default, so existing parts read exactly as before.
- An exploded-view slider is treated as a motion and answered with a one-line sweep,
  rather than adding an opt-out key.
- Handles and animations for a mechanism are prompt rules, not lint findings.
- Eval prompts name the control `open`; they do not ask for verification.
- Four eval cases at `hard`, n = 3, Sonnet 5.5 only for the ship decision.

## Left to the builder

The depth method and its tolerance constant; the exact prompt sentences within the fixed
content; whether the harness sweep is an extension of `grade.sweep` or a sibling; file
layout of new lint/verify code within partforge's existing modules; the detent reference
part's shape; test fixtures.
