# Error patterns — symptom-indexed lookup

When a build, test, `measure`, or `verify` run fails confusingly: **grep this file
for the symptom first** — the literal error text, or a phrase describing the
misbehavior — before debugging from scratch.

**How to add a pattern** (`##` headings are reserved for pattern entries — the lint
test parses every one; keep prose like this as plain paragraphs):

- One pattern per `## <id>` heading. The heading is a **stable kebab-case ID**:
  permanent once committed — never renamed, never reused. External consumers
  (issue #27 diagnostics, HARDWARE.md, skills) cite `ERROR-PATTERNS.md#<id>`.
- **Namespaces:** core framework patterns are bare slugs. Subsystem patterns take
  a reserved prefix — `hardware-*` is reserved for the parts library (issue #30).
  One `#`-level section per namespace.
- Entry shape — exactly these three list lines, then optional note paragraphs:
  - **Symptom:** the literal string an agent would see, verbatim in backticks,
    when one exists; otherwise the observable misbehavior. This is the grep target.
  - **Cause:** one sentence.
  - **Fix:** the concrete change, linking the governing rule
    ([AUTHORING-PARTS.md](AUTHORING-PARTS.md) section) rather than restating it.
- No tables inside entries.
- Code that throws should throw greppable strings: an error message thrown by
  partforge should appear verbatim, in a backtick literal **at the start** of its
  pattern's Symptom line. Only that leading literal is what the crash matcher
  matches on — backticks used for prose later in the line never participate, so a
  reworded Symptom must lead with the thrown string, not bury it mid-sentence.
- `test/error-patterns.test.js` lints this file's structure.

# Core framework

## worker-imports-main-entry

- **Symptom:** `ReferenceError: document is not defined` thrown from a worker build.
- **Cause:** The part (or a helper it imports) imports `partforge` instead of `partforge/geometry`, and the main entry pulls in the DOM viewer/controls.
- **Fix:** Import geometry helpers only from `partforge/geometry` in anything a worker loads. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## impure-build-stale-preview

- **Symptom:** Preview geometry doesn't change after editing the part's `build` (or changes once, then sticks), with no error anywhere.
- **Cause:** The preview kernel memoizes geometry by content hash, and an impure `build` (`Math.random`, clock, module-level mutable state) silently defeats it.
- **Fix:** Make `build` a pure function of `(k, p, d)`; move randomness/state into `derive` inputs or delete it. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Caching & determinism".

## replicad-consumed-operand

- **Symptom:** On the OCCT backend a solid is unexpectedly empty, or the build crashes, right after the same solid was transformed or used in a boolean — often only in STEP export, with the Manifold preview fine.
- **Cause:** replicad transforms and booleans (`translate`/`rotate`/`mirror`/`cut`/…) consume their operand — the input solid is deleted and a new one returned.
- **Fix:** Never reuse a solid after transforming it; take a `.clone()` first when you need the original again. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API" (the `s.clone()` row).

The framework itself rebuilds each sub-part fresh per job and applies `place` once, which avoids the problem — follow the same pattern in your own code. (Since the OCCT solid cache landed, the in-repo backend clones internally before every consuming replicad call, so wrapped `Solid`s effectively have value semantics and this crash should no longer reproduce through the kernel API — but the portable rule stands: per KERNEL-CONTRACT.md a backend MAY consume, so a part must still not rely on reuse.)

## probe-routed-to-occt

- **Symptom:** A part builds far slower than expected (preview takes seconds instead of milliseconds), and the worker logs show it running on the `occt` worker.
- **Cause:** The geometry-free probe runs `build` against a recording proxy (dummy query values), and a **Solid** `shell` call it reaches — including a branch the real build would not take, since queries return dummies — routes that sub-part to OCCT. Fillet and chamfer are not probe-routed: they start on Manifold and reroute only if the mesh backend reports an unsupported edge class. Preview routing is per sub-part; exports and the CLI route the whole part to the max over its sub-parts because those jobs run in one worker/kernel.
- **Fix:** Remove or guard the unnecessary `shell` call, or force the backend with `meta.backend: "manifold"` (or `"occt"`). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Fillet, chamfer & shell". Routing re-runs with live params on every regen; a runtime `needs-occt` fallback is latched only for the current parameters, so a stale backend choice never outlives a parameter edit.

## fillet-chamfer-many-edges-slow

- **Symptom:** A part on the OCCT path (unsupported-edge fallback, forced backend, CLI fallback, or STEP export) fillets or chamfers the rim of an extruded profile and takes many seconds — even tens of seconds — per build, with no error anywhere.
- **Cause:** OCCT fillet/chamfer cost scales with the number of selected edges, and an `inPlane` rim selector on a many-point extruded profile selects every polygon edge (hundreds for a gear), so one op call costs seconds — and re-runs on every parameter change while that path is active.
- **Fix:** Use `extrude`'s `bevel` option instead of `chamfer` — same geometry, stays on the fast Manifold backend. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Beveling profile rims: extrude's bevel option".

## boolean-coincident-faces-hang

- **Symptom:** A part previews instantly but a STEP export (or any OCCT-path build) of one sub-part runs for minutes and never finishes, with no error, no warning, and no progress. Cutting each tool on its own is fast; only the combination hangs. Threaded parts are the usual victims.
- **Cause:** Two cut tools in the same `cutAll` (or a tool and the body) share an *exactly* coincident face — most often a bore whose radius equals a thread's root radius, so the bore wall and the thread root lie on the same cylinder. OCCT's boolean has to classify a surface that is simultaneously on both operands, and the intersection search degenerates. Manifold's mesh CSG does not care, which is why the preview is fine and only the exact kernel suffers. Measured on one real part: bore alone 0.4 s, thread alone 5.4 s, both together did not finish in fifteen minutes; moving the bore 0.05 mm brought the pair to 12.6 s.
- **Detected:** The exact kernel now refuses the common cylindrical form of this contact up front — several swept faces lying exactly on one cylindrical face fail the boolean immediately with `<op> between exactly-touching surfaces: … (radius <r>)` and the fix menu below, instead of grinding. Scope, honestly: the guard needs the contact to tile the cylinder (a thread does, ~6+ hugging faces per turn; a sub-turn thread can slip under it — that is the old grinding behavior, not a new one), it covers swept-face-on-cylinder contact only (two swept faces mated exactly, or contact with non-cylindrical faces, can still hang), and a hand-sunk thread whose chord-bands happen to hug the wall can be refused even though it would have built — `k.tappedBore` resolves that refusal too, since its internal composition is exempt. The rule below applies everywhere regardless.
- **Fix:** For a tapped hole — far and away the most common cause — use `k.tappedBore({ d, pitch, turns, depth })`, which returns the bore and its thread as one tool and cannot put them on the same face. Otherwise: give the surfaces a deliberate clearance instead of letting them land on the same number. Derive one from the other with an explicit gap — `const boreD = threadRootD - 2 * boreClearance;` with `boreClearance` around 0.05-0.1 mm — rather than reusing the same expression for both. The gap is far below a printable layer, so the fit is unchanged. The same rule covers a cut that ends exactly flush with a face (overshoot it by a few tenths, as the surrounding examples do with `+ 0.4` / `- 0.2`) and two tools that abut exactly end-to-end.

## boolean-dropped-operand

- **Symptom:** `dropped an operand` — the full message reads `boolean result invalid: <op> dropped an operand — the result's volume (<v>) equals operand <i>'s exactly, but operand <j> (<vj>) has <x> mm³ of material outside it that the union lost.`, thrown from a `union` (or from `cutAll`, labelled `cutAll (tools)`, whose tools are fused before the cut; or labelled `k.tappedBore's bore ∪ thread union`, in which case the author wrote no union — the framework's own composition failed, report it). Before partforge 0.110 the same construction shipped silently: a STEP export that is a plain cylinder, a preview missing the thread, a `measure` volume equal to the core's alone ([screw-thread-vanishes-on-occt](#screw-thread-vanishes-on-occt)).
- **Cause:** The exact kernel's fuse failed without reporting it and returned one operand instead of the union — a thin or near-self-touching swept operand (a sub-pitch thread ridge riding a core, a thread tool whose root sits on the bore wall) is the case seen on real parts. The gate (`boolean-gate.js`) noticed because the result's volume is one operand's to float precision while the other operand has material outside it, which no union can lose.
- **Fix:** Give the operands genuine overlap rather than a tangent contact (sink one 0.05 mm or more into the other — derive one radius from the other with an explicit offset, never the same expression twice). Build a thread in the **periodic** `screwSweep` form, which needs no union at all, or a tapped hole with `k.tappedBore`, which owns the bore and thread together. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Helical & threaded features". Do not "fix" it by catching the error — the geometry it refused is wrong, and the previous good preview stays on screen while you correct the construction.

## boolean-impossible-result

- **Symptom:** `produced an impossible result` — the full message reads `boolean result invalid: <op> produced an impossible result — …`, thrown from `union`, `cut`, `cutAll` or `intersect`, naming one of: `a negative volume`, `a union smaller than its largest operand`, `a cut larger than its body`, `a cut that emptied its body although the tools cover at most <x> mm³ of its <y> mm³`, `an intersection larger than its smallest operand`.
- **Cause:** The kernel's boolean returned geometry that violates the one property no boolean may (a union contains its inputs, a cut only removes, an intersection lies inside each input, a solid has non-negative volume) without reporting an error. On the exact kernel this follows a tangent or self-touching contact the coincidence guard could not recognise up front ([boolean-coincident-faces-hang](#boolean-coincident-faces-hang) covers the form it does refuse); on the mesh kernel it should never happen and would be a kernel bug worth reporting. The gate carries 1% slack on the largest operand, so volume-integration noise cannot trip it.
- **Fix:** The same menu as the coincidence guard's — genuine overlap or genuine clearance (0.05 mm or more) instead of exact contact, cut tools overcut past the faces they pierce, threads in the periodic `screwSweep` form or via `k.tappedBore`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Gotchas". A refusal is a throw, not a warning, on purpose: the alternative is the silently wrong part these rules exist to stop, and a live preview keeps its last good mesh on screen across a failed rebuild.

## chamfer-rescue-bisection

- **Symptom:** `partforge: chamfer` warning saying the distance `over-ran the geometry — reduced to` a smaller one (or `has no valid distance`), with an attempt count and elapsed seconds, alongside slow builds.
- **Cause:** The requested chamfer distance doesn't fit the geometry (it over-runs an adjacent face or a short edge), so the failure-rescue bisection in `occt-repair.js` re-runs the full chamfer up to 7 more times to find the largest valid distance — multiplying an already-expensive op by ~8× on every build, since the result is only cached per exact input hash.
- **Fix:** Lower the chamfer parameter to at most the printed valid distance (the rescue then never fires), clamp it in `build` from the geometry that limits it, or — for extruded profile rims — switch to `extrude`'s `bevel` option, which finds its own limit in pure JS. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Beveling profile rims: extrude's bevel option".

Variant literals under this entry: `partforge: chamfer <d> over-ran the geometry — reduced to <d'> (largest valid; <n> attempts, <t>s — see ERROR-PATTERNS.md#chamfer-rescue-bisection)`, `partforge: chamfer <d> has no valid distance for this geometry — feature skipped (<n> attempts, <t>s — see ERROR-PATTERNS.md#chamfer-rescue-bisection)`.

## extrude-bevel-invalid

- **Symptom:** `extrude: bevel must fit the height (bottom + top < h)` or `extrude: bevel cannot combine with twist or scaleTop` thrown from a build.
- **Cause:** `extrude`'s `bevel` option desugars into offset-loft envelopes, which need an untwisted straight extrusion and room for both bevels inside the height.
- **Fix:** Clamp the bevel from the height parameter (e.g. `Math.min(c, h / 2 - 0.2)`) and drop `twist`/`scaleTop`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Beveling profile rims: extrude's bevel option".

Variant literals under this entry: `extrude: unknown bevel option`, `extrude: bevel must be a number or { bottom?, top? }`, `extrude: bevel distances must be finite numbers >= 0`.

## extrude-bevel-reduced

- **Symptom:** `partforge: extrude bevel` warning saying the requested distance `exceeds what the profile can take — reduced to` a smaller one (or `has no valid offset for this profile — rim left square`; `hole` in place of `profile` when a hole's flare is the limit).
- **Cause:** Offsetting the rim by the bevel distance would pinch a narrow feature (a tooth land, a thin bar, a thin web beside a hole) shut, so the bevel deterministically backs off to the largest offset the outline can take — the same geometric limit OCCT's chamfer hits, resolved in pure JS instead of kernel re-runs.
- **Fix:** Usually nothing — the reduced bevel is the correct maximum for the geometry. To silence it, clamp the bevel parameter below the printed value or widen the narrow feature. Since partforge 0.69 this warning also rides the build result's `warnings` (see [feature-skipped-warning](#feature-skipped-warning)), so a host or agent is told the rim was left square rather than having to read the console.

## roundedbox-rim-clamped

- **Symptom:** `roundedBox: round.top <n> clamped to round.side <m> (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)` in the console — and, since partforge 0.69, on the build result's `warnings` (see [feature-skipped-warning](#feature-skipped-warning)) — with the built rim round-over smaller than the `round.top`/`round.bottom` you passed.
- **Cause:** the middle regime `0 < side < rim` has no closed-form corner shared by both backends, so the rim radii clamp down to `side` (the footprint-defining radius never grows silently).
- **Fix:** either raise `round.side` to ≥ the rim radii (torus/sphere corners), or set `side: 0` exactly for a full-size rim-only round-over on sharp vertical edges.

## roundedbox-strict-h

- **Symptom:** `roundedBox: with round.side > 0, round.top + round.bottom must be < h (the rim fillets would meet tangentially; reduce the rim radii slightly, or use side: 0 for a sharp-sided full-height round-over)` thrown from a build.
- **Cause:** with `round.side > 0`, the top and bottom rim fillets are separate features that need a straight wall band between them; `top + bottom == h` (or greater) leaves no band, so the fillets would meet tangentially — which the B-rep backend cannot build.
- **Fix:** reduce `round.top`/`round.bottom` slightly so their sum is strictly less than `h`, or set `round.side: 0` for a sharp-sided full-height round-over. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § roundedBox row.

## roundedbox-fillet-skipped

- **Symptom:** `partforge: fillet(<r>) produced invalid geometry — feature skipped` (or `… produced an empty solid — feature skipped`) in the console during a `roundedBox` build, and the OCCT-exported rim is sharp where a round-over was requested.
- **Cause:** OCCT's native fillet cannot build the rim round-over at a degenerate boundary (e.g. a rim radius exactly equal to `round.side` on a stadium profile, `2·side == min(w, d)`) and would otherwise return invalid-but-nonempty geometry; the monotonicity/validity gate in `occt-repair.js`'s `safeOp` catches it and skips the feature rather than exporting invalid STEP.
- **Fix:** shrink the affected rim radius slightly below `round.side` (or below the degenerate boundary), or accept the sharp rim at that exact radius.

## roundall-skipped

- **Symptom:** console warning `partforge: roundall-skipped: offset step … produced no valid solid — r=… is likely at/above the smallest feature size; returning the un-rounded solid`, and the OCCT build (STEP export, CLI measure with the OCCT backend) shows sharp edges where `roundAll` was expected.
- **Cause:** the B-rep backend implements `roundAll` as a triple OCCT offset, which cannot change topology: a radius at or above the smallest local feature (thin wall < 2r, hole < 2r) has no valid B-rep offset result, so the op skips whole rather than emit garbage (KERNEL-CONTRACT.md, `roundAll` row). The mesh backend meanwhile performs true consumption — so preview and STEP legitimately differ in this regime.
- **Fix:** reduce `r` below half the smallest wall/hole radius if STEP fidelity matters; or accept the divergence (preview/STL are correct) and gate the part with a `verify` volume assertion so the behavior is intentional.

## boolean-not-watertight

- **Symptom:** `NOT watertight ✗` from `partforge measure` (non-zero exit) after adding a boolean cut or union.
- **Cause:** A coplanar-face or grazing-cut degeneracy — the tool surface exactly touches the body surface, leaving zero-thickness geometry.
- **Fix:** Overcut: extend the tool past the faces it pierces (e.g. the demo's cut tool is `h + 4` starting at `z = -2`) and avoid exactly-flush faces in unions. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Verifying a part headlessly (render + measure)".

## dual-kernel-same-process

- **Symptom:** A test file crashes or hangs (WASM abort) when it boots both geometry kernels.
- **Cause:** OCCT and Manifold WASM must not boot in the same process.
- **Fix:** Keep OCCT-booting tests in their own files (vitest isolates per file) and boot via `bootOcctKernel()` in a `beforeAll`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Testing a part".

## view-dependent-display-place

- **Symptom:** A sub-part renders correctly in one view but appears misplaced (usually in its other-view pose) after switching views.
- **Cause:** A `place` that depends on `ctx.view` for `purpose: "display"` — display meshes are built once per sub-part and cached across views.
- **Fix:** Make display placement view-independent; only `place(..., { purpose: "export" })` may branch on `view`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "The `PartDefinition` contract".

## place-not-rigid

- **Symptom:** The exported/printed part is a mirror image of — or a different size than — the same part shown in the assembly/display view. Nothing throws: the preview looks right and only the STL/STEP is wrong, or vice-versa.
- **Cause:** A `place` whose `purpose: "display"` and `"export"` branches differ by a non-rigid transform — `mirror` (flips handedness) or a non-identity `scale` (changes size) — so display and export are no longer the same solid, only its reflection/resize.
- **Fix:** Keep the display-vs-export `place` difference a rigid motion (`translate`/`rotate`/`rotateAbout`/`along`/`at`) only. If the part genuinely needs a reflected or resized form, bake that into `build` so both purposes share one canonical solid and pose it rigidly. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "The `PartDefinition` contract".

## wrong-node-version

- **Symptom:** Confusing failures during `npm install`, tests, or CLI runs — WASM load errors, syntax errors in dependencies, or kernels that never boot — on a machine that built fine before.
- **Cause:** The shell's default Node is older than the required Node 24 (`.nvmrc` pins it).
- **Fix:** Run `nvm use` before `npm install`, tests, or any `npx partforge` command. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Quickstart".

## worker-url-not-inline

- **Symptom:** The app loads but geometry never builds — the worker 404s or is missing from the production bundle (works in `npm run dev`, breaks in `npm run build`).
- **Cause:** The `new Worker(new URL(...))` call was moved out of the app entry file (into a helper or variable), so Vite's static analysis can't see and bundle the worker.
- **Fix:** Keep `new Worker(new URL("./<part>-worker.js", import.meta.url), ...)` inline in `src/app-<part>.js`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Wiring a part into a runnable app".

## minwall-sliver-triangles

- **Symptom:** `⚠` minWall warnings from `verify` on a faceted part whose walls are clearly thicker than the profile minimum.
- **Cause:** The ray-shot wall-thickness measurement can catch sliver triangles at facet seams, reading a near-zero "wall" that isn't a designed wall.
- **Fix:** Check where the reported thin spot is: at a facet seam or chamfer transition it's a sliver artifact (minWall is a warning, never a gate — safe to note and move on); along a real wall, thicken the wall. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## near-miss-gap

- **Symptom:** A `⚠ … nearMiss` warning or `✗ … contact` failure from `verify` reporting sub-parts `N mm apart, expected touching`, or a `near-misses:` line in `measure` output for parts that look joined in the preview.
- **Cause:** Two sub-parts that should meet don't quite — a boss shorter than the gap it must bridge, a mis-placed mating datum in `derive()`, or a union that silently missed. Renders and volume/bbox checks cannot see sub-mm joint gaps; this check exists precisely for them.
- **Fix:** If the pair should touch, grow the joining feature or fix the datum math so the faces meet, then declare the pair in `verify.expect._view.contacts`; if a free fit is intended, declare it under `clearance`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## expect-static-across-presets

- **Symptom:** A `verify` exact gate (`holes`, `volume`, …) fails on SOME presets only — e.g. `✗ planter holes 1  (0 != 1)` on two cases while defaults pass — and the preview looks right for every preset.
- **Cause:** `verify` runs `expect` across defaults + every preset, and a preset legitimately changes the asserted fact (an optional feature like a drain/bore toggles the genus), while the expectation is one static value.
- **Fix:** Declare `expect` as a pure function of the case's resolved params — `expect: (p, d) => ({ body: { holes: p.drain > 0 ? 1 : 0 } })` — or restrict `verify.cases`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## param-key-missing-from-defaults

- **Symptom:** The affected control's number box renders empty/blank (internally `numStr(undefined)` produces the string `NaN`, which a number input sanitizes to empty), or its range slider sits at a browser-default position and edits don't drive the geometry — no error is thrown — and if the key is `hidden`, no control is rendered for it at all.
- **Cause:** A `key` used in the `parameters` schema (slider, feature, or preset override) doesn't exist in `defaults` — every key must, including `hidden` ones.
- **Fix:** Add the key to `defaults` with a sensible starting value. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Parameters: the control-panel schema".

## features-missing-sliders

- **Symptom:** `Cannot read properties of undefined (reading 'filter')` thrown from the control panel while the app boots, with no geometry ever rendering.
- **Cause:** A `features` entry in the parameter schema has no `sliders` array — `controls.js` reads `feat.sliders.filter(...)` unguarded. A bare on/off control was put in `features` instead of `toggles`.
- **Fix:** Move a bare boolean to the section's `toggles` array (`{ key, label, on }`), or give the `features` entry the `sliders` array it requires. `npx partforge lint <part>` catches this statically as `features-requires-sliders`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Parameters: the control-panel schema".

## dimmed-control-vestigial-param

- **Symptom:** A control renders dimmed (but still editable) and changing it does nothing on screen.
- **Cause:** No sub-part visible in the active view reads that parameter — the relevance-aware panel dims controls with no on-screen effect.
- **Fix:** This is a signal, not a bug: either the parameter is vestigial (delete it), the control is in the wrong section/view scope, or you're in a view that legitimately doesn't use it. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "The relevance-aware panel".

## linked-checkout-wasm-403

- **Symptom:** In a consuming app using an `npm link`ed partforge checkout, the kernel never boots and the dev-server network tab shows `403` on the Manifold/OCCT `.wasm` files.
- **Cause:** The linked checkout lives outside the app's project root, so Vite's dev server refuses to serve its files.
- **Fix:** Allow-list it: `server: { fs: { allow: ["./", "../partforge"] } }` in the app's `vite.config.js`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Developing against a local (linked) partforge".

## ring-sector-full-circle

- **Symptom:** `ringSectorPolygon: arcDeg must be < 360 (use a cut for a full ring)`
- **Cause:** A full annulus can't be a single simple polygon — it's a contour-with-hole.
- **Fix:** Cut an inner cylinder from an outer one (or `k.extrude({ profile: { outer, holes }, h })`); use `ringSectorPolygon` only for partial arcs. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Profiles & patterns".

## occt-closed-loop-unsupported

- **Symptom:** `loft: closed:true loops are only supported on the Manifold backend` (or the same message from `sweep:`) — typically during STEP export of a part that previews fine.
- **Cause:** Capless closed loops are a Manifold-only capability; the OCCT backend rejects them, and STEP export always runs on OCCT.
- **Fix:** Keep the part on Manifold (no STEP) or model the loop as a capped solid both backends support. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## smooth-geometry-faceted-preview

- **Symptom:** A `ruled:false` loft or `smooth:true` sweep looks faceted/straight-walled in the viewer even though the options are set.
- **Cause:** Smooth blending is OCCT-native; the Manifold preview always tessellates ruled straight walls — only STEP export carries the smooth surface.
- **Fix:** Nothing is wrong — verify smoothness in the exported STEP, not the preview. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## scale-moved-the-part

- **Symptom:** After `s.scale(f)` a part is resized but also relocated — features drift away from where they were built.
- **Cause:** `scale(factor, center?)` defaults its center to the origin, so scaling an off-origin solid about the origin also translates it.
- **Fix:** Pass the center you mean, e.g. `s.scale(f, s.boundingBox().center)` to resize in place. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## occt-holes-watertight-na

- **Symptom:** `watertight n/a` in `partforge measure` output, and `holes`/`watertight` assertions in a `verify` block don't run, on a part with fillets/chamfers.
- **Cause:** `holes` and `watertight` are Manifold-only topology facts, and this part auto-routed to OCCT — the assertions skip rather than fail.
- **Fix:** Expected behavior: assert on backend-independent facts (`bbox`, `volume`, `overlaps`) for OCCT parts, or split topology assertions into a Manifold-buildable configuration. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## html-page-missing-in-prod

- **Symptom:** A part's page 404s in the production deploy while working fine under `npm run dev`.
- **Cause:** Only pages listed in `build.rollupOptions.input` are compiled by the production build; other root `*.html` pages are dev-only conveniences Vite serves without building.
- **Fix:** Add the page to `build.rollupOptions.input` in `vite.config.js` if it should ship. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Wiring a part into a runnable app".

## cutaway-capture-hatch-flood

- **Symptom:** With cutaway enabled, a `captureCurrent`/`captureViews` image comes back with section hatch flooding a whole quad and burying the part, while the live viewer looks correct; a consumer may instead report the capture being rejected as too large, because full-frame hatch is worst-case JPEG content.
- **Cause:** Cutaway masks its section caps with the stencil buffer, and a `THREE.WebGLRenderTarget` has none unless it asks for one — so the mask no-ops in offscreen renders even though the visible canvas (created with `stencil: true`) is fine.
- **Fix:** Allocate offscreen render targets with `stencilBuffer: true` (`renderOffscreen` in `src/framework/viewer.js`); `scripts/check-app.mjs` measures hatch coverage in a real-GL capture to keep it that way.

## options-unknown-key

- **Symptom:** `unknown option` — e.g. `cylinder: unknown option "radius" — did you mean r?`
- **Cause:** an options-form kernel call passed a key the op does not accept (typo, or long-form vocabulary like `radius`/`height`).
- **Fix:** use the canonical keys from the op table in [AUTHORING-PARTS.md](AUTHORING-PARTS.md); the error's did-you-mean / valid-keys hint names them.

## options-missing-key

- **Symptom:** `is required` — e.g. `cylinder: h is required`, `sweep: path is required`.
- **Cause:** an options-form kernel call omitted a required key.
- **Fix:** supply the key; canonical forms are in the [AUTHORING-PARTS.md](AUTHORING-PARTS.md) op table and KERNEL-CONTRACT.md "Calling convention".

## cylinder-radius-keys

- **Symptom:** `cylinder: pass exactly one of r/d, or r1+r2 / d1+d2`
- **Cause:** mixed or missing radius vocabulary — both `r` and `d`, straight + cone keys together, only one cone end, or `r1`+`d2`.
- **Fix:** straight cylinders take one of `r`|`d` plus `h`; cones take `r1`+`r2` or `d1`+`d2` plus `h`.

The sphere variant is `sphere: pass exactly one of r/d` (same cause and fix).

## box-size-vs-corners

- **Symptom:** `box: pass size or min+max, not both`
- **Cause:** the two `box` forms were mixed in one call.
- **Fix:** either `{size, center?}` (centered in X/Y, base at z=0; `center:true` centers Z too) or `{min, max}` — see [AUTHORING-PARTS.md](AUTHORING-PARTS.md).

## box-center-with-corners

- **Symptom:** `box: center only applies to the size form`
- **Cause:** `center` was passed alongside `min`/`max`, but explicit corners already fix the placement.
- **Fix:** drop `center`, or switch to `{size, center?}` — see [AUTHORING-PARTS.md](AUTHORING-PARTS.md).

## offset-polygon-bad-input

- **Symptom:** `offsetPolygon: need at least 3 points`
- **Cause:** malformed input to `offsetPolygon` — too few points after dedup, or (variant messages) a non-finite `delta`, non-finite coordinates, an unknown `corners` style, or a profile that is neither a point list nor `{outer, holes}`.
- **Fix:** pass a CCW `[[x,y],…]` list (≥ 3 distinct points) or `{outer, holes}`, a finite `delta` in mm, and `corners: "round" | "chamfer" | "sharp"` — see [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Profiles & patterns".

Variant literals under this entry: `offsetPolygon: delta must be a finite number`, `offsetPolygon: coordinates must be finite numbers`, `offsetPolygon: corners must be "round" | "chamfer" | "sharp"`, `offsetPolygon: profile must be a point list or {outer, holes}`.

## offset-polygon-input-self-intersects

- **Symptom:** `offsetPolygon: input polygon self-intersects`
- **Cause:** the input contour crosses itself — the profile is broken before any offsetting happens (checked up front so bad input is not blamed on the offset).
- **Fix:** repair the generating math for the contour; the offset envelope requires simple polygons in and out.

## offset-polygon-collapse

- **Symptom:** `offsetPolygon: offset collapses the polygon`
- **Cause:** the offset consumed the shape — either an inset ate the whole polygon (result area ≤ 0 or fewer than 3 points, `|delta|` past the narrowest half-width; also thrown for a region hole that would vanish), or an offset displaced an edge past its own length so the edge inverts (a large inset, or a large *outset* of a concave profile where `|delta|` exceeds a reflex-adjacent edge — this last case can also depend on `corners`, since `"sharp"` extends edges further than `"round"`/`"chamfer"`).
- **Fix:** reduce `|delta|`, or clamp it from the shape's dimensions before offsetting (see planter.js's wall cap). If a vanishing hole is intended, remove the hole from the region explicitly. Realistic clearances (fractions of a mm) on any profile, and wall insets up to the narrowest feature, never trip this.

## offset-polygon-result-self-intersects

- **Symptom:** `offsetPolygon: offset result self-intersects (reduce |delta| or simplify the profile)`
- **Cause:** the true offset of this shape at this `|delta|` is not a single simple polygon (e.g. insetting a dumbbell past its waist would split it in two) — out of `offsetPolygon`'s envelope.
- **Fix:** reduce `|delta|`, or decompose the profile into separately-offset simple contours.

## cubic-segment-mixes-arc-and-cubic

- **Symptom:** `extrude: <role> segment cannot mix arc (via) and cubic (c1/c2)`
- **Cause:** A path-contour segment carries both `via` (three-point arc) and `c1`/`c2` (cubic Bézier). A segment is exactly one kind.
- **Fix:** Drop `via` for a cubic, or drop `c1`/`c2` for an arc. Use `pathProfile().arcTo(to, via)` or `.cubicTo(to, c1, c2)` to build segments.

## cubic-segment-missing-controls

- **Symptom:** `extrude: <role> cubic segment needs c1 and c2 as finite [x,y]`
- **Cause:** A cubic segment is missing `c1` or `c2`, or a control point is not a finite `[x,y]` (e.g. `NaN`, wrong length).
- **Fix:** Provide both control points as finite `[x,y]`. A cubic Bézier needs two controls between the previous point and `to`.

## arcto-radius-too-short

- **Symptom:** `pathProfile: arcTo r=<r> is shorter than half the chord (<half-chord>) from (<x0>, <y0>) to (<x1>, <y1>) — the smallest arc that can join these points has r=<half-chord> (a semicircle)`
- **Cause:** `pathProfile().arcTo(to, { r, sweep?, large? })`'s `r` is smaller than half the distance between the current point and `to` — no circle of that radius passes through both points.
- **Fix:** Raise `r` to at least half the chord (the message states the exact minimum), or move the endpoint closer. Unlike SVG's arc command, partforge refuses rather than silently scaling `r` up to fit — the model should learn the number it wrote was wrong rather than have it quietly corrected.

## shape2d-simple-not-single-region

- **Symptom:** `Shape2D.simple: result has N regions, not 1 (use toRegions())`
- **Cause:** `.simple()` was called on a boolean result that is empty or split into multiple disjoint regions (e.g. `intersect` of disjoint shapes, or a `cut` that severs a shape in two).
- **Fix:** Use `.toRegions()` to get the array, or adjust the operands so the result is a single connected region. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "2-D booleans".

## shape2d-offset-collapses

- **Symptom:** `Shape2D.offset: offset collapses the shape (reduce |delta|)`
- **Cause:** A negative (inset) `offset` removed more than the shape's half-width,
  leaving no geometry — or the delta is larger than the feature it offsets.
- **Fix:** Reduce `|delta|`, or check the source profile is large enough for the
  inset. Realistic clearances (fractions of a mm) and wall insets up to the
  narrowest feature never trip this.

## shape2d-offset-partial-reflection-residual

- **Symptom:** *(Fixed for positive round offsets in `0.60.0`; the ID remains
  permanent.)* An outward `Shape2D.offset` on a region with a hole could leave a
  residual hole ring after the source counter should have closed.
- **Cause:** A fully eroded source counter could survive the raw offset as a
  locally valid negative loop. Positive-winding cleanup then correctly preserved
  that loop because the defect was introduced before winding classification.
- **Fix:** The round resolver now computes a conservative largest-inscribed-disk
  bound from the source hole and removes a residual counter only when the requested
  dilation has certainly passed its source inradius. Upgrade to
  `partforge >= 0.60.0`. Sharp and chamfer offsets use different structuring
  elements and are not covered by this round-specific gate; continue to verify
  those styles at the production offset and use explicit boolean stages when their
  closing topology is critical.

Searchable phrasings of the same misbehavior: hole doesn't disappear after offset;
pocket not closed by offset; residual hole ring; `.holes.length` still 1 after
growing a shape past the hole's own width.

## shape2d-offset-reflex-cluster-too-much-material

- **Symptom:** *(Fixed in `0.60.0`; the ID remains permanent.)* An inward
  `Shape2D.offset` with clustered reflex corners could retain material outside the
  true eroded shape.
- **Cause:** The old overlap-side trim could extend offset lines to an intersection
  outside the finite extent of one or both segments. The deleted Paper.js
  `resolveSelfRegions` path is not part of the current resolver.
- **Fix:** Overlap-side trimming now requires the intersection to lie within both
  segment extents, and the resulting arrangement is resolved by positive winding.
  Upgrade to `partforge >= 0.60.0`. The regression oracle pins the clustered-reflex
  9-gon chamfer area at approximately `3.553831 mm²`.

## shape2d-offset-waist-not-severed-round-join

- **Symptom:** *(Fixed — kept because IDs are permanent. This pattern no longer
  exists.)* An inward `Shape2D.offset` past the width of a narrow waist used to leave
  the shape connected (or add a spurious blob where the waist was) under
  `corners: "round"` or `"chamfer"`, while `"sharp"` split it correctly. The entry's
  own witness now behaves: a 30×10 dumbbell with a 2-wide waist at `delta` −2 severs
  into **two** regions under all three joins — 72.346873 round, 74.000000 chamfer,
  72.000000 sharp — against the three regions and 97.258 the round join used to give.
- **Cause:** The waist recovery it described (`splitAtDuplicateEdges` in
  `contour-offset.js`) matched a pair of duplicate, exactly-collinear edges, so it only
  ever handled rings made entirely of straight lines; a round or chamfer join left an
  arc or bevel chord at the pinch with no duplicate edge to cut. That function no longer
  exists anywhere in `src/` — the whole boolean/heuristic cleanup path was replaced by
  the winding resolver (`geometry/contour-winding.js`), which computes the
  positive-winding region of the raw outline directly and severs a pinched waist as an
  ordinary consequence of that, with no per-shape recovery and no join casing.
- **Fix:** Nothing to work around; the advice this entry used to give ("use
  `corners: "sharp"` to split") is obsolete and was making callers change corner style
  for no reason. If a region count still looks wrong after an inward offset, see
  [shape2d-offset-winding-chain-incomplete](#shape2d-offset-winding-chain-incomplete)
  and the parked cases in [KERNEL-CONTRACT.md "Offset: known
  limitations"](KERNEL-CONTRACT.md#offset-known-limitations).

## shape2d-offset-kissing-ring-passes-validation

- **Symptom:** *(Fixed in partforge 0.59 — kept because IDs are permanent.)* Two
  rings produced by the same `Shape2D.offset` call — two eroding holes that grew into
  each other, or a hole that eroded out through its own outer — used to come back
  still separate and overlapping, and extruded to *solid* material inside the pocket
  or a tab of material hanging off the outline.
- **Cause:** The offset validator's ring-crossing test only looked for transversal
  crossings, so two rings that interfere along a shared collinear edge (which is what
  a sharp join produces) registered as fine; and its hole-containment test sampled a
  single point of the hole ring, which stays inside even when most of the ring has
  escaped. The cleanup stage then self-united everything under one even-odd compound,
  where a doubly-covered region cancels back to solid instead of merging.
- **Fix:** Upgrade to partforge ≥ 0.59, where `ringsCross` also tests collinear
  overlap, hole containment tests the whole ring, and cleanup unites the outers and
  *subtracts* the united hole rings. Nearby holes now merge into one hole and a
  near-edge hole is clipped by its eroded outer. If a ring count still looks wrong
  after an inward offset, see
  [shape2d-offset-waist-not-severed-round-join](#shape2d-offset-waist-not-severed-round-join).

## shape2d-offset-winding-chain-incomplete

- **Symptom:** `contour-winding: could not chain offset boundary (incomplete intersection
  set)` thrown from `Shape2D.offset` (or `offsetPolygon`) after a raw offset self-overlaps
  at a narrow pinch.
- **Cause:** *(Known corpus fixed in partforge 0.60, fold-apex case in 0.68.1; ID retained
  permanently.)* The resolver
  used to classify every boundary piece from one fixed midpoint probe. At a narrow cell that
  probe could cross a nearby non-incident edge, read the wrong winding on both sides, and
  drop a real continuation. Fully eroded round text counters were a separate upstream cause:
  their raw offset could retain a negative pocket even under a correct Positive fill. A third
  cause survived to 0.68.1: at a hairpin fold the antiparallel return branch is the probe
  anchor's immediate ring neighbour, which the clearance measurement blanket-excluded as
  incident geometry — the probe stepped across the fold and kept an interior piece
  (italic-sheared whole-word text was the reproduction).
- **Fix:** Upgrade to partforge ≥ 0.68.1. The classifier chooses among deterministic
  interior samples by local boundary clearance, caps its probe distance accordingly, and
  counts a fold-back neighbour edge (direction reversed against the anchor's) as an
  obstruction rather than incident geometry.
  Positive round offsets also decide counter collapse from the source hole's inradius before
  generating a raw outline. On the committed 36,090-offset corpus
  (`node scripts/offset-rates.mjs`), chain failures before the retry ladder are
  0 round / 1 chamfer / 1 sharp and **zero remain after it**; the full glyph matrix,
  including `"Scott"` through +3, has no throw or topology divergence.

  The literal error remains intentionally loud if a new pathological arrangement defeats
  every retry rung. If it appears on ≥0.68.1, report the profile, delta, and corner style so it
  can become a deterministic fixture. Reducing `|delta|` or simplifying nearly coincident
  features is a temporary workaround; changing corner style is not a reliable general fix.

## fillet-chamfer-radius-does-not-fit

- **Symptom:** *(partforge ≥ 0.69 — a WARNING, no longer a throw.)* `filletProfile: corner <i> at (<x>, <y>): r=<r> does not fit — clamped to <m>` (or `chamferProfile: … dist=<d> does not fit — clamped to <m>`) from `Shape2D.fillet`/`.chamfer` or the free `filletProfile`/`chamferProfile` functions, and the corner comes back rounded at `<m>` rather than at what was asked for.
- **Cause:** The requested radius/distance exceeds what the corner's adjacent edges (or curved neighbor) can hold before the tangent point runs past the segment's own end.
- **Fix:** Usually nothing — the clamp is the designed degrade, and `<m>` is the largest magnitude that corner can hold. It throws only when a corner admits **no** valid magnitude at all. If the exact radius is functionally required (a bearing seat, a mating fit), the part must give the corner longer edges or select fewer corners; assert it in a `verify` block rather than trusting the request. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Editing profiles".

Variant literal for a curve-adjacent corner: `filletProfile: corner <i> at (<x>, <y>): r=<r> does not fit against the curved segment — clamped to <m>` (`chamferProfile: … dist=<d> …` for chamfer). Its ceiling is bisected rather than closed-form, and the residual throw (`could not fit r=<r> against the curved segment; max ≈ <m>`) survives for a corner where the solver finds no valid radius at all.

## fillet-chamfer-corners-overlap

- **Symptom:** *(partforge ≥ 0.69 — normally a WARNING now.)* `filletProfile: corner <i>: r=<r> overruns the edge it shares with a neighbouring corner — clamped to <m>`. The throw `filletProfile: corners <i> and <j> overlap on segment <k> (reduce r)` survives only as a backstop, when eight successive back-off passes still cannot fit the pair.
- **Cause:** Two adjacent selected corners each claim more of the edge between them than it has — their combined setbacks exceed the segment's length (or curved arc-length span).
- **Fix:** Usually nothing — both corners are scaled down until they fit (exactly, in one step, on a straight shared edge; geometrically on a curved one). Fillet/chamfer only one of the two corners if you would rather keep the other's full radius. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Editing profiles".

## profile-query-needs-single-contour

- **Symptom:** `profilePointAt: pass a single contour (use region.outer / region.holes[i])` (same shape from `profileLength`/`profileTangentAt`, with their own name in place of `profilePointAt`).
- **Cause:** The arc-length queries (`profileLength`, `profilePointAt`, `profileTangentAt`) are single-contour by nature, and a `{outer, holes}` region or region array was passed instead of a specific contour.
- **Fix:** Pass `region.outer` or `region.holes[i]`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Editing profiles" polymorphic input contract.

## validate-profile-regions-overlap-or-nest

- **Symptom:** `regions overlap or nest — merge with union() or make it a hole` in a `validateProfile(...).issues` entry (`type: "nesting"`) — reported, never thrown.
- **Cause:** Two regions in the profile occupy overlapping area without one being declared a hole of the other.
- **Fix:** Union the two regions into one shape, or restructure the overlapping region as a `holes` entry of its container. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Editing profiles" — run `validateProfile` after mutations.

## extrude-empty-shape2d

- **Symptom:** `extrude: the profile Shape2D is empty — nothing to build (a cut/intersect may have removed everything; guard with .isEmpty())` (or the `revolve:` twin), often only at certain parameter values.
- **Cause:** A 2-D boolean chain legitimately produced an empty shape — an `intersect` of disjoint shapes, or a `cut` that removed everything — and the part handed it to `extrude`/`revolve`. Both backends reject this identically; a silently empty solid would just move the mystery downstream (missing geometry, failing `verify` volume gates).
- **Fix:** If the emptiness is a surprise, check the boolean operands' placement (`boundingBox()` on each side). If it's a legitimate vanishing feature (a parameter can drive it to nothing), guard the materialization: `if (!pocket.isEmpty()) body = body.cut(pocket.extrude({ h }))`. See [KERNEL-CONTRACT.md](KERNEL-CONTRACT.md) § "Empty shapes".

## curve-fill-resolved-hole-uncontained

- **Symptom:** `curve-fill: resolved hole has no containing outer`
- **Cause:** paper.js returned an unexpected or numerically degenerate path topology for the supplied font outline; the resolver refuses to attach the hole to an arbitrary outer.
- **Fix:** reduce or normalize degenerate font contours, confirm the correct CFF/TrueType fill rule was selected, and add the glyph as a focused `curve-fill.test.js` regression before changing resolver tolerances.

## animation-plays-choppy

- **Symptom:** An animation stutters or updates a few times a second instead of smoothly; `?debug` shows `rebuilt` counts climbing during playback.
- **Cause:** A track drives a param that feeds real geometry (or a build the pose probe can't trust — a query op or function selector), so every frame is a worker rebuild instead of a pose repair.
- **Fix:** Run `npx partforge lint <part>` — the `animation-track-rebuilds` note names the track. Restructure so the param only feeds rigid placement (`place()` or a trailing translate/rotate in `build`), or accept best-effort playback if geometry morphing is the intent. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Animations".

## phantom-edges-on-curved-surface

- **Symptom:** edge lines or hard-shaded patches appear scattered on a smooth
  curved surface (a sphere, fillet, or blend) in the viewer or in `render` PNGs.
- **Cause:** the mesh reached the viewer without kernel `normals`/`edges`, so a
  consumer fell back to dihedral-angle guessing on coarse preview tessellation.
- **Fix:** the backend's `toMesh` must return analytic normals and filtered
  feature edges ([KERNEL-CONTRACT.md](KERNEL-CONTRACT.md) "Shading intent") —
  fix the backend or payload plumbing; do not tune viewer angle thresholds.

## faceted-loft-previews-smooth

- **Symptom:** an intentionally faceted loft (low-side-count rings) previews
  smooth-shaded, but exports/prints show flat facets.
- **Cause:** the loft's shading policy resolved to smooth — a `shading:
  "smooth"` hint, `ruled: false`, rings with 32+ sides, or (for curve/resample
  rings) the smooth-shaded section came from a smoothly tessellated contour
  span — arcs/Béziers shade smooth per SECTOR, while sharp corners and
  silhouette-kink rings flat-shade with a dividing line.
- **Fix:** pass `shading: "faceted"` to `k.loft` (or drop the smooth-implying
  option) per [AUTHORING-PARTS.md](AUTHORING-PARTS.md) shading-intent note.

## loft-ring-multi-region-shape2d

- **Symptom:** `loft: ring 0 is a Shape2D with 2 regions — a loft ring must be a single closed outline (union the regions into one, or loft each separately)`
- **Cause:** the Shape2D handed to a loft ring holds several disjoint outlines (usually the result of a union that never overlapped).
- **Fix:** loft each region as its own solid and union the lofts, or rebuild the profile so the outlines actually merge into one. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API" (`loft` rings).

## loft-ring-has-holes

- **Symptom:** `loft: ring 0 has holes — loft rings must be hole-free outlines (cut the holes from the lofted solid instead)`
- **Cause:** the ring Shape2D has an inner contour (a `.cut()` inside the outline). Lofting hole tunnels needs its own correspondence and is not supported.
- **Fix:** loft the outer outline, then `.cut()` a second loft (or an extrusion) of the hole profile from the solid. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API" (`loft` rings).

## loftsmooth-corner-count-mismatch

- **Symptom:** `loftSmooth: every section must have the same corner count — section 1 has 0, section 0 has 2`
- **Cause:** one section carries a `sharp` list (or is a curve contour with corner joints) and another doesn't — every control section must resolve to the same corner count `m` (tagged or implicit), so correspondence across sections is unambiguous.
- **Fix:** tag the same corners on every section (or none) — a curve section's corners come from its own line/arc joints, so match that count with `sharp` on the point sections it lofts alongside. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md)'s `k.loftSmooth` row.

## loftsmooth-closed-needs-manifold

- **Symptom:** `loftSmooth: closed:true loops are only supported on the Manifold backend`
- **Cause:** the part routed to OCCT — STEP export, or an explicit `meta.backend: "occt"` — and `closed: true` loft loops aren't supported there, same restriction as `k.loft`'s `closed`.
- **Fix:** drop `closed` for a part (or sub-part) that needs STEP export, or keep it mesh-only (no STEP, no `meta.backend: "occt"`). See the `loftSmooth` row in [KERNEL-CONTRACT.md](KERNEL-CONTRACT.md).

## loftsmooth-looks-faceted

- **Symptom:** a `loftSmooth` solid shows flat facets around the cross-section, in preview or in STEP, even though nothing errored.
- **Cause:** `samples` governs curve-*fit* resolution — how many cubic-Bézier spans the emitted ring is cut into — not a facet count, on **either** backend. A B-rep kernel lofts each span as one exact curve edge, so STEP is curve-exact around every ring regardless of `samples`; too few spans just means the fit follows the control sections less faithfully (a visible corner or fast bend flattens). A mesh kernel doesn't facet one triangle per span either — `k.loft`'s curve mode adaptively subdivides each span by curvature at the shared `LOFT_SEGS = 64` budget (`loft-rings.js`'s `segNaturalCount`/`sampleBezier`), so around-ring facet density comes from that curve LOD, and rises with `samples` only because more spans means more things to subdivide, not proportionally.
- **Fix:** raise `samples` (default `max(64, largest section)`, clamp ≤ 2048). If the banding runs along the spine instead, raise `stations`. See the `loftSmooth` row in [KERNEL-CONTRACT.md](KERNEL-CONTRACT.md).

## loftsmooth-zero-perimeter-arc

- **Symptom:** `loftSmooth: a control section has zero perimeter`
- **Cause:** two sharp-tagged vertices (or two contour corners) in the same section are numerically coincident, so the arc between them has zero length — e.g. tagging *both* ends of a closed NACA trailing edge, whose closure coefficient already brings them to the same point (or the same point after a per-section `rotate`). This also fires for the v1 meaning of the message: a genuinely degenerate section.
- **Fix:** tag only one of the coincident vertices as the corner (see `src/parts/propeller.js`'s `sharpTE` comment for why a second tag there would create exactly this zero-length arc). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md)'s `k.loftSmooth` row.

## loftsmooth-stations-out-of-range

- **Symptom:** `loftSmooth: stations must be 2…1024 (or "controls")` — an explicit `stations` was rejected.
- **Cause:** `stations` is clamped to 2…1024 (a preview/export density guard); a non-integer, non-finite, or out-of-range value throws. The default (8 per span + 1 open, 8 per section closed) caps itself at 1024, so omitting the option never trips this.
- **Fix:** pass an integer in 2…1024, or omit `stations` for the capped default. More rings than 1024 along the spine is a density smell — the surface is already spline-smooth between stations; raise `samples` instead if the banding is around the ring. See the `loftSmooth` row in [KERNEL-CONTRACT.md](KERNEL-CONTRACT.md).

## loftsmooth-samples-out-of-range

- **Symptom:** `loftSmooth: samples must be 8…2048` — an explicit `samples` was rejected.
- **Cause:** `samples` is clamped to 8…2048. The default `max(64, largest section)` caps itself at 2048, so omitting the option never trips this — even when a control section has more than 2048 points.
- **Fix:** pass a `samples` value in 8…2048, or omit it for the capped default — and thin any control section above ~2048 points: `loftSmooth` interpolates a smooth outline through sparse control points, so sections that dense defeat the sparse-sections design (pass the dense rings straight to `k.loft` instead). See the `loftSmooth` row in [KERNEL-CONTRACT.md](KERNEL-CONTRACT.md).

## duplicate-preset-name-throws

- **Symptom:** `duplicate preset name across sections:` thrown from verify/measure, naming the repeated preset (e.g. `duplicate preset name across sections: "Compact"`).
- **Cause:** The same preset name is declared twice — once via the legacy `presets` field, once as a `{ type: "preset" }` node, or twice within either.
- **Fix:** Rename one of them; `npx partforge lint` reports it statically as `duplicate-preset-name` before verify ever runs. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Rule catalog".

## when-condition-never-true

- **Symptom:** A control, group, preset, readout, or section with a `when` condition never appears, with no error anywhere.
- **Cause:** The condition references a key `defaults` doesn't declare (reads `undefined`, which every comparison treats as false) or a typo'd operator (`evalWhen` treats an unrecognized operator as false too).
- **Fix:** Run `npx partforge lint` — `when-key-not-in-defaults` or `when-unknown-operator` names the offending key or operator. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Rule catalog".

## readout-shows-em-dash

- **Symptom:** A `{ type: "readout" }` control renders "—" forever, no matter what the other controls are set to.
- **Cause:** The readout's `derivedKey` names a key that no `derive()` group actually produces.
- **Fix:** Name a key a `derive` group returns, or add that key to `derive`; `npx partforge lint` warns via `readout-unknown-derived-key`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Rule catalog".

## select-default-unreachable

- **Symptom:** The panel opens showing a `select`/`radio` value the control can never be set back to by interacting with it.
- **Cause:** `defaults[key]` is not among the control's `options` values — often a value-type mismatch (`12` is not `"12"`).
- **Fix:** Add the default to `options`, or change the default to one of the existing options; `npx partforge lint` errors via `select-default-not-in-options`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Rule catalog".

## screw-thread-vanishes-on-occt

- **Symptom:** a threaded part previews correctly but its STEP export is a plain
  cylinder, or a valid-looking but implausibly small STEP file (~2 KB, a few
  dozen entities, where a real thread is megabytes) that opens with no solid
  geometry; on the OCCT backend the union of a thread with a core returns
  exactly the core's volume, or `0`, with no error thrown.
- **Cause:** the thread was built as a thin sub-pitch helical sliver and unioned
  onto a core. OCCT's boolean fails on a near-self-touching swept operand and
  silently returns the other operand — or nothing — rather than throwing.
- **Detected:** since partforge 0.110 the boolean result gate refuses both
  outcomes instead of shipping them — `boolean result invalid: union dropped an
  operand` when the core comes back alone
  ([boolean-dropped-operand](#boolean-dropped-operand)), `… produced an
  impossible result` when nothing does
  ([boolean-impossible-result](#boolean-impossible-result)). The fix below is
  unchanged; the symptom is now a build error naming it.
- **Fix:** build the thread in the **periodic** form instead — a profile spanning
  exactly one `pitch` with equal first and last radius encloses the axis, so
  `k.screwSweep` yields the whole threaded body with no boolean at all. See
  [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Helical & threaded features".

The hazard is specific to that sliver-riding-a-core shape, not to unions
involving screw geometry in general: a filled periodic `screwSweep` rod
unioned with an unrelated solid — a bolt head, say — booleans correctly. A
measured rod (585.545) unioned with a head (804.248) returned 1324.732 —
inside the geometrically expected range, not the bare-rod or empty-solid
signature above. It's the thin near-self-touching sliver that OCCT's boolean
mishandles, not screw geometry as such.

## occt-bbox-too-large-on-twist

- **Symptom:** `solid.boundingBox()` inside a `build()` reports a solid far larger
  than it is — on a twisted solid (`extrude`/`prism` with `twist`, or
  `k.screwSweep`) whose true max radius is 5, OCCT reports **7.209** where
  Manifold reports **5.000** — so anything placed off that query lands ~44% too
  far out in the STEP export while the preview looks right. The axial extent is
  exact; it is the twisted directions that inflate.
- **Cause:** OCCT derives the bounding box of a twisted B-spline surface from its
  **control hull**, not from the surface. The control points of a twisted section
  bow outward, so the box is a valid outer bound but a loose one. Volume and the
  meshed surface are exact; only the bbox query is loose.
- **Fix:** don't place geometry off `solid.boundingBox()` on a twisted solid —
  compute the extent from the parameters that built it (they are right there in
  `p`/`d`), or bound the twisted part with an untwisted proxy solid.

**The `measure` / `verify` gate is not affected**: `src/framework/oracle/measure.js`
takes its bbox from `bounds(mesh.positions)` — the meshed surface — never from
`solid.boundingBox()`, so `bbox` assertions read 5.000 on both backends. The
exposure is a `build()` that queries a twisted solid's box itself, which is the
normal idiom for placing something relative to a solid and now silently disagrees
between the Manifold preview and the OCCT STEP export.

## import-mesh-not-solid

- **Symptom:** `import "<name>": mesh is not a solid after repair (<n> open edges) — repair it in a mesh tool or re-export watertight (<reason>)` thrown while registering a part's `imports` on the Manifold backend — the trailing `(<reason>)` always appears (it wraps the underlying Manifold error, e.g. `non-manifold edge` or `empty result`), never omitted.
- **Cause:** Basic repair (vertex merge + winding/orientation fix) couldn't close the mesh into a solid — the source STL/3MF has an open shell, missing faces, or another defect beyond what v1's repair pass attempts. The open-edge count and the wrapped `<reason>` in the message together narrow down the gap.
- **Fix:** Close the mesh in a dedicated mesh-repair tool, or re-export it watertight from the tool that produced it; there is no in-framework hole-filling/remeshing. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Importing geometry (STEP/STL/3MF)".

## import-unrecognized-format

- **Symptom:** `unrecognized import format for "<path>" — use a .step/.stl/.3mf extension or non-empty bytes` (the `for "<path>"` clause is omitted for a bytes/thunk source with no path) thrown while resolving a part's `imports`.
- **Cause:** Format detection couldn't identify the source: no `.step`/`.stp`/`.stl`/`.3mf` extension on a URL/string source, and the bytes are empty or start with neither a STEP header (`ISO-10303-21`) nor a zip signature (3MF) — the ASCII/binary STL fallback needs non-empty bytes too.
- **Fix:** Give the source a recognized extension, or make sure inline/fetched bytes are non-empty and actually STEP/STL/3MF content. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Importing geometry (STEP/STL/3MF)".

## import-unknown-name

- **Symptom:** `import: unknown import "<name>"` — declare it in the part's `imports` field — thrown from a build, identical text on both backends.
- **Cause:** `k.import(name)` was called with a name that isn't a key in the part's `imports` field — a typo, or the declaration was never added. Same failure shape as `text2d`'s unknown-font error.
- **Fix:** Add the name to `imports`, or fix the typo. `npx partforge lint <part>` catches this statically, in microseconds, before any kernel boots (`import-unknown-name`). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Importing geometry (STEP/STL/3MF)" and § "Linting" (Rule catalog → Geometry imports).

## import-mesh-on-occt

- **Symptom:** `import "<name>": STL/3MF imports need the Manifold backend — this build routes to OCCT (shell or meta.backend, or a fillet/chamfer rerouted for an unsupported edge class); use the mesh import from a Manifold-routed build` thrown from a build calling `k.import(name)`.
- **Cause:** STL/3MF imports are mesh geometry; mesh-to-B-rep conversion is never attempted, so a declared mesh import registers as an unusable error entry wherever the routed kernel is OCCT — thrown lazily, at the `k.import()` call inside `build`, not when the import is registered (registration itself never throws — see "Registration is total; errors are lazy" in [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Importing geometry (STEP/STL/3MF)").
- **Fix:** Per-sub-part Manifold/OCCT coexistence is a **browser-preview-only** convenience — `npx partforge lint`/`measure`, and any single-worker export (STL/STEP/3MF), route by `detectBackend`, the **max over every sub-part**, so a mesh import still fails there even while sitting on a nominally Manifold-routed sub-part, as long as some OTHER sub-part in the same part routes to OCCT (a `shell` call or `meta.backend: "occt"` statically; since contract v3 a `fillet`/`chamfer` routes only at runtime, when its edge class falls outside the mesh blend — see mesh-fillet-unsupported-edge, below). Putting the import on a Manifold sub-part only helps the live preview; it does not clear this error. Pick one: split the mesh-importing sub-part out into its **own separate part** (a different `PartDefinition`) that has no OCCT-only ops, replace the source with a STEP file instead (STEP tessellates transparently on Manifold via the crossover — see import-step-tessellation-failed, below), or drop the CAD-only op / `meta.backend` pin so the whole part routes to Manifold. `npx partforge lint <part>` catches an extension-detectable case statically, before any kernel boots (`import-mesh-on-occt`).

## import-step-tessellation-failed

- **Symptom:** `STEP import tessellation failed to satisfy the import — see console` in the browser (a build's status/error), or `step tessellation thread exited <n>` from a failed Node CLI/test run.
- **Cause:** A STEP import used on the Manifold backend needs OCCT-tessellated triangles first (the "crossover" described in [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Importing geometry (STEP/STL/3MF)"). This hop is meant to self-heal — the browser worker requests a `tessellate-imports` job from the OCCT worker, Node hops through a `node:worker_threads` isolate (the two WASM kernels may never share a process) — but it surfaces here when the tessellation either delivered a mesh whose digest didn't match what Manifold now expects (a genuinely broken state, not a retry loop) or the worker/thread exited without completing.
- **Fix:** This should be rare and self-resolving on the next build; if it persists, confirm the STEP file parses under OCCT on its own (e.g. `meta.backend: "occt"` temporarily, or `npx partforge measure` against an OCCT-routed copy of the part) to rule out a malformed STEP file, and check the console/thread output for the underlying tessellation error being wrapped.

## vector-unknown-name

- **Symptom:** `vector2d: unknown vector "` followed by the name and — declare it in the part's `vectors` field — thrown from a build calling `k.vector2d(name)`.
- **Cause:** `k.vector2d(name)` was called with a name that isn't a key in the part's `vectors` field — a typo, or the declaration was never added. Same failure shape as `text2d`'s unknown-font error and `k.import`'s unknown-name error.
- **Fix:** Add the name to `vectors`, or fix the typo. `npx partforge lint <part>` catches this statically, in microseconds, before any kernel boots (`vector-unknown-name`). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Vector geometry" and § "Linting" (Rule catalog → Vector geometry).

## vector-size-required

- **Symptom:** `a size is required for artwork units` — with the declared `vectors` name in front of it (`vector2d: "logo" a size is required …`) — pass one of `{ width }`, `{ height }`, or `{ fit }` in millimetres — thrown from a build calling `k.vector2d`.
- **Cause:** The named document is `units: "artwork"` and the call passed none of `width`, `height`, or `fit`. Artwork coordinates carry no physical meaning (an SVG `viewBox` unit is not a length), so there is no safe default to fall back on — a deliberate asymmetry with `k.text2d`, whose `size` can default because a cap height is a real measurement. A `units: "mm"` document never raises this: its coordinates already are millimetres, so it places at scale 1 with no size option at all.
- **Fix:** Pass exactly one of `width`/`height`/`fit`, in millimetres — or, if the file's coordinates really are millimetres, re-author it with `"units": "mm"` and drop the size option entirely (do not do both: see vector-mm-shapes-misscaled below). `npx partforge lint <part>` catches an options-literal call statically (`vector-size-missing`) before any kernel boots. The in-app lint job catches it too, once the vector file has been fetched — it reads only already-resolved documents, so lint stays instant and offline, and this rule is silent until the first build has loaded the artwork. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Vector geometry" and [docs/VECTOR-FORMAT.md](VECTOR-FORMAT.md) § "Units".

## vector-size-options-conflict

- **Symptom:** `pass only one of width, height, or fit` — led by the declared `vectors` name (`vector2d: "logo" pass only one of …`) — followed by the ones that were passed — e.g. `— got width, fit` — thrown from a build calling `k.vector2d`.
- **Cause:** Two or more size options in one call. Scaling is always uniform, so a second option would either be ignored or contradict the first; rather than silently preferring one, the op refuses. (Earlier revisions silently preferred `width`, then `height`, then `fit`.)
- **Fix:** Keep the one you meant. `fit` sizes the longer extent of the artwork's tight bounding box, `width`/`height` the named axis; all three scale uniformly, so one is always enough.

## vector-align-invalid

- **Symptom:** `align must be ` followed by the three legal values and the one that was passed — e.g. `vector2d: "logo" align must be "left", "center", or "right" — got "centre"`, or the vertical twin `vector2d: "logo" valign must be "bottom", "middle", or "top" — got "centre"`. Thrown from a build calling `k.vector2d`.
- **Cause:** A typo in `align` or `valign`. The British spelling `"centre"` is far and away the most common; so is reaching for `"middle"` on the horizontal axis or `"center"` on the vertical one, which are each the *other* axis's word. `k.vector2d` refuses rather than falling through to its default, because every value that fails all three comparisons would otherwise silently land the artwork where the caller never asked for it. (The Symptom literal is deliberately `align must be `, without a leading word: `valign must be …` contains it, so one entry routes both messages. Do not "fix" it to `align must be "left"`.)
- **Fix:** Use one of the values the message lists — horizontal is `"left"`/`"center"`/`"right"`, vertical is `"bottom"`/`"middle"`/`"top"`. Omit the option entirely to get the default, which differs by units: an `"artwork"` document re-centres (`center`/`middle`) because its coordinates mean nothing, and an `"mm"` document does not translate at all, because its coordinates already say where the drawing sits. See [docs/VECTOR-FORMAT.md](VECTOR-FORMAT.md) § "Units".

## vector-size-not-positive

- **Symptom:** `must be a positive number of millimetres`, led by the option's own name and the declared `vectors` key — e.g. `vector2d: "logo" width must be a positive number of millimetres`. Thrown from a build calling `k.vector2d`.
- **Cause:** The `width`, `height`, or `fit` option was present but not a finite number greater than zero — `0`, a negative, `NaN`, `Infinity`, or a string. The usual source is arithmetic on a parameter that can reach zero (a slider whose `min` is `0`, or a subtraction that can go negative), not a literal.
- **Fix:** Clamp or floor the expression that produces the size, or give the driving control a `min` above zero. Note that the option is only read when it is non-`null`: to mean "no size", leave it out (or pass `null`/`undefined`) rather than passing `0` — see vector-size-required for what happens then, which depends on the document's `units`.

## vector-artwork-no-extent

- **Symptom:** `to size against`, led by the axis — e.g. `vector2d: "logo" artwork has no width to size against`, or `… has no extent to size against` for a `fit` call. Thrown from a build calling `k.vector2d`.
- **Cause:** The geometry being sized is degenerate on the requested axis: its tight bounding box has (near) zero width, height, or overall extent, so there is nothing for the scale factor to divide by. Usually a document whose contours are collinear or coincident, or a `{ shape }` call naming a shape that is a single flat line. It is not a units problem — an `"mm"` document with a size option hits it just as readily.
- **Fix:** Size against the axis the artwork actually has (`height` instead of `width`, or `fit`, which uses the longer extent), or fix the geometry — a contour that measures zero on an axis is nearly always a drawing mistake rather than an intentional one. `npx partforge measure <part>` prints the bbox, which names the collapsed axis immediately.

## vector-invalid-document

- **Symptom:** `vector2d: "` followed by the declared `vectors` name and a validation complaint — a bad `format` or `version`, a contour with no `kind` or an unknown one, a malformed `"path"` contour or segment (missing `start`, too few segments, an `arc` with no `through`, a `cubic` missing `c1`/`c2`, a non-numeric coordinate), a primitive with a bad `center`/`r`/`width`/`height`, a shape that is neither a region array nor a `{ role, regions }` object, an unknown `role`, a `bbox` that disagrees with the geometry, or (a different message, same `vector2d: "<name>"` lead) `vector2d: "<name>" is not valid JSON — <parse error>` — thrown while resolving a part's `vectors`, before `build` even runs.
- **Cause:** The stored document isn't a well-formed `partforge-vector` file. The single most common case for the "is not valid JSON" variant: `vectors` points at the raw `.svg` file instead of an ingested `.vector.json` — an SVG document is not JSON at all, so it fails to parse before validation ever gets a chance to name a more specific problem.
- **Fix:** If the message says "is not valid JSON," check the source points at the ingested `<name>.vector.json`, not the original `.svg` — re-ingest with `partforge/ingest` (or `npx partforge ingest <file.svg> --out <file.vector.json>`) if you don't have it yet. Otherwise the message names the shape, the 1-indexed region, the role (`outer` / `hole n`), and where applicable the 1-indexed segment, so the fix is a single edit. Several specific cases have their own entries below (vector-units-missing, vector-stale-regions-array, vector-rect-radius-too-large). See [docs/VECTOR-FORMAT.md](VECTOR-FORMAT.md) for the full schema and what each field means.

## vector-units-missing

- **Symptom:** `file has no valid ` followed by `units` and the value found — e.g. `vector2d: "logo" file has no valid \`units\` (undefined) — \`units\` must be "mm" … or "artwork" …` — thrown while resolving a part's `vectors`, before `build` runs.
- **Cause:** The document has no `units` field, or one that is neither `"mm"` nor `"artwork"`. `units` is required and has no default: millimetre coordinates place as authored, artwork coordinates have no physical meaning and need a size at every call site, and guessing between the two would silently produce wrong-scaled geometry. A file hitting this was either hand-authored without the field or written by a converter that predates it.
- **Fix:** Add `"units": "mm"` if the coordinates are millimetres and should place exactly where they are drawn, or `"units": "artwork"` if they came from an SVG (or anything else whose units are not lengths) and should be sized per call site. Ingest always writes `"artwork"`; re-ingesting the source `.svg` fixes a generated file. See [docs/VECTOR-FORMAT.md](VECTOR-FORMAT.md) § "Units".

## vector-stale-regions-array

- **Symptom:** `has a "regions" array, which this build does not read` — followed by `regions now live under a named shape in "shapes"` — thrown while resolving a part's `vectors`.
- **Cause:** The document uses the old flat top-level `regions` array instead of the named-`shapes` envelope. Either a hand-written draft copied from an obsolete example, or a `.vector.json` generated by an older ingest.
- **Fix:** Wrap the regions in a named shape: `{ "shapes": { "artwork": [ …the regions… ] } }`. Nothing else about a region changes — `outer`/`holes` are unchanged — but every contour also needs its `kind` (`"path"` for the explicit `start`/`segments` form). Re-ingesting the source `.svg` produces the current envelope directly. See [docs/VECTOR-FORMAT.md](VECTOR-FORMAT.md) § "Shapes and roles".

## vector-rect-radius-too-large

- **Symptom:** `has "kind": "rect" with radius` followed by the value, the maximum, and `a corner radius cannot be more than half the shorter side` — e.g. `vector2d: "plate" shape "body" region 1 outer has "kind": "rect" with radius 3.5 exceeds the maximum 3`.
- **Cause:** A `"rect"` contour's corner `radius` is greater than `min(width, height) / 2`, where the four corner arcs would overlap. The loader refuses rather than clamping: a format loader has no warning channel, and a radius past half the shorter side is a typo, not a request.
- **Fix:** Reduce `radius` to at most half the shorter side, or enlarge `width`/`height`. Exactly `min(width, height) / 2` is legal and is the fully-rounded case — a square at that radius expands to four arcs and no straight edges (the degenerate zero-length lines are omitted). See [docs/VECTOR-FORMAT.md](VECTOR-FORMAT.md) § "Contour kinds".

## vector-unknown-shape

- **Symptom:** `has no shape ` followed by the requested name and the list the file does declare — e.g. `vector2d: "plate" has no shape "bodyy" — it declares: body, holes, keyway` — thrown from a build calling `k.vector2d(name, { shape })`.
- **Cause:** The `shape` option names a key the document's `shapes` object doesn't have — a typo, or a shape that was renamed in the JSON and not in `build`.
- **Fix:** Use one of the names the error lists, or drop `shape` entirely to get the file's own role-composed result (every `"add"` shape unioned, minus every `"subtract"` shape). `npx partforge lint <part>` catches this statically (`vector-unknown-shape`), and so does the in-app lint job once the file has been fetched — the in-app job reads only already-resolved documents, so the rule is silent until the first build has loaded the artwork. (A caller embedding `lintPart` directly must pass `vectorDocs` itself, or this rule stays silent.) See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Vector geometry".

## vector-mm-shapes-misscaled

- **Symptom:** No thrown error — a `units: "mm"` document's shapes come out wrong *relative to each other*, when they are fetched one at a time with `{ shape }` and composed in `build`. Holes land off-centre or off the part, a subtracted keyway misses the body, features drawn concentric in the JSON are not concentric in the solid. The overall **bounding box is exactly what you asked for and the volume barely moves**, so the giveaway is a hole or feature count rather than a size. Measured on `src/parts/assets/plate.vector.json`: composing its `body`, `holes`, and `keyway` shapes with `{ width: 40 }` on each call yields the same bbox and a volume within 0.1% of correct, but **1 through-hole where the drawing has 3**.
- **Cause:** A size option (`width`/`height`/`fit`) scales the geometry being placed against **that geometry's own** tight bounding box. For a single shape that is right — `{ shape }` is a request for that shape, and nothing else is in the frame. But two `{ shape }` calls on one document get two *different* scale factors whenever the shapes have different extents, which destroys the shared coordinate frame `units: "mm"` exists to provide. Each call is individually well-formed; they are just no longer registered with each other, so nothing throws.
- **Fix:** Don't size a millimetre drawing per shape. In order of preference: let the file compose itself — `k.vector2d(name)` with no `shape` and no size returns every `"add"` shape minus every `"subtract"` one, placed as authored; or, if you need per-shape composition, drop the size options and let the millimetre coordinates place as drawn; or, if the drawing genuinely needs rescaling, compose it first and scale the finished `Shape2D` (or the extruded solid) once, so one transform applies to every shape together. `src/parts/emblem.js`'s `plate` build carries a comment on exactly this. Note that a size on the **composed** call is safe — the whole document is measured and placed as one — and that `units: "artwork"` documents, which have a single shape, are unaffected.

## svg-stroke-collapsed

- **Symptom:** `svg: stroke outline collapsed — stroke-width is too large for this shape` thrown during ingest (`partforge/ingest`'s `ingestSvg`).
- **Cause:** A stroked element's `stroke-width` is large enough, relative to the shape it strokes, that outlining the stroke (offsetting the path by `±w/2` and joining the results — see [docs/VECTOR-FORMAT.md](VECTOR-FORMAT.md) § "Converting an SVG to this format by hand") produces no valid ring — the offset consumed the entire shape.
- **Fix:** Reduce `stroke-width` on the offending element, or thicken the path it strokes, in the source SVG, then re-ingest. This is a property of the artwork, not something `k.vector2d` or the part can work around at build time — ingest has already discarded the original stroke by the time a build runs.

## svg-no-geometry

- **Symptom:** `svg: no painted geometry — every element is fill="none" with no stroke, hidden, or empty` thrown during ingest.
- **Cause:** Every element in the SVG document either has no `fill` and no (`stroke` + positive `stroke-width`), or the document has no paintable elements at all (e.g. only `<defs>`, only groups with nothing visible, or the whole thing is empty). `partforge/ingest` skips unpainted elements silently — this error fires only when *nothing* in the whole document painted anything.
- **Fix:** Confirm the SVG actually has visible fill/stroke — a common cause is authoring artwork entirely inside `<defs>`/`<symbol>` with no `<use>` anywhere that references it, or a `<use>` whose `href`/`xlink:href` targets an `id` that doesn't exist in the document, or an accidental `fill="none"` with no `stroke` on every element. (Both `href` and the legacy `xlink:href` spelling are resolved — this is not a spelling issue.) Fix the source SVG and re-ingest.

## svg-painting-order

- **Symptom:** No thrown error — a shape that looks like it has a hole in an SVG editor (or in a browser rendering the SVG directly) comes out **solid** through `k.vector2d`.
- **Cause:** The artwork fakes the hole by painting a background-colored shape *on top of* another shape, rather than actually cutting a hole (one path, two subpaths, opposite winding or `fill-rule="evenodd"`). Painting order is not modelled by this format at all — every ingested region adds material unconditionally, and colour is read only as present-or-absent, never compared between elements, so "painted over" and "not there" are indistinguishable once ingest has run. See [docs/VECTOR-FORMAT.md](VECTOR-FORMAT.md) § "Painting order is not modelled".
- **Fix:** Either make it a real hole in the source artwork (one `<path>` element with two subpaths and `fill-rule="evenodd"`, or two subpaths wound oppositely under `nonzero`) and re-ingest; or move the "hole" geometry into its own shape in the JSON with `"role": "subtract"`, so the document composes correctly on its own (an edit that a re-ingest overwrites); or leave the artwork as-is and subtract the "hole" shape in the part with `.cut()` instead of relying on ingest to infer it from paint order.

## svg-overlapping-subpaths

- **Symptom:** No thrown error — an ingested artwork is missing area where shapes overlap, so it comes out slightly too small or a detail is hollow that should be solid. `doc.bbox` is correct; only the filled area is short.
- **Cause:** Ingest calls `resolveCurveFill` (`src/framework/geometry/curve-fill.js`) per-*element*, to resolve one `<path>`'s own subpaths under its fill rule. Two of the three routes through it are exact: even-odd XORs the subpaths, and nonzero over subpaths that all wind the same way takes their union. The third — nonzero over subpaths of *mixed* winding — resolves nesting with paper.js rather than evaluating winding numbers, and diverges in one case: where a subpath wound *against* the others covers area that two or more same-wound subpaths already cover, true nonzero keeps it (winding 2 − 1 = 1) and this drops it. Closing that needs a real planar arrangement, not a fold of pairwise booleans. Pinned by `test/curve-fill.test.js`'s "KNOWN DIVERGENCE" test, and bounded by the same file's glyph-by-glyph check against Manifold's own NonZero fill across the bundled charset.
- **Fix:** Give the subtractive subpath its own `<path>` element (with its own `fill`) in the source SVG and re-ingest — separate elements are combined by `booleanRegions`, a real union, which does not go through this route. Or set `fill-rule="evenodd"` on the element if that expresses the same intent, since even-odd is exact. Note this is *not* the older, much broader defect where any two overlapping same-winding subpaths lost their union outright and even-odd threw "resolved hole has no containing outer"; both of those are fixed.

## mesh-fillet-unsupported-edge

- **Symptom:** `fillet: ` or `chamfer: ` followed by an edge-class reason — e.g. `edge curve is not circular`, `flank angle varies along the arc`, `selector matched no sharp edges`, `~180° knife edge` — thrown as a `KernelCapabilityError`, or a preview sub-part silently rebuilding on the slow OCCT worker.
- **Cause:** The mesh backend's native fillet/chamfer (`mesh-fillet.js`) covers straight and circular-arc sharp-edge chains; the selected edges fall outside that (helical edge, varying dihedral, non-circular curve, or nothing sharp matched), so the op signals `NEEDS_OCCT` and the framework reroutes that sub-part (the CLI re-execs once with `PARTFORGE_BACKEND=occt`).
- **Fix:** Usually nothing — the reroute is the designed degrade and the OCCT result is correct, just slower. To stay on Manifold, restructure so the blend lands on a supported edge class (design the rounding into the profile, or fillet before the boolean that curves the edge). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Fillet, chamfer & shell".

## mesh-fillet-oversized-radius

- **Symptom:** A Manifold-built fillet/chamfer produces a mangled or over-cut shape (no error), where the same part on OCCT would skip the feature with a `fillet(…) failed` warning.
- **Cause:** The mesh fillet does not validate radius feasibility — a magnitude larger than the local geometry self-intersects its cutter solids and the booleans happily apply them.
- **Fix:** Clamp the magnitude against local dimensions in the part (`Math.min(p.fillet, halfWidth - 0.5, …)` — see `src/parts/filleted-box.js`), which is required practice on the mesh class per [KERNEL-CONTRACT.md](KERNEL-CONTRACT.md) § "Mesh degrade policy".

## feature-skipped-warning

- **Symptom:** The build succeeds but its result carries a warning like `fillet 1.15 failed (<reason>) — feature skipped, edges left sharp` (mesh backend), or `fillet(2) failed (…) — feature skipped` / `chamfer 3 over-ran the geometry — reduced to …` (OCCT repair policy), and the rendered part is missing the blend.
- **Cause:** *(partforge ≥ 0.69.)* A fillet/chamfer the geometry (or its own selector) defeats no longer fails the whole build on either backend: the op returns its input solid unchanged, everything downstream still applies, and the skip is recorded on the build result's `warnings` (`kernel.takeBuildWarnings()` / the `meshes` message's `warnings: [{part, message}]`).
- **Fix:** Read the parenthesized reason. A bad selector (unknown plane, wrong `at` height) is a part bug — fix the selector. A geometry-defeated blend usually wants a smaller magnitude or simpler input (clamp per the entry above), or the feature deliberately left off. Treat the warning as "this feature did not land", never as a cosmetic note — the shape on screen genuinely lacks it.

  The same channel carries every other degrade in a build: an `extrude` rim bevel reduced or skipped (`extrude bevel <b> …`), a `roundedBox` rim radius clamped to `round.side`, and the `Shape2D` corner-op clamps in the two entries above. The same channel also carries [profile-self-intersects](#profile-self-intersects) — a hand-authored outline that crosses itself and built with inverted fill. A build result's `warnings` is the complete list of what the part asked for and did not get — or, for `profile-self-intersects`, asked for and should not have.

## control-default-not-literal

- **Symptom:** A control works live — the slider moves, the geometry updates — but the user's panel edits are gone when the part is reopened. Nothing throws anywhere.
- **Cause:** The control's `defaults` entry is written as something other than a plain literal — an expression (`13 / 3`), an array or object, a template literal, a hex/`1_000` spelling. Hosts persist a panel edit by rewriting that value's span in the source, so a value the rewriter cannot read is skipped and the edit is silently lost. The evaluated-object lint cannot see this (`13 / 3` evaluates to an ordinary number); only the source says.
- **Fix:** Write the computed value as a plain decimal/string/boolean literal, or move the computation into `derive()`. `lintPart(part, { sources })` and the CLI report this as the error `control-default-not-literal` with file and line. Only a **visible** control's default is checked — a statically hidden one (`hidden: true` on the control, group or section) renders no widget, so there is no panel edit to lose, and an expression there is legitimate. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Linting" (Rule catalog → Source rules).

## impure-source-token

- **Symptom:** The preview shows stale geometry after a parameter edit, or a part behaves differently across rebuilds with identical params — often intermittent.
- **Cause:** The source contains `Math.random`, `Date.now`, `performance.now`, or an argless `new Date()`. A build must be a pure function of `(k, p, d)`; the memoizing kernel hashes inputs, so an impure value silently serves stale geometry (see impure-build-stale-preview, above). The behavioral lint probe catches impurity only when it changes the recorded call sequence between two probe runs; a value stable within one pass escapes it, which is why the source scan warns on the token itself.
- **Fix:** Replace the impure value with a parameter or a `derive()` output. `new Date(0)` and other argument-carrying forms are deterministic and not flagged; only `.js`/`.mjs` files are scanned, so the same words in a `README.md` are prose. One finding is emitted per (file, token) pair, carrying the occurrence count and the first occurrence's line. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Caching & determinism".

## heightfield-unknown-image

- **Symptom:** `heightfield: unknown image "<name>"` — declare it in the part's `images` field — thrown from a build calling `k.heightfield(name, opts)`, identical text on both backends.
- **Cause:** `k.heightfield` was called with a string name that isn't a key in the part's `images` field (or `images` is missing entirely) — a typo, or the declaration was never added. Same failure shape as `k.import`'s unknown-name error and `text2d`'s unknown-font error.
- **Fix:** Add the name to `images`, or fix the typo. `npx partforge lint <part>` catches this statically when `images` is a static object (rule `heightfield-unknown-image` — a function-form `images` has no statically-knowable keys, so lint skips it there and this throw remains the runtime authority). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Linting" (Rule catalog → Image controls).

## images-only-png-supported

- **Symptom:** `images: only PNG is supported — convert with imageToPng() from "partforge/ingest" before storing, or have the host normalize on upload` thrown while resolving a part's `images`.
- **Cause:** The image resolver checks the first four bytes against the PNG magic number before decoding; a JPEG, WEBP, or any other format fails that check immediately; a heightfield source is a depth map and needs a single well-defined decode path, so no other format is attempted.
- **Fix:** Convert the source to PNG before it reaches `images` — call `imageToPng()` (exported from `"partforge/ingest"`, browser-only: it draws through a `<canvas>`) in the host's upload/panel handler, or pre-convert with any image tool. Bytes that are already PNG (the 4-byte signature `89 50 4E 47`) skip this check entirely.

## png-interlaced-unsupported

- **Symptom:** `decodePng: interlaced (Adam7) PNGs are not supported — re-save without interlacing` thrown while resolving a part's `images`.
- **Cause:** The bundled PNG decoder implements only the non-interlaced scanline layout (interlace method 0); an Adam7-interlaced PNG (interlace method 1 — some export tools and "optimized" PNGs default to it) stores pixels in seven interleaved passes the decoder doesn't reassemble.
- **Fix:** Re-save the PNG without interlacing (most editors/optimizers have a plain "none"/"no interlace" option), or run it back through `imageToPng()` — canvas re-encoding never interlaces.

## heightfield-sew-failed

- **Symptom:** `heightfield: could not sew <n> triangles into a B-rep solid (<reason>). Raise \`pitch\` to reduce the triangle count, or build this sub-part on the Manifold backend.` thrown on the OCCT backend.
- **Cause:** OCCT's heightfield path triangulates the depth-map grid the same way Manifold does, then goes mesh → STL → B-rep (`StlAPI_Reader` + `ShapeUpgrade_UnifySameDomain` + `MakeSolid`) so the result can boolean/fillet/export to STEP like any other B-rep shape. That sewing step can fail outright on a large or high-frequency grid — before failure, a triangle count above the plan's measured threshold already emits a slow-sew/large-STEP warning on the same build (see `feature-skipped-warning`'s sibling channel), and this is what happens when the grid is pushed further still.
- **Fix:** Raise `pitch` on the `k.heightfield` call to coarsen the grid (fewer triangles to sew), or keep this sub-part on the Manifold backend (drop the `meta.backend`/CAD-op pin forcing OCCT) — Manifold's heightfield path never sews through OCCT, so it has no equivalent failure mode. STEP export specifically needs OCCT, so a part that must export a relief to STEP has to bring the triangle count under the sewable range rather than avoid OCCT.

## profile-self-intersects

- **Symptom:** The build succeeds and its result carries a warning like `extrude: profile self-intersects near (12.3400, -6.3800) — the outline crosses itself, so the fill inverts there …` (also `prism: profile …`, `revolve: profile …`, `sweep: profile …`, `loft: ring 2 …`, `shape2d: profile …`), and the rendered part has a cavity, a missing lobe, or a sliver where a curved edge should be. Identical text on both backends.
- **Cause:** *(partforge ≥ 0.112.)* A hand-authored 2-D profile (a point list, a `pathProfile` contour, a `{outer, holes}` region — handed to a factory op, to `k.shape2d`, or as a `Shape2D` boolean operand) crosses itself. Manifold fills a point ring even-odd, so the crossing quietly inverts the fill on one side instead of failing. The usual author of the crossing is an arc sampled into points by hand (a `Math.cos` loop) whose sweep sign or endpoint order is wrong, or a mirrored half whose point order was not reversed. The kernel now runs `validateProfile` on the way in and reports each crossing on the build result's `warnings`; a `Shape2D` is not re-validated, `text2d`/`vector2d` lifts are trusted, and a profile over 4000 segments is skipped (for `loft`, the ceiling is the sum over all its rings). At most **three** crossings are reported per profile — the third reads `… (and N more crossings on this profile)` — so one badly-drawn star cannot evict every other warning in the build. A hole whose edge touches or runs along its outer is **not** reported: that builds exactly as drawn, and only a contour crossing itself inverts the fill.
- **Fix:** Rebuild the curved parts of the outline with `pathProfile(start).lineTo(p).arcTo(to, via).close()` — a three-point arc sweeps through `via`, so its direction cannot flip — or with the `partforge/geometry` helpers (`roundedProfile`, `filletPolygon`, `slotPolygon`, `ringSectorPolygon`, `circleProfile`); build a symmetric half once and `mirrorProfile` it rather than writing the mirror by hand. Confirm with `validateProfile(profile).ok` before extruding. The reported coordinate is in the profile's own frame (before any `rotate`/`at`).

## export-kernel-out-of-memory

- **Symptom:** `Out of bounds memory access` (Safari) or `memory access out of bounds` (Chrome, Node) from an STL or 3MF export — or from a build — of a part whose preview renders fine; often followed, on every later build in the same session, by `Manifold instance already deleted`, `Out of bounds call_indirect`, `call_indirect to a signature that does not match`, `table index is out of bounds`, or `null function or function signature mismatch`.
- **Cause:** The mesh kernel's WASM heap ran out while building the print-quality mesh, and a WASM trap leaves that kernel instance corrupt — every later call into it fails until the worker is replaced or the page reloaded. Before partforge 0.115 the print tier meshed every circle at a flat 480 segments whatever its radius, so a part with a few hundred small spheres or cylinders (a 0.75 mm rivet was 115,200 triangles — 176 of them are 20 M before a single boolean) exhausted a 4 GB heap on its first export while its whole unioned preview was a few hundred thousand triangles. Since 0.115 print sizes circles by a 0.01 mm chord tolerance, floored at the preview count, so a part that previews normally exports at roughly the preview's cost; a part that still traps is genuinely too heavy for the browser at ANY quality — usually thousands of repeated small features, or a boolean chain whose intermediates dwarf the result.
- **Fix:** Reload the page (or let the host replace the kernel worker) before retrying anything — the trapped instance cannot recover. Then reduce what the export has to hold at once: build repeated detail as one union of instances rather than a chain of per-feature booleans, drop feature counts that exceed what the print can show (a 0.75 mm sphere prints as a dot), or pass `segs` to `revolve` where a coarser sweep is acceptable ([Preview vs print quality](AUTHORING-PARTS.md#conventions--gotchas)). Do NOT strip visible detail from the part to dodge a pre-0.115 trap — update partforge instead; the geometry was never the problem.

## preview-build-too-heavy-for-phones

- **Symptom:** A part that previews on a desktop crashes, reloads, or shows a blank viewer on phones — iOS Safari's "This webpage was reloaded because a problem occurred", a viewer that never finishes its first build, or (in partforge-cloud) a `sandbox_timeout` from a phone user agent — with no error text at all, because the browser killed the page rather than the build throwing.
- **Cause:** Peak WASM memory during the preview build exceeded what the phone allows a page (roughly 1–1.5 GB on iOS; a desktop tolerates several GB). The usual shape is hundreds of repeated small features unioned into one body: before partforge 0.116 every sphere was 6,728 triangles regardless of radius (the flat 116-segment preview count, squared), so a body with ~250 rivet spheres carried 1.7 M triangles of rivets into its booleans — measured 10 s and a 2.7 GB peak on a desktop for a 400k-triangle sub-part, against 4 s and 500 MB with the rivets as 12-triangle boxes. A boolean chain whose intermediates dwarf the result (a full-body skin intersected per groove) is the other shape.
- **Fix:** Update partforge (0.116 sizes spheres by chord tolerance: that body builds in ~550 MB and 120k triangles unchanged). Then keep the preview build's peak down the same ways the export needs: build repeated detail as one union of instances rather than a chain of per-feature booleans, cut grooves from a thin local skin rather than the whole envelope, and drop feature counts the print cannot show ([Preview vs print quality](AUTHORING-PARTS.md#conventions--gotchas)). `partforge measure` reports triangle counts per sub-part; a single preview sub-part past ~200k triangles, or a whole view past ~400k, is the range where phones start to fail.

# Hardware library

Reserved for `hardware-*` patterns (issue #30). No entries yet.
