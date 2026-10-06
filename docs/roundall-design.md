# `roundAll(r)` — portable whole-solid rounding

Status: **implemented** (kernel contract v4; this doc is the design record)
Date: 2026-08-16
Base: **stacked on PR #133** (native mesh fillet/chamfer, contract v3).
Spike: session worktree `spike/` scripts (throwaway); findings summarized below.

## Summary

`Solid.roundAll(r)` rounds **every** edge of a solid — convex and concave — with
radius ≈ r, by morphological *close-then-open*: dilate by `r`, erode by `2r`,
dilate by `r`, with a ball. It is implemented natively on **both** backends and
never routes: parts using it keep fast Manifold previews, and STEP export still
gets true B-rep arc surfaces (in the regime where OCCT can produce them — see
the conformance split).

### Relationship to mesh fillet (#133)

`meshFillet`/`meshChamfer` are the **selective** tools: constant radius on
chosen edges, restricted to the edge classes `mesh-fillet.js` can chain
(straight and circular-arc), rerouting anything else to OCCT via
`NEEDS_OCCT`. `roundAll` is the **global** complement: no edge selection, but
it handles arbitrary curved edge chains, blends convex and concave in one
pass, and consumes sub-radius features. Their failure directions are
opposite — for unsupported cases mesh fillet falls back *to* OCCT, while
`roundAll`'s capable backend *is* the mesh one, so it must never throw
`NEEDS_OCCT` (rerouting would land on the weaker implementation).

Semantics inherited from morphology, not from edge dressup:

- Faces stay in place; overall dimensions are preserved for features larger
  than `r`.
- Convex edges/corners round at radius `r` (spherical at corners); concave
  edges fillet at radius `r`.
- Features smaller than the ball are **consumed**: walls/ribs thinner than
  `2r` disappear, holes/slots narrower than `2r` seal shut. This is the point
  of the op — "melt the whole part smooth by r" — and also its sharp edge:
  there is no edge selection and no per-edge radius. For selective filleting
  use `fillet` (OCCT) or the planned wedge-fillet subset (separate track).

## API

```js
s.roundAll(2)            // scalar form
s.roundAll({ r: 2 })     // options form (op-options normalization, like fillet)
```

- `r` must be a finite number ≥ 0. `r === 0` is the identity on every backend
  (same provably-zero carve-out as `fillet(0)`; extend `isZeroMagnitudeCadOp`'s
  spirit but NOT that function — `roundAll` is not a CAD op and never routes).
- Added to `SOLID_OPS` in `kernel.js`; **not** added to `OCCT_ONLY_OPS` (both
  backends must implement it — no stub) and **not** to `ROUTED_CAD_OPS` (the
  probe records it as an ordinary solid op; routing is unaffected).
- `CONTRACT_VERSION` bumps 3 → 4 on top of #133's bump.
  `test/kernel-contract.test.js` and `docs/KERNEL-CONTRACT.md` get the new row.

No quality parameter in v1: quality follows the kernel's existing
preview/print tier, like every other curved primitive. (If a part ever needs
control, an options field can be added compatibly.)

## Contract (KERNEL-CONTRACT.md wording)

`roundAll` is **parity-tolerant**, not backend-identical, with an explicit
regime split:

1. **Safe regime — `r` strictly below the solid's smallest local feature size**
   (min wall thickness, min hole diameter / 2, min edge-to-edge clearance):
   both backends produce the morphological result; volumes agree within the
   mesh-tolerance band (spike: ≤ 0.05% on box and L-bracket cases). This is
   the only regime with cross-backend parity promises.
2. **Consuming regime — `r` at or above feature size**: the **core (mesh)
   class** performs true consumption (features melt away; small remnant
   ridges at consumed-feature bases are correct morphology, not defects).
   The **B-rep class** attempts the same result but MAY skip the entire op
   (returning the input unchanged, with a `roundall-skipped` warning) when
   the offset machinery cannot produce a valid solid. A B-rep `roundAll`
   must never emit an invalid or semantically wrong solid — skip is the only
   permitted degrade (mirror of the fillet skip-on-failure policy).

Authors are pointed at a `verify`-block volume assertion as the guardrail
when they rely on consumption (e.g. `volume` delta bounds), and at the rule
of thumb: keep `r` below half your thinnest wall unless you *want* melting.

## Manifold implementation

`src/framework/geometry/manifold-backend.js`, on the wrapped solid:

```
m1 = simplify(m.minkowskiSum(sphere(r, segs)))
m2 = simplify(m1.minkowskiDifference(sphere(2r, segs)))
out = simplify(m2.minkowskiSum(sphere(r, segs)))
```

- **`simplify` between steps is mandatory, not an optimization.** The naive
  Minkowski (hull-of-triangle-pairs) emits sliver-degenerate meshes whose
  complexity explodes through the chain: the spike's torture case went from
  106 s / 761k tris / broken topology without simplify to 2.4 s / 340 tris /
  clean genus with it. Simplify tolerance: `max(r / 100, 0.01)` mm — well
  under mesh display tolerance, tight enough to preserve the arcs. *As
  implemented*, capped additionally at half the rim-ring spacing
  `r · (1 − cos(2π/segs))`: at a fine tessellation the flat tolerance collapses
  the ring that pins a planar face to its plane and shaves the face inward
  (print tier, r = 2: 0.034 mm per face).
- **Sphere segments scale with quality tier and radius**: choose `segs` so
  chord sagitta `r · (1 − cos(π/segs))` stays under the tier's tolerance
  (preview ≈ 0.05 mm, print ≈ 0.01 mm), clamped to [12, 64]. *As implemented*,
  BOTH balls take the single count sized for the 2r erosion ball (20 at preview,
  45 at print for r = 2, not the 15/32 the r ball alone would need): equal-`segs`
  Manifold spheres are similar, and only then do the dilation and erosion
  support functions cancel exactly, returning planar faces to their planes in
  every orientation rather than only along the axes. The finer r ball costs
  roughly 2x at the print tier — bought deliberately. (`mesh-fillet.js` uses the
  same sagitta *formula* for its burial epsilons but takes full-circle
  `SEGS[quality]` for tessellation — Minkowski cost makes that unaffordable
  here, so `roundAll` owns its radius-scaled `roundAllSegs` helper.) Facets
  smooth-shade in the viewer via the creased-normals pass; only silhouettes
  reveal them. The input's FLAT faces — the ones the input itself shades flat,
  so never a curved wall's facets — are registered on the result as an analytic
  `planes` descriptor (`flatFacePlanes`, `blend-surfaces.js`), and shade with
  their exact plane normal, seam vertices included. Without it a large face's
  corners averaged in the band facets around them (the vertex sum is
  unweighted) and a sloped plate's top showed a shading gradient.
- **Never throws `NEEDS_OCCT`.** The runtime reroute latch exists for ops the
  mesh backend can't do; for `roundAll` the mesh backend is the reference
  implementation, and rerouting would trade a correct result for a skip.
- Cost is real but bounded: hundreds of ms to a few seconds on non-convex
  parts, comparable to an OCCT-routed part today, and memoized by content
  hash like every op — it re-runs only when upstream params change.
- Cache key: `h("roundAll", hash, r)` (segs/tolerance derive from quality and
  radius, so they don't need to be in the key; quality is already part of the
  kernel identity). *As implemented* the mesh key also carries `quality` —
  redundant but harmless, and it documents the tier dependence at the call site.

## OCCT implementation

`src/framework/geometry/occt-backend.js` + a new policy module,
`src/framework/geometry/occt-roundall.js` (it reuses `occt-repair.js`'s
`isClosedSolid` gate and its free-everything convention):

Triple offset via raw OCCT (`replicad.getOC()`), since replicad has no solid
offset wrapper: `BRepOffsetAPI_MakeOffsetShape.PerformByJoin(shape, off, 1e-6,
BRepOffset_Skin, intersection, false, join, false, progressRange)`.

Each step runs a **variant cascade**, first success wins:

| order | join | intersection |
|---|---|---|
| 1 | `GeomAbs_Arc` | `false` |
| 2 | `GeomAbs_Arc` | `true` |
| 3 | `GeomAbs_Intersection` | `false` |
| 4 | `GeomAbs_Intersection` | `true` |

(The spike needed exactly this spread: plain solids dilate with arc/false,
the chained erosion only succeeds with arc/true, and concave post-boolean
solids only dilate with intersection join — which is morphologically fine,
because the *final* arc dilation supplies the convex rounding.)

A step's candidate is accepted only if it passes ALL of:

1. `IsDone()` and non-null shape;
2. meshes to a closed solid with finite positive volume;
3. **monotonicity**: dilation must not shrink volume, erosion must not grow
   it (catches OCCT's "successful" garbage — the spike saw an erosion return
   volume 54 from a 12 000 mm³ input, and a hole case "complete" with an 11%
   crater error; both are filtered by this gate).

If any step exhausts the cascade, the whole op **skips**: return the input
solid unchanged and `console.warn("roundall-skipped", …)` — same shape as the
fillet `safeOp` policy, same rationale (OCCT offset failures are not
monotonic in `r`; searching for a "largest working radius" would converge on
garbage). Zero-radius short-circuits to a clone before any of this.

Result wrapping reuses the normal `wrap(...)` path with cache key
`h("roundAll", hash, r)`; labels pass through unchanged (`cloneLabels`), same
as fillet — `roundAll` produces new surfaces, so feature-label attribution
uses the fallback path (AUTHORING-PARTS.md §labels note applies).

Known hard limitation (documented, not worked around): OCCT cannot do
feature-consuming morphology. Intersection-join dilation of a sub-`r`-featured
solid can pass `BRepCheck_Analyzer` and still poison every downstream op (all
erosion variants fail; booleans can hard-abort the WASM module). Healing
(`ShapeUpgrade_UnifySameDomain`), step-splitting, and complement-based erosion
were all tried in the spike and none survives; the skip policy is the honest
degrade. **Corollary: never run downstream booleans on a candidate that
failed the acceptance gate.**

## What this does NOT change

- #133's landscape stands: `fillet`/`chamfer` stay mesh-native for straight
  and circular-arc chains with the `NEEDS_OCCT` reroute for the rest; `shell`
  stays the only `ROUTED_CAD_OPS` entry; the probe and backend-select are
  untouched by this design.
- No new worker protocol, no new job types: `roundAll` is an ordinary solid op
  inside `build`.
- `roundedBox` / `roundedCylinder` / Shape2D fillet / `meshFillet` remain the
  precise, selective rounding tools; `roundAll` is the blunt global one.

## Testing

- **Contract**: new `SOLID_OPS` row + version bump held by
  `test/kernel-contract.test.js`.
- **Manifold unit tests** (`test/roundall.test.js`): box volume matches the
  analytic closed form (edge/corner terms, spike reference 5800 ± tier
  tolerance); L-shape concave seam rounds (volume drop vs sharp union);
  consumption: rib melts (bbox height returns to base), d < 2r hole seals
  (genus 1 → 0); r = 0 identity; result watertight (`genus`/`isEmpty` sane).
- **OCCT tests** (own file — OCCT boots alone): box + L-shape volumes match
  the Manifold references within 0.5%; the consuming case exercises the skip
  path (result === input volume, warning emitted); r = 0 identity.
- **Parity fixture**: extend the cross-backend volume comparison the same way
  existing parity-tolerant ops are held (box/L-shape only — consuming cases
  are explicitly out of parity scope).
- **ERROR-PATTERNS.md**: one new pattern — `roundall-skipped` → radius likely
  at/above local feature size → reduce r, or accept mesh-only consumption.

## Rollout

1. Kernel op + Manifold implementation + tests (includes the `SOLID_OP_SPECS`
   entry in `op-options.js` — `roundAll: { toArgs: {r} → [r] }` — so the
   options form normalizes and `lint`'s validating probe accepts both forms).
2. OCCT cascade + repair policy + tests.
3. KERNEL-CONTRACT.md (version 4), AUTHORING-PARTS.md section, ERROR-PATTERNS
   entry.
4. Demo part or planter variant exercising it (optional, follow-up).
5. Version bump in the PR per release process.

## Open questions (deliberately deferred)

- Exposing one-sided variants (`roundConvex` / `roundConcave` via opening-only
  or closing-only) — trivial to add later on both implementation paths; YAGNI
  until a part needs it.
- A `minFeature` pre-check on the OCCT side (via the oracle's min-wall
  machinery) to *predict* skips instead of discovering them — nice diagnostics,
  not needed for correctness.
