# View style popover — design

Date: 2026-09-24. Follows the realistic rendering mode (partforge #222, spec in
partforge-cloud `docs/superpowers/specs/2026-09-24-realistic-rendering-mode-design.md`).

## Goal

Every control that changes *how the part is drawn* moves into one popover,
opened from a new **view style** button at the stage's top right. Today those
controls are scattered: the ✦ realistic toggle and the environment `<select>`
sit in the bottom `#viewbar`, and the perspective/orthographic toggle sits on
the view cube's corner. Feature lines have no control at all (always on in CAD,
always off in realistic).

## What the user sees

**Top right.** One pill, same chrome as `#viewbar` (surface, border, pill
radius, float shadow): `[view style] [drawer toggle]`. The drawer toggle is the
host's existing `#rail-toggle`, moved into the pill. Where the rail hides the
toggle (below the narrow breakpoint) the pill holds the view-style button alone.

**The popover**, anchored under the button, right-aligned to the pill:

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
  placeholder until its image lands. Size: 96 px square at device pixel ratio
  (≤ 2).
- **Memory:** a rig loaded only for a thumbnail is disposed after its capture
  unless it is the live environment — each rig holds its equirect (~16 MB
  half-float) and PMREM, and holding four on a phone is not acceptable.
  Re-opening the popover after a part change reloads them (cached by the HTTP
  layer, so it is decode + PMREM, not download).
- **Fallback (option B):** if the live path proves unreliable, tiles become
  shipped preview JPEGs per style. The module keeps a single `thumbnailFor(style)`
  seam so the swap touches one function.

## Feature lines

- Viewer: `setFeatureLines(on)` / `getFeatureLines()` / `onFeatureLinesChange(fn)`.
  The sub-part line visibility rule changes from `shown && renderMode === "cad"`
  to `shown && featureLines`. It applies in both modes; realistic draws the same
  `lineMaterial` (theme line colour) — tuned by eye, opacity allowed to differ
  per mode if CAD's weight looks wrong over physical materials.
- Captures: agent-facing canonical renders keep their current look (CAD with
  lines; realistic without) regardless of the live switch — they are the
  agent's measuring view, not the user's. `captureCurrent` (the gallery's
  "capture from viewer") follows the live switch, like everything else it does.
- Persistence: `view-state.js` gains `loadFeatureLines(style)` /
  `saveFeatureLines(style, on)` over one localStorage key
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
- The pill reparents the host's `railToggle`. rail.js's own hide/show and its
  `toggleOriginal` restore keep working because they act on the element, not
  its position; teardown puts the toggle back where it was.

## Chrome & layout

- New module `src/framework/view-style-controls.js` (DOM + wiring, like
  `realistic-controls.js`, which it replaces) and a small pure
  `view-style-state.js` (style list, per-style line defaults, cache staleness)
  so the logic is unit-testable without a DOM renderer.
- `chrome.css`: `.pf-float-topright` takes `.pf-float-rail-toggle`'s placement
  (top 12, right 12); the toggle inside it becomes `position: static`.
  `app.css`: the pill's appearance (copied from `#viewbar`), the popover card
  (surface, border, radius, float shadow, z-index above the viewbar), tiles,
  the switch and the segmented control — all on existing `--pf-*` tokens so
  light and dark both work.
- Sketch mode hides the pill with the rest of the stage chrome (the list in
  mount.js that already hides `#viewbar`).

## partforge-cloud follow-up

A separate cloud PR after this publishes: bump the pin + regenerate prompts;
check the pill under sheet/side mode (`pfc-stage-chrome-hidden` must hide it,
the same as the viewbar); drop any scaffold reference to `#realistic` /
`#environment` (Plan B's scaffold task changes accordingly — the popover
replaces it).

## Testing

- Unit: `view-style-state` (defaults, per-style memory, staleness); the
  controls with a fake viewer (tile click → the right viewer calls, switch
  persists per style and re-applies on style change, projection control, open/
  close/Escape/outside click, focus return, runtime changes reflected, teardown
  restores the rail toggle); viewer `setFeatureLines` visibility in both modes;
  `renderStyleThumbnail` restores the live look after a borrowed capture and
  disposes a thumbnail-only rig.
- Browser: demo pages (desktop + narrow), both themes, via the Playwright
  scratch scripts; the materials contact sheet with lines on in realistic.

## Version

Minor bump (0.123.0, or the next free minor if #223 lands first — see the
rebase-absorbs-bump trap).
