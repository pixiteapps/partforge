# Collisions: solid pieces in Pose mode, and swept motion for the agent

Status: design, 2026-11-02. Builds on the inverse-kinematics design
(`2026-10-30-inverse-kinematics-design.md`) and generic handles
(`2026-11-02-generic-handles-design.md`).

## Why

Posing the hand, a finger curled straight through the palm. Nothing stopped it:
the solver knows joint ranges and nothing else, and the overlap checks partforge
already has (`assemblyOverlaps` in `src/framework/assembly.js`, `meshGaps` in
`src/framework/oracle/gaps.js`) run on ONE pose — the default — in `measure`/
`verify`, never during a drag. Every reference part that moves (hand, robot arm,
drawer box, gearbox) declares `overlaps: 0`, and that promise holds only at rest.

The agent that writes parts has the same blind spot. It cannot learn that a drawer
is clear over its whole travel, or that a hinge hits its neighbour at 112°, except
by trying poses one at a time.

## What success looks like

- Dragging a fingertip into the palm: the finger comes to rest against the palm and
  the rest of the chain keeps solving, so the finger slides along the surface
  toward the target rather than locking up. It never passes through.
- The agent can declare a motion (a parameter's range, a handle, an animation) and
  `measure`/`verify` report whether it stays clear the whole way, the tightest
  clearance along it, and where first contact happens — for rotation and linear
  motion alike.
- A hinge's limit is the author's choice: write a range as today, or leave the
  range wide and let collision stop the joint. The sweep report gives the contact
  angle either way, so the agent can write a range from a real number.

## Goals

1. **Collision inside the IK solve (Pose mode).** Every drag kind that solves
   (`angles`, `goal`, and the generic `point`/`axis`/`plane`/`rotary` solves in
   `pose/param-solve.js`) keeps blocked pairs apart.
2. **Hard guarantee.** Whatever the solver returns, a drag frame never moves a
   blocked pair from clear to overlapping. If the solve ends inside, the frame
   backs off toward the last clear values (bisection) and lands at contact.
3. **Sweeps for the agent.** A declared motion is stepped from end to end, with
   steps sized by how far the fastest-moving point travels, so nothing skips
   through the clearance. Rigid motion (pieces moved by `place()`) is fast.
   Shape-changing parameters are allowed and work, but run a rebuild per step;
   lint and the report warn the author that they are slower.
4. **Allowed contact.** The author marks pairs that touch on purpose — a detented
   hinge, a snap, a bearing face. Those pairs never block a drag and never fail a
   sweep or the overlap gate. Every other pair must keep clear.
5. **Hinge limits from collision, by choice.** Nothing changes for a joint whose
   author writes a range. A joint left wide is stopped by collision in Pose mode,
   and the sweep report names the contact-free interval around its rest value.

## Non-goals

- Physics: no forces, friction, stacking or settling.
- Panel sliders are not clamped by collision. A slider can still push a finger into
  the palm; `verify`/the sweep report flag it. (My call — see "Calls made".)
- Collision during a shape-changing drag (e.g. the drawer box's corner handle
  resizing the cabinet). Pose-mode blocking covers rigid pieces only.
- Sub-parts the viewer cannot move by matrix (posed deliveries, where the worker
  baked `place()` into the mesh) are not checked during a drag; they are still
  checked by sweeps, which build them.
- Continuous (swept-volume) collision math. Stepping with a travel bound gives the
  same guarantee for our motions at far less complexity.

## Anti-goals (a failure even if it technically works)

- A drag that stutters or drops frames on the hand. If collision in the solver
  cannot hold the budget below, we fall back (see "Fallback").
- A pose that starts overlapping (a preset, an old saved pose) and then cannot be
  moved at all. Blocking is "can move out, cannot move in".
- A detented hinge or a pin joint at its 0.3 mm running clearance reading as a
  collision.
- Any change to verdicts of existing parts that declare nothing new
  (`test/verify-golden.test.js` stays byte-identical unless a part opts in).

## Constraints from the codebase

- The solver is `solve/dls.js`'s `solveDLS`: damped least squares over a residual
  vector, central-difference Jacobian (2n residual evaluations per iteration), an
  active-set step for bounds. `param-solve.js` wraps it per drag kind; residuals
  are millimetres of point miss. Collision terms must be millimetres too so they
  weigh against the target and holds on the same footing.
- Residual evaluation today is `resolveParams` (derive) then a point lookup. To
  know where pieces are, an evaluation also needs each sub-part's placement
  matrix at those params — the same thing the pose ladder's rung 1 computes
  (`pose-fast-path.js`, `probePoses(..., { scope: "place" })`, `geometry/pose.js`).
  Reuse that path; do not invent a second placement model.
- `bvh.js`'s `distanceTo` is exact and early-exits at 0 (touching or inside), so it
  gives no penetration depth. The design never needs one: blocked pairs are kept
  from entering, and the penalty starts before contact (below).
- The BVH needs a query between two indexes under a relative transform, so each
  piece is indexed ONCE in its own mesh frame and moved by matrix — never
  re-indexed per frame. That is new code in `bvh.js`. The native core
  (`native/`, `core-wasm.js`) holds `bvh.js` bit-identical by contract
  (`test/core-parity.test.js`); a new query either gets its C++ twin in the same PR
  or stays JS-only and is reached only through the JS index (`jsIndex()`), as
  `distanceTo` already does for core indexes. Builder decides which; JS-only first
  is acceptable.
- Pose mode runs on the main thread, on meshes the viewer already holds. The
  oracle modules are DOM-free and three-free, so the BVH code can run there.
  Building indexes should happen off the drag's critical path (when Pose mode
  becomes live or a delivery lands, in idle time), the way measure mode builds its
  index.
- Sweeps run where `measure` runs (worker `inspect` job, CLI) and must stay
  DOM-free, three-free, node-free (`test/worker-layering.test.js`).
- Lint must not import the BVH or the embedded WebAssembly: `pairKey` and
  `CONTACT_EPS` move to an import-free leaf that `oracle/gaps.js` re-exports.
- Pair names use the existing `pairKey` (`"a×b"`, order-insensitive) from
  `oracle/gaps.js`, as `verify`'s `clearance` expectation already does.

## How it works

### The collision model (shared)

One pure module, used by Pose mode and by sweeps:

- Input: the sub-parts in the view, each with a mesh in its own frame and a
  function from params to its placement matrix; the part's collision declaration.
- Pairs considered: every pair of sub-parts in the view, minus allowed pairs,
  minus pairs where neither piece moves under the params in play (nothing to
  check). Broad phase by bounding boxes grown by the margin.
- Per pair: exact minimum distance under the two matrices.
- Output: per pair `{ a, b, distance, at }`.

A **blocked pair** is one that is not allowed. It is clear when its distance is
above `clearance` (default `CONTACT_EPS`, 1e-3 mm — so a pin joint at 0.3 mm is
clear). A pair that is already within clearance when a drag starts is exempt for
that drag until it opens past clearance once (can move out, cannot move in).

### Pose mode: collision in the solver

(Revised after review, 2026-11-02. The first draft re-queried the BVH and re-probed
every placement on every residual evaluation, with rows fixed at drag begin for
every pair the handle's range could reach — about 100 evaluations a frame on the
hand, and up to ~190 rows, so it could not hold the frame budget.)

**Rows are chosen per frame, not per drag.** At the start of each drag frame the
guard runs a broad phase at the frame's start params with slack (band plus the
last frame's travel) and keeps at most `MAX_ROWS` (8) blocked pairs, nearest
first. The solve's residual vector is target + holds + those rows, so the DLS's
m×m system stays small (3–11 rows on the hand).

**Contact is linearised once per solver iteration.** At the start of each DLS
iteration (a new `onIteration(x)` hook in `solve/dls.js`; with no hook the solve
is bit-identical to today) the guard runs the exact BVH query for each row's pair
once, and stores each pair's closest points and separating normal in their own
mesh frames. Between iterations, a row is evaluated from placement matrices alone:

    r = w · max(0, margin − n · (M_a·p_a − M_b·p_b))

This is cheap, it is smooth (so the finite-difference Jacobian is meaningful and
the finger slides along the surface instead of chattering), and it is the
standard way contact constraints enter an IK solve. Placements come from
`probeSubPartPose(sp, { p, d }, { scope: "place" })` on the `(p, d)` the
evaluation already resolved — never `probePoses`, which runs derive again.

The band (start at 2 mm, tuned on the hand) gives the Jacobian a slope before
contact, so the solver turns the chain away early. `w` starts at the hold
weights' scale (`HOLD_WEIGHTS` in `param-solve.js`).

**Pairs that always sit inside the band get no rows.** Pinned neighbours (the
hand's pin joints at ~0.4 mm), a drawer in its carcass (1 mm) and meshing gears
are always closer than the band, and they cannot be put in `allow`: the finger
link and the palm are a pin pair and also the pair that collided. A capped band
does not save them, because faceted bosses and slots make the running distance
wobble by a few hundredths of a millimetre as the joint turns, and every dip
would read as a push the same size as the target. So a pair whose distance at
drag start is below the band gets no solver row at all. It is guard-only: the
hard guarantee below still stops it at contact. A drag in open air therefore
solves exactly as it does today.

Within a solve, a row for a pair already inside clearance saturates at
`w · margin`. Steps are never rejected inside the DLS, because a rejected
evaluation would poison the Jacobian columns near contact.

**The hard guarantee.** After the solve, the frame goes from the last clear values
to the solved ones through `settle`:
- It is sub-stepped so no point of a moving piece travels more than `BAND / 2`
  between checks. That bound assumes pieces are thicker than the band; state the
  assumption in the guide. Sub-steps are capped at `MAX_SUBSTEPS` (32) per frame.
  A flick that needs more stops at the last checked clear step, and the drag
  catches up on the next frame (the drag lags the cursor rather than tunnelling).
- At the first sub-step that is not clear, it bisects back to contact.
- The path between the two ends is a `blend(t) → params` the caller supplies.
  Angles and generic drags blend their params linearly. Goal drags blend in
  joint space, through `solveGoalPinned`'s own `at01(t)` and `goalFromForward`,
  so each checked point is the pose derive will reproduce. Interpolating goal
  params would let derive's goal solve jump to another arm shape between checks.

**Wholly inside at drag start.** Distance is unsigned, so a piece wholly inside
another reads as clear. It would not be exempted at begin, and its first move
across a surface would read 0 and be blocked forever. So at `begin` only, for
pairs whose boxes overlap, one ray-parity test (bvh.js's `raycast`) from a vertex
of A against B finds those pairs and exempts them. That is once per drag, never
per frame.

A pair inside clearance at begin (a preset, a saved pose) is exempt until it
opens past clearance once: it can move out, never further in.

Locks, pins (holds) and seeds behave as today. Collision is one more set of
residual rows beside them. Joint rings (`jointRingValues`, forward kinematics)
bypass the solver but go through the same `apply`, so they get `settle`: a ring
turned into the palm stops at it.

**Goal-mode drags (the robot arm) slide too.** Today an unpinned goal drag never
reaches the DLS. Pose mode writes the goal params (`goalValues`), and the limb's
own goal solve in `derive` (`limb.pose({ goals })`) poses the arm. Collision does
not go into `derive`: it is pure, has no meshes, and also runs for sliders,
builds and the worker. Instead, for a part with a `collisions` block:
- In open air (no blocked pair within band of the arm), the goal drag writes the
  goal directly, as today. The user can still drag the goal out of reach, and the
  `tool` probe still reads "missed by".
- Once a pair comes within band, that frame and the following ones switch to
  Pose mode's own solve: the seed (joint) params are the variables, the tool
  target is the residual, the collision rows sit beside it (the path
  `solveGoalPinned` takes), and the result is written back as goal params through
  `goalFromForward`. The stored goal is then the pose on screen, and derive
  reproduces it.
- It switches back to direct writes once the arm is clear of the band again.

(Decided: the arm slides like the hand. The open-air switch is my call, made to
keep out-of-reach drags working.) In the pinned path, placements need
`resolveParams` on the written values, which runs derive's goal solve per
evaluation. Linearisation keeps that to once per iteration, and the bench reports
the arm's derives per frame. A part with no `collisions` block keeps today's goal
drag unchanged.

**What the user sees when blocked.** When a drag ends with a pair at contact,
`onDragEnd` gains `blocked: { a, b }`. The release chip shows "Stopped at <b's
label>" for `CHIP_MS`, the same slot `PIN_HINT` uses. While a drag is held at
contact, the contacted pair gets the existing feature-highlight tint. Both tell
the agent's `check-pose` what happened too.

**Indexing happens in idle time.** BVHs are built in `requestIdleCallback` after
each delivery once Pose mode is live on a part with collisions, including
transient mid-drag deliveries (`cycleTransient`) on a cheap part. A drag that
begins before the index is ready runs the hard guarantee only, for pieces already
indexed.

### Fallback: stop at contact

If collision inside the solver cannot hold the budget, Pose mode keeps the solver
as it is and applies only the hard guarantee (solve, then bisect back to contact).
The finger stops dead rather than sliding, but never passes through. The
two share all the collision code; the switch is internal, not a part option.

Budget: measure the hand's drag with `npm run bench:pose` before and after.
In-solver collision ships if the hand's p95 frame stays under 16 ms and no more
than 1.5× today's p95 on the same machine. Note that the `tol` early exit never
fires while a row is non-zero, so a frame resting against contact runs all its
iterations; the bench must include such a drag. (My call — see "Calls made".)

### Sweeps

A sweep is a declared motion stepped end to end:

- **A parameter**: from its schema `min` to `max` (or a given sub-range).
- **A handle**: each of its listed params on its own, min to max, with the others
  held at their current values; the report has one row per param, each with its
  own `freeRange`. No straight line through every param at once, no grid. A
  goal-mode handle is not sweepable (its params are a target, not a motion);
  sweep its joint params, a path or an animation instead. (My call.)
- **A path**: several params moving together, which is where coupled mechanisms
  and the hand's real contacts live (the thumb against curled fingers depends on
  both). `{ from: "open", to: "fist" }` names presets; `{ path: [{…params},
  {…params}, …] }` gives waypoints, blended linearly between them. This is the
  same engine as an animation sweep, without needing a visible animation, and it
  is what an agent reaches for first on a four-bar, a multi-axis arm or a lid
  closing over a latch. (Added after review.)
- **An animation**: its timeline, start to end, through the same sampling the
  player uses.

Each sweep may give `clearance` (mm, default `collisions.clearance`), and then
`clear` means "never closer than this along the motion". A print needs running
clearance, not just non-contact, and authors already write
`clearance: { "a×b": ">=0.3" }` for the static pose. Each sweep may also give
`views`. By default a sweep runs in every view where its target moves something;
a view where nothing moves gets no row, so the hand's print kit reports no
sweeps.

Sweeps run once per `measure` call that asks for them. `verify` passes
`sweeps: false` to the per-case re-measures (as it passes `probes: false`), so
presets do not re-run every sweep. Their time comes out of the same
report deadline change tracking uses (`changes.js`'s pattern, counted from the
inspect's start). They do not get a separate budget, because the cloud's 8 s
inspect already gives 6 s of its time to change tracking.

Step size: each step moves no point of any moving piece more than half the
clearance-band (bounded from the pieces' bounding boxes and the placement change
between steps; bisect a step that moves too far). This is what makes rotation and
sliding equally safe: the bound is in millimetres of travel, not degrees or
parameter units.

Rigid motion (only `place()` changes) reuses one build per sub-part and moves it by
matrix: fast. A parameter that changes a build rebuilds the affected sub-parts per
step: correct, slower, coarser steps allowed with a step cap. Lint
(`sweep-rebuilds`, a warning) and the sweep report (`rebuilds: true`, step count,
time) say so.

The report, per sweep:

- `clear`: no blocked pair came closer than the sweep's clearance anywhere.
- For each contact, the joint or param that was moving fastest at first contact
  (the largest share of the pair's closing speed), so the agent knows which
  limit or placement to change.
- `minClearance`: the tightest blocked-pair distance and where (param value,
  pair, location).
- `contacts`: each interval of the motion where a blocked pair is in contact,
  with its first value, the pair and the location.
- For a single-parameter sweep, `freeRange`: the contact-free interval around the
  parameter's current value — the suggested joint limit.
- `skipped`/`timeout` when it stopped short, like `changesSkipped`.

### Declaring it

A sketch the builder may refine (the shape, not the spelling, is decided):

    collisions: {
      clearance: 0.1,                       // optional, mm; default CONTACT_EPS
      allow: ["palm×indexProximal"],        // pairs that may touch (detents, snaps)
      pose: true,                           // Pose mode blocks blocked pairs (default: true once the block exists)
    },
    verify: {
      sweeps: {
        indexCurl: { param: "indexCurl" },
        drawer1:   { handle: "drawer1" },
        spin:      { animation: "spin" },
        fist:      { from: "open", to: "fist", clearance: 0.3 },
      },
      expect: { _view: { overlaps: 0, sweeps: "clear" } },
    }

- A part with no `collisions` block behaves exactly as today in Pose mode (no
  blocking), so no existing part changes until it opts in. (My call.)
- `allow` also exempts those pairs from the static `overlaps` gate, which today
  would fail a detented hinge.
- A joint whose author wants collision to set its limit leaves its range wide;
  nothing more to declare.
- Lint checks: unknown sub-part names in `allow`; unknown param/handle/animation in
  a sweep; `sweep-rebuilds` (above).

### Where the agent sees it

- `measure` reports `sweeps[]`; the CLI prints one line per sweep (clear, min
  clearance, first contact, free range).
- `verify` gains a `sweeps` gate metric (registered in `verify-metrics.js` as
  `kind: "gate"`) that fails on a blocked contact.
- `docs/AUTHORING-PARTS.md` and `docs/domains/kinematics.md` get the declaration,
  the allowed-contact rule and the "range or collision" choice for hinges.

### Reference parts

- `hand.js`: opts in (`collisions`; the pin-joint pairs stay BLOCKED and read
  clear through the default clearance and the start-capped band), declares a
  knuckle and a curl sweep per digit, REPORTED, not gated: its joints keep their
  wide ranges and use collision as their limit, so a full-range curl is expected
  to meet the palm, and the sweep's `freeRange` is the reading that matters. Its
  `expect` does not include `sweeps`. Presets keep passing the existing
  `overlaps` gate (verify already runs it on every preset). Its
  `scripts/check-pose.mjs` drag adds a case that pushes a fingertip into the palm
  and asserts it stops at the surface.
- `robot-arm.js`: opts in, so a tool drag into its own base or turret slides
  along it; its `check-pose.mjs` case adds that drag.
- `drawer-box.js`: declares a sweep per drawer handle.
- `gearbox.js`: declares its `spin` animation as a sweep. Faceted involutes mesh
  at about 0.1 mm of backlash and can touch at some angles, so the meshing pairs go
  in `allow`, and the sweep gates the gears against the housing and axles.
- Adding sweeps to these parts changes their verify output, so the task that adds
  them re-records `test/verify-golden.test.js`
  (`PARTFORGE_RECORD_VERIFY_GOLDEN=1`) and reads the diff. Parts that declare
  nothing stay byte-identical.

## Later (not in this round)

- Per-pair clearance in `collisions.clearance`.
- Snap fits with an allowed interference depth. Today `allow` turns the check off
  for a pair entirely.
- A lint note (`collisions-missing`) on a part with handles or limbs and no
  `collisions` block, so an agent discovers the feature.
- A C++ twin for the transformed BVH query, once the JS path is measured.
- Sweeping a goal handle over a workspace (a region of targets, not a line).

## Left to the builder

- The exact declaration spelling and where `collisions` lives (top level vs
  inside `verify`), within the shape above.
- The band and weight values, tuned on the hand.
- Whether the transformed BVH query gets a C++ twin now or stays JS-only.
- How sweeps share work with `measure`'s memo, if at all (a sweep row is new
  input and may simply never be memoized, as domain facts are not).
- Sweep time budget, following `REPORT_SHARE_MS`'s pattern.

## Calls made (not discussed; check these)

- Panel sliders are not blocked by collision; only Pose mode drags are.
- Opt-in per part: no `collisions` block, no Pose-mode blocking.
- `allow` also lifts the static `overlaps` gate for those pairs.
- Default clearance is `CONTACT_EPS` (1e-3 mm), so running clearances read clear.
- Performance bar for keeping collision in the solver: hand p95 < 16 ms and
  ≤ 1.5× today's p95.
- A pose that starts overlapping can always move out.
- Shape-changing drags in Pose mode are not collision-checked; sweeps cover them.
- Drag frames are sub-stepped by a travel bound (`BAND / 2`, at most 32 a frame;
  the drag lags rather than tunnels), plus one ray-parity inside test per pair at
  drag begin.
- Solver rows are chosen per frame (at most 8, nearest first) and linearised once
  per solver iteration.
- A multi-param handle sweep is one sweep per param; goal handles are not swept.
- The hand's sweeps are reported, not gated; drawers and gearbox gate on them.
- Goal drags switch to Pose mode's own solve only for parts with a `collisions`
  block, and only while a pair is within band; in open air they write the goal
  directly as today, so out-of-reach drags still work.
- Pairs closer than the band at drag start get no solver row (guard-only).
- A blocked drag says so: "Stopped at <part>" on the release chip, plus a tint
  while held.
- Sweeps gain paths (presets or waypoints), a per-sweep clearance and per-view
  scoping; the gearbox allows its meshing pairs.
