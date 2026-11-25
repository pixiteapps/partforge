# Cage Authoring Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give cage and limb authors eight tools that remove the hand-written placement code in `src/parts/cage-hand.js`, and move the hand onto each tool as it lands without changing its shape.

**Architecture:** Four tools are options on the cage builder (`src/framework/geometry/subdiv/cage.js`). Two are in the limb's joint tree (`src/framework/domains/kinematics/tree.js`). Two are new oracle modules read by `measure` and the CLI. Each task ends by rewriting the part of the hand that the tool replaces.

**Tech Stack:** Plain ES modules, vitest (`npx vitest run <file>`), eslint (`npm run lint`). Node 24.

**Spec:** `docs/superpowers/specs/2026-11-24-cage-authoring-tools-design.md`

## Global Constraints

- The hand's shape must not change. Before editing `src/parts/cage-hand.js`, save its cage with the script in "The hand guard" below; after the edit the guard must pass. A task that cannot make it pass stops and reports the largest difference; it does not retune the hand.
- `docs/domains/organic.md` holds a copy of `src/parts/cage-hand.js` from its `import` lines to the end of `poseDigits`; `test/organic-docs.test.js` fails when they differ. After any edit to the hand, copy the same span into the guide.
- Every new option is described in the guide where its neighbours are: cage options in `docs/domains/organic.md` ("Starting the cage", "Face ids", "Changing the cage", "Cage errors"), limb options in `docs/domains/kinematics.md` ("Declaring a limb", "Joints", "Errors"). Guide prose is plain: short sentences, no dashes used as punctuation, no semicolons.
- Errors follow the file's style: cage errors start `cage: `, limb errors come from `failer(name)` (`limb "x".field: …`), and each says what to change.
- No point index appears in any API or error.
- New option names are exactly those in the spec. Add no others.
- After a task's own tests pass, run `npx vitest run` (the whole suite) and `npm run lint`. Both must be clean before the commit. Pre-existing lint warnings (8) may remain.
- Commit messages are one plain sentence plus a body where useful, and end with the line `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Do not push. Do not change `package.json`'s version.
- When a method's options change, search `src/`, `docs/`, `test/` and `scripts/` for other places that list those options (lint rules, stub kernels, generated indexes, error-pattern docs) and update them. `npm run docs:domains` regenerates the domain index if a guide's headings change.

### The hand guard

Save as `.superpowers/hand-guard.mjs` (the directory is git-ignored). Run `node .superpowers/hand-guard.mjs save` before a hand edit and `node .superpowers/hand-guard.mjs check` after.

```js
import { readFileSync, writeFileSync } from "node:fs";
import { cage } from "../src/framework/domains/organic/index.js";   // fix this path to wherever partforge/organic's `cage` is exported from
import part, { cageHand } from "../src/parts/cage-hand.js";
const POSES = [
  {},
  { indexKnuckle: 80, indexCurl: 70, middleKnuckle: 80, middleCurl: 70, ringKnuckle: 80, ringCurl: 70, pinkyKnuckle: 80, pinkyCurl: 70 },
  { thumbOppose: 38, indexKnuckle: 35, indexCurl: 62 },
  { thumbOppose: 88, thumbAbduct: 70, thumbCurl: 35 },
  { thumbOppose: -22, thumbCurl: 50, pinkyKnuckle: -10 },
];
const dump = () => POSES.map((over) => {
  const d = part.derive({ ...part.defaults, ...over });
  const snap = cageHand(cage, d).snapshot();
  const bones = Object.fromEntries(Object.entries(d).map(([n, l]) => [n, l.bones.joints.map((j) => j.posed.origin).concat([l.bones.tip.posed])]));
  return { points: snap.points, faces: snap.faces.length, bones };
});
const file = new URL("./hand-guard.json", import.meta.url);
if (process.argv[2] === "save") { writeFileSync(file, JSON.stringify(dump())); console.log("saved"); }
else {
  const was = JSON.parse(readFileSync(file)), now = dump();
  let worst = 0;
  now.forEach((n, i) => {
    if (n.faces !== was[i].faces) throw new Error(`pose ${i}: ${n.faces} faces, was ${was[i].faces}`);
    if (n.points.length !== was[i].points.length) throw new Error(`pose ${i}: ${n.points.length} points, was ${was[i].points.length}`);
    // Points may be stored in another order after an edit: match each to its nearest old point.
    for (const p of n.points) worst = Math.max(worst, Math.min(...was[i].points.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))));
    for (const [name, pts] of Object.entries(n.bones)) {
      const old = was[i].bones[name];
      // A limb may have fewer joints after Task 3: compare the tip, and every new joint to its nearest old one.
      for (const p of pts) worst = Math.max(worst, Math.min(...old.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))));
    }
  });
  console.log(`largest difference ${worst.toExponential(2)} mm`);
  if (worst > 1e-6) process.exit(1);
}
```

The guard's limit is 1e-6 mm for Tasks 1, 2 and 4. Task 3 changes how the limbs are built, so its limit is 1e-3 mm (edit the last line for that task only and say so in the report).

## Review Focus

- A widths list that does not add up to `size`, or is not symmetric under a mirror: must throw, never rescale.
- `steps` as a list of exactly three numbers must never be read as an `[sx, sy, sz]` scale, and `scale: [a, b, c]` with `steps: 3` must keep today's meaning.
- A limb from points whose bones are all in one line must give the same frames, bit for bit in its report, as the same limb written with `at`, `toward` and `lengths`.
- A mirrored limb from points: the mirrored limb's joints are the reflections of the plain limb's, at rest and posed.
- `measure` on a part whose `derive` returns no limbs: the report has no `limbs` key and nothing else changes.

---

### Task 1: Uneven box segments and a scale per extrude step

**Files:**
- Modify: `src/framework/geometry/subdiv/cage.js` (`createCage`, `extrude`, the header comment)
- Modify: `test/subdiv-cage.test.js`, `test/subdiv-cage-mirror.test.js`
- Modify: `src/parts/cage-hand.js`, `docs/domains/organic.md`, `test/cage-hand.test.js` and any other test that names a hand face id

**Interfaces:**
- Produces: `box.segs` entries may be `number[]` of widths. `extrude(face, { by, steps: Array<number | [sx, sy, sz]>, id })`.

- [ ] **Step 1: Failing tests for widths** in `test/subdiv-cage.test.js`:

```js
it("takes a list of widths for an axis of segs", () => {
  const c = createCage({ box: { size: [10, 2, 4], segs: [[1, 3, 6], 1, 2] } });
  expect(c.faces("+z:").length).toBe(3);
  expect(c.centroid("+z:0,0")[0]).toBeCloseTo(-4.5, 9);
  expect(c.centroid("+z:1,0")[0]).toBeCloseTo(-2.5, 9);
  expect(c.centroid("+z:2,0")[0]).toBeCloseTo(2, 9);
});
it("refuses widths that do not add up to the size", () => {
  expect(() => createCage({ box: { size: [10, 2, 4], segs: [[1, 3, 5], 1, 2] } }))
    .toThrow("cage: box.segs[0] widths add up to 9, not the box's size 10");
});
it("refuses a width that is not positive", () => {
  expect(() => createCage({ box: { size: [10, 2, 4], segs: [[4, 0, 6], 1, 2] } })).toThrow(/box\.segs\[0\]/);
});
```

and in `test/subdiv-cage-mirror.test.js`:

```js
it("needs mirrored widths to read the same from both ends", () => {
  expect(() => createCage({ mirror: "yz", box: { size: [10, 2, 4], segs: [[1, 4, 3, 2], 1, 1] } }))
    .toThrow('cage: mirror "yz" needs box.segs[0] widths that read the same from both ends');
  expect(() => createCage({ mirror: "yz", box: { size: [10, 2, 4], segs: [[2, 3, 3, 2], 1, 1] } })).not.toThrow();
});
```

- [ ] **Step 2: Run them, expect FAIL.** `npx vitest run test/subdiv-cage.test.js test/subdiv-cage-mirror.test.js`

- [ ] **Step 3: Implement widths in `createCage`.** Resolve `segs` into per-axis counts plus per-axis cut positions (fractions 0…1 of the size); `latticePoint` reads the position from the cuts. The sum check uses a tolerance of `1e-9 * size`. The face total, the mirror's even-count rule and every id stay on the counts.

- [ ] **Step 4: Failing tests for step scales** in `test/subdiv-cage.test.js`:

```js
it("scales each step of an extrude by its own entry", () => {
  const a = createCage({ box: { size: [4, 4, 4] } });
  let cur = a.extrude("+z:0,0", { by: 2, scale: 1.1, id: "ka" });
  cur = a.extrude(cur, { by: 2, id: "kb" });
  a.extrude(cur, { by: 2, scale: 0.92, id: "kc" });
  const b = createCage({ box: { size: [4, 4, 4] } });
  b.extrude("+z:0,0", { by: 6, steps: [1.1, 1, 0.92], id: "k" });
  const sort = (c) => c.snapshot().points.map((p) => p.map((v) => v.toFixed(9)).join()).sort();
  expect(sort(b)).toEqual(sort(a));
  expect(b.faces("k").sort()).toEqual(["k", "k.1.s0", "k.1.s1", "k.1.s2", "k.1.s3", "k.2.s0", "k.2.s1", "k.2.s2", "k.2.s3", "k.s0", "k.s1", "k.s2", "k.s3"]);
});
it("keeps scale: [a, b, c] with steps: 3 as one [sx, sy, sz] taper", () => {
  const c = createCage({ box: { size: [4, 4, 4] } });
  c.extrude("+z:0,0", { by: 6, steps: 3, scale: [0.5, 1, 1], id: "t" });
  expect(c.size("t")).toEqual([2, 4]);
});
it("refuses scale together with a steps list", () => {
  const c = createCage({ box: { size: [4, 4, 4] } });
  expect(() => c.extrude("+z:0,0", { by: 6, steps: [1, 1], scale: 0.9 }))
    .toThrow("cage: extrude takes scale or a steps list, not both");
});
it("refuses an empty steps list and a bad entry", () => {
  const c = createCage({ box: { size: [4, 4, 4] } });
  expect(() => c.extrude("+z:0,0", { by: 6, steps: [] })).toThrow(/extrude steps/);
  expect(() => c.extrude("+z:0,0", { by: 6, steps: [1, "x"] })).toThrow(/extrude steps\[1\]/);
});
```

- [ ] **Step 5: Run, expect FAIL.**

- [ ] **Step 6: Implement.** With a list, ring `m` is ring `m - 1` moved by `offset / n`, then scaled about its own mean by entry `m` (a joined mirrored region scales about a mean held on the plane, as the cap does today). The short-edge check runs on every ring. The cap ring also carries the region's interior points, scaled with its ring. A mirrored region must stay symmetric: add one mirror test that a `steps` list on a mirrored cage leaves every far point the reflection of its twin.

- [ ] **Step 7: Run both test files, expect PASS.**

- [ ] **Step 8: Move the hand onto them.** Save the hand guard first. In `src/parts/cage-hand.js`: replace `COLUMNS` and the column loop in `palm` with a widths list in `PALM.segs` (`[15, 3, 18.5, 3, 19, 3, 19.5]`); make `knuckle` one `extrude` with `steps: [wide ? 1.1 : 1, 1, wide ? 0.92 : 1]` and `by: 3 * RING`; make the palm's three knuckle rings one `extrude` with `steps: 3`. Face ids change (`knuckleb.sK` becomes `knuckle.2.sK`, `knucklea.sK` becomes `knuckle.1.sK`, and each digit knuckle's rings likewise): update every reference in the hand, its tests and the guide's prose. Run the guard: it must pass at 1e-6.

- [ ] **Step 9: Guide.** In `docs/domains/organic.md`: widths under "Starting the cage", the `steps` list under "Changing the cage" (with its ids under "Face ids"), the new errors under "Cage errors". Copy the hand's new code into the worked example.

- [ ] **Step 10: Whole suite and lint, then commit.**

---

### Task 2: Move along the normal, and faces by direction

**Files:**
- Modify: `src/framework/geometry/subdiv/cage.js` (`move`, the `faces` read)
- Modify: `test/subdiv-cage.test.js`, `test/subdiv-cage-mirror.test.js`
- Modify: `src/parts/cage-hand.js`, `docs/domains/organic.md`

**Interfaces:**
- Produces: `move(face, offset: [x, y, z] | number)`. `faces(prefix = "", { facing?: "+x" | "-x" | "+y" | "-y" | "+z" | "-z" | [x, y, z], near?: [x, y, z] } = {})`.

- [ ] **Step 1: Failing tests** in `test/subdiv-cage.test.js`:

```js
it("moves faces along their normal for a number", () => {
  const c = createCage({ box: { size: [4, 4, 4], segs: [2, 1, 1] } });
  c.move("+y:0,0", 1.5);
  expect(c.centroid("+y:0,0")[1]).toBeCloseTo(2 + 1.5 * (2 / 3) + 0, 1);   // loose: only that it went out along +Y
  expect(c.centroid("+y:0,0")[1]).toBeGreaterThan(2.5);
  const d = createCage({ box: { size: [4, 4, 4] } });
  d.move("-x:0,0", 2);
  expect(d.centroid("-x:0,0")).toEqual([-4, 0, 0]);
});
it("refuses a number when the faces' normal sums to nothing", () => {
  const c = createCage({ box: { size: [4, 4, 4] } });
  expect(() => c.move(["+x:0,0", "-x:0,0"], 1)).toThrow("cage: move by a number, but the faces' normal sums to zero length; give [x, y, z]");
});
it("lists faces by where they face", () => {
  const c = createCage({ box: { size: [4, 4, 4], segs: [3, 1, 1] } });
  const ring = c.extrude(["+z:0,0", "+z:1,0", "+z:2,0"], { by: 2, id: "r" });
  expect(c.faces("r.s", { facing: "-y" }).length).toBe(3);
  expect(c.faces("r.s", { facing: [0, -2, 0] })).toEqual(c.faces("r.s", { facing: "-y" }));
  expect(c.faces("r.s", { facing: "+x" }).length).toBe(1);
  expect(c.faces("", { facing: "+z" })).toEqual(ring);
});
it("orders faces nearest first", () => {
  const c = createCage({ box: { size: [6, 2, 2], segs: [3, 1, 1] } });
  expect(c.faces("+z:", { near: [3, 0, 1] })).toEqual(["+z:2,0", "+z:1,0", "+z:0,0"]);
  expect(c.faces("", { facing: "+z", near: [-3, 0, 1] })[0]).toBe("+z:0,0");
});
it("refuses unknown faces options", () => {
  const c = createCage({ box: { size: [4, 4, 4] } });
  expect(() => c.faces("", { facing: "up" })).toThrow('cage: faces facing must be "+x", "-x", "+y", "-y", "+z", "-z" or a non-zero [x, y, z], not "up"');
  expect(() => c.faces("", { near: 3 })).toThrow("cage: faces near must be [x, y, z] finite numbers");
  expect(() => c.faces("", { towards: "+x" })).toThrow('cage: faces has no option "towards"');
});
```

Delete the loose `toBeCloseTo` line in the first test if it does not hold; the two assertions after it are the requirement.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** `move` with a number: the offset is the unit of the summed Newell normals of the named faces times the number, with the zero-normal rule `extrude` uses (same threshold); on a mirrored cage it goes through `withMirror` like a vector move. `facing`: a face is kept when the dot of its unit normal with the unit direction is at least `Math.SQRT1_2 - 1e-9`. `near`: a stable sort by distance from the face's centroid. `faces` stays a read: it works after `skin`. Add a mirror test: `faces("", { facing: "-x" })` on a `"yz"` mirrored cage returns ids ending in `~`.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Move the hand onto them.** Save the hand guard. In `cageHand`: the knuckle heads and palm mounds pick their face with `c.faces("<ring>.s", { facing: "+y" | "-y", near: <that column's cap centroid> })[0]` and no index arithmetic; the finger pads use `c.faces(\`${name}P${i}.s\`, { facing: "-y" })[0]`; `topmost(sides)` becomes `c.faces("thenar.s", { facing: "+z" })` only if that returns exactly the same one face (check it; keep `topmost` and say so in the report if it does not). Do NOT switch the pads' `[0, -d, 0]` moves to `move(face, d)`: that would move the points and change the shape. Remove the comment about `s(n + 1)` and `s(15 - n)`. Run the guard at 1e-6.

- [ ] **Step 6: Guide.** `move` by a number and `faces` options under "Changing the cage" and "Face ids"; errors under "Cage errors"; one line in "Recipes" on picking a ring's face by direction. Copy the hand's code into the worked example.

- [ ] **Step 7: Whole suite and lint, then commit.**

---

### Task 3: A limb from joint points

**Files:**
- Modify: `src/framework/domains/kinematics/tree.js` (`buildTree`, `DEF_KEYS`, `JOINT_KEYS`, `jointSteps`), `src/framework/domains/kinematics/outputs.js` (`buildFrames`), `src/framework/domains/kinematics/solve.js` (the reach guard)
- Create: `test/kinematics-points.test.js`
- Modify: `src/parts/cage-hand.js`, `docs/domains/kinematics.md`, `docs/domains/organic.md`

**Interfaces:**
- Produces: `limb(name, { points: [x, y, z][], toward?, bendToward, joints, r?, mirror?, parent? })`; joint entries may carry `toward` and `bendToward`.
- Tree shape: each joint gains `aim: { axis: [x, y, z], deg } | null`, the fixed turn from the previous joint's rest frame to this joint's (null for the base joint, and for a joint whose frame equals the previous one). `jointSteps` puts it before the joint's own step, so the joint's own step stays last (outputs.js relies on that). `joint.length` and `joint.offset` are derived from the points in the previous joint's rest frame: `length = max(0, local y)`, `offset = local - [0, length, 0]`, null when zero.

- [ ] **Step 1: Failing tests** in `test/kinematics-points.test.js` (import `limb` the way `test/kinematics-core.test.js` does). Required cases, each its own `it`:

  1. **Straight limb equals the lengths form.** `limb("a", { points: [[1, 2, 3], [1, 2, 13], [1, 2, 21], [1, 2, 26]], bendToward: [0, -1, 0], joints: ["j0", "j1", "j2"] })` and `limb("a", { at: [1, 2, 3], toward: [0, 0, 1], bendToward: [0, -1, 0], joints: ["j0", "j1", "j2"], lengths: [10, 8, 5] })`: for `pose({ bend: [30, 20, 10] })`, `report` is deep-equal and every `bones.joints[i].posed.origin` and `.y` agree to 1e-12.
  2. **A bent polyline rests on its points.** `points: [[0, 0, 0], [0, 0, 10], [5, 0, 18], [5, -4, 25]]`, no `toward`: `pose({}).bones.joints[i].rest.origin` equals each point and `bones.tip.rest` the last, to 1e-9; each `rest.y` is the unit vector to the next point.
  3. **Each joint bends about its own bone.** Same limb, `pose({ bend: { j1: 90 } })`: the tip's distance from `points[1]` is unchanged, and `j1`'s posed `y` is square to its rest `y` (dot under 1e-9).
  4. **A limb `toward` aims every joint.** `points` as in 2 with `toward: [0, 0, 1]` and the last bone changed to lie along Z (`[5, 0, 18] → [5, 0, 25]`): every `rest.y` is `[0, 0, 1]` and the rest origins are the points.
  5. **A joint's own `toward` and `bendToward`.** The spec's thumb shape with numbers: `points: [[0, 0, 0], [0, 0, 0], [10, -3, 20], [16, -6, 30], [20, -8, 38]]`, `bendToward: [-1, -1, 0]`, joints `abduct` (`toward: [0, 0, 1]`, `bendToward: [0, -1, 0]`), `oppose` (`axis: "twist"`, `toward: [0, 0, 1]`), `mcp`, `ip`. At rest the origins are the points. `pose({ bend: { oppose: 40 } })` turns `points[2]` about the Z line through the origin by 40° (same height, same distance from the line). `pose({ bend: { abduct: 30 } })` moves `points[2]` toward −Y.
  6. **Mirror.** The limb of case 2 with `mirror: "YZ"`: at rest and at `pose({ bend: [20, 30, 10] })` every joint origin and the tip are the plain limb's with X negated, to 1e-9.
  7. **Skin reads it.** `pose({ bend: [20, 30, 10] }).bones` has `kind: "partforge.bones"`, three joints, and `rest`/`posed` frames whose axes are unit and mutually square.
  8. **Errors** (exact text after the `limb "a"` prefix that `failer` adds):
     - `points` with `at`: `.points: replaces at, lengths and joint offsets — remove at`
     - `points` with `lengths`: `.points: replaces at, lengths and joint offsets — remove lengths`
     - a joint `offset` with `points`: `.joints[1].offset: points already place this joint — remove offset`
     - wrong count: `.points: expected 4 entries (one per joint, then the tip), got 3`
     - a zero-length first bone and no `toward` anywhere: `.joints[0].toward: this joint's bone has no length, so it needs a toward (its own, or the limb's)`
     - last bone off its aim: message contains `the last bone must lie along its joint's aim` and the angle in degrees to one decimal
     - joint `toward` without `points`: `.joints[0].toward: a joint's own toward needs the limb's points`
     - `bendToward` parallel to a joint's aim: `.joints[1].bendToward: must not be parallel to this joint's aim`
     - `reach` on the limb of case 2: message contains `reach needs a straight limb` and `goals`.
  9. **`goals` and `grip` run.** On the limb of case 2: `pose({ goals: { tip: [8, -6, 20] } })` returns a report whose goal status is a string and whose residual is finite; `pose({ grip: { around: { kind: "sphere", r: 6, at: [6, -8, 16] } , r: [3, 3, 3, 3] } })` returns without throwing. (Read `test/kinematics-goals.test.js` and `test/kinematics-grip.test.js` for the exact option shapes and adjust the literals to valid ones.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement in `buildTree`.** With `points`: validate, reflect for a mirror, then walk the joints. Joint `i`'s aim Y is the first of: its own `toward`, the limb's `toward`, the unit vector `points[i] → points[i + 1]` when that bone is longer than 1e-9, the previous joint's Y. Its Z is the part of −(`bendToward` of the joint, else the limb's) square to Y, exactly as the base aim is built today; X = Y × Z. The base joint's frame becomes `base.aim`/`base.aimStep` as today. For `i ≥ 1` the fixed turn is `axisAngle` of (previous frame)ᵀ · (this frame), stored as `aim` (null when the angle is under 1e-12 degrees). Positions: `local = (previous frame)ᵀ · (points[i] − points[i − 1])`. Set `tree.straight = true` when no joint has an `aim` and no joint has an offset from points; the reach guard reads it. Without `points` nothing changes and `tree.straight` is not consulted.

- [ ] **Step 4: `jointSteps`** puts `joint.aim` (mirror already applied in `buildTree`, since the frames were built from reflected vectors) before the joint's own step for `i ≥ 1`. Check `outputs.js` lines that take `.at(-1)` or slice the last `own` steps: they must still see the joint's own step last, and a hinge at value 0 emits no own step, so make sure the code that counts `own` does not mistake the fixed turn for it (add a test in case 3's style at value 0 if the ring-axis code is reached by `ikInfo`; read `test/kinematics-ikinfo.test.js`).

- [ ] **Step 5: Reach guard** in `solve.js`: a limb from points that is not `straight` fails with `reach needs a straight limb (one aim, every joint on the line) — pose this one with goals: { tip: [x, y, z] }`.

- [ ] **Step 6: Run the new file and every `test/kinematics-*.test.js`, expect PASS.**

- [ ] **Step 7: Move the hand onto it.** Save the hand guard, and set its limit to 1e-3 for this task. In `src/parts/cage-hand.js`:
  - Delete `steppedLimb` and the thumb's `fixed`, `lean`, `tilt`, `roll`, `shape`, `curlOf`, `angle` code and the `DEG`, `cross` helpers if nothing else uses them.
  - A finger's limb: `points: [(cup base,) mcp, pip, dip, tip]`, `toward` (the finger's line, so every joint keeps today's aim), `bendToward` as today. `dip` is `pip` moved `f.lengths[1]` along `toward`, `tip` is `dip` moved `f.lengths[2] - MID`.
  - The thumb's limb: the spec's form. `points: [pivot, pivot, mcp, ip, tip]`, limb `bendToward: THUMB_CURL`, `abduct` with `toward: [0, 0, 1]` and `bendToward: PALMWARD`, `oppose` with `axis: "twist"` and `toward: [0, 0, 1]`, then `mcp` and `ip`. `THUMB.r` becomes five radii: `[26, 26, 19, 18, 18]`.
  - `cageHand`'s skin `blend` keys keep their names.
  - Update the comments that describe the three fixed joints.
  Run the guard. If it fails at 1e-3, report the number and which pose; do not retune. Then run `test/cage-hand.test.js`, `test/cage-deform.test.js`, `test/cage-drag-validity.test.js`, `test/mount-cage-drag.test.js`, `test/pose-probe-cage.test.js`, `test/preview-cage.test.js`.

- [ ] **Step 8: Guide.** `docs/domains/kinematics.md`: a section "A limb from joint points" after "Declaring a limb" (the option, the aim order as a numbered list, one small example, when to give the limb a `toward`), a line in "Joints off the line: `offset`" pointing to it, a line under `reach` on straight limbs, the errors under "Errors". `docs/domains/organic.md`: in "Posing a cage with limbs", say that a limb for a cage is easiest to place from points read off the cage at rest; copy the hand's code into the worked example and fix the prose that describes the old fixed joints.

- [ ] **Step 9: Whole suite and lint, then commit.**

---

### Task 4: A follower may follow a later joint

**Files:**
- Modify: `src/framework/domains/kinematics/tree.js` (`buildTree`'s follow check, `couple`)
- Modify: `test/kinematics-core.test.js` (or the file that tests `follow` today)
- Modify: `src/parts/cage-hand.js`, `docs/domains/kinematics.md`, `docs/domains/organic.md`

**Interfaces:**
- Consumes: Task 3's hand limbs.
- Produces: `follow: { joint }` may name any other hinge of the limb.

- [ ] **Step 1: Failing tests.**

```js
it("lets a joint follow a later joint", () => {
  const l = limb("f", { at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], lengths: [10, 10, 10],
    joints: [{ name: "cup", range: [-2, 18], follow: { joint: "mcp", ratio: 0.2 } }, { name: "mcp", range: [-10, 90] }, "pip"] });
  expect(l.pose({ bend: { mcp: 50, pip: 10 } }).report.bend).toEqual([10, 50, 10]);
  expect(l.pose({ bend: [50, 10] }).report.bend).toEqual([10, 50, 10]);          // driven joints only, in order
  expect(l.pose({ bend: { mcp: 200 } }).report.bend[0]).toBe(18);                 // the leader's clamped value, then its own range
});
it("lets a follower follow a follower", () => {
  const l = limb("f", { at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], lengths: [10, 10, 10],
    joints: [{ name: "a", follow: { joint: "b", ratio: 0.5 } }, { name: "b", follow: { joint: "c", ratio: 0.5 } }, "c"] });
  expect(l.pose({ bend: { c: 80 } }).report.bend).toEqual([20, 40, 80]);
});
it("refuses a loop of followers", () => {
  expect(() => limb("f", { at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], lengths: [10, 10],
    joints: [{ name: "a", follow: { joint: "b" } }, { name: "b", follow: { joint: "a" } }] }))
    .toThrow('limb "f".joints[0].follow.joint: a follows b, which follows a — one of them must be driven');
});
it("refuses a joint that follows itself or an unknown joint", () => {
  const def = (j) => ({ at: [0, 0, 0], toward: [0, 0, 1], bendToward: [0, -1, 0], lengths: [10, 10], joints: [j, "b"] });
  expect(() => limb("f", def({ name: "a", follow: { joint: "a" } }))).toThrow(/follow\.joint/);
  expect(() => limb("f", def({ name: "a", follow: { joint: "zz" } }))).toThrow('unknown joint "zz"');
});
```

The loop error is reported on the first joint, in declaration order, that is part of a loop.

- [ ] **Step 2: Run, expect FAIL** (today: `unknown or later joint`).

- [ ] **Step 3: Implement.** Resolve `follow` names after every joint is read. `couple` computes values in an order where each leader comes before its followers (a fixed order worked out once in `buildTree`, stored on the tree). Every other reader of `follow` (search the kinematics folder, `src/framework/pose/`, the handle code and lint for `follow`) must not assume `follow.index < i`; fix any that does and add a test for it.

- [ ] **Step 4: Run every `test/kinematics-*.test.js` and the handle tests, expect PASS.**

- [ ] **Step 5: Move the hand onto it.** Save the guard (limit back to 1e-6). The cupping joint becomes `{ name: "cup", range: […], follow: { joint: "mcp", ratio: f.cup } }`; `poseDigits` stops passing `cup`; the handles' `joints` maps lose their `cup` entry. Guard, then the hand's tests. If a handle test shows the cup's rotate ring was relied on, report it.

- [ ] **Step 6: Guide.** `docs/domains/kinematics.md` "Joints": a follower may follow any other hinge, a chain of followers, the loop error. Copy the hand's code into `docs/domains/organic.md`.

- [ ] **Step 7: Whole suite and lint, then commit.**

---

### Task 5: `partforge measure --ranges`

**Files:**
- Create: `src/framework/oracle/ranges.js`, `test/oracle-ranges.test.js`
- Modify: `bin/cli.js` (the `measure` command), the CLI's test file for `measure --drag` (follow its pattern), `docs/AUTHORING-PARTS.md` or wherever `measure --drag` is documented, `docs/domains/organic.md` ("Validity")

**Interfaces:**
- Produces:
  - `rangePoses(part, { random = 24, seed = 1 } = {}) → Array<{ name: string, params: object }>`: `params` holds only the keys that differ from the defaults.
  - `sweepRanges(kernel, part, view, { random, seed } = {}) → { view, poses: number, failed: Array<{ name, params, error }>, faces: Array<{ id, count }> }`.

- [ ] **Step 1: Failing tests** in `test/oracle-ranges.test.js`:
  - `rangePoses` on a part with controls `a` (min 0, max 10, default 2), `b` (min −5, max 5, default 0) and a checkbox `c`: names in order `defaults`, `a=min`, `a=max`, `b=min`, `b=max`, `all min`, `all max`, `random 1` … `random 24`; `a=max` has `params: { a: 10 }`; no pose sets `c`; every random value is inside its range; two calls with one seed are deep-equal and another seed differs.
  - `random: 0` gives the first seven only. A part with no ranged control gives `defaults` alone.
  - `sweepRanges` with a stub kernel-free part whose `parts.x.build` throws `new Error("subdiv: the body passes through itself at faces k.s1, k.s2")` when `p.a > 8`: `failed` lists exactly the poses with `a > 8`, each with that error text, and `faces` is `[{ id: "k.s1", count: n }, { id: "k.s2", count: n }]`. (Read how `src/framework/oracle/build.js`'s `buildView` is called by `drag.js` or `measure.js`, and use the smallest real setup the other oracle tests use. Read the real self-intersection message in `src/framework/geometry/subdiv/index.js` and match face ids the way that message writes them.)
  - On the cage hand with `random: 6`: `poses` is `1 + 2 * 11 + 2 + 6`, and `defaults` is not in `failed`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `ranges.js`.** A small seeded generator (mulberry32) so runs repeat. Controls are read from `part.parameters[].controls` (and whatever other shapes the existing param resolver accepts: use the resolver's own list of controls if it exports one). Each pose builds the view through the same call `measure` uses and frees the kernel's objects after it (`kernel.cleanup?.()`), catching the throw. Build warnings are not failures.

- [ ] **Step 4: CLI.** `--ranges` is an alternative mode of `measure`, like `--drag`: `--random` and `--seed` need it, `--drag` and it exclude each other, `--process`, `--no-verify`, `--no-lint` do not apply. Text output: one line per failed pose (`random 7  indexKnuckle=71.3 ringKnuckle=12.0 …  →  <error>`), then `N of M poses did not build`, then the faces line when there are any. `--json` prints the result object. Exit 0 whenever the sweep ran.

- [ ] **Step 5: Run the new tests and the CLI tests, expect PASS.** Run `node bin/cli.js measure src/parts/cage-hand.js --ranges` and put its output in the report.

- [ ] **Step 6: Docs.** Next to `measure --drag`: what `--ranges` builds, that a failed pose is a fact and not always a fault (a drag stops at the last pose that builds), and how to read the faces line. One paragraph in organic.md "Validity".

- [ ] **Step 7: Whole suite and lint, then commit.**

---

### Task 6: Bone lengths and body sizes in the measure report

**Files:**
- Create: `src/framework/oracle/limb-sections.js`, `test/oracle-limb-sections.test.js`
- Modify: `src/framework/oracle/measure.js` (add `limbs` to the result), `bin/cli.js` (text output), the doc that lists the measure report's fields, `docs/domains/kinematics.md` ("The report"), `docs/domains/organic.md`

**Interfaces:**
- Produces:
  - `sectionAt(mesh: { positions, indices }, frame: { origin, x, y, z }) → { width, depth } | null`: the outline of the mesh's cut by the plane through `origin` square to `y` that goes round `origin`, measured along `x` (`width`) and `z` (`depth`); null when no outline goes round it.
  - `limbFacts(d, subparts: Array<{ name, mesh, matrix | null }>) → object | undefined` in the spec's shape, rounded to 0.1.
  - `measure(...)` result gains `limbs` when `limbFacts` returns one.

- [ ] **Step 1: Failing tests** in `test/oracle-limb-sections.test.js`:
  - `sectionAt` on a closed box mesh 20 × 10 × 40 centred at the origin, frame at the origin with `y = [0, 0, 1]`, `x = [1, 0, 0]`, `z = [0, 1, 0]`: `{ width: 20, depth: 10 }` to 1e-9. The same frame turned 90° about Z swaps them. A frame at `[30, 0, 0]` gives null. A frame at `[0, 0, 25]` (past the box) gives null.
  - Two separate boxes in one mesh, the frame inside the second: the second's size, not the union's.
  - A plane that passes exactly through mesh vertices (the box above, frame at `[0, 0, 20]`… use a box whose mid-height has a vertex ring, e.g. two stacked boxes sharing vertices at z = 0): still one closed outline with the right size.
  - `limbFacts` with a straight three-joint limb posed at 0 inside a cylinder-like box prism: `joints[i].length` are the limb's lengths, `at` the joint positions, `width`/`depth` the prism's, `part` the sub-part's name; `tip` is right.
  - `limbFacts({ n: 3, s: "x" }, …)` is undefined. A limb with `bones.parent === true` is skipped. Limbs inside an array one level down are found, named by their `bones.name`.
  - A sub-part with a `matrix` (a translation by `[100, 0, 0]`): the frame is carried into it and the section is still found.
  - `measure` on the cage hand (preview build, defaults): `limbs.index.joints` has three entries, `limbs.thumb.joints` four, every `length` is within 0.2 of the distance between that limb's posed joint origins, the index's `mcp` `width` is between 80 and 92, and its `pip` `width` is between 15 and 21.
  - `measure` on a part with no limbs (use a small existing fixture): the result has no `limbs` key.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `sectionAt`.** Signed distance of each vertex to the plane, with exact zeros nudged to one side (`+1e-9`) so a vertex on the plane never splits an outline. Each crossing triangle gives one segment whose ends are keyed by the mesh edge they lie on; outlines are chains of those keys (the meshes measure reads are closed, so every chain closes; drop an open chain). In the plane's `(x, z)` coordinates, pick the outline with an odd crossing count around the origin; if several nest, the innermost. Width and depth are its extents.

- [ ] **Step 4: Implement `limbFacts` and wire `measure`.** Use the meshes `measure` already has for the view (no extra build) and each sub-part's display pose matrix as `measure` already reads it (`probeSubPartPose` → `composePose`; a pose that is not trusted means that sub-part is skipped). A limb's frames are in part coordinates and the mesh in display coordinates: carry the frame by the matrix. Try sub-parts in declaration order and take the first whose outline goes round the joint.

- [ ] **Step 5: CLI text.** Under the existing sub-part lines, one block per limb: `index  mcp 42.1 mm  (hand: 86.2 × 24.0)   pip 24.0 mm  (hand: 17.9 × 16.2)  …`.

- [ ] **Step 6: Run the new tests, `test/oracle-*.test.js` and the measure tests, expect PASS.** Run `node bin/cli.js measure src/parts/cage-hand.js` and put the limbs block in the report.

- [ ] **Step 7: Docs.** The measure report's field list gains `limbs`. kinematics.md "The report" and organic.md "Posing a cage with limbs" each say in two or three sentences what to read there: bone lengths against the real thing, and the body's size at each joint.

- [ ] **Step 8: Whole suite and lint, then commit.**

---

### Task 7: The hand's last read-through

**Files:**
- Modify: `src/parts/cage-hand.js`, `docs/domains/organic.md`, `test/cage-hand.test.js`

- [ ] **Step 1:** Read the hand top to bottom. Remove any helper, constant or comment the earlier tasks left unused or out of date (`cross`, `dot`, `squareTo`, `along`, `P0`, `REST` and `restLine` only if truly unused). Save the guard before, check after at 1e-6.
- [ ] **Step 2:** Add to `test/cage-hand.test.js`: the measure report's bone lengths for the thumb (`mcp` between 28 and 32, the bone from its pivot between 43 and 47) and the index's width across the knuckles (80 to 92), so a later edit that stretches the thumb or widens the hand fails a test.
- [ ] **Step 3:** In organic.md's bullets after the worked example, replace "Measure the bones, and the built body" with what the report now gives, and name `measure --ranges` where the bullets talk about poses that do not build.
- [ ] **Step 4:** Whole suite and lint, then commit. Report the hand's line count before this plan (344) and now.
