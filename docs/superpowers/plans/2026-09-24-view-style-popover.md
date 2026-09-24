# View Style Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scattered view controls (viewbar ✦ + environment select, the view cube's projection button) with one "view style" popover — live cached thumbnails per style, a per-style feature-lines switch, and a projection selector — opened from a new, more visible button beside the view cube that replaces its projection toggle.

**Architecture:** The viewer becomes the authority for feature lines (a per-style preference map; the effective value follows the current style) and gains `renderStyleThumbnail` (a borrowed-look capture in any style) plus an `onAssemblyChange` event. A pure `view-style-state.js` holds the style list, defaults and the thumbnail cache; `view-style-controls.js` generates the DOM (the view cube precedent — no host markup), replacing `realistic-controls.js`. `mount.js` wires it, restores/persists the lines preference, carries it in `viewerState`, and exposes `runtime.featureLines`.

**Tech Stack:** Vanilla JS ES modules, three.js r184, vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-09-24-view-style-popover-design.md`

## Global Constraints

- Work in `/Users/scottsykora/Documents/Docs/pixite/code/partforge/.claude/worktrees/view-style-popover` (branch `claude/view-style-popover`). Node 24: prefix commands with `source ~/.nvm/nvm.sh >/dev/null && nvm use >/dev/null &&`.
- Test runner: `npx vitest run <file>`; full suite `npm test`; lint `npx eslint src test`.
- Styles, in order: `cad`, then `Object.values(ENVIRONMENTS)` order (`studio`, `workshop`, `print-bed`, `outdoor`). CAD label "CAD"; environment labels from `ENVIRONMENTS[id].label`.
- Feature-lines defaults: `cad → true`, every environment → `false`.
- Agent-facing canonical renders are unchanged: `captureCanonicalViews` / `renderViews(…,{renderMode:"cad"})` always draw lines; `renderViews(…,{renderMode:"realistic"})` never does — regardless of the user's switch.
- Persistence key: `partforge:featureLines`, a JSON object `{ [styleId]: boolean }`; unknown keys and non-boolean values are dropped on read. Storage never throws (view-state.js's guarded read/write).
- Generated DOM ids: button `#view-style`, popover `#pf-view-style-popover`. The drawer toggle (`#rail-toggle`) is NOT touched. Classes: `.pf-view-style-button`, `.pf-view-style-popover`, `.pf-view-style-grid`, `.pf-view-style-tile`, `.pf-view-style-thumb`, `.pf-view-style-row`, `.pf-view-style-switch`, `.pf-view-style-seg`.
- Colours only from existing `--pf-*` tokens (both themes).
- Comment style: match the surrounding files — explain *why*, dense where the code is subtle.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Style list, defaults, thumbnail cache, and the lines preference store

**Files:**
- Create: `src/framework/view-style-state.js`
- Modify: `src/framework/view-state.js`
- Test: `test/framework/view-style-state.test.js`, `test/framework/view-state.test.js`

**Interfaces:**
- Produces:
  - `STYLES: {id: string, label: string}[]`
  - `defaultFeatureLines(style: string): boolean`
  - `styleFor(renderMode: "cad"|"realistic", environmentId: string): string` — `"cad"` in CAD, else the environment id
  - `createThumbnailCache(): { get(id): string|null|undefined, set(id, url|null), isStale(): boolean, markFresh(): void, invalidate(): void, generation(): number }` — starts stale; `invalidate()` sets stale and bumps `generation()`
  - view-state: `loadFeatureLinesPrefs(): Record<string, boolean>` (filtered to known style ids), `saveFeatureLinesPrefs(prefs: Record<string, boolean>): void`

- [ ] **Step 1: Write the failing tests**

`test/framework/view-style-state.test.js`:
```js
import { expect, test } from "vitest";
import { STYLES, defaultFeatureLines, styleFor, createThumbnailCache } from "../../src/framework/view-style-state.js";

test("styles are CAD first, then every environment in order", () => {
  expect(STYLES.map((s) => s.id)).toEqual(["cad", "studio", "workshop", "print-bed", "outdoor"]);
  expect(STYLES[0].label).toBe("CAD");
  expect(STYLES[3].label).toBe("Print bed");
});

test("feature lines default on for CAD and off for every realistic style", () => {
  expect(defaultFeatureLines("cad")).toBe(true);
  for (const s of STYLES.slice(1)) expect(defaultFeatureLines(s.id)).toBe(false);
});

test("the current style is cad in CAD and the environment in realistic", () => {
  expect(styleFor("cad", "workshop")).toBe("cad");
  expect(styleFor("realistic", "workshop")).toBe("workshop");
});

test("the thumbnail cache starts stale and a part change makes it stale again", () => {
  const c = createThumbnailCache();
  expect(c.isStale()).toBe(true);
  c.markFresh();
  c.set("cad", "data:x");
  expect(c.isStale()).toBe(false);
  expect(c.get("cad")).toBe("data:x");
  const g = c.generation();
  c.invalidate();
  expect(c.isStale()).toBe(true);
  expect(c.generation()).toBe(g + 1);
  expect(c.get("cad")).toBe("data:x"); // old image stays until replaced
});
```

Append to `test/framework/view-state.test.js` (match that file's existing localStorage setup/teardown):
```js
import { loadFeatureLinesPrefs, saveFeatureLinesPrefs } from "../../src/framework/view-state.js";

test("feature-lines prefs round-trip, dropping unknown styles and non-booleans", () => {
  saveFeatureLinesPrefs({ cad: false, studio: true });
  expect(loadFeatureLinesPrefs()).toEqual({ cad: false, studio: true });
  localStorage.setItem("partforge:featureLines", JSON.stringify({ moon: true, workshop: "yes", outdoor: true }));
  expect(loadFeatureLinesPrefs()).toEqual({ outdoor: true });
  localStorage.setItem("partforge:featureLines", "{not json");
  expect(loadFeatureLinesPrefs()).toEqual({});
});
```

- [ ] **Step 2: Run to confirm they fail**

`npx vitest run test/framework/view-style-state.test.js test/framework/view-state.test.js` → FAIL (module / exports missing).

- [ ] **Step 3: Implement**

`src/framework/view-style-state.js`:
```js
// src/framework/view-style-state.js
// The view style popover's pure half: which styles exist, what feature lines
// default to in each, and the thumbnail cache's freshness. No DOM, no three —
// view-style-controls.js is the DOM, the viewer owns the lines themselves.
import { ENVIRONMENTS } from "./materials/environments.js";

// CAD first, then the environments in their declared order.
export const STYLES = [
  { id: "cad", label: "CAD" },
  ...Object.values(ENVIRONMENTS).map(({ id, label }) => ({ id, label })),
];

// CAD is a drawing, so its edges are on; a realistic style is a photograph,
// so they start off — the behaviour before the switch existed.
export const defaultFeatureLines = (style) => style === "cad";

export const styleFor = (renderMode, environmentId) => (renderMode === "realistic" ? environmentId : "cad");

// Thumbnails are rendered on OPEN and cached. `invalidate` (a part or theme
// change) only marks them stale — the next open re-renders — and bumps a
// generation so a render already in flight knows to stop painting.
export function createThumbnailCache() {
  const images = new Map();
  let stale = true;
  let gen = 0;
  return {
    get: (id) => images.get(id),
    set: (id, url) => { images.set(id, url); },
    isStale: () => stale,
    markFresh: () => { stale = false; },
    invalidate: () => { stale = true; gen += 1; },
    generation: () => gen,
  };
}
```

In `src/framework/view-state.js`: add `featureLines: "partforge:featureLines",` to `KEY`, and after `saveEnvironment`:
```js
// Feature lines are remembered PER STYLE ("cad" or an environment id); a style
// with no entry uses its default (view-style-state.js). Unknown styles and
// non-boolean values are dropped, so an older or corrupt value reads as {}.
const knownStyle = (id) => id === "cad" || Object.hasOwn(ENVIRONMENTS, id);
export function loadFeatureLinesPrefs() {
  let raw;
  try { raw = JSON.parse(read(KEY.featureLines) ?? "{}"); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => knownStyle(k) && typeof v === "boolean"));
}

export function saveFeatureLinesPrefs(prefs) {
  write(KEY.featureLines, JSON.stringify(prefs ?? {}));
}
```

- [ ] **Step 4: Run to confirm they pass**

`npx vitest run test/framework/view-style-state.test.js test/framework/view-state.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/view-style-state.js src/framework/view-state.js test/framework/view-style-state.test.js test/framework/view-state.test.js
git commit -m "View style state: style list, per-style line defaults, thumbnail cache, lines prefs"
```

---

### Task 2: Feature lines in the viewer, mount restore/persist, runtime API

**Files:**
- Modify: `src/framework/viewer.js` (applySubOpacity ~L351-380, enterRealistic/enterCad, captureCanonicalViews ~L1495, renderViews, returned API ~L2009)
- Modify: `src/framework/mount.js` (restore ~L650-673, makeHandle getViewerState ~L110, runtime API ~L1340)
- Test: `test/framework/viewer-realistic.test.js`, `test/framework/mount-realistic.test.js`

**Interfaces:**
- Consumes: `defaultFeatureLines`, `styleFor` (Task 1); `loadFeatureLinesPrefs`, `saveFeatureLinesPrefs` (Task 1).
- Produces (viewer): `setFeatureLines(on: boolean): void` (for the CURRENT style), `getFeatureLines(): boolean` (effective, current style), `getFeatureLinesPrefs(): Record<string,boolean>` (a copy), `setFeatureLinesPrefs(prefs): void` (replace the map, re-apply), `onFeatureLinesChange(cb: ({style, on}) => void): () => void` (fires on setFeatureLines and setFeatureLinesPrefs).
- Produces (mount handle): `runtime.featureLines: { get(): boolean, set(on): void, onChange(cb): () => void }`; `getViewerState()` gains `featureLines: Record<string,boolean>` (the prefs map).

- [ ] **Step 1: Write the failing tests** (append to `test/framework/viewer-realistic.test.js`; `shown`, `stubCanvas`, `recordRenders` already exist there)

```js
test("feature lines follow a per-style preference in both modes", async () => {
  const v = shown();
  expect(v.getFeatureLines()).toBe(true);           // CAD default
  v.setFeatureLines(false);
  expect(v.__subLines("body").visible).toBe(false);
  await v.setRenderMode("realistic");
  expect(v.getFeatureLines()).toBe(false);          // studio default
  v.setFeatureLines(true);
  expect(v.__subLines("body").visible).toBe(true);  // lines in realistic now possible
  await v.setEnvironment("workshop");
  expect(v.__subLines("body").visible).toBe(false); // workshop keeps its own default
  await v.setEnvironment("studio");
  expect(v.__subLines("body").visible).toBe(true);
  await v.setRenderMode("cad");
  expect(v.__subLines("body").visible).toBe(false); // CAD remembered off
  expect(v.getFeatureLinesPrefs()).toEqual({ cad: false, studio: true });
  v.dispose();
});

test("setFeatureLinesPrefs replaces the map and re-applies; listeners hear explicit changes", async () => {
  const v = shown();
  const heard = [];
  v.onFeatureLinesChange((e) => heard.push(e));
  v.setFeatureLinesPrefs({ cad: false });
  expect(v.__subLines("body").visible).toBe(false);
  v.setFeatureLines(true);
  expect(heard).toEqual([{ style: "cad", on: false }, { style: "cad", on: true }]);
  v.dispose();
});

test("agent renders ignore the switch: CAD always with lines, realistic always without", async () => {
  stubCanvas();
  const v = shown();
  v.setFeatureLinesPrefs({ cad: false, studio: true });
  const seen = [];
  state.renderer.render = () => { seen.push(v.__subLines("body").visible); };
  state.renderer.setRenderTarget = () => {};
  v.captureCanonicalViews(["iso"]);
  expect(seen.at(-1)).toBe(true);
  await v.renderViews(["iso"], { renderMode: "realistic" });
  expect(seen.at(-1)).toBe(false);
  expect(v.__subLines("body").visible).toBe(false); // live CAD, user's "off", restored
  v.dispose();
});
```

Append to `test/framework/mount-realistic.test.js` (use that file's existing mount harness to get a `runtime`; mirror how its other tests read `getViewerState()` and seed `localStorage`):
```js
test("feature lines: restored from storage, carried in viewerState, exposed on the runtime", async () => {
  localStorage.setItem("partforge:featureLines", JSON.stringify({ cad: false }));
  const runtime = await mountForTest(); // the file's existing helper name — use whatever it is
  expect(runtime.featureLines.get()).toBe(false);
  runtime.featureLines.set(true);
  expect(JSON.parse(localStorage.getItem("partforge:featureLines"))).toEqual({ cad: true });
  expect(runtime.getViewerState().featureLines).toEqual({ cad: true });
  runtime.dispose();
});
```
(If the harness names differ, adapt the calls — the assertions are the requirement.)

- [ ] **Step 2: Run to confirm they fail**

`npx vitest run test/framework/viewer-realistic.test.js test/framework/mount-realistic.test.js` → the new tests FAIL.

- [ ] **Step 3: Implement — viewer**

Import at the top of viewer.js: `import { defaultFeatureLines, styleFor } from "./view-style-state.js";`

Near the other realistic state (after `let environmentChosen`):
```js
  // Feature lines, remembered per style (view-style-state.js has the defaults).
  // `linesOverride` pins them for a capture that must not follow the user's
  // switch: agent-facing CAD renders always draw them, realistic ones never.
  let featureLinesPrefs = {};
  let linesOverride = null;
  const linesListeners = new Set();
  const currentStyle = () => styleFor(renderMode, realisticRig?.id ?? environmentId);
  const linesOn = () => linesOverride ?? (featureLinesPrefs[currentStyle()] ?? defaultFeatureLines(currentStyle()));
  function refreshFeatureLines() { for (const n of names) applySubOpacity(n); }
  function withFeatureLines(on, fn) {
    const before = linesOverride;
    linesOverride = on;
    refreshFeatureLines();
    try { return fn(); } finally { linesOverride = before; refreshFeatureLines(); }
  }
  function announceFeatureLines() {
    const evt = { style: currentStyle(), on: linesOn() };
    for (const cb of [...linesListeners]) {
      try { cb(evt); } catch (e) { console.warn("partforge: feature-lines listener failed", e); }
    }
  }
  function setFeatureLines(on) {
    featureLinesPrefs = { ...featureLinesPrefs, [currentStyle()]: !!on };
    refreshFeatureLines();
    announceFeatureLines();
  }
  function setFeatureLinesPrefs(prefs) {
    featureLinesPrefs = { ...(prefs ?? {}) };
    refreshFeatureLines();
    announceFeatureLines();
  }
```
NOTE: `names`, `applySubOpacity`, `renderMode`, `realisticRig` are declared elsewhere in `createViewer`; place this block after all of them are declared (function declarations hoist; `let` bindings must be initialised before first CALL, not before this text). If `realisticRig`/`renderMode` are declared later in the file, put the block after them.

In `applySubOpacity`, replace both `lines.visible = shown && renderMode === "cad";` with `lines.visible = shown && linesOn();`.

At the end of `enterRealistic`'s `try` (after `if (live) applyPixelRatio("realistic");`) and at the end of `enterCad` (before `if (firstError) throw firstError;`, as `attempt(refreshFeatureLines);`) call `refreshFeatureLines()` — the style (and with it the lines) changed. (setSubMaterials already re-applies per sub-part, but it runs BEFORE `realisticRig` is reassigned on an environment switch, so it would read the old style.)

`captureCanonicalViews`: wrap the capture — `return withFeatureLines(true, () => captureIn("cad", null, () => canonicalViewsInCurrentLook(viewNames)));`
`renderViews` realistic branch: `return withFeatureLines(false, () => captureIn("realistic", rig, () => canonicalViewsInCurrentLook(viewNames)));`

Returned API, beside `setRenderMode`:
```js
    setFeatureLines,
    getFeatureLines: () => linesOn(),
    getFeatureLinesPrefs: () => ({ ...featureLinesPrefs }),
    setFeatureLinesPrefs,
    onFeatureLinesChange: (cb) => { linesListeners.add(cb); return () => linesListeners.delete(cb); },
```
In `disposeRealistic()` add `linesListeners.clear();`.

Update the existing tests that asserted "realistic hides lines" only if they now fail for the right reason (studio's default is still off, so they should still pass).

- [ ] **Step 4: Implement — mount**

Import `loadFeatureLinesPrefs, saveFeatureLinesPrefs` from `./view-state.js`.

In the restore block, BEFORE the realistic restore line (`if ((viewerState?.renderMode …`):
```js
    // Feature lines per style by the same precedence: this session's carried
    // map wins over the stored one, key by key.
    viewer.setFeatureLinesPrefs({ ...loadFeatureLinesPrefs(), ...(viewerState?.featureLines ?? {}) });
    cleanup.defer(viewer.onFeatureLinesChange(() => saveFeatureLinesPrefs(viewer.getFeatureLinesPrefs())));
```
(The first `setFeatureLinesPrefs` fires before the listener is attached, so a restore does not write storage back.)

`makeHandle` → `getViewerState`: add `featureLines: viewer.getFeatureLinesPrefs?.() ?? {},`. Add `featureLines` to `makeHandle`'s destructured params and to the returned handle:
```js
    // Feature lines for the CURRENT style ("cad" or the environment in view);
    // set() persists for that style only. onChange hears explicit changes.
    featureLines: featureLines ?? { get: () => true, set: () => {}, onChange: () => () => {} },
```
and pass it from the mount call site beside `renderMode:`:
```js
      featureLines: {
        get: () => viewer.getFeatureLines(),
        set: (on) => viewer.setFeatureLines(on),
        onChange: (cb) => viewer.onFeatureLinesChange(cb),
      },
```
Document `runtime.featureLines` in mount.js's header runtime comment block beside `runtime.renderMode`, and in `docs/AUTHORING-PARTS.md`'s runtime section beside `runtime.renderMode` (one or two lines each, same style).

- [ ] **Step 5: Run to confirm they pass, then the full suite**

`npx vitest run test/framework/viewer-realistic.test.js test/framework/mount-realistic.test.js` → PASS; `npm test` → all pass (a docs-parity test may need the AUTHORING-PARTS line).

- [ ] **Step 6: Commit**

```bash
git add -A src/framework test/framework docs/AUTHORING-PARTS.md
git commit -m "Feature lines per style, in both modes; runtime.featureLines and viewerState carry"
```

---

### Task 3: Style thumbnails and the assembly-change event

**Files:**
- Modify: `src/framework/viewer.js`
- Test: `test/framework/viewer-realistic.test.js`

**Interfaces:**
- Consumes: Task 2's `withFeatureLines`-free design: a borrowed style gets that style's own lines automatically (linesOn reads the current style).
- Produces: `renderStyleThumbnail(style: string, { size?: number }): Promise<string|null>` (JPEG data URL; `size` default 256 — `captureCurrentFromScene` clamps to ≥256 anyway); `onAssemblyChange(cb: () => void): () => void` (fires at the end of every `showAssembly`).

- [ ] **Step 1: Write the failing tests** (append to `test/framework/viewer-realistic.test.js`)

```js
test("a CAD thumbnail from a realistic view borrows CAD and puts the view back", async () => {
  stubCanvas();
  const v = shown();
  await v.setRenderMode("realistic");
  const physical = v.__subMesh("body").material;
  expect(await v.renderStyleThumbnail("cad")).toBe("data:image/jpeg;base64,TEST");
  expect(v.getRenderMode()).toBe("realistic");
  expect(v.__subMesh("body").material).toBe(physical);
  v.dispose();
});

test("an environment thumbnail from CAD renders that environment, leaves CAD, and frees a thumbnail-only rig", async () => {
  stubCanvas();
  const v = shown();
  const renders = recordRenders(v);
  expect(await v.renderStyleThumbnail("outdoor")).toBe("data:image/jpeg;base64,TEST");
  const rig = rigState.rigs.find((r) => r.id === "outdoor");
  expect(renders.some((r) => r.environment === rig.envMap)).toBe(true);
  expect(v.getRenderMode()).toBe("cad");
  expect(rig.dispose).toHaveBeenCalled();           // not the live environment
  v.dispose();
});

test("a thumbnail of another environment while realistic restores the live rig and keeps it", async () => {
  stubCanvas();
  const v = shown();
  await v.setRenderMode("realistic");               // studio
  const live = lastRig();
  const scene = sceneOf(v);
  await v.renderStyleThumbnail("workshop");
  expect(scene.environment).toBe(live.envMap);
  expect(live.ground.parent).toBe(scene);
  expect(live.dispose).not.toHaveBeenCalled();
  expect(rigState.rigs.find((r) => r.id === "workshop").ground.parent).toBe(null);
  v.dispose();
});

test("showAssembly announces an assembly change", () => {
  const v = shown();
  let n = 0;
  v.onAssemblyChange(() => { n += 1; });
  v.showAssembly(["body"]);
  expect(n).toBe(1);
  v.dispose();
});
```

- [ ] **Step 2: Run to confirm they fail**

`npx vitest run test/framework/viewer-realistic.test.js` → new tests FAIL.

- [ ] **Step 3: Implement**

Next to `rigFor`, a release that frees a rig loaded only for a thumbnail:
```js
  // A rig loaded only to draw a thumbnail is freed straight away: each holds
  // its equirect (~16 MB of half-float) and a PMREM, and four of them resident
  // on a phone is not acceptable. The live one (or one a switch is loading) stays.
  function releaseThumbnailRig(id) {
    if (id === environmentId || realisticRig?.id === id) return;
    const p = rigCache.get(id);
    if (!p) return;
    rigCache.delete(id);
    loadedRigs.delete(id);
    p.then((r) => r.dispose(), () => {});
  }
```
Caveat to check while implementing: `rig.dispose()` disposes the ground textures, which come from the shared `textureCache`. three re-uploads a disposed texture on its next use, so a later use of the same file still draws; verify `loadTexture` returns the cached Texture object and nothing else holds a stale GPU handle. If a shared texture proves unsafe to dispose, drop the rig's texture dispose for cached textures instead of skipping the release.

The thumbnail:
```js
  // One small render of the CURRENT framing in any style, for the view style
  // popover. The live view is put back exactly (same contract as captureIn:
  // no publish, nothing persisted), whether it is CAD, or realistic in this
  // or another environment. The borrowed style brings its own feature-lines
  // preference with it, because linesOn() reads the current style.
  async function renderStyleThumbnail(style, { size = 256 } = {}) {
    if (disposed) return null;
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) return null;
    const capture = () => currentFramingInCurrentLook({ size, quality: 0.8 });
    if (style === "cad") return captureIn("cad", null, capture);
    const id = resolveEnvironmentId(style).id;
    const rig = await rigFor(id);
    if (disposed) return null;
    await compileRealistic(rig, { forCapture: true });
    if (disposed) return null;
    try {
      if (renderMode !== "realistic" || realisticRig === rig) return captureIn("realistic", rig, capture);
      // Realistic in another environment: borrow this rig, then put the live one back.
      const liveRig = realisticRig, movedAt = shadowMovedAt;
      try {
        enterRealistic(rig, { live: false });
        return capture();
      } finally {
        try {
          enterRealistic(liveRig, { live: false, reground: false });
          shadowMovedAt = movedAt;
        } catch (e) {
          console.warn("partforge: restoring the realistic view after a thumbnail failed", e);
          publishMode({ error: "couldn't load realistic view" });
        }
      }
    } finally {
      releaseThumbnailRig(id);
    }
  }
```
If `enterRealistic(rig, …)` with a different rig does not remove the live rig's ground/shadow from the scene, check its first lines (`if (realisticRig && realisticRig !== rig) scene.remove(...)`) — it does; the restore re-adds the live rig's.

Assembly event: `const assemblyListeners = new Set();` near `frameListeners`; at the end of `showAssembly` add
```js
    for (const cb of [...assemblyListeners]) {
      try { cb(); } catch (e) { console.warn("partforge: assembly listener failed", e); }
    }
```
Export `renderStyleThumbnail` and `onAssemblyChange: (cb) => { assemblyListeners.add(cb); return () => assemblyListeners.delete(cb); }`; clear `assemblyListeners` in `dispose`.

- [ ] **Step 4: Run to confirm they pass**

`npx vitest run test/framework/viewer-realistic.test.js` → PASS; `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewer.js test/framework/viewer-realistic.test.js
git commit -m "Viewer: renderStyleThumbnail and onAssemblyChange for the view style popover"
```

---

### Task 4: The view style button (beside the cube) and popover; retire the old controls

**Files:**
- Create: `src/framework/view-style-controls.js`
- Delete: `src/framework/realistic-controls.js`, `test/framework/realistic-controls.test.js`
- Modify: `src/framework/mount.js` (element resolution ~L441-443, chrome wiring ~L1266, sketch hide), `src/framework/viewcube/viewcube-controls.js` (remove the projection button), `src/framework/chrome.css`, `src/framework/app.css`, every demo `*.html` at the repo root carrying `id="realistic"` / `id="environment"` (nameplate, relief, hull-sweep, lofted-bottle, materials, emblem, filleted-box, planter, bracket, faceted-vase, gasket, screw, hinged-box, propeller, demo, import-demo, scott-label), `docs/AUTHORING-PARTS.md` (~L2601 mount contract), `AGENTS.md` (the materials/architecture paragraph if it names realistic-controls.js)
- Test: `test/framework/view-style-controls.test.js`; update `test/framework/mount.test.js` (L228, L1498) and `test/framework/viewcube/viewcube-controls.test.js` (projection-button tests → delete)

**Interfaces:**
- Consumes: `STYLES`, `styleFor`, `createThumbnailCache` (Task 1); `saveRenderMode`, `saveEnvironment` (view-state.js); viewer `getRenderMode`, `setRenderMode`, `getEnvironment`, `setEnvironment`, `isRealisticPending`, `onRenderModeChange`, `onEnvironmentChange`, `getProjection`, `setProjection`, `onProjectionChange`, `getFeatureLines`, `setFeatureLines`, `onFeatureLinesChange` (Task 2), `renderStyleThumbnail`, `onAssemblyChange` (Task 3), `onThemeChange`.
- Produces: `attachViewStyleControls(viewer, { stage, anchor }, { tooltip }) → { element, popover, isOpen(), open(), close({focus?}), setHidden(flag), sync(), detach() }` — `anchor` is the view cube's stack element (`viewcube.element`); the button is appended into it, the popover into `stage`.

- [ ] **Step 1: Write the failing tests** — `test/framework/view-style-controls.test.js`

```js
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachViewStyleControls } from "../../src/framework/view-style-controls.js";

function fakeViewer() {
  const l = { mode: new Set(), env: new Set(), proj: new Set(), lines: new Set(), asm: new Set(), theme: new Set() };
  const v = {
    mode: "cad", env: "studio", proj: "perspective", lines: { cad: true },
    getRenderMode: () => v.mode,
    isRealisticPending: () => false,
    setRenderMode: vi.fn(async (m) => { v.mode = m; l.mode.forEach((cb) => cb({ mode: m })); return m; }),
    getEnvironment: () => v.env,
    setEnvironment: vi.fn(async (id) => { v.env = id; l.env.forEach((cb) => cb(id)); return id; }),
    getProjection: () => v.proj,
    setProjection: vi.fn((p) => { v.proj = p; l.proj.forEach((cb) => cb(p)); }),
    getFeatureLines: () => v.lines[v.mode === "cad" ? "cad" : v.env] ?? v.mode === "cad",
    setFeatureLines: vi.fn((on) => { v.lines[v.mode === "cad" ? "cad" : v.env] = on; l.lines.forEach((cb) => cb({})); }),
    renderStyleThumbnail: vi.fn(async (s) => `data:${s}`),
    onRenderModeChange: (cb) => { l.mode.add(cb); return () => l.mode.delete(cb); },
    onEnvironmentChange: (cb) => { l.env.add(cb); return () => l.env.delete(cb); },
    onProjectionChange: (cb) => { l.proj.add(cb); return () => l.proj.delete(cb); },
    onFeatureLinesChange: (cb) => { l.lines.add(cb); return () => l.lines.delete(cb); },
    onAssemblyChange: (cb) => { l.asm.add(cb); return () => l.asm.delete(cb); },
    onThemeChange: (cb) => { l.theme.add(cb); return () => l.theme.delete(cb); },
    _fire: l,
  };
  return v;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
let stage, anchor;
beforeEach(() => {
  stage = document.createElement("div");
  anchor = document.createElement("div"); // stands in for the view cube's stack
  anchor.className = "pf-viewcube-stack";
  stage.append(anchor);
  document.body.append(stage);
});
afterEach(() => { document.body.innerHTML = ""; });

const tile = (id) => stage.querySelector(`.pf-view-style-tile[data-style="${id}"]`);

test("the button sits in the view cube's stack; the popover in the stage; detach removes both", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  expect(anchor.querySelector("#view-style")).not.toBeNull();
  expect(c.popover.parentNode).toBe(stage);
  c.detach();
  expect(stage.querySelector("#view-style")).toBeNull();
  expect(stage.querySelector("#pf-view-style-popover")).toBeNull();
});

test("the popover closes when the cube hides", async () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  c.open();
  anchor.hidden = true;
  await Promise.resolve(); // MutationObserver delivery
  await new Promise((r) => setTimeout(r, 0));
  expect(c.isOpen()).toBe(false);
});

test("opening shows a tile per style with thumbnails, the current one pressed", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  stage.querySelector("#view-style").click();
  expect(c.isOpen()).toBe(true);
  expect(stage.querySelector("#view-style").getAttribute("aria-expanded")).toBe("true");
  await flush(); await flush();
  expect([...stage.querySelectorAll(".pf-view-style-tile")].map((t) => t.dataset.style))
    .toEqual(["cad", "studio", "workshop", "print-bed", "outdoor"]);
  expect(tile("cad").getAttribute("aria-pressed")).toBe("true");
  expect(tile("workshop").querySelector("img").src).toBe("data:workshop");
});

test("thumbnails render once, and again only on the next open after the part changes", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open(); await flush(); await flush();
  c.close(); c.open(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(5);
  c.close();
  v._fire.asm.forEach((cb) => cb());
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(5); // not while closed
  c.open(); await flush(); await flush();
  expect(v.renderStyleThumbnail).toHaveBeenCalledTimes(10);
});

test("a tile switches style: an environment then realistic, or back to CAD", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open();
  tile("print-bed").click(); await flush();
  expect(v.setEnvironment).toHaveBeenCalledWith("print-bed");
  expect(v.setRenderMode).toHaveBeenLastCalledWith("realistic");
  expect(tile("print-bed").getAttribute("aria-pressed")).toBe("true");
  tile("cad").click(); await flush();
  expect(v.setRenderMode).toHaveBeenLastCalledWith("cad");
});

test("the lines switch reflects and sets the current style's lines", async () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open();
  const sw = stage.querySelector(".pf-view-style-switch");
  expect(sw.getAttribute("role")).toBe("switch");
  expect(sw.getAttribute("aria-checked")).toBe("true");
  sw.click();
  expect(v.setFeatureLines).toHaveBeenCalledWith(false);
  expect(sw.getAttribute("aria-checked")).toBe("false");
});

test("the projection control sets and follows the projection", () => {
  const v = fakeViewer();
  const c = attachViewStyleControls(v, { stage, anchor });
  c.open();
  const ortho = stage.querySelector('.pf-view-style-seg [data-projection="orthographic"]');
  ortho.click();
  expect(v.setProjection).toHaveBeenCalledWith("orthographic");
  expect(ortho.getAttribute("aria-checked")).toBe("true");
  v.setProjection("perspective");
  expect(ortho.getAttribute("aria-checked")).toBe("false");
});

test("Escape and an outside press close it; Escape returns focus to the button", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  const button = stage.querySelector("#view-style");
  c.open();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(c.isOpen()).toBe(false);
  expect(document.activeElement).toBe(button);
  c.open();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(c.isOpen()).toBe(false);
});

test("setHidden hides the button and closes the popover", () => {
  const c = attachViewStyleControls(fakeViewer(), { stage, anchor });
  c.open();
  c.setHidden(true);
  expect(c.element.hidden).toBe(true);
  expect(c.isOpen()).toBe(false);
});
```

- [ ] **Step 2: Run to confirm they fail**

`npx vitest run test/framework/view-style-controls.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/framework/view-style-controls.js`**

```js
// src/framework/view-style-controls.js
// The view style button and its popover: every control that changes HOW the
// part is drawn, in one place — the style (CAD or a realistic environment, as
// live thumbnails of this part), feature lines for that style, and the
// projection. Generated into the stage, not declared by the host (the view
// cube / mobile-tabs.js precedent), so an embedder gets it with no markup.
//
// The button replaces the view cube's old projection toggle, in the cube's
// stack (so it hides whenever the cube does), and wears #viewbar's chrome so
// it reads as a control rather than a mark on the cube. The popover opens
// ABOVE it, placed from the button's rect at open time.
//
// The state shown is always the viewer's: a tile is pressed once the viewer
// reports that style, and a runtime change made elsewhere shows up here.
import { STYLES, styleFor, createThumbnailCache } from "./view-style-state.js";
import { saveRenderMode, saveEnvironment } from "./view-state.js";
import { attachButtonTooltips } from "./tooltip.js";

const ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/></svg>`;
const LABEL = "View style";

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function attachViewStyleControls(viewer, { stage, anchor } = {}, { tooltip } = {}) {
  const button = el("button", "pf-view-style-button", {
    type: "button", id: "view-style", "aria-label": LABEL,
    "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "pf-view-style-popover",
  });
  button.innerHTML = ICON;
  if (!tooltip) button.title = LABEL;
  (anchor ?? stage).append(button);

  const pop = el("div", "pf-view-style-popover", { id: "pf-view-style-popover", role: "dialog", "aria-label": LABEL });
  pop.hidden = true;

  const styleHead = el("p", "pf-view-style-heading");
  styleHead.textContent = "Style";
  const grid = el("div", "pf-view-style-grid", { role: "group", "aria-label": "Style" });
  const tiles = new Map();
  for (const s of STYLES) {
    const t = el("button", "pf-view-style-tile", { type: "button", "aria-pressed": "false" });
    t.dataset.style = s.id;
    const thumb = el("span", "pf-view-style-thumb");
    const img = el("img", "", { alt: "" });
    img.hidden = true;
    thumb.append(img);
    const label = el("span", "pf-view-style-label");
    label.textContent = s.label;
    t.append(thumb, label);
    t.addEventListener("click", () => choose(s.id));
    grid.append(t);
    tiles.set(s.id, { tile: t, img });
  }

  const linesRow = el("div", "pf-view-style-row");
  const linesLabel = el("span", "", { id: "pf-view-style-lines-label" });
  linesLabel.textContent = "Feature lines";
  const sw = el("button", "pf-view-style-switch", { type: "button", role: "switch", "aria-checked": "false", "aria-labelledby": "pf-view-style-lines-label" });
  sw.append(el("span", "pf-view-style-knob"));
  sw.addEventListener("click", () => viewer.setFeatureLines(!viewer.getFeatureLines()));
  linesRow.append(linesLabel, sw);

  const projRow = el("div", "pf-view-style-row");
  const projLabel = el("span", "", { id: "pf-view-style-proj-label" });
  projLabel.textContent = "Projection";
  const seg = el("div", "pf-view-style-seg", { role: "radiogroup", "aria-labelledby": "pf-view-style-proj-label" });
  const projButtons = [["perspective", "Perspective"], ["orthographic", "Orthographic"]].map(([id, text]) => {
    const b = el("button", "", { type: "button", role: "radio", "aria-checked": "false" });
    b.dataset.projection = id;
    b.textContent = text;
    b.addEventListener("click", () => { viewer.setProjection(id); render(); });
    seg.append(b);
    return b;
  });
  projRow.append(projLabel, seg);

  pop.append(styleHead, grid, linesRow, projRow);
  stage.append(pop);

  const tooltipBinding = tooltip ? attachButtonTooltips(tooltip, [{ element: button }]) : null;

  // --- state -----------------------------------------------------------------
  let pendingStyle = null; // a tile clicked whose switch is still loading
  function render() {
    const current = styleFor(viewer.getRenderMode(), viewer.getEnvironment());
    for (const [id, { tile }] of tiles) {
      tile.setAttribute("aria-pressed", String(id === current));
      if (id === pendingStyle && id !== current) tile.dataset.busy = "true"; else delete tile.dataset.busy;
    }
    sw.setAttribute("aria-checked", String(!!viewer.getFeatureLines()));
    const proj = viewer.getProjection();
    for (const b of projButtons) b.setAttribute("aria-checked", String(b.dataset.projection === proj));
    tooltipBinding?.sync();
  }

  // What persists is what the viewer says took effect (the realistic-controls
  // rule this replaces): a failed load settles to CAD and CAD is saved.
  async function choose(id) {
    pendingStyle = id;
    render();
    try {
      if (id === "cad") {
        saveRenderMode(await viewer.setRenderMode("cad"));
      } else {
        saveEnvironment(await viewer.setEnvironment(id));
        saveRenderMode(await viewer.setRenderMode("realistic"));
      }
    } catch { /* the viewer reports failures through its mode event */ }
    if (pendingStyle === id) pendingStyle = null;
    render();
  }

  // --- thumbnails (spec: live, cached; re-rendered on the next OPEN after a change)
  const cache = createThumbnailCache();
  function paint(id) {
    const { img } = tiles.get(id);
    const url = cache.get(id);
    if (url) { img.src = url; img.hidden = false; } else { img.hidden = true; }
  }
  async function refreshThumbnails() {
    if (!cache.isStale()) return;
    cache.markFresh();
    const gen = cache.generation();
    // One at a time: each realistic style may load an environment.
    for (const s of STYLES) {
      let url = null;
      try { url = await viewer.renderStyleThumbnail(s.id, { size: 256 }); } catch { url = null; }
      if (detached || gen !== cache.generation()) return;
      cache.set(s.id, url);
      paint(s.id);
    }
  }

  // --- open / close ------------------------------------------------------------
  const isOpen = () => !pop.hidden;
  const onOutside = (e) => {
    if (!pop.contains(e.target) && !button.contains(e.target)) close({ focus: false });
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  // Above the button, right edges aligned, never past the stage's top.
  function place() {
    const s = stage.getBoundingClientRect(), b = button.getBoundingClientRect();
    pop.style.right = `${Math.max(8, s.right - b.right)}px`;
    pop.style.bottom = `${Math.max(8, s.bottom - b.top + 8)}px`;
    pop.style.maxHeight = `${Math.max(160, b.top - s.top - 16)}px`;
  }
  function open() {
    if (isOpen() || button.hidden || anchor?.hidden) return;
    place();
    pop.hidden = false;
    button.setAttribute("aria-expanded", "true");
    button.classList.add("on");
    render();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
    refreshThumbnails();
  }
  function close({ focus = true } = {}) {
    if (!isOpen()) return;
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("on");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey);
    if (focus) button.focus();
  }
  const onButton = () => (isOpen() ? close() : open());
  button.addEventListener("click", onButton);

  const offs = [
    viewer.onRenderModeChange(() => render()),
    viewer.onEnvironmentChange(() => render()),
    viewer.onProjectionChange(() => render()),
    viewer.onFeatureLinesChange(() => render()),
    viewer.onAssemblyChange?.(() => cache.invalidate()) ?? (() => {}),
    viewer.onThemeChange?.(() => cache.invalidate()) ?? (() => {}),
  ];
  render();
  // The cube hides for Sketch mode and for a crowded transport bar; the
  // button goes with it (it is in the stack), and an open popover must too.
  const hideObserver = anchor && typeof MutationObserver === "function"
    ? new MutationObserver(() => { if (anchor.hidden) close({ focus: false }); })
    : null;
  hideObserver?.observe(anchor, { attributes: true, attributeFilter: ["hidden"] });

  let detached = false;
  return {
    element: button,
    popover: pop,
    isOpen,
    open,
    close,
    setHidden(flag) {
      if (flag) close({ focus: false });
      button.hidden = !!flag;
    },
    sync: render,
    detach() {
      if (detached) return;
      detached = true;
      close({ focus: false });
      button.removeEventListener("click", onButton);
      for (const off of offs) { try { off(); } catch { /* already gone */ } }
      tooltipBinding?.detach();
      hideObserver?.disconnect();
      button.remove();
      pop.remove();
    },
  };
}
```
(`viewer.onThemeChange` exists in viewer.js; the fake in the test has it too.)

- [ ] **Step 4: Run to confirm the new tests pass**

`npx vitest run test/framework/view-style-controls.test.js` → PASS.

- [ ] **Step 5: Wire into mount, retire the old controls**

`mount.js`:
- Replace `import { attachRealisticControls } from "./realistic-controls.js";` with `import { attachViewStyleControls } from "./view-style-controls.js";`.
- Delete the `realistic:` and `environment:` lines from the `chrome` element resolution (~L442-443) and the `elements.chrome.realistic / .environment` doc lines in the header comment (~L393-397); replace that comment with one describing the generated view style button (`#view-style`, in the view cube's stack where the projection toggle was).
- Delete the realistic chrome block (~L1266-1270). Right after `const viewcube = attachViewcubeControls(...)` (~L674) add:
```js
    // The view style button + popover (style, feature lines, projection),
    // in the cube's stack where the projection toggle was — it hides with the
    // cube (Sketch, a crowded transport bar) and closes its popover then.
    const viewStyle = attachViewStyleControls(viewer, { stage: els.viewer, anchor: viewcube.element }, { tooltip });
    cleanup.defer(() => viewStyle.detach());
```
  (`viewStyle` must be detached BEFORE `viewcube` — cleanup.defer runs in reverse order, and this is deferred after the cube, so it is.)
- `viewcube-controls.js`: remove the projection button (the `button` element, both icons, `sync`, `onToggle`, its tooltip binding, `offProjection`, and their cleanup steps); update the file's header comment to say the projection control moved into the view style popover (2026-09-24). Keep the stack, key buttons, size publishing.
- `chrome.css`: rename the `.pf-viewcube-toggle` PLACEMENT rule(s) to `.pf-view-style-button` (same spot over the cube's bottom-right corner; grow it to fit a 34 px button and keep it inside the stack's box so the published stack size is unchanged — check the size-publishing comment in viewcube-controls.js and animation-controls' crowding test). Update the long placement comment to say what replaced the projection toggle and when (2026-09-24).
- `app.css`: replace the `.pf-viewcube-toggle` APPEARANCE rules (and its entry in the shared `:focus-visible` list) with the button + popover styles:
```css
/* ---- view style button + popover (view-style-controls.js) -------------------
   The button replaced the cube's small projection circle and is meant to be
   SEEN: #viewbar's chrome (surface, border, float shadow) on a 34px button. */
.pf-view-style-button {
  width: 34px; height: 34px; border: 1px solid var(--pf-border); border-radius: var(--pf-radius-control);
  background: var(--pf-surface); box-shadow: var(--pf-shadow-float);
  color: var(--pf-muted-2); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.pf-view-style-button[hidden] { display: none; }
.pf-view-style-button:hover, .pf-view-style-button.on { color: var(--pf-text); background: var(--pf-surface-2); }
.pf-view-style-popover {
  position: absolute; z-index: 30;
  width: min(300px, calc(100% - 24px)); overflow: auto;
  padding: 12px; display: flex; flex-direction: column; gap: 12px;
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: 12px; box-shadow: var(--pf-shadow-float);
  color: var(--pf-text); font-size: 12px;
}
.pf-view-style-popover[hidden] { display: none; }
.pf-view-style-heading { margin: 0; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--pf-muted-2); }
.pf-view-style-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.pf-view-style-tile {
  display: flex; flex-direction: column; gap: 4px; padding: 0; border: 0;
  background: none; color: var(--pf-muted-2); cursor: pointer; font: inherit; text-align: center;
}
.pf-view-style-thumb {
  display: block; aspect-ratio: 1; border-radius: 8px; overflow: hidden;
  background: var(--pf-surface-2); border: 1px solid var(--pf-border);
}
.pf-view-style-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.pf-view-style-thumb img[hidden] { display: none; }
.pf-view-style-tile[aria-pressed="true"] { color: var(--pf-text); }
.pf-view-style-tile[aria-pressed="true"] .pf-view-style-thumb { border-color: var(--pf-accent); box-shadow: 0 0 0 1px var(--pf-accent); }
.pf-view-style-tile[data-busy] .pf-view-style-thumb { opacity: 0.6; }
.pf-view-style-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pf-view-style-switch {
  position: relative; width: 32px; height: 18px; padding: 0; border: 0; border-radius: 9px;
  background: var(--pf-surface-2); box-shadow: inset 0 0 0 1px var(--pf-border); cursor: pointer;
}
.pf-view-style-switch[aria-checked="true"] { background: var(--pf-accent); box-shadow: none; }
.pf-view-style-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; transition: transform 120ms ease;
}
.pf-view-style-switch[aria-checked="true"] .pf-view-style-knob { transform: translateX(14px); }
.pf-view-style-seg { display: flex; padding: 2px; gap: 2px; border-radius: var(--pf-radius-control); background: var(--pf-surface-2); }
.pf-view-style-seg button {
  border: 0; padding: 4px 8px; border-radius: calc(var(--pf-radius-control) - 2px);
  background: transparent; color: var(--pf-muted-2); font: inherit; cursor: pointer;
}
.pf-view-style-seg button[aria-checked="true"] { background: var(--pf-surface); color: var(--pf-text); box-shadow: var(--pf-shadow-float); }
.pf-view-style-button:focus-visible, .pf-view-style-tile:focus-visible, .pf-view-style-switch:focus-visible, .pf-view-style-seg button:focus-visible {
  outline: none; box-shadow: 0 0 0 3px color-mix(in oklab, var(--pf-accent) 35%, transparent);
}
```
Verify every token used exists in `src/framework/tokens.css` (`--pf-surface`, `--pf-surface-2`, `--pf-border`, `--pf-radius-control`, `--pf-shadow-float`, `--pf-text`, `--pf-muted-2`, `--pf-accent`); substitute the nearest existing token if one is missing.
- Demo HTML: delete the `<button id="realistic" …>✦</button>` and `<select id="environment" …></select>` lines from every root `*.html` listed above.
- Tests: `test/framework/mount.test.js` L228 — drop `els.chrome.realistic, els.chrome.environment` from that list; L1498 — change to assert the view style button exists: `expect(els.viewer.querySelector("#view-style")).not.toBeNull();` and `expect(els.viewer.querySelector("#projection")).toBeNull();`. `test/framework/viewcube/viewcube-controls.test.js` — delete tests driving `#projection`. Delete `test/framework/realistic-controls.test.js` and `src/framework/realistic-controls.js`.
- Docs: `docs/AUTHORING-PARTS.md` ~L2601 — replace the "realistic-mode viewbar controls" contract with the generated view style button (what it contains, that hosts need no markup, that `elements.chrome.realistic/.environment` are gone). `AGENTS.md` — if it names `realistic-controls.js`, name `view-style-controls.js` / `view-style-state.js` instead.
- Grep for leftovers: `grep -rn "realistic-controls\|chrome.realistic\|pf-viewcube-toggle\|#projection" src test docs scripts AGENTS.md`.

- [ ] **Step 6: Full suite + lint**

`npm test` → all pass; `npx eslint src test` → no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "View style popover: one top-right button for style, feature lines and projection"
```

---

### Task 5: Browser check, version bump

**Files:**
- Modify: `package.json` (version), anything the browser check turns up.

- [ ] **Step 1: Run the dev server and look.** `npx vite --port 5181 --strictPort` (background). With Playwright (`require("playwright")` from this worktree), open `/planter.html`, `/materials.html`, `/screw.html` at 1400×900 and 400×800, in both themes. Check: the view style button beside the cube reads clearly as a control and the drawer toggle at top right is unchanged; the popover opens above the button, tiles fill with thumbnails of the part, the current tile is ringed; a tile switches style; the lines switch toggles lines in both CAD and a realistic style (and each style remembers); the projection control works; Escape/outside click close; at 400 px the popover fits above the button; the old projection circle is gone; with the transport bar crowding the cube (hinged-box.html at a narrow width) the button hides with the cube. Screenshot each state to the session scratchpad.
- [ ] **Step 2: Tune by eye** anything that reads wrong (line weight/opacity in realistic, popover spacing). Commit fixes with tests where behaviour changes.
- [ ] **Step 3: Version bump.** `package.json` `"version": "0.123.0"` (if main has moved past 0.122.x by then, the next free minor). Commit: `git commit -am "0.123.0"`.
