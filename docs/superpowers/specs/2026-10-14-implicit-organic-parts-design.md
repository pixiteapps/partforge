# Implicit organic parts (`k.implicit`) — design

Date: 2026-10-14. Status: proposed. Follows the research and throwaway spike in
`docs/research/organic-shapes.md` (§7 has the spike's numbers and lessons).

## Problem

Partforge parts are built from mesh CSG and B-rep ops. Organic forms — anatomy,
creatures, plants, ergonomic grips, textured surfaces — are out of reach: booleans of
primitives give hard creases, and hull chains give ball-joint seams. We want agents to
author detailed, posable organic parts as plain data that an LLM can read, reuse,
re-pose and edit, that always come out watertight and printable, and that preview fast
enough to drag a pose slider on the fully detailed model.

The spike proved the representation (a data tree of signed-distance elements on named
frames, meshed to a Manifold solid) and the JS sparse mesher (hand preview 0.7–1.5 s,
print 0.8 mm 4.9 s). It is not fast enough for live posing at full detail, its STEP
path (sewing a triangle mesh in OCCT) does not finish on real meshes, and its `custom`
JS-function escape hatch cannot run natively.

## Decisions

| Question | Decision |
|---|---|
| Speed target for the first release | Full-detail live posing, so the native (C++) evaluator ships in the first release. |
| Escape hatch | No JS-function `custom` node. Built-in warp/repeat nodes plus `expr` formulas in a GLSL subset with image textures, compiled to the same bytecode as the tree. |
| STEP | Implicit sub-parts export as tessellated mesh bodies inside the STEP file; exact sub-parts stay B-rep. No sewing. |
| Reference parts | A posable hand and a textured vase. |
| partforge-cloud exposure | A separate organic guide, loaded on demand; the main guide carries only a short when-to-use section. Cloud routing is a follow-up PR there. |
| Engine architecture | Matched JS and C++ engines in the native core, bit-identical, the C++ as the speed path and the JS as the fallback and the readable reference. |

Rejected: a C++-only engine (a core fault would mean no geometry, and the grammar's only
definition would be WebAssembly); WebGPU compute (not available in Node/CLI/cloud's
sandbox, and non-deterministic floats break caching); NURBS/B-rep and SubD cages (see the
research doc).

## 1. Grammar

### The op

```js
k.implicit({ frames, root, detail, resolution, preview })  // -> Solid
```

- `frames` — named coordinate frames (below). Optional.
- `root` — the element tree.
- `detail` — surface detail applied after meshing (below). Optional.
- `resolution` — print/export grid edge in mm. Default 0.6.
- `preview` — preview grid edge in mm. Default 1.5.

It returns an ordinary `Solid`: transforms, booleans, `verify`, `measure` and every export
work on it unchanged. The spike's `mesher`, `polish` and `bounds` options are removed
(bounds are derived).

### Frames

`frames: { name: { parent?, at?: [x,y,z], rotate?: Rot | Rot[] } }` where
`Rot = { axis: "x"|"y"|"z"|[x,y,z], deg }`.

A frame's transform is `parent * translate(at) * R1 * R2 * …`: each rotation step is
about the frame's own current axes, in the order listed. Unknown parents and cycles are
compile errors. The guide documents the rule with a diagram, since both of the spike's
thumb bugs (handedness, flex direction) came from rotation order and were invisible in
the code.

### Nodes

Every node accepts `frame` (evaluate in that frame), `at` (a local offset) and `label` (a
name used by lint messages, errors, `measure` reports and `probes`).

| Group | Kind | Fields |
|---|---|---|
| Primitive | `sphere` | `r` |
| | `ellipsoid` | `r: [a,b,c]` |
| | `capsule` | `a`, `b`, `r` or `r: [r0, r1]` (tapered) |
| | `box` | `size: [x,y,z]`, `round` |
| | `cylinder` | `h`, `r`, `round`, `axis` |
| | `torus` | `R`, `r`, `axis` |
| | `tube` | `points`, `r` (number or one per point) |
| | `halfspace` | `normal`, `offset` |
| Combine | `union`, `intersect` | `children`, `k` (blend width, mm) |
| | `subtract` | `children` (first minus the rest), `k` |
| | `contact` | `children` (each may carry a `label`), `gap` (clearance kept at contact, mm; `0` fuses into a pad), `bulge` (skin swell around a contact, mm), `attach` (`[{ a, b, near, radius, k, band? }]`: pairs blended, not pressed, near a frame) |
| Modify | `mirror` | `plane: "yz"|"xz"|"xy"`, `child` |
| | `round` | `r`, `child` |
| | `onion` | `t`, `child` |
| | `displace` | `child`, `by` (a texture sample or an `expr`), `amount` (declared max offset, mm) |
| Warp | `twist` | `axis`, `degPerMm`, `child` |
| | `bend` | `axis`, `toward`, `radius`, `child` |
| | `taper` | `axis`, `from: [z0, s0]`, `to: [z1, s1]`, `child` |
| Repeat | `repeat` | `child`, `linear: { step: [x,y,z], count }` or `polar: { count, axis }` |
| Formula | `expr` | `sdf` (source), `uniforms`, `textures`, `box`, `lipschitz` |

Blends use the normalized quadratic smooth-min (`k` is the blend width in mm; it moves
values by at most `k/4`). Distances are negative inside.

### Detail: two places, chosen by scale

- **Shape-level `displace`** for features at least as large as the grid (ridges, a
  vein). It is part of the field, so later booleans cut through it correctly.
- **Surface `detail`** for features finer than the grid, applied after meshing along
  the normals on a locally refined mesh. Kinds: `creases`, `noise`, `texture`
  (projection `planar` | `cylindrical` | `triplanar`, `image`, `amplitude`), `expr`.
  This replaces the spike's `creases`/`noise` with one set.

### `expr` formulas

A GLSL subset, chosen because SDF knowledge online (Quilez, Shadertoy) is written in it:

- Types `float` and `vec3`; the point is `p` (in the node's frame); locals with
  `float a = …;` / `vec3 q = …;`; one `return` of a float.
- Arithmetic and comparison, swizzles (`p.xy`, `p.zx`), the ternary operator.
- Functions: `abs min max clamp mix step smoothstep length dot cross normalize floor
  fract mod sqrt sin cos smin smax texture`.
- No loops except `for` with a literal bound ≤ 16, no recursion, no access to anything
  outside its uniforms and textures.
- `uniforms` — named numbers (part params flow in here). `textures` — named slots
  bound to declared part `images` (`{ image, channel: "luma"|"r"|"g"|"b"|"a" }`),
  sampled by `texture(name, uv)` (bilinear, clamped).
- `box` — the formula's bounds. `lipschitz` — the declared bound on how fast the value
  can change (1 for a true distance).

`sin`/`cos` are partforge's own (range reduction plus a fixed polynomial, only
`+ * floor`), identical in JS and C++. Textures are capped at 2048² per texture and
16 M texels per part.

## 2. Compiler (pure JS, shared by both engines)

1. **Validate** the tree and every `expr`; errors name a path
   (`root.children[3].r: must be > 0`, `expr line 2: unknown name 'q'`).
2. **Precompute** frame matrices and every constant trig value (warps, repeat), so no
   engine calls a transcendental except partforge's own `sin`/`cos` from `expr`.
3. **Track per node** an axis-aligned bound and a Lipschitz factor. Warps and `expr`
   raise the factor; `displace` widens the margin by `amount`; blends widen it by `k/4`.
4. **Emit** register-based bytecode, a constant pool, a frame-matrix table and texture
   slots. The bytecode depends only on the tree's structure; the matrix table carries
   the pose (§4).

Cache key: canonical JSON of the spec plus each bound texture's content hash.

## 3. Evaluator and mesher (JS and C++, bit-identical)

1. **Batched interpretation.** Each instruction runs over a whole block of points
   before the next. Arithmetic in double, storage in float32, per the native core's
   rules (`native/README.md`).
2. **Per-block pruning.** Before a block is evaluated, the node bounds and Lipschitz
   factors strip every subtree that cannot affect it, and the shortened instruction list
   runs (the libfive/Fidget technique).
3. **Sparse culling.** Coarse-to-fine blocks (16 cells down to 2). A block is skipped
   only when `|d| > halfDiagonal * L + margin`, so culling never opens a hole. Samples
   are stored per surviving block — no dense grid over the bounds (the spike ran
   WebAssembly out of memory at 0.2 mm).
4. **Meshing.** Marching tetrahedra (Kuhn six-tet split), vertices welded by edge, with
   the spike's 0.25-cell snap followed by a Newton projection back to the surface.
5. **Native cleanup**, replacing the spike's Manifold `simplify`/`smoothOut`/`refine`
   round trips:
   - collapse edges shorter than a fraction of the cell, with a link-condition check so
     topology never changes;
   - two passes of tangential relaxation, each followed by projection onto the field;
   - normals from the field gradient;
   - where surface `detail` applies, split edges to the detail's wavelength and displace
     along the normal.
6. The mesh enters Manifold once (`ofMesh`, no merge) for booleans and export.
7. Single-threaded. Blocks are independent, so multi-worker splitting can come later
   without format changes.

### Performance targets

Measured by a new `npm run bench:implicit` on the reference parts (M-series desktop):

| Case | Target |
|---|---|
| Hand, full detail, preview tier, Node | ≤ 150 ms |
| Hand, full detail, preview tier, browser rebuild | ≤ 250 ms |
| One joint moved, region reuse warm | ≤ 80 ms |
| Hand, 0.5 mm print tier | ≤ 2 s |

CI enforces generous multiples of these on the CPU-pace clock
(`test/helpers/cpu-pace.js`). The targets are estimates; if the native mesher and cleanup
miss the joint-move budget, per-block mesh reuse with pinned border vertices is the
fallback (§4).

## 4. Posing and caching

- **Structure vs pose.** A parameter that only moves frames keeps the bytecode and
  rewrites the matrix table; a structural change recompiles (about a millisecond).
- **Block sample cache.** Each surviving block's samples are cached under
  `(block coordinates, hash of its pruned instruction list and every constant it reads,
  including the matrices of the frames it touches)`. Moving one finger leaves every
  other block's key unchanged, so its samples are reused; blocks the finger enters or
  leaves get new pruned lists and new keys. The key is the dependency, so there is no
  invalidation logic and no stale hit.
- **Meshing and cleanup run over the whole surface every rebuild** (cleanup relaxes
  across block borders, so per-block mesh reuse would leave seams).
- **Purity.** A cache hit and a miss give byte-identical output. The cache is a memo
  below `build`, like the kernel's content-hash cache; `build` stays pure.
- **Bounds.** One cache per geometry worker, shared across `implicit` ops,
  least-recently-used, capped at 64 MB, and within the native core's recycle threshold.
- The pose fast path (whole-sub-part matrices) does not apply: posing an implicit part
  changes its shape, so it is an ordinary parameter change through the normal job loop,
  which already drops stale rebuilds during a drag.

## 5. Backends and export

- **Routing.** A sub-part containing `k.implicit` routes to Manifold — the mirror of
  `shell`'s routing to OCCT. A sub-part combining `implicit` with an OCCT-only op
  (`shell` on a Solid) throws a clear error that suggests `onion`. A part may mix
  implicit and exact sub-parts; per-sub-part preview routing handles it.
- **STL, 3MF, preview GLB, `measure`, `verify`**: unchanged — they see a watertight
  mesh. Exports use the `resolution` grid, the preview uses `preview`.
- **STEP.** The Manifold side builds each implicit sub-part's final print-tier mesh
  (after its booleans); the OCCT side builds the exact sub-parts; one STEP file holds the
  exact sub-parts as B-rep and each implicit sub-part as a tessellated body, with its name
  and colour. A mesh over 200k triangles is simplified to that cap with at most 0.02 mm
  error, and the export says so. Meshes cross workers as transferred typed arrays; in the
  CLI, where the two kernels never boot in one process, the mesh half runs in a child
  process (the CLI already re-execs itself for backend pinning).
- **Writer route — decided by a check at the start of the plan:**
  - preferred: OCCT writes the tessellated body itself (a face carrying a
    `Poly_Triangulation`, OCCT ≥ 7.6's tessellated STEP output), if replicad's build
    exposes it and the file imports into Fusion and Onshape;
  - fallback: partforge writes the AP242 tessellated entities and merges them into
    OCCT's STEP text under one product structure.
- `measure` and lint report which sub-parts will export as tessellated bodies.

## 6. Lint, reports and docs

### Lint

The routing probe records every tree passed to `k.implicit` at default parameters; lint
runs the pure-JS compiler on them without booting a kernel.

| Check | Severity | Catches |
|---|---|---|
| Compiler validation | error | bad values, unknown frames, frame cycles, `expr` syntax/names/uniforms, undeclared images, oversized textures |
| Thin feature vs grid | warning | a node thinner than 2 cells of `preview` or `resolution`; suggests its own finer `k.implicit` (the nail pattern) |
| Blend eats feature | warning | a `k` larger than a child's smallest dimension |
| CSG in disguise | warning | a tree of only `box`/`cylinder`/`halfspace` with no blending |
| `lipschitz` spot check | warning | the JS evaluator samples each `expr` at a few hundred points; the measured gradient exceeds the declared factor |
| Detail too fine to print | warning | surface `detail` amplitudes below the part's DFM profile minimum (0.1 mm resin, 0.5 mm FDM) |

### Reports

- `measure` reports every frame's world origin and world X/Y/Z axes, and the world centre
  of every labelled node — the numeric check that catches handedness and rotation-order
  mistakes.
- `probes` may name labels (e.g. the distance from `tip_index` to `tip_thumb`), so a part
  can state a gap and `verify` can hold it.

### Docs

- `docs/ORGANIC-PARTS.md` (new): grammar reference; frames with a rotation-order
  diagram; choosing blend widths; shape-level vs surface detail with printable minimums;
  the `expr` language; textures; thin features; when not to use `implicit`; the hand and
  vase as worked examples.
- `docs/AUTHORING-PARTS.md`: a short when-to-use / when-not section linking to it. Rule:
  use `implicit` only for forms without dominant flats or exact mating dimensions;
  holes, flats, threads and mating faces stay on the standard ops, applied after meshing.
- `docs/KERNEL-CONTRACT.md`: `implicit` leaves SPIKE status and gets its own entry
  (mesh-native, Manifold-routed, tessellated STEP); the contract version goes up.
- `docs/ERROR-PATTERNS.md`: holes from a low `lipschitz`; handles from thin features;
  joints turning to blobs from oversized blends; mirrored or wrong-handed parts; an
  unexpectedly slow rebuild.
- `types/kernel.d.ts`: the full typed node union.
- partforge-cloud (follow-up, after publish): the short section in the always-on prompt;
  organic requests route to the full guide.

## 7. Reference parts

- **`hand.js`** — a right hand rebuilt from the spike: frames per bone, capsule/ellipsoid
  flesh with blend groups, nails each on their own fine `k.implicit` unioned on, surface
  creases, pose sliders (curl, spread, per-finger flex, thumb opposition). Labels on
  every fingertip; a `probes` pinch gap.
- **`vase.js`** — a textured gourd/shell vase exercising what the hand does not: `taper`
  and `twist` body, `repeat` ridges, an image-driven surface `texture`, an `expr` gyroid
  lattice panel, and a precise mechanical base (flat, a drain hole) built with standard
  ops and unioned after meshing.

Each gets the usual glue (`<part>.html`, `src/app-<part>.js`, `src/<part>-worker.js`) and
a place in the smoke-check list.

## 8. Testing

| Area | Holds |
|---|---|
| Compiler | validation errors and paths; bound and Lipschitz tracking per node kind; stable canonical hash |
| Evaluator | batched pruned bytecode equals a plain recursive tree-walker on random points, every node kind |
| Culling exactness | sparse and dense meshing on one grid give the identical mesh, for the reference parts and adversarial trees (thin plates, high-factor formulas, displacement at its limit) |
| Native parity | `test/core-parity.test.js` adds the implicit reference parts, byte-identical core on/off; `test/core-structures.test.js` adds the block store and cleanup structures; partforge `sin`/`cos` identical across engines and within a stated error of `Math.sin`/`Math.cos` |
| Topology | each reference part over a pose sweep: watertight, expected genus, no self-intersection; volume stable across grid sizes within a set percentage |
| Fuzz | seeded random trees compile → mesh watertight |
| Cache purity | pose sequences built warm and cold are byte-identical |
| Export | STEP read back through OCCT: body count, names, colours, tessellated bodies; the CLI child-process path |
| Lint | one firing and one quiet case per check |
| Speed | `bench:implicit` in CI with generous limits on the CPU-pace clock |
| Golden | `test/verify-golden.test.js` unchanged for existing parts |

## 9. Rollout

Work happens on a feature branch `feat/implicit`, with stacked PRs into it:

1. Grammar, compiler, JS engine (evaluator, culling, mesher, cleanup), `k.implicit` on
   Manifold.
2. C++ port and parity.
3. Block sample cache.
4. Routing and tessellated STEP.
5. Lint, reports, docs, and the hand and vase reference parts.

One PR from `feat/implicit` to `main` carries the version bump and publishes it all, so
no release ships a half-built op. The partforge-cloud prompt PR follows the publish.

The spike's files (`src/framework/geometry/implicit.js`, `src/parts/hand-spike.js`,
`hand-spike.html`, `src/app-hand-spike.js`, `src/hand-spike-worker.js`, and the spike's
edits to the backends, kernel op list, contract and types) are reference material and are
replaced, not polished. `docs/research/organic-shapes.md` stays as background.

## Open at plan start

- The STEP writer route (§5): one short check of replicad's OCCT build.
- The exact cleanup thresholds (edge-collapse fraction, relaxation weights) are tuned
  against the hand and vase during PR 1 and fixed in the JS reference before the C++ port.
