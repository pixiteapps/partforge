# View style popover — design

Date: 2026-09-24. Follows the realistic rendering mode (partforge #222, spec in
partforge-cloud `docs/superpowers/specs/2026-09-24-realistic-rendering-mode-design.md`).

## Revisions (read these first)

The sections below are the design as first written and are kept for history.
Three things changed before it shipped:

- **2026-09-24 — feature lines:** no switch; lines are CAD-only (see
  "Feature lines").
- **2026-09-24 — placement:** the button moved off the view cube into the
  bottom toolbar (`#viewbar`), inserted before `#theme` behind a divider (the
  bar's appearance group), with an **eye** icon; the popover opens above the
  pill, right edges flush, and closes when the bar hides (by the `hidden`
  attribute or a host's CSS). Only a stage with no `#viewbar` falls back to
  the cube's bottom-right corner. Follows Fusion 360's display settings in the
  navigation bar.
- **2026-09-24 — projection is automatic:** the Projection row is gone, and
  the popover is the Style grid alone. Following Fusion 360's "Perspective
  with Ortho Faces" (and Blender's "Auto Perspective"): a view cube FACE click
  (canvas or keyboard button) tweens there and settles into orthographic at
  the end of the tween, size-preserving; edge, corner and iso views are
  perspective (an ortho view swaps back as that tween starts, while the part
  is still seen head-on); in a face view pan and zoom keep ortho, and the
  first rotation — a view-direction change past half a degree, checked per
  frame — returns to perspective. Only the cube opts in
  (`tweenCameraTo(view, { autoProjection: true })`); animation cues never
  switch into ortho. The projection is no longer persisted
  (`partforge:projection` is not read); a remount restores ortho from
  `viewerState` only with a face-view camera. `runtime.projection` stays for
  hosts, and a host's `set("orthographic")` is left by rotation like any face
  view. Agent-facing canonical renders stay perspective.

## Goal

Every control that changes *how the part is drawn* moves into one popover,
opened from a new **view style** button beside the view cube (bottom right),
where the projection toggle used to sit. Today those
controls are scattered: the ✦ realistic toggle and the environment `<select>`
sit in the bottom `#viewbar`, and the perspective/orthographic toggle sits on
the view cube's corner. Feature lines have no control at all (always on in CAD,
always off in realistic).

## What the user sees

**Beside the view cube.** The view cube's small projection circle is replaced
by the view style button — deliberately more visible: a 34 px button in
`#viewbar`'s chrome (surface, border, float shadow), sitting at the cube's
bottom-right corner where the projection button was. The drawer toggle at the
top right is unchanged. The button lives in the view cube's stack, so it hides
whenever the cube hides (Sketch mode, a crowded animation transport bar).

**The popover** opens ABOVE the button, right edges aligned, positioned from
the button's rect at open time (so it follows the cube wherever the stage puts
it):

1. **Style** — a grid of five thumbnails: CAD, Studio, Workshop, Print bed,
   Outdoor (CAD first, then `ENVIRONMENTS` order). Each tile is a small render
   of the *current part from the current camera* in that style, labelled
   underneath. The current style carries the accent ring. Clicking a tile
   switches at once: CAD → `setRenderMode("cad")`; an environment →
   `setEnvironment(id)` then `setRenderMode("realistic")`.
2. **Feature lines** — a switch. Remembered **per style**: CAD defaults on,
   every realistic style defaults off (today's behaviour). Flipping it in
   Studio changes Studio only.
3. **Projection** — a two-segment control, Perspective | Orthographic.
   *(2026-09-24: removed — the projection is automatic; see Revisions.)*

Closes on Escape, an outside pointerdown, or the button again; focus returns
to the button. Keyboard: the button has `aria-haspopup="dialog"` /
`aria-expanded`; tiles are buttons (`aria-pressed` on the current one); the
switch is `role="switch"`; the projection control is a radio group. On a narrow
stage the popover's width is capped to the stage minus its margins.

**Removed:** the viewbar's `#realistic` button and `#environment` select, and
the view cube's `#projection` button. The theme toggle stays in `#viewbar` — it
is app appearance, not a view style.

## Thumbnails (option C: live, cached)

- Rendered the first time the popover opens, then cached. The cache is marked
  stale when the geometry changes (every `showAssembly`) or the theme changes;
  a stale cache re-renders on the next OPEN, never while closed. Camera moves
  do not invalidate — a thumbnail shows the style, not a live mirror.
- A new viewer method `renderStyleThumbnail(style, { size })` → `Promise<dataURL|null>`:
  - `"cad"`: `captureIn("cad", …)` of the current framing at `size`.
  - an environment id: `await rigFor(id)`, compile, then a borrowed-look capture
    in THAT rig, restoring the live look exactly (whether the live view is CAD,
    or realistic in the same or another environment). No publish, no persisted
    state change — the same contract as `captureIn`.
  - Feature lines in the thumbnail follow that style's stored setting.
- Tiles render sequentially (one rig load at a time); each tile shows a neutral
  placeholder until its image lands. Rendered at 256 px (the capture path's
  minimum) and shown about 80 px square.
- **Memory:** a rig loaded only for a thumbnail is disposed after its capture
  unless it is the live environment — each rig holds its equirect (~16 MB
  half-float) and PMREM, and holding four on a phone is not acceptable.
  Re-opening the popover after a part change reloads them (cached by the HTTP
  layer, so it is decode + PMREM, not download).
- **Fallback (option B):** if the live path proves unreliable, tiles become
  shipped preview JPEGs per style. The module keeps a single `thumbnailFor(style)`
  seam so the swap touches one function.

## Feature lines

**Removed 2026-09-24 at the user's request — lines are CAD-only; no toggle.**
The section below is kept for history; none of it shipped in the final form.

- Viewer: `setFeatureLines(on)` / `getFeatureLines()` / `onFeatureLinesChange(fn)`.
  The sub-part line visibility rule changes from `shown && renderMode === "cad"`
  to `shown && featureLines`. It applies in both modes; realistic draws the same
  `lineMaterial` (theme line colour) — tuned by eye, opacity allowed to differ
  per mode if CAD's weight looks wrong over physical materials.
- Captures: agent-facing canonical renders keep their current look (CAD with
  lines; realistic without) regardless of the live switch — they are the
  agent's measuring view, not the user's. `captureCurrent` (the gallery's
  "capture from viewer") follows the live switch, like everything else it does.
- Persistence: `view-state.js` gains `loadFeatureLinesPrefs()` /
  `saveFeatureLinesPrefs(prefs)` over one localStorage key
  (`partforge:featureLines`, a JSON object keyed by style id, unknown keys
  ignored). Defaults: `cad → true`, environments → `false`.
- Whenever the style changes (by the popover, the runtime API, or a restore),
  the controls apply that style's stored value. `viewerState` carries the
  current `featureLines` for the remount carry-over, beside `renderMode` and
  `environment`.

## Runtime / host API

- `runtime.featureLines: { get, set(on), onChange }` — acts on the CURRENT
  style and persists for it.
- Existing `runtime.renderMode`, `runtime.environment`, `runtime.projection`
  are unchanged; the popover drives them, and follows them (a host that sets a
  mode through the runtime sees the popover update).
- The button and popover are **generated by partforge** into the stage (the
  view cube / `mobile-tabs.js` precedent), so a host needs no new markup.
  `elements.chrome.realistic` / `.environment` are removed from the mount
  contract; passing them is ignored (the ids simply stop being looked up).
- The host's `railToggle` is untouched.

## Chrome & layout

- New module `src/framework/view-style-controls.js` (DOM + wiring, like
  `realistic-controls.js`, which it replaces) and a small pure
  `view-style-state.js` (style list, per-style line defaults, cache staleness)
  so the logic is unit-testable without a DOM renderer.
- `viewcube-controls.js` loses its projection button and exposes its stack as
  the anchor; `view-style-controls.js` appends its button there. `chrome.css` /
  `app.css`: the button takes the old `.pf-viewcube-toggle` placement (over the
  cube's bottom-right corner) with viewbar-style chrome; the popover card
  (surface, border, radius, float shadow, z-index above the viewbar), tiles,
  the switch and the segmented control — all on existing `--pf-*` tokens so
  light and dark both work.
- When the cube hides (Sketch, crowding) the button goes with it and an open
  popover closes.

## partforge-cloud follow-up

A separate cloud PR after this publishes: bump the pin + regenerate prompts;
check the button under sheet/side mode (`pfc-stage-chrome-hidden` must hide it
with the cube); drop any scaffold reference to `#realistic` /
`#environment` (Plan B's scaffold task changes accordingly — the popover
replaces it).

## Testing

- Unit: `view-style-state` (defaults, per-style memory, staleness); the
  controls with a fake viewer (tile click → the right viewer calls, switch
  persists per style and re-applies on style change, projection control, open/
  close/Escape/outside click, focus return, runtime changes reflected, the popover
  closes when the cube hides); viewer `setFeatureLines` visibility in both modes;
  `renderStyleThumbnail` restores the live look after a borrowed capture and
  disposes a thumbnail-only rig.
- Browser: demo pages (desktop + narrow), both themes, via the Playwright
  scratch scripts; the materials contact sheet with lines on in realistic.

## Version

Minor bump (0.123.0, or the next free minor if #223 lands first — see the
rebase-absorbs-bump trap).
