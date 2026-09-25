# partforge

**AI-built parametric CAD for 3D printing.** Describe a part to an AI agent and get a
*forge* — a self-contained web app for that one part: a 3-D viewer, a control panel with
just the parameters that matter, and STL / STEP / 3MF export. Share the forge and anyone
can dial in their own version and print it.

A forge isn't a frozen STL. It's open-source code that renders and regenerates the model
live, so the part stays **editable** — resize it for a different bearing, screw, or motor
without relearning a heavy CAD tool — and anyone (or their own agent) can read the source
and extend it.

partforge is the engine behind the forge: a small npm framework that an LLM tuned for tool
use can drive to author, test, and measure a part, then ship it as a browser app.

## See it

- **Live showcase** — https://pixiteapps.github.io/partforge/ — example forges (Faceted
  Planter, Spacer, Filleted Box) you can open, adjust, and export.
- **A real forge** — https://scottsykora.github.io/Drum-Machine/ — a parametric capstan
  drum built with partforge for a robotics project.

## Build your own forge

You don't write CAD by hand. Point a tool-using AI agent (Claude Code, or the Claude /
ChatGPT desktop apps with file access) at this repo and describe what you want:

> Using the partforge framework at https://github.com/pixiteapps/partforge, build me a
> _\<your part\>_ — _\<the dimensions, fits, and features that matter\>_.

Expect a few turns. The first attempt is often rough, but you refine it in plain language
— "make the bore fit an M3", "add a 2 mm fillet", "thinner walls", "taller by 10" — until
the part is right. You end up with a forge you can host anywhere and hand to anyone.

## How it works

You — or an agent — write one **part definition**: geometry *build functions* plus a
*parameter schema*. partforge renders everything else: the 3-D viewer, the control panel,
the geometry workers, and the export buttons. Each control can carry a description, a
preset, or be hidden, so the interface stays simple while the part stays deeply adjustable.

Two geometry backends run in Web Workers, and partforge routes each part to whichever it
needs:

- **[Manifold](https://github.com/elalish/manifold)** — fast preview meshes and STL / 3MF,
  including mesh-native fillet and chamfer for straight and circular edges.
- **[Replicad](https://replicad.xyz)** (OpenCASCADE-in-WebAssembly) — exact B-rep for STEP,
  shell, and automatic fallback for blend geometry Manifold cannot handle.

The viewer is [three.js](https://threejs.org).

Because a part is just code, an agent can build it **and check its own work**: the
`partforge/testing` helpers measure volume and bounding box, probe geometry, detect
self-overlap between sub-parts, and render the model so a multimodal agent can *see* what
it made. A part can also declare a `verify` block — a manufacturing (DFM) profile plus
design-intent assertions — that flags problems like a too-thin wall or a part that won't
fit the print bed before anyone hits export.

> **Requires a Vite-based app.** partforge is published as plain ESM source and relies on
> Vite's worker / WASM / CSS import handling.

## Install

```bash
npm install partforge
```

## Use

```js
// app.js
import { mount } from "partforge";
import part from "./parts/my-part.js";
mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./part-worker.js", import.meta.url), { type: "module", name }),
});

// part-worker.js
import { runWorker } from "partforge/worker";
import part from "./parts/my-part.js";
runWorker(part);
```

Test your parts headlessly with `partforge/testing`
(`bootManifoldKernel`, `bootOcctKernel`, `assemblyOverlaps`, `measure`, `verify`, `meshVolume`, `bboxSize`).

**Smoke-test that an app actually boots** (real Chromium, real worker/WASM): `npm run check`
(or `node scripts/check-app.mjs <entry>.html`) — it loads the app and verifies the kernel
boots with no errors. Needs Playwright: `npm i -D playwright && npx playwright install chromium`.

### Embedding (0.12.0+)

`mount()` returns a runtime handle and accepts element references, so an
embedding app (React, iframe, multiple mounts) can size, await, and tear down
the viewer without global IDs:

```js
const runtime = mount(part, {
  createWorker,
  elements: {
    viewer, controls,                       // canvas host + param-panel host
    rail,                                   // full-height resizable/collapsible controls rail
    status: { status, busy, phase },        // status chrome
    tabs,                                   // view-tab segmented control
    exports: { stl, step, threeMf },        // export buttons
    chrome: { reframe, theme, railToggle }, // viewer buttons + rail collapse/restore
  },
  onBuild: ({ status, ms, error }) => {},   // per accepted build: "success" | "error"
  onPick: ({ selection, label, prompt, token }) => {}, // programmatic click-to-select
  pickHint: "Click to edit",                // hover-tooltip nudge while onPick is set (null = none)
});
await runtime.ready;   // first successful build (rejects on a first-build error)
runtime.setHostPane("rail");  // narrow layout only: show just the controls
                               // rail ('stage' | 'rail'), suppressing the
                               // built-in tab bar. null hands selection back.
runtime.setRailLayout({ mode: "dock", inset: 380, railHeight: 316 });
                               // where the rail SITS when the host draws chrome over
                               // the frame: docked into its bottom sheet (inset = the
                               // sheet's height, railHeight = the slice of it the rail
                               // may paint into), or { mode: "overlay" } for a
                               // right-edge drawer over a full-width stage. null (or
                               // any shape partforge can't read) restores partforge's
                               // own layout; resize and collapse are suspended while
                               // a layout is leased.
runtime.setActive(false);      // park the viewer: stop the render loop, release the
                               // drawing buffer. setActive(true) restores both.
runtime.attachTooltips([{ element: myButton }]);  // host chrome buttons join the mount's
                               // shared hover tooltip (label = the button's title or
                               // aria-label, or a per-entry getLabel()); returns
                               // { sync, hide, detach }, auto-detached on dispose()
const off = runtime.onContextLost(() => {});  // WebGL context loss; returns an unsubscribe
const carried = runtime.getViewerState();  // camera + projection + cutaway, as plain JSON
runtime.dispose();     // stops loops, workers, observers, listeners; frees GPU resources
mount(nextPart, { createWorker, elements, viewerState: carried });  // resumes the view
```

**Carry the view across a remount.** A host that applies edits by mounting a
new part — rather than by `setParams` — starts each mount from the part's
default framing, so the camera snaps back and the cutaway closes every time the
user changes anything. Snapshot with `runtime.getViewerState()` *before*
`dispose()` and hand the result to the next `mount()` as `viewerState`: the
part changes, the user's view of it does not.

Restore is best-effort per field, so a state that no longer fits is dropped
rather than fatal. The cut plane's world pose is restored exactly; its
on-screen size is re-derived from the new geometry, since that is a property of
the part rather than of the user's choice. Omit `viewerState` on a first mount
— the viewer then restores its own persisted camera, as it always has, in
perspective (the projection is automatic — orthographic only on a view cube
face view — so it is not persisted).

**Park the viewer when you hide it.** A host that hides the canvas with
`display: none` needs nothing — the container collapses and the ResizeObserver
shrinks the drawing buffer for free. A host that hides it any other way
(`visibility: hidden`, an inactive tab, an off-screen pane) gets no such signal:
the full-resolution MSAA buffer stays resident and the render loop keeps
redrawing an unchanging scene at 60fps that nobody can see (a part with an
`autoplay` animation running is the same story, just with something actually
moving off-screen). On a phone that is tens of megabytes plus continuous GPU
work, and it has been enough on its own to get a tab killed. Call
`runtime.setActive(false)` when the viewer goes off-screen and
`setActive(true)` when it comes back.

Parking releases both large GPU allocations — the drawing buffer and the cached
1024² capture target — and stops the render loop. Offscreen captures
(`captureCurrent`, `captureViews`) keep working while parked and framing is
unchanged, so a host can still take a build screenshot of a hidden viewer; the
first capture after parking just re-allocates its target.

Every `elements` entry defaults to the legacy global ID (`#app`, `#controls`,
`#panel` for `rail`, `#status`/`#busy`/`#phase`, `#part`,
`#download`/`#download-step`/`#download-3mf`,
`#reframe`/`#theme`/`#rail-toggle`), so a classic host page needs no changes.
The viewer sizes from its container via ResizeObserver — no window coupling.

`rail` is the full-height controls rail introduced by the resizable-panel
layout (`docs/superpowers/specs/2026-07-26-controls-rail-layout-design.md`);
`chrome.railToggle` is its optional collapse/restore button. Both are optional
— a host that lays out the framework itself (no rail markup) gets a no-op.
The rail's resize seam is positioned against `rail.parentElement` by default,
so **the rail must be a direct child of the positioned `.pf-shell`** unless
the host also supplies `elements.shell` to point at the real containing block
(e.g. when a wrapper div sits between them, as is common in a React layout).

`runtime.setParams(partial)` edits parameters programmatically — the entry point
for animating a part from host code:

```js
runtime.setParams({ openAngle: 45 });   // merges into the live params, syncs the panel
```

The partial is merged into the current params and the control panel updates to
match. Keys the part doesn't define are silently ignored. When every changed
parameter only moves geometry (a rotation or translation in `place()`), the
viewer re-poses the meshes it already has — instantly, with no worker rebuild;
`onBuild` does not fire for those pose-only edits. Anything that changes the
geometry itself rebuilds as usual.

When any view declares `animations`, `runtime.animation` exposes the viewer's
playback engine (`null` otherwise). Animations are **view-owned**
(`views.<name>.animations`), so the engine is scoped to the active view — call
`setView` first to reach another view's set:

```js
runtime.animation.play("open");   // switch + play, within the ACTIVE view (camera cue and all)
runtime.animation.seek(0.5);      // scrub, normalized 0..1 (pauses)
runtime.animation.pause();
runtime.animation.stop();         // reset + restore pre-animation params and clear opacity overrides
runtime.animation.state();        // { view, animation, status, t, stepIndex }
```

A view can mark at most one of its animations `autoplay: true` to start it
automatically on first show and again on every view switch — until the user
touches the transport — or anything writes params (`runtime.setParams`
included) or calls a `runtime.animation` method; any of those disarms
auto-start for the session. This replaces the old idle turntable as the
"something is moving" cue for a part-app; see the authoring guide for the
full contract.

`onPick` arms click-to-select permanently: `label` is the feature label (falling
back to the sub-part label/name) for compact UI, `prompt` is the LLM-ready
sentence, `token` the compact form, `selection` the raw object. When `onPick` is
set, the `?pick` / `?pickserver` URL modes are ignored (one click listener ever
live); hover labels stay always-on, and gain a `pickHint` line under the name
("Click to edit" by default; pass your own wording, or `null` for none). Hover
never tints the surface under the pointer — a per-face highlight read as "only
this spot is clickable".

## Authoring guide

**[docs/AUTHORING-PARTS.md](docs/AUTHORING-PARTS.md)** is the full guide — the part
contract, the geometry kernel API, the parameter schema, app wiring, testing, and gotchas.
See **Designing the control panel** in that guide for how to write descriptions, hide
internal params, and keep the interface simple while staying deeply adjustable.
`src/parts/demo.js` is a minimal worked example; `src/parts/planter.js` is a richer one
(facets, taper, twist, even walls, an optional feature, and a `verify` block).

Locally, `npm run dev` then open `/demo.html`, `/planter.html`, or `/filleted-box.html`.

- **Agent clarification (`request-a-pick`):** an external tool can ask the user to click
  geometry and get the `Selection` back — serve with `?pickserver&picktoken=<token>`,
  drive with `partforge pick-serve` (it prints the token) + `partforge pick "<prompt>" …`.
  The server is loopback-only and token-gated on every route. See
  `skills/partforge/SKILL.md` and the authoring guide.

## License

MIT
