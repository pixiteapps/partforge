# Display Units (mm / in) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can switch the control panel, readouts, handle readouts and measure mode between millimetres and inches, while the forge, its saved settings and the agent stay in millimetres.

**Architecture:** partforge gains one shared units state per mount and converts at each widget's edge; `params` never leave millimetres. The state rides `getViewerState().units`, so the remount every edit performs keeps it. partforge-cloud remembers the choice in local storage and seeds each mount with it, the way it does the view style.

**Tech Stack:** partforge (plain ES modules, vitest, DOM widgets), partforge-cloud (Vite/React, vitest, Playwright smoke).

**Spec:** `docs/superpowers/specs/2026-11-20-display-units-design.md` (in partforge-cloud). Read it first.

**Two repositories, two pull requests, in this order:**

- **Part A** is in the `partforge` repo. Paths in Part A are relative to that repo. The local checkout at `~/Documents/Docs/pixite/code/partforge` is far behind (0.163.1); start from a fresh worktree of `origin/main`. This plan was written against 0.192.0 as installed in partforge-cloud's `node_modules`.
- **Part B** is in `partforge-cloud` and starts only after Part A is published.

## Global Constraints

- `params`, `defaults`, `min`/`max`/`step`/`ticks`/`recommended`, every tool result and every chat marker stay millimetres. Only shown and typed text converts.
- A control or readout converts only when its `unit` is exactly the string `"mm"`. `"°"`, `"%"`, `"mm²"`, `""` and a missing unit never convert.
- Unit ids are exactly `"mm"` and `"in"`. Anything else, anywhere, is ignored and treated as `"mm"`; nothing throws.
- 1 in = 25.4 mm. Inches to mm rounds to 4 decimals of a millimetre. Inches display to 3 decimals with trailing zeros trimmed.
- A unit switch changes no parameter and fires neither `onChange`, `onCommit`, `onParamsCommit` nor a build.
- In millimetre mode every widget behaves exactly as it does today (same input type, same text). Existing tests must pass unchanged.
- App storage key: `pfc.units`, one key for editor and viewer, written only when the user picks. Messages: `pfc-units` (down, sticky) and `pfc-units-changed` (up).
- partforge-cloud app code never imports `"partforge"`; shared constants are hand-copied into `src/sandbox/protocol.js`.
- Every hop the app makes into the runtime is optional-chained, so an older sandbox ignores it.
- No Claude attribution on anything that leaves the repo as Scott's; commit trailers follow the repo's own rules.

## Review Focus

1. **A box focused and left without typing.** 12.5 mm shows as `0.492`; leaving the box must not commit 12.4968. Expected: nothing is written, no commit. Test in Task A2.
2. **A decimal comma.** `0,75` typed into the inch box must mean 0.75, not 0 (`parseFloat` reads 0). Test in Task A1.
3. **Partial or bad text** (`3/`, `1/0`, `abc`, empty). Expected: the live parameter does not move while typing, and the box reverts on commit. Tests in Tasks A1 and A2.
4. **A unit switch during an uncommitted slider drag.** Expected: the drag still commits exactly once, by its own `change`; the switch commits nothing. Test in Task A2.
5. **Junk where a unit id is expected**: `viewerState.units` of `"ft"` or `5`, local storage holding `"inches"`. Expected: millimetres, no throw. Tests in Tasks A4 and B1.

---

# Part A: partforge

### Task A1: The units module

**Files:**
- Create: `src/framework/units.js`
- Test: `test/framework/units.test.js`

**Interfaces:**
- Produces:
  - `UNIT_IDS: readonly ["mm", "in"]`, `MM_PER_IN = 25.4`
  - `isUnitId(v: unknown): boolean`
  - `convertsUnit(unit: unknown): boolean` (true only for `"mm"`)
  - `toDisplay(mm: number, units: string): number`
  - `fromDisplay(value: number, units: string): number` (mm, rounded to 1e-4)
  - `formatLength(mm: number, units: string): string`
  - `parseLength(text: string, units: string): number | null` (mm)
  - `unitLabel(unit: string | undefined, units: string): string | undefined` (the active unit id for a converting unit, else `unit` unchanged)
  - `createUnitsState(initial?: unknown): { get(): "mm" | "in", set(next: unknown): boolean, onChange(cb: (u) => void): () => void }`
  - `loadUnits(): "mm" | "in" | null`, `saveUnits(u): void` (local storage key `partforge:units`, every touch in try/catch, following `loadRenderMode`'s pattern in the view style state module)

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi } from "vitest";
import { convertsUnit, toDisplay, fromDisplay, formatLength, parseLength, unitLabel, createUnitsState, isUnitId } from "../../src/framework/units.js";

describe("units", () => {
  it("converts only the exact unit mm", () => {
    expect(convertsUnit("mm")).toBe(true);
    for (const u of ["°", "%", "mm²", "MM", " mm", "", undefined, null]) expect(convertsUnit(u)).toBe(false);
  });
  it("stores exact millimetres for inch values", () => {
    expect(fromDisplay(1.5, "in")).toBe(38.1);
    expect(fromDisplay(0.75, "in")).toBe(19.05);
    expect(fromDisplay(12.5, "mm")).toBe(12.5);
  });
  it("round-trips the half-millimetre grid", () => {
    for (let mm = 0; mm <= 300; mm += 0.5) expect(fromDisplay(toDisplay(mm, "in"), "in")).toBe(mm);
  });
  it("formats inches to 3 decimals, trimmed", () => {
    expect(formatLength(12.5, "in")).toBe("0.492");
    expect(formatLength(25.4, "in")).toBe("1");
    expect(formatLength(19.05, "in")).toBe("0.75");
    expect(formatLength(20.299999999999955, "mm")).toBe("20.3");
  });
  it("parses decimals, fractions and mixed numbers in inches", () => {
    expect(parseLength("3/4", "in")).toBe(19.05);
    expect(parseLength("1 1/2", "in")).toBe(38.1);
    expect(parseLength("1/3", "in")).toBe(8.4667);
    expect(parseLength(" 0.75 ", "in")).toBe(19.05);
    expect(parseLength("0,75", "in")).toBe(19.05);
    expect(parseLength("-1/4", "in")).toBe(-6.35);
    expect(parseLength('2"', "in")).toBe(50.8);
  });
  it("refuses what is not a length", () => {
    for (const t of ["", "abc", "3/", "1/0", "1 2", "1/2/3", "1.5.2", "1,5,2"]) expect(parseLength(t, "in")).toBeNull();
    expect(parseLength("3/4", "mm")).toBeNull();
    expect(parseLength("12,5", "mm")).toBe(12.5);
  });
  it("labels a converting unit with the active unit", () => {
    expect(unitLabel("mm", "in")).toBe("in");
    expect(unitLabel("°", "in")).toBe("°");
    expect(unitLabel(undefined, "in")).toBeUndefined();
  });
  it("holds one unit and reports real changes only", () => {
    const s = createUnitsState("ft");
    expect(s.get()).toBe("mm");
    const cb = vi.fn();
    const off = s.onChange(cb);
    expect(s.set("mm")).toBe(false);
    expect(s.set(5)).toBe(false);
    expect(s.set("in")).toBe(true);
    expect(cb).toHaveBeenCalledExactlyOnceWith("in");
    off(); s.set("mm");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(isUnitId("in")).toBe(true);
  });
});
```

- [ ] **Step 2: Run `npx vitest run test/framework/units.test.js`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/framework/units.js`** with the interface above. `parseLength` uses one anchored pattern per form (decimal; `a/b`; `w a/b`), accepts one comma as the decimal point, and strips one trailing `"` or `in` in inch mode. No dependency on the DOM.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Commit** (`Add the display-units module`).

### Task A2: Numeric widget, panel wiring and the rail switch

**Files:**
- Modify: `src/framework/panel/widgets/numeric.js`
- Modify: `src/framework/panel/render.js` (`buildControls`, including its sub-panel recursion near line 67)
- Modify: the stylesheet that holds the rail's `.slider .unit` rule (find with `grep -rn "\.unit" src/framework/*.css`)
- Test: `test/framework/panel/widgets/numeric.test.js` (create if absent), `test/framework/panel/render.test.js`

**Interfaces:**
- Consumes: Task A1's whole interface.
- Produces:
  - `makeNumeric(node, params, { onChange, onCommit, info, units })`: `units` is a units state, optional. Absent means millimetres.
  - `buildControls(root, parameters, params, onDirty, onCommit, opts)`: reads `opts.units` (a units state, optional), hands it to every numeric and readout widget and to nested `buildControls` calls, re-syncs every widget when it changes, and unsubscribes on the panel's existing teardown.
  - The switch: when `opts.units` is given and the tree holds at least one node with a converting unit, `buildControls` renders, as the first child of `root`, `<div class="pf-units" role="group" aria-label="Units">` holding two `<button type="button" data-units="mm|in" aria-pressed>` labelled `mm` and `in`. A click calls `opts.units.set(...)`. Only the top-level panel renders it, never a nested one.

Behaviour of the numeric widget for a node whose unit converts:

- The unit label shows `unitLabel(node.unit, units.get())`.
- The box shows `formatLength(params[key], units)`. In inch mode it is `type="text"` with `inputMode = "decimal"` and no `step` attribute; in millimetre mode it is `type="number"` exactly as today.
- Live typing and commit read `parseLength(box.value, units)`. A null result leaves `params` alone while typing and reverts the box on commit.
- The box remembers the text it last showed. A `change` whose text equals that text writes nothing and calls neither `onChange` nor `onCommit`.
- The slider is untouched: same `min`, `max`, `step`, ticks, snap, log mapping and wrap. Its `input` handler writes the box through `formatLength`.
- `paintWarn` compares millimetres, as today.
- `sync()` re-reads the unit: label, box type and box text.

- [ ] **Step 1: Write the failing widget tests.** One `it` per line, each asserting the exact values given (node: `{ key: "w", type: "slider", label: "Width", unit: "mm", min: 10, max: 50, step: 0.5 }`, `params.w = 12.5`, state from `createUnitsState("in")`):
  - shows `in` as the unit, `0.492` in the box, box `type` `"text"`, `inputMode` `"decimal"`
  - slider `min`/`max`/`step` are `"10"`/`"50"`/`"0.5"`
  - typing `3/4` then `change` sets `params.w` to `19.05` and calls `onCommit` once
  - `change` with the text untouched leaves `params.w === 12.5` and calls neither callback
  - `input` events for `3/`, then `abc`, leave `params.w === 12.5`; `change` on `abc` restores `0.492`
  - typing `3` (76.2 mm) adds the `warn` class
  - slider `input` to `20` sets `params.w` to `20` and the box to `0.787`
  - a slider `input` (uncommitted), then `units.set("mm")` and `sync()`, then the slider's `change`: `onCommit` called exactly once, and the box reads `20`
  - `units.set("mm")` then `sync()` alone calls neither callback and restores `type="number"` and `12.5`
  - a `°` node in inch mode keeps `°`, `type="number"` and its value text
  - with no `units` option the widget matches today's output
- [ ] **Step 2: Write the failing panel tests** in `render.test.js`: the switch renders once for a tree with an `mm` control and not for a tree of only `°` controls; clicking `in` sets the state and flips `aria-pressed`; a state change re-syncs a numeric widget's box; no switch without `opts.units`; a nested panel renders no second switch.
- [ ] **Step 3: Run both files.** Expected: FAIL.
- [ ] **Step 4: Implement** the widget changes, the `buildControls` wiring and the switch, plus CSS for `.pf-units` using the rail's existing token variables (two small segmented buttons, right-aligned).
- [ ] **Step 5: Run `npx vitest run test/framework/panel`.** Expected: PASS, including every pre-existing test unchanged.
- [ ] **Step 6: Commit** (`Panel: show and accept inches`).

### Task A3: Readouts, handle readouts and the value chip

**Files:**
- Modify: `src/framework/panel/widgets/readout.js`
- Modify: `src/framework/pose/handle-guides.js` (`readoutItems`, `readoutText`)
- Modify: `src/framework/pose/readout-chip.js`
- Modify: `src/framework/pose/pose-mode.js` (the `Out of reach` item near line 1351 and the two `readoutItems` call sites)
- Test: the existing tests beside each (`test/framework/pose/…`, `test/framework/panel/…`)

**Interfaces:**
- Consumes: Task A1; `opts.units` from Task A2.
- Produces:
  - `makeReadout(node, { info, units })` returning `{ el, update, sync }`; `sync()` re-renders the last value in the current unit.
  - `readoutItems(part, params, handle, units = "mm")` and `readoutText(part, params, handle, units = "mm")`. For an item whose control unit converts: `unit` is the active unit id and `text` is `formatLength(value, units)` in inch mode (the existing step-based text in millimetre mode). `value` stays millimetres. Each item gains `converts: boolean`.
  - The pose mode and the readout chip each take a `getUnits: () => "mm" | "in"` option (default returns `"mm"`), and the pose mode exposes `refreshReadout()` that re-emits the current readout.

Chip edit rules: a converting item's input shows `formatLength(item.value, units)`, is `type="text"` with `inputMode="decimal"` in inch mode, and commits through `parseLength`. The existing rule that an untouched input writes nothing stays.

- [ ] **Step 1: Write the failing tests**: a readout of `184` with unit `mm` renders `7.244 in` in inch mode and `184 mm` in millimetre mode, and `sync()` after a switch re-renders it; a `°` readout is unchanged; `readoutItems(..., "in")` gives `{ unit: "in", text: "7.244", value: 184, converts: true }` for a 184 mm control and leaves a `°` item's `unit` and `text` as today; a chip edit of `3/4` applies `19.05`; an untouched chip input applies nothing; the `Out of reach` item reads in inches.
- [ ] **Step 2: Run the touched test files.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx vitest run test/framework/pose test/framework/panel`.** Expected: PASS.
- [ ] **Step 5: Commit** (`Readouts and handle chips follow the display unit`).

### Task A4: One state per mount, measure mode, viewer state and the runtime API

**Files:**
- Modify: `src/framework/mount.js` (state creation beside the `initialMode` block near line 1046; `createMeasureMode` call near 762; `buildControls` call near 1935; pose mode and chip construction; `makeHandle`; the embedding-contract comment block)
- Modify: `src/framework/measure/measure-mode.js` (`getUnits`/`setUnits` near line 965)
- Modify: `src/framework/panel/widgets/custom.js` (the host object handed to `node.widget`)
- Test: the mount test that covers `getViewerState` (find with `grep -rln "getViewerState" test/`), `test/framework/measure/measure-controls.test.js`, the custom widget's test

**Interfaces:**
- Consumes: Tasks A1 to A3.
- Produces:
  - `mount()` creates `createUnitsState(isUnitId(viewerState?.units) ? viewerState.units : loadUnits() ?? "mm")` and passes it to `buildControls` (`opts.units`), to `createMeasureMode` (new option `units`), and as `getUnits` to the pose mode and the chip.
  - `createMeasureMode(viewer, { ..., units })`: when given, `getUnits`/`setUnits` delegate to it and a change rebuilds the labels; when absent, today's private variable. `measure-controls.js` needs no change.
  - On every change: `saveUnits(u)`, the pose mode's `refreshReadout()`, and the chip hides.
  - `runtime.getUnits(): "mm" | "in"`, `runtime.setUnits(u): void`, `runtime.onUnitsChange(cb): () => void`.
  - `runtime.getViewerState()` includes `units` only when it is not `"mm"`.
  - Custom control host object gains `units` (a getter of the current id) and `onUnitsChange(cb)`.

- [ ] **Step 1: Write the failing tests**: a mount with `viewerState: { units: "in" }` reports `getUnits() === "in"` and round-trips it through `getViewerState()`; with `units: "ft"` or `units: 5` it is `"mm"` and `getViewerState()` has no `units` key; `setUnits("in")` calls an `onUnitsChange` listener once and calls neither `onParamsCommit` nor `onBuild`; the measure mode's unit button and the panel switch move the same state in both directions; a custom widget's host reports the unit and hears a change.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Document the three runtime methods and the `viewerState.units` key in the embedding-contract comment.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** (`One display unit per mount, carried in viewer state`).

### Task A5: Docs, version, release

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`, `package.json`, the changelog the repo keeps, any generated doc index the repo's AGENTS.md names

- [ ] **Step 1:** Add a short "Display units" section to `docs/AUTHORING-PARTS.md` near the control reference: viewers can switch lengths between mm and in; `unit: "mm"` is what opts a control or readout in; part code, `defaults`, ranges and `verify` are always millimetres; descriptions are not converted, so write them unit-neutral where that is easy; a custom control may read `host.units`.
- [ ] **Step 2:** Bump the minor version (the bump rides with this PR) and add the changelog entry.
- [ ] **Step 3:** Run `npm test`, the lint script and knip. Expected: all pass.
- [ ] **Step 4:** Open a demo page (`npm run dev`, `demo.html`), switch to inches, type `3/4` into a length control, drag a slider, open measure mode and flip its button. Confirm the panel and measure labels agree and the part rebuilds only on value changes.
- [ ] **Step 5: Commit**, open the PR in the reader-friendly style Scott's instructions describe, and publish after merge.

---

# Part B: partforge-cloud

### Task B1: The preference module

**Files:**
- Create: `src/ui/unitsPreference.js`
- Modify: `src/sandbox/protocol.js` (add `export const DISPLAY_UNITS = ["mm", "in"];`)
- Test: `tests/unit/units-preference.test.js`

**Interfaces:**
- Produces: `UNITS_KEY = "pfc.units"`; `loadUnits(storage = globalThis.localStorage): "mm" | "in" | null` (null means the user never picked); `saveUnits(units, storage = globalThis.localStorage): void`. Model the file on `src/ui/appearancePreference.js`.

- [ ] **Step 1: Write the failing test**: empty storage gives `null`; `saveUnits("in")` then `loadUnits()` gives `"in"`; stored `"inches"` gives `null`; `saveUnits("ft")` writes nothing; a storage whose `getItem`/`setItem` throw gives `null` and does not throw.
- [ ] **Step 2: Run `npx vitest run tests/unit/units-preference.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task B2: Protocol, sandbox host, mount manager and client

**Files:**
- Modify: `src/sandbox/protocol.js`, `src/sandbox/host.js`, `src/sandbox/mountManager.js`, `src/viewer/sandboxClient.js`
- Test: create `tests/unit/sandbox-protocol-units.test.js`, `tests/unit/mountmanager-units.test.js`, `tests/unit/sandbox-client-units.test.js`, each modelled on its `-appearance` sibling

**Interfaces:**
- Consumes: `DISPLAY_UNITS` (B1); partforge's `runtime.getUnits/setUnits/onUnitsChange` and `viewerState.units` (Part A).
- Produces:
  - `UNITS_TYPE = "pfc-units"`: `{ type, units }`, app to sandbox, sticky. `validUnits(data): boolean`.
  - `UNITS_CHANGED_TYPE = "pfc-units-changed"`: `{ type, units }`, sandbox to app. `sanitizeUnitsChanged(data): "mm" | "in" | null`.
  - `mountViewerState(carried, appearance, { partEnvironment, units })`: a carried state still wins outright. With none, the result gains `units` when `units === "in"`; with no appearance and `units === "in"` it returns `{ units: "in" }` instead of `null`.
  - Mount manager: `sticky.units` (default `null`); `setUnits(u)` stores it and, when a full viewer is mounted, calls `runtime.setUnits?.(u)`; each mount subscribes `runtime.onUnitsChange?.(…)`, which writes `sticky.units` and posts `pfc-units-changed`, and unsubscribes at teardown. Like the appearance, it only seeds a mount with no carried state. Preview mounts ignore it.
  - `host.js`: dispatch `pfc-units` behind the existing parent-window gate.
  - Sandbox client: `sticky.units`, re-sent on boot after `pfc-appearance`; `setUnits(u)`; `onUnitsChange(cb)`; the up-event rewrites `sticky.units` and is never treated as an RPC result.

- [ ] **Step 1: Write the failing tests**, mirroring the appearance trio: the validator accepts `{type, units: "in"}` and refuses `"ft"`, a number and a missing field; the sanitizer returns `null` for junk; `mountViewerState(null, null, { units: "in" })` is `{ units: "in" }`; `mountViewerState(null, null, { units: "mm" })` is `null`; a carried state without `units` is returned as is even when `units` is `"in"`; a runtime `onUnitsChange("in")` posts the up-event and a reboot replays `pfc-units` with `"in"`; a message from a non-parent window is dropped.
- [ ] **Step 2: Run the three files.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npx vitest run tests/unit/sandbox-protocol-units.test.js tests/unit/mountmanager-units.test.js tests/unit/sandbox-client-units.test.js tests/unit/mountmanager-appearance.test.js tests/unit/sandbox-host.test.js`.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task B3: Wire the preference into both screens

**Files:**
- Modify: `src/ui/ViewerHost.jsx` (beside the `setAppearance` / `onAppearanceChange` lines near 72)
- Test: `tests/unit/viewer-host-units.test.jsx`, modelled on `viewer-host-appearance.test.jsx`

**Interfaces:**
- Consumes: `loadUnits`, `saveUnits` (B1); `mm.setUnits`, `mm.onUnitsChange` (B2).

- [ ] **Step 1: Write the failing test**: with `pfc.units` = `in`, the host calls `setUnits("in")` on mount for both the editor and the viewer screen; with nothing stored it calls nothing; an `onUnitsChange("in")` from either screen writes `pfc.units`; the listener is removed on unmount.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement**, optional-chaining both calls.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task B4: Bump, prompts, docs and the smoke test

**Files:**
- Modify: `package.json`, `package-lock.json`, everything `npm run docs:generate && npm run prompt:generate` rewrites under `prompts/`
- Modify: `AGENTS.md` (the partforge version-floor list in "Viewer + sandbox", and a short "display units" rule), `docs/agents/viewer-and-sandbox.md` (a "Display units" section)
- Create: `tests/smoke/display-units.spec.js`; add it to CI's `smoke-sandbox` job

- [ ] **Step 1:** Pin the published partforge version and run `npm install`, then `npm run docs:generate && npm run prompt:generate`. Read the prompt diff: it should add only the Display units section and whatever else the releases between 0.192.0 and the new version changed.
- [ ] **Step 2: Write the smoke test** against a production build with `?fixture=demo`: click the rail's `in` button; type `3/4` into the first length control and press Enter; assert the committed param is `19.05`; reload the sandbox with the same sticky state and assert the box reads `0.75`; switch back to `mm` and assert it reads `19.05`.
- [ ] **Step 3:** Add the floor entry to AGENTS.md in the list's own form: the new version, "display units", and what happens below it (no switch, millimetres everywhere, the two messages ignored, nothing errors). Add the rules: `params` and every saved value stay millimetres; `pfc.units` is one shared key; `pfc-units` seeds only, a carried state wins; the agent is not told the unit.
- [ ] **Step 4:** Run `npm test`, `npm run build` and the new smoke. Expected: all pass. `npm ls partforge` shows one version.
- [ ] **Step 5:** On the PR's Preview, in the editor: switch to inches, type a fraction, confirm the forge saves and the chat's panel-settings marker shows millimetres; let the agent apply an edit and confirm the panel is still in inches; open another forge and the read-only viewer and confirm both open in inches; check the inch box's keyboard on a phone has a decimal point and a slash.
- [ ] **Step 6: Commit** and open the PR.

---

## Not in this plan

Spec section 7: telling the agent the viewer's unit, a forge's preferred display unit, the Download dialog following the preference, preview-mode chips, and fractional display. Each is its own later change.
