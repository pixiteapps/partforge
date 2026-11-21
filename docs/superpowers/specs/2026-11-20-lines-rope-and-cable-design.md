# Lines: capstan rope and cable routing on one core

Date: 2026-11-20. Status: design; phase 1 approved, decisions 1-3 made.
Repos: `partforge` (the core, the helpers, the checks), `partforge-cloud` (prompt
corpus regenerated after publish; evals).

## Why

Two things a robot joint needs cannot be said in a part today.

- **A capstan rope.** `beltDrive` (`domains/mechanisms/belt.js`) couples pulleys by
  diameter ratio and nothing else: it has no path, so it cannot say how long the rope
  is, how many turns sit on a drum, whether the drum is wide enough, or whether the
  rope goes slack somewhere in the joint's travel. Those are the questions a capstan
  test joint is built to answer.
- **A cable across a joint.** A cable is neither a sub-part (it is not printed, and it
  changes shape with pose) nor a handle. A part can model one as a `k.sweep` tube that
  reads the joint angle, but then every sweep of that joint is a REBUILD sweep
  (`SWEEP_REBUILD_STEPS`, 24 steps, checked at the steps only) and its animation
  rebuilds every frame. Nothing reports bend radius, twist or slack.

Both are the same object: a flexible line routed through frames that move. They differ
in one thing, whether the line is taut. This spec builds one core and two modes on it.

## Goals

- A part can declare a rope or cable in `derive`, the same way it declares a `limb` or
  a `gearTrain`, and get a plain-data report for it.
- A capstan joint cannot reach `verify.ok: true` with a rope that goes slack or
  over-tight along the joint's swept travel, once the part gates on it.
- Posing a joint moves its lines at frame rate. No sub-part rebuilds because a line
  changed shape.
- A cable's bend radius, twist and clearance are read over the whole joint travel, not
  at one pose.
- The agent has one line of brief vocabulary (`// Lines:`) and one guide per mode.

## Non-goals

- No dynamics: no vibration, slip transients, creep or wear. Everything is
  quasi-static geometry plus closed-form statics (capstan equation, axial stiffness).
- No electrical model: no schematic, pinout, wire list import or voltage drop. A
  cable here is a round body with a diameter and bend limits.
- No harness manufacturing output (formboard, flattened harness). A cut list is in
  scope; drawings are not.
- No automatic routing. The author names the waypoints; the solver shapes the line
  between them.
- Belts keep `beltDrive` for now. The taut solver already closes a loop (`closed:
  true`), so a belt's path, length and wraps are a follow-on: `beltDrive` gains
  `lineInfo()` and a report with the path length against the nearest stock belt (a
  whole number of teeth).
- Elastic lines (a rubber band, a spring return) are a follow-on on the same path:
  an `elastic: { restLength, k }` property, tension at each pose, and the force on
  each element. The drift gate then reads as a stretch range. Not in these phases.

## What exists and what it constrains

Read from the code at 0.197.0.

| Fact | Where | Consequence |
| --- | --- | --- |
| A mechanisms helper is a pure derive-time object with `handleInfo()` (`kind: "partforge.points"`) and `place(name, solid)` | `domains/mechanisms/belt.js`, `frame.js` | `capstan()` follows the same shape and adds `lineInfo()` |
| Point sources are recognised by plain data only, never `instanceof` | `pose/handle-source.js`; AGENTS.md (the cloud worker holds two copies of the code) | Lines are recognised by `lineInfo().kind === "partforge.lines"` |
| A domain never imports another domain | `test/domain-layering.test.js` | The shared core cannot be a domain. It is a core leaf, `src/framework/lines/`, like `solve/` |
| `oracle.facts(sp, ctx)` stamps per SUB-PART rows; `oracle.checks` is refused by `validateDomains` | `domains/registry.js`, `oracle/measure.js` `stampDomainFacts` | A line is not a sub-part row. `measure()` gets a new top-level `lines` key, read by core |
| Domain `oracle.metrics` merge into `SUBPART_METRICS`; view gates live in `VIEW_METRICS` | `verify-metrics.js` | Line gates are core `VIEW_METRICS` entries, beside `sweepContacts` |
| The rigid sweep path builds each sub-part once and moves it by matrix; anything that rebuilds is stepped coarsely | `oracle/sweep.js` | Lines must be evaluated from `derive` alone at each sweep sample, never built by the kernel |
| The collision world indexes meshes and takes a matrix per query | `collide/world.js` (`buildIndex`, `distances`) | A line's tube mesh can be indexed per sample and queried against the pieces |
| `solve/dls.js` is a pure damped-least-squares core shared by IK and Pose mode | `solve/` | The slack solver uses it; no new numeric dependency |
| Probes may return plain JSON into `measure.probes` | `oracle/measure.js` | Phase 1 can ship its report through a probe before any oracle change |

## Design

### 1. The core: `src/framework/lines/`

Pure, DOM-free, three-free, worker-safe. Five small modules.

- `elements.js`: the vocabulary. An element is one of
  - `anchor`: a point fixed in a frame (a termination, a clip, a port),
  - `drum`: a cylinder `{ center, axis, radius }` in a frame, with a wrap side
    (`"cw" | "ccw"`), optional `turns` and helix `lead`,
  - `guide`: a point the line must pass through with free direction (an eyelet, a
    bore), optionally with a `tangent`.
  Every element names the frame it rides on: a sub-part's placement, a limb frame
  (`<limb>.<joint>`), or a mechanism member. Frames arrive as resolved matrices, so
  the core never knows which helper made them.
- `taut.js`: the taut solver. Free spans are straight tangents; wraps are arcs or
  helices on drums. Closed form when consecutive drums are coplanar or have parallel
  axes (the helix takes up the axial offset). A skew pair is solved by iterating the
  entry and exit angles to the shortest path; that case is phase 3.
- `slack.js`: the slack solver (phase 4). A fixed-length centerline between two
  anchored tangents, discretised into N segments and relaxed to minimum bending
  energy with `solve/dls.js`. Planar first (a hinge's service loop lies in the
  joint's plane); out-of-plane later.
- `report.js`: turns a solved line into plain JSON (below).
- `tube.js`: a solved centerline as a triangle mesh payload (positions, indices), the
  same shape the viewer and `softrender/` already draw. No kernel involved.

### 2. What a part writes

A line is declared in `derive` and named in a new top-level `lines` block, the twin of
`handles`:

```js
import { capstan } from "partforge/mechanisms";

derive: {
  drive: (p) => capstan({
    rope: { d: 1.2, material: "uhmwpe" },
    input:  { name: "drum",   radius: 6,  center: [0, 0, 0],  axis: [0, 0, 1], turns: 3 },
    output: { name: "pulley", radius: 30, center: [60, 0, 0], axis: [0, 0, 1] },
    drive: { member: "drum", angle: p.motorAngle },
    pretension: 20,          // N
  }),
},
lines: { rope: { on: "drive" } },
```

`capstan()` is a mechanisms helper like `beltDrive`: `angleOf(name)`, `place(name,
solid)`, `handleInfo()`. It adds `lineInfo()` (the solved path as plain data) and
`report` (below). The ratio is `output.radius / input.radius`, plus the rope's own
radius on both (the pitch circle is `radius + d / 2`), which `beltDrive` leaves to
the author.

An antagonistic pair (two ropes, one each way) is two entries in `ropes: [...]`; a
single figure-eight rope is one entry whose path crosses between the drums.

The general form, for routes the helper does not cover, is `line({ mode, rope |
cable, through: [elements] }, frames)` from `partforge/lines`.

### 3. The report

`lineInfo()` carries `kind: "partforge.lines"` and, per line, the centerline as
points plus the element list. `report` is what an agent reads:

| Field | Taut rope | Slack cable |
| --- | --- | --- |
| `length` | path length at this pose, mm | cut length, mm |
| `spans` | each free span's length | each segment, `fixed` or `flex` |
| `wraps` | per drum: `angle`, `turns`, `bendRatio` (drum Ø / rope Ø), `fleet` (deg off perpendicular), `width` needed against the drum's | n/a |
| `holding` | `e^(mu * angle)` per friction wrap, and whether it holds `drive.torque` if declared | n/a |
| `stiffness` | `EA / length` in N/mm, and the joint stiffness it gives at the output radius | n/a |
| `minBend` | n/a | smallest radius, where, against the cable's limit |
| `twist` | n/a | degrees per metre through a `throughBore` |
| `slackMargin` | n/a | free length minus the straight-line distance |

Friction, modulus and bend limits come from the declared `material` or from explicit
numbers; explicit numbers win. The preset table (`lines/materials.js`) carries a
source per value, and an unknown material is an error, not a guess.

### 4. Over a motion: the sweep reading

A single pose says little. The number that decides a capstan is how the path length
changes as the joint turns. Each `verify.sweeps` row gains a `lines` entry per line:

```
{ name: "rope", lengthMin, lengthMax, drift, driftAt,        // taut
  minBend, minBendAt, twistMax, minClearance: { distance, b, at, value } }  // slack
```

The sweep engine already walks a motion sample by sample. At each sample it calls
`derive` (it does today, for placements), so reading `lineInfo()` there costs no
kernel work. Clearance to pieces indexes the line's tube mesh (a few hundred
triangles) and queries it through the collision world. A line has no placement to
bound its motion by, so it is checked at the samples only, as a rebuilt mesh is; the
row says so (`linesSampled: true`).

New `VIEW_METRICS`, each a gate that reads those rows:

- `lineDrift`: the largest `drift` over the declared sweeps. `"<=0.2 mm"` is the
  capstan gate.
- `lineBend`: the worst bend ratio (taut) or bend radius margin (slack).
- `lineContacts`: lines that came closer than their clearance to a piece.

Like `sweepContacts`, each is withheld (null, not 0) when no declared sweep ran to
its end.

### 5. Drawing a line

A line is not a sub-part: it is not exported, and its shape follows the pose. The
viewer draws each line's `tube.js` mesh as a non-exportable display mesh, and on a
pose frame re-meshes it on the main thread from the new `derive`, the pattern
`skin/` already uses for a deforming mesh. Because the tube is an ordinary mesh
payload:

- captures and `softrender/` draw it with no renderer change, so agent renders show
  the rope,
- the cached preview (`gltf/encode-preview.js`) carries it as a non-exported mesh,
  so the opening frame shows it (see "In the cached preview", below),
- `measure()` leaves it out of `aggregate`, `overlaps` and the kit.

Code that edits the scene in place must call `viewer.requestRender()`, as the
draw-on-demand rule requires.

**While posing.** The drag readout (`pose/drag-readout.js`) shows a line's live
numbers beside the handle's own: a rope's length drift from its rest length, a
cable's current bend radius. A line past a limit (slack or over-tight, a bend under
its radius) is tinted, as a blocked pair is at contact. A drag does not stop at a
line: lines are not in the drag guard (`collide/guard.js`), so a cable can pass
through a piece on screen and the sweep reports it. Stopping a drag at a line is
out of scope here.

**In the cached preview.** `mountPreview({ part })` already resolves the part's
`derive` on the main thread for every posed frame (`preview-pose.js`,
`resolveParams`) and moves the file's meshes by matrix. A line needs nothing more
than that `derive`, so the preview re-solves and re-meshes each line after it
applies the piece matrices, and a posed preview shows its lines move. Two cases
stay still, by design:

- a preview mounted WITHOUT the part has no `derive`: the line is the still tube
  the file carries,
- a baked animation stores per-piece poses, which a line's changing shape does not
  fit. With the part, the player re-solves lines per frame; without it they hold
  the opening pose.

`previewHandles` is unchanged: it asks whether every PIECE a handle moves is
place-only, and a line is not a piece. Adding the tube changes the file's bytes, so
`PREVIEW_ENCODER_VERSION` is bumped. The preview must stay light on a host page:
taut lines are always live there; slack lines are live only if a frame's solve
stays inside a budget measured with `npm run bench:pose`, else they hold the last
solved shape until release.

### 6. Slack mode: the wiring domain

A new domain, `domains/wiring/`, published as `partforge/wiring`, guide
`docs/domains/wiring.md`. It imports `lines/` (core) and no other domain.

- `harness({ cables, ports, clips, runs }, frames)` in `derive`.
- A run is a list of segments. `fixed` (both ends on one piece) is a polyline with
  the cable's static bend radius at each corner. `flex` (the ends on different
  pieces) is solved by `slack.js` per pose.
- Three joint-crossing helpers that produce a `flex` segment with a solved length:
  `throughBore` (along a twist axis; reports twist), `serviceLoop` (a planar loop
  beside a hinge), `wrap` (wound round the hub so the wind takes the rotation).
  Each sizes the free length from the worst pose in the joint's declared range.
- Lint, appended through the manifest's `lintRules`: `flex-unanchored` (a flex end
  with no clip within a few cable diameters), `line-unswept` (a line rides a frame
  that a motion moves and no declared sweep moves it), `connector-no-access`.

### 7. Printable hardware

No framework change, and useful before any of the above: published reference
forges whose `lib/` helpers the agent can copy. Rope side: a grooved capstan drum
with a helical lead, a termination pocket, a pretension screw block. Cable side: a
channel, a clip saddle, a zip-tie slot, a strain-relief clamp, a chamfered
pass-through, connector keep-out volumes.

### 8. What the agent is told

- One brief line per line, under `// Interfaces:`:
  `// Lines: rope: capstan drum→pulley, 5:1, 3 turns → lineDrift <=0.2 over motorAngle`
  `// Lines: bus: flex across elbow, serviceLoop → lineBend, lineContacts over elbow`
- `docs/domains/mechanisms.md` gains a `capstan` section; `docs/domains/wiring.md`
  is new; `docs/ERROR-PATTERNS.md` gains one entry per new gate and lint rule.
- `npm run docs:domains` regenerates the index. The cloud's prompt corpus follows
  the published version.

## Phases

Each phase is one PR with its own version bump.

| Phase | Ships | Touches |
| --- | --- | --- |
| 0 | Reference forges for rope and cable hardware | no framework code |
| 1 | `lines/` core (elements, taut closed form, report), `capstan()` in mechanisms, report through a probe, `src/parts/capstan-joint.js`, guide section, types, tests | `lines/`, `domains/mechanisms/`, docs, `types/mechanisms.d.ts` |
| 2 | `lines` block, `measure().lines`, sweep rows' `lines`, `lineDrift` and `lineBend` gates, lint `line-unswept`, CLI line | `oracle/measure.js`, `oracle/sweep.js`, `verify-metrics.js`, `lint/`, `bin/cli.js`; re-record `test/verify-golden.test.js` |
| 3 | Tube mesh, viewer drawing, pose-frame re-mesh, captures; live readout and limit tint; cached-preview support (tube in the GLB, re-solve while posing); skew-axis taut solve; `lineContacts` | `lines/tube.js`, `viewer.js`, `mount.js`, `pose/drag-readout.js`, `gltf/encode-preview.js`, `mount-preview.js`, `preview-pose.js`, `collide/world.js` |
| 4 | `partforge/wiring`: `harness`, fixed segments, planar `slack.js`, the three crossing helpers, its lint rules, `src/parts/cable-arm.js` | `domains/wiring/`, `lines/slack.js`, registry, `package.json` exports |
| 5 | Out-of-plane slack, bundles, cut list in the kit | `lines/slack.js`, `export/kit/` |

Phase 1 as built (0.199.0): `lines/taut.js` (open and closed lines, parallel axes),
`lines/materials.js` (one sourced preset, `uhmwpe`), `capstan()` with `lineInfo()` and
`report()`, the guide section, types and tests. Left for its own PR: the reference
part `src/parts/capstan-joint.js`, and a public `partforge/lines` entry for
`line()` (the solver is internal until a second caller needs it).

Phase 1 is useful by itself: it answers the capstan joint's design questions at one
pose and, through a probe sampled by the part, over a range.

## Tests

- `test/lines-taut.test.js`: closed forms against hand-worked cases (two equal
  pulleys, open and crossed; a 5:1 pair; an offset drum's fleet angle and helix
  length).
- `test/capstan.test.js`: ratio, `angleOf`, `place` identity with `beltDrive` on a
  shared fixture; a concentric drive reads zero drift over a full sweep; an
  eccentric one reads the drift geometry predicts.
- `test/lines-layering.test.js`: `lines/` is DOM-free, three-free and reaches no
  domain; `domains/wiring/` reaches no other domain.
- Phase 2: a fixture whose rope goes slack fails `lineDrift`; the verify golden is
  re-recorded in the same commit and the diff read.
- Phase 3: a preview mounted with the part re-poses its rope to match the live
  mount at the same params; one mounted without it keeps the file's tube; older
  encoder versions still decode.
- Phase 4: `slack.js` against the analytic planar elastica for a symmetric loop;
  cold and warm solves equal bit for bit.

## Decisions Scott made (2026-11-20)

1. **A new top-level `lines` key**, the twin of `handles`. Lines are never
   discovered by scanning `derive`.
2. **Ship a material preset table** (`lines/materials.js`) with sourced values.
   Every preset names its source in a comment; explicit numbers on the rope or
   cable always win over the preset, and an unknown material is an error.
3. **Lines are display meshes**, not a scene overlay, so captures, `softrender/`
   and the cached preview all show them.

## Still open

4. **Where the gates live.** Core `VIEW_METRICS` (recommended, since the sweep
   engine is core and reads the lines) or wiring `oracle.metrics` (which today
   merge into sub-part metrics only, so that route needs a registry change first).
5. **Capstan in mechanisms, cable in a new domain** (recommended), or one
   `partforge/lines` domain holding both.
6. **Withholding the verdict.** Should a line riding a moving frame with no sweep
   hold `verify.ok` at null, as an unswept motion does, or only warn? Recommended:
   warn in phase 2, revisit after the capstan joint has been through it.
