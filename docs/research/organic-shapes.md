# Parametric organic shapes: research notes (2026-10-13)

Question: what representation lets an LLM author a detailed, posable organic
part (a realistic hand: bones, muscles, wrinkles, nails) as semantically
structured code that meshes watertight, prints, and previews live?

Short answer: **signed-distance-field (SDF) "flesh" on a named skeleton,
meshed by Manifold's `levelSet`, with surface detail baked by `warpBatch`
after meshing.** Not NURBS, not a subdivision cage. Details, numbers and
sources below. A throwaway probe (`levelSet` + `warpBatch` on a three-capsule
finger) ran on the Manifold 3.5.1 partforge already ships; its numbers are
in §5.

## 1. Representations compared

| | SDF / implicit | Rigid solids + union | SubD cage | NURBS / B-rep |
|---|---|---|---|---|
| LLM can author blind | yes: `capsule(a,b,r)` + blend k in mm | yes (hull/hullChain exist) | no: edge loops, valence | no: patch layout |
| Smooth junction (finger→palm) | native smooth-min | hard crease; mesh fillet rejects most blob seams | native | research-grade (Gordon/trim/fill) |
| Posing stays watertight | by construction (evaluate in bone frame) | by construction | needs skinning + repair | cracks at patch seams |
| Meshing | Manifold `levelSet`, guaranteed manifold | n/a | OpenSubdiv WASM, early-stage | OCCT tessellates faces |
| Sharp features | lost (route through booleans after) | exact | creases | exact |
| Cost driver | SDF evals × grid³ | boolean count | subdivision level | OCCT free-form booleans crash |

**NURBS/B-rep is out as a base.** Pixar left NURBS for Geri's Game because a
patchwork of trimmed patches cracks at the seams when animated
(DeRose/Kass/Truong 1998,
https://courses.cs.washington.edu/courses/cse557/09au/lectures/extras/p85-derose.pdf).
OCCT booleans and fillets on free-form faces fail or crash where planar
geometry works
(https://dev.opencascade.org/content/intersections-booleans-free-form-surfaces,
https://dev.opencascade.org/content/filleting-and-boolean-reliability);
replicad's issue tracker mirrors it (#241 ellipse fillet, #235 fuse, #175
lofted cuts). Branching a palm into five fingers is a published research
construction with no replicad wrapper
(https://strathprints.strath.ac.uk/45123/). Every FDM slicer tessellates STEP
on import anyway, so STEP of a sculpt buys nothing
(https://wiki.bambulab.com/en/software/bambu-studio/step). If STEP is ever
demanded, OCCT ≥ 7.7 writes AP242 tessellated STEP; never sew triangles (a
4 MB STL took 13 h, https://dev.opencascade.org/content/conversion-stl-step-slow).
Where NURBS still earns a place: a single limb as a varying-section sweep is
one `genericSweep` call in replicad today.

**Subdivision is out as the authoring vocabulary.** Catmull-Clark is the
character-industry standard, but authoring a quad cage with good loops as
code is exactly what LLMs do badly without visual feedback; BlenderMCP-style
agents "struggle with organic modeling… producing stretched primitives"
(https://arxiv.org/pdf/2508.08228). Manifold's own `smooth`/`smoothOut` is
G1 interpolation of a fixed mesh, explicitly not a subdivision surface
(https://elalish.blogspot.com/2022/03/smoothing-triangle-meshes.html).

**Rigid solids + union works today** (hullChain of spheres per bone, joint
spheres, union) and is the zero-kernel-work fallback, but the joints are
hard creases and the mesh fillet refuses the curved-curved seams a blob
produces, so it reads as a ball-joint doll, not skin.

## 2. The SDF vocabulary that fits

- **Primitives (exact distances)**: sphere, capsule, round cone (two radii),
  ellipsoid, vesica, torus, rounded box; revolve/extrude of a 2-D SDF is
  exact in 3-D. Quilez's catalog classifies which ops are exact and which
  only bound (https://iquilezles.org/articles/distfunctions/). Non-uniform
  scale, twist, bend and displacement are "bound" only: fine for grid
  meshing (only the sign matters) but they distort a downstream blend width.
- **Blend**: the normalized CD-family smooth-min (quadratic or circular)
  where k is literally the blend width in mm and the AABB expansion
  (https://iquilezles.org/articles/smin/). It is rigid (no effect once
  |a−b| > k) and never overestimates distance. Circular k gives a true
  fillet between perpendicular bodies.
- **Blend groups**: fingers blend to the palm but not to each other:
  `smin(palm, hardUnion(fingers), k)`. This is the RenderMan blobby hand
  rule (https://renderman.pixar.com/resources/RenderMan_20/appnote.31.html).
- **Creases, nail beds**: smooth subtraction of thin capsules/tori along a
  curve; a nail is a thin rounded box smooth-added after a smooth-subtracted bed.
- **Posing**: one SDF per bone in the bone's local frame; a query point is
  pulled through the inverse forward-kinematics matrix before evaluation, so
  posing is exact rigid motion and the result is a closed solid by
  construction (CharacterMixer, https://arxiv.org/abs/2402.15580; Pixar's
  mesh-free OOOOO rig for Elio is this at production scale,
  https://graphics.pixar.com/library/ElioOooooRig/paper.pdf). No linear-blend
  or dual-quaternion skinning, so no candy-wrapper collapse or joint bulge
  (Kavan 2007, https://users.cs.utah.edu/~ladislav/kavan07skinning/kavan07skinning.html).
- **Contact folds** at tightly bent joints are a later upgrade: implicit
  skinning's gradient-based blend and bulge-in-contact operators (Vaillant
  2013/2014, https://www.irit.fr/~Loic.Barthe/imm.php) handle them but give
  up the distance property.
- **Skeleton-first modeling has precedent as data**: ZBrush ZSpheres
  (sphere tree → adaptive skin), Blender's Skin modifier (B-Mesh, Ji et al.
  2010), Bloomenthal's convolution-surface hand, SCALIS
  (https://hal.archives-ouvertes.fr/hal-00863523). The authored data is the
  same in all of them: named nodes, radii, parent links.

## 3. What LLMs author well (shape-program literature)

Text-to-CAD converged on executable code with named, continuous parameters:
CadQuery (CAD-Recode https://arxiv.org/abs/2412.14042, Text-to-CadQuery
https://arxiv.org/abs/2505.06507). Shape-program work adds the structural
lessons: ShapeAssembly (https://arxiv.org/abs/2009.08026) attaches named
parts to each other instead of placing raw coordinates; ShapeLib
(https://arxiv.org/abs/2502.08884) has the LLM write a library of
small, semantically named functions validated by refitting seed shapes.
Both OpenSCAD and CadQuery agents "hide silent failures", so the external
validator loop (partforge's `verify`) is load-bearing.

Vocabulary consequences: `finger({ name, lengths, radii, flex: { mcp, pip,
dip }, abduct })` returning solids; `hand` composes four fingers and a thumb
by attachment to named palm landmarks; defaults from anthropometric tables,
not literals; joint ranges as schema `min`/`max`.

Data sources (all usable commercially, unlike MANO/SMPL-X which are
research-only, and NIMBLE whose data licence is unresolved):
ANSUR II public CSVs (https://www.openlab.psu.edu/ansur2/); phalanx ratios
from Buryanov & Kotiuk 2010 (DOI 10.4067/S0717-95022010000300015); active
ROM MCP ~85°, PIP ~95°, DIP ~83°
(https://thieme-connect.de/products/ejournals/abstract/10.1055/s-0044-1788593).

## 4. Surface detail

- **Printable scale**: real skin micro-wrinkles are 20–100 µm deep
  (Disney Research SGP 2023,
  https://studios.disneyresearch.com/app/uploads/2023/07/GraphBasedSynthesisForSkinMicroWrinkles.pdf),
  at or below resin pixel size (22–43 µm) and 5–10× below FDM. Minimum
  embossed detail: 0.1 mm SLA, 0.6 mm wide FDM
  (https://formlabs.com/blog/minimum-wall-thickness-3d-printing/). So
  printable "skin" is exaggerated: ≥ 0.1–0.15 mm amplitude on resin,
  ≥ 0.5–1 mm on FDM, wavelength ≥ 2–3× amplitude. Knuckle creases, nail
  ridges and striations (0.3–2 mm) are the FDM-realistic targets; pores only
  on resin.
- **Where to apply it**: not in the SDF. A 0.1 mm grid over a 100 mm part is
  10⁹ cells; a 0.2 mm `levelSet` over a 150 mm hand ran out of wasm32
  memory at 2.3 GB. Mesh coarse, then `refineToLength(wavelength/3)` →
  `calculateNormals` → `warpBatch` along normals. `warp` keeps topology but
  does not check self-overlap
  (https://manifoldcad.org/docs/html/classmanifold_1_1_manifold.html;
  https://github.com/elalish/manifold/issues/289 still open), so clamp
  amplitude to < ½ local thickness and < ½ edge length and gate with the
  oracle's watertight check. Run it last, after booleans: post-boolean
  `smoothOut` oscillates (https://github.com/elalish/manifold/discussions/1073).
- **Pattern sources**: isotropic noise (value/Perlin/Worley) tri-planar in
  model space for pores and grain; **oriented** detail (wrinkles,
  striations) needs a direction field, for which Gabor noise is the natural
  primitive (https://graphics.cs.kuleuven.be/publications/LLDD09PNSGC/).
  Authored depth maps fit the same slot: sample the existing `images`
  asset (already decoded for `k.heightfield`) through a per-bone planar or
  cylindrical projection. Tri-planar projection of an image breaks on
  oriented detail, so images want an explicit projection frame.
- **Preview proxy**: three.js `displacementMap` only moves existing
  vertices and needs UVs; the cheap live proxy is a normal perturbation in
  the fragment shader from the same noise parameters, tri-planar, injected
  at the one existing `onBeforeCompile` site (`materials/patterns.js`), with
  the real warp only in export and inspect.
- **File formats**: STL is triangles only; 3MF has a Displacement
  Extension v1.0.0 (Feb 2025,
  https://github.com/3MFConsortium/spec_displacement) but no slicer
  implements it. Bake to triangles.

## 5. Meshing numbers (Manifold 3.5.1, Node 24, M-series Mac)

`Manifold.levelSet` is marching tetrahedra on a body-centred cubic grid,
positive = inside, output guaranteed 2-manifold, no sharp-feature recovery
by design (https://github.com/elalish/manifold/issues/628). Cost is the
dense grid times the JS SDF callback at 2.5–8 M evals/s.

Probe: a posed three-capsule finger with knuckle ellipsoids and a nail
(bounds 115×30×90 mm):

| edge (mm) | time | triangles | genus |
|---|---|---|---|
| 2 | 75 ms | 7.9k | 10 (0.8 mm nail plate under-resolved) |
| 1 | 311 ms | 30.6k | 0 |
| 0.5 | 2.1 s | 125k | 27 (same plate); `simplify(0.02)` → 32k in 121 ms |
| 0.35 | 6.6 s | 252k | 0 |

Six-blob hand (bounds 200×130×100 mm): 1.5 mm → 2.9 s / 119k tris;
0.8 mm → 18 s / 443k tris. The second agent's independent benchmark
(palm + 5 capsules, 150×150×40 mm): 2 mm → 150 ms, 1 mm → 0.86 s,
0.5 mm → 6.1 s, 0.35 mm → 15 s / 1.05 M tris, 0.2 mm → out of memory.

Other findings:
- Capsules and ellipsoids under smooth-min alone: genus 0, one component at
  every resolution. **Thin features are the trap**: a plate under ~2 cells
  thick grows spurious handles (genus 10) rather than vanishing; a 0.3 mm
  fin at 1 mm cells kept 48 % of its volume, ragged. Resolution floor must
  derive from the part's thinnest feature (partforge's min-wall already
  knows it), or thin features get their own finer `levelSet` and a union.
- `tolerance > 0` (root-finding vertices) produced a negative-volume sliver
  component once; leave it at the default or filter components after.
- **Hybrid for live preview**: `levelSet` at 2 mm → `smoothOut(60)` →
  `refineToLength(0.6)` gave a genus-0, 60k-triangle finger in 118 ms.
- `warpBatch` wrinkles + pores over an 87k-triangle finger: 135 ms.
- `simplify` after `levelSet` is cheap (0.1–0.7 s) and reclaims most of
  the triangle blow-up (1 M → 52k at 0.02 mm).
- Going below 0.5 mm on a whole hand needs the SDF evaluated in
  WebAssembly: partforge's C++ core (`native/`) already has the build and
  parity harness for exactly this kind of port. Dreams evaluates tens of
  thousands of SDF edits at 10–100 M voxels/s with > 99 % culling by
  per-element bounds
  (https://advances.realtimerendering.com/s2015/AlexEvans_SIGGRAPH-2015-sml.pdf),
  so per-element AABB culling is the first optimisation, before any port.

## 6. Recommended shape of the feature

1. A new kernel op, `k.implicit({ elements, blend, bounds?, resolution? })`
   (name open), returning an ordinary `Solid` so it composes with every
   existing boolean, fillet, label and export path. Elements are plain data
   (`{ kind: "capsule", a, b, r, frame: "index.proximal", blend: 4 }`),
   evaluated in named frames; a helper library (`organic.js`, exported from
   `partforge/geometry`) supplies the primitives, the smooth-min family,
   `skeleton()` forward kinematics, `blendGroup`, and `detail()`.
2. Preview builds at a coarse grid plus `smoothOut`/`refine`; export and
   inspect build at a fine grid plus `simplify`, the same lazy quality split
   `circle-segs.js` already makes.
3. `detail({ pattern, amplitude, wavelength, direction?, mask?, image? })`
   as a final warp pass with amplitude guards; lint warns when amplitude is
   under the target process's floor.
4. `verify` additions: genus 0 expectation for a blob, thin-feature floor
   against the grid, warp self-overlap check.
5. Reference part `hand.js`: named skeleton from anthropometric ratios,
   `finger()`/`thumb()` helpers, flex/abduct sliders with ROM limits, nail
   and knuckle-crease dress-ups, a cutaway view showing bones and muscles as
   separate sub-parts.

Open decisions: hard-crease vs contact-fold joints in v1; image depth maps
in v1 or procedural only; export-time budget (which decides whether the C++
evaluator is v1 or v2); FDM vs resin as the detail floor; op vs sub-part
kind.

## 7. Spike results (2026-10-13, branch `claude/parametric-organic-shapes-86ef3a`)

Built: `src/framework/geometry/implicit.js` (frame tree, primitives, blended
ops with exact AABB pruning, `custom` escape hatch, detail warp, a pure-JS
marching tetrahedra), `k.implicit` on both backends (Manifold `levelSet`;
OCCT meshes with the JS tetrahedra and sews like `heightfield`), and
`src/parts/hand-spike.js` behind `/hand-spike.html` — a posable right hand
with its own `finger()` helper, nails, knuckle creases, a bones sub-part on
the same frames, and preview/export grid sliders. All throwaway.

What it proved, with numbers (M-series Mac, Node 24; browser is the Vite dev
server's worker):

- **It works end to end.** The hand poses from sliders, every pose is one
  watertight component, STL/3MF export runs on the print tier, and the data
  tree is cheap to manipulate (a pruning script that drops labelled nodes to
  bisect a topology problem was ten lines).
- **Preview rebuild**: 1.5 mm grid, `smoothOut`, one refine level → about
  3.2 s and 345k triangles per slider change in the browser (1.3–3 s in Node).
  Too slow for a slider and too many triangles; both are addressable (see below).
- **Print tier**: 0.8 mm → 24 s plain, 33 s with nails and creases (890k
  triangles after the detail refine); 0.6 mm → 24–42 s; 0.5 mm → 47 s. The
  dense grid is the cost: ~0.7 µs per sample with ~35 elements pruned by
  bounding box.
- **Sub-cell slivers make handles.** At 0.8 and 1.5 mm the plain hand reads
  genus 1 and the handle moves when the bounds shift; at 0.5 mm it is genus 0.
  A knuckle ellipsoid that barely emerges from its capsule is the likely
  sliver. The first nail recess (a 0.2 mm gap between plate and bed wall)
  did the same and showed as dark specks; burying the plate's edges in flesh
  fixed it. The declared-thickness warning (`thin < 1.5 × edge`) catches only
  declared thinness, not emergent slivers.
- **The export tier also found 2–3 extra components at 0.6 mm** on the first
  nail geometry (genus −1/−2) — the same sliver class, as separate crumbs.

What the spec needs that the spike does not have:

1. **Sparse evaluation.** Everything above is the dense grid. A narrow-band
   or octree evaluation near the surface (Dreams-style) is the ten-times win,
   before any WebAssembly port of the evaluator.
2. **A preview proxy for detail** (shader normal perturbation), and a preview
   triangle budget: one refine level at 1.5 mm is already 345k triangles.
3. **Topology hygiene after meshing**: drop components below a volume, and
   either fill handles under a few cells or re-mesh the offending region at a
   finer grid; `verify` should expect genus 0 for a blob unless declared.
4. **Resolution from geometry, not declarations**: the thinnest emergent
   feature (two surfaces within a cell) is what shreds, and only a
   near-surface probe can find it.
5. **OCCT**: see the STEP figures below; the B-rep road is a faceted export,
   not a modelling path.

### 7a. Where a preview rebuild spends its time (hand, 1.5 mm grid, Node)

| stage | time | notes |
|---|---|---|
| `levelSet` 1.5 mm | 3.8 s | 2.75 M SDF samples (dense body-centred grid over 178×225×114 mm), 1.4 µs each |
| `smoothOut(60)` | 0.1 s | |
| `refineToLength(0.9)` | 0.7 s | 110k → 345k triangles; 1.2 mm gives 224k in 0.4 s |
| `warpBatch` creases | 1.35 s | six SDF samples per vertex for the normal, 172k vertices |
| grid at 3 / 2 / 1 mm | 0.56 / 1.76 / ~13 s | 0.35 / 1.17 / ~9 M samples |

Per-sample cost is 3× the lone-finger probe's (1.4 vs 0.45 µs) because every
sample walks ~38 elements' bounding boxes before the few real evaluations,
and Manifold's JS binding allocates a fresh `[x,y,z]` array per callback.

**How fast it can get, in order of leverage:**

1. **Sparse evaluation (10–40×).** The surface occupies a thin shell of the
   grid: at 1.5 mm, roughly 70k of the 2.75 M samples are within a cell of
   it. A coarse-to-fine octree (evaluate at 6 mm, descend only cells whose
   value is within the cell's diagonal of zero, which the distance bound
   guarantees) or a narrow band seeded from the previous pose's surface
   reduces the sample count by that ratio. This is algorithmic and
   backend-neutral; it is the first thing to build.
2. **Evaluator in the C++ core (5–15×).** A bytecode interpreter over the
   data tree (the tree is data precisely so this is possible) removes the
   JS-to-WASM callback, the per-call array, and the interpretive overhead
   of closures; a fused evaluate-and-mesh in the core (marching tetrahedra
   on the sparse cells, like the pure-JS one written for OCCT) also makes
   the triangles **byte-identical on both backends**, the parity class
   `heightfield` has. Hand the mesh to Manifold via `ofMesh` as
   `heightfield` does.
3. **Normals from the mesh, not the field** for the detail warp: the
   smoothed mesh already carries tangents; `calculateNormals` is 50× cheaper
   than six SDF samples per vertex. The pattern itself is cheap.
4. **Refine budget**: one refine level at 1.2 mm instead of 0.9 mm halves
   the triangle count (224k) for a visually similar preview; detail should
   be a shader proxy in preview anyway.
5. **Pose-local rebuilds**: only elements whose frames moved need
   re-sampling; with a sparse grid, the band around an unmoved finger can
   be reused. Later.

With 1 + 2 the level set drops from 3.8 s to well under 100 ms and the
whole rebuild to about 0.3 s at 1.5 mm, where the refine dominates. Without
C++ at all, 1 + 3 + 4 should reach about 0.6–0.8 s. Browser numbers run
~1.3× the Node ones.

### 7b. The nails: model, not kernel

The first nails were a 0.7 mm recess under a 1.5 mm smooth-subtract and a
flat plate on a round fingertip; at a 1.5 mm grid every part of that is
sub-cell, the level set aliases it, and `smoothOut` turns the jaggies into
ripples. Rendering a lone finger at 1.5 and 0.6 mm showed the same absence
of a nail at both grids: the blend had eaten the recess entirely. The fix is
in the part: a nail is a section of a 1.4 mm shell around the distal
phalanx (so it hugs the curve), clipped to an oval, standing 0.8 mm proud,
meshed in its **own** 0.35 mm grid over a 12 mm box (a few thousand samples)
and unioned onto the hand by a plain boolean. Cost: about 1 s for five nails
in preview. That is the per-feature resolution strategy the research notes
proposed, and it should be the spec's answer to thin features generally: a
feature declares its own grid, and the coarse body never pays for it.

### 7c. Posing lessons from the hand

- **Handedness is easy to get wrong and hard to see.** The first hand was a
  left hand (thumb on +X with the palm down); turning it palm-up by rotation
  kept it a left hand. Mirroring the authored tree across the midline (negate
  the X offsets, negate the rotations about Y and Z) fixed it.
- **Rotation order decides where a joint bends.** The thumb's pronation about
  its own axis is what aims its flexion; with the sign wrong it bent toward
  the wrist and outward. The reliable check was numeric, not visual: resolve
  the frames and print the world direction of the joint's flexion axis. A
  `partforge` lint or probe that reports each frame's axes in world space
  would give an LLM author that check for free, and the spec should include
  one (`probes` already carries plain-JSON measurements).
- **Depth below the palm plane** needs the same discipline: the first
  metacarpal dip put the thumb joint 29 mm under the palm (a real one sits
  12–18 mm). Anthropometric defaults should carry joint positions in three
  dimensions, not just segment lengths.

### 7d. The sparse JavaScript pass (same day)

Built `sparseMarchingTetrahedra` in `implicit.js`: blocks of 16 cells walked
coarse to fine, a block dropped when its centre value exceeds the block's
half-diagonal plus the field's overshoot margin (k/4 of the largest blend; the
quadratic smooth-min never moves a value further), leaves of 2 cells whose
corner samples are shared through a lazily filled grid, the existing
tetrahedra on the surviving cells. Grid samples within a quarter cell of the
surface are snapped onto it (Manifold's own kS trick) so slivers never form,
and each snapped vertex is projected back to the surface by one Newton step
along the gradient — without that step the snap creased the mesh (2959 sharp
dihedral edges vs 182). The mesh enters Manifold through `ofMesh` without a
merge pass (its vertices are already shared by index), then smoothOut and one
refine as before. A sliver `simplify` before smoothOut was tried and removed:
it creased the smoothed result (1872 sharp edges vs 159). The detail warp now
takes normals from the mesh.

Hand at the 1.5 mm preview grid (Node, browser idle):

| stage | dense `levelSet` path | sparse path |
|---|---|---|
| sampling + marching | 3.8 s (2.75 M samples) | 0.23 s (300k samples incl. snap projections, 26 % of the grid) |
| import to Manifold | included | 0.1 s (`ofMesh`, no merge, 105k triangles) |
| smoothOut + refine to 1.2 mm | 0.8 s | 0.3 s |
| sharp edges (> 30°) in the final preview mesh | 921 | 159 |
| **whole hand, no nails** | 2.2 s | **0.72 s** |
| **whole hand, nails + creases** | 3.0 s | **1.5 s** |
| print tier 0.8 mm, plain / full | 12–17 s | **1.5 s / 4.9 s** |

Browser steady state (dev server worker): about 1.0 s plain and 1.6 s with
nails and creases, versus 3 to 5 s before the pass. The sparse mesh is
**genus 0 in every configuration** where the dense level set carries one or
two spurious handles. The band the culler keeps is about seven cells thick
because the 10 mm palm blend's k/4 margin dominates; a per-region margin
would cut the sample count a further 3×. Five nails are unioned in one n-ary
boolean instead of five pairwise ones.

What is left in a 0.72 s preview: 0.23 s mesher, 0.1 s import, 0.3 s
smooth-and-refine, the rest the nails' own level sets and the boolean.
`polish: false` skips the smooth-and-refine for a raw-tetrahedra preview at
about 0.4 s. The C++ evaluator now buys at most the mesher's 0.2 s in preview;
its real value is the print tier and identical meshes on both backends. The
next preview win is the import-plus-refine round trip, which a mesher that
emits the refined, smoothed triangles directly would remove.

## 8. JS engine (feat/implicit PR 1)

The spike's pieces are now one pure-JavaScript engine under
`src/framework/geometry/implicit/`: a coarse-to-fine sparse sampler with exact
interval culling, marching tetrahedra with no vertex snapping, a cleanup pass
(short-edge collapse, then tangential relaxation alternating with Newton
projection onto the field) in place of Manifold's simplify/smoothOut/refine
round trip, and surface detail on the cleaned mesh. This path is the fallback
and the reference that PR 2's C++ port must match bit for bit, so its
constants are frozen here.

**Chosen constants:** LEAF = 4, TOP = 32, collapseFrac = 0.2, relaxPasses = 2,
relaxWeight = 0.5, maxMoveCells = 0.5. These are the plan's defaults; no
alternative tried was both faster and as good.

Measured on an Apple M1 Max, Node 24 (`npm run bench:implicit`, warm run,
milliseconds; the hand includes its knuckle creases, no nails):

| case | compile | sample | mesh | cleanup | detail | total | triangles | samples | programs |
|---|---|---|---|---|---|---|---|---|---|
| hand preview (1.5 mm) | 1 | 134 | 91 | 353 | 104 | **683** | 157,194 | 544,625 | 202 |
| hand print (0.8 mm) | 0 | 364 | 348 | 909 | 533 | **2,155** | 565,396 | 2,052,625 | 160 |
| vase preview (1.2 mm) | 0 | 259 | 43 | 510 | 248 | **1,061** | 144,452 | 431,875 | 147 |

`k.implicit(hand)` end to end, cold, including the Manifold import: about
0.95 s. Run to run the totals move by about 5 %.

Each setting was tried one at a time against those defaults. "p5 angle" is the
5th-percentile minimum triangle angle of the final mesh (the hand at 1.5 mm /
0.8 mm, and the mean over the small IR test trees at 0.8 mm); higher is better.

| setting | hand preview | hand print | vase | p5 angle (hand 1.5 / 0.8 / small trees) | tests |
|---|---|---|---|---|---|
| **defaults** | 0.69 s | 2.15 s | 1.07 s | 22.9° / 23.1° / 20.7° | pass |
| LEAF = 2 | 0.74 s | 2.60 s | 0.88 s | 23.0° / 23.2° / 20.7° | pass |
| LEAF = 8 | 0.98 s | 2.50 s | 1.27 s | 22.8° / 23.0° / 20.6° | sparse culling test fails |
| TOP = 16 | 0.71 s | 2.17 s | 1.10 s | 22.9° / 23.1° / 20.7° | pass |
| LEAF = 8, TOP = 16 | 0.96 s | 2.58 s | 1.28 s | 22.8° / 23.0° / 20.6° | sparse culling test fails |
| collapseFrac = 0.15 | 0.71 s | 2.14 s | 1.10 s | 23.3° / 23.3° / 20.6° | pass |
| collapseFrac = 0.3 | 0.63 s | 1.93 s | 1.02 s | 22.5° / 22.5° / 20.4° | cleanup `bendCut` fails |
| relaxPasses = 1 | 0.60 s | 1.87 s | 0.93 s | 18.9° / 19.8° / 16.8° | pass, but angles drop |
| relaxPasses = 3 | 0.78 s | 2.35 s | 1.22 s | 23.7° / 23.8° / 21.5° | cleanup `bendCut` fails |

LEAF = 2 is faster on the vase (smaller leaves fit its thin walls) but slower on
both hands, where the extra coarse blocks cost more than the samples they save.
The two settings that are faster overall either fail a test (collapseFrac = 0.3)
or give up about 4° of minimum angle (relaxPasses = 1), so the defaults stay.

Compared with the spike's sparse JS pass (§7d): the spike's hand preview was
0.72 s plain and 1.5 s with nails and creases; here the same hand is 0.9 s with
creases through `k.implicit` and about 1.3 s with the five nails unioned on.
The print tier went from 1.5 s plain / 4.9 s full to about 2.8 s with creases /
3.7 s full. The plain number is a little slower because the cleanup pass does
in JavaScript what Manifold's smoothOut did natively, and there is no vertex
snap; that same pass is what PR 2 moves into C++. The hand is genus 0 with its
nails at curl 0, 50 and 100, and its volume at 1.5 mm and 1.0 mm grids agrees
within 3 %.

Features thinner than one grid cell can vanish, especially when a face lands
exactly on a grid plane: a 0.9 mm plate at a 1 mm grid has no sample strictly
inside it, so it meshes to nothing. That is expected, not a bug. Anything under
two cells already triggers the thin-feature warning. The remedy is a finer grid,
or meshing the feature as its own `k.implicit` on a finer grid and unioning it
on, as the hand does with its nails. A 1.6 mm plate at the same grid (under two
cells, so it is warned) still meshes closed.

## 9. Native engine (feat/implicit PR 2)

Everything after `planLeaves` — sampling, meshing, cleanup and surface detail —
now runs in the native core (`native/implicit_*.cpp`, one WebAssembly session
per mesh; `src/framework/core/implicit-core.js`). It is a speed switch only:
the output is byte-identical to the JS engine of §8
(`test/implicit-native-*.test.js`, `test/core-parity.test.js`), and the JS
stays as the fallback when the core is off, refuses or faults.

Measured on an Apple M1 Max, Node 24 (`npm run bench:implicit -- --core both`,
warm run, CPU milliseconds, machine under load ~7). "sample" includes
`planLeaves`, which is still JavaScript in both columns (about 25 ms of the
hand preview's 45 ms native sample, 210 ms of the 0.5 mm one):

| case | engine | compile | sample | mesh | cleanup | detail | **total** | triangles |
|---|---|---|---|---|---|---|---|---|
| hand preview (1.5 mm) | JS | 1 | 167 | 76 | 401 | 377 | 1,021 | 177,102 |
| | native | 1 | 45 | 10 | 59 | 20 | **134** | |
| hand print (0.8 mm) | JS | 1 | 388 | 182 | 1,020 | 1,689 | 3,279 | 553,652 |
| | native | 0 | 155 | 38 | 161 | 68 | **422** | |
| hand 0.5 mm | JS | 1 | 1,012 | 500 | 2,154 | 4,203 | 7,870 | 1,361,338 |
| | native | 0 | 370 | 111 | 369 | 142 | **992** | |
| vase preview (1.2 mm) | JS | 1 | 272 | 47 | 503 | 263 | 1,086 | 144,592 |
| | native | 0 | 53 | 6 | 69 | 28 | **156** | |

Against the design spec's performance targets (Node, M-series desktop):

| target | spec | measured (native) | CI gate (`test/implicit-speed.test.js`) |
|---|---|---|---|
| hand, full detail, preview tier | ≤ 150 ms | 134 ms (126 ms paced median); about 190 ms (188 paced) with §9a's decimation | < 450 ms paced |
| hand, 0.5 mm print tier | ≤ 2 s | 0.99 s (1.05 s paced median) | < 6 s paced |

The gate times compile + `planLeaves` + the native session (what `k.implicit`
runs before Manifold), on `test/helpers/cpu-pace.js`'s `cpuMs` (CPU time in the
calibration desktop's milliseconds), as a median of five runs each, at 3× the
spec target. The hand here has its dorsal knuckle
creases (nine crease entries) and no nails.

The gated targets are the engine's (as `bench:implicit` reports it). `k.implicit(hand)` end to end at 1.5 mm
is about 380 ms native (1,430 ms JS): Manifold's `ofMesh` of the 177k-triangle
result costs about 230 ms of it, more than the whole native engine — the next
place to look for a live-posing rebuild, together with region reuse (PR 3).
Cold, in a fresh process with the Manifold import, it is about 0.6 s.

How the native engine got from about 4–5× to 7–8× faster than the JS without
changing a bit: the interpreter decodes each program once (integer registers,
inline-constant offsets) and dispatches the primitive or function once per op
with a tight lane loop inside, unions/intersections run operand-major with
per-lane running minima (the same per-lane order and first-wins ties), and the
core boots a `-msimd128` build of the module where the engine has wasm SIMD,
so those loops run two lanes per `f64x2` op (IEEE-exact per lane; nothing is
reassociated or fused). An engine without SIMD boots the scalar build of the
same sources: same bits, 13–34 % slower over a whole case (hand preview about 159 ms
instead of 135, vase 210 instead of 156). Surface detail keeps
the targets of vertices a refinement round did not add, answers refused edges
without touching the midpoint map, and holds the map as per-vertex chains,
which keeps lookups near the triangles making them. Before those changes (same
machine, same load) the native hand took 222 ms at 1.5 mm, 660 ms at 0.8 mm and
1.68 s at 0.5 mm, and the vase 260 ms.

### 9a. Preview-tier decimation (PR 2 speed follow-up)

At the 1.5 mm preview grid marching tetrahedra leave the hand at about 177k
triangles, three times what its ~48,600 mm² of skin needs at 1.5 mm, and
everything after the engine — Manifold's import, display, every later boolean —
scales with that count. The preview tier now decimates in cleanup
(`cleanup.js`'s `PREVIEW_CLEANUP`, and its twin in `native/implicit_mesh.cpp`):
after the usual 0.2 · edge collapse, up to four more passes of the same
deterministic triangle-order collapse take edges shorter than 0.7 · edge, under
four guards beyond the link condition and the no-flip test:

- **no tetrahedron** — both endpoints of ring size 3 is, under the link
  condition, exactly a four-vertex closed piece, which a collapse folds into a
  zero-volume "pillow" of two triangles over the same vertices (closed and
  Euler-correct, so only a duplicate-triangle check sees it; tiny spheres in a
  `repeat` made them). Refusing every ring-size-3 endpoint also works but costs
  the hand's triangles their quality (5th-percentile corner 29° → 26°);
- **corners** — no new corner both sharper than 15° and sharper than the
  corners around the edge already were (an absolute 15° floor stalled at 64–96k
  triangles, because marching tetrahedra's own slivers blocked every collapse
  near them);
- **normal turn** — no surviving triangle's normal turns by more than 20°;
- **spread (fidelity)** — every surviving triangle's new normal within 12° of
  their sum. A fan's spread is roughly its size over the surface's radius, so
  this keeps triangles small where the surface is curved and lets them grow
  where it is flat. The turn guard alone could not hold volume at any angle
  from 15° to 30° (a 3 mm sphere lost a further 6–8%, compounding over passes).

Two stops keep decimation from costing more than it saves. Before the first
pass a **probe** runs the full test on the edges of every 32nd triangle and skips
decimation when fewer than 40% of the short ones may collapse: it allows 53% of
the hand's and 30% of the vase's (the small trees: 1–48%), and on the vase four
passes had cost more than the 145k → 130k triangles saved (`k.implicit` 328 →
400 ms). An **early stop** ends the passes once one removes under 20% of the
triangles (the hand's: 39, 31, 16%, so three passes).

Relaxation and projection follow as before. `meshImplicit(compiled, edge,
{ tier })` decimates only for `tier: "preview"`; the Manifold backend passes its
quality, so print and export meshes are byte-for-byte what they were
(`test/implicit-cleanup.test.js` pins their digests from before the change).

Spheres, volume against the print tier (0.6 mm grid), 1.5 mm preview grid:

| r (mm) | 1.5 | 1.8 | 2.2 | 3.0 | 4.5 | 6.0 |
|---|---|---|---|---|---|---|
| preview, not decimated | −26.0% | −11.4% | −9.3% | −3.6% | −2.0% | −0.9% |
| **chosen** (spread 12°, probe, stop) | −26.0% | −11.4% | −9.3% | −3.6% | −2.0% | −2.1% |
| spread 12°, no probe | −26.0% | −11.9% | −9.3% | −3.7% | −2.3% | −2.2% |
| turn 20° only | −30.6% | −16.9% | −20.4% | −10.1% | −4.2% | −2.9% |
| first version (corner guard only) | −40% | −36% | −22% | −10.6% | −4.7% | −2.9% |

The small spheres' loss is the grid's own; the probe leaves spheres up to
4.5 mm undecimated, and at 6 mm decimation adds 1.2%.

Cleanup alone (JS, max |d| in grid edges; closed, oriented, Euler unchanged
and no duplicate triangles in every row):

| case | cleanup | triangles | 5th-pct corner | min corner | max \|d\| |
|---|---|---|---|---|---|
| hand 1.5 mm | CLEANUP | 157,004 | 23.1° | 0.46° | 0.0061 |
| | spread 15°, four passes | 51,010 | 28.7° | 1.2° | 0.0006 |
| | spread 12°, four passes | 53,294 | 28.0° | 1.2° | 0.0060 |
| | **chosen** (three passes by the early stop) | **55,744** | **27.7°** | **1.2°** | **0.0060** |
| | spread 12°, 0.8 · edge | 42,584 | 29.4° | 0.17° | 0.0048 |
| vase 1.2 mm | CLEANUP = **chosen** (probe skips) | 86,626 | 19.5° | 0.13° | 0.33 |
| | spread 12°, no probe | 57,750 | 18.3° | 0.13° | 0.36 |

(The vase's field is not a distance — taper, twist and an `expr` gyroid — so
its |d| is not one either.) Surface detail runs after cleanup and refines back
toward its own target, so the meshes `k.implicit` hands Manifold shrink less:
the hand 177,102 → 77,032 triangles (2.3×; 5th-percentile corner 22.8° →
26.0°); the vase stays at 144,592, byte for byte the undecimated mesh. Rendered
side by side the hand is indistinguishable from before.

`k.implicit` end to end, CPU ms, median of 7, every setting run twice in
alternation on a loaded machine (the two runs shown):

| setting | hand 1.5 mm | vase 1.2 mm |
|---|---|---|
| not decimated (baseline) | 330, 320 | 327, 331 |
| no probe, no stop | 284, 283 | 401, 399 |
| probe 0.4, stop 0.03 | 288, 290 | 333, 338 |
| probe 0.4, stop 0.05 | 289, 287 | 335, 334 |
| **probe 0.4, stop 0.2 (chosen)** | **279, 282** | **332, 329** |

The engine alone (native, meshImplicitCore) is about 190 ms for the hand
preview against 130 ms undecimated (speed gate: 188 paced ms, limit 450), and 156 ms for the vase against 157 — the
probe costs the vase about 1 ms. The core skips, exactly, edges a previous pass
refused whose neighbourhood nothing has touched since, and runs the spread
guard before the flip test.

## 10. Contact vs blends (feat/implicit PR 2b)

A `union` with `k` blends its children before they touch: the surfaces reach toward
each other and fuse, which is right where two pieces grow out of one another (a finger
from the palm, a handle from a mug) and wrong where they only press together. There, at
a coarse grid, a blend bridges a near miss into a blobby neck. A `contact` node is for
pieces that press: it holds a clearance between them until they actually overlap, then
shows the overlap as a flat pad. `gap` is the clearance in mm — `0` fuses touching pieces
into one solid at the pad, above `0` keeps them apart so they print separately (a gap
under two grid cells warns, since the grid cannot show it). `bulge` swells the skin
around a contact, scaled by how deep the pieces press, and never reaches across a gap;
`0` turns it off. `attach` names pairs that are joined, not just touching, near a frame
(a finger at its knuckle): within `radius` of it they blend with width `k` like a
`union`, beyond it they follow the contact rules. The hand fixture uses all three — its
digits are `contact` children attached to the palm at their bases.
