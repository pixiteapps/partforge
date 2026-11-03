# Handles for limbs: joint ranges, mid-joint grabs, groups, drag tests

Status: design, 2026-11-02. Follows `2026-11-02-handles-ux-followups-design.md` (0.180.0).
Source: feedback from the first agent adopting the 0.179 handles API, and the user's own
use of the robot arm. The user asked to go ahead without questions; the calls below marked
"builder's call" are the controller's.

Dropped by the user: optional readouts (the bottom readout slot settled it) and the older
limb visuals / limit arcs.

## Goals

1. **A drag stops at a joint's limit.** An `angles` handle's DOF that its `joints` map
   drives is bounded by that joint's own range, not only by its slider's range: a hinge
   `{ param, scale }` by `range / scale` (bounds ordered for a negative scale), a ball's
   bend and spread by `±cone`, intersected with the schema range. Today a solve step can
   push the param past the limb's clamp; there the pose stops changing, the Jacobian
   column is zero, and the drag sticks — it cannot even bring the joint back. Joint rings
   in angles mode clamp the same way. New lint WARNING `handle-joint-range`: an `angles`
   handle's `joints` entry whose param's slider range reaches past its joint's range
   (scaled) — the slider moves where the joint cannot follow. Needs the posed limb at the
   defaults (skip silently when derive throws).
2. **Grab a goal limb by a middle joint.** On a `drag: "goal"` handle, every joint dot
   whose joint has a seeded (driven) joint above it in the chain is a grab, not ring-only.
   Its rings still show on hover, as an angles limb's joints do today. Dragging it solves
   the seed joints so THAT joint's origin follows the pointer (`solveGoalPinned` gains
   `grab`, default the handle's `at`; joints below the grab do not move the grab point, so
   they stay as they were and the tool rides along rigidly), then writes what a joint ring
   writes: every seed param, and the goal params at the new tool frame (so derive's goal
   solve lands on the same pose). Pins on the limb hold as they do for a pinned goal drag.
   The miss line starts at the grabbed joint (already so). The `at` dot keeps today's
   behaviour exactly.
3. **Handle groups.** Any handle may carry `group: "<name>"`. Within one group:
   - On hover, when more than one handle of the group would show, only the one whose
     nearest dot (or arrow) is nearest the pointer on screen shows its dots and can be grabbed;
     the others stay hidden until the pointer is nearer them.
   - The resting cue shows one mark per group: the first-declared handle of the group
     that the view shows (builder's call: the first, not a centroid, so the mark sits on
     something grabbable).
   - `handle-crowded` counts a group as one handle. `group` that is not a non-empty string
     is a lint ERROR `handle-bad-group`. `measure().handles` entries carry `group` when set.
   - Handles with no group behave exactly as today.
4. **Test a drag without a browser.** `dragHandle(part, { handle, to, turn, grab, params,
   view, steps })` in a new `src/framework/oracle/drag.js`, exported from
   `partforge/oracle` (and so `partforge/testing`). Derive only — no kernel. It plays the
   drag the way Pose mode would, with no pins: from the handle's current point to the
   target in `steps` (default 12) evenly spaced frames, each solved warm from the last
   frame's params through pose-session's `defaultSolve`, then snapped on release
   (`snapValues`). Targets: `point`/`goal`/`angles` take `to` ([x, y, z]); `axis` projects
   `to` onto its axis line, `plane` onto its plane; `rotary` takes `turn` (degrees about its
   axis, signed by the axis's right-hand rule, accumulated across frames so 720 is two
   turns). `angles`/`goal` take an optional `grab` (a joint name, or "tip"; default the
   handle's grab point). Returns `{ handle, drag, grab, from, target, reached, missMm,
   values }` — `values` the snapped params that changed, `reached` the grab point after
   the release, `missMm` its distance from the target (rotary: the arc miss at the grab
   radius). A bad request (unknown handle, missing `to`/`turn`, a handle the view does not
   show) returns `{ handle, error }`, never throws. A solve that fails returns `error` too.
   CLI: `partforge measure <part> [view] --drag <id> (--to x,y,z | --turn deg) [--grab
   <joint>] [--params json] [--json]` prints that result instead of measuring (no kernel
   boot, no verify), exit 1 only on `error`. The guide's Handles section tells agents to
   use it to check a handle's sign and reach.

## Non-goals

- Readout opt-in, limb visuals, limit arcs (dropped by the user).
- Changing generic (`point`/`axis`/`plane`/`rotary`) handles' solve beyond groups.
- Bounding params a limb reads through `derive` arithmetic the handle does not declare in
  `joints` (no mapping to read); the lint covers the declared ones.

## Anti-goals

- Any change to the hand's or arm's existing `at`-dot / tip behaviour or feel.
- A drag test that boots a kernel or needs a browser.

## Constraints

- Pose-mode layering as today: param-solve, pose-session, handle-source, drag-kinds pure;
  three.js only in pose-scene / pose-mode. `oracle/drag.js` DOM-free, three-free,
  node:-free (worker layering test).
- Every existing `test/pose-*.test.js`, `scripts/check-pose.mjs` and the verify golden stay
  green. `npm run lint`, `npm run lint:dead`, `npm run typecheck` clean.
- Types: `group` in `types/part.d.ts`; `dragHandle` in the oracle types.
- Docs: `docs/AUTHORING-PARTS.md` Handles (groups, joint ranges, testing a drag),
  `docs/domains/kinematics.md` (grabbing a goal limb mid-chain), AGENTS.md's Pose-mode
  paragraph, the CLI usage line.
- Version bump 0.180.0 → 0.181.0 in the PR.
