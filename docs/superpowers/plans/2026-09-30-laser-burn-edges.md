# Laser-Cut Wood Burns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In realistic mode, a laser `sheetPart` in a wood shows charred cut edges and scorched engraving/score floors; a laser sheet part with no material takes its stock's look (`plywood` or `clear-acrylic`) instead of a PLA print; a new `plywood` preset ("Birch plywood") shows its plies under the char. CAD mode, exports and every non-sheet part are unchanged.

**Architecture:** A new three-free module, `src/framework/materials/sheet-look.js`, is the one statement of a sheet part's realistic look: who burns (`burnsFor`, static per sub-part), the canonical sheet frame computed from data (`sheetFrameFor` — `invertRigid(composePose(poseSteps(pose, t)))`, no probe), the burn's numbers (`BURN`) with JS twins for the tests, and the stock-label default (`realisticDisplay`). `patterns.js` gains `applyBurn`, a pass composed over the wood pass and compiled only into qualifying sub-parts. The viewer's lazy print-frame channel is generalized to carry sheet frames too (`setFrameSource` → `{ print, sheet }`), pulled only when the realistic look is drawn.

**Tech Stack:** Vanilla JS ES modules, three.js r184 (`onBeforeCompile` injection into `MeshPhysicalMaterial`), Manifold (tests), vitest + happy-dom, Playwright + sharp (the dev capture script).

**Spec:** `docs/superpowers/specs/2026-09-30-laser-burn-edges-design.md`

## Global Constraints

- Work only in `/Users/scottsykora/Documents/Docs/pixite/code/partforge/.claude/worktrees/laser-burn` (branch `claude/laser-burn-edges`).
- Node 24 for every command: prefix with `PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH` (shown as `$NODE24` below — expand it; the shell does not know it).
- Never run bare `git stash`; set work aside with a WIP commit. Never push, never `npm publish`, never tag.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- CAD mode and every non-qualifying program are unchanged: `buildCadMaterial`, `cadAppearance`, `printColor`, `declaresMaterials`, exports and the kit are not edited. The burn is realistic-only.
- No new author-facing names except the preset id `plywood`. `BURN`, `laminated`, `sheet.place`, `sheet.generatedPlace` are internal and never documented to authors.
- Tests must be machine-robust: no wall-clock or GPU pixel assertions in the suite. (`test/helpers/cpu-pace.js` exists if a timing limit is ever unavoidable — none is needed here.)
- Screenshots and scratch output go only to the directory the controller names in your brief (`$SHOTS` below) — never inside the repo, never committed.
- Test runner: `$NODE24 npx vitest run <file…>`; full suite `$NODE24 npm test`; lint `$NODE24 npm run lint`; types `$NODE24 npm run typecheck`. Run the full suite before every commit that touches `src/`.
- Comment style: match the surrounding files — say WHY, dense where the code is subtle.

---

### Task 1: The sheet frame, from data

Who burns, and the matrix that carries a delivered sheet mesh back into its canonical frame. Pure JS; nothing renders yet.

**Files:**
- Modify: `src/framework/sheet/part.js` (record `place` and `generatedPlace`)
- Modify: `types/part.d.ts` (`SheetDeclaration`)
- Create: `src/framework/materials/sheet-look.js`
- Test: `test/sheet-part.test.js` (add one test), create `test/framework/sheet-look.test.js`

**Interfaces:**
- Consumes: `isSheetPart`, `sheetMeta`, `MARK_DEPTH` (`src/framework/sheet/constants.js`); `poseSteps(pose, t)`, `validatePose(pose)` (`src/framework/sheet/pose.js`); `composePose(steps)`, `invertRigid(m)`, `transformPositions(positions, m)` (`src/framework/geometry/pose.js`); `resolveMaterial(display)` (`src/framework/materials/resolve.js`); `buildPosed`, `resolveParams` (`src/framework/part-model.js`); `bootManifoldKernel` (`src/testing.js`).
- Produces:
  - `sheetPart(spec).sheet.place: Function | null` — the author's own `place`, or `null`.
  - `sheetPart(spec).sheet.generatedPlace: Function | null` — what sheetPart installed as `sub.place`, or `null`.
  - `BURN: { wallNz: [0.35, 0.65], floorDepth: 0.1 }` (frozen; Task 2 adds colour keys).
  - `plyCount(t: number): number` — `< 4.5 → 3`, `< 7.5 → 5`, `< 10.5 → 7`, else `9`.
  - `burnsFor(sp): boolean`
  - `sheetFrameFor(sp, { p, d }): { frame: number[16], t: number, plies: number } | null`
  - `classifySheetSurface(pos: [x, y, z], normal: [x, y, z], t: number): "wall" | "face" | "back" | "floor"`

- [ ] **Step 1: Write the failing record test**

In `test/sheet-part.test.js`, inside `describe("an ordinary sub-part with a plain-data marker", …)`, after the `"passthrough keys, a generated build, place only when needed"` test, add:

```js
  // The realistic look (materials/sheet-look.js) trusts a sheet's canonical frame only
  // when it sits exactly on its pose: no author place, and sheetPart's own place still
  // installed. So the record names both, the way generatedBuild names the build.
  test("the record names the author's place and the place sheetPart installed", () => {
    const own = (s) => s.translate([0, 0, 5]);
    const posed = sheetPart(panelSpec());
    expect(posed.sheet.place).toBeNull();
    expect(posed.sheet.generatedPlace).toBe(posed.place);
    const placed = sheetPart(panelSpec({ place: own }));
    expect(placed.sheet.place).toBe(own);
    expect(placed.sheet.generatedPlace).toBe(placed.place);
    const flat = sheetPart(panelSpec({ pose: undefined }));
    expect(flat.sheet.place).toBeNull();
    expect(flat.sheet.generatedPlace).toBeNull();
    expect("place" in flat).toBe(false);
  });
```

- [ ] **Step 2: Write the failing frame tests**

Create `test/framework/sheet-look.test.js`:

```js
// A laser sheet part's canonical frame, from data (materials/sheet-look.js): the matrix
// that carries its DELIVERED display mesh back into the frame it was drawn in — profile in
// XY, material over z ∈ [0, t], laser face at z = t — which the burn pass classifies
// surfaces in. Held against real geometry: every laser-box panel is built posed (as the
// viewer receives it) and flat (sheetPart's own build), and the frame must land the one
// exactly on the other.
import { beforeAll, describe, expect, test } from "vitest";
import laserBox from "../../src/parts/laser-box.js";
import { bootManifoldKernel } from "../../src/testing.js";
import { buildPosed, resolveParams } from "../../src/framework/part-model.js";
import { sheetPart } from "../../src/framework/sheet/part.js";
import { MARK_DEPTH } from "../../src/framework/sheet/constants.js";
import { poseSteps } from "../../src/framework/sheet/pose.js";
import { composePose, invertRigid, transformPositions } from "../../src/framework/geometry/pose.js";
import { BURN, burnsFor, classifySheetSurface, plyCount, sheetFrameFor } from "../../src/framework/materials/sheet-look.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SHEETS = ["bottom", "left", "right", "front", "back", "lid"];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const P = { p: {}, d: {} };

// Class histogram of a mesh after `frame`: walls by count, caps by class AND height (to
// 0.001 mm), so a frame that lands a panel anywhere but on its canonical self fails.
function histogram(solid, frame, t) {
  const pos = Float64Array.from(solid.toMesh().positions);
  transformPositions(pos, frame);
  const h = {};
  for (let i = 0; i < pos.length; i += 9) {
    const u = [pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]];
    const v = [pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;                                  // a boolean's sliver
    const z = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
    const cls = classifySheetSurface([0, 0, z], n.map((c) => c / len), t);
    const key = cls === "wall" ? "wall" : `${cls}@${Math.round(z * 1000) / 1000 + 0}`;
    h[key] = (h[key] ?? 0) + 1;
  }
  return h;
}

describe("every laser-box panel's frame lands its display mesh on its canonical solid", () => {
  test.each(SHEETS)("%s", (name) => {
    const { p, d } = resolveParams(laserBox, {});
    const sp = laserBox.parts[name];
    const f = sheetFrameFor(sp, { p, d });
    expect(f).not.toBeNull();
    expect(f.t).toBe(p.t);
    const posed = buildPosed(k, laserBox, name, { purpose: "display", view: "box", p, d });
    const got = histogram(posed, f.frame, p.t);
    expect(got).toEqual(histogram(sp.build(k, p, d), IDENTITY, p.t));   // sheetPart's own build IS canonical
    expect(got[`face@${p.t}`]).toBeGreaterThan(0);
    expect(got["back@0"]).toBeGreaterThan(0);
    expect(got.wall).toBeGreaterThan(0);
  });

  test("the front panel's frame is the inverse of its pose, and its label and score are floors", () => {
    const { p, d } = resolveParams(laserBox, {});
    const f = sheetFrameFor(laserBox.parts.front, { p, d });
    expect(f.frame).toEqual(invertRigid(composePose(poseSteps(d.box.front.pose, p.t))));
    const h = histogram(buildPosed(k, laserBox, "front", { purpose: "display", view: "box", p, d }), f.frame, p.t);
    expect(h[`floor@${Math.round((p.t - MARK_DEPTH) * 1000) / 1000}`]).toBeGreaterThan(0);
  });

  test("a thickness change moves the frame with the laser face", () => {
    const at = (t) => { const { p, d } = resolveParams(laserBox, { t }); return sheetFrameFor(laserBox.parts.front, { p, d }); };
    expect(at(6).t).toBe(6);
    expect(at(6).frame).not.toEqual(at(3).frame);
  });
});

const panel = (extra = {}) => sheetPart({
  label: "Panel", views: ["main"], display: { material: "oak" }, material: "birch plywood", thickness: 3,
  profile: (kk) => kk.shape2d(rect(0, 0, 40, 30)), ...extra,
});

describe("who burns: a laser sheet in a wood, on its own build and pose", () => {
  test("a flat oak sheet burns with the identity frame and no plies", () => {
    const sp = panel();
    expect(burnsFor(sp)).toBe(true);
    expect(sheetFrameFor(sp, P)).toEqual({ frame: IDENTITY, t: 3, plies: 0 });
  });

  test("walnut burns; acrylic, PLA and a non-sheet oak part do not", () => {
    expect(burnsFor(panel({ display: { material: "walnut" } }))).toBe(true);
    expect(burnsFor(panel({ display: { material: "clear-acrylic" } }))).toBe(false);
    expect(burnsFor(panel({ display: { material: "pla-print" } }))).toBe(false);
    expect(burnsFor({ views: ["main"], build: () => null, display: { material: "oak" } })).toBe(false);
    expect(sheetFrameFor(panel({ display: { material: "clear-acrylic" } }), P)).toBeNull();
  });

  // The frame is only exact while the delivered mesh is the canonical solid carried by the
  // pose. Anything else draws plain wood rather than a frame that could char a face.
  test("a custom build, an author place (mirrored or not) and a replaced place show plain wood", () => {
    const sp = panel();
    expect(burnsFor({ ...sp, build: (kk) => kk.box({ size: [40, 30, 3] }) })).toBe(false);
    expect(burnsFor(panel({ place: (s) => s.translate([0, 0, 5]) }))).toBe(false);
    expect(burnsFor(panel({ place: (s) => s.mirror("YZ") }))).toBe(false);
    expect(burnsFor({ ...sp, place: (s) => s })).toBe(false);
    expect(sheetFrameFor({ ...sp, place: (s) => s }, P)).toBeNull();
  });

  test("a hand-written sheet declaration never gets a frame", () => {
    const sp = panel();
    expect(burnsFor({ views: ["main"], build: sp.build, display: { material: "oak" }, sheet: { ...sp.sheet, generatedBuild: undefined } })).toBe(false);
  });

  test("a pose or thickness that cannot be read gives no frame; a null pose is flat", () => {
    const throwing = panel({ pose: () => { throw new Error("boom"); } });
    expect(burnsFor(throwing)).toBe(true);
    expect(sheetFrameFor(throwing, P)).toBeNull();
    expect(sheetFrameFor(panel({ pose: () => null }), P).frame).toEqual(IDENTITY);
    expect(sheetFrameFor(panel({ thickness: () => Number.NaN }), P)).toBeNull();
  });
});

test("plies: 3 mm → 3, 6 → 5, 9 → 7, 12 → 9", () => {
  expect([0.5, 3, 4.4, 4.5, 6, 7.5, 9, 10.5, 12].map(plyCount)).toEqual([3, 3, 3, 5, 5, 7, 7, 9, 9]);
});

test("classifySheetSurface: walls by the normal, floors by depth under the laser face", () => {
  expect(BURN.floorDepth).toBe(MARK_DEPTH / 2);
  expect(classifySheetSurface([0, 0, 1.5], [1, 0, 0], 3)).toBe("wall");
  expect(classifySheetSurface([0, 0, 1.5], [0.9, 0, 0.4], 3)).toBe("wall");      // |n.z| below the band's middle (0.5)
  expect(classifySheetSurface([0, 0, 3], [0.8, 0, 0.6], 3)).toBe("face");        // above it: a cap
  expect(classifySheetSurface([0, 0, 3], [0, 0, 1], 3)).toBe("face");
  expect(classifySheetSurface([0, 0, 3 - MARK_DEPTH], [0, 0, 1], 3)).toBe("floor");
  expect(classifySheetSurface([0, 0, 0], [0, 0, -1], 3)).toBe("back");
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `$NODE24 npx vitest run test/sheet-part.test.js test/framework/sheet-look.test.js`
Expected: FAIL — `sheet.generatedPlace` is undefined; `sheet-look.js` does not exist.

- [ ] **Step 4: Record `place` and `generatedPlace` in `sheetPart`**

In `src/framework/sheet/part.js`, extend the header paragraph that ends "…is detectable as `sp.build !== sp.sheet.generatedBuild`." with:

```js
// Likewise `sp.sheet.generatedPlace` is the place made here (the pose, then the author's
// own) and `sp.sheet.place` the author's own place, or null: the realistic look
// (materials/sheet-look.js) trusts a sheet's canonical frame only with no author place
// and `sp.place === sp.sheet.generatedPlace`.
```

Replace the body of `sheetPart` from `const generatedBuild = …` to `return sub;` with:

```js
  const generatedBuild = (k, p, d) => {
    const s = resolveSheet(k, sub, p, d);
    return (processById(s.process).preview ?? sheetPreview)(k, s);
  };

  // Placement (decision 10): the pose applies for display AND export, then the author's own
  // place. Made BEFORE the record is frozen, so the record can name it.
  const pose = spec.pose ?? null;
  const authorPlace = spec.place ?? null;
  const generatedPlace = pose !== null || authorPlace ? (solid, ctx) => {
    const resolved = typeof pose === "function" ? pose(ctx.p, ctx.d) : pose;
    let posed = solid;
    if (resolved !== null) {
      const reason = validatePose(resolved);
      if (reason) throw new Error(`sheet pose: ${reason}`);
      const t = typeof spec.thickness === "function" ? spec.thickness(ctx.p, ctx.d) : spec.thickness;
      posed = applyPose(solid, resolved, t);
    }
    return authorPlace ? authorPlace(posed, ctx) : posed;
  } : null;

  const sheet = Object.freeze({
    process,
    material: spec.material,
    thickness: spec.thickness,
    profile: spec.profile,
    score: spec.score ?? null,
    engrave: spec.engrave ?? null,
    pose,
    place: authorPlace,
    generatedBuild,
    generatedPlace,
  });
  sub.build = generatedBuild;
  if (generatedPlace) sub.place = generatedPlace;
  sub.sheet = sheet;
  return sub;
```

(`Object.keys(sub)` keeps its order — `…, build, place, sheet` — which `test/sheet-part.test.js` pins.)

- [ ] **Step 5: Create `src/framework/materials/sheet-look.js`**

```js
// src/framework/materials/sheet-look.js
// How a laser-cut sheet part looks in realistic mode — plain data and pure math, three-free
// and DOM-free like resolve.js, so the viewer, mount, lint and the tests all read ONE
// statement of it. patterns.js turns it into GLSL; nothing here knows about three.
//
// A laser sheetPart in a wood shows its burns: charred cut walls, scorched engrave and
// score floors, faces untouched. The shader tells those surfaces apart in the sheet's
// CANONICAL frame — profile in XY, material over z ∈ [0, t], laser face at z = t — but the
// viewer holds the DELIVERED display mesh. With no author `place`, sheetPart's generated
// place is exactly the rigid steps poseSteps(pose, t) (and there is no place at all with no
// pose), so the delivered mesh is that motion applied to the canonical solid and the frame
// is its inverse: computed from data, with no pose probe and no geometry. A sheet with an
// author place, a replaced place or a custom build is not trusted with a frame — it draws
// plain wood, never a frame that could char a face.
import { isSheetPart, sheetMeta, MARK_DEPTH } from "../sheet/constants.js";
import { poseSteps, validatePose } from "../sheet/pose.js";
import { composePose, invertRigid } from "../geometry/pose.js";
import { resolveMaterial } from "./resolve.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// The burn's numbers, ONE statement: patterns.js templates the GLSL from them, and the JS
// twins below (classifySheetSurface, and Task 2's burnAlbedo) read the same object.
//   wallNz      a surface whose canonical |n.z| is below this band is a cut wall (the
//               shader blends across the band; the JS twin splits at its middle). Creased
//               normals are hard at a sheet's 90° arris, so real walls sit at n.z = 0.
//   floorDepth  an up-facing surface at least this far below the laser face is an engrave
//               or score floor: half the preview's MARK_DEPTH, so the laser face (z = t) is
//               never one and a mark's floor (z = t − MARK_DEPTH) always is.
export const BURN = Object.freeze({
  wallNz: Object.freeze([0.35, 0.65]),
  floorDepth: MARK_DEPTH / 2,
});

// Plies in a birch-plywood sheet t mm thick: 3 mm → 3, 6 → 5, 9 → 7, 12 → 9. Always odd, so
// both outer plies run with the face grain.
const PLY_STEPS = Object.freeze([[4.5, 3], [7.5, 5], [10.5, 7]]);
export function plyCount(t) {
  for (const [below, plies] of PLY_STEPS) if (t < below) return plies;
  return 9;
}

// The material realistic mode draws this sub-part in.
const lookOf = (sp) => resolveMaterial(sp.display);

// Does this sub-part carry the burn pass at all? Static — it reads no params — so the
// viewer decides a sub-part's PROGRAM once, and every sub-part that answers false keeps
// exactly the program it had before the burn existed.
export function burnsFor(sp) {
  if (!isSheetPart(sp) || sp.sheet.process !== "laser") return false;
  if (sp.build !== sp.sheet.generatedBuild) return false;                   // a custom build is not the canonical sheet
  if (sp.sheet.place != null) return false;                                 // an author place moves it off its pose
  if ((sp.place ?? null) !== (sp.sheet.generatedPlace ?? null)) return false; // place replaced after sheetPart
  try { return lookOf(sp).params.pattern === "wood"; } catch { return false; }
}

// At (p, d) — a delivery's params — the frame that maps the delivered display mesh's
// object space into the canonical sheet frame, the sheet's thickness, and how many plies
// its cut walls show (0 unless its preset is `laminated`). null when burnsFor says no or
// the pose or thickness cannot be read (the build reports those).
export function sheetFrameFor(sp, { p, d } = {}) {
  if (!burnsFor(sp)) return null;
  const meta = sheetMeta(sp, p, d);
  if (!meta) return null;
  const t = meta.thickness;
  let pose;
  try { pose = typeof sp.sheet.pose === "function" ? sp.sheet.pose(p, d) : sp.sheet.pose; } catch { return null; }
  if (pose != null && validatePose(pose)) return null;
  const frame = pose == null ? [...IDENTITY] : invertRigid(composePose(poseSteps(pose, t)));
  return { frame, t, plies: lookOf(sp).preset.laminated ? plyCount(t) : 0 };
}

// The shader's surface classification, in JS: the frame tests hold real geometry to it.
// `pos` and `normal` are canonical (after the frame); `t` is the thickness.
export function classifySheetSurface(pos, normal, t) {
  if (Math.abs(normal[2]) < (BURN.wallNz[0] + BURN.wallNz[1]) / 2) return "wall";
  if (normal[2] < 0) return "back";
  return pos[2] <= t - BURN.floorDepth ? "floor" : "face";
}
```

- [ ] **Step 6: Declare the two fields**

In `types/part.d.ts`, inside `interface SheetDeclaration`, after the `generatedBuild` member:

```ts
  /** The author's own `place` (the spec's), run after the pose; `null` when there is none. */
  place: ((solid: Solid, ctx: PlaceContext<P, D>) => Solid) | null;
  /** The `place` `sheetPart` installed (the pose, then the author's own), or `null`; `sub.place !== sub.sheet.generatedPlace` is a replaced place. */
  generatedPlace: ((solid: Solid, ctx: PlaceContext<P, D>) => Solid) | null;
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `$NODE24 npx vitest run test/sheet-part.test.js test/framework/sheet-look.test.js test/laser-box.test.js test/lint-sheet.test.js test/sheet-layering.test.js test/lint-purity.test.js`
Expected: PASS.

Then `$NODE24 npm run typecheck && $NODE24 npm run lint && $NODE24 npm test` — all green.

- [ ] **Step 8: Commit**

```bash
git add src/framework/sheet/part.js types/part.d.ts src/framework/materials/sheet-look.js test/sheet-part.test.js test/framework/sheet-look.test.js
git commit -m "Laser sheets: a canonical sheet frame from data, and who qualifies for burns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The burn pass

The shader: classification, char relative to the face, the exit gradient, ply bands, roughness, the normal fade and clearcoat — compiled only when asked for. Plus the calibration gate.

**Files:**
- Modify: `src/framework/materials/sheet-look.js` (colour keys in `BURN`, `srgbToLinear`, `burnAlbedo`)
- Modify: `src/framework/materials/patterns.js` (`applyBurn`)
- Modify: `src/framework/materials/physical.js` (`burn` option)
- Test: `test/framework/sheet-look.test.js`, `test/framework/materials-patterns.test.js`, `test/framework/materials-physical.test.js`

**Interfaces:**
- Consumes: `BURN` (Task 1); `applyPattern`, `applyBrushFrame` (`patterns.js`); `THREE.ShaderLib.physical` (tests).
- Produces:
  - `BURN` gains `charcoal: 0x262220, kThin: 0.55, kThick: 0.85, tThin: 3, tThick: 9, exit: 0.1, engraveLess: 0.1, charOfDark: 0.5, roughness: 0.85, crossPly: 0.78`.
  - `srgbToLinear(hex: number): [number, number, number]`
  - `burnAlbedo(face: number[3], t: number, { kind?: "edge" | "engrave", zFrac?: number }): number[3]` — linear RGB.
  - `applyBurn(material, { faceAvg: number }): material` — adds uniforms `pfSheetFrame` (Matrix4, identity), `pfSheetT` (0), `pfPlies` (0), `pfFaceAvg` (Color) to `material.userData.patternUniforms`; cache key `${previous}|pf-burn`; no-op unless the wood pass ran.
  - `buildPhysicalMaterial(display, { printFrame, loadTexture, burn })` — `burn: true` applies `applyBurn` (before the brush frame).

- [ ] **Step 1: Write the failing calibration tests**

Append to `test/framework/sheet-look.test.js` (add `burnAlbedo, srgbToLinear` to the `sheet-look.js` import, and `import { PRESETS } from "../../src/framework/materials/presets.js";`):

```js
// "Clearly visible" is judged the only way that cannot be fooled by lighting: the SAME
// pixel with the burn on and off. At the albedo level the two differ only by the burn (the
// diffuse lighting multiplies both alike), so each wood's char is held to a floor at 3 mm —
// the laser box's default, the thin end of the ramp — at the lightest point of a wall (the
// laser-face end, zFrac 1). Never wall against face: studio light darkens walls anyway.
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function lab(rgb) {
  const [r, g, b] = rgb;
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = luma(rgb), z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (q) => (q > 216 / 24389 ? Math.cbrt(q) : (24389 / 27 * q + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const dE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const WOODS = ["oak", "walnut"];

describe("the burn is clearly visible: the same pixel, burn on vs off", () => {
  test.each(WOODS)("%s at 3 mm", (id) => {
    const face = srgbToLinear(PRESETS[id].color);          // the unburnt pixel's albedo: the texture's average
    const edge = burnAlbedo(face, 3);
    const mark = burnAlbedo(face, 3, { kind: "engrave" });
    expect(dE(face, edge)).toBeGreaterThanOrEqual(12);
    expect(luma(edge)).toBeLessThanOrEqual(0.7 * luma(face));
    expect(dE(face, mark)).toBeGreaterThanOrEqual(10);
    expect(luma(mark)).toBeLessThanOrEqual(0.8 * luma(face));
  });

  test("thicker stock chars darker, and the exit side darker than the laser face", () => {
    const face = srgbToLinear(PRESETS.oak.color);
    const at = (t, zFrac = 1) => luma(burnAlbedo(face, t, { zFrac }));
    expect(at(9)).toBeLessThan(at(6));
    expect(at(6)).toBeLessThan(at(3));
    expect(at(3, 0)).toBeLessThan(at(3, 1));
  });

  test("char is darker than its own face under any tint, and never below its floor", () => {
    for (const hex of [0x202020, 0x101010, 0x3a1c10]) {
      const face = srgbToLinear(hex);
      expect(luma(burnAlbedo(face, 3)), hex.toString(16)).toBeLessThan(luma(face));
    }
    const oak = srgbToLinear(PRESETS.oak.color);
    expect(luma(burnAlbedo(oak, 12, { zFrac: 0 }))).toBeGreaterThanOrEqual(luma(srgbToLinear(BURN.charcoal)) - 1e-12);
  });
});
```

- [ ] **Step 2: Write the failing shader tests**

Append to `test/framework/materials-patterns.test.js` (add `applyBurn` to the `patterns.js` import):

```js
// The burn pass (patterns.js applyBurn), against three's REAL meshphysical source — the
// three-line fakeShader cannot show where each snippet lands relative to the chunks.
const physicalShader = () => ({
  uniforms: {},
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
});
const compiled = (m) => { const s = physicalShader(); m.onBeforeCompile(s); return s; };
const woodTextures = () => new THREE.Texture();
// The shader's lines with every `// pf-burn {` … `// } pf-burn` block taken out,
// indentation ignored (a snippet inserted before an indented #include takes its tab).
const outsideBurn = (src) => {
  const out = [];
  let inside = false;
  for (const line of src.split("\n").map((l) => l.trim())) {
    if (line === "// pf-burn {") inside = true;
    else if (line === "// } pf-burn") inside = false;
    else if (!inside) out.push(line);
  }
  return out;
};

test("the burn pass lands in three's meshphysical order: after wood, before normals, lights and clearcoat", () => {
  const f = compiled(buildPhysicalMaterial({ material: "walnut" }, { loadTexture: woodTextures, burn: true })).fragmentShader;
  const at = (s) => { const i = f.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
  // (a) colour + roughness: after wood's body and metalness, before the normals begin
  expect(at("diffuseColor.rgb *= pfTriplanarWood(pfPatternMap")).toBeLessThan(at("float pfBurnWall = 0.0;"));
  expect(at("#include <metalnessmap_fragment>")).toBeLessThan(at("float pfBurnWall = 0.0;"));
  expect(at("pfBurnWall = 1.0 - smoothstep")).toBeLessThan(at("#include <normal_fragment_begin>"));
  // (b) the normal fade: after wood's normal map and the clearcoat normals, before emissive
  const fade = at("normal = normalize(mix(normal, nonPerturbedNormal, max(pfBurnWall, pfBurnFloor)));");
  expect(at("normal = normalize(mat3(vPfNmX, vPfNmY, vPfNmZ) * pfObjN)")).toBeLessThan(fade);
  expect(at("#include <clearcoat_normal_fragment_maps>")).toBeLessThan(fade);
  expect(fade).toBeLessThan(at("#include <emissivemap_fragment>"));
  // (c) clearcoat off the char: after lights_physical assigns it, before the lights use it
  const coat = at("material.clearcoat *= 1.0 - max(pfBurnWall, pfBurnFloor);");
  expect(at("#include <lights_physical_fragment>")).toBeLessThan(coat);
  expect(coat).toBeLessThan(at("#include <lights_fragment_begin>"));
});

test("a burning program is the plain wood program plus its pf-burn blocks and nothing else", () => {
  for (const material of ["oak", "walnut"]) {
    const plain = compiled(buildPhysicalMaterial({ material }, { loadTexture: woodTextures }));
    const burned = compiled(buildPhysicalMaterial({ material }, { loadTexture: woodTextures, burn: true }));
    expect(burned.vertexShader, material).toBe(plain.vertexShader);
    expect(outsideBurn(burned.fragmentShader), material).toEqual(plain.fragmentShader.split("\n").map((l) => l.trim()));
    expect(plain.fragmentShader, material).not.toContain("pfBurn");
  }
});

test("the burn uniforms ride the shared pattern uniforms, off until a frame arrives", () => {
  const m = buildPhysicalMaterial({ material: "oak" }, { loadTexture: woodTextures, burn: true });
  const u = m.userData.patternUniforms;
  expect(u.pfSheetFrame.value).toBeInstanceOf(THREE.Matrix4);
  expect(u.pfSheetFrame.value.equals(new THREE.Matrix4())).toBe(true);
  expect(u.pfSheetT.value).toBe(0);
  expect(u.pfPlies.value).toBe(0);
  const s = compiled(m);
  for (const name of ["pfSheetFrame", "pfSheetT", "pfPlies", "pfFaceAvg"]) expect(s.uniforms[name], name).toBe(u[name]);
});

test("the burn is a no-op on anything but wood", () => {
  const carbon = applyPattern(new THREE.MeshPhysicalMaterial(), { kind: "carbon", scale: 10, texture: new THREE.Texture() });
  const key = carbon.customProgramCacheKey();
  applyBurn(carbon, { faceAvg: 0x1b1c1e });
  expect(carbon.customProgramCacheKey()).toBe(key);
  expect(carbon.userData.patternUniforms.pfSheetT).toBeUndefined();
  const bare = new THREE.MeshPhysicalMaterial();
  expect(applyBurn(bare, { faceAvg: 0 })).toBe(bare);
  expect(Object.hasOwn(bare, "onBeforeCompile")).toBe(false);
});
```

Append to `test/framework/materials-physical.test.js` (add `import { srgbToLinear } from "../../src/framework/materials/sheet-look.js";`):

```js
// `burn` is the viewer's per-sub-part decision (sheet-look.js burnsFor). It adds the pass
// to a wood and nothing else; the brush frame (an author's anisotropy override) composes on top.
test("burn: true adds the burn pass to a wood, keyed apart from plain wood", () => {
  expect(buildPhysicalMaterial({ material: "oak" }, { loadTexture }).customProgramCacheKey()).toBe("pf-pattern:wood");
  const m = buildPhysicalMaterial({ material: "oak" }, { loadTexture, burn: true });
  expect(m.customProgramCacheKey()).toBe("pf-pattern:wood|pf-burn");
  const avg = m.userData.patternUniforms.pfFaceAvg.value.toArray();
  srgbToLinear(0xa17e57).forEach((c, i) => expect(avg[i]).toBeCloseTo(c, 6));   // the preset's own colour, never a tint
  expect(buildPhysicalMaterial({ material: "oak", anisotropy: 0.5 }, { loadTexture, burn: true }).customProgramCacheKey())
    .toBe("pf-pattern:wood|pf-burn|pf-brush");
  expect(buildPhysicalMaterial({ material: "brass" }, { loadTexture, burn: true }).customProgramCacheKey()).not.toContain("pf-burn");
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `$NODE24 npx vitest run test/framework/sheet-look.test.js test/framework/materials-patterns.test.js test/framework/materials-physical.test.js`
Expected: FAIL — `burnAlbedo`, `srgbToLinear` and `applyBurn` are not exported; `burn` is ignored.

- [ ] **Step 4: The colour numbers and their JS twin**

In `src/framework/materials/sheet-look.js`, replace the `BURN` block (comment and object) with:

```js
// The burn's numbers, ONE statement: patterns.js templates the GLSL from them, and the JS
// twins below (classifySheetSurface, burnAlbedo) read the same object.
//   wallNz      a surface whose canonical |n.z| is below this band is a cut wall (the
//               shader blends across the band; the JS twin splits at its middle). Creased
//               normals are hard at a sheet's 90° arris, so real walls sit at n.z = 0.
//   floorDepth  an up-facing surface at least this far below the laser face is an engrave
//               or score floor: half the preview's MARK_DEPTH, so the laser face (z = t) is
//               never one and a mark's floor (z = t − MARK_DEPTH) always is.
// Char is RELATIVE to the face, all in linear RGB: a cut wall is the face's average colour
// mixed toward `charcoal` by k — kThin at ≤ tThin mm, kThick at ≥ tThick (thick stock takes
// a longer dwell) — plus up to `exit` more toward the exit side (z = 0); an engrave or score
// floor by `engraveLess` less. Under a face darker than twice charcoal's luminance, charcoal
// is scaled down to `charOfDark` of the face's own luminance, so char is never LIGHTER than
// its face (a dark tint). Char and scorched floors take `roughness`; on plywood's cut walls a
// cross ply is `crossPly` of a face-grain ply. The colours are starting points from the
// research, tuned by eye on the contact sheet — within the calibration floors that
// test/framework/sheet-look.test.js holds them to.
export const BURN = Object.freeze({
  wallNz: Object.freeze([0.35, 0.65]),
  floorDepth: MARK_DEPTH / 2,
  charcoal: 0x262220,
  kThin: 0.55,
  kThick: 0.85,
  tThin: 3,
  tThick: 9,
  exit: 0.1,
  engraveLess: 0.1,
  charOfDark: 0.5,
  roughness: 0.85,
  crossPly: 0.78,
});

// sRGB 0xRRGGBB → linear [r, g, b]: the conversion three applies to a colour uniform.
export function srgbToLinear(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}
```

Append at the end of the file:

```js
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// The shader's burnt albedo, in JS (the calibration test's twin — same numbers, same
// formula): `face` is the unburnt face's average colour in linear RGB (the preset's texture
// average times any tint), `t` the sheet thickness (mm), `kind` "edge" — a cut wall, `zFrac`
// of the way from the exit side (0) up to the laser face (1) — or "engrave", a mark's floor.
// Ply bands are left out: they only modulate an edge.
export function burnAlbedo(face, t, { kind = "edge", zFrac = 1 } = {}) {
  const charcoal = srgbToLinear(BURN.charcoal);
  const scale = Math.min(1, (BURN.charOfDark * luma(face)) / luma(charcoal));
  const k = BURN.kThin + (BURN.kThick - BURN.kThin) * clamp01((t - BURN.tThin) / (BURN.tThick - BURN.tThin));
  const amount = kind === "engrave" ? k - BURN.engraveLess : Math.min(1, k + BURN.exit * (1 - clamp01(zFrac)));
  return face.map((f, i) => f + (charcoal[i] * scale - f) * amount);
}
```

- [ ] **Step 5: `applyBurn` in `patterns.js`**

Add `import { BURN, srgbToLinear } from "./sheet-look.js";` after the `three` import, and extend the file's header comment with one line: "A laser-cut wood sheet's burn (applyBurn) composes over the wood pass in the sheet's canonical frame (sheet-look.js)." Then append at the end of the file:

```js
// --- laser burns ------------------------------------------------------------------
// A laser-cut sheet in a wood shows what the laser did to it (sheet-look.js decides which
// sub-parts, and mount hands the viewer each one's canonical frame): cut walls charred,
// engrave and score floors scorched, faces untouched. Composes over the wood pass the way
// applyBrushFrame does, injecting at three points in three's meshphysical order:
//   (a) colour + roughness, before <normal_fragment_begin>: after wood's body (injected
//       after <roughnessmap_fragment>) and <metalnessmap_fragment>. A second replace of
//       <roughnessmap_fragment> would land IN FRONT of wood's body, so it is not reused.
//       pfBurnWall / pfBurnFloor are declared at main() scope, like pfLayer, for (b), (c).
//   (b) the normal, before <emissivemap_fragment>: after wood's normal map and the
//       clearcoat normals. Char has no grain, so the wood normal fades back to the
//       geometric one (nonPerturbedNormal, set by <normal_fragment_begin>).
//   (c) clearcoat, after <lights_physical_fragment>, which assigns material.clearcoat:
//       walnut's lacquer comes off the char.
// Every snippet sits between `// pf-burn {` and `// } pf-burn` lines: that is how the tests
// prove a burning program is the plain wood program plus these and nothing else. The
// vertex stage is untouched — the pass reads the varyings every pattern already has. With
// pfSheetT = 0 (no frame delivered yet) it draws plain wood. No noise term: an unfiltered
// striation would shimmer at part scale (the layer-lines lesson above).
const glf = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const CHARCOAL = srgbToLinear(BURN.charcoal);
const CHARCOAL_Y = 0.2126 * CHARCOAL[0] + 0.7152 * CHARCOAL[1] + 0.0722 * CHARCOAL[2];
const burnBlock = (glsl) => `// pf-burn {\n${glsl}\n// } pf-burn`;

const BURN_FRAG_DECL = burnBlock(`uniform mat4 pfSheetFrame;
uniform float pfSheetT;
uniform float pfPlies;
uniform vec3 pfFaceAvg;
// 1 on a cross ply (an odd one), 0 on a face-grain ply: the square wave box-filtered over
// the pixel (its integral, differenced across fwidth), so plies too thin to draw average
// out instead of shimmering.
float pfCrossPlyI(float x) { return floor(x * 0.5) + max(0.0, fract(x * 0.5) * 2.0 - 1.0); }
float pfCrossPly(float x) {
  float w = max(fwidth(x), 1e-4);
  return (pfCrossPlyI(x + 0.5 * w) - pfCrossPlyI(x - 0.5 * w)) / w;
}`);

const BURN_FRAG_BODY = burnBlock(`float pfBurnWall = 0.0;
float pfBurnFloor = 0.0;
if (pfSheetT > 0.0) {
  vec3 pfC = (pfSheetFrame * vec4(vPfObjPos, 1.0)).xyz;
  vec3 pfCn = normalize(mat3(pfSheetFrame) * vPfObjNormal);
  pfBurnWall = 1.0 - smoothstep(${glf(BURN.wallNz[0])}, ${glf(BURN.wallNz[1])}, abs(pfCn.z));
  pfBurnFloor = step(0.5, pfCn.z) * step(pfC.z, pfSheetT - ${glf(BURN.floorDepth)});
  float pfK = mix(${glf(BURN.kThin)}, ${glf(BURN.kThick)}, clamp((pfSheetT - ${glf(BURN.tThin)}) / ${glf(BURN.tThick - BURN.tThin)}, 0.0, 1.0));
  float pfZ = clamp(pfC.z / pfSheetT, 0.0, 1.0);
  vec3 pfFace = diffuse * pfFaceAvg;
  vec3 pfChar = vec3(${CHARCOAL.map((c) => c.toFixed(6)).join(", ")}) * min(1.0, ${glf(BURN.charOfDark)} * dot(pfFace, vec3(0.2126, 0.7152, 0.0722)) / ${CHARCOAL_Y.toFixed(6)});
  vec3 pfEdge = mix(pfFace, pfChar, min(1.0, pfK + ${glf(BURN.exit)} * (1.0 - pfZ)));
  if (pfPlies > 0.0) pfEdge *= mix(1.0, ${glf(BURN.crossPly)}, pfCrossPly(pfZ * pfPlies));
  vec3 pfMark = mix(pfFace, pfChar, pfK - ${glf(BURN.engraveLess)});
  diffuseColor.rgb = mix(diffuseColor.rgb, pfEdge, pfBurnWall);
  diffuseColor.rgb = mix(diffuseColor.rgb, pfMark, pfBurnFloor);
  roughnessFactor = mix(roughnessFactor, ${glf(BURN.roughness)}, max(pfBurnWall, pfBurnFloor));
}`);

const BURN_FRAG_NORMAL = burnBlock("normal = normalize(mix(normal, nonPerturbedNormal, max(pfBurnWall, pfBurnFloor)));");

const BURN_FRAG_CLEARCOAT = burnBlock(`#ifdef USE_CLEARCOAT
material.clearcoat *= 1.0 - max(pfBurnWall, pfBurnFloor);
#endif`);

// `faceAvg` is the preset's own colour (0xRRGGBB) — its texture's average, never the tint:
// the tint arrives as `diffuse`, so the shader's face colour is diffuse · pfFaceAvg.
export function applyBurn(material, { faceAvg }) {
  const uniforms = material.userData.patternUniforms;
  if (!uniforms?.pfGrainSwap) return material; // wood only: the burn draws over the wood pass
  Object.assign(uniforms, {
    pfSheetFrame: { value: new THREE.Matrix4() },
    pfSheetT: { value: 0 },
    pfPlies: { value: 0 },
    pfFaceAvg: { value: new THREE.Color(faceAvg) },
  });
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer); // applyPattern's hook copies `uniforms` — burn uniforms included
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${BURN_FRAG_DECL}`)
      .replace("#include <normal_fragment_begin>", `${BURN_FRAG_BODY}\n#include <normal_fragment_begin>`)
      .replace("#include <emissivemap_fragment>", `${BURN_FRAG_NORMAL}\n#include <emissivemap_fragment>`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>\n${BURN_FRAG_CLEARCOAT}`);
  };
  const base = prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey ? prevKey.call(material) : "";
  material.customProgramCacheKey = () => `${base}|pf-burn`;
  material.needsUpdate = true;
  return material;
}
```

- [ ] **Step 6: The `burn` option in `physical.js`**

Change the patterns import to `import { applyBrushFrame, applyBurn, applyPattern } from "./patterns.js";` and replace `buildPhysicalMaterial` with:

```js
// Realistic-mode material. `loadTexture(fileName)` is injected (the viewer owns
// a caching TextureLoader), so this stays unit-testable without a network.
// `burn` is the viewer's per-sub-part decision (sheet-look.js burnsFor): it adds the laser
// burn pass to a wood and changes no other program.
export function buildPhysicalMaterial(display, opts = {}) {
  let m = buildPhysical(display, opts);
  if (opts.burn) m = applyBurn(m, { faceAvg: resolveMaterial(display).preset.color });
  // brushed metal picks its brush direction per pixel (patterns.js applyBrushFrame)
  return m.userData.pfAnisotropic ? applyBrushFrame(m) : m;
}
```

(The comment block that sat above `buildPhysicalMaterial` — "Realistic-mode material. `loadTexture(fileName)` is injected …" — is the one reproduced here; do not leave a duplicate.)

- [ ] **Step 7: Run the tests and watch them pass**

Run: `$NODE24 npx vitest run test/framework/sheet-look.test.js test/framework/materials-patterns.test.js test/framework/materials-physical.test.js`
Expected: PASS. If a calibration floor fails, the numbers in `BURN` are wrong — do not lower the floor.

Then `$NODE24 npm run lint && $NODE24 npm test` — all green.

- [ ] **Step 8: Commit**

```bash
git add src/framework/materials/sheet-look.js src/framework/materials/patterns.js src/framework/materials/physical.js test/framework/sheet-look.test.js test/framework/materials-patterns.test.js test/framework/materials-physical.test.js
git commit -m "The laser burn pass: charred walls, scorched marks, relative to the face

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire burns into the viewer and mount

One lazy frame channel carrying print frames AND sheet frames; one per-sub-part gate on the program.

**Files:**
- Modify: `src/framework/viewer.js`
- Modify: `src/framework/mount.js`
- Modify: `AGENTS.md` (the materials paragraph)
- Test: `test/framework/viewer-realistic.test.js`, `test/framework/mount-realistic.test.js`, `test/framework/mount.test.js`

**Interfaces:**
- Consumes: `burnsFor(sp)`, `sheetFrameFor(sp, { p, d })` (Task 1); `buildPhysicalMaterial(display, { burn })` (Task 2).
- Produces (viewer handle):
  - `setFrameSource(source: () => { print?: Record<string, number[16]>, sheet?: Record<string, { frame: number[16], t: number, plies: number }> })` — replaces `setPrintFrameSource`.
  - `invalidateFrames()` — replaces `invalidatePrintFrames`.
  - `setSheetFrames(frames: Record<string, { frame, t, plies }>)` — new; `setPrintFrames(frames)` unchanged.
- Produces (mount): the registered source returns `{ print, sheet }`.

- [ ] **Step 1: Write the failing viewer tests**

In `test/framework/viewer-realistic.test.js`, add `import { sheetPart } from "../../src/framework/sheet/part.js";` beside the viewer import, and append:

```js
// A laser sheet in oak beside an oak block that is not a sheet part: only the sheet
// compiles the burn pass (sheet-look.js burnsFor), so every other program is untouched.
const square = (k) => k.shape2d([[0, 0], [30, 0], [30, 30], [0, 30]]);
const sheetPartDef = () => ({
  meta: { title: "t" },
  parts: {
    panel: sheetPart({ views: ["main"], display: { material: "oak" }, material: "birch plywood", thickness: 3, profile: square }),
    block: { build: () => null, display: { material: "oak" } },
  },
});
function shownSheets() {
  const v = createViewer(createContainer(), sheetPartDef());
  for (const n of ["panel", "block"]) v.setSubGeometry(n, payload());
  v.showAssembly(["panel", "block"], { frame: true });
  return v;
}

test("only the laser sheet compiles the burn pass; the non-sheet oak keeps the plain wood program", async () => {
  const v = shownSheets();
  await v.setRenderMode("realistic");
  expect(v.__subMesh("panel").material.customProgramCacheKey()).toBe("pf-pattern:wood|pf-burn");
  expect(v.__subMesh("block").material.customProgramCacheKey()).toBe("pf-pattern:wood");
  v.dispose();
});

test("sheet frames reach the burning material and its cutaway clone; a missing frame is plain wood", async () => {
  const v = shownSheets();
  await v.setRenderMode("realistic");
  const base = v.__subMesh("panel").material;
  expect(base.userData.patternUniforms.pfSheetT.value).toBe(0);
  const frame = new THREE.Matrix4().makeTranslation(1, 2, 3).toArray();
  v.setSheetFrames({ panel: { frame, t: 3, plies: 3 } });
  v.setCutawayEnabled(true);
  const clipped = v.__subMesh("panel").material;
  expect(clipped).not.toBe(base);
  const u = clipped.userData.patternUniforms;
  expect(u).toBe(base.userData.patternUniforms);
  expect(u.pfSheetFrame.value.toArray()).toEqual(frame);
  expect(u.pfSheetT.value).toBe(3);
  expect(u.pfPlies.value).toBe(3);
  v.setSheetFrames({});
  expect(u.pfSheetT.value).toBe(0);
  v.dispose();
});

test("frames are pulled from the source only when the realistic look is drawn", async () => {
  const v = shownSheets();
  const frame = new THREE.Matrix4().makeTranslation(0, 0, -3).toArray();
  const source = vi.fn(() => ({ print: {}, sheet: { panel: { frame, t: 3, plies: 0 } } }));
  v.setFrameSource(source);
  v.invalidateFrames();
  expect(source).not.toHaveBeenCalled();              // CAD: nothing is computed
  await v.setRenderMode("realistic");
  expect(source).toHaveBeenCalledTimes(1);
  expect(v.__subMesh("panel").material.userData.patternUniforms.pfSheetFrame.value.toArray()).toEqual(frame);
  v.invalidateFrames();                               // a delivery while realistic: pulled at once
  expect(source).toHaveBeenCalledTimes(2);
  v.dispose();
});
```

- [ ] **Step 2: Write the failing mount tests**

In `test/framework/mount-realistic.test.js`:

(a) In the `vi.mock("three", …)` factory, before its `return`, add a texture loader that answers on a microtask, and return it:

```js
  // No network: a texture "loads" on a microtask (the oak maps a burning sheet asks for).
  class FakeTextureLoader {
    load(_url, onLoad) { const t = new actual.Texture(); queueMicrotask(() => onLoad?.(t)); return t; }
  }
  return { ...actual, WebGLRenderer: FakeRenderer, TextureLoader: FakeTextureLoader };
```

(b) After the `print-frame.js` mock, add:

```js
// Counts the sheet frames mount asks for (materials/sheet-look.js).
const sheetFrameCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/framework/materials/sheet-look.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, sheetFrameFor: (...args) => { sheetFrameCalls.count++; return real.sheetFrameFor(...args); } };
});
```

(c) Add these imports beside `mount`'s:

```js
import { sheetPart } from "../../src/framework/sheet/part.js";
import { poseSteps } from "../../src/framework/sheet/pose.js";
import { composePose, invertRigid } from "../../src/framework/geometry/pose.js";
```

(d) In `beforeEach`, add `sheetFrameCalls.count = 0;`.

(e) Append:

```js
// A laser sheet in oak, posed face -Y, beside a non-sheet oak block. Realistic mode chars
// the sheet in its canonical frame, which mount computes lazily from the delivered pose and
// thickness — from data, no probe.
const SHEET_POSE = { face: "-Y", up: "+Z", at: [0, 0, 0] };
const sheetFixture = () => ({
  meta: { title: "Sheet Fixture", backend: "manifold" },
  defaults: { t: 3 },
  views: { main: { label: "Main" } },
  parts: {
    panel: sheetPart({ label: "Panel", views: ["main"], display: { material: "oak" }, material: "birch plywood",
      thickness: (p) => p.t, profile: (k) => k.shape2d([[0, 0], [30, 0], [30, 30], [0, 30]]), pose: SHEET_POSE }),
    block: { label: "Block", views: ["main"], display: { material: "oak" }, build: (k) => k.box({ size: [10, 10, 3] }) },
  },
  parameters: [{ id: "stock", title: "Stock", advanced: [{ key: "t", label: "Thickness", min: 1, max: 10, step: 0.5 }] }],
});
function mountSheets() {
  const workers = {};
  const runtime = mount(sheetFixture(), {
    createWorker: (name) => (workers[name] = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }),
    elements: makeElements(),
  });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("panel"), payload("block")], ms: 1 } });
  return { runtime, workers };
}
const round9 = (a) => a.map((v) => Math.round(v * 1e9) / 1e9 + 0);

test("a laser sheet in a wood gets its canonical frame lazily, from the delivered pose", async () => {
  const { runtime } = mountSheets();
  await runtime.ready;
  expect(sheetFrameCalls.count).toBe(0);                      // CAD: nothing computed
  await runtime.renderMode.set("realistic");
  expect(sheetFrameCalls.count).toBe(1);                      // the panel; the block is no sheet
  const u = viewers[0].__subMesh("panel").material.userData.patternUniforms;
  expect(u.pfSheetT.value).toBe(3);
  expect(round9(u.pfSheetFrame.value.toArray())).toEqual(round9(invertRigid(composePose(poseSteps(SHEET_POSE, 3)))));
  expect(viewers[0].__subMesh("block").material.customProgramCacheKey()).not.toContain("pf-burn");
  runtime.dispose();
});

test("a delivery while realistic recomputes the sheet frame; CAD deliveries do not", async () => {
  const { runtime, workers } = mountSheets();
  await runtime.ready;
  await runtime.renderMode.set("realistic");
  const before = sheetFrameCalls.count;
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("panel")], ms: 1 } });
  expect(sheetFrameCalls.count).toBe(before + 1);
  await runtime.renderMode.set("cad");
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("panel")], ms: 1 } });
  expect(sheetFrameCalls.count).toBe(before + 1);
  runtime.dispose();
});
```

In `test/framework/mount.test.js`, in the fake viewer replace

```js
      setPrintFrames: vi.fn(),
      setPrintFrameSource: vi.fn(),
      invalidatePrintFrames: vi.fn(),
```

with

```js
      setPrintFrames: vi.fn(),
      setSheetFrames: vi.fn(),
      setFrameSource: vi.fn(),
      invalidateFrames: vi.fn(),
```

and in the test `"a sub-part with no material has a print frame, offered lazily on delivery"` replace its body's frame assertions with:

```js
  expect(v.setFrameSource).toHaveBeenCalledOnce();
  finishFirstBuild(workers);
  expect(v.invalidateFrames).toHaveBeenCalled();
  expect(v.setPrintFrames).not.toHaveBeenCalled(); // nothing computed in CAD
  const source = v.setFrameSource.mock.calls[0][0];
  expect(source()).toEqual({ print: { body: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, sheet: {} });
```

(keep its `runtime`/`v` setup and its `declaresMaterials` and `dispose` lines).

- [ ] **Step 3: Run the tests and watch them fail**

Run: `$NODE24 npx vitest run test/framework/viewer-realistic.test.js test/framework/mount-realistic.test.js test/framework/mount.test.js`
Expected: FAIL — `setFrameSource`/`setSheetFrames` do not exist; the sheet compiles no burn pass.

- [ ] **Step 4: The viewer**

In `src/framework/viewer.js`:

1. Add `import { burnsFor } from "./materials/sheet-look.js";` after the `resolve.js` import.
2. Replace

```js
  let printFrames = {};
  let printFrameSource = null;       // () => frames; mount's lazy provider (setPrintFrameSource)
  let printFramesStale = false;      // the source has frames the materials have not seen
```

with

```js
  let printFrames = {};              // name -> mat4 array: layer lines' display → export map
  let sheetFrames = {};              // name -> { frame, t, plies }: a burning sheet's canonical frame (sheet-look.js)
  let frameSource = null;            // () => { print, sheet }; mount's lazy provider (setFrameSource)
  let framesStale = false;           // the source has frames the materials have not seen
  const IDENTITY_MAT4 = new THREE.Matrix4().toArray();
```

(`IDENTITY_MAT4` sits here, with the state, so nothing can reach `applySheetFrame` before it exists.)

3. Replace `physicalFor` with:

```js
  function physicalFor(name) {
    let m = physicalMats.get(name);
    if (!m) {
      const sp = part.parts[name];
      // `burn` is decided once per sub-part (sheet-look.js burnsFor): only a laser sheet in
      // a wood compiles the burn pass, so every other program is exactly what it was.
      m = cloneKeepsPattern(buildPhysicalMaterial(sp.display, { printFrame: printFrames[name], burn: burnsFor(sp), loadTexture }));
      physicalMats.set(name, m);
      syncGrain(name);
      applySheetFrame(m, sheetFrames[name]);
    }
    return m;
  }
```

4. In `enterRealistic` replace `syncPrintFrames(); // before the swap: the first realistic frame has the export-pose layers` with `syncFrames(); // before the swap: the first realistic frame has the export-pose layers and the sheets' burns`; in `compileRealistic` replace `syncPrintFrames();` with `syncFrames();`.

5. Replace everything from `  // The lazy form mount uses.` through the end of `function syncPrintFrames() { … }` with:

```js
  // A burning sheet's canonical frame (sheet-look.js sheetFrameFor). No frame — not yet
  // delivered, or not computable at these params — is pfSheetT = 0: plain wood.
  function applySheetFrame(m, f) {
    const u = m.userData.patternUniforms;
    if (!u?.pfSheetFrame) return;
    u.pfSheetFrame.value.fromArray(f?.frame ?? IDENTITY_MAT4);
    u.pfSheetT.value = f?.t ?? 0;
    u.pfPlies.value = f?.plies ?? 0;
  }
  function setSheetFrames(frames) {
    sheetFrames = frames ?? {};
    for (const [n, m] of physicalMats) applySheetFrame(m, sheetFrames[n]);
  }

  // The lazy form mount uses. Frames are PULLED only when something is about to draw the
  // realistic look: the live view (or a switch loading), and any capture that borrows it —
  // compileRealistic and enterRealistic are the two doors every such path goes through. A
  // delivery just marks them stale (invalidateFrames); in CAD nothing is computed. One
  // source carries both kinds: `print` (layer lines; a placed sub-part's costs two
  // geometry-free probe builds, and every sub-part with no material draws layer lines) and
  // `sheet` (a burning sheet's canonical frame, from data).
  function setFrameSource(source) {
    frameSource = typeof source === "function" ? source : null;
    invalidateFrames();
  }
  function invalidateFrames() {
    framesStale = true;
    if (renderMode === "realistic" || realisticPending) syncFrames();
  }
  function syncFrames() {
    if (!frameSource || !framesStale) return;
    framesStale = false;
    let frames;
    try { frames = frameSource(); } catch (e) {
      console.warn("partforge: computing material frames failed", e);
      return;
    }
    setPrintFrames(frames?.print);
    setSheetFrames(frames?.sheet);
  }
```

6. In the returned handle replace `setPrintFrames,\n    setPrintFrameSource,\n    invalidatePrintFrames,` with `setPrintFrames,\n    setSheetFrames,\n    setFrameSource,\n    invalidateFrames,`.

- [ ] **Step 5: mount**

In `src/framework/mount.js`:

1. Add `import { burnsFor, sheetFrameFor } from "./materials/sheet-look.js";` after the `print-frame.js` import.
2. Replace the block from `    // Print frames for the layer-line pattern: the display → export map of the` through `    viewer.setPrintFrameSource?.(computePrintFrames);` with:

```js
    // Frames the realistic look reads, for the geometry just delivered:
    //  - print frames for the layer-line pattern: the display → export map, so layers run
    //    the way the part is printed rather than the way it is displayed. Only sub-parts
    //    whose material draws layer lines have one — which includes every sub-part naming
    //    no material, since realistic mode shows those as PLA (resolve.js). One without a
    //    place() is identity at once; one with it costs two geometry-free probe builds.
    //  - sheet frames for the burn pass (materials/sheet-look.js): a laser sheet in a wood,
    //    mapped back into its canonical frame — from data, no probe.
    // Each describes the delivered mesh (which a later pose-only repair only moves).
    const layerLined = new Set(Object.keys(part.parts).filter((n) => {
      try { return resolveMaterial(part.parts[n].display).params.pattern === "layer-lines"; } catch { return false; }
    }));
    const burning = new Set(Object.keys(part.parts).filter((n) => burnsFor(part.parts[n])));
    // LAZY: a delivery only records the view and params it was built at; the viewer pulls
    // the frames (computeFrames) when it is about to draw the realistic look — live,
    // loading, or borrowed by a capture — so a CAD-only session computes nothing
    // (viewer.js setFrameSource). The snapshot keeps a late computation describing the
    // mesh actually delivered.
    const printFrames = {};
    const sheetFrames = {};
    const undrawnFrames = new Map(); // sub-part -> { view, params } at its delivery
    function recordFrames(names) {
      const wanted = names.filter((n) => layerLined.has(n) || burning.has(n));
      if (!wanted.length) return;
      const at = { view: view(), params: { ...params } };
      for (const n of wanted) undrawnFrames.set(n, at);
      viewer.invalidateFrames?.();
    }
    function computeFrames() {
      const resolvedFor = new Map(); // one resolveParams per delivery, not per sub-part
      for (const [n, at] of undrawnFrames) {
        if (!resolvedFor.has(at)) {
          try { resolvedFor.set(at, resolveParams(part, at.params)); } catch { resolvedFor.set(at, null); } // diagnosed by the build
        }
        const resolved = resolvedFor.get(at);
        if (!resolved) continue;
        if (layerLined.has(n)) printFrames[n] = printFrameMatrix(part.parts[n], { view: at.view, ...resolved });
        if (burning.has(n)) {
          const f = sheetFrameFor(part.parts[n], resolved);
          if (f) sheetFrames[n] = f; else delete sheetFrames[n];
        }
      }
      undrawnFrames.clear();
      return { print: { ...printFrames }, sheet: { ...sheetFrames } };
    }
    viewer.setFrameSource?.(computeFrames);
```

3. In the `meshes` case replace `recordPrintFrames(data.meshes.map((m) => m.name));` with `recordFrames(data.meshes.map((m) => m.name));`.

- [ ] **Step 6: AGENTS.md**

In the `src/framework/materials/` paragraph, replace

```
`print-frame.js`
  (pose math for layer lines; frames are LAZY - `mount.js` only records each
  delivery, and the viewer pulls them through `setPrintFrameSource` when it is
  about to draw the realistic look, live or borrowed by a capture, so CAD
  builds never run the pose probes),
```

with

```
`print-frame.js`
  and `sheet-look.js` (pose math for layer lines, and a laser sheet part's
  canonical frame for its burns - from data, no probe; frames are LAZY -
  `mount.js` only records each delivery, and the viewer pulls both kinds
  through `setFrameSource` when it is about to draw the realistic look, live
  or borrowed by a capture, so CAD builds never compute them),
```

and extend "`patterns.js` is the **only** shader-injection site (`onBeforeCompile`) for layer lines, wood, carbon weave and SLS grain" to "… for layer lines, wood, carbon weave, SLS grain and the laser burn (compiled only into the sub-parts `sheet-look.js`'s `burnsFor` picks)". (Match the file's line wrapping; the text is what matters.)

- [ ] **Step 7: Run the tests and watch them pass**

Run: `$NODE24 npx vitest run test/framework/viewer-realistic.test.js test/framework/mount-realistic.test.js test/framework/mount.test.js test/framework/viewer-materials.test.js test/framework/mount-capture-view.test.js`
Expected: PASS.

`grep -rn "setPrintFrameSource\|invalidatePrintFrames\|syncPrintFrames\|recordPrintFrames\|computePrintFrames" src test` must print nothing.

Then `$NODE24 npm run lint && $NODE24 npm test` — all green.

- [ ] **Step 8: Commit**

```bash
git add src/framework/viewer.js src/framework/mount.js AGENTS.md test/framework/viewer-realistic.test.js test/framework/mount-realistic.test.js test/framework/mount.test.js
git commit -m "Realistic mode draws laser burns: sheet frames ride the one lazy frame channel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The contact sheet's laser views and the capture script

The first time the pass compiles in a real browser. Two views that differ only by the burn, and a dev script that renders and diffs them.

**Files:**
- Modify: `src/parts/material-swatches.js`
- Modify: `test/verify-golden.test.js` (exclude the two views)
- Create: `scripts/capture-contact-sheet.mjs`
- Modify: `AGENTS.md` (the `materials.html` sentence)
- Test: create `test/framework/material-swatches.test.js`

**Interfaces:**
- Consumes: `sheetPart` (`src/framework/sheet/part.js`), `sheetHole` (`src/framework/sheet/joinery.js`), `burnsFor`, `sheetFrameFor` (Task 1); the runtime handle on `window.__pfRuntime` (`src/app-materials.js`): `ready`, `setView(name)`, `environment.set(id)`, `renderViews(angles, { renderMode: "realistic" }) → [{ view, dataUrl }]`.
- Produces:
  - Views `laser` ("Laser-cut") and `unburnt` ("Laser-cut, unburnt"); sub-parts `laser_<key>` / `unburnt_<key>` from one `LASER_SWATCHES` list (keys this task: `oak_3|6|9`, `walnut_3|6|9`, `acrylic_3`, `oak_standing`, `oak_block`).
  - `node scripts/capture-contact-sheet.mjs --out <dir> [--views laser,unburnt] [--envs studio,workshop,print-bed,outdoor] [--angles iso,top]` → `<env>-<view>-<angle>.jpg` per capture, `<env>-<angle>-diff.png` per pair; exit 1 on any console error.

- [ ] **Step 1: Write the failing swatch test**

Create `test/framework/material-swatches.test.js`:

```js
// The contact sheet's laser-cut views (materials.html). "Laser-cut, unburnt" is the twin
// scripts/capture-contact-sheet.mjs diffs against, so its promise is pinned: the same
// swatches, in the same places, with the same geometry — only the burn differs.
import { beforeAll, expect, test } from "vitest";
import part from "../../src/parts/material-swatches.js";
import { bootManifoldKernel } from "../../src/testing.js";
import { buildPosed } from "../../src/framework/part-model.js";
import { burnsFor, sheetFrameFor } from "../../src/framework/materials/sheet-look.js";
import { isSheetPart } from "../../src/framework/sheet/constants.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const inView = (view) => Object.entries(part.parts).filter(([, sp]) => sp.views.includes(view));
const keysIn = (view) => inView(view).map(([n]) => n.slice(n.indexOf("_") + 1));
const BURNING = ["oak_3", "oak_6", "oak_9", "walnut_3", "walnut_6", "walnut_9", "oak_standing"];

test("the Laser-cut view and its unburnt twin hold the same swatches", () => {
  expect(keysIn("laser").length).toBeGreaterThan(0);
  expect(keysIn("unburnt")).toEqual(keysIn("laser"));
});

test("in the Laser-cut view exactly the wood sheets burn; no twin burns", () => {
  expect(inView("laser").filter(([, sp]) => burnsFor(sp)).map(([n]) => n.slice("laser_".length)).sort()).toEqual([...BURNING].sort());
  for (const [n, sp] of inView("unburnt")) {
    expect(burnsFor(sp), n).toBe(false);
    if (isSheetPart(sp)) expect(sp.sheet.place, n).toBeTypeOf("function");
  }
});

test("the standing swatch's frame is not the identity; a flat swatch's is", () => {
  expect(sheetFrameFor(part.parts.laser_oak_standing, { p: {}, d: {} }).frame).not.toEqual(IDENTITY);
  expect(sheetFrameFor(part.parts.laser_oak_3, { p: {}, d: {} }).frame).toEqual(IDENTITY);
});

test("each twin builds the same solid in the same place", () => {
  for (const key of keysIn("laser")) {
    const at = (name) => buildPosed(k, part, name, { purpose: "display", view: name.startsWith("laser") ? "laser" : "unburnt", p: {}, d: {} });
    const a = at(`laser_${key}`), b = at(`unburnt_${key}`);
    expect(b.volume(), key).toBeCloseTo(a.volume(), 6);
    const [ba, bb] = [a.boundingBox(), b.boundingBox()];
    expect(bb.min, key).toEqual(ba.min);
    expect(bb.max, key).toEqual(ba.max);
  }
});
```

Run: `$NODE24 npx vitest run test/framework/material-swatches.test.js`
Expected: FAIL — no `laser` view.

- [ ] **Step 2: The swatches**

In `src/parts/material-swatches.js`:

1. Extend the header comment: "…judged by eye in every environment (materials.html). The "Laser-cut" views (below) do the same for the laser burn. Not a reference part."
2. Add imports after the `PRESETS` import:

```js
import { sheetPart } from "../framework/sheet/part.js";
import { sheetHole } from "../framework/sheet/joinery.js";
```

3. After `withHole`, add:

```js
// The "Laser-cut" view: sheet swatches as the laser burn draws them — each 30 × 30 with a
// cut hole, an engraved label (its thickness) and a score line — in every wood at 3, 6 and
// 9 mm; one oak panel standing on edge (posed, so its frame is not the identity); and the
// looks that must NOT burn: a clear-acrylic sheet and an oak block that is not a sheet part.
// "Laser-cut, unburnt" is its twin: the same swatches with an identity author `place`,
// which shows plain wood (materials/sheet-look.js) — same geometry, same place, same
// material — so the two views differ ONLY by the burn and scripts/capture-contact-sheet.mjs
// can diff them pixel for pixel.
const SW = 30;
const WOODS = ["oak", "walnut"];
const CONTROLS_Y = -WOODS.length * PITCH;
const LASER_SWATCHES = [
  ...WOODS.flatMap((material, row) => [3, 6, 9].map((t, col) => ({
    key: `${material}_${t}`, label: `${PRESETS[material].label}, ${t} mm`, at: [col * PITCH, -row * PITCH], t, display: { material },
  }))),
  { key: "acrylic_3", label: "Clear acrylic, 3 mm", at: [0, CONTROLS_Y], t: 3, display: { material: "clear-acrylic" }, stock: "clear acrylic" },
  { key: "oak_standing", label: "Oak, 3 mm, standing", at: [PITCH, CONTROLS_Y], t: 3, display: { material: "oak" }, standing: true },
  { key: "oak_block", label: "Oak block (not a sheet part)", at: [2 * PITCH, CONTROLS_Y], t: 3, display: { material: "oak" }, block: true },
];

function laserSwatch(s, unburnt) {
  const [x, y] = s.at;
  const common = {
    label: unburnt ? `${s.label} (unburnt)` : s.label,
    views: [unburnt ? "unburnt" : "laser"],
    ...(s.display ? { display: s.display } : {}),
  };
  if (s.block) {
    return { ...common, build: (k) => k.box({ min: [x, y, 0], max: [x + SW, y + SW, s.t] })
      .cut(k.cylinder({ d: 8, h: s.t + 2 }).translate([x + 21, y + 21, -1])) };
  }
  // A standing swatch is drawn at the drawing origin; its pose stands it on edge at `at`.
  const [u, v] = s.standing ? [0, 0] : [x, y];
  return sheetPart({
    ...common,
    material: s.stock ?? "birch plywood",
    thickness: s.t,
    profile: (k) => k.shape2d([[u, v], [u + SW, v], [u + SW, v + SW], [u, v + SW]]).cut(sheetHole({ d: 8, at: [u + 21, v + 21] })),
    engrave: (k) => k.text2d(String(s.t), { size: 10, align: "center", valign: "middle" }).translate([u + 9, v + 20]),
    score: () => [[[u + 3, v + 7], [u + SW - 3, v + 7]]],
    ...(s.standing ? { pose: { face: "-Y", up: "+Z", at: [x, y, 0] } } : {}),
    ...(unburnt ? { place: (solid) => solid } : {}),
  });
}
```

4. In the default export, extend `views` with `laser: { label: "Laser-cut" }, unburnt: { label: "Laser-cut, unburnt" }` (after `print`), and add at the end of `parts`:

```js
    ...Object.fromEntries(LASER_SWATCHES.flatMap((s) => [
      [`laser_${s.key}`, laserSwatch(s, false)],
      [`unburnt_${s.key}`, laserSwatch(s, true)],
    ])),
```

Run: `$NODE24 npx vitest run test/framework/material-swatches.test.js test/lint-parts.test.js test/lint-source.test.js`
Expected: PASS.

- [ ] **Step 3: Keep the verify golden deterministic**

In `test/verify-golden.test.js`, after `const EXCLUDED = new Set(["laser-box.js"]);` add:

```js
// The contact sheet's laser-cut views hold sheet parts too, and a sheet's laser checks run
// on a real clock (SHEET_CHECK_BUDGET_MS) — so their verdict depends on the machine. They
// are a dev page for judging the burn by eye, with no verdict to guard.
const EXCLUDED_VIEWS = new Set(["material-swatches.js#laser", "material-swatches.js#unburnt"]);
```

In `currentKeys()` replace `for (const view of Object.keys(part.views)) keys.push(`${file}#${view}`);` with:

```js
    for (const view of Object.keys(part.views)) {
      if (!EXCLUDED_VIEWS.has(`${file}#${view}`)) keys.push(`${file}#${view}`);
    }
```

and rename the second test to `"the golden covers every view of every reference part except laser-box.js and the contact sheet's laser views"`.

Run: `$NODE24 npx vitest run test/verify-golden.test.js`
Expected: PASS with no re-record (the fixture is unchanged: `git diff --stat test/fixtures` prints nothing).

- [ ] **Step 4: The capture script**

Create `scripts/capture-contact-sheet.mjs`:

```js
#!/usr/bin/env node
// Dev tool, not a test: render the materials contact sheet (materials.html) in realistic
// mode, in every environment, so a preset or shader change can be judged by eye. Given two
// part views — by default "Laser-cut" and its "unburnt" twin, which hold the same swatches
// in the same places and differ ONLY by the laser burn — it also writes, per environment
// and angle, an amplified |a − b| image: the burn's footprint, pixel for pixel, with the
// lighting cancelled (the same geometry lit the same way). Cut walls, engravings and
// scores should light up; faces, the acrylic sheet and the non-sheet block stay black.
//
//   node scripts/capture-contact-sheet.mjs --out <dir> [--views laser,unburnt]
//     [--envs studio,workshop,print-bed,outdoor] [--angles iso,top]
//
// Writes <env>-<view>-<angle>.jpg per capture and <env>-<angle>-diff.png per pair of views.
// Exits 1 if the page logged a console error — a shader that fails to compile surfaces
// here — or a view never finished building. CHECK_PORT picks the Vite port (default
// 5191). Needs Playwright's Chromium, like scripts/check-app.mjs.
import { chromium } from "playwright";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const out = opt("out", null);
if (!out) {
  console.error("usage: node scripts/capture-contact-sheet.mjs --out <dir> [--views a,b] [--envs …] [--angles …]");
  process.exit(2);
}
const views = opt("views", "laser,unburnt").split(",");
const envs = opt("envs", "studio,workshop,print-bed,outdoor").split(",");
const angles = opt("angles", "iso,top").split(",");
const PORT = Number(process.env.CHECK_PORT) || 5191;
const url = `http://localhost:${PORT}/materials.html`;
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
mkdirSync(out, { recursive: true });

// |a − b| per channel, times 4, and the share of pixels the burn visibly moved (any channel
// by more than 8/255 before amplifying).
async function diff(a, b, file) {
  const A = await sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(b).removeAlpha().raw().toBuffer();
  const { width, height, channels } = A.info;
  const d = Buffer.alloc(A.data.length);
  let moved = 0;
  for (let i = 0; i < d.length; i += channels) {
    let most = 0;
    for (let c = 0; c < channels; c++) {
      const delta = Math.abs(A.data[i + c] - B[i + c]);
      most = Math.max(most, delta);
      d[i + c] = Math.min(255, delta * 4);
    }
    if (most > 8) moved++;
  }
  await sharp(d, { raw: { width, height, channels } }).png().toFile(file);
  console.log(`${file}: the burn moved ${(100 * moved / (width * height)).toFixed(1)}% of pixels`);
}

const errors = [];
const vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], { detached: true, stdio: "ignore" });
let browser;
try {
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not listening yet */ }
    if (tries > 240) throw new Error(`vite never answered on ${url}`);
    await sleep(250);
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.__pfRuntime, null, { timeout: 60_000 });
  await page.evaluate(() => window.__pfRuntime.ready);
  const pairs = new Map(); // "<env>-<angle>" -> one file per view, in --views order
  for (const env of envs) {
    await page.evaluate((id) => window.__pfRuntime.environment.set(id), env);
    for (const view of views) {
      if (!await page.evaluate((v) => window.__pfRuntime.setView(v) !== false, view)) throw new Error(`no view "${view}"`);
      // A view switch disables the export buttons synchronously until its sub-parts are
      // built and current (mount's refreshView), so this waits out the build.
      await page.waitForFunction(() => document.querySelector("#download")?.disabled === false, null, { timeout: 180_000 });
      const shots = await page.evaluate((a) => window.__pfRuntime.renderViews(a, { renderMode: "realistic" }), angles);
      for (const { view: angle, dataUrl } of shots) {
        const file = join(out, `${env}-${view}-${angle}.jpg`);
        writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
        const key = `${env}-${angle}`;
        if (!pairs.has(key)) pairs.set(key, []);
        pairs.get(key).push(file);
        console.log(file);
      }
    }
  }
  if (views.length === 2) for (const [key, [a, b]] of pairs) await diff(a, b, join(out, `${key}-diff.png`));
} finally {
  await browser?.close();
  try { process.kill(-vite.pid, "SIGTERM"); } catch { /* already gone */ }
}
if (errors.length) {
  console.error(`console errors:\n${errors.join("\n")}`);
  process.exit(1);
}
```

- [ ] **Step 5: First look, in a real browser**

Run: `$NODE24 node scripts/capture-contact-sheet.mjs --out "$SHOTS/task4" --envs studio`
Expected: exit 0 (no console errors — a GLSL error would print `THREE.WebGLProgram: Shader Error` and exit 1), four JPEGs and two diff PNGs.

Open every image (the Read tool shows them) and check, writing what you see in your report:
- `studio-iso-diff.png` / `studio-top-diff.png`: bright on the oak and walnut swatches' cut walls, hole walls, engraved numbers and score lines, and on the standing panel's edges; BLACK on every laser face, on the acrylic sheet and on the oak block.
- `studio-laser-iso.jpg` against `studio-unburnt-iso.jpg`: edges visibly darker on oak AND walnut at 3 mm; 9 mm darker than 3 mm; the engraved numbers legible; walnut's char matte (no lacquer sheen).

If the diff lights a face, the frame or the floor classification is wrong — stop and report; do not tune colours to hide it.

- [ ] **Step 6: AGENTS.md**

Replace "is the contact sheet - one 30mm sample of every preset plus the layer-line orientation check - to check by eye after any preset or shader change." with "is the contact sheet - one 30mm sample of every preset, the layer-line orientation check, and the Laser-cut views (burning sheets beside an unburnt twin that differs only by the burn; `scripts/capture-contact-sheet.mjs` renders both in every environment and diffs them) - to check by eye after any preset or shader change."

- [ ] **Step 7: Verify and commit**

`$NODE24 npm run lint && $NODE24 npm run lint:dead && $NODE24 npm test` — all green.

```bash
git add src/parts/material-swatches.js test/verify-golden.test.js scripts/capture-contact-sheet.mjs AGENTS.md test/framework/material-swatches.test.js
git commit -m "Contact sheet: Laser-cut views with an unburnt twin, and a capture-and-diff script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The `plywood` preset

A real birch plywood: a pale face, and its plies on laser-cut walls. The texture comes from an approved CC0 set or from the stated fallback — this task never waits on a download.

**Files:**
- Create: `src/framework/materials/assets/pattern-plywood-color.jpg` (+ `pattern-plywood-normal.jpg`, `pattern-plywood-rough.jpg` on path (a) only)
- Modify: `src/framework/materials/assets.js`, `src/framework/materials/assets/SOURCES.md`
- Modify: `src/framework/materials/presets.js`
- Modify: `docs/AUTHORING-PARTS.md` ("## Materials and appearance": the `textureScale` table and the preset table)
- Modify: `src/parts/material-swatches.js` (`WOODS`)
- Test: `test/framework/materials-resolve.test.js`, `test/framework/materials-physical.test.js`, `test/framework/sheet-look.test.js`, `test/framework/material-swatches.test.js`

**Interfaces:**
- Consumes: `scripts/bake-environments.mjs --texture <in> <out-name.jpg> [--data] [--gray] [--quality Q] [--modulate brightness,saturation] [--flatten K] [--size N]`; `plyCount` (Task 1); the capture script (Task 4).
- Produces: `PRESETS.plywood = P("plywood", "Birch plywood", "natural", …, { …, pattern: "wood", laminated: true, textures: {…} })` — 25 presets; asset names in `assets.js`.

- [ ] **Step 1: Which texture path**

Your brief from the controller says whether Scott APPROVED downloading the ambientCG set (candidates Wood087, Wood088, Wood089). Downloading without that approval is not allowed.

- **(a) Approved:** download the chosen set's 1K JPG zip from its ambientCG page (`https://ambientcg.com/view?id=Wood087` etc.) into `$SHOTS/plywood-src/`, and open its colour map. It qualifies ONLY if the colour map shows a birch plywood FACE (long-grain veneer, no ply stripes) — the plies are drawn by the burn pass at the sheet's real count, so a side/edge image cannot be the face. If none of the three qualifies, use (b) and say so in your report.
- **(b) Not approved, or no qualifying face:** the fallback below. No download.

- [ ] **Step 2: Write the failing tests**

`test/framework/materials-resolve.test.js`: add `"plywood"` to `LISTED` after `"walnut"`; rename the test to `"the library lists exactly the 25 presets, no hidden default"`; in `"wood presets carry a full texture set"` change `["oak", "walnut"]` to `["oak", "walnut", "plywood"]`. Append:

```js
test("plywood is a laminated wood; nothing else is laminated", () => {
  expect(PRESETS.plywood).toMatchObject({ label: "Birch plywood", category: "natural", pattern: "wood", laminated: true, tintable: false });
  expect(Object.values(PRESETS).filter((p) => p.laminated).map((p) => p.id)).toEqual(["plywood"]);
});
```

`test/framework/sheet-look.test.js`: change `const WOODS = ["oak", "walnut"];` to `const WOODS = ["oak", "walnut", "plywood"];`, and append:

```js
test("a plywood sheet shows its plies: 3 mm → 3, 6 → 5, 9 → 7; other woods none", () => {
  for (const [t, plies] of [[3, 3], [6, 5], [9, 7]]) {
    expect(sheetFrameFor(panel({ display: { material: "plywood" }, thickness: t }), P).plies, `${t} mm`).toBe(plies);
  }
  expect(sheetFrameFor(panel(), P).plies).toBe(0);
});
```

`test/framework/materials-physical.test.js`, append:

```js
test("plywood loads its colour map as sRGB and burns like any wood", () => {
  const seen = {};
  const m = buildPhysicalMaterial({ material: "plywood" }, { loadTexture: (f) => (seen[f] = new THREE.Texture()), burn: true });
  expect(seen["pattern-plywood-color.jpg"].colorSpace).toBe(THREE.SRGBColorSpace);
  expect(m.customProgramCacheKey()).toBe("pf-pattern:wood|pf-burn");
  expect(m.color.getHex()).toBe(0xffffff);
});
```

`test/framework/material-swatches.test.js`: add `"plywood_3", "plywood_6", "plywood_9"` to `BURNING`.

Run: `$NODE24 npx vitest run test/framework/materials-resolve.test.js test/framework/sheet-look.test.js test/framework/materials-physical.test.js test/framework/materials-docs.test.js`
Expected: FAIL — no `plywood` preset.

- [ ] **Step 3: Bake the texture**

**(a)** From the set's maps (names as ambientCG ships them):

```bash
$NODE24 node scripts/bake-environments.mjs --texture "$SHOTS/plywood-src/<Set>_1K-JPG_Color.jpg" pattern-plywood-color.jpg
$NODE24 node scripts/bake-environments.mjs --texture "$SHOTS/plywood-src/<Set>_1K-JPG_NormalGL.jpg" pattern-plywood-normal.jpg --data --quality 95
$NODE24 node scripts/bake-environments.mjs --texture "$SHOTS/plywood-src/<Set>_1K-JPG_Roughness.jpg" pattern-plywood-rough.jpg --gray
```

**(b)** From the committed oak scan, lightened and desaturated to birch, its open grain softened:

```bash
$NODE24 node scripts/bake-environments.mjs --texture src/framework/materials/assets/pattern-oak-color.jpg pattern-plywood-color.jpg --modulate 1.45,0.75 --flatten 0.7 --quality 85
```

It reuses oak's normal and roughness maps (`pattern-oak-normal.jpg`, `pattern-oak-rough.jpg`; roughness mean 0.53).

Measure the colour map's average — it becomes the preset's `color`:

```bash
$NODE24 node -e 'require("sharp")("src/framework/materials/assets/pattern-plywood-color.jpg").stats().then((s) => console.log("0x" + s.channels.slice(0, 3).map((c) => Math.round(c.mean).toString(16).padStart(2, "0")).join("")))'
```

(b) should print about `0xe1c2a3` (a pale birch). It must read as pale birch — roughly R 200–235, G 180–210, B 145–180, R > G > B. If it does not, adjust `--modulate` (brightness, saturation) and re-bake; record the final command. On (a), also measure the roughness map's mean the same way (`mean / 255` of its one channel — `roughnessMean`), and look at the colour map to decide which image axis its grain runs along (`grain: "u"` horizontal, `"v"` vertical). Every file must be ≤ 400 KB (`ls -l`).

- [ ] **Step 4: Register the assets**

In `src/framework/materials/assets.js` add, after the walnut lines:

```js
  "pattern-plywood-color.jpg": new URL("./assets/pattern-plywood-color.jpg", import.meta.url).href,
```

and on (a) also the `-normal` and `-rough` lines in the same literal form.

In `src/framework/materials/assets/SOURCES.md`, in "## Ground and pattern textures", add one row per new file in the table's format. (b):

```
| `pattern-plywood-color.jpg` | Poly Haven "Oak Veneer 01" (colour), via the committed `pattern-oak-color.jpg` | https://polyhaven.com/a/oak_veneer_01 | 2026-09-30 | Birch-plywood face, the fallback while no CC0 birch-ply face is approved: `node scripts/bake-environments.mjs --texture src/framework/materials/assets/pattern-oak-color.jpg pattern-plywood-color.jpg --modulate 1.45,0.75 --flatten 0.7 --quality 85` (lightened 1.45x, saturation 0.75, grain contrast 0.7). The `plywood` preset reuses `pattern-oak-normal.jpg` and `pattern-oak-rough.jpg`. |
```

(a): the set's name, its ambientCG URL, today's date, and each exact command from Step 3. Update the "## Budgets" paragraph only if a new file is now the largest.

- [ ] **Step 5: The preset**

In `src/framework/materials/presets.js`, extend the wood comment block above `oak` with: "`laminated` (plywood) asks the burn pass (patterns.js applyBurn) for ply bands on laser-cut walls, at sheet-look.js's plyCount(t)." Then add after `walnut` (before `carbon-fiber`) — (b):

```js
  plywood: P("plywood", "Birch plywood", "natural", "Birch plywood sheet: a pale, fine-grained face; its plies show on laser-cut edges.",
    { color: 0xe1c2a3, metalness: 0, roughness: 0.6, pattern: "wood", textureScale: 150, laminated: true,
      textures: { color: "pattern-plywood-color.jpg", normal: "pattern-oak-normal.jpg", roughness: "pattern-oak-rough.jpg", roughnessMean: 0.53, normalScale: 1.5, grain: "v" } }),
```

— with `color` set to the value Step 3 printed. On (a): `normal: "pattern-plywood-normal.jpg"`, `roughness: "pattern-plywood-rough.jpg"`, the measured `roughnessMean`, the observed `grain`, `normalScale: 2`, and `textureScale` chosen by eye in Step 8 (start at 150: finer than oak's 250).

- [ ] **Step 6: The docs rows**

In `docs/AUTHORING-PARTS.md` "## Materials and appearance":

- the `textureScale` table's wood row becomes
  `` | wood | `oak`, `walnut`, `plywood` | size of one texture tile (the grain repeats every this many mm) | 250 (`oak`), 400 (`walnut`), 150 (`plywood`) | `` (use the final `textureScale`);
- after the `` `walnut` `` row of the preset table add
  `` | `plywood` | Birch plywood | — | Birch plywood sheet: a pale, fine-grained face; its plies show on laser-cut edges. | ``.

Count the documented preset ids before AND after the edit with

```bash
$NODE24 node -e 'const d=require("fs").readFileSync("docs/AUTHORING-PARTS.md","utf8");const i=d.indexOf("## Materials and appearance");const s=d.slice(i,d.indexOf("\n## ",i+5));console.log(s.split("\n").filter((l)=>/^\| `[a-z-]+` \| [A-Z]/.test(l)).length)'
```

Expected: `24` before, `25` after — state both in your report.

- [ ] **Step 7: Plywood on the contact sheet**

In `src/parts/material-swatches.js`, change `const WOODS = ["oak", "walnut"];` to `const WOODS = ["plywood", "oak", "walnut"];` (plywood's row first; the controls row moves down with `CONTROLS_Y`).

- [ ] **Step 8: Run, look, commit**

Run: `$NODE24 npx vitest run test/framework/materials-resolve.test.js test/framework/sheet-look.test.js test/framework/materials-physical.test.js test/framework/materials-docs.test.js test/framework/materials-assets.test.js test/framework/materials-assets-map.test.js test/framework/material-swatches.test.js`
Expected: PASS (the calibration test now holds plywood at 3 mm too).

`$NODE24 node scripts/capture-contact-sheet.mjs --out "$SHOTS/task5" --envs studio` — then look: the plywood row's faces pale birch with a fine grain (not orange, not grey); its cut walls show plies through the char — 3, 5 and 7 bands at 3, 6 and 9 mm — best seen in `studio-laser-iso.jpg`; the `all` view is unchanged except for the new swatch. On (a), if the grain reads too coarse or too fine, adjust `textureScale` (and its docs cell) and re-capture.

`$NODE24 npm run lint && $NODE24 npm test` — all green (the verify golden's `material-swatches.js#all` entry does not list sub-parts, so a new preset leaves it unchanged — if it does change, stop and report).

```bash
git add src/framework/materials/assets src/framework/materials/assets.js src/framework/materials/presets.js docs/AUTHORING-PARTS.md src/parts/material-swatches.js test/framework/materials-resolve.test.js test/framework/sheet-look.test.js test/framework/materials-physical.test.js test/framework/material-swatches.test.js
git commit -m "A plywood preset: a pale birch face, plies under the char

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sheet parts default to their stock's look

A laser sheet part naming no material (or an unknown one) draws as `plywood` or `clear-acrylic` from its stock label, not as a PLA print.

**Files:**
- Modify: `src/framework/materials/sheet-look.js`
- Modify: `src/framework/viewer.js` (`physicalFor`), `src/framework/mount.js` (`layerLined`)
- Modify: `src/framework/lint/rules-materials.js` (the `unknown-material` hint)
- Modify: `docs/AUTHORING-PARTS.md` ("## Materials and appearance"), `AGENTS.md`
- Modify: `src/parts/material-swatches.js` (stock-default swatches)
- Test: `test/framework/sheet-look.test.js`, `test/framework/viewer-realistic.test.js`, `test/framework/mount-realistic.test.js`, `test/lint-materials.test.js`, `test/framework/materials-docs.test.js`, `test/framework/material-swatches.test.js`

**Interfaces:**
- Consumes: `PRESETS` (`presets.js`), `isSheetPart`; `burnsFor`, `sheetFrameFor` (Task 1).
- Produces (all in `sheet-look.js`):
  - `STOCK_LOOKS: ReadonlyArray<{ look: string, words: readonly string[] }>` — `[{ look: "clear-acrylic", words: ["acrylic", "perspex", "plexi", "pmma", "polycarbonate"] }]`
  - `DEFAULT_STOCK_LOOK = "plywood"`
  - `stockLook(stock: unknown): string` — case-insensitive substring match on a string label, first matching row, else `DEFAULT_STOCK_LOOK`.
  - `sheetStockLook(sp): string | null` — `stockLook(sp.sheet.material)` for a laser sheet part, else `null`.
  - `realisticDisplay(sp): object | undefined` — the display realistic mode draws.
  - `burnsFor`/`sheetFrameFor` now read `realisticDisplay`.

- [ ] **Step 1: Write the failing tests**

`test/framework/sheet-look.test.js` — add `DEFAULT_STOCK_LOOK, STOCK_LOOKS, realisticDisplay, sheetStockLook, stockLook` to the `sheet-look.js` import, and append:

```js
describe("a laser sheet with no usable material takes its stock's look", () => {
  test("one keyword table: acrylic-like stock is clear acrylic, everything else plywood", () => {
    for (const stock of ["clear acrylic", "3 mm Perspex", "Plexiglas", "PMMA", "polycarbonate sheet", "Cast ACRYLIC"]) {
      expect(stockLook(stock), stock).toBe("clear-acrylic");
    }
    for (const stock of ["birch plywood", "basswood", "poplar ply", "MDF", "hardboard", "wood", "cardboard", "", "?"]) {
      expect(stockLook(stock), stock).toBe("plywood");
    }
    expect(stockLook((p) => p.stock)).toBe(DEFAULT_STOCK_LOOK);   // a function label is not read
    for (const { look } of STOCK_LOOKS) expect(Object.keys(PRESETS)).toContain(look);
    expect(Object.keys(PRESETS)).toContain(DEFAULT_STOCK_LOOK);
  });

  test("realisticDisplay: an explicit known material wins; none, or an unknown one, takes the stock's look", () => {
    const oak = panel();
    expect(realisticDisplay(oak)).toBe(oak.display);
    expect(realisticDisplay(panel({ display: undefined }))).toEqual({ material: "plywood" });
    expect(realisticDisplay(panel({ display: { color: 0x2e8b3d } }))).toEqual({ color: 0x2e8b3d, material: "plywood" });
    expect(realisticDisplay(panel({ display: { material: "birch" } }))).toEqual({ material: "plywood" });
    expect(realisticDisplay(panel({ display: undefined, material: "clear acrylic" }))).toEqual({ material: "clear-acrylic" });
    const block = { views: ["main"], build: () => null };
    expect(realisticDisplay(block)).toBeUndefined();              // not a sheet: still a PLA print
    expect(sheetStockLook(block)).toBeNull();
  });

  test("a default-plywood sheet burns and shows its plies; a default-acrylic one does not burn", () => {
    const ply = panel({ display: undefined });
    expect(burnsFor(ply)).toBe(true);
    expect(sheetFrameFor(ply, P).plies).toBe(3);
    expect(burnsFor(panel({ display: undefined, material: "clear acrylic" }))).toBe(false);
  });
});
```

`test/framework/viewer-realistic.test.js`, append:

```js
// A laser sheet naming no material draws as its stock (sheet-look.js realisticDisplay),
// not as a PLA print — realistic-only: the CAD material is exactly as before.
test("a laser sheet with no material draws its stock's look in realistic; CAD is unchanged", async () => {
  const def = { meta: { title: "t" }, parts: {
    ply: sheetPart({ views: ["main"], material: "birch plywood", thickness: 3, profile: square }),
    acrylic: sheetPart({ views: ["main"], material: "3 mm Perspex", thickness: 3, profile: square }),
    stained: sheetPart({ views: ["main"], display: { color: 0x2e8b3d }, material: "birch plywood", thickness: 3, profile: square }),
  } };
  const v = createViewer(createContainer(), def);
  for (const n of Object.keys(def.parts)) v.setSubGeometry(n, payload());
  v.showAssembly(Object.keys(def.parts), { frame: true });
  const cad = v.__subMesh("ply").material;
  expect(cad.color.getHex()).toBe(0x9fb4cc);
  await v.setRenderMode("realistic");
  expect(v.__subMesh("ply").material.customProgramCacheKey()).toBe("pf-pattern:wood|pf-burn");
  expect(v.__subMesh("ply").material.color.getHex()).toBe(0xffffff);       // the map carries plywood's colour
  expect(v.__subMesh("acrylic").material.transmission).toBe(1);
  expect(v.__subMesh("stained").material.color.getHex()).toBe(0x2e8b3d);   // a bare colour tints the plywood
  await v.setRenderMode("cad");
  expect(v.__subMesh("ply").material).toBe(cad);
  v.dispose();
});
```

`test/framework/mount-realistic.test.js`, append:

```js
test("a laser sheet with no material gets a sheet frame, not a print frame", async () => {
  const part = sheetFixture();
  part.parts.panel = sheetPart({ label: "Panel", views: ["main"], material: "birch plywood",
    thickness: (p) => p.t, profile: (k) => k.shape2d([[0, 0], [30, 0], [30, 30], [0, 30]]), pose: SHEET_POSE });
  const workers = {};
  const runtime = mount(part, {
    createWorker: (name) => (workers[name] = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null }),
    elements: makeElements(),
  });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [payload("panel"), payload("block")], ms: 1 } });
  await runtime.ready;
  await runtime.renderMode.set("realistic");
  expect(printFrameCalls.count).toBe(0);                      // no layer lines: it is no longer PLA
  expect(sheetFrameCalls.count).toBe(1);
  expect(viewers[0].__subMesh("panel").material.userData.patternUniforms.pfPlies.value).toBe(3);
  expect(runtime.declaresMaterials).toBe(true);               // the block names oak — the default never counts
  runtime.dispose();
});
```

(`declaresMaterials` is true here only because of the oak block; the no-material sheet alone would leave it false — covered by the `realisticDisplay` unit test's premise that `sp.display` itself is untouched.)

`test/lint-materials.test.js`, add `import { sheetPart } from "../src/framework/sheet/part.js";` and append (it reuses the file's `goodPart`):

```js
test("an unknown material on a laser sheet names the stock's look the viewer falls back to", () => {
  const part = goodPart();
  part.parts.body = sheetPart({ label: "Body", views: ["main"], display: { material: "birch" }, material: "birch plywood",
    thickness: 3, profile: (k) => k.shape2d([[0, 0], [30, 0], [30, 30], [0, 30]]) });
  const f = lintPart(part).warnings.find((w) => w.rule === "unknown-material");
  expect(f.hint).toContain("`plywood`");
  expect(f.hint).not.toContain("PLA print");
  // an ordinary sub-part keeps the PLA wording
  const plain = goodPart();
  plain.parts.body.display = { material: "birch" };
  expect(lintPart(plain).warnings.find((w) => w.rule === "unknown-material").hint).toContain("a PLA print in realistic mode");
});
```

`test/framework/materials-docs.test.js`, add `import { STOCK_LOOKS, DEFAULT_STOCK_LOOK } from "../../src/framework/materials/sheet-look.js";` and append:

```js
test("the sheet-default table lists every stock word and look", () => {
  expect(section).toContain("**Sheet parts default to their stock.**");
  for (const { look, words } of STOCK_LOOKS) {
    expect(section, look).toContain(`\`${look}\``);
    for (const w of words) expect(section, w).toContain(`\`${w}\``);
  }
  expect(section).toContain(`\`${DEFAULT_STOCK_LOOK}\``);
});
```

`test/framework/material-swatches.test.js`: add `"stock_plywood", "stock_stained"` to `BURNING`.

Run: `$NODE24 npx vitest run test/framework/sheet-look.test.js test/framework/viewer-realistic.test.js test/framework/mount-realistic.test.js test/lint-materials.test.js test/framework/materials-docs.test.js`
Expected: FAIL.

- [ ] **Step 2: The table and `realisticDisplay`**

In `src/framework/materials/sheet-look.js`, add `import { PRESETS } from "./presets.js";`, extend the header comment with one paragraph —

```js
// It also says what a laser sheet part with no usable material looks like: not a PLA print
// (resolve.js's default for every other sub-part) but the sheet its stock label names —
// realisticDisplay, from the ONE keyword table STOCK_LOOKS. Realistic-only, like the PLA
// default: the CAD view, 3MF colours and declaresMaterials read sp.display itself.
```

— replace `const lookOf = (sp) => resolveMaterial(sp.display);` with `const lookOf = (sp) => resolveMaterial(realisticDisplay(sp));`, and append:

```js
// A laser sheet with no usable material takes its look from its stock label: the first row
// whose word the label contains (ignoring case), else DEFAULT_STOCK_LOOK — plywood for
// birch, basswood, poplar, MDF, hardboard, card or anything unlabelled. Only a string label
// is read: a (p, d) function would make a sub-part's look (and its program) depend on the
// params it was first drawn at, so it counts as unlabelled.
export const STOCK_LOOKS = Object.freeze([
  Object.freeze({ look: "clear-acrylic", words: Object.freeze(["acrylic", "perspex", "plexi", "pmma", "polycarbonate"]) }),
]);
export const DEFAULT_STOCK_LOOK = "plywood";

export function stockLook(stock) {
  if (typeof stock !== "string") return DEFAULT_STOCK_LOOK;
  const label = stock.toLowerCase();
  return STOCK_LOOKS.find(({ words }) => words.some((w) => label.includes(w)))?.look ?? DEFAULT_STOCK_LOOK;
}

// The stock's look for a laser sheet part, else null (lint names it in its fallback hint).
export function sheetStockLook(sp) {
  return isSheetPart(sp) && sp.sheet.process === "laser" ? stockLook(sp.sheet.material) : null;
}

// The display realistic mode draws: sp.display itself, except that a laser sheet part
// naming no KNOWN material — none, or one the library does not know, the same "no usable
// material" resolve.js treats as one case — gets its stock's look. A `color` rides along,
// so a bare colour tints that look (stained plywood, coloured acrylic).
export function realisticDisplay(sp) {
  const display = sp?.display;
  const look = sheetStockLook(sp);
  if (!look) return display;
  if (typeof display?.material === "string" && Object.hasOwn(PRESETS, display.material)) return display;
  return { ...(display && typeof display === "object" ? display : {}), material: look };
}
```

- [ ] **Step 3: The two callers and the lint hint**

`src/framework/viewer.js`: change the import to `import { burnsFor, realisticDisplay } from "./materials/sheet-look.js";`, and in `physicalFor` replace `buildPhysicalMaterial(sp.display, …)` with `buildPhysicalMaterial(realisticDisplay(sp), …)` (keeping the options), extending its comment: "realisticDisplay: a laser sheet with no material draws as its stock (sheet-look.js)."

`src/framework/mount.js`: change the import to `import { burnsFor, realisticDisplay, sheetFrameFor } from "./materials/sheet-look.js";`, and in `layerLined` replace `resolveMaterial(part.parts[n].display)` with `resolveMaterial(realisticDisplay(part.parts[n]))`. In the comment above it, change "which includes every sub-part naming no material, since realistic mode shows those as PLA (resolve.js)" to "which includes every sub-part naming no material, since realistic mode shows those as PLA (resolve.js) — except a laser sheet part, which it shows as its stock (sheet-look.js realisticDisplay)".

`src/framework/lint/rules-materials.js`: add `import { sheetStockLook } from "../materials/sheet-look.js";` and in the `unknown-material` rule replace the `run` body with:

```js
    run: ({ part }) => issuesOf(part, "unknown-material").map(({ name, value }) => {
      const near = typeof value === "string" ? suggest(value, listedPresets()) : null;
      // A laser sheet falls back to its stock's look, not to PLA (materials/sheet-look.js).
      const stock = sheetStockLook(part.parts[name]);
      const fallback = stock ? `in realistic mode \`${stock}\`, from its stock label` : "a PLA print in realistic mode";
      return warn("unknown-material",
        `sub-part "${name}" names material ${JSON.stringify(value)}, which is not in the library`,
        `${near ? `Did you mean "${near}"? ` : ""}The viewer draws it as if it named no material instead (${fallback}). Known materials: ${listedPresets().join(", ")}.`,
        `parts.${name}.display.material`);
    }),
```

- [ ] **Step 4: The docs**

In `docs/AUTHORING-PARTS.md` "## Materials and appearance", insert after the bullet list (after the "**One material per sub-part.**" bullet, before "**Where it shows.**"):

```
**Sheet parts default to their stock.** A laser `sheetPart` that names no material (or
one the library does not know) is not drawn as a PLA print: realistic mode shows it as the
sheet its stock label names — the first row whose word the label contains, ignoring case:

| Stock label contains | Realistic look |
| --- | --- |
| `acrylic`, `perspex`, `plexi`, `pmma`, `polycarbonate` | `clear-acrylic` |
| anything else — plywood, birch, basswood, poplar, MDF, hardboard, cardboard — or no readable label | `plywood` |

A `color` then tints that look, as it tints any preset (a stained plywood, a coloured
acrylic); the CAD view still shows the `color` itself. Only a string label is read: a stock
written as a `(p, d)` function counts as unreadable. Name `display.material` to choose the
look yourself. Like the PLA look, this is realistic-only and never makes a part declare a
material.
```

In `AGENTS.md`'s materials paragraph, after "…so its layer lines get a print frame like any PLA part;" add "a laser sheet part is the exception - `sheet-look.js`'s `realisticDisplay` gives it its stock's look (`plywood`, or `clear-acrylic` for acrylic-like stock);".

- [ ] **Step 5: Stock-default swatches**

In `src/parts/material-swatches.js`, append to `LASER_SWATCHES` (and extend the comment above it: "…and one row of sheets that name no material, drawn as their stock (sheet-look.js STOCK_LOOKS)"):

```js
  { key: "stock_plywood", label: "No material, \"birch plywood\" stock", at: [0, CONTROLS_Y - PITCH], t: 3, stock: "birch plywood" },
  { key: "stock_acrylic", label: "No material, \"clear acrylic\" stock", at: [PITCH, CONTROLS_Y - PITCH], t: 3, stock: "clear acrylic" },
  { key: "stock_stained", label: "A bare colour on \"birch plywood\" stock", at: [2 * PITCH, CONTROLS_Y - PITCH], t: 3, stock: "birch plywood", display: { color: 0x2e8b3d } },
```

- [ ] **Step 6: Run, look, commit**

Run: `$NODE24 npx vitest run test/framework/sheet-look.test.js test/framework/viewer-realistic.test.js test/framework/mount-realistic.test.js test/lint-materials.test.js test/framework/materials-docs.test.js test/framework/material-swatches.test.js test/lint-purity.test.js test/sheet-layering.test.js`
Expected: PASS.

`$NODE24 node scripts/capture-contact-sheet.mjs --out "$SHOTS/task6" --envs studio` — the new row: a burnt plywood sheet, a clear acrylic sheet (no burn in the diff), a green-stained burnt plywood sheet.

`$NODE24 npm run lint && $NODE24 npm test` — all green.

```bash
git add src/framework/materials/sheet-look.js src/framework/viewer.js src/framework/mount.js src/framework/lint/rules-materials.js docs/AUTHORING-PARTS.md AGENTS.md src/parts/material-swatches.js test/framework/sheet-look.test.js test/framework/viewer-realistic.test.js test/framework/mount-realistic.test.js test/lint-materials.test.js test/framework/materials-docs.test.js test/framework/material-swatches.test.js
git commit -m "Sheet parts with no material take their stock's look, not a PLA print

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sign-off captures in all four environments

Scott's gate: the look, judged by eye. Code changes here are limited to tuning `BURN` numbers within the calibration floors.

**Files:**
- Possibly modify: `src/framework/materials/sheet-look.js` (`BURN` numbers only)

**Interfaces:**
- Consumes: `scripts/capture-contact-sheet.mjs` (Task 4); the full contact sheet (Tasks 4–6).
- Produces: `$SHOTS/signoff/` — 16 captures (`<env>-<laser|unburnt>-<iso|top>.jpg`) and 8 diffs (`<env>-<iso|top>-diff.png`); a written observation per environment in your report.

- [ ] **Step 1: Capture**

Run: `$NODE24 node scripts/capture-contact-sheet.mjs --out "$SHOTS/signoff"`
Expected: exit 0; 16 JPEGs, 8 PNGs, and a "the burn moved N% of pixels" line per diff.

- [ ] **Step 2: Look at every image and check, per environment (studio, workshop, print-bed, outdoor)**

1. At 3 mm, plywood, oak AND walnut edges are clearly darker than the same edges in the unburnt capture (and bright in the diff).
2. 9 mm edges are darker than 3 mm edges, in every wood.
3. The engraved numbers are legible on every wood; the score lines show.
4. Plywood's walls show plies — 3, 5, 7 bands at 3, 6, 9 mm — through the char, without shimmer or moiré.
5. The diff is BLACK on every laser face and back, on the acrylic sheets and on the non-sheet oak block.
6. Walnut's char is matte; its faces keep their lacquer.
7. The standing panel's edges are charred and its face is not.
8. The stained sheet chars darker than its green face.

- [ ] **Step 3: Tune only if a check fails**

If a check fails on colour (not on classification — a lit face in the diff is a bug: stop and report), adjust `BURN.kThin`/`kThick`/`exit`/`crossPly`/`roughness` in `sheet-look.js`, run `$NODE24 npx vitest run test/framework/sheet-look.test.js test/framework/materials-patterns.test.js` (the calibration floors must still pass — never lower them), and re-capture. Commit any tuning:

```bash
git add src/framework/materials/sheet-look.js
git commit -m "Tune the laser burn by eye in all four environments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand off**

Report the `$SHOTS/signoff` path, the eight diff percentages, one line per environment against the checklist, and any tuning (old → new numbers). The controller shows Scott; his changes become a follow-up task, not part of this one.

---

### Task 8: Docs, the laser box, and 0.135.0

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` ("## Materials and appearance": the Laser-cut wood paragraph; "## Sheet parts": the worked example)
- Modify: `src/parts/laser-box.js`
- Modify: `package.json`, `package-lock.json`
- Test: `test/framework/materials-docs.test.js`, `test/sheet-docs.test.js` (unchanged — must still pass)

**Interfaces:**
- Consumes: everything above.
- Produces: the documented rule; `laser-box.js` in `plywood`; version `0.135.0`.

- [ ] **Step 1: Write the failing docs test**

Append to `test/framework/materials-docs.test.js`:

```js
test("the Laser-cut wood paragraph says who burns, that nothing is set, and when it does not", () => {
  const i = section.indexOf("**Laser-cut wood.**");
  expect(i).toBeGreaterThan(-1);
  const para = section.slice(i, section.indexOf("\n\n", i));
  for (const s of ["`sheetPart`", "`plywood`", "`oak`", "`walnut`", "realistic", "nothing to set", "custom `build`", "own `place`", "CAD"]) {
    expect(para, s).toContain(s);
  }
});
```

Run: `$NODE24 npx vitest run test/framework/materials-docs.test.js` — Expected: FAIL.

- [ ] **Step 2: The paragraph**

In "## Materials and appearance", after the "**3D-print layer lines**" paragraph and before the "**`textureScale` is millimetres…**" paragraph, insert:

```
**Laser-cut wood.** In realistic mode a laser `sheetPart` in a wood — `plywood`, `oak` or
`walnut` — shows what the laser did: its cut edges are charred, darker on thicker stock (on
`plywood` the plies show through), and its engraving and score lines are scorched, while its
faces stay wood. There is nothing to set, and it is still one material: the char follows
from the sheet and the material it names. It needs the sheet's own frame, so a sheet part
with a custom `build` or its own `place` shows plain wood. The CAD view and every export are
unchanged.
```

- [ ] **Step 3: The laser box, in both copies**

Measure the Sheet parts section first:

```bash
$NODE24 node -e 'const d=require("fs").readFileSync("docs/AUTHORING-PARTS.md","utf8");const a=d.indexOf("\n## Sheet parts\n"),b=d.indexOf("\n## ",a+1),s=d.slice(a+1,b);const i=s.indexOf("\n### The kit\n"),j=s.indexOf("\n### ",i+1);console.log(s.length, s.length-(i<0?0:s.slice(i,j<0?undefined:j).length))'
```

Expected: `15906 15345` (caps 16,000 and 15,350).

In `src/parts/laser-box.js` AND in the guide's "### Worked example: laser-box.js" copy, change `display: { material: "oak" }` to `display: { material: "plywood" }` (the `const PLY = …` line — the only occurrence in each). Re-run the measurement: expected `15910 15349`. If the second number exceeds 15,350 (a rebase moved the section), shorten the section's PROSE — never the example — by the overflow, e.g. "Mixing is normal — plywood panels, printed hinges." → "Mixing is fine — plywood panels, printed hinges." (−2), and say so in the commit message.

- [ ] **Step 4: 0.135.0**

Run: `$NODE24 npm version 0.135.0 --no-git-tag-version --ignore-scripts`
Then `grep -n '"version": "0.13' package.json package-lock.json | head -3` must show `0.135.0` for `package.json` and BOTH lockfile fields (the top-level `version` and `packages[""].version`).

- [ ] **Step 5: Everything**

```bash
$NODE24 npx vitest run test/framework/materials-docs.test.js test/sheet-docs.test.js test/laser-box.test.js test/kit-docs.test.js
$NODE24 npm run typecheck && $NODE24 npm run lint && $NODE24 npm run lint:dead
$NODE24 npm test
CHECK_PORT=5192 $NODE24 node scripts/check-app.mjs materials.html
```

All green (the smoke check boots the contact sheet in CAD with no console errors).

- [ ] **Step 6: Commit**

```bash
git add docs/AUTHORING-PARTS.md src/parts/laser-box.js package.json package-lock.json test/framework/materials-docs.test.js
git commit -m "Docs for laser-cut wood; the laser box in plywood; 0.135.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review (planner)

- **Spec coverage.** Decision 1 → Tasks 1 (frame from data, `place`/`generatedPlace`, author place → plain wood, per-sub-part gate), 2 (relative char, k ramp, engrave −0.1, exit gradient, no noise, clearcoat, normal fade, injection points against the real ShaderLib, byte-identity of plain programs, same-pixel calibration incl. walnut), 3 (gate in `physicalFor`, lazy channel), 8 (docs). Decision 2 → Task 6 (one table in one module, docs, bare `color`, unknown material, lint hint, mount's print frames). Decision 3 → Task 5 (preset, texture (a)/(b), SOURCES row, size budget, plies 3/5/7, docs 24 → 25, calibration adds plywood) and Task 8 (laser-box + guide copy, both caps measured, fallback trim named). Decision 4 → Tasks 4 (Laser-cut view with every listed swatch, unburnt twin for the same-pixel diff, first browser compile) and 7 (four environments). Decision 5 → Task 8.
- **Placeholders.** None, except values measured at execution time and stated as such: the plywood colour average (Task 5 Step 3 prints it; (b) ≈ `0xe1c2a3`), and on path (a) the set name, `roughnessMean`, `grain` and `textureScale`.
- **Names.** `BURN`, `plyCount`, `burnsFor`, `sheetFrameFor`, `classifySheetSurface` (T1); `srgbToLinear`, `burnAlbedo`, `applyBurn`, `buildPhysicalMaterial(…, { burn })` (T2); `setFrameSource`, `invalidateFrames`, `setSheetFrames`, `setPrintFrames` (T3); `LASER_SWATCHES`, `laser_*`/`unburnt_*`, `scripts/capture-contact-sheet.mjs` (T4); `laminated`, `pattern-plywood-color.jpg` (T5); `STOCK_LOOKS`, `DEFAULT_STOCK_LOOK`, `stockLook`, `sheetStockLook`, `realisticDisplay` (T6) — each defined before use, spelled the same in every task.
- **Independence.** The burn works on oak and walnut after Task 3 and is seen in a browser in Task 4; the texture task (5) blocks none of it and never waits on a download.
