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
