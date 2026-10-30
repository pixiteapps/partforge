# Limb Split (Kinematics Domain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the limb helper built on `feat/implicit-limb` as two PRs.
- **PR A → `main`:** the kinematics domain (`partforge/kinematics`). It covers forward kinematics, `reach`, `grip` against a distance function or a plain primitive, solid placement, and the report. It also adds the core pieces the domain needs: rigid-transform maths, `SpecError`, and the rotation converters.
- **PR B → `feat/implicit`:** the implicit adapter (`flesh`, `attach`, `implicitDistance`, and the hand-fixture port).

**Architecture:** This follows the domain-modules design.
- A domain lives in `src/framework/domains/<id>/` with a plain-data `manifest.js` and an `index.js` entry, and is published as its own subpath.
- A domain imports core freely. Core never imports a domain, and a domain never imports another domain.
- Generic pieces move into core: the frame maths becomes `geometry/xform.js`, the error becomes `SpecError` in `geometry/errors.js`, and `geometry/rotations.js` holds the converters.
- `grip.around` is a function seam. It takes a signed distance function, or plain primitive data evaluated by the domain's own `shapes.js`. There is no registration hook.

**Tech Stack:** Plain ESM JavaScript, vitest, Node 24 (`export PATH=$(ls -d ~/.nvm/versions/node/v24*/bin | tail -1):$PATH`).

**Specs:**
- `docs/superpowers/specs/2026-10-29-limb-helper-design.md`, the limb behaviour, on `feat/implicit-limb`.
- `docs/superpowers/specs/2026-10-29-domain-modules-design.md`, the domain contract. It is in the worktree `.claude/worktrees/competent-rosalind-4367cc` and not yet committed, so read it from that file. Its "Kinematics: the first domain" section is binding here.
- Where the two specs differ on location, entry point or error class, the domain design wins.

**Source of the code:** branch `feat/implicit-limb` (head `cd502428`), in `src/framework/geometry/limb/{rotations,tree,core,solve,outputs}.js` and `test/limb-*.test.js`. Port that code; do not rewrite its behaviour. Every execution ruling recorded there stays in force:
- angles follow `order` positions;
- `farEnd = hi < 0 ? lo : hi`;
- `curl` uses the `a0 + curl·(farEnd − a0)` family;
- `reach` adds the second pitch branch, the snap, and the residual guard;
- `grip` uses 24 samples per segment, judges contact on the final pose, and reports `touching` and `gap`;
- skipped joints take the verdict of the joint that stopped the grip;
- `reach`/`grip` targets are never mirrored.

## Global Constraints

- **Purity.** No clock, no `Math.random`, fixed iteration counts. Use `hypot3` (`geometry/js-math.js`), never `Math.hypot`. Code must be DOM-free, `three`-free, `node:`-free and paper-free; `domains/kinematics/index.js`'s import closure is held to `test/worker-layering.test.js`'s rules.
- **Imports.** The domain imports only core (`geometry/xform.js`, `geometry/rotations.js`, `geometry/errors.js`, `geometry/js-math.js`). Nothing in `src/framework/` outside `domains/` imports `domains/kinematics/`. On PR A nothing imports `geometry/implicit/`, which does not exist on `main`.
- **Manifest and entry.** `manifest.js` and `index.js` run nothing on import. The manifest imports nothing from `lint/`, `lint/rules-verify.js` or `verify-metrics.js`, even transitively.
- **Exports.**
  - `limb` is exported from `partforge/kinematics` only, never from `partforge/geometry`.
  - `deg`, `rad`, `euler`, `toEuler` and `applyRotation` are exported from `partforge/geometry`.
- **Errors.** Errors are `SpecError` (core). Messages name the field and the fix, prefixed `limb "<name>".…` as today. Converter messages keep their exact text (`euler: …`).
- **Release.** PR A bumps `package.json` 0.170.0 → 0.171.0 (minor). PR B has no version bump, since `feat/implicit` stays unreleased. Never `npm publish`.
- **Git hygiene.**
  - Stage files explicitly, and never stage hand-dev files, `.superpowers/`, or scratch.
  - Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - PR bodies are brief and reader-friendly, and end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **No registry dependency.** `src/framework/domains/registry.js` does not exist yet; the modularity session is landing it on `main` separately. PR A must not depend on it. Whichever PR merges second adds the one registry line for kinematics.

## Branches and worktrees

- **PR A:** new branch `feat/kinematics` from `origin/main`, in a new worktree `.claude/worktrees/kinematics-main` (`git worktree add .claude/worktrees/kinematics-main -b feat/kinematics origin/main`, then `npm ci` there with Node 24). Every PR A task runs in that worktree.
- **PR B:** new branch `feat/implicit-kinematics` from `origin/feat/implicit`, with `feat/kinematics` merged in. Merging `feat/kinematics` also brings in every `main` commit that `feat/implicit` has not merged yet. So until PR A lands on `main` and `main` is merged into `feat/implicit`, PR B's diff shows PR A's files and that backlog. Open it as a draft that says so. Resolve any merge conflicts in that merge commit and run the full suite before Task B1. It runs in this worktree (`sharp-swanson-0daccb`), after switching from `feat/implicit-limb` with `git switch -c feat/implicit-kinematics origin/feat/implicit`.
- **`feat/implicit-limb`** stays as the source until both PRs are open. It is never pushed or merged.

## Rulings on the specs (decided while planning)

1. **`posed.frames` ships in PR A.** It is plain `{ parent, at, rotate }` data in core's shared frame shape, and `place`/`world` are built on it. `flesh()` and `attach()` wait for PR B (Scott, 2026-10-29: keep them off `main` until the implicit grammar is released).
2. **`SpecError(message, { field, issues } = {})`.**
   - Its `name` is `"SpecError"` and its `code` is `"SPEC"`.
   - `issues` defaults to `[message]`.
   - `xform.resolveFrames` throws it with `issues` set to the list of frame problems, the same strings `implicit/frames.js` produces today but without the `implicit: ` prefix.
   - In PR B, `ImplicitSpecError` extends `SpecError` and keeps its `code: "IMPLICIT_SPEC"`, its `implicit: ` message prefix and its `issues`. `implicit/frames.js` re-exports `xform.js` and wraps `resolveFrames` to rethrow a `SpecError` as `ImplicitSpecError(e.issues)`, because `grammar.js` matches on `code === "IMPLICIT_SPEC"`.
3. **The `shapes.js` vocabulary is exactly:** sphere, ellipsoid, capsule, box (with `round`), cylinder (with `round`, `axis`), torus (`axis`), tube, halfspace, plus `union` with no `k` (or `k: 0`) of those.
   - The field names and defaults are the k.implicit grammar's (`implicit/grammar.js` `NODE_KINDS` on `feat/implicit`).
   - The formulas are the closed forms in `implicit/primitives.js` with the parameter packing that `implicit/ir.js` uses: axis orientation, capsule `a` defaulting to the origin, `r` as a number or a two-element taper.
   - Read both files with `git show origin/feat/implicit:src/framework/geometry/implicit/<file>`.
   - A `frame` field is still an error. Any other kind, or a `union` with `k > 0`, throws `` limb "<name>".grip.around: node kind "<kind>" needs the implicit engine — pass a distance function (implicitDistance(node) on feat/implicit makes one) ``. The "union with k" case says `a blended union needs the implicit engine — …`.
4. **`grip.around` as a function.** A distance function is called as `around(x, y, z)` and must return a finite number (signed mm, negative inside). A non-finite return throws `grip.around: distance function returned a non-finite value at [x, y, z]`. Batch evaluation stays an internal detail: `shapes.js` exposes `distanceFor(node) → (x, y, z) => mm`, and the solver calls one function either way.
5. **Tests that need implicit move to PR B:**
   - the fixture port (`test/limb-port.test.js`);
   - the `world` vs `k.implicitFrames` comparison;
   - the `flesh`/`attach` tests.

   PR A's grip tests use their own finger constants, copied from the fixture's index finger (`mcp [-30, 96, 2]`, `len [42, 25, 22]`, `r [9.5, 8.5, 7.4, 6.4]`) as literals in the test. They run against both a cylinder primitive and an equivalent distance function.
6. **The limb spec's "Constraints" and "Docs" lines** about file layout and the `partforge/geometry` export are amended in PR A to the domain layout. Reference the domain design; do not rewrite the spec.

## Review Focus

1. **The import closure on `main`.** `import("partforge/kinematics")` in a plain Node process must load without `geometry/implicit/`, DOM or `three`. A transitive import left over from the port would break `main` at import time. Test in Task A4.
2. **The `shapes.js` sign and axis conventions.** A cylinder or torus with `axis: "x"` placed `at` an offset must give the same distance as the implicit engine. A transposed axis would make `grip` close on an invisible rod. Test in Task A3 against hand-computed values, and in Task B1 against the engine.
3. **A distance function that throws, or returns NaN, mid-grip.** It must surface as a `SpecError` that names `grip.around`, never as a NaN pose. Test in Task A3.
4. **`resolveFrames` errors after the move.** On `feat/implicit`, a spec with a frame cycle must still throw `ImplicitSpecError` with the same message and `issues` as before. Test in Task B1, which reruns the existing implicit grammar tests.
5. **The fast path for the reference part.** `robot-finger.js`'s links must stay `trusted` with a stable `baseHash` across `curl`. Test in Task A5.

---

## PR A — `feat/kinematics` → `main`

### Task A1: Core pieces (xform, SpecError, rotations)

**Files:**
- Create: `src/framework/geometry/xform.js`, `src/framework/geometry/rotations.js`
- Modify: `src/framework/geometry/errors.js` (add `SpecError`), `src/framework/geometry/polygon.js` (export the converters), `types/geometry.d.ts` (converter types + `RotateStep`), `docs/KERNEL-CONTRACT.md` (the bullet naming the converters), `docs/superpowers/specs/` (copy in `2026-10-29-limb-helper-design.md` from `feat/implicit-limb`, with Ruling 6's amendment), `docs/superpowers/plans/` (copy in this plan)
- Test: `test/xform.test.js`, `test/rotations.test.js`

**Interfaces:**
- **`xform.js`** has the same signatures as `implicit/frames.js` on `feat/implicit`: `IDENTITY`, `compose(A, B)`, `invert(M)`, `translation(t)`, `axisVector(axis)`, `rotation(axis, deg)`, `xformPoint(out, M, x, y, z)`, `xformDir(out, M, x, y, z)`, `resolveFrames(frames) → Map<name, { world, inv }>`. Errors follow Ruling 2.
- **`rotations.js`** is the limb branch's `limb/rotations.js` (`deg`, `rad`, `euler`, `toEuler`, `applyRotation`, `stepsMatrix`, `axisAngle`), importing `xform.js` and throwing `SpecError` with the same messages.

- [ ] **Step 1: Write the failing tests.**
  - `test/rotations.test.js` is `test/limb-rotations.test.js` from the limb branch, re-pointed at `geometry/rotations.js`. Its error assertions expect `SpecError` instead of `ImplicitSpecError`.
  - `test/xform.test.js` covers:
    - `compose`/`invert` round-trip a random rigid transform to 1e-12;
    - `rotation("z", 90)` maps `[1, 0, 0]` to `[0, 1, 0]`;
    - `resolveFrames` resolves a three-level chain to the product of its locals;
    - an unknown parent and a cycle each throw `SpecError` with `issues` naming the frame;
    - `axisVector([0, 0, 0])` throws.
- [ ] **Step 2: Run** `npx vitest run test/rotations.test.js test/xform.test.js`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - Port `xform.js` from `git show origin/feat/implicit:src/framework/geometry/implicit/frames.js`, swapping the error class.
  - Port `rotations.js` from the limb branch.
  - Add `SpecError`.
  - Export the converters from `polygon.js` and declare them in `types/geometry.d.ts`.
  - Add the KERNEL-CONTRACT bullet (converters only; `limb` is not on `partforge/geometry`).
  - Copy in the spec and this plan.
- [ ] **Step 4: Run** `npx vitest run test/rotations.test.js test/xform.test.js test/kernel-contract.test.js test/types-surface.test.js test/worker-layering.test.js` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(geometry): rigid-transform core, SpecError, rotation converters`.

### Task A2: The kinematics domain (structure, pose, reach, frames, place/world)

**Files:**
- Create: `src/framework/domains/kinematics/{manifest.js,index.js,tree.js,core.js,solve.js,outputs.js}`
- Test: `test/kinematics-core.test.js`, `test/kinematics-reach.test.js`, `test/kinematics-outputs.test.js`

**Interfaces:**
- **`manifest.js`** default-exports the domain design's manifest with:
  - `id: "kinematics"`, `title: "Kinematics"`;
  - `when: "jointed limbs, fingers, arms, robot hands; posing links about joints; reach and grip"`;
  - `subpath: "partforge/kinematics"`, `guide: "docs/domains/kinematics.md"`, `referenceParts: ["src/parts/robot-finger.js"]`;
  - `kernelOps: []`, `lintRules: []`, `oracle: { facts: null, metrics: {}, checks: [] }`, `processes: []`, `workerSafe: true`.
- **`index.js`:** `export { limb } from "./core.js";`.
- **The posed limb** has: `values`, `frames`, `joints`, `tip`, `report`, `place(x, joint?)`, `world(joint?)`. There are no `flesh`/`attach` (Ruling 1).
- **Grip** is handled in Task A3. This task's `core.js` keeps the grip validation but throws `grip: not implemented` until A3, and does not import `geometry/implicit/`.

- [ ] **Step 1: Write the failing tests.** Port `test/limb-core.test.js`, `test/limb-reach.test.js` and `test/limb-outputs.test.js`:
  - re-point them at `domains/kinematics/index.js`;
  - expect `SpecError`;
  - drop the `world` vs `k.implicitFrames` comparison, the `flesh`/`attach` tests and any fixture import (Ruling 5).
  - Keep the Manifold "one pose, two engines" placement test, the mirrored-place test and the fast-path test (`probePoses` + `lintPart`; the test part imports `limb` from `domains/kinematics/index.js`).
- [ ] **Step 2: Run** `npx vitest run test/kinematics-*.test.js`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Port `tree.js`, `core.js`, `solve.js` (reach plus the shared forward pass) and `outputs.js` (frames, report, place, world). Re-point imports at `geometry/xform.js`, `geometry/rotations.js` and `geometry/errors.js`. Add `manifest.js` and `index.js`.
- [ ] **Step 4: Run** `npx vitest run test/kinematics-*.test.js test/worker-layering.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kinematics): limb domain — joint tree, pose, reach, frames, place/world`.

### Task A3: `grip` with the function seam and `shapes.js`

**Files:**
- Create: `src/framework/domains/kinematics/shapes.js`
- Modify: `domains/kinematics/core.js`, `solve.js`, `outputs.js` (`report.grip`)
- Test: `test/kinematics-shapes.test.js`, `test/kinematics-grip.test.js`

**Interfaces:** `distanceFor(node) → (x, y, z) => number` (Ruling 3). `pose({ grip: { around, clearance = 0, r? } }, frames)`, where `around` is a function or a node (Ruling 4). `report.grip` is `{ joints: [{ joint, bend, touched }], touching, gap }`, as on the limb branch.

- [ ] **Step 1: Write the failing tests.**
  - **`kinematics-shapes.test.js`:** for each kind, three probe points (inside, on the surface, outside) against hand-computed distances, within 1e-9.
    - Cover `at` offsets and `axis: "x"`/`"y"` for cylinder and torus (Review Focus 2).
    - Cover a tapered capsule (`r: [3, 1]`) and a `round`ed box.
    - A plain union equals the min of its children.
    - `{ kind: "union", k: 2, … }`, `{ kind: "twist", … }` and a node with `frame` each throw their Ruling 3 message.
  - **`kinematics-grip.test.js`:** port `test/limb-grip.test.js` with the Ruling 5 constants.
    - Run each contact test twice: once with `around` as the cylinder node, once as `(x, y, z) => distanceFor(node)(x, y, z)`. Both must give identical reports.
    - Add Review Focus 3: a distance function that returns `NaN` near the finger throws `` grip.around: distance function returned a non-finite value ``, and one that throws has its error surface wrapped in a `SpecError` naming `grip.around`.
- [ ] **Step 2: Run** `npx vitest run test/kinematics-shapes.test.js test/kinematics-grip.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `shapes.js` from the closed forms (Ruling 3) and port `solveGrip`. The contact test calls the distance function per sample instead of `evalBatch`, keeping 24 samples per segment and the fixed 48 scan and 40 bisection steps.
- [ ] **Step 4: Run** `npx vitest run test/kinematics-*.test.js test/worker-layering.test.js`. Expected: PASS. The cost test (≤ 15 ms `cpuMs` per 3-joint grip) still holds.
- [ ] **Step 5: Commit** `feat(kinematics): grip on a distance function or a plain primitive (shapes.js)`.

### Task A4: Publish `partforge/kinematics`

**Files:**
- Modify: `package.json` (`exports["./kinematics"]`, `typesVersions`, `files` += `docs/domains/`, `version` 0.171.0), `test/types-surface.test.js` (`RUNTIME` row), `test/worker-layering.test.js` (walk `domains/kinematics/index.js`'s closure if the test does not already walk every subpath), `docs/ERROR-PATTERNS.md` (`## limb-links-hand-chained` in "# Core framework")
- Create: `types/kinematics.d.ts` (port the limb branch's limb types: `limb`, `Limb`, `PosedLimb` without `flesh`/`attach`, the joint, pose and report types; the converter types stay in `geometry.d.ts`)
- Test: `test/kinematics-entry.test.js`, plus a `test/lint-build.test.js` case

- [ ] **Step 1: Write the failing tests.**
  - **`kinematics-entry.test.js`:**
    - the import closure of `src/framework/domains/kinematics/index.js` contains no path under `geometry/implicit/`, `three`, `paper` or `node:` (Review Focus 1; reuse the import-graph walker `test/worker-layering.test.js` uses);
    - `import("partforge/kinematics")`, resolved through the package `exports`, yields a `limb` function;
    - the manifest has exactly the keys and values in A2's interface;
    - no file outside `src/framework/domains/` imports from `domains/kinematics/`.
  - **`lint-build.test.js`:** port the limb branch's lint case, importing `limb` from the kinematics entry. The part uses `grip` with a cylinder `around` in `derive`, a `curl` track and `place` in a view. Expect no `build-throws`, `probe-throws`, `derive-throws`, `unknown-kernel-op` or `animation-track-rebuilds`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the `package.json` entries, the `.d.ts`, the `RUNTIME` row and the ERROR-PATTERNS entry. The entry's symptom is that a solid finger's links separate or bend the wrong way when a joint param moves; its fix is `d.<limb>.place(s, joint)` from `partforge/kinematics`.
- [ ] **Step 4: Run** `npx vitest run test/kinematics-*.test.js test/lint-build.test.js test/types-surface.test.js test/worker-layering.test.js test/error-patterns.test.js test/kernel-contract.test.js` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kinematics): publish partforge/kinematics; types, lint coverage, error pattern; 0.171.0`.

### Task A5: Reference part, guide, index line

**Files:**
- Create: `src/parts/robot-finger.js`, `docs/domains/kinematics.md`
- Modify: `docs/AUTHORING-PARTS.md` (a "Domains" heading near the top with one line), `AGENTS.md` (parts list entry), `docs/superpowers/specs/2026-10-29-limb-helper-design.md` (Ruling 6 amendments, if not done in A1)
- Test: `test/robot-finger.test.js`

**Interfaces:** `robot-finger.js` follows `src/parts/laser-box.js`'s precedent: a fixture plus the guide's worked example, with no HTML page and no CI smoke entry. It has:
- three link sub-parts (`proximal`, `middle`, `distal`), each built at the origin along +Y as printed boxes with rounded pin bosses (simple geometry is fine);
- `derive` building `finger = limb("finger", { … joints mcp/pip/dip, dip follows pip 0.75 }).pose({ curl: p.curl })`;
- a `print` view laying the links flat and spaced;
- an `assembly` view placing each link with `d.finger.place(s, "<joint>")`;
- `defaults: { curl: 0.3 }`;
- `views.assembly.animations.close` with a `curl` track from 0 to 1.

- [ ] **Step 1: Write the failing test** `test/robot-finger.test.js`:
  - `lintPart` on the part reports no errors and no `animation-track-rebuilds`;
  - `probePoses(part, "assembly", { curl })` is trusted, with a stable `baseHash` across curl 0.1 and 0.9 for every link (Review Focus 5);
  - the part declares a `verify` block on its assembly view: no interpenetration between links (use the same assertion vocabulary other reference parts use); `verify` (`partforge/oracle`) passes it at `curl` 0 and 0.9;
  - every link's placed origin equals `finger.world("<joint>").origin`.
- [ ] **Step 2: Run** `npx vitest run test/robot-finger.test.js`. Expected: FAIL (part missing).
- [ ] **Step 3: Implement** the part. Write `docs/domains/kinematics.md` for an agent that has the core guide and nothing else, covering:
  - the import line;
  - joints (axis, range, follow, a zero-length two-axis base);
  - orientation words (`toward`, `bendToward`, `bend`/`curl`/`spread`/`twist`, with sign rules);
  - posing by goal (`reach` statuses, `grip` with a primitive or a function, and reading `touching`/`gap`/`touched`);
  - mirroring (inputs reflected, targets never);
  - solid placement with the fast-path rule (pose params read only in `derive`/`views`);
  - the report;
  - errors;
  - the worked example, `robot-finger.js`;
  - the deferred-minor notes: an unset joint whose range excludes 0 reports `clamped`; a joint with `hi = 0` has nothing to close toward, so author it with a flipped `bendToward`; the meaning of `touched` for skipped joints; and that grip closes base-first.

  Add the AUTHORING-PARTS "Domains" line (title, `when`, import line, guide path) and the AGENTS.md parts entry.
- [ ] **Step 4: Run** `npx vitest run test/robot-finger.test.js`, then the full suite `npm test > <workspace>/full-A.txt 2>&1` and read its tail. Expected: green. The known `contour-cleanup` "offset of text" load flake must pass when its file is run alone.
- [ ] **Step 5: Commit** `feat(kinematics): robot-finger reference part and the kinematics domain guide`.

### Task A6: Open PR A

- [ ] Push `feat/kinematics` and open a PR to `main`. The body is brief and reader-friendly (user-visible effects first, with the registry line and the PR B relationship in a short note), ending with the Claude Code line. Bind it with the ccd_pr tools and report its URL. Do not merge.

## PR B — `feat/implicit-kinematics` → `feat/implicit`

### Task B1: Implicit engine over core; `implicitDistance`

**Files:**
- Modify: `src/framework/geometry/implicit/errors.js` (`ImplicitSpecError extends SpecError`), `src/framework/geometry/implicit/frames.js` (re-export `xform.js` and wrap `resolveFrames`, Ruling 2), the module where `k.implicit`'s helpers are exported from `partforge/geometry` (add `implicitDistance(node, { images } = {}) → (x, y, z) => number`, wrapping `compileImplicit({ root: node })`, `fullDecision`, `emitProgram` and `evalBatch` for one point), `types/geometry.d.ts`, `docs/KERNEL-CONTRACT.md` (if `implicitDistance` must be named)
- Test: `test/implicit-distance.test.js`

- [ ] **Step 1: Write the failing tests.**
  - `implicitDistance` matches `domains/kinematics/shapes.js`'s `distanceFor` on every Ruling 3 primitive and a plain union, at 200 seeded points each, within 1e-9. The ellipsoid is compared as a bound: same sign, and both within 5% where |d| < 1.
  - `implicitDistance` works on a blended union and a `twist` (finite values; the sign is correct at a known inside and outside point).
  - `grip` with `around: implicitDistance(blendedNode)` touches.
  - `new ImplicitSpecError("x") instanceof SpecError` is true.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/implicit-distance.test.js test/implicit-*.test.js test/kinematics-*.test.js test/worker-layering.test.js test/types-surface.test.js test/kernel-contract.test.js`. Expected: PASS. The implicit grammar and frame-error tests (Review Focus 4) must be unchanged and green.
- [ ] **Step 5: Commit** `feat(implicit): engine over core xform/SpecError; implicitDistance for kinematics grip`.

### Task B2: Implicit adapter (`flesh`, `attach`) and the fixture port

**Files:**
- Create: `src/framework/domains/kinematics/implicit.js` (`flesh` and `attach` as on the limb branch, producing plain k.implicit nodes and importing nothing from `geometry/implicit/`)
- Modify: `domains/kinematics/outputs.js`/`core.js` (attach `flesh`/`attach` to the posed limb), `types/kinematics.d.ts`, `docs/domains/kinematics.md` (an "Organic bodies" section), `docs/ERROR-PATTERNS.md` (extend `implicit-limbs-miss-target` to lead with `grip`/`reach` and the report), `test/fixtures/implicit-trees.js` (`export` on `FINGERS`, `THUMB`, `FAN`, `HAND_DEFAULTS`)
- Test: port `test/limb-port.test.js` → `test/kinematics-port.test.js`; the `flesh`/`attach` and `world`-vs-`implicitFrames` tests into `test/kinematics-implicit.test.js`

- [ ] **Step 1: Write the failing tests** (ported).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the targeted tests, then `npm test`. Expected: green (with the same flake rule).
- [ ] **Step 5: Commit** `feat(kinematics): implicit adapter — flesh/attach; hand-fixture port bit-identical`.

### Task B3: Open PR B

- [ ] Push `feat/implicit-kinematics` and open a draft PR to `feat/implicit`. The body states that it depends on PR A (link it) and that its diff shrinks to the implicit adapter once PR A is on `main` and `main` is merged into `feat/implicit`. Bind it with the ccd_pr tools. Do not merge. Leave `feat/implicit-limb` in place for Scott to delete.
