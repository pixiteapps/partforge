# k.implicit PR 1 — grammar, compiler and JS engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `k.implicit` on the Manifold backend, backed by a complete pure-JS engine (validator, `expr` language, compiler to bytecode, batched pruned interpreter, sparse sampler, marching-tetrahedra mesher, mesh cleanup, surface detail), written so PR 2 can port it to C++ bit for bit.

**Architecture:** A spec (plain data) is validated, then lowered to an IR (a node table with per-node placement, bounds and Lipschitz factors). For each spatial block, an interval pass over the IR decides which subtrees can affect the block (a *decision tree*); the decision tree is emitted as a self-contained `Float64Array` program and run over the block's samples in batches. Surviving leaf blocks are meshed with marching tetrahedra, cleaned (edge collapse, tangential relaxation, projection onto the field), optionally detailed, and imported into Manifold once.

**Tech Stack:** Plain ESM JavaScript, vitest, manifold-3d 3.5.1 (already a dependency), Node 24.

**Spec:** `docs/superpowers/specs/2026-10-14-implicit-organic-parts-design.md` (this plan is PR 1 of the spec's §9 rollout: "Grammar, compiler, JS engine (evaluator, culling, mesher, cleanup), `k.implicit` on Manifold"). Background and the spike's lessons: `docs/research/organic-shapes.md` §7. The throwaway spike is commit `c0b5b5d3` on branch `claude/parametric-organic-shapes-86ef3a`; read its `src/framework/geometry/implicit.js` and `src/parts/hand-spike.js` with `git show c0b5b5d3:<path>` when a task says to.

## Global Constraints

- **Node 24.** `source nvm.sh` is blocked in agent shells; prefix every command with `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`. Commands below omit the prefix for brevity — always add it.
- **Branching:** work on `feat/implicit-1-js-engine`, branched from `feat/implicit`, which is branched from `origin/main`. PR 1 targets `feat/implicit`, never `main`. **No `package.json` version bump** in this PR (the bump rides the final `feat/implicit` → `main` PR).
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `npm publish`.
- **Engine purity:** every file under `src/framework/geometry/implicit/` is DOM-free, `three`-free, `node:`-free and side-effect-free (it loads in the geometry worker). No `Math.random`, clock or module-level mutable state that changes results.
- **Native-portable arithmetic (for PR 2's bit-identical C++):** code that runs per sample, per vertex or per texel may use only `+ − × ÷`, `Math.sqrt`, `Math.floor`, `Math.abs`, `Math.min`, `Math.max`, comparisons, `Math.imul`/integer bit ops, and partforge's own `hypot3`, `pfSin`, `pfCos`, `pfAtan2` from `src/framework/geometry/js-math.js`. **Never** `Math.hypot`, `Math.sin`, `Math.cos`, `Math.atan2`, `Math.exp`, `Math.pow` or `**` there. `Math.cos`/`Math.sin` are allowed only when computing constants at lowering time (frame and warp matrices), because those constants are handed to the native side as data.
- **Units are millimetres.** Defaults: `resolution` 0.6, `preview` 1.5 (spec §1).
- **Limits (spec §1):** textures ≤ 2048 px per side and ≤ 16 M texels per part; `expr` `for` loops have a literal bound of at most 16 iterations; `repeat` count 1–256.
- **Distances are negative inside.**
- **Deterministic order everywhere:** iterate arrays and `Map`s in insertion order; no sort without a deterministic tie-break. Equal inputs must give byte-identical meshes.

## Decisions this plan makes (spec refinements)

These are needed to make the spec's design exact or implementable; each is called out where it lands.

1. **Blends are n-ary and order-independent.** `union` = `m − (k/4)·Σ hᵢ²` over every child except the first arg-min, with `m` the minimum and `hᵢ = max(k − (dᵢ − m), 0)/k`. For two children this is *exactly* the spec's normalized quadratic smooth-min; for more it does not depend on child order, and a child at least `k` above the minimum contributes exactly `0` — which is what makes per-block pruning exact (Task 8). `intersect` mirrors it with the maximum; `subtract` is `intersect(base, −tools…)`.
2. **`frame` is absolute, `at` is relative.** A node with `frame: "f"` is evaluated in frame `f`'s world coordinates whatever its ancestors are; `at` offsets the node inside whichever frame applies (its own `frame`, else its parent's).
3. **`displace.by`** is an expr object `{ expr, uniforms?, textures? }` whose value is clamped to `[−1, 1]`; the surface moves by `amount × by`.
4. **Textures have no `channel` field**: registered `images` are single-channel 16-bit grids already. Texture `v` follows `heightfield`'s convention (row 0 of the image at `v = 0`).
5. **Shading:** the solid's original ID is registered with the existing `SMOOTH` shading policy. Field normals are computed by cleanup and used for surface detail.
6. **Empty results throw** a clear error (the kernel's convention for empty profiles), never an empty solid.
7. **Detail `radius`** is a compact support radius with falloff `(1 − r²/R²)²` (no `exp`).
8. **`repeat`** lowers to a hard (`k = 0`) union of `count` placed instances of one shared child, pruned per instance like any union.

## Review Focus

1. **An `expr` that divides by zero or takes `sqrt` of a negative** (NaN/±∞): expected to read as "outside" (a large positive value) for that formula alone, with no crash and no holes in other shapes. Test in Task 9.
2. **A shape that reaches the edge of the sampling grid** (a huge blend, a displacement past its declared box): the mesh must still close (watertight), and a warning says it was clipped. Test in Task 11.
3. **Tangent or touching primitives** (two spheres touching at one point, coincident box faces): the mesh must import into Manifold as a valid manifold. Test in Task 16.
4. **A grid far too large** (a 1000 mm sphere at 0.05 mm): a clear `IMPLICIT_SIZE` error before memory runs out, not a WebAssembly out-of-memory crash. Test in Task 10.
5. **An empty result** (everything subtracted away, or a shape thinner than the grid): a clear error naming `implicit`, not a crash inside Manifold. Test in Task 15.

---

## File structure

All new engine files live in `src/framework/geometry/implicit/` (one responsibility each):

| File | Responsibility |
|---|---|
| `errors.js` | `ImplicitSpecError` (code `IMPLICIT_SPEC`), `ImplicitSizeError` (code `IMPLICIT_SIZE`) |
| `noise.js` | integer lattice hash + trilinear value noise |
| `frames.js` | 3×4 rigid matrices; `resolveFrames` |
| `grammar.js` | `NODE_KINDS`, `DETAIL_KINDS`, `validateSpec` |
| `expr-parse.js` | GLSL-subset lexer + parser → AST |
| `expr-lower.js` | AST → typed scalar SSA ops; shared scalar function tables; `evalExprScalar` |
| `textures.js` | `makeTexture`, `sampleTexture`, `TEXTURE_LIMITS` |
| `primitives.js` | scalar SDFs, `unionN`/`intersectN`, point maps (xform, mirror, warps), `sanitize` |
| `ir.js` | `lowerSpec`: spec → IR (placement, bounds, Lipschitz, thin, detail entries, textures) |
| `reference.js` | `evalReference`: plain recursive tree-walker (the semantic oracle) |
| `interval.js` | `blockDecision`, `fullDecision`, `decisionKey` |
| `program.js` | `OP`, `emitProgram`, `runProgram`, `evalBatch` |
| `sparse.js` | `sampleField`: coarse-to-fine culling, per-leaf programs and samples |
| `mesher.js` | `meshStore`: marching tetrahedra with snap + Newton projection |
| `project.js` | `projectVertices`: per-leaf batched field evaluation for vertices |
| `cleanup.js` | `cleanupMesh`: edge collapse, relaxation, projection, normals |
| `detail.js` | `applySurfaceDetail`: local refinement + displacement |
| `index.js` | `IMPLICIT_DEFAULTS`, `compileImplicit`, `meshImplicit`, `implicitHashable` |

Modified: `src/framework/geometry/js-math.js` (add `pfSin`, `pfCos`, `pfAtan2`), `src/framework/geometry/mesh-build.js` (`manifoldFromWeldedMesh`), `src/framework/geometry/manifold-backend.js` (the op), `src/framework/geometry/occt-backend.js` (a clear "Manifold only" error), `src/framework/geometry/kernel.js`, `src/framework/geometry/op-options.js`, `types/kernel.d.ts`, `docs/KERNEL-CONTRACT.md`, `test/op-options.test.js`, `package.json` (a `bench:implicit` script only).

Tests (flat, the repo's convention): `test/implicit-*.test.js`, plus fixtures in `test/fixtures/implicit-trees.js`, and `scripts/bench-implicit.mjs`.

---

### Task 0: Branches

**Files:** none (git only).

- [ ] **Step 1: Create the feature branch and PR 1 branch from main**

```bash
git fetch origin
git switch -c feat/implicit origin/main
git cherry-pick 1ce2d21d            # the design spec
git checkout c0b5b5d3 -- docs/research/organic-shapes.md
git commit -m "docs: organic-shapes research notes (from the k.implicit spike)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git cherry-pick <sha of the commit that added this plan>
git switch -c feat/implicit-1-js-engine
```

(Find the plan's commit with `git log --oneline claude/parametric-organic-shapes-86ef3a -- docs/superpowers/plans`.)

- [ ] **Step 2: Install and baseline**

Run: `npm ci && npx vitest run test/kernel-contract.test.js test/op-options.test.js`
Expected: PASS (nothing changed yet).

---

### Task 1: Native-portable trig and noise

**Files:**
- Modify: `src/framework/geometry/js-math.js`
- Create: `src/framework/geometry/implicit/noise.js`
- Test: `test/implicit-math.test.js`

**Interfaces:**
- Produces: `pfSin(x: number): number`, `pfCos(x)`, `pfAtan2(y, x)` (in `js-math.js`); `latticeHash(i, j, l): number` in `[0, 1)`, `valueNoise(x, y, z): number` in `[−0.5, 0.5)` (in `implicit/noise.js`).

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-math.test.js
import { describe, test, expect } from "vitest";
import { pfSin, pfCos, pfAtan2 } from "../src/framework/geometry/js-math.js";
import { latticeHash, valueNoise } from "../src/framework/geometry/implicit/noise.js";

const grid = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

describe("partforge trig", () => {
  test("pfSin/pfCos track Math.sin/Math.cos to 1e-15 on [-1000, 1000]", () => {
    for (const x of grid(-1000, 1000, 20001)) {
      expect(Math.abs(pfSin(x) - Math.sin(x))).toBeLessThan(1e-15 * Math.max(1, Math.abs(x)));
      expect(Math.abs(pfCos(x) - Math.cos(x))).toBeLessThan(1e-15 * Math.max(1, Math.abs(x)));
    }
  });
  test("exact at the obvious points", () => {
    expect(pfSin(0)).toBe(0);
    expect(pfCos(0)).toBe(1);
    expect(pfSin(-0.5)).toBe(-pfSin(0.5));
  });
  test("pfAtan2 tracks Math.atan2 to 2e-16 relative over every quadrant", () => {
    for (const y of grid(-50, 50, 201)) for (const x of grid(-50, 50, 201)) {
      const want = Math.atan2(y, x), got = pfAtan2(y, x);
      expect(Math.abs(got - want)).toBeLessThanOrEqual(4e-16 * Math.max(1, Math.abs(want)));
    }
    expect(pfAtan2(0, -1)).toBe(Math.PI);
    expect(pfAtan2(1, 0)).toBe(Math.PI / 2);
    expect(pfAtan2(0, 0)).toBe(0);
    expect(Number.isNaN(pfAtan2(NaN, 1))).toBe(true);
  });
  test("trig is NaN on non-finite input (deterministic, no throw)", () => {
    expect(Number.isNaN(pfSin(Infinity))).toBe(true);
    expect(Number.isNaN(pfCos(NaN))).toBe(true);
  });
});

describe("noise", () => {
  test("latticeHash is in [0,1), deterministic and decorrelated", () => {
    const seen = new Set();
    for (let i = -20; i < 20; i++) for (let j = -20; j < 20; j++) {
      const v = latticeHash(i, j, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(latticeHash(i, j, 7)).toBe(v);
      seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(1590); // ~1600 distinct values
  });
  test("valueNoise is continuous and bounded", () => {
    let prev = valueNoise(0.3, 0.7, 1.1);
    for (let t = 0.001; t < 3; t += 0.001) {
      const v = valueNoise(0.3 + t, 0.7, 1.1);
      expect(v).toBeGreaterThanOrEqual(-0.5);
      expect(v).toBeLessThan(0.5);
      expect(Math.abs(v - prev)).toBeLessThan(0.01);
      prev = v;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-math.test.js`
Expected: FAIL — `pfSin` is not exported / `noise.js` not found.

- [ ] **Step 3: Implement**

Append to `src/framework/geometry/js-math.js`:

```js
// partforge's own sin/cos/atan2 for code the native core will mirror (the
// implicit engine's expr formulas, warps and surface detail). Math.sin & co. are
// not one function across engines or libms, so a C++ port could never match
// "the JS"; these are fdlibm's kernels — only + − × and floor, each rounded in
// order — so native/js_math.h can reproduce them bit for bit (PR 2 ports them).
// Accuracy: a few ulp for |x| below ~1e5 (one-step Cody–Waite reduction), which
// is all an implicit formula in millimetres needs; larger inputs stay
// deterministic, just less accurate.
const INVPIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
  S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
  S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
  C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
  C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
const kSin = (r) => { const z = r * r, v = z * r; return r + v * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6))))); };
const kCos = (r) => { const z = r * r; return 1 - (0.5 * z - z * (z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))))); };
const quadrant = (n) => ((n % 4) + 4) % 4;
export function pfSin(x) {
  const n = Math.floor(x * INVPIO2 + 0.5), r = (x - n * PIO2_1) - n * PIO2_1T, q = quadrant(n);
  return q === 0 ? kSin(r) : q === 1 ? kCos(r) : q === 2 ? -kSin(r) : -kCos(r);
}
export function pfCos(x) {
  const n = Math.floor(x * INVPIO2 + 0.5), r = (x - n * PIO2_1) - n * PIO2_1T, q = quadrant(n);
  return q === 0 ? kCos(r) : q === 1 ? -kSin(r) : q === 2 ? -kCos(r) : kSin(r);
}
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
  -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
  6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
  -3.65315727442169155270e-02, 1.62858201153657823623e-02];
function pfAtan(x) { // fdlibm s_atan.c
  const neg = x < 0;
  let ax = neg ? -x : x, id;
  if (ax < 0.4375) id = -1;
  else if (ax < 0.6875) { id = 0; ax = (2 * ax - 1) / (2 + ax); }
  else if (ax < 1.1875) { id = 1; ax = (ax - 1) / (ax + 1); }
  else if (ax < 2.4375) { id = 2; ax = (ax - 1.5) / (1 + 1.5 * ax); }
  else { id = 3; ax = -1 / ax; }
  const z = ax * ax, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  const r = id < 0 ? ax - ax * (s1 + s2) : ATANHI[id] - ((ax * (s1 + s2) - ATANLO[id]) - ax);
  return neg ? -r : r;
}
const PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16, PIO2 = 1.5707963267948965580e+00;
/** atan2 for the implicit engine. Both zeros give 0 (signed zeros are not distinguished). */
export function pfAtan2(y, x) {
  if (x !== x || y !== y) return NaN;
  if (x === 0) return y > 0 ? PIO2 : y < 0 ? -PIO2 : 0;
  const a = pfAtan(Math.abs(y / x));
  if (x > 0) return y < 0 ? -a : a;
  return y < 0 ? -(PI - (a - PI_LO)) : PI - (a - PI_LO);
}
```

Create `src/framework/geometry/implicit/noise.js`:

```js
// Integer lattice hash + trilinear value noise for implicit surface detail.
// Only Math.imul, xor/shift, and + − × floor on doubles — operations the native
// core reproduces exactly. Note for the C++ port: `i | 0` is ECMAScript ToInt32
// (wrap modulo 2^32), and `>>> 0` reads the bits as uint32.
export function latticeHash(i, j, l) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(l | 0, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

/** Trilinear value noise in [-0.5, 0.5), period-free, continuous. */
export function valueNoise(x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const ux = fade(x - fx), uy = fade(y - fy), uz = fade(z - fz);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
    acc += latticeHash(fx + dx, fy + dy, fz + dz) * w;
  }
  return acc - 0.5;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-math.test.js`
Expected: PASS. If the `pfAtan2` bound fails by a hair on a few points, loosen that one assertion to `8e-16` and note it in the commit message; do not loosen `pfSin`/`pfCos`.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/js-math.js src/framework/geometry/implicit/noise.js test/implicit-math.test.js
git commit -m "feat(implicit): native-portable sin/cos/atan2 and lattice noise

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Errors and frames

**Files:**
- Create: `src/framework/geometry/implicit/errors.js`, `src/framework/geometry/implicit/frames.js`
- Test: `test/implicit-frames.test.js`

**Interfaces:**
- Produces: `class ImplicitSpecError extends Error` (`.code = "IMPLICIT_SPEC"`, `.issues: string[]`, message `implicit: <issues joined by "; ">`); `class ImplicitSizeError` (`.code = "IMPLICIT_SIZE"`).
- Produces (frames.js): a matrix is a `Float64Array(12)` laid out `[r00 r01 r02 r10 r11 r12 r20 r21 r22 tx ty tz]`, applying `x' = r00·x + r01·y + r02·z + tx` (rows ditto). `IDENTITY`, `compose(A, B)` (apply B, then A), `invert(M)` (rigid), `translation([x,y,z])`, `rotation(axis, deg)`, `axisVector(axis): [x,y,z]` (unit; `"x"|"y"|"z"` or a vector), `xformPoint(out, M, x, y, z)`, `xformDir(out, M, x, y, z)` (no translation), `resolveFrames(frames) → Map<string, { world: Float64Array, inv: Float64Array }>`.

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-frames.test.js
import { describe, test, expect } from "vitest";
import { resolveFrames, xformPoint, xformDir, compose, invert, rotation, IDENTITY } from "../src/framework/geometry/implicit/frames.js";
import { ImplicitSpecError } from "../src/framework/geometry/implicit/errors.js";

const close = (a, b, eps = 1e-12) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));
const apply = (M, p) => { const o = [0, 0, 0]; xformPoint(o, M, p[0], p[1], p[2]); return o; };
const dir = (M, p) => { const o = [0, 0, 0]; xformDir(o, M, p[0], p[1], p[2]); return o; };

describe("frames", () => {
  test("rotation steps apply about the frame's OWN current axes, in order", () => {
    const f = resolveFrames({ a: { rotate: [{ axis: "z", deg: 90 }, { axis: "x", deg: 90 }] } }).get("a");
    close(dir(f.world, [1, 0, 0]), [0, 1, 0]);   // local x: Rx keeps it, Rz turns it to +y
    close(dir(f.world, [0, 1, 0]), [0, 0, 1]);   // local y: Rx turns it to +z, Rz keeps z
  });
  test("parent chains compose: child `at` is in the parent's rotated frame", () => {
    const fr = resolveFrames({
      p: { at: [10, 0, 0], rotate: { axis: "z", deg: 90 } },
      c: { parent: "p", at: [0, 5, 0] },
    });
    close(apply(fr.get("c").world, [0, 0, 0]), [5, 0, 0]);
  });
  test("inv is the inverse of world", () => {
    const f = resolveFrames({ a: { at: [1, 2, 3], rotate: [{ axis: [1, 1, 0], deg: 33 }, { axis: "y", deg: -71 }] } }).get("a");
    close(Array.from(compose(f.inv, f.world)), Array.from(IDENTITY));
    close(Array.from(invert(invert(rotation("z", 40)))), Array.from(rotation("z", 40)));
  });
  test("unknown parents and cycles are spec errors naming the frame", () => {
    expect(() => resolveFrames({ a: { parent: "nope" } })).toThrow(ImplicitSpecError);
    expect(() => resolveFrames({ a: { parent: "nope" } })).toThrow(/frames\.a\.parent: unknown frame "nope"/);
    expect(() => resolveFrames({ a: { parent: "b" }, b: { parent: "a" } })).toThrow(/is its own ancestor/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-frames.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/errors.js
// The implicit engine's two error kinds. `code` is the stable handle hosts and
// lint match on; the message always starts with "implicit: ".
export class ImplicitSpecError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(`implicit: ${list.join("; ")}`);
    this.name = "ImplicitSpecError";
    this.code = "IMPLICIT_SPEC";
    this.issues = list;
  }
}

export class ImplicitSizeError extends Error {
  constructor(message) {
    super(`implicit: ${message}`);
    this.name = "ImplicitSizeError";
    this.code = "IMPLICIT_SIZE";
  }
}
```

```js
// src/framework/geometry/implicit/frames.js
// Rigid 3×4 transforms for the implicit engine, and the named frame tree.
// Layout: [r00 r01 r02 r10 r11 r12 r20 r21 r22 tx ty tz]; x' = r00·x + r01·y + r02·z + tx.
// Math.cos/Math.sin appear ONLY in `rotation` — lowering-time constants that the
// native port receives as data (see the plan's Global Constraints).
import { hypot3 } from "../js-math.js";
import { ImplicitSpecError } from "./errors.js";

export const IDENTITY = Object.freeze(Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0));

/** A∘B: apply B, then A. */
export function compose(A, B) {
  const o = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) o[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
    o[9 + i] = A[3 * i] * B[9] + A[3 * i + 1] * B[10] + A[3 * i + 2] * B[11] + A[9 + i];
  }
  return o;
}

/** Inverse of a rigid transform: Rᵀ, −Rᵀ·t. */
export function invert(M) {
  const o = new Float64Array(12);
  o[0] = M[0]; o[1] = M[3]; o[2] = M[6];
  o[3] = M[1]; o[4] = M[4]; o[5] = M[7];
  o[6] = M[2]; o[7] = M[5]; o[8] = M[8];
  for (let i = 0; i < 3; i++) o[9 + i] = -(o[3 * i] * M[9] + o[3 * i + 1] * M[10] + o[3 * i + 2] * M[11]);
  return o;
}

export const translation = (t) => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, t[0], t[1], t[2]);

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export function axisVector(axis) {
  const a = typeof axis === "string" ? AXES[axis] : axis;
  if (!a) throw new ImplicitSpecError(`unknown axis ${JSON.stringify(axis)}`);
  const l = hypot3(a[0], a[1], a[2]);
  if (!(l > 0)) throw new ImplicitSpecError(`axis ${JSON.stringify(axis)} has zero length`);
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function rotation(axis, deg) {
  const [x, y, z] = axisVector(axis);
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return Float64Array.of(
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
    0, 0, 0);
}

export function xformPoint(out, M, x, y, z) {
  out[0] = M[0] * x + M[1] * y + M[2] * z + M[9];
  out[1] = M[3] * x + M[4] * y + M[5] * z + M[10];
  out[2] = M[6] * x + M[7] * y + M[8] * z + M[11];
}

export function xformDir(out, M, x, y, z) {
  out[0] = M[0] * x + M[1] * y + M[2] * z;
  out[1] = M[3] * x + M[4] * y + M[5] * z;
  out[2] = M[6] * x + M[7] * y + M[8] * z;
}

/** A frame's local transform: translate(at), then each rotate step about the current axes. */
function localOf(def) {
  let M = translation(def.at ?? [0, 0, 0]);
  const steps = def.rotate == null ? [] : Array.isArray(def.rotate) ? def.rotate : [def.rotate];
  for (const r of steps) M = compose(M, rotation(r.axis ?? "z", r.deg ?? 0));
  return M;
}

/** Every frame's world transform (and inverse), resolved through the parent chain. */
export function resolveFrames(frames = {}) {
  const out = new Map();
  const visiting = new Set();
  const get = (name, from) => {
    if (out.has(name)) return out.get(name).world;
    const def = frames[name];
    if (!def) throw new ImplicitSpecError(`${from}: unknown frame "${name}"`);
    if (visiting.has(name)) throw new ImplicitSpecError(`frames.${name}: frame "${name}" is its own ancestor`);
    visiting.add(name);
    const parent = def.parent == null ? IDENTITY : get(def.parent, `frames.${name}.parent`);
    const world = compose(parent, localOf(def));
    visiting.delete(name);
    out.set(name, { world, inv: invert(world) });
    return world;
  };
  for (const name of Object.keys(frames)) get(name, `frames.${name}`);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-frames.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/errors.js src/framework/geometry/implicit/frames.js test/implicit-frames.test.js
git commit -m "feat(implicit): error types and the named frame tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Grammar validation

**Files:**
- Create: `src/framework/geometry/implicit/grammar.js`
- Test: `test/implicit-grammar.test.js`

**Interfaces:**
- Consumes: `ImplicitSpecError` (Task 2), `resolveFrames` (Task 2).
- Produces: `NODE_KINDS` (kind → `{ req, opt }` field-type maps), `DETAIL_KINDS` (same shape), `validateSpec(spec, { imageNames?: Set<string> }) → void` (throws one `ImplicitSpecError` listing every issue as `"<path>: <problem>"`, paths like `root.children[3].r`).

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-grammar.test.js
import { describe, test, expect } from "vitest";
import { validateSpec, NODE_KINDS } from "../src/framework/geometry/implicit/grammar.js";

const issues = (spec, opts) => { try { validateSpec(spec, opts); return []; } catch (e) { expect(e.code).toBe("IMPLICIT_SPEC"); return e.issues; } };

describe("validateSpec", () => {
  test("a good spec passes", () => {
    expect(issues({
      frames: { palm: {}, tip: { parent: "palm", at: [0, 10, 0], rotate: [{ axis: "x", deg: -20 }] } },
      root: { kind: "union", k: 2, children: [
        { kind: "sphere", r: 5, frame: "palm", label: "ball" },
        { kind: "capsule", frame: "tip", b: [0, 8, 0], r: [3, 2] },
        { kind: "repeat", linear: { step: [0, 0, 6], count: 4 }, child: { kind: "torus", R: 4, r: 1 } },
        { kind: "expr", box: [[-5, -5, -5], [5, 5, 5]], sdf: "return length(p) - 4.0;", lipschitz: 1 },
      ] },
      detail: [{ kind: "creases", frame: "tip", amplitude: 0.3, wavelength: 1.5, axis: "y" }],
      resolution: 0.5, preview: 1.5,
    })).toEqual([]);
  });
  test("every problem is reported with its exact path", () => {
    const got = issues({
      root: { kind: "union", children: [
        { kind: "sphere", r: -1 },
        { kind: "sphre", r: 1 },
        { kind: "box", size: [1, 2] },
        { kind: "sphere", r: 1, radius: 2 },
        { kind: "sphere", r: 1, frame: "missing" },
      ] },
      preview: 0,
    });
    expect(got).toContain("root.children[0].r: must be a number > 0");
    expect(got.some((m) => m.startsWith('root.children[1].kind: unknown kind "sphre"'))).toBe(true);
    expect(got).toContain("root.children[2].size: must be [x, y, z] with every value > 0");
    expect(got).toContain('root.children[3]: unknown field "radius"');
    expect(got).toContain('root.children[4].frame: unknown frame "missing"');
    expect(got).toContain("preview: must be a number ≥ 0.05");
  });
  test("missing root, repeat needing exactly one layout, tube radii length", () => {
    expect(issues({})).toContain("root: required");
    expect(issues({ root: { kind: "repeat", child: { kind: "sphere", r: 1 } } }))
      .toContain("root: repeat needs exactly one of `linear` or `polar`");
    expect(issues({ root: { kind: "tube", points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], r: [1, 1] } }))
      .toContain("root.r: needs one radius per point (3)");
  });
  test("texture images must be declared when imageNames is given", () => {
    const spec = { root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return 0.0;", textures: { skin: { image: "skinMap" } } } };
    expect(issues(spec, { imageNames: new Set(["skinMap"]) })).toEqual([]);
    expect(issues(spec, { imageNames: new Set() })).toContain('root.textures.skin.image: unknown image "skinMap" — declare it in the part\'s `images` field');
  });
  test("every documented kind has a schema", () => {
    for (const k of ["sphere", "ellipsoid", "capsule", "box", "cylinder", "torus", "tube", "halfspace",
      "union", "intersect", "subtract", "mirror", "round", "onion", "displace", "twist", "bend", "taper", "repeat", "expr"]) {
      expect(NODE_KINDS[k], k).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-grammar.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/grammar.js
// The k.implicit grammar as data, and the validator that turns a bad spec into
// one ImplicitSpecError listing every issue with its exact path. Expr SOURCE is
// checked later, when it is lowered (ir.js); everything structural is here.
import { ImplicitSpecError } from "./errors.js";
import { resolveFrames } from "./frames.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

// Field type → checker returning a problem string or null. Checkers that need to
// recurse receive (value, path, ctx).
const TYPES = {
  pos: (v) => (isNum(v) && v > 0 ? null : "must be a number > 0"),
  nonneg: (v) => (isNum(v) && v >= 0 ? null : "must be a number ≥ 0"),
  num: (v) => (isNum(v) ? null : "must be a finite number"),
  vec3: (v) => (isVec3(v) ? null : "must be [x, y, z]"),
  pos3: (v) => (isVec3(v) && v.every((c) => c > 0) ? null : "must be [x, y, z] with every value > 0"),
  axis: (v) => (v === "x" || v === "y" || v === "z" || (isVec3(v) && v.some((c) => c !== 0))
    ? null : 'must be "x", "y", "z" or a non-zero [x, y, z]'),
  axisName: (v) => (v === "x" || v === "y" || v === "z" ? null : 'must be "x", "y" or "z"'),
  radius: (v) => ((isNum(v) && v > 0) || (Array.isArray(v) && v.length === 2 && v.every((c) => isNum(c) && c > 0))
    ? null : "must be a number > 0 or [r0, r1] with both > 0"),
  tubeRadius: (v) => ((isNum(v) && v > 0) || (Array.isArray(v) && v.every((c) => isNum(c) && c > 0))
    ? null : "must be a number > 0 or one number > 0 per point"),
  points: (v) => (Array.isArray(v) && v.length >= 2 && v.every(isVec3) ? null : "must be at least two [x, y, z] points"),
  plane: (v) => (["yz", "xz", "xy"].includes(v) ? null : 'must be "yz", "xz" or "xy"'),
  string: (v) => (typeof v === "string" && v.length > 0 ? null : "must be a non-empty string"),
  source: (v) => (typeof v === "string" ? null : "must be a string of expr source"),
  size2: (v) => (Array.isArray(v) && v.length === 2 && v.every((c) => isNum(c) && c > 0) ? null : "must be [u, v] with both > 0"),
  taperEnd: (v) => (Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[1] > 0 ? null : "must be [position, scale] with scale > 0"),
  box: (v) => (Array.isArray(v) && v.length === 2 && isVec3(v[0]) && isVec3(v[1]) && v[0].every((c, i) => c < v[1][i])
    ? null : "must be [[minX, minY, minZ], [maxX, maxY, maxZ]] with min < max"),
  projection: (v) => (["planar", "cylindrical", "triplanar"].includes(v) ? null : 'must be "planar", "cylindrical" or "triplanar"'),
  uniforms: (v) => (isObj(v) && Object.values(v).every(isNum) ? null : "must be an object of finite numbers"),
  child: (v, path, ctx) => { if (!isObj(v)) return "must be a node object"; walkNode(v, path, ctx); return null; },
  children: (v, path, ctx) => {
    if (!Array.isArray(v) || v.length === 0) return "must be a non-empty array of nodes";
    v.forEach((c, i) => (isObj(c) ? walkNode(c, `${path}[${i}]`, ctx) : ctx.issues.push(`${path}[${i}]: must be a node object`)));
    return null;
  },
  textureMap: (v, path, ctx) => {
    if (!isObj(v)) return "must be an object of { image } entries";
    for (const [name, t] of Object.entries(v)) {
      if (!isObj(t) || typeof t.image !== "string") { ctx.issues.push(`${path}.${name}: must be { image: "<name>" }`); continue; }
      if (ctx.imageNames && !ctx.imageNames.has(t.image)) {
        ctx.issues.push(`${path}.${name}.image: unknown image "${t.image}" — declare it in the part's \`images\` field`);
      }
    }
    return null;
  },
  exprSpec: (v, path, ctx) => {
    if (!isObj(v) || typeof v.expr !== "string") return "must be { expr: \"<source>\", uniforms?, textures? }";
    if (v.uniforms != null) { const p = TYPES.uniforms(v.uniforms); if (p) ctx.issues.push(`${path}.uniforms: ${p}`); }
    if (v.textures != null) TYPES.textureMap(v.textures, `${path}.textures`, ctx);
    return null;
  },
  linear: (v) => (isObj(v) && isVec3(v.step) && v.step.some((c) => c !== 0) && Number.isInteger(v.count) && v.count >= 1 && v.count <= 256
    ? null : "must be { step: [x, y, z] (non-zero), count: 1–256 }"),
  polar: (v) => (isObj(v) && Number.isInteger(v.count) && v.count >= 1 && v.count <= 256 && (v.axis == null || TYPES.axis(v.axis) === null)
    ? null : "must be { count: 1–256, axis? }"),
};

const COMMON = { frame: "string", at: "vec3", label: "string" };

export const NODE_KINDS = {
  sphere: { req: { r: "pos" } },
  ellipsoid: { req: { r: "pos3" } },
  capsule: { req: { b: "vec3", r: "radius" }, opt: { a: "vec3" } },
  box: { req: { size: "pos3" }, opt: { round: "nonneg" } },
  cylinder: { req: { h: "pos", r: "pos" }, opt: { round: "nonneg", axis: "axis" } },
  torus: { req: { R: "pos", r: "pos" }, opt: { axis: "axis" } },
  tube: { req: { points: "points", r: "tubeRadius" } },
  halfspace: { req: { normal: "axis" }, opt: { offset: "num" } },
  union: { req: { children: "children" }, opt: { k: "nonneg" } },
  intersect: { req: { children: "children" }, opt: { k: "nonneg" } },
  subtract: { req: { children: "children" }, opt: { k: "nonneg" } },
  mirror: { req: { child: "child" }, opt: { plane: "plane" } },
  round: { req: { child: "child", r: "pos" } },
  onion: { req: { child: "child", t: "pos" } },
  displace: { req: { child: "child", amount: "pos", by: "exprSpec" } },
  twist: { req: { child: "child", degPerMm: "num" }, opt: { axis: "axis" } },
  bend: { req: { child: "child", radius: "pos" }, opt: { axis: "axis", toward: "axis" } },
  taper: { req: { child: "child", from: "taperEnd", to: "taperEnd" }, opt: { axis: "axis" } },
  repeat: { req: { child: "child" }, opt: { linear: "linear", polar: "polar" } },
  expr: { req: { sdf: "source", box: "box" }, opt: { uniforms: "uniforms", textures: "textureMap", lipschitz: "pos" } },
};

const DETAIL_COMMON = { frame: "string", at: "vec3", radius: "pos", side: "axis" };
export const DETAIL_KINDS = {
  creases: { req: { amplitude: "num", wavelength: "pos" }, opt: { axis: "axisName" } },
  noise: { req: { amplitude: "num", wavelength: "pos" } },
  texture: { req: { image: "string", amplitude: "num", size: "size2" }, opt: { projection: "projection", axis: "axisName" } },
  expr: { req: { height: "source" }, opt: { uniforms: "uniforms", textures: "textureMap", wavelength: "pos" } },
};

function checkFields(obj, schema, common, path, ctx) {
  const known = { ...common, ...schema.req, ...(schema.opt ?? {}) };
  for (const key of Object.keys(obj)) {
    if (key === "kind") continue;
    if (!(key in known)) ctx.issues.push(`${path}: unknown field "${key}"`);
  }
  for (const [key, type] of Object.entries(known)) {
    const v = obj[key];
    if (v === undefined) { if (key in schema.req) ctx.issues.push(`${path}.${key}: required`); continue; }
    const problem = TYPES[type](v, `${path}.${key}`, ctx);
    if (problem) ctx.issues.push(`${path}.${key}: ${problem}`);
  }
}

function walkNode(node, path, ctx) {
  const schema = NODE_KINDS[node.kind];
  if (!schema) {
    ctx.issues.push(`${path}.kind: unknown kind ${JSON.stringify(node.kind)} (expected one of ${Object.keys(NODE_KINDS).join(", ")})`);
    return;
  }
  checkFields(node, schema, COMMON, path, ctx);
  if (typeof node.frame === "string" && !ctx.frameNames.has(node.frame)) ctx.issues.push(`${path}.frame: unknown frame "${node.frame}"`);
  if (node.kind === "repeat" && (node.linear == null) === (node.polar == null)) ctx.issues.push(`${path}: repeat needs exactly one of \`linear\` or \`polar\``);
  if (node.kind === "tube" && Array.isArray(node.r) && Array.isArray(node.points) && node.r.length !== node.points.length) {
    ctx.issues.push(`${path}.r: needs one radius per point (${node.points.length})`);
  }
  if (node.kind === "box" && isNum(node.round) && isVec3(node.size) && node.round > Math.min(...node.size) / 2) {
    ctx.issues.push(`${path}.round: must be at most half the smallest size (${Math.min(...node.size) / 2})`);
  }
  if (node.kind === "cylinder" && isNum(node.round) && isNum(node.r) && isNum(node.h) && node.round > Math.min(node.r, node.h / 2)) {
    ctx.issues.push(`${path}.round: must be at most min(r, h/2)`);
  }
}

export function validateSpec(spec, { imageNames = null } = {}) {
  const issues = [];
  if (!isObj(spec)) throw new ImplicitSpecError("expected an options object { frames?, root, detail?, resolution?, preview? }");
  const ctx = { issues, imageNames, frameNames: new Set() };
  if (spec.frames != null) {
    if (!isObj(spec.frames)) issues.push("frames: must be an object of named frames");
    else {
      for (const [name, f] of Object.entries(spec.frames)) {
        ctx.frameNames.add(name);
        if (!isObj(f)) { issues.push(`frames.${name}: must be { parent?, at?, rotate? }`); continue; }
        for (const key of Object.keys(f)) if (!["parent", "at", "rotate"].includes(key)) issues.push(`frames.${name}: unknown field "${key}"`);
        if (f.at != null && !isVec3(f.at)) issues.push(`frames.${name}.at: must be [x, y, z]`);
        const steps = f.rotate == null ? [] : Array.isArray(f.rotate) ? f.rotate : [f.rotate];
        steps.forEach((r, i) => {
          if (!isObj(r) || TYPES.axis(r.axis) !== null || !isNum(r.deg)) issues.push(`frames.${name}.rotate[${i}]: must be { axis, deg }`);
        });
      }
      if (issues.length === 0) {
        try { resolveFrames(spec.frames); } catch (e) { if (e.code === "IMPLICIT_SPEC") issues.push(...e.issues); else throw e; }
      }
    }
  }
  if (spec.root == null) issues.push("root: required");
  else if (!isObj(spec.root)) issues.push("root: must be a node object");
  else walkNode(spec.root, "root", ctx);
  for (const key of ["resolution", "preview"]) {
    if (spec[key] != null && !(isNum(spec[key]) && spec[key] >= 0.05)) issues.push(`${key}: must be a number ≥ 0.05`);
  }
  if (spec.detail != null) {
    if (!Array.isArray(spec.detail)) issues.push("detail: must be an array");
    else spec.detail.forEach((d, i) => {
      const path = `detail[${i}]`;
      const schema = isObj(d) && DETAIL_KINDS[d.kind];
      if (!schema) { issues.push(`${path}.kind: unknown detail kind ${JSON.stringify(d?.kind)} (expected one of ${Object.keys(DETAIL_KINDS).join(", ")})`); return; }
      checkFields(d, schema, DETAIL_COMMON, path, ctx);
      if (typeof d.frame === "string" && !ctx.frameNames.has(d.frame)) issues.push(`${path}.frame: unknown frame "${d.frame}"`);
      if (d.kind === "texture" && ctx.imageNames && !ctx.imageNames.has(d.image)) {
        issues.push(`${path}.image: unknown image "${d.image}" — declare it in the part's \`images\` field`);
      }
    });
  }
  for (const key of Object.keys(spec)) {
    if (!["frames", "root", "detail", "resolution", "preview"].includes(key)) issues.push(`${key}: unknown option`);
  }
  if (issues.length) throw new ImplicitSpecError(issues);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-grammar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/grammar.js test/implicit-grammar.test.js
git commit -m "feat(implicit): grammar schema and path-precise spec validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The `expr` language

**Files:**
- Create: `src/framework/geometry/implicit/expr-parse.js`, `src/framework/geometry/implicit/expr-lower.js`
- Test: `test/implicit-expr.test.js`

**Interfaces:**
- Consumes: `pfSin`, `pfCos` (Task 1).
- Produces (expr-parse.js): `class ExprError extends Error` (`.line`), `parseExpr(src) → AST` (statements array).
- Produces (expr-lower.js): `UN`, `BIN`, `TER` (name → scalar function tables, shared with the interpreter); `smin2(a, b, k)`, `smax2(a, b, k)`; `lowerExpr(ast, { uniforms?: object, textureSlots?: object }) → Lowered` where `Lowered = { ops: Op[], result: number, nregs: number }` and `Op` is one of `{op:"const",dst,val}`, `{op:"get",dst,comp}`, `{op:"un",fn,dst,a}`, `{op:"bin",fn,dst,a,b}`, `{op:"ter",fn,dst,a,b,c}`, `{op:"tex",dst,slot,u,v}`; `evalExprScalar(L, x, y, z, textures) → number`; `compileExprSource(src, opts) → Lowered` (parse + lower, errors as `ExprError`).
- `sampleTexture` is imported from `textures.js` (Task 5) — **Task 5 must exist before Task 4's `tex` op can run**; to keep tasks independent, `expr-lower.js` imports `sampleTexture` lazily via a parameter: `evalExprScalar(L, x, y, z, textures, sample)` where `sample(t, u, v)` is passed by callers. Task 7 and later pass `sampleTexture`.

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-expr.test.js
import { describe, test, expect } from "vitest";
import { compileExprSource, evalExprScalar } from "../src/framework/geometry/implicit/expr-lower.js";
import { ExprError } from "../src/framework/geometry/implicit/expr-parse.js";
import { pfSin, pfCos } from "../src/framework/geometry/js-math.js";

const run = (src, p = [0, 0, 0], opts = {}, textures = [], sample = () => 0) =>
  evalExprScalar(compileExprSource(src, opts), p[0], p[1], p[2], textures, sample);
const err = (src, opts) => { try { compileExprSource(src, opts); return null; } catch (e) { expect(e).toBeInstanceOf(ExprError); return e.message; } };

describe("expr language", () => {
  test("arithmetic, precedence, uniforms", () => {
    expect(run("return 1.0 + 2.0 * 3.0;")).toBe(7);
    expect(run("return (1.0 + 2.0) * 3.0;")).toBe(9);
    expect(run("return -p.x + k;", [2, 0, 0], { uniforms: { k: 5 } })).toBe(3);
  });
  test("vectors, swizzles, built-ins", () => {
    expect(run("return length(p) - 1.0;", [3, 4, 0])).toBe(4);
    expect(run("vec3 q = p.zyx; return q.x;", [1, 2, 3])).toBe(3);
    expect(run("vec2 a = vec2(3.0, 4.0); return length(a);")).toBe(5);
    expect(run("return dot(vec3(1.0, 2.0, 3.0), p);", [1, 1, 1])).toBe(6);
    expect(run("return cross(vec3(1.0,0.0,0.0), vec3(0.0,1.0,0.0)).z;")).toBe(1);
    expect(run("return clamp(p.x, 0.0, 1.0);", [5, 0, 0])).toBe(1);
    expect(run("return mix(2.0, 4.0, 0.25);")).toBe(2.5);
    expect(run("return mod(-1.0, 3.0);")).toBe(2);
    expect(run("return step(0.5, p.x);", [0.4, 0, 0])).toBe(0);
    expect(run("return smoothstep(0.0, 1.0, 0.5);")).toBe(0.5);
    expect(run("return fract(2.75);")).toBe(0.75);
    expect(run("return sin(p.x) + cos(p.y);", [0.3, 0.4, 0])).toBe(pfSin(0.3) + pfCos(0.4));
    expect(run("return smin(1.0, 1.0, 2.0);")).toBe(0.5);
    expect(run("return p.x > 0.0 && p.y > 0.0 ? 1.0 : -1.0;", [1, 1, 0])).toBe(1);
  });
  test("for loops unroll with a literal bound", () => {
    expect(run("float s = 0.0; for (int i = 0; i < 4; i++) { s += float(i); } return s;")).toBe(6);
    expect(err("float s = 0.0; for (int i = 0; i < 17; i++) { s += 1.0; } return s;")).toMatch(/at most 16 iterations/);
  });
  test("texture() calls the sampler with the slot and uv", () => {
    const seen = [];
    const v = run("return texture(skin, p.xy);", [0.25, 0.75, 0], { textureSlots: { skin: 3 } }, ["t0", "t1", "t2", "T3"],
      (t, u, w) => { seen.push([t, u, w]); return 0.5; });
    expect(v).toBe(0.5);
    expect(seen).toEqual([["T3", 0.25, 0.75]]);
  });
  test("errors name the line and the problem", () => {
    expect(err("float a = 1.0;\nreturn b;")).toMatch(/line 2: unknown name 'b'/);
    expect(err("return vec3(1.0);")).toMatch(/line 1: return must be a float, got vec3/);
    expect(err("return 1.0")).toMatch(/expected ';'/);
    expect(err("return texture(nope, p.xy);")).toMatch(/unknown texture 'nope'/);
    expect(err("float a = 1.0;")).toMatch(/must end with a return/);
    expect(err("return 1.0; return 2.0;")).toMatch(/code after return/);
    expect(err("return p.w;")).toMatch(/swizzle/);
    expect(err("return length(1.0, 2.0);")).toMatch(/length expects 1 argument/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-expr.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

```js
// src/framework/geometry/implicit/expr-parse.js
// A GLSL subset for implicit formulas (spec §1 "expr formulas"): float/vec2/vec3
// locals, arithmetic, comparisons, && || !, the ternary, swizzles, calls, and
// `for (int i = A; i < B; i++)` with literal bounds (unrolled by the lowerer).
export class ExprError extends Error {
  constructor(message, line) { super(`line ${line}: ${message}`); this.name = "ExprError"; this.line = line; }
}

const PUNCT = ["<=", ">=", "==", "!=", "&&", "||", "++", "+=", "+", "-", "*", "/", "(", ")", "{", "}", ",", ";", ".", "?", ":", "<", ">", "!", "="];
const NUM = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const ID = /^[A-Za-z_]\w*/;

function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    const rest = src.slice(i);
    let m = NUM.exec(rest);
    if (m) { toks.push({ k: "num", v: Number(m[0]), line }); i += m[0].length; continue; }
    m = ID.exec(rest);
    if (m) { toks.push({ k: "id", v: m[0], line }); i += m[0].length; continue; }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (p) { toks.push({ k: "p", v: p, line }); i += p.length; continue; }
    throw new ExprError(`unexpected character '${c}'`, line);
  }
  toks.push({ k: "eof", v: "", line });
  return toks;
}

const TYPE_NAMES = new Set(["float", "vec2", "vec3"]);

export function parseExpr(src) {
  const toks = lex(src);
  let pos = 0;
  const peek = (o = 0) => toks[pos + o];
  const next = () => toks[pos++];
  const isP = (v, o = 0) => peek(o).k === "p" && peek(o).v === v;
  const isId = (v) => peek().k === "id" && peek().v === v;
  const expect = (v) => {
    if (!(isP(v) || isId(v))) throw new ExprError(`expected '${v}' but found '${peek().v || "end of source"}'`, peek().line);
    return next();
  };
  const ident = () => {
    const t = next();
    if (t.k !== "id") throw new ExprError(`expected a name but found '${t.v || "end of source"}'`, t.line);
    return t.v;
  };
  const intLit = () => {
    const t = next();
    if (t.k !== "num" || !Number.isInteger(t.v)) throw new ExprError("loop bounds must be integer literals", t.line);
    return t.v;
  };

  function block() {
    if (!isP("{")) return [statement()];
    next();
    const out = [];
    while (!isP("}")) {
      if (peek().k === "eof") throw new ExprError("missing '}'", peek().line);
      out.push(statement());
    }
    next();
    return out;
  }

  function statement() {
    const t = peek();
    if (t.k === "id" && TYPE_NAMES.has(t.v) && peek(1).k === "id") {
      next();
      const name = ident();
      expect("=");
      const e = expr();
      expect(";");
      return { t: "decl", type: t.v, name, e, line: t.line };
    }
    if (isId("return")) { next(); const e = expr(); expect(";"); return { t: "ret", e, line: t.line }; }
    if (isId("for")) {
      next(); expect("("); expect("int");
      const v = ident(); expect("="); const from = intLit(); expect(";");
      if (ident() !== v) throw new ExprError(`loop condition must test '${v}'`, t.line);
      expect("<"); const to = intLit(); expect(";");
      if (ident() !== v) throw new ExprError(`loop step must be '${v}++'`, t.line);
      expect("++"); expect(")");
      return { t: "for", v, from, to, body: block(), line: t.line };
    }
    if (t.k === "id" && (isP("=", 1) || isP("+=", 1))) {
      next();
      const op = next().v;
      const e = expr();
      expect(";");
      const value = op === "+=" ? { t: "bin", op: "+", a: { t: "id", name: t.v, line: t.line }, b: e, line: t.line } : e;
      return { t: "assign", name: t.v, e: value, line: t.line };
    }
    throw new ExprError("expected a declaration, an assignment, 'for' or 'return'", t.line);
  }

  const expr = () => ternary();
  function ternary() {
    const c = binary(0);
    if (!isP("?")) return c;
    const line = next().line;
    const a = ternary();
    expect(":");
    const b = ternary();
    return { t: "tern", c, a, b, line };
  }
  const LEVELS = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/"]];
  function binary(level) {
    if (level === LEVELS.length) return unary();
    let a = binary(level + 1);
    while (peek().k === "p" && LEVELS[level].includes(peek().v)) {
      const t = next();
      a = { t: "bin", op: t.v, a, b: binary(level + 1), line: t.line };
    }
    return a;
  }
  function unary() {
    if (isP("-") || isP("!")) { const t = next(); return { t: "un", op: t.v, a: unary(), line: t.line }; }
    return postfix();
  }
  function postfix() {
    let a = primary();
    while (isP(".")) { const t = next(); a = { t: "swz", a, s: ident(), line: t.line }; }
    return a;
  }
  function primary() {
    const t = next();
    if (t.k === "num") return { t: "num", v: t.v, line: t.line };
    if (t.k === "p" && t.v === "(") { const e = expr(); expect(")"); return e; }
    if (t.k === "id") {
      if (isP("(")) {
        next();
        const args = [];
        if (!isP(")")) { do args.push(expr()); while (isP(",") && next()); }
        expect(")");
        return { t: "call", name: t.v, args, line: t.line };
      }
      return { t: "id", name: t.v, line: t.line };
    }
    throw new ExprError(`unexpected '${t.v || "end of source"}'`, t.line);
  }

  const stmts = [];
  while (peek().k !== "eof") stmts.push(statement());
  return stmts;
}
```

- [ ] **Step 4: Implement the lowerer**

```js
// src/framework/geometry/implicit/expr-lower.js
// Lowers a parsed expr to scalar SSA ops (vectors become 2 or 3 scalar registers,
// loops unroll). The scalar function tables here are THE semantics: the reference
// evaluator and the bytecode interpreter both call them, so they agree exactly.
import { pfSin, pfCos } from "../js-math.js";
import { parseExpr, ExprError } from "./expr-parse.js";

export function smin2(a, b, k) {
  if (!(k > 0)) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export const smax2 = (a, b, k) => -smin2(-a, -b, k);

export const UN = {
  neg: (a) => -a, abs: Math.abs, floor: Math.floor, fract: (a) => a - Math.floor(a), sqrt: Math.sqrt,
  sin: pfSin, cos: pfCos, not: (a) => (a === 0 ? 1 : 0),
};
export const BIN = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => a / b,
  min: Math.min, max: Math.max, mod: (a, b) => a - b * Math.floor(a / b), step: (e, x) => (x < e ? 0 : 1),
  lt: (a, b) => (a < b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0), le: (a, b) => (a <= b ? 1 : 0), ge: (a, b) => (a >= b ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0), ne: (a, b) => (a !== b ? 1 : 0),
  and: (a, b) => (a !== 0 && b !== 0 ? 1 : 0), or: (a, b) => (a !== 0 || b !== 0 ? 1 : 0),
};
export const TER = {
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  mix: (a, b, t) => a * (1 - t) + b * t,
  smoothstep: (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); },
  smin: smin2, smax: smax2,
  select: (c, a, b) => (c !== 0 ? a : b),
};

const SIZE = { float: 1, bool: 1, vec2: 2, vec3: 3 };
const VEC = { 2: "vec2", 3: "vec3" };
const BIN_OPS = { "+": "add", "-": "sub", "*": "mul", "/": "div", "<": "lt", ">": "gt", "<=": "le", ">=": "ge", "==": "eq", "!=": "ne", "&&": "and", "||": "or" };
const COMPONENTWISE_UN = new Set(["abs", "floor", "fract", "sqrt", "sin", "cos"]);
const SWZ = { x: 0, y: 1, z: 2, r: 0, g: 1, b: 2 };
const MAX_LOOP = 16;
const MAX_OPS = 8192;

export function lowerExpr(ast, { uniforms = {}, textureSlots = {} } = {}) {
  const ops = [];
  let nregs = 0;
  const reg = () => nregs++;
  const emit = (o) => { if (ops.length >= MAX_OPS) throw new ExprError(`formula is too large (over ${MAX_OPS} operations after unrolling)`, 1); ops.push(o); return o.dst; };
  const konst = (val) => emit({ op: "const", dst: reg(), val });
  const val = (type, regs) => ({ type, regs });
  const P = val("vec3", [0, 1, 2].map((comp) => emit({ op: "get", dst: reg(), comp })));
  const scopes = [new Map()];
  const lookup = (name) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); return null; };

  const un = (fn, v) => val(v.type, v.regs.map((a) => emit({ op: "un", fn, dst: reg(), a })));
  const broadcast = (v, n, line) => {
    if (v.type === "bool") throw new ExprError("expected a number, got a comparison", line);
    if (SIZE[v.type] === n) return v.regs;
    if (v.type === "float") return Array(n).fill(v.regs[0]);
    throw new ExprError(`cannot combine ${v.type} with ${VEC[n] ?? "float"}`, line);
  };
  const widest = (...vs) => Math.max(...vs.map((v) => (v.type === "bool" ? 1 : SIZE[v.type])));
  const bin = (fn, a, b, line) => {
    const n = widest(a, b), A = broadcast(a, n, line), B = broadcast(b, n, line);
    return val(n === 1 ? "float" : VEC[n], A.map((ra, i) => emit({ op: "bin", fn, dst: reg(), a: ra, b: B[i] })));
  };
  const ter = (fn, a, b, c, line) => {
    const n = widest(a, b, c), A = broadcast(a, n, line), B = broadcast(b, n, line), C = broadcast(c, n, line);
    return val(n === 1 ? "float" : VEC[n], A.map((ra, i) => emit({ op: "ter", fn, dst: reg(), a: ra, b: B[i], c: C[i] })));
  };
  const sumOf = (regs) => regs.slice(1).reduce((acc, r) => emit({ op: "bin", fn: "add", dst: reg(), a: acc, b: r }), regs[0]);
  const lengthOf = (v) => val("float", [emit({ op: "un", fn: "sqrt", dst: reg(), a: sumOf(v.regs.map((r) => emit({ op: "bin", fn: "mul", dst: reg(), a: r, b: r }))) })]);
  const needFloat = (v, what, line) => { if (v.type !== "float") throw new ExprError(`${what} must be a float, got ${v.type}`, line); return v; };
  const needVec = (v, what, line) => { if (v.type !== "vec2" && v.type !== "vec3") throw new ExprError(`${what} must be a vec2 or vec3, got ${v.type}`, line); return v; };
  const arity = (name, args, n, line) => { if (args.length !== n) throw new ExprError(`${name} expects ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`, line); };

  function call(node) {
    const { name, line } = node;
    if (name === "texture") {
      arity(name, node.args, 2, line);
      const tn = node.args[0];
      if (tn.t !== "id" || !(tn.name in textureSlots)) throw new ExprError(`unknown texture '${tn.t === "id" ? tn.name : "?"}' — list it in this formula's \`textures\``, line);
      const uv = ex(node.args[1]);
      if (uv.type !== "vec2") throw new ExprError(`texture uv must be a vec2, got ${uv.type}`, line);
      return val("float", [emit({ op: "tex", dst: reg(), slot: textureSlots[tn.name], u: uv.regs[0], v: uv.regs[1] })]);
    }
    const args = node.args.map(ex);
    if (name === "float") { arity(name, args, 1, line); return val("float", [args[0].regs[0]]); }
    if (name === "vec2" || name === "vec3") {
      const n = SIZE[name];
      const regs = args.flatMap((a) => a.regs);
      if (regs.length === 1) return val(name, Array(n).fill(regs[0]));
      if (regs.length !== n) throw new ExprError(`${name} needs ${n} components, got ${regs.length}`, line);
      return val(name, regs);
    }
    if (COMPONENTWISE_UN.has(name)) { arity(name, args, 1, line); return un(name, args[0]); }
    if (name === "min" || name === "max" || name === "mod" || name === "step") { arity(name, args, 2, line); return bin(name, args[0], args[1], line); }
    if (name === "clamp" || name === "mix" || name === "smoothstep") { arity(name, args, 3, line); return ter(name, args[0], args[1], args[2], line); }
    if (name === "smin" || name === "smax") { arity(name, args, 3, line); args.forEach((a) => needFloat(a, `${name} argument`, line)); return ter(name, args[0], args[1], args[2], line); }
    if (name === "length") { arity(name, args, 1, line); return lengthOf(needVec(args[0], "length argument", line)); }
    if (name === "dot") {
      arity(name, args, 2, line);
      if (args[0].type !== args[1].type) throw new ExprError("dot needs two vectors of the same size", line);
      needVec(args[0], "dot argument", line);
      return val("float", [sumOf(args[0].regs.map((r, i) => emit({ op: "bin", fn: "mul", dst: reg(), a: r, b: args[1].regs[i] })))]);
    }
    if (name === "normalize") {
      arity(name, args, 1, line);
      const l = lengthOf(needVec(args[0], "normalize argument", line)).regs[0];
      return val(args[0].type, args[0].regs.map((r) => emit({ op: "bin", fn: "div", dst: reg(), a: r, b: l })));
    }
    if (name === "cross") {
      arity(name, args, 2, line);
      if (args[0].type !== "vec3" || args[1].type !== "vec3") throw new ExprError("cross needs two vec3s", line);
      const [ax, ay, az] = args[0].regs, [bx, by, bz] = args[1].regs;
      const m = (a, b) => emit({ op: "bin", fn: "mul", dst: reg(), a, b });
      const s = (a, b) => emit({ op: "bin", fn: "sub", dst: reg(), a, b });
      return val("vec3", [s(m(ay, bz), m(az, by)), s(m(az, bx), m(ax, bz)), s(m(ax, by), m(ay, bx))]);
    }
    throw new ExprError(`unknown function '${name}'`, line);
  }

  function ex(node) {
    switch (node.t) {
      case "num": return val("float", [konst(node.v)]);
      case "id": {
        if (node.name === "p") return P;
        const local = lookup(node.name);
        if (local) return local;
        if (Object.hasOwn(uniforms, node.name)) return val("float", [konst(uniforms[node.name])]);
        throw new ExprError(`unknown name '${node.name}'`, node.line);
      }
      case "un": {
        const a = ex(node.a);
        if (node.op === "!") { if (a.type !== "bool") throw new ExprError("'!' needs a comparison", node.line); return val("bool", un("not", a).regs); }
        return un("neg", a);
      }
      case "bin": {
        const a = ex(node.a), b = ex(node.b), fn = BIN_OPS[node.op];
        if (fn === "and" || fn === "or") {
          if (a.type !== "bool" || b.type !== "bool") throw new ExprError(`'${node.op}' needs comparisons on both sides`, node.line);
          return val("bool", [emit({ op: "bin", fn, dst: reg(), a: a.regs[0], b: b.regs[0] })]);
        }
        if (["lt", "gt", "le", "ge", "eq", "ne"].includes(fn)) {
          needFloat(a, "a comparison operand", node.line); needFloat(b, "a comparison operand", node.line);
          return val("bool", [emit({ op: "bin", fn, dst: reg(), a: a.regs[0], b: b.regs[0] })]);
        }
        return bin(fn, a, b, node.line);
      }
      case "tern": {
        const c = ex(node.c);
        if (c.type !== "bool") throw new ExprError("the condition of '?:' must be a comparison", node.line);
        const a = ex(node.a), b = ex(node.b);
        if (a.type !== b.type) throw new ExprError(`both branches of '?:' must have the same type (${a.type} vs ${b.type})`, node.line);
        return val(a.type, a.regs.map((ra, i) => emit({ op: "ter", fn: "select", dst: reg(), a: c.regs[0], b: ra, c: b.regs[i] })));
      }
      case "swz": {
        const a = ex(node.a);
        if (a.type !== "vec2" && a.type !== "vec3") throw new ExprError(`cannot swizzle a ${a.type}`, node.line);
        const idx = [...node.s].map((ch) => SWZ[ch]);
        if (idx.length > 3 || idx.some((i) => i === undefined || i >= SIZE[a.type])) throw new ExprError(`bad swizzle '.${node.s}' on a ${a.type}`, node.line);
        return val(idx.length === 1 ? "float" : VEC[idx.length], idx.map((i) => a.regs[i]));
      }
      case "call": return call(node);
      default: throw new ExprError(`unsupported expression`, node.line ?? 1);
    }
  }

  let result = null;
  function stmts(list, top) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (result !== null) throw new ExprError("code after return", s.line);
      if (s.t === "decl") {
        const v = ex(s.e);
        if (v.type !== s.type) throw new ExprError(`'${s.name}' is declared ${s.type} but assigned a ${v.type}`, s.line);
        scopes[scopes.length - 1].set(s.name, v);
      } else if (s.t === "assign") {
        let found = null;
        for (let j = scopes.length - 1; j >= 0 && !found; j--) if (scopes[j].has(s.name)) found = scopes[j];
        if (!found) throw new ExprError(`unknown name '${s.name}'`, s.line);
        const v = ex(s.e);
        if (v.type !== found.get(s.name).type) throw new ExprError(`cannot assign a ${v.type} to ${found.get(s.name).type} '${s.name}'`, s.line);
        found.set(s.name, v);
      } else if (s.t === "for") {
        if (s.to - s.from > MAX_LOOP) throw new ExprError(`loops may run at most ${MAX_LOOP} iterations`, s.line);
        for (let it = s.from; it < s.to; it++) {
          scopes.push(new Map([[s.v, val("float", [konst(it)])]]));
          stmts(s.body, false);
          scopes.pop();
        }
      } else if (s.t === "ret") {
        if (!top) throw new ExprError("return is only allowed at the top level", s.line);
        const v = ex(s.e);
        if (v.type !== "float") throw new ExprError(`return must be a float, got ${v.type}`, s.line);
        result = v.regs[0];
      }
    }
  }
  stmts(ast, true);
  if (result === null) throw new ExprError("a formula must end with a return statement", ast.length ? ast[ast.length - 1].line : 1);
  return { ops, result, nregs };
}

export const compileExprSource = (src, opts) => lowerExpr(parseExpr(src), opts);

/** Scalar interpreter for lowered ops — used by the reference evaluator and surface detail. */
export function evalExprScalar(L, x, y, z, textures, sample) {
  const r = new Float64Array(L.nregs);
  for (const o of L.ops) {
    switch (o.op) {
      case "const": r[o.dst] = o.val; break;
      case "get": r[o.dst] = o.comp === 0 ? x : o.comp === 1 ? y : z; break;
      case "un": r[o.dst] = UN[o.fn](r[o.a]); break;
      case "bin": r[o.dst] = BIN[o.fn](r[o.a], r[o.b]); break;
      case "ter": r[o.dst] = TER[o.fn](r[o.a], r[o.b], r[o.c]); break;
      case "tex": r[o.dst] = sample(textures[o.slot], r[o.u], r[o.v]); break;
    }
  }
  return r[L.result];
}
```

Note: `float(i)` in the test's loop converts the loop counter (already a float register) — the `float` call above is the identity on a float.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/implicit-expr.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/implicit/expr-parse.js src/framework/geometry/implicit/expr-lower.js test/implicit-expr.test.js
git commit -m "feat(implicit): expr language — GLSL-subset parser and scalar lowering

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Textures

**Files:**
- Create: `src/framework/geometry/implicit/textures.js`
- Test: `test/implicit-textures.test.js`

**Interfaces:**
- Consumes: `ImplicitSizeError` (Task 2).
- Produces: `TEXTURE_LIMITS = { maxSide: 2048, maxTexelsPerPart: 16777216 }`; `makeTexture(image: {digest,width,height,data:Uint16Array}) → Texture` where `Texture = { width, height, data: Float32Array (0..1), digest }`; `sampleTexture(t: Texture, u, v) → number` (bilinear, `u, v` clamped to `[0,1]`, NaN → 0; row 0 of the image is `v = 0`, the `heightfield` convention); `checkTextureBudget(textures: Texture[])` (throws `ImplicitSizeError`).

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-textures.test.js
import { describe, test, expect } from "vitest";
import { makeTexture, sampleTexture, checkTextureBudget } from "../src/framework/geometry/implicit/textures.js";

const img = (w, h, f) => {
  const data = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.round(f(x, y) * 65535);
  return { digest: `d${w}x${h}`, width: w, height: h, data };
};

describe("textures", () => {
  test("bilinear sampling hits texel centres exactly and interpolates between them", () => {
    const t = makeTexture(img(3, 2, (x, y) => (x + 3 * y) / 5));
    expect(sampleTexture(t, 0, 0)).toBeCloseTo(0, 6);
    expect(sampleTexture(t, 1, 0)).toBeCloseTo(2 / 5, 6);
    expect(sampleTexture(t, 0, 1)).toBeCloseTo(3 / 5, 6);    // row 1 is v = 1 (heightfield convention)
    expect(sampleTexture(t, 0.25, 0)).toBeCloseTo(0.5 / 5, 6);
  });
  test("uv clamps and NaN reads as 0", () => {
    const t = makeTexture(img(2, 2, () => 1));
    expect(sampleTexture(t, -5, 9)).toBeCloseTo(1, 6);
    expect(sampleTexture(t, NaN, NaN)).toBeCloseTo(1, 6);
  });
  test("budget: per-side and per-part caps", () => {
    expect(() => checkTextureBudget([{ width: 4096, height: 2, digest: "a" }])).toThrow(/2048/);
    const big = { width: 2048, height: 2048, digest: "b" };
    expect(() => checkTextureBudget([big, big, big, big])).not.toThrow();
    expect(() => checkTextureBudget([big, big, big, big, { width: 2, height: 2, digest: "c" }])).toThrow(/16777216/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-textures.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/textures.js
// Image textures for expr formulas and surface detail. Pixels are stored once as
// float32 in 0..1; sampling is bilinear with only + − × floor, so the native port
// matches it exactly. Orientation follows heightfield: image row 0 is v = 0.
import { ImplicitSizeError } from "./errors.js";

export const TEXTURE_LIMITS = Object.freeze({ maxSide: 2048, maxTexelsPerPart: 16 * 1024 * 1024 });

export function makeTexture(image) {
  const data = new Float32Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) data[i] = image.data[i] / 65535;
  return { width: image.width, height: image.height, data, digest: image.digest };
}

export function sampleTexture(t, u, v) {
  const uc = u > 0 ? (u < 1 ? u : 1) : 0;   // NaN fails `u > 0` → 0
  const vc = v > 0 ? (v < 1 ? v : 1) : 0;
  const fx = uc * (t.width - 1), fy = vc * (t.height - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = x0 + 1 < t.width ? x0 + 1 : x0, y1 = y0 + 1 < t.height ? y0 + 1 : y0;
  const ax = fx - x0, ay = fy - y0, d = t.data, w = t.width;
  const top = d[y0 * w + x0] * (1 - ax) + d[y0 * w + x1] * ax;
  const bot = d[y1 * w + x0] * (1 - ax) + d[y1 * w + x1] * ax;
  return top * (1 - ay) + bot * ay;
}

export function checkTextureBudget(textures) {
  let total = 0;
  for (const t of textures) {
    if (t.width > TEXTURE_LIMITS.maxSide || t.height > TEXTURE_LIMITS.maxSide) {
      throw new ImplicitSizeError(`texture ${t.width}×${t.height} exceeds ${TEXTURE_LIMITS.maxSide} px per side — downscale the image`);
    }
    total += t.width * t.height;
  }
  if (total > TEXTURE_LIMITS.maxTexelsPerPart) {
    throw new ImplicitSizeError(`textures total ${total} texels, over the ${TEXTURE_LIMITS.maxTexelsPerPart} per-part limit`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-textures.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/textures.js test/implicit-textures.test.js
git commit -m "feat(implicit): bilinear image textures with size budgets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Primitives, blends and point maps

**Files:**
- Create: `src/framework/geometry/implicit/primitives.js`
- Test: `test/implicit-primitives.test.js`

**Interfaces:**
- Consumes: `hypot3`, `pfSin`, `pfCos`, `pfAtan2` (Task 1); `smin2` (Task 4).
- Produces: `PRIM = { SPHERE:1, ELLIPSOID:2, CAPSULE:3, ROUNDCONE:4, BOX:5, CYLINDER:6, TORUS:7, HALFSPACE:8 }`; `evalPrim(code, P, x, y, z)` where `P` is a `Float64Array` (or subarray) of parameters — layouts: SPHERE `[r]`; ELLIPSOID `[rx,ry,rz]`; CAPSULE `[ax,ay,az,bx,by,bz,r]`; ROUNDCONE `[ax,ay,az,bax,bay,baz,l2,rr,a2,il2,r1,r2]`; BOX `[hx,hy,hz,round]` (half sizes); CYLINDER `[halfH,r,round]` (along z); TORUS `[R,r]` (about z); HALFSPACE `[nx,ny,nz,offset]` (unit normal). `roundConeParams(a, b, r1, r2) → Float64Array`. `unionN(v, n, k)`, `intersectN(v, n, k)`. `WARP = { TWIST:1, BEND:2, TAPER:3 }`; `warpPoint(out, kind, W, x, y, z)` with `W` params: TWIST `[rate]` (rad/mm), BEND `[R]`, TAPER `[z0,s0,z1,s1]`. `mirrorPoint(out, axis, x, y, z)` (axis 0/1/2 negated). `BIG = 1e6`; `sanitize(v)`; `clampUnit(v)` (to `[−1,1]`, NaN → 0).

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-primitives.test.js
import { describe, test, expect } from "vitest";
import { PRIM, evalPrim, roundConeParams, unionN, intersectN, WARP, warpPoint, sanitize } from "../src/framework/geometry/implicit/primitives.js";
import { smin2 } from "../src/framework/geometry/implicit/expr-lower.js";

const F = (...v) => Float64Array.of(...v);
let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;

const CASES = [
  ["sphere", PRIM.SPHERE, F(3)],
  ["ellipsoid", PRIM.ELLIPSOID, F(4, 2, 1)],
  ["capsule", PRIM.CAPSULE, F(-2, 0, 0, 3, 1, 0, 1.5)],
  ["roundcone", PRIM.ROUNDCONE, roundConeParams([0, 0, 0], [0, 6, 0], 2, 1)],
  ["box", PRIM.BOX, F(2, 3, 1, 0.4)],
  ["cylinder", PRIM.CYLINDER, F(3, 2, 0.3)],
  ["torus", PRIM.TORUS, F(4, 1)],
  ["halfspace", PRIM.HALFSPACE, F(0, 0, 1, 2)],
];

describe("primitives", () => {
  test("known values", () => {
    expect(evalPrim(PRIM.SPHERE, F(3), 0, 0, 5)).toBe(2);
    expect(evalPrim(PRIM.BOX, F(1, 1, 1, 0), 3, 0, 0)).toBe(2);
    expect(evalPrim(PRIM.CYLINDER, F(2, 1, 0), 0, 0, 0)).toBe(-1);
    expect(evalPrim(PRIM.TORUS, F(4, 1), 4, 0, 0)).toBe(-1);
    expect(evalPrim(PRIM.HALFSPACE, F(0, 0, 1, 2), 0, 0, 5)).toBe(3);
    expect(evalPrim(PRIM.CAPSULE, F(0, 0, 0, 0, 10, 0, 1), 0, 5, 3)).toBe(2);
  });
  test("every primitive is 1-Lipschitz (gradient magnitude ≤ 1)", () => {
    const e = 1e-5;
    for (const [name, code, P] of CASES) {
      let worst = 0;
      for (let i = 0; i < 4000; i++) {
        const x = rnd() * 9, y = rnd() * 9, z = rnd() * 9;
        const gx = (evalPrim(code, P, x + e, y, z) - evalPrim(code, P, x - e, y, z)) / (2 * e);
        const gy = (evalPrim(code, P, x, y + e, z) - evalPrim(code, P, x, y - e, z)) / (2 * e);
        const gz = (evalPrim(code, P, x, y, z + e) - evalPrim(code, P, x, y, z - e)) / (2 * e);
        worst = Math.max(worst, Math.sqrt(gx * gx + gy * gy + gz * gz));
      }
      expect(worst, name).toBeLessThanOrEqual(1 + 1e-4);
    }
  });
  test("unionN of two children IS the normalized quadratic smin", () => {
    for (let i = 0; i < 1000; i++) {
      const a = rnd() * 3, b = rnd() * 3, k = Math.abs(rnd()) * 2;
      expect(unionN(F(a, b), 2, k)).toBe(smin2(a, b, k));
    }
  });
  test("unionN/intersectN do not depend on child order", () => {
    const v = [0.3, 0.9, -0.2, 0.5];
    const perms = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]];
    const u = perms.map((p) => unionN(F(...p.map((i) => v[i])), 4, 1.2));
    const n = perms.map((p) => intersectN(F(...p.map((i) => v[i])), 4, 1.2));
    expect(new Set(u).size).toBe(1);
    expect(new Set(n).size).toBe(1);
  });
  test("a child ≥ k above the minimum contributes exactly nothing", () => {
    expect(unionN(F(0.2, 5, 0.6), 3, 1)).toBe(unionN(F(0.2, 0.6), 2, 1));
    expect(intersectN(F(0.2, -5, 0.6), 3, 1)).toBe(intersectN(F(0.2, 0.6), 2, 1));
  });
  test("warps: twist turns xy, bend maps the axis onto an arc, taper scales xy", () => {
    const o = [0, 0, 0];
    warpPoint(o, WARP.TWIST, F(Math.PI / 20), 1, 0, 10);      // 90° at z = 10
    expect(o[0]).toBeCloseTo(0, 12); expect(o[1]).toBeCloseTo(-1, 12); expect(o[2]).toBe(10);
    const R = 10, th = 0.5;
    warpPoint(o, WARP.BEND, F(R), R - R * Math.cos(th), 0, R * Math.sin(th));  // a point on the bent axis
    expect(o[0]).toBeCloseTo(0, 12); expect(o[2]).toBeCloseTo(R * th, 12);
    warpPoint(o, WARP.TAPER, F(0, 1, 10, 0.5), 2, 2, 10);
    expect(o).toEqual([4, 4, 10]);
  });
  test("sanitize maps NaN and infinities to ±BIG", () => {
    expect(sanitize(NaN)).toBe(1e6);
    expect(sanitize(-Infinity)).toBe(-1e6);
    expect(sanitize(3)).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-primitives.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/primitives.js
// Scalar building blocks shared by the reference evaluator, the interval pass and
// the bytecode interpreter — one definition, so all three agree to the bit.
// Native-portable arithmetic only (see the plan's Global Constraints).
import { hypot3, pfSin, pfCos, pfAtan2 } from "../js-math.js";

export const PRIM = Object.freeze({ SPHERE: 1, ELLIPSOID: 2, CAPSULE: 3, ROUNDCONE: 4, BOX: 5, CYLINDER: 6, TORUS: 7, HALFSPACE: 8 });
export const BIG = 1e6;

/** Precomputed round-cone constants (Quilez sdRoundCone, exact). */
export function roundConeParams(a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr;
  return Float64Array.of(a[0], a[1], a[2], bax, bay, baz, l2, rr, a2, 1 / l2, r1, r2);
}

const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export function evalPrim(code, P, x, y, z) {
  switch (code) {
    case 1: return hypot3(x, y, z) - P[0];
    case 2: {
      const k0 = hypot3(x / P[0], y / P[1], z / P[2]);
      if (k0 === 0) return -Math.min(P[0], P[1], P[2]);
      const k1 = hypot3(x / (P[0] * P[0]), y / (P[1] * P[1]), z / (P[2] * P[2]));
      return (k0 * (k0 - 1)) / k1;
    }
    case 3: {
      const px = x - P[0], py = y - P[1], pz = z - P[2];
      const bx = P[3] - P[0], by = P[4] - P[1], bz = P[5] - P[2];
      const bb = bx * bx + by * by + bz * bz;
      let h = bb > 0 ? (px * bx + py * by + pz * bz) / bb : 0;
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      return hypot3(px - bx * h, py - by * h, pz - bz * h) - P[6];
    }
    case 4: {
      const pax = x - P[0], pay = y - P[1], paz = z - P[2];
      const bax = P[3], bay = P[4], baz = P[5], l2 = P[6], rr = P[7], a2 = P[8], il2 = P[9];
      const yv = pax * bax + pay * bay + paz * baz, zv = yv - l2;
      const xx = pax * l2 - bax * yv, xy = pay * l2 - bay * yv, xz = paz * l2 - baz * yv;
      const x2 = xx * xx + xy * xy + xz * xz, y2 = yv * yv * l2, z2 = zv * zv * l2;
      const k = sgn(rr) * rr * rr * x2;
      if (sgn(zv) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - P[11];
      if (sgn(yv) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - P[10];
      return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - P[10];
    }
    case 5: {
      const r = P[3];
      const qx = Math.abs(x) - P[0] + r, qy = Math.abs(y) - P[1] + r, qz = Math.abs(z) - P[2] + r;
      return hypot3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
    }
    case 6: {
      const r = P[2];
      const dx = Math.sqrt(x * x + y * y) - P[1] + r, dz = Math.abs(z) - P[0] + r;
      const mx = Math.max(dx, 0), mz = Math.max(dz, 0);
      return Math.sqrt(mx * mx + mz * mz) + Math.min(Math.max(dx, dz), 0) - r;
    }
    case 7: {
      const q = Math.sqrt(x * x + y * y) - P[0];
      return Math.sqrt(q * q + z * z) - P[1];
    }
    case 8: return P[0] * x + P[1] * y + P[2] * z - P[3];
    default: throw new Error(`implicit: unknown primitive code ${code}`);
  }
}

// n-ary, order-independent quadratic smooth min (plan decision 1). Two children:
// exactly Quilez's normalized quadratic smin. A child ≥ k above the minimum adds
// exactly 0, which is what makes interval pruning exact.
export function unionN(v, n, k) {
  let m = v[0], am = 0;
  for (let i = 1; i < n; i++) if (v[i] < m) { m = v[i]; am = i; }
  if (!(k > 0)) return m;
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i === am) continue;
    const g = k - (v[i] - m);
    if (g > 0) { const h = g / k; s += h * h; }
  }
  return m - s * k * 0.25;
}

export function intersectN(v, n, k) {
  let M = v[0], aM = 0;
  for (let i = 1; i < n; i++) if (v[i] > M) { M = v[i]; aM = i; }
  if (!(k > 0)) return M;
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i === aM) continue;
    const g = k - (M - v[i]);
    if (g > 0) { const h = g / k; s += h * h; }
  }
  return M + s * k * 0.25;
}

export const WARP = Object.freeze({ TWIST: 1, BEND: 2, TAPER: 3 });

/** Maps a point (in the warp's basis: axis = z, toward = x) into the child's space. */
export function warpPoint(out, kind, W, x, y, z) {
  if (kind === 1) {
    const a = -W[0] * z, c = pfCos(a), s = pfSin(a);
    out[0] = c * x - s * y; out[1] = s * x + c * y; out[2] = z;
  } else if (kind === 2) {
    const R = W[0], u = R - x, rho = Math.sqrt(u * u + z * z);
    out[0] = R - rho; out[1] = y; out[2] = R * pfAtan2(z, u);
  } else {
    let t = (z - W[0]) / (W[2] - W[0]);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const s = W[1] + (W[3] - W[1]) * t;
    out[0] = x / s; out[1] = y / s; out[2] = z;
  }
}

export function mirrorPoint(out, axis, x, y, z) {
  out[0] = axis === 0 ? -x : x; out[1] = axis === 1 ? -y : y; out[2] = axis === 2 ? -z : z;
}

export const sanitize = (v) => (v === v ? (v > BIG ? BIG : v < -BIG ? -BIG : v) : BIG);
export const clampUnit = (v) => (v > -1 ? (v < 1 ? v : 1) : v === v ? -1 : 0);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-primitives.test.js`
Expected: PASS. **If the ellipsoid's Lipschitz assertion fails**, do not loosen it globally: add `export const PRIM_LIPSCHITZ = { 2: <observed max × 1.05, rounded up to 2 decimals> }` here, use `PRIM_LIPSCHITZ[code] ?? 1` wherever Task 7 assigns a primitive's `L`, change the test to assert against that table, and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/primitives.js test/implicit-primitives.test.js
git commit -m "feat(implicit): primitives, order-independent n-ary blends, warps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Lowering to IR, and the reference evaluator

**Files:**
- Create: `src/framework/geometry/implicit/ir.js`, `src/framework/geometry/implicit/reference.js`
- Test: `test/implicit-ir.test.js`

**Interfaces:**
- Consumes: frames.js (Task 2), `compileExprSource`, `evalExprScalar` (Task 4), `makeTexture`, `sampleTexture`, `checkTextureBudget` (Task 5), primitives.js (Task 6), `ImplicitSpecError` (Task 2).
- Produces (ir.js): `lowerSpec(spec, { images: Map<string, image> }) → Compiled` where
  `Compiled = { ir: { nodes: Node[], root: number }, textures: Texture[], bounds: {min:[3],max:[3]}, thin: number, detail: DetailEntry[], digests: string[] }`.
  `Node = { kind, inv: Float64Array|null, children: number[], L, box, thin, label, path, …kind fields }` with kind-specific fields: `prim: {code, P}` (`kind:"prim"`); `k` (union/intersect/subtract); `axis` (mirror: 0|1|2); `r` (round); `t` (onion); `amount`, `by: Lowered` (displace); `warp: {kind, W, B: Float64Array|null, Bt}` (`kind:"warp"`); `expr: Lowered` (`kind:"expr"`); `kind:"ref"` (an instance: placement in `inv`, one child). Repeat and tube lower to `union` nodes (k = 0).
  `DetailEntry = { kind, inv, radius, side: [3]|null, amplitude, wavelength, axis: 0|1|2, slot, projection, size, height: Lowered|null, target }` (`target` = refine edge length, mm).
- Produces (reference.js): `evalReference(compiled, x, y, z) → number`.

Placement rule (plan decision 2): for each node, `W_node = node.frame ? frameWorld · T(at) : W_parent · T(at)`; `node.inv = invert(W_node) ∘ W_parent` (parent-local → node-local), `null` when identity. A node's `box` is in its parent's coordinates.

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-ir.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";

const lower = (spec, images = new Map()) => lowerSpec(spec, { images });
const at = (c, p) => evalReference(c, p[0], p[1], p[2]);

describe("lowering + reference", () => {
  test("frames are absolute, `at` is relative to the frame", () => {
    const c = lower({
      frames: { f: { at: [10, 0, 0], rotate: { axis: "z", deg: 90 } } },
      root: { kind: "union", children: [{ kind: "sphere", r: 1, frame: "f", at: [0, 5, 0] }] },
    });
    expect(at(c, [5, 0, 0])).toBeCloseTo(-1, 12);   // f's local +y is world −x
  });
  test("nested `at` composes with the parent's placement", () => {
    const c = lower({ root: { kind: "union", at: [0, 0, 10], children: [{ kind: "sphere", r: 1, at: [3, 0, 0] }] } });
    expect(at(c, [3, 0, 10])).toBeCloseTo(-1, 12);
  });
  test("subtract and blended union", () => {
    const c = lower({ root: { kind: "subtract", children: [{ kind: "sphere", r: 5 }, { kind: "sphere", r: 3 }] } });
    expect(at(c, [0, 0, 0])).toBe(3);
    expect(at(c, [4, 0, 0])).toBe(-1);
    const u = lower({ root: { kind: "union", k: 2, children: [{ kind: "sphere", r: 1, at: [-1.5, 0, 0] }, { kind: "sphere", r: 1, at: [1.5, 0, 0] }] } });
    expect(at(u, [0, 0, 0])).toBeLessThan(0.5);                                  // blended past the hard union's 0.5
  });
  test("repeat places count instances; tube is a chain of capsules", () => {
    const c = lower({ root: { kind: "repeat", linear: { step: [10, 0, 0], count: 3 }, child: { kind: "sphere", r: 1 } } });
    expect(at(c, [20, 0, 0])).toBeCloseTo(-1, 12);
    expect(at(c, [30, 0, 0])).toBeCloseTo(9, 12);
    const p = lower({ root: { kind: "repeat", polar: { count: 4 }, child: { kind: "sphere", r: 1, at: [5, 0, 0] } } });
    expect(at(p, [0, 5, 0])).toBeCloseTo(-1, 9);
    const t = lower({ root: { kind: "tube", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], r: 1 } });
    expect(at(t, [10, 5, 0])).toBeCloseTo(-1, 12);
  });
  test("mirror, round, onion, twist, bend, taper", () => {
    expect(at(lower({ root: { kind: "mirror", plane: "yz", child: { kind: "sphere", r: 1, at: [4, 0, 0] } } }), [-4, 0, 0])).toBeCloseTo(-1, 12);
    expect(at(lower({ root: { kind: "round", r: 1, child: { kind: "sphere", r: 1 } } }), [0, 0, 2])).toBeCloseTo(0, 12);
    expect(at(lower({ root: { kind: "onion", t: 0.5, child: { kind: "sphere", r: 3 } } }), [0, 0, 0])).toBeCloseTo(2.5, 12);
    const tw = lower({ root: { kind: "twist", degPerMm: 9, child: { kind: "box", size: [8, 2, 20] } } });
    expect(at(tw, [0, 3.9, 9])).toBeLessThan(0);                               // 81° at z = 9: the slab has turned almost onto y
    const bd = lower({ root: { kind: "bend", radius: 20, child: { kind: "capsule", a: [0, 0, 0], b: [0, 0, 15], r: 1 } } });
    expect(at(bd, [20 - 20 * Math.cos(0.5), 0, 20 * Math.sin(0.5)])).toBeCloseTo(-1, 9);
    const tp = lower({ root: { kind: "taper", from: [0, 1], to: [10, 0.5], child: { kind: "cylinder", h: 20, r: 4 } } });
    expect(at(tp, [3.9, 0, -5])).toBeLessThan(0);
    expect(at(tp, [3.9, 0, 9.9])).toBeGreaterThan(0);
  });
  test("expr nodes, uniforms and textures", () => {
    const data = Uint16Array.from([0, 65535, 0, 65535]);
    const images = new Map([["ramp", { digest: "r1", width: 2, height: 2, data }]]);
    const c = lower({ root: { kind: "expr", box: [[-5, -5, -5], [5, 5, 5]], sdf: "return length(p) - r - texture(t, vec2(1.0, 0.0));", uniforms: { r: 2 }, textures: { t: { image: "ramp" } } } }, images);
    expect(at(c, [0, 0, 4])).toBeCloseTo(1, 6);
    expect(c.digests).toEqual(["r1"]);
  });
  test("bounds, thin, and spec errors from expr source", () => {
    const c = lower({ root: { kind: "union", k: 2, children: [{ kind: "sphere", r: 1 }, { kind: "box", size: [2, 4, 0.6], at: [5, 0, 0] }] } });
    expect(c.bounds.min[0]).toBeLessThanOrEqual(-1);
    expect(c.bounds.max[0]).toBeGreaterThanOrEqual(6);
    expect(c.thin).toBeCloseTo(0.6, 12);
    expect(() => lower({ root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return q;" } })).toThrow(/root\.sdf: line 1: unknown name 'q'/);
    expect(() => lower({ root: { kind: "halfspace", normal: "z" } })).toThrow(/unbounded/);
    expect(() => lower({ root: { kind: "bend", radius: 2, child: { kind: "box", size: [10, 1, 1] } } })).toThrow(/bend radius/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-ir.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ir.js`**

```js
// src/framework/geometry/implicit/ir.js
// Spec → IR. Resolves frames, placements (plan decision 2), warps' bases, repeat
// and tube expansion, expr lowering and texture slots; computes each node's box
// (in its parent's coordinates), Lipschitz factor L and thinnest feature. The IR
// is the single input to the reference evaluator, the interval pass and the emitter.
import { resolveFrames, compose, invert, translation, rotation, axisVector, xformPoint, IDENTITY } from "./frames.js";
import { compileExprSource } from "./expr-lower.js";
import { makeTexture, checkTextureBudget } from "./textures.js";
import { PRIM, WARP, roundConeParams, warpPoint } from "./primitives.js";
import { ImplicitSpecError } from "./errors.js";

const INF = Infinity;
const AXIS_INDEX = { yz: 0, xz: 1, xy: 2 };
const box = (min, max) => ({ min, max });
const boxUnion = (a, b) => box(a.min.map((v, i) => Math.min(v, b.min[i])), a.max.map((v, i) => Math.max(v, b.max[i])));
const boxInter = (a, b) => box(a.min.map((v, i) => Math.max(v, b.min[i])), a.max.map((v, i) => Math.min(v, b.max[i])));
const boxPad = (b, d) => box(b.min.map((v) => v - d), b.max.map((v) => v + d));
const finite = (b) => b.min.every(Number.isFinite) && b.max.every(Number.isFinite);
function boxXform(b, M) {
  if (!finite(b)) return box([-INF, -INF, -INF], [INF, INF, INF]);
  const out = box([INF, INF, INF], [-INF, -INF, -INF]), p = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    xformPoint(p, M, c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]);
    for (let i = 0; i < 3; i++) { out.min[i] = Math.min(out.min[i], p[i]); out.max[i] = Math.max(out.max[i], p[i]); }
  }
  return out;
}
const isIdentity = (M) => M.every((v, i) => v === IDENTITY[i]);

/** Basis taking `axis` to z and `toward` to x (rows x̂, ŷ, ẑ); null when it is the identity. */
function warpBasis(axis = "z", toward) {
  const z = axisVector(axis);
  let t = toward != null ? axisVector(toward) : Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = t[0] * z[0] + t[1] * z[1] + t[2] * z[2];
  t = [t[0] - d * z[0], t[1] - d * z[1], t[2] - d * z[2]];
  const tl = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
  if (!(tl > 1e-9)) throw new ImplicitSpecError("bend `toward` must not be parallel to `axis`");
  const x = [t[0] / tl, t[1] / tl, t[2] / tl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const B = Float64Array.of(...x, ...y, ...z, 0, 0, 0);
  return isIdentity(B) ? null : B;
}

export function lowerSpec(spec, { images = new Map() } = {}) {
  const frames = resolveFrames(spec.frames ?? {});
  const nodes = [];
  const textures = [], slotOf = new Map();
  const slot = (imageName) => {
    if (slotOf.has(imageName)) return slotOf.get(imageName);
    const img = images.get(imageName);
    if (!img) throw new ImplicitSpecError(`unknown image "${imageName}" — declare it in the part's \`images\` field`);
    textures.push(makeTexture(img));
    slotOf.set(imageName, textures.length - 1);
    return textures.length - 1;
  };
  const lowerSource = (src, uniforms, texMap, path) => {
    const textureSlots = {};
    for (const [name, t] of Object.entries(texMap ?? {})) textureSlots[name] = slot(t.image);
    try { return compileExprSource(src, { uniforms: uniforms ?? {}, textureSlots }); }
    catch (e) { if (e.name === "ExprError") throw new ImplicitSpecError(`${path}: ${e.message}`); throw e; }
  };

  const add = (n) => { nodes.push(n); return nodes.length - 1; };
  const placeOf = (node, Wparent) => {
    const base = node.frame != null ? frames.get(node.frame).world : Wparent;
    return node.at ? compose(base, translation(node.at)) : base;
  };
  const localInv = (W, Wparent) => { const M = compose(invert(W), Wparent); return isIdentity(M) ? null : M; };

  // Returns the node id. Wparent: world transform of the parent's local space.
  function lower(node, Wparent, path) {
    const W = placeOf(node, Wparent);
    const inv = localInv(W, Wparent);
    const toParent = inv ? invert(inv) : null;
    const finish = (n, localBox, thin) => {
      n.inv = inv; n.label = node.label ?? null; n.path = path;
      n.box = toParent ? boxXform(localBox, toParent) : localBox;
      n.thin = thin;
      return add(n);
    };
    const prim = (code, P, localBox, thin) => finish({ kind: "prim", prim: { code, P }, children: [], L: 1 }, localBox, thin);
    const kids = (list, key = "children") => list.map((c, i) => lower(c, W, `${path}.${key}[${i}]`));
    const child = (c) => lower(c, W, `${path}.child`);
    switch (node.kind) {
      case "sphere": { const r = node.r; return prim(PRIM.SPHERE, Float64Array.of(r), box([-r, -r, -r], [r, r, r]), 2 * r); }
      case "ellipsoid": { const [a, b, c] = node.r; return prim(PRIM.ELLIPSOID, Float64Array.of(a, b, c), box([-a, -b, -c], [a, b, c]), 2 * Math.min(a, b, c)); }
      case "capsule": {
        const a = node.a ?? [0, 0, 0], b = node.b;
        const [r1, r2] = Array.isArray(node.r) ? node.r : [node.r, node.r];
        const R = Math.max(r1, r2);
        const lb = boxPad(box(a.map((v, i) => Math.min(v, b[i])), a.map((v, i) => Math.max(v, b[i]))), R);
        if (r1 === r2) return prim(PRIM.CAPSULE, Float64Array.of(...a, ...b, r1), lb, 2 * r1);
        return prim(PRIM.ROUNDCONE, roundConeParams(a, b, r1, r2), lb, 2 * Math.min(r1, r2));
      }
      case "box": {
        const [hx, hy, hz] = node.size.map((v) => v / 2);
        return prim(PRIM.BOX, Float64Array.of(hx, hy, hz, node.round ?? 0), box([-hx, -hy, -hz], [hx, hy, hz]), 2 * Math.min(hx, hy, hz));
      }
      case "cylinder": case "torus": {
        // Authored about `axis` (default z): an inner basis rotation maps it to z.
        const B = warpBasis(node.axis ?? "z");
        const inner = node.kind === "cylinder"
          ? { code: PRIM.CYLINDER, P: Float64Array.of(node.h / 2, node.r, node.round ?? 0), lb: box([-node.r, -node.r, -node.h / 2], [node.r, node.r, node.h / 2]), thin: 2 * Math.min(node.r, node.h / 2) }
          : { code: PRIM.TORUS, P: Float64Array.of(node.R, node.r), lb: box([-node.R - node.r, -node.R - node.r, -node.r], [node.R + node.r, node.R + node.r, node.r]), thin: 2 * node.r };
        if (!B) return prim(inner.code, inner.P, inner.lb, inner.thin);
        const id = add({ kind: "prim", prim: { code: inner.code, P: inner.P }, children: [], L: 1, inv: B, label: null, path, box: boxXform(inner.lb, invert(B)), thin: inner.thin });
        return finish({ kind: "union", k: 0, children: [id], L: 1 }, nodes[id].box, inner.thin);
      }
      case "halfspace": {
        const n = axisVector(node.normal);
        return prim(PRIM.HALFSPACE, Float64Array.of(n[0], n[1], n[2], node.offset ?? 0), box([-INF, -INF, -INF], [INF, INF, INF]), INF);
      }
      case "tube": {
        const pts = node.points, radii = Array.isArray(node.r) ? node.r : pts.map(() => node.r);
        const segs = [];
        for (let i = 0; i + 1 < pts.length; i++) segs.push({ kind: "capsule", a: pts[i], b: pts[i + 1], r: radii[i] === radii[i + 1] ? radii[i] : [radii[i], radii[i + 1]] });
        const ids = kids(segs, "segments");
        return finish({ kind: "union", k: 0, children: ids, L: 1 }, ids.map((i) => nodes[i].box).reduce(boxUnion), Math.min(...ids.map((i) => nodes[i].thin)));
      }
      case "union": case "intersect": case "subtract": {
        const ids = kids(node.children);
        const k = node.k ?? 0, bs = ids.map((i) => nodes[i].box);
        const lb = node.kind === "union" ? boxPad(bs.reduce(boxUnion), ((ids.length - 1) * k) / 4)
          : node.kind === "intersect" ? bs.reduce(boxInter) : bs[0];
        return finish({ kind: node.kind, k, children: ids, L: Math.max(...ids.map((i) => nodes[i].L)) }, lb, Math.min(...ids.map((i) => nodes[i].thin)));
      }
      case "mirror": {
        const id = child(node.child), axis = AXIS_INDEX[node.plane ?? "yz"], cb = nodes[id].box;
        const mb = box(cb.min.slice(), cb.max.slice());
        mb.min[axis] = -cb.max[axis]; mb.max[axis] = -cb.min[axis];
        return finish({ kind: "mirror", axis, children: [id], L: nodes[id].L }, boxUnion(cb, mb), nodes[id].thin);
      }
      case "round": { const id = child(node.child); return finish({ kind: "round", r: node.r, children: [id], L: nodes[id].L }, boxPad(nodes[id].box, node.r), nodes[id].thin + 2 * node.r); }
      case "onion": { const id = child(node.child); return finish({ kind: "onion", t: node.t, children: [id], L: nodes[id].L }, boxPad(nodes[id].box, node.t), 2 * node.t); }
      case "displace": {
        const id = child(node.child);
        const by = lowerSource(node.by.expr, node.by.uniforms, node.by.textures, `${path}.by.expr`);
        return finish({ kind: "displace", amount: node.amount, by, children: [id], L: nodes[id].L }, boxPad(nodes[id].box, node.amount), nodes[id].thin);
      }
      case "twist": case "bend": case "taper": {
        const id = child(node.child);
        const B = warpBasis(node.axis ?? "z", node.kind === "bend" ? node.toward : undefined);
        const Bt = B ? invert(B) : null;
        const cb = B ? boxXform(nodes[id].box, B) : nodes[id].box;   // child box in basis coords
        let wb, W;
        if (node.kind === "twist") {
          W = { kind: WARP.TWIST, W: Float64Array.of((node.degPerMm * Math.PI) / 180) };
          const rho = Math.max(...[0, 1, 2, 3].map((c) => Math.hypot(c & 1 ? cb.max[0] : cb.min[0], c & 2 ? cb.max[1] : cb.min[1])));
          wb = box([-rho, -rho, cb.min[2]], [rho, rho, cb.max[2]]);
        } else if (node.kind === "taper") {
          const [z0, s0] = node.from, [z1, s1] = node.to;
          if (z0 === z1) throw new ImplicitSpecError(`${path}: taper from/to positions must differ`);
          W = { kind: WARP.TAPER, W: Float64Array.of(z0, s0, z1, s1) };
          const s = Math.max(s0, s1);
          wb = box([cb.min[0] * s, cb.min[1] * s, cb.min[2]], [cb.max[0] * s, cb.max[1] * s, cb.max[2]]);
        } else {
          const R = node.radius;
          if (cb.max[0] >= R * 0.95) throw new ImplicitSpecError(`${path}.radius: bend radius ${R} must exceed the child's extent toward the bend (${cb.max[0].toFixed(3)} mm)`);
          if (Math.max(Math.abs(cb.min[2]), Math.abs(cb.max[2])) >= Math.PI * R * 0.9) throw new ImplicitSpecError(`${path}.radius: the child is too long to bend at radius ${R} (it would wrap past half a turn)`);
          W = { kind: WARP.BEND, W: Float64Array.of(R) };
          // Forward-map a lattice through the child box: (x', y', z') → (R − ρ cos θ, y', ρ sin θ).
          wb = box([INF, INF, INF], [-INF, -INF, -INF]);
          for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) for (let l = 0; l <= 16; l++) {
            const xp = cb.min[0] + ((cb.max[0] - cb.min[0]) * i) / 2, yp = cb.min[1] + ((cb.max[1] - cb.min[1]) * j) / 2, zp = cb.min[2] + ((cb.max[2] - cb.min[2]) * l) / 16;
            const th = zp / R, rho = R - xp, q = [R - rho * Math.cos(th), yp, rho * Math.sin(th)];
            for (let a = 0; a < 3; a++) { wb.min[a] = Math.min(wb.min[a], q[a]); wb.max[a] = Math.max(wb.max[a], q[a]); }
          }
          wb = boxPad(wb, 0.02 * Math.hypot(...wb.max.map((v, a) => v - wb.min[a])));
        }
        const lb = Bt ? boxXform(wb, Bt) : wb;
        return finish({ kind: "warp", warp: { kind: W.kind, W: W.W, B, Bt }, children: [id], L: nodes[id].L }, lb, nodes[id].thin);
      }
      case "repeat": {
        const id = child(node.child);
        const placements = [];
        if (node.linear) for (let i = 0; i < node.linear.count; i++) placements.push(translation(node.linear.step.map((s) => s * i)));
        else for (let i = 0; i < node.polar.count; i++) placements.push(rotation(node.polar.axis ?? "z", (360 * i) / node.polar.count));
        const refs = placements.map((P, i) => add({
          kind: "ref", inv: isIdentity(P) ? null : invert(P), children: [id], L: nodes[id].L,
          box: boxXform(nodes[id].box, P), thin: nodes[id].thin, label: null, path: `${path}.instance[${i}]`,
        }));
        return finish({ kind: "union", k: 0, children: refs, L: nodes[id].L }, refs.map((r) => nodes[r].box).reduce(boxUnion), nodes[id].thin);
      }
      case "expr": {
        const lowered = lowerSource(node.sdf, node.uniforms, node.textures, `${path}.sdf`);
        return finish({ kind: "expr", expr: lowered, children: [], L: node.lipschitz ?? 1 }, box(node.box[0].slice(), node.box[1].slice()), INF);
      }
      default: throw new ImplicitSpecError(`${path}.kind: unknown kind ${JSON.stringify(node.kind)}`);
    }
  }

  const root = lower(spec.root, IDENTITY, "root");
  const rb = nodes[root].box;
  if (!finite(rb)) throw new ImplicitSpecError("root: the shape is unbounded — intersect or subtract a `halfspace` from a bounded shape instead of using it alone");
  const detail = (spec.detail ?? []).map((d, i) => lowerDetail(d, i, frames, slot, lowerSource));
  for (const e of detail) if (e.kind === "texture") {
    const t = textures[e.slot];   // refine to about one texel
    e.target = Math.max(e.size[0] / t.width, e.size[1] / t.height);
  }
  checkTextureBudget(textures);
  return { ir: { nodes, root }, textures, bounds: rb, thin: nodes[root].thin, detail, digests: textures.map((t) => t.digest) };
}

const AXIS_OF = { x: 0, y: 1, z: 2 };
function lowerDetail(d, i, frames, slot, lowerSource) {
  const path = `detail[${i}]`;
  let W = d.frame != null ? frames.get(d.frame).world : IDENTITY;
  if (d.at) W = compose(W, translation(d.at));
  const inv = isIdentity(W) ? null : invert(W);
  const side = d.side != null ? axisVector(d.side) : null;
  const e = { kind: d.kind, inv, radius: d.radius ?? null, side, amplitude: d.amplitude ?? 0, wavelength: d.wavelength ?? null,
    axis: AXIS_OF[d.axis ?? "z"], slot: -1, projection: d.projection ?? "planar", size: d.size ?? null, height: null, target: Infinity };
  if (d.kind === "creases" || d.kind === "noise") e.target = d.wavelength / 3;
  if (d.kind === "texture") e.slot = slot(d.image);
  if (d.kind === "expr") {
    e.height = lowerSource(d.height, d.uniforms, d.textures, `${path}.height`);
    e.target = d.wavelength != null ? d.wavelength / 3 : Infinity;   // Infinity: detail.js uses edge / 2
  }
  return e;
}
```

A texture entry's refine `target` (about one texel) is set in `lowerSpec` right after detail lowering, once its slot's size is known.

- [ ] **Step 4: Implement `reference.js`**

```js
// src/framework/geometry/implicit/reference.js
// The semantic oracle: a plain recursive walk of the IR. The interval pass and the
// bytecode interpreter must agree with it EXACTLY (tests hold them to it).
import { xformPoint, xformDir } from "./frames.js";
import { evalPrim, unionN, intersectN, warpPoint, mirrorPoint, sanitize, clampUnit } from "./primitives.js";
import { evalExprScalar } from "./expr-lower.js";
import { sampleTexture } from "./textures.js";

export const evalReference = (compiled, x, y, z) => evalNode(compiled, compiled.ir.root, x, y, z);

function evalNode(c, id, x, y, z) {
  const n = c.ir.nodes[id];
  if (n.inv) { const q = [0, 0, 0]; xformPoint(q, n.inv, x, y, z); x = q[0]; y = q[1]; z = q[2]; }
  switch (n.kind) {
    case "prim": return evalPrim(n.prim.code, n.prim.P, x, y, z);
    case "expr": return sanitize(evalExprScalar(n.expr, x, y, z, c.textures, sampleTexture));
    case "union": case "intersect": case "subtract": {
      const v = new Float64Array(n.children.length);
      n.children.forEach((ch, i) => { const d = evalNode(c, ch, x, y, z); v[i] = n.kind === "subtract" && i > 0 ? -d : d; });
      return n.kind === "union" ? unionN(v, v.length, n.k) : intersectN(v, v.length, n.k);
    }
    case "mirror": {
      const a = evalNode(c, n.children[0], x, y, z), m = [0, 0, 0];
      mirrorPoint(m, n.axis, x, y, z);
      const b = evalNode(c, n.children[0], m[0], m[1], m[2]);
      return Math.min(a, b);
    }
    case "round": return evalNode(c, n.children[0], x, y, z) - n.r;
    case "onion": return Math.abs(evalNode(c, n.children[0], x, y, z)) - n.t;
    case "displace": {
      const d = evalNode(c, n.children[0], x, y, z);
      return d - n.amount * clampUnit(evalExprScalar(n.by, x, y, z, c.textures, sampleTexture));
    }
    case "warp": {
      const q = [x, y, z], w = [0, 0, 0];
      if (n.warp.B) xformDir(q, n.warp.B, x, y, z);
      warpPoint(w, n.warp.kind, n.warp.W, q[0], q[1], q[2]);
      if (n.warp.Bt) xformDir(w, n.warp.Bt, w[0], w[1], w[2]);
      return evalNode(c, n.children[0], w[0], w[1], w[2]);
    }
    case "ref": return evalNode(c, n.children[0], x, y, z);
    default: throw new Error(`implicit: unknown IR node kind ${n.kind}`);
  }
}
```

Note on `xformDir(q, B, …)` writing into `q` while reading `x, y, z` — safe because the inputs are scalars, not `q`. In the `Bt` line the inputs are `w[0..2]` read before any write? No: `xformDir(out, M, x, y, z)` writes `out[0]` before reading nothing else from `out`, and `x, y, z` were passed by value — safe.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/implicit-ir.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/implicit/ir.js src/framework/geometry/implicit/reference.js test/implicit-ir.test.js
git commit -m "feat(implicit): lower specs to IR; reference evaluator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Interval pass and block decisions

**Files:**
- Create: `src/framework/geometry/implicit/interval.js`
- Test: `test/implicit-interval.test.js`

**Interfaces:**
- Consumes: IR (Task 7), primitives.js (Task 6), frames.js, `evalExprScalar`, `sampleTexture`.
- Produces: `blockDecision(compiled, cx, cy, cz, r) → { lo, hi, dec }`; `fullDecision(compiled) → dec`; `decisionKey(dec) → string`. A decision `dec` is `{ id, kids: (dec|null)[] }` for nodes with children (one entry per child slot; `null` = pruned) and `{ id }` for leaves. A **mirror** decision's `kids` has two entries: `[direct visit, mirrored visit]`.
- Guarantee: for every point within distance `r` of `(cx, cy, cz)`, evaluating only the kept slots gives *exactly* `evalReference`'s value, and that value lies in `[lo, hi]`.

Interval rules (each node returns `[lo, hi]` over the ball):
- leaf (prim, expr): `v = value at the centre`, `[v − L·r, v + L·r]`.
- union: `H = min hi`; slot `i` pruned when `lo_i > H + k`; `lo = min kept lo − (kept − 1)·k/4`, `hi = H`.
- intersect / subtract (tools negated: `[−hi, −lo]`): `Lmax = max lo`; slot pruned when `hi_i < Lmax − k`; `lo = Lmax`, `hi = max kept hi + (kept − 1)·k/4`.
- mirror: two visits A (direct) and B (mirrored point); drop A when `A.lo > B.hi`, drop B when `B.lo > A.hi`; `[min lo, min hi]` over kept.
- round `[lo − r, hi − r]`; onion `|·| − t` on the interval; displace `[lo − amount, hi + amount]`.
- warp: child visited at the warped centre with radius `r · S`, where S (the map's stretch, in basis coordinates): twist `1 + |rate|·(√(x² + y²) + r)`; bend `R / (ρ − r)` with `ρ = √((R − x)² + z²)` (and `[−∞, ∞]` with a full child decision when `ρ ≤ r`); taper `max(1, 1/s_min) + |s₁ − s₀|/|z₁ − z₀| · (√(x² + y²) + r) / s_min²` with `s_min` the smallest scale over `[z − r, z + r]`.
- ref: child at the transformed centre, same `r`.

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-interval.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { blockDecision, fullDecision, decisionKey } from "../src/framework/geometry/implicit/interval.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

let seed = 11;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;

describe("interval pass", () => {
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: every sampled value lies inside its block's interval`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      const { min, max } = c.bounds;
      for (let b = 0; b < 300; b++) {
        const cx = min[0] + (max[0] - min[0]) * (rnd() * 0.5 + 0.5), cy = min[1] + (max[1] - min[1]) * (rnd() * 0.5 + 0.5), cz = min[2] + (max[2] - min[2]) * (rnd() * 0.5 + 0.5);
        const r = 0.5 + Math.abs(rnd()) * 3;
        const { lo, hi } = blockDecision(c, cx, cy, cz, r);
        for (let s = 0; s < 20; s++) {
          let dx = rnd(), dy = rnd(), dz = rnd();
          const l = Math.hypot(dx, dy, dz) || 1, t = Math.abs(rnd()) * r / l;
          const v = evalReference(c, cx + dx * t, cy + dy * t, cz + dz * t);
          expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
          expect(v).toBeLessThanOrEqual(hi + 1e-9);
        }
      }
    });
  }
  test("far children are pruned; keys are stable and distinguish decisions", () => {
    const c = lowerSpec({ root: { kind: "union", k: 1, children: [{ kind: "sphere", r: 1 }, { kind: "sphere", r: 1, at: [50, 0, 0] }] } }, { images: new Map() });
    const near = blockDecision(c, 0, 0, 0, 1);
    expect(near.dec.kids[0]).not.toBeNull();
    expect(near.dec.kids[1]).toBeNull();
    expect(decisionKey(near.dec)).toBe(decisionKey(blockDecision(c, 0.1, 0, 0, 1).dec));
    expect(decisionKey(near.dec)).not.toBe(decisionKey(fullDecision(c)));
  });
});
```

Create the shared fixture `test/fixtures/implicit-small-trees.js` (used by Tasks 8–11):

```js
// test/fixtures/implicit-small-trees.js
// Small IR-coverage trees: every node kind, nested placements, blends of 3+
// children, shared children (repeat, mirror). Kept small so per-point tests are fast.
export const TREES = {
  blobs: { root: { kind: "union", k: 3, children: [
    { kind: "sphere", r: 4 }, { kind: "sphere", r: 3, at: [5, 1, 0] }, { kind: "ellipsoid", r: [5, 2, 2], at: [-3, 3, 1] },
  ] } },
  carved: { frames: { f: { at: [0, 0, 2], rotate: [{ axis: "x", deg: 30 }, { axis: "z", deg: 20 }] } }, root: { kind: "subtract", k: 1, children: [
    { kind: "box", size: [12, 8, 6], round: 1 }, { kind: "cylinder", r: 2, h: 20, frame: "f" }, { kind: "sphere", r: 2, at: [5, 3, 3] },
  ] } },
  shells: { root: { kind: "intersect", k: 0.5, children: [
    { kind: "onion", t: 0.6, child: { kind: "sphere", r: 6 } }, { kind: "halfspace", normal: "z", offset: 1 },
  ] } },
  warps: { root: { kind: "union", k: 1, children: [
    { kind: "twist", degPerMm: 6, child: { kind: "box", size: [6, 2, 16] } },
    { kind: "bend", radius: 25, at: [8, 0, 0], child: { kind: "capsule", a: [0, 0, -6], b: [0, 0, 10], r: [2, 1] } },
    { kind: "taper", from: [-5, 1.2], to: [5, 0.6], at: [-9, 0, 0], child: { kind: "cylinder", h: 10, r: 3 } },
  ] } },
  repeats: { root: { kind: "union", k: 0.8, children: [
    { kind: "torus", R: 8, r: 1.5 },
    { kind: "repeat", polar: { count: 6 }, child: { kind: "sphere", r: 1.8, at: [8, 0, 0] } },
    { kind: "mirror", plane: "xz", child: { kind: "tube", points: [[0, 3, 0], [4, 6, 2], [8, 6, 5]], r: [1, 1.5, 0.8] } },
  ] } },
  formula: { root: { kind: "union", k: 1, children: [
    { kind: "expr", box: [[-6, -6, -6], [6, 6, 6]], lipschitz: 1.6, sdf: "float g = sin(p.x)*cos(p.y) + sin(p.y)*cos(p.z) + sin(p.z)*cos(p.x); return max(length(p) - 5.0, abs(g) - 0.4);" },
    { kind: "displace", amount: 0.5, by: { expr: "return sin(p.x * 2.0) * cos(p.y * 2.0);" }, at: [12, 0, 0], child: { kind: "sphere", r: 4 } },
  ] } },
};
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-interval.test.js`
Expected: FAIL — `interval.js` not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/interval.js
// Per-block interval bounds and pruning decisions over the IR (plan Task 8 rules).
// A pruned slot provably contributes exactly nothing anywhere in the ball, so the
// program emitted from a decision equals the full tree there, bit for bit.
import { xformPoint, xformDir } from "./frames.js";
import { evalPrim, warpPoint, mirrorPoint, sanitize } from "./primitives.js";
import { evalExprScalar } from "./expr-lower.js";
import { sampleTexture } from "./textures.js";

export const blockDecision = (c, cx, cy, cz, r) => visit(c, c.ir.root, cx, cy, cz, r);

function full(c, id) {
  const n = c.ir.nodes[id];
  if (n.children.length === 0) return { id };
  if (n.kind === "mirror") return { id, kids: [full(c, n.children[0]), full(c, n.children[0])] };
  return { id, kids: n.children.map((ch) => full(c, ch)) };
}
export const fullDecision = (c) => full(c, c.ir.root);

export function decisionKey(dec) {
  if (!dec.kids) return String(dec.id);
  return `${dec.id}(${dec.kids.map((k) => (k ? decisionKey(k) : "_")).join(",")})`;
}

const UNBOUNDED = (c, id) => ({ lo: -Infinity, hi: Infinity, dec: full(c, id) });

function visit(c, id, x, y, z, r) {
  const n = c.ir.nodes[id];
  if (n.inv) { const q = [0, 0, 0]; xformPoint(q, n.inv, x, y, z); x = q[0]; y = q[1]; z = q[2]; }
  switch (n.kind) {
    case "prim": { const v = evalPrim(n.prim.code, n.prim.P, x, y, z); return { lo: v - n.L * r, hi: v + n.L * r, dec: { id } }; }
    case "expr": { const v = sanitize(evalExprScalar(n.expr, x, y, z, c.textures, sampleTexture)); return { lo: v - n.L * r, hi: v + n.L * r, dec: { id } }; }
    case "union": {
      const rs = n.children.map((ch) => visit(c, ch, x, y, z, r));
      let H = Infinity;
      for (const a of rs) if (a.hi < H) H = a.hi;
      const kids = rs.map((a) => (a.lo > H + n.k ? null : a.dec));
      let lo = Infinity, kept = 0;
      rs.forEach((a, i) => { if (kids[i]) { kept++; if (a.lo < lo) lo = a.lo; } });
      if (n.k > 0) lo -= ((kept - 1) * n.k) / 4;
      return { lo, hi: H, dec: { id, kids } };
    }
    case "intersect": case "subtract": {
      const rs = n.children.map((ch, i) => {
        const a = visit(c, ch, x, y, z, r);
        return n.kind === "subtract" && i > 0 ? { lo: -a.hi, hi: -a.lo, dec: a.dec } : a;
      });
      let Lmax = -Infinity;
      for (const a of rs) if (a.lo > Lmax) Lmax = a.lo;
      const kids = rs.map((a) => (a.hi < Lmax - n.k ? null : a.dec));
      let hi = -Infinity, kept = 0;
      rs.forEach((a, i) => { if (kids[i]) { kept++; if (a.hi > hi) hi = a.hi; } });
      if (n.k > 0) hi += ((kept - 1) * n.k) / 4;
      return { lo: Lmax, hi, dec: { id, kids } };
    }
    case "mirror": {
      const A = visit(c, n.children[0], x, y, z, r), m = [0, 0, 0];
      mirrorPoint(m, n.axis, x, y, z);
      const B = visit(c, n.children[0], m[0], m[1], m[2], r);
      const keepA = !(A.lo > B.hi), keepB = !(B.lo > A.hi);
      const lo = Math.min(keepA ? A.lo : Infinity, keepB ? B.lo : Infinity), hi = Math.min(keepA ? A.hi : Infinity, keepB ? B.hi : Infinity);
      return { lo, hi, dec: { id, kids: [keepA ? A.dec : null, keepB ? B.dec : null] } };
    }
    case "round": { const a = visit(c, n.children[0], x, y, z, r); return { lo: a.lo - n.r, hi: a.hi - n.r, dec: { id, kids: [a.dec] } }; }
    case "onion": {
      const a = visit(c, n.children[0], x, y, z, r);
      const lo = a.lo >= 0 ? a.lo : a.hi <= 0 ? -a.hi : 0, hi = Math.max(Math.abs(a.lo), Math.abs(a.hi));
      return { lo: lo - n.t, hi: hi - n.t, dec: { id, kids: [a.dec] } };
    }
    case "displace": { const a = visit(c, n.children[0], x, y, z, r); return { lo: a.lo - n.amount, hi: a.hi + n.amount, dec: { id, kids: [a.dec] } }; }
    case "warp": {
      const q = [x, y, z], w = [0, 0, 0], { kind, W, B, Bt } = n.warp;
      if (B) xformDir(q, B, x, y, z);
      let S;
      if (kind === 1) S = 1 + Math.abs(W[0]) * (Math.sqrt(q[0] * q[0] + q[1] * q[1]) + r);
      else if (kind === 2) {
        const u = W[0] - q[0], rho = Math.sqrt(u * u + q[2] * q[2]);
        if (rho <= r) return UNBOUNDED(c, id);
        S = Math.max(1, W[0] / (rho - r));
      } else {
        const sAt = (zz) => { let t = (zz - W[0]) / (W[2] - W[0]); t = t < 0 ? 0 : t > 1 ? 1 : t; return W[1] + (W[3] - W[1]) * t; };
        const sMin = Math.min(sAt(q[2] - r), sAt(q[2] + r));   // s is linear (clamped) in z, so its minimum is at an end
        const slope = Math.abs(W[3] - W[1]) / Math.abs(W[2] - W[0]);
        S = Math.max(1, 1 / sMin) + (slope * (Math.sqrt(q[0] * q[0] + q[1] * q[1]) + r)) / (sMin * sMin);
      }
      warpPoint(w, kind, W, q[0], q[1], q[2]);
      if (Bt) xformDir(w, Bt, w[0], w[1], w[2]);
      const a = visit(c, n.children[0], w[0], w[1], w[2], r * S);
      return { lo: a.lo, hi: a.hi, dec: { id, kids: [a.dec] } };
    }
    case "ref": { const a = visit(c, n.children[0], x, y, z, r); return { lo: a.lo, hi: a.hi, dec: { id, kids: [a.dec] } }; }
    default: throw new Error(`implicit: unknown IR node kind ${n.kind}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-interval.test.js`
Expected: PASS. A failure on `warps` means a stretch factor S is too small — fix the factor (never widen the tolerance).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/interval.js test/implicit-interval.test.js test/fixtures/implicit-small-trees.js
git commit -m "feat(implicit): interval bounds and exact per-block pruning decisions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Bytecode emitter and batched interpreter

**Files:**
- Create: `src/framework/geometry/implicit/program.js`
- Test: `test/implicit-program.test.js`

**Interfaces:**
- Consumes: IR + decisions (Tasks 7–8), primitives.js, frames.js, expr-lower.js tables, `sampleTexture`.
- Produces: `OP` (opcode table); `emitProgram(compiled, dec) → Float64Array` (layout `[nP, nV, …instructions, OP.END, rootV]`; register `P0` holds the input point); `runProgram(prog, textures, X, Y, Z, n, out)` for `n ≤ BATCH` (256); `evalBatch(prog, textures, X, Y, Z, out)` for any length (chunks of `BATCH`). All arrays `Float64Array`.

Instruction encodings (every operand is a double in the program):

| Op | Encoding |
|---|---|
| `END` 0 | `0, rootV` |
| `XFORM` 1 | `1, dstP, srcP, m0…m11` |
| `XDIR` 2 | `2, dstP, srcP, m0…m11` (rotation only, translation entries ignored) |
| `PRIM` 3 | `3, code, dstV, srcP, nParams, …params` |
| `UNION` 4 / `INTER` 5 | `op, dstV, k, count, …srcV` |
| `NEG` 6 | `6, dstV, srcV` |
| `MIN2` 7 | `7, dstV, a, b` |
| `MIRRORP` 8 | `8, dstP, srcP, axis` |
| `ADDC` 9 | `9, dstV, srcV, c` (round: `c = −r`) |
| `ONION` 10 | `10, dstV, srcV, t` |
| `WARP` 11 | `11, kind, dstP, srcP, nParams, …params` |
| `DISP` 12 | `12, dstV, srcV, byV, amount` (`dst = src − amount·clampUnit(by)`) |
| `SANITIZE` 13 | `13, dstV, srcV` |
| `GET` 20 | `20, dstV, srcP, comp` |
| `CONST` 21 | `21, dstV, value` |
| `UN` 22 / `BIN` 23 / `TER` 24 | `op, fnCode, dstV, a[, b[, c]]` — fn codes index `UN_NAMES`/`BIN_NAMES`/`TER_NAMES` |
| `TEX` 25 | `25, dstV, slot, uV, vV` |

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-program.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { blockDecision, fullDecision } from "../src/framework/geometry/implicit/interval.js";
import { emitProgram, evalBatch } from "../src/framework/geometry/implicit/program.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

let seed = 5;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;

describe("bytecode", () => {
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: the full program equals the reference exactly`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      const prog = emitProgram(c, fullDecision(c));
      const N = 1000, X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), out = new Float64Array(N);
      for (let i = 0; i < N; i++) { X[i] = rnd() * 15; Y[i] = rnd() * 15; Z[i] = rnd() * 15; }
      evalBatch(prog, c.textures, X, Y, Z, out);
      for (let i = 0; i < N; i++) expect(out[i]).toBe(evalReference(c, X[i], Y[i], Z[i]));
    });
    test(`${name}: a pruned program equals the reference exactly inside its ball`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      for (let b = 0; b < 40; b++) {
        const cx = rnd() * 12, cy = rnd() * 12, cz = rnd() * 12, r = 1 + Math.abs(rnd()) * 2;
        const prog = emitProgram(c, blockDecision(c, cx, cy, cz, r).dec);
        const N = 64, X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), out = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          const dx = rnd(), dy = rnd(), dz = rnd(), l = Math.hypot(dx, dy, dz) || 1, t = (Math.abs(rnd()) * r) / l;
          X[i] = cx + dx * t; Y[i] = cy + dy * t; Z[i] = cz + dz * t;
        }
        evalBatch(prog, c.textures, X, Y, Z, out);
        for (let i = 0; i < N; i++) expect(out[i]).toBe(evalReference(c, X[i], Y[i], Z[i]));
      }
    });
  }
  test("Review Focus 1: NaN/∞ formulas read as outside without poisoning a union", () => {
    const c = lowerSpec({ root: { kind: "union", children: [
      { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return sqrt(-1.0) + 1.0 / 0.0;" },
      { kind: "sphere", r: 2 },
    ] } }, { images: new Map() });
    const prog = emitProgram(c, fullDecision(c));
    const out = new Float64Array(1);
    evalBatch(prog, c.textures, Float64Array.of(0), Float64Array.of(0), Float64Array.of(0), out);
    expect(out[0]).toBe(-2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-program.test.js`
Expected: FAIL — `program.js` not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/program.js
// Emits a decision tree as a self-contained Float64Array program and runs it over
// batches of points. Every per-lane computation calls the SAME scalar functions as
// reference.js, in the same order, so the two agree exactly. PR 2 ports runProgram
// to C++; the program format is the contract between them.
import { xformPoint, xformDir } from "./frames.js";
import { evalPrim, unionN, intersectN, warpPoint, mirrorPoint, sanitize, clampUnit } from "./primitives.js";
import { UN, BIN, TER } from "./expr-lower.js";
import { sampleTexture } from "./textures.js";

export const OP = Object.freeze({ END: 0, XFORM: 1, XDIR: 2, PRIM: 3, UNION: 4, INTER: 5, NEG: 6, MIN2: 7, MIRRORP: 8, ADDC: 9, ONION: 10, WARP: 11, DISP: 12, SANITIZE: 13, GET: 20, CONST: 21, UN: 22, BIN: 23, TER: 24, TEX: 25 });
export const UN_NAMES = Object.keys(UN), BIN_NAMES = Object.keys(BIN), TER_NAMES = Object.keys(TER);
const UN_FN = UN_NAMES.map((k) => UN[k]), BIN_FN = BIN_NAMES.map((k) => BIN[k]), TER_FN = TER_NAMES.map((k) => TER[k]);
export const BATCH = 256;

export function emitProgram(compiled, dec) {
  const code = [];
  let nP = 1, nV = 0;
  const newP = () => nP++, newV = () => nV++;
  const nodes = compiled.ir.nodes;

  function emitExpr(L, p) {
    const base = nV; nV += L.nregs;
    for (const o of L.ops) {
      const d = base + o.dst;
      if (o.op === "const") code.push(OP.CONST, d, o.val);
      else if (o.op === "get") code.push(OP.GET, d, p, o.comp);
      else if (o.op === "un") code.push(OP.UN, UN_NAMES.indexOf(o.fn), d, base + o.a);
      else if (o.op === "bin") code.push(OP.BIN, BIN_NAMES.indexOf(o.fn), d, base + o.a, base + o.b);
      else if (o.op === "ter") code.push(OP.TER, TER_NAMES.indexOf(o.fn), d, base + o.a, base + o.b, base + o.c);
      else if (o.op === "tex") code.push(OP.TEX, d, o.slot, base + o.u, base + o.v);
    }
    return base + L.result;
  }

  function emit(d, p) {
    const n = nodes[d.id];
    if (n.inv) { const q = newP(); code.push(OP.XFORM, q, p, ...n.inv); p = q; }
    switch (n.kind) {
      case "prim": { const v = newV(); code.push(OP.PRIM, n.prim.code, v, p, n.prim.P.length, ...n.prim.P); return v; }
      case "expr": { const r = emitExpr(n.expr, p), v = newV(); code.push(OP.SANITIZE, v, r); return v; }
      case "union": case "intersect": case "subtract": {
        const vs = [];
        d.kids.forEach((kd, i) => {
          if (!kd) return;
          let v = emit(kd, p);
          if (n.kind === "subtract" && i > 0) { const w = newV(); code.push(OP.NEG, w, v); v = w; }
          vs.push(v);
        });
        if (vs.length === 1) return vs[0];
        const out = newV();
        code.push(n.kind === "union" ? OP.UNION : OP.INTER, out, n.k, vs.length, ...vs);
        return out;
      }
      case "mirror": {
        const [da, db] = d.kids, vs = [];
        if (da) vs.push(emit(da, p));
        if (db) { const q = newP(); code.push(OP.MIRRORP, q, p, n.axis); vs.push(emit(db, q)); }
        if (vs.length === 1) return vs[0];
        const out = newV(); code.push(OP.MIN2, out, vs[0], vs[1]); return out;
      }
      case "round": { const v = emit(d.kids[0], p), out = newV(); code.push(OP.ADDC, out, v, -n.r); return out; }
      case "onion": { const v = emit(d.kids[0], p), out = newV(); code.push(OP.ONION, out, v, n.t); return out; }
      case "displace": {
        const v = emit(d.kids[0], p), by = emitExpr(n.by, p), out = newV();
        code.push(OP.DISP, out, v, by, n.amount);
        return out;
      }
      case "warp": {
        const { kind, W, B, Bt } = n.warp;
        let q = p;
        if (B) { const t = newP(); code.push(OP.XDIR, t, q, ...B); q = t; }
        const w = newP(); code.push(OP.WARP, kind, w, q, W.length, ...W); q = w;
        if (Bt) { const t = newP(); code.push(OP.XDIR, t, q, ...Bt); q = t; }
        return emit(d.kids[0], q);
      }
      case "ref": return emit(d.kids[0], p);
      default: throw new Error(`implicit: unknown IR node kind ${n.kind}`);
    }
  }

  const root = emit(dec, 0);
  code.push(OP.END, root);
  return Float64Array.from([nP, nV, ...code]);
}

// Register files are reused across runs (allocation-free hot loop). Not shared
// state in any observable sense: every run overwrites what it reads.
let PX = [], PY = [], PZ = [], V = [];
const ensure = (arr, count) => { while (arr.length < count) arr.push(new Float64Array(BATCH)); return arr; };
const tmp = [0, 0, 0];

export function runProgram(prog, textures, X, Y, Z, n, out) {
  const nP = prog[0], nV = prog[1];
  ensure(PX, nP); ensure(PY, nP); ensure(PZ, nP); ensure(V, nV);
  PX[0].set(X.subarray(0, n)); PY[0].set(Y.subarray(0, n)); PZ[0].set(Z.subarray(0, n));
  const gather = new Float64Array(64);
  let pc = 2;
  for (;;) {
    const op = prog[pc];
    switch (op) {
      case OP.END: { const v = V[prog[pc + 1]]; for (let i = 0; i < n; i++) out[i] = v[i]; return; }
      case OP.XFORM: case OP.XDIR: {
        const d = prog[pc + 1], s = prog[pc + 2], M = prog.subarray(pc + 3, pc + 15);
        const sx = PX[s], sy = PY[s], sz = PZ[s], dx = PX[d], dy = PY[d], dz = PZ[d];
        for (let i = 0; i < n; i++) {
          if (op === OP.XFORM) xformPoint(tmp, M, sx[i], sy[i], sz[i]); else xformDir(tmp, M, sx[i], sy[i], sz[i]);
          dx[i] = tmp[0]; dy[i] = tmp[1]; dz[i] = tmp[2];
        }
        pc += 15; break;
      }
      case OP.PRIM: {
        const code = prog[pc + 1], dv = V[prog[pc + 2]], s = prog[pc + 3], np = prog[pc + 4], P = prog.subarray(pc + 5, pc + 5 + np);
        const sx = PX[s], sy = PY[s], sz = PZ[s];
        for (let i = 0; i < n; i++) dv[i] = evalPrim(code, P, sx[i], sy[i], sz[i]);
        pc += 5 + np; break;
      }
      case OP.UNION: case OP.INTER: {
        const dv = V[prog[pc + 1]], k = prog[pc + 2], cnt = prog[pc + 3];
        const g = cnt <= gather.length ? gather : new Float64Array(cnt);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < cnt; j++) g[j] = V[prog[pc + 4 + j]][i];
          dv[i] = op === OP.UNION ? unionN(g, cnt, k) : intersectN(g, cnt, k);
        }
        pc += 4 + cnt; break;
      }
      case OP.NEG: { const d = V[prog[pc + 1]], s = V[prog[pc + 2]]; for (let i = 0; i < n; i++) d[i] = -s[i]; pc += 3; break; }
      case OP.MIN2: { const d = V[prog[pc + 1]], a = V[prog[pc + 2]], b = V[prog[pc + 3]]; for (let i = 0; i < n; i++) d[i] = Math.min(a[i], b[i]); pc += 4; break; }
      case OP.MIRRORP: {
        const d = prog[pc + 1], s = prog[pc + 2], axis = prog[pc + 3];
        for (let i = 0; i < n; i++) { mirrorPoint(tmp, axis, PX[s][i], PY[s][i], PZ[s][i]); PX[d][i] = tmp[0]; PY[d][i] = tmp[1]; PZ[d][i] = tmp[2]; }
        pc += 4; break;
      }
      case OP.ADDC: { const d = V[prog[pc + 1]], s = V[prog[pc + 2]], c = prog[pc + 3]; for (let i = 0; i < n; i++) d[i] = s[i] + c; pc += 4; break; }
      case OP.ONION: { const d = V[prog[pc + 1]], s = V[prog[pc + 2]], t = prog[pc + 3]; for (let i = 0; i < n; i++) d[i] = Math.abs(s[i]) - t; pc += 4; break; }
      case OP.WARP: {
        const kind = prog[pc + 1], d = prog[pc + 2], s = prog[pc + 3], np = prog[pc + 4], W = prog.subarray(pc + 5, pc + 5 + np);
        for (let i = 0; i < n; i++) { warpPoint(tmp, kind, W, PX[s][i], PY[s][i], PZ[s][i]); PX[d][i] = tmp[0]; PY[d][i] = tmp[1]; PZ[d][i] = tmp[2]; }
        pc += 5 + np; break;
      }
      case OP.DISP: {
        const d = V[prog[pc + 1]], s = V[prog[pc + 2]], b = V[prog[pc + 3]], a = prog[pc + 4];
        for (let i = 0; i < n; i++) d[i] = s[i] - a * clampUnit(b[i]);
        pc += 5; break;
      }
      case OP.SANITIZE: { const d = V[prog[pc + 1]], s = V[prog[pc + 2]]; for (let i = 0; i < n; i++) d[i] = sanitize(s[i]); pc += 3; break; }
      case OP.GET: { const d = V[prog[pc + 1]], s = prog[pc + 2], c = prog[pc + 3], src = c === 0 ? PX[s] : c === 1 ? PY[s] : PZ[s]; for (let i = 0; i < n; i++) d[i] = src[i]; pc += 4; break; }
      case OP.CONST: { const d = V[prog[pc + 1]], c = prog[pc + 2]; for (let i = 0; i < n; i++) d[i] = c; pc += 3; break; }
      case OP.UN: { const f = UN_FN[prog[pc + 1]], d = V[prog[pc + 2]], a = V[prog[pc + 3]]; for (let i = 0; i < n; i++) d[i] = f(a[i]); pc += 4; break; }
      case OP.BIN: { const f = BIN_FN[prog[pc + 1]], d = V[prog[pc + 2]], a = V[prog[pc + 3]], b = V[prog[pc + 4]]; for (let i = 0; i < n; i++) d[i] = f(a[i], b[i]); pc += 5; break; }
      case OP.TER: { const f = TER_FN[prog[pc + 1]], d = V[prog[pc + 2]], a = V[prog[pc + 3]], b = V[prog[pc + 4]], c = V[prog[pc + 5]]; for (let i = 0; i < n; i++) d[i] = f(a[i], b[i], c[i]); pc += 6; break; }
      case OP.TEX: {
        const d = V[prog[pc + 1]], t = textures[prog[pc + 2]], u = V[prog[pc + 3]], v = V[prog[pc + 4]];
        for (let i = 0; i < n; i++) d[i] = sampleTexture(t, u[i], v[i]);
        pc += 5; break;
      }
      default: throw new Error(`implicit: bad opcode ${op} at ${pc}`);
    }
  }
}

export function evalBatch(prog, textures, X, Y, Z, out) {
  const N = X.length;
  for (let s = 0; s < N; s += BATCH) {
    const n = Math.min(BATCH, N - s);
    const o = out.subarray(s, s + n);
    runProgram(prog, textures, X.subarray(s, s + n), Y.subarray(s, s + n), Z.subarray(s, s + n), n, o);
  }
}
```

The reference applies the mirror's child to the *original* point first, then the mirrored point — the emitter keeps that order (direct visit's value first in `MIN2`), and `Math.min` is symmetric, so values agree.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-program.test.js`
Expected: PASS (bit-exact equality with `toBe`).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/program.js test/implicit-program.test.js
git commit -m "feat(implicit): bytecode emitter and batched interpreter, exact to the reference

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Sparse sampler

**Files:**
- Create: `src/framework/geometry/implicit/sparse.js`
- Test: `test/implicit-sparse.test.js`

**Interfaces:**
- Consumes: `blockDecision`, `fullDecision`, `decisionKey` (Task 8); `emitProgram`, `evalBatch` (Task 9); `ImplicitSizeError` (Task 2).
- Produces: constants `LEAF = 4`, `TOP = 32`, `SNAP_CELLS = 0.25`, `PAD_CELLS = 1`, `MAX_SAMPLES = 24_000_000`, `MAX_GRID_CELLS = 2e10`; `sampleField(compiled, edge, { cull = true }) → Store` where
  `Store = { origin: [3], edge, n: [3], snap, leaves: Leaf[], programs: Map<string, Float64Array>, textures, samples: number, clipped: boolean }` and
  `Leaf = { i0, j0, l0, prog: Float64Array, vals: Float32Array((LEAF+1)³) }` (sample `(i, j, l)` local to the leaf at `vals[(l·S + j)·S + i]`, `S = LEAF + 1`).
- Sample rules: `|v| < snap → 0`; a sample on the grid's outer layer is raised to `max(v, 0.5·edge)` and sets `clipped` when `v ≤ 0` (Review Focus 2).

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-sparse.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField, LEAF } from "../src/framework/geometry/implicit/sparse.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const lower = (spec) => lowerSpec(spec, { images: new Map() });
const S = LEAF + 1;

describe("sparse sampler", () => {
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: culled leaves hold exactly the dense run's values; skipped leaves have no sign change`, () => {
      const c = lower(spec);
      const sparse = sampleField(c, 0.8), dense = sampleField(c, 0.8, { cull: false });
      const byKey = new Map(dense.leaves.map((l) => [`${l.i0},${l.j0},${l.l0}`, l]));
      for (const l of sparse.leaves) expect(Array.from(l.vals)).toEqual(Array.from(byKey.get(`${l.i0},${l.j0},${l.l0}`).vals));
      const kept = new Set(sparse.leaves.map((l) => `${l.i0},${l.j0},${l.l0}`));
      for (const l of dense.leaves) {
        if (kept.has(`${l.i0},${l.j0},${l.l0}`)) continue;
        let neg = 0, zero = 0;
        for (const v of l.vals) { if (v < 0) neg++; if (v === 0) zero++; }
        expect(zero).toBe(0);
        expect(neg === 0 || neg === S * S * S).toBe(true);
      }
      expect(sparse.samples).toBeLessThan(dense.samples * 0.6);
    });
  }
  test("a shape reaching the grid edge is clipped closed and flagged", () => {
    const c = lower({ root: { kind: "displace", amount: 3, by: { expr: "return 1.0;" }, child: { kind: "sphere", r: 4 } } });
    c.bounds = { min: [-4, -4, -4], max: [4, 4, 4] };   // pretend the box was declared too small
    const s = sampleField(c, 0.5);
    expect(s.clipped).toBe(true);
  });
  test("Review Focus 4: an absurd grid fails fast with IMPLICIT_SIZE", () => {
    const c = lower({ root: { kind: "sphere", r: 1000 } });
    const t0 = Date.now();
    let err;
    try { sampleField(c, 0.05); } catch (e) { err = e; }
    expect(err?.code).toBe("IMPLICIT_SIZE");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-sparse.test.js`
Expected: FAIL — `sparse.js` not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/sparse.js
// Coarse-to-fine sampling: blocks of TOP cells split in octants down to LEAF
// cells; a block is skipped when its interval excludes [−snap, snap] (exact — see
// interval.js). Surviving leaves get the program emitted from their own decision
// (shared across leaves with equal decisions) and their (LEAF+1)³ samples.
import { blockDecision, fullDecision, decisionKey } from "./interval.js";
import { emitProgram, evalBatch } from "./program.js";
import { ImplicitSizeError } from "./errors.js";

export const LEAF = 4, TOP = 32, SNAP_CELLS = 0.25, PAD_CELLS = 1;
export const MAX_SAMPLES = 24_000_000, MAX_GRID_CELLS = 2e10;
const SQRT3 = Math.sqrt(3);

export function sampleField(compiled, edge, { cull = true } = {}) {
  const { bounds } = compiled;
  const pad = 2 * edge;
  const origin = bounds.min.map((v) => v - pad);
  const n = [0, 1, 2].map((a) => Math.max(2, Math.ceil((bounds.max[a] + pad - origin[a]) / edge) + 1));
  const cells = (n[0] - 1) * (n[1] - 1) * (n[2] - 1);
  if (cells > MAX_GRID_CELLS) {
    throw new ImplicitSizeError(`a ${edge} mm grid over this shape has ${cells.toExponential(1)} cells (limit ${MAX_GRID_CELLS.toExponential(0)}) — raise \`resolution\`/\`preview\` or split the part`);
  }
  const snap = SNAP_CELLS * edge;
  const S = LEAF + 1, S3 = S * S * S;
  const programs = new Map(), leaves = [];
  const X = new Float64Array(S3), Y = new Float64Array(S3), Z = new Float64Array(S3), out = new Float64Array(S3);
  const fullDec = cull ? null : fullDecision(compiled);
  let samples = 0, clipped = false;

  const visit = (i0, j0, l0, B) => {
    let dec;
    if (cull) {
      const r = (B * edge * SQRT3) / 2 + PAD_CELLS * edge;
      const cx = origin[0] + (i0 + B / 2) * edge, cy = origin[1] + (j0 + B / 2) * edge, cz = origin[2] + (l0 + B / 2) * edge;
      const a = blockDecision(compiled, cx, cy, cz, r);
      // A sample is "on" the surface once |v| < snap: a block whose interval
      // excludes [−snap, snap] holds no surface and no snapped sample.
      if (a.lo > snap || a.hi < -snap) return;
      dec = a.dec;
    } else dec = fullDec;
    if (B > LEAF) {
      const h = B / 2;
      for (let dl = 0; dl < 2; dl++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
        const i = i0 + di * h, j = j0 + dj * h, l = l0 + dl * h;
        if (i < n[0] - 1 && j < n[1] - 1 && l < n[2] - 1) visit(i, j, l, h);
      }
      return;
    }
    const key = decisionKey(dec);
    let prog = programs.get(key);
    if (!prog) { prog = emitProgram(compiled, dec); programs.set(key, prog); }
    samples += S3;
    if (samples > MAX_SAMPLES) throw new ImplicitSizeError(`the surface needs more than ${MAX_SAMPLES} samples at a ${edge} mm grid — raise \`resolution\`/\`preview\` or split the part`);
    let q = 0;
    for (let l = 0; l < S; l++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++, q++) {
      X[q] = origin[0] + (i0 + i) * edge; Y[q] = origin[1] + (j0 + j) * edge; Z[q] = origin[2] + (l0 + l) * edge;
    }
    evalBatch(prog, compiled.textures, X, Y, Z, out);
    const vals = new Float32Array(S3);
    q = 0;
    for (let l = 0; l < S; l++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++, q++) {
      let v = out[q];
      const gi = i0 + i, gj = j0 + j, gl = l0 + l;
      if (gi === 0 || gj === 0 || gl === 0 || gi >= n[0] - 1 || gj >= n[1] - 1 || gl >= n[2] - 1) {
        if (v <= 0) clipped = true;
        if (v < 0.5 * edge) v = 0.5 * edge;
      }
      if (Math.abs(v) < snap) v = 0;
      vals[q] = v;
    }
    leaves.push({ i0, j0, l0, prog, vals });
  };

  for (let l = 0; l < n[2] - 1; l += TOP) for (let j = 0; j < n[1] - 1; j += TOP) for (let i = 0; i < n[0] - 1; i += TOP) visit(i, j, l, TOP);
  return { origin, edge, n, snap, leaves, programs, textures: compiled.textures, samples, clipped };
}
```

The ball radius is padded by `PAD_CELLS·edge` so each leaf's program stays exact for points up to one cell outside the leaf (Newton steps and cleanup moves, Tasks 11–12). The pad only makes culling slightly more conservative; it never skips a block that holds surface. If `MAX_GRID_CELLS` does not trip fast enough for Review Focus 4's case, the bound arithmetic is wrong — fix it, don't relax the timing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-sparse.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/sparse.js test/implicit-sparse.test.js
git commit -m "feat(implicit): sparse coarse-to-fine sampler with exact culling and size limits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Mesher and vertex projection

**Files:**
- Create: `src/framework/geometry/implicit/mesher.js`, `src/framework/geometry/implicit/project.js`
- Test: `test/implicit-mesher.test.js`, `test/helpers/mesh-topology.js`

**Interfaces:**
- Consumes: `Store` (Task 10), `evalBatch` (Task 9).
- Produces (mesher.js): `meshStore(store) → Mesh` where `Mesh = { positions: Float64Array, indices: Uint32Array, vertLeaf: Int32Array }` (`vertLeaf[v]` = index into `store.leaves` whose program is exact around `v`). Triangles are CCW seen from outside (normal along `+∇d`).
- Produces (project.js): `projectVertices(store, positions, vertLeaf, { maxStep, which?: Int32Array|null, normals?: Float64Array }) → void` — moves each vertex (or each listed vertex) one Newton step onto `d = 0` (step clamped to `maxStep`) and, if `normals` is given, writes the unit field gradient at the *original* position. Gradient by central differences with `e = 0.1·edge`.
- Produces (test helper): `edgeCheck(indices) → { boundary, nonManifold, misoriented }` (counts) and `eulerChar(positions, indices)`.

- [ ] **Step 1: Write the test helper and the failing test**

```js
// test/helpers/mesh-topology.js
// Closed-manifold checks for indexed triangle meshes.
export function edgeCheck(indices) {
  const half = new Map();
  for (let t = 0; t < indices.length; t += 3) for (let c = 0; c < 3; c++) {
    const a = indices[t + c], b = indices[t + ((c + 1) % 3)];
    const key = `${a},${b}`;
    half.set(key, (half.get(key) ?? 0) + 1);
  }
  let boundary = 0, nonManifold = 0, misoriented = 0;
  for (const [key, count] of half) {
    const [a, b] = key.split(",");
    const back = half.get(`${b},${a}`) ?? 0;
    if (count > 1) misoriented++;
    if (back === 0) boundary++;
    else if (back > 1) nonManifold++;
  }
  return { boundary, nonManifold, misoriented };
}

export function eulerChar(positions, indices) {
  const used = new Set(indices), edges = new Set();
  for (let t = 0; t < indices.length; t += 3) for (let c = 0; c < 3; c++) {
    const a = indices[t + c], b = indices[t + ((c + 1) % 3)];
    edges.add(a < b ? `${a},${b}` : `${b},${a}`);
  }
  return used.size - edges.size + indices.length / 3;
}

export function volume(positions, indices) {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}
```

```js
// test/implicit-mesher.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { edgeCheck, eulerChar, volume } from "./helpers/mesh-topology.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const lower = (spec) => lowerSpec(spec, { images: new Map() });

describe("mesher", () => {
  test("a sphere: closed, oriented, genus 0, volume within 1.5%", () => {
    const m = meshStore(sampleField(lower({ root: { kind: "sphere", r: 10 } }), 1));
    expect(edgeCheck(m.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
    expect(eulerChar(m.positions, m.indices)).toBe(2);
    const want = (4 / 3) * Math.PI * 1000;
    expect(Math.abs(volume(m.positions, m.indices) - want) / want).toBeLessThan(0.015);
  });
  test("a torus has genus 1", () => {
    const m = meshStore(sampleField(lower({ root: { kind: "torus", R: 8, r: 3 } }), 0.8));
    expect(edgeCheck(m.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
    expect(eulerChar(m.positions, m.indices)).toBe(0);
  });
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: sparse and dense runs give the identical mesh`, () => {
      const c = lower(spec);
      const a = meshStore(sampleField(c, 0.8)), b = meshStore(sampleField(c, 0.8, { cull: false }));
      expect(edgeCheck(a.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
      expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
      expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    });
  }
  test("Review Focus 2: a clipped shape still closes", () => {
    const c = lower({ root: { kind: "sphere", r: 6 } });
    c.bounds = { min: [-4, -4, -4], max: [4, 4, 4] };
    const s = sampleField(c, 0.5);
    expect(s.clipped).toBe(true);
    expect(edgeCheck(meshStore(s).indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-mesher.test.js`
Expected: FAIL — `mesher.js` not found.

- [ ] **Step 3: Implement `project.js`**

```js
// src/framework/geometry/implicit/project.js
// Newton projection of mesh vertices onto d = 0, batched per leaf: each vertex is
// evaluated with its own leaf's program, which is exact within PAD_CELLS of the
// leaf (sparse.js), so every move stays inside that guarantee.
import { evalBatch } from "./program.js";

export function projectVertices(store, positions, vertLeaf, { maxStep, which = null, normals = null }) {
  const e = 0.1 * store.edge;
  const groups = new Map();   // leaf index -> vertex list (insertion order = vertex order)
  const count = which ? which.length : positions.length / 3;
  for (let q = 0; q < count; q++) {
    const v = which ? which[q] : q, L = vertLeaf[v];
    let g = groups.get(L);
    if (!g) { g = []; groups.set(L, g); }
    g.push(v);
  }
  for (const [L, verts] of groups) {
    const prog = store.leaves[L].prog, m = verts.length;
    const X = new Float64Array(7 * m), Y = new Float64Array(7 * m), Z = new Float64Array(7 * m), out = new Float64Array(7 * m);
    verts.forEach((v, k) => {
      const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2], o = 7 * k;
      X[o] = x; Y[o] = y; Z[o] = z;
      X[o + 1] = x + e; Y[o + 1] = y; Z[o + 1] = z;
      X[o + 2] = x - e; Y[o + 2] = y; Z[o + 2] = z;
      X[o + 3] = x; Y[o + 3] = y + e; Z[o + 3] = z;
      X[o + 4] = x; Y[o + 4] = y - e; Z[o + 4] = z;
      X[o + 5] = x; Y[o + 5] = y; Z[o + 5] = z + e;
      X[o + 6] = x; Y[o + 6] = y; Z[o + 6] = z - e;
    });
    evalBatch(prog, store.textures, X, Y, Z, out);
    verts.forEach((v, k) => {
      const o = 7 * k, d = out[o];
      const gx = (out[o + 1] - out[o + 2]) / (2 * e), gy = (out[o + 3] - out[o + 4]) / (2 * e), gz = (out[o + 5] - out[o + 6]) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (!(g2 > 1e-12)) return;
      const gl = Math.sqrt(g2);
      if (normals) { normals[3 * v] = gx / gl; normals[3 * v + 1] = gy / gl; normals[3 * v + 2] = gz / gl; }
      let t = d / gl;                              // signed distance estimate along the gradient
      if (t > maxStep) t = maxStep; else if (t < -maxStep) t = -maxStep;
      positions[3 * v] -= (gx / gl) * t; positions[3 * v + 1] -= (gy / gl) * t; positions[3 * v + 2] -= (gz / gl) * t;
    });
  }
}
```

- [ ] **Step 4: Implement `mesher.js`**

```js
// src/framework/geometry/implicit/mesher.js
// Marching tetrahedra over the sparse store: each leaf's cells are split into the
// six Kuhn tetrahedra (face-consistent, so the surface closes), crossings are
// welded per grid edge (key = lowCorner·8 + direction bits), and snapped samples
// (value 0) become one vertex per grid point, projected back onto the surface.
import { projectVertices } from "./project.js";
import { LEAF } from "./sparse.js";

const KUHN = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];

function tetGradient(p, v) {
  const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const c = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
  const r = [v[1] - v[0], v[2] - v[0], v[3] - v[0]];
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (Math.abs(det) < 1e-18) return [0, 0, 1];
  const inv = 1 / det;
  return [
    (r[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (r[1] * c[2] - b[2] * r[2]) + a[2] * (r[1] * c[1] - b[1] * r[2])) * inv,
    (a[0] * (r[1] * c[2] - b[2] * r[2]) - r[0] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * r[2] - r[1] * c[0])) * inv,
    (a[0] * (b[1] * r[2] - r[1] * c[1]) - a[1] * (b[0] * r[2] - r[1] * c[0]) + r[0] * (b[0] * c[1] - b[1] * c[0])) * inv,
  ];
}

export function meshStore(store) {
  const { origin, edge, n, leaves } = store;
  const S = LEAF + 1;
  const positions = [], indices = [], vertLeaf = [];
  const edgeVerts = new Map(), gridVerts = new Map();
  const snapped = [];   // grid vertices to project (vertex ids)
  const gIndex = (i, j, l) => (l * n[1] + j) * n[0] + i;
  const p4 = [null, null, null, null], v4 = [0, 0, 0, 0];

  for (let L = 0; L < leaves.length; L++) {
    const { i0, j0, l0, vals } = leaves[L];
    const at = (i, j, l) => vals[(l * S + j) * S + i];
    const posOf = (i, j, l) => [origin[0] + (i0 + i) * edge, origin[1] + (j0 + j) * edge, origin[2] + (l0 + l) * edge];
    const gridVertex = (i, j, l) => {
      const g = gIndex(i0 + i, j0 + j, l0 + l);
      let v = gridVerts.get(g);
      if (v !== undefined) return v;
      v = positions.length / 3;
      positions.push(...posOf(i, j, l));
      vertLeaf.push(L);
      gridVerts.set(g, v);
      snapped.push(v);
      return v;
    };
    // Corner c of cell (i, j, l): offset bits (c & 1, c >> 1 & 1, c >> 2 & 1).
    const vertexOn = (i, j, l, ca, cb) => {
      const lo = ca & cb, dir = ca ^ cb;               // Kuhn edges run low → high along monotone bits
      const hi = lo | dir;
      const li = i + (lo & 1), lj = j + ((lo >> 1) & 1), ll = l + ((lo >> 2) & 1);
      const hi_i = i + (hi & 1), hi_j = j + ((hi >> 1) & 1), hi_l = l + ((hi >> 2) & 1);
      const a = at(li, lj, ll), b = at(hi_i, hi_j, hi_l);
      if (a === 0) return gridVertex(li, lj, ll);
      if (b === 0) return gridVertex(hi_i, hi_j, hi_l);
      const key = gIndex(i0 + li, j0 + lj, l0 + ll) * 8 + dir;
      let v = edgeVerts.get(key);
      if (v !== undefined) return v;
      const t = a / (a - b), pa = posOf(li, lj, ll), pb = posOf(hi_i, hi_j, hi_l);
      v = positions.length / 3;
      positions.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
      vertLeaf.push(L);
      edgeVerts.set(key, v);
      return v;
    };
    const tri = (a, b, c, g) => {
      if (a === b || b === c || a === c) return;   // collapsed by a snap
      const ax = positions[3 * a], ay = positions[3 * a + 1], az = positions[3 * a + 2];
      const ux = positions[3 * b] - ax, uy = positions[3 * b + 1] - ay, uz = positions[3 * b + 2] - az;
      const vx = positions[3 * c] - ax, vy = positions[3 * c + 1] - ay, vz = positions[3 * c + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * g[0] + ny * g[1] + nz * g[2] < 0) indices.push(a, c, b); else indices.push(a, b, c);
    };
    const iEnd = Math.min(LEAF, n[0] - 1 - i0), jEnd = Math.min(LEAF, n[1] - 1 - j0), lEnd = Math.min(LEAF, n[2] - 1 - l0);
    for (let l = 0; l < lEnd; l++) for (let j = 0; j < jEnd; j++) for (let i = 0; i < iEnd; i++) {
      let neg = 0;
      for (let c = 0; c < 8; c++) if (at(i + (c & 1), j + ((c >> 1) & 1), l + ((c >> 2) & 1)) < 0) neg++;
      if (neg === 0 || neg === 8) continue;
      for (const tet of KUHN) {
        let inside = 0;
        for (let q = 0; q < 4; q++) {
          const c = tet[q], ci = i + (c & 1), cj = j + ((c >> 1) & 1), cl = l + ((c >> 2) & 1);
          v4[q] = at(ci, cj, cl); p4[q] = posOf(ci, cj, cl);
          if (v4[q] < 0) inside++;
        }
        if (inside === 0 || inside === 4) continue;
        const g = tetGradient(p4, v4);
        const negC = [], posC = [];
        for (let q = 0; q < 4; q++) (v4[q] < 0 ? negC : posC).push(tet[q]);
        if (inside === 1 || inside === 3) {
          const lone = inside === 1 ? negC[0] : posC[0], others = inside === 1 ? posC : negC;
          tri(vertexOn(i, j, l, lone, others[0]), vertexOn(i, j, l, lone, others[1]), vertexOn(i, j, l, lone, others[2]), g);
        } else {
          const [n0, n1] = negC, [q0, q1] = posC;
          const v00 = vertexOn(i, j, l, n0, q0), v01 = vertexOn(i, j, l, n0, q1), v10 = vertexOn(i, j, l, n1, q0), v11 = vertexOn(i, j, l, n1, q1);
          tri(v00, v01, v11, g);
          tri(v00, v11, v10, g);
        }
      }
    }
  }
  const out = { positions: Float64Array.from(positions), indices: Uint32Array.from(indices), vertLeaf: Int32Array.from(vertLeaf) };
  if (snapped.length) projectVertices(store, out.positions, out.vertLeaf, { maxStep: store.snap, which: Int32Array.from(snapped) });
  return out;
}
```

Why the sparse/dense meshes are identical: culled leaves contain no zero and no sign change, so they emit nothing; vertices are created in leaf order, and the dense run's extra leaves sit between the sparse run's ones only where they emit nothing. Edge vertices interpolate low → high, so a crossing gets the same coordinates whichever leaf reaches it first.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/implicit-mesher.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/implicit/mesher.js src/framework/geometry/implicit/project.js test/implicit-mesher.test.js test/helpers/mesh-topology.js
git commit -m "feat(implicit): sparse marching tetrahedra with snap and Newton projection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Mesh cleanup

**Files:**
- Create: `src/framework/geometry/implicit/cleanup.js`
- Test: `test/implicit-cleanup.test.js`

**Interfaces:**
- Consumes: `Store`, `Mesh` (Tasks 10–11), `projectVertices` (Task 11).
- Produces: `CLEANUP = { collapseFrac: 0.2, relaxPasses: 2, relaxWeight: 0.5, maxMoveCells: 0.5 }`; `cleanupMesh(store, mesh, opts = CLEANUP) → { positions, indices, vertLeaf, normals: Float64Array }`.
- Algorithm (deterministic, single collapse pass then relax/project passes): (1) collapse every edge shorter than `collapseFrac·edge` in triangle order, skipping vertices already touched this pass, requiring the link condition (exactly two common neighbours) and no triangle normal flipping; the survivor moves to the midpoint; compact vertices in first-use order. (2) Project (records normals). (3) `relaxPasses` × { tangential umbrella smoothing with weight `relaxWeight`, each move clamped to `maxMoveCells·edge`; project }.

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-cleanup.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh, CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { evalReference } from "../src/framework/geometry/implicit/reference.js";
import { edgeCheck, eulerChar } from "./helpers/mesh-topology.js";
import { TREES } from "./fixtures/implicit-small-trees.js";

const minAngles = (P, T) => {
  const out = [];
  for (let t = 0; t < T.length; t += 3) {
    const v = [0, 1, 2].map((c) => [P[3 * T[t + c]], P[3 * T[t + c] + 1], P[3 * T[t + c] + 2]]);
    let m = Math.PI;
    for (let c = 0; c < 3; c++) {
      const a = v[c], b = v[(c + 1) % 3], d = v[(c + 2) % 3];
      const u = b.map((x, i) => x - a[i]), w = d.map((x, i) => x - a[i]);
      const cos = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
      m = Math.min(m, Math.acos(Math.max(-1, Math.min(1, cos))));
    }
    out.push(m);
  }
  return out.sort((a, b) => a - b);
};

describe("cleanup", () => {
  for (const [name, spec] of Object.entries(TREES)) {
    test(`${name}: topology kept, slivers gone, vertices on the surface, triangles better`, () => {
      const c = lowerSpec(spec, { images: new Map() });
      const edge = 0.8, store = sampleField(c, edge), raw = meshStore(store);
      const out = cleanupMesh(store, raw);
      expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
      expect(eulerChar(out.positions, out.indices)).toBe(eulerChar(raw.positions, raw.indices));
      let worst = 0;
      for (let v = 0; v < out.positions.length / 3; v++) {
        worst = Math.max(worst, Math.abs(evalReference(c, out.positions[3 * v], out.positions[3 * v + 1], out.positions[3 * v + 2])));
      }
      expect(worst).toBeLessThan(0.05 * edge);
      const before = minAngles(raw.positions, raw.indices), after = minAngles(out.positions, out.indices);
      expect(after[Math.floor(after.length * 0.05)]).toBeGreaterThan(before[Math.floor(before.length * 0.05)]);
      expect(out.normals.length).toBe(out.positions.length);
    });
  }
  test("deterministic: two runs are byte-identical", () => {
    const c = lowerSpec(TREES.blobs, { images: new Map() });
    const run = () => { const s = sampleField(c, 0.8); return cleanupMesh(s, meshStore(s)); };
    const a = run(), b = run();
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
  test("defaults are the documented ones", () => {
    expect(CLEANUP).toEqual({ collapseFrac: 0.2, relaxPasses: 2, relaxWeight: 0.5, maxMoveCells: 0.5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-cleanup.test.js`
Expected: FAIL — `cleanup.js` not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/cleanup.js
// Replaces the spike's Manifold simplify/smoothOut/refine round trips: one pass of
// topology-safe short-edge collapse, then tangential relaxation alternating with
// projection onto the field. Deterministic: triangle order, first-use compaction.
import { projectVertices } from "./project.js";

export const CLEANUP = Object.freeze({ collapseFrac: 0.2, relaxPasses: 2, relaxWeight: 0.5, maxMoveCells: 0.5 });

function triNormal(P, a, b, c, out) {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
}

function collapse(P, T, vertLeaf, minLen) {
  const nv = P.length / 3, nt = T.length / 3;
  const vt = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) vt[T[3 * t + c]].push(t);
  const alive = new Uint8Array(nt).fill(1), locked = new Uint8Array(nv);
  const min2 = minLen * minLen, n0 = [0, 0, 0], n1 = [0, 0, 0];
  const ring = (v) => {
    const s = new Set();
    for (const t of vt[v]) if (alive[t]) for (let c = 0; c < 3; c++) if (T[3 * t + c] !== v) s.add(T[3 * t + c]);
    return s;
  };
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    for (let c = 0; c < 3; c++) {
      const a = T[3 * t + c], b = T[3 * t + ((c + 1) % 3)];
      if (locked[a] || locked[b]) continue;
      const dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
      if (dx * dx + dy * dy + dz * dz >= min2) continue;
      const ra = ring(a), rb = ring(b);
      let common = 0;
      for (const v of ra) if (rb.has(v)) common++;
      if (common !== 2) continue;
      const mx = (P[3 * a] + P[3 * b]) / 2, my = (P[3 * a + 1] + P[3 * b + 1]) / 2, mz = (P[3 * a + 2] + P[3 * b + 2]) / 2;
      // No flips: every surviving triangle around a or b keeps its orientation.
      let ok = true;
      const save = [P[3 * a], P[3 * a + 1], P[3 * a + 2], P[3 * b], P[3 * b + 1], P[3 * b + 2]];
      for (const v of [a, b]) for (const tt of vt[v]) {
        if (!ok || !alive[tt]) continue;
        const i = T[3 * tt], j = T[3 * tt + 1], k = T[3 * tt + 2];
        if ((i === a || j === a || k === a) && (i === b || j === b || k === b)) continue;
        triNormal(P, i, j, k, n0);
        P[3 * a] = P[3 * b] = mx; P[3 * a + 1] = P[3 * b + 1] = my; P[3 * a + 2] = P[3 * b + 2] = mz;
        triNormal(P, i, j, k, n1);
        P[3 * a] = save[0]; P[3 * a + 1] = save[1]; P[3 * a + 2] = save[2]; P[3 * b] = save[3]; P[3 * b + 1] = save[4]; P[3 * b + 2] = save[5];
        if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] <= 0) ok = false;
      }
      if (!ok) continue;
      P[3 * a] = mx; P[3 * a + 1] = my; P[3 * a + 2] = mz;
      for (const tt of vt[b]) {
        if (!alive[tt]) continue;
        let hasA = false;
        for (let q = 0; q < 3; q++) if (T[3 * tt + q] === a) hasA = true;
        if (hasA) { alive[tt] = 0; continue; }
        for (let q = 0; q < 3; q++) if (T[3 * tt + q] === b) T[3 * tt + q] = a;
        vt[a].push(tt);
      }
      locked[a] = locked[b] = 1;
      break;   // triangle t is gone; move on
    }
  }
  // Compact: vertices renumbered in order of first use by a surviving triangle.
  const map = new Int32Array(nv).fill(-1), outT = [], outP = [], outL = [];
  for (let t = 0; t < nt; t++) {
    if (!alive[t]) continue;
    for (let c = 0; c < 3; c++) {
      const v = T[3 * t + c];
      if (map[v] < 0) { map[v] = outP.length / 3; outP.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); outL.push(vertLeaf[v]); }
      outT.push(map[v]);
    }
  }
  return { positions: Float64Array.from(outP), indices: Uint32Array.from(outT), vertLeaf: Int32Array.from(outL) };
}

function relax(P, T, N, weight, maxMove) {
  const nv = P.length / 3, sum = new Float64Array(3 * nv), cnt = new Uint32Array(nv);
  for (let t = 0; t < T.length; t += 3) for (let c = 0; c < 3; c++) {
    const a = T[t + c], b = T[t + ((c + 1) % 3)];
    sum[3 * a] += P[3 * b]; sum[3 * a + 1] += P[3 * b + 1]; sum[3 * a + 2] += P[3 * b + 2]; cnt[a]++;
    sum[3 * b] += P[3 * a]; sum[3 * b + 1] += P[3 * a + 1]; sum[3 * b + 2] += P[3 * a + 2]; cnt[b]++;
  }
  for (let v = 0; v < nv; v++) {
    if (!cnt[v]) continue;
    let dx = sum[3 * v] / cnt[v] - P[3 * v], dy = sum[3 * v + 1] / cnt[v] - P[3 * v + 1], dz = sum[3 * v + 2] / cnt[v] - P[3 * v + 2];
    const nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2], dn = dx * nx + dy * ny + dz * nz;
    dx = (dx - dn * nx) * weight; dy = (dy - dn * ny) * weight; dz = (dz - dn * nz) * weight;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > maxMove) { const s = maxMove / l; dx *= s; dy *= s; dz *= s; }
    P[3 * v] += dx; P[3 * v + 1] += dy; P[3 * v + 2] += dz;
  }
}

export function cleanupMesh(store, mesh, opts = CLEANUP) {
  const edge = store.edge;
  const m = collapse(Float64Array.from(mesh.positions), Uint32Array.from(mesh.indices), mesh.vertLeaf, opts.collapseFrac * edge);
  const normals = new Float64Array(m.positions.length);
  const maxStep = opts.maxMoveCells * edge;
  projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals });
  for (let pass = 0; pass < opts.relaxPasses; pass++) {
    relax(m.positions, m.indices, normals, opts.relaxWeight, maxStep);
    projectVertices(store, m.positions, m.vertLeaf, { maxStep, normals });
  }
  return { ...m, normals };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-cleanup.test.js`
Expected: PASS. If the on-surface bound fails, add one more `projectVertices` call at the end of `cleanupMesh` (a second Newton step) before touching thresholds.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/cleanup.js test/implicit-cleanup.test.js
git commit -m "feat(implicit): native-portable mesh cleanup — collapse, relax, project

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Surface detail

**Files:**
- Create: `src/framework/geometry/implicit/detail.js`
- Test: `test/implicit-detail.test.js`

**Interfaces:**
- Consumes: `DetailEntry[]` (Task 7), cleaned mesh + normals (Task 12), `projectVertices` (Task 11), `valueNoise` (Task 1), `pfCos`, `pfAtan2`, `sampleTexture`, `evalExprScalar`, frames.js.
- Produces: `MAX_REFINE_ROUNDS = 3`; `detailHeight(entry, textures, x, y, z, nx, ny, nz) → number`; `applySurfaceDetail(store, mesh, compiled) → { positions, indices, vertLeaf, normals }`.
- Refinement: up to 3 rounds; an edge is split when longer than `max(edge/8, min target over entries active at either endpoint)` (`expr` with no `wavelength` uses `edge/2`); conforming red-green splits (1, 2 or 3 marked edges → 2, 3 or 4 triangles); new midpoints are projected onto the field with normals recomputed; finally every vertex moves `normal × Σ heights`.

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-detail.test.js
import { describe, test, expect } from "vitest";
import { lowerSpec } from "../src/framework/geometry/implicit/ir.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail, detailHeight } from "../src/framework/geometry/implicit/detail.js";
import { edgeCheck, eulerChar } from "./helpers/mesh-topology.js";
import { pfCos } from "../src/framework/geometry/js-math.js";

const build = (spec, images = new Map(), edge = 1) => {
  const c = lowerSpec(spec, { images }), s = sampleField(c, edge);
  return { c, s, m: cleanupMesh(s, meshStore(s)) };
};

describe("surface detail", () => {
  test("creases height matches the formula", () => {
    const { c } = build({ root: { kind: "sphere", r: 5 }, detail: [{ kind: "creases", amplitude: 0.4, wavelength: 2, axis: "x" }] });
    const h = detailHeight(c.detail[0], c.textures, 0.3, 0, 5, 0, 0, 1);
    expect(h).toBe(-0.4 * Math.max(0, pfCos((2 * Math.PI * 0.3) / 2)));
  });
  test("radius and side limit where detail applies", () => {
    const { c } = build({ root: { kind: "sphere", r: 5 }, detail: [{ kind: "noise", amplitude: 1, wavelength: 1, radius: 2, side: [0, 0, 1] }] });
    expect(detailHeight(c.detail[0], c.textures, 3, 0, 0, 0, 0, 1)).toBe(0);    // outside radius
    expect(detailHeight(c.detail[0], c.textures, 0.5, 0, 0, 0, 0, -1)).toBe(0); // facing away
  });
  test("refines only where detail applies, stays closed, keeps topology", () => {
    const { c, s, m } = build({ root: { kind: "box", size: [20, 20, 6], round: 2 },
      detail: [{ kind: "creases", amplitude: 0.3, wavelength: 1.2, axis: "x", at: [0, 0, 3], radius: 4, side: [0, 0, 1] }] });
    const out = applySurfaceDetail(s, m, c);
    expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
    expect(eulerChar(out.positions, out.indices)).toBe(2);
    expect(out.indices.length).toBeGreaterThan(m.indices.length);
    expect(out.indices.length).toBeLessThan(m.indices.length * 4);   // local, not global
    let minZ = Infinity;
    for (let v = 0; v < out.positions.length / 3; v++) {
      const x = out.positions[3 * v], y = out.positions[3 * v + 1], z = out.positions[3 * v + 2];
      if (Math.hypot(x, y) < 1 && z > 2) minZ = Math.min(minZ, z);
    }
    expect(minZ).toBeLessThan(2.85);   // grooves cut into the top face at z = 3
  });
  test("texture detail embosses where the image is white", () => {
    const data = new Uint16Array(4 * 4).fill(65535);
    const images = new Map([["w", { digest: "w1", width: 4, height: 4, data }]]);
    const { c, s, m } = build({ root: { kind: "box", size: [10, 10, 4] },
      detail: [{ kind: "texture", image: "w", amplitude: 0.5, size: [10, 10], side: [0, 0, 1] }] }, images);
    const out = applySurfaceDetail(s, m, c);
    let maxZ = -Infinity;
    for (let v = 0; v < out.positions.length / 3; v++) maxZ = Math.max(maxZ, out.positions[3 * v + 2]);
    expect(maxZ).toBeGreaterThan(2.4);
    expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-detail.test.js`
Expected: FAIL — `detail.js` not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/detail.js
// Surface detail finer than the grid (spec §1 "Detail: two places"): refine the
// mesh only where an entry applies, then move vertices along the field normal by
// the summed heights. Native-portable arithmetic only.
import { pfCos, pfAtan2 } from "../js-math.js";
import { xformPoint, xformDir } from "./frames.js";
import { valueNoise } from "./noise.js";
import { sampleTexture } from "./textures.js";
import { evalExprScalar } from "./expr-lower.js";
import { projectVertices } from "./project.js";

export const MAX_REFINE_ROUNDS = 3;
const TWO_PI = 2 * Math.PI;

function weight(e, lx, ly, lz, nx, ny, nz) {
  let w = 1;
  if (e.side) {
    const d = nx * e.side[0] + ny * e.side[1] + nz * e.side[2];
    const s = (d - 0.15) / 0.5;
    w = s < 0 ? 0 : s > 1 ? 1 : s;
    if (w === 0) return 0;
  }
  if (e.radius != null) {
    const r2 = (lx * lx + ly * ly + lz * lz) / (e.radius * e.radius);
    if (r2 >= 1) return 0;
    const f = 1 - r2;
    w *= f * f;
  }
  return w;
}

function planar(t, axis, lx, ly, lz, size) {
  const u = axis === 2 ? lx : axis === 0 ? ly : lz, v = axis === 2 ? ly : axis === 0 ? lz : lx;
  return sampleTexture(t, u / size[0] + 0.5, v / size[1] + 0.5);
}

export function detailHeight(e, textures, x, y, z, nx, ny, nz) {
  const p = [x, y, z], n = [nx, ny, nz];
  if (e.inv) { xformPoint(p, e.inv, x, y, z); xformDir(n, e.inv, nx, ny, nz); }
  const w = weight(e, p[0], p[1], p[2], n[0], n[1], n[2]);
  if (w === 0) return 0;
  switch (e.kind) {
    case "creases": return -e.amplitude * Math.max(0, pfCos((TWO_PI * p[e.axis]) / e.wavelength)) * w;
    case "noise": return e.amplitude * 2 * valueNoise(p[0] / e.wavelength, p[1] / e.wavelength, p[2] / e.wavelength) * w;
    case "texture": {
      const t = textures[e.slot];
      let v;
      if (e.projection === "cylindrical") {
        const a = e.axis, u = pfAtan2(p[(a + 2) % 3], p[(a + 1) % 3]) / TWO_PI + 0.5;
        v = sampleTexture(t, u, p[a] / e.size[1] + 0.5);
      } else if (e.projection === "triplanar") {
        const ax = n[0] * n[0] * n[0] * n[0], ay = n[1] * n[1] * n[1] * n[1], az = n[2] * n[2] * n[2] * n[2], s = ax + ay + az;
        v = (planar(t, 0, p[0], p[1], p[2], e.size) * ax + planar(t, 1, p[0], p[1], p[2], e.size) * ay + planar(t, 2, p[0], p[1], p[2], e.size) * az) / s;
      } else v = planar(t, e.axis, p[0], p[1], p[2], e.size);
      return e.amplitude * v * w;
    }
    case "expr": {
      const v = evalExprScalar(e.height, p[0], p[1], p[2], textures, sampleTexture);
      return (v === v ? v : 0) * w;
    }
    default: return 0;
  }
}

// Split pattern for a triangle with midpoints m[0] (v0v1), m[1] (v1v2), m[2] (v2v0), −1 = none.
function splitTri(out, v, m) {
  const k = (m[0] >= 0) + (m[1] >= 0) + (m[2] >= 0);
  if (k === 3) { out.push(v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]); return; }
  // Rotate so the pattern is canonical: for k = 1 the marked edge is edge 0;
  // for k = 2 the unmarked edge is edge 2.
  let r = 0;
  if (k === 1) r = m[0] >= 0 ? 0 : m[1] >= 0 ? 1 : 2;
  else r = m[2] < 0 ? 0 : m[0] < 0 ? 1 : 2;
  const V = [v[r], v[(r + 1) % 3], v[(r + 2) % 3]], M = [m[r], m[(r + 1) % 3], m[(r + 2) % 3]];
  if (k === 1) out.push(V[0], M[0], V[2], M[0], V[1], V[2]);
  else out.push(M[0], V[1], M[1], V[0], M[0], M[1], V[0], M[1], V[2]);
}

export function applySurfaceDetail(store, mesh, compiled) {
  const entries = compiled.detail, tex = compiled.textures, edge = store.edge;
  let P = Array.from(mesh.positions), N = Array.from(mesh.normals), T = Array.from(mesh.indices), VL = Array.from(mesh.vertLeaf);
  // The refinement mask is exactly "some entry's weight is non-zero here".
  const targetAt = (v) => {
    let t = Infinity;
    for (const e of entries) {
      if (weight(e, ...localOf(e, P, N, v)) > 0) t = Math.min(t, e.target === Infinity ? edge / 2 : e.target);
    }
    return Math.max(edge / 8, t);
  };
  for (let round = 0; round < MAX_REFINE_ROUNDS; round++) {
    const nv = P.length / 3, target = new Float64Array(nv);
    for (let v = 0; v < nv; v++) target[v] = targetAt(v);
    const mid = new Map(), added = [];
    const midpoint = (a, b) => {
      const key = a < b ? a * nv + b : b * nv + a;
      let m = mid.get(key);
      if (m !== undefined) return m;
      const lim = Math.min(target[a], target[b]);
      const dx = P[3 * a] - P[3 * b], dy = P[3 * a + 1] - P[3 * b + 1], dz = P[3 * a + 2] - P[3 * b + 2];
      if (!(lim < Infinity) || dx * dx + dy * dy + dz * dz <= lim * lim) { mid.set(key, -1); return -1; }
      m = P.length / 3;
      P.push((P[3 * a] + P[3 * b]) / 2, (P[3 * a + 1] + P[3 * b + 1]) / 2, (P[3 * a + 2] + P[3 * b + 2]) / 2);
      N.push(0, 0, 0); VL.push(VL[a]); added.push(m);
      mid.set(key, m);
      return m;
    };
    const out = [];
    for (let t = 0; t < T.length; t += 3) {
      const v = [T[t], T[t + 1], T[t + 2]];
      splitTri(out, v, [midpoint(v[0], v[1]), midpoint(v[1], v[2]), midpoint(v[2], v[0])]);
    }
    if (!added.length) break;
    T = out;
    const Pf = Float64Array.from(P), Nf = Float64Array.from(N);
    projectVertices(store, Pf, Int32Array.from(VL), { maxStep: edge, which: Int32Array.from(added), normals: Nf });
    P = Array.from(Pf); N = Array.from(Nf);
  }
  const positions = Float64Array.from(P), normals = Float64Array.from(N);
  for (let v = 0; v < positions.length / 3; v++) {
    let h = 0;
    for (const e of entries) h += detailHeight(e, tex, positions[3 * v], positions[3 * v + 1], positions[3 * v + 2], normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]);
    if (h === 0) continue;
    positions[3 * v] += normals[3 * v] * h; positions[3 * v + 1] += normals[3 * v + 1] * h; positions[3 * v + 2] += normals[3 * v + 2] * h;
  }
  return { positions, indices: Uint32Array.from(T), vertLeaf: Int32Array.from(VL), normals };
}

function localOf(e, P, N, v) {
  const p = [P[3 * v], P[3 * v + 1], P[3 * v + 2]], n = [N[3 * v], N[3 * v + 1], N[3 * v + 2]];
  if (e.inv) { xformPoint(p, e.inv, p[0], p[1], p[2]); xformDir(n, e.inv, n[0], n[1], n[2]); }
  return [p[0], p[1], p[2], n[0], n[1], n[2]];
}
```

Note: `xformPoint(p, e.inv, p[0], p[1], p[2])` passes the coordinates by value before writing, so reusing `p` is safe.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-detail.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/detail.js test/implicit-detail.test.js
git commit -m "feat(implicit): surface detail with local red-green refinement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Engine entry point

**Files:**
- Create: `src/framework/geometry/implicit/index.js`
- Test: `test/implicit-engine.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `IMPLICIT_DEFAULTS = { resolution: 0.6, preview: 1.5 }`; `compileImplicit(spec, { images }) → Compiled` (validate + lower); `meshImplicit(compiled, edge) → { positions: Float64Array, indices: Uint32Array, normals: Float64Array, warnings: string[], stats: { samples, leaves, programs } }`; `implicitHashable(spec, compiled) → object` (the spec plus `digests`; used as the kernel cache key).

- [ ] **Step 1: Write the failing test**

```js
// test/implicit-engine.test.js
import { describe, test, expect } from "vitest";
import { compileImplicit, meshImplicit, implicitHashable, IMPLICIT_DEFAULTS } from "../src/framework/geometry/implicit/index.js";
import { edgeCheck } from "./helpers/mesh-topology.js";

describe("engine entry", () => {
  test("compile + mesh a blended pair", () => {
    const spec = { root: { kind: "union", k: 2, children: [{ kind: "sphere", r: 5 }, { kind: "capsule", a: [0, 0, 0], b: [12, 0, 0], r: 2 }] } };
    const out = meshImplicit(compileImplicit(spec), 1);
    expect(edgeCheck(out.indices)).toEqual({ boundary: 0, nonManifold: 0, misoriented: 0 });
    expect(out.stats.leaves).toBeGreaterThan(0);
    expect(out.warnings).toEqual([]);
  });
  test("warns on features thinner than two grid cells and on clipping", () => {
    const thin = meshImplicit(compileImplicit({ root: { kind: "box", size: [10, 10, 1] } }), 0.8);
    expect(thin.warnings.join(" ")).toMatch(/thinnest feature \(1\.00 mm\) is under 2 grid cells/);
  });
  test("invalid specs throw IMPLICIT_SPEC before any sampling", () => {
    expect(() => compileImplicit({ root: { kind: "sphere", r: 0 } })).toThrow(/root\.r: must be a number > 0/);
  });
  test("hashable carries image digests", () => {
    const data = new Uint16Array(4);
    const images = new Map([["m", { digest: "abc", width: 2, height: 2, data }]]);
    const spec = { root: { kind: "expr", box: [[-1, -1, -1], [1, 1, 1]], sdf: "return length(p) - 0.5 - texture(t, p.xy);", textures: { t: { image: "m" } } } };
    expect(implicitHashable(spec, compileImplicit(spec, { images })).digests).toEqual(["abc"]);
  });
  test("defaults", () => expect(IMPLICIT_DEFAULTS).toEqual({ resolution: 0.6, preview: 1.5 }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/implicit-engine.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/implicit/index.js
// The implicit engine's public surface for the kernels: compile a spec once,
// mesh it at a grid edge. Pure and DOM-free (loads in the geometry worker).
import { validateSpec } from "./grammar.js";
import { lowerSpec } from "./ir.js";
import { sampleField } from "./sparse.js";
import { meshStore } from "./mesher.js";
import { cleanupMesh } from "./cleanup.js";
import { applySurfaceDetail } from "./detail.js";

export const IMPLICIT_DEFAULTS = Object.freeze({ resolution: 0.6, preview: 1.5 });

export function compileImplicit(spec, { images = new Map() } = {}) {
  validateSpec(spec, { imageNames: new Set(images.keys()) });
  return lowerSpec(spec, { images });
}

export function meshImplicit(compiled, edge) {
  const store = sampleField(compiled, edge);
  let mesh = cleanupMesh(store, meshStore(store));
  if (compiled.detail.length) mesh = applySurfaceDetail(store, mesh, compiled);
  const warnings = [];
  if (compiled.thin < 2 * edge) {
    warnings.push(`implicit: thinnest feature (${compiled.thin.toFixed(2)} mm) is under 2 grid cells at ${edge} mm — it may break up or grow handles; mesh it as its own k.implicit with a finer grid, or thicken it`);
  }
  if (store.clipped) warnings.push("implicit: the shape reached the edge of its sampling box and was clipped flat there — enlarge the `box` of any `expr` node, or reduce blend widths and displacement");
  return { positions: mesh.positions, indices: mesh.indices, normals: mesh.normals, warnings,
    stats: { samples: store.samples, leaves: store.leaves.length, programs: store.programs.size } };
}

export const implicitHashable = (spec, compiled) => ({ spec, digests: compiled.digests });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/implicit-engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/implicit/index.js test/implicit-engine.test.js
git commit -m "feat(implicit): engine entry — compileImplicit/meshImplicit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Kernel wiring

**Files:**
- Modify: `src/framework/geometry/mesh-build.js` (add `manifoldFromWeldedMesh` after the comment block above `manifoldFromMesh`)
- Modify: `src/framework/geometry/manifold-backend.js` (import; new `implicit` op next to `loft`)
- Modify: `src/framework/geometry/occt-backend.js` (an `implicit` that throws; register it in `finishKernel({...})`)
- Modify: `src/framework/geometry/kernel.js` (`KERNEL_OPS` += `"implicit"`)
- Modify: `src/framework/geometry/op-options.js` (`KERNEL_OP_SPECS.implicit`)
- Modify: `types/kernel.d.ts` (`ImplicitOptions`, `implicit(o): Solid`)
- Modify: `docs/KERNEL-CONTRACT.md` (one table row)
- Modify: `test/op-options.test.js` (expected op list)
- Test: `test/implicit-manifold.test.js`, `test/implicit-occt.test.js`

**Interfaces:**
- Consumes: `compileImplicit`, `meshImplicit`, `implicitHashable`, `IMPLICIT_DEFAULTS` (Task 14); `SMOOTH` from `./shading-policy.js`; the backend's `h`, `cache.lookup`, `T`, `wrap`, `recordWarning`, `oidPolicies`, `images`, `quality`.
- Produces: `k.implicit({ frames?, root, detail?, resolution?, preview? }) → Solid` on Manifold; on OCCT it throws `Error` whose message contains `implicit: builds on the Manifold backend`.

- [ ] **Step 1: Write the failing tests**

```js
// test/implicit-manifold.test.js
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const ball = { root: { kind: "sphere", r: 10 }, preview: 1 };

describe("k.implicit on Manifold", () => {
  test("a watertight genus-0 solid with the right volume", () => {
    const s = k.implicit(ball);
    const want = (4 / 3) * Math.PI * 1000;
    expect(Math.abs(s.volume() - want) / want).toBeLessThan(0.02);
    if (typeof s.genus === "function") expect(s.genus()).toBe(0);
  });
  test("composes with ordinary booleans", () => {
    const s = k.implicit(ball).subtract(k.box([-20, -20, 0], [20, 20, 20]));
    expect(s.boundingBox().max[2]).toBeLessThanOrEqual(1e-6);
  });
  test("cache key: equal specs share a hash, different specs do not", () => {
    expect(k.implicit(ball)._hash).toBe(k.implicit({ ...ball })._hash);
    expect(k.implicit(ball)._hash).not.toBe(k.implicit({ ...ball, root: { kind: "sphere", r: 9 } })._hash);
  });
  test("textures read registered images, and the image digest is in the key", async () => {
    const data = new Uint16Array(16).fill(32768);
    await k._registerImage({ name: "grey", digest: "g1", width: 4, height: 4, data });
    const spec = { root: { kind: "displace", amount: 1, by: { expr: "return texture(t, p.xy * 0.05 + 0.5);", textures: { t: { image: "grey" } } }, child: { kind: "sphere", r: 8 } }, preview: 1 };
    const a = k.implicit(spec);
    await k._registerImage({ name: "grey", digest: "g2", width: 4, height: 4, data: new Uint16Array(16) });
    const b = k.implicit(spec);
    expect(a._hash).not.toBe(b._hash);
    expect(a.volume()).toBeGreaterThan(b.volume());   // grey (0.5) lowers d by 0.5: the surface moves OUT 0.5 mm
  });
  test("Review Focus 5: an empty result is a clear error", () => {
    expect(() => k.implicit({ root: { kind: "subtract", children: [{ kind: "sphere", r: 2 }, { kind: "sphere", r: 5 }] }, preview: 1 }))
      .toThrow(/implicit: the shape is empty/);
  });
  test("spec errors surface with their path", () => {
    expect(() => k.implicit({ root: { kind: "sphere", r: -1 } })).toThrow(/root\.r: must be a number > 0/);
  });
});
```

```js
// test/implicit-occt.test.js — its own file: OCCT and Manifold never boot in one process.
import { test, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

test("OCCT refuses k.implicit with a clear message (tessellated STEP lands in PR 4)", () => {
  expect(() => k.implicit({ root: { kind: "sphere", r: 1 } })).toThrow(/implicit: builds on the Manifold backend/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/implicit-manifold.test.js test/implicit-occt.test.js`
Expected: FAIL — `k.implicit is not a function`.

- [ ] **Step 3: Implement**

`src/framework/geometry/mesh-build.js` — add above `manifoldFromMesh`:

```js
// Same import for a mesh whose vertices are ALREADY shared by index (welded) —
// skips `merge()`, which re-derives vertex identity from positions and costs
// about a third of the import on a 200k-triangle mesh. Only for meshes a
// partforge mesher produced with index sharing (implicit/mesher.js); an
// arbitrary soup still goes through manifoldFromMesh.
export function manifoldFromWeldedMesh(wasm, V, Tr) {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(V), triVerts: Uint32Array.from(Tr) });
  const out = wasm.Manifold.ofMesh(mesh);
  mesh.delete?.();
  return out;
}
```

`src/framework/geometry/manifold-backend.js` — change the mesh-build import to `import { manifoldFromMesh, manifoldFromWeldedMesh, ringStackManifold } from "./mesh-build.js";`, add `import { compileImplicit, meshImplicit, implicitHashable, IMPLICIT_DEFAULTS } from "./implicit/index.js";`, make sure `SMOOTH` is in the existing `shading-policy.js` import (it already is: `import { loftShadingPolicy, SMOOTH, BLEND } from "./shading-policy.js";`), and add this op directly after `loft`:

```js
    // Signed-distance tree → solid (implicit/index.js). The engine meshes at the
    // tier's grid (`preview` for preview, `resolution` for print) and hands
    // Manifold one welded mesh; the result shades SMOOTH (one surface, no creases).
    // Cached on the spec plus every bound image's digest, per quality tier.
    implicit: (spec) => {
      const compiled = compileImplicit(spec, { images });
      const key = h("implicit", implicitHashable(spec, compiled), quality);
      return cache.lookup(key, () => {
        const edge = quality === "print" ? (spec.resolution ?? IMPLICIT_DEFAULTS.resolution) : (spec.preview ?? IMPLICIT_DEFAULTS.preview);
        const out = meshImplicit(compiled, edge);
        for (const w of out.warnings) recordWarning(w);
        if (out.indices.length === 0) throw new Error(`implicit: the shape is empty at a ${edge} mm grid — nothing is inside it (check subtract order and sizes), or it is thinner than the grid`);
        const m = T(T(manifoldFromWeldedMesh(wasm, out.positions, out.indices)).asOriginal());
        const id = m.originalID();
        oidPolicies.set(id, SMOOTH);
        return { value: wrap(m, key), pin: m, dispose: () => { oidPolicies.delete(id); m.delete?.(); } };
      });
    },
```

`images` here is the backend's registered-image map (`name → { digest, width, height, data }`), the same one `heightfield` reads — it already has the shape `compileImplicit` expects.

`src/framework/geometry/occt-backend.js` — add before `const kernel = finishKernel({`:

```js
  // k.implicit is mesh-native: its booleans are mesh booleans, which OCCT cannot
  // run on a triangulated body. Tessellated STEP (feat/implicit PR 4) routes
  // implicit sub-parts to Manifold and writes their meshes into the STEP file.
  const implicit = () => {
    throw new Error("implicit: builds on the Manifold backend only — set `meta.backend: \"manifold\"` for this part (STEP export of implicit sub-parts is not supported yet)");
  };
```

and add `implicit` to the `finishKernel({ … })` object next to `heightfield`.

`src/framework/geometry/kernel.js` — append to `KERNEL_OPS` after `"tappedBore"`:

```js
  // Signed-distance tree → solid (implicit/). Mesh-native: Manifold builds it;
  // OCCT throws until tessellated STEP lands (feat/implicit PR 4).
  "implicit",
```

`src/framework/geometry/op-options.js` — add after the `loftSmooth` entry:

```js
  // implicit({frames?, root, detail?, resolution?, preview?}); the tree itself is
  // validated by implicit/grammar.js with path-precise messages.
  implicit: { toArgs: passThrough("implicit", ["frames", "root", "detail", "resolution", "preview"], ["root"]) },
```

`test/op-options.test.js` — add `"implicit"` to the expected `KERNEL_OP_SPECS` key list (find the array the test compares against with `grep -n "loftSmooth" test/op-options.test.js`, and insert `"implicit"` right after `"loftSmooth"`).

`types/kernel.d.ts` — next to `HeightfieldOptions`:

```ts
/** k.implicit — a signed-distance element tree meshed into a solid (docs/superpowers/specs/2026-10-14-implicit-organic-parts-design.md). */
export interface ImplicitNode { kind: string; frame?: string; at?: [number, number, number]; label?: string; [field: string]: unknown; }
export interface ImplicitFrame { parent?: string; at?: [number, number, number]; rotate?: { axis: "x" | "y" | "z" | [number, number, number]; deg: number } | Array<{ axis: "x" | "y" | "z" | [number, number, number]; deg: number }>; }
export interface ImplicitOptions {
  frames?: Record<string, ImplicitFrame>;
  root: ImplicitNode;
  detail?: Array<{ kind: "creases" | "noise" | "texture" | "expr"; [field: string]: unknown }>;
  /** Print/export grid edge, mm. Default 0.6. */
  resolution?: number;
  /** Preview grid edge, mm. Default 1.5. */
  preview?: number;
}
```

and in the kernel interface, next to `heightfield(...)`: `implicit(o: ImplicitOptions): Solid;`. (PR 5 replaces `ImplicitNode` with the full typed union.)

`docs/KERNEL-CONTRACT.md` — add a row to the ops table right after the `heightfield` row:

```markdown
| `implicit({frames?, root, detail?, resolution?, preview?})` | **Unreleased (feat/implicit).** A signed-distance element tree (primitives, n-ary smooth blends, warps, repeat, `expr` formulas with image textures) on named frames, meshed watertight at the tier's grid (`preview` for preview, `resolution` for print/export). Mesh-native: Manifold builds it; OCCT throws until tessellated STEP. Full entry, conformance class and contract-version decision arrive with the feature's final PR. |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/implicit-manifold.test.js test/implicit-occt.test.js test/op-options.test.js test/kernel-contract.test.js test/types-surface.test.js`
Expected: PASS. If `types-surface` or `kernel-contract` fails, read its message: they hold the d.ts and the contract doc to `KERNEL_OPS` — adjust the d.ts/doc row wording, never the tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/mesh-build.js src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/kernel.js src/framework/geometry/op-options.js types/kernel.d.ts docs/KERNEL-CONTRACT.md test/op-options.test.js test/implicit-manifold.test.js test/implicit-occt.test.js
git commit -m "feat(implicit): k.implicit on the Manifold kernel; OCCT refuses clearly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Reference fixtures, topology sweep, fuzz, bench and tuning

**Files:**
- Create: `test/fixtures/implicit-trees.js`, `test/implicit-topology.test.js`, `scripts/bench-implicit.mjs`
- Modify: `package.json` (add `"bench:implicit": "node scripts/bench-implicit.mjs"`), `docs/research/organic-shapes.md` (new §8)

**Interfaces:**
- Consumes: the whole engine, `bootManifoldKernel`.
- Produces: `handSpec(pose?) → spec` and `nailSpecs(pose?) → spec[]` (the spike hand, ported to the final grammar), `vaseSpec() → { spec, images }` (exercises taper, twist, repeat, expr gyroid, displace + texture, texture detail), `ADVERSARIAL` (named specs), `randomSpec(seed) → spec`.

- [ ] **Step 1: Port the hand**

Read the spike's tree with `git show c0b5b5d3:src/parts/hand-spike.js` (functions `finger`, `nail`, `build`). Create `test/fixtures/implicit-trees.js` that exports `handSpec(pose)` returning `{ frames, root: body, detail, preview: 1.5, resolution: 0.8 }` built **exactly** like the spike's `build` (same `FINGERS`, `THUMB`, `FAN`, frame chains, palm/finger/thumb unions, crease entries), with these changes:
  - no `k`; return the spec object.
  - `pose` defaults: `{ curl: 30, spread: 8, flex: { index: 60, middle: 60, ring: 60, pinky: 60, thumb: 50 }, oppose: 20, handLength: 190, slender: 1, knuckles: 0.5, fingerBlend: 3, palmBlend: 8, creases: true, creaseDepth: 0.5 }`, merged with the argument (`{ ...DEFAULTS, ...pose, flex: { ...DEFAULTS.flex, ...pose.flex } }`), so `handSpec({ curl: 100 })` works.
  - drop `mesher`/`polish`; drop `pores`.
  - `nailSpecs(pose)` returns one spec per digit exactly like the spike's `nail` minus `mesher`, with `{ resolution: 0.25, preview: 0.35 }`.

Then add to the same file:

```js
export function vaseSpec() {
  const n = 64, data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = ((x >> 3) + (y >> 3)) % 2 ? 65535 : 0;   // checker
  const images = new Map([["checker", { digest: "checker-64", width: n, height: n, data }]]);
  const spec = {
    root: { kind: "union", k: 2, children: [
      { kind: "taper", from: [0, 1], to: [60, 0.55], child: { kind: "twist", degPerMm: 1.5, child: {
        kind: "onion", t: 1.6, child: { kind: "union", k: 3, children: [
          { kind: "cylinder", h: 60, r: 20, at: [0, 0, 30], round: 4 },
          { kind: "repeat", polar: { count: 12 }, child: { kind: "capsule", a: [20, 0, 4], b: [20, 0, 56], r: 2.2 } },
        ] } } } },
      { kind: "intersect", children: [
        { kind: "expr", box: [[-12, 14, 10], [12, 26, 40]], lipschitz: 1.8,
          sdf: "float g = sin(p.x*k)*cos(p.y*k) + sin(p.y*k)*cos(p.z*k) + sin(p.z*k)*cos(p.x*k); return abs(g)/k - t;", uniforms: { k: 0.9, t: 0.35 } },
        { kind: "box", size: [20, 8, 26], at: [0, 20, 25], round: 2 },
      ] },
    ] },
    detail: [{ kind: "texture", image: "checker", amplitude: 0.4, projection: "cylindrical", axis: "z", size: [40, 60], at: [0, 0, 30], radius: 30 }],
    preview: 1.2, resolution: 0.6,
  };
  return { spec, images };
}

export const ADVERSARIAL = {
  tangentSpheres: { root: { kind: "union", children: [{ kind: "sphere", r: 5 }, { kind: "sphere", r: 5, at: [10, 0, 0] }] }, preview: 1 },
  coincidentFaces: { root: { kind: "union", children: [{ kind: "box", size: [10, 10, 10] }, { kind: "box", size: [10, 10, 10], at: [10, 0, 0] }] }, preview: 1 },
  thinPlate: { root: { kind: "box", size: [30, 30, 0.9] }, preview: 1 },
  highLipschitz: { root: { kind: "expr", box: [[-10, -10, -10], [10, 10, 10]], lipschitz: 3,
    sdf: "return max(length(p) - 9.0, (sin(p.x*3.0)+sin(p.y*3.0)+sin(p.z*3.0)) * 0.33);" }, preview: 0.8 },
  displaceAtLimit: { root: { kind: "displace", amount: 2, by: { expr: "return sin(p.x) * sin(p.y) * sin(p.z) > 0.0 ? 1.0 : -1.0;" }, child: { kind: "sphere", r: 8 } }, preview: 1 },
};

/** Seeded random trees: unions/intersections/subtractions of placed primitives, warps and repeats. */
export function randomSpec(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const v3 = (r) => [(rnd() * 2 - 1) * r, (rnd() * 2 - 1) * r, (rnd() * 2 - 1) * r];
  const leaf = () => pick([
    () => ({ kind: "sphere", r: 2 + rnd() * 4, at: v3(6) }),
    () => ({ kind: "box", size: [2 + rnd() * 8, 2 + rnd() * 8, 2 + rnd() * 8], round: rnd() * 0.9, at: v3(6) }),
    () => ({ kind: "capsule", a: v3(6), b: v3(6), r: [1.5 + rnd() * 2, 1.5 + rnd() * 2] }),
    () => ({ kind: "torus", R: 4 + rnd() * 3, r: 1.2 + rnd(), at: v3(4), axis: pick(["x", "y", "z"]) }),
  ])();
  const node = (depth) => {
    if (depth === 0) return leaf();
    const kind = pick(["union", "union", "intersect", "subtract", "twist", "repeat"]);
    if (kind === "twist") return { kind, degPerMm: rnd() * 8 - 4, child: node(depth - 1) };
    if (kind === "repeat") return { kind, polar: { count: 2 + Math.floor(rnd() * 4) }, child: { ...leaf(), at: [7, 0, 0] } };
    return { kind, k: rnd() * 3, children: [node(depth - 1), node(depth - 1), ...(rnd() < 0.5 ? [leaf()] : [])] };
  };
  return { root: node(2), preview: 1 };
}
```

- [ ] **Step 2: Write the topology sweep and fuzz test**

```js
// test/implicit-topology.test.js
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { compileImplicit, meshImplicit } from "../src/framework/geometry/implicit/index.js";
import { handSpec, nailSpecs, vaseSpec, ADVERSARIAL, randomSpec } from "./fixtures/implicit-trees.js";
import { edgeCheck } from "./helpers/mesh-topology.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
const CLOSED = { boundary: 0, nonManifold: 0, misoriented: 0 };

describe("topology", () => {
  for (const curl of [0, 50, 100]) {
    test(`hand at curl ${curl}: watertight, genus 0, nails attach`, () => {
      const pose = { curl };
      let hand = k.implicit(handSpec(pose));
      expect(hand.genus()).toBe(0);
      hand = k.union([hand, ...nailSpecs(pose).map((s) => k.implicit(s))]);
      expect(hand.genus()).toBe(0);
      expect(hand.volume()).toBeGreaterThan(0);
    }, 60_000);
  }
  test("vase: all grammar features in one part", async () => {
    const { spec, images } = vaseSpec();
    for (const [name, im] of images) await k._registerImage({ name, ...im });
    const v = k.implicit(spec);
    expect(v.volume()).toBeGreaterThan(0);
  }, 60_000);
  for (const [name, spec] of Object.entries(ADVERSARIAL)) {
    test(`adversarial ${name}: closed and accepted by Manifold (Review Focus 3)`, () => {
      const out = meshImplicit(compileImplicit(spec), spec.preview);
      expect(edgeCheck(out.indices)).toEqual(CLOSED);
      expect(k.implicit(spec).volume()).toBeGreaterThan(0);
    });
  }
  test("volume is stable across grid sizes (within 3%)", () => {
    const spec = handSpec({ curl: 30 });
    const a = k.implicit({ ...spec, preview: 1.5 }).volume(), b = k.implicit({ ...spec, preview: 1.0 }).volume();
    expect(Math.abs(a - b) / b).toBeLessThan(0.03);
  }, 60_000);
  test("seeded fuzz: 40 random trees mesh closed", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const spec = randomSpec(seed);
      let out;
      try { out = meshImplicit(compileImplicit(spec), spec.preview); } catch (e) { if (e.code === "IMPLICIT_SPEC") continue; throw e; }
      if (out.indices.length === 0) continue;
      expect(edgeCheck(out.indices), `seed ${seed}`).toEqual(CLOSED);
    }
  }, 120_000);
});
```

- [ ] **Step 3: Run it; fix real failures in the engine, not in the test**

Run: `npx vitest run test/implicit-topology.test.js`
Expected: PASS. A genus ≠ 0 on the hand at one pose is the spike's known sub-cell sliver (research doc §7c): first check whether `CLEANUP.collapseFrac` is removing it; if not, record the pose and grid in the commit and keep the test at that pose — do not delete it.

- [ ] **Step 4: Write the bench**

```js
// scripts/bench-implicit.mjs — times each engine stage on the reference fixtures.
// Usage: node scripts/bench-implicit.mjs   (Node 24)
import { compileImplicit } from "../src/framework/geometry/implicit/index.js";
import { sampleField } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { cleanupMesh } from "../src/framework/geometry/implicit/cleanup.js";
import { applySurfaceDetail } from "../src/framework/geometry/implicit/detail.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handSpec, vaseSpec } from "../test/fixtures/implicit-trees.js";

const time = (f) => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };
const k = await bootManifoldKernel();
const { spec: vase, images } = vaseSpec();
for (const [name, im] of images) await k._registerImage({ name, ...im });
const cases = [["hand preview", handSpec(), 1.5, new Map()], ["hand print", handSpec(), 0.8, new Map()], ["vase preview", vase, 1.2, images]];
console.log("case            compile  sample  mesh  cleanup  detail  total   tris     samples  programs");
for (const [name, spec, edge, imgs] of cases) {
  for (let warm = 0; warm < 2; warm++) {
    const [c, tc] = time(() => compileImplicit(spec, { images: imgs }));
    const [s, ts] = time(() => sampleField(c, edge));
    const [m, tm] = time(() => meshStore(s));
    const [cl, tcl] = time(() => cleanupMesh(s, m));
    const [d, td] = time(() => (c.detail.length ? applySurfaceDetail(s, cl, c) : cl));
    if (warm === 0) continue;
    const total = tc + ts + tm + tcl + td;
    console.log(`${name.padEnd(15)} ${tc.toFixed(0).padStart(7)} ${ts.toFixed(0).padStart(7)} ${tm.toFixed(0).padStart(5)} ${tcl.toFixed(0).padStart(8)} ${td.toFixed(0).padStart(7)} ${total.toFixed(0).padStart(6)} ${String(d.indices.length / 3).padStart(8)} ${String(s.samples).padStart(9)} ${String(s.programs.size).padStart(9)}`);
  }
}
const [, tk] = time(() => k.implicit({ ...handSpec(), preview: 1.5 }));
console.log(`k.implicit(hand) end to end, cold: ${tk.toFixed(0)} ms`);
```

Add to `package.json` `scripts`: `"bench:implicit": "node scripts/bench-implicit.mjs"`.

- [ ] **Step 5: Tune and record (the spec's "open at plan start" item)**

Run: `npm run bench:implicit` three times. Then try, one at a time, `LEAF` ∈ {2, 4, 8}, `TOP` ∈ {16, 32}, `CLEANUP.collapseFrac` ∈ {0.15, 0.2, 0.3}, `relaxPasses` ∈ {1, 2, 3}, re-running `npx vitest run test/implicit-*.test.js` after each change (all must pass). Keep the fastest setting whose tests pass and whose cleanup test's 5th-percentile minimum angle does not drop. Write the chosen values and the final bench table into a new section of `docs/research/organic-shapes.md`:

```markdown
## 8. JS engine (feat/implicit PR 1)

Chosen constants (frozen here before the C++ port): LEAF = …, TOP = …, collapseFrac = …, relaxPasses = …, relaxWeight = …, maxMoveCells = ….
Measured on <machine>, Node 24 (`npm run bench:implicit`, warm):

<paste the table>

Compared with the spike's sparse JS pass (§7d): hand preview 0.72 s plain / 1.5 s full.
```

If constants changed from the plan's defaults, update the `CLEANUP` assertion in `test/implicit-cleanup.test.js` to match.

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: PASS except known CPU-load flakes; re-run any timeout alone (`npx vitest run <file>`) and confirm it passes before moving on.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/implicit-trees.js test/implicit-topology.test.js scripts/bench-implicit.mjs package.json docs/research/organic-shapes.md src/framework/geometry/implicit/
git commit -m "test(implicit): hand/vase fixtures, topology sweep, fuzz, bench; freeze tuned constants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Open PR 1 into `feat/implicit`**

Ask the user before pushing. Then:

```bash
git push -u origin feat/implicit
git push -u origin feat/implicit-1-js-engine
gh pr create --base feat/implicit --head feat/implicit-1-js-engine --title "k.implicit PR 1: grammar, compiler and JS engine" --body-file <a file you write in the reader-friendly style from the user's CLAUDE.md: plain summary first, a short "what this means in practice" list, the bench table, then a note that this is PR 1 of 5 into feat/implicit, with no version bump. End with: 🤖 Generated with [Claude Code](https://claude.com/claude-code)>
```

---

## Plans for PRs 2–5

Each gets its own plan, written once the previous PR merges into `feat/implicit` (the C++ port must follow the constants frozen in Task 16; routing and STEP depend on the op's final shape):

- **PR 2 — C++ port and parity:** `native/implicit_*.{h,cpp}` mirroring `js-math.js` trig, `noise.js`, `primitives.js`, `program.js` (`runProgram`), `sparse.js`, `mesher.js`, `project.js`, `cleanup.js`, `detail.js`; `test/core-parity.test.js` gains the hand and vase; `test/core-structures.test.js` gains the leaf store and collapse structures; the spec's speed targets become CI gates via `bench:implicit`.
- **PR 3 — block sample cache** (spec §4).
- **PR 4 — routing and tessellated STEP** (spec §5), starting with the OCCT writer-route check.
- **PR 5 — lint, reports, docs and the hand and vase reference parts** (spec §6–§7), including the full typed node union and the contract-version decision.
