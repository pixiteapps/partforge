# Handles follow-ups: findable, precise, and harder for agents to get wrong

Status: design, 2026-11-02. Follows `2026-11-02-generic-handles-design.md` (shipped in 0.179.0).
Source: a design review of the handles system (Fable), and the controller's take on it, which
the user asked to turn into a PR.

## Intent

Handles shipped working, but a review found three gaps between "works" and "useful":

- **Nobody finds them.** Handles show only on hover near them. Touch has no hover at all.
- **Shape handles are imprecise.** A person about to print wants `width: 85`, not "about
  there", and the drag readout is read-only.
- **Agents can make bad handles that lint does not catch**: a handle inert away from the
  defaults, too many handles, a missing `drag`, a pin that silently freezes a gear train.

## Goals

1. **Resting cue.** When posing first goes live on a part with handles, every shown handle's
   dot appears dimmed for 2 s, then fades out. On a touch-only device (no hover:
   `matchMedia("(hover: none)")`), the dimmed dots stay visible until the first drag of any
   handle in that mount, then follow the normal hover rules. The cue never shows in captures.
2. **Editable readout.** After a drag of a generic handle that wrote at least one parameter,
   a small DOM chip stays by the handle for 4 s showing the readout values. Clicking (or
   tapping) the chip turns it into one number input per readout parameter. Enter or blur
   writes the typed values through the same path as a slider (clamped and snapped like a
   slider, wrapped params stored in the same turn), as one commit. Escape cancels. The chip
   uses partforge's own chrome styles and sits inside the stage.
3. **Pin hint.** When a generic-handle drag ends having written nothing because a pin held it
   (the solve moved no parameter while a pin was active), the readout chip shows "Held by a
   pin — Release pins to move it" for 3 s instead of values.
4. **Lint, wider net.**
   - `handle-inert` also samples each listed parameter at 0%, 25%, 50%, 75% and 100% of its
     range (other params at defaults), and warns when the point does not move at any sample,
     naming the value: "inert at drawerOpen = 0".
   - New warning `handle-crowded`: more than 5 handles in a view without `showOn`.
   - `drag` is required: `handle-bad-drag` errors when a handle has no `drag`. The runtime
     default stays `"point"` so an unlinted part still works.
5. **Guide.** The authoring guide's Handles section says: prefer motion handles; add a shape
   handle only for a dimension a user would naturally drag, and give its parameters
   nice-number steps (1 mm, not 0.1); motion handles' parameters must never change the export
   pose (a moved drawer prints closed). Fix the contradiction that told every handle to use a
   fine step: fine steps are for motion and IK parameters.

## Non-goals

- A runtime export warning. Exports use each sub-part's export pose, and a well-written part's
  export pose ignores motion parameters (drawer-box already does). The guide rule (goal 5)
  covers it; a lint for it would need geometry.
- Dropping the `plane` drag kind. The drawer-box corner needs it (two parameters in one drag).
- Changing limb (goal/angles) behaviour beyond the resting cue.

## Anti-goals

- A cue that nags: it must not reappear on every param change or view switch, only once per
  mount (and on touch, until the first drag).
- Any change to the robot arm's or hand's drag behaviour.

## Constraints

- Pose-mode code layering as today: pure helpers stay pure; three.js only in pose-scene and
  pose-mode; DOM chrome follows how `pose-controls.js` and other viewbar chrome add elements.
- The viewer draws on demand: overlay edits call `viewer.requestRender()`.
- Every existing `test/pose-*.test.js` and `scripts/check-pose.mjs` stays green.
- Version bump 0.179.0 → 0.180.0 in the PR.

## Left to the builder

The chip's exact look and placement; the cue's fade curve; how the chip finds the handle's
screen point (reuse `handlePoints()`); message copy beyond what is fixed above.
