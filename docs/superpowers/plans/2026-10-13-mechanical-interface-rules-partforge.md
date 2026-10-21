# Mechanical interface rules (partforge side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the DFM profiles the fit, hole and bridge numbers the cloud prompt will cite, and add a `_view.held` expectation that fails when an exportable sub-part is connected to nothing.

**Architecture:** Three profile fields are plain data on `PROFILES` (`src/framework/oracle/dfm-profiles.js`), read by nobody in this repo yet; they exist so the docs carry one spelling and an inline profile can override them. `held` is a pair-derived check like `contacts`: `evaluateCase` peels it off `_view`, a new import-free module `src/framework/oracle/held.js` builds a contact graph from the facts' `overlaps` and `gaps` (joined when overlapping or within `CONTACT_EPS`), and answers one structured check object. Lint mirrors the peel and validates the value statically; types, the error-pattern catalog and AUTHORING-PARTS.md say the same thing.

**Tech Stack:** Node 24 ESM, vitest (`npm test`), `tsc` typecheck, eslint + knip. The Manifold kernel boots in tests through `bootManifoldKernel` from `src/testing.js`.

**Spec:** `partforge-cloud/docs/superpowers/specs/2026-10-12-mechanical-interface-rules-design.md` (in the cloud repo; sections 2 and 3 are this plan). Read it first.

## Global Constraints

- `src/framework/oracle/` is shared runtime: DOM-free, `three`-free, `node:`-free (`test/worker-layering.test.js` enforces it). `dfm-profiles.js` must stay import-free (it is in the eager worker closure).
- `held` is an EXPECTATION, never a default: a part that does not declare it gets no check, and `test/verify-golden.test.js` must stay byte-identical (do not re-record it).
- Contact tolerance is `CONTACT_EPS` from `gaps.js` (1e-3 mm), or an entry in `overlaps`. The profile's `clearance` field is read by nothing; do not start reading it.
- Every registry/check `hint` is a non-empty string and every `pattern` id must exist as a `## <id>` heading in `docs/ERROR-PATTERNS.md` (`test/error-patterns.test.js`).
- Sub-parts with `exportable: false` are left OUT of the held graph; a sub-part disabled by `enabled()` in a case is a skip, never a throw; a name that exists nowhere in `part.parts` throws (the `requirePair` convention).
- Release: bump `package.json` on this branch as part of the PR, never `npm publish` or tag by hand (AGENTS.md "Releasing"). Pick the version at bump time: one minor above both `origin/main` and any open PR that already bumps (partforge #273 carries 0.148.0 as of 2026-10-12), and re-check the bump survived after any merge of main.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **OCCT view, sub-part fully inside another.** `overlaps` is empty on OCCT and the gap reads positive, so a pressed-in pin reads as floating. Expected: the doc says so beside the existing OCCT caveat, and the check's message is honest ("not connected"), not a crash. Pinned by Task 6's doc paragraph; no code path to test beyond Task 2's "no overlaps, positive gap → fail".
2. **A quick lap (`measuredGaps === false`).** Expected: `held` skips with `unevaluated: true`, so `verify.ok` is `null`, never `true`. Test in Task 2.
3. **`held: "lid"` where `lid` is `enabled()`-off in one preset.** Expected: that case skips with "sub-part disabled in this case", other cases evaluate. Test in Task 5.
4. **A view with one exportable sub-part and a reference ghost.** Expected: pass (nothing to hold), the ghost never counted. Test in Task 5.
5. **`held: true` on a facts object with no `bounds`** (legacy measure output). Expected: the first in-view sub-part is the base, no throw. Test in Task 2.

---

### Task 1: Profile fields `fits`, `holeUndersize`, `bridge`

**Files:**
- Modify: `src/framework/oracle/dfm-profiles.js:1-12`
- Modify: `types/part.d.ts:479-496` (`DfmProfile`)
- Test: `test/dfm-profiles.test.js`

**Interfaces:**
- Produces: `PROFILES[name].fits = { press, push, slip, moving, printInPlace }` (numbers, mm, diametral; negative = interference), `PROFILES[name].holeUndersize` (number, mm), `PROFILES[name].bridge` (number, mm; absent on `resin`). `resolveProfile` is unchanged and spreads them through.

- [ ] **Step 1: Write the failing tests**

Replace the first and fourth tests in `test/dfm-profiles.test.js` and add one:

```js
const FDM_PLA = {
  bed: [220, 220, 250], minWall: 1.2, clearance: 0.2, overhang: 45,
  fits: { press: -0.1, push: 0.05, slip: 0.25, moving: 0.35, printInPlace: 0.45 },
  holeUndersize: 0.25, bridge: 10,
};

test("resolves a built-in profile by name", () => {
  expect(resolveProfile("fdm-pla")).toEqual(FDM_PLA);
  expect(Object.keys(PROFILES)).toContain("resin");
  expect(resolveProfile("resin").overhang).toBeUndefined(); // resin prints on supports
  expect(resolveProfile("resin").bridge).toBeUndefined();   // and bridges nothing
});

test("every profile carries the five fit classes, an undersize and a positive minWall", () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    expect(Object.keys(p.fits).sort(), name).toEqual(["moving", "press", "printInPlace", "push", "slip"]);
    expect(p.fits.press, name).toBeLessThan(0);
    expect(p.fits.push, name).toBeLessThan(p.fits.slip);
    expect(p.fits.slip, name).toBeLessThan(p.fits.moving);
    expect(p.fits.moving, name).toBeLessThan(p.fits.printInPlace);
    expect(p.holeUndersize, name).toBeGreaterThan(0);
  }
});

test("merges overrides onto a named base", () => {
  expect(resolveProfile({ base: "fdm-pla", minWall: 2 })).toEqual({ ...FDM_PLA, minWall: 2 });
  expect(resolveProfile({ base: "fdm-pla", overhang: null }).overhang).toBeNull(); // an inline profile can switch it off
  // a calibrated printer overrides the whole fits table; a partial object replaces, never merges
  expect(resolveProfile({ base: "fdm-pla", fits: { press: -0.05, push: 0.02, slip: 0.15, moving: 0.25, printInPlace: 0.35 } }).fits.slip).toBe(0.15);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/dfm-profiles.test.js`
Expected: FAIL — `toEqual` on the first test (no `fits` key), the new test throws on `Object.keys(undefined)`.

- [ ] **Step 3: Add the fields**

Replace lines 1-12 of `src/framework/oracle/dfm-profiles.js` with:

```js
// Reusable design-for-manufacturing process profiles — a manufacturing technique
// as DATA: which checks apply and at what thresholds. `bed` is the build volume
// [x,y,z] in mm (a hard bbox-fit gate); `minWall` mm (a warn); `overhang` is the
// steepest unsupported face the process prints cleanly, in degrees from vertical
// (a warn, armed only by the part — see overhangAngleFor; resin prints on
// supports, so it carries none); `clearance` mm is carried for a future gap check
// (not enforced yet).
//
// `fits`, `holeUndersize` and `bridge` are the numbers an author (or the cloud
// agent) copies into derive() for a mating feature; nothing in this repo reads
// them yet. They are guide defaults from the FDM design guides, not measurements:
// a calibrated printer overrides them through an inline `{ base, fits: {...} }`
// profile, which REPLACES the fits table whole. `fits` are diametral offsets in
// mm (negative = interference): press (a pin that never comes out), push (a cap
// pressed on by hand), slip (a lid that lifts off), moving (a hinge pin or axle),
// printInPlace (parts printed already assembled). `holeUndersize` is added to a
// horizontal bore's diameter, since the top of a printed arch sags inward.
// `bridge` is the longest flat span the process prints unsupported; resin prints
// on supports, so it carries none.
export const PROFILES = {
  "fdm-pla": {
    bed: [220, 220, 250], minWall: 1.2, clearance: 0.2, overhang: 45,
    fits: { press: -0.1, push: 0.05, slip: 0.25, moving: 0.35, printInPlace: 0.45 },
    holeUndersize: 0.25, bridge: 10,
  },
  "fdm-petg": {
    bed: [220, 220, 250], minWall: 1.5, clearance: 0.3, overhang: 45,
    fits: { press: -0.1, push: 0.05, slip: 0.3, moving: 0.4, printInPlace: 0.5 },
    holeUndersize: 0.3, bridge: 10,
  },
  "resin": {
    bed: [120, 68, 160], minWall: 0.6, clearance: 0.1,
    fits: { press: -0.05, push: 0.05, slip: 0.1, moving: 0.15, printInPlace: 0.2 },
    holeUndersize: 0.05,
  },
};
```

- [ ] **Step 4: Type it**

In `types/part.d.ts`, inside `DfmProfile` after the `clearance?: number;` member add:

```ts
  /**
   * Diametral fit offsets in mm, negative = interference: `press` (never comes
   * out), `push` (pressed on by hand), `slip` (lifts off), `moving` (a pin or
   * axle), `printInPlace` (printed assembled). Guide defaults; an inline profile
   * replaces the whole table.
   */
  fits?: { press: number; push: number; slip: number; moving: number; printInPlace: number };
  /** Added to a horizontal bore's diameter — a printed arch sags inward. */
  holeUndersize?: number;
  /** Longest flat span printed unsupported, mm. Absent on a process that prints on supports. */
  bridge?: number;
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/dfm-profiles.test.js test/types-surface.test.js test/worker-layering.test.js && npm run typecheck`
Expected: all PASS (types-surface only checks `DfmProfileName`, unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/framework/oracle/dfm-profiles.js types/part.d.ts test/dfm-profiles.test.js
git commit -m "DFM profiles carry fit offsets, hole undersize and bridge span

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `heldCheck` — the contact graph over the view's facts

**Files:**
- Create: `src/framework/oracle/held.js`
- Test: `test/held.test.js`

**Interfaces:**
- Consumes: `pairKey`, `CONTACT_EPS` from `./gaps.js`; facts shape from `measure` (`subparts[].name`, `subparts[].bounds?.min`, `subparts[].centerOfMass`, `overlaps[] {a,b,volume,location}`, `gaps[] {a,b,distance,at}` or `undefined`, `measuredGaps`).
- Produces: `heldCheck(facts, held, { subPartNames, exportableNames })` → one check object `{ scope: "view", subpart: null, metric: "held", kind: "gate", expr, actual, status, pass, message, hint?, pattern?, location? }` or `null` when `held` is `undefined`/`null`. Throws on a malformed value or an unknown base name. `HELD_HINT` exported.

- [ ] **Step 1: Write the failing tests**

Create `test/held.test.js`:

```js
import { expect, test } from "vitest";
import { heldCheck, HELD_HINT } from "../src/framework/oracle/held.js";

// Three 10 mm cubes in a row on z=0: base, mid touching base, top floating 0.2 above mid.
const row = (name, x, z = 0) => ({
  name, bounds: { min: [x, 0, z], max: [x + 10, 10, z + 10] }, centerOfMass: [x + 5, 5, z + 5],
});
const facts = (over = {}) => ({
  subparts: [row("base", 0), row("mid", 10), row("top", 10, 10.2)],
  overlaps: [],
  gaps: [
    { a: "base", b: "mid", distance: 0, at: [10, 5, 5] },
    { a: "mid", b: "top", distance: 0.2, at: [15, 5, 10.1] },
    { a: "base", b: "top", distance: 10.2, at: [10, 5, 10] },
  ],
  nearMisses: [],
  ...over,
});

test("returns null when held is not declared", () => {
  expect(heldCheck(facts(), undefined, {})).toBeNull();
  expect(heldCheck(facts(), null, {})).toBeNull();
});

test("fails naming the floating sub-part, located at its centre of mass", () => {
  const c = heldCheck(facts(), true, {});
  expect(c.metric).toBe("held");
  expect(c.status).toBe("fail");
  expect(c.actual).toBe(1);
  expect(c.message).toBe("top not connected to base");
  expect(c.hint).toBe(HELD_HINT);
  expect(c.pattern).toBe("floating-subpart");
  expect(c.location).toEqual([15, 5, 15.2]);
});

test("passes when every sub-part reaches the base through contact or overlap", () => {
  const c = heldCheck(facts({ gaps: [
    { a: "base", b: "mid", distance: 0, at: [10, 5, 5] },
    { a: "mid", b: "top", distance: 0.0005, at: [15, 5, 10] }, // within CONTACT_EPS
    { a: "base", b: "top", distance: 10, at: [10, 5, 10] },
  ] }), true, {});
  expect(c.status).toBe("pass");
  expect(c.actual).toBe(0);
  expect(c.message).toBe("3 sub-parts connected to base");
});

test("an overlap joins a pair whatever its gap reads", () => {
  const c = heldCheck(facts({ overlaps: [{ a: "mid", b: "top", volume: 5, location: [15, 5, 10] }] }), true, {});
  expect(c.status).toBe("pass");
});

test("the base is the lowest sub-part by bounds.min z, else the first in view order", () => {
  const f = facts({ subparts: [row("top", 10, 10.2), row("mid", 10), row("base", 0)] });
  expect(heldCheck(f, true, {}).message).toBe("top not connected to base");
  const legacy = facts({ subparts: [{ name: "base" }, { name: "mid" }, { name: "top" }] });
  expect(heldCheck(legacy, true, {}).message).toBe("top not connected to base");
});

test("a named base roots the graph there", () => {
  const c = heldCheck(facts(), "top", {});
  expect(c.expr).toBe("connected to top");
  expect(c.status).toBe("fail");
  expect(c.message).toBe("base, mid not connected to top");
  expect(c.location).toEqual([5, 5, 5]);
});

test("exportable names bound the graph: a ghost neither counts nor holds", () => {
  // `top` is held only by `ghost`; ghost is not exportable, so top floats
  const f = facts({
    subparts: [row("base", 0), row("top", 10, 10.2), row("ghost", 10)],
    gaps: [
      { a: "base", b: "top", distance: 10.2, at: [10, 5, 10] },
      { a: "ghost", b: "top", distance: 0, at: [15, 5, 10] },
      { a: "base", b: "ghost", distance: 0, at: [10, 5, 5] },
    ],
  });
  const c = heldCheck(f, true, { exportableNames: ["base", "top"] });
  expect(c.status).toBe("fail");
  expect(c.message).toBe("top not connected to base");
  // one exportable sub-part plus a ghost: nothing to hold
  const one = heldCheck(f, true, { exportableNames: ["base"] });
  expect(one.status).toBe("pass");
  expect(one.message).toBe("1 sub-part, nothing to hold");
});

test("a quick lap skips as unevaluated; legacy facts with no gap table skip as unavailable", () => {
  const quick = heldCheck(facts({ gaps: undefined, measuredGaps: false }), true, {});
  expect(quick.status).toBe("skip");
  expect(quick.unevaluated).toBe(true);
  const legacy = heldCheck(facts({ gaps: undefined }), true, {});
  expect(legacy.status).toBe("skip");
  expect(legacy.unevaluated).toBeUndefined();
  expect(legacy.message).toBe("unavailable");
});

test("a base disabled in this case skips; a base in no case throws; a bad value throws", () => {
  const f = facts({ subparts: [row("base", 0), row("mid", 10)], gaps: [{ a: "base", b: "mid", distance: 0, at: [10, 5, 5] }] });
  const c = heldCheck(f, "top", { subPartNames: ["base", "mid", "top"] });
  expect(c.status).toBe("skip");
  expect(c.message).toBe("sub-part disabled in this case");
  expect(() => heldCheck(f, "lid", { subPartNames: ["base", "mid", "top"] })).toThrow(/unknown sub-part "lid"/);
  expect(() => heldCheck(f, "lid", {})).toThrow(/unknown sub-part "lid"/);
  expect(() => heldCheck(f, 1, {})).toThrow(/held: must be true or a sub-part name/);
  expect(() => heldCheck(f, false, {})).toThrow(/held: must be true or a sub-part name/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/held.test.js`
Expected: FAIL — cannot resolve `../src/framework/oracle/held.js`.

- [ ] **Step 3: Implement `held.js`**

Create `src/framework/oracle/held.js`:

```js
// `_view.held`: every exportable sub-part in the view must be connected, through
// contact or overlap, to a base. A pair-derived check like `contacts` — it reads
// the gap table and overlap list measure already computed and never touches a
// mesh — so it lives beside pairGapChecks, outside the scalar VIEW_METRICS
// registry, and emits the same structured check object.
//
// Topological only: a part balanced on a point passes. Load path and strength
// are not this check's business (AUTHORING-PARTS.md, "Self-verification").
import { pairKey, CONTACT_EPS } from "./gaps.js";

export const HELD_HINT = "sub-part touches nothing — seat it on a mating face or add the fastener that holds it";

// `held` is `true` (base = the lowest sub-part by bounds.min z) or a sub-part
// name. `subPartNames` is the part's whole vocabulary (so a base that is
// enabled()-off in this case skips rather than throws); `exportableNames` bounds
// the graph to printed sub-parts — a reference ghost neither counts nor holds.
export function heldCheck(facts, held, { subPartNames, exportableNames } = {}) {
  if (held === undefined || held === null) return null;
  if (held !== true && typeof held !== "string") {
    throw new Error(`held: must be true or a sub-part name, got ${JSON.stringify(held)}`);
  }
  const base = {
    scope: "view", subpart: null, metric: "held", kind: "gate",
    expr: held === true ? "connected" : `connected to ${held}`,
  };
  const inView = facts.subparts.map((s) => s.name);
  const known = subPartNames ? new Set(subPartNames) : new Set(inView);
  if (typeof held === "string" && !known.has(held)) {
    throw new Error(`held: unknown sub-part "${held}" (view has: ${inView.join(", ")})`);
  }
  const printed = exportableNames ? new Set(exportableNames) : null;
  const nodes = inView.filter((n) => !printed || printed.has(n));
  if (typeof held === "string" && !nodes.includes(held)) {
    return { ...base, actual: null, status: "skip", pass: null, message: "sub-part disabled in this case" };
  }
  if (nodes.length < 2) {
    return { ...base, actual: 0, status: "pass", pass: true, message: `${nodes.length} sub-part, nothing to hold` };
  }
  // Same rule as pairGapChecks' noReading: a deliberately skipped pass (quick lap)
  // is unevaluated; a legacy result with no table stays an untagged skip.
  if (!facts.gaps) {
    return facts.measuredGaps === false
      ? { ...base, actual: null, status: "skip", pass: null, unevaluated: true,
          message: "not measured (quick check)", hint: "re-run this check without `quick` to measure pair distances" }
      : { ...base, actual: null, status: "skip", pass: null, message: "unavailable" };
  }
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  const join = (a, b) => {
    if (!adj.has(a) || !adj.has(b)) return;
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const o of facts.overlaps ?? []) join(o.a, o.b);
  for (const g of facts.gaps) if (g.distance <= CONTACT_EPS) join(g.a, g.b);
  const rowOf = (n) => facts.subparts.find((s) => s.name === n);
  const zOf = (n) => rowOf(n)?.bounds?.min?.[2];
  const root = held === true
    ? nodes.reduce((best, n) => (zOf(n) != null && (zOf(best) == null || zOf(n) < zOf(best)) ? n : best), nodes[0])
    : held;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    for (const m of adj.get(n)) if (!seen.has(m)) { seen.add(m); queue.push(m); }
  }
  const floating = nodes.filter((n) => !seen.has(n));
  if (floating.length === 0) {
    return { ...base, actual: 0, status: "pass", pass: true, message: `${nodes.length} sub-parts connected to ${root}` };
  }
  const first = rowOf(floating[0]);
  const location = first?.centerOfMass
    ?? (first?.bounds ? first.bounds.min.map((v, i) => (v + first.bounds.max[i]) / 2) : null);
  return {
    ...base, actual: floating.length, status: "fail", pass: false,
    message: `${floating.join(", ")} not connected to ${root}`,
    hint: HELD_HINT, pattern: "floating-subpart",
    ...(location ? { location } : {}),
  };
}
```

Note `pairKey` is imported but unused in the code above; drop the import if eslint's `no-unused-vars` complains (`npm run lint`).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/held.test.js test/worker-layering.test.js && npm run lint`
Expected: PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/held.js test/held.test.js
git commit -m "heldCheck: a contact graph over the view's gaps and overlaps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wire `held` through `evaluateCase` and `verify`

**Files:**
- Modify: `src/framework/oracle/verify.js:1-7` (import), `:259-273` (`evaluateCase`), `:426-440` (`verify`)
- Test: `test/verify.test.js` (append)

**Interfaces:**
- Consumes: `heldCheck` from Task 2.
- Produces: `evaluateCase(facts, { profile, expect, subPartNames, exportableNames, overhang })` — new optional `exportableNames` (array of sub-part names with `exportable !== false`); `verify()` computes it from `part.parts`. `_view.held` is peeled and never reaches the scalar registry loop.

- [ ] **Step 1: Write the failing tests**

Append to `test/verify.test.js` (after the `twoBoxFacts` tests, which already define `twoBoxFacts` and `pairCheck`):

```js
test("evaluateCase peels _view.held and answers one held check", () => {
  const facts = twoBoxFacts(); // left and right 0.2 apart, no overlap
  const checks = evaluateCase(facts, { profile: null, expect: { _view: { held: true } } });
  const held = pairCheck(checks, "held");
  expect(held.scope).toBe("view");
  expect(held.status).toBe("fail");
  expect(held.message).toBe("right not connected to left");
  expect(checks.filter((c) => c.metric === "held")).toHaveLength(1);
});

test("evaluateCase hands exportableNames to the held check", () => {
  const facts = twoBoxFacts();
  const checks = evaluateCase(facts, { profile: null, expect: { _view: { held: true } }, exportableNames: ["left"] });
  expect(pairCheck(checks, "held").status).toBe("pass");
});

test("held is not a scalar view metric", () => {
  const facts = twoBoxFacts();
  expect(() => check("view", null, "held", true, VIEW_METRICS, facts)).toThrow(/unknown view metric/);
});
```

`check` is not exported from verify.js; if the file's existing imports do not already expose it, replace the third test with:

```js
test("held is not a scalar view metric", () => {
  expect(VIEW_METRICS.held).toBeUndefined();
});
```

(`VIEW_METRICS` is re-exported from `verify.js`; import it beside `evaluateCase` if the test file does not already.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/verify.test.js -t "held"`
Expected: FAIL — `evaluateCase` passes `held` to the registry loop and throws `unknown view metric "held"`.

- [ ] **Step 3: Wire it**

In `src/framework/oracle/verify.js`, add after the `gaps.js` import:

```js
import { heldCheck } from "./held.js";
```

Change `evaluateCase`'s signature and peel (the lines quoted at 259-273):

```js
export function evaluateCase(facts, { profile, expect, subPartNames, exportableNames, overhang = null }) {
  const checks = [];
  // contacts/clearance/held are pair-derived, not scalar view metrics — peel
  // them off before the registry loop. held.js explains the exportable bound.
  const { contacts, clearance, held, ...viewScalarExp } = expect?._view ?? {};
```

and after the `checks.push(...pairGapChecks(...))` line add:

```js
  const heldResult = heldCheck(facts, held, { subPartNames, exportableNames });
  if (heldResult) checks.push(heldResult);
```

In `verify()`, after `const subPartNames = Object.keys(part.parts);` add:

```js
  // A reference ghost (`exportable: false`) is never printed, so it neither counts
  // as held nor holds anything — the same exclusion measure applies to overhang.
  const exportableNames = subPartNames.filter((n) => part.parts[n]?.exportable !== false);
```

and pass it: `evaluateCase(facts, { profile, expect, subPartNames, exportableNames, overhang: overhangAngle })`.

- [ ] **Step 4: Run the oracle tests and the golden**

Run: `npx vitest run test/verify.test.js test/verify-golden.test.js test/verify-cases.test.js test/verify-cli.test.js`
Expected: PASS, golden unchanged (no reference part declares `held`).

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/verify.js test/verify.test.js
git commit -m "verify: peel _view.held beside contacts and clearance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Lint, types and the error pattern

**Files:**
- Modify: `src/framework/lint/rules-verify.js:31-38` (`peelPairKeys`), `:287-299` (`verify-bad-pair-check`), plus a new `checkHeld` beside `checkClearance`
- Modify: `types/part.d.ts:568-584` (`ViewExpectations`)
- Modify: `test/types-surface.test.js:237-242`
- Modify: `docs/ERROR-PATTERNS.md` (after the `## near-miss-gap` entry, lines 195-199)
- Test: `test/lint-verify.test.js` (append), `test/error-patterns.test.js` (runs as is)

**Interfaces:**
- Produces: lint rule `verify-bad-pair-check` reports a `held` that is neither `true` nor a string; `verify-unknown-subpart` reports a `held` naming no sub-part. `ViewExpectations.held?: true | string`. Pattern id `floating-subpart`.

- [ ] **Step 1: Write the failing lint tests**

Append to `test/lint-verify.test.js`:

```js
// --- _view.held --------------------------------------------------------------

test("held: true and held: <sub-part> are accepted and not unknown metrics or bad expressions", () => {
  for (const held of [true, "body"]) {
    const r = lintPart(partWithTwoSubparts({ expect: { _view: { held } } }));
    expect(ids(r.errors)).toEqual([]);
  }
});

test("held naming no sub-part is verify-unknown-subpart with a suggestion", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { held: "bodyy" } } }));
  expect(ids(r.errors)).toContain("verify-unknown-subpart");
  const f = find(r, "verify-unknown-subpart");
  expect(f.path).toBe("verify.expect._view.held");
  expect(f.fix).toMatch(/did you mean "body"/);
});

test("held that is neither true nor a name is verify-bad-pair-check", () => {
  for (const held of [false, 1, ["body"], { base: "body" }]) {
    const r = lintPart(partWithTwoSubparts({ expect: { _view: { held } } }));
    expect(ids(r.errors), JSON.stringify(held)).toContain("verify-bad-pair-check");
    expect(find(r, "verify-bad-pair-check").path).toBe("verify.expect._view.held");
  }
});
```

Check the finding's field name for the fix text by reading `src/framework/lint/finding.js` (`err(rule, message, fix, path)` — if the property is not `fix`, use the one `err` writes).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/lint-verify.test.js -t "held"`
Expected: FAIL — `verify-unknown-metric` ("held" is not a view metric) and `verify-bad-expr` fire instead.

- [ ] **Step 3: Implement the lint side**

In `src/framework/lint/rules-verify.js` replace `peelPairKeys`:

```js
// `contacts` (must-touch pairs), `clearance` (free-fit gaps) and `held` (the
// contact graph) live under `verify.expect._view` but are pair-derived checks,
// not scalar VIEW_METRICS — mirror verify.js's own peel (evaluateCase) so they
// never hit the scalar-metric / assertion-expression checks below. Validated for
// real by `verify-bad-pair-check`.
const peelPairKeys = (metrics) => {
  const { contacts, clearance, held, ...rest } = metrics;
  return rest;
};
```

Add after `checkClearance`:

```js
// Static analogue of held.js: `true`, or the name of the sub-part the graph is
// rooted at. Anything else throws at runtime, so it is an error here.
function checkHeld(held, names, path) {
  if (held === undefined || held === null || held === true) return [];
  if (typeof held === "string") {
    if (names.includes(held)) return [];
    const hint = safeSuggest(held, names);
    return [err("verify-unknown-subpart",
      `\`${path}\` references "${held}", which is not a sub-part`,
      `Use \`true\` (the lowest sub-part is the base) or one of the sub-part names (${names.join(", ")})${hint ? ` — did you mean "${hint}"?` : "."}`,
      path)];
  }
  return [err("verify-bad-pair-check",
    `\`${path}\` must be true or a sub-part name, got ${describe(held)}`,
    "Set `held: true` to root the contact graph at the lowest sub-part, or `held: \"<name>\"` to root it at that sub-part.",
    path)];
}
```

In the `verify-bad-pair-check` rule's returned array add:

```js
        ...checkHeld(view.held, names, "verify.expect._view.held"),
```

- [ ] **Step 4: Type it and fix the surface test**

In `types/part.d.ts` `ViewExpectations`, after the `clearance?` member add:

```ts
  /**
   * Every exportable sub-part must be connected, through contact or overlap, to
   * the base: the lowest sub-part (`true`) or the named one. Topological only.
   */
  held?: true | string;
```

In `test/types-surface.test.js` change the pair-wise keys test to:

```js
  test("ViewExpectations declares VIEW_METRICS plus the three pair-derived keys", () => {
    const { all } = interfaceMembers("types/part.d.ts", "ViewExpectations");
    // contacts/clearance/held are pair-derived, so verify.js peels them off before
    // the scalar registry loop — they are real `_view` keys with no registry entry.
    expect(sorted(all)).toEqual(sorted([...Object.keys(VIEW_METRICS), "contacts", "clearance", "held"]));
  });
```

- [ ] **Step 5: Add the error pattern**

In `docs/ERROR-PATTERNS.md`, after the `## near-miss-gap` entry's three list lines, add:

```markdown
## floating-subpart

- **Symptom:** A `✗ … held` failure from `verify` reporting `<name> not connected to <base>`: a sub-part that looks assembled in the preview touches nothing that reaches the base.
- **Cause:** The piece is placed by eye rather than against a mating datum — a lid a hair above its box, a bracket beside the wall it should bolt to, a pin whose bore it was never moved into — or it is held only by a reference ghost (`exportable: false`), which is never printed. On OCCT a sub-part fully inside another reads as not touching, since overlap detection is Manifold-only.
- **Fix:** Seat the part on a mating face by deriving its position from the face it sits on in `derive()`, or add the fastener, boss or tab that holds it, then keep `verify.expect._view.held` so the next edit re-checks it. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".
```

- [ ] **Step 6: Run lint tests, types, error patterns, typecheck**

Run: `npx vitest run test/lint-verify.test.js test/types-surface.test.js test/error-patterns.test.js test/held.test.js && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/framework/lint/rules-verify.js types/part.d.ts test/types-surface.test.js test/lint-verify.test.js docs/ERROR-PATTERNS.md
git commit -m "lint + types: _view.held is a pair-derived key; floating-subpart pattern

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end on the real kernel

**Files:**
- Test: `test/verify.test.js` (append, in the section that already imports `gapPart` and boots `k`)

**Interfaces:**
- Consumes: `verify` from `../src/framework/oracle/verify.js`, `bootManifoldKernel` (already in the file), `gapPart` fixture.

- [ ] **Step 1: Write the failing end-to-end tests**

Append:

```js
test("end-to-end: held fails on the real 0.2mm gap part and passes once the gap closes", () => {
  const floating = verify(k, { ...gapPart, verify: { expect: { _view: { held: true } } } });
  expect(floating.ok).toBe(false);
  const h = floating.failures.find((f) => f.metric === "held");
  expect(h.message).toBe("right not connected to left");
  expect(h.pattern).toBe("floating-subpart");
  expect(h.location[0]).toBeCloseTo(15.2, 3); // right's centre of mass, x = 10 + 0.2 + 5

  const seated = verify(k, { ...gapPart, defaults: { gap: 0 }, verify: { expect: { _view: { held: true } } } });
  expect(seated.ok).toBe(true);
  expect(seated.checks.find((c) => c.metric === "held").status).toBe("pass");
});

test("end-to-end: a sub-part held only by an exportable:false ghost is floating", () => {
  const part = {
    meta: { title: "GhostHold", units: "mm" },
    defaults: {},
    parts: {
      base:  { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }) },
      ghost: { views: ["v"], exportable: false, build: (kk) => kk.box({ min: [10, 0, 0], max: [20, 10, 10] }) },
      top:   { views: ["v"], build: (kk) => kk.box({ min: [10, 0, 10], max: [20, 10, 20] }) },
    },
    views: { v: { label: "V" } },
    verify: { expect: { _view: { held: true } } },
  };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  expect(v.failures.find((f) => f.metric === "held").message).toBe("top not connected to base");
});

test("end-to-end: held on an enabled()-gated base skips the case where it is off", () => {
  const part = {
    meta: { title: "LidBoxHeld", units: "mm" },
    defaults: { with_lid: 1 },
    parameters: [{ id: "b", presets: { Bare: { with_lid: 0 } } }],
    parts: {
      base: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 5] }) },
      lid:  { views: ["v"], enabled: (p) => p.with_lid > 0, build: (kk) => kk.box({ min: [0, 0, 5], max: [10, 10, 7] }) },
    },
    views: { v: { label: "V" } },
    verify: { expect: { _view: { held: "lid" } } },
  };
  const v = verify(k, part);
  const byCase = Object.fromEntries(v.cases.map((c) => [c.name, c]));
  expect(byCase.defaults.checks.find((c) => c.metric === "held").status).toBe("pass");
  expect(byCase.Bare.checks.find((c) => c.metric === "held").status).toBe("skip");
});

test("end-to-end: a quick lap answers held as unevaluated, so ok is null", () => {
  const v = verify(k, { ...gapPart, verify: { expect: { _view: { held: true } } } }, { quick: true });
  const h = v.checks.find((c) => c.metric === "held");
  expect(h.status).toBe("skip");
  expect(h.unevaluated).toBe(true);
  expect(v.ok).toBeNull();
});
```

Read how the existing enabled()-gated contacts test (around line 384-403) reaches per-case checks (`v.cases` and the case name for a preset) and how an existing quick-lap test calls `verify` (grep `quick` in `test/verify.test.js`); match those exact shapes if they differ from the above.

- [ ] **Step 2: Run to verify behaviour**

Run: `npx vitest run test/verify.test.js -t "end-to-end: held"`
Expected: PASS if Tasks 2-3 are correct; a FAIL here is a real bug in the graph or the wiring, not a test to adjust — fix `held.js`/`verify.js` and re-run.

- [ ] **Step 3: Commit**

```bash
git add test/verify.test.js
git commit -m "verify: end-to-end held cases on the Manifold kernel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/AUTHORING-PARTS.md:4022-4036` (example), `:4038` (profile paragraph), `:4066-4068` (`_view` list), after `:4195` (new held paragraph), `:3741-3746` (rule catalog), `:3900-3908` (diagnostics contract)

- [ ] **Step 1: The example block**

Change the two example comment lines and add `held`:

```js
  process: "fdm-pla",            // a DFM profile: fdm-pla | fdm-petg | resin, or an
                                  // inline { base, bed:[x,y,z], minWall, overhang, fits, holeUndersize, bridge } object
```

and in `_view`:

```js
    _view:  { overlaps: 0,
              contacts:  [["drum", "flange"]],       // these pairs must touch
              clearance: { "lid×body": ">=0.3" },    // intended free fits
              held: true },                          // every printed piece reaches the base
```

- [ ] **Step 2: The profile table**

After the paragraph beginning `**What the profile gives you:**` (ends at "Switch it off under an FDM profile with an inline `{ base: "fdm-pla", overhang: null }`."), add:

```markdown
**What the profile tells you.** Three more fields carry the numbers a mating
feature needs. Nothing checks them; they are the one place the value is spelled,
so `derive()` copies it with a comment naming the fit (`// slip fit: fdm-pla 0.25`).
`fits` are diametral offsets in mm, negative is interference; `holeUndersize` is
added to a horizontal bore's diameter because a printed arch sags inward; `bridge`
is the longest flat span the process prints unsupported (none on resin, which
prints on supports). They are guide defaults, not measurements of your printer:
an inline `{ base: "fdm-pla", fits: { … } }` replaces the whole table.

| field | fdm-pla | fdm-petg | resin |
| --- | --- | --- | --- |
| `fits.press` — a pin that never comes out | -0.10 | -0.10 | -0.05 |
| `fits.push` — pressed on by hand | 0.05 | 0.05 | 0.05 |
| `fits.slip` — a lid that lifts off | 0.25 | 0.30 | 0.10 |
| `fits.moving` — a hinge pin or axle | 0.35 | 0.40 | 0.15 |
| `fits.printInPlace` — printed already assembled | 0.45 | 0.50 | 0.20 |
| `holeUndersize` | 0.25 | 0.30 | 0.05 |
| `bridge` (mm) | 10 | 10 | — |
```

- [ ] **Step 3: The `_view` list and the held paragraph**

Change the `_view` list line to end `plus the pair-wise \`contacts\` / \`clearance\` and the graph check \`held\` below.`

After the OCCT caveat paragraph (ends "check containment cases on Manifold."), add:

```markdown
**Held (the contact graph).** `contacts` asserts a pair you named; it cannot say a
sub-part touches nothing at all — a lid placed a hair above its box, a bracket
beside the wall it should bolt to. `held: true` builds a graph over every
exportable sub-part in the view, joining two whenever they overlap or their gap
is within the same ~1 µm `contacts` tolerates, and fails naming each sub-part not
connected to the base — the lowest sub-part by its bounds, or the one you name
with `held: "body"`. The location is the first floating sub-part's centre of
mass. A reference ghost (`exportable: false`) is left out entirely: it neither
counts nor holds, since it is never printed. A named base that is `enabled()`-off
in a case skips that case; a name that exists nowhere throws, like a `contacts`
pair. It is an expectation, never a default, for the overhang reason: a part
still being shaped should not be nagged. Topological only — a part balanced on a
point passes — and the same OCCT caveat applies: a sub-part fully inside another
reads as not touching there. A quick lap answers it `unevaluated`.
```

- [ ] **Step 4: The rule catalog and the diagnostics contract**

In the rule catalog sentence change `contacts\` / \`clearance\` keys` to `contacts\` / \`clearance\` / \`held\` keys`. In the diagnostics contract's `location` line, change `the pair checks \`contact\` / \`clearance\` / \`nearMiss\`` to `the pair checks \`contact\` / \`clearance\` / \`nearMiss\` (the midpoint between the pair's closest surface points) and \`held\` (the first floating sub-part's centre of mass)` — keep the existing parenthetical's wording intact for the three pair checks.

- [ ] **Step 5: Run the doc-reading tests and the whole suite**

Run: `npm test && npm run lint && npm run lint:dead && npm run typecheck`
Expected: all green. (`test/error-patterns.test.js` reads the docs; nothing else parses AUTHORING-PARTS.md, but the full run is the gate before the bump.)

- [ ] **Step 6: Commit**

```bash
git add docs/AUTHORING-PARTS.md
git commit -m "docs: the profile's fit table and the held check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Version bump and PR

**Files:**
- Modify: `package.json:3`, `package-lock.json` (its two `version` fields)

- [ ] **Step 1: Pick the version**

Run: `npm view partforge version && git fetch origin && git show origin/main:package.json | grep '"version"' && gh pr list --repo pixiteapps/partforge --state open --json number,title,headRefName`
Decide: one minor above the highest of the published version, `origin/main`'s, and any open PR's bump (read each open PR's `package.json` with `gh pr diff <n> | grep '"version"'`). Write the chosen version into `package.json` and both `version` fields at the top of `package-lock.json` (run `npm install --package-lock-only` to regenerate the lock instead of editing it by hand).

- [ ] **Step 2: Verify and commit**

Run: `npm test`
Expected: PASS (`test/partforge.test-d.ts` or similar may pin the version string; if a test names the old version, update it in the same commit).

```bash
git add package.json package-lock.json
git commit -m "chore: release <version> — DFM fit table, _view.held

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: Open the PR**

```bash
git push -u origin claude/mechanical-interface-rules
gh pr create --repo pixiteapps/partforge --title "DFM profiles carry fit offsets; a held expectation for assemblies" --body-file - <<'MD'
Gives the process profiles the numbers a mating feature needs, and adds one check that catches a piece that only looks assembled.

What this means in practice:
- `fdm-pla`, `fdm-petg` and `resin` now carry a fit table (press / push / slip / moving / print-in-place offsets), a horizontal-hole undersize and a bridge span. Nothing enforces them yet; they are the one spelling an author or the cloud agent copies into `derive()`, and an inline profile overrides the whole table for a calibrated printer.
- `verify.expect._view.held: true` (or `held: "body"`) fails when an exportable sub-part is not connected, through contact or overlap, to the base. Reference ghosts are left out. It is opt-in, like overhang.
- Lint validates `held` statically; the new `floating-subpart` error pattern names the fix.

Notes: no default check changes, so the verify golden is untouched. Downstream, partforge-cloud regenerates its prompt corpus against this version and adds the prompt rule that cites the table.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
MD
```

- [ ] **Step 4: After merge of main (if any), confirm the bump survived**

Run: `git log -1 --format=%H && grep '"version"' package.json`
Expected: the chosen version; if a merge dropped it (same-version bump on both sides), re-bump in a new commit.
