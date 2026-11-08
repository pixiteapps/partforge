# Cel Shading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third render mode, `"cel"`, that draws the part in flat banded colour with ink outlines over a halftone field and a live soft ground shadow, selectable from the View style popover and carried through captures.

**Architecture:** A new `src/framework/cel/` folder, split like `materials/`: one pure module (constants, tone derivation; no three) and three three.js modules (the band `ShaderMaterial`, the screen-space ink pass, the VSM ground shadow). `viewer.js` gains `enterCel` beside `enterRealistic` / `enterCad`, routes the ink pass through `renderWithBackdrop` (so the canvas and every offscreen capture of the live scene get it), and teaches `captureIn` / `renderViews` / `renderStyleThumbnail` the third mode. The popover, persistence, mount, preview, types and docs each accept `"cel"`.

**Tech Stack:** three.js r0.184 (`ShaderMaterial`, `DepthTexture`, `VSMShadowMap`, `ShadowMaterial`), vitest (+ happy-dom for DOM tests), Playwright Chromium for the smoke check (`scripts/check-app.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-07-cel-shading-design.md` (constants table, decisions 1–10, invariants).

## Global Constraints

- Node 24 (`nvm use`) for every command.
- `src/framework/cel/cel-style.js` imports no three and no DOM; nothing under `cel/` is ever reachable from `src/framework/worker.js`.
- Every `ShaderMaterial` fragment shader ends its colour write with `#include <colorspace_fragment>`; every cel material is `clipping: true` and includes three's `clipping_planes_*` chunks.
- The ink pass and the ground shadow render only for the LIVE scene (`renderScene === scene` inside `renderWithBackdrop`); throwaway scenes (`renderMeshPayloads`, `renderMaterialThumbnail`) stay CAD.
- `captureCanonicalViews` (agent renders), `renderStyles.js`, `softrender/` and the CLI are untouched; `npm run check:softrender` must stay green.
- Constants are the spec's table, verbatim: bands 3; band edges 0.45 / 0.05; softness 0.015; shadow darken 0.74, tint `#6f86b4` at 0.5, deep darken 0.7; highlight 0.85 / 0.6 / 60; rim 0.6 / 0.18; key light az −35° el 38° (view space); ink `#161a24`, thick 0.7 / thin 0.3 CSS px, outer ×1.4, depth threshold 0.004, normal threshold 0.3, kernel lines on at 0.55; field `#9fd9ea`, halftone 0.1 at 7 px, dot colour field × 0.82; body default `#eef1f4`; ground shadow opacity 0.3, colour `#24304a`, penumbra 8 % of R, light elevation 60° (world elevation clamped ≥ 40°), map 2048² (1024² on a coarse pointer, while moving, and in `mountPreview`), bias −0.0015, light at 30 R, slab 26 R – 34 R, shadow camera half-width 4 R, plane side 2·4R/√2 × 0.98.
- `package.json` version 0.186.0 in this branch; the spike (`src/spike/`, `cel-demo.html`, `src/app-cel-demo.js`) and the two `// SPIKE` hook lines are removed before the PR opens.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A sub-part with `display.opacity < 1` or a user see-through fade in cel: it must draw as a translucent flat fill with no ink of its own and must not occlude ink behind it (Task 4's check-app step fades a sub-part and asserts the capture still succeeds; Task 2's material test pins `transparent` / `depthWrite`).
2. A `transparent` viewer (`mountPreview({ background: "transparent", renderMode: "cel" })`): no field colour, no halftone, part + ink + ground shadow over alpha 0 (Task 2's ink test pins that `field: null` writes no dots; Task 6's preview test accepts the combination).
3. A cutaway in cel: the clipped clone must keep clipping (`clipping: true`, chunks present), the cap must get a colour (`material.color` exists on the cel material) and ink must stop at the cut (Task 2's material test pins the first two; Task 4's check-app step captures in cel while the cutaway the earlier check toggled on is still enabled, and the prepass normals are double-sided so the rim of a cut reads as a crease).
4. A theme toggle while in cel must leave the field, ink and lines alone, and the switch back to CAD must restore the theme's line colour (Task 4's check-app step toggles the theme in cel and back).
5. A top or bottom camera: the ground light's world elevation is clamped to ≥ 40° and the plane is never drawn from below (Task 2's ground tests pin the clamp and the plane's `side`).

---

### Task 1: The pure half — `cel-style.js`

**Files:**
- Create: `src/framework/cel/cel-style.js`
- Test: `test/cel-style.test.js`, `test/cel-layering.test.js`

**Interfaces:**
- Produces: `CEL` (frozen constants, shape below), `celBase(display) -> number` (sRGB hex), `celTones(baseHex) -> { lit: number, shadow: number, deep: number }` (sRGB hex), `CEL_BODY = 0xeef1f4`.

```js
export const CEL = Object.freeze({
  bands: { count: 3, lit: 0.45, deep: 0.05, softness: 0.015 },
  shadow: { darken: 0.74, tint: 0x6f86b4, tintAmount: 0.5, deepDarken: 0.7 },
  highlight: { strength: 0.85, size: 0.6, shininess: 60 },
  rim: { strength: 0.6, width: 0.18 },
  light: { azimuthDeg: -35, elevationDeg: 38 },
  ink: { color: 0x161a24, thickPx: 0.7, thinPx: 0.3, outerBoost: 1.4, depthThreshold: 0.004, normalThreshold: 0.3, kernelLineOpacity: 0.55 },
  field: { color: 0x9fd9ea, dots: 0.1, dotCellPx: 7, dotDarken: 0.82 },
  ground: { opacity: 0.3, color: 0x24304a, penumbra: 0.08, elevationDeg: 60, minWorldElevationDeg: 40,
            mapSize: 2048, mapSizeSmall: 1024, bias: -0.0015, lightDistanceR: 30, nearR: 26, farR: 34, frustumR: 4, planeFill: 0.98 },
});
```

- [ ] **Step 1: Write the failing tests**

`test/cel-style.test.js`:
```js
import { describe, it, expect } from "vitest";
import { CEL, CEL_BODY, celBase, celTones } from "../src/framework/cel/cel-style.js";
import { cadAppearance } from "../src/framework/materials/resolve.js";

describe("celBase", () => {
  it("is the body white when the display names no colour and no material", () => {
    expect(celBase(undefined)).toBe(CEL_BODY);
    expect(celBase({})).toBe(CEL_BODY);
  });
  it("is the effective CAD colour when a colour or material is named", () => {
    expect(celBase({ color: 0xe8442c })).toBe(0xe8442c);
    expect(celBase({ material: "brass" })).toBe(cadAppearance({ material: "brass" }).color);
  });
});
describe("celTones", () => {
  const luma = (h) => 0.2126 * ((h >> 16) & 255) + 0.7152 * ((h >> 8) & 255) + 0.0722 * (h & 255);
  it("white goes to a blue-grey shadow: darker than lit, bluer than it, deep darker still", () => {
    const t = celTones(0xeef1f4);
    expect(t.lit).toBe(0xeef1f4);
    expect(luma(t.shadow)).toBeLessThan(luma(t.lit) * 0.8);
    expect(t.shadow & 255).toBeGreaterThan((t.shadow >> 16) & 255); // blue > red
    expect(luma(t.deep)).toBeCloseTo(luma(t.shadow) * CEL.shadow.deepDarken, -1);
  });
  it("a saturated red keeps red dominant in its shadow", () => {
    const t = celTones(0xe8442c);
    expect((t.shadow >> 16) & 255).toBeGreaterThan(t.shadow & 255);
  });
  it("black stays black", () => {
    expect(celTones(0x000000)).toEqual({ lit: 0, shadow: 0, deep: 0 });
  });
  it("constants are frozen and in range", () => {
    expect(Object.isFrozen(CEL) && Object.isFrozen(CEL.ink)).toBe(true);
    expect(CEL.ink.thickPx).toBe(0.7); expect(CEL.ink.thinPx).toBe(0.3); expect(CEL.ground.opacity).toBe(0.3);
    expect(CEL.bands.count).toBe(3); expect(CEL.field.color).toBe(0x9fd9ea);
  });
});
```

`test/cel-layering.test.js` (model on `test/softrender-no-three.test.js`): `walk("<root>/src/framework/cel/cel-style.js")` reaches no bare `three` / `three/*`; `walk("<root>/src/framework/worker.js")`'s resolved set contains no path under `/src/framework/cel/`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/cel-style.test.js test/cel-layering.test.js`
Expected: FAIL — cannot resolve `../src/framework/cel/cel-style.js`.

- [ ] **Step 3: Implement `cel-style.js`**

`celBase(display)`: when `display` is not an object or names neither `color` nor `material`, return `CEL_BODY`; else `cadAppearance(display).color` (import from `../materials/resolve.js`, which is three-free). `celTones(base)`: work in linear-ish 0..1 per channel on sRGB bytes (match the spike: `shadowCol = mix(base * darken, tint * (luma(base) / luma(tint)) * darken, tintAmount)`, each channel clamped to 0..1; `deep = shadow * deepDarken`), round back to hex.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cel-style.test.js test/cel-layering.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cel/cel-style.js test/cel-style.test.js test/cel-layering.test.js
git commit -m "feat(cel): pure constants and tone derivation"
```

---

### Task 2: The three modules — material, ink pass, ground shadow

**Files:**
- Create: `src/framework/cel/cel-material.js`, `src/framework/cel/cel-ink.js`, `src/framework/cel/cel-ground.js`
- Test: `test/cel-three.test.js` (plain Node: three's objects construct without GL)
- Reference (read, do not import): `src/spike/cel.js` lines 79–209 (`CEL_VERT`, `CEL_FRAG`, `INK_VERT`, `INK_FRAG`) and 283–370 (ground + render wrap).

**Interfaces:**
- Consumes: `CEL`, `celBase`, `celTones` (Task 1).
- Produces:
  - `buildCelMaterial(display) -> THREE.ShaderMaterial` with `userData.pfCel = true`, `clipping: true`, `transparent` / `opacity` / `depthWrite: false` when `display.opacity < 1` (same rule as `buildCadMaterial`), a `color` property (a `THREE.Color` of the lit tone — the cutaway's cap reads `sourceMaterial.color`), uniforms `uLit`, `uShadow`, `uDeep` (per material) and the shared constant uniforms. `cloneCelMaterial` is not needed: `material.clone()` must keep `uLit/uShadow/uDeep` (three deep-clones uniforms) and the test pins it.
  - `createCelInk() -> { render(renderer, scene, camera, { pixelScale, field }), dispose() }`. `render` does the normal + depth prepass over `scene` with `camera.layers` set to `CEL_LAYER` (exported constant `1`), the scene's `overrideMaterial` a `MeshNormalMaterial` whose `clippingPlanes` are copied from `opts.clippingPlanes ?? []`, clear colour `0x808080` with the renderer's previous clear colour and alpha RESTORED afterwards; then the fullscreen quad with `autoClear` false. `field` is `{ color: THREE.Color, dots: boolean }` or `null` (transparent: the shader's background branch discards instead of drawing dots). Resizes its target to `renderer.getDrawingBufferSize()` on each call.
  - `createCelGround({ mapSize }) -> { light, plane, fit(bounds: THREE.Box3), aim(camera, { azimuthDeg, elevationDeg }), setMapSize(n), setCasters(meshes), dispose() }`. `light` is a `DirectionalLight` of intensity 0 with `castShadow`, `shadow.bias = CEL.ground.bias`, `shadow.blurSamples = 25`; `plane` a `Mesh` of `PlaneGeometry` with `ShadowMaterial({ color: CEL.ground.color, opacity: CEL.ground.opacity, transparent: true, depthWrite: false, side: FrontSide })`, `receiveShadow`, `rotation.x = -π/2`, `name = "pfCelGround"`. `fit` sets `plane.position` to (centre.x, bounds.min.y − 1e-3·R, centre.z), the plane side per the constants, and the shadow camera `±4R`, near `26R`, far `34R` (R = half the bounds' diagonal, floored at 1e-3). `aim` turns the view-space direction (az, el) into world through `camera.matrixWorld`, clamps its world elevation to ≥ `minWorldElevationDeg`, places the light at centre + dir·30R, and the target at the centre. `shadow.radius = penumbra · mapSize / (2 · frustumR)`, recomputed in `setMapSize`.

- [ ] **Step 1: Write the failing tests**

`test/cel-three.test.js`:
```js
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildCelMaterial } from "../src/framework/cel/cel-material.js";
import { createCelInk, CEL_LAYER } from "../src/framework/cel/cel-ink.js";
import { createCelGround } from "../src/framework/cel/cel-ground.js";
import { CEL, celTones } from "../src/framework/cel/cel-style.js";

describe("buildCelMaterial", () => {
  it("is a clipping-capable ShaderMaterial that writes sRGB and exposes its lit colour", () => {
    const m = buildCelMaterial({ color: 0xe8442c });
    expect(m.isShaderMaterial && m.userData.pfCel && m.clipping).toBe(true);
    expect(m.fragmentShader).toContain("#include <colorspace_fragment>");
    expect(m.fragmentShader).toContain("#include <clipping_planes_fragment>");
    expect(m.vertexShader).toContain("#include <clipping_planes_vertex>");
    expect(m.color.getHex()).toBe(celTones(0xe8442c).lit);
    expect(m.uniforms.uShadow.value.getHex()).toBe(celTones(0xe8442c).shadow);
    expect(m.transparent).toBe(false);
  });
  it("a ghost is transparent with depthWrite off, like the CAD material", () => {
    const m = buildCelMaterial({ color: 0xffffff, opacity: 0.4 });
    expect(m.transparent).toBe(true); expect(m.opacity).toBe(0.4); expect(m.depthWrite).toBe(false);
  });
  it("a clone keeps its tones (the cutaway and fades clone it)", () => {
    const c = buildCelMaterial({ color: 0x3366cc }).clone();
    expect(c.uniforms.uLit.value.getHex()).toBe(celTones(0x3366cc).lit);
    expect(c.userData.pfCel).toBe(true);
  });
});
describe("createCelInk", () => {
  it("constructs, names the sub-part layer, and disposes", () => {
    const ink = createCelInk();
    expect(CEL_LAYER).toBe(1);
    expect(typeof ink.render).toBe("function");
    expect(() => ink.dispose()).not.toThrow();
  });
});
describe("createCelGround", () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-10, 0, -20), new THREE.Vector3(10, 30, 20));
  const R = bounds.getSize(new THREE.Vector3()).length() / 2;
  it("fits the plane under the bounds, inside the shadow frustum, with the slab per spec", () => {
    const g = createCelGround({ mapSize: 2048 });
    g.fit(bounds);
    expect(g.plane.position.y).toBeCloseTo(0 - 1e-3 * R, 5);
    expect(g.plane.geometry.parameters.width).toBeCloseTo((2 * CEL.ground.frustumR * R) / Math.SQRT2 * CEL.ground.planeFill, 5);
    const sc = g.light.shadow.camera;
    expect([sc.right, sc.near, sc.far]).toEqual([CEL.ground.frustumR * R, CEL.ground.nearR * R, CEL.ground.farR * R]);
    expect(g.light.shadow.radius).toBeCloseTo(CEL.ground.penumbra * 2048 / (2 * CEL.ground.frustumR), 5);
    expect(g.plane.material.side).toBe(THREE.FrontSide);
    expect(g.light.intensity).toBe(0);
  });
  it("the plane's corners stay inside the map under every azimuth", () => {
    const g = createCelGround({ mapSize: 1024 });
    g.fit(bounds);
    const cam = new THREE.PerspectiveCamera(); cam.position.set(50, 40, 50); cam.lookAt(0, 15, 0); cam.updateMatrixWorld();
    const half = g.plane.geometry.parameters.width / 2;
    for (let az = -180; az < 180; az += 10) {
      g.aim(cam, { azimuthDeg: az, elevationDeg: CEL.ground.elevationDeg });
      g.light.shadow.camera.updateMatrixWorld(); g.light.shadow.updateMatrices(g.light);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = new THREE.Vector3(g.plane.position.x + sx * half, g.plane.position.y, g.plane.position.z + sz * half)
          .applyMatrix4(g.light.shadow.camera.matrixWorldInverse).applyMatrix4(g.light.shadow.camera.projectionMatrix);
        expect(Math.abs(p.x)).toBeLessThan(1); expect(Math.abs(p.y)).toBeLessThan(1); expect(Math.abs(p.z)).toBeLessThan(1);
      }
    }
  });
  it("clamps the light's world elevation to 40° from a top-down camera", () => {
    const g = createCelGround({ mapSize: 1024 });
    g.fit(bounds);
    const cam = new THREE.PerspectiveCamera(); cam.position.set(0, 200, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    g.aim(cam, { azimuthDeg: -35, elevationDeg: 60 });
    const d = g.light.position.clone().sub(g.light.target.position).normalize();
    expect(Math.asin(d.y) * 180 / Math.PI).toBeGreaterThanOrEqual(CEL.ground.minWorldElevationDeg - 1e-6);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/cel-three.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `cel-material.js`**

Port `CEL_VERT` / `CEL_FRAG` from the spike with three additions: the `clipping_planes_pars_vertex` / `clipping_planes_vertex` / `clipping_planes_pars_fragment` / `clipping_planes_fragment` chunks; a `uOpacity` uniform kept in step with the material's `opacity` by an own-property accessor (`Object.defineProperty(material, "opacity", { get, set })` writing `uniforms.uOpacity.value`), so `fadeMatFor`'s `fm.opacity = fade` works unchanged and a clone (which copies own enumerable data properties, not the accessor) is re-wired by the same helper in the clone path the viewer uses — give the module `wireCelOpacity(material)` and call it from `buildCelMaterial`; the viewer calls it on every clone it makes of a `pfCel` material (fade clones; the cutaway clones through `material.clone()`, so override `clone()` on the instance to call `wireCelOpacity` on its result); and the three tone uniforms `uLit` / `uShadow` / `uDeep` instead of the spike's single `uBase`. The shared uniforms hold the `CEL` constants; the light direction is computed once from `CEL.light` (view space, no per-frame update). Define `color` as a getter returning `uniforms.uLit.value`.

- [ ] **Step 4: Implement `cel-ink.js`**

Port `INK_VERT` / `INK_FRAG`. `render` follows the spike's wrap body: save clear colour/alpha and `camera.layers.mask`; prepass with a `MeshNormalMaterial({ side: THREE.DoubleSide })` override (double-sided so a cutaway's hollow interior registers as surface and the cut's rim reads as a crease rather than a hole) into a `WebGLRenderTarget` with a `DepthTexture(FloatType)` sized to the drawing buffer; restore; draw the quad with `uNear/uFar/uOrtho/uPx = pixelScale`, `uField` / `uFieldDots` / `uDotCell`; when `field` is null set `uBgDots = 0`. Dispose target, materials and geometry in `dispose`.

- [ ] **Step 5: Implement `cel-ground.js`**

Port the spike's ground block into the interface above. `setCasters(meshes)` sets `castShadow` true on those and false on the previously set ones. `aim` clamps: `if (dir.y < sin(min)) { scale dir.xz so |dir| = 1 with dir.y = sin(min) }` (if xz is zero, use the camera's right vector for the azimuth).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/cel-three.test.js test/cel-layering.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/framework/cel test/cel-three.test.js
git commit -m "feat(cel): band material, ink pass and VSM ground shadow modules"
```

---

### Task 3: Popover, persistence and the visibility rule

**Files:**
- Modify: `src/framework/view-style-state.js` (STYLES, styleFor), `src/framework/view-style-controls.js:201-215` (choose), `src/framework/view-state.js:69-76` (load/saveRenderMode), `src/framework/materials/overrides.js:134-145` (subPartVisibility), `src/framework/app.css:805`
- Test: `test/view-style-popover.test.js:45`, `test/view-state.test.js:107-114`, `test/display-overrides.test.js:119-124`

**Interfaces:**
- Produces: `STYLES[1] === { id: "cel", label: "Cel" }`; `styleFor("cel", anyEnv) === "cel"`; `saveRenderMode("cel")` persists and `loadRenderMode()` returns it; `subPartVisibility({ renderMode: "cel" }).linesVisible === true`.
- Consumes (Task 4 provides the real one; tests stub it): `viewer.setRenderMode("cel")` resolving `"cel"`.

- [ ] **Step 1: Write the failing tests**

In `test/view-style-popover.test.js` change the tile count at line 45 to 6 and add:
```js
it("has a Cel tile after CAD that sets the cel render mode and persists it", async () => {
  const set = vi.fn(async (m) => m);
  const vs = attachViewStyleControls({ ...viewerStub(), setRenderMode: set, getRenderMode: () => "cel" }, { stage, toolbar });
  vs.open();
  const tiles = [...vs.popover.querySelectorAll(".pf-view-style-tile")];
  expect(tiles.map((t) => t.dataset.style).slice(0, 2)).toEqual(["cad", "cel"]);
  expect(tiles[1].querySelector(".pf-view-style-label").textContent).toBe("Cel");
  expect(tiles[1].getAttribute("aria-pressed")).toBe("true");
  tiles[1].click(); await Promise.resolve(); await Promise.resolve();
  expect(set).toHaveBeenCalledWith("cel");
  expect(localStorage.getItem("partforge:renderMode")).toBe("cel");
  vs.detach();
});
```
In `test/view-state.test.js` extend the render-mode test: `saveRenderMode("cel"); expect(loadRenderMode()).toBe("cel");` before the `"bogus"` line.
In `test/display-overrides.test.js` add to the first `subPartVisibility` test: `expect(subPartVisibility({ ...base, renderMode: "cel" })).toEqual({ meshVisible: true, linesVisible: true, fade: null });`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/view-style-popover.test.js test/view-state.test.js test/display-overrides.test.js`
Expected: FAIL on the tile count (5), the cel persistence (null) and `linesVisible` (false).

- [ ] **Step 3: Implement**

`STYLES = [{ id: "cad", label: "CAD" }, { id: "cel", label: "Cel" }, ...environments]`; `styleFor = (mode, env) => mode === "realistic" ? env : mode === "cel" ? "cel" : "cad"`. In `choose`: `if (id === "cad" || id === "cel") saveRenderMode(await viewer.setRenderMode(id))`. `view-state.js`: the guard set is `["cad", "realistic", "cel"]` in both functions (and the comment lists three). `overrides.js`: `linesVisible = renderMode !== "realistic"`. `app.css:805`: `repeat(3, 1fr)`. Update the header comment of `view-style-state.js` ("CAD, then Cel, then the environments").

- [ ] **Step 4: Run the three files, then the whole suite**

Run: `npx vitest run test/view-style-popover.test.js test/view-state.test.js test/display-overrides.test.js && npm test`
Expected: PASS; the full suite green (a snapshot or count elsewhere that assumed five tiles is fixed in this step).

- [ ] **Step 5: Commit**

```bash
git add src/framework/view-style-state.js src/framework/view-style-controls.js src/framework/view-state.js src/framework/materials/overrides.js src/framework/app.css test/view-style-popover.test.js test/view-state.test.js test/display-overrides.test.js
git commit -m "feat(cel): Cel tile, persistence and feature lines on in cel"
```

---

### Task 4: The viewer — enterCel, ink, lines, captures

**Files:**
- Modify: `src/framework/viewer.js` — `lineMaterial` (340), `applySubOpacity` (457–486), `rematerialize` (520–540), `physicalFor` region (883), `enterRealistic` / `enterCad` / `setRenderMode` (1105–1265), `livePixelRatio` (1090), `setTheme` (2368), `renderOffscreen` (2489), `captureCurrent` / `captureIn` / `renderStyleThumbnail` (2760–2870), `renderViews` (first lines), `renderWithBackdrop` (3098), the API object (3600–3625)
- Modify: `src/framework/mount.js:1031` (the restore line)
- Test: `scripts/check-app.mjs` (new `checkCelMode()`, called after `checkCaptureCurrent()`)

**Interfaces:**
- Consumes: Task 2's three modules; Task 1's `CEL`.
- Produces: `viewer.setRenderMode("cel")` resolves `"cel"` after `compileCel()`; `getRenderMode()` reads `"cel"`; `captureCurrent({ renderMode: "cel" })`, `renderViews(names, { renderMode: "cel" })`, `renderStyleThumbnail("cel")` all render the look; `publishMode` reports `busy: true` during the compile. Internal: `celFor(name)` (cached `celMats`), `enterCel({ live })`, `syncLineLook()`, `lineOpacityForMode()`.

- [ ] **Step 1: Write the failing smoke check**

Add to `scripts/check-app.mjs` a `checkCelMode()` modelled on `checkCaptureCurrent()` and call it right after it (line 877). It returns early unless `window.__pfRuntime?.renderMode`. In-page helper (one `page.evaluate`): `cornerOf(dataUrl)` draws the JPEG into a 2D canvas and returns `[r,g,b]` at (2,2); `near(a, b, tol)` is max channel distance. The check, all inside the page except the screenshot equality:
1. `const mode = await rt.renderMode.set("cel")` → expect `"cel"`, and `rt.getViewerState().renderMode === "cel"`.
2. Wait 30 frames. `cornerOf(rt.captureCurrent({ size: 128 }))` within 14 of `[159, 217, 234]`.
3. `cornerOf(rt.captureCurrent({ size: 128, renderMode: "cad" }))` farther than 60 from the field colour.
4. `(await rt.renderViews(["front"], { renderMode: "cel" }))[0].dataUrl` corner within 14 of the field colour.
5. Toggle the theme (`#theme` click) and back; the live capture's corner is still the field colour.
6. Fade one sub-part: `rt.setSubPartDisplay(rt.listSubParts()[0].name, { opacity: 0.5 })`; `captureCurrent({ size: 128 })` still returns a JPEG; clear with `rt.clearSubPartDisplay({ viewing: true })`.
7. `await rt.renderMode.set("cad")` → `"cad"`; the live canvas screenshot after 30 frames equals the one taken before step 1.
Push a distinct `errors` message for each failing assertion (`cel: <what>`). The existing console-error collection catches shader compile errors.

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-app.mjs demo.html`
Expected: FAIL with `cel: set("cel") resolved "cad"`.

- [ ] **Step 3: Implement the mode in `viewer.js`**

- Import `buildCelMaterial`, `createCelInk`, `CEL_LAYER`, `createCelGround` (the ground is wired in Task 5; import now, construct lazily), `CEL`, `celBase`.
- `const celMats = new Map()`; `celFor(name)` builds from `effectiveDisplayOf(name)` and caches; `rematerialize` disposes and deletes the entry and, when `renderMode === "cel"`, rebases onto `celFor(name)`.
- `lineOpacityForMode = () => renderMode === "cel" ? CEL.ink.kernelLineOpacity * edgeOpacity : edgeOpacity`; `syncLineLook()` sets `lineMaterial.color` to `CEL.ink.color` in cel else `THEME[currentTheme].line`, `lineMaterial.opacity = lineOpacityForMode()`, `transparent = opacity < 1`, and the same colour on every `fadeLineMats` value. Lines 480 and 2668 multiply by `lineOpacityForMode()` instead of `edgeOpacity`. `setTheme` calls `syncLineLook()` instead of its two colour lines.
- `enterCel({ live = true })`: `renderMode = "cel"`; `scene.environment = null`; remove the realistic rig's ground/shadow/lights if present and null `realisticRig`; `scene.background = transparent ? null : new THREE.Color(CEL.field.color)`; `backgroundBlurriness/Intensity/Rotation` reset as `enterCad` does; live lights hidden; `grid.visible = false`; `renderer.toneMapping = NoToneMapping`; `setSubMaterials(celFor)`; `disposeLiveShadow()`; `if (live) applyPixelRatio("cad")`; `syncLineLook()`; `refreshFeatureLines()`; `if (live) invalidateMaterialThumbnails()`. Wrapped like `enterRealistic`: on throw, `enterCad({ live })` then rethrow.
- `enterCad` and `enterRealistic` leave cel cleanly: both already reset background/lights/grid; add `syncLineLook()` to each after `renderMode` is set, and make `enterRealistic` tolerate `realisticRig === null` on entry from cel (it does).
- `compileCel()` mirrors `compileRealistic` without the rig: a proxy scene of every built sub-part under `celFor(n)`, `compileAsync`.
- `setRenderMode`: `want` is one of the three (anything else → `"cad"`). For `"cel"`: if already cel, publish and return; else `publishMode({ busy: true })`, `await compileCel()`, stale check, `enterCel()`, `publishMode()`; on throw log and `publishMode({ error: "couldn't switch to cel" })`. Leaving cel for `"cad"` goes through `enterCad`; for `"realistic"` the existing path (`enterRealistic` replaces materials).
- `renderWithBackdrop`: after the scene render, `if (renderMode === "cel" && renderScene === scene) ink.render(renderer, scene, cam, { pixelScale, field })` where `pixelScale` is `renderer.getPixelRatio()` when `renderer.getRenderTarget() === null`, else `Math.max(1, Math.max(w, h) / 800)` of the bound target, and `field` is `null` when `transparent` else `{ color: fieldColor, dots: true }`; `clippingPlanes` is `plane ? [plane] : []` from `cutaway.getPlane?.(_shadowClipPlane)`. Sub-part meshes get `layers.enable(CEL_LAYER)` where they are created (line ~370) so the prepass sees them; a faded sub-part (`fade !== null` in `applySubOpacity`) gets `layers.disable(CEL_LAYER)` and re-enabled when unfaded.
- `renderOffscreen`: `const lit = renderMode !== "realistic" && renderMode !== "cel"` guards the capture-light block (two sites).
- `captureIn(want, rig, capture)`: generalise to three modes — a table of `enter(want)`: `"cad" → enterCad({ live: false })`, `"cel" → enterCel({ live: false })`, `"realistic" → enterRealistic(rig, { live: false[, reground: false] })`; remember the live mode and rig, enter the wanted one, capture, restore (realistic restored with `reground: false`), same error handling as today.
- `captureCurrent`: `if (want === "cel") return captureIn("cel", null, capture)`.
- `renderStyleThumbnail`: `if (style === "cel") return captureIn("cel", null, capture)` before the environment branch.
- `renderViews`: `if (want === "cel") { await compileCel(); return captureIn("cel", null, () => canonicalViewsInCurrentLook(viewNames)); }`.
- `thumbKey` passes `renderMode` as today (cel spheres are CAD spheres: `rig` is null in cel).
- `mount.js:1031`: `const initialMode = viewerState?.renderMode ?? loadRenderMode() ?? "cad"; if (initialMode !== "cad") viewer.setRenderMode(initialMode);`.

- [ ] **Step 4: Run the smoke check and the unit suite**

Run: `node scripts/check-app.mjs demo.html && node scripts/check-app.mjs hinged-box.html && npm test`
Expected: both checks pass (the cel block included, `checkCutawayCapture` still green), suite green.

- [ ] **Step 5: Look at it**

Run: `npm run dev`, open `/robot-arm.html`, pick Cel in the eye popover. Expected: the spike's look minus the ground shadow (Task 5); the cutaway, measure, hover highlight and pose drag work; Esc / theme toggle leave the field alone; CAD tile restores the theme.

- [ ] **Step 6: Commit**

```bash
git add src/framework/viewer.js src/framework/mount.js scripts/check-app.mjs
git commit -m "feat(cel): third render mode in the viewer — band materials, ink pass, captures"
```

---

### Task 5: The ground shadow in the viewer

**Files:**
- Modify: `src/framework/viewer.js` — `enterCel` / `enterCad` / `enterRealistic`, `placeGround` + `holdGround` region (987–1035), `renderWithBackdrop`, `showAssembly` (where `placeGround` is called), `castersNow()` (943)
- Test: `scripts/check-app.mjs` `checkCelMode()` (one more assertion)

**Interfaces:**
- Consumes: Task 2's `createCelGround`; the viewer's `getVisibleWorldBounds`, `groundHolds` / `lastGround`, `castersNow`, `isCoarsePointer`.
- Produces: in cel, `scene` holds the ground light, its target and the plane; `renderer.shadowMap.enabled` true with `VSMShadowMap` only while cel is on (previous values restored on leaving).

- [ ] **Step 1: Extend the smoke check**

In `checkCelMode()` after step 2: over the lower half of `captureCurrent({ size: 256 })`, count pixels that lie on the field-to-shadow line — the shadow at full opacity over the field is `(122, 166, 186)`, so accept `g < 206 && |(b − g) − 17.5| ≤ 4 && |(g − r) − 50| ≤ 8` (the body's own band tones have `g − r` near 17, ink and the part's deep tones are far darker, the untouched field has `g ≈ 217`). Expect at least 40 such pixels (demo.html's spacer casts a visible shadow down-right of itself). Push `cel: no ground shadow in the capture` on failure.

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-app.mjs demo.html`
Expected: FAIL with `cel: no ground shadow in the capture`.

- [ ] **Step 3: Implement**

- Extract the floor derivation of `placeGround` into `floorFromBounds(b)` → `{ y, centerX, centerZ, radius, footprintMm }` honouring the hold (`groundHeld && lastGround ? lowered copy : fresh`), used by both `placeGround` (realistic) and a new `placeCelGround({ force })` that calls `celGround.fit(bounds)` with the held `y`. `showAssembly`'s existing `placeGround` call site also calls `placeCelGround` when `renderMode === "cel"`; `enterCel` calls it; `holdGround`'s semantics are unchanged (the shadow map is live, so `growHeldShadow` has no cel twin).
- `enterCel`: lazily `celGround = createCelGround({ mapSize: isCoarsePointer() ? CEL.ground.mapSizeSmall : CEL.ground.mapSize })`; remember `renderer.shadowMap.enabled/type`, set `true` / `THREE.VSMShadowMap`, `plane.material.needsUpdate = true`, add light, target and plane to the scene. `enterCad` / `enterRealistic`: remove them and restore the shadow map settings (attempted like every other step).
- `renderWithBackdrop` in cel for the live scene: before the scene render, `celGround.setCasters(castersNow())`, `celGround.aim(cam, { azimuthDeg: CEL.light.azimuthDeg, elevationDeg: CEL.ground.elevationDeg })` (the spec's clamp lives in `aim`), and the moving / settled schedule: `celGround.setMapSize(small)` while `controls` report a camera move or a pose drag is in flight (`shadowMovedAt`-style timestamp set from the `controls` "change" event and from `setSubPose`), back to the full size `SHADOW_SETTLE_MS` after the last move; in `mountPreview`-created viewers (`frameSwept || framePoses`) stay small.
- A `transparent` viewer keeps the plane (decision 3).
- Captures: `renderOffscreen` renders through `renderWithBackdrop`, so the shadow is in them; nothing extra.

- [ ] **Step 4: Run the smoke checks and the suite**

Run: `node scripts/check-app.mjs demo.html && node scripts/check-app.mjs hinged-box.html && npm test`
Expected: PASS.

- [ ] **Step 5: Look at it**

`/robot-arm.html` in Cel: the shadow follows a pose drag and the `curl`-style animations on `/hinged-box.html` (play: the floor does not slide); the view cube's Top view keeps a compact shadow; no stripe, no faint square around the part; Bottom view shows no plane.

- [ ] **Step 6: Commit**

```bash
git add src/framework/viewer.js scripts/check-app.mjs
git commit -m "feat(cel): live VSM ground shadow, placed by the realistic floor rules"
```

---

### Task 6: Preview, types, docs, AGENTS, version, spike removal

**Files:**
- Modify: `src/framework/mount-preview.js:140-175` (`presentation`), `:277` (`applyState`), header comments 38–45 and 75–77
- Modify: `types/index.d.ts:369` (RenderMode), 371, 862–865, 907–908
- Modify: `docs/AUTHORING-PARTS.md` — "Materials and appearance" (after the sheet-stock table, before line 577) and the `runtime.renderMode` section (4344–4400)
- Modify: `AGENTS.md:248` region (a `src/framework/cel/` entry after the `materials/` one), `package.json` version
- Delete: `src/spike/`, `cel-demo.html`, `src/app-cel-demo.js`; the `__viewer` line in `src/framework/mount.js` `makeHandle` and the `__renderer` line in `src/framework/viewer.js`
- Test: `test/mount-preview-options.test.js` (new)

**Interfaces:**
- Produces: `export function validatePresentation(options)` from `mount-preview.js` (the existing `presentation`, renamed and exported; `mountPreview` calls it), returning `{ renderMode: "cad" | "realistic" | "cel" | null, transparent, contactShadow, … }`.

- [ ] **Step 1: Write the failing test**

`test/mount-preview-options.test.js`:
```js
import { describe, it, expect } from "vitest";
import { validatePresentation } from "../src/framework/mount-preview.js";

describe("mountPreview presentation options", () => {
  it("accepts the three render modes and rejects anything else", () => {
    expect(validatePresentation({ renderMode: "cel" }).renderMode).toBe("cel");
    expect(validatePresentation({}).renderMode).toBeNull();
    expect(() => validatePresentation({ renderMode: "celshaded" })).toThrow(TypeError);
  });
  it("allows a transparent background and contactShadow with cel (cel ignores contactShadow)", () => {
    const o = validatePresentation({ renderMode: "cel", background: "transparent", contactShadow: true });
    expect(o.transparent).toBe(true); expect(o.contactShadow).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/mount-preview-options.test.js`
Expected: FAIL — `validatePresentation` is not exported / `"cel"` throws.

- [ ] **Step 3: Implement the code changes**

`presentation` → `export function validatePresentation`, `oneOf("renderMode", renderMode, ["cad", "realistic", "cel"], null)`; `applyState` accepts `"cel"` (`["cad", "realistic", "cel"].includes(s.renderMode)`). Header comments: `background: "transparent"` is "CAD and cel modes", `contactShadow` "CAD mode only (cel draws its own ground shadow)", `renderMode` lists three. `types/index.d.ts`: `export type RenderMode = "cad" | "realistic" | "cel";` with the doc comment "the drafting view, physical materials under an environment, or the cel-shaded look"; update the `RenderModeEvent` comment (`busy` while realistic's assets load or cel's shaders compile), the `background` / `contactShadow` / `renderMode` option comments. Remove the two `// SPIKE` lines and `git rm -r src/spike cel-demo.html src/app-cel-demo.js`. `package.json` → `0.186.0`.

- [ ] **Step 4: Write the docs**

`docs/AUTHORING-PARTS.md`, "Materials and appearance": a paragraph **Cel shaded.** — the third tile in the View style popover; every sub-part drawn in flat bands of its effective `color` (or the material's colour; a sub-part with neither is drawn body-white `#eef1f4`, not CAD blue-grey), shadow tones derived automatically; presets' metalness, roughness, textures and finish overrides do not change it; `opacity` still ghosts; ink on silhouettes and creases plus the kernel's feature edges; a flat field with a soft ground shadow that follows a pose; nothing to author. The `runtime.renderMode` section: `mode` is `"cad"`, `"realistic"` or `"cel"`; `captureCurrent({ renderMode: "cel" })` always works (no assets); `renderViews(…, { renderMode: "cel" })`; the feature-lines sentence becomes "they draw whenever `runtime.renderMode` reads `"cad"` or `"cel"` and never while it reads `"realistic"`"; `viewerState.renderMode` carries all three. `AGENTS.md`: a bullet for `src/framework/cel/` naming the four modules, the pure/three split, the live-scene-only rule and that `cel-style.js` is three-free (`test/cel-layering.test.js`).

- [ ] **Step 5: Run everything**

Run: `npm test && node scripts/check-app.mjs demo.html && npm run check:softrender`
Expected: all green; `git status` shows no spike files.

- [ ] **Step 6: Commit**

```bash
git add -A src/framework/mount-preview.js src/framework/mount.js src/framework/viewer.js types/index.d.ts docs/AUTHORING-PARTS.md AGENTS.md package.json test/mount-preview-options.test.js src/spike cel-demo.html src/app-cel-demo.js
git commit -m "feat(cel): preview option, types, docs; remove the spike; 0.186.0"
```

---

### Task 7: Frame-time measurement

**Files:**
- Modify: `scripts/bench-pose.mjs` (a `--mode <cad|realistic|cel>` flag applied after the page loads: `await page.evaluate((m) => window.__pfRuntime.renderMode.set(m), mode)`, printed in the report header)

- [ ] **Step 1: Add the flag** (default `cad`, validated against the three values; unknown → exit 2 with a usage line).

- [ ] **Step 2: Measure**

Run: `npm run bench:pose -- --no-profile` and `npm run bench:pose -- --no-profile --mode cel`
Expected: the `idleOrbit` and `dragTip` scenarios on robot-arm report a mean frame `dt` in cel at most 2× CAD's. If over, lower `CEL.ground.mapSize` to 1024 and re-measure before anything else; record both numbers in the PR description.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench-pose.mjs
git commit -m "bench(pose): --mode flag to time a render mode"
```

---

### Task 8: Branch wrap-up

- [ ] **Step 1:** `npm test`, `node scripts/check-app.mjs demo.html`, `node scripts/check-app.mjs hinged-box.html`, `npm run check:softrender` — all green on the final tree.
- [ ] **Step 2:** `git diff main --stat` shows no `src/spike`, no `cel-demo.html`, the version bump, and the spec + plan.
- [ ] **Step 3:** Open the PR (brief, reader-friendly description per the user's PR style; note the cloud follow-up and the bench numbers), per `superpowers:finishing-a-development-branch`.
