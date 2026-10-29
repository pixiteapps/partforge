# Measure mode redesign

Date: 2026-10-28. Status: for Scott's approval (both open questions answered
2026-10-29).

Where the work lands: almost all of it is in the **partforge** package
(`src/framework/measure/`), released as a partforge minor version, followed by
a version-floor bump in partforge-cloud. This document lives in the cloud repo
because that is where the brainstorm happened; move it to partforge's
`docs/superpowers/specs/` if that is where its plan will be written.

## Why

Scott wanted the size of one feature on a part. Three things went wrong:

1. **Slow.** Getting a reading took several clicks, and each took noticeably
   long.
2. **Too much.** One click drew many dimensions at once, so the one he wanted
   was hard to find.
3. **Broken drawing.** Some dimensions were placed off the part's canonical
   planes, and their extension lines were not parallel to each other.

Today's mode hovers a feature, draws every dimension the feature classifier
finds for it, and pins them on click (`measure-mode.js` → `feature-dims.js`
→ `dim3-place.js`). Which dimensions appear depends on what the classifier
finds, which will vary more as parts get more complex. Scott does not want to
tune that set. He wants a different interaction: the snapping two-click model
from cadgang (github.com/cheewee2000/cadgang).

**Success:** you point at the thing you care about and get its one number in
one click, or the distance between two things in two clicks. Every dimension
on screen is drawn cleanly, on the part's axes.

## The interaction (decided with Scott)

### Entering the mode

- The overall size (width × depth × height) shows at once, as it does today.
- It is drawn on the part's own axes with parallel extension lines. The
  broken-drawing bug must not happen here.
- These dims stay up the whole time the mode is on. Clicks and Clear never
  remove them.

### Hover (desktop)

- The pointer highlights the nearest thing a click would grab, with a short
  label naming it (for example "hole edge · centre").
- Snap targets, in this order: corner (vertex), edge midpoint, circle or arc
  centre, edge, face.
- Hover draws no dimension. It shows only what a click would grab. This is the
  fix for "too much".

### First click: the one most relevant reading

One number for what you clicked:

| Clicked | Reading |
| --- | --- |
| Circular edge or full cylinder | ⌀ |
| Partial arc or fillet face | R |
| Straight edge | its length |
| Flat face | its outer size, W × H, on the face's own axes; holes and cutouts are ignored |
| Corner, midpoint or centre point | no reading; the point becomes the start of a distance |

Every click also sets the first point for a distance: the snap point it
grabbed. A circle snaps to its centre. A face snaps to the point clicked on it.

### Second click: a distance from the first point

- Distance from the first point to the second snap.
- **Axis-aligned by default**: the dimension is drawn along the one part axis
  with the largest separation, or along each axis that separates the points.
  Which of those two is the builder's call (see below).
- **Shift held: straight-line** (true 3D) distance.
- If both clicks are on parallel flat faces, the reading is the gap between
  the faces. This is my guess at the right behaviour, not something Scott
  confirmed.

### Clearing

- A **third click** starts a new measurement. The old reading and distance go
  away, and that click becomes a new first click.
- The **Clear** button (already in the measure controls) clears every reading.
  The overall dims stay.
- Leaving the mode clears readings too. *My call:* this differs from today,
  where pins survive mode toggles. The new model holds at most one reading and
  one distance, so keeping them would add little.
- **A rebuild clears readings** (Scott). When a slider move or an agent apply
  rebuilds the part, the current reading and distance go away. The overall
  dims redraw for the new part. Readings do not follow the geometry live.
  This changes two published things, and the release notes must say so:
  - The docs promise that a pin "tracks parameter changes live". Remove that
    line.
  - The runtime handle (`pinCount`, `clearPins`, `onPinsChange`) must keep
    working, so the cloud app does not break. `pinCount` reports 0 or 1 or 2
    (a reading, a distance), `clearPins` is the Clear button, and
    `onPinsChange` fires on each change, including a clear on rebuild.

### What can be measured (Scott)

- **Named features** (those an author tagged with `.label()`) get everything
  above: edge, circle, arc, face and centre snaps, and a first-click reading.
- **Everything else gets corners only.** On unnamed geometry the snap targets
  are the corners of the mesh's drawn edges and the point clicked on a face.
  A first click there gives **no reading**; it only sets the start point of a
  distance. The second click works the same on named and unnamed geometry.
- *My call:* the hover label on unnamed geometry says only "corner" or
  "point", so it never promises a reading the click will not give.
- Not in scope: working out faces and edges from the raw mesh, or asking the
  geometry engine for them. That would be a separate, larger project.

### Touch (phone and tablet)

Scott uses measure mostly on desktop, so this is the secondary path. It should
work, but desktop gets the polish first.

- There is no hover. A tap shows the snap it would grab, with its label. A
  second tap on the same spot, or a drag to adjust and then a lift, commits
  it. This stops a fat finger from committing to the wrong corner.
- There is no Shift. A small **straight-line toggle** sits beside Clear and
  mm/in.

### Param flash

- Today a reading whose value matches a part setting flashes that setting in
  the panel (`param-link.js`, `paramMatches`).
- Keep it for the **first-click reading only**. Distances do not flash.
- Scott: "keep the flash unless it adds a lot of complexity." It reuses the
  existing function, so it should be cheap. If it becomes costly, drop it and
  say so.

## Drawing rules

These fix complaint 3 and apply to every dimension the mode draws:

- Dimension lines lie in a plane that contains one of the part's axes.
  Extension lines are parallel to each other and perpendicular to the
  dimension line.
- A diameter or radius is drawn across or from the circle's centre, in the
  circle's own plane, with a leader to its label.
- A face's W × H reading is drawn in the face's plane, along its two in-plane
  part axes. A face that is not axis-aligned uses its own edge directions.
- Labels never overlap one another. The existing lane and side-choice logic in
  `dim3-place.js` may be reused where it already meets these rules.

## Settled after the builder check (my calls)

- **Frames.** A reading on one sub-part is drawn on that sub-part's own axes,
  so a posed or rotated sub-part still gets square dims. A distance between two
  sub-parts uses the shared parts frame. This applies both to axis-aligned
  measurement and to drawing.
- **Snaps on curves.** A curved edge's tessellation vertices are never corner
  snaps. Pointing near a hole rim highlights the rim itself, labelled with its
  reading and its snap point ("hole edge · centre"). The highlight is always
  exactly what the click gets.
- **Speed.** "Slow" covers both hover and click, so the builder profiles both
  on a large real part before choosing a design. Snap candidates and readings
  are computed once per geometry and cached. The target is that hover and
  click both respond within one frame of input on a typical part.
- **Broken drawing.** Scott does not remember which part showed it. The
  builder finds a reproduction first, by trying rotated sub-parts,
  non-axis-aligned faces and cylinder ⌀ dims. The regression test pins
  whatever case is found.

## Goals

- One click shows one reading. Two clicks show one distance.
- A snap highlight, before you click, tells you what you will get.
- Every dimension is drawn on a canonical plane with parallel extension lines.
- Hover and click feel immediate on a typical part.
- The overall size shows on entry, as it does today.

## Non-goals

- **Sending measurements to the agent.** This was in the original ask and has
  been dropped: "I'm not sure how useful that is unless there is a very clear
  use case." The chip and prompt-locator paths are untouched.
- Saved or named measurements, more than one distance at a time, angle
  measurement, and measurement exports.
- Readings that follow the part through a rebuild.
- Readings on unnamed geometry (faces and edges recovered from the mesh).
- Any change to sketch mode or the selection popover.

## Anti-goals (a failure even if it works)

- One click that still produces a cluster of dimensions.
- A dimension drawn skewed off the part's axes, or with converging extension
  lines.
- Hover that redraws dimensions on every pointer move, which is what made the
  old mode slow.
- Snaps that pick something other than what is highlighted.

## Constraints

- partforge is a published package. Release as a minor version with a
  changelog entry. The version bump rides with the PR.
- partforge-cloud pins version floors (see AGENTS.md "Viewer + sandbox"). The
  cloud bump adds a floor entry that states what degrades below it. Below the
  floor the old measure mode still works, so nothing errors.
- Phones are memory-tight. Hover must not scan the whole mesh per pointer move.
  Snap candidates for a feature are computed once and cached, as `specCache`
  does today.
- The mode already rides the pivot, pose fast path and animations by
  parenting dims under the meshes' group. Keep that.
- Units toggle (mm/in) and the Clear button already exist in
  `measure-controls.js` and keep working.

## Left to the builder

- **How snaps are found.** Screen-space search over projected candidate points
  (cadgang's approach), or a raycast followed by a search of the hit feature's
  edges. The builder can choose, within the hover-cost constraint.
- **Snap radius** in screen pixels, and how ties between nearby candidates
  break.
- **Axis-aligned distance:** one dimension along the dominant axis, or one per
  separating axis (up to three). Pick whichever reads cleaner on real parts and
  say which.
- How much of `dim3-place.js` and `pins.js` survives. Readings clear on
  rebuild, so the pin store's live tracking can go. Keep only what the
  runtime handle above needs.
- The exact snap label wording, and the visual style of the snap marker,
  matched to the existing feature highlight.
- Tests. At minimum: snap ranking, first-click reading per feature type, the
  axis-aligned and straight-line distance maths, and a regression test that
  extension lines come out parallel for the case that broke.
