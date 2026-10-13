# Part appearance controls: recolour, change material, hide from the viewer

Date: 2026-10-13. Spans two repos: `partforge` (viewer runtime, the View style
popover, captures) and `partforge-cloud` (the pick bubble, saving into source,
the sandbox protocol). Status: design approved in conversation from live
mockups; awaiting spec review.

## Why

partforge 0.122 gave sub-parts physical materials (`display.material`, a tint
`color`, six finish overrides) and the viewer a realistic mode, and the agent
is taught to author them. But the only way a person can change a part's look is
to ask the assistant, and the only way to see what is behind a lid or inside a
housing is the cutaway. Both are ordinary things to want to do by hand:

- try a finish or a colour on one piece and look at it, without a chat turn;
- hide a sub-part for a moment to see what it covers, then bring it back.

Visitors to a public forge want the same two things, on a part they cannot
edit.

## What the user gets

- **Behind the eye.** The View style popover (the eye in the pill) keeps its
  Style tiles and gains a **Parts** section: the sub-parts in the active view,
  each with an eye (hide / show) and a swatch. Show all clears every hide.
  Nothing is added to the pill.
- **From the model.** Clicking a sub-part raises the pick bubble as today, now
  led by the part: a first row with its swatch, name and material, an eye, and
  close. The pick chips sit inline in the text area, as they do in the main
  composer, so several picks still leave room to type.
- **One appearance card**, opened from either swatch: partforge's material
  presets as spheres, a colour row for tintable presets, the finish overrides
  behind a disclosure, and a footer that says where the change goes.
- **Owners' changes are saved to the forge.** Material, colour and finish land
  in the sub-part's `display` literal as a checkpoint, so the assistant sees
  them, exports carry the colour, and visitors see them after publish.
- **Hiding and see-through are never saved.** A part can be hidden with its
  eye or faded with a slider; both are ways of looking, like the cut plane:
  they survive every apply's remount and are cleared by Show all or a reload.
- **Visitors get the same controls, screen-only.** The footer reads "Only on
  this screen" and Reset returns to what the owner published.

## Decisions (from the mockups)

1. The Parts list lives in the existing View style popover, Style above Parts;
   no new pill button.
2. The bubble leads with the part (header row) and keeps its chips inline in
   the text area. The three layouts tried (header, toolbar, chip) are in the
   mockup page; header won.
3. Visitors on public forges get the full card, screen-only.
4. **The card is the popover's second page**, not a floating panel. The mockup
   drew it floating beside the popover and beside the bubble; the phone mockup
   already made it a second page with Back. One placement for every host is
   the simpler build, and it is where the model picker's two-level panel
   already lives. From the bubble, the swatch opens the popover directly on
   the card page. *Reviewer: confirm.*
5. Style tiles go from a three-column grid to one row of five, so the list has
   room. This changes partforge's own part pages too; accepted.
6. **Opacity is on the card, and it is a way of looking, like Hide.** A
   see-through slider sits beside the eye; it is never saved, survives
   applies the way a hide does, and is cleared by Show all. A ghost that
   should be PART of the design (a reference overlay) stays an authoring
   decision, written as `display.opacity` by the assistant. The slider is
   screen-only for everyone, owner included, so the footer says so in one
   line.

## Non-goals

- Per-view overrides. An override is keyed by sub-part name and applies in
  every view the sub-part appears in.
- Saving hides, or any "hidden" authoring key. A permanent removal is
  `exportable: false` or an edit, which is the assistant's job.
- Live material thumbnails per preset rendered on THIS part. The card renders
  spheres.
- A pick bubble on the visitor's viewer. `ViewerScreen` does not subscribe to
  picks today and has no chat to send to; the popover is the visitor's way in.
  A header-only bubble there is a follow-up if wanted.
- Folding appearance saves into the MCP viewer's Keep button (it keeps
  `defaults` only). In the MCP viewer the card is screen-only in v1.
- Server laps. They have no DOM, no popover and no overrides; the CPU renderer
  already honours a saved `display` (`softrender/index.js:30`).

## What exists today (the facts the design rests on)

partforge 0.146/0.147 (`P = src/framework`):

- `display` resolves through `materials/resolve.js` (`resolveMaterial`,
  `cadAppearance`, `DISPLAY_KEYS`, `OVERRIDE_RANGES`). CAD materials are built
  once per `createViewer` from `part.parts[name].display`
  (`viewer.js:271-277`); realistic ones lazily per sub-part into
  `physicalMats` (`viewer.js:723-736`). **A swap without a rebuild already
  exists**: `rebaseSubMaterial(name, mat)` (`viewer.js:758-770`) is how
  realistic mode enters and leaves; `setSubGeometry` never touches materials.
- Visibility per view is `showAssembly(visibleNames)` (`viewer.js:1688-1708`),
  run on every regen and view change; animation `opacity: 0` sets
  `mesh.visible = false` through `applySubOpacity` (`viewer.js:379-417`), and
  `effectiveVisible()` filters `lastShown` by it. There is no per-sub-part
  visibility or appearance API on the runtime handle.
- `getViewerState()` is `{camera, projection, cutaway, renderMode,
  environment?}` (`mount.js:113-126`), restored per field in `mount()`
  (`mount.js:696-718`, `954-980`). The cloud snapshots it before every
  teardown and passes it to the next mount (`mountManager.js:944-953`).
- The View style popover (`view-style-controls.js`) is appended to the STAGE,
  places itself above `#viewbar`, renders live thumbnails on open, and closes
  on outside pointerdown, Escape, or its host losing its box. Nothing else
  appends into it. `app.css:767` gives it `width: min(300px, calc(100% -
  24px))`, `overflow: auto`, and a `repeat(3, 1fr)` grid.
- `listExportableParts()` ignores the view; `viewSubParts(part, view, params)`
  (`part-model.js:18-24`) is the view-aware name list, exported from the
  package root, and the regen loop already uses it.
- `onPick` is called with `{selection, label, prompt, token, anchor}` where
  `selection.subPart` is the sub-part KEY (`mount.js:819-828`).
- Captures: `captureViews`, `renderViews`, `captureCurrent` and
  `renderStyleThumbnail` all render the **live scene** and respect
  `mesh.visible`; `captureView` (the checkpoint thumbnail) builds a throwaway
  scene with `materialFor(name)` (`mount.js:1439-1450`, `viewer.js:2202`).
- Exports read `display` in the WORKER's copy of the part
  (`jobs.js:518,531`, `printColor`); nothing on the main thread reaches them.

cloud:

- `mountManager.js:1052-1059` forwards picks as `{label, prompt, anchor}` and
  **drops `selection`**; `protocol.js:485-499` `sanitizePick` admits only those
  three. `pickLocator.js` recovers the key by regex-parsing the prompt.
- `PickBubble.jsx` holds a chip row and a `<textarea>`; the chip markup is the
  composer's. `PickComposer.jsx` is the contenteditable chip builder
  (`chipNode`, `insertPick`, `serialize` → `<pick>` markers inside a text part).
- Panel settings persist through `partDefaults.js` (`findDefaultsLiteral`,
  `scanEntries`, `rewriteDefaults` with its self-verification) and
  `useSettingsSession.js` `flushSave` (lines 179-234): `panelVersionsRef`
  before `controller.updateTree`, then `controller.enqueueSave({tree,
  treeHash, message: PANEL_SAVE_PREFIX + keys, verification: {panelSettings:
  true}})`. `authoredBaseline` skips those revisions; `useUndoRedo` treats the
  head change as an external edit.
- The sticky app→sandbox table (`sandboxClient.js:548-571`, replayed on every
  handshake) and its validators in `protocol.js` are the pattern for any state
  the app must push into the sandbox.
- Build sight (`mountManager.js:1347-1349`) is `runtimeShowcaseShot` with
  `renderMode: "cad"`, i.e. `captureCurrent` of the live scene.

## A. partforge: the display override

### A.1 Model

A per-sub-part **override** merged over the authored `display`:

```js
override = { material?, color?, roughness?, metalness?, clearcoat?,
             clearcoatRoughness?, anisotropy?, textureScale?,
             hidden?, opacity? }
effective(name) = { ...part.parts[name].display, ...appearanceKeys(override(name)) }
```

- The **appearance** keys are the eight `DISPLAY_KEYS` other than `opacity`:
  they merge into `effective()`, which every material read uses. Values go
  through the same clamps `applyDisplay` already applies; an unknown material
  id is kept (it resolves to PLA exactly as an authored one does) so the card
  can show "unknown" the way lint would.
- The **viewing** keys are `hidden` (boolean) and `opacity` (a multiplier,
  0.05–1, clamped). They are viewer state: never part of `effective()`,
  never seen by anything that reads a display, never saved by a host. They
  multiply the authored `display.opacity` rather than replace it, so an
  authored ghost at 0.3 slid to 50% shows at 0.15, the same arithmetic
  animation opacity uses.
- `material: null` in a patch clears the override for that key (back to the
  authored value); `hidden: false` and `opacity: 1` (or `null`) clear the
  viewing keys. An override object with no keys left is dropped.

### A.2 Runtime API (new hops on the handle, `mount.js` `makeHandle`)

```js
runtime.setSubPartDisplay(name, patch)   // merge; returns the override now held, or null
runtime.getSubPartDisplay(name)          // { authored, override, effective, hidden }
runtime.listSubParts({ view? })          // [{ name, label, inView, hidden, effective,
                                         //    color (resolved swatch int), materialLabel|null,
                                         //    tintable, overridden: boolean }]
runtime.clearSubPartDisplay({ viewing?: true, appearance?: true }) // Show all / Reset
                                         // viewing = hidden + opacity; appearance = the rest
runtime.onSubPartDisplayChange(cb)       // cb({ name, override }) after each change, and
                                         // cb(null) after a clear; returns unsubscribe
runtime.openAppearance(name)             // opens the popover on the card page for `name`
runtime.setDisplaySaveState(state)       // "saved" | "screen-only" | "blocked" — footer copy
```

`listSubParts` defaults to the active view and uses `viewSubParts` for
`inView`, `partLabel` for the label, and `resolveMaterial(effective).params.
color` (or `NO_MATERIAL_COLOR`) for the swatch. An unknown `name` in any call
is ignored (returns null / false), never throws.

### A.3 Viewer implementation

- `createViewer` gains `displayOverrides: Map<name, override>` and
  `hiddenSubParts: Set<name>`.
- `materialFor(name)` reads `effective(name)`; so does `physicalFor`,
  `realisticDisplay`, the static-opacity reads (`viewer.js:408, 780, 1374`)
  and `renderMeshPayloads` (the throwaway thumbnail scene, `viewer.js:2217`).
- `setSubPartDisplay` stores the patch, rebuilds that ONE sub-part's CAD
  material (`buildCadMaterial(effective, base)`), drops its `physicalMats`
  entry, and calls `rebaseSubMaterial(name, renderMode === "realistic" ?
  physicalFor(name) : cadMats[name])`. No geometry work, no regen. The
  mount-time `layerLined` / `burning` sets (`mount.js:995-998`) become
  per-sub-part functions evaluated at swap time; `printFrames` is computed for
  every sub-part at mount (it is cheap: one matrix per sub-part), so a piece
  switched live to a print preset gets its layer lines oriented correctly.
- **Hide** is its own flag, beside animation opacity, not a value of it:
  `applySubOpacity` ANDs `!hiddenSubParts.has(name)` into `shown`, and
  `effectiveVisible()` filters hidden names too, so the cutaway, the ground,
  shadow casters, raycast and visible-bounds framing all follow. `showAssembly`
  leaves hidden names out of what it shows. Hidden wins over an animation's
  opacity; the animation keeps tracking and the piece reappears where the
  animation says when shown again.
- **See-through** rides the fade path animation already has: `applySubOpacity`
  computes `v = animOpacity × userOpacity` and takes its existing `0 < v < 1`
  branch (`fadeMatFor`, `transparent`, `depthWrite: false`, line clone opacity),
  so a see-through part draws, casts no shadow (the ghost rule at
  `viewer.js:780`), and is still pickable. `userOpacity` is a second Map
  beside `animOpacity`; an animation reset or detach clears only its own.
- **Which captures see the viewing keys.** Hides and see-through are how the
  user is looking, and only captures of "what the user sees" honour them:

  | capture | hide + see-through | appearance overrides |
  | --- | --- | --- |
  | live scene, `captureCurrent` (gallery capture), `renderStyleThumbnail` | honoured | applied |
  | `captureViews`, `renderViews` (agent renders), `captureCurrent({includeHidden: true})` (build sight) | **ignored** | applied |
  | `captureView` (checkpoint thumbnail, throwaway scene) | ignored by construction | applied |

  `renderOffscreen` already toggles `captureHidden` objects off for a frame;
  the canonical paths toggle hidden sub-meshes ON and user opacity to 1 for
  the frame the same way (`includeHidden`), and restore after.
  `captureViews`/`renderViews` pass it unconditionally. The model must never
  be shown a part with pieces missing or faded.
- **Thumbnail cache invalidation**: the popover's `invalidate()` also fires on
  `onSubPartDisplayChange`, so the style tiles re-render on the next open.

### A.4 Viewer state

`getViewerState()` gains `display: { [name]: override }` (viewing keys included)
when any override is held; `mount({viewerState})` restores it right after the
projection/environment restores (`mount.js:696-718`), before the first
`showView`, by replaying `setSubPartDisplay` per entry. Two pruning rules on
restore:

- a name the part no longer declares is dropped;
- an override whose appearance keys all equal the authored `display` is
  reduced to its viewing keys (or dropped). This is what makes an owner's
  saved change self-clean: after the save remounts the part with the new
  source, the carried override is a no-op and disappears.

`localStorage` is not used for overrides (view-state.js's keys are for the
camera and style only); the cloud's opaque-origin document could not read it
anyway.

### A.5 The popover: Parts section

`view-style-controls.js` (renamed in spirit, not in file name) gains, under the
Style grid:

```
<hr class="pf-viewbar-divider-h">
<div class="pf-parts-head"><p class="pf-view-style-heading">Parts</p><button>Show all</button></div>
<div class="pf-parts-list" role="list">
  <div class="pf-parts-row" role="listitem" data-name>
    <button class="pf-parts-eye" aria-pressed aria-label="Hide Lid">eye</button>
    <button class="pf-parts-swatch" aria-label="Change appearance of Lid" style="--pf-swatch:#…"></button>
    <span class="pf-parts-name">Lid</span><span class="pf-parts-mat">Anodized aluminium</span>
  </div>…
</div>
```

- Rows are `listSubParts()` for the active view, re-rendered on open, on
  `onViewChange`, on assembly change and on every display change. A forge
  with one sub-part shows one row (no special case). Show all is shown only
  while something is hidden or see-through; it is
  `clearSubPartDisplay({viewing: true})` for every part. A see-through row's
  eye draws half-weight, so the list says which parts are faded.
- `.pf-view-style-grid` becomes `repeat(5, 1fr)` with a 6px gap; the thumb
  keeps `aspect-ratio: 1`; the label drops to 10.5px. `place()`'s `maxHeight`
  already bounds the popover to the stage; the list scrolls inside it.
- The swatch is a flat disc in the resolved colour; a hidden row dims its
  swatch and name. Rows carry `title`s for the tooltip binding like the
  tiles.

### A.6 The popover: card page

Clicking a swatch (or `runtime.openAppearance(name)`) swaps the popover's
content for the card, with a Back button that returns to the list; the
popover's placement, close rules and host-hidden observers are unchanged. The
card:

1. **Header**: Back, the sub-part label, the eye (same toggle as the row),
   close. Under it, **See-through**: one range input, 5–100%, writing
   `{opacity}`; at 100% the key clears. It sits with the eye rather than in
   Finish because it is the eye's partial form, and both are screen-only.
2. **Materials**: a 6-column grid of tiles, one per `PRESETS` entry plus a
   first "CAD" tile meaning "no material"; the pressed tile is `effective.
   material` (CAD when null or unknown; an unknown id shows its text under the
   CAD tile so the author's typo is visible). Tile thumbnails are small
   sphere renders under the current environment, rendered lazily one per
   frame on first open of the card and cached per `(preset, environment,
   theme)` by the thumbnail cache; while pending, a flat disc in the preset's
   colour. Picking a tile is `setSubPartDisplay(name, {material: id})`
   (`null` for CAD).
3. **Colour**: nine fixed swatches, a hex field and a native colour input,
   enabled only when the pressed preset is `tintable` (or CAD). A preset with
   its own colour dims the row and says "Brass has its own colour. Pick a
   tintable preset to colour it." Picking writes `{color: int}`.
4. **Finish** (`<details>`, closed): six range inputs over `OVERRIDE_RANGES`,
   each writing its key; a cleared value (the input's reset affordance)
   writes `null`.
5. **Footer**: copy from `setDisplaySaveState`: `saved` → "Material and
   colour are saved to this forge. See-through and hiding are only on this
   screen." + **Reset to authored**; `screen-only` → "Only on this screen" +
   **Reset**; `blocked` → "This part's look is set by code. Ask the assistant
   to change it." + Reset. Reset is `clearSubPartDisplay({appearance: true})`
   for this name only (the viewing keys are left alone; Show all is theirs).

Every write goes through `setSubPartDisplay`, which emits
`onSubPartDisplayChange` — the ONE event the host listens to.

### A.7 Docs

`AUTHORING-PARTS.md` "Wiring a part into a runnable app" gets the new runtime
hops beside `renderMode`/`environment`, and "Materials and appearance" gets
one paragraph: viewers can change a sub-part's look and hide it; a host may
persist the look by writing `display`. Regenerating the cloud's prompt corpus
from this is part of the bump (the agent-facing compact prompt needs no new
rule: a `display` the user set is just part of the source it reads).

## B. cloud: carry, pick, bubble, save

### B.1 Protocol (`src/sandbox/protocol.js`)

Up (sandbox → app):

- `pfc-pick` gains `subPart` (string, ≤120 chars, control-stripped, dropped if
  absent). `mountManager`'s `onPick` forwards `selection.subPart`; `host.js`
  `sendPick` posts it; `sanitizePick` admits it. `pickLocator.js` keeps its
  regex parse as the fallback for a sandbox older than the floor.
- `pfc-display-state` `{ parts: [{name, label, inView, hidden, color,
  materialLabel, tintable, overridden}] }`, ≤200 rows, every string
  control-stripped and capped, `color` an int. Sent after every mount's first
  build, on view change, and on every `onSubPartDisplayChange`. The app keeps
  the last one per viewer handle (`displayState`); it is what the bubble
  header renders from.
- `pfc-display-changed` `{ name, override }` — the raw override after a
  change (`null` after a clear), sanitized to the ten keys with clamped
  numbers, a preset-id-or-null material, a boolean hidden and an opacity in
  0.05–1. The owner's save path consumes it.

Down (app → sandbox), none sticky:

- `pfc-display-set` `{ name, patch }` → `runtime.setSubPartDisplay`. The
  bubble's eye sends `{hidden: true}`.
- `pfc-appearance-open` `{ name }` → `runtime.openAppearance`.
- `pfc-display-save-state` `{ state }` → `runtime.setDisplaySaveState`. Sent
  after every mount and whenever the app's answer changes; **not sticky**
  because the answer is per part and per sub-part session, and a stale replay
  would mislabel the footer. The app re-sends it on `pfc-display-state`.

Overrides themselves ride `viewerState`, which `mountManager.apply` already
carries whole (`mountManager.js:944-953`); nothing app-side holds them.

### B.2 The bubble (`src/ui/PickBubble.jsx`, `EditorScreen.jsx`)

- `EditorScreen`'s pick subscriber stores `subPart` on each pick. The bubble
  takes `displayState` and renders the header row when the LATEST pick's
  `subPart` is in it: swatch (`color`), `label`, `materialLabel` or "No
  material", a chevron; the eye; close. A pick with no `subPart` (older
  sandbox, a cut-face hit) renders no header and the bubble is today's.
- The header's swatch button sends `pfc-appearance-open`; the eye sends
  `pfc-display-set {hidden: true}` and then `closePickBubble()` with the picks
  handed to the composer exactly as dismiss does today (the subject is gone,
  the text is not lost).
- The chip row and the `<textarea>` are replaced by a `PickComposer` in a
  compact variant (same `chipNode`, same `<pick>` serialization). Each new
  pick is `insertPick`ed into it; Send serializes it (`serialize().text`) into
  the main composer through the bridge (`setText`, then `submit`) instead of
  inserting picks one by one; dismiss hands the text over the same way.
  `onRemovePick` goes: the chip's own ✕ removes it.

### B.3 Saving for the owner (`src/parts/partDisplay.js`, `src/ui/useDisplaySession.js`)

Mirrors panel settings, one file each:

- `rewriteDisplay(source, name, patch)` → `{ok, source}` or `{ok: false,
  reason}`. It finds the sub-part's object literal inside the `parts:` literal
  the way `pickLocator.js`'s `locatePick` already does (the key as `name:`,
  `"name":` or `'name':` after the `parts:` opener, skipping strings and
  comments), then:
  - an existing `display: { … }` literal: readable entries are spliced like
    `rewriteDefaults` does, and **keys absent from the literal are inserted**
    at its end (this differs from `rewriteDefaults`, which never adds a key:
    most forges declare no `display`, and a control that only works on parts
    that already have one is not a control);
  - no `display` entry: `display: { … },` is inserted as the first entry of
    the sub-part literal, on its own line at the literal's indent;
  - a `display` that is not an object literal (an identifier, a spread, a
    call) or a sub-part that is not a literal (`...PLY`, a computed key, a
    helper call): `{ok: false, reason: "display-not-literal"}`.
  - colours are written as `0xRRGGBB` (the docs' spelling), strings
    JSON-quoted, numbers plain; `null` in the patch removes the key, and an
    emptied literal is left as `display: {}`.
  - self-verification as `rewriteDefaults`: bytes outside the sub-part
    literal unchanged; the written values read back (a small
    `readDisplay(source, name)` using the same scanner) equal to the patch.
- `useDisplaySession({ viewerRef, controller, persist })`, owned by
  `TabbedPane` beside `useSettingsSession`:
  - subscribes to `pfc-display-changed`; strips the viewing keys (`hidden`,
    `opacity`) and ignores a change that carried nothing else; debounces 2s
    per sub-part (`SAVE_DEBOUNCE_MS`, shared constant), coalescing keys;
  - `flushSave`: refuse while locked (server run, the settings session's
    rule); `rewriteDisplay` on the entrypoint file that declares the sub-part;
    `panelVersionsRef`-style exclusion so the settings session does not rebuild
    (the two hooks share one `panelVersions` set lifted into `TabbedPane`);
    `controller.updateTree(nextTree)`; `enqueueSave({tree, treeHash, message:
    PANEL_SAVE_PREFIX + "appearance of " + label, verification: {panelSettings:
    true, appearance: true}})`. Reusing the prefix and the `panelSettings` flag
    keeps `authoredBaseline`, `useUndoRedo` and the revision list behaving as
    they do for a panel save, with nothing new to teach them;
  - a `display-not-literal` refusal sends `pfc-display-save-state {state:
    "blocked"}` for that sub-part's next card open and leaves the override
    screen-only; any other refusal logs once and does the same;
  - answers `pfc-display-state` with `pfc-display-save-state`: `"saved"` when
    `persist` and the sub-part is rewritable, `"blocked"` when not,
    `"screen-only"` when `!persist` (`ViewerScreen`, which mounts with
    `persist: false`, and the MCP viewer, which sends nothing and so leaves
    partforge's default, `"screen-only"`).
  - Reset for the owner: the card's Reset clears the override; the session
    then writes the **session baseline** display (the sub-part's `display` as
    read from the tree at the session's epoch) back through the same save
    path, so Reset to authored is a checkpoint like any other change.
- The checkpoint thumbnail is captured by `captureView` from the live viewer's
  `part`, which is still the OLD source until the remount lands — the same
  race panel settings accept today; the next save corrects it.

### B.4 Build sight and the agent

- `mountManager`'s build-sight call passes `includeHidden: true` to
  `captureCurrent`; the gallery capture passes nothing (what the user sees).
  `tests/unit/apply-flags-guard.test.js`'s allowlist is unchanged — this is
  not an apply flag.
- No tool changes. A saved `display` is in the tree the agent reads; the
  manifest already names each sub-part. `apply_part_changes` results carry
  nothing about hides.
- Prompt corpus regeneration (`npm run docs:generate && npm run
  prompt:generate`) comes with the pin bump, as every bump does.

### B.5 Version floor and degradation

Every hop is optional-chained and feature-detected on
`runtime.listSubParts`. Below the floor: the popover shows Style alone (it is
partforge's), picks carry no `subPart` so the bubble shows no header, no
`pfc-display-state` arrives so nothing app-side renders, and `captureCurrent`
ignores `includeHidden`. Nothing errors. The floor joins the `package.json`
pins and AGENTS.md's list.

## C. Testing

partforge:

- `resolve`: `effective()` merge, `null` clears, unknown material kept.
- `viewer`: `setSubPartDisplay` swaps the material with the same
  `BufferGeometry` instance; realistic cache entry dropped and rebuilt; hidden
  excludes from `effectiveVisible`, visible bounds, raycast and `castersNow`;
  `captureViews` and `captureCurrent({includeHidden: true})` include a hidden
  sub-mesh and restore its visibility after; plain `captureCurrent` and
  `renderStyleThumbnail` exclude it; a print preset set live gets a print
  frame.
- `mount`: `getViewerState().display` round-trips through `mount({viewerState})`;
  both pruning rules; `listSubParts` follows `setView`; `declaresMaterials`
  unchanged by overrides.
- popover (jsdom, the `sandbox-scaffold.test.js` stub pattern): rows match
  `listSubParts`; eye toggles and dims; Show all; swatch opens the card page;
  Back returns; card tiles press the effective material; colour row disabled
  for an untintable preset; footer copy per save state; `openAppearance` from
  the runtime.

cloud:

- `protocol`: `sanitizePick` with and without `subPart`; the three new
  messages' validators (caps, clamps, enum material, booleans); an invalid
  `pfc-display-set` is dropped with no reply.
- `partDisplay`: rewrite into an existing literal; insert a missing key;
  insert a missing `display`; `0x` colour spelling; `null` removes; refusals
  for a spread sub-part, an identifier display, a computed key; bytes outside
  the sub-part literal identical; verify failure refuses.
- `useDisplaySession`: debounce and coalescing; the checkpoint message and
  `verification`; the shared `panelVersions` exclusion (no settings-session
  rebuild); `blocked` state on refusal; `screen-only` with `persist: false`;
  Reset writes the baseline.
- `PickBubble`: header from `displayState` keyed by the latest pick's
  `subPart`; no header without one; eye sends `pfc-display-set` and closes
  with picks handed over; chips serialize through the compact composer.
- `mountmanager-apply.test.js`: build sight passes `includeHidden: true`;
  gallery capture does not.
- `sandbox-scaffold.test.js`: unchanged and green — no new pill button.
- Stale-floor: a runtime without `listSubParts` renders no header and sends
  nothing.
- `tests/smoke`: one Playwright pass in the real sandbox — hide a part, apply
  an edit, the part stays hidden; set a material, see the swatch and the
  checkpoint message.

## D. Rollout

1. **partforge** (one PR, minor bump): A.1–A.7. Publish.
2. **cloud** (one PR): pin bump + regenerated corpus; B.1–B.5; AGENTS.md's
   version-floor list and `docs/agents/viewer-and-sandbox.md` gain the rule
   that hides are screen-only and agent captures ignore them; the mockup
   page's decisions summarized in the doc.
3. No migration, no env var, no WAF rule. The feature is on with the pin.
4. Manual checks before merge, on a Preview: desktop editor (owner), the
   public viewer (visitor, screen-only), a phone at peek, the MCP viewer
   (popover present, card screen-only), and one forge with a `...PLY`-style
   shared display (card says "set by code").

## E. Residuals and open questions

- A sub-part whose `display` comes from a shared constant cannot be saved
  from the card; the override stays screen-only and the card says so. The
  laser-box worked example is exactly that shape.
- Overrides are keyed by name; renaming a sub-part in an edit drops its
  override at the next mount (pruning rule 1). Accepted.
- A hide survives applies but not a reload; the visitor's recolour too.
- Two tabs on one forge: each has its own overrides; the owner's saves
  reconcile through the checkpoint CAS as panel saves do.
- See-through multiplies an authored `display.opacity` rather than replacing
  it, so a part authored as a 0.3 ghost cannot be made MORE solid from the
  card; the slider's top is the authored value. Accepted: making a ghost
  solid is an edit.
- A see-through part set below the slider's floor is not the same as hidden:
  it still draws, picks and frames. The eye is the way to remove it.
- Reviewer questions: decision 4 (card as the popover's second page on every
  host); whether Show all should also clear appearance overrides for a
  visitor (proposed: no, hides only; the card's Reset is per part).
