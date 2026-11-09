# Cel shading: a third render mode with a sci-fi anime look

Date: 2026-11-07. Repo: `partforge` (the three.js viewer, the View style
popover, captures, the preview). Status: look approved from a live spike
(`src/spike/cel.js`, throwaway, dialled in on robot-arm / gearbox / hinged-box
/ hand); design awaiting review.

## Why

The viewer has two looks: CAD (the drafting view, blue-grey under three
lights, feature edges, a grid) and realistic (physical materials under a
photographed environment). Both are literal. A part shown to other people, on
a forge's page, in a card or a shared capture, often wants a third register:
stylised, graphic, obviously a picture rather than a measurement. The
reference the user brought is sci-fi anime: flat colour in two or three
steps, cool shadows, dark ink outlines, a flat pale-cyan field with a faint
halftone screen.

The spike proved the look is reachable with the viewer's own pieces (one
shader material per sub-part, one screen-space ink pass, one shadow-casting
light) and that the kernel's feature edges read well as the thin interior
line. The constants below are the ones the user dialled in on real parts.

## What the user gets

- **A third tile in the View style popover: "Cel".** Beside CAD and the four
  realistic environments. Choosing it switches the live view; it persists like
  the other two (local storage on a part page, `viewerState.renderMode` for a
  host that remounts) and shows a live thumbnail of this part like the other
  tiles.
- **The look.** Every sub-part drawn flat in three bands (lit, shadow, deep
  shadow) in its own colour, the shadow tone pulled toward a cool blue-grey, a
  hard-edged highlight, a pale rim on the shadow side. Dark ink: a thick line
  on every silhouette and wherever one piece sits in front of another,
  thicker still against the background; a thin line on creases; the kernel's
  feature edges as a lighter thin line. A flat pale-cyan field with a faint
  halftone screen and no grid. A soft shadow on the ground under the part,
  cast from the key light, that follows a pose drag and a playing animation.
- **Everything else keeps working in it.** Orbit, the view cube, measure,
  sketch, cutaway, pose handles, hover and selection highlight, hide /
  see-through, animations, the preview's turntable and autoplay.
- **It carries into captures that follow the live look.** `captureCurrent`
  follows the live view, so a host's "capture from viewer" gets the cel look
  when the user is in it; `renderViews(views, { renderMode: "cel" })` renders
  the canonical angles in it on request; `mountPreview({ renderMode: "cel" })`
  opens a cached preview in it. Agent renders (`captureViews`, the CLI's
  `render`) stay CAD, exactly as they do in realistic mode.

## Decisions

1. **Cel is a render mode, not an environment.** `RenderMode` becomes
   `"cad" | "realistic" | "cel"`. It is a different way of drawing the same
   materials, so it sits beside realistic, not inside it; `styleFor` maps it
   to the `cel` tile. The environment id is untouched by choosing it (a user
   who goes CAD → cel → realistic lands in the environment they had).
2. **Colour comes from the sub-part's own appearance, nothing new to author.**
   The base tone is the effective display colour the CAD view already resolves
   (`cadAppearance(display).color`: the authored or user-picked `color`,
   else — new, cel only — the cel body white `#eef1f4` rather than the CAD
   blue-grey, so an uncoloured part reads as the reference's white armour).
   Shadow and deep-shadow tones are DERIVED from the base (below), never
   authored. Preset metalness, roughness, textures and finish overrides do
   not change the cel look; `opacity` does (a ghost is a see-through flat
   fill). The spike's hand-assigned "sci-fi" roles (body / accent / dark per
   sub-part) are not a product feature: an author who wants a red gripper
   colours the gripper.
3. **The frame is fixed, except the field's colour, and the ground shadow's, follow the theme**
   (amended 2026-11-08; 0.186.0 shipped one field). The halftone's strength
   and cell and the ink colour are part of the style; the field is
   `CEL.field.color` (pale cyan) in the light theme and `CEL.field.darkColor`
   (a slate) in the dark theme, with the halftone dot darkened on the light
   field and lightened on the dark one (`celField(theme)`), and the ink stays
   dark on both — the dark field is chosen light enough for the outer
   contour to read on it. `meta.background` is still ignored. A
   `transparent` viewer (the preview's `background: "transparent"`) in cel
   draws no field and no halftone; the part, its ink and its ground shadow
   draw over the host page.
4. **The key light is camera-relative in a capture and world-fixed on the
   canvas** (amended 2026-11-08; shipped camera-relative everywhere in
   0.186.0). The direction is azimuth −35°, elevation 38° in view space, as
   in the spike: the lit side up-left of the viewer, the way a drawn figure
   is lit, and the ground shadow falling down-right from it. Held in view
   space on the live canvas it turned with the camera, and an orbit swept the
   band edges across the part — every face flipped tone as it crossed one,
   which read as unstable shading. So the LIVE view reads that view-space
   direction once at the viewer's DEFAULT camera pose (`CEL.light.at`:
   position (18, 12, 18) looking at the origin, about 25° up) and holds the
   resulting WORLD direction still (`celLightWorld`), the way CAD's live key
   is world-fixed: a face keeps its tone through an orbit, and the default
   framing looks exactly as before. The pose matters: read at a pure iso
   (35° up) the world key steepens to 61° and a box's front face drops just
   under the lit band, so every wall sat in the cool shadow and the base
   colour showed only on top faces, reading as an added highlight. Orbit far enough and the shadow side
   faces the viewer, the cost CAD already pays. Every capture (canonical
   views, `captureCurrent`, the popover thumbnails) keeps the camera-relative
   key, so each canonical view is lit the same way — CAD's capture lights do
   the same swap. The band shaders light by ONE shared uniform
   (`aimCelLight` / `restCelLight`), re-aimed per frame in
   `prepareCelGround` by whether a render target is bound. **The ground
   light follows the key** (same azimuth, 60° elevation: in world space on the
   canvas, `celGroundLightWorld`; in view space in a capture), so the shadow
   always falls away from the lit side; a ground light in the other frame
   would put the shadow under the lit side at some angles, which reads wrong.
   The shadow map still re-renders every frame (three's default), so the
   moving / settled map-size schedule (Performance, below) stays; skipping
   the re-render on camera-only frames, now that the live shadow holds
   still, is a follow-up. *Reviewer's question; my call.* At steep cameras
   the light's WORLD elevation is clamped to at least 40° (a top view would
   otherwise drop a camera-relative light to ~24° and throw a tall part's
   shadow off the plane); from below the floor the plane is single-sided and
   simply not drawn.
5. **The ground shadow is live, and it is in captures.** A shadow-map light
   and a shadow-only plane, blurred (three's VSM shadow maps), so a posed
   piece casts where it is now. It is part of the look, so `captureCurrent`,
   `renderViews` and the popover thumbnail include it, as realistic's contact
   shadow is included in theirs (the spike hid it from captures only because
   it never implemented them). It replaces the CAD contact shadow
   (`contactShadow` option) while cel is on; realistic's baked contact shadow
   is unrelated. The floor is placed by the rules realistic's ground already
   follows (on `showAssembly` and on entering the mode; held — never slid,
   only lowered — while an animation drives the part).
6. **Ink is screen-space, from the sub-parts alone.** A prepass renders every
   visible sub-part's normals and depth (the cutaway's clipping applied, caps
   included); the ink shader finds depth discontinuities (thick) and normal
   disagreement (thin), the outer contour is boosted; the halftone is drawn on
   field pixels in the same pass. Overlays (dimensions, handles, the gizmo,
   the hover highlight mesh, the grid) are never in the prepass, so they are
   neither inked nor occlude ink.
7. **Captures through the one render chokepoint.** The ink pass runs
   wherever the live scene is rendered — the canvas and `renderOffscreen` —
   so `captureCurrent`, `renderViews` and the popover thumbnail get cel
   without a second code path. Throwaway scenes (the appearance card's sphere
   tiles, `renderMeshPayloads`) stay CAD.
8. **Captures are opt-in exactly as realistic is.** `captureViews` and the
   CLI never change. `captureCurrent` follows the live mode and accepts
   `{ renderMode: "cel" }`; cel needs no assets, so unlike realistic it never
   falls back. `renderViews(…, { renderMode: "cel" })` is synchronous work
   behind the same async signature.
9. **The CPU renderer and the capture STYLES are out of scope.** `cad` and
   `thumbnail` in `renderStyles.js`, `softrender/`, the CLI's PNGs and the
   cloud's server-rendered card thumbnails are unchanged. A cel capture style
   (and its CPU twin, which the parity script would then have to cover) is a
   follow-up, written up separately if wanted. This is the one place the
   playback ("thumbnails and agent renders can use it too") narrows:
   popover thumbnails, `captureCurrent` and `renderViews` are in; the product
   shot and agent renders are not.
10. **Six tiles.** The style grid goes from one row of five to a 3 × 2 grid
    (`grid-template-columns: repeat(3, 1fr)`), tiles the same size. The Parts
    section below keeps its room. *Reviewer: confirm.*

## Non-goals

- Authoring keys for the cel look (`display.cel`, per-part palettes, per-part
  line weight). Colour is the only author-facing input, and it already exists.
- A cel capture STYLE (`renderStyles.js`) or a CPU port. See decision 9.
- Host-tinted frames (`meta.background`). The field has one colour per theme and no more.
- Halftone or ink on the realistic or CAD looks.
- Shadow catching on the part itself (a gear shading the plate under it).
  The ground plane is the only receiver; a sub-part's own banding is its only
  self-shadow.
- A toggle for the kernel feature lines inside cel. They draw, as in CAD; a
  host that must hide them has `edgeOpacity` on the preview as before.
- Changing the ink or band constants per device or per part size. One set of
  numbers; a follow-up may add a size-aware ink width if captures at odd
  sizes want it.

## What exists today (the facts the design rests on)

`P = src/framework`:

- **Modes.** `viewer.js` holds `renderMode` (`"cad" | "realistic"`),
  `setRenderMode` / `enterRealistic` / `enterCad` (the two synchronous halves,
  each a full swap: materials via `setSubMaterials`, background, grid, lights,
  tone mapping, pixel ratio, feature lines, material thumbnails), `publishMode`
  for `onRenderModeChange`, and `captureIn(want, rig, capture)` which borrows
  a look for one synchronous capture and restores exactly. `renderOffscreen`
  is the one offscreen render (fat-line resolution fix, capture lights for
  the non-realistic case, linear → sRGB or tone-mapped readback), and
  `renderWithBackdrop` is the one place `renderer.render` is called for the
  scene (live frame and captures).
- **Materials.** `baseMats[n]` is a sub-part's current source material,
  `cadMats[n]` its CAD `MeshStandardMaterial` (`buildCadMaterial`),
  `physicalFor(n)` its cached realistic material. `rebaseSubMaterial` swaps the
  source and drops the fade clones; `applySubOpacity` derives per-sub-part
  visibility and fade (`subPartVisibility({ renderMode, … })` already keys on
  the mode: lines on in CAD, off in realistic) and re-clones on demand. The
  cutaway (`cutaway-render.js`) clones the base material with clipping planes
  and reassigns `mesh.material`; `registerCutawayMaterial` lets an overlay
  material (the hover highlight's `MeshBasicMaterial`) follow the plane.
- **Lines.** One shared `LineMaterial` (`lineMaterial`) for every sub-part's
  kernel feature edges (`LineSegments2`), colour from `THEME[mode].line`,
  width 1 px; fade clones per sub-part (`fadeLineMats`) copy it and multiply
  opacity by `edgeOpacity`. The CAD background is `cadBackground(theme)`, the
  grid a `GridHelper` rebuilt in `setTheme`.
- **The popover.** `view-style-state.js` `STYLES` (CAD then the
  environments) and `styleFor(renderMode, environmentId)`;
  `view-style-controls.js` builds one tile per style, `choose(id)` calls
  `setRenderMode` / `setEnvironment` and persists what took effect
  (`saveRenderMode` / `saveEnvironment` in `view-state.js`, whose guards accept
  only the known values), and `renderStyleThumbnail(style)` renders the tile
  images through `captureIn`. CSS: `app.css` `.pf-view-style-grid` is
  `repeat(5, 1fr)`.
- **Persistence and hosts.** `mount.js` restores `viewerState.renderMode ??
  loadRenderMode()` at mount, reports `renderMode` in `getViewerState()`
  (the mode headed for), exposes `runtime.renderMode { get, set, onChange }`
  and `renderViews(views, { renderMode })`. `mount-preview.js` validates
  `renderMode` against `["cad", "realistic"]`, carries it, and `contactShadow`
  / `background: "transparent"` are documented CAD-only. `types/index.d.ts`
  declares `RenderMode` and the `renderMode` fields; `docs/AUTHORING-PARTS.md`
  "Materials and appearance" and "`runtime.renderMode`, …" document the
  contract, including "feature lines draw whenever `renderMode` reads `cad`
  and never while it reads `realistic`".
- **Captures.** `captureCurrent(opts)` (follows the live look, `renderMode:
  "realistic"` only once the rig is loaded), `renderViews` (mount's async path
  that waits for the rig), `captureCanonicalViews` (always CAD),
  `renderStyleThumbnail`. The thumbnail cache (`createThumbnailCache`) is
  invalidated by part, theme, cutaway and display changes.
- **Realistic's ground.** `placeGround`, the animation driver's hold
  (feedback #138: the floor may only lower while an animation runs),
  `castersNow()` (ghosts and user fades cast nothing), `renderShadow`'s
  low-res-while-moving / full-res-on-settle schedule.
- **The spike** (`src/spike/cel.js`, `cel-demo.html`, `src/app-cel-demo.js`,
  two hook lines in `mount.js` / `viewer.js`): the shader source for the band
  material and the ink pass, the VSM ground shadow with its two pitfalls
  solved (the receiving plane must sit strictly inside the shadow camera's
  xy bounds, and the depth slab must be thin enough for half-float depth), the
  output-colour-space fix (`#include <colorspace_fragment>` in every
  `ShaderMaterial`, else linear writes to the sRGB canvas), and the GridHelper
  detection by `type`. It is deleted by the implementation PR; the product
  code is a rewrite into the viewer's structure, not a move.

## The design

### Module layout

A new folder `P/cel/`, split like `materials/`: a pure half and a three half.

- `cel/cel-style.js` — **pure, no three, no DOM.** The constants table (below)
  as frozen data, and the colour derivations: `celBase(display)` (the effective
  colour, the body white when `cadAppearance` would give the CAD blue-grey
  default and the display names no colour), `celTones(baseHex)` → `{ lit,
  shadow, deep }` as sRGB hex (the shadow is the base darkened by
  `shadowDarken`, mixed `shadowTintAmount` toward the cool tint rescaled to the
  base's luminance so a dark part stays dark and a white one goes blue-grey;
  deep is shadow × `deepDarken`). Unit-tested; the docs' colour examples come
  from it.
- `cel/cel-material.js` — `buildCelMaterial(display)` → a `ShaderMaterial`
  (`clipping: true`, with three's `clipping_planes` chunks so the cutaway's
  clones work; `transparent` + `opacity` honoured so fade clones work;
  `#include <colorspace_fragment>`; `userData.pfCel = true`). Uniforms shared
  across sub-parts (light direction, band edges, softness, highlight, rim) and
  per material (base tones). Banding, highlight and rim as in the spike;
  shadow halftone off (the dialled value is 0 — keep the uniform, drop the
  slider).
- `cel/cel-ink.js` — the ink pass: owns the normal + depth render target
  (float depth texture, resized with the drawing buffer or capture target),
  the override `MeshNormalMaterial` (clipping planes applied), and the
  fullscreen quad with the ink shader. `render(renderer, scene, camera, {
  pixelScale, field })`: prepass on the sub-part layer, then the quad with
  `autoClear` off. Renders nothing when the scene has no sub-parts.
- `cel/cel-ground.js` — the ground shadow: a zero-intensity
  `DirectionalLight` with `castShadow`, VSM map (2048², 1024² on a coarse
  pointer), bias and blur per the constants, the `ShadowMaterial` plane
  sized to sit strictly inside the shadow camera's xy frustum, `fit(bounds)`
  and `aim(camera)` (the light follows the camera-relative key direction at
  the ground elevation, its world elevation clamped to ≥ 40°), called from
  `renderWithBackdrop` so captures aim it too. Honours `castersNow()`: ghosts
  cast nothing.

### The viewer

- `renderMode` gains `"cel"`. `enterCel({ live })` and the extension of
  `enterCad` / `enterRealistic` to leave it are the synchronous halves, in the
  style of the existing two: `setSubMaterials(celFor)` (a cached
  `celMats[n]`, built from the effective display like `physicalFor`,
  invalidated by the same display-override paths), `scene.background =
  field colour` (or `null` when `transparent`), `scene.environment = null`,
  grid hidden, live lights hidden (the cel material ignores scene lights
  anyway; hiding keeps any non-cel material a sub-part might still hold —
  none today — from being lit twice), tone mapping off, pixel ratio as CAD,
  the CAD contact shadow disposed, the ground shadow added and the
  renderer's shadow map enabled (restored on leaving), feature lines
  refreshed, material thumbnails invalidated. `setRenderMode("cel")` is
  synchronous after a shader compile: `compileCel()` mirrors
  `compileRealistic` (a proxy scene of every built sub-part under the cel
  material, through `compileAsync`), so the first cel frame does not stall;
  until it resolves the mode event reports `busy`, exactly as realistic does.
- `subPartVisibility` treats cel like CAD for lines (on). The line colour
  and opacity follow the mode: `lineMaterial.color` is the ink colour and
  `opacity` the kernel-line opacity (0.55) while cel is on, the theme's colour
  at 1 otherwise; the fade clones keep multiplying. The refresh lives where
  `setTheme` already recolours lines.
- `renderWithBackdrop` runs the ink pass after the scene render when
  `renderMode === "cel"` and `renderScene === scene`. `pixelScale` is the
  renderer's pixel ratio on the canvas and, for a capture, the target's long
  side ÷ 800, floored so no ink line is thinner than one device pixel
  (decision: ink widths are CSS px on screen; a 1024 capture gets ×1.28).
- `renderOffscreen`'s capture lights are not added in cel (the material
  ignores them; adding them is wasted work and lights the ground plane's
  `ShadowMaterial` no differently). Readback is the CAD path (LDR, sRGB
  encode).
- `captureIn` learns the third mode: borrowing cel from CAD or realistic, and
  CAD or realistic from cel, each in one synchronous block, restoring the
  realistic rig without re-grounding as today.
- The cutaway: the cel material's clones carry the planes; the section caps
  keep the cutaway's own cap material (ink appears at the cap boundary
  because depth jumps there, which is the right picture). The prepass's
  override material gets the same planes so ink stops at the cut.
- The hover highlight's overlay mesh and the selection tint are unchanged
  (separate meshes and materials, off the sub-part layer).
- Pose-drag ghosts (0.35 fade clones), user see-through and animation
  opacity all arrive through `applySubOpacity` as clones of the cel material;
  a faded sub-part is left out of the prepass (it is see-through, so it has
  no silhouette) and out of the shadow casters.
- `getViewerState().renderMode` may read `"cel"`; `isRealisticPending` is
  unchanged (cel never waits on assets, so a remount mid-compile simply
  recompiles).

### The ground

Floor height and extent follow realistic's `placeGround` rules through a
shared helper rather than a second copy: placed on `showAssembly` and on
entering cel, held during a driven animation. The plane is centred on the
visible bounds' horizontal centre, square, side = 2 × (frustum half-width) /
√2 × 0.98 with the shadow camera's half-width 4 R (R = the visible bounds'
half-diagonal); the light sits 30 R out along the aimed direction, slab
26 R – 34 R. These are the spike's working numbers; the builder may change
them as long as the two invariants hold (plane strictly inside the map's xy
bounds under every azimuth; the plane never crosses near or far within the
map) and the spike's two artefacts (a stripe along the frustum side; a faint
self-shadowed square) are not reintroduced. Shadow map re-renders are driven
by the on-demand render loop (every rendered frame), with no extra schedule:
a 2048² VSM blur per frame was fine on the spike's desktop; the builder
measures it on a coarse-pointer device and may drop to 1024² there (the
constant above) or further if a frame budget of twice CAD's is exceeded.

### The popover and persistence

- `STYLES` gains `{ id: "cel", label: "Cel" }` after CAD and before the
  environments (the two non-photographic looks first). `styleFor` returns
  `"cel"` for the mode. `choose("cel")` calls `setRenderMode("cel")` and
  persists what took effect. The thumbnail loop renders it through
  `renderStyleThumbnail("cel")` → `captureIn("cel", …)`.
- `saveRenderMode` / `loadRenderMode` accept `"cel"`. An older partforge
  reading a stored `"cel"` falls back to CAD by its own guard, which is the
  right behaviour.
- `mount-preview.js`: `renderMode` accepts `"cel"`; `contactShadow` is ignored
  in cel (cel brings its own); `background: "transparent"` is allowed in cel
  per decision 3; the doc comments change accordingly.

### Constants (locked from the spike)

| Group | Name | Value |
| --- | --- | --- |
| Bands | count | 3 |
| | lit edge / deep edge (n·l) | 0.45 / 0.05 |
| | softness | 0.015 |
| Shadow tone | darken | 0.74 |
| | tint / amount | `#6f86b4` / 0.25 (the spike's 0.5 pulled a warm part's shadow to mauve, so its lit faces read as a highlight of another colour; lowered 2026-11-08) |
| | deep darken | 0.7 |
| Highlight | strength / size / shininess | 0.85 / 0.6 / 60 |
| Rim | strength / width | 0.6 / 0.18 |
| Key light | azimuth / elevation (view space; held in world on the canvas, read at the default camera pose (18, 12, 18)) | −35° / 38° |
| Ink | colour | `#161a24` |
| | thick / thin (CSS px) | 0.7 / 0.3 |
| | outer contour boost | ×1.4 |
| | depth threshold / normal threshold | 0.004 / 0.3 |
| | kernel lines | on, opacity 0.55, ink colour |
| Field | colour, light / dark theme | `#9fd9ea` / `#273648` |
| | halftone strength / cell (CSS px) | 0.1 / 7, 45°, dot colour field × 0.82 (light) or × 1.3 (dark) |
| Body default | colour | `#eef1f4` |
| Ground | shadow opacity / colour, light / dark theme | 0.3 / `#24304a`, 0.5 / `#0a0e16` (the light pair is nearly the slate itself) |
| | penumbra | 8 % of R |
| | light elevation | 60° (azimuth = key's; same frame as the key) |
| | map / bias | 2048² (1024² coarse pointer) / −0.0015 |

The shader math for each is in the spike and is the reference: the view-space
normal and an orthographic-aware view vector; `band()` as a `smoothstep` of
width `softness` at each edge; the Blinn lobe stepped at `size`; the rim on
the shadow side only; ink = max of the depth edge (a second difference of
linear depth, normalised by depth) and the normal edge (1 − n·n′ at the thin
radius); the outer contour on field pixels within `thick × boost` of a part
pixel.

### Performance

The cel frame adds: a prepass of the sub-parts at full resolution (normals
only, no lighting), a fullscreen quad with 9 texture reads, and the shadow
map's depth render plus two blur passes. Target: a cel frame costs at most
twice a CAD frame on robot-arm at 1080p / 2× DPR on the dev machine, and the
mode is usable on an iPad (the builder measures with the pose bench's
machinery, `npm run bench:pose`, extended or a sibling script). The shadow
map renders on every frame the camera or a caster moves (decision 4), so the
levers are: a moving / settled schedule like realistic's contact shadow
(1024² while the camera or a drag moves, 2048² once settled — a VSM map's
size can change between frames by swapping the render target), blur samples,
and a flat 1024² on a coarse pointer and in `mountPreview` (a landing page
turntable never settles). There is no frame-skip lever.

### Tests

- `test/cel-style.test.js`: the tone derivation (white → the reference's
  blue-grey shadow; a saturated red keeps its hue; black stays black; the
  body default applies only when no colour is authored or picked), the
  constants table frozen and in range.
- `test/view-style-popover.test.js`: six tiles, cel pressed when the viewer
  reports it, persistence of `"cel"`.
- `test/view-state` / mount tests: `loadRenderMode` round-trips `"cel"`;
  `getViewerState().renderMode` reads `"cel"`; `mountPreview({ renderMode:
  "cel" })` accepted, `"celshaded"` rejected.
- A layering test, like `worker-layering`: `cel/cel-style.js` imports no
  three; the worker graph never imports `cel/`.
- `scripts/check-app.mjs` (real Chromium): set `runtime.renderMode.set("cel")`
  on demo.html, assert the mode event settles, that a canvas corner pixel is
  the field colour, that `captureCurrent()` returns an image whose corner is
  the field colour and `captureCurrent({ renderMode: "cad" })` one whose
  corner is the CAD background, and that switching back restores CAD's. Run
  on the CI app list.
- `check:softrender` is unaffected and must stay green (nothing in
  `renderStyles.js` changes).

### Docs, types, release

- `types/index.d.ts`: `RenderMode` adds `"cel"`; the `renderMode` doc
  comments mention it; `mountPreview` options.
- `docs/AUTHORING-PARTS.md`: "Materials and appearance" gains a short "Cel
  shaded" paragraph (what colour it reads, what it ignores, the body default);
  the `runtime.renderMode` section lists the third value, notes cel needs no
  assets so `captureCurrent({ renderMode: "cel" })` always works, and amends
  the feature-lines sentence (they draw in CAD and cel, never in realistic).
- `AGENTS.md`: a line under the viewer architecture for `cel/`, parallel to
  `materials/`.
- `package.json` bumped to 0.186.0 in the PR (the releasing rule).
- The spike files and the two hook lines are removed in the same PR.
- **Release ordering against partforge-cloud.** The cloud coerces
  `viewerState.renderMode` to cad / realistic today (`mountManager.js`'s
  sticky appearance, `previewStyle.js`, `appearancePreference.js`) and
  remounts on every edit, so a cloud user who picked the Cel tile would get
  CAD back on the next keystroke. No host-facing option to hide the tile is
  added: the cloud only sees the tile once it bumps its partforge dependency,
  and its acceptance change (take `"cel"` wherever it validates the mode;
  build sight keeps pinning `"cad"`) lands in that same bump PR. partforge
  ships whenever it is ready. *Reviewer's question; my call.*

## What's left to the builder

- The exact split of `enterCel` against the existing halves, and whether the
  shared ground-placement helper is extracted first (a refactor PR) or
  alongside.
- Shader structure (one material with per-sub-part uniforms vs. a cached
  material per sub-part like `physicalFor`), so long as the cutaway's and the
  fades' cloning keep working.
- Whether the ink prepass renders into a separate layer, as the spike did,
  or walks the sub-part meshes with an override; the invariant is "sub-parts
  only, overlays never".
- Shadow-map tuning within the invariants above and the moving / settled
  schedule.
- Test fixtures and how check-app reads pixels back.
- Whether to land as one PR or two (mode + materials + ink + popover first,
  ground shadow + preview options second). Either is fine; the first must not
  ship without the ground shadow being at least a follow-up PR already open.

## Follow-ups (not this design)

- A `cel` capture STYLE and its CPU twin in `softrender/`, so the cloud's
  server-rendered card thumbnails and the CLI's PNGs can be cel.
- partforge-cloud: the dependency bump PR that accepts `"cel"` (see Release
  ordering) and regenerates its prompt corpus against the published version.
- Size-aware ink widths for very large or very small captures.
