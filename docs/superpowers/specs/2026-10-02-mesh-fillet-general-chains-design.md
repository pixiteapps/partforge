# Mesh fillet: general chains between curved faces

Date: 2026-10-02. Status: design approved in conversation; spec awaiting review.

## Why

The Manifold fillet (`src/framework/geometry/mesh-fillet.js`) blends three edge
classes: straight edges with planar flanks (prism tool), circular edges with coaxial
revolved flanks (revolve tool), and edges lying in a face plane with a constant wall
angle (planar sweep). Anything else throws `UnsupportedEdgeError`, and the whole
sub-part reroutes to OCCT (`manifold-backend.js`, `KernelCapabilityError` /
`NEEDS_OCCT`), paying OCCT's cold boot and per-edge cost.

The pain this addresses, in the user's words: OCCT reroutes are slow, and edges people
want rounded come out sharp, slow, or worked around.

### Evidence

A census on 2026-10-01 (71 public forges, 610 model-written eval parts) found:

- Every fillet the agent actually wrote built on Manifold, but the agent rarely
  fillets at all; prompts wrongly called fillet OCCT-only (fixed separately: cloud
  #410, partforge #246).
- A selector-free 0.5 mm fillet of every sub-part rejected 114 of 253 sub-parts. Much
  of that is surface texture nobody fillets (knurls, threads, gear teeth).
- Hand-built fixtures of edges people do want rounded:

| Fixture | Today |
|---|---|
| Pipe tee (boss on a tube) | reroutes: saddle curve, concave |
| Cross hole in a tube | reroutes: saddle rim, convex |
| Off-axis boss on a dome | reroutes: concave |
| Tube cut on a slant | reroutes: elliptical rim |
| Rib on a cylinder, D-shaft flat, drafted box, fillet after fillet, boss on a plate | already Manifold |

In every failing fixture the edge lies between two curved faces, and the edge path is
also split into fragments (some runs classify `line`, some `arc`, some unsupported), so
no single fixed-section tool can follow it.

### Why not carried surface definitions

The first concept carried analytic surface descriptors (cylinder, cone, sphere…)
through booleans per face. A review (verified against `manifold-3d@3.5.1`) found
Manifold's `MeshGL.faceID` survives booleans, transforms and `simplify` but is reset by
`asOriginal()` (four call sites) and `hull()`; extrude/revolve triangles are
Manifold-authored; twisted extrudes have no analytic wall. More importantly, every
rejection fails a *constancy* test (flank normal, plane, dihedral within a few
degrees), not missing information: `detectSharpEdges` already records both exact flank
normals per edge member. A per-station cross-section built from those normals needs no
descriptors. Carried descriptors remain the route to large radii on coarse facets and
are deferred.

## Goal and success criteria

Fillets and chamfers on edges between two curved faces run on Manifold instead of
rerouting. Done means:

1. The four failing fixtures build on Manifold — no `NEEDS_OCCT` — at r = 1 and 2 mm,
   fillet and chamfer.
2. Output is watertight (`genus()`-checked; `isWatertight` false-negatives on swept
   geometry) and its volume matches the OCCT result within tolerance.
3. No stray band lines along the new bands (bounded feature-line count via `toMesh()`).
4. Runtime in milliseconds to low seconds, no OCCT boot.
5. Every existing test passes unchanged, including all eight `test/mesh-fillet-*.test.js`
   files; every chain the three existing tools accept today is still accepted by the
   same tool.
6. The census probe does not get worse for any part.

## Out of scope

- Carried surface descriptors; large radii relative to flank facet size.
- Partial blending. **Policy (decided): if any selected chain is still unsupported, the
  sub-part reroutes to OCCT exactly as today.** The new tool only converts today's
  reroutes into Manifold builds; it never trades correctness for speed.
- New corner treatments (patches, horns, pivots) for general chains.
- Promising good results on knurl, thread or gear-tooth edges (they must not crash or
  produce wrong geometry; rerouting them is acceptable).
- STL-import flanks beyond what falls out of the same code.
- Kernel API or selector changes.

## Design

### 1. A fourth chain kind: `general`

Detection (`detectSharpEdges`, `chainEdges`) and the `line` / `arc` / `planar`
classifiers are unchanged. Where a path still has an unsupported run after the
existing whole-path planar rescue (`buildPlanarPath` → `tryPlanarChain`) fails, a new
whole-path rescue, `tryGeneralChain(members, points, closed)`, runs on the **entire
path**, which also repairs the fragmentation seen in the fixtures.

It accepts the path only if:

- every member has the same convexity;
- no member is a knife edge (flank normals anti-parallel; the existing `knife` filter);
- the path has at least 3 points.

Corners sharper than `SMOOTH_MAX_DEG` (30°) still end paths, as today. A path the rescue
rejects stays unsupported, and the selection reroutes.

### 2. Station frames from the mesh

Each path vertex is a station `{ p, t, n1, n2 }`:

- `t`: the unit tangent, the bisector of the two incident member directions (the end
  member's direction at an open end).
- `n1`, `n2`: the station's two flank normals, averaged from the incident members. Each
  member's flanks are paired against the previous member's pairing (continuity
  pairing), never against a fixed world frame, so flanks do not swap as the curve turns
  (the same reason `fitArcChain` pairs in a rotating frame).
- Normals are projected into the plane perpendicular to `t`.

Frames are Phong-interpolated between stations (the `path` descriptor's rule in
`blend-surfaces.js`). If vertex spacing is uneven enough to step the section visibly,
stations are resampled by arc length.

### 3. The tool

At each station the existing cross-section `profile2D` (unchanged) is built from that
station's `n1`/`n2` in the plane perpendicular to `t`, giving one ring per station. The
ring stack is meshed directly (closed loop for a closed chain, capped for an open one)
and handed to `manifoldFromMesh` (`mesh-build.js`), the same hand-meshed-ring-stack
approach `roundedBox` uses. `k.loft` is not used: its rings are planar at fixed z.

As with the existing tools:

- a cutter for convex chains, a filler for concave chains, combined in `apply()`'s
  existing `cutAll` / `union` step;
- the section is oversized past the corner (`ext`, as `profile2D` already supports) and
  buried by the local flank sagitta, the grazing guard every existing tool carries,
  measured per station from the chord dip as `revolveTool` does;
- fillet-band triangles register a blend descriptor (section 6).

### 4. Ends

- Closed chains (cross hole, boss junction) close on themselves.
- Open chain ends are flat mitres perpendicular to `t`, extended past the end vertex the
  way `prismTool` extends. Where another selected chain meets the vertex, the corner
  keeps the honest mitre seam the module already accepts at sharp salient corners.

### 5. Self-fold guard

Per station, if the spine's local radius of curvature (from the neighbouring stations)
is smaller than the section's reach on the bend's inside, the tool throws
`UnsupportedEdgeError("general chain: bend too tight for r=…")`. Under the policy above
that reroutes; it never emits a self-intersecting tool. The reach is computed from the
station's own profile, not a fixed multiple of r.

### 6. Shading

A new descriptor kind in `blend-surfaces.js`:

    { kind: "spine", pts, closed }   ball-centre polyline (one point per station)

Its normal is the direction from the nearest point on the spine polyline, the exact
canal-surface normal. It registers through the existing `_markBlendSurface` hook, in
the tool's original frame, and follows `runTransform` like every other descriptor.
Chamfers register nothing, as today.

### Unchanged

The selector semantics, the kernel API and contract version, OCCT, the cache keys, the
roundAll fast path (which uses `_filletRaw` and must keep its own fallback), and every
chain the existing tools classify.

## Testing

New file `test/mesh-fillet-general.test.js`:

- **Acceptance fixtures:** pipe tee, cross hole in a tube, off-axis boss on a dome, tube
  cut on a slant; r = 1 and 2; fillet and chamfer; each at default tessellation and at a
  coarse one. Assert no throw, `genus()` = expected, and volume within tolerance of
  reference constants computed once from OCCT in a separate process (the two kernels
  cannot boot together; the generating script is checked in under `scripts/`).
- **Band lines:** feature-line count from `toMesh()` along the new band stays under a
  small bound.
- **Shading:** on the pipe tee, the `spine` descriptor's normals match the analytic
  canal-surface normal within a tight angle.
- **Guards:** a tight-bend case still throws `UnsupportedEdgeError`; a knife edge is
  still skipped.
- **Classification freeze:** for a fixed set of meshes covering the existing tools'
  cases, every chain's kind is identical before and after, so the new path can never
  silently take over an existing edge.

Plus the full existing suite unchanged.

Measurement (not a test): `scripts/bench-mesh-fillet-census.mjs` reruns the census's
selector-free probe over a directory of part trees and prints per-bucket reroute counts
plus timings, so before/after can be compared.

## Risks

1. **Faceted flanks.** On a coarse cylinder the mesh normal at the edge is up to half a
   facet off the true surface, so the section tilts and may graze. Contained by burial
   and the band-line test, which runs at coarse tessellation too.
2. **Stepped section rotation** where stations are unevenly spaced. Contained by Phong
   frames and arc-length resampling.
3. **Concave fillers on saddles** overlap their flanks by design. Slivers from the
   union are removed by the existing `dropDebris` pass that already runs after every
   mesh fillet.
4. **Runtime.** One ring stack per chain, no iterative solves; checked by the benchmark.

## Rollout

A partforge minor release (after 0.135.1 and 0.135.2 land). Then a cloud pin bump with
`npm run docs:generate && npm run prompt:generate`; the regenerated op line and
`AUTHORING-PARTS.md`'s fillet section should say Manifold handles curved-meets-curved
edges. A small eval comparing fillet use before and after is the follow-up check.

## Follow-up: clean band edges and smooth bands (2026-10-02)

On the first build, the CAD overlay drew ragged lines along every general band and the
bands looked a little lumpy. Measured on the cross hole at r = 1.5:

- **Ragged lines.** The hole-side boundary was 37.0 mm of drawn line against an exact
  contact curve of 19.7 mm. It was a staircase: two parallel lines ~0.09 mm apart, joined
  by a rung at every hole facet seam.
  - Cause: the band met the TRUE curved wall tangentially at the contact, but the wall
    is planar facets sagging ~1 µm off that curve. Within ±~0.05 mm of the contact the
    band ran closer to the wall than the sag, so each facet kept a sub-µm lens of uncut
    (or, for a filler, unfilled) wall.
  - The overlay draws every seam between a blend band and its wall, so it traced both
    edges of every lens.
- **Lumpy bands.** Shading was up to 7° off the exact rolling-ball normal, and the
  solved ball centres jittered 5–25 µm from station to station.
  - Cause: each station measured its flank normals at the EDGE, from facet normals that
    step ~3° per facet. The ball's position depends on the wall where it touches it,
    about r away from the edge.

The fix makes one change to the section, in two parts. The line-drawing code is not
touched.

1. **Measure the wall at the contact.** Five ray hits around each current contact give
   the wall's secant normal through a point on the facets. The probes are spaced ±0.3·r
   along the section's in-face direction (capped at half the contact's distance from the
   edge) and along the edge tangent. The ball is re-solved tangent to both measured
   tangent lines.
   - Two rounds. One round leaves the tee at 2.95°; a third round changes nothing.
   - The patch half-width is flat from 0.15·r to 0.4·r in both shading and line
     placement.
   - There is no smoothing window along the edge.
   - A station whose patch cannot be measured keeps its edge-measured section.
2. **End on the wall.** The arc stops at the contacts, which are snapped onto the faceted
   mesh, and the polygon's closing edge leaves each contact at 90° to the wall. The
   contact and the arc points next to it sit on the tool side of the wall (the material
   for a cutter, the air for a filler) by a margin:
   - a floor of 2e-4·r, so no point lies exactly on a facet;
   - plus L·fold/4, the most a chord can leave the wall between two probed points on
     facets turned `fold` apart;
   - the fold allowance counts only when the wall folds toward the tool side. The other
     way the chord sinks on its own, and a margin there only adds a visible step;
   - the whole margin is capped at 0.05·r. A coarse 32-gon asked for up to 0.39·r
     uncapped; fine meshes never ask for more than 0.03·r, so the cap does not bind
     there.

   The boolean then cuts the wall along the contact polyline at a steep crossing, and
   the band ends on one clean line.

The shading spine changed too. Its 4-point subdivision midpoint is now the cubic through
the four points at their chord-length parameters, instead of Dyn's (−1, 9, 9, −1)/16
weights. With even spacing the two are identical. Where a station pair sits much closer
than its neighbours, Dyn overshot: once the centres were accurate it turned 0.73° of
polyline error into 2.2° of shading error on the tee at r = 1.

Result:

| | Before | After |
|---|---|---|
| Cross hole r = 1.5, hole-side line | 37.0 mm, staircase | 19.7 mm, ≤ 13 µm off the contact |
| Cross hole and tee, every contact line | — | within 0.5% of exact length, ≤ 16 µm off |
| Shading | up to 7.5° | ≤ 1.41° |

- Volumes against OCCT and genus are unchanged within tolerance on fine, print and
  coarse meshes.
- General-tool time rose up to 1.5×; whole-fillet time is unchanged.
- The work budget is untouched, since it counts stations, not probes.
- Known residue: on 32-gon walls, where a convex facet ridge crosses between two widely
  spaced stations, the band's contact edge and the wall seam are both drawn ~25–50 µm
  apart. This adds 12.5% of tube-side line on the coarse cross hole, against 2× before
  the fix.

Tests: `test/mesh-fillet-general-lines.test.js` and the cross-hole shading test.

### Chamfers: setbacks on the wall (2026-10-02)

Chamfers had kept `profile2D`'s section, whose setbacks sit on each flank's tangent
line at the edge. On a curved wall that point stands off the facets by about d²κ/2.
A filler's side wall along that line then adds a lens of material over the wall,
from where the line leaves the facets out to the setback, and the overlay draws
every edge of it. On the boss-on-dome junction at d = 1.5 the boss-side line was
44 mm against a 19.75 mm setback curve, with 137 segments running across the
junction.

The chamfer section now uses the fillet's layout:

- Each setback is the wall point at chord distance d from the edge, in the section
  plane. It is found by walking the wall from the edge in four probed steps, then
  sliding along the wall until the chord is d. A walk that misses (1 in ~500
  stations on the fixtures) keeps the tangent-line setback.
- The flank is modelled as the circle tangent to it at the edge through the setback.
  The section is then laid out, snapped and margined exactly as a fillet's
  (`contactPolygon`), with the straight chord in place of the arc.

| d = 1.5 | Before | After |
|---|---|---|
| Dome boss, boss / dome line vs exact | 44.0 / 60.0 mm vs 19.75 / 28.99, 137 across | 19.67 / 28.80, 0 across |
| Tee, boss / tube | 31.4 / 72.0 mm vs 31.97 / 41.40 | 31.87 / 41.31 |
| Cross hole, hole / tube | 18.46 / 27.77 mm vs 18.96 / 28.39, up to 83 µm off | 18.89 / 28.32, ≤ 8 µm off |

- Chamfer volumes move toward OCCT (fine tee d = 2: −2.0% → −0.1%). Genus is
  unchanged at preview, print and coarse tessellation. Fillets are unchanged.
- General chamfers now build the probe grid too. They take 1.3–1.9× longer, still
  well under the fillets' time.
- The boss-wall shading streaks next to the chamfer junction are gone with it. The
  chamfer face meets the boss wall at as little as 27°, under the wall's 35° crease
  angle, and the overlay's blend↔base rule smoothed the wall's junction vertices
  into it. The setback is now a few hundred nm off the wall, at the end of a steep
  step, so the wall's vertices no longer touch the chamfer face.

Still open: the streaks that remain on the boss wall come from the TOP-RIM blend
(the existing revolve tool), not the general chain, and are the same on main. That
cut leaves sub-µm sliver triangles spanning the wall strips. Their normals are
18–31° off, inside the crease angle, and `creasedNormals` gives each one a full,
unweighted vote at the strip's vertices. A plain cylinder with a top-rim fillet
shows 12.5% of its wall area more than 5° off (chamfer 25%).
