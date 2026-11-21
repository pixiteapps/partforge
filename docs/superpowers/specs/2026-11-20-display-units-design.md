# Display units: millimetres or inches in the control panel

Status: DRAFT, 2026-11-20. Nothing is built. Decision 1 (display only) was
confirmed by Scott on 2026-11-20. Decisions 2 to 5 (section 9) are still
Claude's recommendations, and the document assumes them.

Plan: `docs/superpowers/plans/2026-11-20-display-units.md`.

## 1. Intent

A person who thinks in inches can switch the control panel to inches, move
sliders and type values in inches, and get the same forge. The forge, its
saved settings, the agent and every export stay in millimetres.

Why: a large share of our users are in the US, and routed plywood and
imperial hardware are designed in inches. Today a person who wants a 3/4 in
slot has to type 19.05.

## 2. How it works today

- **Everything is millimetres.** The kernel, `defaults`, `verify`, exports
  and the agent's prompt ("Units are **millimetres**") all assume it. Every
  forge writes `meta.units: "mm"`, and I found nothing in partforge 0.192 that
  reads it.
- **The panel is partforge's, not the app's.** It is drawn inside the sandbox
  by `partforge/src/framework/panel/widgets/numeric.js`. A control's `unit` is
  a plain label: the widget prints the string after the box and writes the
  box's number straight into `params`. Nothing converts.
- **Measure mode already switches units.** `measure-mode.js` has `setUnits("mm"
  | "in")` and a button, display only, inches to 3 decimals
  (`dim3-place.js`'s `UNITS`). It is not remembered and not carried across the
  remount an edit performs.
- **The Download dialog has its own units** (mm, in, ft per stock group,
  `src/ui/kitChoices.js`), also display only.
- **Other places that print a control's value and unit**: the read-only
  `readout` widget, the handle drag readout and its typed-value chip
  (`pose/drag-readout.js`, `pose/readout-chip.js`), handle guides, and the kit
  README's settings and clearances list.
- Of 138 `unit:` values in partforge's own examples, 121 are `"mm"`, 12 `"°"`,
  3 `"%"`.

So most of the work is in partforge. The app's part is remembering the
choice and passing it into the sandbox.

## 3. Goals, non-goals, anti-goals

Goals

- One switch, millimetres or inches, for every length the viewer shows:
  panel sliders and number boxes, readouts, handle readouts and chips, and
  measure mode.
- Values typed in inches are exact (1.5 in is 38.1 mm, not a nearby slider
  step).
- The choice is remembered per browser and survives edits, reloads and
  opening another forge.
- A forge behaves the same in both modes: same slider positions, same saved
  settings, same build.

Non-goals

- Forges authored in inches. `defaults`, geometry code and `verify` stay mm.
- Converting the agent's side: tool results, the manifest, verify messages
  and chat markers stay mm.
- Converting authored prose. A description that says "6–12 mm is typical"
  still says that in inch mode.
- Feet, or fractional display (see decision 2).
- Area and volume readouts (`mm²`, `mm³`). Only a unit of exactly `"mm"`
  converts in v1.

Anti-goals

- A saved setting that differs by display mode. If switching to inches and
  back changes any stored number, the feature has failed.
- A second copy of a forge's ranges. The app must not rewrite `min`, `max` or
  `step` into inches before mount: `params` would then be in inches and the
  build would be wrong.

## 4. Approaches

**A. Display-only conversion inside partforge (recommended).** The viewer
gets one `units` setting. `params` stay mm. Each widget converts at its edge:
mm to the shown text, typed text back to mm. The app remembers the choice and
seeds each mount with it, the way it does the view style.

- For: small, safe, no stored data changes, works for every existing forge
  at once, and it matches what measure mode already does.
- Against: slider steps are still mm steps, so dragging in inch mode lands on
  values like 0.492 in. Typing is how a person gets a round inch value.

**B. Convert in the app, before mount.** The app rewrites each control's
`min`/`max`/`step`/`unit` into inches and converts `params` in and out.

- Rejected. Part code reads `params` directly, so every value would need
  converting on every hop (build, save, undo, handles, the agent's manifest),
  and custom controls and handles would be missed. It is approach A done from
  the wrong side of the sandbox wall.

**C. Inch-native forges.** `meta.units: "in"` means the forge's numbers are
inches: defaults, geometry, verify, exports.

- Rejected for now. It touches the kernel boundary, every verify threshold,
  exports, the whole authoring prompt and the reference library (a helper
  copied from an mm forge into an inch forge would be wrong by 25.4). It also
  does nothing for the thousands of existing mm forges. A much lighter form
  of the same wish is decision 3's option: a forge that only says which unit
  it would like to be SHOWN in.

## 5. Design

### 5.1 partforge

**One module, `framework/units.js`**, replacing `dim3-place.js`'s private
`UNITS` table:

- `UNIT_IDS = ["mm", "in"]`.
- `toDisplay(mm, units)` and `fromDisplay(value, units)`. Inches to mm is
  `value * 25.4`, rounded to 4 decimals of a millimetre (the same grid
  `numStr` already uses), so 1.5 in stores as `38.1`, never
  `38.099999999999994`.
- `formatLength(mm, units)`: mm as today; inches to 3 decimals with trailing
  zeros trimmed.
- `parseLength(text, units)`: a decimal, and in inch mode also a fraction or
  mixed number (`3/4`, `1 1/2`). Anything else is "not a number", which the
  box already handles by reverting.
- `convertsUnit(unit)`: true only for the exact string `"mm"`.

**`runtime.getUnits()` / `setUnits()` / `onUnitsChange()`**, seeded from
`viewerState.units` (no separate mount option: the app already seeds a mount
through `viewerState`). The value rides `getViewerState().units` only when it
is not `"mm"`, so the existing carry-over keeps it across a remount with no
new plumbing. An unknown value is ignored, not thrown.

A decimal comma is read as a decimal point (`0,75` is 0.75), because
`parseFloat("0,75")` is 0 and a text box would otherwise commit it.

**Numeric widget** (`numeric.js`), for a control whose unit converts:

- The label after the box shows the active unit.
- The box shows `formatLength(params[key])` and commits
  `parseLength(box.value)`. In inch mode the box is a text input with
  `inputmode="decimal"`: a number input cannot hold `3/4` and its `step`
  attribute would fight the conversion.
- The slider track is unchanged: still mm `min`, `max`, `step`, `ticks`,
  `snap`, `recommended` and log scale. Same thumb position in both modes.
- The out-of-range warning compares millimetres, as today.
- A unit switch calls each widget's existing `sync()`. It changes no
  parameter and fires neither `onChange` nor `onParamsCommit`.

**Other readers of a control's unit** use the same two functions: the
`readout` widget, the drag readout, the readout chip (including its typed
entry) and handle guides. Controls in `°`, `%` or anything else are
untouched.

**Measure mode** drops its private `units` variable and reads the shared
setting. Its existing button becomes one of two ways to flip the same state.

**The switch itself** is generated by partforge, like `#view-style`: a small
`mm | in` control at the top of the controls rail, shown only when the view
has at least one converting control or readout. Generated, not added to the
app's scaffold, so the read-only viewer, the MCP viewer and any other host
get it without wiring.

**Custom controls** (`type: "custom"`) draw themselves. Their mount context
gains `units` and a change callback so a widget may follow; one that ignores
it keeps showing mm. No lint rule.

**Docs**: AUTHORING-PARTS gains a short section saying display units exist,
that `unit: "mm"` is what opts a control in, and that part code never sees
anything but mm.

### 5.2 partforge-cloud

- **Preference**: `src/ui/unitsPreference.js`, one key `pfc.units`, shared by
  editor and viewer (a person's units do not depend on the screen, unlike the
  view style). Written only when the user picks; absent means mm. Every touch
  in try/catch.
- **Down**: a sticky `pfc-units` message seeds a mount that has no carried
  viewer state, exactly as `pfc-appearance` does. It goes in both sticky
  tables (`sandboxClient`'s boot re-send and `mountManager`'s `replaySticky`),
  the protocol validator and `host.js`'s parent-gated dispatch. A carried
  state wins over the seed.
- **Up**: `pfc-units-changed` rewrites both tables and saves the preference.
- **Nothing else changes.** The settings session still receives mm params, so
  the per-key defaults save, `sameValue`, the adopt-hash stamp and undo are
  untouched. The chat's panel-settings marker and the manifest stay mm
  because the model reads them.
- **Bump**: pin the new partforge, add the version-floor entry to AGENTS.md
  (below it: no switch, mm everywhere, nothing errors), and regenerate the
  prompts (`npm run docs:generate && npm run prompt:generate`).

### 5.3 What a person sees

```
Controls                      [ mm | in ]
Width          ────●────────   [ 4.921 ] in
Slot           ──●──────────   [ 0.75  ] in     <- typed "3/4"
Angle          ─────●───────   [ 30    ] °      <- never converts
```

## 6. Edge cases

- **Stored number after an inch entry.** `3/4` stores `19.05`; `1/3` stores
  `8.4667`. Both are ordinary panel saves.
- **Display rounding is not identity.** 12.5 mm shows as `0.492 in`. Focusing
  and leaving the box without typing must not commit `12.4968`. The box
  commits only when its text changed since the last sync.
- **A forge mid-edit by the agent.** The remount carries `units` in
  `viewerState`; no flash of mm.
- **Kernel-trap recovery** is an in-sandbox remount and carries it too.
- **Preview mode** (forge page, embed card, landing hero) has no panel. Its
  handle chips stay mm in v1.
- **Stale partforge in an open tab**: the stale-tab guard already covers a
  tab older than the docs; the units messages are optional-chained on every
  hop, so an older sandbox ignores them.

## 7. Later, not in v1

1. **Tell the agent.** One manifest line (`Display units: in`) so replies and
   new control descriptions use inches and hardware suggestions lean imperial.
   It changes what every turn is told, so it needs its own eval.
2. **A forge's preferred display unit** (decision 3).
3. **The Download dialog** defaulting its custom sheet unit from the
   preference.
4. **Preview-mode chips** following the preference (`SHOW_PREVIEW` gains an
   optional `units`).
5. **Fractional display** to the nearest 1/64 for woodworking.

## 8. Testing

- partforge unit tests: round trip mm → in → mm on a grid of values; fraction
  parsing; the no-edit-no-commit rule; a unit switch firing no commit; `°`
  and `%` controls untouched; measure mode and panel agreeing after one
  switch.
- Cloud unit tests: the preference module; the `pfc-units` validator; both
  sticky tables replaying it; a carried state beating the seed.
- One sandbox smoke on the production bundle: switch to inches, type `3/4`,
  assert the committed param is `19.05` and the saved `defaults` literal
  holds `19.05`.
- By hand on a phone: the inch box's keyboard has a decimal point and a
  slash.

## 9. Decisions for Scott

1. **Display only, or inch-native forges?** DECIDED 2026-11-20: display only
   (approach A).
2. **Decimal or fractional inches?** Recommended: show decimals to 3 places,
   accept fractions when typed. Fractional display later if woodworkers ask.
3. **Whose choice is it?** Recommended: the viewer's, one setting per browser
   for all forges. The alternative adds an author hint (`meta.units: "in"`
   becoming "open me in inches unless the viewer chose otherwise"), which
   would suit a forge built around 3/4 in plywood but gives `meta.units` a
   meaning the agent would need teaching.
4. **First-visit default.** Recommended: mm for everyone, since the agent and
   every description speak mm. The alternative is inches for a US browser
   locale.
5. **Should the agent be told the viewer's unit in v1?** Recommended: no,
   measure it separately (section 7, item 1).

## 10. Left to the builder

- The switch's exact markup and placement in the rail header, and its
  tooltip.
- Whether `units.js` also covers `mm²`/`mm³` readouts if it falls out cheaply.
- The inch box's width and how a too-long value truncates.
- The partforge version number and the split of the partforge work into
  commits.

## 11. Size and order

Two pull requests. partforge first: one new module, five readers converted,
measure mode re-pointed, the mount option and viewer-state key, the rail
switch, docs and tests. Then a small cloud PR: the preference module, two
protocol messages, the bump and the regenerated prompts. No migration, no
server change, no privacy-policy change (a display preference in local
storage, like the theme).
