# k.implicit frame report: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `k.implicitFrames(spec)` returns a transformable frame set, and `partforge measure` writes it out as joint positions and axes plus approximate label boxes.

**Architecture:** There is one pure module, `src/framework/geometry/implicit/frame-report.js`:
- It validates and lowers the spec with the engine's own `validateSpec` and `lowerSpec`.
- It reads world frames from `resolveFrames`.
- It walks the lowered IR for labelled boxes.
- It keeps one accumulated affine 3×4 for the transforms applied to the set.

Both backends expose it as a kernel op, passing their registered `images`. `measure.js` duck-types the frame set by a plain-data marker and calls its `report()`.

**Tech Stack:** Plain ESM JS, vitest, Node 24 (`.nvmrc`; PATH-prefix `~/.nvm/versions/node/v24*/bin`).

**Spec:** `docs/superpowers/specs/2026-10-28-implicit-frame-report-design.md`

## Global Constraints

- Branch `feat/implicit-frame-report`, off `feat/implicit`. No version bump: `feat/implicit` stays unreleased.
- Pure: no clock, no kernel state, no meshing. The same spec and transforms give byte-identical JSON on every machine and backend.
- Recognised by a plain-data marker (`_frameSet: 1`), never `instanceof`, a module-scoped `Symbol()` or a `WeakMap`.
- Every reported number is rounded to 0.001, and −0 is written as 0.
- Frames stay plain `{ parent, at, rotate }` data. Labels come from IR node boxes, never from primitive kinds.
- Sugar comes from `solid-sugar.js`'s `SUGAR` object, never from a copy.
- `frame-report.js` imports nothing from `src/framework/core/`, `oracle/` or three.js. `test/worker-layering.test.js` stays green.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit `hand-dev.html`, `src/app-hand-dev.js`, `src/hand-dev-worker.js` or `src/hand-dev-part.js`. Stage explicitly.

## Rulings on spec gaps (made while planning)

- **Lint:** the spec says lint "runs it as is". In fact lint's probe kernel answers every `KERNEL_OPS` name with its solid proxy, so `k.implicitFrames(...)` and any transforms chain on the proxy. That is enough for "no `probe-throws`", and it is the same treatment `k.implicit` gets. Task 2 corrects the spec sentence.
- **Transform errors:** only `scale`'s check is shared Solid code (in `addSugar`). The frame set throws the same text for it, `scale: factor must be > 0`. For an unknown mirror plane it throws `mirror: unknown plane "<p>" (use "XY"|"XZ"|"YZ")`. The sugar errors are shared verbatim because the sugar itself is shared.
- **Labels inside distorting nodes.** Under a `warp`, `round`, `onion` or `displace` ancestor, a labelled node's own box no longer bounds what it becomes. Its reported box is therefore the box of the OUTERMOST such ancestor, so the spec's "always contains" stays true.
- **Labels inside mirrors and repeats.** A label inside a `mirror` node reports both copies. A label inside a `repeat` reports every instance. Both are unioned under the duplicate-label rule.

## Review Focus

1. **A label inside a `repeat` or `mirror`.** The box must cover every copy, not just the first. Pinned in Task 1 (`labels cover repeat instances and mirror copies`).
2. **A label under a `twist`/`bend`/`round`.** The box must still contain the warped or rounded shape. Pinned in Task 1 (`labels under a warp or round report the outer distorting box`).
3. **A spec using `detail` textures or `expr` textures with images declared.** It must report on both backends, not throw "unknown image". Pinned in Task 2 (`implicitFrames sees the kernel's registered images`).
4. **A probe that wraps the frame set in an object** (`{ hand: frames, n: 3 }`). It must report whole and not hit the depth cap. Pinned in Task 3 (`a frame set nested in a probe object reports whole`).
5. **`scale` then `mirror` then `rotate` in any order.** Axes stay unit length and orthogonal, and `mirrored` tracks parity. Pinned in Task 1 (`axes stay unit after scale and mirror`).

---

### Task 1: The frame set (pure module)

**Files:**
- Create: `src/framework/geometry/implicit/frame-report.js`
- Modify: `src/framework/geometry/solid-sugar.js` (export `SUGAR`), `src/framework/geometry/implicit/ir.js` (export `boxXform`)
- Test: `test/implicit-frame-report.test.js` (new, no kernel boot)

**Interfaces:**
- Produces: `implicitFrames(spec, { images = new Map() } = {}) → FrameSet`.
  - A `FrameSet` is a frozen object carrying `_frameSet: 1` plus methods:
    - `translate(v)`;
    - `rotate(deg, center = [0,0,0], axis = [0,0,1])`, with Solid's argument order;
    - `mirror(plane)`, where plane is `"XY"|"XZ"|"YZ"` (normal z / y / x, through the origin, as Manifold's `PLANE_NORMAL`);
    - `scale(factor, center = [0,0,0])`, uniform;
    - the six `SUGAR` methods;
    - `report() → { frames, labels, mirrored }`, the JSON shape in the spec.
  - Each transform returns a new FrameSet.
- Produces: `export const SUGAR` from `solid-sugar.js` (no behaviour change), and `export function boxXform(b, M)` from `ir.js`.

- [ ] **Step 1: Write the failing tests** in `test/implicit-frame-report.test.js`:
  - `frames match resolveFrames before any transform`. For `handSpec(HAND_POSES.fist)` (from `test/fixtures/implicit-trees.js`):
    - `Object.keys(report().frames)` equals `Object.keys(spec.frames)`, in declaration order;
    - each origin equals `resolveFrames(spec.frames).get(name).world` columns 9–11, rounded;
    - each x/y/z equals the matrix's columns 0/1/2 (`[M[0],M[3],M[6]]` etc.), rounded.
  - `transforms move origins as points and axes as directions`. On `f.rotateY(180).translate([1,2,3])`, `index.tip`'s origin equals (−x+1, y+2, −z+3) of the untransformed origin, and its x axis equals (−x, y, −z).
  - `axes stay unit after scale and mirror`. After `.scale(2,[5,0,0]).mirror("XY").rotate(30,[0,0,0],[1,1,0])`, every axis has length 1 ± 0.001, axes are pairwise orthogonal within 0.001, `mirrored === true`, and `x × y ≈ −z`. A second `.mirror("YZ")` gives `mirrored === false` and `x × y ≈ z`.
  - `sugar matches primitives`:
    - `rotateX(a)` equals `rotate(a,[0,0,0],[1,0,0])`, and likewise Y and Z;
    - `rotateAbout({axis:"Y",deg:40,through:[1,2,3]})` equals `rotate(40,[1,2,3],[0,1,0])`;
    - `along("+X")` equals `rotate(90,[0,0,0],[0,1,0])`;
    - `at(v)` equals `translate(v)`;
    - all compared by `report()` deep-equality;
    - also assert `f.rotateX === SUGAR.rotateX`.
  - `labels: boxes contain their pieces`. Use spec `{ root: { kind: "union", children: [ { kind: "sphere", r: 5, at: [10,0,0], label: "a" }, { kind: "box", size: [4,4,4], at: [-10,0,0], label: "b" } ] } }`. Check that `a` is `{ min: [5,-5,-5], max: [15,5,5], center: [10,0,0], approximate: true }`, and that after `.translate([0,0,7])` both boxes move by 7 in z.
  - `duplicate labels report the union of their boxes`. Two spheres labelled `"x"` at ±10 give min x −15 and max x 15.
  - `labels cover repeat instances and mirror copies`:
    - a labelled sphere r 2 inside `repeat` `linear: { count: 3, step: [10,0,0] }` reports max x 22;
    - a labelled sphere r 2 at `[10,0,0]` inside a `mirror` (plane `"yz"`) reports min x −12 and max x 12.
  - `labels under a warp or round report the outer distorting box`. A labelled box inside a `twist` reports exactly the twist node's box. A labelled sphere under `round` r 1 reports a box padded by at least 1.
  - `no frames reports {}`. `{ root: { kind: "sphere", r: 1 } }` gives `frames: {}`, `labels: {}`, `mirrored: false`.
  - `rounding and negative zero`. Every number in `report()` of the fist hand after `.rotateY(180)` satisfies `Math.round(v*1000)/1000 === v` and `!Object.is(v,-0)`.
  - `bad spec throws the k.implicit error`. `implicitFrames({ frames: { a: { parent: "nope" } }, root: { kind: "sphere", r: 1 } })` throws an `ImplicitSpecError` whose message equals the one `compileImplicit` throws for the same spec.
  - `bad transform arguments`:
    - `.scale(0)` throws `scale: factor must be > 0`;
    - `.mirror("Q")` throws `mirror: unknown plane "Q" (use "XY"|"XZ"|"YZ")`;
    - `.along("up")` throws the `SUGAR` text.
  - `immutable and deterministic`:
    - `Object.isFrozen(f)`;
    - `f.translate([1,0,0])` leaves `f.report()` unchanged;
    - `JSON.stringify` of two independent calls is equal;
    - it is still equal with `setCoreEnabled(false)` (from `src/framework/core/core.js`), restored in `finally`.

- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run test/implicit-frame-report.test.js`. Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement `implicitFrames` in `frame-report.js`.**
  - Call `validateSpec(spec, { imageNames: new Set(images.keys()) })`, then `lowerSpec(spec, { images })`. Don't import `index.js`, which pulls in the native core.
  - Use `resolveFrames(spec.frames ?? {})` for world frames, iterated in `Object.keys(spec.frames ?? {})` order.
  - Store the transform as a general 3×4 `A`, starting at `IDENTITY`. Each transform pre-composes, `A' = compose(T, A)`:
    - rotate is `translation(c) ∘ rotation(axis, deg) ∘ translation(−c)`;
    - mirror is a diagonal with −1 on the plane's normal axis;
    - scale is `translation(c) ∘ diag(s) ∘ translation(−c)`.
  - Keep a `mirrored` parity bit.
  - In the report:
    - origin = `xformPoint(A, ·)`;
    - axis = normalise(`xformDir(A, ·)`), which is valid because every transform is a similarity;
    - label box = `boxXform(worldBox, A)`, center = midpoint;
    - round each number with `r = (v) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; }`.
  - World label boxes are computed once at construction by this walk, the one algorithm the tests don't fully determine:

    ```js
    // node.box is in its PARENT's space; node.inv maps parent→local (null = identity).
    // Wp: parent space → part space. `outer`: the box of the outermost distorting ancestor, in part space.
    function walk(id, Wp, outer) {
      const n = nodes[id];
      const own = boxXform(n.box, Wp);
      const distorting = n.kind === "warp" || n.kind === "round" || n.kind === "onion" || n.kind === "displace";
      const o = outer ?? (distorting ? own : null);
      if (n.label != null) add(n.label, o ?? own);          // union into labels[n.label]
      const W = n.inv ? compose(Wp, invert(n.inv)) : Wp;    // n.inv is rigid (frames.js invert is valid)
      if (n.kind === "mirror") {                            // also visit the reflected copy
        const R = diag with −1 on axis n.axis;
        for (const c of n.children) { walk(c, W, o); walk(c, compose(W, R), o); }
      } else for (const c of n.children) walk(c, W, o);
    }
    walk(ir.root, IDENTITY, null);
    ```

    Check `mirror` in `src/framework/geometry/implicit/reference.js` for whether its reflection is about the node's local origin. Match it.
  - The `ref` nodes made by `repeat` carry their placement in `inv`, so the walk covers every instance with no special case.
  - Validate `scale` and `mirror` with the texts in the Rulings.
  - Build the object as `Object.freeze(Object.assign({ _frameSet: 1, translate, rotate, mirror, scale, report }, SUGAR))`.

- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run test/implicit-frame-report.test.js test/implicit-ir.test.js test/implicit-frames.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(implicit): frame set — joint frames and label boxes that transform like a Solid`.

### Task 2: The `k.implicitFrames` kernel op

**Files:**
- Modify: `src/framework/geometry/kernel.js` (`KERNEL_OPS`), `src/framework/geometry/manifold-backend.js` (next to `implicit:`), `src/framework/geometry/occt-backend.js` (next to its `implicit` stub, and in the returned kernel object), `docs/KERNEL-CONTRACT.md` (a row after `implicit`), `docs/superpowers/specs/2026-10-28-implicit-frame-report-design.md` (the lint sentence, per the Rulings)
- Test: `test/implicit-manifold.test.js`, `test/implicit-occt.test.js`, `test/lint-build.test.js`

**Interfaces:**
- Consumes: `implicitFrames(spec, { images })` from Task 1.
- Produces: `k.implicitFrames(spec) → FrameSet` on both backends.

- [ ] **Step 1: Write the failing tests:**
  - In `implicit-manifold.test.js`, `implicitFrames sees the kernel's registered images`:
    - register a 2×2 image via `k._registerImage({ name: "tex", digest: "d", width: 2, height: 2, data: Float32Array.of(0,1,1,0) })`. Match the data type the existing texture tests use; copy their registration;
    - then `k.implicitFrames(vaseSpec())` (or the existing textured spec those tests use) does not throw;
    - and its `report()` equals `implicitFrames(spec, { images })` called directly with the same image record.
  - In `implicit-manifold.test.js`, `label boxes contain the transformed pieces`:
    - for the two-piece `a`/`b` spec from Task 1, define `T = (x) => x.rotate(30,[0,0,0],[1,1,0]).translate([3,-2,5]).scale(1.5).mirror("XZ")`;
    - for each label, `k.implicit({ root: thatChildAlone, preview: 0.5 })` with `T` applied has a `boundingBox()` inside `T(k.implicitFrames(spec)).report().labels[label]`, within 0.05 mm on every side.
  - In `implicit-occt.test.js`, `implicitFrames runs on OCCT`: `k.implicitFrames(handSpec()).rotateY(180).report()` deep-equals the pure `implicitFrames(handSpec()).rotateY(180).report()`.
  - In `lint-build.test.js`, `a frame-set probe raises no probe-throws`: a part with `probes: { f: (k) => k.implicitFrames({ root: { kind: "sphere", r: 1 } }).rotateY(180).translate([0,0,1]) }` gives no `probe-throws`. Follow the file's existing probe test shape.
  - `test/kernel-contract.test.js` needs no new code. It fails on its own once the op is in `KERNEL_OPS` and the doc row is missing.

- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run test/implicit-manifold.test.js test/implicit-occt.test.js test/lint-build.test.js test/kernel-contract.test.js`. Expected: FAIL on the missing op.

- [ ] **Step 3: Implement.**
  - Add `"implicitFrames"` to `KERNEL_OPS`, after `"implicit"`, with a one-line comment: "the frame report — pure, no meshing, so both backends run it".
  - In both backends, write `implicitFrames: (spec) => implicitFrames(spec, { images })`. It is not cached, because it is cheap and holds no WASM.
  - Add the contract row: `` `implicitFrames(spec)` | **Unreleased (feat/implicit).** `` followed by one sentence: "where every named frame and labelled node of a `k.implicit` spec ends up, as a frame set with Solid's transform methods; meshes nothing; both backends; reported by `measure` probes."
  - Fix the spec's "lint's geometry-free probe … runs it as is" sentence to the Rulings wording.

- [ ] **Step 4: Run the tests and see them pass.** Run the Step 2 command plus `npx vitest run test/worker-layering.test.js test/probe.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(implicit): k.implicitFrames kernel op on both backends`.

### Task 3: Measure reports frame sets

**Files:**
- Modify: `src/framework/oracle/measure.js` (`resolveProbeValue`, and the comment block above `isSolid`), `docs/ERROR-PATTERNS.md`
- Test: `test/measure.test.js`, plus a new `test/implicit-frame-report-hand.test.js` (Manifold boot)

**Interfaces:**
- Consumes: the FrameSet marker `_frameSet: 1` and `report()` from Task 1, and `k.implicitFrames` from Task 2.

- [ ] **Step 1: Write the failing tests:**
  - In `measure.test.js`, `a probe returning a frame set reports its JSON`. A part (shaped like the existing probes fixture there) with `probes: { f: (k) => k.implicitFrames(spec).translate([0,0,2]) }`, where spec is the Task 1 `a`/`b` spec, gives `r.probes.f` deep-equal to the frame set's `report()`.
  - In `measure.test.js`, `a frame set nested in a probe object reports whole`. `probes: { g: (k) => ({ hand: { frames: k.implicitFrames(handSpec()) }, n: 3 }) }` gives `r.probes.g.hand.frames.frames["index.tip"].origin` as an array of 3 numbers, with no `error` anywhere in `r.probes.g`.
  - In `measure.test.js`, `a throwing frame-set probe reports error`. A spec with an unknown frame parent gives `r.probes.f.error` containing `unknown frame`.
  - In the new hand test, `fist: index fingertip lies inside the palm's label box`. With `const f = k.implicitFrames(handSpec(HAND_POSES.fist)).report()`, `f.frames["index.tip"].origin` lies within `f.labels.palm.min/max` on all three axes. If this fails on the real fixture, stop and report the numbers. It would mean the fixture's fist doesn't close, which is a finding, not a test to loosen.
  - In the new hand test, `the placement pattern keeps solid and frames together`. Use `place = (x) => x.rotateY(180)`, `hand = place(k.implicit(handSpec()))` and `lift = [0,0,-hand.boundingBox().min[2]]`. Then every label box of `place(k.implicitFrames(handSpec())).translate(lift).report()` has `min[2] >= -0.5`, the bottom resting on the bed within a preview grid.

- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run test/measure.test.js test/implicit-frame-report-hand.test.js`. Expected: the measure tests FAIL with "probe returned a function" or a depth error.

- [ ] **Step 3: Implement.**
  - In `resolveProbeValue`, before the `isSolid` check, add `if (isFrameSet(v)) return v.report();`.
  - Define `const isFrameSet = (v) => v !== null && typeof v === "object" && v._frameSet === 1 && typeof v.report === "function";` next to `isShape2D`, with a two-line comment in the style of `isShape2D`'s: a plain-data marker, because a host may hold two copies of this code.
  - Add one clause to the probe comment block: "a `k.implicitFrames` frame set by its report".
  - Add an ERROR-PATTERNS entry at the end, `## implicit-limbs-miss-target`, with the three-bullet shape the file uses:
    - **Symptom:** an implicit part's limbs miss what they should touch or grip (fingers miss the rod), with no build error.
    - **Cause:** frame placement worked out by hand through a chain of `{ parent, at, rotate }` rotations.
    - **Fix:** return `place(k.implicitFrames(spec))` from a probe, using the same placement function applied to the solid, and compare `measure`'s reported origins and axes against the target. Label boxes are approximate (generous).

- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run test/measure.test.js test/implicit-frame-report-hand.test.js test/oracle-entry.test.js test/worker-layering.test.js`, then the full `npm test`. Expected: all PASS, except the known CI "version" check, which isn't part of `npm test`.

- [ ] **Step 5: Commit** `feat(oracle): measure reports k.implicitFrames probes; error pattern for missed limbs`.
