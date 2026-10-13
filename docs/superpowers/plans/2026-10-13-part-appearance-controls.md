# Part Appearance Controls (partforge half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a viewer user change a sub-part's material, colour and finish, fade it, or hide it, live and without a rebuild, from a Parts section inside the View style popover, with the overrides carried across remounts in `viewerState` and exposed on the runtime handle for a host to drive and persist.

**Architecture:** A per-sub-part override map (appearance keys merged over the authored `display`; `hidden` and `opacity` as viewer-only "viewing" keys) lives in `createViewer`, which already swaps materials without geometry work (`rebaseSubMaterial`). Pure decisions (sanitizing a patch, merging, pruning, the visibility arithmetic, the row model) live in two new import-free modules so they are unit-tested without WebGL; the viewer and `mount` wire them. The popover gains a Parts list and a second "card" page; `mount` exposes the hops, restores the map from `viewerState`, and recomputes layer-line frames lazily when a live material change needs one.

**Tech Stack:** three.js (viewer), vanilla DOM (popover), vitest + happy-dom (tests; `createViewer` needs WebGL and is never instantiated in a test), `materials.html` for the manual check.

**Spec:** `docs/superpowers/specs/2026-10-13-part-appearance-controls-design.md` (sections A.1–A.7 are this plan; B is the cloud half, done after this publishes).

## Global Constraints

- Version bump rides with the PR (AGENTS.md "Releasing"). `origin/main` is 0.147.0 and open PR #273 (routed parts) carries 0.148.0, so this branch bumps to **0.149.0**; whichever of the two merges second re-bumps past the other.
- The appearance override keys are exactly `DISPLAY_KEYS` minus `opacity` (`color`, `material`, `roughness`, `metalness`, `clearcoat`, `clearcoatRoughness`, `anisotropy`, `textureScale`); the viewing keys are exactly `hidden` (boolean) and `opacity` (0.05–1). Nothing else is ever stored.
- Viewing keys never reach `effective()`, any material read, `printColor`, exports, lint or `declaresMaterials`.
- Agent captures (`captureCanonicalViews`/`captureViews`, `renderViews`) and `captureCurrent({ includeHidden: true })` ignore hidden and user opacity; the live scene, plain `captureCurrent`, and `renderStyleThumbnail` honour them.
- The popover's existing contract is unchanged: appended to the stage, placed above `#viewbar` right-aligned, closes on outside pointerdown / Escape / host hidden; `attachViewStyleControls(viewer, { stage, toolbar, anchor })` with no `parts` option renders exactly what it renders today (the cloud's `sandbox-scaffold.test.js` passes a viewer stub with none of the new methods).
- Style grid becomes `repeat(5, 1fr)`, 6px gap, labels 10.5px.
- Copy, exact: section headings "Style" and "Parts"; button "Show all"; card footer per save state: `saved` → "Material and colour are saved to this forge. See-through and hiding are only on this screen." / "Reset to authored"; `screen-only` → "Only on this screen" / "Reset"; `blocked` → "This part's look is set by code. Ask the assistant to change it." / "Reset"; untintable note "<Label> has its own colour. Pick a tintable preset to colour it."; the no-material tile is labelled "CAD"; the see-through control is labelled "See-through".
- Every new runtime hop ignores an unknown sub-part name (returns `null`/`false`), never throws.
- No new dependency. Pure modules import nothing outside `src/framework/materials/` and `sub-part-views.js`/`part-model.js` (lint purity tests scan for this).

## Review Focus

1. A patch that names a sub-part the part does not declare, a `material` that is not a string, a `color` outside 0..0xffffff, an override outside its range, or `opacity: 0`: nothing stored, nothing thrown, ranges clamped, `opacity` floored at 0.05. Pinned in Task 1's sanitize tests.
2. A `viewerState.display` carried from a part whose sub-part was renamed or removed by the edit: the stale entry is dropped and the mount proceeds. Pinned in Task 1's prune tests and Task 4's restore test.
3. A sub-part hidden while an animation plays, then shown again: it reappears where the animation says, and the animation's own reset does not clear the hide. Pinned in Task 1's visibility tests (`anim` and `user` are independent inputs) and Task 3's manual check.
4. Entering realistic mode after a live material change: `physicalFor` must not hand back the cached material built from the authored display. Pinned in Task 3 (the override swap drops the `physicalMats` entry; manual check in `materials.html`).
5. Show all with nothing hidden, Reset on a part with no override, and a card opened for a sub-part not in the active view: each is a no-op that renders a sane list. Pinned in Task 5/6 popover tests.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/framework/materials/overrides.js` (new) | Pure: key sets, `sanitizeDisplayPatch`, `mergeOverride`, `effectiveDisplay`, `pruneOverrides`, `subPartVisibility`. No imports beyond `resolve.js`. |
| `src/framework/sub-part-list.js` (new) | Pure: `subPartRows(part, { view, params, overrides })` — the row model the popover, `listSubParts()` and a host render from. |
| `src/framework/viewer.js` (modify) | Holds the override map; `setSubPartDisplay`, `getSubPartDisplayState`, `getDisplayOverrides`, `clearSubPartDisplay`, `onDisplayChange`; honours hidden/opacity in `applySubOpacity`; `includeHidden` on the capture paths. |
| `src/framework/mount.js` (modify) | Handle hops; `viewerState.display` restore; lazy layer-line frames; wires the popover's `parts` option. |
| `src/framework/parts-list.js` (new) | DOM: the Parts section (rows, eyes, swatches, Show all). |
| `src/framework/appearance-card.js` (new) | DOM: the card page (header, see-through, tiles, colour, finish, footer). |
| `src/framework/view-style-controls.js` (modify) | Mounts the two above under the Style grid; page switching with Back; `openCard(name)`. |
| `src/framework/app.css` (modify) | 5-column grid; styles for the list and card. |
| `docs/AUTHORING-PARTS.md`, `package.json` (modify) | Runtime docs; 0.149.0. |

---

### Task 1: The pure override model

**Files:**
- Create: `src/framework/materials/overrides.js`
- Test: `test/display-overrides.test.js`

**Interfaces:**
- Consumes: `OVERRIDE_RANGES`, `DISPLAY_KEYS`, `resolveMaterial` from `src/framework/materials/resolve.js`; `PRESETS` from `presets.js`.
- Produces (all exported, all pure):
  - `APPEARANCE_OVERRIDE_KEYS: string[]`, `VIEWING_KEYS = ["hidden", "opacity"]`, `MIN_USER_OPACITY = 0.05`
  - `sanitizeDisplayPatch(patch) → object` (only known keys; `null` means "clear this key"; bad values dropped; numbers clamped)
  - `mergeOverride(current | null, patch) → object | null` (`null` when nothing is left)
  - `effectiveDisplay(authored, override) → object` (appearance keys only, merged over authored)
  - `isAppearanceNoop(authored, override) → boolean`
  - `pruneOverrides(map, part) → object` (drops unknown names, strips no-op appearance keys, drops empties)
  - `subPartVisibility({ shown, anim, user, hidden, renderMode, staticOpacity }) → { meshVisible, linesVisible, fade }` where `fade` is `null` (no fade clone) or the clone's opacity.

- [ ] **Step 1: Write the failing tests**

```js
// test/display-overrides.test.js
import { describe, it, expect } from "vitest";
import {
  APPEARANCE_OVERRIDE_KEYS, VIEWING_KEYS, MIN_USER_OPACITY,
  sanitizeDisplayPatch, mergeOverride, effectiveDisplay, isAppearanceNoop, pruneOverrides, subPartVisibility,
} from "../src/framework/materials/overrides.js";
import { DISPLAY_KEYS } from "../src/framework/materials/resolve.js";

describe("key sets", () => {
  it("appearance keys are DISPLAY_KEYS minus opacity; viewing keys are hidden and opacity", () => {
    expect(APPEARANCE_OVERRIDE_KEYS).toEqual(DISPLAY_KEYS.filter((k) => k !== "opacity"));
    expect(VIEWING_KEYS).toEqual(["hidden", "opacity"]);
  });
});

describe("sanitizeDisplayPatch", () => {
  it("keeps known keys, clamps ranges, floors opacity, drops junk", () => {
    expect(sanitizeDisplayPatch({
      material: "brass", color: 0xb3261e, roughness: 2, metalness: -1, textureScale: 0.001,
      opacity: 0, hidden: 1, bogus: 3, clearcoat: "x",
    })).toEqual({ material: "brass", color: 0xb3261e, roughness: 1, metalness: 0, textureScale: 0.01, opacity: MIN_USER_OPACITY, hidden: true });
  });
  it("keeps an unknown material id (resolve.js falls back; lint names it) and drops a non-string one", () => {
    expect(sanitizeDisplayPatch({ material: "unobtainium" })).toEqual({ material: "unobtainium" });
    expect(sanitizeDisplayPatch({ material: 7 })).toEqual({});
  });
  it("drops a colour outside 0..0xffffff and a non-integer", () => {
    expect(sanitizeDisplayPatch({ color: 0x1000000 })).toEqual({});
    expect(sanitizeDisplayPatch({ color: 1.5 })).toEqual({});
  });
  it("passes null through as 'clear' for every key, and reads opacity >= 1 as clear", () => {
    expect(sanitizeDisplayPatch({ material: null, color: null, hidden: null, opacity: 1 })).toEqual({ material: null, color: null, hidden: null, opacity: null });
  });
  it("returns {} for a non-object", () => {
    expect(sanitizeDisplayPatch(null)).toEqual({});
    expect(sanitizeDisplayPatch("x")).toEqual({});
  });
});

describe("mergeOverride", () => {
  it("merges, clears with null, and returns null when empty", () => {
    expect(mergeOverride(null, { material: "oak" })).toEqual({ material: "oak" });
    expect(mergeOverride({ material: "oak", hidden: true }, { material: null })).toEqual({ hidden: true });
    expect(mergeOverride({ hidden: true }, { hidden: false })).toBeNull();
    expect(mergeOverride({ opacity: 0.5 }, { opacity: null })).toBeNull();
  });
  it("hidden: false and opacity 1 are clears, never stored", () => {
    expect(mergeOverride(null, { hidden: false })).toBeNull();
    expect(mergeOverride({ material: "oak" }, { opacity: 1 })).toEqual({ material: "oak" });
  });
});

describe("effectiveDisplay", () => {
  it("merges appearance keys over the authored display and never carries viewing keys", () => {
    const authored = { material: "pla-print", color: 0x112233, opacity: 0.3 };
    expect(effectiveDisplay(authored, { material: "oak", hidden: true, opacity: 0.5 }))
      .toEqual({ material: "oak", color: 0x112233, opacity: 0.3 });
    expect(effectiveDisplay(undefined, null)).toEqual({});
    expect(effectiveDisplay(undefined, { color: 0xff0000 })).toEqual({ color: 0xff0000 });
  });
});

describe("isAppearanceNoop / pruneOverrides", () => {
  const part = { parts: { lid: { display: { material: "oak", color: 0x112233 } }, body: {} } };
  it("is a noop when every appearance key equals the authored value", () => {
    expect(isAppearanceNoop(part.parts.lid.display, { material: "oak", hidden: true })).toBe(true);
    expect(isAppearanceNoop(part.parts.lid.display, { material: "brass" })).toBe(false);
    expect(isAppearanceNoop(undefined, { color: 0x112233 })).toBe(false);
  });
  it("drops unknown names, strips no-op appearance keys, keeps viewing keys, drops empties", () => {
    expect(pruneOverrides({
      lid: { material: "oak", color: 0x112233, hidden: true },
      body: { material: "brass" },
      gone: { material: "oak" },
      base: { color: 0x112233 },
    }, part)).toEqual({ lid: { hidden: true }, body: { material: "brass" } });
  });
  it("sanitizes what it keeps (a carried token from an older host may be malformed)", () => {
    expect(pruneOverrides({ body: { roughness: 9, bogus: 1 } }, part)).toEqual({ body: { roughness: 1 } });
    expect(pruneOverrides(null, part)).toEqual({});
  });
});

describe("subPartVisibility", () => {
  const base = { shown: true, anim: undefined, user: undefined, hidden: false, renderMode: "cad", staticOpacity: 1 };
  it("shown and untouched: visible, lines in cad only, no fade", () => {
    expect(subPartVisibility(base)).toEqual({ meshVisible: true, linesVisible: true, fade: null });
    expect(subPartVisibility({ ...base, renderMode: "realistic" })).toEqual({ meshVisible: true, linesVisible: false, fade: null });
  });
  it("hidden wins over everything", () => {
    expect(subPartVisibility({ ...base, hidden: true, anim: 1, user: 1 })).toEqual({ meshVisible: false, linesVisible: false, fade: null });
  });
  it("not shown is not visible even with a fade", () => {
    expect(subPartVisibility({ ...base, shown: false, user: 0.5 })).toEqual({ meshVisible: false, linesVisible: false, fade: null });
  });
  it("anim 0 hides; anim and user multiply with the static opacity", () => {
    expect(subPartVisibility({ ...base, anim: 0 })).toEqual({ meshVisible: false, linesVisible: false, fade: null });
    expect(subPartVisibility({ ...base, anim: 0.5, user: 0.5, staticOpacity: 0.4 })).toEqual({ meshVisible: true, linesVisible: true, fade: 0.1 });
    expect(subPartVisibility({ ...base, user: 0.25 })).toEqual({ meshVisible: true, linesVisible: true, fade: 0.25 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/display-overrides.test.js`
Expected: FAIL — `Failed to resolve import "../src/framework/materials/overrides.js"`.

- [ ] **Step 3: Write the module**

```js
// src/framework/materials/overrides.js
// The viewer-side override of a sub-part's appearance, and the viewing state
// beside it. Pure: no three, no DOM (lint purity scans this folder).
//
// Two kinds of key, deliberately separate (spec A.1):
//   - APPEARANCE keys merge over the authored `display` into effective(), which
//     every material read uses — CAD, realistic, the throwaway thumbnail scene.
//     A host may persist these into source.
//   - VIEWING keys (`hidden`, `opacity`) are how the user is LOOKING. They never
//     reach effective(), exports, lint or declaresMaterials, and no host saves
//     them. `opacity` MULTIPLIES an authored display.opacity (the arithmetic
//     animation opacity already uses), so a ghost can be faded further but not
//     made solid from here.
import { DISPLAY_KEYS, OVERRIDE_RANGES } from "./resolve.js";

export const APPEARANCE_OVERRIDE_KEYS = DISPLAY_KEYS.filter((k) => k !== "opacity");
export const VIEWING_KEYS = ["hidden", "opacity"];
export const MIN_USER_OPACITY = 0.05;

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isColor = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

// Only known keys survive; `null` is the "clear this key" value and survives
// as-is. Bad values are DROPPED (not clamped) where clamping would invent a
// choice: a non-string material, a colour out of range. Numeric overrides clamp
// to OVERRIDE_RANGES exactly as resolve.js clamps authored ones. `opacity`
// floors at MIN_USER_OPACITY and reads >= 1 as a clear; `hidden` is coerced to
// a boolean.
export function sanitizeDisplayPatch(patch) {
  if (!isObject(patch)) return {};
  const out = {};
  for (const [key, v] of Object.entries(patch)) {
    if (v === null) {
      if (APPEARANCE_OVERRIDE_KEYS.includes(key) || VIEWING_KEYS.includes(key)) out[key] = null;
      continue;
    }
    if (key === "material") { if (typeof v === "string" && v.length > 0) out.material = v; continue; }
    if (key === "color") { if (isColor(v)) out.color = v; continue; }
    if (key === "hidden") { out.hidden = !!v; continue; }
    if (key === "opacity") {
      if (!finite(v)) continue;
      out.opacity = v >= 1 ? null : Math.max(MIN_USER_OPACITY, v);
      continue;
    }
    if (key in OVERRIDE_RANGES) {
      if (!finite(v)) continue;
      const [lo, hi] = OVERRIDE_RANGES[key];
      out[key] = Math.min(hi, Math.max(lo, v));
    }
  }
  return out;
}

// Merge a SANITIZED patch over the current override. `hidden: false` and
// `opacity: null` are clears like any other null. Returns null when nothing is
// left, so a Map entry can be deleted rather than kept empty.
export function mergeOverride(current, patch) {
  const next = { ...(isObject(current) ? current : {}) };
  for (const [key, v] of Object.entries(patch ?? {})) {
    if (v === null || (key === "hidden" && v === false)) delete next[key];
    else next[key] = v;
  }
  return Object.keys(next).length ? next : null;
}

// The display every material read sees: authored, with the override's
// APPEARANCE keys on top. Viewing keys are never in it.
export function effectiveDisplay(authored, override) {
  const out = isObject(authored) ? { ...authored } : {};
  if (!isObject(override)) return out;
  for (const key of APPEARANCE_OVERRIDE_KEYS) if (key in override) out[key] = override[key];
  return out;
}

export function isAppearanceNoop(authored, override) {
  if (!isObject(override)) return true;
  const a = isObject(authored) ? authored : {};
  return APPEARANCE_OVERRIDE_KEYS.every((key) => !(key in override) || override[key] === a[key]);
}

// A carried map, made safe for THIS part (spec A.4): names the part no longer
// declares go; appearance keys that now equal the authored value go (an owner's
// saved change self-cleans this way); every kept entry is re-sanitized, since
// the token came from a host; empties go.
export function pruneOverrides(map, part) {
  const out = {};
  if (!isObject(map)) return out;
  for (const [name, raw] of Object.entries(map)) {
    const sp = part?.parts?.[name];
    if (!sp) continue;
    const clean = mergeOverride(null, sanitizeDisplayPatch(raw));
    if (!clean) continue;
    const authored = isObject(sp.display) ? sp.display : {};
    for (const key of APPEARANCE_OVERRIDE_KEYS) if (key in clean && clean[key] === authored[key]) delete clean[key];
    if (Object.keys(clean).length) out[name] = clean;
  }
  return out;
}

// The one visibility decision viewer.js's applySubOpacity makes, as a pure
// function of its inputs. `anim` is the animation driver's opacity (undefined =
// none), `user` the viewing override's (undefined = none). `fade` is null when
// the mesh should sit on its base material, else the fade clone's opacity.
export function subPartVisibility({ shown, anim, user, hidden, renderMode, staticOpacity = 1 }) {
  const off = { meshVisible: false, linesVisible: false, fade: null };
  if (!shown || hidden) return off;
  const a = anim === undefined ? 1 : anim;
  const u = user === undefined ? 1 : user;
  const v = a * u;
  if (v <= 0) return off;
  const linesVisible = renderMode === "cad";
  if (v >= 1) return { meshVisible: true, linesVisible, fade: null };
  return { meshVisible: true, linesVisible, fade: staticOpacity * v };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/display-overrides.test.js`
Expected: PASS (all).

- [ ] **Step 5: Run the purity and layering guards**

Run: `npx vitest run test/lint-purity.test.js test/worker-layering.test.js`
Expected: PASS (the new module imports only `resolve.js`).

- [ ] **Step 6: Commit**

```bash
git add src/framework/materials/overrides.js test/display-overrides.test.js
git commit -m "materials: pure display override model (sanitize, merge, effective, prune, visibility)"
```

---

### Task 2: The sub-part row model

**Files:**
- Create: `src/framework/sub-part-list.js`
- Test: `test/sub-part-list.test.js`

**Interfaces:**
- Consumes: `effectiveDisplay` (Task 1); `viewSubParts` from `part-model.js`; `partLabel` from `export-select.js`; `resolveMaterial`, `NO_MATERIAL_COLOR` from `materials/resolve.js`; `PRESETS` from `materials/presets.js`.
- Produces: `subPartRows(part, { view, params, overrides }) → Row[]` with `Row = { name, label, inView, hidden, opacity, effective, color, materialLabel, tintable, overridden }`. Rows are in `Object.keys(part.parts)` order, every sub-part included (`inView` says which are in the view). `color` is the swatch colour (the resolved preset params colour when a known material is named, else the explicit `color`, else `NO_MATERIAL_COLOR`); `materialLabel` is the preset's label, `"unknown"` for an unknown id, `null` for none; `tintable` is true for no material or a tintable preset; `overridden` is true when the override holds any appearance key.

- [ ] **Step 1: Write the failing tests**

```js
// test/sub-part-list.test.js
import { describe, it, expect } from "vitest";
import { subPartRows } from "../src/framework/sub-part-list.js";
import { NO_MATERIAL_COLOR } from "../src/framework/materials/resolve.js";
import { PRESETS } from "../src/framework/materials/presets.js";

const part = {
  defaults: { withFeet: true },
  parts: {
    body: { label: "Body", views: { assembly: true, body: true }, display: { material: "powder-coat", color: 0x3a3f47 } },
    lid: { label: "Lid", views: { assembly: true }, display: { material: "brass" } },
    window: { views: { assembly: true }, display: { color: 0xbfe0f5 } },
    feet: { label: "Feet", views: { assembly: true }, enabled: (p) => p.withFeet },
    odd: { label: "Odd", views: { assembly: true }, display: { material: "unobtainium" } },
  },
  views: { assembly: {}, body: {} },
};

describe("subPartRows", () => {
  it("lists every sub-part in definition order and says which are in the view", () => {
    const rows = subPartRows(part, { view: "body", params: part.defaults, overrides: {} });
    expect(rows.map((r) => [r.name, r.inView])).toEqual([["body", true], ["lid", false], ["window", false], ["feet", false], ["odd", false]]);
  });
  it("respects enabled() through viewSubParts", () => {
    const rows = subPartRows(part, { view: "assembly", params: { withFeet: false }, overrides: {} });
    expect(rows.find((r) => r.name === "feet").inView).toBe(false);
  });
  it("labels fall back to the key; swatch colour, material label and tintable come from the EFFECTIVE display", () => {
    const rows = subPartRows(part, { view: "assembly", params: part.defaults, overrides: { lid: { material: "anodized-aluminum", color: 0xb3261e } } });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.window.label).toBe("window");
    expect(byName.body).toMatchObject({ color: 0x3a3f47, materialLabel: PRESETS["powder-coat"].label, tintable: true, overridden: false });
    expect(byName.lid).toMatchObject({ color: 0xb3261e, materialLabel: PRESETS["anodized-aluminum"].label, tintable: true, overridden: true });
    expect(byName.window).toMatchObject({ color: 0xbfe0f5, materialLabel: null, tintable: true });
    expect(byName.feet).toMatchObject({ color: NO_MATERIAL_COLOR, materialLabel: null, tintable: true });
    expect(byName.odd).toMatchObject({ materialLabel: "unknown", tintable: true });
  });
  it("an untintable preset with no explicit colour shows the preset colour and tintable: false", () => {
    const rows = subPartRows(part, { view: "assembly", params: part.defaults, overrides: {} });
    const lid = rows.find((r) => r.name === "lid");
    expect(lid.color).toBe(PRESETS.brass.color);
    expect(lid.tintable).toBe(false);
  });
  it("carries the viewing keys and the effective display", () => {
    const rows = subPartRows(part, { view: "assembly", params: part.defaults, overrides: { body: { hidden: true, opacity: 0.5 } } });
    const body = rows.find((r) => r.name === "body");
    expect(body).toMatchObject({ hidden: true, opacity: 0.5, overridden: false });
    expect(body.effective).toEqual({ material: "powder-coat", color: 0x3a3f47 });
    expect(rows.find((r) => r.name === "lid")).toMatchObject({ hidden: false, opacity: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sub-part-list.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```js
// src/framework/sub-part-list.js
// The row model behind the popover's Parts section and the runtime's
// listSubParts(): one row per sub-part, in definition order, saying whether it
// is in the view, how it is overridden, and what its swatch should look like.
// Pure (no DOM, no three) so the popover, a host and the tests read one model.
import { viewSubParts } from "./part-model.js";
import { partLabel } from "./export-select.js";
import { resolveMaterial, NO_MATERIAL_COLOR } from "./materials/resolve.js";
import { PRESETS } from "./materials/presets.js";
import { effectiveDisplay, APPEARANCE_OVERRIDE_KEYS } from "./materials/overrides.js";

const known = (m) => typeof m === "string" && Object.hasOwn(PRESETS, m);
const isColor = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;

// The swatch colour: the explicit colour wins (it tints any preset, resolve.js),
// else a known preset's own colour, else the drafting blue-grey.
function swatchColor(effective) {
  if (isColor(effective.color)) return effective.color;
  if (known(effective.material)) return resolveMaterial(effective).params.color;
  return NO_MATERIAL_COLOR;
}

export function subPartRows(part, { view, params, overrides = {} } = {}) {
  const inViewNames = new Set(viewSubParts(part, view, params ?? part.defaults ?? {}));
  return Object.keys(part.parts).map((name) => {
    const sp = part.parts[name];
    const override = overrides?.[name] ?? null;
    const effective = effectiveDisplay(sp.display, override);
    const m = effective.material;
    const materialLabel = m == null ? null : known(m) ? PRESETS[m].label : "unknown";
    return {
      name,
      label: partLabel(part, name),
      inView: inViewNames.has(name),
      hidden: override?.hidden === true,
      opacity: typeof override?.opacity === "number" ? override.opacity : 1,
      effective,
      color: swatchColor(effective),
      materialLabel,
      tintable: m == null || !known(m) || PRESETS[m].tintable === true,
      overridden: !!override && APPEARANCE_OVERRIDE_KEYS.some((k) => k in override),
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/sub-part-list.test.js test/worker-layering.test.js`
Expected: PASS. (`export-select.js` and `part-model.js` are already main-thread-safe leaves; the layering test confirms nothing new reaches the worker closure.)

- [ ] **Step 5: Commit**

```bash
git add src/framework/sub-part-list.js test/sub-part-list.test.js
git commit -m "framework: sub-part row model for the parts list"
```

---

### Task 3: The viewer holds and applies the overrides

**Files:**
- Modify: `src/framework/viewer.js` — the material block (lines 268–277), the opacity block (300–442), `castersNow` (780–782), the ortho ghost read (~1374), `physicalFor` (723–736), `captureViewsFromScene`/`canonicalViewsInCurrentLook`/`captureCurrent` (65–88, 2021–2069), the returned object (~2760+).
- Test: `test/viewer-capture.test.js` (extend: `captureViewsFromScene` gets a `reveal` list), `test/display-overrides.test.js` (already covers the decision); the live behaviour is checked by hand in `materials.html`.

**Interfaces:**
- Consumes: Task 1's `sanitizeDisplayPatch`, `mergeOverride`, `effectiveDisplay`, `subPartVisibility`.
- Produces, on the object `createViewer` returns:
  - `setSubPartDisplay(name, patch) → object | null` (the override now held; `null` for an unknown name or when the patch left nothing)
  - `getSubPartDisplayState(name) → { authored, override, effective, hidden, opacity } | null`
  - `getDisplayOverrides() → { [name]: override }` (a copy; only names with an override)
  - `clearSubPartDisplay({ viewing = false, appearance = false, name = null }) → void`
  - `onDisplayChange(cb) → unsubscribe`, `cb({ name, override })` after `setSubPartDisplay`, `cb(null)` after a clear
  - `captureCurrent({ ..., includeHidden: true })` renders hidden and faded sub-parts as if untouched
  - `captureCanonicalViews`, `renderViews` always render them as if untouched
  - `effectiveDisplayOf(name) → object` (for mount's frame logic)

- [ ] **Step 1: Extend the capture test for the reveal list**

Add to `test/viewer-capture.test.js` (it already builds a fake `renderer`, `liveCamera`, `grid`; follow the file's existing fixtures for those):

```js
it("captureViewsFromScene shows `reveal` objects for the pass and puts them back", () => {
  const grid = { visible: true };
  const hiddenMesh = { visible: false };
  const fadedMesh = { visible: true, material: { opacity: 0.4 } };
  const calls = [];
  const renderer = { renderOffscreen: () => { calls.push([hiddenMesh.visible, fadedMesh.visible]); return "d"; } };
  const liveCamera = new THREE.PerspectiveCamera();
  captureViewsFromScene(["iso"], {
    renderer, liveCamera, grid, bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
    reveal: [{ object: hiddenMesh, restore: () => { hiddenMesh.visible = false; }, show: () => { hiddenMesh.visible = true; } }],
  });
  expect(calls).toEqual([[true, true]]);
  expect(hiddenMesh.visible).toBe(false);
  expect(grid.visible).toBe(true);
});
```

Run: `npx vitest run test/viewer-capture.test.js`
Expected: FAIL — `reveal` is ignored (calls record `[false, true]`).

- [ ] **Step 2: Add `reveal` to `captureViewsFromScene`**

In `captureViewsFromScene` (viewer.js ~line 65), accept `reveal = []` beside `hidden` and bracket the pass:

```js
export function captureViewsFromScene(viewNames, { renderer, liveCamera, grid, bounds, sceneBounds, hidden = [], reveal = [], poseFor }) {
  // ...existing prologue...
  const hiddenWas = hidden.map((o) => o.visible);
  for (const o of hidden) o.visible = false;
  // `reveal`: [{ show, restore }] — sub-parts the user hid or faded, shown as
  // if untouched for THIS pass only (agent renders must never miss a piece).
  for (const r of reveal) r.show();
  try {
    // ...existing views.map...
  } finally {
    for (const r of reveal) r.restore();
    if (grid) grid.visible = gridWasVisible;
    hidden.forEach((o, i) => { o.visible = hiddenWas[i]; });
    liveCamera.position.copy(before);
  }
}
```

Run: `npx vitest run test/viewer-capture.test.js`
Expected: PASS.

- [ ] **Step 3: Add the override state and `effectiveDisplayOf` to the viewer**

In `createViewer`, replace the `materialFor` block (lines 268–273) with:

```js
  // --- per-sub-part display overrides (materials/overrides.js) ----------------
  // Appearance keys merge over the authored display for EVERY material read
  // below (effectiveDisplayOf); the viewing keys (hidden, opacity) are read only
  // by applySubOpacity / effectiveVisible. Carried by mount in viewerState.
  const displayOverrides = new Map(); // name -> override (never empty)
  const displayListeners = new Set();
  const effectiveDisplayOf = (name) => effectiveDisplay(part.parts[name]?.display, displayOverrides.get(name) ?? null);
  const isHidden = (name) => displayOverrides.get(name)?.hidden === true;
  const userOpacityOf = (name) => displayOverrides.get(name)?.opacity; // undefined = none

  // Per-sub-part CAD material: the shared default unless the EFFECTIVE display
  // declares appearance (colour, opacity, or a library material flattened for
  // the CAD view — materials/resolve.js cadAppearance).
  function materialFor(name) {
    return buildCadMaterial(effectiveDisplayOf(name), material);
  }
```

and add the import at the top of the file:

```js
import { effectiveDisplay, mergeOverride, sanitizeDisplayPatch, subPartVisibility, APPEARANCE_OVERRIDE_KEYS, VIEWING_KEYS } from "./materials/overrides.js";
```

- [ ] **Step 4: Route every display read through `effectiveDisplayOf`**

Four reads of `part.parts[name].display` must become the effective one. Edit each:

```js
// applySubOpacity, the staticOpacity line:
    const staticOpacity = effectiveDisplayOf(name).opacity ?? 1;
// castersNow (~line 780): ghosts cast no shadow — a USER fade counts as a ghost too
  const castersNow = () => names
    .filter((n) => subMesh[n].visible && (effectiveDisplayOf(n).opacity ?? 1) >= 1 && userOpacityOf(n) === undefined)
    .map((n) => subMesh[n]);
// physicalFor (~line 723): `realisticDisplay(sp)` reads sp.display, so hand it a
// sub-part whose display is the effective one:
      const sp = part.parts[name];
      const eff = { ...sp, display: effectiveDisplayOf(name) };
      m = cloneKeepsPattern(buildPhysicalMaterial(realisticDisplay(eff), { printFrame: printFrames[name], burn: burnsFor(eff), loadTexture }));
// the ortho size-match ghost read (~line 1374): replace `part.parts[n].display?.opacity`
// with `effectiveDisplayOf(n).opacity` (same expression shape as castersNow).
```

Search to be sure none remain: `grep -n "parts\[[a-z]*\]\.display\|\.display?\.opacity" src/framework/viewer.js` must show only `effectiveDisplayOf` and `realisticDisplay(eff)` sites.

- [ ] **Step 5: Rewrite `applySubOpacity` and `effectiveVisible` on the pure decision**

Replace the body of `applySubOpacity` (lines 379–417) with:

```js
  function applySubOpacity(name) {
    const mesh = subMesh[name], lines = subLines[name];
    if (!mesh) return;
    const { meshVisible, linesVisible, fade } = subPartVisibility({
      shown: lastShown.includes(name),
      anim: animOpacity.get(name),
      user: userOpacityOf(name),
      hidden: isHidden(name),
      renderMode,
      staticOpacity: effectiveDisplayOf(name).opacity ?? 1,
    });
    if (fade === null) {
      // Restore ONLY from our own fade clone (see the cutaway note below).
      const hadFade = mesh.material === fadeMats.get(name);
      if (hadFade) mesh.material = baseMats[name];
      if (lines.material === fadeLineMats.get(name)) lines.material = lineMaterial;
      if (hadFade) cutaway.resyncSubpart(name);
    } else {
      const fm = fadeMatFor(name);
      fm.opacity = fade;
      mesh.material = fm;
      const flm = fadeLineMatFor(name);
      flm.opacity = fade / (effectiveDisplayOf(name).opacity ?? 1); // lines fade by the multiplier alone
      lines.material = flm;
    }
    mesh.visible = meshVisible;
    lines.visible = linesVisible && meshVisible;
  }
```

Keep the explanatory comments that were above the old body (the cutaway resync note) — move them above this function. Then:

```js
  const effectiveVisible = () => lastShown.filter((n) =>
    !isHidden(n) && (animOpacity.get(n) ?? 1) > 0 && (userOpacityOf(n) ?? 1) > 0);
```

- [ ] **Step 6: Add the override API**

After `clearSubPartOpacities` add:

```js
  // --- display overrides: the API (spec A.2) -----------------------------------
  function publishDisplay(evt) {
    for (const cb of [...displayListeners]) {
      try { cb(evt); } catch (e) { console.warn("partforge: display listener failed", e); }
    }
  }
  // Re-point one sub-part at the materials its EFFECTIVE display now means, in
  // whichever mode is live — no geometry work (rebaseSubMaterial's contract).
  function rematerialize(name) {
    cadMats[name]?.dispose?.();
    const cad = materialFor(name);
    cadMats[name] = cad;
    const phys = physicalMats.get(name);
    if (phys) { phys.dispose(); physicalMats.delete(name); }
    if (renderMode === "realistic") {
      if (subCache[name] && physicalFor(name).userData.pfAnisotropic) ensureBoxUVs(subCache[name]);
      rebaseSubMaterial(name, physicalFor(name));
    } else {
      rebaseSubMaterial(name, cad);
    }
  }
  function visibilityChanged(name) {
    matchGeneration++;
    cutaway.setVisible(effectiveVisible());
    if (realisticRig) shadowMovedAt = performance.now();
    if (realisticRig) placeGround();
  }
  function setSubPartDisplay(name, patch) {
    if (!subMesh[name]) return null;
    const before = displayOverrides.get(name) ?? null;
    const clean = sanitizeDisplayPatch(patch);
    const next = mergeOverride(before, clean);
    if (next) displayOverrides.set(name, next); else displayOverrides.delete(name);
    const appearanceMoved = APPEARANCE_OVERRIDE_KEYS.some((k) => k in clean);
    const viewingMoved = VIEWING_KEYS.some((k) => k in clean);
    if (appearanceMoved) rematerialize(name); else if (viewingMoved) applySubOpacity(name);
    if (viewingMoved) visibilityChanged(name);
    requestRender();
    publishDisplay({ name, override: next ? { ...next } : null });
    return next ? { ...next } : null;
  }
  function getSubPartDisplayState(name) {
    if (!subMesh[name]) return null;
    const override = displayOverrides.get(name) ?? null;
    return {
      authored: part.parts[name].display ?? null,
      override: override ? { ...override } : null,
      effective: effectiveDisplayOf(name),
      hidden: isHidden(name),
      opacity: userOpacityOf(name) ?? 1,
    };
  }
  const getDisplayOverrides = () => Object.fromEntries([...displayOverrides].map(([n, o]) => [n, { ...o }]));
  // Clear the viewing keys, the appearance keys, or both — for one sub-part or all.
  function clearSubPartDisplay({ viewing = false, appearance = false, name = null } = {}) {
    const targets = name ? (displayOverrides.has(name) ? [name] : []) : [...displayOverrides.keys()];
    if (!targets.length) return;
    for (const n of targets) {
      const o = displayOverrides.get(n);
      const patch = {};
      if (viewing) for (const k of VIEWING_KEYS) if (k in o) patch[k] = null;
      if (appearance) for (const k of APPEARANCE_OVERRIDE_KEYS) if (k in o) patch[k] = null;
      const next = mergeOverride(o, patch);
      if (next) displayOverrides.set(n, next); else displayOverrides.delete(n);
      if (appearance) rematerialize(n); else applySubOpacity(n);
    }
    matchGeneration++;
    cutaway.setVisible(effectiveVisible());
    if (realisticRig) { shadowMovedAt = performance.now(); placeGround(); }
    requestRender();
    publishDisplay(null);
  }
  function onDisplayChange(cb) { displayListeners.add(cb); return () => displayListeners.delete(cb); }
```

Note on `rematerialize`: `cadMats[name]` is the shared `material` when the sub-part had no appearance (`buildCadMaterial` returns `base`); disposing the shared base would break every other sub-part. Guard it:

```js
    if (cadMats[name] !== material) cadMats[name]?.dispose();
```

Also in `dispose()` nothing changes: `cadMats[n]?.dispose()` already runs per name; add `displayListeners.clear(); displayOverrides.clear();` beside the other listener clears.

- [ ] **Step 7: Reveal hidden and faded sub-parts in the agent captures**

Add a helper near `captureHidden`:

```js
  // Sub-parts the user hid or faded, as `reveal` entries: shown as if untouched
  // for one capture pass (agent renders must never miss a piece), then put back.
  function revealEntries() {
    const out = [];
    for (const n of names) {
      if (!lastShown.includes(n) || !subCache[n]) continue;
      if (!isHidden(n) && userOpacityOf(n) === undefined) continue;
      const mesh = subMesh[n], lines = subLines[n];
      const was = { mat: mesh.material, lmat: lines.material, vis: mesh.visible, lvis: lines.visible };
      out.push({
        object: mesh,
        show: () => {
          const { meshVisible, linesVisible, fade } = subPartVisibility({
            shown: true, anim: animOpacity.get(n), user: undefined, hidden: false, renderMode, staticOpacity: effectiveDisplayOf(n).opacity ?? 1,
          });
          if (fade === null) { mesh.material = baseMats[n]; lines.material = lineMaterial; }
          else { const fm = fadeMatFor(n); fm.opacity = fade; mesh.material = fm; }
          mesh.visible = meshVisible; lines.visible = linesVisible && meshVisible;
        },
        restore: () => { mesh.material = was.mat; lines.material = was.lmat; mesh.visible = was.vis; lines.visible = was.lvis; },
      });
    }
    return out;
  }
```

Then in `canonicalViewsInCurrentLook`, the framing must include the revealed meshes too. Wrap the body:

```js
  function canonicalViewsInCurrentLook(viewNames) {
    const reveal = revealEntries();
    for (const r of reveal) r.show();            // framed WITH the hidden pieces
    try {
      const box = getVisibleWorldBounds();
      if (!box || box.isEmpty()) return [];
      // ...existing center/size/styleBox/points...
      return captureViewsFromScene(viewNames, { /* existing args */, hidden: [...canonicalCaptureHidden] });
    } finally {
      for (const r of reveal) r.restore();
    }
  }
```

(`reveal` is handled here rather than passed down, because the framing reads `mesh.visible` before `captureViewsFromScene` runs; `captureViewsFromScene`'s own `reveal` option stays for a caller that frames itself.) Also change `captureCanonicalViews`'s early `getVisibleWorldBounds()` emptiness check to run after a reveal the same way, or a part whose every sub-part is hidden returns `[]` instead of the render — simplest: delete that early check there and rely on the one inside `canonicalViewsInCurrentLook`.

In `captureCurrent`, honour `includeHidden`:

```js
  function captureCurrent(opts) {
    if (disposed) return null;
    const { renderMode: want, includeHidden = false, ...rest } = opts ?? {};
    const reveal = includeHidden ? revealEntries() : [];
    for (const r of reveal) r.show();
    try {
      const box = getVisibleWorldBounds();
      if (!box || box.isEmpty()) return null;
      const capture = () => currentFramingInCurrentLook(rest);
      if (want === "cad") return captureIn("cad", null, capture);
      if (want === "realistic" && renderMode !== "realistic") {
        const rig = loadedRigs.get(environmentId);
        if (rig) return captureIn("realistic", rig, capture);
      }
      return capture();
    } finally {
      for (const r of reveal) r.restore();
    }
  }
```

- [ ] **Step 8: Export the API from `createViewer`'s returned object**

In the `return withRenderRequests({ ... })` block add, beside `setSubPartOpacity`:

```js
    setSubPartDisplay,
    getSubPartDisplayState,
    getDisplayOverrides,
    clearSubPartDisplay,
    onDisplayChange,
    effectiveDisplayOf,
```

- [ ] **Step 9: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. `test/viewer-capture.test.js`'s existing cases still pass (no `reveal` → no change).

- [ ] **Step 10: Manual check in `materials.html`**

Run: `npm run dev`, open `http://localhost:5173/materials.html`, and in the console (the page exposes the runtime; if it does not, `window.__pf = runtime` where `mount(...)` is called in `src/app-materials.js`, as other demo pages do):

```js
const v = __pf.__viewer ?? null; // if mount does not expose it, temporarily `window.__viewer = viewer` inside mount() for this check and revert
```

Instead of reaching into the viewer, drive it through the handle once Task 4 lands. For THIS task, check with a temporary `window.__viewer = viewer` line in `mount()` (remove before commit):

1. `__viewer.setSubPartDisplay("<a sub-part name>", { material: "brass" })` → the piece turns brass in CAD (flattened) at once; no "forging"/rebuild status.
2. Toggle realistic (eye → Studio) → it is brass under the environment, not the authored look.
3. `__viewer.setSubPartDisplay(name, { opacity: 0.4 })` → see-through, still pickable (click it, the hover label names it), no shadow under it in realistic.
4. `__viewer.setSubPartDisplay(name, { hidden: true })` → gone; cutaway and ground follow.
5. `__viewer.captureCanonicalViews(["iso"])[0].dataUrl` pasted into a new tab shows the piece present and solid; `__viewer.captureCurrent({})` shows it absent; `__viewer.captureCurrent({ includeHidden: true })` shows it present.
6. Play an animation that fades that piece, hide it, show it (`{hidden: false}`): it reappears where the animation has it. Stop the animation: it stays shown.
7. `__viewer.clearSubPartDisplay({ viewing: true, appearance: true })` → back to the authored look.

Remove the temporary `window.__viewer` line.

- [ ] **Step 11: Commit**

```bash
git add src/framework/viewer.js test/viewer-capture.test.js
git commit -m "viewer: live per-sub-part display overrides, hide and see-through; agent captures reveal them"
```

---

### Task 4: `mount` exposes the hops, restores `viewerState.display`, recomputes frames lazily

**Files:**
- Modify: `src/framework/mount.js` — `makeHandle` (line 73 onward), the restore block (~696–718), `layerLined`/`burning`/`recordFrames`/`computeFrames` (~995–1075), the `return makeHandle({...})` call (1570 onward).
- Test: `test/mount-display-state.test.js` (new), `test/mount-capture.test.js` (extend).

**Interfaces:**
- Consumes: Task 3's viewer methods; Task 1's `pruneOverrides`; Task 2's `subPartRows`.
- Produces on the handle (spec A.2):
  - `setSubPartDisplay(name, patch)`, `getSubPartDisplay(name)`, `clearSubPartDisplay(opts)`, `onSubPartDisplayChange(cb)` — delegations
  - `listSubParts({ view } = {}) → Row[]` from `subPartRows(part, { view: view ?? getView(), params, overrides })`
  - `openAppearance(name) → boolean` and `setDisplaySaveState(state)` — forwarded to the popover (Task 6 fills them; here they default to no-ops so the handle shape is fixed now)
  - `getViewerState().display` present only when any override is held
  - `mount({ viewerState: { display } })` restores through `pruneOverrides`

- [ ] **Step 1: Write the failing handle tests**

```js
// test/mount-display-state.test.js
import { describe, it, expect, vi } from "vitest";
import { makeHandle } from "../src/framework/mount.js";

const viewerStub = (overrides = {}) => ({
  captureCanonicalViews: vi.fn(),
  getCameraState: () => ({ pos: [1, 2, 3], target: [0, 0, 0] }),
  getDisplayOverrides: () => overrides,
  setSubPartDisplay: vi.fn((name, patch) => ({ ...patch })),
  getSubPartDisplayState: vi.fn(() => ({ authored: null, override: null, effective: {}, hidden: false, opacity: 1 })),
  clearSubPartDisplay: vi.fn(),
  onDisplayChange: vi.fn(() => () => {}),
});

describe("mount handle display hops", () => {
  it("getViewerState carries `display` only while an override is held", () => {
    const empty = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer: viewerStub({}) });
    expect("display" in empty.getViewerState()).toBe(false);
    const held = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer: viewerStub({ lid: { material: "oak" } }) });
    expect(held.getViewerState().display).toEqual({ lid: { material: "oak" } });
  });
  it("delegates set/get/clear/onChange to the viewer", () => {
    const viewer = viewerStub();
    const h = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer });
    expect(h.setSubPartDisplay("lid", { material: "oak" })).toEqual({ material: "oak" });
    expect(viewer.setSubPartDisplay).toHaveBeenCalledWith("lid", { material: "oak" });
    h.getSubPartDisplay("lid");
    expect(viewer.getSubPartDisplayState).toHaveBeenCalledWith("lid");
    h.clearSubPartDisplay({ viewing: true });
    expect(viewer.clearSubPartDisplay).toHaveBeenCalledWith({ viewing: true });
    const cb = () => {};
    h.onSubPartDisplayChange(cb);
    expect(viewer.onDisplayChange).toHaveBeenCalledWith(cb);
  });
  it("listSubParts uses the active view by default and an explicit one when given", () => {
    const listSubParts = vi.fn((opts) => [{ name: "lid", view: opts?.view }]);
    const h = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer: viewerStub(), listSubParts });
    expect(h.listSubParts()).toEqual([{ name: "lid", view: undefined }]);
    expect(h.listSubParts({ view: "body" })).toEqual([{ name: "lid", view: "body" }]);
  });
  it("openAppearance and setDisplaySaveState default to no-ops with fixed return shapes", () => {
    const h = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer: viewerStub() });
    expect(h.openAppearance("lid")).toBe(false);
    expect(h.setDisplaySaveState("saved")).toBeUndefined();
    expect(h.listSubParts()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/mount-display-state.test.js`
Expected: FAIL — `h.setSubPartDisplay is not a function`.

- [ ] **Step 3: Extend `makeHandle`**

Add the new names to `makeHandle`'s destructured parameter list: `listSubParts, openAppearance, setDisplaySaveState`. Inside the returned object add:

```js
    // --- per-sub-part display overrides (spec 2026-10-13 part appearance controls) ---
    // Live, no rebuild: appearance keys (material, colour, finish) merge over
    // the authored `display` for every render; `hidden` and `opacity` are how
    // the user is looking and never reach a material read, an export or a
    // host's save. All of it rides getViewerState().display below.
    setSubPartDisplay: (name, patch) => viewer.setSubPartDisplay?.(name, patch) ?? null,
    getSubPartDisplay: (name) => viewer.getSubPartDisplayState?.(name) ?? null,
    clearSubPartDisplay: (opts) => viewer.clearSubPartDisplay?.(opts),
    onSubPartDisplayChange: (cb) => viewer.onDisplayChange?.(cb) ?? (() => {}),
    // Every sub-part as a row (sub-part-list.js), for a host's own list; the
    // active view unless `view` names another.
    listSubParts: listSubParts ?? (() => []),
    // Open the popover on the appearance card for `name`; false when there is
    // no popover (a host with neither #viewbar nor a view cube stack).
    openAppearance: openAppearance ?? (() => false),
    // "saved" | "screen-only" | "blocked": the card's footer copy. A host that
    // persists overrides into source says "saved"; one that cannot, for this
    // sub-part, says "blocked"; the default is "screen-only".
    setDisplaySaveState: setDisplaySaveState ?? (() => {}),
```

and in `getViewerState` add, after the environment spread:

```js
      // Only while something is overridden: an empty map would be noise in a
      // token hosts compare and store.
      ...(() => { const d = viewer.getDisplayOverrides?.(); return d && Object.keys(d).length ? { display: d } : {}; })(),
```

- [ ] **Step 4: Run the handle tests**

Run: `npx vitest run test/mount-display-state.test.js test/mount-capture.test.js`
Expected: PASS.

- [ ] **Step 5: Restore `viewerState.display` in `mount()`**

Import `pruneOverrides` from `./materials/overrides.js` and `subPartRows` from `./sub-part-list.js` at the top of `mount.js`. In the restore block, after `const initialEnv = …; if (initialEnv) viewer.setEnvironment(initialEnv);`, add:

```js
    // Carried display overrides, pruned for THIS part (materials/overrides.js):
    // a renamed sub-part's entry goes, and an appearance key that now equals the
    // authored value goes — which is how an owner's saved change self-cleans
    // after the remount that applied it. Restored before the first showView so
    // the first frame already draws the override, hidden pieces included.
    for (const [name, override] of Object.entries(pruneOverrides(viewerState?.display, part))) {
      viewer.setSubPartDisplay(name, override);
    }
```

- [ ] **Step 6: Make the layer-line and burn frames follow the effective display**

Replace the `layerLined` / `burning` constants and `recordFrames` (~lines 995–1012) with per-name predicates over the effective display, and keep a delivery record for EVERY sub-part so a later material change can compute its frame without a new build:

```js
    // Which sub-parts need frames is read off the EFFECTIVE display at the time
    // the frames are computed, not fixed at mount: a live material change (the
    // Parts section) can turn a plain piece into a layer-lined print, and it
    // must get its print frame without a rebuild. So every delivery's
    // dispatch record is kept (one small object per sub-part), and computeFrames
    // decides per name.
    const effectiveSubPart = (n) => ({ ...part.parts[n], display: viewer.effectiveDisplayOf?.(n) ?? part.parts[n].display });
    const isLayerLined = (n) => {
      try { return resolveMaterial(realisticDisplay(effectiveSubPart(n))).params.pattern === "layer-lines"; } catch { return false; }
    };
    const isBurning = (n) => burnsFor(effectiveSubPart(n));
    const printFrames = {};
    const sheetFrames = {};
    const deliveredAt = new Map(); // sub-part -> { at: { view, params }, frame } of its delivered mesh (kept, not consumed)
    const undrawnFrames = new Set(); // sub-part names whose frames are stale
    function recordFrames(meshes) {
      for (const m of meshes) {
        deliveredAt.set(m.name, { at: dispatched.get(m.name) ?? null, frame: m.frame ?? "posed" });
        undrawnFrames.add(m.name);
      }
      viewer.invalidateFrames?.();
    }
    function computeFrames() {
      const resolvedFor = new Map();
      for (const n of undrawnFrames) {
        const rec = deliveredAt.get(n);
        if (!rec) continue;
        const { at, frame } = rec;
        const needPrint = isLayerLined(n), needBurn = isBurning(n);
        if (!needPrint && !needBurn) { delete sheetFrames[n]; continue; }
        if (at && !resolvedFor.has(at)) {
          try { resolvedFor.set(at, resolveParams(part, at.params)); } catch { resolvedFor.set(at, null); }
        }
        const resolved = at ? resolvedFor.get(at) : null;
        if (!resolved) { delete sheetFrames[n]; continue; }
        if (needPrint) printFrames[n] = printFrameMatrix(part.parts[n], { view: at.view, ...resolved, frame });
        if (needBurn) {
          const f = sheetFrameFor(part.parts[n], { ...resolved, frame });
          if (f) sheetFrames[n] = f; else delete sheetFrames[n];
        }
      }
      undrawnFrames.clear();
      return { print: { ...printFrames }, sheet: { ...sheetFrames } };
    }
    // A display change re-stales that sub-part's frames: computeFrames is lazy
    // (viewer.js syncFrames) so a CAD-only session still computes nothing.
    cleanup.defer(viewer.onDisplayChange?.((evt) => {
      if (evt?.name) undrawnFrames.add(evt.name); else for (const n of deliveredAt.keys()) undrawnFrames.add(n);
      viewer.invalidateFrames?.();
    }) ?? (() => {}));
```

The call sites that read `layerLined.has(...)` / `burning.has(...)` elsewhere in `mount.js` (search `layerLined` and `burning`) switch to `isLayerLined(n)` / `isBurning(n)`.

- [ ] **Step 7: Wire `listSubParts` and the popover's `parts` option into the `makeHandle` call**

In `return makeHandle({ ... })` add:

```js
      listSubParts: ({ view: v } = {}) => subPartRows(part, { view: v ?? view(), params, overrides: viewer.getDisplayOverrides?.() ?? {} }),
      openAppearance: (name) => viewStyle.openCard?.(name) ?? false,
      setDisplaySaveState: (state) => viewStyle.setSaveState?.(state),
```

and change the `attachViewStyleControls` call (line 763) to pass the parts seam the popover will use (Task 5 consumes it; until then the option is ignored):

```js
    const viewStyle = attachViewStyleControls(viewer, {
      stage: els.viewer,
      toolbar: els.viewer.querySelector("#viewbar"),
      anchor: viewcube.element,
      parts: {
        list: () => subPartRows(part, { view: view(), params, overrides: viewer.getDisplayOverrides?.() ?? {} }),
        setDisplay: (name, patch) => viewer.setSubPartDisplay(name, patch),
        clear: (opts) => viewer.clearSubPartDisplay(opts),
        onChange: (cb) => viewer.onDisplayChange(cb),
        onViewChange: (cb) => { viewChangeListeners.add(cb); return () => viewChangeListeners.delete(cb); },
        getState: (name) => viewer.getSubPartDisplayState(name),
      },
    }, { tooltip });
```

`viewChangeListeners` is a new `Set` declared beside `tabsCtl`; in `tabsCtl`'s `onChange` add `for (const cb of [...viewChangeListeners]) { try { cb(name); } catch { /* listener's problem */ } }` before `onViewChange?.(name)`. Keep the `viewStyle` declaration ABOVE the `makeHandle` call (it already is).

- [ ] **Step 8: Run the whole suite and the app check**

Run: `npx vitest run && npm run check`
Expected: PASS; `check-app.mjs` boots every demo page (no popover change yet, so it must be identical).

- [ ] **Step 9: Manual check** (`materials.html`, console with `window.__pf = runtime`):

1. `__pf.setSubPartDisplay("<name>", { material: "pla-print" })` on a piece that had a metal → in realistic mode its layer lines run with the export +Z (compare with a piece authored as `pla-print`); this is the lazy frame.
2. `__pf.getViewerState().display` shows the override; reload the page and pass it back: `mount(part, { ..., viewerState })` is exercised by partforge-cloud, so here only confirm `pruneOverrides` through the unit test in Task 1 and that `getViewerState().display` is absent after `clearSubPartDisplay({ viewing: true, appearance: true })`.
3. `__pf.listSubParts()` returns rows for the active view with `inView` true for what is on screen.

- [ ] **Step 10: Commit**

```bash
git add src/framework/mount.js test/mount-display-state.test.js
git commit -m "mount: display override hops on the handle, viewerState.display restore, lazy material frames"
```

---

### Task 5: The Parts section in the popover

**Files:**
- Create: `src/framework/parts-list.js`
- Modify: `src/framework/view-style-controls.js`, `src/framework/app.css`
- Test: `test/view-style-popover.test.js` (new)

**Interfaces:**
- Consumes: the `parts` option from Task 4 (`{ list, setDisplay, clear, onChange, onViewChange, getState }`), rows per Task 2.
- Produces: `attachPartsList(container, parts, { onSwatch })` → `{ render(), detach() }`; `attachViewStyleControls` accepts `parts` and mounts the section under the grid; the returned object gains `openCard(name)` (Task 6 implements it; here it returns `false`) and `setSaveState(state)` (stored for Task 6).

- [ ] **Step 1: Write the failing popover tests**

```js
// test/view-style-popover.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachViewStyleControls } from "../src/framework/view-style-controls.js";

const noop = () => () => {};
function viewerStub() {
  return {
    getRenderMode: () => "cad", getEnvironment: () => "studio",
    onRenderModeChange: noop, onEnvironmentChange: noop, onAssemblyChange: noop, onThemeChange: noop, onCutawayChange: noop,
    renderStyleThumbnail: async () => null,
  };
}
function partsStub(rows) {
  let listeners = new Set();
  return {
    rows,
    list: () => rows,
    setDisplay: vi.fn((name, patch) => { const r = rows.find((x) => x.name === name); if ("hidden" in patch) r.hidden = !!patch.hidden; if ("opacity" in patch) r.opacity = patch.opacity ?? 1; for (const cb of listeners) cb({ name, override: patch }); return patch; }),
    clear: vi.fn((opts) => { if (opts?.viewing) for (const r of rows) { r.hidden = false; r.opacity = 1; } for (const cb of listeners) cb(null); }),
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onViewChange: noop,
    getState: (name) => { const r = rows.find((x) => x.name === name); return r ? { authored: null, override: null, effective: r.effective, hidden: r.hidden, opacity: r.opacity } : null; },
  };
}
const ROWS = () => [
  { name: "body", label: "Body", inView: true, hidden: false, opacity: 1, effective: { material: "powder-coat" }, color: 0x3a3f47, materialLabel: "Powder coat", tintable: true, overridden: false },
  { name: "lid", label: "Lid", inView: true, hidden: false, opacity: 1, effective: { material: "brass" }, color: 0xc9a24b, materialLabel: "Brass", tintable: false, overridden: false },
  { name: "jig", label: "Jig", inView: false, hidden: false, opacity: 1, effective: {}, color: 0x9fb4cc, materialLabel: null, tintable: true, overridden: false },
];

let stage, toolbar;
beforeEach(() => {
  document.body.innerHTML = `<div id="stage"><div id="viewbar"><button id="theme"></button></div></div>`;
  stage = document.getElementById("stage"); toolbar = document.getElementById("viewbar");
});

describe("view style popover: parts section", () => {
  it("renders nothing new without a `parts` option (the cloud scaffold contract)", () => {
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar });
    vs.open();
    expect(vs.popover.querySelector(".pf-parts-list")).toBeNull();
    expect(vs.popover.querySelectorAll(".pf-view-style-tile").length).toBe(5);
    expect(vs.openCard("body")).toBe(false);
    vs.detach();
  });
  it("lists the rows IN the active view, with label, material and an eye each", () => {
    const parts = partsStub(ROWS());
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts });
    vs.open();
    const rows = [...vs.popover.querySelectorAll(".pf-parts-row")];
    expect(rows.map((r) => r.dataset.name)).toEqual(["body", "lid"]);
    expect(rows[0].querySelector(".pf-parts-name").textContent).toBe("Body");
    expect(rows[0].querySelector(".pf-parts-mat").textContent).toBe("Powder coat");
    expect(rows[0].querySelector(".pf-parts-eye").getAttribute("aria-label")).toBe("Hide Body");
    expect(vs.popover.querySelector(".pf-parts-heading").textContent).toBe("Parts");
    expect(vs.popover.querySelector(".pf-parts-swatch").style.getPropertyValue("--pf-swatch")).toBe("#3a3f47");
    vs.detach();
  });
  it("the eye hides and shows; Show all appears only while something is hidden or faded, and clears the viewing keys", () => {
    const parts = partsStub(ROWS());
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts });
    vs.open();
    const showAll = () => vs.popover.querySelector(".pf-parts-showall");
    expect(showAll().hidden).toBe(true);
    vs.popover.querySelector('.pf-parts-row[data-name="body"] .pf-parts-eye').click();
    expect(parts.setDisplay).toHaveBeenCalledWith("body", { hidden: true });
    const row = vs.popover.querySelector('.pf-parts-row[data-name="body"]');
    expect(row.classList.contains("hidden")).toBe(true);
    expect(row.querySelector(".pf-parts-eye").getAttribute("aria-label")).toBe("Show Body");
    expect(showAll().hidden).toBe(false);
    showAll().click();
    expect(parts.clear).toHaveBeenCalledWith({ viewing: true });
    expect(showAll().hidden).toBe(true);
    vs.detach();
  });
  it("a faded row shows a half-weight eye and counts for Show all", () => {
    const rows = ROWS(); rows[1].opacity = 0.4;
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts: partsStub(rows) });
    vs.open();
    expect(vs.popover.querySelector('.pf-parts-row[data-name="lid"]').classList.contains("faded")).toBe(true);
    expect(vs.popover.querySelector(".pf-parts-showall").hidden).toBe(false);
    vs.detach();
  });
  it("re-renders on a display change and on a view change", () => {
    const rows = ROWS();
    const parts = partsStub(rows);
    let viewCb = null; parts.onViewChange = (cb) => { viewCb = cb; return () => {}; };
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts });
    vs.open();
    rows[2].inView = true; viewCb("other");
    expect([...vs.popover.querySelectorAll(".pf-parts-row")].map((r) => r.dataset.name)).toEqual(["body", "lid", "jig"]);
    vs.detach();
  });
  it("the style grid is five across", () => {
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar });
    expect(vs.popover.querySelector(".pf-view-style-grid").children.length).toBe(5);
    vs.detach();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/view-style-popover.test.js`
Expected: FAIL on the parts cases (`.pf-parts-list` null; `openCard` undefined).

- [ ] **Step 3: Write `parts-list.js`**

```js
// src/framework/parts-list.js
// The View style popover's Parts section: the sub-parts in the active view,
// one row each with an eye (hide / show) and a swatch (opens the appearance
// card), plus Show all. DOM only; the row model is sub-part-list.js's and the
// state is the viewer's — this module renders `parts.list()` and calls
// `parts.setDisplay` / `parts.clear`, nothing more.
const EYE = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`;

export const hexColor = (int) => `#${(int >>> 0).toString(16).padStart(6, "0").slice(-6)}`;

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// `onSwatch(name)` opens the card. Returns { element, render, detach }.
export function attachPartsList(parts, { onSwatch } = {}) {
  const section = el("div", "pf-parts");
  const head = el("div", "pf-parts-head");
  const heading = el("p", "pf-view-style-heading pf-parts-heading");
  heading.textContent = "Parts";
  const showAll = el("button", "pf-parts-showall", { type: "button" });
  showAll.textContent = "Show all";
  showAll.hidden = true;
  showAll.addEventListener("click", () => { parts.clear({ viewing: true }); render(); });
  head.append(heading, showAll);
  const list = el("div", "pf-parts-list", { role: "list" });
  section.append(head, list);

  function render() {
    const rows = parts.list().filter((r) => r.inView);
    list.replaceChildren(...rows.map((r) => {
      const row = el("div", "pf-parts-row", { role: "listitem", "data-name": r.name });
      if (r.hidden) row.classList.add("hidden");
      else if (r.opacity < 1) row.classList.add("faded");
      const eye = el("button", "pf-parts-eye", { type: "button", "aria-pressed": String(r.hidden), "aria-label": `${r.hidden ? "Show" : "Hide"} ${r.label}` });
      eye.title = eye.getAttribute("aria-label");
      eye.innerHTML = r.hidden ? EYE_OFF : EYE;
      eye.addEventListener("click", () => { parts.setDisplay(r.name, { hidden: !r.hidden }); render(); });
      const swatch = el("button", "pf-parts-swatch", { type: "button", "aria-label": `Change appearance of ${r.label}` });
      swatch.title = swatch.getAttribute("aria-label");
      swatch.style.setProperty("--pf-swatch", hexColor(r.color));
      swatch.addEventListener("click", () => onSwatch?.(r.name));
      const name = el("span", "pf-parts-name"); name.textContent = r.label;
      const mat = el("span", "pf-parts-mat"); mat.textContent = r.materialLabel ?? "";
      row.append(eye, swatch, name, mat);
      return row;
    }));
    showAll.hidden = !parts.list().some((r) => r.hidden || r.opacity < 1);
  }

  const offs = [parts.onChange(() => render()), parts.onViewChange?.(() => render()) ?? (() => {})];
  render();
  return { element: section, render, detach() { for (const off of offs) { try { off(); } catch { /* gone */ } } section.remove(); } };
}
```

- [ ] **Step 4: Mount it in `view-style-controls.js`**

Accept `parts = null` in the options destructure. After `pop.append(styleHead, grid);` add:

```js
  // The Parts section (parts-list.js) — only for a host that passes the seam.
  // Separated from the style grid by a rule so the popover reads as two
  // things: how the scene is drawn, then what is in it.
  let partsList = null;
  let divider2 = null;
  if (parts) {
    divider2 = el("hr", "pf-popover-rule");
    partsList = attachPartsList(parts, { onSwatch: (name) => openCard(name) });
    pop.append(divider2, partsList.element);
  }
  // Filled by the appearance card (Task 6); until then nothing opens.
  let openCard = () => false;
  let saveState = "screen-only";
```

Import `attachPartsList` at the top. In `open()`, after `render();` add `partsList?.render();`. In `detach()`, add `partsList?.detach();`. In the `offs` array add one entry, so the style thumbnails re-render on the next open after a material or hide change (spec A.3):

```js
    viewer.onDisplayChange?.(() => cache.invalidate()) ?? (() => {}),
```

In the returned object add:

```js
    openCard: (name) => openCard(name),
    setSaveState(state) { saveState = state; },
    getSaveState: () => saveState,
```

- [ ] **Step 5: CSS**

In `app.css` change the grid rule and add the list styles after the tile rules:

```css
.pf-view-style-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.pf-view-style-tile { /* existing */ font-size: 10.5px; }
.pf-popover-rule { border: 0; border-top: 1px solid var(--pf-border); margin: 0 -12px; }
.pf-parts { display: flex; flex-direction: column; gap: 6px; }
.pf-parts-head { display: flex; align-items: baseline; justify-content: space-between; }
.pf-parts-showall { font: inherit; font-weight: 500; color: var(--pf-accent); background: none; border: 0; padding: 0; cursor: pointer; }
.pf-parts-showall[hidden] { display: none; }
.pf-parts-list { display: flex; flex-direction: column; gap: 2px; }
.pf-parts-row { display: grid; grid-template-columns: 28px 22px 1fr auto; align-items: center; gap: 8px; padding: 3px 4px 3px 0; border-radius: var(--pf-radius-control); min-width: 0; }
.pf-parts-row:hover { background: var(--pf-surface-2); }
.pf-parts-eye { width: 28px; height: 28px; border: 0; background: none; color: var(--pf-muted-2); border-radius: 6px; display: grid; place-items: center; cursor: pointer; }
.pf-parts-eye:hover { background: var(--pf-accent-soft); color: var(--pf-accent); }
.pf-parts-row.hidden .pf-parts-eye { color: var(--pf-hint); }
.pf-parts-row.faded .pf-parts-eye { opacity: .55; }
.pf-parts-row.hidden .pf-parts-name { color: var(--pf-hint); }
.pf-parts-row.hidden .pf-parts-swatch { opacity: .35; }
.pf-parts-swatch { width: 22px; height: 22px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; background: var(--pf-swatch, var(--pf-surface-2)); box-shadow: inset 0 0 0 1px rgb(0 0 0 / .18); }
.pf-parts-swatch:hover { box-shadow: inset 0 0 0 1px rgb(0 0 0 / .18), 0 0 0 2px var(--pf-surface), 0 0 0 4px var(--pf-accent); }
.pf-parts-name { font-size: 13px; color: var(--pf-text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-parts-mat { font-size: 11.5px; color: var(--pf-muted); white-space: nowrap; }
.pf-parts-eye:focus-visible, .pf-parts-swatch:focus-visible, .pf-parts-showall:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklab, var(--pf-accent) 35%, transparent); }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/view-style-popover.test.js test/tokens.test.js`
Expected: PASS (the `tokens.test.js` hidden-rule scan still finds its two selectors).

- [ ] **Step 7: Check the cloud's scaffold contract still holds**

Run, from the cloud worktree, against this checkout: `cd /Users/scottsykora/Documents/Docs/pixite/code/partforge-cloud/.claude/worktrees/part-recolor-materials-visibility-d25ca1 && npx vitest run tests/unit/sandbox-scaffold.test.js` after `npm link`-ing or temporarily pointing its `node_modules/partforge/src/framework/view-style-controls.js` at this file (copy the file in, run, `git checkout` it back). Expected: PASS — the stub passes no `parts`, so the popover is unchanged.

- [ ] **Step 8: Manual check** (`materials.html`): open the eye; the Parts section lists what is on screen; an eye hides a piece at once; Show all appears and clears; the style tiles are one row of five.

- [ ] **Step 9: Commit**

```bash
git add src/framework/parts-list.js src/framework/view-style-controls.js src/framework/app.css test/view-style-popover.test.js
git commit -m "popover: Parts section under the style grid (eyes, swatches, Show all); grid one row of five"
```

---

### Task 6: The appearance card page

**Files:**
- Create: `src/framework/appearance-card.js`
- Modify: `src/framework/view-style-controls.js` (page switching, `openCard`, `setSaveState`), `src/framework/app.css`
- Test: `test/appearance-card.test.js` (new), `test/view-style-popover.test.js` (extend)

**Interfaces:**
- Consumes: `parts` seam (Task 4), `PRESETS`, `OVERRIDE_RANGES`, `MIN_USER_OPACITY`; Task 7 later adds `renderThumb`.
- Produces: `attachAppearanceCard(parts, { onBack, getSaveState, renderThumb = null })` → `{ element, show(name), hide(), render(), detach() }`; the popover's `openCard(name)` opens the popover (if closed) and shows the card for `name`, returning `true` when `name` is a known row; Back returns to the list; close hides both.

- [ ] **Step 1: Write the failing card tests**

```js
// test/appearance-card.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachAppearanceCard } from "../src/framework/appearance-card.js";
import { PRESETS } from "../src/framework/materials/presets.js";

function partsStub(rows) {
  const listeners = new Set();
  return {
    list: () => rows,
    setDisplay: vi.fn((name, patch) => { for (const cb of listeners) cb({ name, override: patch }); return patch; }),
    clear: vi.fn((opts) => { for (const cb of listeners) cb(null); }),
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onViewChange: () => () => {},
    getState: (name) => { const r = rows.find((x) => x.name === name); return r ? { authored: r.authored ?? null, override: r.override ?? null, effective: r.effective, hidden: r.hidden, opacity: r.opacity } : null; },
  };
}
const rows = () => [
  { name: "lid", label: "Lid", inView: true, hidden: false, opacity: 1, effective: { material: "anodized-aluminum", color: 0xb3261e }, color: 0xb3261e, materialLabel: "Anodized aluminium", tintable: true, overridden: true, override: { material: "anodized-aluminum" } },
  { name: "knob", label: "Knob", inView: true, hidden: false, opacity: 1, effective: { material: "brass" }, color: 0xc9a24b, materialLabel: "Brass", tintable: false, overridden: false },
  { name: "base", label: "Base", inView: true, hidden: false, opacity: 1, effective: {}, color: 0x9fb4cc, materialLabel: null, tintable: true, overridden: false },
];
beforeEach(() => { document.body.innerHTML = ""; });

describe("appearance card", () => {
  it("shows the label, one tile per preset plus CAD, the pressed one being the effective material", () => {
    const card = attachAppearanceCard(partsStub(rows()), { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    expect(card.element.querySelector(".pf-card-title").textContent).toBe("Lid");
    const tiles = [...card.element.querySelectorAll(".pf-card-tile")];
    expect(tiles.length).toBe(Object.keys(PRESETS).length + 1);
    expect(tiles[0].textContent).toBe("CAD");
    expect(tiles.find((t) => t.getAttribute("aria-pressed") === "true").dataset.material).toBe("anodized-aluminum");
    card.detach();
  });
  it("CAD is pressed for no material; an unknown id presses CAD and names itself", () => {
    const r = rows(); r[2].effective = { material: "unobtainium" };
    const card = attachAppearanceCard(partsStub(r), { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("base");
    expect(card.element.querySelector('.pf-card-tile[data-material=""]').getAttribute("aria-pressed")).toBe("true");
    expect(card.element.querySelector(".pf-card-unknown").textContent).toBe("unobtainium");
    card.detach();
  });
  it("tiles write material (CAD writes null); colour writes an int; the colour row is disabled for an untintable preset", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    card.element.querySelector('.pf-card-tile[data-material="oak"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: "oak" });
    card.element.querySelector('.pf-card-tile[data-material=""]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { material: null });
    card.element.querySelector('.pf-card-color[data-color="#1f5bd6"]').click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { color: 0x1f5bd6 });
    card.show("knob");
    expect(card.element.querySelector(".pf-card-colors").classList.contains("disabled")).toBe(true);
    expect(card.element.querySelector(".pf-card-tint-note").textContent).toBe("Brass has its own colour. Pick a tintable preset to colour it.");
    card.detach();
  });
  it("the hex field and the native input write a colour; a bad hex writes nothing", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const hex = card.element.querySelector(".pf-card-hex");
    hex.value = "#00ff00"; hex.dispatchEvent(new Event("change"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { color: 0x00ff00 });
    parts.setDisplay.mockClear();
    hex.value = "nope"; hex.dispatchEvent(new Event("change"));
    expect(parts.setDisplay).not.toHaveBeenCalled();
    card.detach();
  });
  it("see-through writes opacity, 100% clears; the eye toggles hidden", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const range = card.element.querySelector(".pf-card-seethrough");
    range.value = "40"; range.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { opacity: 0.4 });
    range.value = "100"; range.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { opacity: null });
    card.element.querySelector(".pf-card-eye").click();
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { hidden: true });
    card.detach();
  });
  it("finish sliders write their key, clamped to the range", () => {
    const parts = partsStub(rows());
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    card.show("lid");
    const r = card.element.querySelector('.pf-card-finish[data-key="roughness"]');
    r.value = "0.25"; r.dispatchEvent(new Event("input"));
    expect(parts.setDisplay).toHaveBeenLastCalledWith("lid", { roughness: 0.25 });
    card.detach();
  });
  it("footer copy follows the save state; Reset clears appearance for this part only", () => {
    const parts = partsStub(rows());
    let state = "saved";
    const card = attachAppearanceCard(parts, { onBack: () => {}, getSaveState: () => state });
    document.body.append(card.element);
    card.show("lid");
    expect(card.element.querySelector(".pf-card-foot-note").textContent).toBe("Material and colour are saved to this forge. See-through and hiding are only on this screen.");
    expect(card.element.querySelector(".pf-card-reset").textContent).toBe("Reset to authored");
    state = "blocked"; card.render();
    expect(card.element.querySelector(".pf-card-foot-note").textContent).toBe("This part's look is set by code. Ask the assistant to change it.");
    expect(card.element.querySelector(".pf-card-reset").textContent).toBe("Reset");
    card.element.querySelector(".pf-card-reset").click();
    expect(parts.clear).toHaveBeenCalledWith({ appearance: true, name: "lid" });
    card.detach();
  });
  it("Back calls onBack; show() of an unknown name returns false", () => {
    const onBack = vi.fn();
    const card = attachAppearanceCard(partsStub(rows()), { onBack, getSaveState: () => "screen-only" });
    document.body.append(card.element);
    expect(card.show("nope")).toBe(false);
    expect(card.show("lid")).toBe(true);
    card.element.querySelector(".pf-card-back").click();
    expect(onBack).toHaveBeenCalled();
    card.detach();
  });
});
```

And add to `test/view-style-popover.test.js`:

```js
  it("a swatch opens the card page; Back returns; openCard() from outside opens the popover on the card", () => {
    const vs = attachViewStyleControls(viewerStub(), { stage, toolbar, parts: partsStub(ROWS()) });
    vs.open();
    vs.popover.querySelector('.pf-parts-row[data-name="lid"] .pf-parts-swatch').click();
    expect(vs.popover.dataset.page).toBe("card");
    expect(vs.popover.querySelector(".pf-card-title").textContent).toBe("Lid");
    expect(vs.popover.querySelector(".pf-view-style-grid").hidden).toBe(true);
    vs.popover.querySelector(".pf-card-back").click();
    expect(vs.popover.dataset.page).toBe("list");
    vs.close();
    expect(vs.openCard("body")).toBe(true);
    expect(vs.isOpen()).toBe(true);
    expect(vs.popover.dataset.page).toBe("card");
    expect(vs.openCard("nope")).toBe(false);
    vs.close();
    expect(vs.popover.dataset.page).toBe("list"); // close always returns to the list
    vs.detach();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/appearance-card.test.js test/view-style-popover.test.js`
Expected: FAIL — module not found; `dataset.page` undefined.

- [ ] **Step 3: Write `appearance-card.js`**

```js
// src/framework/appearance-card.js
// The appearance card: the popover's second page, for one sub-part. Header
// (Back, label, eye, close), See-through, the material tiles, the colour row,
// the finish sliders, and a footer that says where a change goes. Every write
// is one parts.setDisplay(name, patch); the card re-renders from parts.getState
// on the change event, so what it shows is always the viewer's answer.
import { PRESETS } from "./materials/presets.js";
import { OVERRIDE_RANGES } from "./materials/resolve.js";
import { MIN_USER_OPACITY } from "./materials/overrides.js";
import { hexColor } from "./parts-list.js";

const COLORS = ["#b3261e", "#e8711a", "#e3b31c", "#2e8b57", "#1f5bd6", "#6f42c1", "#f2f2f0", "#8c8c90", "#1f1f22"];
const FINISH = [
  ["roughness", "Roughness"], ["metalness", "Metalness"], ["clearcoat", "Clearcoat"],
  ["clearcoatRoughness", "Clearcoat roughness"], ["anisotropy", "Anisotropy"], ["textureScale", "Texture scale"],
];
const FOOT = {
  "saved": { note: "Material and colour are saved to this forge. See-through and hiding are only on this screen.", reset: "Reset to authored" },
  "screen-only": { note: "Only on this screen", reset: "Reset" },
  "blocked": { note: "This part's look is set by code. Ask the assistant to change it.", reset: "Reset" },
};
const ICONS = {
  back: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`,
};
const parseHex = (s) => (/^#?[0-9a-f]{6}$/i.test(String(s).trim()) ? parseInt(String(s).trim().replace("#", ""), 16) : null);
const known = (m) => typeof m === "string" && Object.hasOwn(PRESETS, m);

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// `renderThumb(materialId, display) -> Promise<dataUrl|null>` (Task 7) paints a
// sphere into a tile; absent, tiles stay flat discs in the preset colour.
export function attachAppearanceCard(parts, { onBack, onClose, getSaveState, renderThumb = null } = {}) {
  const root = el("div", "pf-card");
  let name = null;
  let row = null;

  // --- static skeleton (rebuilt values only on render) ---
  const head = el("div", "pf-card-head");
  const back = el("button", "pf-card-back", { type: "button", "aria-label": "Back to parts" }); back.innerHTML = ICONS.back;
  const title = el("span", "pf-card-title");
  const eye = el("button", "pf-card-eye", { type: "button" });
  const close = el("button", "pf-card-close", { type: "button", "aria-label": "Close" }); close.innerHTML = ICONS.close;
  head.append(back, title, eye, close);

  const seeRow = el("label", "pf-card-row");
  const seeLab = el("span", "pf-card-lab"); seeLab.textContent = "See-through";
  const seeVal = el("span", "pf-card-val");
  const see = el("input", "pf-card-seethrough", { type: "range", min: String(Math.round(MIN_USER_OPACITY * 100)), max: "100", step: "1", "aria-label": "See-through" });
  seeRow.append(seeLab, seeVal, see);

  const matHead = el("div", "pf-card-lab-row");
  const matLab = el("span", "pf-card-lab"); matLab.textContent = "Material";
  const matVal = el("span", "pf-card-val");
  matHead.append(matLab, matVal);
  const tiles = el("div", "pf-card-tiles", { role: "group", "aria-label": "Material" });
  const tileFor = (id, label, color) => {
    const t = el("button", "pf-card-tile", { type: "button", "data-material": id, "aria-pressed": "false", title: label });
    const ball = el("span", "pf-card-ball"); ball.style.setProperty("--pf-swatch", hexColor(color));
    const img = el("img", "", { alt: "" }); img.hidden = true; ball.append(img);
    const lab = el("span", "pf-card-tile-label"); lab.textContent = label;
    t.append(ball, lab);
    return t;
  };
  tiles.append(tileFor("", "CAD", 0x9fb4cc), ...Object.values(PRESETS).map((p) => tileFor(p.id, p.label, p.color)));
  const unknown = el("p", "pf-card-unknown"); unknown.hidden = true;

  const colHead = el("div", "pf-card-lab-row");
  const colLab = el("span", "pf-card-lab"); colLab.textContent = "Colour";
  const colVal = el("span", "pf-card-val");
  colHead.append(colLab, colVal);
  const colors = el("div", "pf-card-colors");
  for (const c of COLORS) {
    const b = el("button", "pf-card-color", { type: "button", "data-color": c, title: c, "aria-label": c });
    b.style.setProperty("--pf-swatch", c);
    colors.append(b);
  }
  const native = el("input", "pf-card-native", { type: "color", "aria-label": "Custom colour" });
  colors.append(native);
  const hexRow = el("div", "pf-card-hexrow");
  const hex = el("input", "pf-card-hex", { type: "text", "aria-label": "Hex colour", spellcheck: "false", maxlength: "7" });
  hexRow.append(hex);
  const tintNote = el("p", "pf-card-tint-note"); tintNote.hidden = true;

  const finish = el("details", "pf-card-finish-group");
  const summary = el("summary"); summary.textContent = "Finish";
  finish.append(summary);
  const finishInputs = new Map();
  for (const [key, label] of FINISH) {
    const [lo, hi] = OVERRIDE_RANGES[key];
    const r = el("label", "pf-card-row");
    const lab = el("span", "pf-card-lab"); lab.textContent = label;
    const val = el("span", "pf-card-val");
    const input = el("input", "pf-card-finish", { type: "range", "data-key": key, min: String(lo), max: String(hi), step: key === "textureScale" ? "0.5" : "0.01", "aria-label": label });
    r.append(lab, val, input);
    finish.append(r);
    finishInputs.set(key, { input, val });
    input.addEventListener("input", () => { if (name) parts.setDisplay(name, { [key]: Number(input.value) }); });
  }

  const foot = el("div", "pf-card-foot");
  const note = el("span", "pf-card-foot-note");
  const reset = el("button", "pf-card-reset", { type: "button" });
  foot.append(note, reset);

  root.append(head, seeRow, matHead, tiles, unknown, colHead, colors, hexRow, tintNote, finish, foot);

  // --- wiring ---
  back.addEventListener("click", () => onBack?.());
  close.addEventListener("click", () => onClose?.());
  eye.addEventListener("click", () => { if (name && row) parts.setDisplay(name, { hidden: !row.hidden }); });
  see.addEventListener("input", () => {
    if (!name) return;
    const v = Number(see.value) / 100;
    parts.setDisplay(name, { opacity: v >= 1 ? null : v });
  });
  tiles.addEventListener("click", (e) => {
    const t = e.target.closest(".pf-card-tile");
    if (!t || !name) return;
    parts.setDisplay(name, { material: t.dataset.material === "" ? null : t.dataset.material });
  });
  colors.addEventListener("click", (e) => {
    const b = e.target.closest(".pf-card-color");
    if (!b || !name) return;
    parts.setDisplay(name, { color: parseHex(b.dataset.color) });
  });
  native.addEventListener("input", () => { const c = parseHex(native.value); if (name && c !== null) parts.setDisplay(name, { color: c }); });
  hex.addEventListener("change", () => { const c = parseHex(hex.value); if (name && c !== null) parts.setDisplay(name, { color: c }); else render(); });
  reset.addEventListener("click", () => { if (name) parts.clear({ appearance: true, name }); });

  function render() {
    if (!name) return;
    row = parts.list().find((r) => r.name === name) ?? null;
    const state = parts.getState(name);
    if (!row || !state) return;
    title.textContent = row.label;
    eye.innerHTML = row.hidden ? ICONS.eyeOff : ICONS.eye;
    eye.setAttribute("aria-pressed", String(row.hidden));
    eye.setAttribute("aria-label", `${row.hidden ? "Show" : "Hide"} ${row.label}`);
    eye.title = eye.getAttribute("aria-label");
    const pct = Math.round(row.opacity * 100);
    see.value = String(pct); seeVal.textContent = `${pct}%`;
    const m = state.effective.material;
    const pressed = known(m) ? m : "";
    for (const t of tiles.children) t.setAttribute("aria-pressed", String(t.dataset.material === pressed));
    matVal.textContent = row.materialLabel ?? "None";
    unknown.hidden = !(m != null && !known(m));
    unknown.textContent = unknown.hidden ? "" : String(m);
    const color = row.color;
    colVal.textContent = row.tintable ? hexColor(color) : "from the material";
    colors.classList.toggle("disabled", !row.tintable);
    hex.disabled = !row.tintable;
    for (const b of colors.querySelectorAll(".pf-card-color")) b.classList.toggle("on", parseHex(b.dataset.color) === color);
    native.value = hexColor(color);
    if (document.activeElement !== hex) hex.value = hexColor(color);
    tintNote.hidden = row.tintable;
    tintNote.textContent = row.tintable ? "" : `${row.materialLabel} has its own colour. Pick a tintable preset to colour it.`;
    for (const [key, { input, val }] of finishInputs) {
      const v = state.effective[key];
      const shown = typeof v === "number" ? v : (known(m) ? (PRESETS[m][key] ?? 0) : 0);
      input.value = String(shown); val.textContent = key === "textureScale" ? `${shown} mm` : shown.toFixed(2);
    }
    const f = FOOT[getSaveState?.() ?? "screen-only"] ?? FOOT["screen-only"];
    note.textContent = f.note; reset.textContent = f.reset;
    if (renderThumb) paintThumbs(state.effective);
  }

  // Thumbnails: one per tile, lazily, in order, cached by the renderer (Task 7).
  let thumbToken = 0;
  async function paintThumbs(effective) {
    const token = ++thumbToken;
    for (const t of tiles.children) {
      if (token !== thumbToken || !root.isConnected) return;
      const id = t.dataset.material;
      if (id === "") continue;
      let url = null;
      try { url = await renderThumb(id, { ...effective, material: id }); } catch { url = null; }
      if (token !== thumbToken) return;
      const img = t.querySelector("img");
      if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
    }
  }

  const off = parts.onChange(() => render());
  return {
    element: root,
    show(next) {
      if (!parts.list().some((r) => r.name === next)) return false;
      name = next;
      render();
      return true;
    },
    hide() { name = null; thumbToken++; },
    render,
    detach() { try { off(); } catch { /* gone */ } root.remove(); },
  };
}
```

- [ ] **Step 4: Page switching in `view-style-controls.js`**

Replace the Task 5 placeholders (`let openCard = () => false; let saveState = "screen-only";`) with:

```js
  let saveState = "screen-only";
  let card = null;
  const listNodes = () => [styleHead, grid, divider2, partsList?.element].filter(Boolean);
  function showPage(page) {
    pop.dataset.page = page;
    for (const n of listNodes()) n.hidden = page !== "list";
    if (card) card.element.hidden = page !== "card";
    if (page === "list") card?.hide();
    if (isOpen()) place();
  }
  if (parts) {
    card = attachAppearanceCard(parts, {
      onBack: () => showPage("list"),
      onClose: () => close(),
      getSaveState: () => saveState,
      renderThumb: viewer.renderMaterialThumbnail ? (id, display) => viewer.renderMaterialThumbnail(display, { size: 96 }) : null,
    });
    card.element.hidden = true;
    pop.append(card.element);
  }
  pop.dataset.page = "list";
  // Open the popover (if it is closed) on the card for `name`. False when there
  // is no card (no `parts` seam) or `name` is not a sub-part.
  function openCard(name) {
    if (!card) return false;
    if (!isOpen()) open();
    if (!isOpen()) return false; // the host is hidden: nothing to show on
    if (!card.show(name)) return false;
    showPage("card");
    card.element.querySelector(".pf-card-back")?.focus();
    return true;
  }
```

Import `attachAppearanceCard`. In `close()`, after `pop.hidden = true;` add `showPage("list");` so the next open starts on the list. In `detach()`, add `card?.detach();`. Keep the returned `openCard`/`setSaveState`/`getSaveState` from Task 5 (they now do the real thing). `setSaveState` should also `card?.render()` when the card is showing.

- [ ] **Step 5: CSS for the card**

Append to `app.css`:

```css
.pf-card { display: flex; flex-direction: column; gap: 10px; }
.pf-card[hidden] { display: none; }
.pf-card-head { display: flex; align-items: center; gap: 4px; }
.pf-card-title { flex: 1; min-width: 0; font-weight: 600; font-size: 13px; color: var(--pf-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-card-back, .pf-card-eye, .pf-card-close { width: 28px; height: 28px; border: 0; background: none; color: var(--pf-muted-2); border-radius: 6px; display: grid; place-items: center; cursor: pointer; }
.pf-card-back:hover, .pf-card-eye:hover, .pf-card-close:hover { background: var(--pf-surface-2); color: var(--pf-text); }
.pf-card-eye[aria-pressed="true"] { color: var(--pf-hint); }
.pf-card-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: baseline; }
.pf-card-row input[type="range"] { grid-column: 1 / -1; width: 100%; margin: 0; accent-color: var(--pf-accent); }
.pf-card-lab-row { display: flex; justify-content: space-between; align-items: baseline; }
.pf-card-lab { font-size: 12px; color: var(--pf-muted); }
.pf-card-val { font-size: 12px; color: var(--pf-text-2); font-variant-numeric: tabular-nums; }
.pf-card-tiles { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
.pf-card-tile { display: grid; justify-items: center; gap: 3px; border: 0; background: none; padding: 3px 0; border-radius: 8px; cursor: pointer; font: inherit; color: var(--pf-muted); }
.pf-card-tile:hover { background: var(--pf-surface-2); }
.pf-card-tile[aria-pressed="true"] { background: var(--pf-accent-soft); color: var(--pf-accent); }
.pf-card-ball { position: relative; width: 30px; height: 30px; border-radius: 50%; overflow: hidden; background: radial-gradient(circle at 35% 30%, color-mix(in oklab, var(--pf-swatch) 72%, white) 0, var(--pf-swatch) 48%, color-mix(in oklab, var(--pf-swatch) 68%, black) 100%); box-shadow: inset 0 -1px 2px rgb(0 0 0 / .25); }
.pf-card-ball img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.pf-card-ball img[hidden] { display: none; }
.pf-card-tile-label { font-size: 9.5px; line-height: 1.1; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-card-unknown { margin: 0; font-size: 11px; color: var(--pf-err); font-family: var(--pf-mono); }
.pf-card-unknown[hidden] { display: none; }
.pf-card-colors { display: grid; grid-template-columns: repeat(10, 1fr); gap: 6px; }
.pf-card-colors.disabled { opacity: .35; pointer-events: none; }
.pf-card-color { width: 100%; aspect-ratio: 1; border-radius: 50%; border: 0; padding: 0; cursor: pointer; background: var(--pf-swatch); box-shadow: inset 0 0 0 1px rgb(0 0 0 / .18); }
.pf-card-color.on, .pf-card-color:hover { box-shadow: inset 0 0 0 1px rgb(0 0 0 / .18), 0 0 0 2px var(--pf-surface), 0 0 0 4px var(--pf-accent); }
.pf-card-native { width: 100%; aspect-ratio: 1; border: 1px solid var(--pf-border); border-radius: 50%; padding: 0; background: none; cursor: pointer; }
.pf-card-hex { width: 100%; font: 12px var(--pf-mono); padding: 5px 8px; border: 1px solid var(--pf-border); border-radius: var(--pf-radius-control); background: var(--pf-input-bg); color: var(--pf-text); }
.pf-card-hex:disabled { opacity: .5; }
.pf-card-tint-note { margin: 0; font-size: 12px; color: var(--pf-muted); }
.pf-card-tint-note[hidden] { display: none; }
.pf-card-finish-group summary { cursor: pointer; font-size: 12px; color: var(--pf-muted-2); list-style: none; display: flex; align-items: center; gap: 6px; }
.pf-card-finish-group summary::before { content: ""; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); }
.pf-card-finish-group[open] summary::before { transform: rotate(45deg); }
.pf-card-finish-group .pf-card-row { margin-top: 8px; }
.pf-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--pf-muted); border-top: 1px solid var(--pf-border); padding-top: 10px; }
.pf-card-reset { font: inherit; font-weight: 500; color: var(--pf-accent); background: none; border: 0; padding: 0; cursor: pointer; white-space: nowrap; }
.pf-card button:focus-visible, .pf-card input:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklab, var(--pf-accent) 35%, transparent); }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/appearance-card.test.js test/view-style-popover.test.js test/tokens.test.js`
Expected: PASS.

- [ ] **Step 7: Manual check** (`materials.html`): swatch → card; tiles switch the material live in both modes; colour row disabled on Brass with the note; See-through fades; eye hides and the card stays on that part (hidden state shown); Back returns; Escape closes and the next open is the list; `__pf.openAppearance("<name>")` from the console opens straight onto the card; `__pf.setDisplaySaveState("saved")` changes the footer.

- [ ] **Step 8: Commit**

```bash
git add src/framework/appearance-card.js src/framework/view-style-controls.js src/framework/app.css test/appearance-card.test.js test/view-style-popover.test.js
git commit -m "popover: appearance card page (materials, colour, see-through, finish, footer) with Back"
```

---

### Task 7: Sphere thumbnails for the material tiles

**Files:**
- Modify: `src/framework/viewer.js` (new `renderMaterialThumbnail`), `src/framework/view-style-controls.js` (cache invalidation on environment/theme change)
- Test: `test/material-thumb-cache.test.js` (new, pure cache); the render itself is a manual check.

**Interfaces:**
- Produces: `viewer.renderMaterialThumbnail(display, { size = 96 }) → Promise<dataUrl | null>`: a sphere in `display`'s material under the current look (CAD look if the live mode is CAD; the live environment's envMap and tone mapping if realistic), rendered in a throwaway scene (never the live one), cached per `(material id, color, environment id, theme, renderMode)`; `null` when disposed or on any failure. `viewer.invalidateMaterialThumbnails()` clears the cache.
- `src/framework/materials/thumb-cache.js` (new, pure): `createMaterialThumbCache()` → `{ key(display, env, theme, mode), get(key), set(key, url), clear() }` with an LRU cap of 120 entries.

- [ ] **Step 1: Write the failing cache test**

```js
// test/material-thumb-cache.test.js
import { describe, it, expect } from "vitest";
import { createMaterialThumbCache } from "../src/framework/materials/thumb-cache.js";

describe("material thumbnail cache", () => {
  it("keys on material, colour, environment, theme and mode; ignores finish overrides", () => {
    const c = createMaterialThumbCache();
    const a = c.key({ material: "oak", color: 0x112233, roughness: 0.2 }, "studio", "dark", "realistic");
    const b = c.key({ material: "oak", color: 0x112233, roughness: 0.9 }, "studio", "dark", "realistic");
    expect(a).toBe(b);
    expect(c.key({ material: "oak" }, "studio", "dark", "realistic")).not.toBe(a);
    expect(c.key({ material: "oak", color: 0x112233 }, "workshop", "dark", "realistic")).not.toBe(a);
    expect(c.key({ material: "oak", color: 0x112233 }, "studio", "light", "realistic")).not.toBe(a);
    expect(c.key({ material: "oak", color: 0x112233 }, "studio", "dark", "cad")).not.toBe(a);
  });
  it("evicts the oldest past 120 entries and clears", () => {
    const c = createMaterialThumbCache();
    for (let i = 0; i < 125; i++) c.set(`k${i}`, `u${i}`);
    expect(c.get("k0")).toBeUndefined();
    expect(c.get("k124")).toBe("u124");
    c.clear();
    expect(c.get("k124")).toBeUndefined();
  });
});
```

Run: `npx vitest run test/material-thumb-cache.test.js` → FAIL (module not found).

- [ ] **Step 2: Write the cache**

```js
// src/framework/materials/thumb-cache.js
// Keys and bounds for the appearance card's sphere thumbnails. Finish overrides
// are NOT in the key: a tile shows the preset, and re-rendering 25 spheres on
// every slider tick would make the card unusable.
const CAP = 120;
export function createMaterialThumbCache() {
  const map = new Map();
  return {
    key: (display, env, theme, mode) => `${display?.material ?? ""}|${display?.color ?? ""}|${env}|${theme}|${mode}`,
    get(k) { const v = map.get(k); if (v !== undefined) { map.delete(k); map.set(k, v); } return v; },
    set(k, url) { map.delete(k); map.set(k, url); if (map.size > CAP) map.delete(map.keys().next().value); },
    clear() { map.clear(); },
  };
}
```

Run the test → PASS.

- [ ] **Step 3: `viewer.renderMaterialThumbnail`**

In `viewer.js`, after `renderStyleThumbnail`, add:

```js
  // A sphere in `display`'s material under the current look, for the
  // appearance card's tiles. A THROWAWAY scene (never the live one): in CAD it
  // is the flattened CAD material under the capture lights; in realistic it is
  // the physical material lit by the live rig's envMap with its tone mapping.
  // Cached per (material, colour, environment, theme, mode); null on failure.
  const materialThumbs = createMaterialThumbCache();
  const _thumbSphere = new THREE.SphereGeometry(1, 48, 32);
  async function renderMaterialThumbnail(display, { size = 96 } = {}) {
    if (disposed) return null;
    const key = materialThumbs.key(display, environmentId, currentTheme, renderMode);
    const hit = materialThumbs.get(key);
    if (hit !== undefined) return hit;
    try {
      const tmp = new THREE.Scene();
      const realistic = renderMode === "realistic" && realisticRig;
      let mat;
      if (realistic) {
        mat = buildPhysicalMaterial(display, { loadTexture });
        tmp.environment = realisticRig.envMap;
        tmp.environmentRotation.set(0, realisticRig.rotationY ?? 0, 0);
        tmp.background = null;
      } else {
        mat = buildCadMaterial(display, material);
        tmp.add(createHemisphereLight());
        const { key: k, fill: f } = createCaptureLights();
        k.position.set(3, 4, 5); f.position.set(-4, 1, 5);
        tmp.add(k, k.target, f, f.target);
      }
      const mesh = new THREE.Mesh(_thumbSphere, mat);
      tmp.add(mesh);
      const url = renderOffscreen(
        { position: [0, 0, 3.2], up: [0, 1, 0], target: [0, 0, 0] },
        { width: size, height: size, fov: 40, quality: 0.85, sceneBounds: { center: [0, 0, 0], radius: 1.2 } },
        tmp,
      );
      if (mat !== material) mat.dispose();
      materialThumbs.set(key, url);
      return url;
    } catch (e) {
      console.warn("partforge: material thumbnail failed", e);
      return null;
    }
  }
  const invalidateMaterialThumbnails = () => materialThumbs.clear();
```

`renderOffscreen`'s `realistic` flag keys on `renderScene === scene`, so the throwaway scene renders through the non-HDR, non-tone-mapped path; in realistic mode that leaves the sphere too dark. Make the flag read `realistic = renderMode === "realistic" && (renderScene === scene || renderScene.environment != null)` so a throwaway scene that carries an environment is treated as realistic (tone mapped, HDR readback). Export both functions from the returned object, and call `invalidateMaterialThumbnails()` from `setTheme`, `setEnvironment`'s settle, and the end of `enterRealistic`/`enterCad` (one line each; grep the four sites).

- [ ] **Step 4: Invalidate from the popover on look changes**

In `view-style-controls.js`'s `offs` array add:

```js
    viewer.onRenderModeChange(() => { viewer.invalidateMaterialThumbnails?.(); if (pop.dataset.page === "card") card?.render(); }),
    viewer.onEnvironmentChange(() => { viewer.invalidateMaterialThumbnails?.(); if (pop.dataset.page === "card") card?.render(); }),
```

(The existing two `render()` entries stay.)

- [ ] **Step 5: Run the suite; manual check**

Run: `npx vitest run` → PASS.
`materials.html`: open a card in CAD: tiles fill with lit spheres over a few frames; switch to Studio: they re-render as physical spheres under the environment (brass reflects, acrylic is clear, oak shows grain); switch environment: they re-render; reopen the card: instant (cached). Drag a finish slider: no re-render.

- [ ] **Step 6: Commit**

```bash
git add src/framework/materials/thumb-cache.js src/framework/viewer.js src/framework/view-style-controls.js test/material-thumb-cache.test.js
git commit -m "viewer: sphere thumbnails for the appearance card's material tiles"
```

---

### Task 8: Docs, version, check

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (the `runtime.renderMode…` section at ~3247 and "Materials and appearance" at ~368), `package.json`, `AGENTS.md` (architecture list, one line).

- [ ] **Step 1: Runtime docs**

Add a subsection after `### runtime.renderMode, runtime.environment, …`:

```markdown
### `runtime.setSubPartDisplay`, `runtime.listSubParts`, `runtime.openAppearance`

A viewer user can change how one sub-part looks, or hide it, without a rebuild.
The View style popover (the eye) has a **Parts** section — the sub-parts in the
active view, an eye and a swatch each — and the swatch opens an appearance card
(material presets, colour for tintable presets, finish, See-through). A host can
drive the same state:

- `runtime.setSubPartDisplay(name, patch)` — merges `patch` over the sub-part's
  override and returns the override now held (`null` when nothing is left, or
  for an unknown `name`). Appearance keys (`material`, `color`, `roughness`,
  `metalness`, `clearcoat`, `clearcoatRoughness`, `anisotropy`, `textureScale`)
  merge over the authored `display` for every render — CAD, realistic and the
  `captureView` thumbnail — so a tile picked here is drawn exactly as if it had
  been authored. Two **viewing** keys are different: `hidden` (boolean) and
  `opacity` (0.05–1, a multiplier on an authored `display.opacity`). They are
  how the user is looking: never part of a material read, an export, lint or
  `declaresMaterials`, and `captureViews` / `renderViews` (the agent's renders)
  draw every sub-part as if they were unset. `captureCurrent` follows them,
  like the screen, unless called with `{ includeHidden: true }`. A `null` value
  clears a key; `hidden: false` and `opacity: 1` clear theirs.
- `runtime.getSubPartDisplay(name)` → `{ authored, override, effective, hidden,
  opacity }`, or `null`.
- `runtime.clearSubPartDisplay({ viewing?, appearance?, name? })` — Show all is
  `{ viewing: true }`; the card's Reset is `{ appearance: true, name }`.
- `runtime.onSubPartDisplayChange(cb)` — `cb({ name, override })` after a
  change, `cb(null)` after a clear; returns the unsubscribe. A host that
  persists overrides into source (partforge-cloud writes the sub-part's
  `display` literal) listens here.
- `runtime.listSubParts({ view? })` — every sub-part as `{ name, label, inView,
  hidden, opacity, effective, color, materialLabel, tintable, overridden }`, in
  definition order, for the active view unless `view` names another.
- `runtime.openAppearance(name)` — opens the popover on the card for `name`;
  `runtime.setDisplaySaveState("saved" | "screen-only" | "blocked")` sets the
  card's footer line ("screen-only" is the default; a host that saves says so).

The override map rides `viewerState.display` and comes back through
`mount({ viewerState })`, pruned for the new part: an entry for a sub-part the
part no longer declares is dropped, and an appearance key that now equals the
authored value is dropped (a host that saved the change into source sees its
override vanish on the next mount, which is the intended self-clean).
```

And one paragraph at the end of "Materials and appearance" (before "## Geometry"):

```markdown
**Viewers can change a sub-part's look.** The View style popover's Parts
section lets a user pick a material and colour per sub-part, fade it, or hide
it, live and without a rebuild (`runtime.setSubPartDisplay` below). Material
and colour draw exactly as if authored, and a host may write them back into
`display`; hiding and see-through are only ever how the screen looks — exports,
`captureViews` and `renderViews` never see them.
```

- [ ] **Step 2: Version and AGENTS.md**

`package.json`: `"version": "0.149.0"`. In `AGENTS.md`'s `src/framework/` architecture list, add after the `view-style-controls.js` mention (or the materials bullet): `materials/overrides.js` (the per-sub-part display override model), `sub-part-list.js`, `parts-list.js`, `appearance-card.js` — one line: "the Parts section and appearance card inside the View style popover (spec 2026-10-13); viewing keys never reach exports or agent captures".

- [ ] **Step 3: Full verification**

Run: `npm test && npm run lint && npm run lint:dead && npm run typecheck && npm run check`
Expected: all green. `knip` must not flag the new modules (they are imported); if it flags `hexColor`'s second export use, keep it — it is used by `appearance-card.js`.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/AUTHORING-PARTS.md package.json AGENTS.md
git commit -m "docs: runtime display override hops; 0.149.0"
git push -u origin claude/part-appearance-controls
```

Then `gh pr create` with a reader-facing description (what a user can now do in the popover; what hosts get; the version note about #273), ending with the attribution line this session uses.

---

## Self-review

- **Spec coverage.** A.1 (model) → Task 1. A.2 (hops) → Task 4 (`getSubPartDisplay` is `getSubPartDisplayState` on the viewer, named per the spec on the handle). A.3 (viewer, captures table) → Task 3 (`captureCanonicalViews`/`renderViews` reveal; `captureCurrent({includeHidden})`; `captureView` uses `materialFor` → effective by construction; hide beside anim; see-through on the fade path; shadow casters skip faded; thumbnail invalidation → Task 7's `onDisplayChange` is covered by the popover's existing `onAssemblyChange`? No: add `viewer.onDisplayChange?.(() => cache.invalidate())` to the popover's `offs` in Task 5, Step 4 — done as part of that step's edit). A.4 (viewerState) → Task 4. A.5 (Parts section, 5-col grid) → Task 5. A.6 (card, second page) → Task 6; tile thumbnails → Task 7. A.7 (docs) → Task 8.
- **Placeholders.** None; every step carries its code or exact command.
- **Type consistency.** Viewer: `setSubPartDisplay`, `getSubPartDisplayState`, `getDisplayOverrides`, `clearSubPartDisplay({viewing, appearance, name})`, `onDisplayChange`, `effectiveDisplayOf`, `renderMaterialThumbnail`, `invalidateMaterialThumbnails`. Handle: `setSubPartDisplay`, `getSubPartDisplay`, `clearSubPartDisplay`, `onSubPartDisplayChange`, `listSubParts`, `openAppearance`, `setDisplaySaveState`. Popover: `openCard`, `setSaveState`, `getSaveState`; `parts` seam `{ list, setDisplay, clear, onChange, onViewChange, getState }`. Card: `attachAppearanceCard(parts, { onBack, onClose, getSaveState, renderThumb })`. Consistent across tasks.
- **Review Focus.** Each line names its task; the popover's `onDisplayChange → cache.invalidate()` line is folded into Task 5 Step 4's edit list.
