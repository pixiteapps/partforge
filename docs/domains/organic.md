# Organic: signed-distance bodies

Use this domain for smooth organic bodies: a hand, a paw, a creature, a blobby or
sculpted form. You describe the body as a tree of shapes (spheres, capsules,
ellipsoids, …) on named frames, joined by smooth blends, and `k.implicit` meshes the
tree into one watertight solid. Joints stay smooth because the blend is part of the
shape, not a fillet applied later.

```js
import { validateImplicit, ImplicitSpecError, ImplicitSizeError, IMPLICIT_NODE_KINDS, IMPLICIT_DETAIL_KINDS } from "partforge/organic";
```

The ops themselves stay on the kernel: **`k.implicit(spec)`** builds the solid and
**`k.implicitFrames(spec)`** reports where the spec's frames and labelled shapes end up.
You need no import for them. `partforge/organic` holds the checks and the vocabulary:

| export | what it is |
| --- | --- |
| `validateImplicit(spec, { imageNames? })` | Checks a spec without a kernel. Returns nothing when the spec is valid; otherwise throws one `ImplicitSpecError` that lists every issue with its path. Pass `imageNames` (a `Set` of the part's declared image names) to also check the image names that `texture` detail uses. |
| `ImplicitSpecError` | A spec the grammar refused. `code: "IMPLICIT_SPEC"`, `issues: string[]`, and a message that starts `implicit: `. |
| `ImplicitSizeError` | A spec too large to mesh at its grid. `code: "IMPLICIT_SIZE"`, message starts `implicit: `. |
| `IMPLICIT_NODE_KINDS` | Every node `kind` the tree accepts (a frozen array). |
| `IMPLICIT_DETAIL_KINDS` | Every `kind` the `detail` list accepts (a frozen array). |

`partforge/organic` is worker-safe and light: it loads the grammar only, not the mesher.

There is no reference part file for this domain. The worked example at the end of this
guide (a two-toe paw) is complete and tested. The larger example is the posable hand in
`test/fixtures/implicit-trees.js` (`handSpec`): five digits on frame chains, a `contact`
root, attachments and crease detail.

## When to use it, and when not

Use `k.implicit` for forms with no dominant flats and no exact mating dimensions:
bodies, limbs, handles that grow out of a surface, sculpted reliefs.

Do **not** use it for prismatic or mechanical parts. A bracket, a box, a gear or a
threaded boss is better built with the ordinary ops (`k.box`, `k.cylinder`, booleans,
`fillet`). Those are exact, export to STEP, and build faster. A tree of only boxes,
cylinders and half-spaces with no blending is ordinary CSG in disguise.

When an organic body needs a flat, a hole or a mating face, build the body with
`k.implicit` and then apply ordinary booleans to the solid it returns. `k.implicit`
returns an ordinary `Solid`: transforms, booleans, `measure`, `verify`, STL and 3MF
export all work on it.

## Backend: Manifold only

`k.implicit` is mesh-native. It builds on the Manifold backend only. The OCCT backend
throws:

```text
implicit: builds on the Manifold backend only — set `meta.backend: "manifold"` for this part (STEP export of implicit sub-parts is not supported yet)
```

- Set **`meta.backend: "manifold"`** on a part with implicit bodies. Exports and the CLI
  build the whole part on one backend, and without the pin a `shell` (an OCCT-only op)
  in any sub-part would send the implicit sub-part to OCCT too.
- **STEP export of an implicit sub-part is not supported.** STL and 3MF are.
- A kernel with no implicit engine at all (a host's own kernel) throws
  `implicit: this kernel has no implicit engine — build the part on the Manifold backend`.
- `k.implicitFrames` meshes nothing, so it works on both backends.

## The spec

`k.implicit({ frames?, root, detail?, resolution?, preview? })`. An unknown key is an
error.

| option | meaning |
| --- | --- |
| `frames` | Named coordinate frames: `{ name: { parent?, at?, rotate? } }`. See "Frames". |
| `root` | Required. The node tree. See "Node reference". |
| `detail` | Surface detail applied after meshing, finer than the grid. See "Surface detail". |
| `resolution` | The print/export grid edge in mm. Default `0.6`. Must be a number `≥ 0.05`. |
| `preview` | The preview grid edge in mm. Must be a number `≥ 0.05`. Omit it and the engine picks one (see "Resolution, preview and cost"). |

Distances are in mm and negative inside a shape.

## Frames

A frame is `{ parent?, at?, rotate? }`:

- `parent` names another frame. The frame then sits in its parent. Without `parent` it
  sits in part coordinates.
- `at` is the frame's origin, `[x, y, z]`, in the parent frame.
- `rotate` is one step `{ axis, deg }` or an array of steps. `axis` is `"x"`, `"y"`,
  `"z"` or a non-zero `[x, y, z]`. Each step turns by the right-hand rule.

A frame's transform is `parent · translate(at) · R1 · R2 · …`. Each rotate step turns
about the frame's **own current axes**, in the order you list them. The order matters:

```js
const turned = (rotate) => k.implicitFrames({ frames: { f: { rotate } }, root: { kind: "sphere", r: 1 } }).report().frames.f.y;
turned([{ axis: "z", deg: 90 }, { axis: "x", deg: 90 }]);   // [0, 0, 1]
turned([{ axis: "x", deg: 90 }, { axis: "z", deg: 90 }]);   // [-1, 0, 0]
```

In the first, the turn about z takes the frame's y to −X, and the turn about the frame's
new x axis (world +Y) then takes it to +Z. Each rotation also turns every frame further
down the chain, so a mistake near the root moves everything after it. Check the result
with `k.implicitFrames` (see "Reporting frames") rather than working it out by hand.

An unknown parent and a cycle (`frame "a" is its own ancestor`) are spec errors.

## Node reference

Every node is a plain object `{ kind, …fields }`. Every node also accepts three common
fields:

- **`frame`**: the name of a frame. The node is placed in that frame, wherever it sits
  in the tree: `frame` does not compose with the parent node's placement.
- **`at`**: an offset `[x, y, z]`, in the node's frame (or in its parent's space when it
  has no `frame`).
- **`label`**: a name. `k.implicitFrames` reports a box for each label, and a `contact`
  node's attachments name its children by label.

An unknown field is an error. "axis" fields take `"x"`, `"y"`, `"z"` or a non-zero
`[x, y, z]`.

| kind | required | optional | meaning |
| --- | --- | --- | --- |
| `sphere` | `r` | | A sphere of radius `r`, centred on the node's origin. |
| `ellipsoid` | `r` | | Radii `[rx, ry, rz]`, each > 0. Its field is a scaled sphere, not an exact distance. |
| `capsule` | `b`, `r` | `a` | A capsule from `a` (default `[0, 0, 0]`) to `b`. `r` is one radius, or `[r at a, r at b]` for a taper. |
| `box` | `size` | `round` | A box of full widths `[x, y, z]`, centred. `round` (≥ 0) rounds its edges; at most half the smallest size. |
| `cylinder` | `h`, `r` | `round`, `axis` | Height `h` (centred) and radius `r`, along `axis` (default `"z"`). `round` is at most `min(r, h/2)`. |
| `torus` | `R`, `r` | `axis` | A ring of radius `R` about `axis` (default `"z"`), tube radius `r`. |
| `tube` | `points`, `r` | | Capsules through at least two `[x, y, z]` points. `r` is one radius, or one radius per point. |
| `halfspace` | `normal` | `offset` | Everything on the far side of the plane `normal · p = offset` from `normal` (default `offset` 0). With `normal: "z", offset: 1`, everything below z = 1. Unbounded: use it only inside an `intersect` or `subtract`. |
| `union` | `children` | `k` | All children. `k` is the blend width in mm (default 0, a sharp union). |
| `intersect` | `children` | `k` | Where all children overlap, blended by `k`. |
| `subtract` | `children` | `k` | The first child minus the rest, blended by `k`. |
| `contact` | `children` | `gap`, `bulge`, `attach` | Children that press together instead of blending. Must be the root. See "Blends and contact". |
| `mirror` | `child` | `plane` | The child plus its reflection across `plane`: `"yz"` (the default, x → −x), `"xz"` or `"xy"`. |
| `round` | `child`, `r` | | The child's surface moved out by `r`: rounds its edges and grows it by `r`. |
| `onion` | `child`, `t` | | A shell `2·t` thick, centred on the child's surface. |
| `displace` | `child`, `amount`, `by` | | Moves the surface out by `amount × by`, where `by` is `{ expr, uniforms?, textures? }` (see "Formulas") and its value is clamped to −1…1. `amount` is the most it can move, in mm. |
| `twist` | `child`, `degPerMm` | `axis` | Turns the child about `axis` (default `"z"`) by `degPerMm` degrees per mm along it. |
| `bend` | `child`, `radius` | `axis`, `toward` | Bends the child's length (along `axis`, default `"z"`) into an arc of `radius` that curves toward `toward`. `radius` must exceed the child's extent toward the bend, and the child must not wrap past half a turn. |
| `taper` | `child`, `from`, `to` | `axis` | Scales the child's cross-section along `axis` (default `"z"`): `from: [position, scale]` to `to: [position, scale]`, linear between, held beyond. Scales must be > 0 and the positions must differ. |
| `repeat` | `child` | `linear`, `polar` | Copies of the child. Exactly one of `linear: { step: [x, y, z], count }` (copy i at `i × step`) or `polar: { count, axis? }` (equal turns about `axis`, default `"z"`). `count` is 1 to 256. |
| `expr` | `sdf`, `box` | `uniforms`, `textures`, `lipschitz` | A distance formula. See "Formulas". |

A tree is checked as a whole: every issue is listed, with its path, in one error.

### Blends and contact

A **blend** (`k` on `union`, `intersect`, `subtract`) is the quadratic smooth minimum
(maximum for `intersect`). `k` is the width of the blend in mm. Surfaces closer than `k`
reach toward each other and fuse, and a blend moves a surface by at most `k/4`. Use a
blend where one piece grows out of another: a finger out of a palm, a handle out of a mug.
Keep `k` smaller than the pieces it joins, or the joint turns into a blob.

A **`contact`** node is for pieces that press together without growing into each other.
It keeps its children apart until they actually overlap, and then shows the overlap as
a flat pad with a crisp crease:

- `gap` (mm, default 0) is the clearance kept between children. `0` fuses touching
  children into one solid at the pad. Above `0` they stay apart, so they print as
  separate pieces.
- `bulge` (mm, default 1) swells the skin around a contact, scaled by how deep the
  children press. `0` turns it off.
- `attach` is a list of `{ a, b, near, radius, k, band? }`: two children (`a` and `b`,
  by `label`) that are joined, not just touching, near the frame `near`. Within `radius`
  of that frame's origin they blend with width `k`, like a `union`. The blend fades out
  over `band` (default `radius / 2`). Beyond that they follow the contact rules.

A contact node must be the **root** of its spec, its children's labels must be unique,
it needs at least 2 children and takes at most 127. To combine a contact group with
other shapes, add them as children, or build them as separate `k.implicit` calls and
join the solids with ordinary booleans.

### Formulas (`expr`)

An `expr` node gives the distance as a formula in a small GLSL subset. `sdf` is the
source. The point is `p` (a `vec3`, in the node's frame). The formula must end with one
`return` of a float, negative inside.

- Types `float`, `vec2`, `vec3`. Declare with `float a = …;`; assign with `a = …;` or
  `a += …;`. Constructors `float()`, `vec2()`, `vec3()`.
- Arithmetic, comparisons, `&&`, `||`, `!`, the ternary `c ? a : b`, and swizzles of up
  to three components (`p.xy`, `p.zx`, `.rgb`).
- Functions: `abs`, `floor`, `fract`, `sqrt`, `sin`, `cos` (per component), `min`,
  `max`, `mod`, `step`, `clamp`, `mix`, `smoothstep`, `smin(a, b, k)`, `smax(a, b, k)`,
  `length`, `dot`, `normalize`, `cross`, and `texture(name, uv)`.
- `for (int i = A; i < B; i++) { … }` with integer literals, at most 16 iterations.
  No other loops and no recursion.
- `uniforms`: named numbers, `{ name: number }`. Part params go in here.
- `textures`: named images, `{ name: { image: "<image name>" } }`. The image must be
  declared in the part's `images` field. `texture(name, uv)` samples it (bilinear, `uv`
  clamped to 0…1, grey value 0…1).
- `box`: `[[minX, minY, minZ], [maxX, maxY, maxZ]]`, the formula's bounds in its own
  frame. The shape must stay inside it. Where it reaches the box, it is clipped flat and
  the build warns.
- `lipschitz` (default 1): the most the value can change per mm. A true distance is 1.
  Set it higher for a formula that changes faster (a gyroid, a warped field); too low a
  value can open holes in the mesh.

The `by` of a `displace` node is the same formula language without `box` and
`lipschitz`. Formula errors name their line: `root.sdf: line 1: unknown function 'lenght'`.

## Surface detail

`detail` is a list of entries applied after meshing. The mesh is refined where an entry
applies, and each vertex moves along the surface normal by the summed heights (positive
is outward). Use detail for features finer than the grid: creases, pores, a texture.
For features at least as large as the grid, use a `displace` node instead, which is part
of the shape.

Every entry accepts four common fields:

- **`frame`** and **`at`**: the entry's origin and axes, as for nodes.
- **`radius`**: limits the entry to a ball around its origin. It fades out smoothly
  toward the rim. Without `radius`, the entry applies everywhere.
- **`side`**: an axis in the entry's frame. The entry applies only where the surface
  faces that way: none where the normal's dot product with `side` is 0.15 or less, all
  where it is 0.65 or more.

| kind | required | optional | meaning |
| --- | --- | --- | --- |
| `creases` | `amplitude`, `wavelength` | `axis` | Grooves `amplitude` mm deep, one every `wavelength` mm along `axis` (default `"z"`), running across it. |
| `noise` | `amplitude`, `wavelength` | | Smooth random bumps from −`amplitude` to +`amplitude`, about `wavelength` mm across. |
| `texture` | `image`, `amplitude`, `size` | `projection`, `axis` | An image's grey value (0…1) times `amplitude`. `size: [u, v]` is the area the image covers, in mm, centred on the origin. `projection`: `"planar"` (the default, onto the plane across `axis`), `"cylindrical"` (wrapped once around `axis`; `size[1]` runs along it) or `"triplanar"`. `axis` defaults to `"z"`. |
| `expr` | `height` | `uniforms`, `textures`, `wavelength` | A formula (the language above, `p` in the entry's frame) that returns the height in mm. `wavelength` sets how fine the mesh is refined; without it, to half the grid edge. |

On a `contact` root, detail fades to nothing within 1 mm of a crease or gap between
children, so it never closes a gap.

## Resolution, preview and cost

The engine samples the tree on a grid and meshes it. The grid edge is the cost:
halving it roughly quadruples the work, since the work follows the surface area in
cells.

- **Print and export** use `resolution` (default 0.6 mm).
- **Preview** uses `preview`. Without it, the engine picks the finest edge from
  0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 2.5 and 3 mm whose predicted cost fits a fixed
  budget. The prediction is a pure function of the tree, so every machine picks the
  same grid. A small shape gets a fine grid; the worked example's paw previews at
  0.5 mm, and the hand fixture at 1.5 mm.
- A result is cached on the spec and each image it reads, per tier. Editing
  `resolution` does not rebuild the preview, and the reverse.

Measured on an Apple M1 Max (`docs/research/organic-shapes.md` §9), the hand fixture
costs about 0.19 s in the engine at its 1.5 mm preview, about 0.42 s at 0.8 mm and about
1 s at 0.5 mm. Manifold's import of the mesh adds to that.

**Thin features.** A feature thinner than two grid cells can break up or grow handles.
The build warns (see "Errors and warnings"). Thicken the feature, or build it as its own
`k.implicit` with a finer grid and join it to the body with an ordinary `union`. The hand
fixture's nails are built that way (`nailSpecs`, `resolution: 0.25, preview: 0.35`).

**Limits.** A grid over the shape's bounds with more than 2·10¹⁰ cells, or a surface
that needs more than 24,000,000 samples, throws `ImplicitSizeError`. An image used by a
formula or by detail can be at most 2048 px per side, and 16,777,216 texels in total per
part.

**Posing rebuilds.** Moving a frame changes the shape, so a pose param rebuilds the body.
A whole body moved rigidly by a `views` placement does not.

## Reporting frames: `k.implicitFrames`

`k.implicitFrames(spec)` returns a **frame set**: where the spec's named frames and
labelled nodes are. It validates the spec but meshes nothing. A frame set has the
Solid's transform methods (`translate`, `rotate(deg, center?, axis?)`, `mirror(plane)`,
`scale(factor, center?)`, `rotateX`, `rotateY`, `rotateZ`, `rotateAbout`, `along`,
`at`). Apply the same transforms to it that you apply to the solid, and it moves with
the solid. `report()` gives plain JSON:

- `frames`: each frame's `origin` and unit axes `x`, `y`, `z`, in part coordinates.
- `labels`: each label's box, `{ min, max, center, approximate: true }`. The box always
  contains the labelled piece but can be generous: it grows by a blend's or a contact's
  reach and by the summed `amplitude` of all `detail`, and a label at or under a
  `round`, `onion`, `displace` or warp reports the outermost such node's box. Copies made by `mirror` and
  `repeat`, and duplicate labels, are in one box.
- `mirrored`: true after an odd number of `mirror` calls.

Every number is rounded to 0.001.

```js
const ball = { frames: { top: { at: [0, 0, 10] } }, root: { kind: "sphere", r: 5, frame: "top", label: "ball" } };
k.implicitFrames(ball).report();
// { frames: { top: { origin: [0, 0, 10], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } },
//   labels: { ball: { min: [-5, -5, 5], max: [5, 5, 15], center: [0, 0, 10], approximate: true } }, mirrored: false }
k.implicitFrames(ball).rotateX(90).translate([0, 0, 2]).report().frames.top.origin;   // [0, -10, 2]
```

**In a probe.** Return a frame set from a `probes` entry, and `partforge measure`
writes its `report()` into the report (anywhere in the returned value). Use the same
placement function the build applies to the solid. This is how you check that a limb
reaches what it should, instead of guessing from the render (the error pattern
`implicit-limbs-miss-target` in `docs/ERROR-PATTERNS.md`). A probe that throws reports
`{ error }`.

Return the frame set itself and let `measure` call `report()`. Do not call `report()`
inside the probe: lint runs probes without geometry, where `k.implicitFrames` returns a
placeholder, so the call is the lint error `unknown-solid-op`. For exact surface numbers, read a slab probe (a solid intersected with a
thin box): label boxes are approximate.

## Checking a spec: `validateImplicit`

`validateImplicit(spec)` runs the structural checks without a kernel: every field, every
frame name, every `kind`, and the rules in the tables above. Use it in a unit test, or
when you build a spec in `derive`. It does **not** check what is found only when the
tree is compiled: formula source, the contact-must-be-root rule, an unbounded root, a
`bend` that is too tight, and (without `imageNames`) image names. `k.implicitFrames`
compiles the tree, so it checks all of those, still without meshing.

```js
const issuesOf = (spec) => { try { validateImplicit(spec); return []; } catch (e) { return e.issues; } };
validateImplicit(ball);   // undefined
issuesOf({ frames: { tip: { parent: "toe" } }, root: { kind: "union", k: -1, children: [{ kind: "sphere", r: 0 }, { kind: "capsule", b: [0, 9, 0], r: 2, frame: "toes" }] }, quality: "high" });
// ['frames.tip.parent: unknown frame "toe"', "root.children[0].r: must be a number > 0",
//  'root.children[1].frame: unknown frame "toes"', "root.k: must be a number ≥ 0", "quality: unknown option"]
```

The thrown error is an `ImplicitSpecError` whose message is `implicit: ` followed by the
same issues joined with `; `. `k.implicit` throws the same error for the same spec.

## Errors and warnings

`k.implicit` and `k.implicitFrames` throw an `ImplicitSpecError` for any spec issue
above. These are the errors found when the tree is compiled or meshed:

```text
implicit: root.children[1]: a contact group must be the top of its k.implicit (it is the root's job to split the surface into pieces) — make it the spec's root and add the other shapes as its children, or build them as separate k.implicit calls and join them with k.union
implicit: root: the shape is unbounded — intersect or subtract a `halfspace` from a bounded shape instead of using it alone
implicit: root.sdf: line 1: unknown function 'lenght'
implicit: root.radius: the child is too long to bend at radius 5 (it would wrap past half a turn)
implicit: detail[0].image: unknown image "skin" — declare it in the part's `images` field
implicit: the shape is empty at a 1 mm grid — nothing is inside it (check subtract order and sizes), or it is thinner than the grid
implicit: a 0.05 mm grid over this shape has 8.0e+12 cells (limit 2e+10) — raise `resolution`/`preview` or split the part
```

The last one is an `ImplicitSizeError` (`code: "IMPLICIT_SIZE"`). The empty-shape error
is a plain `Error`. The others are `ImplicitSpecError`s.

A build can also succeed with a warning in its build warnings (which `partforge
measure` and the app show):

```text
implicit: thinnest feature (1.60 mm) is under 2 grid cells at 1 mm — it may break up or grow handles; mesh it as its own k.implicit with a finer grid, or thicken it
```

The other warnings are a shape clipped flat at the edge of its sampling box (enlarge the
`box` of the `expr` it reaches past, or reduce blend widths and displacement), and a
contact search between two children that found too much overlap to resolve (those two
get no bulge).

Relevant entries in `docs/ERROR-PATTERNS.md`: `implicit-limbs-miss-target`.

## What lint and verify check

The domain adds no lint rules and no verify metrics.

- **Lint does not compile the tree.** It checks `k.implicit`'s option keys only
  (`invalid-op-options`: an unknown option, or a missing `root`). A bad node, a bad
  frame or a bad formula lints clean. Run `validateImplicit` in a test, or run
  `partforge measure`, which builds the part and fails with the spec error.
- **Verify** reads the meshed solid like any other: `watertight`, `holes`, `bbox`,
  `volume`, the process's checks, `overlaps`. A rounded body on a flat bed has little
  bed contact and large overhangs; read the costs.

## Gotchas

- **`frame` is absolute.** A node with `frame` sits in that frame wherever it is in the
  tree. To place a group of shapes together, give the group a frame (or give each child
  the same frame), not an `at` on a parent node that its framed children then ignore.
- **Rotate steps turn about the frame's own axes, in order.** Swap two steps and the
  limb points somewhere else. Report the frames to check.
- **A blend wider than the pieces eats them.** Keep `k` below the smallest piece it
  joins. Use `contact` where pieces should press, not fuse.
- **`round` grows the shape** by `r`, and `onion` makes a shell `2·t` thick centred on the
  surface. Size the child for that.
- **A probe returns the frame set, not its `report()`.** Calling `report()` in a probe
  fails lint.
- **Contact is root-only.** Put the other shapes inside it, or build them separately.
- **No STEP.** Pin `meta.backend: "manifold"` and export STL or 3MF.
- **Build flats and holes after meshing**, with ordinary booleans on the returned solid.

## Worked example: a two-toe paw

A pad and two toes. Each toe is a capsule on its own frame, whose +Y runs along the toe.
`spread` fans the toes and `curl` bends them down. One `union` with a blend joins them,
and each toe gets a patch of crease detail on its top. A probe reports where the frames
end up.

```js
import { validateImplicit } from "partforge/organic";

// Pad and two toes; each toe frame's +Y runs along its toe.
const pawSpec = (p) => ({
  frames: {
    pad: { at: [0, 0, 8] },
    left: { parent: "pad", at: [-7, 10, 0], rotate: [{ axis: "z", deg: p.spread }, { axis: "x", deg: -p.curl }] },
    right: { parent: "pad", at: [7, 10, 0], rotate: [{ axis: "z", deg: -p.spread }, { axis: "x", deg: -p.curl }] },
    "left.tip": { parent: "left", at: [0, 18, 0] },
    "right.tip": { parent: "right", at: [0, 18, 0] },
  },
  root: { kind: "union", k: p.blend, children: [
    { kind: "ellipsoid", frame: "pad", r: [16, 14, 8], label: "pad" },
    { kind: "capsule", frame: "left", b: [0, 18, 0], r: [5, 4], label: "left" },
    { kind: "capsule", frame: "right", b: [0, 18, 0], r: [5, 4], label: "right" },
  ] },
  detail: ["left", "right"].map((toe) => ({
    kind: "creases", frame: toe, at: [0, 6, 4.6], radius: 4, amplitude: 0.3, wavelength: 1.2, axis: "y", side: [0, 0, 1],
  })),
  resolution: 0.6,
});

export default {
  meta: { title: "Paw", units: "mm", backend: "manifold" },
  parameters: [{ id: "pose", title: "Pose", advanced: [
    { key: "spread", label: "Spread", unit: "°", min: 0, max: 30, step: 1 },
    { key: "curl", label: "Curl", unit: "°", min: 0, max: 60, step: 1 },
    { key: "blend", label: "Blend", unit: "mm", min: 0, max: 8, step: 0.5 },
  ] }],
  defaults: { spread: 12, curl: 25, blend: 4 },
  parts: {
    paw: { label: "Paw", views: ["paw"], build: (k, p) => k.implicit(pawSpec(p)) },
  },
  views: { paw: { label: "Paw" } },
  probes: { frames: (k, p) => k.implicitFrames(pawSpec(p)) },
  verify: { expect: { paw: { watertight: true, holes: 0 } } },
};
```

The spec is valid, and its frames put the left toe's tip here:

```js
validateImplicit(pawSpec({ spread: 12, curl: 25, blend: 4 }));   // undefined
k.implicitFrames(pawSpec({ spread: 12, curl: 25, blend: 4 })).report().frames["left.tip"];
// { origin: [-10.392, 25.957, 0.393], x: [0.978, 0.208, 0], y: [-0.188, 0.887, -0.423], z: [-0.088, 0.413, 0.906] }
```

`partforge measure` on this part writes the frame set's report under `probes.frames`.
Its tip origins are `[-10.392, 25.957, 0.393]` for `left.tip` and
`[10.392, 25.957, 0.393]` for `right.tip`: the toes are mirror images. With `curl: 25` the toes dip below the pad: the solid's
lowest point is at z ≈ −3.6, under the pad's underside at z = 0. A printed paw needs
supports there, or a flat cut with an ordinary boolean.

The points to copy:

- **One spec function of the params**, used by both `build` and the probe, so the
  report always describes the solid that was built.
- **Frames carry the pose.** The toes are authored once, along +Y of their frames; the
  params only change the frames' rotate steps.
- **`meta.backend: "manifold"`** pins the part to the backend that can build it.

## Jointed bodies

For a body with jointed limbs, pose the joint chain with `limb` from
`partforge/kinematics` (`docs/domains/kinematics.md`). Its frames have the same
`{ parent, at, rotate }` shape, so a posed limb's `frames` go straight into a spec's
`frames`:

```js
import { limb } from "partforge/kinematics";

const toe = limb("toe", { at: [-7, 10, 8], toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["base", "mid"], lengths: [10, 8] });
const posed = toe.pose({ bend: [20, 30] });
k.implicitFrames({ frames: posed.frames, root: { kind: "capsule", frame: "toe.base", b: [0, 10, 0], r: 4 } }).report().frames["toe.tip"].origin;   // [-7, 24.539, -1.549]
posed.world("tip").origin;   // [-7, 24.539, -1.549]
```
