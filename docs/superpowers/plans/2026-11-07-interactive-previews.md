# Interactive Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cached preview GLB mounted with its part module shows the editor's place-only handles, solves IK, and keeps pieces solid with the collision guard, with no kernel and no worker.

**Architecture:** The GLB gains the params its meshes sit at (encoder version 6). A new pure leaf, `src/framework/preview-pose.js`, turns a part + those params into a "file placer" (`place(p, d) · base⁻¹` per mesh, the pose ladder's rung 1 with the file as the delivery) and decides which handles are place-only against the file. `mountPreview({ glb, part })` wires the existing Pose mode, chrome and collision index to that placer; while a baked animation plays, the params it reports follow the player.

**Tech Stack:** plain ESM, three.js (viewer only), @gltf-transform (encoder), vitest with happy-dom and the fake-renderer harness in `test/framework/preview-real-viewer.test.js`, Playwright for `scripts/check-pose.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-07-interactive-previews-design.md`

## Global Constraints

- Node 24 (`nvm use`) before any test or CLI run.
- `encode-preview.js` stays worker-safe (no three, no DOM, no Blob) and deterministic; `PREVIEW_ENCODER_VERSION` goes 5 → 6 in this work and nowhere else.
- `preview-pose.js` is pure: no DOM, no three, no `node:`, never imports `collide/world.js` (the BVH) — only `collide/place.js`. It is reached by `oracle/measure.js`, so `test/oracle-entry.test.js` and `test/worker-layering.test.js` must stay green.
- A preview mounted without `part` is byte-for-byte today's: no new import, no new DOM, no behaviour change (`test/framework/preview-real-viewer.test.js`'s existing mountPreview tests are the guard).
- Files of versions 1–5 still decode and mount (`test/fixtures/preview-v1.glb`, `preview-v2.glb`).
- No `instanceof` across the part boundary; limbs and sources by `handleInfo()` / `ikInfo()` only.
- Handle visibility in a preview = `handlesShownInView` ∩ place-only; a hidden handle is never drawn half-working.
- `package.json` version bump on this branch (last task).
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A preview whose part module does not match the file** (a sub-part renamed since the GLB was written): the placer must leave unknown meshes where they are and `previewHandles` must still decide — Task 3 and Task 4 test a mesh name the part lacks and a view sub-part the file lacks.
2. **A `wrap: true` param (gearbox `driveAngle`) dragged past 360 in a preview**: the write path must keep the turn as mount does — Task 6 tests a write of 370 lands as the schema's wrapped value.
3. **A press while the player is in its intro tween (t = 0, camera moving)**: the press must pause and the params written must equal the file params — Task 8 tests it.
4. **Reduced motion with an animated file**: the player never starts, `getParams()` must answer the file params with no `evaluate`, and handles must show at once — Task 8 tests it.
5. **Dispose mid-drag**: no write reaches a torn-down placer or viewer — Task 6 tests dispose during a begun session leaves `getParams()` null-safe and throws nothing.

---

### Task 1: The file carries the params it was posed at (encoder, version 6)

**Files:**
- Modify: `src/framework/gltf/encode-preview.js` (header comment, `PREVIEW_ENCODER_VERSION`, `encodePreviewGlb` signature, root extras at ~line 502)
- Modify: `types/gltf.d.ts` (`EncodePreviewInput.params`, the version comment)
- Test: `test/gltf-encode.test.js`

**Interfaces:**
- Produces: `encodePreviewGlb({ meshes, part, view, params, animation })` where `params?: Record<string, unknown> | null`. Writes top-level extra `partforgeParams: Record<string, number | string | boolean>` holding only the finite-number / string / boolean entries of `params`; writes NO extra when `params` is null/undefined or has no such entry. `PREVIEW_ENCODER_VERSION === 6`.

- [ ] **Step 1: Write the failing tests** in `test/gltf-encode.test.js`

```js
test("PREVIEW_ENCODER_VERSION is 6 (the file carries the params its meshes sit at)", () => {
  expect(PREVIEW_ENCODER_VERSION).toBe(6);
});

test("params ride along as partforgeParams, primitives only; omitted writes no extra", async () => {
  const font = new Uint8Array([1, 2, 3]);
  const withParams = await readGlb(await encodePreviewGlb({
    meshes: meshes(), part, view: "assembly",
    params: { width: 40, label: "A", lid: true, font, nested: { a: 1 }, nan: NaN, nothing: null },
  }));
  expect(withParams.getRoot().getExtras().partforgeParams).toEqual({ width: 40, label: "A", lid: true });
  const without = await readGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly" }));
  expect(without.getRoot().getExtras()).not.toHaveProperty("partforgeParams");
  const empty = await readGlb(await encodePreviewGlb({ meshes: meshes(), part, view: "assembly", params: { font } }));
  expect(empty.getRoot().getExtras()).not.toHaveProperty("partforgeParams");
});

test("the same params write the same bytes, and params change the bytes", async () => {
  const a = await encodePreviewGlb({ meshes: meshes(), part, view: "assembly", params: { width: 40 } });
  const b = await encodePreviewGlb({ meshes: meshes(), part, view: "assembly", params: { width: 40 } });
  const c = await encodePreviewGlb({ meshes: meshes(), part, view: "assembly", params: { width: 41 } });
  expect(Buffer.compare(a, b)).toBe(0);
  expect(Buffer.compare(a, c)).not.toBe(0);
});
```

Also update the existing version test (`"PREVIEW_ENCODER_VERSION is 5 …"`) by deleting it; the new one replaces it. Update the existing `expect(doc.getRoot().getExtras()).toEqual({ partforgeView: "assembly", partforgeEncoder: PREVIEW_ENCODER_VERSION })` assertion only if it fails (it should not: no params → no extra).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/gltf-encode.test.js`
Expected: FAIL — version is 5; `partforgeParams` undefined.

- [ ] **Step 3: Implement** in `encode-preview.js`

Add `paramsExtras(params)` beside `metaExtras`: returns `null` or the filtered object (keys in insertion order; `typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))`). Add `params = null` to `encodePreviewGlb`'s destructuring, compute `const fileParams = paramsExtras(params);` and spread `...(fileParams ? { partforgeParams: fileParams } : {})` into `doc.getRoot().setExtras({...})` after `partforgeMeta`. Set `PREVIEW_ENCODER_VERSION = 6` and extend the version comment: `6: partforgeParams extra — the params the meshes sit at`. Extend the header's extras list.

- [ ] **Step 4: Update `types/gltf.d.ts`**

Add to `EncodePreviewInput`:
```ts
/**
 * The params the meshes sit at (encoder version 6): `{ ...defaults, ...live, ...autoplay t = 0 values }`
 * as `exportPreview` passes them. Only finite numbers, strings and booleans are written, as the
 * top-level extra `partforgeParams`; omitted (or nothing primitive) writes no extra, which a reader
 * takes as "posed at the part's defaults".
 */
params?: Record<string, unknown> | null;
```
Extend the `PREVIEW_ENCODER_VERSION` doc comment with `6: partforgeParams`.

- [ ] **Step 5: Run the gltf suites**

Run: `npx vitest run test/gltf-encode.test.js test/gltf-encode-animation.test.js test/gltf-layering.test.js test/framework/preview-decode.test.js`
Expected: PASS (decode tests still pass: they read no params yet).

- [ ] **Step 6: Commit**

```bash
git add src/framework/gltf/encode-preview.js types/gltf.d.ts test/gltf-encode.test.js
git commit -m "gltf: the preview file carries the params its meshes sit at (encoder 6)"
```

---

### Task 2: The decoder returns `params`

**Files:**
- Modify: `src/framework/gltf/decode-preview.js` (header, `decodePreviewGlb`'s return)
- Test: `test/framework/preview-decode.test.js`

**Interfaces:**
- Produces: `decodePreviewGlb(bytes)` resolves `{ view, meta, meshes, animation, params }` with `params: Record<string, number | string | boolean> | null` — the `partforgeParams` extra filtered by the same primitive rule (a hand-edited file cannot smuggle an object in), `null` when absent or empty.

- [ ] **Step 1: Write the failing tests**

```js
test("params come back as written; a file without them answers null", async () => {
  const withParams = await decodePreviewGlb(await encodePreviewGlb({
    meshes: [boxSoup("base")], part, view: "assembly", params: { width: 40, label: "A", lid: true, font: new Uint8Array(2) },
  }));
  expect(withParams.params).toEqual({ width: 40, label: "A", lid: true });
  expect((await decodePreviewGlb(await encode())).params).toBeNull();
});

test("version 1 and 2 fixtures decode with params: null", async () => {
  for (const name of ["preview-v1.glb", "preview-v2.glb"]) {
    const bytes = readFileSync(fileURLToPath(new NodeURL(`../fixtures/${name}`, import.meta.url)));
    expect((await decodePreviewGlb(bytes)).params).toBeNull();
  }
});
```
(Reuse the file's existing fixture-reading pattern if it already has one for `preview-v1.glb`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/framework/preview-decode.test.js`
Expected: FAIL — `params` undefined.

- [ ] **Step 3: Implement**

Add `paramsOf(extras)` beside `metaOf`: reads `extras.partforgeParams`, keeps primitive entries, returns `null` when none. Add `params: paramsOf(extras)` to the returned object. Note it in the header comment.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/framework/preview-decode.test.js test/framework/gltf-decode-animation.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/gltf/decode-preview.js test/framework/preview-decode.test.js
git commit -m "gltf: decode the preview's params"
```

---

### Task 3: `preview-pose.js` — the file placer and the opening params

**Files:**
- Create: `src/framework/preview-pose.js`
- Test: `test/preview-pose.test.js`

**Interfaces:**
- Consumes: `poseMatrices(part, view, p, d)` from `collide/place.js`; `resolveParams(part, params)` from `part-model.js`; `invertRigid`, `mulMat4` from `geometry/pose.js`; `viewAnimations`, `evaluate` from `animation.js`.
- Produces:
  - `openingParams(part, view, params = {}) → object`: `{ ...part.defaults, ...params, ...evaluate(anim, 0).values }` where `anim` is `viewAnimations(part).get(view)?.find((a) => a.autoplay)`; without one, `{ ...part.defaults, ...params }`. Never throws (a throwing `viewAnimations` yields the no-animation answer).
  - `createFilePlacer(part, view, fileParams, drawnNames) → { base, matricesAt, apply }`:
    - `base: Map<string, mat16 | null>` — `placeMatrix` at the file params for every name in `drawnNames` that is a part sub-part (`null` for an untrusted/non-rigid placement; a name the part lacks is not in the map);
    - `matricesAt(p, d, names = drawnNames) → Map<string, mat16 | null>` — `place(p, d) · base⁻¹` for each; `null` when either side is null or the name is absent from `base`. Never derives (takes resolved `p, d`).
    - `apply(viewer, params) → string[]` — resolves `{ ...part.defaults, ...params }`, calls `matricesAt`, and `viewer.setSubPose(name, m)` for every name whose matrix differs from the one last applied (`null` is never sent: a null leaves the mesh where the file put it). Returns the names sent. Keeps a `shown` map like `pose-fast-path.js`'s.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import { openingParams, createFilePlacer } from "../src/framework/preview-pose.js";
import { relativeMatsAt } from "../src/framework/collide/world.js";
import { resolveParams, viewSubParts } from "../src/framework/part-model.js";
import gearbox from "../src/parts/gearbox.js";
import hand from "../src/parts/hand.js";
import robotArm from "../src/parts/robot-arm.js";
import drawerBox from "../src/parts/drawer-box.js";
import hingedBox from "../src/parts/hinged-box.js";

const near = (a, b, tol = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < tol);
const defaultView = (part) => Object.keys(part.views)[0];

describe("openingParams", () => {
  it("layers the autoplay animation's t = 0 values over the live params", () => {
    expect(openingParams(gearbox, defaultView(gearbox), { driveAngle: 90 }).driveAngle).toBe(0);
    expect(openingParams(hingedBox, "box", { lidAngle: 50 }).lidAngle).toBe(0);
  });
  it("is defaults + params for a view without an autoplay animation", () => {
    const view = defaultView(drawerBox);
    expect(openingParams(drawerBox, view, { drawer1Open: 40 })).toEqual({ ...drawerBox.defaults, drawer1Open: 40 });
  });
});

describe("createFilePlacer", () => {
  for (const [label, part, file] of [
    ["robot-arm", robotArm, {}], ["hand", hand, {}], ["gearbox", gearbox, { driveAngle: 37 }], ["drawer-box", drawerBox, { drawer2Open: 60 }],
  ]) {
    it(`${label}: matricesAt equals relativeMatsAt from the file params`, () => {
      const view = defaultView(part);
      const fileParams = { ...part.defaults, ...file };
      const names = viewSubParts(part, view, fileParams);
      const placer = createFilePlacer(part, view, fileParams, names);
      const r0 = resolveParams(part, fileParams);
      const rel = relativeMatsAt(part, view, r0.p, r0.d);
      const moved = { ...fileParams };
      for (const k of Object.keys(file).length ? Object.keys(file) : Object.keys(part.defaults).filter((k) => typeof part.defaults[k] === "number").slice(0, 2)) moved[k] = fileParams[k] + 5;
      const r1 = resolveParams(part, moved);
      const got = placer.matricesAt(r1.p, r1.d), want = rel(r1.p, r1.d);
      for (const n of names) {
        if (want.get(n) == null) expect(got.get(n)).toBeNull();
        else expect(near(got.get(n), want.get(n))).toBe(true);
      }
    });
  }
  it("at the file params every matrix is the identity", () => {
    const view = defaultView(gearbox);
    const fileParams = { ...gearbox.defaults, driveAngle: 37 };
    const names = viewSubParts(gearbox, view, fileParams);
    const placer = createFilePlacer(gearbox, view, fileParams, names);
    const { p, d } = resolveParams(gearbox, fileParams);
    for (const m of placer.matricesAt(p, d).values()) expect(near(m, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])).toBe(true);
  });
  it("a mesh name the part lacks is not placed; a view sub-part the file lacks is not asked for", () => {
    const view = defaultView(gearbox);
    const placer = createFilePlacer(gearbox, view, gearbox.defaults, ["gear1", "ghost"]);
    expect(placer.base.has("ghost")).toBe(false);
    const { p, d } = resolveParams(gearbox, { ...gearbox.defaults, driveAngle: 10 });
    expect([...placer.matricesAt(p, d).keys()]).toEqual(["gear1"]);
  });
  it("apply sends only changed matrices, never null, and reports the names sent", () => {
    const view = defaultView(gearbox);
    const names = viewSubParts(gearbox, view, gearbox.defaults);
    const placer = createFilePlacer(gearbox, view, gearbox.defaults, names);
    const sent = [];
    const viewer = { setSubPose: (n, m) => sent.push([n, m]) };
    expect(placer.apply(viewer, { ...gearbox.defaults })).toEqual([]);          // identity: nothing to send
    const moved = placer.apply(viewer, { ...gearbox.defaults, driveAngle: 30 });
    expect(moved.length).toBeGreaterThan(0);
    expect(sent.every(([, m]) => Array.isArray(m) && m.length === 16)).toBe(true);
    expect(placer.apply(viewer, { ...gearbox.defaults, driveAngle: 30 })).toEqual([]); // unchanged: not re-sent
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/preview-pose.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/framework/preview-pose.js`**

Header comment: the module's role (the preview's pose ladder, rung 1 only, the file as the delivery; which handles are place-only; imports only pure leaves — never `collide/world.js`). Implement `openingParams`, `createFilePlacer` per the Interfaces block. `base` comes from `poseMatrices(part, view, p0, d0)` filtered to `drawnNames`; inverses are cached once. `apply` uses the same "same matrix is never re-sent" rule as `pose-fast-path.js`'s `setPose` (compare element-wise).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/preview-pose.test.js`
Expected: PASS

- [ ] **Step 5: Layering guards still green**

Run: `npx vitest run test/worker-layering.test.js test/oracle-entry.test.js`
Expected: PASS (the module is not yet imported anywhere; this pins the baseline).

- [ ] **Step 6: Commit**

```bash
git add src/framework/preview-pose.js test/preview-pose.test.js
git commit -m "preview-pose: the file placer and the opening params"
```

---

### Task 4: `previewHandles` — which handles are place-only against the file

**Files:**
- Modify: `src/framework/preview-pose.js`
- Test: `test/preview-pose.test.js`

**Interfaces:**
- Consumes: `handlesShownInView(part, view, params)` from `pose/handle-views.js`; `handleKeys(handle, allHandles, params)` from `pose/pose-collide.js`; `rangesOf(part)` from `pose/param-solve.js`; `probeSubPartPose(sp, { view, purpose: "display", p, d }, { scope: "build" })` from `pose-probe-core.js`; `placeMatrix` from `collide/place.js`; `viewSubParts`, `resolveParams`.
- Produces:
  - `export const PREVIEW_HANDLE_SAMPLES = [0, 0.25, 0.5, 0.75, 1];`
  - `previewHandles(part, view, fileParams, meshNames) → { shown: string[], hidden: Record<string, string> }`. `shown` keeps `handlesShownInView`'s order. Reasons (exact strings, `<key>`/`<name>` substituted): `"<key> changes which sub-parts the view shows"`, `"<name> has no rigid placement"`, `"<key> rebuilds <name>"`, `"<name>'s build cannot be read"`, `"the handle's point cannot be read"` (any other throw). A part with no `handles` returns `{ shown: [], hidden: {} }`.

The identity test per the spec §3: view set = `viewSubParts(part, view, fileParams)`; drawn = view set ∩ meshNames; for each key in `handleKeys`, each sample `min + f · (max − min)` from `rangesOf(part).get(key)` (no finite min/max: the file value alone), with the other params at the file values: view set unchanged; every drawn sub-part has a non-null `placeMatrix`; every view-set sub-part whose build probe at the file params is trusted keeps `JSON.stringify([baseHash, pose])`; a view-set sub-part whose build probe at the file params is untrusted fails the handle.

- [ ] **Step 1: Write the failing tests** (append to `test/preview-pose.test.js`)

```js
import { previewHandles, PREVIEW_HANDLE_SAMPLES } from "../src/framework/preview-pose.js";

describe("previewHandles", () => {
  const all = (part, file = {}) => {
    const view = defaultView(part);
    const fileParams = { ...part.defaults, ...file };
    return previewHandles(part, view, fileParams, viewSubParts(part, view, fileParams));
  };
  it("samples 0/25/50/75/100 % of a key's range", () => {
    expect(PREVIEW_HANDLE_SAMPLES).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
  it("shows every robot-arm, hand and gearbox handle", () => {
    for (const part of [robotArm, hand, gearbox]) {
      const out = all(part);
      expect(out.hidden).toEqual({});
      expect(out.shown).toEqual(handlesShownInView(part, defaultView(part), part.defaults));
    }
  });
  it("hides the drawer box's corner handle (width/depth rebuild the carcass) and shows its drawers", () => {
    const out = all(drawerBox);
    expect(out.shown).toEqual(["drawer1", "drawer2", "drawer3"]);
    expect(out.hidden.corner).toMatch(/^(width|depth) rebuilds /);
  });
  it("a view sub-part missing from the file hides only a handle whose key would give it geometry", () => {
    const view = defaultView(drawerBox);
    const names = viewSubParts(drawerBox, view, drawerBox.defaults).filter((n) => n !== "drawer2");
    const out = previewHandles(drawerBox, view, drawerBox.defaults, names);
    expect(out.shown).toEqual(["drawer1", "drawer2", "drawer3"]); // drawer2's slide is still place-only
  });
  it("a sub-part that comes and goes with a key hides the handle", () => {
    const part = { ...drawerBox, parts: { ...drawerBox.parts, flag: { ...drawerBox.parts.drawer1, enabled: (p) => p.drawer1Open > 50 } } };
    expect(all(part).hidden.drawer1).toBe("drawer1Open changes which sub-parts the view shows");
  });
  it("a querying build hides the handles that touch it", () => {
    const part = { ...gearbox, parts: { ...gearbox.parts, plate: { ...gearbox.parts.plate,
      build: (k, p, d) => { const s = gearbox.parts.plate.build(k, p, d); s.volume(); return s; } } } };
    const out = all(part);
    expect(out.shown).toEqual([]);
    expect(Object.values(out.hidden).every((r) => r === "plate's build cannot be read")).toBe(true);
  });
  it("a part without handles answers empty", () => {
    expect(previewHandles(hingedBox, "box", hingedBox.defaults, ["base", "lid"])).toEqual({ shown: [], hidden: {} });
  });
});
```
Import `handlesShownInView` from `../src/framework/pose/handle-views.js` at the top. If gearbox's plate sub-part is not named `plate`, use whichever fixed sub-part `gearbox.js` declares (read the file).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/preview-pose.test.js -t previewHandles`
Expected: FAIL — `previewHandles` is not exported.

- [ ] **Step 3: Implement `previewHandles`** per the Interfaces block. Build identities are computed once per sub-part at the file params and once per (key, sample); memoize the per-sample `resolveParams` across sub-parts. Fail closed: wrap each handle's evaluation in try/catch → `"the handle's point cannot be read"`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/preview-pose.test.js`
Expected: PASS

- [ ] **Step 5: Measure the cost** (no assertion, a number for the handover)

Run: `node --input-type=module -e "import hand from './src/parts/hand.js'; import { previewHandles } from './src/framework/preview-pose.js'; import { viewSubParts } from './src/framework/part-model.js'; const v=Object.keys(hand.views)[0]; const t=performance.now(); previewHandles(hand, v, hand.defaults, viewSubParts(hand, v, hand.defaults)); console.log((performance.now()-t).toFixed(0)+' ms');"`
Expected: prints a time; note it in the commit message. Over 1500 ms on this desktop means the sampling must be cheaper (drop to 3 samples per key) — decide and note.

- [ ] **Step 6: Commit**

```bash
git add src/framework/preview-pose.js test/preview-pose.test.js
git commit -m "preview-pose: previewHandles decides which handles are place-only against the file"
```

---

### Task 5: `exportPreview` passes the opening params

**Files:**
- Modify: `src/framework/mount.js` (`exportPreview`, ~line 2211)
- Test: `test/framework/preview-real-viewer.test.js`

**Interfaces:**
- Consumes: `openingParams` (Task 3), `encodePreviewGlb`'s `params` (Task 1), `decodePreviewGlb`'s `params` (Task 2).

- [ ] **Step 1: Write the failing tests**

```js
test("exportPreview stores the params the meshes sit at", async () => {
  const runtime = await mountHingedBox(hingedBox);        // the file's existing helper
  runtime.setParams({ lidAngle: 50 });
  const d = await decodePreviewGlb(await runtime.exportPreview());
  runtime.dispose();
  expect(d.params.lidAngle).toBe(0);                      // the cycle's t = 0 value, not the live 50
  expect(d.params.width).toBe(hingedBox.defaults.width);  // the defaults ride along
});

test("a still export stores the live params", async () => {
  // the file's existing still-part harness (the makePart() box of the mountPreview tests); set one numeric param first
  …
  expect(d.params).toMatchObject({ <thatParam>: <theValue> });
});
```
Write the second test against whichever still part the file already mounts; it only needs one numeric param set through `setParams` before `exportPreview`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/framework/preview-real-viewer.test.js -t "stores the"`
Expected: FAIL — `d.params` is null.

- [ ] **Step 3: Implement** in `exportPreview`: import `openingParams` from `./preview-pose.js`; pass `params: openingParams(part, current, params)` to `encodePreviewGlb`. Update the comment above it (the file carries the params its meshes sit at).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/framework/preview-real-viewer.test.js test/framework/mount.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/mount.js test/framework/preview-real-viewer.test.js
git commit -m "exportPreview: store the params the meshes sit at"
```

---

### Task 6: `mountPreview({ glb, part })` — Pose mode on the file

**Files:**
- Modify: `src/framework/mount-preview.js` (`KNOWN_OPTIONS`, the `ready` chain after `showAssembly`, the handle, `dispose`)
- Modify: `types/index.d.ts` (`MountPreviewOptions.part`, `PreviewRuntime.pose`, `PreviewRuntime.getParams`)
- Test: `test/framework/preview-real-viewer.test.js`

**Interfaces:**
- Consumes: `createFilePlacer`, `previewHandles` (Tasks 3–4); `createPoseMode` (its option list in `pose/pose-mode.js`); `attachPoseControls(viewer, mode, { viewbar }, { tooltip })`, `attachDragReadout(mode, { viewbar })`, `attachReadoutChip(viewer, mode, { stage }, { part, getParams, apply })`; `withDeriveMemo`; `rangesOf`.
- Produces on the handle:
  - `getParams(): object | null` — a copy of the preview's params; `null` before ready, without `part`, and after dispose.
  - `pose`: without `part`, mount.js's `NOOP_POSE` shape (`isEnabled → false`, `setEnabled`, `isLive → false`, `pinCount → 0`, `releasePins`, `handlePoints → []`). With `part`: `{ isEnabled, setEnabled, isLive, pinCount, releasePins, handlePoints, onDragEnd(cb) → unsubscribe, __dragReadout, __lastDragEnd }` (the two hooks as mount names them, for `scripts/check-pose.mjs`). Every method null-safe before ready and after dispose.
  - Internal: `preview.params` (the live object), `preview.fileParams` (frozen copy of the seed), `preview.placer`, `preview.poseMode`, `preview.visible` (the `previewHandles` result), set once decided.

Behaviour to implement (spec §2–3):
1. `KNOWN_OPTIONS` gains `"part"`; `part` must be an object with `parts`, else `TypeError("mountPreview: part must be a PartDefinition")`.
2. After `showAssembly` and `applyState`: `params = { ...part.defaults, ...(decoded.params ?? {}) }`, `fileParams = Object.freeze({ ...params })`, `placer = createFilePlacer(part, view, fileParams, drawnNames)` where `drawnNames` = decoded mesh names that are keys of `part.parts`. When `decoded.view` is non-null and not a key of `part.views`: warn once `partforge: preview part ignored — the file shows view "<v>", which the part does not declare` and attach nothing.
3. `visible = null` until decided; decide with `previewHandles(part, view, fileParams, drawnNames)` in idle time after `drawn` resolves (`requestIdleCallback`, else `setTimeout(…, 0)`); `visibleHandles: () => visible?.shown ?? []`.
4. `createPoseMode(viewer, { part, orbitControls: viewer.orbitControls, getParams, write, restore, commit, staleSubParts: () => [], ghost() {}, unghost() {}, hold, collide, onBlocked, visibleHandles, hoveredSubPart, cueBlocked })` where:
   - `getParams` → the live params (Task 8 makes it follow the player);
   - `write(values)`: `Object.assign(params, values)` then `withDeriveMemo(() => placer.apply(viewer, params))` and `viewer.requestRender()`; `restore(snapshot)` the same;
   - `commit(changed)`: notify `onDragEnd` listeners is pose-mode's own; here `commit` only records `lastDragEnd = { changed }` for `__lastDragEnd`;
   - `hold(on)`: no-op in this task (Task 7 and 8 fill it);
   - `collide: () => null`, `onBlocked() {}` in this task (Task 7 fills them);
   - `hoveredSubPart`: the last `pointermove`'s client point raycast through `raycastViewer(viewer, x, y)?.subPart ?? null` (import from `selection/raycast.js`); null before any move;
   - `cueBlocked: () => player ? motionState() === "playing" : false`.
   The wrapped-param rule: `write` clamps nothing itself; `createPoseSession` already snaps on release and the chip's `chipValues` wraps — verify with the test below; if a raw 370 lands, pass values through `snapValues(part, values)` from `pose/param-solve.js` in `write`.
5. Chrome, only when `opts.chrome`: `attachPoseControls(viewer, poseMode, { viewbar: toolbar }, { tooltip })`, `attachDragReadout(poseMode, { viewbar: toolbar })`; always: `attachReadoutChip(viewer, poseMode, { stage: container }, { part, getParams: () => params, apply: (values) => write(values) })`. Each pushed onto `cleanups` — the pose mode's `detach` pushed FIRST so it runs LAST (cleanups pop LIFO), as mount does.
6. `handle.getParams`, `handle.pose` per the Interfaces block.

- [ ] **Step 1: Write the failing tests** in `test/framework/preview-real-viewer.test.js`, in a new section `// --- mountPreview({ part }): posing on the file ---`. Build a gearbox GLB without a kernel: box soups named after `viewSubParts(gearbox, view, gearbox.defaults)` (each a 10 mm box at that sub-part's `placeMatrix` origin, so the viewer has something to frame), `part: gearbox`, `params: gearbox.defaults`. Helper `gearboxGlb({ params = gearbox.defaults, animation = null } = {})`.

```js
test("without part, mountPreview exposes the no-op pose and null params", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb() });
  await handle.ready;
  expect(handle.pose.isLive()).toBe(false);
  expect(handle.pose.handlePoints()).toEqual([]);
  expect(handle.getParams()).toBeNull();
  handle.dispose();
});

test("part must be a PartDefinition", async () => {
  expect(() => mountPreview(makeStage(), { glb: new Uint8Array(4), part: 3 })).toThrow(/part must be a PartDefinition/);
});

test("with part, the preview seeds its params from the file and shows the place-only handles once decided", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ params: { ...gearbox.defaults, driveAngle: 37 } }), part: gearbox });
  await handle.drawn;
  expect(handle.getParams().driveAngle).toBe(37);
  await settleIdle();                                   // flush requestIdleCallback / setTimeout(0)
  expect(handle.pose.isLive()).toBe(true);
  const ids = handle.pose.handlePoints().map((h) => h.handleId);
  expect(new Set(ids)).toEqual(new Set(Object.keys(gearbox.handles)));
  handle.dispose();
  expect(handle.getParams()).toBeNull();
  expect(handle.pose.handlePoints()).toEqual([]);
});

test("a drag writes the params and poses every gear by matrix; release fires onDragEnd once", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb(), part: gearbox });
  await handle.drawn; await settleIdle();
  const ends = [];
  handle.pose.onDragEnd((e) => ends.push(e));
  const { poseMode, placer } = handle.__preview;        // a test hook on the handle, like mount's __ hooks
  poseMode.session.begin("crank");
  poseMode.session.frame(/* a target that turns the crank 30°: compute from gearbox's crank axis */);
  const mid = handle.getParams().driveAngle;
  expect(mid).not.toBe(0);
  const viewerPose = state.renderer /* the fake renderer harness */ && viewerSubPose("gear1"); // read viewer._subMeshes.gear1.matrix
  expect(viewerPose.equals(matrixFrom(placer.matricesAt(...).get("gear1")))).toBe(true);
  poseMode.session.end();
  expect(ends).toHaveLength(1);
  expect(ends[0].changed).toEqual(["driveAngle"]);
  handle.dispose();
});

test("a wrapped param keeps its turn: a write of 370 lands as the schema's wrapped value", async () => { /* write({ driveAngle: 370 }) through the session's frame, then expect getParams().driveAngle to equal what mount's panel would hold (10, or 370 if the schema's wrap keeps turns) — read rangesOf(gearbox).get("driveAngle").wrap and assert accordingly */ });

test("the drawer box's corner handle is hidden in a preview; its drawers show", async () => {
  // drawer-box GLB of box soups, part: drawerBox
  expect(handle.__preview.visible).toEqual({ shown: ["drawer1", "drawer2", "drawer3"], hidden: { corner: expect.stringMatching(/rebuilds/) } });
});

test("dispose mid-drag writes nothing and throws nothing", async () => {
  const handle = …; await handle.drawn; await settleIdle();
  handle.__preview.poseMode.session.begin("crank");
  expect(() => handle.dispose()).not.toThrow();
  expect(handle.getParams()).toBeNull();
});

test("chrome: false attaches no Release pins action and no readout pill, but the chip", async () => { /* query .pf-pose-readout absent; the chip's element present after a drag end */ });
```
Use the file's existing `makeStage`, `makeToolbarStage`, fake-renderer `state` and the `session.begin / frame / end` driving pattern from `test/pose-collide-wiring.test.js`. The exact crank target: `rotary` drag targets are a point; take the crank's `point(p, d)` at the file params, rotate it 30° about the crank's axis `{ origin: [C1x, C1y, GEAR_Z], direction: [0, 0, 1] }` as declared in `gearbox.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/framework/preview-real-viewer.test.js -t "mountPreview"`
Expected: FAIL — unknown option "part"; no `pose` on the handle.

- [ ] **Step 3: Implement** in `mount-preview.js` per the behaviour list, plus `handle.__preview = { get params, fileParams, placer, poseMode, get visible }` (null without `part`). Add `NOOP_POSE` as an export of `mount.js` (it is a module const today) and import it.

- [ ] **Step 4: Update `types/index.d.ts`**

`MountPreviewOptions.part?: PartDefinition` with the doc: "0.186.0+: the part the file was written from. Pose mode then runs on the file: every handle the editor would show in this view that moves pieces by placement alone (never one that rebuilds geometry) can be dragged, IK included; drags write the preview's own params (`getParams`) and edit nothing else." `PreviewRuntime.pose: PoseRuntime & { onDragEnd(cb: (e: { handleId: string; changed: string[]; pinHeld: boolean; blocked: { a: string; b: string } | null }) => void): () => void }` and `getParams(): Record<string, unknown> | null`.

- [ ] **Step 5: Run the preview suites and the layering guards**

Run: `npx vitest run test/framework/preview-real-viewer.test.js test/framework/mount.test.js test/pose-mount-handle.test.js test/worker-layering.test.js`
Expected: PASS, including every pre-existing mountPreview test unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount-preview.js src/framework/mount.js types/index.d.ts test/framework/preview-real-viewer.test.js
git commit -m "mountPreview: Pose mode on the file with the part module (part option)"
```

---

### Task 7: Collisions in the preview

**Files:**
- Modify: `src/framework/mount-preview.js` (the `collide`, `onBlocked`, and `delivered` wiring)
- Test: `test/preview-pose.test.js` (the placer in the fastPath seat), `test/framework/preview-real-viewer.test.js` (the mount wiring)

**Interfaces:**
- Consumes: `createPoseCollide({ part, viewer, fastPath, getView, getParams, isLive, frameOf, schedule?, loadModules?, createHighlight })` from `pose/pose-collide.js`; `createFeatureHighlight` from `selection/feature-highlight.js`; `normalizeCollisions` from `collide/declaration.js`.
- Produces: in mountPreview with `part`, `poseCollide = createPoseCollide({ part, viewer, fastPath: placer, getView: () => view, getParams: () => params, isLive: () => poseMode.isLive(), frameOf: () => "canonical", createHighlight: createFeatureHighlight })`, created only when `normalizeCollisions(part)?.pose`; `poseCollide.delivered(drawnNames)` once after `showAssembly`; pose mode's `collide: (args) => poseCollide?.guardFor(args) ?? null`, `onBlocked: (pair) => poseCollide?.tint(pair)`; disposed in cleanups before the viewer.

- [ ] **Step 1: Write the failing tests**

In `test/preview-pose.test.js` (pure, modelled on `test/pose-collide-wiring.test.js`'s "mount's index" tests): the drawer box, two drawers' meshes as `barMeshes`-style boxes placed by `placeMatrix` at the file params, `createPoseCollide` with `fastPath: placer`, `frameOf: () => "canonical"`, a synchronous `schedule`, `loadModules` returning the real `world` and `partGuard`; after `delivered([...])` and a tick, `state().indexed` lists both; `guardFor({ handle: drawerBox.handles.drawer1, snapshot: file })` returns a guard whose `moving` is `["drawer1"]`; a settle from `drawer1Open: 0` toward a value that drives drawer1's box into drawer2's box (give the test meshes overlapping travel on purpose: two 20 mm boxes 5 mm apart along −Y) comes back `blocked` with `b: "drawer2"`.

In `preview-real-viewer.test.js`: mounting the drawer-box GLB with `part: drawerBox` creates a collide index (`handle.__preview.poseCollide.state().queued + indexed.length` equals the drawn count after `settleIdle()`), and mounting hinged-box (no `collisions` block) creates none (`poseCollide === null`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/preview-pose.test.js test/framework/preview-real-viewer.test.js -t "collid"`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block; expose `poseCollide` on `handle.__preview`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/preview-pose.test.js test/framework/preview-real-viewer.test.js test/pose-collide-wiring.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/mount-preview.js test/preview-pose.test.js test/framework/preview-real-viewer.test.js
git commit -m "mountPreview: the collision guard over the file's meshes"
```

---

### Task 8: A drag on a playing animation, and the turntable

**Files:**
- Modify: `src/framework/mount-preview.js` (`getParams`, `hold`, `createTurntable`, `motion.restart`)
- Test: `test/framework/preview-real-viewer.test.js`

**Interfaces:**
- Consumes: `viewAnimations`, `evaluate` from `animation.js`; the player's `started()`, `state()`, `pause()`, `onChange(cb)`.
- Produces (spec §5):
  - `anim = viewAnimations(part).get(view)?.find((a) => a.autoplay) ?? null` when `part` and `decoded.animation` are both present.
  - `getParams()`: when `player && anim && player.started() && !reducedMotion` and `player.state().status` is `"playing"` or `"intro"`: `{ ...fileParams, ...evaluate(anim, player.state().t).values }` (a fresh object); otherwise the live `params` object.
  - `hold(true)`: `turntable?.stop()`; if the player is playing/intro: `t = player.state().t; player.pause(); Object.assign(params, evaluate(anim, t).values)`. `hold(false)`: nothing.
  - `player.onChange`: on a change to `"paused"` or `"done"` that did not come from `hold`, `Object.assign(params, evaluate(anim, t).values)` so a later press finds them.
  - `createTurntable` gains `stop()`: `halt(); set("stopped")` (the grab path calls it too).
  - `motion.restart()` with `part`: `Object.assign(params, fileParams); placer.apply(viewer, params)` before the existing camera reset and player/turntable restart.

- [ ] **Step 1: Write the failing tests** (the gearbox GLB with `animation: samplePreviewAnimation(gearbox, view, gearbox.defaults, { buildReads: () => new Set() })` — an empty read set means "no build reads a tracked key", which is true of the gearbox; the test helper `gearboxGlb({ animation: true })` builds it)

```js
test("while the animation plays, getParams follows the player", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb({ animation: true }), part: gearbox });
  await handle.drawn; await settleIdle();
  state.renderer.animationLoop(…advance to t ≈ 0.4 as the file's existing player tests do…);
  const t = handle.animation.state().t;
  expect(handle.getParams().driveAngle).toBeCloseTo(evaluate(anim, t).values.driveAngle, 6);
  // the placer's matrix for those params matches the player's pose
  const m = handle.__preview.placer.matricesAt(...resolveParams(gearbox, handle.getParams())).get("gear1");
  expect(maxAbsDiff(m, viewerSubPoseArray("gear1"))).toBeLessThan(1e-6);
});

test("a press pauses the player and writes its params; cancel restores them, not t = 0", async () => {
  …advance to t ≈ 0.4…
  handle.__preview.poseMode.session.begin("crank");
  expect(handle.animation.state().status).toBe("paused");
  const held = handle.getParams().driveAngle;
  expect(held).toBeCloseTo(evaluate(anim, 0.4).values.driveAngle, 1);
  handle.__preview.poseMode.session.frame(/* a target */);
  handle.__preview.poseMode.session.cancel();
  expect(handle.getParams().driveAngle).toBeCloseTo(held, 9);
});

test("a press during the intro pauses it and writes the file params", async () => { /* a cue at t = 0 in the animation input; status "intro"; begin; expect paused and getParams() toEqual fileParams */ });

test("under reduced motion the params are the file params and handles show at once", async () => { /* the file's matchMedia stub; expect getParams() toEqual fileParams after settleIdle and pose.isLive() true */ });

test("a press stops the turntable", async () => {
  const handle = mountPreview(makeStage(), { glb: await gearboxGlb(), part: gearbox, turntable: 30 });
  await handle.drawn; await settleIdle();
  expect(handle.motion.state).toBe("playing");
  handle.__preview.poseMode.session.begin("crank");
  expect(handle.motion.state).toBe("stopped");
});

test("motion.restart puts the params back to the file's", async () => {
  …begin/frame/end a drag that moves driveAngle…
  handle.motion.restart();
  expect(handle.getParams()).toEqual(handle.__preview.fileParams);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/framework/preview-real-viewer.test.js -t "player|turntable|restart|intro|reduced"`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/framework/preview-real-viewer.test.js test/preview-player.test.js`
Expected: PASS, the pre-existing player and button tests included.

- [ ] **Step 5: Commit**

```bash
git add src/framework/mount-preview.js test/framework/preview-real-viewer.test.js
git commit -m "mountPreview: a drag on a playing animation starts from the player's pose"
```

---

### Task 9: The oracle reports a preview's handles; the CLI prints them

**Files:**
- Modify: `src/framework/oracle/measure.js` (~line 554, beside `handles`)
- Modify: `bin/cli.js` (~line 641, after the `handles:` block)
- Test: `test/oracle-handles.test.js`

**Interfaces:**
- Produces: `measure()`'s report gains `previewHandles: { shown: string[], hidden: Record<string, string> }` whenever `handles` is present, computed by `previewHandles(part, view, { ...part.defaults, ...params }, drawn)` where `drawn` = the sub-part rows of this view whose `triangleCount > 0` (the names a GLB of this view would hold). The CLI prints, after the `handles:` lines:
  ```
    preview handles: <shown ids joined ", " or "none">
      hidden in a preview: <id> — <reason>   (one line per hidden handle, omitted when none)
  ```

- [ ] **Step 1: Write the failing test** in `test/oracle-handles.test.js` (the file boots `k` with `bootManifoldKernel` in `beforeAll` and calls `measure(k, part, view)` synchronously; import `drawerBox` from `../src/parts/drawer-box.js`):

```js
it("reports which handles a cached preview would show, and why the rest are hidden", () => {
  const r = measure(k, drawerBox, Object.keys(drawerBox.views)[0]);
  expect(r.previewHandles.shown).toEqual(["drawer1", "drawer2", "drawer3"]);
  expect(r.previewHandles.hidden.corner).toMatch(/rebuilds/);
});
it("a part without handles reports no previewHandles either", () => {
  expect("previewHandles" in measure(k, demo, "spacer")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/oracle-handles.test.js`
Expected: FAIL — `previewHandles` undefined.

- [ ] **Step 3: Implement** in `measure.js` (import `previewHandles` from `../preview-pose.js`) and print in `bin/cli.js`.

- [ ] **Step 4: Run the oracle guards and a CLI measure**

Run: `npx vitest run test/oracle-handles.test.js test/oracle-entry.test.js test/worker-layering.test.js test/verify-golden.test.js` then `npx partforge measure src/parts/drawer-box.js`
Expected: PASS; the CLI prints the `preview handles:` line with the three drawers and `corner` hidden. (The verify golden pins `verify`, not `measure`'s report shape; if it fails, read the diff before re-recording.)

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/measure.js bin/cli.js test/oracle-handles.test.js
git commit -m "measure: report the handles a cached preview would show"
```

---

### Task 10: The browser check, the dev page, docs and the version bump

**Files:**
- Create: `preview-pose.html`, `src/app-preview-pose.js` (dev-only; NOT added to `vite.config.js`'s `rollupOptions.input`)
- Modify: `scripts/check-pose.mjs` (`PAGES` + `checkPreviewPose`), `scripts/bench-pose.mjs` (the page list)
- Modify: `docs/AUTHORING-PARTS.md` (after "### When a handle shows", a "### Handles in the cached preview" subsection), `README.md` (the mountPreview paragraph, ~line 182), `AGENTS.md` (the `gltf/` + `mount-preview.js` bullet)
- Modify: `package.json` (version 0.185.0 → 0.186.0)

**Interfaces:**
- `src/app-preview-pose.js`: mounts `robot-arm` through `mount()` into a hidden container, awaits `ready` and the first `onBuild`, calls `runtime.exportPreview()`, disposes it, then `mountPreview(stage, { glb, part, elements: { chrome: { theme } } })` into the visible `#app`. Exposes `window.__pfPart`, `window.__pfPreview` (the preview handle), `window.__pfWorkersAfterPreview` (a count of `Worker` constructions after the preview mount — wrap `window.Worker` before mounting), `window.__pfDragEnds` (every `pose.onDragEnd` payload). `?part=hand` swaps the part (the hand, for the blocked drag).
- `checkPreviewPose(page, url, errors)`: waits for `__pfPreview.drawn` and for `pose.handlePoints()` to be non-empty; a 20-move pointer drag of the `tool` handle as `checkRobotArm` does; asserts `__pfDragEnds` has exactly one entry with `changed` non-empty, `__dragReadout()` non-null mid-drag and null after, `__pfWorkersAfterPreview === 0`, `getParams()` differs from `__pfPart.defaults` on the changed keys, console clean. Then on `?part=hand`: the index-into-middle contact drag as `checkHand` performs it, asserting the drag end's `blocked.b` starts with `"middle"`.

- [ ] **Step 1: Write the page and app**, copying `robot-arm.html`'s stage markup (no rail: `#app` only, with `#viewbar` holding `#theme`) and the app per the Interfaces block.

- [ ] **Step 2: Add `checkPreviewPose` and the two `PAGES` entries** (`{ entry: "preview-pose.html", run: checkPreviewPose, required: true }` and the `?part=hand` variant — `PAGES` entries are plain file names; add a `query` field the loop appends to `url` when present). Add `preview-pose.html` to `bench-pose.mjs`'s pages with the robot-arm scenario.

- [ ] **Step 3: Run the check**

Run: `npm run check:pose`
Expected: every page passes, the two preview entries included. Fix what fails in `mount-preview.js`, never by loosening the check.

- [ ] **Step 4: Docs**

- `docs/AUTHORING-PARTS.md`, new subsection after "### When a handle shows":
  > ### Handles in the cached preview
  > A page that mounts a cached preview with the part (`mountPreview({ glb, part })`) poses it without a kernel. A handle shows there when it would show in the editor AND every parameter it writes only moves pieces by their placement — the sub-parts it touches keep the same geometry over the parameter's range. A handle that reshapes anything (the drawer box's corner handle, which writes `width` and `depth`) is hidden in the preview, never shown half-working. `partforge measure` prints a `preview handles:` line naming which show and why the rest are hidden. IK handles pass as long as their links are placed by `d.<limb>.place`; collisions and pins work as in the editor. A drag edits the preview's own copy of the parameters, never the part.
- `README.md`: in the `mountPreview` paragraph add one sentence: "`part` (0.186.0+) hands it the part module, and the editor's place-only handles — IK and collisions included — work on the file."
- `AGENTS.md`: in the `gltf/` + `mount-preview.js` bullet add: "Since 0.186.0 the file carries `partforgeParams` (encoder 6) and `mountPreview({ part })` runs Pose mode on it: `preview-pose.js` (pure; never imports `collide/world.js`) is the placer — `place(p, d) · base⁻¹` over the file's meshes, the pose ladder's rung 1 with the file as the delivery — and `previewHandles` decides which handles are place-only against the file (`handlesShownInView` ∩ the baker's identity test over `PREVIEW_HANDLE_SAMPLES`); `measure()` reports it as `previewHandles`. While a baked animation plays, `getParams()` follows the player; a press pauses it and writes its values."

- [ ] **Step 5: Version bump and the whole suite**

Set `"version": "0.186.0"` in `package.json`. Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add preview-pose.html src/app-preview-pose.js scripts/check-pose.mjs scripts/bench-pose.mjs docs/AUTHORING-PARTS.md README.md AGENTS.md package.json
git commit -m "Interactive previews: browser check, docs, 0.186.0"
```

---

## Self-review notes

- Spec coverage: §1 → Tasks 1, 2, 5; §2 → Task 6; §3 → Task 4 (+ Task 6 wiring); §4 → Task 7; §5 → Task 8; §6 → Tasks 1, 6, 10; Testing → each task's tests plus Task 10's browser check and bench; "Later" → nothing, by design.
- Names used across tasks: `openingParams`, `createFilePlacer` (`base`, `matricesAt`, `apply`), `previewHandles` (`shown`, `hidden`), `PREVIEW_HANDLE_SAMPLES`, `handle.__preview` (`params`, `fileParams`, `placer`, `poseMode`, `visible`, `poseCollide`), `handle.pose.onDragEnd`, `handle.getParams`, `createTurntable().stop`.
- The Review Focus lines are pinned in Tasks 3/4 (mismatched names), 6 (wrap, dispose mid-drag), 8 (intro press, reduced motion).
