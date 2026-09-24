# Authoring parts

This app is a small **framework** that turns a declarative **`PartDefinition`** into
a full parametric-CAD web app: a 3-D viewer, a control panel built from your
parameter schema, two geometry workers, and STL / STEP / 3MF export. To make a new
part you write **one script** — geometry build functions + a parameter schema — and
the framework does the rest.

- Reusable framework: `src/framework/` (knows nothing about any specific part).
- Parts: `src/parts/` — e.g. `planter.js` (full, rich) and `demo.js` (minimal).
- A part module is **plain data + pure functions**: no DOM, no side effects (it
  loads in both the main thread and a Web Worker).

Two worked examples to read alongside this guide: **`src/parts/demo.js`** (a
parametric spacer — the smallest complete part) and **`src/parts/planter.js`** (a
faceted planter — facets, taper, twist, even walls, an optional feature, a `derive`,
and a `verify` block). **`src/parts/filleted-box.js`** is the worked example for the
portable Solid fillet/chamfer API and the OCCT-only shell op.

---

## Quickstart

1. Copy `src/parts/demo.js` to `src/parts/<your-part>.js` and edit it.
2. Copy the three glue files, repointing them at your part:
   - `demo.html` → `<your-part>.html`
   - `src/app-demo.js` → `src/app-<your-part>.js`
   - `src/demo-worker.js` → `src/<your-part>-worker.js`
3. `nvm use && npm install` (Node 24), then `npm run dev` and open
   `http://localhost:5173/<your-part>.html`.

That's the whole loop. The chrome (panel, tabs, viewer, export buttons) is shared —
your HTML is structural markup only and carries no CSS (the framework supplies it via
`framework/app.css`, imported by `mount`). See "Wiring a part into a runnable app"
below for what that markup must contain.

---

## Before geometry: state the engineering intent

For a decorative or low-consequence part, a short dimensional description may be
enough. For anything that mates with another object, carries load, or could cause harm
if it fails, write down the engineering intent **before** writing `build`:

- the coordinate frame, origin, and named datums;
- the allowed envelope and the interfaces that must align (mating faces, axes, hole
  patterns, fits, clearances, and tolerances);
- the manufacturing process and material assumptions;
- load cases, support regions, intended load paths, and safety factors when structural
  behavior matters;
- numbered acceptance claims with units and thresholds; and
- unresolved assumptions that need the user or an engineer to answer.

This may live in the task/specification, a companion design note, or comments next to
the part — partforge does not prescribe a blueprint schema yet. Do not silently invent
missing loads, material properties, tolerances, or safety factors. Ask, or record the
property as unverified.

Treat user/specification acceptance claims as **higher authority** than agent-authored
geometry and checks. An agent may add conservative checks, but must not delete a claim
or loosen its threshold merely to make a failing design pass; changing the contract
requires explicit approval.

---

## The `PartDefinition` contract

A part is a default-exported object. Full shape (optional fields marked `?`):

```js
export default {
  meta: { title, units, background?, environment? },     // title string; units e.g. "mm"; background = 0xRRGGBB scene colour
  parameters,                              // the control-panel schema (array of sections — see below)
  defaults,                                // flat { paramKey: value } — seeds params + control values
  fonts?,                                  // { name: source } — or (p) => ({ name: source }) when a control drives the typeface
  imports?,                                // { name: source } — STEP/STL/3MF files a part's k.import() needs; same preload timing as fonts (see below)
  vectors?,                                // { name: source } — declared vector files k.vector2d() places: authored partforge-vector JSON or ingested SVG; same source grammar and preload timing as fonts
  derive?,                                 // (p) => d, or { group: (p, d) => {…}, … } — dependent values computed once per build
  parts: {                                 // named sub-parts; each builds ONE solid
    <name>: {
      label?,                              // display name (tabs/progress); defaults to the key
      build: (k, p, d, onProgress?) => Solid,   // REQUIRED — see kernel API
      place?: (solid, { view, purpose, p, d }) => Solid,   // optional reposition; default identity
      views,                               // string[] — which views show this sub-part
      enabled?: (p) => boolean,            // optional — gate a conditional sub-part
      display?: { color?, opacity?, material?, …overrides }, // viewer-only appearance — see "Materials and appearance"
      export?: { name },                   // filename/object name on export; defaults to the key
      reference?: string,                  // name of a declared import — measure() computes a deviation fact against it (see below)
    },
  },
  views: { <name>: { label, default?, animations? } },  // view tabs; a view may own animations (below)
  probes?,                                 // { name: (k, p, d) => Solid | Shape2D | plain JSON } — measurements reported by
                                           // measure/inspect, never rendered or exported (see "Probes" below)
};
```

**Rules:**

- `build(k, p, d, onProgress?)` returns the **canonical** solid (e.g. at the origin).
  It is the only required function per sub-part. `p` is `{ ...defaults, ...userParams }`;
  `d` is `derive(p)` (or `{}`). `onProgress?.("phase")` is optional per-feature progress
  shown during export — call it before expensive steps.
- `place(solid, ctx)` is an optional escape hatch for parts whose **display pose differs
  from their export pose** (e.g. positioning a sub-part in an assembly). `ctx.purpose` is
  `"display"` or `"export"`; `ctx.view` is the active view. Default is identity, so simple
  parts omit it. **Display placement must not depend on `view`** — display meshes are built
  once per sub-part and cached across views (the viewer re-centres per view).
  **Any difference between the display and export pose must be a rigid motion** —
  `translate`/`rotate`/`rotateAbout`/`along`/`at` only. Never put a `mirror` or a
  non-identity `scale` on one purpose but not the other: the exported (printed) part is the
  same physical object you show in the assembly, and a reflection or resize there makes the
  two silently disagree — you print the mirror image of what the viewer showed
  ([place-not-rigid](ERROR-PATTERNS.md#place-not-rigid)). If a part genuinely needs a
  reflected or resized form (e.g. a block that seats flipped), bake that into `build` so
  both purposes share one canonical solid, then pose it rigidly.
- `enabled(p)` gates a conditional sub-part (e.g. only present when a feature is on).
- A view's sub-parts are derived, never hard-coded: those whose `views` include the view
  and whose `enabled(p)` is true.
- **Which view the viewer opens on** is resolved in this order: the first view flagged
  `default: true`; else the view placing the most sub-parts at `defaults` (counting
  `enabled(defaults)`), which for a multi-view part is normally the assembly; else the
  first key in `views`. So flag the assembly view `default: true` when you want it to
  open but sit last in the tab bar. The chosen tab then persists per part for the rest
  of the browser session. The headless tools are deliberately different: `measure`,
  `verify` and `render` all default to the **first key** in `views`, ignoring
  `default: true`, so a CI gate can't move because a sub-part was added to a view.
- `fonts` declares the outline fonts a part's `k.text2d()` calls need, as `{ name: source
  }` — a source is inline bytes, a URL string, or a thunk (e.g. a Vite `import('./x.ttf')`,
  which resolves to `{ default: url }`). The framework resolves and parses these into
  `kernel._fonts` **before** the synchronous `build` runs, so `k.text2d(str, { font: name
  })` can look the font up by name. See `src/framework/fonts.js` (`resolveFonts`) and
  `k.text2d` in `docs/KERNEL-CONTRACT.md` for the full contract; fuller authoring guidance
  (recommended font sourcing, licensing notes) lands in a follow-up pass.
- `imports` declares the STEP/STL/3MF files a part's `k.import()` calls need, same source
  grammar and preload timing as `fonts` above. See "Importing geometry (STEP/STL/3MF)"
  below for the full contract — backend matrix, units, the `reference` field + the
  deviation gate, and caching.
- `vectors` declares the vector files a part's `k.vector2d()` calls need, same source
  grammar and preload timing as `fonts` above — but the source resolves to **JSON** in the
  `partforge-vector` format, never to raw `.svg`. That JSON is either **authored** by hand
  (millimetre coordinates, placed as drawn) or the **ingested** output of `partforge/ingest`.
  A vector source may additionally be that JSON **already parsed** — the object itself,
  rather than bytes or a URL pointing at it — which is the form to use when the artwork
  lives beside the part and is meant to stay hand-editable.
  See "Vector geometry" below for the full contract.

---

## Animations

A **view** may declare named animations — pure keyframe data that drives
**existing params** over time and fades the view's own sub-parts in and out.
Animations belong to the view that declares them: they live under
`views.<name>.animations`, never at the top level of the part (a top-level
`animations` key is a lint error — `animation-not-in-view` — and is ignored at
runtime: no bar, no crash).

The viewer shows a transport bar (play/scrub, with ‹ › pagers between
animations) **only while the active view declares animations**, listing exactly
that view's set; views without animations render no bar at all. Switching views
resets playback: the running animation stops, its param snapshot is restored,
all opacity overrides are cleared, and the incoming view's transport starts
fresh at its first animation, position 0 — no animation state survives a view
switch. Hosts drive the same engine via `runtime.animation`, scoped to the
active view (call `setView` first to reach another view's animations);
`partforge render` can render stills at any position. The reference part is
`src/parts/hinged-box.js`.

Step labels surface on the scrubber rather than in a readout: hovering or
dragging along the timeline names the chapter under the pointer, and with the
scrubber focused **PageUp / PageDown jump whole chapters** (PageUp forward,
matching the key's native slider direction). Screen readers get the same
information from the scrubber's `aria-valuetext`, which reads
`"<step label> — <percent>"`.

This is the shipped reference part's own block — `views.box` owns all three
animations, and `assemble` opens with a fade rather than a motion:

```js
views: {
  box: {
    label: "Box",
    animations: {
      open: {
        label: "Open lid",
        description: "Swings the lid to **110°** about the rear hinge line.\n\nPose-only: playback runs at frame rate with no geometry rebuild.",
        camera: "front",        // optional: intro angle, cue list, or per-step (below)
        duration: 1.2,          // seconds
        tracks: { lidAngle: [[0, 0], [1, 110]] },   // param -> [t, value] keyframes
      },
      cycle: {
        label: "Open / close",
        duration: 2.4,
        loop: true,             // wraps continuously (single-step only)
        easing: "linear",       // linear | ease-in | ease-out | ease-in-out
        autoplay: true,         // at most one per view
        tracks: { lidAngle: [[0, 0], [0.5, 110], [1, 0]] },
      },
      assemble: {
        label: "Assemble",
        description: "How the parts come together: the lid fades in above the base, drops on, then swings open to check hinge clearance.",
        steps: [                // steps play in order; named on the scrubber as you hover/drag
          { label: "Lid appears", camera: "iso", duration: 0.8,
            opacity: { lid: [[0, 0], [1, 1]] },        // sub-part -> [t, 0..1] keyframes
            tracks: { lidLift: [[0, 40], [1, 40]] } }, // hold the lift while it fades in
          { label: "Lower the lid", camera: "left", duration: 1.0,
            tracks: { lidLift: [[0, 40], [1, 0]] } },
          { label: "Open to check clearance", camera: "iso", duration: 1.0,
            tracks: { lidAngle: [[0, 0], [1, 110]] } },
        ],
      },
    },
  },
},
```

Rules (all lint-enforced):

- Animations are declared under `views.<name>.animations` — one map per view,
  each name unique within its view. Two views may reuse a name; each owns its
  own animation.
- An animation has **either** `tracks`/`opacity` (a single anonymous step)
  **or** `steps`. Never both forms, never neither.
- Tracks reference numeric params from `defaults`. Keyframe `t` is normalized
  per step, strictly ascending from exactly 0 to exactly 1; values must sit
  inside the owning control's min/max (the engine applies them unclamped).
- Params not tracked anywhere keep their current values; a param tracked in
  one step holds its nearest keyframe value while other steps play.
- `opacity` sits beside `tracks` and fades sub-parts instead of moving them.
  It is keyed by **sub-part name**, and the sub-part must belong to the owning
  view (`animation-opacity-unknown-part` otherwise); values run 0 (hidden) to 1
  (normal) and are lint-checked against that range
  (`animation-opacity-range`). Keyframes follow exactly the same rules as param
  tracks — per-step normalized `t`, strictly ascending from 0 to 1 — including
  the hold rule: a sub-part faded in step 3 holds its step-3 opening value
  (0, hidden) through steps 1–2, so "absent until its moment" needs no extra
  declaration. Sub-parts never mentioned render normally.
- Opacity 0 hides the mesh **and its edge lines** entirely — it is absence, not
  a ghost. Values in between multiply any static `display.opacity`: a ghost
  part at `display.opacity: 0.5` faded to 1 shows at 0.5.
- **Opacity is display-only, always** — it never touches params, export,
  `measure`, or `verify`, and Reset restores normal visibility. This is a
  deliberate asymmetry with param `tracks`, where exporting while paused
  exports the posed state (below): a pose is real param state, a fade is not.
  Because it bypasses the param pipeline, a fade runs at frame rate even when
  param tracks force worker-cadence rebuilds.
- Fades compose with the cutaway: a half-faded surface is still sectioned by the
  cut plane, though its hatch cap keeps full-strength opacity for the moment the
  part is mid-fade.
- A step may declare a `camera` and **no** `tracks`/`opacity` — an establishing
  shot that swings the view while the model holds still. At least one step still
  has to carry `tracks` or `opacity`, or the animation animates nothing; a
  **pure-fade** animation, carrying only `opacity`, is perfectly legal. Note the
  holding value is the nearest keyframe, not whatever the user last set: a
  leading camera-only step shows the animation's opening pose, the same one
  `t = 0` would show.
- `loop` and `autoplay` must be literal booleans. Anything else is reported by
  lint and treated as `false` at runtime, so `loop: "false"` never means "loop".
- Couple motions through `derive` (animate one master param; derive the rest),
  not by tracking dependent params separately.
- `camera` cues use the seven canonical angles (`iso front back top bottom
  left right`). One mechanism per animation: an animation-level name (an intro
  cue at t=0), an animation-level `[[t, angle], …]` list, or per-step names.
  Cues fire during play only — scrubbing never moves the camera — and a user
  orbit disarms the remaining cues for that run.
- Playback drives params through the real param pipeline: a **pose-only**
  param (feeds only rigid placement — see "Caching & determinism" below) plays
  at frame rate; anything else rebuilds best-effort at worker cadence. `lint`
  prints a note per track that can't take the fast path.
- Playback pauses when the user edits any control; Reset restores the values
  the animation found. Because animated values are real params, exporting
  while paused exports the posed state — by design.
- `autoplay: true` (optional, at most one animation **per view**) starts that
  animation on first show and again on each view switch, until the user touches the
  transport — or anything writes params (`runtime.setParams` included) or
  calls a `runtime.animation` method; any of those disarms auto-start for the
  session. Lint: `animation-autoplay-invalid`. It is not armed when the
  browser reports `prefers-reduced-motion: reduce` — self-starting motion is
  exactly what that setting asks a page not to do. An autoplay animation that
  declares a `camera` cue will sweep the camera away from the user's
  persisted framing on every page load, so choose cues for autoplay
  deliberately — the shipped example's `cycle` animation has none.

Headless: `partforge render <part> --animation open --at 0,0.5,1` renders
tagged stills (`--at` is normalized over the animation's total duration, like
the scrubber); `--step <index|label>` renders a step's end state; stills
default to the governing camera cue's angle, and apply opacity at the rendered
`t`, so a faded frame renders faded. `--animation` searches every view: a name
unique across the part implies its owning view and renders there, overriding
the usual first-view default. If two views declare the same name the CLI stops
and asks for the existing positional view argument
(`partforge render <part> <view> --animation shared`) — there is no compound
"view/name" syntax, and `--views` already means camera angles.

---

## Materials and appearance

A sub-part's `display` block says how it LOOKS. Appearance never changes
geometry, exports (other than 3MF colour, below), `measure` or `verify`, and a
mistake in it never fails a build — lint warns and the viewer falls back.

```js
parts: {
  body:   { build: …, display: { material: "anodized-aluminum", color: 0xb3261e } },
  knob:   { build: …, display: { material: "abs-plastic", color: 0x111111, roughness: 0.25 } },
  gasket: { build: …, display: { material: "rubber" } },
},
meta: { title: "…", units: "mm", environment: "studio" },
```

- `material` — a preset id from the table below. Without one the sub-part keeps
  the default look.
- `color` — the base colour (`0xRRGGBB`). With a preset it is the TINT. Presets
  marked tintable are normally coloured this way (anodizing, plastic, paint);
  the others have an intrinsic colour (brass) but still accept one.
- Overrides — each clamped to its range: `roughness` (0–1), `metalness` (0–1),
  `clearcoat` (0–1), `clearcoatRoughness` (0–1), `anisotropy` (0–1), `textureScale` (0.01–1000).
  Transmission, index of refraction, sheen and iridescence come only from a preset.
- `opacity` — unchanged: a ghost stays a ghost and casts no shadow.
- **One material per sub-part.** Something that needs two finishes (a knurled
  grip in rubber on an aluminium body) is two sub-parts.

**Where it shows.** The CAD view (with feature lines) shows each material's
colour, flattened so dark materials stay readable. **Realistic** mode — the
viewer's toggle — shows the full material under environment lighting, with a
ground and soft shadow and no feature lines. The part never moves when the
mode changes.

**3D-print layer lines** (`pla-print`, `petg-print`) run perpendicular to the
**export** pose's +Z — the way the part will be printed, not the way it is
displayed. If the lines run the wrong way, fix the export pose with `place()`
(`purpose: "export"`), not the material. Wood, carbon fibre and SLS grain are
fixed to the sub-part, so they never slide when the camera or an animation
moves.

**`textureScale` is millimetres, and what it measures depends on the preset's
pattern** — so a value copied from one preset family is wrong on another (0.2
on oak shrinks the grain to a 0.2 mm tile, i.e. invisible noise):

| Pattern | Presets | `textureScale` means | Default |
| --- | --- | --- | --- |
| layer lines | `pla-print`, `petg-print` | layer height | 0.2 |
| SLS grain | `nylon-sls` | grain size | 0.15 |
| wood | `oak`, `walnut` | size of one texture tile (the grain repeats every this many mm) | 250 (`oak`), 400 (`walnut`) |
| carbon weave | `carbon-fiber` | size of one texture tile | 48 |

Presets without a pattern ignore it.

**3MF export** carries each sub-part's colour (its `color`, else its preset's
colour), so a multi-colour print opens in a slicer already split and coloured.
A part with no `color` or `material` exports exactly as before.

| Preset | Name | Tintable | Use |
| --- | --- | --- | --- |
| `machined-aluminum` | Machined aluminium | — | Bare CNC-milled aluminium, fine tool marks, satin sheen. |
| `brushed-aluminum` | Brushed aluminium | — | Directionally brushed aluminium panels and enclosures. |
| `anodized-aluminum` | Anodized aluminium | yes | Dyed anodized aluminium; tint with `color` (e.g. red, black, blue). |
| `bead-blasted-aluminum` | Bead-blasted aluminium | — | Matte, even-textured aluminium (laptop-shell finish). |
| `brushed-stainless` | Brushed stainless steel | — | Brushed 304 stainless: kitchen, marine and fastener hardware. |
| `polished-chrome` | Polished chrome | — | Mirror chrome plating; shows the environment strongly. |
| `black-oxide-steel` | Black-oxide steel | — | Blackened steel tooling and fasteners with a slight oily sheen. |
| `cast-iron` | Cast iron | — | Raw sand-cast iron: dark, rough and matte. |
| `titanium` | Titanium | — | Bare titanium: slightly warm grey, satin. |
| `brass` | Brass | — | Yellow brass fittings and decorative hardware. |
| `copper` | Copper | — | Bare copper: busbars, heat sinks, decorative parts. |
| `bronze` | Bronze | — | Cast bronze bushings and sculpture. |
| `powder-coat` | Powder coat | yes | Durable textured paint over metal; tint with `color`. |
| `painted-metal` | Painted metal | yes | Glossy enamel or automotive-style paint; tint with `color`. |
| `pla-print` | PLA print | yes | FDM-printed PLA with visible layer lines; tint with `color`. |
| `petg-print` | PETG print | yes | FDM-printed PETG: glossier than PLA, visible layers; tint with `color`. |
| `resin-print` | Resin print | yes | SLA/MSLA resin print: smooth, faintly waxy; tint with `color`. |
| `nylon-sls` | Nylon SLS | yes | Powder-bed nylon: matte, grainy, usually white or dyed black. |
| `abs-plastic` | ABS plastic | yes | Injection-moulded ABS housings and knobs; tint with `color`. |
| `clear-acrylic` | Clear acrylic | yes | Transparent PMMA/polycarbonate windows and covers; tint for coloured acrylic. |
| `rubber` | Rubber | yes | Matte elastomer: gaskets, feet, grips; tint with `color`. |
| `oak` | Oak | — | Light oak with open grain. |
| `walnut` | Walnut | — | Dark oiled walnut. |
| `carbon-fiber` | Carbon fibre | — | 2x2 twill carbon fibre under clear coat. |

**Environments** (`meta.environment`, default `studio`; viewers can switch):
`studio` (neutral soft boxes, paper sweep), `workshop` (warm interior, unfinished
maple table), `print-bed` (a dim, hard-lit enclosure over a standard-size PEI build plate (180, 220, 256 or 350 mm) marked with its size), `outdoor` (overcast sky,
concrete).

---

## Geometry: the kernel / `Solid` API

`build` receives a backend-agnostic `kernel` (`k`). It returns and combines `Solid`
handles. The same code runs on **Manifold** (fast meshes — preview + STL + 3MF) and
**OCCT/replicad** (exact B-rep — STEP). Op lists live in
`src/framework/geometry/kernel.js`; the normative semantics (conventions, value
semantics, conformance classes, versioning) are in `docs/KERNEL-CONTRACT.md` — the
tables below are the authoring-side view of that contract.

**Calling convention.** Every multi-parameter op below takes a single **options
object** — this is the canonical, documented way to call them (`k.cylinder({ r, h
})`, not `k.cylinder(r, r, h)`); the object's keys are named the same across both
backends, so a call is self-describing and immune to the positional-argument
transposition mistake (swap two same-typed numbers, get a valid *wrong* solid).
Single-argument chaining ops (`translate`, `rotate*`, `cut`, `mirror`, `scale`, …)
already take one argument and are unaffected. Legacy positional calls (e.g.
`k.cylinder(rBottom, rTop, h)`) still work — they're accepted silently until a
future breaking contract version removes them (contract v2, partforge 0.59, did
not — it only changed `offset` semantics) — but are not shown here; see
`docs/KERNEL-CONTRACT.md` "Calling convention" for the full canonical/legacy table
and the detection rule.

**Kernel — make solids:**

| Call | Result |
|---|---|
| `k.cylinder({ r\|d, h, center? })` · `k.cylinder({ r1, r2, h, center? })` \| `{ d1, d2, h }` | cylinder/cone along +Z (frustum for the cone form); straight takes exactly one of `r`/`d` |
| `k.box({ size, center? })` · `k.box({ min, max })` | `{size:[x,y,z]}` = centered X/Y, base at z=0 (`center:true` also centers Z); `{min,max}` = explicit `[x,y,z]` corners |
| `k.prism({ points, h, twist?, scaleTop? })` | extrude a 2-D polygon (or an **arc profile** from `roundedProfile`) from z=0; optional `twist` (degrees over the height) and `scaleTop` (uniform top taper: 1 straight, <1 taper in, 0 → point/cone) |
| `k.extrude({ profile, h, twist?, scaleTop? })` | extrude a **polygon-with-holes** region from z=0 in one op — `profile` is `{ outer, holes? }` where each contour is a points array **or an arc profile** (`roundedProfile`, for true STEP fillets), or a bare points array / arc profile for outer-only; same `twist`/`scaleTop` as `prism` (both backends) |
| `k.loft({ rings, ruled?, closed?, shading? })` | stack polygon cross-sections into a solid — ruled walls between consecutive rings, capped ends (both backends; `closed:true` capless loops are Manifold-only). A ring's `polygon` may be a point list, `sides`+`radius`, a curve contour, or a single-region hole-free `Shape2D` (multi-region / holed shapes throw). Identical all-line rings are bit-identical on both backends (unchanged legacy). Identical curve-structure rings loft curve-natively on OCCT (STEP keeps true arcs) and facet at fixed LOD on Manifold; structurally different rings auto-resample to a common vertex count with a deterministic seam and share the same faceted STEP at sampling LOD on both backends. `ruled:false` (smooth C2 blend) is honoured only by OCCT/STEP export; the Manifold preview always shows faceted straight walls. `shading?: "smooth" \| "faceted"` overrides facet/smooth shading inference (point-ring default: <32-side rings shade as flat facets, drawing no same-surface lines at all — not even their own cap rims — though cut seams against other solids still draw; ≥32 sides shade smooth. Curve/resample rings shade by tessellation provenance — smooth only along smooth contour spans, with dividing lines at sharp corners and silhouette-kink rings; see the shading-intent note) |
| `k.sweep({ profile, path, cornerRadius?, closed?, ruled?, smooth? })` | sweep a fixed 2-D profile along a 3-D polyline path — sharp mitered corners (or `cornerRadius` fillets), capped ends (both backends). `closed:true` capless loops and `smooth:true` (OCCT-native swept B-rep, STEP-exact / preview-faceted) are backend-specific, like loft's `closed`/`ruled:false`. `closed:true` loops must be **planar** — RMF frame-transport holonomy can seam-twist a non-planar closed loop where the last station rejoins the first, so only planar closed loops are supported/tested |
| `k.sphere({ r\|d })` | sphere centred at the origin; bare `k.sphere(r)` also stays valid |
| `k.roundedBox({ size, center?, round })` | box with rounded edges — `round` = number (all edges) or `{ side?, top?, bottom? }` (vertical edges / rims); built as one hand-meshed ring stack (no booleans at all, cheaper than `fillet`'s cutters); `side` must be 0 or ≥ the rim radii (between clamps with a warning); with `side > 0`, `top + bottom` must be strictly `< h` |
| `k.roundedCylinder({ r\|d, h, center?, round })` | cylinder with rounded rims — `round` = number (both) or `{ top?, bottom? }`; `round: r` with `top+bottom = h` gives a sphere (capsule when `h > 2r`); one lathe revolve, curve-exact in STEP |
| `k.torus({ rMajor, rMinor })` | torus centered at the origin (tube centerline in z=0); `0 < rMinor < rMajor` |
| `k.revolve({ profile, degrees? })` | revolve a lathe profile `[[r,z],…]` (r ≥ 0) around the Z axis (full or partial) |
| `k.helixSweptTube({ pathR, profileR, pitch, turns, z0, lefthand })` | circle swept along a helix (e.g. a rope groove). **Not for threads** — the profile is always circular and rides a frenet frame that rolls with the helix, tilting a tooth off-axis. For threads use `k.screwSweep` |
| `k.screwSweep({ profile, pitch, turns, lefthand? })` | screw-motion sweep of an **axial** lathe profile `[[r, z], …]` (same convention as `k.revolve`) — threads, worms, helical ridges. `h = pitch · turns`. The profile's axial extent must not exceed `pitch`; a profile spanning exactly `pitch` must be **periodic** (first radius == last radius) and yields a complete threaded body with no boolean (both backends) |
| `k.loftSmooth({ sections, stations?, samples?, shading?, closed? })` | smooth organic loft: ≥2 sparse control sections — point rings, `sides`+`radius`, curve contours, or `Shape2D`, vertex/corner counts may differ per section — interpolated with splines on both backends — the "here are 5 airfoil sections, make it smooth" op. The surface passes through every section exactly. A point section may tag `sharp: [indices]` to keep those vertices true corners instead of letting the spline round them off; a curve/`Shape2D` section gets its corners implicitly from its own non-smooth joints. All sections need the same corner count. `closed: true` closes the loft into a loop (Manifold-only, like `k.loft`). See the propeller reference part (`sharpTE` toggle) |
| `k.union(solids[])` | boolean union |

**`loft` rings** — each ring is `{ polygon:[[x,y],…] | sides+radius | {start,segments} | Shape2D, z, rotate?, scale? }`
(`rotate` is degrees about Z, `scale` is a number or `[sx,sy]`). A ring's `polygon` may be:
- a point list `[[x,y],…]` — plain polygon
- `{sides, radius}` — shorthand for a regular polygon
- a curve contour `{start:[x,y], segments:[...]}` — from `roundedProfile` (true CIRCLE/CUBIC edges in STEP)
- a single-region hole-free `Shape2D` — from a 2-D boolean, fillet, or other shape operation

Rings with **identical all-line segment structure** (the same straight-sided shape at different z/scale/rotate) are
bit-identical on both backends — unchanged legacy behavior, parity by construction. When such a ring set mixes a
point-list ring with a Shape2D/contour-sourced one, start-vertex correspondence is not author-controlled (a Shape2D's
contour starts wherever its outline begins) — use per-ring `rotate`, or keep every ring the same form, to control twist
phase. Rings with **identical curve structure**
(containing arcs/Béziers, the same shape at different z/scale/rotate) loft curve-natively on OCCT (STEP keeps exact arc
edges), while a Manifold preview facets at fixed LOD. **Structurally different rings** (e.g. a square morphing to a circle,
or unequal-N point lists) auto-resample to a common vertex count in shared pure-JS code, with seam = the outermost +X-ray
crossing from each ring's centroid; use per-ring `rotate` to tune the twist phase. Every backend then lofts the identical
resampled point rings — parity by construction on both — and STEP is faceted at the sampling LOD.

Author rings CCW and ordered by ascending `z` (the `regularPolygon` / `polygon.js` helpers are already CCW);
loft self-corrects a fully-inverted result so CW-wound or descending-z rings still export a valid outward solid.
Multi-region or holed `Shape2D` throws — loft each region as its own solid and union the lofts, or cut holes from
the lofted solid after it closes.

**Smooth organic lofts.** When the silhouette should be a smooth curve rather
than faceted stations, don't densify rings by hand — hand `k.loftSmooth` the
few sections you can reason about and let it interpolate (both backends;
`k.loft` stays the right tool for deliberate facets and exact station control):

```js
const sections = [0, 0.3, 0.6, 0.85, 1].map((t) => ({
  polygon: airfoil(chord(t)),        // plain [[x,y],…] point rings; counts may differ
  z: span * t,
  rotate: pitch(t),                  // authored twist sweeps correctly — vertex j
}));                                 // is the same material line on every section
const blade = k.loftSmooth({ sections });
```

Raise `samples` if the cross-section shows facets, `stations` if banding runs
along the spine. Vertex order and the vertex-0 seam are how corresponding
points line up across sections (or corner 0, when sections are tagged —
below).

Tag a true corner (e.g. an airfoil trailing edge that shouldn't be smeared
into a smooth curve) with `sharp`, an index list into that section's points —
every other section needs the same *count* of corners, tagged or implicit:

```js
// src/parts/propeller.js's sharpTE toggle: vertex 0 of each airfoil section
// is the trailing edge (upper and lower surfaces meet there); tagging it
// keeps that meeting point a crease instead of letting the spline round it.
const sections = airfoilSections.map((s) => ({ ...s, sharp: [0] }));
```

A section can also be a curve contour instead of a point ring — its corners
come for free from wherever the contour itself isn't smooth (a line/arc
joint, say), so it needs no `sharp` of its own (and rejects one if given):

```js
// a half-round "D" profile: one line segment + one arc — 2 implicit corners
// (the line/arc joints), so it can loft alongside a point section tagged
// with exactly 2 sharp indices.
const D = { start: [0, -8], segments: [{ to: [0, 8] }, { to: [0, -8], via: [8, 0] }] };
k.loftSmooth({ sections: [{ polygon: D, z: 0 }, { polygon: D, z: 10 }] });
```

Pass `closed: true` to close the loft into a loop instead of capping both
ends (Manifold-only, same restriction as `k.loft`'s `closed`; a part that
needs STEP export can't use it).

**`sweep`** takes the same CCW `polygon.js` outline as its `profile` and a plain `[[x,y,z],…]` point list as its
`path`; the profile stays perpendicular to the path (a rotation-minimizing frame), with sharp mitered corners by
default or `cornerRadius` fillets. Worked snippets:

```js
// a square tube (extrude a region with a hole) — one op, no boolean cut
k.extrude({ profile: { outer: roundedRectPolygon(40, 30, 4), holes: [circleProfile(6)] }, h: 10 });

// a tapered, twisting faceted vase wall (see src/parts/faceted-vase.js)
const rings = [];
for (let i = 0; i <= 24; i++) { const t = i / 24;
  rings.push({ sides: 6, radius: 30 - 8 * t, z: 120 * t, rotate: 90 * t }); }
k.loft({ rings });                      // ruled walls, capped ends

// a cable/hose: sweep a circle along a 3-D polyline, with rounded bends
k.sweep({ profile: circleProfile(3), path: [[0, 0, 0], [0, 0, 20], [15, 0, 20]], cornerRadius: 5 });

// round every corner of any CCW outline, then extrude/loft/prism it
k.prism({ points: filletPolygon(bracketOutline, 3), h: 4 });   // tessellated corners (faceted in STEP)
k.prism({ points: roundedProfile(bracketOutline, 3), h: 4 });  // true CIRCLE corners in STEP export

// print clearance on an arbitrary cut profile, or an inset wall
k.extrude({ profile: offsetPolygon(slotPolygon(20, 3), 0.2), h: 10 });   // slot cut 0.2 mm looser all around
offsetPolygon(outline, -wall, { corners: "sharp" });                     // inset a wall (see planter.js)

// A mounting tab: square at the root, semicircular at the tip. The arc names the
// point it must pass THROUGH (its apex), so its direction can never flip — there is
// no sweep sign to get wrong, and no Math.cos loop to write.
const tab = pathProfile([0, -w / 2])
  .lineTo([len, -w / 2])
  .arcTo([len, w / 2], [len + w / 2, 0])   // tip, via the apex
  // same arc: .arcTo([len, w / 2], { r: w / 2 }) — radius form, no via to compute
  .lineTo([0, w / 2])
  .close();
k.extrude({ profile: tab, h: 3 });

// A free-form curved side (exact on STEP, faceted at mesh LOD):
const lip = pathProfile([0, 0])
  .lineTo([20, 0]).lineTo([20, 8])
  .cubicTo([0, 8], [14, 16], [6, 16])   // curved top edge
  .close();
k.extrude({ profile: lip, h: 3 });

// Rounded enclosure: soft vertical edges, a softer lid, a flat base.
const shell = k.roundedBox({ size: [60, 40, 22], round: { side: 4, top: 2, bottom: 0 } });
```

2-D polygon helpers for `prism`/`extrude`/`loft`: `import { piePolygon, hexPolygon,
regularPolygon, roundedRectPolygon, starPolygon, slotPolygon, circleProfile, filletPolygon,
roundedProfile, offsetPolygon, pathProfile } from "partforge/geometry"`. `filletPolygon(points, r, { segs? })` rounds
every corner of a CCW polygon (per-corner radius clamped so neighbouring arcs never overlap)
and returns points usable by `prism`/`extrude`/`loft` on both backends — but it **bakes each
corner into line facets**, so STEP corners are faceted. `roundedProfile(points, r | r[])`
rounds corners the same way but keeps them **mathematically true** — it carries the arc
symbolically so STEP export gets real circular edges. Use it for `prism`/`extrude`/`loft` alike (loft lifts arc rings into its curve mode). A scalar `r` rounds every corner; a per-corner
`r[]` (length = points) rounds selectively (a `0`, a zero-length edge, or a straight/180°
corner stays sharp). `offsetPolygon(profile, delta, { corners?, segs? })` offsets a
point-list polygon or `{ outer, holes }` region by `delta` mm — positive grows material,
negative insets; regions offset material-wise (outer `+delta`, holes `−delta`, so a
clearance loosens the whole cut). `corners` picks the convex-corner style: `"round"`
(default; the true Minkowski clearance), `"chamfer"`, or `"sharp"` (miter, falling back to
chamfer past a miter length of 2·|delta|). It is **simple polygon in, simple polygon out**:
an offset whose true result would collapse or split into multiple contours (e.g. insetting a
dumbbell past its waist) **throws** a greppable error rather than returning degenerate
geometry. Being pure, it works in `derive()` as well as `build()` — the natural home for
clearance math.
`pathProfile(start)` is a fluent builder for a curve-native path contour (`lineTo` / `arcTo` / `cubicTo` / `close`); cubic segments become exact B-rep spline edges on the OCCT/STEP backend and facet at the mesh LOD on Manifold — the same exact-vs-faceted split as `roundedProfile` arcs.
`arcTo(to, via)` is a **three-point arc**: `via` is any point on the arc between the current point and `to` (its midpoint is the natural choice), and the sweep is whichever direction passes through it — so an arc's direction is a property of a point you can see, never of a sign. `arcTo(to, { r, sweep?, large? })` is the **radius form** for when you know the radius, not a point on the arc: it computes `via` from the current point, `to`, and `r`, emitting the exact same `{to, via}` segment the three-point form does. `sweep` names the direction the arc itself is traversed (default `"ccw"`), so on a counter-clockwise outline `"ccw"` bulges OUTWARD (a convex bump), and inward on a clockwise hole; `"cw"` is the reverse. `large` (default `false`) picks the major arc over the minor one when both are possible. A radius shorter than half the distance between the current point and `to` throws rather than being silently scaled up (the way SVG's arc command does) — the smallest circle joining the two points is a semicircle at `r = d/2`. Build the symmetric half of a profile once and `mirrorProfile` it (see "Editing profiles") rather than writing the mirrored arcs by hand. `loft` accepts these contours as rings (every ring with the same segment signature lofts curve-to-curve).
**`pathProfile` or an authored vector file?** Reach for `pathProfile` (and the polygon helpers above) when the geometry is **computed from parameters** — a profile whose dimensions come from `p`/`d`, which a JSON file cannot see. Reach for an authored `partforge-vector` document (`k.vector2d`, see "Vector geometry" below) when the geometry is **drawn** — a logo, a faceplate outline, a decorative cutout, where each number means one thing and gets edited on its own. The two are freely composable: both produce ordinary 2-D geometry that the same booleans and editing ops accept.
**Import geometry helpers from `partforge/geometry`, never from `partforge`** — the main
entry pulls in the DOM viewer/controls, and your build functions run in a Web Worker
(importing the main entry there throws `document is not defined`).

**`Solid` — combine / transform / export:**

| Call | Result |
|---|---|
| `s.cut(tool)` / `s.cutAll(tools[])` | boolean subtract (one / batch) |
| `s.intersect(other)` | boolean intersection (Manifold; used by collision tests) |
| `s.translate([x,y,z])` | move |
| `s.rotate(deg, center, axis)` | **internal primitive** — prefer `rotateX/Y/Z` / `rotateAbout` |
| `s.rotateX(deg)` / `s.rotateY(deg)` / `s.rotateZ(deg)` | rotate about a world axis through the origin |
| `s.rotateAbout({ axis, deg, through? })` | general rotation: `axis` = `"X"｜"Y"｜"Z"` or `[x,y,z]`; `through` = centre (default origin) |
| `s.along(dir)` | orient the canonical **+Z** build axis to point along `dir` (`"+X"｜"-X"｜"+Y"｜"-Y"｜"+Z"｜"-Z"`) |
| `s.at([x,y,z])` | place an origin-built solid at a point (readable alias of `translate`) |
| `s.mirror("XY"\|"XZ"\|"YZ")` | mirror across a plane |
| `s.scale(factor, center?)` | uniform scale (single factor) about `center` (default origin) — scaling an off-origin part about the origin also moves it; pass a center (e.g. `s.boundingBox().center`) to resize in place |
| `s.clone()` | independent copy (replicad consumes solids on transform) |
| `s.label(name)` | name this solid's surface for hover/pick feature attribution; survives transforms + booleans; same name on several solids merges into one feature |
| `s.boundingBox()` | `{ min, max, center, size }` axis-aligned bounds (query) |
| `s.volume()` | volume in mm³ (Manifold) |
| `s.toMesh({ quality })` / `s.toSTL({ quality })` / `s.toIndexedMesh()` | meshes / STL / indexed mesh (3MF) — the framework calls these |
| `k.toSTEP(named[])` | STEP bytes (OCCT only) — the framework calls this |

You normally only call the *make/combine/transform* ops; the framework handles
`toMesh`/`toSTL`/`toIndexedMesh`/`toSTEP`. Units are millimetres.

### Build-step style: orient → place, and batch features

Write build steps so intent is legible — an LLM (and a human) should not have to decode
magic vectors. Three habits:

- **Orient then place.** Build a primitive along its canonical **+Z** axis, point it with
  `along(dir)`, then position it with `at([x,y,z])`:

  ```js
  // ✗ cryptic: which axis? what centre?
  k.cylinder({ r, h: L }).rotate(-90, [0, 0, 0], [1, 0, 0]).translate([rp, y1, sz])
  // ✓ legible
  k.cylinder({ r, h: L }).along("+Y").at([rp, y1, sz])
  ```

- **Rotate about a point with `rotateAbout`** when the axis isn't through the origin
  (use `rotateX/Y/Z` for the common origin cases):

  ```js
  // ✗  .rotate(angle, [rp, 0, 0], [0, 0, 1])
  // ✓
  tool.rotateAbout({ axis: "Z", deg: angle, through: [rp, 0, 0] })
  ```

- **Batch features** instead of reassigning through a cut-chain:

  ```js
  // ✗  body = body.cut(a); body = body.cut(b); body = body.cut(c);
  // ✓
  body.cutAll([a, b, c])          // and k.union([base, f1, f2]) for additive batches
  ```

- **Size cut tools so no two of them land on exactly the same surface.** Booleans are
  cheap right up until two operands share a coincident face, at which point OCCT has to
  classify a surface belonging to both and the search degenerates — seconds become
  minutes, with no error and no warning. Manifold's mesh CSG is unaffected, so the trap
  is invisible until a STEP export (the one format pinned to OCCT) or an OCCT-routed
  build. The classic is a threaded cap: a bore sized straight off the thread's root
  diameter puts the bore wall and the thread root on the same cylinder.

  ```js
  // ✗  the bore wall lands exactly on the thread root
  const boreD = threadRootD;
  cap.cutAll([k.cylinder({ d: boreD, h }), thread]);
  // ✓  a deliberate gap, far below a printable layer
  const boreD = threadRootD - 2 * 0.05;
  ```

  The same applies to a cut that stops exactly flush with a face — overshoot it instead,
  which is why cut tools throughout this guide carry `+ 0.4` / `- 0.2` slop. See
  [boolean-coincident-faces-hang](ERROR-PATTERNS.md#boolean-coincident-faces-hang).

The bare `rotate(deg, center, axis)` remains available as the low-level primitive for
anything `rotateX/Y/Z`/`rotateAbout` can't express, but prefer the vocabulary above.

### Naming features (`.label()`)

Label your part's features, and label them **thoroughly** — this is how a user points
at what they want changed. The viewer's hover tooltip, highlight, and pick selection
all show a feature's label, so you, the app user, and an agent editing on their behalf
share one vocabulary: "make the Drainage hole 10 mm", "raise the Motor upright". A
feature with no name can't be referred to — it reads as the whole part, so the request
has nowhere to land.

Treat comprehensive labeling as the default, not a finishing touch. Name every feature
a user could reasonably want to change: the base body, and each functional feature —
grooves, mounts, bores, pockets, distinct structural members.

```js
const body = k.prism({ points: d.outerPts, h: p.height, scaleTop: p.taper }).label("Faceted wall");
let s = body.cut(cavity.label("Cavity"));
if (p.drain > 0) s = s.cut(k.cylinder({ r: d.drainR, h: p.floor + 4 }).at([0, 0, -2]).label("Drainage hole"));
```

- **Aim for functional groups.** Label at the granularity a user would name a thing
  ("Rope groove", "Tensioner pockets", "Bearing seat"), grouping repeated or related
  faces under one name. Fine enough to reference any feature; coarse enough that
  near-identical surfaces don't fragment into dozens of near-duplicates.
- A label names the solid's **surface** wherever it survives into the final part —
  a cutting tool's label lands on the faces it leaves behind (the hole's wall).
- Label **after** shaping compound tools (e.g. after an `intersect` clip) and
  either before or after transforms — labels ride through `at`/`rotate`/etc.
  Labeling a compound collapses it to ONE shading surface — the majority
  policy of its registered surfaces (by triangle count) applies to the whole
  solid, so a faceted policy also suppresses line-drawing on the compound's
  internal seams.
- **Same label merges; distinct siblings need distinct names.** The same label on
  several solids merges into one feature — label a ring of four bolt holes
  `"Mounting holes"` and they hover/highlight as one. Conversely, when two similar
  features are things a user would tell apart, name them apart — two uprights as
  `"Drum upright"` and `"Motor upright"`, not both `"Upright"`.
- Unlabeled geometry falls back to the sub-part's `label`. Faces created by
  `fillet`/`chamfer`/`shell` are new surfaces, so they use the fallback too.
- Works on both backends. On OCCT each label keeps a geometry snapshot for
  mesh-time classification, so label meaningful features (functional groups — a
  handful to a couple dozen per part), not hundreds of individual faces.
- Names should describe intent ("Drainage hole", not "cylinder2"); make them
  unique per sub-part unless you specifically want the merge behavior.

Labels do double duty in the viewer: the hover tooltip names the feature, and
**measurement mode** (the ruler button in the viewbar) measures it — a labeled
hole reads ⌀ + depth, a labeled face reads its extents, and a click pins that
dimension so it tracks parameter changes live. Label the features a user would
want to measure; unlabeled geometry still measures as its bounding box.

### Caching & determinism

The preview kernel memoizes geometry by content hash, so editing a parameter only
re-runs the operations that parameter actually affects. For this to be sound, a
`build` must be a **pure function of `(k, p, d)`** — no `Math.random`, no clock, no
module-level mutable state. An impure build will silently return stale geometry.

Cache granularity follows the operations you call. Booleans and heavy primitives are
cached; cheap transforms are recomputed. To make a multi-step shape into a single
cache node, use (or add) a **compound op** like `k.boredCylinder({ od, h, bore })` —
it hashes from its own arguments and never exposes its internals to the cache. The heavy
primitives `loft`, `sweep`, `extrude`, `prism`, and `revolve` are cached this way too:
their hash folds every shape-affecting argument (each `loft` ring's points/`z`/`rotate`/`scale`,
`sweep`'s profile points/path points/`cornerRadius`/`closed`, `extrude`'s holes, an arc
profile's segment specs from `roundedProfile`, and the tessellation from `twist`), so
changing any of them is a fresh cache node while an identical rebuild is a hit.

This holds on **both backends** — and on OCCT, `translate`/`rotate` are additionally
*pose-lazy*: the backend re-poses the cached solid's cached tessellation instead of
re-running any B-rep work. A parameter that only feeds a final placement rotation (a
lid's open angle, an exploded-view offset) therefore re-drags in ~0 ms even on the
slow exact kernel — keep such transforms as the last ops in `build` (or in `place`)
rather than baking them into the geometry earlier. In the app, such pose-only edits
skip the worker entirely — the viewer re-poses the cached mesh — so they stay smooth
even at animation rates (see `runtime.setParams`).

---

## Parameters: the control-panel schema

`src/parts/planter.js`'s "Body" section is a live in-repo example of the full node
shape — a preset, headline sliders, and a nested `"Wall"` group holding a
`recommended` band and an `innerDia` readout. `src/parts/bracket.js`'s "Shape ops"
section shows a `"radio"` control, and mixes it with two sections left on the legacy
shape — proof the two coexist in one part.

`parameters` is an **array of sections**. Each section is a node with a `controls`
array, and **authored order is render order** — what you write top-to-bottom is what
the user reads top-to-bottom:

```js
{
  id: "body",              // optional; also the node id (see "Ids" below)
  title: "Body",
  description: "...",      // CommonMark, behind the section's ⓘ glyph
  collapsed: "auto",       // true | false | "auto" (default)
  when: { ... },           // optional condition — see "Conditions" below
  controls: [ /* entries, in render order */ ],
}
```

Every entry in `controls` is one of four things, told apart by its `type`:

- a **control** — bound to one key in `defaults` (`type` defaults to `"slider"`,
  so a plain `{ key, label, min, max, step }` is a slider);
- **`type: "group"`** — a nested container with its own `controls` array;
- **`type: "preset"`** — a picker that writes a bundle of parameters at once;
- **`type: "readout"`** — a read-only display of a `derive()` output.

Groups nest, but **two levels is the limit** — a section plus one fold inside it is
as deep as a 300 px rail stays readable, and `partforge lint` warns (`group-depth`)
past that. Flatten by promoting the inner group to its own section.

A complete section, exercising most of the model:

```js
defaults: { profile: "round", facets: 6, dia: 80, wall: 2, feet: 0 },
derive: (p) => ({ innerDia: p.dia - 2 * p.wall }),

parameters: [
  {
    id: "body",
    title: "Body",
    description: "Silhouette and size of the vessel.",
    controls: [
      { type: "preset", presets: {
          "Pen cup": { dia: 80,  wall: 2,   profile: "round" },
          Vase:      { dia: 120, wall: 2.4, profile: "faceted", facets: 8 },
      } },

      { key: "profile", type: "radio", label: "Profile",
        options: [{ value: "round", label: "Round" }, { value: "faceted", label: "Faceted" }],
        description: "**Round** revolves the silhouette; **faceted** prisms it." },

      { key: "facets", type: "slider", label: "Facets", min: 3, max: 12, step: 1,
        when: { profile: "faceted" },              // only shown on a faceted profile
        description: "Sides of the prism. 6–8 reads as faceted without looking coarse." },

      { key: "dia", type: "slider", label: "Diameter", unit: "mm", min: 30, max: 150, step: 1,
        description: "Outer diameter at the widest point; 60–100 mm suits a pen cup." },

      { type: "group", title: "Wall", collapsed: "auto", controls: [
        { key: "wall", type: "slider", label: "Thickness", unit: "mm",
          min: 0.8, max: 4, step: 0.1, recommended: [1.2, 4],
          description: "Wall thickness. Under 1.2 mm an FDM print gets fragile." },

        { type: "readout", label: "Inner diameter", derivedKey: "innerDia", unit: "mm",
          description: "Diameter minus both walls — the space something actually has to fit into." },

        { key: "feet", type: "checkbox", label: "Raised feet", on: 3,
          description: "Lift the base on four 3 mm feet so it drains and de-moulds cleanly." },
      ] },
    ],
  },
]
```

Every control `key` must exist in `defaults`, or the control is silently dead —
`control-key-not-in-defaults` is an error for exactly that reason. Its value there must
be a **number, string or boolean** — a control writes one scalar, so a control bound to
an array, an object, `null` or `NaN` is dead in the same silent way
(`control-default-not-primitive`), and a host that saves panel settings back into
`defaults` cannot write that value either. A non-primitive `defaults` entry that no
control is bound to is fine: `defaults` also seeds `p` for `build()`.

**Ids.** A section, a group and a preset may carry an `id`; the renderer keys its
element, state and disclosure maps on ids, so they must be unique across the whole
panel (`duplicate-node-id`). A **control** entry's `id` is ignored — controls get
positional ids — and lint reports it as an unknown field. Leave `id` off unless you
need a stable handle.

### Control types

Every control accepts `key`, `type`, `label`, `description`, `hidden`, `when` and
`whenFalse`. Beyond those:

| `type` | Renders as | Extra fields |
|---|---|---|
| `"slider"` (default) | a range track plus an editable number box | `unit`, `min`, `max`, `step`, and the refinements below |
| `"number"` | the number box alone — for precise or very wide ranges | `unit`, `min`, `max`, `step`, `recommended` (see below) |
| `"text"` | a single-line string field | — |
| `"textarea"` | a multiline string field; line breaks are preserved | — |
| `"checkbox"` | an on/off box: ticked writes `on`, cleared writes `0` | `on` (default `1`) |
| `"select"` | a dropdown | `options` |
| `"radio"` | a segmented button row | `options` |
| `"font"` | a typeface picker with a catalog, else a drop target | `allow`, `preview`, `sourceField` |
| `"image"` | an image picker with a catalog, else a drop target showing the artwork | `allow`, `sourceField` |
| `"vector"` | a drop target showing the artwork — no catalog exists | `sourceField` |
| `"custom"` | a widget the part draws itself — see "Custom controls" below | `widget`, `keys` |

Numeric controls always show the number box: drag the slider *or* type an exact
value. Typed values may be finer than `step` and may sit **outside `[min, max]`**:
the range bounds the slider track, not the parameter. An out-of-range value commits
as typed and the build runs with it — the box turns red while the value is outside
the range, the thumb pins at the nearer end of the track, and a build that can't
take the value fails in the status line while the viewer keeps the last good
geometry. A build that *succeeds into nothing* (a boolean that empties a sub-part)
is reported there too — "empty: body produced no geometry at these values". Author
`min`/`max` as the span the track should cover, not as a guard the build relies
on; a build that needs a floor clamps it itself.
Text fields write `params` on every keystroke, so the rebuild loop previews the new
string immediately; give every text key a string default (empty strings are valid,
and the build decides whether its geometry tolerates one).

**`options`** (select/radio) takes either the shorthand `["round", "faceted"]` —
each entry is both value and label — or the long form
`[{ value, label, description? }]`. Values may be strings or numbers, and
`defaults[key]` **must be one of them** (`select-default-not-in-options`; watch
types, `12` is not `"12"`). An option's `description` surfaces as a hover tooltip
on that one option, not as a ⓘ popover.

**`sourceField: true`** (font/image/vector) adds a raw source text box to the
control. It is **off by default**: the drop target already carries the preview,
the drag target and click-to-choose, and where a catalog is wired there is a
picker too, so on a 288 px rail a text box is the affordance earning its space
least. Turn it on when typing a source by hand is something your users will
actually do — pasting an `https:` URL they already have, or a host `pfc-asset:`
token. Hiding it changes nothing else: the same values are accepted by the same
allow list, and a source set in `defaults` or by the host still applies.

For a `"font"` control with no `fontCatalog` this is the only text entry there
is, so a standalone app that expects users to paste font URLs should set it.

**`allow` and `preview`** (font) configure the typeface control. `allow` lists the
source kinds a **param-supplied** value may use — what the picker writes, or what
arrives in a share link:

| value | accepts |
|---|---|
| `"https"` | any `https:` URL. **The default** — omitting `allow` means `["https"]` |
| `"gstatic"` | `https://fonts.gstatic.com` only (hostname-exact: a lookalike host is refused) |
| `"asset"` | a `pfc-asset://` token — a font the host has stored for this part |

Name as many as apply (`allow: ["gstatic", "asset"]`); anything unnamed is refused,
which is how `http:`, `file:`, `data:` and `blob:` are closed off. The check is
deliberately narrow — **it applies only to values that arrive as params.** A source
you write into `fonts` yourself is code, not user input, and stays unrestricted:
`fonts: { label: "https://cdn.example.com/Courier-Prime.ttf" }` keeps working
whatever `allow` says. A refused param falls back to `defaults[key]`, and the build
carries a warning naming the key rather than failing (lint's `font-source-scheme`
catches the case where that default is itself refused). `allow` gates what the
**picker fetches** too: a family whose files it refuses is dropped from the list
rather than offered, and neither that family's name-preview face nor its weight
samples are ever requested.

`preview` is the sample string the picker's weight list renders each face in — set
it when the generic sample shows the wrong glyphs (`preview: "0123456789"` for a
part that letters digits). Defaults to `Hamburgefonstiv 0123`.

**`"readout"` is not a control.** It has no `key`, never writes `params`, and can
never be a preset target. It displays one output of `derive()`, named by
`derivedKey`, refreshed on every parameter change; `unit` is appended to numeric
values. A `derivedKey` no `derive` group returns shows an em-dash forever, which
`readout-unknown-derived-key` warns about. Readouts are how a panel closes the loop
on design intent — show the user the clearance, the inner diameter, the resulting
wall — without adding a parameter nobody should edit.

**A `group`** takes `type`, `id`, `title`, `collapsed`, `bare`, `controls`,
`hidden`, `when` and `whenFalse`. It deliberately takes **no `description`**: the
fold's title is itself a button, and there is nowhere to hang an ⓘ glyph beside it.
Put the explanation on the section or on the controls inside. `bare: true` drops the
title and the disclosure entirely, leaving an indented block — useful for a run of
controls that appear and disappear together under one `when`.

### Control metadata

- `description` — a CommonMark string shown in a click-open **ⓘ** popover beside the
  label. Supports **bold/italic**, lists, `code`, links and images (for diagrams);
  links open in a new tab and the rendered HTML is sanitized. Write one for every
  control — see "A description for every control" below.
- `hidden: true` — omits the node from the panel. Its `key` must still exist in
  `defaults` and still drives the geometry: this is *no UI*, not *no parameter*. Use
  it for internal constants the end user shouldn't edit. A group left with no visible
  children doesn't render at all, and neither does an empty section.

### Slider refinements

Three optional fields shape how a numeric track behaves. All three are worth reaching
for when a raw linear slider misrepresents the parameter.

- **`scale: "log"`** — the thumb travels geometrically, so a 0.1–100 range gives each
  decade equal width instead of burying everything below 10 in the first pixel. The
  number box stays linear and exact, so typing `0.5` still works. `min` **must be
  greater than 0** (`log(0)` is `-Infinity` and the mapping breaks); lint reports
  `log-scale-needs-positive-min`.
- **`ticks: [...]`** — marked values on the track (a native `datalist`). Every tick
  must sit inside `[min, max]`. Add **`snap: true`** to quantize *slider drags* to the
  nearest tick; the number box stays free, so an off-tick value is always still
  typeable. Use it for stock sizes: M3/M4/M5, 3 mm / 6 mm plate.
- **`recommended: [lo, hi]`** — tints that span of the track. This is the **visual
  companion to the DFM checks**: the band is where the process the part targets is
  comfortable (minimum wall, nozzle multiples, sane clearances), and `verify`'s
  `minWall` / process checks are the same judgement enforced at measure time. It is
  purely advisory — it never colours the number box (red is reserved for values
  outside `[min, max]`), and outside values remain selectable, because a user who
  knows their printer should not be blocked by a default profile. Say **why** the
  band sits where it does in the control's `description` ("below 1.2 mm a 0.4 mm
  nozzle prints walls poorly"); the band alone is a hint, the description is the
  reason.

`ticks`, `snap` and `recommended` render on a **linear track only**; combined with
`scale: "log"` they are ignored, and `slider-refinement-invalid` warns. On a
`"number"` control there is no track at all, so `recommended`, `scale`, `ticks` and
`snap` do nothing.

### Conditions: `when` and `whenFalse`

`when` is valid on **any** node — a control, a group, a preset, a readout, or a
section itself. It is a plain data condition evaluated against raw parameters:

```js
when: { profile: "faceted" }                            // equality
when: { wall: { gte: 1.2 } }                            // gt | gte | lt | lte | ne
when: { style: { in: ["cup", "vase"] } }                // membership
when: { drain: { gt: 0 }, mode: "planter" }             // multiple keys are ANDed
when: { allOf: [{ drain: { gt: 0 } }, { mode: "planter" }] }
when: { anyOf: [{ style: "cup" }, { style: "vase" }] }
when: { not: { style: "plain" } }
```

The operators are `gt`, `gte`, `lt`, `lte`, `ne` and `in`; the combinators are
`allOf`, `anyOf` and `not`. Two rules make conditions statically checkable, and both
are enforced as **errors** because either failure is silent at runtime:

- **Raw parameter keys only.** A `when` reads keys from `defaults`, never derived
  values — that is what lets lint check every referenced key against `defaults`
  (`when-key-not-in-defaults`), which no predicate function could support. Readouts
  reach derived values through their own `derivedKey`, so there is never any doubt
  which namespace a name is in.
- **Known operators only.** `evalWhen` treats an unrecognised operator as false, so a
  typo would hide the node forever; `when-unknown-operator` catches it first.

A malformed condition evaluates to `false` rather than throwing — a control that
hides is better than a panel that crashes.

When the condition is false the node is **removed from the layout**, taking its
subtree with it if it is a group. Set **`whenFalse: "disable"`** to grey it in place
instead, for the case where the user should see that an option exists but needs
something else switched on first. Disabling propagates through the whole subtree and
sets real `disabled` attributes, so a disabled control cannot be focused or dragged.

**`when` is not relevance dimming.** The panel also dims controls automatically, and
the two are different mechanisms that must stay visually distinct:

| | Relevance dimming | `when` |
|---|---|---|
| Answers | "does the geometry on screen actually read this parameter?" | "did the author say this applies right now?" |
| Comes from | probing the build — automatic, nothing to write | your `when` condition |
| Looks like | faded but fully usable, with a "doesn't affect the parts in the current view" tooltip | gone from the layout, or genuinely disabled |

A control can be relevant but conditioned away, or conditioned in but irrelevant.
Both recompute on the same tick as any parameter change. Don't reach for `when` to
reproduce dimming — you'd be hand-maintaining something the framework already knows.

### Collapsing

Every section and every titled group is a disclosure, controlled by `collapsed`:
`true` (start closed), `false` (start open), or `"auto"` (the default). `"auto"`
defers to one rule:

> A panel with **three or fewer visible top-level sections** opens every `"auto"`
> section and fold on load. Beyond that, they all start closed.

The rail is a fixed-height column, and a long part otherwise scrolls forever; three
sections is a panel the user can take in at a glance. The count is over the sections
in the built tree — `hidden: true` sections and sections left with nothing in them are
gone before counting, but a section that a false `when` or relevance merely hides from
view still counts, since it can come back without rebuilding the panel.
Only the **first** render applies it — after that the user's own clicks own the folds,
and a slider drag never snaps a section they opened back shut. A `bare: true` group
has no disclosure at all and is never collapsed.

### Presets

A preset picker is a node like any other:

```js
{ type: "preset", label: "Size", presets: {
    M3: { od: 8,  bore: 3.4, h: 10 },
    M5: { od: 12, bore: 5.4, h: 16 },
} }
```

Each key of `presets` is a name, each value a bundle of parameter overrides (every
key of which must exist in `defaults` — `preset-key-not-in-defaults`). The picker
lists the names plus **Custom**, and opens on the first name. Choosing a preset
assigns its overrides over `params` and refreshes that section's controls; editing
any control in the section afterwards drops the picker to **Custom**.

Because it is a node, a picker can sit **anywhere** in `controls` — among the
controls it affects, not necessarily at the top — and a section may carry more than
one. Note that Custom-marking tracks the section's **first** picker only, so if two
pickers in one section both need to show divergence, give each its own section.

**Preset names are global to the part**, not to the section: `verify()` expands one
case per preset name (so every preset gets measured), and a repeated name throws
there. `duplicate-preset-name` catches it at lint time instead.

### Custom controls

A `type: "custom"` control renders a widget the part draws itself — a clickable hex
grid, an organizer whose walls toggle on click, a picture of the part's own outline
with hot regions. Reach for it when the user configures **many similar things
individually**, or makes a **spatial choice** no slider or select can express.
Never for a value an existing control already covers: a slider is still a slider.

```js
// part.js
import { tilePicker } from "./tile-picker.js";

export default {
  defaults: {
    tileSize: 20,
    tiles: [{ q: 0, r: 0, height: 10 }, { q: 1, r: 0, height: 14 }],
  },
  parameters: [{
    title: "Tiles",
    controls: [
      { type: "slider", key: "tileSize", min: 10, max: 40 },
      { type: "custom", key: "tiles", label: "Tile layout", widget: tilePicker,
        description: "Click a tile to select it. Drag to move it." },
    ],
  }],
  parts: { tiles: { build: (k, p) => /* p.tiles is the array */ } },
};
```

- `key` names the param the widget owns. It may hold a **JSON value**: numbers,
  strings, booleans, arrays and plain objects of those, at most 16 KB serialized and
  8 levels deep, never `null` (`custom-default-not-json`). `build()` reads it like any
  other param. This is the one place the "a control writes one scalar" rule is relaxed.
- `keys` (optional) lists further scalar params the widget may also write.
- `widget` is a function `(host) => …`, normally imported from a sibling file so
  `part.js` stays readable (`custom-control-widget-not-function`).
- `label`, `description`, `hidden`, `when` and `whenFalse` behave as on any control.

**The widget function.** It runs once per mount and draws into `host.el` with plain
DOM and SVG. It may return `{ update, dispose }`.

```js
// tile-picker.js
export function tilePicker(host) {
  const svg = host.h("svg", { viewBox: "0 0 200 160", width: "100%" });
  const detail = host.h("div");
  host.el.append(svg, detail);
  let stopDetail = null;

  function draw() {
    const tiles = host.get();                 // a fresh clone of the owned value
    const sel = host.state.selected ?? null;  // survives the remount an edit performs
    svg.replaceChildren(...tiles.map((t, i) => host.h("polygon", {
      points: hexPoints(t.q, t.r), class: i === sel ? "pf-hit selected" : "pf-hit",
      onpointerdown: () => { host.setState({ selected: i }); draw(); },
    })));
    stopDetail?.();
    stopDetail = sel === null ? null : host.controls(detail, [
      { type: "slider", key: "height", label: "Height", min: 4, max: 30 },
    ], { path: `${sel}` });
  }
  draw();
  return { update: draw, dispose: () => stopDetail?.() };
}
```

**The host.**

| Member | Meaning |
|---|---|
| `host.el`, `host.doc` | The slot to draw into, and its document. |
| `host.get(key?)` | A clone of the current value (default: the owned key). Any param is readable. |
| `host.set(value, {key?, commit?})` | Replace a value with a **new** one — never mutate what `get` returned. Schedules the rebuild and commits, unless `commit: false`; then call `host.commit()` when the gesture ends (a drag). Throws for a key you do not own or a value outside the contract. On a **retired** widget (one whose code already threw) `set`, `commit` and `setState` are silent no-ops. |
| `host.commit(keys?)` | Ends a deferred gesture. A no-op when nothing changed. |
| `host.derived` | The latest `derive()` output, the same object readouts show. |
| `host.state`, `host.setState(patch)` | Transient JSON (a selection, an open panel). Not a param, never persisted, but it **survives a remount**, which every edit performs. |
| `host.controls(container, controls, {path})` | Mount ordinary built-in controls bound *inside* the owned value at a dotted `path` (`"3"`, `"walls.north"`). Their edits commit the owning key. Returns a disposer. One level: no custom control inside, and no `font`, `image` or `vector` sub-control at a path (their asset lookups are keyed on the part's real param names). |
| `host.h(tag, attrs, ...children)` | Element builder. SVG tags get the SVG namespace; `on<event>` attrs become listeners; `class` and `style` pass through. |
| `host.svg(text)` | Parse an SVG string to an element you can append and wire up. |
| `host.svgFromVector(doc)` | A partforge-vector document → inline `<svg>` (the same renderer the `vector` control uses). |
| `host.file(pathOrToken)` | Text of one of the part's own files, by path or a `pfc-tree://` token, or null. |
| `host.disabled` | Whether a `when`/`whenFalse: "disable"` currently disables this control. |

`update({reason, disabled})` is called when your key changes from outside the widget
(`reason: "sync"` — a preset, undo, `setParams`), when `derived` changes
(`"derived"`), and once after `host.state` was restored on mount (`"restore"`). It is
**not** called for your own `set`. `dispose()` runs on teardown.

**Rules that keep it working.**

1. Size SVG with `viewBox` plus `width: 100%`. The rail is 288px wide by default and
   narrower on a phone, where it is the bottom sheet.
2. Use pointer events, not mouse events, and put `class="pf-drag"` (or
   `touch-action: none`) on anything dragged — otherwise a finger scrolls the sheet.
3. Keep selection and similar state in `host.state`, not in a closure: every edit
   remounts the part and your function runs again.
4. Hand `set` a new value. `get` returns a clone precisely so the stored value is never
   edited in place.
5. A throw in creation, `update`, or a listener installed through `host.h` replaces
   the widget with an error card and reports it (a hosting agent sees it in the apply
   result as `panelErrors`); other controls keep working. A throw in `dispose` is
   reported the same way but leaves no card — there is nothing left to show it on. A
   listener you attach yourself with `addEventListener`, rather than through `host.h`,
   is **not** guarded — wire listeners through `host.h`, or wrap your own in try/catch.

**Looking native.** The slot inherits the rail's font and text colour, and the
built-in looks come for free: bare `<button>`, `<input>` and `<select>` elements
are already styled, the built-in classes are there by name for the exact thing —
`row`, `seg` (a segmented row of buttons), `action`, `ghost`, `num`, `text-input`,
`select-input` — and sub-controls mounted through `host.controls` *are* the
built-in widgets. For SVG there are two classes: `pf-hit` (a clickable region,
with a `selected` state) and `pf-drag`.

**Colour only with the rail's tokens.** Inheriting the rail's colours covers the
text you did not style; it does not cover anything you colour yourself. For that,
use a `--pf-*` custom property and never a hex literal or a named colour — the
tokens flip with the light/dark theme and a literal cannot, so a `#333` border is
a widget that is unreadable in one of the two themes. The ones worth knowing:
`var(--pf-text)` and `var(--pf-text-2)` for text, `var(--pf-muted)` for a
secondary label, `var(--pf-border)` for a rule or an outline,
`var(--pf-surface-2)` for a filled chip, `var(--pf-accent)` with
`var(--pf-on-accent)` for the selected or primary thing, and `var(--pf-err)` for
a problem. That palette is the whole palette: the accent blue for the one thing
that is chosen or primary, the surface and border greys for everything else. A
widget that reaches past it for a red or a green is a widget that has stopped
looking like the rest of the panel.

**Nest a region's label inside the region.** The common case then needs no colour
from you at all: an SVG shape you leave unfilled inherits `var(--pf-text-2)`
rather than SVG's own black, a `pf-hit` region is filled and outlined at rest,
and a `<text>` *inside* that region stays readable through all three states —
the rail gives it `var(--pf-text-2)` at rest and `var(--pf-on-accent)` once the
region is selected and has gone solid accent underneath it, and clears the
stroke it would otherwise inherit from the region's outline (SVG paints that
around every glyph, which at label sizes leaves a pale ghost of the number).
Draw the label as a sibling instead and none of that reaches it: a dark number
sitting on the selected blue is the result, and you have to colour it yourself.
To colour a
region from your own data, set an inline `style` — a `fill="…"` attribute loses
to the rail's rule.

**Reading the part's own files.** Artwork can live beside the code (the tree is text,
so an SVG, a `partforge-vector` JSON document or a JSON data file — not a PNG).
Two routes: store the SVG as a string in a JS module (`assets/emblem.svg.js` exporting
a template literal) and import it like any sibling file — no framework support
needed; or read it with `host.file("assets/emblem.svg")` and inline it with
`host.svg(text)`. Give regions ids and wire `pointerdown` on `#wall-3` to toggle
`walls[3]` in the owned value.

**What a widget cannot do.** Never `fetch` or otherwise reach the network — a widget
is a pure function of the part and its params, and a hosted sandbox may refuse the
request or have no credentials to make it with. Also: no imports beyond the part's
own files, nothing outside `host.el`, and no reading of `params` except through
`host`.

### Legacy section shapes (still supported)

Everything above is what a **new part should write**. The original array-based shapes
predate the node model, still work exactly as they always did, and are not going
away — most of the in-repo parts are deliberately left on them as live proof.
`desugar()` normalizes them into the very same nodes, so the **runtime** is uniform:
one renderer, one state pass, one set of lint walkers, whichever shape you wrote.

The **authorable surface is not** uniform, and deliberately so — the legacy
descriptors are frozen at the fields they always had. `when`, `whenFalse` and
`collapsed`, and the `"checkbox"`, `"select"`, `"radio"` and `"readout"` types, exist
in the `controls` shape **only**. Written on a legacy descriptor they are dropped and
reported as `unknown-control-field`; a legacy section's `collapsed` is ignored
silently. Reach for any of them and you are writing a `controls` section.

| Legacy | Normalizes to |
|---|---|
| `presets: {...}` | a `{ type: "preset" }` node, first child of the section |
| `toggles: [{ key, label, on }]` | `"checkbox"` controls placed directly in the section, after the picker and before the Advanced fold |
| `advanced: [...]` | a nested group titled **Advanced**, `collapsed: "auto"` |
| `features: [{ key, on, sliders }]` | per feature: a `"checkbox"`, followed by a `bare` group of its sliders carrying `when: { [key]: { gt: 0 } }` — both inside the Advanced group |
| `control: "number"` | `type: "number"` |
| `hidden: true` | kept through desugaring (lint needs it), dropped when the render tree is built |

**Preset + controls section** — a picker, standalone toggles, and an Advanced fold:

```js
{
  id: "body",
  title: "Body",
  presets: { M3: { od: 8, bore: 3.4, h: 10 }, M5: { od: 12, bore: 5.4, h: 16 } },
  toggles: [
    { key: "clip", label: "Clip arms to a disc (intersect)", on: 1,
      description: "**Intersect** the cross with a circle so the arm tips round off." },
  ],
  advanced: [                                  // controls revealed under "Advanced"
    { key: "od",   label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 },
    { key: "bore", label: "Bore", unit: "mm", min: 1, max: 30, step: 0.1, control: "number" },
    { key: "title", label: "Title", control: "text" },
  ],
}
```

`control` is the legacy spelling of `type` and takes `"slider"` (the default),
`"number"`, `"text"` or `"textarea"` — the newer `"checkbox"`, `"select"`, `"radio"`
and `"readout"` types exist only in the `controls` shape. A `toggles` entry is
`{ key, label, on?, hidden?, description? }`: checked writes `on` (default `1`),
unchecked writes `0`. It is the right home for a bare boolean in this shape —
`src/parts/hull-sweep.js`'s `wrap` toggle is the in-repo example.

**Feature-toggle section** — a checkbox that enables a feature *and* reveals its own
sliders (`0` = off):

```js
{
  id: "flange",
  title: "Flange",
  features: [
    { label: "Base flange", key: "flange_d", on: 16,
      sliders: [{ key: "flange_d", label: "Flange diameter", unit: "mm", min: 8, max: 50, step: 1 }] },
  ],
}
```

A feature's `on` is **required and must be greater than 0** — it is the real value the
parameter takes when the box is ticked (a diameter, a count), and the panel reads
`> 0` as "enabled", so there is nothing sensible to fall back to
(`features-requires-on`). `sliders` is required too (`features-requires-sliders`) — it
is what the checkbox reveals, and a feature with nothing to reveal belongs in
`toggles` instead. A section carrying `features` renders *only* its features — its
`presets`, `toggles` and `advanced` are ignored. `src/parts/demo.js`'s `flange` is the
in-repo example (`planter.js` has a second one).

Three behaviours differ between the shapes, and they are frozen that way on purpose:

- A legacy **feature** checkbox restores the magnitude the user had dialled in when
  re-ticked; an authored `"checkbox"` always writes `on`. The node-model way to get a
  feature is a checkbox plus a group gated on `when: { key: { gt: 0 } }` — which is
  exactly what `features` desugars to.
- **Every** control in a `controls` section marks the section's picker Custom when
  edited. In the legacy shapes, feature sliders and toggles do not.
- Collapse state is not authorable here, per the surface note above: a legacy section
  and the "Advanced" fold it desugars to are both always `"auto"`, so they follow the
  three-section rule and nothing else.

**A section is one shape or the other.** Mixing `controls` with `advanced`,
`toggles`, `features` or `presets` is the error `mixed-section-shape` — the render
order of the mixture would be arbitrary. (`controls` wins if you do it anyway.) A
single *part* may mix freely, one shape per section, so migration can go section by
section.

---

## Designing the control panel

A good part exposes a **simple** interface — a handful of controls most users will
touch — while still giving deep, correct adjustability underneath. `src/parts/demo.js`
is the worked example for the patterns below.

### Procedural & parametric parts

Drive many features from a few controls, so tweaking one control reshapes the part
coherently:

- **`derive(p) => d`** computes shared/dependent values once per build; sub-part `build`
  functions read `d`. Put the "design intent" math here — clearances, ratios, wall
  thicknesses — so a single input feeds everything downstream. In the demo, `derive`
  turns the nominal `bore` into `boreR` (with a fixed print clearance) and `h` into the
  cut-tool height `cutH`; `build(k, p, d)` reads those.
- **Grouped `derive` (recommended once it grows):** `derive` may instead be an object of
  named group functions, run in declaration order; each group receives `(p, d)` where `d`
  holds the merged outputs of the groups **before** it:

  ```js
  derive: {
    core:  (p) => ({ boreR: p.bore / 2 + 0.15 }),
    stand: (p, d) => ({ postH: d.boreR * 4 + p.base_t }),   // may read earlier groups
  }
  ```

  Builds see the same merged `d` either way. The point is the **control panel's
  relevance dimming** (and the rebuild cache): with a single function, a sub-part that
  reads *any* derived value is assumed to depend on *every* param `derive` touches, so
  e.g. stand-only controls stay lit in a drum-only view. With groups, each derived key
  is attributed to just its own group's inputs (plus, transitively, those of the groups
  it read), so unrelated controls dim correctly. Group along your sub-part seams:
  values only one sub-part family reads belong in their own group.

  Grouped-form rules: a group reading a key **no earlier group produced** throws
  immediately (misordered groups / typos would otherwise surface as silent NaN
  geometry) — this includes optional-chaining reads like `d.maybe?.x`, so probe for a
  conditionally-produced key with `"maybe" in d`, not `?.`. Prefer returning values
  over mutating `d` in place — mutation works and is tracked, but returned keys read
  clearer. Outside the part definition (helpers, tests), merge groups with
  `resolveDerived(part, p)` from **`partforge/derive`** — a lean, DOM-free entry safe
  to import from part modules; don't hand-roll the merge.
- **Reuse a param `key`** across sub-parts/features so one slider moves all of them.
- **`enabled(p)`** gates a whole sub-part on a toggle param (the part appears/disappears
  with the control).

### Progressive disclosure (simple, but deep)

Tier the controls so the default view is uncluttered:

1. **Presets** for the common cases — the first thing most users pick.
2. A **few primary controls** for the dimensions users change most, sitting loose in
   the section.
3. **A nested group** (`{ type: "group", title: "...", collapsed: "auto" }`) for the
   rest — one per idea, titled for what it is (`Wall`, `Lid`, `Mounting`), not
   "Advanced". Two levels is the ceiling.
4. **`hidden: true`** for internal constants the end user shouldn't edit.

Keep a section to **12 visible controls or fewer** — past that `section-too-many-controls`
warns, because more than a dozen in one column reads as a wall rather than a set of
choices. If a section is over budget, the fix is almost always that two ideas are
sharing it: split the section, or hide internals (`hidden: true`) — grouping
organizes but does not reduce the count.

Aim for a panel whose first screen is a handful of controls, and whose full design is
one click away in a fold.

### Choosing a control

The type carries meaning, so pick the one that matches the parameter rather than
defaulting everything to a slider:

- **A continuous dimension** → `"slider"`. Add `recommended` when there's a
  manufacturable band, `ticks` + `snap` when real-world stock sizes exist, and
  `scale: "log"` when the range spans decades.

  **Make the range generous.** `min`/`max` bound the slider track, not the
  parameter — a user can type past either end and the build runs with it — so the
  range is the whole span the build can turn into sensible geometry, not the
  neighbourhood of the default. As a floor, reach at least ¼× and 4× the default,
  and much further for an open-ended dimension (a length, a height, a count).
  Where one value must stay below another (a fillet radius against a half-width),
  clamp it in `build` or `derive` rather than narrowing the range: a narrow range
  is a limit the user hits immediately, a clamp is one they never notice. Typical
  values belong in the `description`; a process limit belongs in `recommended`,
  with the reason in the description.
- **A precise or very wide number** (a count, a tolerance, a coordinate) →
  `"number"`, so the user types rather than hunts.
- **A discrete choice** → `"select"` when the values are a list, or `"radio"` when
  there are **2–4** of them and seeing all the options at once is part of the
  decision. Never fake either one with a slider over magic integers.
- **A boolean** → `"checkbox"`. Ticked writes `on`, cleared writes `0`; there is no
  reason for a two-position slider to exist.
- **A computed value the user should see but not set** → `"readout"`. It costs no
  parameter and answers the "so what did that do?" question in place.
- **Many similar things configured individually, or a spatial choice** (which tiles
  exist and how tall each is; which walls of an organizer are present) →
  `"custom"`: a widget the part draws, holding one JSON value. See "Custom controls"
  above; use it only when no built-in control expresses the choice.

Then gate what doesn't always apply. A control that is meaningless in the current mode
should carry a **`when`** rather than sit there inert — hide it by default, or use
`whenFalse: "disable"` when its existence is itself the information ("Lid hinge:
enable a lid first"). Conditions are also the cheapest way to keep a section under
budget: three mode-specific controls that are never all relevant at once cost the
reader one.

Finally, **every control gets a `description`** — see below.

### Ordering and naming

Authored order is render order, so spend it deliberately: put the control a user
reaches for first at the **top** — usually the primary dimension the presets don't
settle — and order the rest by how a user thinks about the part, not by the order
the build consumes them. A user scans the rail top-to-bottom once; the control they
need should sit where that scan expects it, with fine-tuning below it and
housekeeping last.

Labels are for reading, not for the build: a short noun phrase (**"Wall
thickness"**, **"Bolt hole ø"**), with units in `unit:` rather than in the label
text, and never a parameter key or build-internal jargon — `flange_d` is a key,
"Flange diameter" is a label. Every label must make sense on its own with its
neighbours folded away; if a label only reads correctly next to another control
("Diameter" … "Diameter" in two groups), rename until each stands alone or regroup
until they are one idea.

### A description for every control

Give every section and control a `description`. Keep each one short and make it cover:

- **what** the control does,
- its **units**,
- a **sensible range** (and what's typical),
- **when it matters** (what it interacts with).

Use Markdown links or images for diagrams and deeper reference. These are the popovers
end users rely on — treat writing them as part of authoring the control, not an
afterthought.

### The relevance-aware panel

The panel updates itself to match what's on screen: a **section is hidden** when none of
its controls affect the active view's visible parts, and a **control is dimmed** (but
still usable) when it doesn't currently affect them — recomputed as the view and the
parameters change. You don't wire this up; it's automatic. To get the most from it:

- Group controls into **sections by the sub-parts they affect**, so whole sections drop
  away in views that don't use them.
- Scope a parameter to the **views/sub-parts that read it** — a control read by no
  on-screen part shows dimmed, which is a useful signal that it's vestigial or
  misplaced.

This is a separate mechanism from `when`, and stays visually distinct from it on
purpose — see "Conditions: `when` and `whenFalse`" above for the split.

---

## Profiles & patterns

Pure helpers from `partforge/geometry` (no backend dependency):

**2-D profiles** (CCW point arrays for `k.prism` / `k.revolve`):
`roundedRectPolygon(w,h,r)`, `regularPolygon(n,r,{flat})`, `ellipsePolygon(rx,ry)`,
`slotPolygon(length,r)` (overall length = `length + 2r`), `starPolygon(points,outerR,innerR)`,
`ringSectorPolygon(innerR,outerR,arcDeg)` (**arcDeg < 360** — a full ring is a contour-with-hole;
cut an inner cylinder from an outer one instead).
`circleProfile(r, center?)` — a circle of radius `r` centered at `[cx,cy]` (default origin).
Compose it for round solids: `k.prism({ points: circleProfile(r), h })` is a cylinder, and
**use `k.torus({ rMajor, rMinor })` for a torus** — it desugars to a revolve of
an arc-exact circle profile (`k.revolve({ profile: circleProfile(minorR,
[majorR, 0]) })` is the faceted hand-rolled equivalent; the primitive keeps
real TORUS faces in STEP).

**Patterns** (return `Solid[]` — feed to `k.union(...)` for features or `s.cutAll(...)` for holes):
`linearPattern(solid, count, [dx,dy,dz])`, `circularPattern(solid, count, { center, axis, angle, rotateCopies })`.

```js
const hole = k.cylinder({ r: 2, h: 20 }).translate([20, 0, 0]);
body = body.cutAll(circularPattern(hole, 8, { axis: "Z" }));   // 8 bolt holes on a 40mm circle
```

**Helical & threaded features** (screws, threads, bolts, worms, helical ridges):

Use `k.screwSweep({ profile, pitch, turns })`. The profile is an **axial**
`[[r, z]]` contour — the shape you would see slicing the thread down its axis —
exactly `k.revolve`'s convention, with an axial rise added.

The strongly preferred form is **periodic**: span exactly one `pitch`, start and
end at the same radius. That makes the cross-section enclose the axis, so one op
gives you the whole threaded body — no union with a core cylinder, which is both
faster and avoids a boolean the B-rep backend handles badly
([screw-thread-vanishes-on-occt](ERROR-PATTERNS.md#screw-thread-vanishes-on-occt)).

```js
// an ISO-ish M10x1.5 external thread: 60° flanks, crest flat P/8, root flat P/4
const pitch = 1.5, majorR = 5;
const rootR = majorR - (5 / 8) * (Math.sqrt(3) / 2) * pitch;
const crest = pitch / 8, root = pitch / 4;
const rise = (pitch - crest - root) / 2;
const rod = k.screwSweep({
  profile: [
    [rootR,  0],
    [rootR,  root],                    // root flat
    [majorR, root + rise],             // up the flank
    [majorR, root + rise + crest],     // crest flat
    [rootR,  pitch],                   // down the flank, back to the start radius
  ],
  pitch, turns: 6,
});
```

The ends are flat z-planes, which is what a threaded rod wants; intersect a cone
for a lead-in chamfer. For a bolt, build the head as its own solid — that is what
**`src/parts/screw.js`** does, the worked example for this recipe: an ISO-style
metric bolt, periodic thread plus a hex head, presets and all.

Cost scales with `turns` (= `length / pitch`), and steeply: the section is
resampled every 5° of the twist, so an M10×1.5 shank costs ~10.5k triangles per
turn. A 30 mm shank is 20 turns and about half a second on Manifold; hundreds of
turns is millions of triangles and minutes behind the STEP button. Bound the
`length` and `pitch` your schema exposes accordingly.

**Internal threads: use `k.tappedBore`, not a bore plus a `screwSweep`.** The
periodic trick above is what saves an *external* thread from a boolean, and it
has no internal equivalent — a tapped hole is a bore and a thread, and they have
to be combined. Assembled by hand the obvious way, they are a trap:

```js
// ✗  the bore wall and the thread root land on the same cylinder
const bore = k.cylinder({ d: boreD, h: depth });
const thread = k.screwSweep({ profile: [[boreD / 2, 0], …], pitch, turns });
cap.cutAll([bore, thread]);
// ✓  one tool, no shared face
cap.cut(k.tappedBore({ d: boreD, pitch, turns, depth }));
```

Both cut tools touch along an exactly coincident cylinder without overlapping.
Manifold shrugs; OCCT has to resolve a tangential contact between a cylinder and
the thread root's swept spline surface, along a helix, and the intersector
degenerates — on one real 6-turn cap the export did not finish in **fifteen
minutes**, while `tappedBore` builds the same hole in about fifteen seconds
([boolean-coincident-faces-hang](ERROR-PATTERNS.md#boolean-coincident-faces-hang)).

`k.tappedBore({ d, pitch, turns, depth?, crest?, lefthand?, rootSink?, overshoot? })`
returns that hole as **one** solid to cut: `d` is the bore a tap would cut into,
`crest` the radial thread height (default `0.15 · pitch`), `depth` the plain-bore
length (default the thread's own). It owns both halves precisely so it can sink
the thread's root *inside* the bore — which costs nothing, since the bore already
removes that material, and is why the tangency never arises. `screwSweep` cannot
do that for you: a thread cut into solid stock with no bore would then cut a
deeper root and change your part.

The hand-rolled equivalent, for the record: `screwSweep` is
`k.extrude({ profile, h, twist })` with the axial profile remapped to polar
(`ψ = −360·z/pitch`) and `twist = 360 · turns` — one full turn of twist per pitch
of height *is* screw motion. The op exists because that identity is easy to
want and hard to find, and because the remap must be densified (see
`geometry/screw-profile.js`) or the chords between profile points cut deep into
the tooth.

## 2-D booleans

`k.shape2d(profile)` lifts a point list, arc profile, or region into a `Shape2D` — an opaque 2-D boolean value. You can then compose booleans, and feed the result directly to `extrude` or `revolve` without materializing intermediate regions. The same `content-hash caching` discipline applies: identical arguments produce identical geometry.

**Shape2D booleans are a build-time operation** (not `derive()`), and the curve semantics differ between backends: on OCCT the result carries exact circular arcs and Bézier curves into STEP export; on Manifold the curves facet to mesh LOD.

```js
// Keyhole plate: union a disc onto a rect, punch a slot, extrude.
const plate = k.shape2d(roundedRectPolygon(40, 24, 4))
  .union(circleProfile(8))
  .cut(slotPolygon(16, 3))
  .extrude({ h: 3 });   // sugar for k.extrude({ profile: …, h: 3 }); .revolve({ degrees }) too
```

A `Shape2D` also carries `.extrude({ h, twist?, scaleTop? })` and `.revolve({ degrees? })`
sugar (equivalent to the `k.extrude`/`k.revolve` forms), and `.regions()` — scission, which
returns each disjoint region as its own live `Shape2D` (vs `.toRegions()`, which returns raw
`{outer, holes}` data).

```js
// A 0.2 mm printer clearance around a bore, then a 2 mm wall inset:
const bore  = k.shape2d(circleProfile(3)).offset(0.2);            // looser
const wall  = k.shape2d(outer).offset(-2, { corners: "sharp" });  // inset, mitered
```

(This achieves the same geometry as building the profiles separately and using `k.extrude({ profile: { outer, holes }, h })`, but the Shape2D path is more idiomatic for complex 2-D operations.)

`Shape2D.offset(delta, { corners: "round" | "chamfer" | "sharp" })` grows (`delta>0`) or insets (`delta<0`) a shape. It runs backend-independently on the shared contour engine — lines and arcs offset exactly (arcs stay arcs), so results are backend-identical by construction, like every other `Shape2D` op; it throws if the offset collapses the shape. A region with holes offsets material-wise: the outer grows/shrinks by `delta`, holes by `-delta`, so a positive `delta` always adds material. (For `derive()`/main-thread clearance math on plain point lists, use the pure `offsetPolygon` helper instead.)

## Editing profiles

Once a profile exists — a vector file (`k.vector2d`, see "Vector geometry" below),
`pathProfile`, or the result of a boolean — the
**2-D editing ops** let you reshape it with named operations instead of hand-editing
control points: round or bevel a corner, nudge/rotate/mirror it, measure it, simplify
it, or validate it. This is deliberately the same vocabulary an LLM agent calls: pick a
corner, name a radius, get back a profile — never coordinate math. Every op is
available two ways — as a `Shape2D` method (`plate.fillet(2)`) and as a free function
over plain contour data (`filletProfile(outline, 2)`) — both run the same
`contour-ops.js`/paper.js machinery.

**Polymorphic input contract.** Every op below accepts a point list, a `{start,
segments}` contour, a `{outer, holes}` region, or a region array, and returns the
**same shape it was given** — a bare point list stays a point list, upgrading to a
`{start, segments}` contour only if the op introduces curves (e.g. a fillet, or a
non-uniform scale on an arc). The exception is the three arc-length queries
(`profileLength`, `profilePointAt`, `profileTangentAt`): they are single-contour by
nature, so passing a region throws, naming the accessor to use —
`profilePointAt: pass a single contour (use region.outer / region.holes[i])`.

**Transforms** — exact on every segment type (line, arc, cubic); mirror and
non-uniform scale re-normalize winding (outer CCW, holes CW) afterward, so no op can
hand the kernel an inverted region:

| Function | Notes |
|---|---|
| `translateProfile(input, [dx,dy])` | exact on all segment types |
| `rotateProfile(input, deg, center = [0,0])` | arcs stay arcs |
| `scaleProfile(input, s \| [sx,sy], center = [0,0])` | non-uniform scale converts `{to,via}` arcs to cubics (an ellipse is not a circular arc) |
| `mirrorProfile(input, axis)` | `axis: "x" \| "y" \| {point:[x,y], dir:[dx,dy]}` |

**Corners** — fillet inserts a true `{to,via}` arc (a real STEP `CIRCLE` on OCCT);
chamfer sets back `dist` along each adjacent segment and connects with a straight
`{to}`. Both throw, precisely, when a radius/distance doesn't fit — naming the corner,
its coordinates, and the max that would work — rather than silently clamping:

| Function | Notes |
|---|---|
| `filletProfile(input, r, opts?)` | `r`: number, or an array matched positionally with `opts.corners.indices` |
| `chamferProfile(input, dist, opts?)` | symmetric setback, straight connector |
| `profileCorners(input)` | `[{index, position, point, interiorAngleDeg, convex, segTypes}]` — `position` is the entry's place in this list, `index` the joint's vertex number within its contour |

`opts.corners` selects which corners an op touches (default `"all"`):

- `"all"` · `"convex"` · `"concave"`
- `{indices: [...]}` — each corner's **`position`** in `profileCorners(input)`'s return
  list, never its `index`; pair with an array `r`/`dist` for per-corner radii (the
  `roundedProfile` pattern). Any entry out of range throws, naming the range.
- `{near: [x,y], count?: 1, within?: mm}` — nearest-corner selection; the hook for a
  human pick or an agent resolving "the top-left corner" from bbox reasoning. **Without
  `within` the nearest corner is always selected, however far away** — `count: 4`
  applied around a small pocket rounds the four corners nearest it, which may all
  belong to the outer wall. Pass `within` when the pick must be local; a `near` with
  nothing inside `within` throws instead of reaching further.

**`index` and `position` are different numbers.** `index` is the vertex number within
the contour; `position` is the corner's place in the returned list. They agree only
while every joint is a corner — the moment a contour has a smooth joint (a collinear
midpoint, a G1 arc-to-line join, a fillet already applied) the vertex numbers skip
ahead of the positions, and `.map((c) => c.index)` fed to `{indices}` fillets the
wrong corners or throws out of range. Always map to `c.position`.

```js
// Fillet only the two corners nearest the profile's top edge, 3mm and 1.5mm:
const corners = profileCorners(outline);
const top = corners.filter((c) => c.point[1] > 20).map((c) => c.position);   // position, NOT index
const rounded = filletProfile(outline, [3, 1.5], { corners: { indices: top } });

// Fillet every convex corner of a Shape2D by the same amount:
plate = plate.fillet(p.cornerR, { corners: "convex" });
```

**Queries, cleanup and validation:**

| Function | Notes |
|---|---|
| `profileLength(contour)` | mm; single contour only |
| `profilePointAt(contour, {t} \| {length})` | `t` ∈ [0,1] normalized arc length; single contour only |
| `profileTangentAt(contour, {t} \| {length})` | unit vector; single contour only |
| `profileNearestPoint(input, [x,y])` | `{point, distance, contourIndex, segmentIndex, t}` — accepts regions; the pick-resolution primitive |
| `profileBounds(input)` | curve-exact `{min, max}` |
| `profileArea(input)` | outers − holes, curve-exact |
| `profileContains(input, [x,y])` | curve-aware containment (inside an outer, not inside a hole) |
| `simplifyProfile(input, tolerance)` | corner-preserving: splits at corners, refits each smooth run within `tolerance` mm, rejoins — corners survive exactly, arcs entering it return as cubics |
| `validateProfile(input)` | `{ok, issues: [{type, contourIndex, segmentIndex?, point?, message}]}`; never throws — `type` is `self-intersection`, `winding`, `nesting`, or `degenerate` |

Three rules worth internalizing before reaching for any of this:

- **Fillet after booleans if STEP `CIRCLE` fidelity matters.** Booleans run through
  paper.js, which is cubic-only — an arc entering a boolean returns as a cubic
  approximation (relative error ~1e-6). `union`/`cut` first, `fillet` last keeps the
  rounded corners true circular arcs all the way to STEP export.
- **A radius that doesn't fit is CLAMPED, not refused.** `fillet`/`chamfer` reduce any
  corner whose magnitude its edges cannot hold down to the largest that they can, and
  report each clamp on the build's warnings — so a slider that used to kill the part at
  r=3.1 now rounds at whatever fits. Two ceilings apply: the corner's own edges, and
  the edge it shares with a neighbouring selected corner (both back off together there).
  It still throws when there is no feasible magnitude at all. **If an exact radius is
  functionally required** — a bearing seat, a mating fit — do not trust the request:
  clamp it yourself from the geometry that limits it, or assert it in `verify`.
- **Run `validateProfile` after mutations.** `fillet`/`chamfer` check only their own
  corner's local fit — not whether the result self-intersects globally (a large radius
  on a narrow profile can produce arcs that cross the far side). `validateProfile`
  never throws, so it's cheap to call after any edit and inspect `issues` before
  committing to the result.
  Since 0.112 the kernel runs it for you on the way IN to `extrude`/`prism`/`revolve`/`sweep`/`loft`/`shape2d` and reports each crossing as a build warning ([profile-self-intersects](ERROR-PATTERNS.md#profile-self-intersects)); the manual call is for inspecting a result BEFORE committing to it.
- **Guard vanishing features with `isEmpty()`.** A boolean chain can legitimately
  produce an *empty* shape (an `intersect` of shapes a parameter drove apart, a `cut`
  that removed everything). The empty shape is a fine 2-D value — further booleans,
  transforms and `offset` all work — but `extrude`/`revolve` throw on it, identically
  on both backends. If a parameter can drive a feature to nothing, write the guard
  explicitly: `if (!pocket.isEmpty()) body = body.cut(pocket.extrude({ h }))`.
  (Symptom-keyed: `ERROR-PATTERNS.md#extrude-empty-shape2d`.)

A practical trap with the broad selectors: `"all"`/`"convex"`/`"concave"` match **every**
matching corner, including ones you didn't mean to touch. Union a curve-native outline
with a *tessellated* point-list shape (e.g. `circleProfile`, still a faceted polygon —
see "Profiles & patterns") and every one of that polygon's facet vertices becomes its
own small convex corner in the result; a `corners: "convex"` fillet then tries to round
all of them, including the tiny ones whose neighboring facet is too short to hold any
useful radius. `profileCorners(input)` reports each corner's `interiorAngleDeg`, which
cleanly tells a facet artifact (close to 180°, barely bent) from a real corner (well
away from 180°) — filter on that, or pass a coarser `segs` to the tessellated shape
before unioning, rather than fighting the selector after the fact.

**`Shape2D` methods.** Existing: `union`, `cut`, `cutAll`, `intersect`, `offset`,
`area`, `boundingBox`, `toRegions`, `simple`, `regions`, `clone`, `extrude`, `revolve`.
New, all delegating to the pure functions above over the shape's stored contours:
`translate([dx,dy])`, `rotate(deg, center?)`, `scale(s | [sx,sy], center?)`,
`mirror(axis)`, `toContours()` (the stored contour IR, deep-copied — the one readback
that tessellates nothing, unlike `toRegions()`), `fillet(r, opts?)`, `chamfer(dist,
opts?)`, `simplify(tolerance)`, `corners()`, `contains([x,y])`, `isEmpty()` (no
regions left — see the vanishing-features rule above).

## Convex hull

`k.hull([a, b, …])` wraps its inputs (Shape2Ds, curve contours, or point lists) in a
convex `Shape2D`. `k.hullChain([a, b, c, …])` sweeps the hull along an ordered sequence
(≥2 inputs) — the union of `hull([a,b])`, `hull([b,c])`, … — for capsules, rounded slots,
and organic tapers. Faceted (curved inputs facet at mesh LOD): the hull is a pure-JS
monotone-chain computation, never a native backend op.

```js
const capsule = k.hull([circleProfile(4, [0, 0]), circleProfile(4, [20, 0])]);   // a stadium
const slot = k.hullChain([circleProfile(3, [0, 0]), circleProfile(3, [15, 0]), circleProfile(2, [25, 5])]);
```

## Text (`text2d`)

`k.text2d(string, { size, font?, align?, valign?, lineHeight?, tracking?, kerning? })` renders outline-font text as a `Shape2D` — a 2-D boolean you can compose with other shapes (union / cut / offset) and extrude into 3-D geometry.

**Parameters:**

- `string` — the text to render
- `size` — **cap height in mm** (the design-height of capital letters like "H"); the layout engine scales the font to this height
- `font` — optional font name (declared in the part's `fonts` field, below); omit it to use the bundled default (Roboto)
- `align` — horizontal alignment: `"center"` (default), `"left"`, or `"right"`
- `valign` — vertical alignment: `"middle"` (default), `"baseline"`, `"top"`, or `"bottom"`. The defaults (`center`/`middle`) place the text block's centre at the origin, so `.at([x, y])` / `plate.cut(text)` compose without extra translation
- `lineHeight` — distance between baselines in **mm** for multi-line text; omit for a font-metrics default (≈ `(ascender − descender)/em × size`)
- `tracking` — letter spacing in mm (default 0); positive widens, negative tightens
- `kerning` — boolean, enable pair-wise kerning (default true)

**Shape2D composition:**

Like any `Shape2D`, the result composes with booleans and offset — you can union it onto a face, cut it out as a depression, expand it with `offset()`, or combine multiple text shapes:

```js
// Emboss text onto a plate
const baseplate = k.extrude({ profile: roundedRectPolygon(100, 60, 4), h: 5 });
const emboss = k.text2d("v2.0", { size: 8 }).offset(0.2);  // 0.2 mm relief
const part = baseplate.cut(k.extrude({ profile: emboss, h: 1 }));

// Deboss text into a lid
const lid = k.extrude({ profile: circleProfile(40), h: 3 });
const deboss = k.text2d("PART-042", { size: 6 });
const carved = lid.cut(k.extrude({ profile: deboss, h: 0.5 }));

// Extrude text as a solid letters
const raised = k.extrude({ profile: k.text2d("LOGO", { size: 10, align: "center" }), h: 2 });

// Multi-line label with tight tracking
const label = k.text2d("YEAR 2025\nSERIES A", { size: 4, align: "center", tracking: -0.1 });
```

**Font sourcing (the `fonts` PartDefinition field):**

Declare fonts in your part definition's optional `fonts` object — a map of font names to sources. The framework resolves and parses these before `build()` runs, so `k.text2d(str, { font: name })` can look them up synchronously:

```js
fonts: {
  heading: () => import("./fonts/Raleway-Bold.ttf"),    // bundle via Vite dynamic import
  label: "https://cdn.example.com/fonts/Courier-Prime.ttf",  // URL fetch
  default: new Uint8Array([...])                             // inline bytes (rare)
},
```

- **Dynamic import:** `() => import("./path/to/font.ttf")` — Vite bundles the font; resolves to `{ default: url }` at runtime
- **URL:** a string — the framework fetches it (CORS must allow it)
- **Inline bytes:** an `ArrayBuffer` or `Uint8Array` — useful for generated or embedded fonts

Reference a font by name: `k.text2d("text", { font: "heading" })`. Omit the `font` option to use the bundled **Roboto** (Regular, SIL OFL 1.1) default.

**Making the typeface a parameter.** Give `fonts` a function of params instead of a
static object, and a `type: "font"` control can drive which face `text2d` uses —
`src/parts/nameplate.js` is the reference:

```js
{ key: "face", type: "font", label: "Typeface" },   // in `parameters`
fonts: (p) => (p.face ? { face: p.face } : {}),     // a function, not a static map
k.text2d(p.label, { font: "face" }),                // only when p.face is set
```

An empty `face` declares nothing — `fonts` returns `{}`, and `text2d` falls back to
the bundled Roboto — so the part still builds with no network access. A part with a
fixed typeface needs none of this: a plain `{ name: source }` object is fine.

The control's `allow` list bounds what a picked — or share-link-supplied — value may
be, and defaults to `["https"]`; see the control-types table above. It does **not**
constrain sources you declare yourself.

**Build-time & curve semantics:**

`text2d` is a **build-time operation** (not `derive()`), and **the curve representation differs by backend:**

- **OCCT (B-rep):** text outlines carry **exact cubic Bézier curves** into STEP export (not tessellated)
- **Manifold (mesh):** text outlines **facet at the mesh level-of-detail** (same as other curves in preview)

Both backends produce watertight emboss/deboss geometry; the difference is export fidelity. As with any `Shape2D`, composition with booleans and offset is backend-agnostic — the same code works on both.

**Overlapping / self-intersecting glyph outlines:** real font outlines aren't always simple, correctly-nested contours — counters can overlap or self-intersect. Before glyphs become curve regions, the framework resolves each glyph's raw contours with the nonzero winding rule (how all OpenType outlines — TrueType and CFF alike — are filled), so composite/overlapping outlines still produce a single correct `{outer, holes}` shape per glyph. This resolution stays curve-exact — it never flattens beziers to polygons — so the OCCT/Manifold split above still holds.

---

## Vector geometry

`k.vector2d(name, { shape?, width?, height?, fit?, align?, valign? })` places a declared
vector document as a `Shape2D` — the same kind of value `k.text2d`, `k.shape2d`, and every
2-D boolean/editing op above return, so it composes exactly the same way: union it onto a
face, cut it as a depression, `.offset()` it, extrude or revolve it, run it through the
"Editing profiles" ops above (fillet a corner, `.simplify()` it, query its bounds).

A vector document is JSON in the `partforge-vector` format, and it arrives one of two ways:

- **Authored** — written by hand (or by an agent) in millimetres, and placed exactly as
  drawn. This is the path for geometry that is *drawn* rather than computed: a faceplate
  outline, a bolt pattern, a decorative cutout. `src/parts/assets/plate.vector.json` is
  the worked example.
- **Ingested** — converted once from an `.svg`, in a browser, by `partforge/ingest`, and
  checked in beside the part. The artwork keeps its own unitless coordinates and is sized
  at every call site. `src/parts/assets/emblem.vector.json` is the worked example.

Both load through the same validator and behave identically downstream.
**`docs/VECTOR-FORMAT.md` is the normative spec of the format** — read it before
hand-authoring a document, hand-converting one, or debugging a validation error.

```js
vectors: {
  emblem: new URL("./assets/emblem.vector.json", import.meta.url),   // ingested (units "artwork")
  plate:  new URL("./assets/plate.vector.json",  import.meta.url),   // authored (units "mm")
},
build: (k, p) => k
  .vector2d("plate")                                          // composed by the file's own roles
  .extrude({ h: p.plate_t })
  .union(k.vector2d("emblem", { width: p.emblem_w })          // artwork units: a size is REQUIRED
    .extrude({ h: p.emboss }).translate([0, 0, p.plate_t])),
```

**Units decide placement, and the file declares them.** Every document carries a required
`units` field — there is no default, because guessing between the two would silently
produce wrong-scaled geometry:

| | `units: "mm"` | `units: "artwork"` |
|---|---|---|
| Coordinates mean | millimetres | nothing physical |
| Scale | `1`, unless a size option is given | exactly one of `width`/`height`/`fit`, **required** |
| Placement | as authored — no translate | the geometry's bbox centre moves to the origin |
| `align`/`valign` | no default; applied when passed | default `"center"` / `"middle"` |

One formula covers both: scale uniformly about the document origin, then translate per
`align`/`valign`. `fit` sizes the artwork's longer bounding-box edge; scaling is always
uniform (never stretched to fit both). Passing **more than one** of `width`/`height`/`fit`
throws, naming the ones it got. Omitting all three on an `"artwork"` document throws — see
[ERROR-PATTERNS.md#vector-size-required](ERROR-PATTERNS.md#vector-size-required); unlike
`text2d`'s `size`, which defaults to a cap height of 10 mm, there is no default here,
because a font's cap height is a well-defined physical metric and an SVG's own coordinate
units are not.

**Size a millimetre drawing as a whole, never shape by shape.** A size option scales the
geometry being placed against *that geometry's own* bounds. On the composed call
(`k.vector2d(name)` with no `shape`) that is the whole document, measured and placed on
one transform, so it is safe. On two `{ shape }` calls it is two different scale factors,
which silently destroys the shared coordinate frame that made the file worth authoring in
millimetres — the holes scale against the holes' bounding box, not the body's. Nothing
throws, and the composed bbox still comes out the size you asked for; only a hole or
feature count reveals it. Prefer no size option at all on an `"mm"` file; if a drawn part
needs rescaling, compose it first and scale the finished `Shape2D` (or the extruded solid)
once in `build`. See
[ERROR-PATTERNS.md#vector-mm-shapes-misscaled](ERROR-PATTERNS.md#vector-mm-shapes-misscaled).

**Named shapes and roles.** A document's geometry lives under named shapes, and each shape
declares a `role` of `"add"` (the default) or `"subtract"`:

| Call | Returns |
|---|---|
| `k.vector2d("plate")` | The file's own composition: every `"add"` shape unioned, minus every `"subtract"` shape. |
| `k.vector2d("plate", { shape: "body" })` | That shape's own geometry, whatever its role. |

Naming a shape is a request for *that* geometry; `role` governs only the default
composition. An unknown shape name throws, listing the ones the file does declare
(`npx partforge lint` catches it statically — see the rule catalog below). The composed
call places the whole document on **one** transform, derived from every region in it, so a
size or `align` option cannot scale the subtracts relative to the adds; a `{ shape }` call
is measured against that shape alone. Anything more than add/subtract is ordinary
`Shape2D` algebra in `build`:

```js
k.vector2d("plate", { shape: "body" }).cut(k.vector2d("plate", { shape: "holes" }))
```

Ingested documents have a single shape (named `artwork`, role `"add"`), so ingested
artwork never needs to mention a shape name.

**Declaring the source.** Sources use the same `new URL("./…", import.meta.url)` form
`imports` and `fonts` do, for the same reason: Vite turns it into a bundled asset URL in
the app, and in Node it resolves to a `file:` URL that `src/testing/assets.js` reads
straight off disk — so the same declaration works unchanged in the browser, the CLI, and
tests. A bare `() => import("./art/logo.vector.json")` dynamic import works under Vite but
**fails in the CLI**, the same gotcha `fonts`/`imports` have: nothing bundles the dynamic
import outside a Vite build, so `partforge lint`/`measure`/`render` can't resolve it. The
source must resolve to the `.vector.json`, never to a raw `.svg` — `k.vector2d` does no
SVG parsing at all.

**A source may also be the parsed file itself.** Alongside bytes, a URL and a thunk, a
`vectors` entry accepts the **contents** of a `.vector.json` — the object a JSON import
yields, or anything else that already holds it:

```js
import plate from "./assets/plate.vector.json" with { type: "json" };
export default { vectors: { plate }, /* … */ };
```

The `with { type: "json" }` attribute is required — Node refuses a JSON import without it.
Reach for this form when the artwork is **hand-authored and meant to stay editable**: the
numbers sit in a file a reader can open and change, next to the part that uses them, with
nothing to fetch in order to see them. Reach for `new URL(…)` instead when the file is
**ingested output** — generated, large, and not read by hand. `src/parts/emblem.js`
declares one of each, side by side, for exactly this contrast.

Two consequences worth knowing. `partforge/lint`'s document-aware rules can read a parsed
source on the very first lint, before any build has run, because there is nothing to
resolve — with a URL they stay silent until the bytes arrive. And the object is validated
on every resolve, so a malformed one fails with the same message its fetched twin would;
it is read and never written, so `build` stays pure.

**`vectors` may also be a function of params — and must be, for a `type: "vector"`
control.** Exactly like `fonts` and `images`, the field takes either a static
`{ name: source }` object (everything above) or a function called with the resolved
params, so a picked or dropped source can reach the build:

```js
parameters: [{ id: "art", title: "Artwork", controls: [{ key: "art", type: "vector" }] }],
defaults: { art: "" },                        // empty = no artwork yet; the build must cope
vectors: (p) => (p.art ? { badge: p.art } : {}),
build: (k, p) => {
  const plate = k.box({ w: 60, d: 40, h: p.plate_t });
  if (!p.art) return plate;                   // nothing dropped yet
  return plate.union(k.vector2d("badge", { width: 30 })
    .extrude({ h: 1 }).translate([0, 0, p.plate_t]));
},
```

A static object provably cannot read a param, so a `type: "vector"` control beside
one is inert — the picker changes a param and the artwork never moves.
`vector-control-not-in-vectors` (lint) catches both halves of that mistake: a static
`vectors` beside a vector control, and a function-form `vectors` that never returns
the picked value. An empty `p.art` declares **no** artwork for that name (the same
"unset, not refused" rule `fonts`/`images` use) — the job skips it with a progress
note rather than fetching `""`, so a build that guards on it, as above, still runs
with nothing dropped.

**Sizing is against the tight geometric bounding box, not a `viewBox`.** Icon sets pad
their `viewBox` inconsistently, so sizing relative to `viewBox` makes two icons declared at
the same nominal size look different on the plate. `width`/`height`/`fit` instead measure
the actual painted geometry, recomputed at build time — a stored `bbox` in the file (which
is optional, and which authored documents omit) is a checksum, never the authority.

**Strokes are outlined into real filled geometry, at ingest — not at build time, and not
skipped.** A stroked SVG element (`stroke` + `stroke-width`) is not a "line" anywhere in
the format; ingest turns it into an ordinary filled `{outer, holes}` region the width of
the stroke, caps and joins included, before it ever reaches `k.vector2d`.
`src/parts/emblem.js` is the reference part for this — its `emblem.svg` carries one filled
circle and one stroked open polyline, so both of ingest's geometry paths are exercised in
one checked-in fixture.

**`<use>`, `<defs>`, `<symbol>`, and CSS `class=`/`<style>` all work**, because ingest runs
inside a real browser DOM that resolves them the same way rendering the SVG directly would
— this is the actual reason ingest requires a browser rather than running headlessly inside
`k.vector2d` or the CLI.

**Painting order is not modelled.** Every region in an `"add"` shape adds material,
unconditionally — there is no notion of one shape being painted over, and therefore
visually hiding, another. An SVG that fakes a hole by painting a background-colored shape
on top of another shape (rather than using an actual fill-rule hole, or two properly-wound
subpaths) comes out **solid** through `k.vector2d`, not holed. See `docs/VECTOR-FORMAT.md`
§ "Painting order is not modelled" for the three fixes (a real hole in the source artwork,
a `"role": "subtract"` shape in the JSON, or `.cut()` it in `build`), and
[ERROR-PATTERNS.md#svg-painting-order](ERROR-PATTERNS.md#svg-painting-order).

**What this is not.** `k.shape2d` does **not** accept the JSON dialect — it takes the
internal contour form the polygon helpers and `pathProfile` produce — and there is no
inline document form in `build`. A parsed source (above) does not change that: it is a
`vectors` **declaration**, resolved and validated before `build` runs, not a document
`build` may assemble or hand to the kernel. The two vocabularies stay separated by the file boundary,
which is what lets `docs/VECTOR-FORMAT.md` be the only place they meet. Inline authoring
stays `pathProfile` (see § "Geometry: the kernel / `Solid` API" above, where `pathProfile` is
introduced, for which to reach for).

Full contract — the JSON format itself, hand-authoring it, hand-converting an SVG without
a browser, arc recovery, and every validation error's exact wording — lives in
`docs/VECTOR-FORMAT.md`; `src/parts/emblem.js` is the worked reference part, built through
the CLI and both backends.

---

## Importing geometry (STEP/STL/3MF)

`k.import(name)` returns a previously-registered imported file as an ordinary `Solid` — the same handle a `k.box()` or `k.loft()` call would give you. It exists for two uses: a **reference** the agent workflow measures and rebuilds a parametric part around (with a verify-time deviation gate holding the rebuild to it), or a **component** — a real body that participates in booleans, scaling, and export like any other solid. `src/parts/import-demo.js` is the worked example for both; read it alongside this section.

**Declaring imports (the `imports` PartDefinition field):**

Exactly the `fonts` grammar, one level up in the contract — a map of names to sources:

```js
imports: {
  scan: new URL("./assets/import-demo-scan.stl", import.meta.url), // Vite serves it; Node reads disk
  lid:  "https://…/signed-url.step",                               // URL string
  chip: bytesOrThunk,                                               // ArrayBuffer/Uint8Array, or a (possibly async) thunk returning one
},
```

The framework resolves these — fetch/read bytes, detect the format (filename extension when the source has one; a magic-bytes sniff otherwise — the `ISO-10303-21` STEP header, a `PK` zip signature for 3MF, else STL), and content-hash them — before the synchronous `build` runs, registering the parsed result on the kernel through an underscore-prefixed side-channel (see `docs/KERNEL-CONTRACT.md` § "Conformance classes"). Reference an import by name: `k.import("scan")`. An undeclared name throws (mirrors `text2d`'s unknown-font error) — see [ERROR-PATTERNS.md#import-unknown-name](ERROR-PATTERNS.md#import-unknown-name).

**Backend matrix:**

- **STEP on OCCT** — native: `replicad.importSTEP` builds a real B-rep, exact into STEP export.
- **STEP on Manifold** — tessellated transparently: the framework routes an OCCT-worker tessellation pass behind the scenes (the "crossover" — see caching, below) and hands Manifold the resulting triangle mesh. Exactness is lost on this path; the STEP curves become facets at print quality, same as any other mesh geometry.
- **STL/3MF on Manifold** — native: parsed, repaired (vertex merge + winding/orientation fix), and handed to `Manifold.ofMesh`. A mesh still non-manifold after repair throws loudly with the open-edge count — see [ERROR-PATTERNS.md#import-mesh-not-solid](ERROR-PATTERNS.md#import-mesh-not-solid).
- **STL/3MF on OCCT** — never attempted: mesh-to-B-rep conversion isn't in scope for v1. Declaring a mesh import on a part (or sub-part, under per-sub-part routing) that routes to OCCT is an error — see [ERROR-PATTERNS.md#import-mesh-on-occt](ERROR-PATTERNS.md#import-mesh-on-occt).

`import` is not in `OCCT_ONLY_OPS` — a STEP import does not by itself force OCCT routing (the crossover exists precisely so it doesn't have to); backend selection is still driven by `fillet`/`chamfer`/`shell` on a `Solid`, or `meta.backend`.

**Units:** everything normalizes to millimetres at parse time — STEP units are honored by the OCCT importer, a 3MF file's `unit` attribute is converted, and **STL is assumed to already be in millimetres** (the format carries no unit metadata).

**Registration is total; errors are lazy.** Every declared import registers on whichever kernel runs a job, regardless of whether that kernel can actually use it — this is what keeps a mixed-format part (an OCCT sub-part and a Manifold sub-part with different import formats) from having one format's registration break the other's job. A format the running kernel can't use registers as an **error entry** instead of throwing at registration; the error throws from `k.import(name)` itself, at the point in a `build` that actually calls it. Two cases surface this way:

- **mesh import on OCCT** — throws immediately, every time (see the backend matrix above).
- **unprimed STEP import on Manifold** — throws once, then self-heals: the framework's crossover machinery notices, arranges the OCCT-side tessellation (a `tessellate-imports` worker job in the browser, a `node:worker_threads` hop in the CLI/tests, since the two WASM kernels may never share a process), and retries the build. A build whose params never actually reach a `k.import()` call on that STEP file never triggers the crossover at all — the cost is paid only when the import is really used. If the crossover itself fails to produce a usable mesh, that surfaces as [ERROR-PATTERNS.md#import-step-tessellation-failed](ERROR-PATTERNS.md#import-step-tessellation-failed).

**Caching & content-stability:** import sources are **content-stable for a session** — the same rule as `fonts`. Bytes are memoized process-wide by source identity (not by digest) the first time a source resolves, and stay resident for the life of that worker/process: the raw bytes in the resolver's cache, and the parsed master (a Manifold mesh or an OCCT B-rep shape) in the kernel that parsed it. A multi-megabyte STEP or STL file is read and parsed once, not on every slider drag or view switch — but it also means a changed file on disk needs a fresh worker/process to be picked up (a rebind/remount, same as changing a font). Downstream, every op built from an import folds the file's content digest into its cache key (`h("import", name, digest)`), so an actually-changed file (a new digest) still invalidates every dependent cache node correctly. On the STEP-on-Manifold crossover, note that the file is fetched **independently by both workers** — the Manifold worker resolves it to get a digest, and the OCCT worker resolves it again to tessellate — so a large STEP file used this way is held in memory twice, once per worker.

**Performance:** a `reference` deviation check (below) costs one solid boolean per verify run. On a Manifold-routed part that's cheap; on an **OCCT-routed** part it's a full OpenCASCADE boolean against the entire imported B-rep, and `docs/geometry-backend-strategy.md` measures OCCT booleans at 75–1486× slower than the equivalent Manifold operation. A `reference`-bound sub-part on OCCT is a deliberate trade — exactness for STEP export vs. a slower `measure`/`verify` loop — worth knowing about before wiring one up on a large imported assembly.

**The `reference` field and the deviation gate:**

A sub-part can bind itself to an import by name; `measure()` then computes a `deviation` fact against it (symmetric-difference volume, volume delta %, and per-axis bbox-corner drift), which three `ref*` metrics in `verify.expect` can gate on — the same `SUBPART_METRICS` registry `holes`/`volume`/`bbox` live in, so they take the same assertion DSL:

```js
parts: {
  body: {
    reference: "scan",   // an import name — measure() computes s.deviation against it
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.scanW, p.scanD, p.scanH] }),
  },
},
verify: {
  expect: {
    body: {
      refXorVolume: "<=5mm3",          // symmetric-difference volume — the real match check
      refVolumeDeltaPct: "<=1",        // cheap sanity gate, % of the reference's volume
      refBboxDelta: "<=[0.2,0.2,0.2]", // mm, per-axis max of |min|/|max| corner deltas
    },
  },
},
```

Deviation is measured in build coordinates on the posed display solid — aligning the rebuild to the reference is the part author's job, and the ghost overlay (next) is how you check it by eye. A sub-part with no `reference` gets `deviation: null` and skips any `ref*` assertion rather than failing it; `npx partforge lint` catches the inverse mistake — a `ref*` assertion on a sub-part that declares no `reference` — statically, as `ref-metric-without-reference` (see "Linting" → Rule catalog → "Geometry imports", below).

**The two-view ghost pattern:** `measure()`'s `ok` gate is **view-scoped and overlap-strict** — it requires zero sub-part overlaps among whatever the *current* view shows. A translucent ghost of the raw import, shown in the same view as its parametric rebuild, is by construction coincident with that rebuild — so that view's `overlaps` would always read greater than zero, failing `verify` on a part that is otherwise exactly correct. The fix is not a bigger overlap tolerance; it's two views:

```js
parts: {
  // Ghost overlay: only in "reference" — never coincides with body in "assembly".
  ref: {
    label: "Reference (ghost)",
    views: ["reference"],
    exportable: false,
    display: { opacity: 0.3 },
    build: (k) => k.import("scan"),
  },
  // The parametric rebuild — shown alone in "assembly", and against the ghost
  // in "reference" for visual alignment checking.
  body: {
    label: "Rebuild",
    views: ["assembly", "reference"],
    reference: "scan",
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.scanW, p.scanD, p.scanH] }),
  },
},
views: { assembly: { label: "Assembly" }, reference: { label: "Reference overlay" } },
verify: {
  expect: {
    body: { refXorVolume: "<=5mm3", /* … */ },
    _view: { overlaps: 0 },   // checked against the DEFAULT ("assembly") view only
  },
},
```

`assembly` is listed first so `measure`/`verify`/`render` — which all default to the **first** view key, `default: true` notwithstanding — see only the real, non-overlapping parts. `reference` is the ghost-overlay view: browse it by hand in the viewer, or pass it explicitly to `measure`/`render`, to eyeball how closely the rebuild tracks the scan. Declare `ref` `exportable: false` (it's not a real part of the design) and give it a `display.opacity` well under 1 so it reads as an overlay rather than an opaque duplicate. This is exactly `src/parts/import-demo.js`'s shape — read its `parts.ref`/`parts.body`/`views`/`verify` blocks for the fully worked, commented version.

**Using an import as a real component** — the other use, no ghost involved — is an ordinary boolean, chainable like any `Solid`: `import-demo.js`'s `mount` sub-part cuts a through-socket shaped to the scan itself (scaled up slightly for clearance) out of a plate:

```js
build: (k, p, d) => {
  const plate = k.box({
    min: [d.mountOffsetX - p.margin, -p.margin, -p.plateH],
    max: [d.mountOffsetX + p.scanW * p.fit + p.margin, p.scanD * p.fit + p.margin, 0],
  });
  const socket = k.import("scan")
    .scale(p.fit)
    .translate([d.mountOffsetX, 0, -p.plateH - 1]); // overcut past both plate faces
  return plate.cut(socket);
},
```

**Linting:** `npx partforge lint` learns `import` as a known op and adds four static checks — `import-unknown-name`, `import-mesh-on-occt`, `reference-unknown`, `ref-metric-without-reference` — described in full under "Linting" → Rule catalog → "Geometry imports", below; this section only points there rather than repeating it.

**CLI:** `partforge measure|render|lint` work on an importing part exactly as on any other — the `imports` field resolves in the CLI's Node boot the same way `fonts` does, no extra flags.

## Height maps and images

`k.heightfield(nameOrGrid, opts)` turns a grayscale depth map into a relief
solid: a sampled grid on top, skirt walls down the sides, a flat cap at
`z = 0`. It exists for one thing — a printable relief plate from a picture —
and `src/parts/relief.js` is the worked example; read it alongside this
section.

**Declaring images (the `images` PartDefinition field):**

Same grammar as `fonts` and `imports`, one more asset sibling:

```js
images: {
  relief: new URL("./assets/relief-demo.png", import.meta.url), // Vite serves it; Node reads disk
  logo:   "https://…/signed-url.png",                            // URL string
  scan:   bytesOrThunk,                                           // ArrayBuffer/Uint8Array, or a (possibly async) thunk returning one
},
```

`images` may also be a **function of the resolved params** — `images: (p) => ({...})`
— which is what lets a `type: "image"` control pick the source. `relief.js` uses
exactly this to fall back to a bundled sample when the control is empty:

```js
images: (p) => ({
  relief: p.relief || new URL("./assets/relief-demo.png", import.meta.url),
}),
```

**The empty-value fallback:** `p.relief` starts as `""` (its `defaults` entry),
which reads as "no image chosen" — never a source to fetch, never a source
`npx partforge lint`/the runtime warn about. A part is responsible for
supplying its own fallback when a key resolves empty, exactly as above; an
`images` entry that stays empty is simply dropped from registration (with a
progress note, not an error), so a `build()` that still calls
`k.heightfield(name, …)` for that name gets the same
[`heightfield-unknown-image`](ERROR-PATTERNS.md#heightfield-unknown-image)
throw as a typo'd name — the framework has no automatic "flat slab" behavior of
its own; a part that wants one branches around the `k.heightfield` call itself
when its source param is empty, the same way it would branch around any other
optional feature.

**The `type: "image"` control:** the control-types table above lists `"image"`
— an image picker with a host-supplied catalog, or a plain URL text field
without one. `allow` restricts what a **param-supplied** value (from the
picker, or a pasted/shared URL) may be — the same shape as `font`'s `allow`,
but with one fewer kind, since there's no image equivalent of Google Fonts'
CDN allowance:

| value | accepts |
|---|---|
| `"https"` | any `https:` URL. **The default** — omitting `allow` means `["https"]` |
| `"asset"` | a `pfc-asset://` token — an image the host has stored for this part |

A refused param falls back to `defaults[key]`, with a build warning naming the
key — `image-source-scheme` (lint) catches a `defaults` value the control's own
`allow` would itself refuse. As with `fonts`, `allow` only gates values that
arrive as **params**; a source you write into `images` yourself is code, not
user input, and is never checked against it.

**`k.heightfield`'s options:**

```js
k.heightfield("relief", {
  w: 60, d: 60,        // footprint, mm — REQUIRED, both > 0 (no default)
  base: 1.5,            // solid slab thickness under the relief, mm (default 1; must be > 0 — zero is degenerate)
  maxZ: 3,               // how far the tallest sample rises above base, mm (default 1)
  pitch: 0.5,             // grid spacing, mm (default 0.5) — see "pitch" below
  invert: false,           // swap high/low (default false)
  range: [0, 1],            // remap the raw sample range before invert (default [0, 1] — identity)
  origin: "center",         // "center" | "corner" — footprint placement in XY (default "center")
});
```

`nameOrGrid` is either a name declared in `images`, or an inline
`{ width, height, data: Uint16Array }` grid (bypassing `images`/PNG entirely —
useful for procedural depth maps, as CI fixtures use).

- **`range` is a remap with clamped ends, not an output clamp.** `range[0]` maps
  to sample value 0, `range[1]` maps to sample value 1, and everything outside
  `[range[0], range[1]]` clamps to the nearer end — it does not pass the raw
  0..1 sample through unclamped and then chop the *output* height. `range: [0, 1]`
  (the default) is the identity map: a raw sample stays exactly what it was.
  This is exactly the tool for a source whose luminance never reaches the
  extremes — `relief.js`'s bundled demo asset only spans roughly 39–75% of the
  16-bit range (the ripple pattern that generated it decays toward mid-gray),
  so left at the default `range` the demo would use well under half of `maxZ`;
  it sets `range` to the asset's own measured extent to stretch that into the
  full 0..1 span. **`invert` applies after the remap**, as `1 − t` on the
  remapped value — it flips which end is raised, not which end of the source
  range is used.
- **`origin` positions the footprint in XY only.** `"corner"` puts the minimum
  corner at `(0, 0)`; `"center"` (the default) centers the footprint on the
  origin. Either way the **base always sits at `z = 0`** — `origin` never moves
  the part vertically, only in X/Y.
- **The image stretches to `w × d`.** Sampling maps the image's own aspect
  ratio onto whatever rectangle `w`/`d` describe — a square source on a
  non-square footprint stretches, it is not letterboxed or cropped.
- **Axis convention:** a source PNG's row 0 (its first scanline — the visual
  top of the file in an image viewer) maps to the footprint's **−Y** edge, with
  Y increasing down the rows — the standard texture-coordinate convention, and
  not something this framework special-cases. In practice: a depth map viewed
  in the app from above (+Z) reads vertically flipped relative to the same file
  open in an image viewer. If a source contains text or a logo and that
  orientation matters, flip the source pixels before declaring it — `invert`
  will not do this for you, since it remaps sampled *height*, not pixel
  position.
- **Vertex budget:** the sampled grid is `max(2, ceil(w/pitch))` ×
  `max(2, ceil(d/pitch))` vertices. If that product would exceed 400,000,
  `pitch` is scaled up uniformly until it fits (and, if still over, the two
  counts are shrunk in lockstep) — a build warning names the clamped pitch
  rather than the build hanging or throwing.

**PNG only, in core.** `images` resolves exactly one format — a source that
doesn't start with the PNG signature throws
[`images-only-png-supported`](ERROR-PATTERNS.md#images-only-png-supported) —
and the decoder itself rejects Adam7-interlaced files
([`png-interlaced-unsupported`](ERROR-PATTERNS.md#png-interlaced-unsupported)).
This is deliberate, not an oversight: the same pure-JS decoder
(`src/framework/geometry/png-decode.js`) runs in the browser worker, the CLI,
and CI alike, so the geometry a user previews, the geometry `partforge measure`
gates, and the geometry a regression test pins can never disagree about how a
given file decodes — a second format would mean a second decode path, and a
second place for the three to drift apart. The escape hatch is
`imageToPng(fileOrBlob, { maxSize = 1024 }) → Promise<Blob>`, exported from
`"partforge/ingest"` (main-thread only — it draws through a `<canvas>`, never import
it from a part or a worker): convert any format the browser can decode into a
PNG before it reaches `images`, in a host's upload handler. It downsamples to
`maxSize` on the long edge on the way, since `pitch` caps useful resolution
anyway and downsampling avoids shipping detail no `heightfield` call will ever
sample.

**`pitch` is the throttle for both triangle count and STEP size.** Every
`w/pitch × d/pitch` grid cell becomes two triangles, plus a skirt and a cap —
halving `pitch` roughly quadruples the triangle count. On a 60×60 mm plate,
pitch 1.0 produces about 7,670 triangles and (on the OCCT backend) a STEP file
around 17.6 MB; pitch 0.3 produces about 81,590 triangles and a STEP file
around 206.5 MB, for the same footprint. STEP size is content-dependent — only
genuinely coplanar faces merge during sewing, so a flat relief compresses far
better than a high-frequency one at the same triangle count — but the linear
relationship to triangle count holds regardless of content. Above 24,000
triangles the OCCT backend's sewing step also slows down and warns on the same
build; past a further, content-dependent point sewing can fail outright
([`heightfield-sew-failed`](ERROR-PATTERNS.md#heightfield-sew-failed)), fixed
by raising `pitch` or keeping the sub-part on the Manifold backend, which never
sews through OCCT. Manifold's own preview has no such ceiling, so a fine
`pitch` is always safe there — it only becomes expensive at STEP-export /
OCCT time.

**Bytes in params — the sandbox path.** A `type: "image"` control's value may
also be raw PNG bytes (an `ArrayBuffer`/typed array) rather than a URL string —
either dropped onto the control (see "Getting files into a part", below) or
placed there directly by a host that cannot fetch URLs (the partforge-cloud
sandbox is the motivating case). Byte values **bypass the `allow` check
entirely**, for every `allow` list, including the default — not a hole, but
the deliberate consequence of what a byte value in `params` can mean: a URL
cannot carry megabytes, so an `ArrayBuffer` arriving there cannot have come
from a pasted link or a shared URL. That plausibility argument isn't the
load-bearing one, though — the structural fact is that `asset-resolve.js`'s
resolver (shared by `images`/`fonts`/`vectors`) calls `fetch` only for a
`string`/`URL` source, so bytes are consumed directly and can never become a
request no matter how they arrived in `params`. `allow` exists to keep a
shared link from turning into an arbitrary fetch — a concern that structurally
cannot apply to a byte-valued param.

**Linting:** `npx partforge lint` adds an "Image controls" group of static
checks — `image-control-not-in-images`, `heightfield-unknown-image`,
`image-source-scheme` — described in full under "Linting" → Rule catalog →
"Image controls", below; this section only points there rather than repeating
it.

**CLI:** `partforge measure|render|lint` resolve `images` in the CLI's Node
boot exactly the way `fonts`/`imports` do — no extra flags — with the same
function-form caveat: a `verify` case or animation frame that changes the
image-control param still builds against the base-params source, because the
CLI boots its kernel once.

## Getting files into a part

`"image"`, `"vector"` and `"font"` controls each carry a drop target, on top of
the URL/catalog paths documented for them above — a file dropped, pasted, or
picked (a native file-input dialog behind a click, for a mouse/keyboard user
with no drag-and-drop) lands in the same param a URL or a picker selection
would. There is no drop target for `imports` (STEP/STL/3MF) — those are
reference geometry, checked in or fetched, not something a panel field takes a
file for. `src/framework/panel/widgets/file-drop.js` is the shared
implementation behind all three; this section documents its contract, not its
code.

**What each control's drop target accepts.** A dropped file is classified by
its actual bytes — never its extension or the browser's claimed MIME type —
against a fixed sniff table (`src/framework/ingest/sniff.js`), because a
file's claimed type is exactly the input a mislabelled or hostile upload would
travel as:

| Control | Accepts | Lands as |
|---|---|---|
| `"image"` | PNG, JPEG, WebP | a PNG (JPEG/WebP re-encoded through a `<canvas>`; PNG passes through unchanged) |
| `"vector"` | SVG | a parsed `partforge-vector` document (paper.js — the same conversion `partforge/ingest`'s `ingestSvg` performs) |
| `"font"` | TTF, OTF | the file itself — nothing to convert |

A file that doesn't match its own control's list is refused with a message
naming what it actually is; when another control's slot *would* take it (an
SVG dropped on the Image control), the message names that control instead of
just saying no. A file over 25 MB is refused before being read into memory to
classify at all.

**Where the result goes — `onAssetUpload`, or straight into the param.** After
conversion, the drop widget looks for `onAssetUpload` (a `mount()` option —
see "Wiring a part into a runnable app", above, for its full signature):

- **With the hook**, it hands over the converted artifact — a PNG blob, the
  partforge-vector document serialized as a JSON blob, or the original font
  file — and writes whatever source string the hook resolves to into the
  param, exactly as if that string had been typed into the URL field or
  chosen from a catalog.
- **Without it**, the artifact itself becomes the param value directly: raw
  bytes (an `ArrayBuffer`) for `"image"`/`"font"`, and the **parsed
  `partforge-vector` document object** — not its serialized bytes — for
  `"vector"`, because `vectors.js`'s resolver already accepts an in-tree
  parsed object directly (`asParsedFile`, see "Vector geometry", above);
  serializing it only for the resolver to re-parse would be pure waste. This
  is the path a host that cannot fetch URLs needs — the partforge-cloud
  sandbox is the motivating case — and it is a first-class destination, not a
  degraded fallback for a host that hasn't wired anything up: nothing about
  presets, undo, the params hash, or `when` cares which shape a control's
  value takes.

**The `allow` list, and what bypasses it.** All three controls take the same
`allow` list already documented for `"font"` in the control-types table above
(`"https"` — the default; `"gstatic"`, font-only, `https://fonts.gstatic.com`
exactly; `"asset"`, a `pfc-asset://` token the host has stored for this part;
`"tree"`, vector-only, a `pfc-tree://` token naming artwork that lives as a
**file inside the part itself** rather than in host storage), gating what a
**param-supplied** value may be.

`"tree"` is vector-only by construction, not by omission: a part's files are
text, so a `partforge-vector` JSON document can live in one and a PNG or a
font cannot. Its payoff is that the artwork is versioned *with* the part —
a host that stores parts as a file tree keeps the document in the same
snapshot as the code that reads it, so publishing, history and undo carry the
two together instead of leaving a param pointing at storage that moved on. It never restricts a source an
author writes into `images`/`fonts`/`vectors` themselves — that's code, not
user input.

A value that lands with no `onAssetUpload` hook — bytes for image/font, the
parsed document object for vector — bypasses `allow` entirely, for every allow
list including the default. **This rests on a structural fact, not on "a URL
can't carry megabytes."** That plausibility argument is true, but it isn't
what the check actually rests on: `asset-resolve.js`'s resolver — the code
every `fonts`/`images`/`vectors` declaration resolves through, no matter which
control produced the value — calls `fetch` **only** for a `string`/`URL`
source. Bytes and parsed objects are consumed directly and never reach that
branch, so neither can become an outbound request no matter how it got into
`params` — which is exactly the class of harm `allow` exists to gate, and
still holds even if a host someday finds a way to put a few bytes of base64 on
a share link.

**Read that fact in the resolver's own order, though.** The resolver unwraps a
`{ default: … }` module namespace **before** it dispatches on shape, so
"object ⇒ never fetched" is not true of every object: `{ default:
"http://…" }` unwraps to a plain string and is fetched. The vector check
therefore unwraps first and judges what the resolver will actually see — a
string or `URL` gets the full `allow` treatment however it was wrapped, a
thunk is refused outright (its return value cannot be known at check time),
and only a value that genuinely does not unwrap to a fetchable source is
exempt.

**`npx partforge ingest`** runs the same classify/convert step outside a
browser, for an agent (or a script) handed a raw file with nowhere to drop it:

```bash
npx partforge ingest logo.svg   --out logo.vector.json
npx partforge ingest scan.ttf   --out src/parts/assets/scan.ttf
```

`--out` is required, always — for a pass-through case (PNG, font) a computed
"beside the input" default would land on the exact same path as the input
itself, and a surprising same-path overwrite is worse than an explicit
destination every time. The four cases the drop widget's classification can
produce, resolved to a file instead of a param:

| Input | Result |
|---|---|
| SVG | converted to a `partforge-vector` JSON document (`--strokes outline`, the default, turns strokes into filled geometry; `--strokes ignore` drops them) |
| PNG | passed through unchanged — validated by the same magic-byte sniff the drop target uses, not a full structural PNG decode |
| JPEG / WebP / other raster | refused, naming the browser path instead |
| TTF / OTF | parsed with opentype.js to prove it's readable, then copied through unchanged |

**Headless raster conversion is out of scope, not merely unimplemented.** SVG
conversion runs headlessly by installing `happy-dom` — an **optional peer
dependency** (`npm install happy-dom`) — as a stand-in DOM and importing the
same paper.js converter the drop widget uses; paper.js never touches the
raster context for its geometry work, so a no-op `getContext` stub
(`src/framework/ingest/node-dom.js`) is enough to satisfy it. Converting
JPEG/WebP to PNG has no equivalent escape: it needs `createImageBitmap` and a
real `<canvas>` to encode through, and happy-dom implements no canvas raster
backend at all — there's no stub for a missing pixel pipeline the way there is
for missing DOM structure. Convert those in a browser (drop the file onto the
app's Image control) or with your own tooling before ingesting.

## Host jobs: extending the worker

The worker's job loop handles a closed set of message types (`generate`, the exports,
`inspect`, …). A host app can add its own: `runWorker(part, { jobs: { <type>:
handler } })`. A message whose `type` matches no built-in is handed to the matching
handler as `handler(kernel, part, msg, post, { isStale })` — the live kernel (so the
handler can `kernel.import(name)` a declared import, or read `kernel._importDigest`),
the part current when the message arrived, the message, and the poster for results
(`post(msg, transferables?)`). A throw is posted as the ordinary `{type: "error",
message, jobId}`; built-in types cannot be overridden; a type with no handler is
ignored.

This is the seam through which a host adds a capability this open framework does not
ship. The semantic mesh oracle — imported mesh → feature report, for rebuilding an
STL parametrically — is one: it is a separate, closed package with its own CLI, and
the app that installs it registers its job here. This repo carries nothing
oracle-shaped: no verb, no message types, no error codes. The one direction that
does exist is the oracle peer-depending on this package for `partforge/oracle`'s
mesh/BVH helpers and file parsers (`bounds`, `meshArea`, `meshTriangles`, `parseStl`,
`parse3MF`); those exports are part of its contract.


## Probes: measuring geometry into the report

A `probes` block turns the measure report into an instrument panel. Each probe is
a pure `(k, p, d)` function with **build's exact contract** — same kernel handle,
same resolved params and derived values — but its result lands in the **report**
instead of the scene:

```js
probes: {
  // A Solid anywhere in the return value is measured into a fact object:
  // { empty, bbox, bounds, centerOfMass, volume, surfaceArea, triangleCount,
  //   watertight, holes }
  slabX12: (k, p, d) => buildBody(k, p, d)
    .intersect(k.box({ min: [12, -25, -4], max: [13, 25, 4] })),

  // The paired form — the localizing workhorse when a rebuild drifts from its
  // imported reference: the same thin slab through both solids, side by side.
  slabPair: (k, p, d) => ({
    mine: buildBody(k, p, d).intersect(k.box({ min: [12, -25, -4], max: [13, 25, 4] })),
    ref:  k.import("scan").intersect(k.box({ min: [12, -25, -4], max: [13, 25, 4] })),
  }),

  // Plain JSON passes through verbatim — compute any number the solid queries
  // can reach (volume/boundingBox booleans, arc fits, whatever).
  xor: (k, p, d) => {
    const mine = buildBody(k, p, d), ref = k.import("scan");
    return mine.volume() + ref.volume() - 2 * mine.intersect(ref).volume();
  },
}
```

**Where they show up.** `npx partforge measure` prints a `probes:` section and
includes `probes: { name: value }` in `--json`; the worker's `inspect` job carries
the same key, so any host reporting measure output (e.g. an agent's check loop)
sees probe values on every edit with no extra wiring. Probes are **part-level,
not per-view**: every measured view reports them, so they never disappear because
the "wrong" tab was measured.

**What they replace.** Before probes, getting a cross-section's numbers out of
the pipeline meant authoring throwaway `exportable: false` sub-parts and fishing
their facts out of the sub-part list — polluting views, the control panel's
mental model, and the overlap check. Probes are invisible to the viewer, the
exporter, the assembly checks, and `verify` gates; they exist only in the report.

**Failure is contained.** A probe that throws reports `{ error: "…" }` in its
own slot — it never crashes the measurement and never flips the report's `ok`.
An empty boolean result (a slab that misses the part) reports
`{ empty: true, volume: 0 }` rather than degenerate infinite bounds — "no
material here" is a first-class answer for a localizing probe. Lint covers
probes with the same pass as builds: a throwing probe is `probe-throws`, a
malformed block is `invalid-probes`, and unknown ops / bad options / impurity
are caught exactly as in `build`.

**Driving geometry from a live measurement.** Probes get numbers *out*. To feed
a measurement *into* geometry, remember that `build` already holds a real
kernel: `k.import("scan").boundingBox()` (and `.volume()`, and booleans between
solids) work live inside any build, so a sub-part can size itself off another
solid directly — no probe needed. Keep it pure: the measurement is deterministic
for a given import + params, which is exactly what the geometry cache assumes.
To set parameter **defaults** from a reference (the "rebuild this STL" flow),
declare a probe that reads the value, run `measure`, and bake the reported
number into `defaults` — the probe then keeps watching it on every regen, so a
swapped import shows up as a probe delta instead of silently stale defaults.

**Reading a 2-D shape's arcs and corners.** Return the `Shape2D` itself and the
report carries a summary instead of the object: a flat `rings` list — one entry
per ring, each naming where it came from (`region`, `ring: "outer" | "hole"`,
plus `hole` on a hole ring) — every arc as `{ center, r, from, to, sweepDeg }`
(exact for a `{to, via}` arc; a cubic is fitted through its start, midpoint and
end and tagged `fit: "cubic"`), every corner as `{ position, point,
interiorAngleDeg, convex }`, plus `area`, `bbox`, and a straight-segment count
per ring. `position` is a running count across every ring in that same order —
region by region, outer then holes — which is exactly the positional index
`fillet({corners: {indices}})` and `shape.corners()` select on, so a corner read
here can be fed straight back into a fillet call.

Fillet itself never emits a cubic — paper.js has no arc primitive, so an
exactly-constructed `{to, via}` arc only becomes a cubic once the shape has been
through a **boolean** (union/cut/intersect), a non-uniform transform, or
`simplify`. So after any of those, every arc in the summary is `fit: "cubic"`,
including ones a fillet placed exactly. For an unclipped arc that cubic fit is
still exact to the reporting grid; when a boolean clips an arc **mid-sweep**,
the fit's centre and radius drift, and the drift grows as the kept fragment
shortens. So when you need an exact centre, read it off the **unclipped**
shape and use a clip only to find which arc to look at — don't trust the centre
reported on the clipped fragment itself:

```js
probes: {
  fullBend: (k, p, d) => trayPocket(k, p, d),
  // Clip only to locate the arc; read its numbers off fullBend above, not here.
  bendNear: (k, p, d) => trayPocket(k, p, d).intersect(k.shape2d([[18, -6], [28, -6], [28, 4], [18, 4]])),
}
// → probes.fullBend.rings[0].arcs: [{ center: [23.75, -3], r: 4, … }, …]
```

This is the instrument for any question a render cannot settle to a fraction of
a millimetre: whether two arcs share a centre (a bend's inner and outer radii),
what radius a `fillet` actually took after clamping, whether a corner is still
a corner. The summary lists at most 64 arcs and 64 corners **in total**, across
every ring — not 64 each per ring — and says `truncated` when it had to cut, so
keep the probe to the region in question.

**Cost.** Probes run on every `measure`/`inspect` (including quick checks — the
agent loop is exactly who reads them), so keep them proportionate: a handful of
thin-slab booleans is cheap; a dense sweep of whole-part XORs is not. `verify`'s
per-case re-measures skip probes entirely (no gate reads them). The reference
part for probes is [`src/parts/import-demo.js`](../src/parts/import-demo.js).

## Wiring a part into a runnable app

Three tiny glue files per part (copy from the demo). The worker statically imports
your part, so it can't be injected at runtime — hence the per-part entries.

`src/app-<part>.js`:

```js
import part from "./parts/<part>.js";
import { mount } from "partforge";
mount(part, {
  // NB: the `new Worker(new URL(...))` MUST stay inline here or Vite won't bundle the worker.
  createWorker: (name) => new Worker(new URL("./<part>-worker.js", import.meta.url), { type: "module", name }),
});
```

`src/<part>-worker.js`:

```js
import part from "./parts/<part>.js";
import { runWorker } from "partforge/worker";
runWorker(part);
```

`<part>.html` — structural markup only (no CSS; `mount` pulls in partforge's
stylesheet). `mount` looks up these element IDs:

| ID | Purpose |
|---|---|
| `#app` | viewer canvas mounts here |
| `#controls` | control panel is built into this |
| `#part` | view-tab bar — leave the div **empty**; `mount` generates one button per entry in `part.views` and opens the resolved default (see the "Which view the viewer opens on" rule above) |
| `#download-step` / `#download` / `#download-3mf` | STEP / STL / 3MF export buttons |
| `#status`, `#busy`, `#phase` | status line + busy overlay |
| `#viewbar` with `#annotate` / `#measure` / `#cutaway` / `#reframe` / `#theme` | optional viewer controls (omit any you don't want) |
| `#panel` | the full-height controls rail (`class="pf-rail"`); programmatic hosts pass `elements.rail` instead |
| `#rail-toggle` | optional — collapses/restores the rail; resolved the same way as `#reframe`/`#theme`. A sibling of `#viewbar`, not a child of it: give it `class="pf-float-rail-toggle"` and it floats at the stage's top right |

Copy `demo.html` and change the title, the panel heading, and the `<script src>`. Two
workers are spawned from your one worker entry (`name` = `"manifold"` for preview/STL/3MF,
`"occt"` for STEP — handled for you).

**The view style button needs no markup.** `mount` generates it (`#view-style`)
beside the view cube, to its left (it replaces the old projection toggle,
and belongs to the cube's stack), so it hides whenever the cube does (Sketch mode, a
crowded animation transport bar). It opens a popover holding every control that
changes *how* the part is drawn: the **style** — CAD or one of the realistic
environments (see "Materials and appearance" above), each shown as a live
thumbnail of the part, re-rendered on the next open after the part or theme
changes — a **Feature lines** switch for the current style, and a
**Perspective / Orthographic** projection control. The old `#realistic` /
`#environment` viewbar controls (`elements.chrome.realistic` /
`.environment`) and the cube's own `#projection` button were retired with it
(2026-09-24); a page that still carries `#realistic` / `#environment` markup
just shows dead elements, so delete them. A host can still drive
`runtime.renderMode` / `runtime.environment` / `runtime.featureLines` /
`runtime.projection` from its own UI (see below). All of these preferences
persist across reloads the same way the theme does, and are carried in
`viewerState` (below), which outranks what is stored.

**`#reframe` is supported but no longer shipped.** The framework's own pages dropped
the button on 2026-08-20: clicking a face, edge or corner on the view cube reframes
too, so a separate control was one more thing in a crowded bottom-right corner. The
wiring is untouched and fully optional — supply the button (by ID or as
`elements.chrome.reframe`) and it works exactly as before — so a host with its own
scaffold need change nothing.

**`#rail-toggle` left the viewbar on 2026-08-20.** It used to be the pill's last
button; it now floats alone at the stage's **top right**, opposite the pill's bottom
right, as a bare icon that grows a background on hover. Nothing in the wiring changed —
`mount` still resolves it by id (or `elements.chrome.railToggle`), and `rail.js` still
hides it below the 720px narrow breakpoint, where the pane tab bar takes over. A host
with its own scaffold gets the new look by moving the button out of `#viewbar` and adding
`class="pf-float-rail-toggle"`; leaving it inside the pill keeps the old look and still
works.

**View control (the mount handle).** For an embedder driving the view tabs from its own UI
instead of (or in addition to) the built-in `#part` bar:

- `runtime.getView() → string` — the active view name; never null once the runtime is ready
  (mount resolves a default before first build — see "Which view the viewer opens on" above).
- `runtime.setView(name) → boolean` — switch tabs programmatically, the same path as clicking
  a tab. Returns `false` (and leaves the active tab untouched) for a name the part doesn't
  declare in `views`; `true` otherwise, including when `name` is already active.
- `await runtime.captureView(viewName?, opts?) → Promise<string | null>` — a JPEG data URL of
  `viewName` rendered offscreen (falling back to the resolved default view — see
  `resolveDefaultView` / `default-view.js` — when `viewName` is omitted or names a view the
  part doesn't declare). Never disturbs the active tab, the live camera, or the on-screen
  scene; `opts` forwards to the underlying render (size, quality, angle, background).
  Resolves `null` on failure rather than throwing (a build error, a part with no sub-parts
  in that view, a disposed runtime). The render happens in a throwaway scene, so it takes
  no colour from the viewer's light/dark theme: it gets a fixed neutral grey, on the
  reasoning that a thumbnail is captured once and then displayed under host chrome
  partforge cannot see. Pass `background` (any `THREE.Color`-compatible value) to choose
  your own, or `background: null` for no background at all — which clears to opaque black
  unless the embedder has set a clear colour.

Pass `onViewChange(name)` to `mount()` to be told the active view: it fires once
synchronously during mount with the initial resolved view (before `runtime.ready` settles),
then again on every subsequent change — a tab click or a `setView` call — always with the
new view name.

**Headless export (the mount handle).** The `#download*` buttons above are the built-in,
view-bound export UI. An embedder that wants its own export UI (e.g. a "pick which parts,
pick a format" modal) can skip those buttons and drive export off the handle `mount()`
returns instead:

- `runtime.listExportableParts() → [{ name, label }]` — every exportable sub-part
  (excludes any `exportable: false` part, respects each part's `enabled(params)`),
  **independent of the active view**. Use it to populate an export checklist.
- `runtime.exportParts({ parts, format, quality?, onProgress }) → Promise<void>` — build
  the given `parts` (sub-part names) in `format` (`"stl" | "step" | "3mf"`), streaming
  phase strings to `onProgress(phase)`. Resolves once the file is written (handed to your
  `onDownload` sink, or downloaded directly if you don't supply one); rejects on
  build/export failure or an empty selection. Placement uses the current
  view. STEP is routed to OCCT automatically.
- `runtime.warmExportKernel() → Promise<boolean>` — pay OCCT's cold boot *before* an
  export needs it. Because STEP is pinned to OCCT and OCCT's ~11 MB WASM loads on its
  first job, a part whose preview ran on Manifold pays that whole boot inside its first
  STEP export — the user waits having just asked for a file, and a host with an export
  timeout can trip it. Call this when an export becomes likely (your download dialog
  opening) and the wait lands somewhere harmless instead. Best-effort: resolves `true`
  once the kernel is up, `false` on any failure or teardown, never rejects, and is a
  cheap no-op once warm. It costs a speculative ~11 MB download, so fire it on a real
  signal of intent rather than on mount.

Pass `onDownload({ data, filename, mime })` to `mount()` to receive the exported bytes
yourself (e.g. to download from a different origin) instead of partforge's own DOM download.

- `fontCatalog` — a provider backing every `type: "font"` control in the part:

  - `search(query, { limit }) → Promise<FontFamily[]>`, where a `FontFamily` is
    `{ id, family, category, variants: [{ variant, label, url, bytes }],
    menuUrl }`. `url` is what the picker writes into `params`; `menuUrl` is a
    name-only subset used to draw the list row.
  - `describe(source) → { family, variant } | null` — optional reverse lookup so
    the closed control can name a face whose URL carries a hashed filename.

  partforge ships no provider — a host supplies one, and without it every font
  control renders as a URL field.

- `imageCatalog` — a provider backing every `type: "image"` control in the part:
  `{ search(query, { limit }) → Promise<ImageAsset[]>, describe?(source) → { label, width, height } | null }`,
  where `ImageAsset` is `{ id, label, url, width, height, thumbUrl }`. With no
  provider a `type: "image"` control degrades to a URL field.

- `onAssetUpload(blob, { kind, key, filename }) → Promise<string>` — the drop
  target shared by `"image"`/`"vector"`/`"font"` controls (see "Getting files
  into a part", below) calls this with the converted artifact after a drop,
  paste, or file-picker choice, and writes whatever it resolves to into the
  param. `blob` is the CONVERTED artifact — a PNG, a partforge-vector JSON blob,
  or the original file for a font — never the user's raw drop; `kind` is
  `"image"`, `"vector"`, or `"font"`; `key` is the param the drop landed on,
  which is what lets a host give each control a stable destination of its own
  rather than reconciling uploads against the part afterwards. Must resolve to
  a non-empty source string (an `https:` URL, or a host-defined `pfc-asset:` or
  `pfc-tree:` token); anything else is treated
  as a contract violation and reported through the control's own error line,
  not written into the param. Omit it and the converted bytes land straight in
  the param instead — the path a host that cannot fetch URLs (the
  partforge-cloud sandbox) needs, not a degraded fallback. A rejection is
  likewise reported through the control's error line, and the widget keeps the
  converted artifact so a retry costs a network call, not a re-decode/re-parse.

**Showcase capture (the mount handle).** The handle can also render the user's *current*
framing offscreen at a resolution independent of the window size and devicePixelRatio —
for gallery/preview images, where grabbing the live canvas would be capped at the viewer
pane's pixel size:

- `runtime.captureCurrent({ size = 2048, hideGrid = true, quality = 0.9, recenter = false } = {}) → string | null` —
  one offscreen render from the live camera's pose (position, up, and orbit target — not a
  canonical pose) with the live viewport's aspect ratio, `size` px on the long edge
  (clamped into `[256, maxTextureSize]`). Renders with 4× MSAA and the same
  camera-relative capture lighting as `captureViews`, so the result is print-quality even
  from a small window on a 1× display. Returns a `data:image/jpeg;base64,…` string, or
  `null` when the runtime is disposed or nothing is built/visible yet — it never throws.
  `hideGrid: false` keeps the floor grid so the capture matches the on-screen look
  exactly. The live view is untouched: the camera never moves, and lights/grid/render
  target are restored after the render. Measurement-mode dimensions render directly
  in the scene, so a dimensioned capture needs no special handling — enable measure
  mode (`runtime.measure.setEnabled(true)`) and call `captureCurrent()`; the dims are
  just part of the rendered frame.
  `recenter: true` centres the part: the capture becomes the largest centred
  sub-window of the current framing that still holds every visible vertex (equal
  margins on both axes, rendered at the full `size` resolution through a view
  offset, so it is a pixel-exact crop of what the user framed — same
  perspective, no re-encode). The extent is the projection of the actual mesh
  vertices, not a bounding box, so it is exact at any angle. The framing is
  kept as-is when the geometry runs past any frame edge (a user who zoomed in
  past the part's silhouette cropped it on purpose), when it is already centred,
  or when measurement dimensions are pinned (their labels sit beside the part and
  could otherwise be cut off).
- `runtime.captureViews(viewNames) → [{ view, dataUrl }]` — the canonical-angle
  counterpart (fixed poses, framed to the visible assembly, 1024², grid hidden). Sized
  for feeding a vision model, not for display; use `captureCurrent` for showcase images.

### `runtime.projection`

`{ get(), set(mode), onChange(cb) }` where `mode` is `"perspective"` or
`"orthographic"`. Drives the **live view** and `captureCurrent` only —
`captureCanonicalViews`, `renderMeshPayloads`, and the CLI's `partforge render`
stay perspective unconditionally, so agent-facing output does not depend on a UI
toggle. The choice persists across reloads under `partforge:projection` and is
restored before the first framing. The orientation cube and the view style
button beside it are hidden while Sketch (annotate) mode is active, but that only governs
*user-driven* view changes — the framework does not police programmatic ones.
The ink is a transparent overlay and the WebGL canvas keeps rendering beneath
it, so a host that calls `runtime.projection.set()` mid-sketch **visibly
re-frames the 3D view underneath ink the user may still be drawing**: the
elements stay where they were laid down while the model shifts out from under
them, and the sketch that gets sent is misaligned, not merely mis-labelled.
Deliberately unguarded, the same way it's always been free to call
`setCameraState` during Sketch.

### `runtime.renderMode`, `runtime.environment`, `runtime.renderViews`, `runtime.declaresMaterials`

For an embedder driving realistic mode from its own UI instead of (or in
addition to) the generated view style button above:

- `runtime.renderMode` — `{ get(), set(mode), onChange(cb) }` where `mode` is
  `"cad"` or `"realistic"`. `set()` resolves to the mode actually in effect —
  `"cad"` if the realistic environment's assets fail to load — and
  `onChange` receives `{ mode, busy, error }` so a host can show its own
  loading/error state. Same shape as `runtime.projection`. It drives the live
  view, and `runtime.captureCurrent()` follows it by default (a "capture from
  viewer" captures what the user sees). It never changes what an agent sees:
  `runtime.captureViews()` is always CAD, in either live mode, and a
  realistic agent render is only ever an explicit
  `renderViews(…, { renderMode: "realistic" })`.
- `runtime.captureCurrent({ renderMode })` — pins the showcase capture's look
  instead of following the live view. `"cad"` always works. `"realistic"` from
  a CAD view works only once the current environment's assets have loaded
  (the call is synchronous and can't wait for them); before that it falls
  back to the live look. Use `renderViews` when realistic must be guaranteed.
- `runtime.environment` — `{ get(), set(id), onChange(cb), list() }` for the
  realistic environment (`"studio"` | `"workshop"` | `"print-bed"` |
  `"outdoor"`, per "Materials and appearance" above). `list()` returns every
  environment as `[{ id, label }]`, for building your own picker. `set()`
  resolves to the id actually in effect; a failed switch while realistic is
  showing reverts to the environment still on screen, and `onChange` hears the
  revert too.
- `runtime.declaresMaterials` — `true` when any sub-part names a
  `display.material`. A part with none still supports realistic mode (every
  sub-part just renders under the library's `default` look), so use this to
  decide whether to surface your own realistic control at all, not whether it works.
- `runtime.featureLines` — `{ get(), set(on), onChange(cb) }`, same shape as
  `runtime.renderMode`. `on` is a boolean, and it applies to the **current
  style** — CAD, or whichever environment is showing — remembered separately
  per style: CAD defaults on (it's a drawing), a realistic style defaults off
  (it's a photograph), and switching styles restores whatever that style was
  last set to, not the CAD/realistic default. `onChange` receives
  `{ style, on }`. It drives the live view only: `runtime.captureViews()` and
  `renderViews(…, { renderMode: "cad" })` always draw lines, and
  `renderViews(…, { renderMode: "realistic" })` never does, whatever the live
  preference shows.
- `await runtime.renderViews(viewNames, { renderMode? })` — the appearance-aware
  sibling of `runtime.captureViews` (canonical angles, framed to the visible
  assembly, grid hidden): `{ renderMode: "cad" }` (the default) is exactly
  `captureViews` — CAD whatever the live view shows — and `{ renderMode: "realistic" }` borrows the realistic look
  for the capture — waiting on the chosen environment's assets — **without**
  switching the live view. Rejects if the realistic assets fail to load.

All three preferences round-trip through `mount()`'s `viewerState`: a
previous mount's `runtime.getViewerState()` carries `viewerState.renderMode`
(`"cad"` or `"realistic"`) and, only when the viewer's environment was
actually CHOSEN rather than merely defaulted from `meta.environment`,
`viewerState.environment`, plus `viewerState.featureLines` — the whole
per-style map (`{ cad: false, studio: true, … }`), keyed by style id, only for
the styles a preference was ever set on. `renderMode` reports the mode the
user is **headed for**, not only the one on screen: a realistic restore or
switch that's still loading reports `"realistic"`, so a host that remounts on
every edit (as an embedder applying edits by remounting typically does)
doesn't drop the in-flight choice — a load that ultimately fails still
settles back to `"cad"`. Pass `viewerState` back into the next `mount()` call
to resume all three where the previous mount left them; omit it on a first
mount and the viewer restores its own persisted choice instead, the same way
it does for the camera and projection.

### The annotation payload's camera block

`onAnnotationSend(payload)` receives a `camera` block in two frames — `world`
(replays exactly against the build that produced it) and `parts` (pinned to
the CAD geometry, so it survives a later rebuild's bbox recentring; reread a
sketch's camera intrinsics from `parts`, not `world`, once the model has been
rebuilt). `ANNOTATION_VERSION` is **3**: both frames carry
`projection: "perspective" | "orthographic"`, and under an orthographic camera
`fov` is `null` while `orthoHeight` gives the frustum's world height instead.
(v1 had `fov` only, and predates the projection toggle; v3 replaced the
payload's `strokes` array with `elements` — typed pen/line/rect/ellipse
shapes rather than raw ink paths — a change orthogonal to this camera block.)
The payload is self-describing for LLM consumers: a top-level `summary` joins
every element's plain-language `description`, and `frames` is a legend mapping
each payload path to its coordinate convention (element `params` are
stage-space, anchor `screen`s are per-axis normalized 0..1, descriptions are
viewport percentages — `viewport.aspect` bridges them). Each element carries an
`id` (`"e1"`, `"e2"`, …) for unambiguous reference in replies, `rotDeg`
alongside the radian `rot`, and erased spans rendered into the description in
each type's own vocabulary ("erased top edge", "erased arc 36°–126°"); each
anchor of a gapped element carries the `run` index of the visible fragment it
sits on.

**Reconstructing rays from a sketch payload.** Every anchor also carries
`ray: { origin, dir }` — a pick ray in the **parts frame** (mm origin, unit
direction), computed from the live camera at send time and rounded to 4
decimals; it is omitted when `camera.parts` is `null` (no meshes at send
time — the same condition under which no `hit` can exist). Unlike `hit`,
the ray is present even where the stroke crosses empty space, so any anchor
can be projected onto a construction plane. For screen points that have no
anchor (a circle's rim, a grid over a region), `partforge/oracle` exports
`annotationRay(payload, screenOrAnchor, { frame? })` — the same ray,
reconstructed from the payload's camera block (perspective and orthographic
both) — and `rayPlane(ray, plane)` intersects either kind of ray with
`{ point, normal }` or the shorthand origin planes `"xy" | "yz" | "zx"`,
returning `{ point, t }` in mm or `null` on a parallel / behind-origin miss
(the same miss semantics as `hit: null`). End to end:

```js
import { annotationRay, rayPlane } from "partforge/oracle";
const anchor = payload.elements.find((e) => e.id === "e3")
  .anchors.find((a) => a.at === "center");
const hit = rayPlane(anchor.ray ?? annotationRay(payload, anchor), "xy");
// → boss where the sketched circle's center points, on the z=0 plane:
//   k.prism({ points: circleProfile(r_mm, [hit.point[0], hit.point[1]]), h })
```

**The markup convention (`demo.html` is the canonical copy-me page):** `<body>` carries
`class="pf-shell"`, the flex row that lays the viewer column next to the rail. `#app`
(`class="pf-stage"`) *is* that viewer column, and now contains the floating chrome
(`#topbar`, `#viewbar`, `#busy`) as absolutely-positioned siblings of the canvas, not
page-level overlays. `#panel` (`class="pf-rail"`) is a full-height rail docked to the
right edge, split into three children — `.pf-rail-head` / `.pf-rail-body` /
`.pf-rail-foot` — of which head and foot are flex-fixed and only the body scrolls: put
your heading in the head and the download row in the foot so the export buttons never
scroll out of reach. The rail's drag/collapse seam is created by `rail.js` itself; don't
add markup for it. This isn't decorative — get the head/body/foot split wrong and either
the export buttons scroll away or a tall parameter list pushes them off-screen. See
`docs/superpowers/specs/2026-07-26-controls-rail-layout-design.md` for why the rail is
shaped this way (resize/collapse behavior, breakpoints, the design rationale).

**Keyboard (the seam is `role="separator"`, focusable, `tabIndex=0`):**

| Key | Action |
|---|---|
| ← | widen the rail 16px (64px with Shift). No-op while collapsed. |
| → | narrow the rail 16px (64px with Shift), clamped at the 240px minimum — never collapses. No-op while collapsed. |
| Home | jump to the 240px minimum, animated. Reopens even while collapsed. |
| End | jump to the clamped maximum (half the shell, capped at 560px), animated. Reopens even while collapsed. |
| Enter / Space | toggle collapse — collapses if open; reopens at the remembered width if collapsed. |
| double-click (on the seam) | reset to the 288px default, animated, and opens if collapsed. |

Arrow keys move the **separator**, not the pane — standard `role="separator"`
semantics, and why ← *widens* a right-hand rail. `Cmd`/`Ctrl`/`Alt` held with an
arrow key passes through untouched (those are OS/browser-reserved combos, e.g.
back navigation or window-switching); `Shift` alone still applies the larger
step. Collapsed, the two arrow keys are deliberate no-ops rather than a reopen
gesture — reopening would otherwise silently discard the remembered width and
clamp to the minimum, and "press an arrow, get narrower" reads backwards for a
rail that's already shut. Home/End and Enter/Space/double-click are exempt from
that rule and always reopen, since jumping to an explicit width or toggling is
an unambiguous, deliberate gesture either way. A held arrow-key repeat
suppresses the 150ms width transition for the whole repeat window (not just one
keydown), matching what happens during a drag.

Legacy id-only markup (predating this class scheme) still renders: `app.css` keeps
`:not(.pf-*)` fallbacks (`#app:not(.pf-stage)`, `#panel:not(.pf-rail)`, and
placement-only ones for `#topbar`/`#viewbar`) that reproduce the old floating-card
look — `:not()` rather than a plain id rule because an id selector outranks a class. New
apps should still use the classed markup above; the fallback exists for pages that
predate it, not as a second supported style.

A host that builds its own DOM instead of using `mount`'s markup (e.g. an editor
embedding the viewer/rail inside a larger UI) can adopt the same layout by importing
**`partforge/chrome.css`** directly — it's deliberately class-based and id-free for that
reason. It expects `partforge/tokens.css` to already be loaded for its `--pf-*` custom
properties, and expects the host to size `.pf-shell` itself (`mount`'s own `app.css`,
which `@import`s both, does both of these for you already).

`#cutaway` is optional viewer chrome. When present, it toggles an interactive
section plane whose exposed faces are hatched; changing views resets it. Cutaway
is viewer-only and never changes STL, STEP, or 3MF exports. Hosts that omit the
button get no cutaway UI.

Programmatic hosts can provide the same optional controls, including the rail toggle,
without relying on an ID by passing them beside the other chrome references — and can
pass the rail itself as `elements.rail` instead of relying on `#panel`:

```js
mount(part, {
  createWorker,
  elements: {
    rail,
    chrome: {
      reframe,
      cutaway,
      measure,
      theme,
      railToggle,
    },
  },
});
```

`rail`/`chrome.railToggle` are both optional; a host with no rail markup gets a
no-op (the resize/collapse behavior below simply doesn't attach). **Constraint:**
the rail element must be a direct child of the positioned `.pf-shell` — the
resize seam is created and positioned against `rail.parentElement` by default,
so an extra wrapper div between them (common in a React layout) puts the seam
against the wrong ancestor and silently breaks `[data-pf-dragging] .pf-stage`.
A host that can't make the rail a direct child of `.pf-shell` must also pass
`elements.shell` pointing at the real positioned ancestor:

```js
mount(part, {
  createWorker,
  elements: { rail, shell, chrome: { railToggle } },
});
```

> Production deploy compiles only the pages listed in `build.rollupOptions.input`
> (currently the landing gallery + the demo part pages). Other root `*.html` files are
> **dev-only** (Vite serves any root HTML in `npm run dev`) unless added there. To also
> ship one, add it to `build.rollupOptions.input` in `vite.config.js`.

**Styling hooks:** the rail/stage layout and palette are both plain `--pf-*` custom
properties from `partforge/tokens.css`, overridable on `:root` (or
`:root[data-theme="light"]`) without touching `chrome.css`. Layout/shape tokens added
alongside the rail: `--pf-sans`, `--pf-rail-w`, `--pf-rail-pad`, `--pf-radius-control`,
`--pf-radius-pill`, `--pf-shadow-float`, `--pf-shadow-rail`. The dev demos self-host
Geist and Geist Mono (`@fontsource-variable/geist(-mono)`, a `devDependency`, imported
from each `app-<part>.js` — see `src/app-demo.js`) so a standalone forge looks like the
finished product; the published library ships no font files, and a consumer that loads
none falls through `--pf-sans`/`--pf-mono` to system stacks by design.

### Developing against a local (linked) partforge

A normal `npm install partforge` needs no extra config. But if you `npm link` a local
partforge checkout (to co-develop the framework), it lives **outside your project root**,
so Vite refuses to serve its files — including the Manifold/OCCT WASM, which fails with a
403 and the kernel never boots. Allow-list it in your `vite.config.js`:

```js
server: { fs: { allow: ["./", "../partforge"] } } // path to your linked checkout
```

(Geometry/asset imports are already worker-safe; this is purely Vite's dev-server file
access. It's harmless to leave in when partforge is a normal install.)

---

## Testing a part

Tests run under **Node 24** (`nvm use` first; the default shell Node is too old) via
`npx vitest run`. The oracle half of this surface — `measure`, `verify`, gaps,
match scoring — is also published on its own as
`partforge/oracle` (browser-safe import closure); `partforge/testing` re-exports
it, so either import works. Build geometry directly off your part with a Manifold
kernel:

```js
import { bootManifoldKernel, resolveDerived } from "partforge/testing";
import part from "../src/parts/<part>.js";

const k = await bootManifoldKernel();
const solid = part.parts.<name>.build(k, part.defaults, resolveDerived(part, part.defaults));
expect(solid.toMesh().triangles).toBeGreaterThan(0);
```

**Collision check (assemblies).** `assemblyOverlaps` builds every sub-part of a view in
its assembly pose and returns any interpenetrating pair with its overlap volume —
parts meant to fit (e.g. seated in a pocket) read ~0 and don't trip it:

```js
import { assemblyOverlaps } from "partforge/testing";
test("assembly has no interpenetrating parts", () => {
  expect(assemblyOverlaps(k, part, "<view>", {})).toEqual([]); // [{a,b,volume}] on failure
});
```

See `test/framework/assembly.test.js` for a real example, and `test/framework/jobs.test.js`
for exporting through the job loop.

**OCCT tests** (STEP / B-rep) boot the OCCT kernel with `bootOcctKernel()` from
`partforge/testing` (in a `beforeAll`) — see `test/occt-backend.test.js`.
**OCCT and Manifold must not boot in the same process** — keep OCCT-booting tests in their
own files (vitest isolates files).

---

## Verifying a part headlessly (render + measure)

Once the package is installed you get two CLI commands that build your part in
pure Node (no dev server, no browser) so you — or an LLM authoring the part — can
check it without opening the app:

    npx partforge measure src/parts/<part>.js [view]      # geometric facts
    npx partforge render  src/parts/<part>.js [view]       # canonical-angle PNGs

`measure` prints a report: per sub-part and per view it reports bounding box,
volume, surface area, triangle count, whether the solid is watertight, and the
number of through-holes (genus), plus an assembly overlap check, and a
**near-miss** check — sub-part pairs whose surfaces come closer than 0.5 mm
without touching (`near-misses:` in the output; reported for judgment, never an
exit-code gate by itself). It exits non-zero
if any sub-part isn't watertight or any parts interpenetrate — so it doubles as a
CI/agent gate. Add `--json` to also dump the report as JSON on stdout, or
`--out report.json` to write it to a file (nothing is written otherwise). (Manifold output is
manifold by construction, so `watertight` is mainly a build-sanity check for
empty/degenerate results; `holes` is the informative topology number.)

`render` writes one PNG per angle (`iso`, `front`, `top` by default; choose with
`--views iso,front`, output dir with `--out`) to `render/`. The view defaults to
the part's first declared view. Treat renders as complementary evidence, not a ruler:
use several views for complex parts and the interactive viewer's cutaway for hidden
interfaces, but rely on `measure` / `verify` for dimensions, contact, and clearance.

The `measure` function is also exported for vitest (boot a Manifold kernel as in
"Testing a part", then `measure(kernel, part, "<view>")`):

    import { measure } from "partforge/testing";
    test("part is sound", () => {
      const r = measure(kernel, part, "<view>");
      expect(r.ok).toBe(true);
      expect(r.subparts[0].holes).toBe(1);   // e.g. expects one bore
    });

## Linting

`partforge lint` statically validates a PartDefinition without booting a geometry
kernel. It runs in milliseconds and catches the authoring mistakes that otherwise
surface only at runtime — or, worse, not at all.

```bash
npx partforge lint src/parts/<part>.js [--params '{"h":40}'] [--json] [--out f] [--strict]
```

Exit 0 when clean, 1 when any **error** finding is present; `--strict` also fails on
warnings. `partforge measure` runs the error tier automatically before booting a
kernel — pass `--no-lint` to skip it.

The same check is available programmatically and in the browser:

```js
import { lintPart } from "partforge/lint";
const { ok, errors, warnings } = lintPart(part, { params });
```

`lintPart(part, { sources })` optionally takes the part's own source files
(`{ files: { path: text }, entrypoint }` — `entrypoint` names the file holding the
`PartDefinition`, defaulting to the first key) and unlocks a ninth rule group that
reads the source itself, catching the defects evaluation erases. The CLI passes the
module's own file automatically, so `partforge lint`/`measure` always run it; a
programmatic caller that omits `sources` (or hands over a malformed one) just gets
no findings from that group. Source findings carry `file` and `line` on top of the
standard shape, and `SOURCE_RULE_IDS` names them — a host that gates rendering on
lint errors uses it to keep them reported but non-blocking.

`lintPart(part, { vectorDocs })` optionally takes the RAW parsed JSON of the
part's declared `vectors` files — `{ name: parsedDocument }` — and unlocks the
two vector rules that need to read `units`/`shapes` (below). Lint is pure and
synchronous by contract, so it never fetches these itself: `vectors.js`'s
`resolveVectorDocs(part.vectors)` does the async resolve (sharing the same
bytes memo `resolveVectors` uses, so `lint` ahead of `measure` costs no extra
fetch) and the caller passes the result in, exactly the way `sources` already
works. Both built-in callers do, by different routes: `bin/cli.js` awaits
`resolveVectorDocs` for `partforge lint|measure`, while the worker's `lint` job
uses the synchronous `cachedVectorDocs`, which reads only documents already in
the resolver's memo and never starts a fetch. That difference is deliberate — a
CLI run can afford to wait for a file, but the in-app lint must stay instant and
offline, because a host runs it on every edit and `fetch` has no timeout. In
practice a build has loaded the artwork long before anyone reads a lint report,
so both rules are live in the app too; before the first build they are simply
silent. Omit `vectorDocs`, or hand over something malformed, and those two rules
just stay silent rather than guess.

`partforge/lint` has **zero runtime dependencies** and never imports a geometry
kernel or the DOM viewer, so it runs unchanged in Node, a Web Worker, a sandboxed
iframe, and Deno. A worker also answers `{ type: "lint", params }` with
`{ type: "lint-report", report }` without booting its kernel.

**Findings** carry the same guarantees as verify's checks — a self-contained `hint`
on every one, and a stable `pattern` id where an ERROR-PATTERNS.md entry applies:

```js
{ rule: "features-requires-sliders", severity: "error",
  message: "section \"flange\" feature 0 has no `sliders` array",
  hint: "A `features` entry must carry a `sliders` array …",
  path: "parameters[1].features[0]", pattern: "features-missing-sliders" }
```

`path` is a JS accessor path rooted at the PartDefinition — `parameters[1].features[0]`,
`defaults.bore`, `parts.spacer.views[0]`, `parameters[0].presets["M3"].od`. Findings
about the definition as a whole use `""`.

**Severity.** A finding is an `error` when the part is *provably broken* — it cannot
behave as authored — whether or not that shows up as a thrown exception. Some error
findings do correspond to a runtime throw (`build-throws`, `verify-expect-throws`),
but others catch **silent** wrongness: `missing-meta-title`, `part-view-unknown`,
`control-key-not-in-defaults`, `control-default-not-primitive`,
`preset-key-not-in-defaults`, and
`verify-unknown-subpart` all fire on parts that build, measure, and verify cleanly —
a dead control that's silently unreachable, a view that renders nothing, or a
`verify` expectation that's silently dropped so its gate never runs. That's still an
error: the part doesn't do what its author wrote, the failure is just quiet instead
of loud. Everything speculative or stylistic — lossy but not broken — is a `warning`
and never blocks anything. Because `measure` runs the error tier as a gate (see
below), a part with one of these silent defects now exits non-zero where it
previously didn't; that's the fix working as intended, not a regression.

### Rule catalog

**Definition shape** — `missing-meta-title`, `missing-defaults`, `no-buildable-parts`,
`missing-views`, `part-view-unknown`, `invalid-probes` (all errors); `view-unused`,
`default-view-ambiguous` (warnings). `invalid-probes` fires when a declared
`probes` block isn't an object of functions (see "Probes" above).

**Parameter schema** — `features-requires-sliders`, `features-requires-on`,
`control-key-not-in-defaults`, `control-default-not-primitive`,
`preset-key-not-in-defaults`, `mixed-section-shape`,
`duplicate-preset-name`, `duplicate-node-id`, `select-options-missing`,
`select-default-not-in-options`, `log-scale-needs-positive-min`,
`when-key-not-in-defaults`, `when-unknown-operator`, `unknown-control-type`,
`custom-control-widget-not-function`, `custom-default-not-json`,
`custom-keys-not-in-defaults` (errors);
`slider-range-excludes-default`, `unknown-control-field`, `duplicate-control-key`,
`default-not-exposed`, `readout-unknown-derived-key`, `slider-refinement-invalid`,
`group-depth`, `section-too-many-controls` (warnings).

`mixed-section-shape` fires when a section mixes the new `controls` array with
a legacy field (`advanced`, `toggles`, `features`, `presets`) — the two shapes
can't coexist, since mixing them would make the render order arbitrary. Move
the legacy entries into `controls` (a toggle becomes a checkbox control,
`advanced` becomes a nested group, `presets` becomes `{ type: "preset" }`
nodes), or drop `controls` and stay legacy.
`custom-default-not-json` is `control-default-not-primitive`'s counterpart for a
`type: "custom"` control, whose key may hold a JSON value (see "Custom controls"):
it names the first member that is not one — `null`, a function, a class instance,
a forbidden key, or a value past the 16 KB / depth-8 caps.
`duplicate-preset-name` fires when the same preset name is declared twice
(legacy `presets` and/or `{ type: "preset" }` nodes both count) — preset names
are global to the part, and `verify()` expands one case per name and throws on
a repeat, a worse place to find out. Rename one of them.
`duplicate-node-id` fires when two panel nodes (sections, groups, or controls)
share an `id` — the renderer keys its element and state maps on ids, and a
collision silently cross-wires the two nodes. Rename one `id`, or drop it to
use the positional default.
`select-options-missing` fires when a `select`/`radio` control has no
`options` array — with none the control renders empty and its parameter can
never change.
`select-default-not-in-options` fires when `defaults[key]` is not one of a
`select`/`radio`'s option values (watch value types — `12` is not `"12"`) —
without this the panel opens showing a value the user can never get back to.
Add the value to `options`, or change the default.
`log-scale-needs-positive-min` fires when a slider/number sets `scale: "log"`
without a positive `min` — `log(0)` is `-Infinity` and the thumb-to-value mapping
breaks, so raise `min` above 0 or drop `scale`.
`when-key-not-in-defaults` and `when-unknown-operator` walk every authored
`when` (on a control, a group, a preset, a readout, or a section itself) —
`allOf`/`anyOf`/`not` recurse — and check each condition against the two things
that make it real: the param key must be one `defaults` actually declares, and
each comparison operator (`{ gt: 0 }`, `{ in: [...] }`, …) must be one
`evalWhen` recognises. Both are silent failure modes — an unknown key reads
`undefined` and an unknown operator is treated as false, so either way the
condition is always false and the node never shows — which is why both are
errors rather than warnings.

`unknown-control-type` fires when an authored control's `type` (e.g. a typo
like `"sldier"`) isn't one of the recognised widget types — the renderer skips
a node with an unrecognised type entirely, so the control silently vanishes
from the panel with no other sign anything is wrong. An unrecognised type's
field list falls back to the common set (`key`, `type`, `label`, `description`,
`hidden`, `when`, `whenFalse`) rather than an empty one, so this error carries
the diagnosis instead of every field on the control — even ordinary ones like
`label` — separately warning as `unknown-control-field`. This only applies to
the authored `controls` shape — a legacy descriptor's `control:` value was
never validated and still isn't.

`readout-unknown-derived-key` checks a `{ type: "readout" }` entry's `derivedKey`
against the keys `derive()` actually produces (resolved once against `defaults`)
— a readout naming a key no group returns shows an em-dash forever, so it warns
rather than errors.
`slider-refinement-invalid` covers a slider/number's optional `ticks` (native
datalist marks; combine with `snap: true` to quantize slider drags to the
nearest tick) and `recommended` (an `[lo, hi]` band tinted on the track, with
the value box warning outside it): a tick outside `[min, max]`, a `recommended`
that isn't exactly `[lo, hi]` with `lo < hi`, or either of them combined with
`scale: "log"` (ticks and the band render on a linear track only) all warn.
`group-depth` warns when authored groups nest more than two levels deep — a
section plus one inner fold is as deep as a 300px rail can stay readable.
Flatten by promoting the innermost group to its own section, or folding its
controls into the parent.
`section-too-many-controls` warns when a section (authored or legacy, desugared
to a common format) shows more than 12 visible controls — the budget is
deliberately conservative, revisable against real LLM-authored parts. More than a
dozen in one section reads as a wall; split into multiple sections, or hide
internals (`hidden: true`). Grouping controls organizes them but does not
reduce the count — the check recurses into groups — so a group alone doesn't
bring a section back under budget.

**Kernel API**, found by executing `build()` — and every declared probe, which
shares build's `(k, p, d)` contract — against a geometry-free probe —
`unknown-kernel-op`, `unknown-solid-op`, `invalid-op-options`, `build-throws`,
`probe-throws`, `derive-throws`, `manifold-backend-uses-occt-op`,
`build-runaway` (errors); `nondeterministic-build` (warning, from diffing two
probe runs).

**Verify block** — `verify-unknown-metric`, `verify-unknown-subpart`,
`verify-bad-expr`, `verify-bad-pair-check`, `verify-unknown-process`,
`verify-unknown-orientation`,
`verify-expect-throws` (all errors). Note `_view` also accepts the pair-wise
`contacts` / `clearance` keys, which are not scalar view metrics; they are
validated by `verify-bad-pair-check`, matching `verify.js`'s own handling.

**Animations block** — static validation of each view's `animations` block,
without executing `build`: `animation-not-in-view` (a top-level `animations`
key, which the runtime ignores), `animations-not-object`,
`animation-tracks-or-steps`,
`animation-unknown-param`, `animation-param-not-numeric`,
`animation-keyframes-invalid`, `animation-value-out-of-range`,
`animation-opacity-unknown-part`, `animation-opacity-range`,
`animation-duration-invalid`, `animation-loop-invalid`,
`animation-step-label-duplicate`, `animation-easing-unknown`,
`animation-camera-invalid`, `animation-description-invalid`,
`animation-autoplay-invalid` (all errors). One
more rule does execute `build`, geometry-free: `animation-track-rebuilds` probes
each track's endpoint values and emits a **note** when the animated param feeds
real geometry (or the probe can't be trusted), because such a track plays
best-effort rather than at frame rate. Notes are informational — they never
affect `ok`, `measure`, or `--strict`.

**Place invariants**, found by running the geometry-free pose probe (the same
one animation's `animation-track-rebuilds` uses) against each sub-part's
`place()` — `view-dependent-display-place` (display placement must not depend
on the active view, since display meshes are cached across views) and
`place-not-rigid` (display vs. export placement may differ only by a rigid
motion — translate/rotate — never a reshape) (both errors). An untrusted probe
(a query op or function selector reached during `build`/`place`) proves
nothing either way and stays silent, matching `animation-track-rebuilds`'s own
trust handling.

**Appearance** (all warnings) — `unknown-material` (a `display.material` the
library does not know; the viewer shows the default look), `unknown-environment`
(`meta.environment` not known; realistic mode uses `studio`),
`material-key-unknown` (a `display` key that is not colour, opacity, material
or one of the six overrides; ignored), `material-override-clamped` (an override
outside its range, or not a number; clamped).

**Geometry imports** — `import-unknown-name` (a build calls `k.import` with a
name the part's `imports` field doesn't declare — this throws at build time;
lint reaches it in microseconds instead), `import-mesh-on-occt` (a declared
STL/3MF import on a part that routes to OCCT — mesh imports need the Manifold
backend; the message names whether `meta.backend` or a CAD op forced OCCT.
Only extension-detectable `imports` sources — a `URL` or string path — are
checked; a bytes/thunk source's format can't be known without resolving it, so
lint skips it and the lazy `k.import` error entry at build time remains the
runtime authority for those cases), `reference-unknown` (a sub-part's
`reference` names no declared import) (all errors); `ref-metric-without-reference`
(a sub-part's `verify.expect` uses a `ref*` metric — `refXorVolume`,
`refVolumeDeltaPct`, `refBboxDelta` — but the sub-part declares no `reference`,
so the deviation gate always reports status "skip") (warning).

**Font controls** — `font-control-not-in-fonts` (a `type: "font"` control's
`key` is not read by a function-form `fonts` — a static `fonts` object or a
missing `fonts` field both provably can't depend on a param, so the picker
changes a param and nothing else happens; the message names which of the two
it is) (error); `font-source-scheme` (`defaults` holds a value for a font
control that the control's own `allow` list would refuse — at build time it's
swapped for `defaults[key]`, i.e. itself, so the part boots with no usable
font; use a source `allow` accepts, or widen `allow`) (warning).

**Image controls** — the sibling group for `type: "image"` controls, `images`,
and `k.heightfield()`. `image-control-not-in-images` (a `type: "image"`
control's `key` is never returned by `images` — unlike the font rule above,
this one actually calls a function-form `images` with the control's key set to
a sentinel value and checks whether the sentinel comes back out, because a
picker only silently does nothing if the function ignores that specific key,
not just any key; a static `images` object provably can't depend on any param,
so it is skipped there — that is a different mistake, not this rule's business)
(error); `heightfield-unknown-image` (a build calls `k.heightfield(name, opts)`
with a string `name` absent from a **static** `images` object — skipped when
`images` is a function, since its keys aren't statically known; an inline
`{width, height, data}` grid as the first argument is never flagged, since that
is a supported call shape, not a name) (error); `image-source-scheme`
(`defaults` holds a value for an image control that the control's own `allow`
list would refuse — same shape as `font-source-scheme` above, including the
empty-string and raw-bytes exemptions from `image-source.js`) (warning).

**Source rules** — the tenth group, which runs only when the caller hands over
`sources` (above) — `control-default-not-literal` (a control's `defaults` entry is
written as something other than a plain literal: an expression like `13 / 3`, an
array or object, a template literal, a `0x10`/`1_000` spelling. Hosts persist a
panel edit by rewriting that value's span in the source, so a spelling the
rewriter cannot read means the user's edit is silently lost on reload — write a
plain decimal/string/boolean literal, or move the computation into `derive()`)
(error); `impure-source-token` (the source contains `Math.random`, `Date.now`,
`performance.now`, or an argless `new Date()` — replace it with a parameter or a
`derive()` output) (warning). Only a default a **visible** control is actually
**bound** to is checked: an unbound non-primitive default (a lookup table, an
array of hole positions) is never rewritten by a panel save and stays legal and
unflagged, and so is the default of a statically hidden control (`hidden: true`
on the control, or on an enclosing group or section) — it renders no widget, so
there is no panel edit to lose, and `hidden: true` is the documented idiom for an
internal constant. A `when`-conditioned control is *not* hidden — it can appear,
so its default is checked.
`impure-source-token` is warning-tier because the behavioral
`nondeterministic-build` probe stays the error authority on impurity — the source
scan is the wider net that also catches an impure value stable within one probe
pass. It scans `.js`/`.mjs` files only (prose in a `README.md` is not a build),
and code only within them (comments and string/template *interiors* are blanked
first), so an impurity token inside a `${…}` interpolation is not seen. It emits
one finding per (file, token) pair, carrying the occurrence count and the first
occurrence's line, rather than one per occurrence.

**Vector geometry** — `vector-unknown-name` (a build calls `k.vector2d` with a name the
part's `vectors` field doesn't declare — this throws at build time; lint reaches
it in microseconds instead; needs no `vectorDocs`), `vector-size-missing` (a
`k.vector2d` call declares none of `{ width }`, `{ height }`, or `{ fit }` **and**
the named file's `units` is `"artwork"` — unlike `k.text2d`'s cap-height `size`,
artwork units carry no physical meaning, so there is no safe default to fall
back on; an `"mm"` file's coordinates already are millimetres, so a size is
genuinely optional there), `vector-unknown-shape` (a `k.vector2d(name, { shape })`
call names a shape the file's `shapes` object doesn't contain), and
`vector-control-not-in-vectors` (a `type: "vector"` control whose key never reaches
`vectors:` — either because `vectors` is a static object, which cannot read a param
at all, or because the function form never returns the picked value; the picker then
changes a param and nothing else) (all errors). `vector-unknown-name` runs only for a
static `vectors` object, whose names are statically knowable; for the function form
`vector-control-not-in-vectors` asks the answerable question instead, by calling the
function with a sentinel — the same complementary split `heightfield-unknown-image`
and `image-control-not-in-images` use.
`vector-size-missing` and `vector-unknown-shape` need `vectorDocs` (above) to
read the file's `units`/`shapes` — without it, both stay silent rather than
fire on every correct millimetre file or guess at shape names. All three call
rules judge the argument values the probe resolves under the part's default params, the
same basis `import-unknown-name` uses; a call that only goes wrong for
non-default params still fails correctly at build time.

A rule that itself throws yields an `internal-rule-error` **warning** and the run
continues: `lintPart` never throws and never blocks a part because of a linter bug.

### The diagnostics contract (for agents)

`partforge measure <part> --json` / `--out <file>` emits the machine-readable
report. Every `fail`/`warn` check in `verify.failures` / `verify.warnings`
carries:

- `hint` — one self-contained corrective sentence (always present),
- `pattern` — a stable [ERROR-PATTERNS.md](ERROR-PATTERNS.md) entry ID when one
  applies (follow it with `ERROR-PATTERNS.md#<id>`),
- `note` — an optional caveat about *how* the value was measured, or a companion
  reading, attached whatever the verdict. `minWall` sets one when the reading came
  from a sample rather than every triangle (see below); `overhangArea` sets one
  naming the steepest unsupported face's angle,
- `location` — `[x, y, z]` in mm where the metric has one: `minWall` (thinnest
  sample point), `overhangArea` (the largest unsupported face's centroid) and
  `overlaps` (the center of the first offending intersection's
  *bounding box* — a nearby indicator, not an exact point: when a pair overlaps in
  more than one place the bbox center can fall in the empty space between regions)
  and the pair checks `contact` / `clearance` / `nearMiss` (the midpoint between
  the pair's closest surface points). Whole-solid metrics (bbox, volume, …) have
  none.

Subpart facts include `minWall` (number or `null` — null exactly when no reading
exists, e.g. the OCCT backend or min-wall measurement turned off, matching
`minWallAt`'s null) and `minWallAt` (`[x,y,z]` or `null`). Min wall casts one ray
per triangle, which is unbounded work on a dense mesh, so past a sample budget
it casts from a spread, deterministic subset instead — `minWallSampled` (boolean)
and `minWallSamples` (`{ sampled, total }` or `null`) say whether that happened.
A part that opted into the overhang check (see the `verify` block) also carries
`overhangArea` (mm² of unsupported downward-facing surface, `null` when not
checked or on an `exportable: false` sub-part), `overhangAngle` (the steepest such
face, degrees from vertical) and `overhangAt` (that face's centroid); the report's
`measuredOverhang` stamps the angle the pass ran against, or `null`.
A sub-part that declares `wall` (see the `verify` section below) also carries
`wall` — `{ value, location, band, members }` or `null`: the declared band's
worst member, located, with the band it was measured against and how many rays
fell inside it. `null` unless the sub-part declares `wall` *and* min wall was
measured for this run — the same "declared but not measured" gap `minWall`
itself has.
**The budget depends on whether the reading is checked against anything**: a part
that declares a min-wall gate — a `verify.process` profile, or an `expect`
mentioning `minWall` or `wall` — gets 50,000, because a gate's verdict rides on
it; a part that declares neither gets 5,000, because there the number is a
diagnostic for a reader rather than an assertion. Declaring the gate is what
buys the resolution.
`sampled` is how many triangles the walk *selected*, not how many rays were
cast: a degenerate (zero-area) triangle has no normal to cast along and is
skipped. A sampled reading is an **upper bound**: it can miss a thin spot, never
invent one — and a sampled run that found no wall at all still reports its
`minWallSamples`, so a null `minWall` there is "we looked and found nothing",
not "nobody looked". Everything in `src/parts/` is far below the budget and
reads exactly. The report's top-level `measuredMinWall` says whether this run
cast min-wall rays at all — the difference between a null `minWall` that means
"no wall found" and one that means "not measured".
Overlap entries are
`{ a, b, volume, location }`. Pair-distance facts are `gaps` (every sub-part
pair: `{ a, b, distance, at }`, distance 0 = touching or overlapping) and
`nearMisses` (the pairs with an unintended-looking gap under 0.5 mm).
`measuredGaps` is the companion to `measuredMinWall` for that pass, and `gaps` is
**absent** rather than empty when it did not run — an empty table means "measured,
and these pairs have no distance", which a declared `clearance` gate fails on.

### Quick checks

An editor may ask for a **quick** check, which skips both ray-casting passes — min
wall and pair distances — and keeps everything derived from the build itself:
triangles, bbox, volume, genus, watertight, the assembly overlap check, and lint.
On a 460k-triangle assembly that is roughly 6.8 s down to 0.9 s.

Gates still run on a quick check wherever the facts allow it, so a violated `bbox`
or `holes` expectation still fails. What a quick check will **never** do is return a
pass: any gate it could not evaluate is listed in `verify.unevaluated`, and one such
gate makes `verify.ok` **`null`** rather than `true`. So `ok` is tri-state — `false`
(something failed), `null` (nothing failed, but something went unchecked), `true`
(everything declared was checked and passed) — and code that treats a truthy `ok` as
"passed" stays correct without changing. Run a full check before trusting a part.

A **thrown** error (bad part module, kernel failure) with `--json` prints pure
JSON to stdout and exits 1:

```json
{ "ok": false, "error": { "message": "…", "pattern": "<id>", "hint": "…" } }
```

`pattern`/`hint` appear when the message matches an ERROR-PATTERNS.md symptom
string. Exit codes: 0 pass, 1 gate failure or crash — unchanged. `measure`'s
automatic lint pass (see "Linting" above) now catches most of the defects that
used to surface this way statically, before the kernel boots, so they fail with
pure JSON up front instead. The caveat narrows but doesn't disappear: lint
resolves `verify.expect` once against the part's *defaults*, while `verify()`
itself expands every `verify.cases` entry and re-resolves `expect(p, d)` per
case — so an expectation that only names a bad metric/subpart for a non-default
case (see `test/fixtures/unknown-metric-in-case-part.js`) still passes lint
clean and then throws at runtime, after measure output has printed. That throw
appends crash JSON after the human lines, so stdout is no longer pure JSON;
prefer `--out` (or parse the trailing JSON object — the crash JSON is
pretty-printed across multiple lines) for robust machine parsing. With `--out`
the measure report is written to the file as soon as `measure` succeeds, so
even if a later `verify` throw crashes the run the file is there — it just
lacks the `verify` key.

**Fresh-evidence rule.** A passing report is evidence only for the source, parameters,
view, backend, and framework version that produced it. Any relevant edit makes the old
result stale. Before reporting a part complete, run `measure` / `verify` again on the
current source and inspect current renders where visual requirements remain. Do not cite
a command that ran before the last geometry or expectation change as evidence.

**Part-authored hints.** Any `verify.expect` metric accepts `{ expr, hint }` in
place of a bare expression — use it to name the governing parameter:

```js
verify: {
  expect: {
    body: { minWall: { expr: ">=1.2", hint: "increase `wallThickness` or reduce `twist`" } },
  },
}
```

---

## Self-verification (the `verify` block)

A part can declare how it should be checked, co-located with its schema, so
`partforge measure` (and vitest) can enforce selected **geometric**, **assembly**, and
**DFM** properties. Add an optional top-level `verify` block:

```js
verify: {
  process: "fdm-pla",            // a DFM profile: fdm-pla | fdm-petg | resin, or an
                                  // inline { bed:[x,y,z], minWall, clearance, overhang } object
  orientation: "print",          // optional; ONLY with this is overhang checked — it says the
                                  // part is laid out for its bed (Z up, bed at the lowest Z)
  cases: ["defaults", "M3"],     // optional; default = defaults + every preset
  expect: {                      // design intent, by sub-part name (+ "_view")
    spacer: { holes: 1, bbox: "<=[60,60,60]", volume: "0.4..0.6cm3" },
    _view:  { overlaps: 0,
              contacts:  [["drum", "flange"]],       // these pairs must touch
              clearance: { "lid×body": ">=0.3" } },  // intended free fits
  },
}
```

**What the profile gives you:** a hard **bed-fit** gate (the view bbox must fit `bed`),
a **min-wall** warning, and — only for a part that also declares
`orientation: "print"` — an **overhang** warning: `overhangArea` is the mm² of
downward-facing surface steeper than the profile's `overhang` angle (45° from vertical
on the FDM profiles; resin carries none, since it prints on supports), measured per
sub-part with the bed at that sub-part's own lowest Z, and warned past 1 mm². The
opt-in is deliberate: a profile says what a process can print, the orientation key
says this part is laid out for it, and a part still being shaped, or one bound for a
different process, should not be nagged about its underside. Writing your own
`overhangArea` expectation is the other way in — it arms the measurement by itself,
against the profile's angle or 45° when the profile names none, so a declared
expectation is never answered "unavailable". Two bands next to the bed are never
counted: the footprint itself, and faces whose centroid sits within 1 mm of the bed
(the lower curl of a bottom-edge fillet or chamfer, which prints fine). A bridge (a
flat underside spanning two supports) and the ceiling of a horizontal bore are
reported as overhangs — the mesh alone cannot tell a bridge from a ceiling — which
is why this is a warning and never a gate. Two more limits, stated: it is judged in
the DISPLAY pose, so a sub-part whose `place` differs for export (a lid that prints
flat beside its base) is measured as displayed, and `exportable: false` sub-parts
are skipped. Switch it off under an FDM profile with an inline
`{ base: "fdm-pla", overhang: null }`. **What `expect` gives you:** per-sub-part
assertions on the facts `measure` already reports — `holes` (through-bores / genus),
`volume`, `surfaceArea`, `triangleCount`, `bbox`, `watertight`, `minWall`,
`overhangArea`, `wall` (a range — see below), `boundsMin` / `boundsMax`
(the axis-aligned `{min,max}` corner positions — where the geometry sits, vs
`bbox` which is only its size) and `centerOfMass` (`[x,y,z]`, the volume-weighted
centroid; `null` for a degenerate/zero-volume sub-part); and `_view` assertions `bbox`,
`volume`, `overlaps`, `centerOfMass`, `boundsMin`, `boundsMax`, plus the pair-wise
`contacts` / `clearance` below.

Passing these checks does **not** prove structural strength, fatigue life, stability,
manufacturing tolerance stack-up, regulatory compliance, or safe real-world use.
Load-bearing or safety-relevant parts need appropriate analytical/simulation evidence
(for example FEA with declared materials, loads, supports, and safety factors) plus
qualified human review. If no such evidence exists, say that physical performance is
unverified.

**Assertion DSL:** a bare number means equality (`holes: 1`); `">=n"`, `"<=n"`, `">n"`,
`"<n"`, or a range `"a..b"`; an optional unit suffix `mm`/`cm`/`mm3`/`cm3`; and for
`bbox`, `centerOfMass`, `boundsMin`, `boundsMax`, a componentwise vector `"<=[x,y,z]"` /
`">=[x,y,z]"` where `*` skips an axis. The parser is strict — a malformed assertion
fails loudly.

**A part whose typeface is a parameter needs band assertions, not points.** Glyph
advance widths differ by family, so a `text2d` sub-part's `bbox`/`volume` shifts with
the picked face even when every other param is unchanged. Write `verify` bounds wide
enough to hold across the fonts your `allow` list admits (a range, or `<=`/`>=`,
rather than exact equality). `verify` runs against `defaults`, which is stable — the
nameplate ships `face: ""` (the bundled Roboto), so its own `verify` cases don't
need this, but a part whose default already names a specific face does.

```js
verify: { expect: {
  stand: { boundsMin: ">=[0,0,0]", centerOfMass: "<=[*,*,25]" },   // sits in +octant, mass kept low
  _view: { boundsMax: "<=[220,220,250]" },                          // whole assembly fits the bed
} }
```

**Gates vs. warnings:** exact facts are **gates** (a failure sets a non-zero exit code);
`minWall` is computed (a ray/shot wall-thickness measurement) and reported as a
**warning** — it flags walls below the profile's minimum but never fails the build —
and so is `overhangArea` (see above). `holes`/`watertight` are Manifold-only, so those
assertions **skip** on OCCT parts rather than fail.

**A wall that must stay one thickness: `wall`.** `minWall` answers "is anything too
thin"; `wall` answers "does this wall stay what I declared" — the question a bend, a
fillet or an offset silently breaks. Declare it as a range in mm, per sub-part:

```js
verify: { expect: { tray: { wall: "1.8..2.2" } } }
```

It rides the same inward rays as `minWall`. A ray reading inside `[0.75 × min,
1.5 × max]` counts as this wall (a 1.2 mm floor under a 2 mm wall is another
feature and is ignored) — but the window discriminates by **thickness alone, not
intent**: anything else on that sub-part whose thickness falls in the window is
counted too, so declare `wall` on a sub-part that is mostly this one wall; a rib
or boss inside the window reads as a deviation, and a part that needs two
thicknesses declares two sub-parts. The check reports the member farthest from
the band — or, when every member is inside it, the one farthest from its
midpoint — with its location, and warns when it lies outside — `wall 2.62 out of
1.8..2.2 at (22.8, -2.0, 15.1)` is a bend whose outer arc is not concentric with
its inner one. Range form only (lint refuses `"<=2"`), a warning like `minWall`
because it is a sampled reading.

**A verify block that declares nothing verifies nothing.** `verify.ok` is tri-state:
`true` when every declared check passed, `false` on any gate failure, and `null` when
no verdict can be given — a quick lap that could not measure a gate, or a part with
**no declared expectations** at all (no `verify` block, an empty `expect`, no profile).
That last case used to read as `ok: true` with zero checks, which every reader took as
"verified". It now comes back `ok: null` with `evaluated: 0` and a `no expectations
declared` warning whose hint says what to pin; the CLI runs verify on every part, block
or no block, prints *nothing verified* and exits 0 (a withheld verdict is not a
failure). The same `null` covers a part that declared checks none of which could be
answered — every one SKIPPED (a `ref*` metric on a sub-part with no `reference`,
`holes` on the OCCT backend, a pair on a disabled sub-part) — with a `no expectation
could be evaluated` warning instead; `declared` and `evaluated` on the report tell
the two apart. A single answerable expectation — or a process profile, which brings
the bed-fit gate — is enough for a verdict. Treat `null` as "not verified", never as
a pass.

**Per-case expectations.** Checks run across defaults **and every preset**, so a
static `expect` breaks the moment a preset legitimately changes an asserted fact —
a "cup" preset that turns the drainage hole off flips the genus from 1 to 0.
For that, declare `expect` as a **pure function of the case's resolved params**,
`(p, d) => ({ … })` (same `p`/`d` your `build` sees, `d` from `derive`):

```js
verify: {
  process: "fdm-pla",
  expect: (p) => ({
    planter: { holes: p.drain > 0 ? 1 : 0, bbox: "<=[220,220,250]" },
    _view: { overlaps: 0 },
  }),
}
```

`src/parts/planter.js` is the worked example — its "Pen cup" and "Vase" presets
disable the drain, so the hole count is pinned per case. Keep the function pure
(no clock/randomness), like every other part function.

**Contacts & clearance (near-miss gaps).** Volume, bbox, and render checks all miss
sub-parts that *almost* touch — a flange floating 0.3 mm off its drum body passes
every one of them. `measure` therefore reports `nearMisses` (pairs with a
surface-to-surface gap under 0.5 mm), and `_view` accepts two pair-wise gates:

- `contacts: [["drum", "flange"]]` — each listed pair must touch. The gate fails
  with the measured gap and the closest-point location when the surfaces don't
  meet. Interpenetration counts as contact — the separate `overlaps` gate owns
  *excessive* interpenetration. A pair naming an `enabled()`-gated sub-part
  **skips** in cases where that sub-part is off; a name that exists nowhere in
  the part still throws.
- `clearance: { "lid×body": ">=0.3" }` — an intended free fit. Keys are `"a×b"`
  (order doesn't matter); values take the same assertion DSL as any metric (and
  the `{ expr, hint }` form), evaluated against the pair's minimum surface
  distance in mm.

Any pair *not* declared either way that sits closer than 0.5 mm becomes a
**warning** — the "did you mean these to touch?" signal. Declare the pair to
silence it. Distances are measured mesh-to-mesh (exact triangle distance, so it
works on both backends with no kernel booleans); contact tolerates ~1 µm, so a
tessellation-limited curved contact (e.g. equal-radius cylinder-in-bore built with
different facet counts) may read a few hundredths of a millimetre — prefer a tight
`clearance` bound like `"<=0.05"` over `contacts` for those. One OCCT caveat: with
no overlap detection there (`Solid.intersect` is Manifold-only), a sub-part
*fully contained* inside another reads as its surface-to-surface distance, so it
can surface as a near miss — check containment cases on Manifold.

**Running it:**

```bash
npx partforge measure src/parts/<part>.js          # auto-runs verify if a block exists
npx partforge measure src/parts/<part>.js --process resin   # force/override a profile
npx partforge measure src/parts/<part>.js --no-verify       # facts only
```

…and in vitest:

```js
import { verify } from "partforge/testing";
test("part is printable and correct", () => {
  expect(verify(kernel, part).ok).toBe(true);
});
```

Checks run across the **default config plus every preset** (or your `cases` list); a
preset that changes only parameters no on-screen sub-part reads is deduplicated, so
coverage is cheap.

When an agent authors both geometry and `verify`, the check is useful feedback but not
an independent oracle. Preserve externally supplied acceptance claims verbatim (ideally
with stable IDs in the surrounding specification), and test boundary/tolerance cases in
addition to friendly defaults and presets. A repair should change the design, not relax
the requirement that exposed the failure.

---

## Fillet, chamfer & shell

Two backends build your part: **Manifold** (fast meshes — preview, STL, 3MF) and
**OCCT/replicad** (exact B-rep — STEP). Most parts run on Manifold — and since
contract v3 that **includes fillet and chamfer**: the mesh backend blends straight
edges, circular-arc edges (bore rims, cylinder rims, the arcs where fillets meet a
face), and **planar contour edges at constant dihedral** — the top/bottom rims of any
extruded profile, however curvy its outline: `text2d` lettering, `Shape2D.offset`
outlines, spline profiles all round natively now. Only `shell` still routes a
sub-part to OCCT up front; a fillet/chamfer on an edge class the mesh backend can't
blend (helical edges, varying dihedral) reroutes that sub-part to OCCT automatically
at runtime — no declaration needed either way:

| Op | Meaning |
|---|---|
| `s.fillet(radius)` · `s.fillet({ r, edges? })` | round edges (curve-following, exact); the bare-number scalar shorthand fillets **all** edges, the options form adds a selector |
| `s.chamfer(distance)` · `s.chamfer({ d, edges? })` | bevel edges; same scalar-shorthand-or-options-with-selector shape as `fillet` |
| `s.shell({ t, open })` | hollow inward, wall = `t`; `open` selector (`{inPlane,at}`/`{dir}`/`{near}`) chooses which face(s) to open. Closed (no-open-face) hollows are not supported. |

`edges` (fillet/chamfer) / `open` (shell) chooses which edges/faces (omit `edges` for **all** edges — `shell` always requires `open`):

- `{ dir: "X"｜"Y"｜"Z" }` — edges running along an axis (e.g. `{dir:"Z"}` = the vertical edges)
- `{ inPlane: "XY"｜"XZ"｜"YZ", at }` — edges lying in a plane (e.g. base edges: `{inPlane:"XY", at:0}`)
- `{ near: [x,y,z] }` — edges passing through a point
- a raw `(edgeFinder) => edgeFinder` replicad finder, for anything fancier — **OCCT-only
  escape hatch**: it forces the sub-part onto OCCT (the mesh backend reroutes on
  sight of it) and is non-portable — parts meant to travel must use the object forms
  (see `KERNEL-CONTRACT.md`)

```js
let s = k.box({ min: [0, 0, 0], max: [40, 30, 16] });
s = s.fillet({ r: 3, edges: { dir: "Z" } });            // round the 4 vertical edges
s = s.chamfer({ d: 1, edges: { inPlane: "XY", at: 0 } }); // bevel the base
```

See `src/parts/filleted-box.js` for the worked example.

**Automatic backend selection.** Before building, the framework runs a geometry-free *probe*
of your `build`; a `shell` call **on a Solid** routes that sub-part to OCCT up front, and
everything else — fillet and chamfer included — stays on fast Manifold. The probe tracks
which handle kind each op ran on, so `Shape2D.fillet`/`.chamfer` (the shared,
backend-identical 2-D implementations — see "Editing profiles") never look like Solid
ops. Force the backend with `meta.backend: "occt" | "manifold"` if you ever need to.
STEP export always builds on OCCT, so a filleted part gets exact B-rep blends in its
STEP even though it previews (and STL/3MF-exports) from the mesh blend — the two agree
to within tessellation on the supported edge classes, with one visible exception:
orthogonal box-style corners where three filleted edges meet get a true sphere-octant
cap, and a planar rim's own corners blend by turn direction (salient corners steer
the band around a small arc; reflex/inside corners round into an arc of the blend
radius about the vertex — the rolling-ball pivot), but other blend junctions are
mitred on the mesh where OCCT builds a vertex blend.

If the mesh backend hits an edge class it can't blend, it signals `NEEDS_OCCT` and the
framework reroutes **just that sub-part** to OCCT for those exact parameters —
dialing the parameter away re-tries Manifold automatically. A zero magnitude —
`fillet(0)`, `chamfer({ d: 0 })` — is the **identity** on both backends (see
KERNEL-CONTRACT.md), so an unguarded `s.fillet(p.r)` needs no `if (p.r > 0)` wrapper.
(`shell` is the exception: `t: 0` is degenerate, not identity, so a shell call always
routes to OCCT.)

**Clamp your radii.** The mesh fillet does **not** validate feasibility — an oversized
radius self-intersects its cutters and yields a wrong shape rather than a skipped
feature (OCCT skips instead). Clamp magnitudes against local geometry the way
`filleted-box.js` does: `Math.min(p.fillet, halfWidth - 0.5, p.h - 0.5)`.

**A defeated fillet/chamfer skips, and the build reports it.** On both backends a
fillet or chamfer the geometry defeats does **not** fail the build: the op returns its
input solid unchanged (edges left sharp) and the build result carries a feature-skip
warning naming the op, its magnitude, and the reason. The same channel carries every
other degrade — an `extrude` rim bevel reduced or left square, a `roundedBox` rim
clamped to `round.side`, a `Shape2D` corner rounded smaller than asked — so the part on screen is real,
minus that one feature, with everything downstream of it still applied. When a build
answer includes such a warning, treat it as a failed feature, not a success: say so,
and either adjust the geometry/radius and retry or leave the feature off deliberately.
Do not conclude a fillet landed just because the build succeeded.

**Preview routing is per sub-part.** Each sub-part is probed and routed independently, and
a mixed part's regen fans out to both workers in parallel — a shelled body pays for OCCT
while a plain lid rebuilds at Manifold speed beside it. Two scopes
still route whole-part (the max over the sub-parts): **exports** (one STL/STEP/3MF job
builds everything in one worker) and the **CLI** (a single Node process boots exactly one
kernel; on a mesh-side `NEEDS_OCCT` it re-runs itself once with the backend pinned to
OCCT). Within one sub-part's build there is no per-op backend mixing.

**Shading intent.** The kernel decides what shades smooth and where edge lines
draw — spheres, cylinders and fillets are smooth by construction; boolean cut
seams always shade hard and draw a line; a point-ring loft's facets shade flat
when its rings have fewer than 32 sides. A curve or resample loft shades by
**tessellation provenance**: only wall sections that came from a smoothly
tessellated contour span (an arc/Bézier run) shade smooth, sharp contour
corners and silhouette-kink rings (an abrupt direction change up the stack,
like a belly break) flat-shade and draw a dividing line, and a morph's snapped
corners do the same. `shading: "smooth"|"faceted"` on `k.loft` overrides all of
this either way. If your part previews smooth but would print faceted — or the
reverse — set the hint rather than changing facet counts.

> `partforge measure` reports `watertight`/`holes` as `n/a` for OCCT-run parts
> (Manifold-only topology); `render` works on both. Filleted parts now measure on
> Manifold with full topology.

### `roundAll(r)` — round everything at once

`s.roundAll(2)` (or `s.roundAll({ r: 2 })`) rounds **every** edge of the solid
— convex and concave — with radius ≈ 2 mm in one pass, on both backends, with
no OCCT routing. Faces stay in place (within backend tolerance). It is the
blunt, global counterpart to `fillet`/`chamfer`: there is no edge selection,
and features smaller than the ball are **consumed** — walls thinner than `2r`
melt away, holes narrower than `2r` seal shut. That makes it ideal for
"soften this whole organic part" and wrong for parts where a specific edge
must stay sharp (use `fillet` with a selector for that).

**Cost note.** On a Z-aligned extrusion (constant cross-section — a plate, a
text backing, any straight-sided prism) roundAll takes a fast path: the ball
morphology is computed as a 2-D close-open of the cross-section plus rim
fillets, so even a complex text-outline backing rounds in well under a second.
Everything else pays the full morphology (three Minkowski passes), whose
runtime grows steeply with triangle count — a rotated or lofted solid of a few
thousand triangles can take tens of seconds. When only a specific edge needs
rounding, `fillet` with a selector (e.g. `{ inPlane: "XY", at: h }` for a rim)
says what you mean and is always the cheap, predictable choice; reach for
roundAll when the design genuinely calls for every edge softened at once. At
the fast path's corners the plan silhouette follows the rim fillet's corner
rounding (radius ≈ 1.05–1.25·r rather than exactly r) — the same corner
treatment fillet itself applies.

Rules of thumb:

- Keep `r` under half your thinnest wall unless you *want* melting.
- Preview and STL/3MF export always work (mesh morphology). STEP export gets
  true B-rep arc surfaces while `r` is below the smallest feature size; at
  consuming radii OCCT cannot represent the melt and **skips the op whole**
  with a `roundall-skipped` warning — the STEP then has the un-rounded shape.
- Relying on consumption? Add a `verify` volume assertion so a regression in
  the radius (or a backend skip) fails loudly.
- A small ridge remaining where a thin rib was consumed is correct morphology
  (the rib's dilation fillet survives the opening), not a bug.

### Cost on the OCCT path: fillet/chamfer scale with edge count — and order matters

These costs apply when a sub-part **does** run on OCCT (a shell, an unsupported edge
class, a pinned backend, or STEP export). OCCT fillet/chamfer cost is **per selected
edge**, on top of the OCCT boolean tax. Two habits keep it tolerable:

- **Fillet/chamfer as early as possible, on the simplest solid.** A fillet on a bare
  primitive is ~15× cheaper than the same fillet after a dozen boolean cuts have
  multiplied the face count — and because the solid cache keys each op by its input's
  content hash, an early fillet is a cache **hit** when a downstream parameter changes,
  while a fillet-last build re-pays the whole op on every slider step of every parameter.
- **Never point a rim selector at a many-point extruded profile.** `edges: {inPlane}` on
  a gear-like extrusion selects *every* polygon edge (hundreds); one chamfer call then
  costs seconds — and if the distance doesn't fit the tooth lands, the failure-rescue
  bisection re-runs it ~8× (`ERROR-PATTERNS.md#chamfer-rescue-bisection`). Use the loft
  bevel below instead.

### Beveling profile rims: extrude's bevel option

For an **extruded profile** (gear, star, bracket outline — any `k.extrude` of a polygon),
a top/bottom rim bevel doesn't need `chamfer` at all — it's built into `extrude`:

```js
k.extrude({ profile: prof, h: 5, bevel: 0.6 });                 // 45° bevel, both rims
k.extrude({ profile: prof, h: 5, bevel: { top: 0.6 } });        // one rim only
```

Same 45° bevel a rim `chamfer` would cut, but it desugars into extrude + loft +
intersect at the shared kernel front, so the part **stays on the fast Manifold
backend** (no CAD-only op for the probe to find) and costs one boolean regardless of
profile point count. Measured on a 24-tooth involute gear: ~0.1 s on Manifold vs
~40 s for the equivalent OCCT `chamfer` (576-edge rim × the rescue bisection).

Every profile form works: point arrays, arc profiles, `{outer, holes}` regions
(hole rims flare outward — the opening is larger at the face, as a chamfer would
cut it), and `Shape2D` (multi-region shapes bevel each region and union). One
fidelity caveat: curved profiles are **materialized to point rings** first — the
loft envelope needs matched points — so a beveled extrusion is faceted at the
sampling LOD even in STEP export. Arc contours sample at a fixed LOD identically
on both backends; a `Shape2D` materializes at its own backend's LOD. If you need
arc-exact STEP walls, that's the one case native `chamfer` still buys you (at
its OCCT cost).

Rules (throws otherwise — `ERROR-PATTERNS.md#extrude-bevel-invalid`): no
`twist`/`scaleTop`, and `bottom + top < h` — clamp from your height parameter, e.g.
`bevel: Math.min(p.chamfer, p.thickness / 2 - 0.2)`. A bevel that would pinch a
narrow feature shut (a gear's tooth land) is deterministically reduced to the
largest offset the rim can take, with a console warning
(`ERROR-PATTERNS.md#extrude-bevel-reduced`).

Under the hood it insets the profile with `offsetPolygon(prof, -c, { corners:
"sharp" })` and intersects with a loft envelope extended past both faces (so the
envelope's own end caps never coincide with the extrusion's faces — coincident caps
leave sliver-triangle shading artifacts). The same construction works by hand when
you need a variant the option doesn't cover. This bevels a **whole rim**; for
selective edges on a solid that's already OCCT-routed, plain `chamfer` with a tight
selector is still the right tool.

---

## Conventions & gotchas

When something fails confusingly, **grep [ERROR-PATTERNS.md](ERROR-PATTERNS.md) for the
symptom first** — it maps error text → cause → fix. The invariants, one line each:

- **replicad (OCCT) transforms consume their input** — never reuse a transformed solid;
  `.clone()` first ([replicad-consumed-operand](ERROR-PATTERNS.md#replicad-consumed-operand)).
- **Part modules are DOM-free and side-effect-free** — they load in both the main thread
  and the worker ([worker-imports-main-entry](ERROR-PATTERNS.md#worker-imports-main-entry)).
- **`build` is a pure function of `(k, p, d)`** — impurity silently defeats the geometry
  cache ([impure-build-stale-preview](ERROR-PATTERNS.md#impure-build-stale-preview)).
- **Units are millimetres** throughout.
- **Never sample an arc into points by hand.** A `Math.cos` loop hides the sweep direction
  in a sign, and a wrong sign produces a self-crossing outline that builds with inverted
  fill and no error — only a `profile-self-intersects` warning
  ([profile-self-intersects](ERROR-PATTERNS.md#profile-self-intersects)). Build curved
  outlines with `pathProfile().arcTo(to, via)`, `roundedProfile`, `filletPolygon`,
  `slotPolygon`, `ringSectorPolygon` and `circleProfile`; mirror a symmetric half with
  `mirrorProfile`.
- **Preview vs print quality:** Manifold bakes segment counts in at primitive creation,
  so builds are quality-agnostic; the export path uses a separate "print" kernel. Preview
  facets every circle at 116 segments. Print sizes each circle by chord tolerance — the
  fewest segments that keep the facet sagitta under 0.01 mm — never fewer than the
  preview's 116 and never more than 480, so a small feature exports at exactly the density
  you previewed and only circles wider than about 54 mm get finer. A part that previews
  is a part that exports: the old flat 480 turned a 0.75 mm rivet into 115,200 triangles
  and a body with a few hundred of them into an out-of-memory trap at export
  ([export-kernel-out-of-memory](ERROR-PATTERNS.md#export-kernel-out-of-memory)).
  **Doubly-curved surfaces are the exception on both tiers:** a sphere, a lathe's
  profile arcs (`torus`, `roundedCylinder`, a `revolve` of your own rounded `Shape2D`)
  and a `roundedBox`'s corners all spend the segment count squared (6,728 triangles
  for any sphere at 116; 27,000 for a tiny O-ring), so they are sized by chord
  tolerance — 0.02 mm at preview, never fewer than 24 segments per circle (a rivet
  sphere is 288 triangles, an O-ring ~6,000) and never more than the flat count, so
  only features under about 60 mm radius get coarser and none get finer. That is what
  keeps a body studded with a few hundred rivets inside a phone's memory
  ([preview-build-too-heavy-for-phones](ERROR-PATTERNS.md#preview-build-too-heavy-for-phones)).
  Two consequences to know: a lathe's sweep still runs at the flat count, so a small
  rounded cylinder is cheaper as `roundedCylinder` than as a revolve you densify by
  hand; and a tolerance-sized surface measures slightly smaller than the exact one
  (about 0.8% on a 3 mm rounded feature), so give a `verify` volume gate on small
  rounded parts that much slack. Spheres and rounded features are still the costliest
  way to add small detail — a domed rivet is 288 triangles where a short cylinder is
  232 and a box is 12, and every one is a boolean operand — so prefer instancing one
  union of a row over a chain of per-feature booleans, and drop counts the print
  cannot show.
- **Display placement is view-independent**; only `place(..., { purpose: "export" })` may
  depend on `view` ([view-dependent-display-place](ERROR-PATTERNS.md#view-dependent-display-place)).
- **Keep geometry backend-agnostic** (kernel calls only); only STEP requires OCCT
  ([probe-routed-to-occt](ERROR-PATTERNS.md#probe-routed-to-occt),
  [occt-holes-watertight-na](ERROR-PATTERNS.md#occt-holes-watertight-na)).
- **Never let two cut tools share an exactly coincident face** — a bore whose radius
  equals a thread's root radius, a cut ending flush with a face. Give them 0.05-0.1 mm
  of deliberate clearance, or overshoot the cut. Mesh CSG shrugs; OCCT's boolean
  degenerates, so the part previews instantly and the STEP export runs for minutes
  ([boolean-coincident-faces-hang](ERROR-PATTERNS.md#boolean-coincident-faces-hang)).
  The exact kernel refuses the common form up front — an `exactly-touching surfaces`
  build error names the shared radius and this fix menu.
  For the case that causes this most often — a tapped hole — reach for
  `k.tappedBore`, which owns the bore and the thread together and cannot land them
  on the same face.
- **A boolean that comes back geometrically impossible is a build error, not a
  part.** Every `cut`/`cutAll`/`intersect`/`union` result is judged by volume against
  its operands on both backends: a union smaller than an input, a cut that grew, a
  negative volume, or the exact kernel's silent "returned one operand instead of the
  union" all throw `boolean result invalid: …` with the fix menu above instead of
  shipping a wrong preview or STEP file
  ([boolean-dropped-operand](ERROR-PATTERNS.md#boolean-dropped-operand),
  [boolean-impossible-result](ERROR-PATTERNS.md#boolean-impossible-result)). A
  legitimately degenerate design — a hole wider than its plate — is not impossible and
  builds as before; `verify` is what catches that.

---

## Interactive clarification: request-a-pick

An external tool (e.g. an AI agent editing your part) can ask the *user* to click
geometry and receive the `Selection` back, closing the loop in the other direction
from `?pick`.

- Serve your app with **`?pickserver&picktoken=<token>`** (or
  `?pickserver=http://127.0.0.1:4518&picktoken=<token>`) to enable it. While idle
  nothing changes; when the local pick-server requests a click, a banner appears
  ("🤖 Claude needs you to click …") and the picker arms for one click.
- The agent side runs `partforge pick-serve` once — it prints the token and the exact
  URL to open — then `partforge pick "<prompt>" …` for one or more clicks (collected in
  order, returned together). The CLI blocks until the user clicks, then prints the
  `Selection`(s) as JSON.
- **The token is required.** Every route on the pick-server (including the SSE stream)
  is gated by a random per-process token, requests from non-loopback origins are
  refused, and the server never reflects an arbitrary `Origin`. Without that, any site
  the user browsed to while the server was running could read the agent's prompts,
  inject text into the agent's output, or harvest the user's live parameter values.
  A `?pickserver=` pointing anywhere but loopback is ignored with a console warning.
  `partforge pick` finds the token automatically via `~/.partforge/pick-<port>.token`;
  `--token` and `PARTFORGE_PICK_TOKEN` override it.

See the bundled skill `skills/partforge/SKILL.md` for the agent workflow. This is plain
click-routing — no LLM logic lives in partforge.
