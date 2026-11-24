# Cage skinning: a cage that follows limbs

Date: 2026-11-23. Status: design, awaiting approval.

## Why

A subdivision cage is posed today by `rotate` calls on face sets. For one bend that is
fine. For a hand it is not: the cage hand needs about 80 lines of nested rotations, in a
fixed order, on sets chosen so the right points end at the right angles. Every fold and
crease found in the hand came from that code. It is also the part a model writes worst,
because it has to reason about which points several face sets share.

Real subdivision hands do not work this way. They give every control point a weight per
bone and let the bones move the points. This design adds that to the cage, with the
weights worked out for the author.

## Goals

- One call poses a cage from posed limbs. The author writes no weights in the usual case.
- An author can set weights explicitly where the automatic ones are wrong.
- A model can write it correctly from the guide: it names limbs and faces, never points.
- A pose still moves the cage's points and never its faces, so the fast drag, the stop at
  the last valid pose and the public-page preview keep working with no change.

## Not goals

- Corrective shapes, volume preservation, muscle bulge. A bend keeps its thickness (see
  "How a point moves"), and that is all.
- A weight-painting screen.
- Mirrored cages. `skin` on a cage with `mirror` is an error in this version.
- Skinning `k.implicit` bodies. They have `flesh()` already.

## Never

- A point index in the API. A model cannot see one.
- Weights that depend on the pose. They are fixed by the cage and the limbs at rest.
- A silent fallback. A limb that reaches no point is an error, not a no-op.

## The API

```js
const c = k.cage({ box: { … } });
// … build the whole cage straight, at rest …
c.skin([d.index, d.middle, d.ring, d.pinky, d.thumb]);
return k.subdiv(c);
```

`cage.skin(limbs, options?)`

- `limbs`: one posed limb or an array of them (`limb(…).pose(…)`, usually from `derive`).
  Each must be defined with `r`, the limb option that already holds its radii.
- The cage must be built in the limbs' rest pose: the pose a limb takes with no bends
  asked, `limb.pose({})`. That is every joint at 0, except a joint whose range leaves 0
  out, which rests at the nearest value it allows. So a limb can have a fixed tilt: a
  joint with a range such as `[23, 23]` is a bend the limb always has, and the cage is
  built with it.
- `skin` is the last change to a cage. After it, `extrude`, `move`, `scale`, `rotate`,
  `crease` and a second `skin` throw. Reads (`centroid`, `normal`, `faces`, `bounds`,
  `snapshot`) return posed values.
- A limb with a `parent` is an error in this version.
- It returns a report (see "The report").

Options, all optional:

| Option | Meaning |
|---|---|
| `blend` | How long a joint's bend is spread along the limb, in mm. A number for every joint, or `{ "index.mcp": 16 }` by joint name; a joint left out takes the default. Default: the limb's radius at that joint. |
| `set` | Explicit weights: a list of `{ faces, follow?, turn? }`. See "Explicit weights". |

That is the whole surface: one method, two options.

### Which points follow a limb

A limb at rest is a line: its joints' positions in order, then its tip. A point follows a
limb when both are true:

1. It is close. Within the limb's radius there, the point follows fully. Between 1 and
   1.5 radii the pull fades to nothing.
2. It can see the limb. The straight line from the point to the nearest spot on the
   limb's line does not cross a face of the cage. This is what keeps a finger's points
   from following the finger next to it: the two are close, but a gap is between them.

A point that two limbs pull lands between where each would put it, by how hard each
pulls. A point that no limb pulls fully keeps the rest of its weight on the body, which
does not move. So the skin between two fingers shares them, and the palm stays still.

### How a point moves

Along a limb, a point takes a share of each joint's angle. The share is 0 before the
joint and 1 after it, rising smoothly across `blend` mm centred on the joint, measured
along the limb. The point then turns about each joint, last joint first, by its share of
that joint's angle.

Turning by a share of the angle, and not mixing positions, is what keeps a knuckle's
thickness at 90°. Mixing positions is the usual method and it pinches there. A ball or
spread joint is the same: its turn is scaled about its own axis. A follower joint turns by
its posed value. A pose's own `spread` and `twist`, which belong to no joint, go with the
first joint's share.

### Explicit weights

```js
c.skin(limbs, {
  set: [
    { faces: c.faces("thenarWeb"), follow: { thumb: 0.5 } },          // half with the thumb, half with the body
    { faces: ["knucklec:1"], follow: { index: 0.5, middle: 0.5 } },   // shared evenly
    { faces: c.faces("indexP0"), turn: { "index.mcp": 1 } },          // these points take the whole knuckle angle
  ],
});
```

- `faces`: the faces whose points the entry sets.
- `follow`: for those points, which limbs pull and how hard (0 to 1), by limb name. It
  replaces the automatic answer of "which points follow a limb". What the limbs leave
  under 1 stays with the body. A sum over 1 is an error.
- `turn`: for those points, the share of a joint's angle, by joint name. It replaces the
  automatic share for that joint only.
- A point in two entries takes the later one, key by key.

An entry names faces, so a model writes it with the ids it already has.

### The report

`skin` returns what it decided, so a model can check its work without a render:

```js
{
  limbs: { index: { points: 62, full: 48 }, … },   // points pulled, and pulled fully
  shared: 29,                                      // points pulled by more than one limb
  still: 104,                                      // points no limb pulls
  faces: { "indexP0:0": { follow: { index: 1 } }, "knucklec:1": { follow: { index: 0.5, middle: 0.5 } }, … },
}
```

`faces` gives the mean pull over each face's points, and leaves out faces that are
wholly still. The report is plain data, so a probe can return it through `measure`.

### Errors

Each names the limb, joint or face, and says what to change:

- `skin: limb "pinky" has no r — give the limb its radii`
- `skin: limb "pinky" pulls no point of the cage: its rest line is 31 mm from the nearest point. Check its at and toward, or its r`
- `skin: set[1].follow names "indx", which is not one of these limbs: index, middle, …`
- `skin: set[0].follow adds up to 1.3 for face "thenarWeb.s2" — at most 1`
- `cage: extrude after skin — skin is the last change to a cage`
- `skin: a mirrored cage cannot be skinned yet`
- `skin: limb "hand.index" has a parent — skin takes limbs in part coordinates for now`
- `skin: set[2].turn names "index.mcp" for face "wrist:0", whose points no limb pulls`

Self-intersection is found as today, by `k.subdiv`, and names faces.

## How it fits what exists

- **Limbs.** A posed limb works from its rest frames and posed frames already (`place(…, {
  from: "rest" })` uses them), but keeps them private, and `world()` rounds to 0.001. So
  a posed limb gains one plain-data field holding its name, its radii, and each joint's
  unrounded rest and posed frames. It is for `skin` to read and the guide does not teach
  it. It must be plain data: the cage and the limb can come from two copies of the
  module.
- **Fast drag and previews.** They re-run the part's cage code to get the new points, and
  need the faces to stay the same. `skin` moves points only. No change there.
- **Cost.** The weights depend only on the rest cage and the limbs at rest, so they are
  worked out once and kept by content. A pose then costs a few turns per point: well
  under a millisecond for the hand. Working the weights out is about 5 ms for the hand
  (318 points, 5 limbs).
- **`rotate` stays.** It is still the way to shape a cage and to bend one limb by hand.

## What a throwaway test showed

A script ran these rules on the cage hand's fingers (not kept):

- The automatic weights gave the same shape as the 80 hand-written lines, with no posing
  code in the part. Limb tips and cage tips agree as before.
- The visibility rule is needed. Without it, each finger's inner points are as close to
  the next finger's line as to their own.
- **Weights do not replace faces.** On today's hand every point across the top of the
  palm is shared by two fingers, so one finger down still drags its neighbours, with
  automatic weights or hand-written ones. The cage needs a narrow strip of faces between
  two limbs that move apart. With strips, each knuckle moved more on its own. The guide
  must say this.
- Not settled: whether the palm-side crease then looks right. That is hand modelling, to
  be judged against photographs in the build.

## What gets built

1. `cage.skin` in the cage builder: weights, posing, `set`, the report, the errors, the
   lock after skin.
2. The guide: a section "Posing a cage with limbs", the rule about strips, and the
   errors. The compact prompt's organic rule points at it.
3. The cage hand rebuilt on it: strips between the fingers, knuckles inside the palm, the
   thumb's opposition and abduction as joints of its limb at the wrist, no nested
   rotations. Checked against photographs, the OK sign and the 1.5 inch bar grip.
4. The uncommitted in-palm knuckle code in the worktree is dropped: step 3 replaces it.

## Left to the builder

- The fade curve between 1 and 1.5 radii, and the smooth step for the share.
- How the weights are kept (by a hash of the rest points and the limbs' rest frames).
- Whether the report rounds its numbers.
- The name of the posed limb's plain-data field.
- Past the tip, the radius is held at the tip's. A point two limbs both pull fully is shared in proportion.
- The hand's flat under the wrist is placed from the cage's lowest point, so the thumb's limb must not pull the arm's end.
- The exact wording of errors, in the style of the cage's existing ones.

## Open questions

None that block the build. Two things to measure during it: the default `blend`, and
whether the visibility test needs a small tolerance at points that sit on the limb's
line.
