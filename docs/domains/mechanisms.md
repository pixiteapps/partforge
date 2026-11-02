# Mechanisms: parts that move together

Use this domain for any part with members whose motion is coupled: a gear train, pulleys
on a belt, a rack and pinion, a crank and slider. You give the mechanism one driving
value (an angle). The helper calculates where every member is, places each member's
solid, and gives handles the points to grab. The domain is plain maths. It builds no
geometry (no tooth profile, no belt), so you call it in `derive`.

```js
import { gearTrain, beltDrive, rack, crankSlider } from "partforge/mechanisms";
```

Import it from `partforge/mechanisms`, never from `partforge/geometry` or `partforge`.
It is worker-safe, like `partforge/geometry`.

The worked example is **`src/parts/gearbox.js`**: three gears on a plate, a rotary
handle on every gear and a crank on the input. It is at the end of this guide.
`src/parts/drawer-box.js` is its companion for handles without a helper: a plane
handle that changes the cabinet's size and an axis handle per drawer.

## Why use it

When you couple members by hand, these are the usual faults:

- a gear turns the wrong way, or at the wrong ratio, after a mesh is added;
- a ring gear is given the sign of an external mesh;
- a gear is turned about the origin, not about its own centre, so it wanders;
- a handle on the second gear moves a parameter that only the first gear reads, so the
  drag does nothing.

The helpers remove these faults. The ratios and signs come from the tooth counts and
diameters, and each member is placed by one call.

## The pattern: couple in derive, grab any member

1. **One driving parameter.** For a rotating input, declare it with `wrap: true` and a
   range of 0..360, so it turns without end:

   ```js
   { key: "driveAngle", label: "Input angle", unit: "°", min: 0, max: 360, step: 0.1, wrap: true }
   ```

2. **Couple in `derive`.** Call the helper with the driving parameter. Return the result
   under a key; it is a **point source** (it has `handleInfo()`).

   ```js
   derive: (p) => ({ train: gearTrain({ gears: GEARS, drive: { gear: "input", angle: p.driveAngle } }) }),
   ```

3. **Place each member.** Build each member once, in its own frame, and place it in its
   view with the helper's `place(name, solid)`. Placing is a rotate and a translate, so
   a change to the driving parameter re-places the member by matrix and never rebuilds
   it, in a drag or in an animation.

   ```js
   gear2: { build: (k) => gear(k, 30), views: { main: (s, p, d) => d.train.place("gear2", s) } },
   ```

4. **Grab any member.** Put a handle on any of the helper's points, with the driving
   parameter in `params`. The drag solves the shared parameter, so every member moves.
   A rotary handle at `"<member>.<point>"` turns about the helper's axis for that member,
   so it needs no `axis` of its own.

   ```js
   handles: {
     output: { on: "train", at: "gear3.rim", params: ["driveAngle"], drag: "rotary", showOn: "gear3" },
   },
   ```

   Turn gear 3 by 90° and the solver writes `driveAngle` + 180 (the train's ratio from
   gear 1 to gear 3 is 20/40). The viewer has no gear-specific code: the coupling is all
   in `derive`. See `docs/AUTHORING-PARTS.md` for the handle declaration.

A member name must have no `.`, because a point is named `"<member>.<point>"`.

## The frame `place` uses

A rotating member (a gear, a pulley, a pinion) is built **about +Z through the origin**,
with its 0° direction along +X. `place` turns it by the member's angle about +Z, then sets
it on its axis (the smallest turn that takes +Z onto `axis`; for the default `[0, 0, 1]`,
no turn at all), then moves it to its `center`. A positive angle is counter-clockwise
about `axis`.

The `rim` point of a member is on its pitch circle along the member's +X, turned by its
angle: the point a handle grabs and the solid's 0° mark move together.

## `gearTrain({ gears, drive })`

```js
const train = gearTrain({
  gears: [
    { name: "gear1", teeth: 20, module: 2, center: [0, 0, 11] },
    { name: "gear2", teeth: 30, module: 2, center: [50, 0, 11], meshesWith: "gear1" },
    { name: "gear3", teeth: 40, module: 2, center: [107.3, 40.2, 11], meshesWith: ["gear2"] },
  ],
  drive: { gear: "gear1", angle: p.driveAngle },
});
train.angleOf("gear3"); // driveAngle * 20 / 40
```

- `gears`: `{ name, teeth, module, center, axis = [0, 0, 1], meshesWith?, internal? }`.
  `meshesWith` is one gear name or a list. The pitch radius is `module * teeth / 2`.
- `drive`: `{ gear, angle }`, in degrees. The angle is not reduced: 720 is two turns.
- Across a mesh the angle scales by **`-teethA / teethB`**: meshing gears turn opposite
  ways. When either gear is `internal: true` (a ring gear), the ratio is
  **`+teethA / teethB`**: a ring turns the same way as its pinion.
- Returns `{ angleOf(name), handleInfo(), place(name, solid) }`.
- Points: `<gear>.center` and `<gear>.rim`. Axes: one per gear, `{ origin: center,
  direction: axis }`. Lines: one per mesh, centre to centre.
- It throws on a `meshesWith` that names no gear, a gear not connected to the drive, and
  a loop of meshes whose ratios disagree (a locked train).

It does not check that meshing gears share a module or sit at the right distance, and it
draws no teeth. Put each gear's centres at the sum of the pitch radii. For the teeth to
mesh at angle 0, give each gear a fixed tooth phase in its build (the gearbox's `PHASE`
shows the calculation); the ratios then keep them in mesh at every angle.

## `beltDrive({ pulleys, drive })`

```js
const belt = beltDrive({
  pulleys: [
    { name: "motor", diameter: 20, center: [0, 0, 0] },
    { name: "spindle", diameter: 40, center: [80, 0, 0] },
  ],
  drive: { pulley: "motor", angle: p.motorAngle },
});
belt.angleOf("spindle"); // motorAngle * 20 / 40, the same way round
```

- `pulleys`: `{ name, diameter, center, axis = [0, 0, 1] }`, pitch diameters, all on one
  belt. A pulley's angle is `angle * dDrive / d`; every pulley turns the same way.
- Points: `<pulley>.center`, `<pulley>.rim`, and `belt`, the top of the first pulley's
  pitch circle (its +Y), where the belt runs. `belt` is fixed: use it for a label or a
  guide, not a handle. Lines: neighbouring pulleys, centre to centre.
- Returns `{ angleOf, handleInfo, place }`.

## `rack({ pinion, direction, name? })`

```js
const slide = rack({
  pinion: { name: "pinion", teeth: 20, module: 1, center: [0, 0, 0], angle: p.pinionAngle },
  direction: [1, 0, 0],
});
slide.travel; // rad(pinionAngle) * 10
```

- `pinion`: `{ name, teeth, module, center, axis = [0, 0, 1], angle }`.
- `direction`: where the rack moves for a positive pinion angle, at right angles to the
  axis. The rack meshes on the side `direction × axis` of the pinion (below it, for
  `direction` +X and axis +Z).
- `travel = rad(angle) * module * teeth / 2`, mm.
- Points: `<pinion>.center`, `<pinion>.rim`, and `<rack>.pitch` (`name` defaults to
  "rack"): the mark on the rack's pitch line that met the pinion at travel 0. Axes: the
  pinion's, and the rack's line of travel.
- `place(pinionName, solid)` turns the pinion. `place("rack", solid)` slides the rack by
  `travel`: build the rack **where it sits at travel 0**.

A rack's travel grows without end as the pinion turns. Give the pinion angle a range, or
clamp it in `derive`, to keep the rack on its pinion.

## `crankSlider({ crank, rod, slideDirection })`

```js
const engine = crankSlider({
  crank: { center: [0, 0, 0], axis: [0, 0, 1], length: 20, angle: p.crankAngle },
  rod: 50,
  slideDirection: [1, 0, 0],
});
engine.slider; // [20 cos a + √(50² − 20² sin² a), 0, 0]
```

- An in-line slider-crank, from the closed form. Angle 0 points the crank along
  `slideDirection`; a positive angle turns it counter-clockwise about `axis`.
- `rod` must be at least the crank's `length`, or it throws.
- Returns `{ crankPin, slider, handleInfo, place }`.
- Points: `crank.center`, `crank.pin`, `slider`. Axis: `crank`. Lines: the crank and
  the rod.
- `place` names `"crank"`, `"rod"` and `"slider"`. Each is built in a frame with its axis
  along +Z and the slide direction along +X: the crank from its pivot at the origin, the
  rod from the crank pin at the origin toward +X, the slider centred on its pin.

A rotary handle at `crank.pin` turns the crank; an axis handle on `slider` along
`slideDirection` pushes the slider and the solver finds the crank angle (one of two: the
drag keeps the side it starts on).

A four-bar linkage is not in this release.

## Handles without a helper

A coupling you can write as a formula needs no helper. Return the point from a `point`
handle: `drawer-box.js` puts an axis handle on each drawer pull at
`[0, -depth / 2 - pull - open, z]`, and a plane handle on the cabinet's top corner at
`[width / 2, depth / 2, height]` that writes width and depth. Reach for a helper when the
coupling is a chain (gears, belts) or a closed form you would otherwise derive (a crank).

## Worked example: `src/parts/gearbox.js`

Three spur gears (20, 30 and 40 teeth, module 2) on a base plate, and a crank on the
input gear:

- One parameter, `driveAngle` (`wrap: true`, 0..360, step 0.1), in the "Motion" section.
- `derive` calls `gearTrain` with the three gears, each meshing with the one before, and
  returns it as `train`. It also returns the crank knob's point, `crankKnob`.
- Every gear and the crank is a sub-part, built once about +Z and placed with
  `d.train.place`. The crank is placed as `gear1`, so it turns with the input.
- Handles: `gear1`, `gear2` and `gear3` are rotary handles at `<gear>.rim`, each shown
  while the pointer is over its gear (`showOn`). `crank` is a rotary `point` handle at
  `crankKnob`, about the input's axis. All four write `driveAngle`.
- The `spin` animation turns the input one turn, 0 to 360, linear and looping. Like a
  drag, it never rebuilds a gear.
- `verify` pins no overlaps and the running clearances at angle 0; the test
  `test/reference-handles.test.js` also measures another angle, so the teeth stay in mesh.

The demo page is `gearbox.html` (`npm run dev`, then open `/gearbox.html`).

## Errors

Every helper throws a `SpecError` whose message starts with the helper's name and the
field: `gearTrain: gear3.meshesWith: unknown gear "gear4"`. A throw in `derive` fails the
build, and lint reports it at the defaults. A handle whose point throws in a drag scores
that frame as failed and the drag holds the last good values.
