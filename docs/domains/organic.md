# Organic: signed-distance and subdivision bodies

Use this domain for smooth organic bodies: a hand, a paw, a creature, a blobby or
sculpted form. You describe the body as a tree of shapes (spheres, capsules,
ellipsoids, …) on named frames, joined by smooth blends, and `k.implicit` meshes the
tree into one watertight solid. Joints stay smooth because the blend is part of the
shape, not a fillet applied later.

The domain has a second way to build a smooth body: box-model a coarse cage of quads
with `k.cage` and smooth it into a solid with `k.subdiv`. See "A controlled surface:
the subdivision cage" near the end of this guide for that, and for when to use which.

```js
import { validateImplicit, ImplicitSpecError, ImplicitSizeError, IMPLICIT_NODE_KINDS, IMPLICIT_DETAIL_KINDS, cage } from "partforge/organic";
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
| `cage(options)` | The cage builder `k.cage` calls: same options, same cage. For code that has no kernel, such as `derive`. See "Drag handles on a cage". |

`partforge/organic` is worker-safe and light: it loads the grammar only, not the mesher.

The domain has two reference parts. `src/parts/organic-hand.js` is a posable hand built
with `k.implicit`: five digits on frame chains, a `contact` root, attachments and crease
detail (its builders are also the fixture in `test/fixtures/implicit-trees.js`).
`src/parts/organic-whale.js` is a whale built from one subdivision cage. The worked
example in "Worked example: a two-toe paw" is complete and tested, and so is the whale
in "Worked example: a whale".

## When to use it, and when not

Use `k.implicit` for forms with no dominant flats and no exact mating dimensions:
bodies, limbs, handles that grow out of a surface, sculpted reliefs.

Do **not** use it for prismatic or mechanical parts. A bracket, a box, a gear or a
threaded boss is better built with the ordinary ops (`k.box`, `k.cylinder`, booleans,
`fillet`). Those are exact, export to STEP, and build faster. A tree of only boxes,
cylinders and half-spaces with no blending is ordinary CSG in disguise.

For one continuous skin whose outline you want to control exactly (a whale, a fish, a
hull), a subdivision cage is often the better tool; see "When a cage, and when an
implicit tree".

When an organic body needs a flat, a hole or a mating face, build the body with
`k.implicit` and then apply ordinary booleans to the solid it returns. `k.implicit`
returns an ordinary `Solid`: transforms, booleans, `measure`, `verify`, STL and 3MF
export all work on it.

## Backend: Manifold only

`k.implicit` and `k.subdiv` are mesh-native. They build on the Manifold backend only.
For `k.implicit`, the OCCT backend throws:

```text
implicit: OCCT cannot build k.implicit (it is mesh-native) — this part reached OCCT because meta.backend pins it there, because a fillet or chamfer in the part needs OCCT (a function selector, or an edge the mesh backend cannot blend — the CLI, STL and 3MF build the whole part on one backend), or because the geometry-free probe did not see the k.implicit call (one made only after reading a geometry query); set `meta.backend: "manifold"`, give that fillet or chamfer an object selector or a shape the mesh backend can blend, and make the k.implicit call unconditional
```

- Set **`meta.backend: "manifold"`** on a part with implicit bodies. STL, 3MF and the
  CLI build the whole part on one backend, and without the pin a `shell` (an OCCT-only
  op) in any sub-part would send the implicit sub-part to OCCT too.
- **Keep every `fillet` and `chamfer` in the part mesh-buildable**, in the ordinary
  sub-parts too. The preview builds each sub-part on its own backend, but `measure`,
  `verify`, STL and 3MF build the whole part on one, so a fillet that falls back to
  OCCT takes the implicit sub-part with it and the build fails. Use the object selectors
  (`{ dir }`, `{ inPlane, at }`, `{ near }`), never a function selector (lint:
  `implicit-needs-manifold`). A fillet can also fall back at build time, on an edge the
  mesh backend cannot blend (mixed convexity, a bend tighter than the radius); lint
  cannot see that, and `partforge measure` then names the fillet that stopped the
  Manifold build. Change its radius or edges, or `chamfer` instead.
- **STEP export writes a hybrid file.** The ordinary sub-parts are exact B-rep solids,
  as always. Each sub-part whose build calls `k.implicit` is meshed on Manifold at the
  print grid (`resolution`) in its export pose and written as a tessellated solid
  (AP242's `TESSELLATED_SOLID`), with its name and colour, so the file carries a closed
  mesh body beside the exact ones. A sub-part that calls `k.implicit` anywhere is one mesh
  body, including any ordinary ops in it. The pin does not change this split. Expect
  about 40 bytes per triangle: the reference hand (`src/parts/organic-hand.js`, ~116k triangles
  at its print grid) adds about 4 MB. A sub-part that calls both
  `k.implicit` and `shell` cannot export; use an `onion` node for a hollow organic body.
- A kernel with no implicit engine at all (a host's own kernel) throws
  `implicit: this kernel has no implicit engine — build the part on the Manifold backend`.
- `k.implicitFrames` meshes nothing, so it works on both backends.
- **`k.subdiv` follows every rule above.** OCCT throws the same message with `k.subdiv`
  in place of `k.implicit`; it starts
  `subdiv: OCCT cannot build k.subdiv (it is mesh-native)`. Pin the part to Manifold and
  keep its fillets and chamfers mesh-buildable. A STEP export writes a `k.subdiv`
  sub-part as a tessellated solid, as it does an implicit one. A kernel with no
  subdivision engine throws
  `subdiv: this kernel has no subdivision engine — build the part on the Manifold backend`.
  `k.cage` is plain data, so it works on both backends.

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

### Dragging a pose

This section is about `k.implicit` bodies. A `k.subdiv` body's drag is under "The
surface: `k.subdiv`".

While you drag a slider, the app does not rebuild the body on every move. It bends the
last exact mesh instead, at display rate, and rebuilds exactly when you let go or pause.
A handle drag in Pose mode bends it the same way (pose the body's frames with limbs and
declare `handles`, as the reference hand does; see `docs/domains/kinematics.md`, "Organic
bodies"). A handle drag builds nothing until you let go, and the bent mesh is not faded as a
rebuilding part is.

**What bends.** A slider bends the mesh only when it changes nothing but `frames` of a
`k.implicit`, or of a `k.union` of them, and the result is in its canonical place (not
moved, rotated, mirrored or cut after the build). The build must also be one the
framework can trust without running it: the same shapes, fonts, images and vector
sources on both sides, and a plain operand (a `k.box` in the union) unchanged.

**What does not.** A `setParams` call, an animation, a posed or moved result, and any
change to a shape (a radius, a node, the detail, an image) rebuild as before.

**How.** Each vertex of a preview mesh remembers which frame or frames it follows. A
move blends the frames' rigid motions per vertex, so a finger follows its joints and the
palm stays put. The bent mesh is approximate: the exact build starts after a 150 ms
pause with no move, or at once on release, and replaces it when it lands. While the mesh
is bent its edge lines are hidden. They return with the exact mesh. A render or capture
during a drag draws the last exact mesh, at the pose it was built at, never the bent one;
if that build fails, the last exact mesh comes back.

**Two-stage union.** A union of `k.implicit` bodies (the hand and its nails) posts its
pieces joined together as soon as they are built, then the real union. The first mesh has
overlaps but looks right. It skips the stage during a drag, on its release, or in an animation, and a failed
build puts the previous exact mesh back.

The View style thumbnails, picking and sketch anchors, and the cutaway cap read the bent
mesh during a drag. That is accepted: they are display only.

Measured on an Apple M1 Max, native core on, the hand part at its 1.5 mm preview
(`npm run bench:pose-drag`, CPU time):

| Step | Time |
| --- | --- |
| Bend the mesh (296,946 corners), curl 30 to 31 | 5.3 ms |
| Bind a build's vertices (the body, 38,895 vertices) | 12.6 ms |
| Exact rebuild, one finger (`flexIndex` 60 to 62), cold / warm | 723 / 704 ms |
| Exact rebuild, every finger (`curl` 30 to 32), cold / warm | 767 / 777 ms |
| First mesh (the pieces), cold / warm | 536 / 526 ms |
| Real union mesh, cold / warm | 739 / 704 ms |

The warm rebuild reuses the preview sample cache: 76% of the one-finger samples hit and
21% of the all-finger samples. A palm block's program includes the bulge regions of every
finger, so a flex misses the palm's blocks and the saving is small once the nails, the
union and the mesh import are added. Cold and warm meshes are identical.

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

Relevant entries in `docs/ERROR-PATTERNS.md`: `implicit-limbs-miss-target`, `implicit-thin-feature`, `implicit-blend-eats-child`, `implicit-lipschitz-low`.

## What lint and verify check

The domain adds lint rules and no verify metrics. Lint runs every `k.implicit` and
`k.implicitFrames` spec that the build makes at the lint params, so it judges the
**default pose**. A pose a slider reaches but the defaults do not is not checked. Of
these rules, only `implicit-needs-manifold` applies to `k.subdiv`. Lint does not mesh a
cage, so the build finds a cage that passes through itself (see "Validity").

| Rule | Severity | Reports |
|---|---|---|
| `implicit-spec-invalid` | error | The engine's compiler rejects the spec: a bad node or field, a frame cycle, a formula error, a contact below the root, an attach naming a missing label, an undeclared image. The message is the build's own error. Image names are checked only against a static `images` object. |
| `implicit-needs-manifold` | error | `k.implicit` or `k.subdiv` (the message names which) in a part that builds on OCCT: `meta.backend: "occt"`, a `shell` that routes the part there, or a `fillet`/`chamfer` with a function selector in any sub-part (whatever the pin). |
| `implicit-thin-feature` | warning | The thinnest feature is under 2 cells of the preview grid (the spec's `preview`, or the automatic choice) or the print grid. |
| `implicit-blend-eats-child` | warning | A blend's `k`, or a contact `attach` entry's `k`, is wider than a child it joins: the child melts into a blob. |
| `implicit-lipschitz-low` | warning | An `expr` formula, sampled on 512 points of its `box`, changes faster per mm than its `lipschitz`. A spot check, not a proof. Formulas that read a texture are skipped. |
| `implicit-csg-in-disguise` | note | Only boxes, cylinders and halfspaces under sharp booleans: plain CAD that the standard ops build exactly. |

- **Measure** shows the build's warnings (a thin feature, a clipped shape) under
  `warnings`, the same text the app shows.
- **Verify** reads the meshed solid like any other: `watertight`, `holes`, `bbox`,
  `volume`, the process's checks, `overlaps`. A rounded body on a flat bed has little
  bed contact and large overhangs; read the costs.

The reference part, `src/parts/organic-hand.js`, lints with no errors or warnings: a contact
hand with crease detail, its nails each their own fine-grid `k.implicit` (the fix
`implicit-thin-feature` suggests), and a probe that reports its frames. Each digit is a
`limb` posed in `derive`, its frames put into the spec, with one angles-mode handle per
digit, so you pose the hand by dragging a fingertip or a knuckle in Pose mode. The
other reference part, `src/parts/organic-whale.js`, also lints clean and passes `verify`.

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
- **No exact STEP.** Pin `meta.backend: "manifold"`. A STEP export writes an organic
  sub-part as a tessellated (mesh) solid; export STL or 3MF for printing.
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

const toe = limb("toe", { at: [-7, 10, 8], toward: [0, 1, 0], bendToward: [0, 0, -1], joints: ["base", "mid"], lengths: [10, 8], r: [4.75, 4, 3] });
const posed = toe.pose({ bend: [20, 30] });
k.implicitFrames({ frames: posed.frames, root: { kind: "capsule", frame: "toe.base", b: [0, 10, 0], r: 4 } }).report().frames["toe.tip"].origin;   // [-7, 24.539, -1.549]
posed.world("tip").origin;   // [-7, 24.539, -1.549]
```

The posed limb also writes two pieces of the spec for you, as plain data:

- **`posed.flesh({ r?, blend?, label? })`** is a `union` of one tapered `capsule` per
  segment, each in its joint's frame and labelled with it. `blend` becomes the union's
  `k`; leave it out for a sharp union.
- **`posed.attach(label, { k, radius?, band?, r?, a? })`** is one entry for a `contact`
  node's `attach` list. It joins the flesh (label `a`, default the limb's name) to the
  piece labelled `label`, near the limb's base joint.

```js
posed.flesh({ blend: 1.5 });
// { kind: "union", k: 1.5, label: "toe", children: [
//   { kind: "capsule", frame: "toe.base", b: [0, 10, 0], r: [4.75, 4], label: "toe.base" },
//   { kind: "capsule", frame: "toe.mid", b: [0, 8, 0], r: [4, 3], label: "toe.mid" } ] }
posed.attach("pad", { k: 3, radius: 4 });   // { a: "toe", b: "pad", near: "toe.base", radius: 4, band: 1.5, k: 3 }
```

To pose a limb so that it grips a `k.implicit` shape, give `grip.around` the shape's
distance function: `implicitDistance(node)` from `partforge/geometry`. It is the engine's
own field for that node, in part coordinates, so the node must not name a `frame`. Like
the field, it is negative inside and zero on the surface:

```js
import { implicitDistance } from "partforge/geometry";

const pad = { kind: "union", k: 2, children: [{ kind: "sphere", r: 6 }, { kind: "sphere", r: 6, at: [10, 0, 0] }] };
implicitDistance(pad)(0, 0, 10);   // 4
implicitDistance(pad)(5, 0, 0);    // -1.5
```

The kinematics guide has the defaults, the errors, and a worked hand.

## A controlled surface: the subdivision cage

A second way to build a smooth body. Start from a box, and box-model a coarse closed
mesh of quads, the **cage**, by extruding, moving and scaling its faces. Then
`k.subdiv` smooths the cage into one watertight solid (Catmull-Clark subdivision).
The cage is a builder object you change in place inside `build`:

```js
const bar = k.cage({ box: { size: [40, 20, 20], segs: [2, 1, 1] } });
bar.faces("+z");   // ["+z:0,0", "+z:1,0"]
bar.extrude("+x:0,0", { by: 10, scale: 0.5 });   // "+x:0,0>"
```

You need no import: `k.cage` and `k.subdiv` are kernel ops. `k.subdiv(cage)` returns an
ordinary `Solid`, so booleans, transforms, `measure`, `verify`, STL and 3MF work on
it. It builds on Manifold only (see "Backend: Manifold only").

### When a cage, and when an implicit tree

- **Use a cage for one continuous skin whose outline matters**: a whale, a fish, a
  bottle with a sculpted shoulder, a hull, a paw, a hand. You place the control points,
  so you control the silhouette directly, and the surface has no blend widths to tune.
  Limbs grow out of the body as extrudes, and a slider can bend them (`rotate`), as long
  as the bent parts do not touch each other or the body. A `limb` posed in `derive` can
  set those angles, so a Pose-mode handle can drag the limb (see "Drag handles on a
  cage").
- **Use an implicit tree for pieces that press together, blend where they meet, or pose
  by frames**: fingers that close against the palm, toes that fan and merge, a body with
  crease detail. The cage has none of these: it has no frames, no `contact`, no detail,
  and a cage that passes through itself is an error. A pose drag on a cage follows the
  pointer (see "The surface: `k.subdiv`"), but it stops where the body would pass through
  itself.
- The two join each other only by ordinary booleans (`union`, `cut`), which leave a
  sharp seam where they meet. Do not plan on a smooth join between a cage and a tree.

### Starting the cage: `k.cage`

`k.cage({ box: { size, center?, segs? }, mirror? })` starts the cage from a box.

- `size` is `[x, y, z]` in mm, all positive. `center` defaults to `[0, 0, 0]` (the box
  is centred on it in all three axes).
- `segs` is how many faces each side is split into along x, y and z, default
  `[1, 1, 1]`. A side across x and y has `segs[0] × segs[1]` faces.
- `mirror` is `"yz"` (reflect X), `"xz"` (reflect Y) or `"xy"` (reflect Z), through
  the box's centre. See "Mirror".

### Face ids

Every face has an id string. Box faces are `${side}:${i},${j}`, where `side` is one of
`+x`, `-x`, `+y`, `-y`, `+z`, `-z`, and the two indices count faces along two axes,
rising with the coordinate:

| side | `i` counts along | `j` counts along |
|---|---|---|
| `+x`, `-x` | Y | Z |
| `+y`, `-y` | X | Z |
| `+z`, `-z` | X | Y |

An extrude replaces the faces it extrudes and names the new ones after them:

- **One face:** the cap is the face's id plus `>` (`+x:0,0>`), or the `id` you give.
  Its four sides are `<cap>.s0` to `<cap>.s3`.
- **A region** (a list of faces): the caps are `<id>:0`, `<id>:1`, … in the order you
  listed the faces, where `<id>` defaults to the first face's id plus `>`. There is one
  side per boundary edge, `<id>.s0`, `<id>.s1`, … A region given as a list returns a
  list, even with one face.
- **`steps: n`:** the extrude is cut into `n` rings. Ring `m` (1 is next to the base)
  names its sides `<id>.<m>.sK`; the last ring drops the `.<m>`. Only the last ring is a
  cap.

**Side order.** Side `k` sits on boundary edge `k`. Take the two world axes least
aligned with the face's normal (the region's summed normal), in x, y, z order; call them
the first and second in-plane axes. Edge 0 is the edge whose midpoint is smallest on the
first in-plane axis. The other edges follow counter-clockwise, seen from outside. On a
tilted face two edges can tie on the first axis (within 1e-9 mm): then the smaller
midpoint on the second axis wins, and then the edge met first in the stored walk.

```js
bar.faces("+x:0,0>.s").map((id) => bar.normal(id).map(Math.round));   // [[0, -1, 0], [0, 0, -1], [0, 1, 0], [0, 0, 1]]
bar.extrude(["+z:0,0", "+z:1,0"], { by: 5 });   // ["+z:0,0>:0", "+z:0,0>:1"]
bar.faces("+z:0,0>.").length;   // 6
bar.extrude("-x:0,0", { by: 12, steps: 3, id: "arm" });   // "arm"
bar.faces("arm.1.");   // ["arm.1.s0", "arm.1.s1", "arm.1.s2", "arm.1.s3"]
bar.faces("arm.s");   // ["arm.s0", "arm.s1", "arm.s2", "arm.s3"]
```

Do not guess ids for faces deep in a model. Read them back with `faces(prefix)`, and
pick by `normal` or `centroid` when you need "the side that faces +Y".

### Changing the cage

- **`extrude(face | faces, { by, scale?, steps?, id? })`** pushes the faces out and
  returns the new cap's id (a list of cap ids for a list of faces). `by` is a distance
  along the faces' normal (their summed normal for a region), or an `[x, y, z]` offset.
  `scale` (a number, or `[sx, sy, sz]` along the world axes, default 1) sizes the cap
  about its own centre. `steps` (an integer, default 1) cuts the extrude into rings.
  The extruded faces are gone afterwards; their id names the cap and sides' family.
  A region must be edge-connected and have one boundary loop: a region with a hole
  throws. An `id` must be a non-empty string without `~`, and may not be an id in use
  or head a family in use (an id that an existing `<id>:` or `<id>.` id starts with).
- **`move(face | faces, [x, y, z])`** moves the faces' points. A point shared with a
  neighbour moves once, so the neighbours stretch to follow.
- **`scale(face | faces, s, { about? })`** scales the faces' points by `s` (a number or
  `[sx, sy, sz]`) about the point `about`. Omitted (or `null`), it is the points' mean;
  under a mirror, for faces with an edge on the plane, the mean of the faces and their
  reflections, on the plane.
- **`rotate(face | faces, { axis, deg, about? })`** turns the faces' points by `deg`
  degrees about a line. `axis` is `"x"`, `"y"`, `"z"` or an `[x, y, z]` direction, and the
  turn is right-handed (a positive angle about `"x"` turns +Y toward +Z). The line passes
  through `about`, which defaults to the points' mean, so a bare `rotate` tilts a face
  where it stands. A later `extrude` with a distance `by` follows the face's new normal:
  this is how a limb turns a corner or bends with a slider (see "Recipes").
- **`crease(face | faces, other?)`** keeps the border of the face (or of the region the
  faces make) as a hard edge of the smooth surface. With `other` (a face or faces), only
  the edges the two share are creased. Everything else stays smooth. The mark stays on
  those edges: extrude the face afterwards and the crease is at the base of the extrusion.
  Under a mirror, a region with an edge on the plane is creased together with its
  reflection, so no crease is left on the plane.

The read methods change nothing:

- **`centroid(id)`** is the mean of the face's four corners. **`normal(id)`** is its unit
  normal, pointing out.
- **`size(id)`** is `[u, v]`: the face's extent along its first in-plane axis (the mean
  length of edges 1 and 3), then along its second (edges 0 and 2).
- **`faces(prefix?)`** lists the ids that start with `prefix` (every id when omitted).
- **`bounds()`** is `{ min, max }` of the cage's points (the surface lies inside it).

```js
bar.size("arm.s0");   // [4, 20]
bar.move("arm", [0, 0, 5]);
bar.centroid("arm");   // [-32, 0, 5]
bar.scale("arm", 0.5);
bar.size("arm");   // [10, 10]
bar.bounds();   // { min: [-32, -10, -10], max: [30, 10, 15] }
bar.rotate("arm", { axis: "y", deg: 90 });
bar.normal("arm").map(Math.round);   // [0, 0, 1]
```

### Creases

A cage is smooth everywhere unless you say otherwise. `crease` marks where it is not:

- A creased border is a sharp edge that still curves along its length. Crease one face of
  a box and that face becomes flat with a rounded outline and a hard rim.
- A point where three or more creased edges meet is a sharp corner. Crease two faces that
  share an edge and the ends of that edge are corners; crease every face of a box and the
  result is the box itself.
- Each crease shades hard and draws an edge line, like an edge of a mechanical part. The
  skin between creases shades smooth, as before.

```js
const puck = cage({ box: { size: [30, 30, 10] } });
puck.crease("+z:0,0");
puck.crease("-z:0,0");
puck.snapshot().creases.length;   // 8
```

That is a pebble with a flat, hard-rimmed top and bottom and a smooth wall.

A crease does not have to close a loop. `crease(a, b)` marks only the edges that `a` and
`b` share, and where that run of edges stops, the crease fades into the smooth surface.
`b` may name reflected (`~`) faces, which is how a ridge is laid along the mirror plane:

```js
const trout = cage({ box: { size: [40, 16, 12], segs: [2, 2, 1] }, mirror: "xz" });
trout.crease(["+z:0,1", "+z:1,1"], ["+z:0,1~", "+z:1,1~"]);
trout.snapshot().creases.length;   // 2
```

A crease follows the borders of cage faces, so to crease along a line, give the cage an
edge there first (`segs`, or an `extrude`). A crease along a line where the surface does
not bend (down the middle of a flat face) changes nothing and draws no line. There is no
partly sharp crease: for a tight but rounded edge, add a short `extrude` step beside it.

### Mirror

With `mirror`, the cage stays whole and symmetric through the plane:

- **You change the positive half only.** A changing method (`extrude`, `move`,
  `scale`, `rotate`) takes positive-side ids, and the same change is made to the reflected faces
  at once. Every face on the far side is named after its positive twin plus `~`
  (`+y:0,0>~`). The far box side has no ids of its own: under `mirror: "xz"` there are
  no `-y:` ids (its faces are `+y:0,0~`, `+y:1,0~`, …), and on a side the plane cuts,
  the far half is named the same way (there is no `+x:0,0`; that face is `+x:1,0~`).
  You can read a `~` id, but you cannot change one.
- **`segs` across the plane must be even**, so the plane falls on a row of points.
- **A point on the plane stays on it.** It keeps only the in-plane part of a move,
  scale or rotate. So a face with an edge on the plane does not turn rigidly: its plane
  points stay put and the face stretches.
- **A reflected face turns the opposite way.** `rotate` turns the positive faces as
  asked and sets the far side to their reflection. Its default `about` is the positive
  faces' own mean. Keep a turned face on its own side of the plane: one swung across
  it passes through its reflection.
- **A face or region with an edge on the plane grows across it as one region** with its
  reflection, so no wall is left on the plane: a dorsal fin on the middle of a back is one
  fin, not two. Its caps are the positive caps and their `~` twins. Its sides are
  numbered from the positive edge that leaves the plane, counter-clockwise seen from
  outside; each far side takes its twin's number plus `~`.

```js
const fish = k.cage({ box: { size: [60, 30, 20], segs: [4, 2, 1] }, mirror: "xz" });
fish.faces("+x:");   // ["+x:1,0~", "+x:1,0"]
fish.faces("-y:");   // []
const pec = fish.extrude("+y:0,0", { by: 12, scale: 0.7 });
fish.centroid(`${pec}~`)[1] === -fish.centroid(pec)[1];   // true
fish.move("+z:1,1", [0, 0, 4]);
fish.centroid("+z:1,1~");   // [-7.5, -7.5, 14]
fish.extrude(["+z:2,1", "+z:3,1"], { by: 6 });   // ["+z:2,1>:0", "+z:2,1>:1"]
fish.faces("+z:2,1>.");
// ["+z:2,1>.s0", "+z:2,1>.s1", "+z:2,1>.s2", "+z:2,1>.s3",
//  "+z:2,1>.s3~", "+z:2,1>.s2~", "+z:2,1>.s1~", "+z:2,1>.s0~"]
```

### The surface: `k.subdiv`

`k.subdiv(cage)` reads the cage when it is called. A later change to the cage changes
no solid already built, so you can build, change and build again.

- **The surface lies inside the cage.** It passes near the cage's points but not through
  them, and rounds every corner. A cube with one face per side becomes a ball about 84%
  as wide. More faces near an edge pull the surface toward it: with two faces per side,
  the middle of each side stays flat and keeps the cube's full width.
- **Preview and print lie on the same surface.** They differ only in facet size. The
  build picks the lowest subdivision level whose facets lie within the quality's
  tolerance of the surface: 0.2 mm for preview, 0.05 mm for print. The levels run from
  1 to 5, and no level past 200,000 triangles for preview or 1,500,000 triangles for
  print is chosen. When no level meets the tolerance, the body still builds with the
  finest level allowed and a build warning (below). The warning names the remedy: when
  level 5 is not fine enough (a large body with few faces), split the cage into more
  faces; when the triangle limit stops the level, use fewer, larger faces.
- **A cage has at most 2,000 faces.**
- **It shades smooth** and takes every ordinary `Solid` op afterwards. A flat to print
  on is an ordinary `cut` with a box.
- **A drag that moves the cage's points follows the pointer.** While a slider or a
  Pose-mode handle drag changes only where the cage's points are (a `rotate` angle, an
  extrude length), the viewer re-poses the last exact mesh from the moved points, with
  no build. The exact build replaces it after a 150 ms pause or on release, and the
  drag's commit is reported once, after that build. This needs a build that smooths
  exactly one cage with no creases and asks no geometry question of a solid (reading the
  cage is fine), and a `place()`, if any, that only moves the body. A `cut` is fine
  while its numbers stay the same during the drag. A cut placed from a cage value that
  moves with the pose changes the build's shape, so every move rebuilds. During the drag
  a cut face is not recut (its rim rides the skin), and shading at a sharply bent joint
  can differ slightly, until the exact build lands. This is not the approximate bend of a
  `k.implicit` drag ("Dragging a pose"): the re-posed skin lies on the smooth surface of
  the moved cage.
- **Anything else rebuilds the whole body on each move**: a piece unioned onto the body
  (eyes, nails), a fillet or chamfer on it, a creased cage, two cages in one sub-part, a
  change to the cage's faces (an extrude count, `steps`), `setParams`, an animation and
  the print tier. The rebuild is fast for a small cage: the whale below rebuilds in well
  under a second at print quality. A large cage, such as the hand below, takes longer.

To keep a drag fast:

1. Place a print flat from the cage or from constants, not from the solid's
   `boundingBox()`, and keep its numbers the same at every pose.
2. Bend and reshape with moves of points (`rotate`, `move`, `scale`) that the slider
   drives. A parameter that changes the number of faces (an extrude count, `steps`)
   rebuilds on each move.
3. Keep the body one cage with no pieces unioned onto it. Make eyes, nails or other
   added pieces their own sub-part: each sub-part is checked alone, so the body still
   follows the pointer (the added piece rebuilds when the drag changes it). Or accept a
   rebuild on each move.

```js
const smoothBox = (segs) => k.subdiv(k.cage({ box: { size: [20, 20, 20], segs } })).boundingBox();
Math.round(10 * (smoothBox([1, 1, 1]).max[0] - smoothBox([1, 1, 1]).min[0])) / 10;   // 16.8
smoothBox([2, 2, 2]).max[0];   // 10
```

### Validity

- **A body that passes through itself** (an extrude pushed back through the body, two
  limbs crossing) is an error at print quality and a build warning at preview. Both
  name the cage faces that cross, so you can find them. A face whose own surface
  crosses is named once, as `-y:1,0 folds through itself`.
- **A drag never draws a pose that passes through itself.** A handle stops at the last
  valid pose. A panel slider's thumb can move past it, but the body holds, and the value
  returns to the last valid one. The drag's check is coarser than the build's, so the
  exact build after the drag is the final word: if it refuses the pose, the params the
  drag changed go back to where the drag began.
- **A body with no volume throws** at both qualities, and so does one turned inside out.
  When it also passes through itself, the error names the crossing instead.
- **Two faces lying exactly flat on each other are not detected.** Keep separate parts
  of the cage apart.

### Recipes

- **A round body** starts from few faces. A box side with one face across it rounds
  fully; a side with two or more stays flat in the middle. So give `segs` only the faces
  the limbs need (three toes on one end are `segs: [3, 1, 1]`, four fingers
  `segs: [4, 1, 2]`), and keep one face across the thin directions. Then taper the ends:
  `scale` an end's faces to about 0.6 for a rounded heel or nose.
- **A rounder cross-section** on a side that needs several faces: `scale` the side's
  faces toward its middle row before extruding.
- **A limb** is 2 to 4 chained extrudes from one face, each with its own `by` and
  `scale`. Start with a short neck (`scale` about 0.8) so neighbouring limbs stay
  separate. Keep each `by` leaning along its face's normal: a `by` in the face's own
  plane builds a thin blade.
- **A turn** in a limb: `rotate` the cap, then `extrude` by a distance. The extrude
  follows the turned cap. (To turn a square corner, extrude a side face, `<cap>.s<k>`.)
- **A bend a slider drives** is a few short rings, each swung about the centre of the
  face it grew from:

  ```js
  const ringStep = (c, face, by, deg, axis) => {
    const hinge = c.centroid(face);
    const cap = c.extrude(face, { by });
    c.rotate(cap, { axis, deg, about: hinge });
    return cap;
  };
  ```

  Keep each ring to 30° or less and at least a quarter of the limb's thickness long, or
  the inside of the bend folds through itself (a `subdiv:` error). An 80° knuckle is
  three rings.
- **A knuckle or bulge** is a short extrude with `scale` above 1, followed by one with
  `scale` below 1.
- **A tip** is a last short extrude with `scale` about 0.6.
- **A flat for printing** is an ordinary boolean `cut` on the result.

### Drag handles on a cage

A handle's `point` is computed in `derive`, which has no kernel. Import `cage` from
`partforge/organic` there: it is the builder `k.cage` calls, with the same options. Write
the cage once as a function of the builder, call it with `k.cage` in `build` and with
`cage` in `derive`, and read a face centre for the handle:

```js
const eel = (make, p) => {
  const c = make({ box: { size: [40, 20, 20] } });
  c.extrude("+x:0,0", { by: p.tail, scale: 0.5, id: "tail" });
  return c;
};
eel(cage, { tail: 12 }).centroid("tail");   // [32, 0, 0]
```

In the part: `derive: (p) => ({ tail: eel(cage, p).centroid("tail") })`,
`build: (k, p) => k.subdiv(eel(k.cage, p))`, and a handle
`{ point: (p, d) => d.tail, params: ["tail"], drag: "axis", direction: [1, 0, 0] }`.
The smooth surface lies inside the cage, so the handle sits just off the skin. Every
handle on a cage, this one and the limb-driven ones below, follows the pointer as a
slider does (see "The surface: `k.subdiv`"), and stops at the last pose in which the body
does not pass through itself.

**A limb that bends, driven by a `limb`.** For a finger, a leg or a tail that bends at
joints, let a `limb` from `partforge/kinematics` decide the angles, and give the cage
those angles. Declare the limb, pose it in `derive`, pass `posed.values` to the knuckle
`rotate` calls in the cage, and give the limb one `angles` handle (one per chain, not a
handle per joint). `posed.values` is an array of joint angles in degrees, in the limb's
joint order, with `follow` joints included. The handle then sits on the limb's tip, and
two rules put the tip on the cage:

- **The knuckle's rings are centred on the limb's joint.** A knuckle is three rings,
  each turned a third of the joint's angle about the centre of the face it grew from
  (the "bend a slider drives" recipe). The turns are at the start of each ring, so the
  joint is at the start of the middle ring: one ring past the face the knuckle grows
  from.
- **The cage's segment lengths equal the limb's `lengths`.** From the start of one
  knuckle to the start of the next is the segment's length: three rings, then an
  extrude of the length less three rings. That extrude stops one ring short of the
  limb's tip, so end the last segment with a short tip extrude about one ring long
  (6 mm below, 5 mm on the hand).

```js
const fingerCage = (make, bends) => {
  const c = make({ box: { size: [20, 20, 20] } });
  let cur = c.extrude("+z:0,0", { by: 4, scale: 0.85, id: "neck" });
  [30, 25].forEach((length, i) => {
    // A knuckle: three 6 mm rings, each a third of the joint's angle.
    for (const ring of ["a", "b", "c"]) {
      const hinge = c.centroid(cur);
      cur = c.extrude(cur, { by: 6, id: `k${i}${ring}` });
      c.rotate(cur, { axis: "x", deg: bends[i] / 3, about: hinge });
    }
    cur = c.extrude(cur, { by: length - 18, id: `p${i}` });
  });
  c.extrude(cur, { by: 6, scale: 0.6, id: "tip" });
  return c;
};
const finger = limb("finger", {
  at: [0, 0, 20],   // the neck ends at z = 14, and the joint is one 6 mm ring past it
  toward: [0, 0, 1], bendToward: [0, -1, 0],
  joints: [{ name: "base", range: [-10, 90] }, { name: "middle", range: [0, 90] }],
  lengths: [30, 25],
});
const fingerPose = finger.pose({ bend: { base: 20, middle: 40 } });
fingerPose.report.tip;   // [0, -31.911, 60.691]
fingerCage(cage, fingerPose.values).centroid("tip").map(Math.round);   // [0, -32, 61]
```

The limb bends about `toward × bendToward`, here +X, and a positive `rotate` about
`"x"` turns +Z toward -Y, so the cage bends the same way. Straight, the two tips are the
same point. Bent, the cage's tip is within a few millimetres of the limb's, because the
cage spreads each bend over three rings. In the part, with `knuckle` and `curl` params:
`derive: (p) => ({ finger: finger.pose({ bend: { base: p.knuckle, middle: p.curl } }) })`,
`build: (k, p, d) => k.subdiv(fingerCage(k.cage, d.finger.values))`, and a handle
`{ on: "finger", drag: "angles", params: ["knuckle", "curl"] }`. Drag the fingertip and
the drag solves `knuckle` and `curl`. It stops at each joint's `range`. Keep the ranges
inside the poses that build: a cage may not pass through itself, so stop a joint before
the limb reaches the body or another limb.

On a mirrored cage, give a side feature a second handle at the reflected point with the
same `params` (for `mirror: "xz"`, `point: (p, d) => [d.fin[0], -d.fin[1], d.fin[2]]`).
Either one can then be grabbed, and both sides follow, because both write the same
parameters.

A click on a cage body opens the controls for that area, not for the whole body. Each
`extrude`, `move`, `scale` and `rotate` records the parameters read since the cage call before it
against the faces it made or reshaped, and a face made by an `extrude` also keeps those of
the face it grew from. So read a feature's parameters in the call that shapes it
(`c.extrude(face, { by: p.finHeight })`) and a click on the fin offers the fin's settings.
A parameter that a handle drags is in that list too.

### Cage errors

Every cage method throws a `cage: ` error that names the problem, and leaves the cage as
it was. These are the common ones:

```text
cage: face "+x:0,0" was extruded; it is now +x:0,0>
cage: no face "+y:9,0"; nearest: +y:1,0, +y:2,0, +y:3,0, +y:1,0~, +y:2,0~, +y:3,0~, +y:0,0>, +y:0,0>.s0
cage: face "+z:1,1~" is a reflected face; change "+z:1,1" and the mirror follows
cage: mirror "xz" needs an even box.segs count across the plane, not 1
cage: region [+y:1,0, +y:3,0] is not edge-connected
cage: region [+z:0,0, +z:1,0, +z:2,0, +z:0,1, +z:2,1, +z:0,2, +z:1,2, +z:2,2] has a hole; extrude it in pieces
cage: id "+y:0,0>" is already in use (by "+y:0,0>")
cage: box.segs make 5400 faces, more than MAX_CAGE_FACES (2000)
cage: rotate axis must be "x", "y", "z" or a non-zero [x, y, z], not "up"
```

`k.subdiv` throws or warns with `subdiv: ` messages:

```text
subdiv: the body passes through itself between -x:0,0 and +x:0,0>.s3; -x:0,0 and +x:0,0>.s0; -x:0,0 and +x:0,0>.s2; -x:0,0 and +x:0,0>.s1
subdiv: the body has no volume
subdiv: expected a cage from k.cage(...)
```

and, when the tolerance cannot be met, it warns
`subdiv: the surface is within <n> mm of smooth, not the <tolerance> mm this quality asks for — split the cage into more faces (more segs, or more steps on an extrude)`
when level 5 is not fine enough, or
`subdiv: the surface is within <n> mm of smooth, not the <tolerance> mm this quality asks for — use fewer, larger cage faces`
when the triangle limit stops the level.

### Worked example: a whale

`src/parts/organic-whale.js` builds a whale from one cage, mirrored through Y = 0. The
nose points to -X and the back to +Z. Every cage position is a function of the params:
`length` scales every size, and `tailLift` (in mm, not scaled) raises only the last two
tail rings, so the body ahead of the tail keeps its shape.

```js
const CAGE_LENGTH = 124;

function whaleCage(k, p) {
  const s = p.length / CAGE_LENGTH;
  const v = (x, y, z) => [x * s, y * s, z * s];
  const c = k.cage({ box: { size: v(60, 30, 26), center: [0, 0, 0], segs: [4, 2, 2] }, mirror: "xz" });
  const positive = (prefix) => c.faces(prefix).filter((id) => !id.endsWith("~"));
  // Round the cross-section: pull each side's outer rows in toward its middle row.
  c.scale(positive("+y:"), [1, 1, 0.75]);
  c.scale(positive("+z:"), [1, 0.75, 1]);
  c.scale(positive("-z:"), [1, 0.75, 1]);
  // Head: two short extrudes forward, each narrower.
  const head = c.extrude(["-x:1,0", "-x:1,1"], { by: 8 * s, scale: [1, 0.8, 0.85], id: "head" });
  c.extrude(head, { by: 5 * s, scale: [1, 0.7, 0.7], id: "nose" });
  // Tail stock: three extrudes back, each narrower. tailLift raises only the last two, so
  // the body ahead of the tail keeps its shape.
  const t1 = c.extrude(["+x:1,0", "+x:1,1"], { by: v(18, 0, 1), scale: [1, 0.6, 0.6], id: "tail1" });
  const t2 = c.extrude(t1, { by: [16 * s, 0, p.tailLift / 2], scale: [1, 0.6, 0.6], id: "tail2" });
  c.extrude(t2, { by: [8 * s, 0, p.tailLift / 2], scale: [1, 0.8, 0.8], id: "tail3" });
  // Flukes: the last tail step's two +Y sides, pushed out and back and flattened.
  const fluke = c.extrude(["tail3.s1", "tail3.s2"], { by: v(4, 12, 0), scale: [1.2, 1, 0.3], id: "fluke" });
  c.extrude(fluke, { by: v(8, 12, 0), scale: [0.6, 1, 0.7], id: "flukeTip" });
  // Dorsal fin: the back face over the tail root, which has an edge on the mirror plane,
  // so it grows across it as one fin; swept back and thinned.
  const fin = c.extrude("+z:3,1", { by: v(2, 0, 5), scale: [0.6, 0.7, 1], id: "fin" });
  c.extrude(fin, { by: v(5, 0, 4), scale: [0.5, 0.35, 0.6], id: "finTip" });
  // Pectoral fins: a low side face near the front, swept out, back and a little down.
  const pec = c.extrude("+y:1,0", { by: v(3, 6, -2), scale: [0.7, 1, 0.35], id: "pec" });
  c.extrude(pec, { by: v(8, 12, -2), scale: [0.6, 1, 0.6], id: "pecTip" });
  return c;
}
```

The part builds `k.subdiv(whaleCage(k, p))` and cuts a flat under the belly with an
ordinary boolean (1.5 mm deep at the cage's own length, scaled with `length`).
Its cage has 132 faces. It previews at level 2 (4,224 triangles)
and prints at level 4 (67,584 triangles).

The points to copy:

- **Shape the box before extruding.** The three `scale` calls round the body's
  cross-section; extrudes made afterwards start from the rounded rings.
- **Read ids back.** `positive("+y:")` is `faces` with the `~` ids left out; the flukes
  extrude `tail3.s1` and `tail3.s2`, the two sides of the last tail ring that face +Y.
- **Let the mirror do the other half.** One pectoral fin and one fluke are written; the
  dorsal fin sits on a face that has an edge on the plane, so it grows as one fin.
- **Calibrate the length.** The surface lies inside its cage, so the whale's length is
  measured once (`CAGE_LENGTH`) and the params scale from it.

### Worked example: a hand that curls

`src/parts/cage-hand.js` builds a posable hand from one cage, no mirror: a palm with four
faces across its top (one per finger), a wrist, and a thumb from the lower face of the
+X side. The palm faces -Y, the fingers point to +Z, and the thumb leaves the +X side.
Each digit's bends come from a `limb` posed in `derive`, the pattern in "Drag handles on
a cage":

- each finger is a limb of three joints, `mcp`, `pip`, and `dip`, which follows `pip`
  at 0.75. Its params are `<f>Knuckle` (the `mcp` angle, -10° to 90°) and `<f>Curl` (the
  `pip` angle, 0° to 90°), for `f` in `index`, `middle`, `ring` and `pinky`;
- the thumb is a limb of one joint, `ip`, driven by `thumbCurl` (0° to 60°).

```js
import { limb } from "partforge/kinematics";

const RING = 6;                     // a knuckle ring's length (mm); three per knuckle
const NECK = 5;                     // each finger's neck out of the palm (mm)
const PALM = { size: [78, 28, 80], center: [0, 0, 60], segs: [4, 1, 2], topScale: 1.08 };
const PALM_TOP = PALM.center[2] + PALM.size[2] / 2;
// Per finger: the column of the palm's top face it grows from, and the cage's segment
// lengths, which are the limb's. The face's centre along X follows from its column: the
// four top faces split the palm's width, then the top row is widened by topScale about X = 0.
const FINGERS = {
  index:  { col: 3, lengths: [37, 27, 23] },
  middle: { col: 2, lengths: [41, 30, 24] },
  ring:   { col: 1, lengths: [38, 28, 23] },
  pinky:  { col: 0, lengths: [30, 23, 21] },
};
for (const f of Object.values(FINGERS)) {
  f.face = `+z:${f.col},0`;
  f.x = (-PALM.size[0] / 2 + (PALM.size[0] / PALM.segs[0]) * (f.col + 0.5)) * PALM.topScale;
}
// The thumb: a root out of the palm's lower +X face, turned 45° about Y so it points up
// and out, then a straight run to its one joint and one segment past it, curling toward
// the palm side (-Y).
const THUMB_ROOT = 8;
const THUMB_RUN = 20;               // root face to joint (mm)
const THUMB_LENGTH = 30;            // joint to tip (mm)
const THUMB_DIR = [Math.SQRT1_2, 0, Math.SQRT1_2];
// The root cap's centre: the lower +X face's centre, THUMB_ROOT out (the turn is about it).
const THUMB_ROOT_AT = [PALM.size[0] / 2 + THUMB_ROOT, 0, PALM.center[2] - PALM.size[2] / 4];
const THUMB_BEND = [0, -1, 0];
// The cage turns a bend about toward × bendToward, as a limb bends.
const THUMB_AXIS = [
  THUMB_DIR[1] * THUMB_BEND[2] - THUMB_DIR[2] * THUMB_BEND[1],
  THUMB_DIR[2] * THUMB_BEND[0] - THUMB_DIR[0] * THUMB_BEND[2],
  THUMB_DIR[0] * THUMB_BEND[1] - THUMB_DIR[1] * THUMB_BEND[0],
];

// The curl stops at 90°: with every knuckle at 90° and a curl past about 92° the pinky's
// tip, the shortest finger, presses into the palm's front, and a cage may not pass through
// itself. Every pose within these ranges builds, all of them at their max at once included.
const RANGE = { knuckle: [-10, 90], curl: [0, 90], thumbCurl: [0, 60] };
const DIGITS = [...Object.keys(FINGERS), "thumb"];

/** Every digit posed: the four fingers on the palm's top, the thumb on its side. */
function poseDigits(p) {
  const out = {};
  for (const [name, f] of Object.entries(FINGERS)) {
    out[name] = limb(name, {
      // The first knuckle's rings start at the neck's end, so its middle ring (the joint)
      // starts one ring further out.
      at: [f.x, 0, PALM_TOP + NECK + RING],
      toward: [0, 0, 1],
      bendToward: [0, -1, 0],
      joints: [
        { name: "mcp", range: RANGE.knuckle },
        { name: "pip", range: RANGE.curl },
        { name: "dip", range: [0, RANGE.curl[1] * 0.75], follow: { joint: "pip", ratio: 0.75 } },
      ],
      lengths: f.lengths,
    }).pose({ bend: { mcp: p[`${name}Knuckle`], pip: p[`${name}Curl`] } });
  }
  out.thumb = limb("thumb", {
    at: THUMB_ROOT_AT.map((v, i) => v + THUMB_RUN * THUMB_DIR[i]),
    toward: THUMB_DIR,
    bendToward: THUMB_BEND,
    joints: [{ name: "ip", range: RANGE.thumbCurl }],
    lengths: [THUMB_LENGTH],
  }).pose({ bend: { ip: p.thumbCurl } });
  return out;
}

/**
 * The hand's cage. `make` is k.cage (or partforge/organic's cage); `bends` maps each digit
 * to its posed limb's `values`: the joint angles in degrees, in the limb's joint order
 * (a finger's [mcp, pip, dip], the thumb's [ip]).
 */
function cageHand(make, p, bends) {
  const c = make({ box: { size: PALM.size, center: PALM.center, segs: PALM.segs } });
  c.scale(c.faces("+z:"), [PALM.topScale, 1, 1]);
  const w = c.extrude(c.faces("-z:"), { by: 14, scale: [0.62, 0.85, 1], id: "wrist" });
  c.extrude(w, { by: 22, id: "arm" });
  // One ring of a bend: extrude, then swing the new cap about the centre of the face it
  // grew from. The next extrude follows the turned cap.
  const ring = (cur, deg, axis, opts) => {
    const hinge = c.centroid(cur);
    const cap = c.extrude(cur, { by: RING, ...opts });
    if (deg) c.rotate(cap, { axis, deg, about: hinge });
    return cap;
  };
  // A knuckle: three rings centred on the joint, each a third of its angle. Past the first
  // knuckle (which sits in the palm) the first ring widens and the last narrows, which
  // draws the joint.
  const knuckle = (cur, tag, deg, axis, wide) => {
    cur = ring(cur, deg / 3, axis, { id: `${tag}a`, scale: wide ? 1.12 : 1 });
    cur = ring(cur, deg / 3, axis, { id: `${tag}b` });
    return ring(cur, deg / 3, axis, { id: `${tag}c`, scale: wide ? 0.9 : 1 });
  };
  for (const [name, f] of Object.entries(FINGERS)) {
    const angles = bends[name];   // [mcp, pip, dip]
    let cur = c.extrude(f.face, { by: NECK, scale: [0.82, 0.85, 1], id: `${name}Neck` });
    f.lengths.forEach((L, i) => {
      cur = knuckle(cur, `${name}K${i}`, angles[i], "x", i > 0);
      // From the knuckle's last ring to the next knuckle's first: L less a whole knuckle.
      cur = c.extrude(cur, { by: L - 3 * RING, scale: 0.94, id: `${name}P${i}` });
    });
    c.extrude(cur, { by: 5, scale: 0.6, id: `${name}Tip` });
  }
  let t = c.extrude("+x:0,0", { by: THUMB_ROOT, scale: [1, 0.85, 0.6], id: "thumbRoot" });
  c.rotate(t, { axis: "y", deg: -45 });
  t = c.extrude(t, { by: THUMB_RUN - RING, scale: 0.9, id: "thumb1" });
  t = knuckle(t, "thumbK", bends.thumb[0], THUMB_AXIS, true);
  t = c.extrude(t, { by: THUMB_LENGTH - 3 * RING, scale: 0.92, id: "thumb2" });
  c.extrude(t, { by: 5, scale: 0.6, id: "thumbTip" });
  return c;
}

const bendsOf = (d) => Object.fromEntries(DIGITS.map((n) => [n, d[n].values]));

const handParams = {
  indexKnuckle: 15, indexCurl: 20, middleKnuckle: 15, middleCurl: 20,
  ringKnuckle: 15, ringCurl: 20, pinkyKnuckle: 15, pinkyCurl: 20, thumbCurl: 10,
};
const handDigits = poseDigits(handParams);
handDigits.index.values;   // [15, 20, 15]
const hand = cageHand(cage, handParams, bendsOf(handDigits));
hand.faces().length;   // 300
handDigits.index.report.tip;   // [31.59, -42.682, 183.64]
hand.centroid("indexTip").map(Math.round);   // [32, -42, 183]
```

`handParams` is the part's defaults. In the part:

- `derive: (p) => poseDigits(p)` poses every digit.
- `build: (k, p, d) => k.subdiv(cageHand(k.cage, p, bendsOf(d)))`, then an ordinary
  `cut` with a box under the wrist for a flat to stand on. The box's top is the cage's
  lowest point (`cage.bounds().min[2]`, the arm's end) plus 2.4 mm. The smooth body lies
  inside the cage, so that removes a slab about 1.5 mm thick at every pose.
- `handles` has one `angles` handle per digit: `{ on: "index", drag: "angles", params:
  ["indexKnuckle", "indexCurl"] }` for each finger, and `{ on: "thumb", drag: "angles",
  params: ["thumbCurl"] }`. Drag a fingertip and the drag solves that finger's knuckle
  and curl. The `dip` joint is not a param: it follows `pip`.

The points to copy:

- **Place a print flat from the cage or from constants, not from the solid's
  `boundingBox()`** (rule 1 of "To keep a drag fast", under "The surface: `k.subdiv`").
  The viewer re-poses the body during a drag only when it can trust the build without
  running it. A build that measures its own solid cannot be trusted that way, so each move
  of a drag would rebuild the whole hand: about 460 ms a move at the preview tier, in Node
  on an Apple M1 Max. Reading the cage (`cage.bounds()`) is fine, and the hand's flat
  keeps its numbers at every pose because the arm's end never moves.
- **One top face per finger.** `segs: [4, 1, 2]` gives the palm four faces across X on
  its top and one face through its thickness, so its edge is round. Each finger starts
  with a short narrower neck, which keeps the fingers separate.
- **A knuckle is three short rings that share the bend.** Each ring swings about the
  centre of the face it grew from (`ring`), a third of the joint's angle each, so the
  inside of the bend does not fold. The rings are 6 mm long on fingers about 24 mm
  thick, a quarter of the thickness. On the knuckles past the first (which sits in the
  palm) the first ring widens and the last narrows, which draws the joint.
- **The thumb turns before it grows.** Its root is a short extrude out of the side,
  turned 45° about Y. The extrudes after it follow that direction, and so does its
  limb: `toward` is the turned direction, and the knuckle turns about `toward ×
  bendToward` (`THUMB_AXIS`), the axis the limb bends about.
- **The limb and the cage agree.** Each finger's limb starts one ring past the neck,
  so the three rings of its first knuckle are centred on `mcp`, and its `lengths` are
  the cage's segment lengths. At the defaults each digit's limb tip is within 1 mm of
  its cage tip, so the handle sits on the fingertip.
- **A pose moves the cage's points, never its faces.** Every pose has the same 300
  faces and the same ids. Only the `rotate` angles change.
- **It builds clean across every slider's range**, every param at its max at once
  included. The curl stops at 90°: with every knuckle at 90°, past about 92° the
  pinky's tip, the shortest, presses into the palm's front, and a cage may not pass
  through itself. Stop each joint's range before contact. For fingers that must press
  into the palm, use an implicit tree.
