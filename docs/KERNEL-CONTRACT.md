# The partforge kernel contract

**Contract version: 4** (introduced in partforge 0.63) — mirrored by `CONTRACT_VERSION`
in `src/framework/geometry/kernel.js` and asserted by `test/kernel-contract.test.js`;
see [Versioning](#versioning) for what may change under which version bump.

This document is the portable seam of partforge. A part's `build(k, p, d)` is a pure ESM
function written against the kernel `k` and the `Solid` handles it returns — no framework
imports, no DOM, no backend types. That means **the kernel interface is the interchange
format**: any host that implements this contract can run any partforge part, and an LLM
given this document plus one exemplar part has everything it needs to write correct
geometry. There is deliberately no separate file format or DSL.

The contract has two halves:

- **Machine-checked:** the op lists in `src/framework/geometry/kernel.js`
  (`KERNEL_OPS`, `SOLID_OPS`, `OCCT_ONLY_OPS`, `ROUTED_CAD_OPS`, `*_OPTIONAL_OPS`) and their `@typedef`
  signatures. `test/kernel-contract.test.js` and the OCCT twin in
  `test/occt-backend.test.js` assert each backend exposes exactly these ops, so the list
  cannot silently drift from the implementations. **Those lists are normative.**
- **Prose (this doc):** the semantics an implementer or generator cannot read off a
  signature — coordinate conventions, value semantics, validation rules, error taxonomy,
  what parts may and may not rely on across backends.

Audience: backend/host implementers, and anyone (human or LLM) generating parts outside
this repo. For *authoring guidance* — usage tables, worked snippets, control-panel schema
— read `docs/AUTHORING-PARTS.md`. Where the two overlap (the op tables), this doc
carries the conformance semantics and that one the usage guidance;
`test/kernel-contract.test.js` keeps this doc's op coverage in sync with the code.

## Conformance classes

**Core class.** A conforming core kernel implements every op in `KERNEL_OPS` and
every `Solid` op in `SOLID_OPS`, *except* that the B-rep ops (`fillet`, `chamfer`,
`shell` — the `OCCT_ONLY_OPS` list — and `toSTEP`) may instead throw
`KernelCapabilityError`. Exception to the exception: `fillet(0)` / `chamfer({d: 0})`
(a magnitude that is exactly the number `0`, either calling convention) is the
**identity** on every class — it returns the solid unchanged and must not throw, so a
parametric radius dialed to 0 builds on a core kernel with no guard in the part.
`shell` has no identity form (`t: 0` means zero-thickness walls — degenerate, not
identity) and always throws on core. Kernels built from this repo get the stubs for
free: `addSugar()` generates the Solid-level stubs (including the zero-magnitude
identity) for whichever `OCCT_ONLY_OPS` a backend leaves undefined, and
`finishKernel()` stubs `toSTEP` (a kernel-level op, so it is not in that Solid-op
list).

**The in-repo Manifold backend is the reference core kernel, and since contract v3 it
implements `fillet` and `chamfer` natively** (`mesh-fillet.js` — tangent-tool CSG).
Its coverage and tolerance band are part of the contract:

- **Edge classes:** straight sharp edges with planar flanks, and circular-arc sharp
  edges whose flanks are surfaces of revolution about the arc axis (bore rims,
  cylinder rims, the arcs where blends meet a face) — full circles included. Convex
  edges subtract a cutter; concave edges union a filler. Any other edge class
  (helical edges, varying dihedral, non-circular curves, function selectors) throws
  `KernelCapabilityError` so the host can reroute that build to a B-rep kernel.
- **Tolerance band, not identity:** the blend surface is the exact rolling-ball
  (fillet) or setback-chord (chamfer) surface to within tessellation, plus
  micron-scale robustness allowances (tool overshoot past tangency and seam-grazing
  guards, all ≤ ~1e-3 mm). Volumes agree with the B-rep result to ~0.1% on covered
  edge classes. **Corners:** where exactly three selected straight convex chains meet
  at a mutually orthogonal vertex (a box corner), the fillet caps it with the
  rolling-ball sphere octant. A two-chain corner in a common face plane (a rim
  corner) blends by turn direction: SALIENT corners steer the band around a small
  arc (the silhouette rounds by about the blend radius inside the band), and REFLEX
  corners get the rolling-ball pivot — the face's blend boundary rounds into an arc
  of the blend radius about the vertex, exactly what a ball rolling into an inside
  corner leaves. Every other junction of blended chains is a **mitre** (the blend
  surfaces intersect), where the B-rep class builds a kernel-specific vertex blend
  instead — parity at such corners is approximate, like `roundedBox`'s documented
  corner carve-out.
- **New surfaces:** like the B-rep op, a mesh blend produces new surfaces — feature
  labels upstream of the call do not survive through it (attribution uses the
  fallback path), and the result shades with the default SMOOTH policy.

`roundAll` is required on **every** class (it is in `SOLID_OPS`, not
`OCCT_ONLY_OPS`) and is **parity-tolerant with a regime split**: while `r` is
strictly below the solid's smallest feature size (min wall, min hole
diameter / 2), both classes produce the morphological result and volumes agree
within the mesh-tolerance band. That band is stated at the **export (print)
tier**, where the mesh class's tessellation is fine enough to compare against
B-rep arcs (box and L-bracket cases: ≤ 0.05%); the preview tier is coarser by
design and runs ~0.2% below the B-rep volume, which is tessellation, not a
parity failure. At consuming radii, only the core (mesh) class
performs true consumption; a B-rep class MUST either produce a valid solid or
skip the entire op (returning the input unchanged, warning `roundall-skipped`)
— emitting an invalid or semantically wrong solid is non-conforming. Authors
relying on consumption should gate it with a `verify` volume assertion.

**B-rep class.** Core plus native `fillet`/`chamfer`/`shell` and `toSTEP`. The in-repo
OCCT/replicad backend is the reference.

**Optional ops.** `KERNEL_OPTIONAL_OPS` (`beginSubPart`/`endSubPart`/`sweepCache`/
`cacheStats`/`resetCacheStats`/`cleanup`) and `SOLID_OPTIONAL_OPS` (`genus`/`isEmpty`) may
be omitted entirely; callers in the framework guard with `?.`/`typeof`. A host that omits
them loses sub-part caching and mesh-topology gates (`holes`, emptiness), nothing else.
`sweepCache()` is the cache's rebind hygiene hook: called once when a worker is rebound to
a part (never inside a `beginSubPart`/`endSubPart` bracket), it drops cache partitions that
have gone unbuilt for three consecutive rebinds.

`beginSubPart`/`endSubPart` brackets MAY nest: only the outermost pair opens and
commits a round, and an inner pair is a balanced no-op. Nesting is real rather than
theoretical — `buildView` opens a round of its own, so any caller that brackets around
a view build contains one. A backend that keeps a single open round (rather than a
stack) must collapse inner pairs this way; committing on the inner `end()` would close
the outer round early and leave the rest of that build uncached.

Sub-part brackets bound cache RETENTION, not reuse: a solid one sub-part builds is reused
by any other that asks for the same content hash, so a sheet of identical cells split
across row sub-parts evaluates each distinct cell once rather than once per row. An adopted
entry is retained by both partitions and disposed only when the last one drops it.

The oracle (`buildView`, `assemblyOverlaps`) brackets under partition names of its
own rather than the display sub-part names, and a host adding another oracle-side build
should do the same. Both reuse the display build's solids through the cross-partition
index, so measuring a view costs almost nothing right after drawing it; keeping them in
separate partitions is what stops a measurement's own geometry — verify walks cases with
params of their own — from displacing the geometry the viewer is showing.

**Transform hoisting.** Booleans commute with rigid transforms, so a conforming backend MAY
lift a transform every operand shares out of the boolean and apply it to the result
instead — which is what lets N identically-built copies share one evaluation. Two
consequences a host must expect. Hoisting evaluates the boolean in a different frame, so
the result is geometrically equivalent but **not** guaranteed mesh-identical: vertex order,
triangulation, and triangle count may differ (measured on the in-repo `scott-label`
lettering: same genus and bounding box, volume agreeing to ~1e-9 relative, ~1% more
triangles). Output stays deterministic for a given build. And an op is eligible only if it
provably commutes with the transform — `fillet`/`chamfer` do NOT, because their edge
selectors can be world-space, so hoisting past one would select different edges and emit
wrong geometry.

**`import`.** `kernel.import(name) → Solid` returns previously-registered imported geometry
(STL/STEP/3MF geometry declared in a part's `imports` field); `_registerImport`/
`_importDigest`/`_acceptsStep`/`_acceptsMesh` are the underscore-prefixed side-channel the
framework uses to feed it — not a part author's calling surface. It is a required op
(`KERNEL_OPS`) on both in-repo backends: the Manifold backend accepts mesh formats
(`_acceptsMesh: true`) and the OCCT backend accepts STEP (`_acceptsStep: true`); a format
neither backend accepts for the routed kernel registers as an `{error}` entry that
`import(name)` throws lazily at call time, not at registration.

`KernelCapabilityError` is a *routing signal*, not a failure: partforge's geometry-free
probe (`probe.js`) runs `build` against a fake kernel, and any use of a
`ROUTED_CAD_OPS` op (`shell`, since v3) **on a Solid handle** routes the build to a
B-rep-class kernel up front (the probe tracks handle kinds, so the same names on a
`Shape2D` — shared pure JS, backend-identical — do not route). `fillet`/`chamfer` are
**not probe-routed anymore**: the core kernel attempts them, and throws
`KernelCapabilityError` only for an edge class it cannot blend — which the in-repo
framework's runtime reroute latch (`backend-select.js`) converts into a per-sub-part
OCCT fallback, and the CLI into a re-exec on the OCCT kernel. Routing granularity is a
host choice: the in-repo framework routes preview builds per sub-part (each sub-part
builds wholly on one kernel) and exports/CLI whole-part; a single-kernel host routes
everything whole-part. A host with only a core kernel must surface the error ("this
part needs a B-rep backend") rather than swallow it.

## Global semantics

These hold for every op on every backend. A part may assume them; an implementation must
provide them.

- **Units are millimetres.** Everywhere, including `volume()` (mm³) and mesh output.
- **Angles are degrees.** Everywhere (`rotate*`, `twist`, `revolve` `degrees`, loft ring
  `rotate`, `arcDeg` helpers).
- **Coordinates are right-handed, Z-up.** Primitives build along **+Z from z = 0**
  (`cylinder`, `prism`, `extrude` extrude upward; `revolve` spins `[[r, z], …]` about the
  Z axis). The idiom is *build canonical at the origin, then orient/place*
  (`.along(dir).at(v)`).
- **2-D contours are `[[x, y], …]` point lists, CCW = material.** Holes in an `extrude`
  profile are additional contours; winding of holes is normalized by the backend. The
  symbolic-arc alternative is an **arc profile** `{ start, segments: [{ to, via? }, …] }`
  (produced by `roundedProfile`), where a segment with `via` is a three-point circular
  arc; B-rep backends must carry these arcs exactly (real CIRCLE edges in STEP), mesh
  backends tessellate them. Cubic Bézier segments (`{to, c1, c2}`, built via `pathProfile().cubicTo(…)`)
  follow the same rule: exact spline B-rep on OCCT (→ STEP), adaptively faceted at
  the mesh `segs` LOD on Manifold. Measure-parity (volume/bbox) holds within
  tolerance as facets converge; this is not a parity waiver.
- **Ops never mutate — but they MAY consume.** Every op returns a new `Solid` and never
  mutates one in place. Whether the *inputs stay valid* is backend-dependent: the mesh
  backend leaves them usable, but the B-rep backend's engine (replicad) deletes the
  operand of a transform or boolean. The portable rule is therefore: **never reuse a
  `Solid` after passing it to a transform or boolean — `.clone()` first if you need it
  again** (failure signature: ERROR-PATTERNS.md `replicad-consumed-operand`). `clone()`
  must return an independent handle on every backend; a backend MAY additionally provide
  full value semantics, but a portable part must not rely on it.
- **Purity and determinism: identical arguments must produce identical geometry.** No
  randomness, clocks, or hidden global state in an implementation. partforge's solid
  cache memoizes by a content hash of `(op, args)`; a nondeterministic op silently
  poisons the cache.
- **Validation** (a conforming implementation enforces all of these; in-repo the kernel
  front checks the `prism`/`extrude`/`revolve` rules, `addSugar` the `scale` rule, and
  the B-rep backend the `shell` rule): `prism`/`extrude` `scaleTop ≥ 0`; `revolve`
  profile radii `≥ 0`; `scale` `factor > 0`; `shell` requires `open` (a fully
  closed hollow is not supported).
- **Error taxonomy:** invalid arguments throw plain `Error` with a message naming the op
  (`"prism: scaleTop must be ≥ 0"`); a whole op a backend class lacks throws
  `KernelCapabilityError` (from `geometry/errors.js`) — the routing signal. A
  backend-divergent *option* (`loft`/`sweep` `closed: true` on a B-rep kernel) throws a
  plain `Error` naming the limitation, not `KernelCapabilityError`: option misuse is not
  reroutable, and a host must fail loudly rather than silently ignore the option. Beyond
  those, nothing else is thrown for well-formed input — a fillet the engine cannot
  compute falls under the repair policy below, not a part-visible error class.

## Calling convention

**Detection rule (normative):** a call is **options form** when the op receives
**exactly one argument and it is a plain object** — not an `Array`, not a `Solid`.
Any other arity or first argument is legacy positional form. "Plain object" means
`Object.getPrototypeOf(x) === Object.prototype || null`, which excludes arrays,
`Solid` handles (backend handles carry methods/prototypes), and typed arrays. This
one rule disambiguates every op with no key-sniffing — the load-bearing case:
`extrude({outer, holes}, h)` is positional (two arguments); `extrude({profile, h})`
is options (one plain object).

Options form is canonical — the form this document, `AUTHORING-PARTS.md`, and every
in-repo part teach and use. Legacy positional forms remain accepted (silently — no
runtime warning) until a future breaking contract version removes them; a conforming
implementation must accept both, and this repo's `finishKernel()`/`addSugar()`
provide the normalization for free. (Contract v2, partforge 0.59, did **not** remove
them — that bump was for `offset` semantics, see [Versioning](#versioning); legacy
positional removal is still pending a version of its own.)

### Kernel factory ops (options-canonical; legacy positional accepted)

| Op | Canonical options form | Legacy positional (pending removal) |
|---|---|---|
| `cylinder` | `{r\|d, h, center?}` straight · `{r1, r2, h, center?}` or `{d1, d2, h, center?}` cone | `(rBottom, rTop, h, {center?})` |
| `sphere` | `{r\|d}` — `sphere(5)` stays valid, undeprecated | `(r)` |
| `box` | `{size:[x,y,z], center?}` (centered X/Y, base z=0; `center:true` also centers Z) · `{min, max}` | `(min, max)` |
| `prism` | `{points, h, twist?, scaleTop?}` | `(points2D, h, {twist?,scaleTop?})` |
| `extrude` | `{profile, h, twist?, scaleTop?, bevel?}` — `profile` = points array, `{outer, holes}`, or arc profile; `bevel` has no positional form | `(profile, h, {twist?,scaleTop?})` |
| `revolve` | `{profile, degrees?}` | `(points2D, {degrees?})` |
| `loft` | `{rings, ruled?, closed?}` | `(rings, {ruled?,closed?})` |
| `sweep` | `{profile, path, closed?, cornerRadius?, ruled?, smooth?}` | `(profile2D, path3D, opts?)` |

`boredCylinder`, `helixSweptTube` and `screwSweep` were always options-only (no
positional legacy form exists); they get the same unknown-key / required-key
validation as the ops above.
`union(solids[])` and `toSTEP(named[])` take a single array — unchanged.

### Solid ops

| Op | Canonical form(s) | Notes |
|---|---|---|
| `fillet` | `fillet(3)` · `fillet({r, edges?})` | options form replaces `fillet(3, selector)` |
| `chamfer` | `chamfer(1)` · `chamfer({d, edges?})` | ditto |
| `shell` | `shell({t, open})` | replaces `(thickness, openFaces)`; `open` was already required |
| everything else | unchanged | `translate/at/along/rotate*/rotateAbout/mirror/scale/cut/cutAll/intersect/union/clone/label` + queries |

### Cylinder key rules

- Straight: exactly one of `r` / `d`. Cone: `r1`+`r2` or `d1`+`d2` (no mixing
  radius and diameter across ends; no mixing straight and cone keys).
- `h` required everywhere.
- Diameter keys are sugar: normalized to radii before the backend sees them.

### `box({size})` placement

`{size:[x,y,z]}` is centered in X and Y with its base at `z = 0` — the same
canonical placement `cylinder` already has (build canonical at the origin, then
orient/place). `{center:true}` additionally centers Z. `{min, max}` remains for
explicit corners and is unaffected.

Scalar shorthands are permanent, not legacy: `sphere(5)`, `fillet(3)`, and
`chamfer(1)` stay valid and undeprecated — they take a single number with no
transposition risk, so there is no options-form pressure to replace them (only
`fillet`/`chamfer`'s two-argument selector call is superseded, by
`fillet({r, edges})` / `chamfer({d, edges})`).

## Kernel ops (make solids)

Signatures are normative in `kernel.js`'s `@typedef GeometryKernel`; this table fixes
the behavior. Signatures are shown in the canonical options form — the legacy
positional equivalents live in the [Calling convention](#calling-convention) table
above. All ops return a `Solid`.

| Op | Contract |
|---|---|
| `cylinder({r\|d, h, center?})` · `cylinder({r1, r2, h, center?})` \| `{d1, d2, h}` | Cylinder along +Z from z = 0 (straight: exactly one of `r`/`d`); the cone form (`r1`/`r2` or `d1`/`d2` ends) gives a frustum. `center: true` centers on z = 0. |
| `boredCylinder({od, h, bore})` | Compound: cylinder of diameter `od` with a through-bore `bore`. Semantically identical to the composition in `kernel-front.js`; a backend may override only for caching, never for different geometry. |
| `sphere({r\|d})` | Sphere centered at the origin; bare `sphere(r)` stays valid. |
| `roundedCylinder({ r\|d, h, center?, round })` | Cylinder with rim round-overs (`round`: number = both rims, or `{ top?, bottom? }`), built as one lathe `revolve` of an arc-exact profile — real torus faces in STEP. Validation: radii ≥ 0, each ≤ r, top + bottom ≤ h. Options-only. |
| `torus({ rMajor, rMinor })` | Torus centered at the origin, tube centerline in the z = 0 plane; requires 0 < rMinor < rMajor. Curve-exact on B-rep backends. Options-only. |
| `roundedBox({ size, center?, round })` | Box with selectively rounded edges; `round`: number = every edge, or `{ side?, top?, bottom? }` (vertical edges / top rim / bottom rim). Corner semantics and the `0 < side < rim` clamp-with-warning rule are normative in the design spec and summarized under [Rounded primitives](#rounded-primitives). Options-only. |
| `box({size, center?})` · `box({min, max})` | Axis-aligned box: `{size:[x,y,z]}` centered in X/Y with base at z = 0 (`center: true` also centers Z), or explicit `[x,y,z]` `{min, max}` corners. |
| `prism({points, h, twist?, scaleTop?})` | Extrude one CCW contour (point list or arc profile) from z = 0. `twist` = total degrees over the height; `scaleTop` = uniform top scale (1 straight, 0 → apex). |
| `extrude({profile, h, twist?, scaleTop?, bevel?})` | Same, for a polygon-with-holes region — `profile` is `{outer, holes?}` (bare contour = outer only) — in one op, no per-hole boolean. `profile` may also be a `Shape2D` (see below). `bevel` (number = both rims, `{bottom?, top?}` = per rim) cuts a 45° rim bevel; it desugars at the shared front into extrude + loft + intersect/cut, so it is backend-identical by construction and is **not** a CAD-only op (no OCCT routing). Every profile form works — point array, arc profile, `{outer, holes}` (hole rims flare outward), or `Shape2D` (multi-region bevels each and unions) — but curved profiles are **materialized to point rings** first, so a beveled extrusion is faceted at the sampling LOD even in STEP (arc contours at a fixed pure-JS LOD, backend-identical; a `Shape2D` at its backend's own LOD — `hull`'s parity class). No `twist`/`scaleTop`, and `bottom + top < h` or it throws; a bevel a rim's narrow features cannot take is deterministically reduced with a console warning (`ERROR-PATTERNS.md#extrude-bevel-reduced`). |
| `revolve({profile, degrees?})` | Revolve a lathe profile `[[r, z], …]` (r ≥ 0) about Z; `degrees` < 360 gives a capped partial revolve. Default 360. |
| `loft({rings, ruled?, closed?})` | Stack cross-sections along Z with ruled walls and capped ends (per-ring `z`/`rotate`/`scale`). A ring's `polygon` may be a point list, `sides`+`radius`, a curve contour, or a single-region hole-free `Shape2D` (multi-region / holed shapes throw). Rings with **identical all-line segment structure** (one straight-sided shape reused at different z/scale/rotate) loft **bit-identically** on both backends — parity by construction, unchanged legacy behavior. Rings with **identical curve structure** (containing arcs or Béziers, the same shape at different z/scale/rotate) loft curve-natively on a B-rep kernel — STEP keeps exact arc edges — while a mesh kernel facets the same sections at a fixed LOD (`hull`'s parity class). **Structurally different rings** (a rounded square morphing to a circle, unequal-N point lists) are arc-length-resampled once, in shared pure-JS code, to a common vertex count with a deterministic seam (the outermost +X-ray crossing from each ring's centroid; per-ring `rotate` tunes the phase) and snapped corners — every backend then lofts the **identical** resampled point rings, so the result is parity **by construction** and STEP is faceted at the sampling LOD. Must self-correct a fully inverted result (CW rings / descending z) to an outward solid. |
| `sweep({profile, path, closed?, cornerRadius?, ruled?, smooth?})` | Sweep a fixed CCW profile along a polyline with a rotation-minimizing frame; sharp mitered corners, or `cornerRadius` fillets; capped ends. |
| `helixSweptTube({pathR, profileR, pitch, turns, z0, lefthand})` | Circle of radius `profileR` swept along a helix (e.g. a rope groove). Circular profile on a frenet frame that rolls with the helix — **not for threads**; use `screwSweep`. |
| `screwSweep({profile, pitch, turns, lefthand})` | Screw-motion sweep of an axial lathe profile `[[r, z], …]` (r ≥ 0) — threads. The profile travels to `(r·cosθ, r·sinθ, z + pitch·θ/2π)`; `h = pitch · turns`. Axial extent must not exceed `pitch` or consecutive turns interpenetrate (throws). A profile spanning exactly `pitch` is **periodic**: first and last radius must agree, and it yields a complete threaded body needing no boolean. Compound: the polar-remapped, densified section extruded with `twist = 360 · turns`, exactly as composed in `kernel-front.js`; a backend may override only for caching, never for different geometry. Options-only. Parity: **within tolerance, not by construction** — both backends receive the identical densified polygon, but the mesh backend facets the twist at its own resolution while the B-rep backend builds an exact spline (`hull`'s parity class). |
| `tappedBore({d, pitch, turns, depth?, crest?, lefthand?, rootSink?, overshoot?})` | A tapped (internally threaded) hole as **one cut tool** — the plain bore of diameter `d` fused with its thread. Compound (`kernel-front.js`), so no backend implements it. Exists for robustness, not ergonomics: assembled by hand the bore wall and the thread root land on exactly the same cylinder, and OCCT's boolean cannot resolve that tangential contact along a helix — measured at fifteen minutes without finishing on a 6-turn cap (73–92 s even with OCCT's own `GlueShift`/`GlueFull` mitigation), against ~14 s for this op. Two offsets carry that: `rootSink` (default 0.2) sinks the thread's root INSIDE the bore by extending each flank COLINEARLY — the same swept surface carried further down, so everything at `r ≥ d/2` is identical to the hand-assembled construction and the union with the bore clips the rest (verified on Manifold, which can build the tangent form, to ~1e-5 of tool volume; sinking the root points radially instead would tilt the flanks and fatten the tooth outside the bore by a measured 2%). The extension steals axial root-flat width, so the sink is silently clamped where a full `rootSink` would consume it — the clamped overlap still clears the coincidence band by an order of magnitude. And `overshoot` (default 0.2) overhangs the bore past the thread at both ends, because flush ends are coincident faces one layer down, where the union does not hang but silently returns the bore alone (operands swapped, an empty solid). Both are refused at zero. `depth` defaults to the thread's own length `pitch · turns` and is refused SHORTER than it (the thread would poke out past the bore's far end); `crest` (radial thread height) defaults to `0.15 · pitch`; the tooth is a printable trapezoid, root flat `pitch/4` and crest flat `pitch/8`. This op owns BOTH halves on purpose: `screwSweep` cannot sink its own root, because a thread cut into solid stock with no bore would then cut deeper and change the part. Options-only. Parity: `screwSweep`'s class (within tolerance), which it composes. |
| `loftSmooth({sections, stations?, samples?, shading?, closed?})` | Spline-interpolated loft of ≥2 sparse control sections — loft-style ring specs `{polygon\|sides+radius\|curve contour\|Shape2D, z, rotate?, scale?, sharp?}`; vertex counts **may differ**. A point section may tag `sharp: [indices]` as true corners (integers in `0…points.length-1`, sorted/deduped silently); a curve/`Shape2D` section takes corners implicitly from its non-smooth joints (single-region, hole-free, `loftSmooth:`-prefixed `k.loft` validation) and rejects an explicit `sharp`. Every section must resolve to the **same corner count `m`** (frozen error otherwise); with `m ≥ 1` corner 0 anchors the seam (replacing vertex 0), with `m = 0` v1's vertex-0 anchor holds verbatim. Compound (`kernel-front.js` + `loft-smooth.js`): each section's outline is a closed centripetal Catmull-Rom split into `m` clamped open arcs at its corners (or one closed periodic CR when `m = 0`); the `samples` budget is apportioned across arcs by mean arc-length fraction (largest-remainder, min 1 span/arc) and each arc resampled by arc length — total ring vertex count is `samples`, identical across sections, exactly v1's invariant now corner-anchored. The cross-station direction is v1 verbatim (shared centroid-spine knots, per-vertex CR, reflection phantoms at the ends, or periodic knots when `closed: true`). What's new is emission: every station — the dense list and the sparse `stations:"controls"` list alike — is fitted back to an **all-cubic Bézier contour**, arc-by-arc, via exact 4-point CR→Bézier inversion, so **both backends receive identical curve rings**. A B-rep kernel lofts the sparse control wires with its native smooth skin (`ruled: false`) — curve-exact around each ring in STEP (the densified-*point*-wire alternative measured 23 s / WASM-abort territory, which curve wires don't hit). A mesh kernel densifies `stations` rings and lofts them through `k.loft`'s curve-mode per-segment sampling, creasing sharp/corner columns via loft's geometric corner policy. `closed: true` (default false; needs ≥3 control sections, frozen error otherwise) makes the cross-station CR periodic (no reflection phantoms, ring 0 not repeated) and is **Manifold-only**, same restriction as `loft` `closed: true`: a B-rep kernel throws `loftSmooth: closed:true loops are only supported on the Manifold backend` in the composition, before building any rings; combining `closed: true` with `stations:"controls"` is rejected as a defensive invariant (reachable only by explicitly passing the internal `stations:"controls"` value; the composition never produces the combination itself). Options-only. Defaults `stations = (n−1)·8+1` open / `n·8` closed (raised to the section count `n` when lower), `samples = max(64, largest section)` (raised to the corner count `m` when lower); clamps 2…1024 / 8…2048 — the defaults cap themselves at the ceilings, only explicit out-of-range values throw. The surface interpolates every control section exactly. Parity: **within tolerance** (`screwSweep`'s class, unchanged from v1 — ~0.4% measured on the propeller reference part, test-gated at 2%). STEP is now curve-exact around each ring (previously faceted at the `samples` LOD); the cross-station skin remains ThruSections' native fit, not the shared CR — exact cross-station B-splines are a v3 candidate. Additive: `sharp`, curve/`Shape2D` sections, and `closed` are new options on top of v1's `{sections, stations?, samples?, shading?}`; `CONTRACT_VERSION` stays 4 — the same non-bump precedent as `import` above, a refinement inside the op's already-stated tolerance class rather than a new one. |
| `heightfield(nameOrGrid, {w, d, base?, maxZ?, pitch?, invert?, range?, origin?})` | A depth map as a relief solid: a sampled grid top at `z = base + maxZ·f(v)`, skirt walls, and a flat base cap at `z = 0`. `nameOrGrid` is a name declared in the part's `images` field, or an inline `{width, height, data}` grid. Sample count per axis is `max(2, ceil(w/pitch))` and `max(2, ceil(d/pitch))`; if their product exceeds a vertex budget, `pitch` is scaled up uniformly to fit and, if still over, the two counts are shrunk in lockstep — with a `takeBuildWarnings` message rather than an error. `range` is a remap with clamped ends (`range[0]`→0, `range[1]`→1); `invert` applies after, as `1−v`. `origin` positions the footprint in XY only — the base always sits at `z = 0`. The image stretches to `w × d`; aspect is not preserved. **Axis convention:** sample row 0 (a source PNG's first scanline, i.e. its visual top in an image viewer) maps to the footprint's **−Y** edge — Y increases with row, the standard texture-coordinate mapping — so a depth map viewed from +Z looks vertically mirrored relative to the same file opened in a viewer; flip the source pixels before declaring the image if that orientation is unwanted (`invert` remaps height values, not position, and does not affect this). Fed by an underscore-prefixed side-channel (`_registerImage`), not part authors — see [Conformance classes](#conformance-classes). Required on both in-repo backends: Manifold imports the triangles directly, OCCT sews them into a faceted B-rep via `importSTL`, so STEP export carries a triangulated surface rather than an analytic one. Parity: **exact** — both backends receive byte-identical triangle data. Additive: `CONTRACT_VERSION` stays 4, the same precedent as `import` and `loftSmooth`. |
| `union(solids[])` | Boolean union of one or more solids. |
| `text2d(string, {size, font?, align?, valign?, lineHeight?, tracking?, kerning?})` | Outline-font text → `Shape2D`. `size` = cap height (mm). `font` = declared name / inline bytes / default. Build-time; curve-exact on OCCT, faceted on Manifold. |
| `vector2d(name, {shape?, width\|height\|fit, align?, valign?})` | A declared vector document → `Shape2D`. `name` = a declared name in the part's `vectors` field (`partforge-vector` JSON — authored by hand or ingested from an `.svg`; never raw `.svg`). With no `shape`, the document's own composition: every `"add"` shape unioned minus every `"subtract"` shape; `shape` selects one named shape's geometry whatever its role. Sizing follows the document's required `units`: `"artwork"` requires exactly one of `width`/`height`/`fit` in millimetres, `"mm"` places as authored (scale 1, no translate) and accepts a size option optionally; more than one is refused. Uniform scale in every case (`fit` = larger extent); `align`/`valign` position it, same as `text2d`, defaulting to centre/middle for `"artwork"` and to no translate for `"mm"`. **The composed call derives ONE transform from every region in the document**, `"add"` and `"subtract"` alike, so a size or align option cannot scale the subtracts relative to the adds; a `shape` call is measured against that shape alone. **Primitive contours (`circle`/`rect`/`polygon`) expand to ordinary path contours at the format boundary, in `vector-format.js`, so this op's kernel-facing contract is unchanged by them** — nothing below the loader learns primitives exist. Conformance: **both backends** (it lowers to `shape2d` + `union`, exactly like `text2d`). Parity: **identical across backends by construction** — the regions are curve-native (arcs/cubics), so there is no sampling step for the two backends to diverge over. |
| `hull(inputs[])` | Convex hull of all inputs (each a `Shape2D`, a curve contour, or an `[[x,y],…]` point list) → a convex `Shape2D`. Backend-agnostic: a pure-JS monotone-chain hull over the inputs' sampled points (curved inputs tessellated at a fixed LOD), lifted via `shape2d` (see the parity note below). Throws on an empty input array or a degenerate (collinear/point-count < 3) hull. |
| `hullChain(inputs[])` | Swept hull over an ordered sequence of ≥2 inputs (same input forms as `hull`): the union of `hull([inᵢ, inᵢ₊₁])` for each consecutive pair — e.g. a tapered link connecting a row of circles. Throws with fewer than 2 inputs. |
| `toSTEP(named[])` | `[{name, solid}]` → `Promise<ArrayBuffer>` of a STEP assembly. B-rep class only. |
| `import(name)` | Previously-registered imported geometry (STEP/STL/3MF, declared in the part's `imports` field) as an ordinary `Solid`. Required on both in-repo backends (Manifold accepts mesh formats, OCCT accepts STEP); a format the routed backend can't use throws lazily, at this call, not at registration. Fed by an underscore-prefixed side-channel, not part authors — see [Conformance classes](#conformance-classes). Additive: not in `OCCT_ONLY_OPS`; needed no `CONTRACT_VERSION` bump of its own (v3 came from the mesh fillet/chamfer change, not this op). |

`hull`/`hullChain` parity: point-list and curve-contour inputs hull bit-identically
across backends (pure-JS sampling, no backend materialization involved). A `Shape2D`
input samples via its own backend materialization (`.toRegions()`), so a hull that
includes a `Shape2D` input agrees only within the tessellation tolerance of that
backend's curve faceting — the same class of parity as the 2-D boolean ops above, not
a waiver of `CONTRACT_VERSION` (still 1; this op is additive).

**Backend-divergent options** (a portable part must treat these as declared here):
`loft` `closed: true` (capless loop) and `sweep` `closed: true` are supported **only by
mesh backends** (Manifold); B-rep kernels throw a plain `Error` naming the limitation
(see the error taxonomy). `loft` `ruled: false` (smooth C2 walls) and `sweep`
`smooth: true` (native swept B-rep) are honored only by B-rep kernels; mesh kernels
render the ruled form. `sweep` `closed: true` loops must be planar. Where both backends build the same
shape they do it **by construction, not by tolerance**: sweep elbows loft the identical
station list (`sweep.js`), and structurally-different loft rings loft the identical resampled ring list
(`loft-rings.js`) on both backends. Structurally-identical all-line rings remain bit-identical on both backends
(unchanged legacy behavior). Structurally-identical curve rings are the exception by design: the B-rep kernel keeps the
exact curves (STEP-exact) while a mesh kernel facets them — `hull`'s parity class.

### Rounded primitives

`roundedBox` / `roundedCylinder` / `torus` are options-only compound
primitives. `roundedBox` is an atomic compound node; `roundedCylinder`/`torus`
desugar to a `shape2d` + `revolve` pair (both nodes hash deterministically
from the op's arguments). Normative semantics for `roundedBox`
(design spec 2026-07-30): the cross-section at height z is the rounded
rectangle inset by δ(z) with corner radius max(side − δ(z), 0), where δ
traces a quarter circle of the rim radius in each rim zone and is 0 in the
straight zone. Consequences an implementation must honour:

- **side ≥ max(top, bottom)**: top/bottom corners are exact torus patches
  (sphere octants when equal).
- **side = 0**: each rim round-over runs the full edge length and adjacent
  round-overs meet in their natural intersection curve — NOT a
  kernel-specific vertex blend; the top/bottom face keeps sharp corners.
- **0 < side < max(top, bottom)**: the rim radii CLAMP DOWN to side, with a
  console warning (deduped per distinct message). A clamped call and its
  explicitly-clamped equivalent are the same normalized arguments — one
  cache node. For a rim-only round-over use side: 0 exactly.

Validation (op-named plain Errors, backend-identical): radii ≥ 0 and finite;
box: 2·r ≤ min(w, d) for every group, top + bottom ≤ h (strict < when
side > 0 — the two rim fillets would meet tangentially, which the B-rep
backend cannot build; side: 0 full-height round-overs stay valid); cylinder:
rims ≤ r, top + bottom ≤ h; torus: 0 < rMinor < rMajor. `roundedCylinder`/
`torus` are single lathe revolves of arc-exact profiles — B-rep backends
carry real torus/sphere faces to STEP; mesh backends facet at the segs LOD
(the standard exact-vs-faceted split, not a parity waiver). `roundedBox` is
faceted at the segs LOD on mesh backends and exact B-rep on OCCT; measure
parity holds within facet tolerance — except where a rim fillet hits a
degenerate boundary (e.g. rim = side on a stadium profile) and the B-rep
backend skips it with a warning (`ERROR-PATTERNS.md`,
`roundedbox-fillet-skipped`) rather than export invalid geometry.

## Solid ops (combine / transform / query / output)

Normative signatures: `kernel.js`'s `@typedef Solid`.

| Op | Contract |
|---|---|
| `cut(tool)` / `cutAll(tools[])` / `intersect(other)` / `union(other)` | Boolean subtract (single / batched), intersection, and union. |
| `translate(v)` · `rotate(deg, center, axis)` · `mirror("XY"\|"XZ"\|"YZ")` · `scale(factor, center?)` | Transforms — but only two are **rigid** (pose): `translate`/`rotate` move a solid without altering it (position + orientation, shape and handedness preserved). `mirror` **reflects** — it returns the opposite-handed (chiral) solid, which no rotation can reproduce; `scale` **resizes**. So `mirror`/`scale` change the solid *itself*, not just where it sits — think of them as build operations, and never as the difference between a display pose and an export pose (see AUTHORING-PARTS.md `place`). `translate`/`rotate` are the primitives; the placement sugar below is composed *purely from them* (`solid-sugar.js`), so it is geometry-identical on every backend and a host gets it for free via `addSugar()`. |
| `rotateX(deg)` / `rotateY(deg)` / `rotateZ(deg)` · `rotateAbout({axis, deg, through?})` · `along(dir)` · `at(v)` | The readable placement vocabulary parts actually use. `along` maps the canonical +Z build axis to `"±X"\|"±Y"\|"±Z"`. |
| `clone()` | Independent handle (see value semantics). |
| `label(name)` | Name this solid's surface for feature attribution; must survive transforms and booleans; equal names merge into one feature. Affects mesh metadata only, never geometry. |
| `boundingBox()` | `{min, max, center, size}`; `center`/`size` are derived by `addSugar` from the backend's `{min, max}`. |
| `volume()` | Solid volume in mm³. |
| `genus()` / `isEmpty()` | Optional (`SOLID_OPTIONAL_OPS`): mesh-topology queries — through-hole count / no-geometry test. The mesh backend provides them; OCCT has no cheap equivalent. |
| `toMesh({quality?})` | Render mesh: `{positions, normals, indices?, triangles, edges?, featureIds?, features?}`. `indices` optional (a backend may emit soup or indexed); `normals` and `edges` are authoritative shading intent from both backends — see [Shading intent](#shading-intent-tomesh-normals-and-edges) below; `featureIds`/`features` are optional metadata. |
| `toSTL({quality?})` | `Promise<ArrayBuffer>`, binary STL, outward CCW winding. Stored facet normals may be zero — slicers recompute them (the mesh backend happens to write them). |
| `toIndexedMesh({quality?})` | `{positions, indices}` indexed mesh (3MF path); defaults to `"print"` like `toSTL`. Coincident vertices need NOT be welded — the 3MF writer welds, because that format reads topology from the indices rather than re-stitching soup by position the way an STL consumer does. |
| `fillet(r)` · `fillet({r, edges?})` / `chamfer(d)` · `chamfer({d, edges?})` / `shell({t, open})` | `fillet`/`chamfer`: implemented on BOTH in-repo classes since v3 — exactly on B-rep, tolerance-band on the mesh class for straight and circular-arc edge chains (see [Conformance classes](#conformance-classes)); an edge class the mesh kernel cannot blend throws `KernelCapabilityError` and reroutes. Zero magnitude — `fillet(0)` / `chamfer({d: 0})` — is the identity on every class (returns the solid unchanged, never throws; `shell` excluded, `t: 0` is degenerate). Scalar `fillet(3)`/`chamfer(1)` acts on all edges; the options form adds an `edges` selector. `shell` remains B-rep-only (core throws), hollows inward keeping outer dimensions; `open` (face selector) is required. |
| `roundAll(r)` · `roundAll({r})` | Morphological close-then-open with a ball of radius `r`: rounds EVERY edge (convex and concave) at radius ≈ `r`; faces stay in place (within the class's tolerance band — the B-rep offset chain can drift ~0.1 mm); features smaller than the ball are consumed (walls < 2r melt, holes < 2r seal). Implemented natively on BOTH classes — never routes, never throws `KernelCapabilityError`. Parity-tolerant only while `r` is below the smallest feature size; at consuming radii the mesh class performs true consumption and a B-rep class MAY skip the whole op unchanged with a `roundall-skipped` warning (skip is the only permitted degrade). `roundAll(0)` is the identity on every class. |

`quality` (`"preview"` | `"print"`) is **advisory**: it trades tessellation density for
speed and a backend may bake it at kernel creation (Manifold does). A part must never
depend on triangle counts, segment counts, or normals being present. The in-repo
backends both define `print` as a **chord tolerance of 0.01 mm** (OCCT's linear
deflection; Manifold's per-circle segment rule in `geometry/circle-segs.js`, floored at
the preview's 116 segments so print is never coarser than preview and capped at 480), so
a small feature costs the export exactly what its preview cost — the property that makes
"if it previews, it exports" hold. Preview is a flat 116 on Manifold, a visual choice.

### Shading intent (toMesh normals and edges)

`toMesh` output is the authoritative statement of how a solid SHADES and which
edges are FEATURE edges — consumers (viewer, CLI renderer) must draw what they
are given and must not re-derive either from dihedral angles when the fields
are present:

- `normals` — per-vertex shading normals. Smooth within one surface, hard
  across boolean-cut seams. OCCT ships analytic B-rep normals; Manifold ships
  the policy-aware crease pass (`src/framework/geometry/creased-normals.js`).
- `edges` — flat feature-edge segment pairs (6 floats per segment). An EMPTY
  array means "this solid has no feature edges"; it is not "unknown". OCCT
  ships true B-rep edges with tangent edges (fillet blends, seam lines)
  filtered out; Manifold ships policy-gated sharp/seam segments.

`loft` accepts `shading?: "smooth" | "faceted"` to override facet-vs-smooth
inference. Point-list (poly-exact) lofts infer as before: rings with fewer than
32 sides shade as intentional flat facets with no same-surface edge lines, while
rings with 32+ sides (and `ruled: false` lofts) shade smooth. Curve and resample
lofts shade by **tessellation provenance** instead of a single whole-solid
policy: the walls partition into shading sectors split at sharp contour joints
(and at snapped corners in a resample morph), and into band groups split at
silhouette-kink rings (wall direction bending more than the 5° tangent bar —
the same bar at which a B-rep loft's real ring edges draw lines). Sector and
band-group boundaries flat-shade and draw dividing lines regardless of bend
angle; only sectors whose facets come from smoothly tessellated curve spans
shade smooth inside. `shading: "smooth"` forces whole-solid smooth shading;
`shading: "faceted"` forces facets — either hint bypasses sectoring entirely;
any other non-nullish value throws. Thresholds live in
`src/framework/geometry/shading-policy.js`.

Known limitation: the OCCT backend ignores `shading` — a loft forced to OCCT
via `meta.backend` draws its facet corner edges as B-rep feature lines. The
hint is honored on the Manifold path, which is where lofts preview by default.

`label()`ing a compound solid (one spanning more than one original surface)
collapses it to a single shading surface that inherits the majority policy of
its registered constituent surfaces, weighted by triangle count. A constituent
with no registered policy of its own (e.g. a plain boolean tool) still votes,
as SMOOTH — the policy it actually renders with — and an exact tie resolves to
the no-lines (faceted) policy. Two exceptions preserve their surface partition
through labeling instead of collapsing: fillet/chamfer blend bands (base +
blend re-stamp as two surfaces), and provenance-sectored lofts (every sector
and band-group run re-stamps 1:1) — in both cases all the resulting surfaces
carry the one label, so hover/pick still reads a single feature.

**Selectors** (`fillet`/`chamfer` `edges` selector, `shell` `open` face selector) are
declarative objects, criteria AND-combined:

```js
{ dir: "X"|"Y"|"Z",           // edges along / faces normal-to this axis — edge
                              //   selectors ALSO accept an [x,y,z] vector; face
                              //   selectors (shell open) accept ONLY the strings
  inPlane: "XY"|"XZ"|"YZ", at: number,   // in the given plane at offset `at`
  near: [x,y,z] }                        // containing this point
```

`undefined` selects all edges/faces. A raw replicad finder function is also accepted
in-repo (AUTHORING-PARTS.md offers it for parts that are content to stay OCCT-bound),
but it is
inherently backend-specific: portable parts **MUST** use the object form, and a host
**MAY** reject function selectors.

**B-rep repair policy** (`occt-repair.js`): a failing fillet or shell is skipped **as a
whole** — attempted once, and on failure the shape reverts to its pre-op state (OCCT
fillet failures are not monotonic in the radius, so per-edge retry would converge on
garbage). A failing chamfer instead binary-searches the largest valid distance. A
conforming B-rep kernel must degrade this way — a fillet request must never brick the
build, and authors should expect all-or-nothing filleting per call, not per edge.

**Mesh degrade policy** (`mesh-fillet.js` + `manifold-backend.js`): an unsupported edge
class or a function selector *reroutes* — it throws `KernelCapabilityError` and the
framework retries the build on the B-rep kernel, which then applies its own repair
policy. Every other fillet/chamfer failure on the mesh class (a geometry-defeated
blend, a selector naming an unknown plane, an empty selection error from the machinery)
now **skips like the B-rep policy**: the op returns its input solid unchanged and
records a feature-skip warning instead of failing the build. One asymmetry is
deliberate: the mesh class does **not** validate radius feasibility (an oversized
radius yields self-intersecting tools and a wrong shape rather than a skipped feature),
so parts should clamp magnitudes against local geometry the way `filleted-box.js`
does — good practice on both classes, mandatory on this one.

**2-D corner-op policy** (`contour-ops.js`, partforge 0.69): `Shape2D.fillet`/`.chamfer`
— and the free `filletProfile`/`chamferProfile` — **CLAMP** a magnitude the geometry
cannot take rather than throwing. Two ceilings apply, and both were already computed
for the error messages this replaces: a per-corner one (closed-form for a line-line
corner, bisected for a curve-adjacent one) and a shared-edge one where two selected
corners claim the same segment, resolved by scaling both until they fit — exactly in
one step on a straight edge, geometrically on a curved one, bounded at 8 passes. Each
clamp is reported through the warnings channel. It still throws where there is no
feasible magnitude at all: a corner the curve solver cannot fit at any radius, a
selector matching no corner, and a shared edge still overlapping after the pass bound.
A conforming implementation must not silently return the requested magnitude.

**Feature-skip warnings channel** (both backends, partforge 0.69): every skipped,
clamped, or rescued feature is recorded on the kernel and drained with
`kernel.takeBuildWarnings()`. The full set: a mesh fillet/chamfer that returned its
input, occt-repair's skip/bisection rescues, a `roundall-skipped`, an `extrude` rim
bevel reduced or left square, a `roundedBox` rim radius clamped to `round.side`, and
a `Shape2D.fillet`/`.chamfer` corner clamped to what its edges can hold. Backend-neutral
helpers reach the recorder through the kernel's internal `_recordWarning`, so there is
one list per build rather than one per subsystem. The worker job layer (`jobs.js`) drains per
sub-part and attaches `warnings: [{part, message}]` to the `meshes` /
`capture-meshes` result when any were recorded, so a host can tell its user (or its
agent) that the part on screen is missing a feature it asked for. A skipped op still
console.warns as before; the channel is additive. Hosts that ignore the field see
exactly the old behavior. The same array also carries *job-level* notices that
belong to no single sub-part — currently a font source refused by its control's
`allow` list — as entries with `part: null`.

**Boolean result gate** (both backends, partforge 0.110, `boolean-gate.js`): every
author-facing boolean — `cut`, `cutAll`, `intersect`, `union` in both forms, and the
B-rep backend's internal tool fuse inside `cutAll` — is judged AFTER it runs, by
volume against its operands, and a result that violates the one property no boolean
may violate **throws** (`code: "BOOLEAN_RESULT_INVALID"`, message leading
`boolean result invalid:`): a union smaller than any operand, a cut larger than its
body, an intersection larger than its smallest operand, a negative volume. Each
inequality carries 1% of the operand it is compared AGAINST as slack (floored at
1e-6 mm³) — never of the largest operand, which would switch the cut and intersect
rules off whenever the tool is the big one — so volume-integration noise can never
fire them. Two signatures the inequalities cannot decide are confirmed lazily, on that
signature only: first a free bounding-box enclosure test, then ONE extra intersect. A
union whose volume equals one operand's to float precision is refused when the other
operand has material outside it, judged against that operand's OWN size (the
documented silent failure — a thin thread ridge dropped, the core returned alone);
a cut that came back empty is refused when its tools cannot have covered the body. A
probe that fails is inconclusive, never a refusal, and so is a negative OPERAND (broken
input, not this boolean's doing). On the B-rep class the probe intersect runs through
the coincidence guard like every other boolean — it runs on exactly the pair that just
misbehaved — and a guard refusal counts as "nothing inside", which on the equal-volume
signature is the refusal the gate was about to make anyway rather than an unabortable
grind. A refusal is remembered by cache key, so a live edit does not re-pay the failing
boolean per rebuild. This is deliberately NOT the warnings channel: a skipped fillet is
an honest part minus a feature, whereas a union that lost its core is wrong, and the two
other provably-wrong cases in this contract (an empty `Shape2D` reaching `extrude`, the
coincidence guard) throw for the same reason; a refusal raised by a boolean INSIDE a
degrading feature (the mesh fillet's own cutters and fillers, a B-rep `safeOp`) is
caught by that feature's policy and reported as its skip, message included. Results are
judged once, before they enter the solid cache. A conforming mesh kernel is expected
never to trip it — the rule is stated for both classes so that a mesh-class refusal
reads as the kernel bug it would be; measured, the volume reads cost ~0.4% on a
hundred-cut chain there. Classification: additive, `CONTRACT_VERSION` stays 4. The
Versioning rule below counts "tightened validation that rejects previously valid
input" as breaking; this rejects input the kernel previously ACCEPTED but never built
correctly — every refused result is wrong geometry the author could not have wanted —
so no previously valid part changes, and a part it refuses was already broken on that
backend, with the breakage now named.

## Shape2D (2-D booleans)

`k.shape2d(profile)` (`KERNEL_OPS`) lifts a point list, `{outer,
holes?}` region, region array, or arc/curve contour into a `Shape2D` — a 2-D
sketch value carrying booleans, transforms, corner ops and queries. Idempotent:
`shape2d(x)` returns `x` unchanged if `x` is already a `Shape2D`. `_`-prefixed
keys are internals. Normative signatures: `kernel.js`'s `@typedef Shape2D`; the
full public surface is `SHAPE2D_OPS`. The `kernel-front.js`
`KernelCapabilityError` stub for `shape2d` is a dead / future-backend safety net
only (both current backends define the op), not an OCCT limitation.

**Contour storage.** A `Shape2D` stores a **curve-native contour IR** — a region
list `[{outer, holes[]}]` whose contours are `{start, segments}` with line, arc
(`{to, via}`) and cubic (`{to, c1, c2}`) segments. It is *not* a backend handle:
no `CrossSection` and no replicad `Drawing` exists until the shape is handed to a
kernel op. Curves therefore survive every op, on both backends — a rounded corner
is still a circle after a union, and reaches STEP as a real `CIRCLE` entity.

**One shared implementation.** `geometry/shape2d.js` implements the whole surface
against that IR, and both backends instantiate it. Booleans run through **paper.js**
(pure JS, curve-exact), as do the transforms, corner ops and queries — so
`union`/`cut`/`intersect`/`cutAll`, `translate`/`rotate`/`scale`/`mirror`,
`fillet`/`chamfer`/`simplify`, and `area`/`boundingBox`/`corners`/`contains` are
**backend-identical**, not merely parity-tolerant. `area()` and `boundingBox()` are
curve-exact (they integrate the real curves; they do not measure a tessellation).
`offset` runs on this same shared engine (`geometry/contour-offset.js`) — see below —
so it is backend-identical too, like everything else in this list.

**Lazy materialization.** Backend geometry is built only where it is unavoidable.
Three readbacks tessellate to point rings at the backend's own LOD (Manifold 116 per
circle at preview and, at print, the fewest segments holding a 0.01 mm chord sagitta
between 116 and 480 — per arc, by its radius; OCCT 64): `toRegions()`, `simple()` (its unwrapped form), and
`regions()` — scission currently round-trips through `toRegions()`, so each returned
`Shape2D` is a faceted copy, not a curve-native slice of the original. `extrude` and
`revolve` materialize the shape into the backend's own form instead (Manifold: a
`CrossSection`, memoized in the solid cache by content hash + LOD, so extruding the
same shape twice tessellates once; OCCT: a fresh `Drawing` per call, drawn from the
contours — arcs and cubics become true B-rep edges). A `Shape2D` may be passed
directly as the `profile` to `extrude`/`revolve`, holes included. `toContours()` is
the one readback that tessellates nothing.

**Offset runs on the contour IR too.** `Shape2D.offset(delta, { corners })` runs
backend-independently on the contour IR — no backend `CrossSection` or `Drawing` is
ever involved. Lines and arcs offset exactly (arcs stay arcs); cubics are
approximated to ≤ 1e-3 mm deviation. `corners: "round"` inserts exact arc joins,
`"chamfer"` a true 45°-bisecting bevel chord at every corner angle, `"sharp"` miters
with limit 2 (falling back to the bevel chord past the limit). Self-intersecting raw
results are resolved through the shared planar boolean engine (paper.js), which may
return arcs as cubic approximations — identical to boolean-op output. `segs` is
accepted and ignored (there is no backend LOD to tune). Both backends produce
identical offset geometry by construction, like every other Shape2D op.

A region with holes offsets **material-wise**: the outer boundary moves by `delta`,
each hole by `-delta`, so a positive `delta` always adds material (the outer grows,
holes shrink) and a negative one always removes it (the outer shrinks, holes grow) —
never the reverse for either. This one shared implementation is what guarantees it;
a route that offsets a single fused `outer.cut(hole)` drawing with one call gets it
backwards for the holes (see the migration note below).

| Op | Contract |
|---|---|
| `union(other)` / `cut(other)` / `cutAll(others[])` / `intersect(other)` | 2-D boolean ops; `other` may be a `Shape2D` or a raw profile (lifted via `shape2d` first). Curve-exact and backend-identical (paper.js). |
| `offset(delta, {corners?, segs?})` | Grows (`delta>0`) or insets (`delta<0`) by `delta` mm; `corners` = `round` (default) / `chamfer` / `sharp`. Runs backend-independently on the contour IR — lines/arcs offset exactly, cubics approximate to ≤ 1e-3 mm; `chamfer` is a true 45°-bisecting bevel at every corner angle, `sharp` miters with limit 2. Backend-identical by construction, like every other Shape2D op. Holes offset material-wise (`-delta` where the outer gets `delta`). `segs` is accepted and ignored. Empty in → empty out (short-circuits before the engine). Throws if the offset collapses the shape. |
| `area()` | Net area (Σ\|outers\| − Σ\|holes\|), mm². Curve-exact. |
| `boundingBox()` | `{min, max}` — axis-aligned 2-D bounds, curve-exact (no `center`/`size`, unlike `Solid.boundingBox`). |
| `toRegions()` | Materialize into `{outer, holes}[]` point-ring region arrays (`assembleRegions`), tessellating curves at the backend's LOD; a boolean result may be several disjoint regions. |
| `toContours()` | The stored contour IR — `{outer, holes}[]` of `{start, segments}` contours, **curve-native and lossless** (no tessellation). Returns a deep copy, safe to mutate. |
| `simple()` | `toRegions()` unwrapped — throws unless the result is exactly one region. |
| `regions()` | Scission: each disjoint region as its own live `Shape2D[]` (each further boolean-able), vs `toRegions()` which returns raw `{outer, holes}` data. Goes through `toRegions()`, so the pieces are tessellated at the backend's LOD — curves do not survive scission. |
| `translate([dx,dy])` / `rotate(deg, center?)` / `scale(f\|[sx,sy], center?)` / `mirror(axis)` | Rigid/similarity transforms on the contours (curve-preserving). `center` defaults to the origin; `axis` is `"x"`, `"y"`, or `{point, dir}`. `scale`'s factor is uniform when a bare number, per-axis when `[sx,sy]`. |
| `fillet(r, {corners?})` / `chamfer(d, {corners?})` | Round (true arcs) or bevel (straight chords) selected corners. `corners` = `"all"` (default) / `"convex"` / `"concave"` / `{indices}` / `{near, count?}`; `r`/`d` may be an array paired positionally with `{indices}`. Throws when no corner matches. |
| `simplify(tolerance)` | Corner-preserving decimation/refit within `tolerance` mm — dense point rings become fewer segments (and refit arcs/cubics) without moving corners. |
| `corners()` | The corner list — `{index, point, interiorAngleDeg, convex, segTypes}[]`. This positional order is what `fillet`/`chamfer`'s `{indices}` selects into. |
| `contains([x,y])` | Point-in-shape test (inside an outer, not inside a hole). |
| `isEmpty()` | `true` when the shape has no regions at all — a `cut`/`intersect` legitimately removed everything. Pure JS on the stored IR, backend-identical. See "Empty shapes" below. |
| `extrude({h, twist?, scaleTop?})` | Sugar for `k.extrude({profile: this, …})` → `Solid`. Throws on an empty shape (see "Empty shapes"). |
| `revolve({degrees?})` | Sugar for `k.revolve({profile: this, …})` → `Solid`. Throws on an empty shape (see "Empty shapes"). |
| `clone()` | Independent copy. Every op returns a NEW `Shape2D`; no operand is ever mutated. |

**Empty shapes.** An empty `Shape2D` is a legal 2-D value, and every 2-D op is total
on it: booleans treat it as the identity/absorbing element, transforms and `offset`
return it unchanged, `area()` is 0, `toRegions()` is `[]`. What it cannot do is become
3-D: `extrude` and `revolve` (either calling form, on both backends) throw
`"<op>: the profile Shape2D is empty — nothing to build (a cut/intersect may have
removed everything; guard with .isEmpty())"`. The check runs in the shared op-spec
layer before any backend materialization, so the two backends agree by construction.
A part whose parameters can drive a feature to nothing guards explicitly:
`if (!pocket.isEmpty()) body = body.cut(pocket.extrude({ h }))`. (Before this was
pinned, Manifold silently built an empty solid where OCCT threw — behavior no part
could rely on portably, so defining it follows the reference backend and is not a
contract break.)

On `offset`: `round`, `sharp`, and `chamfer` all agree across both backends **at every corner angle, convex or reflex** — a 10×10 square offset +1 gives 142.0 on both, a pentagon 298.920 on both, and an equilateral triangle's chamfer agrees to float precision on both, with no acute-corner carve-out. This follows from `offset` being one native implementation rather than a call into either backend's own 2-D engine — there is no Clipper2-vs-OCCT split left to diverge.

The three tessellating readbacks — `toRegions()`, `simple()`, `regions()` — remain LOD-dependent: they hand back point rings sampled at the backend's own segment count, so the two backends' output differs in vertex count and by chord error, converging as LOD rises. Those three ops are the whole LOD-dependent surface; everything else, including `offset`, is backend-identical.

**Known limitations.** The native offset engine has verified defects on specific input
shapes — on inward offsets that sever a shape, and on outward offsets of text — under **all
three corner styles at nearly the same rate**; see [Offset: known
limitations](#offset-known-limitations) below for the parked cases, their measured values,
the committed corpus and script that produce every rate quoted there, and the independent
construction the truths come from.

**Fillet after a boolean reaches STEP as real arcs.** Because booleans preserve curves
and `fillet` inserts true arc segments, `shape2d(a).union(b).fillet(2).extrude({h})`
exports a filleted profile as `CIRCLE` B-rep entities on OCCT — the corner op does not
have to run before the boolean, and no facet fan is baked in along the way. (Manifold
facets at mesh LOD, as always, since its meshes have no curve representation.)

### Offset: known limitations

The native offset engine preserves line, arc, and cubic contour IR through its normal cleanup
path. Tangled raw offsets are split at crossings, classified under the Positive winding rule,
and chained back into regions by `geometry/contour-winding.js`. Positive round dilation also
uses the source hole's inradius to prove when a counter has fully closed, and positive
dilation drops output components that contain no source material. These are source-domain
topology proofs, not output-area heuristics.

The reported text case is covered as correctness in
`test/offset-oracle-manifold.test.js`: the 6-glyph × 7-delta round matrix, including
`"Scott"` at +0.8/+1.5/+2/+3, matches Clipper2 region and hole counts exactly and stays
within the corpus area tolerance. `"Scott"` retains native arcs and cubics at every tested
delta.

**Measured failure surface.** The committed instrument is
`node scripts/offset-rates.mjs`, over 600 deterministic seeded shapes plus six glyph cases,
20 deltas, and three corner styles (36,090 attempts). In partforge 0.68.1 (after the
fold-aware clearance fix in the winding classifier) it reports:

- before the retry ladder: round 0/12,030, chamfer 1/12,030 (0.008%), sharp
  1/12,030 (0.008%);
- after the retry ladder: zero chain-incomplete failures for all three styles;
- two oracle-checked rescues, with median area error 0.0727%, worst 0.073%
  (0.0720 mm²), zero region-count losses, and zero complete arc losses.

The ladder remains a numerical escape hatch: it perturbs delta by 1e-9, coarsens crossing
clustering, then tries polyline outlines. A future case that reaches a coarse clustering or
polyline rung can still lose fine topology or native arcs, so the order remains
fidelity-first and every newly found rescue must be checked against the independent
Minkowski oracle.

The currently parked limitations are narrower:

- **Round erosion with several holes reaching the eroded outer can keep too much material.**
  The characterized 30×20 plate with three rectangular holes at −2 returns about 324.75
  instead of the 258.18 oracle truth under round corners; chamfer and sharp are exact.
- **Fully eroded holes under sharp and chamfer can leave a remnant.** The source-inradius
  gate is intentionally limited to round joins, whose structuring element is a Euclidean
  disk. A 1×1 hole at +2 closes correctly under round, while the sharp/chamfer variants
  remain parked rather than applying the wrong geometric criterion.
- **Erosion can emit sub-0.001 mm² rings.** Five exact seeded cases are pinned in
  `test/offset-fuzz.test.js`. They are not automatically deleted: unlike positive
  dilation, erosion has no source-membership invariant that distinguishes a false island
  from a genuine surviving crumb.

The fuzz oracle sweep covers 150 seeded shapes × 6 deltas × 3 styles and currently reports
no region-count, hole-count, or area disagreements outside those explicit
characterizations. Do not widen tolerances or add an area-based sliver filter when a new
case appears; add its deterministic fixture and establish the source-domain truth first.
## The 2-D helper library

`partforge/geometry` ships pure-JS helpers of several kinds. The **contour builders**
(`piePolygon`, `hexPolygon`, `regularPolygon`, `roundedRectPolygon`, `ellipsePolygon`,
`slotPolygon`, `starPolygon`, `ringSectorPolygon`, `circleProfile`, `cornerArc`,
`filletPolygon`, `roundedProfile`) are pure functions from numbers to plain CCW point
lists or arc profiles — *data already in this contract's input format*, with no kernel
dependency at all. The **solid patterns** (`linearPattern`, `circularPattern`) take a
`Solid` and call only ops from the tables above (`clone`/`translate`/`rotate`/
`boundingBox`). The **profile transform** (`offsetPolygon`) takes a point list or
`{outer, holes}` region and grows or shrinks it by a delta in mm — printer-clearance
offsetting with round/chamfer/sharp corner styles — validating its input and result and
throwing rather than ever returning degenerate (self-intersecting or collapsed)
geometry. All are therefore portable by construction: a host implements the kernel and
the helpers come along unmodified. (`test/kernel-contract.test.js` asserts every
`polygon.js` export is named here.)

- `pathProfile` — fluent builder for a curve-native path contour (`lineTo` /
  `arcTo` / `cubicTo` / `close`); cubic segments become exact B-rep on OCCT and
  facet at mesh LOD on Manifold.

**Profile validation on the way in** (0.112). `prism`, `extrude`, `revolve`, `sweep`,
`loft` (per ring) and `shape2d` (including boolean operands) run `validateProfile` on a
hand-authored profile — a point list, a `{start, segments}` contour, a `{outer, holes}`
region — and record each `self-intersection` issue on the build's warnings
(`takeBuildWarnings()`), prefixed `<op>: profile` / `loft: ring <i>`, deduplicated per
drain. It never throws and never changes the built geometry; a `Shape2D` is never
re-validated. Three bounds keep it cheap and keep its output readable: a profile over
4000 contour segments (counted as authored, before curve sampling) is skipped; `loft`
applies that ceiling to the **sum** over its rings, not per ring, so a many-ring loft
(everything `loftSmooth` produces) is skipped whole rather than validated ring by ring on
every rebuild; and at most **three** crossings are reported per profile, the third
carrying `(and N more crossings on this profile)`. A contact between two contours of one
region — a hole drawn flush with its outer — is **not** reported: it builds exactly as
drawn, so `validateProfile` tags it `crosses` and the warning skips it. This lives in the
shared front (`profile-warnings.js`), so both backends emit identical text — a host
implementing the kernel gets it by wiring one warner (build it beside the warnings list,
expose `_warnProfile`, pass `warnProfile` to the Shape2D factory, reset it on drain). Not
a contract-version change (additive, the import-op precedent).

### 2-D editing ops

The **2-D editing ops** are the free-function twins of the `Shape2D` transforms,
corner ops and queries documented above — the same `contour-ops.js`/paper.js
machinery, callable directly on a point list, a `{start, segments}` contour, a
`{outer, holes}` region, or a region array, with no `shape2d()` lift required.
Every op returns the same shape of input it was given (a bare point list stays a
point list, upgrading to a contour only if the op introduces curves — e.g. a
non-uniform scale on an arc). The arc-length queries are the one exception:
being single-contour by nature, they throw on a region. The full set: `translateProfile`,
`rotateProfile`, `scaleProfile`, `mirrorProfile`, `filletProfile`, `chamferProfile`,
`profileCorners`, `profileLength`, `profilePointAt`, `profileTangentAt`,
`profileNearestPoint`, `profileBounds`, `profileArea`, `profileContains`,
`simplifyProfile`, `validateProfile`.

| Group | Function | Notes |
|---|---|---|
| Transforms | `translateProfile(input, [dx,dy])` | exact on all segment types |
| | `rotateProfile(input, deg, center?)` | arcs stay arcs |
| | `scaleProfile(input, s \| [sx,sy], center?)` | non-uniform scale converts `{to,via}` arcs to cubics |
| | `mirrorProfile(input, axis)` | `axis: "x" \| "y" \| {point, dir}` |
| Corners | `filletProfile(input, r, opts?)` | `r` may be an array paired with `{indices}` |
| | `chamferProfile(input, dist, opts?)` | symmetric setback, straight connector |
| | `profileCorners(input)` | `[{index, point, interiorAngleDeg, convex, segTypes}]` |
| Queries | `profileLength(contour)` | mm; single contour only |
| | `profilePointAt(contour, {t} \| {length})` | single contour only |
| | `profileTangentAt(contour, {t} \| {length})` | unit vector; single contour only |
| | `profileNearestPoint(input, [x,y])` | `{point, distance, contourIndex, segmentIndex, t}`; accepts regions |
| | `profileBounds(input)` | curve-exact `{min, max}` |
| | `profileArea(input)` | outers − holes, curve-exact |
| | `profileContains(input, [x,y])` | curve-aware containment |
| Cleanup | `simplifyProfile(input, tolerance)` | corner-preserving decimation/refit |
| Validation | `validateProfile(input)` | `{ok, issues}`; never throws |

`filletProfile`/`chamferProfile`'s `opts.corners` selector and `profileCorners`'s
positional order match `Shape2D.fillet`/`Shape2D.chamfer`/`Shape2D.corners`
exactly — `CornerSelector` above applies unchanged. Mirror and negative-scale
inputs re-normalize winding (outer CCW, holes CW) before returning, so no op can
hand the kernel inverted regions.

## Worker rebind

The op tables above are the portable seam for *geometry*; this section is the matching
seam for *worker lifetime*. A host that shows one part after another (an embedder, the
cloud runner) can keep a single worker across the swap and reuse its booted WASM kernel
and warm solid cache instead of paying the boot cost again.

`runWorker(part)` (`src/framework/worker.js`) returns a rebind handle —
`{ setPart(newPart) }` — and that handle is the whole interface. The framework defines
**no rebind *message***: a host that talks to its worker over its own re-init protocol
maps that protocol onto `setPart` itself.

`setPart(newPart)` does four things, synchronously, on the worker's own turn:

- **Swaps the part** for jobs that arrive *after* the call. Jobs already queued keep the
  part that was current when their message arrived — a job always runs against the part
  it was sent for, never against a part that replaced it mid-flight.
- **Bumps the generate epoch**, which is what makes earlier builds stale (below).
- **Sweeps each booted kernel's solid cache** — one `sweepCache()` per booted kernel,
  never inside a `beginSubPart`/`endSubPart` bracket. See the Optional ops paragraph
  under [Conformance classes](#conformance-classes) for what the sweep evicts; a host
  whose kernel omits the op simply keeps every partition.
- **Re-posts `{type:"ready"}`**, so a remounting host gates its first generate on
  readiness exactly as it would on a freshly spawned worker.

**Epoch guard.** Generates supersede each other; exports (`export-stl`/`export-step`/
`export-3mf`), `inspect`, and `lint` are **never** epoch-guarded — cancelling a user's
export because an edit landed would be wrong. A generate that is stale by the time the
job pump reaches it is skipped and never builds at all. A generate already running
re-checks staleness at each sub-part boundary and, if it has been superseded, stops
there and posts `{type:"superseded"}` **instead of** `{type:"meshes"}` — a build that
ended without producing meshes, and not an error. A generate with no boundary left to
stop at — one that goes stale during its *final* sub-part, or a single-sub-part generate
that goes stale once the pump has dequeued it — runs to completion, and the worker then
discards its result the same way, posting `{type:"superseded"}` in place of the meshes it
built. So **a `meshes` post is current as of the moment it is posted**: it is never a
previous part's geometry surfacing after a rebind, and a host may take it as the build
outcome for the part it currently has mounted.

**Host-side rule for `superseded`.** partforge's own `mount()` does not handle a
`superseded` message, and does not need to: in its single-mount flow the regen loop
serializes generates, so no generate is ever in flight when the next one is sent and the
message is unreachable. An **embedding host that rebinds via `setPart` must** do one of
two things:

- detach the old message listener before rebinding — the partforge-cloud pattern. A
  rebound worker's next mount sends its first generate *after* `setPart`, so that
  generate can never be stale, and any `superseded` from the previous mount lands on a
  listener that is already gone; or
- handle `superseded` explicitly as "this build ended without meshes" — clear the busy
  state, keep the current geometry, and wait for the next result. A host that instead
  lets it fall through a `meshes`-only handler leaves a spinner up forever.

**Only `meshes` is epoch-gated**, so the second option is the weaker one. A stale build's
other posts — `progress`, `error`, `needs-occt` — are not gated and still reach a listener
that survived the rebind: a stale `error` would mark a perfectly good new part failed, and
a stale `needs-occt` would stickily flip the host's backend for a part that never asked for
it. Handling `superseded` fixes the stuck spinner but not that crosstalk, which is why
detaching the listener is the recommended pattern. `needs-import-mesh` — posted when a
build throws an error carrying code `NEEDS_IMPORT_MESH` (an unprimed STEP import on the
Manifold backend, thrown from `imports.js`'s registration policy, not `errors.js`'s
`KernelCapabilityError`/`NEEDS_OCCT`) — is the same message shape and the same
non-epoch-gated risk as `needs-occt`; a host handling one should handle both the same way.

**Cancellation granularity is the sub-part.** The guard is checked only between
sub-parts (one macrotask yield each), so a single long WASM op — a big boolean, an OCCT
fillet — runs to completion no matter how stale it is. That is by design: WASM kernel
calls are not interruptible, and a build that abandons a sub-part mid-bracket would
strand pinned cache entries. Hosts should size responsiveness expectations against the
slowest single sub-part, not the whole build. Cancellation is therefore about *work
avoided*, never about correctness of what is posted: work already under way may finish,
but its output is still gated behind the epoch before it leaves the worker.

## Versioning

The contract version is the number at the top of this document, mirrored by
`CONTRACT_VERSION` in `kernel.js` (the parity test asserts the two match). The op lists
in `kernel.js` define the current surface; only breaking changes bump the version:

- **Additive** (new kernel/Solid op, new optional field on an options object, new
  optional mesh-output field): contract version unchanged, minor npm release. Old parts
  run everywhere; new parts need hosts that implement the new op.
- **Breaking** (changed signature or semantics, removed op, new *required* argument,
  tightened validation that rejects previously valid input): contract version bump,
  **major npm release**, and a migration note added here. Removal without a major bump
  is forbidden.
- The naming vocabulary is frozen deliberately: where a name was arbitrary it matches
  the OpenSCAD/Manifold/CadQuery consensus (`union`, `translate`, `rotate`, `mirror`;
  `cut` per CadQuery/replicad rather than OpenSCAD's `difference`), so LLM priors
  transfer. Renames are breaking changes with no offsetting benefit — don't.

**v3 → v4** (partforge 0.63): `Solid.roundAll` is added to `SOLID_OPS` (portable
morphological rounding — rounds every edge with a ball of radius `r`;
parity-tolerant, regime-split semantics, see
[Conformance classes](#conformance-classes)). Additive for parts — nothing
existing calls it — but breaking for backend implementers: a core kernel must
now implement it (no stub, unlike the `OCCT_ONLY_OPS` ops).

**v2 → v3** (partforge 0.62): `Solid.fillet` and `Solid.chamfer` are implemented
natively on the mesh (core reference) kernel for straight and circular-arc edge
chains, and are **no longer probe-routed to OCCT** — `ROUTED_CAD_OPS` (`shell`) is
the remaining probe-routing set, and unsupported edge classes reroute at runtime via
`KernelCapabilityError`. Semantics change for existing parts: a part using fillet or
chamfer now previews (and STL/3MF-exports) from the mesh kernel's tolerance-band
blend instead of paying for the OCCT worker; STEP export still uses OCCT's exact
blends. Behavioral deltas to re-measure when migrating: vertex junctions between
blended chains are mitred rather than corner-blended, radius feasibility is not
validated on the mesh class (clamp in the part), and a fillet/chamfer that previously
*failed and was skipped* by OCCT's repair policy may now build (mesh) or reroute.

**v1 → v2** (partforge 0.59): `Shape2D.offset` moved off the two per-backend 2-D
engines (Clipper2 via `CrossSection` on Manifold, replicad's `Drawing.offset` on
OCCT) onto the single native contour-offset engine described above. Semantics
changed, not just implementation: `offset` is now backend-identical by construction
at every corner angle (the old acute-corner `chamfer` divergence and the LOD-faceted
Manifold result are both gone), and `segs` is now accepted-but-ignored rather than
tuning Manifold's tessellation. Holes offset material-wise (`-delta` where the outer
gets `delta`) on both backends — the deleted OCCT production route got this backwards
by fusing `outer.cut(hole)` into one `Drawing` and offsetting it with a single call,
so holes grew under a positive `delta` instead of shrinking; no test caught it because
there was no holed-offset test before this contract version. Parts that relied on the
old holed-offset direction (if any existed) need the sign of their workaround removed.

**`sharp` and `chamfer` change shape on acute corners — check these when migrating.** This
is a real geometric change, not a precision polish, and it is the one thing v1 parts should
be re-measured for. Once a convex corner gets tighter than 90° the two old backends did not
agree with each other, and neither agreed with this repo's own `offsetPolygon`; v1's claim
that "`round` and `sharp` are exact across backends at every angle" was simply false.
Measured on an 11-point star (alternating radii 10 and 4) at `delta` +2:

| corners | native (v2) | Clipper2 (v1 Manifold) | OCCT (v1 B-rep) | `offsetPolygon` |
| --- | --- | --- | --- | --- |
| `round` | 295.933 | 295.933 | 295.933 | 295.933 |
| `sharp` | 282.158 | 300.671 | 326.534 | 282.158 |
| `chamfer` | 278.389 | 288.138 | 278.389 | 278.389 |

The spread is **miter-limit policy**, not accuracy: OCCT miters unbounded, so an acute spike
shoots arbitrarily far past the corner; Clipper2 squares the corner off past its own limit
rather than bevelling it. Native applies miter limit 2 and falls back to a plain bevel — the
same rule `offsetPolygon` (`geometry/polygon.js`) has always used, so `offset` and
`offsetPolygon` now agree to the digit where previously *neither* backend matched the pure-JS
helper sitting next to it. `chamfer` additionally lands exactly on OCCT's `bevel` join; only
Clipper2 differed there, because it had no bevel join and approximated one with two chords.

Practical rule: divergence from v1 is confined to `sharp` and `chamfer` on **outward**
offsets of shapes with sub-90° convex corners (star points, V-notches, triangles, spiky text
serifs), and native is always the *smaller*, never the over-solid, result — a clearance
offset that fit in v1 still fits. `round` is unchanged at every angle, inward offsets are
unchanged, and shapes whose corners are all ≥90° (rectangles, hexagons, rounded-rects, slots)
are unchanged. A random-polygon sweep put the >1%-divergent share at 1.6% overall, every one
of them `sharp` or `chamfer` at positive delta.

## Why not an existing CAD language

Considered and rejected as the part format (2026-07; revisit if the landscape shifts):

- **CadQuery** — largest corpus after OpenSCAD, but its workplane-stack + string-selector
  model is B-rep-native and cannot be implemented on the mesh backend; Python besides.
- **KCL (Zoo)** — designed for LLM generation, but young, sketch-plane-shaped, and tied
  to one vendor's engine; adopting it costs the dual-backend seam.
- **replicad** — already the OCCT backend; part of partforge's value is papering over
  its consuming-transform semantics. Matching downward would re-expose them.
- **OpenSCAD** — closest semantic cousin (Manifold is its modern engine) and the largest
  LLM prior; unadoptable as syntax (own language, no fillets/STEP), so we align
  *vocabulary* instead.

The recurring constraint: every op here is implementable on **both** a mesh-CSG kernel
and a B-rep kernel (see `docs/geometry-backend-strategy.md` for why that dual-backend
property is worth protecting — OCCT booleans are ~75–1400× slower). Generation *safety*
comes not from a restricted DSL but from the verify loop (`measure`/`verify` gates:
`bbox`, `volume`, `holes`, `watertight`, overlaps — plus `minWall` and `overhangArea`
*warnings*, which report but never fail) — a generator gets machine-checkable
pass/fail feedback per part, which a syntax could never provide.

## Conformance checklist for a new backend or host

1. Implement `KERNEL_OPS` + `SOLID_OPS` (stub `OCCT_ONLY_OPS`/`toSTEP` with
   `KernelCapabilityError` if core class); route through `finishKernel()`/`addSugar()`
   if building in-repo to inherit validation, sugar, and stubs.
2. Pass `test/kernel-contract.test.js` (op-list parity) — add an equivalent for an
   out-of-repo host.
3. Honor the global semantics above (units, Z-up, CCW, value semantics, determinism).
4. Run **every part in `src/parts/`** through `npx partforge measure` unmodified — the
   directory, not this prose, is the acceptance suite (today that includes
   `faceted-vase.js`, the `loft` exerciser, and — B-rep class — `filleted-box.js`).
   Caveat: a part with no `verify` block (`filleted-box.js` today) exercises only the
   default measure gates, so B-rep implementers should also render it and export STEP
   rather than trust the exit code alone.
