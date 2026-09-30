# Laser-cut wood shows its burns — design

**Date:** 2026-09-30 · **Ships as:** partforge 0.135.0, stacked on `claude/sheet-parts-kit`
(PR #237, 0.134.0) · **Plan:** `docs/superpowers/plans/2026-09-30-laser-burn-edges.md`

## Summary

In realistic mode a laser-cut `sheetPart` in a wood now looks laser-cut: its cut edges are
charred, its engraving and score lines are scorched, and its faces stay wood. Nothing new is
written by an author to get it — the burn follows from data the agent already writes (a laser
sheet part and a wood material). Two companions ship with it:

- **A sheet part with no material stops looking 3D-printed.** Today it renders as a PLA print
  with layer lines. It now takes its look from its stock label: acrylic-like stock renders as
  `clear-acrylic`, everything else as the new `plywood`.
- **A real `plywood` preset** ("Birch plywood"): a pale birch face, and ply layers on its cut
  edges, showing through the char at the right count for the sheet's thickness.

CAD mode, every export, thumbnails and every non-sheet part are unchanged. The design is the
critique's "B-lite": the approved approach B (derived, no vocabulary) with the frame taken from
data instead of a pose probe, char defined relative to the face, no striation noise, and the
pass compiled only into qualifying sheets.

## Decisions (binding, from Scott)

1. **Derived, no new author vocabulary for the burn.** A laser sheet part (`sp.sheet.process ===
   "laser"`, its own generated build) whose realistic material is a wood-pattern preset shows
   charred cut edges and scorched engrave/score floors in REALISTIC mode only. CAD mode, exports
   and every non-sheet part are unchanged; non-sheet wood shader programs are byte-identical.
   Frame from data — `invertRigid(composePose(poseSteps(pose(p, d), t)))`, identity with no
   pose — with no pose probe. The frozen sheet record gains an internal `place` so an author
   `place` is distinguishable; a sheet with an author `place` shows plain wood. Char relative to
   the face colour: edge = mix(tinted face average, charcoal ≈ `#262220`, k), k ≈ 0.55 at ≤ 3 mm
   → ≈ 0.85 at ≥ 9 mm, engrave ≈ 0.1 less; a cheap exit-side gradient; no striation noise;
   clearcoat off on char; the wood normal faded to the geometric normal on char. The pass is
   gated per sub-part. The burn must be clearly visible on oak, walnut and plywood at 3 mm,
   judged by a same-pixel burn-on vs burn-off comparison, never wall vs face.
2. **Default material for sheet parts.** A laser sheet part with no `display.material` derives
   its realistic look from its stock string with one keyword table in one module: acrylic-like
   (`acrylic`, `perspex`, `plexi`, `pmma`, `polycarbonate`) → `clear-acrylic`; everything else
   → `plywood`. Documented in "## Materials and appearance". An explicit `display.material`
   wins; a bare `display.color` gives tinted plywood, not PLA.
3. **A real `plywood` preset now.** Id `plywood`, label "Birch plywood", category `natural`:
   pale birch face, fine grain, ply bands on cut edges under the char (3 mm → 3 plies, 6 → 5,
   9 → 7). Texture: an approved CC0 set, or the stated fallback (oak's scan re-tinted to birch,
   finer `textureScale`). `laser-box.js` switches `"oak"` → `"plywood"`; the guide's byte-pinned
   copy follows. The preset table grows 24 → 25.
4. **Sign-off by eye.** A "Laser-cut" view in the materials contact sheet, captured in all four
   environments for Scott. No GPU pixel-test infrastructure beyond an optional burn-on vs
   burn-off diff.
5. **Ship** as 0.135.0 (`package.json` and both `package-lock.json` fields), in the last task.

## What changes for an author

One new name: the preset id **`plywood`**. `display` keys stay at 9 and `sheetPart` keys at 7.
Nothing is retired. The laser box's panels switch to `display: { material: "plywood" }`.

Two looks change without an edit, both realistic-only and both documented:

- a laser sheet part in `oak`, `walnut` or `plywood` shows burns;
- a laser sheet part naming no material (or an unknown one) shows its stock's look instead of
  PLA.

## Design

### 1. Who burns — `burnsFor(sp)`, static per sub-part

A pure predicate in the new `src/framework/materials/sheet-look.js` (three-free, DOM-free, beside
`resolve.js` and `print-frame.js`). True when ALL of these hold:

- `isSheetPart(sp)` and `sp.sheet.process === "laser"`;
- `sp.build === sp.sheet.generatedBuild` — a custom build's geometry is not the canonical sheet;
- `sp.sheet.place == null` — no author `place` (decision 1: plain wood);
- `(sp.place ?? null) === (sp.sheet.generatedPlace ?? null)` — the `place` sheetPart installed
  was not replaced afterwards (the `generatedBuild` idiom, for `place`);
- the sub-part's realistic material has `pattern === "wood"` (oak, walnut, plywood — and any
  future wood-pattern preset).

It reads no params, so it is decided once per sub-part: the viewer uses it to choose the
PROGRAM (burning or plain) when it first builds a sub-part's physical material, and mount uses it
to choose which sub-parts need a frame. Qualification never depends on timing or on which
delivery arrived first.

### 2. The sheet frame, from data — `sheetFrameFor(sp, { p, d })`

The shader classifies surfaces in the sheet's CANONICAL frame: profile in XY, material over
z ∈ [0, t], laser face at z = t. The viewer's mesh is the DELIVERED display mesh, in the part's
object space. The frame maps one to the other.

Why it can be computed from data, exactly: `sheetPart`'s generated `place` is
`applyPose(solid, pose, t)` — the rigid steps `poseSteps(pose, t)` and nothing else — when the
author adds no `place` of their own (`test/laser-box.test.js` already pins
`probe(display).pose === poseSteps(pose, t)` for every panel). With no pose there is no place at
all. So the delivered mesh is `composePose(poseSteps(pose, t)) · canonical`, and

```
frame = pose == null ? I : invertRigid(composePose(poseSteps(pose, t)))
```

evaluated at the delivery's params (`pose` may be a `(p, d)` function; `t` is `sheetMeta`'s
thickness). No probe runs, so a label centred by its bounding box (which poisons probe trust)
still burns; and because an author `place` disqualifies the sub-part, a mirroring `place` (the
critique's frame bug) can never hand the shader a wrong frame. `sheetFrameFor` returns
`{ frame: number[16], t, plies }` or `null` (not burning, or a field that throws or is invalid).
`plies` is `plyCount(t)` when the realistic material's preset is `laminated` (plywood), else 0.

**The sheet record gains two internal fields** (`sheet/part.js`, `types/part.d.ts`
`SheetDeclaration`): `place` — the author's own `place` from the spec, or `null`, beside `pose`;
and `generatedPlace` — the `place` sheetPart installed as `sp.place` (pose, then the author's),
or `null`, beside `generatedBuild`. Neither is documented to authors; the declaration is "never
written by hand".

A pose-only edit re-poses the delivered mesh through the mesh's object matrix (the pose fast
path), never its positions, so a frame recorded at a delivery stays correct until the next
delivery — the print-frame argument, unchanged.

### 3. The burn pass — `applyBurn(material, { faceAvg })` in `patterns.js`

`patterns.js` stays the one shader-injection module. `applyBurn` composes on top of the wood pass
the way `applyBrushFrame` does (it calls the previous `onBeforeCompile`, appends `|pf-burn` to the
program cache key) and adds its uniforms INTO `material.userData.patternUniforms`, so
`cloneKeepsPattern`'s cutaway and fade clones share them. It is a no-op on anything but a wood
pattern.

**Uniforms:** `pfSheetFrame` (mat4, identity), `pfSheetT` (mm; 0 = no frame yet, draws plain
wood), `pfPlies` (0 = no bands), `pfFaceAvg` (the preset's texture-average colour, linear).

**Classification**, per fragment, in canonical space (`c = pfSheetFrame · vPfObjPos`,
`n = mat3(pfSheetFrame) · vPfObjNormal`):

- wall: `1 − smoothstep(0.35, 0.65, |n.z|)` — cut edges, hole walls, the walls of marks;
- floor: `n.z > 0.5` and `c.z ≤ t − MARK_DEPTH / 2` — engrave and score floors (the preview
  cuts them `MARK_DEPTH` = 0.2 mm deep);
- everything else (the laser face at z = t, the back at z = 0) stays wood.

Creased normals are hard at the 90° arris, so the split falls exactly on the geometry.

**Colour — char relative to the face** (all in linear RGB):

```
face  = diffuse · pfFaceAvg                       (the tinted face's average colour)
char  = CHARCOAL · min(1, 0.5 · Y(face) / Y(CHARCOAL))     CHARCOAL = #262220
k     = mix(0.55, 0.85, clamp((t − 3) / 6, 0, 1))
edge  = mix(face, char, min(1, k + 0.1 · (1 − z/t)))       (exit side, z = 0, a little darker)
mark  = mix(face, char, k − 0.1)                           (engrave / score floors)
```

The `min(1, …)` scale is an addition to decision 1's formula and fixes the critique's
dark-tint problem: when a face is darker than twice charcoal's luminance, the char target is
scaled down (neutral, to half the face's luminance) instead of being lighter than the face — so
char is always darker than its own face — while every preset face, walnut included, is bright
enough to keep plain charcoal. No noise term at all.

**Plies** (plywood): on walls, `edge *= mix(1, 0.78, crossPly(z/t · plies))`, where `crossPly`
is the square wave "1 on an odd ply" box-filtered over the pixel (its integral differenced across
`fwidth`), so bands too thin to draw average out instead of shimmering. With an odd ply count
both outer plies are face-grain. The bands multiply the char, so they stay visible under it.

**Roughness** mixes to 0.85 on walls and floors. **Normal:** `normal = normalize(mix(normal,
nonPerturbedNormal, max(wall, floor)))` — char has no grain. **Clearcoat:** `material.clearcoat
*= 1 − max(wall, floor)` — walnut's lacquer comes off the char.

**Injection points**, verified against three 0.184's meshphysical fragment order
(`roughnessmap → metalnessmap → normal_fragment_begin → normal_fragment_maps → clearcoat normals
→ emissivemap → lights_physical`):

| Snippet | Where | Why there |
|---|---|---|
| declarations | after `#include <common>` | uniforms and the `crossPly` helpers |
| colour + roughness | before `#include <normal_fragment_begin>` | after wood's body (injected after `roughnessmap_fragment`) and `metalnessmap_fragment`; a second `.replace` of `roughnessmap_fragment` would land IN FRONT of wood's body. Declares `pfBurnWall` / `pfBurnFloor` at `main()` scope (the `pfLayer` precedent) for the two below |
| normal fade | before `#include <emissivemap_fragment>` | after wood's normal (`normal_fragment_maps`) and the clearcoat normals; `nonPerturbedNormal` is in scope |
| clearcoat | after `#include <lights_physical_fragment>` | where `material.clearcoat` is assigned; guarded by `#ifdef USE_CLEARCOAT` |

Every snippet sits between `// pf-burn {` and `// } pf-burn` lines. That is what lets a test
prove a burning program is exactly the plain wood program plus those blocks, and the vertex shader
is untouched (the pass reads the varyings every pattern already has).

**One statement of the numbers.** `BURN` in `sheet-look.js` holds every threshold and colour
constant; `patterns.js` templates the GLSL from it, and two JS twins read the same object:
`classifySheetSurface(pos, normal, t)` (the classification, which the frame test holds real
geometry to) and `burnAlbedo(face, t, { kind, zFrac })` (the colour, which the calibration test
holds to a visibility floor). The twins share the numbers, not the code, so they prove the frame
math and the calibration — the shader's own correctness is proved by eye.

### 4. Plumbing — one lazy frame channel, one per-sub-part gate

- **viewer.js.** The existing lazy channel is generalized instead of adding a second:
  `setPrintFrameSource` / `invalidatePrintFrames` / `syncPrintFrames` become `setFrameSource` /
  `invalidateFrames` / `syncFrames`, and the source returns `{ print, sheet }`. The same two
  doors pull it (`enterRealistic`, `compileRealistic`), so a CAD-only session computes nothing.
  `setSheetFrames(frames)` writes `pfSheetFrame` / `pfSheetT` / `pfPlies` into every cached
  physical material that has them; `physicalFor(name)` passes `burn: burnsFor(sp)` to
  `buildPhysicalMaterial` and seeds a new material from the last sheet frames, as it seeds
  `printFrame`. CAD materials are never touched.
- **physical.js.** `buildPhysicalMaterial(display, { printFrame, loadTexture, burn })` —
  `burn: true` applies `applyBurn` (before the brush frame) with the preset's own `color` as
  `faceAvg`. Nothing else calls it with `burn`.
- **mount.js.** Beside `layerLined`, a `burning` set (`burnsFor`). Deliveries record either kind
  in the one `undrawnFrames` snapshot; `computeFrames()` resolves params once per delivery and
  fills both maps. A sub-part can never be in both (layer lines vs wood).

### 5. The sheet default look — `realisticDisplay(sp)`

One keyword table, `STOCK_LOOKS`, in `sheet-look.js`:

| Stock label contains (case-insensitive) | Realistic look |
|---|---|
| `acrylic`, `perspex`, `plexi`, `pmma`, `polycarbonate` | `clear-acrylic` |
| anything else — plywood, birch, basswood, poplar, MDF, hardboard, wood, cardboard — or no readable label | `plywood` (`DEFAULT_STOCK_LOOK`) |

`realisticDisplay(sp)` is the display realistic mode draws:

- not a laser sheet part → `sp.display`, untouched;
- a laser sheet part naming a KNOWN material → `sp.display`, untouched (explicit wins);
- a laser sheet part with no usable material — none, or one the library does not know (the
  same "no usable material" `resolve.js` already treats as one case) → `{ ...sp.display,
  material: stockLook(sp.sheet.material) }`.

So a bare `display.color` tints the stock's look exactly as `color` tints any preset — stained
plywood, coloured acrylic — and the CAD view still shows the colour itself. The stock label is
read only when it is a string: a label written as a `(p, d)` function counts as unreadable
(plywood). The look is fixed per sub-part, as `display.material` is; evaluating a function label
at some params would make a sub-part's program depend on which params it was first drawn at.

Unchanged: `cadAppearance`, `printColor` (3MF), `declaresMaterials` (the default never makes a
part "declare" a material), the kit. Callers: the viewer's `physicalFor`, mount's `layerLined`
(so a no-material sheet no longer gets a print frame), and `burnsFor`/`sheetFrameFor` (so a
default-plywood sheet burns). The `unknown-material` lint hint names the sheet's actual fallback
instead of "a PLA print".

### 6. The `plywood` preset

```
plywood: P("plywood", "Birch plywood", "natural", "…", { color: <map average>, metalness: 0,
  roughness: 0.6, pattern: "wood", textureScale: 150, laminated: true, textures: { … } })
```

Not tintable (like oak and walnut; it still accepts a tint). `laminated` is an internal field
(like `grain` and `roughnessMean`): it asks the burn pass for ply bands, at
`plyCount(t)` — < 4.5 mm → 3, < 7.5 → 5, < 10.5 → 7, else 9 — which is 3 → 3, 6 → 5, 9 → 7.

**Texture.** (a) An approved CC0 set (candidate: ambientCG Wood087/088/089), processed with
`scripts/bake-environments.mjs` into `pattern-plywood-{color,normal,rough}.jpg`, each under
`test/framework/materials-assets.test.js`'s 400 KB, with a `SOURCES.md` row per file — only if
its colour map shows a birch FACE (long-grain veneer): a side/edge view with ply stripes cannot
be the face, since plies are drawn procedurally at the sheet's real count. (b) Fallback, if
approval is not given: `pattern-plywood-color.jpg` baked from the committed
`pattern-oak-color.jpg` (no download) with `--modulate 1.45,0.75 --flatten 0.7` (a pale birch,
≈ `#e1c2a3`, softer grain), reusing oak's normal and roughness maps, `grain: "v"`, and a finer
`textureScale` (150 against oak's 250).

**Docs:** one row in the preset table (24 documented ids → 25) and `plywood` in the wood row of
the `textureScale` table.

### 7. `laser-box.js` and the Sheet parts cap

`const PLY = { …, display: { material: "plywood" }, … }` (was `"oak"`) — +4 characters, in
`laser-box.js` and in its byte-pinned copy in the guide. `test/sheet-docs.test.js` has two caps;
measured on this branch: the section is 15,906 / 16,000 and 15,345 / 15,350 excluding "The kit",
so +4 leaves 1 character under the binding cap. Nothing else in the Sheet parts section changes.

### 8. Verification

- **Frame math against real geometry** (`test/framework/sheet-look.test.js`): every laser-box
  panel is built posed (as delivered) and flat (sheetPart's own build) with the Manifold kernel;
  the frame must map the posed mesh onto the flat one — the class histogram (walls; faces,
  backs and floors by height) must be identical — and the front panel's label and score show as
  floors at `t − MARK_DEPTH`. Plus the null cases: non-sheet oak, acrylic, PLA, custom build,
  author place (plain and mirrored), replaced place, hand-written declaration, unreadable pose
  or thickness.
- **Calibration, same pixel, burn on vs off**: at the albedo level the two differ only by the
  burn (lighting cancels on the diffuse term), so `burnAlbedo` is held to a visibility floor for
  each wood at 3 mm, at the lightest point of a wall: edge ΔE76 ≥ 12 and luminance ≤ 0.7 × face;
  engrave floor ΔE76 ≥ 10 and luminance ≤ 0.8 × face. Also: thicker is darker, the exit side is
  darker, char is darker than its face under any tint, char never goes below its floor.
  (Walnut is the binding case: ΔE 13.7, ratio 0.68 at k = 0.55.)
- **Shader structure against three's real source** (`THREE.ShaderLib.physical`): the injection
  order above; the burning program minus its `pf-burn` blocks equals the plain wood program line
  for line; identical vertex shaders; cache keys `pf-pattern:wood` vs `pf-pattern:wood|pf-burn`
  (and `…|pf-burn|pf-brush` with an anisotropy override); the uniforms in `patternUniforms` with
  `pfSheetT = 0`; a no-op on non-wood.
- **Wiring**: a burning sheet's frame reaches its material and the cutaway/fade clones; a
  non-sheet oak sub-part keeps the plain program; CAD-only sessions never compute a sheet frame;
  entering realistic computes each once.
- **By eye** — the materials contact sheet gains two views built from one swatch list:
  **"Laser-cut"** (plywood, oak and walnut sheets at 3/6/9 mm, each 30 × 30 with a cut hole, an
  engraved label and a score line; an oak panel standing on edge; a clear-acrylic sheet; a
  non-sheet oak block; the stock-default swatches) and **"Laser-cut, unburnt"**, its twin — the
  same swatches with an identity author `place`, which by the rule above shows plain wood. Same
  geometry, same place, same material: the two render identically except for the burn.
  `scripts/capture-contact-sheet.mjs` (a committed dev tool, not a test) renders both views in
  realistic mode in every environment and writes an amplified |burnt − unburnt| image per
  environment — the burn's exact footprint, pixel for pixel, with lighting cancelled: walls,
  engravings and scores light up; faces, the acrylic sheet and the non-sheet block stay black.
  It fails on any console error, which is how a GLSL compile error surfaces. The final capture in
  all four environments is Scott's sign-off.
- The two contact-sheet views are excluded from `test/verify-golden.test.js` (a sheet's laser
  checks run on a real clock, so their verdict is machine-dependent; the page is for judging by
  eye and has no verdict to guard).

### 9. Docs

"## Materials and appearance" (no size cap) gains: a **"Sheet parts default to their stock"**
paragraph with the `STOCK_LOOKS` table and what a bare `color` does; a **"Laser-cut wood"**
paragraph — laser sheet parts in a wood char at their cut edges and scorch their marks, darker on
thicker stock, plies showing on `plywood`; nothing to set and still one material; a custom
`build` or an own `place` shows plain wood; CAD and exports unchanged — and the `plywood` rows.
The "## Sheet parts" section changes by the example's four characters only. `AGENTS.md`'s
materials paragraph learns `sheet-look.js`, the renamed frame channel and the contact sheet's
laser views.

## What does not change

CAD mode (materials, colours, feature lines); every export (STL, STEP, 3MF colours, the cut kit's
SVG/DXF, README and parts.csv); checkpoint thumbnails and agent CAD renders; the software
rasterizer; `declaresMaterials`; `measure`/`verify`; the program of every sub-part that does not
qualify — non-sheet wood (e.g. `hinged-box.js`'s walnut) included.

## Residuals (accepted)

- A sheet part with an author `place` — including a mirrored "left from right" panel — or a
  custom build shows plain wood.
- A stock label computed by a function reads as unlabelled: plywood.
- MDF, hardboard and card render as `plywood` (with ply bands) until the library has their looks.
- Coloured acrylic stock ("black acrylic") renders clear unless `display.color` tints it.
- Before its first delivery a burning sub-part draws plain wood (`pfSheetT = 0`).
- Score grooves are drawn at their real 0.3 mm width: near-invisible at whole-part scale.
- Char is one uniform colour per surface (no smoke halo, no darker corners, no honeycomb marks).
- The ply count is a step table, not a measurement.
- 3MF carries the face average; the burn is realistic-only.
- On partforge-cloud's server laps the viewer is CAD-only, so an agent's realistic render there
  shows no burn.

## Out of scope

Smoke halos; darker corners and small holes; glue lines; acrylic flame-polished or frosted edges
(the channel admits a later record); burns in CAD, thumbnails, the rasterizer or any export;
custom builds; a lint rule for a no-material sheet; the STEP red-colour bug (separate ticket).

## Cloud follow-up (not this PR)

Bump the pin to `^0.135.0` and run `npm run docs:generate && npm run prompt:generate`. The corpus
diff is the Materials topic (the two paragraphs, the table, the `plywood` rows) and the Sheet
parts topic's example (`"oak"` → `"plywood"`). `render_part_views` with `appearance:
"realistic"` shows burns on browser laps. Below the new floor everything degrades to today's
look, so an AGENTS floor line is informational only.
