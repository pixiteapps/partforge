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
  including mesh-native fillet and chamfer for straight, circular, planar-rim and
  curved-face edges.
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

**Show a cached preview while the kernel boots (0.147.0+).** `partforge/gltf`'s
`encodePreviewGlb({ meshes, part, view })` writes one view's posed display
meshes as a small GLB — welded, quantized and meshopt-compressed, one node per
sub-part, Y-up, millimetres — in Node, a page or a worker, and
`runtime.exportPreview()` encodes the view on screen with it. Hand the file back
as `mount()`'s `preview` and the viewer draws it before the worker is ready, then
swaps each sub-part for the live build in place without re-framing;
`runtime.previewActive` is true in between, while picking, measure, sketch and
cutaway wait for the live build. A file for another view, or one that will not
decode, is logged and ignored (a file written without a view is drawn on
sub-part name match alone). `mountPreview(container, { glb, elements,
viewerState })` is the kernel-free form — the same viewer, view cube, view style
and theme, with no part, no worker and no rail — for a page that only shows a
model (CAD look exact; realistic mode uses each sub-part's display only — no sheet
stock, no layer-line frames). Previews carry no edge lines, textures or patterns.
`part` (0.187.0+) hands it the part module, and the editor's place-only handles —
IK and collisions included — work on the file: `getParams()` reads the posed values,
`pose.onDragEnd(cb)` hears each release, and `motion.restart()` puts the pose back.
`resolveDefaultView(part)` (main entry and `partforge/testing`) names the view
`mount()` opens on, so a preview built headlessly matches it.

`mountPreview` takes presentation options (0.168.0+), each usable alone and
each defaulting to the viewer above: `chrome: false` (no view cube, viewbar
controls, view style, tooltips or play button), `background: "transparent"`
(alpha-0 canvas, no grid) and `contactShadow: true` (a soft shadow under the
part) — both CAD mode only, since realistic mode draws its own environment and
ground — `zoom: false`
and `pan: false` (a wheel then scrolls the page), `turntable: <degrees per
second>` (a model with no playing animation turns until the first camera grab,
never under `prefers-reduced-motion`), `fill: 0.8` (frame the model so its
bounding box, as seen from the opening view, spans that fraction of the preview
along its tighter axis — larger in a small card; with a turntable the model swept
a full turn is framed, so it never clips as it turns and a round part still fills, and it
turns about its hub; a model that is not turning has its on-screen outline centred, since 0.169.0, and a playing animation is framed over every pose it passes through, since 0.171.0, so a part that swings out never leaves the frame), `camera: "default"` (drop the carried camera
and projection and keep the file's own framing; a carried render mode and
environment still apply) and `renderMode: "cad" | "realistic"` (the opening
mode, over any carried one; it can change afterwards), and `autostart: false`
(0.169.0+: the animation or turntable waits at its first frame until
`handle.motion.start()`), and `edgeWidth` / `edgeOpacity` (0.170.0+: the CAD
edge lines' width in CSS pixels, default 1, and opacity, default 1 — a small
card reads the default lines as heavy). An unknown option key
throws. A baked animation always plays as authored — it
loops, or plays once and holds its end pose. Every handle carries `drawn`, which
resolves after the first frame showing the meshes, so a host can cross-fade from
a still image.

`handle.motion` (0.169.0+; `null` before `ready` and once disposed) drives that
motion: `start()` begins a waiting one (idempotent), `restart()` puts the model
back as it opened — the opening camera framing, the animation from its start or
the turntable turning again — and starts it, `state` is `"waiting"`,
`"playing"`, `"stopped"` (a drag stopped the turntable, or nothing moves) or
`"finished"` (a play-once animation ended), and `onChange(cb)` hears each change.
Under `prefers-reduced-motion` nothing moves and `restart()` only resets the
camera; a turntable mount is framed for its full turn either way.

```js
const glb = await runtime.exportPreview();               // Uint8Array: the view on screen
mount(part, { createWorker, elements, preview: glb });   // drawn at once, replaced by the build
const shown = mountPreview(stage, { glb });              // no kernel at all
await shown.ready;
const card = mountPreview(cardStage, {                   // a landing-page card
  glb, chrome: false, background: "transparent", contactShadow: true,
  zoom: false, pan: false, turntable: 14, fill: 0.8, camera: "default", renderMode: "cad",
});
await card.drawn;                                        // the first frame is on the canvas
// With autostart: false the card waits at that frame: fade it in, then
// card.motion.start(); a "replay" button calls card.motion.restart().
```

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
parameter only moves geometry (a rotation or translation in a `views` pose), the
viewer re-poses the meshes it already has — instantly, with no worker rebuild;
`onBuild` does not fire for those pose-only edits. Anything that changes the
geometry itself rebuilds as usual.

When any view declares `animations`, `runtime.animation` exposes the viewer's
playback engine (`null` otherwise). Animations are **view-owned**
(`views.<name>.animations`), so the engine is scoped to the active view — call
`setView` first to reach another view's set:

```js
runtime.animation.play("open");   // switch + play, within the ACTIVE view (camera cue and all)
runtime.animation.seek(0.5);      // scrub, normalized 0..1 (pauses); never moves the camera
runtime.animation.seek(0.5, { camera: true }); // 0.204.0+: and jump the camera to its cue pose there
runtime.animation.pause();
runtime.animation.stop();         // reset + restore pre-animation params and clear opacity overrides
runtime.animation.state();        // { view, animation, status, t, stepIndex, duration } (duration in seconds, 0.204.0+)
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

`runtime.picking` (0.204.0+) switches click-to-select off and on:
`picking.setEnabled(false)` makes a click pick nothing, open no selection
popover and (on the background) close no open one, and the hover label drops
its "Click to edit" hint while still naming what is under the pointer. It
closes nothing that is already open. `picking.isEnabled()` reads the switch. It
is not part of `getViewerState()`, so a remount comes up with picking on: send
it again after each remount. Without `onPick` it is a stand-in whose
`isEnabled()` is always false.

**Render an animation to video frames (0.204.0+).** Four parts of the runtime
handle do this:

- `runtime.renderCurrent(opts)` is `captureCurrent`'s capture as an
  `HTMLCanvasElement` instead of a JPEG data URL. It takes `captureCurrent`'s
  `size`, `hideGrid`, `recenter` and `renderMode`, plus `width` and `height`
  (together: an exact output size; the live framing is cropped to cover it, and
  a size past the GPU's largest texture is scaled down, keeping the aspect) and
  `includeHidden` (draw sub-parts the user hid). It has no `type` or `quality`.
  It returns `null` when disposed or nothing is built, and throws as
  `captureCurrent` does while a provisional stage is on screen. **The canvas is
  partforge's and is reused**: one canvas is kept for the output size last
  asked for, and the next call at that size draws over it. Consume it
  (`new VideoFrame(canvas)`, `drawImage`) before you call again. That frame
  set (target, readback buffer and canvas: about 50 MB at 1080²) is released
  5 s after the last `renderCurrent` call, and on park and dispose; a canvas
  you already received stays readable until your next call, which then simply
  allocates again. Before it draws, the capture catches up the per-frame work
  a live frame would have done — the cutaway's section outline and, in the
  realistic look, the contact shadow at full resolution — so a frame taken
  right after a seek is not drawn against stale state (`captureCurrent` does
  the same). Measurement dimensions are the exception: they rebuild only in a
  live frame, so with measure dimensions on screen wait for one `onRendered`
  after `whenSettled()` before `renderCurrent` (the seek's own render request
  guarantees that frame comes). Like `captureCurrent`, each call also asks the live view to redraw.
- `runtime.animation.seek(t, { camera: true })` poses the part at `t` and jumps
  the camera to where the animation's camera cues put it at `t`, as if the
  animation had played from 0 starting at the camera the first such seek found.
  Every cue's pose is framed then too, on the geometry on screen at that first
  camera seek, so a held cue does not creep as the part moves under it. The
  start and the cue poses are remembered until play, stop, another animation,
  a view change or a user camera grab, so the same `t` always gives the same
  frame, in any order. A user camera grab mid-render therefore makes later
  frames jump: block orbit input for the length of a render. Without `{ camera: true }`, `seek` never moves the camera. `seek`
  writes real params, so call `animation.stop()` when you are done to put the
  part's values back. `animation.state().duration` is the selected animation's
  length in seconds (0 with none selected), for working out the frame count.
- `await runtime.whenSettled()` waits until no build is pending or about to
  start. It resolves `true` when everything in the view on screen is built at
  the live params, and `false` after a build error, while a provisional stage
  is on screen, or on dispose. It never rejects, and before the first build it
  waits for it. It reads `true` while a pose drag is holding the build back, so
  do not capture during a drag. It can wait indefinitely in two cases — a
  worker that dies without replying (until dispose, as `runtime.ready` does),
  and an imported model whose tessellation fails without reporting back — so
  race it against a timeout.
- `runtime.setCameraCue(cue)` and `runtime.setCamera({ pos, target })` jump the
  camera with no tween. `setCameraCue` takes a camera cue — a view name or an
  `{ azimuth, elevation, distance? }` orbit in degrees — which is what a host
  stepping a turntable calls once per frame, with `getCameraCue().cue` for the
  start angle (`getCameraCue()` returns `{ cue, panned }`). A cue always aims
  at the part's centre, so a user's pan is lost on the first turntable frame:
  restore it afterwards with `setCamera(saved)`. An autoplaying or playing
  animation keeps moving the part during a turntable unless you
  `animation.pause()` or `stop()` it first. It leaves orthographic when the cue is not face-aligned, and a
  jump while orthographic resets the orthographic zoom to 1. It does not count
  as a user camera grab, so an animation's remaining cues stay armed.
  `setCamera` takes the `{ pos, target }` that `getViewerState().camera`
  returns, to put the user's view back afterwards. Both return `false`, and
  leave the camera alone, for input they cannot use (an invalid cue, vectors
  that are not three finite numbers) or, for `setCameraCue`, with nothing on
  screen.

```js
const anim = runtime.animation;
const saved = runtime.getViewerState();
const fps = 30, width = 1080, height = 1080;
anim.play("open");                          // "open" is a placeholder: one of your part's animations
                                            // (play selects it; the seek below pauses it)
const frames = Math.max(2, Math.round(anim.state().duration * fps) + 1);
const settled = () => {                   // whenSettled can wait forever (see above)
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), 30000); });
  return Promise.race([runtime.whenSettled(), timeout]).finally(() => clearTimeout(timer));
};
for (let i = 0; i < frames; i++) {
  // Ends on t = 1. For a `loop` animation use i / frames instead, or the
  // last frame repeats the first pose.
  anim.seek(i / (frames - 1), { camera: true });
  if (!(await settled())) break;            // a build failed or timed out
  const canvas = runtime.renderCurrent({ width, height });
  if (!canvas) break;                       // disposed, or nothing on screen
  const frame = new VideoFrame(canvas, { timestamp: (i * 1e6) / fps }); // consume it now
  encoder.encode(frame);                    // a WebCodecs VideoEncoder
  frame.close();
}
anim.stop();                                // restore the part's own values
if (saved.camera) runtime.setCamera(saved.camera); // and the user's view
runtime.projection.set(saved.projection);
```

A turntable steps the camera, not the animation (`frames`, `width` and
`height` as in the example above):

```js
const saved = runtime.getViewerState();
runtime.animation.pause();                  // or stop(): a playing animation keeps moving the part
const start = runtime.getCameraCue()?.cue;  // { azimuth, elevation, distance }
for (let i = 0; start && i < frames; i++) {
  runtime.setCameraCue({ ...start, azimuth: start.azimuth + (360 * i) / frames });
  const canvas = runtime.renderCurrent({ width, height });
  // …encode canvas as above…
}
if (saved.camera) runtime.setCamera(saved.camera); // puts back the user's pan too
```

**Record the live canvas (0.204.0+).** `runtime.onRendered(cb)` calls `cb`
after each frame has drawn to the live canvas, in the same task as the draw,
and returns an unsubscribe. That callback is the only time the live canvas can
be read back reliably (`drawImage`, `new VideoFrame(liveCanvas)`); at any other
time it may read blank. The viewer draws on demand, so an idle viewer calls
nobody — calling `renderCurrent` from inside the callback keeps it drawing —
and nothing fires while parked (`setActive(false)`). A callback that throws
costs only itself. Pose handles are drawn in the live canvas, so a host
recording it that does not want them calls `runtime.pose.setEnabled(false)`;
turning picking off does not hide them.

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
