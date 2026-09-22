# Shape2D Probe Summaries + `wall` Band Metric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a part author two numeric read-backs the apply report lacks today: the exact arcs and corners of any `Shape2D` returned from a probe, and a located warning when a declared wall's ray-cast thickness drifts from its band.

**Architecture:** Feature 1 adds a pure summariser (`shape-probe.js`) that the existing probe walker calls when it meets a `Shape2D`, exactly as it already calls `solidProbeFacts` for a Solid. Feature 2 adds one running extreme to the existing min-wall ray loop, resolves the band per sub-part from the part's own `verify.expect`, and registers `wall` as a `warn` metric so verify, lint and the docs learn it from the one registry. Nothing casts a new ray and nothing reports automatically; both are opt-in per part.

**Tech Stack:** partforge (ES modules, vitest, Manifold WASM kernel booted per test file via `bootManifoldKernel` from `src/testing.js`). Run tests with `npx vitest run <file>`; the full suite with `npm test`.

**Spec:** `docs/superpowers/specs/2026-09-21-shape2d-probe-and-wall-band-design.md`

## Global Constraints

- Two PRs, one per feature, each carrying its own `package.json` version bump (the repo's convention: a release-worthy PR bumps the version itself; a rebase can silently absorb a same-version bump, so re-check the bump after any rebase).
- Feature 1 lives on this worktree/branch (`claude/shape2d-probe-wall-band`, bump to `0.119.0`). Feature 2 starts on a second worktree/branch from `origin/main` (`claude/wall-band-metric`, bump to `0.120.0`); Task 4 creates it.
- Probe values are bounded downstream (partforge-cloud drops a probe over `MAX_PROBES_JSON_CHARS`): caps are 64 arcs and 64 corners per ring, numbers rounded to 1e-4.
- `wall` accepts the range form only (`"1.8..2.2"`); membership window is `[0.75 × min, 1.5 × max]`; kind is `warn`.
- The corner summary never carries `profileCorners`' `index` field.
- `verify-metrics.js` must stay import-free (the linter imports it).
- Run `npm run lint` and `npm run typecheck` before each PR.
- Worktrees need their own `npm install` (already run for this one; run it in the second).

---

## File Structure

**Feature 1 (this branch):**
- Create `src/framework/oracle/shape-probe.js` — pure: contour regions → summary. One responsibility: turn the contour IR into arcs/corners with caps.
- Create `test/shape-probe.test.js` — pure tests, no kernel.
- Modify `src/framework/oracle/measure.js` (`resolveProbeValue`, lines ~28-70) — the `isShape2D` duck type and the call.
- Modify `test/measure.test.js` (probe section, after line ~203) — kernel-backed probe tests.
- Modify `types/testing.d.ts` (`MeasureReport` probe typing) and `docs/AUTHORING-PARTS.md` (Probes section, before the `**Cost.**` paragraph at line ~2410).
- Modify `package.json` version.

**Feature 2 (second branch):**
- Modify `src/framework/oracle/min-wall.js` (`minWall`, lines 74-115) — optional `band`.
- Modify `src/framework/oracle/gates.js` — `partWallBands(part, params)`; `partGatesMinWall` also arms on `wall`.
- Modify `src/framework/oracle/measure.js` (lines ~126, ~141, ~182-191) — pass the band, emit `wall`.
- Modify `src/framework/verify-metrics.js` — `wall` entry with `form: "range"` and `unavailable`.
- Modify `src/framework/oracle/verify.js` (`check`, lines 120-152; sub-part loop, lines 180-198).
- Modify `src/framework/lint/rules-verify.js` (`verify-bad-expr`, lines ~240-256).
- Create `test/wall-band.test.js` — the L-bend fixtures, min-wall, gates, measure, verify end to end.
- Modify `test/verify.test.js`, `test/lint-verify.test.js`, `types/testing.d.ts`, `docs/AUTHORING-PARTS.md` (Self-verification section, line ~3324 list), `package.json`.

**Cloud follow-through (partforge-cloud, after both publish):** `src/sandbox/protocol.js`, `tests/unit/sandbox-protocol.test.js` (or wherever `sanitizeMeasure` is pinned — check with `grep -rn "sanitizeMeasure" tests/unit`), `prompts/authoring-compact-essentials.md`, pin bump + regen.

---

### Task 1: Pure contour summariser

**Files:**
- Create: `src/framework/oracle/shape-probe.js`
- Test: `test/shape-probe.test.js`

**Interfaces:**
- Consumes: `arcCenterAndSweep(p0, via, to)` from `src/framework/geometry/paper-bridge.js` (returns `{center, r, dA}` in radians, `dA` positive CCW, or `null` when collinear); `cubicAt(p0, c1, c2, p1, t)` and `profileCorners(regions)` from `src/framework/geometry/contour-ops.js`; `profileArea`, `profileBounds` from the same file.
- Produces: `summarizeContours(regions, {isEmpty, area, bbox}) → ShapeProbeFacts` and the constants `MAX_RING_ARCS = 64`, `MAX_RING_CORNERS = 64`. Task 2 calls `summarizeContours(shape.toContours(), { isEmpty: shape.isEmpty(), area: shape.area(), bbox: shape.boundingBox() })`.

- [ ] **Step 1: Write the failing tests**

```js
// test/shape-probe.test.js
import { expect, test } from "vitest";
import { summarizeContours, MAX_RING_ARCS, MAX_RING_CORNERS } from "../src/framework/oracle/shape-probe.js";

// Hand-built contour IR, the same shape Shape2D.toContours() returns.
const square = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
// A 10×10 square whose top-right corner is a true r=2 arc about (8, 8) (via at 45°).
const k45 = 2 - 2 * Math.SQRT1_2; // 0.5858
const roundedCorner = { start: [0, 0], segments: [
  { to: [10, 0] }, { to: [10, 8] },
  { to: [8, 10], via: [8 + 2 * Math.SQRT1_2, 8 + 2 * Math.SQRT1_2] },
  { to: [0, 10] }, { to: [0, 0] },
] };
const region = (outer, holes = []) => [{ outer, holes }];
const facts = (regions) => summarizeContours(regions, { isEmpty: false, area: 100, bbox: { min: [0, 0], max: [10, 10] } });

test("a via arc reports its exact centre, radius, endpoints and a CCW sweep", () => {
  const ring = facts(region(roundedCorner)).regions[0].outer;
  expect(ring.segments).toBe(5);
  expect(ring.lines).toBe(4);
  expect(ring.arcs).toHaveLength(1);
  const a = ring.arcs[0];
  expect(a.center[0]).toBeCloseTo(8, 4);
  expect(a.center[1]).toBeCloseTo(8, 4);
  expect(a.r).toBeCloseTo(2, 4);
  expect(a.from).toEqual([10, 8]);
  expect(a.to).toEqual([8, 10]);
  expect(a.sweepDeg).toBeCloseTo(90, 3);
  expect(a.fit).toBeUndefined();
});

test("a cubic segment is fitted and tagged", () => {
  // Standard kappa quarter circle r=2 about (8,8) from (10,8) to (8,10).
  const kap = 0.5522847498307936 * 2;
  const cubicCorner = { start: [0, 0], segments: [
    { to: [10, 0] }, { to: [10, 8] },
    { to: [8, 10], c1: [10, 8 + kap], c2: [8 + kap, 10] },
    { to: [0, 10] }, { to: [0, 0] },
  ] };
  const a = facts(region(cubicCorner)).regions[0].outer.arcs[0];
  expect(a.fit).toBe("cubic");
  expect(a.center[0]).toBeCloseTo(8, 2);
  expect(a.center[1]).toBeCloseTo(8, 2);
  expect(a.r).toBeCloseTo(2, 2);
  expect(a.sweepDeg).toBeCloseTo(90, 1);
});

test("a collinear via triple is counted as a line", () => {
  const flat = { start: [0, 0], segments: [{ to: [10, 0], via: [5, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
  const ring = facts(region(flat)).regions[0].outer;
  expect(ring.arcs).toHaveLength(0);
  expect(ring.lines).toBe(4);
});

test("corners carry point, interior angle and convexity, never an index", () => {
  const ring = facts(region(square)).regions[0].outer;
  expect(ring.corners).toHaveLength(4);
  for (const c of ring.corners) {
    expect(c.interiorAngleDeg).toBeCloseTo(90, 6);
    expect(c.convex).toBe(true);
    expect(c).not.toHaveProperty("index");
    expect(Object.keys(c).sort()).toEqual(["convex", "interiorAngleDeg", "point"]);
  }
});

test("a hole's arc sweeps clockwise (negative)", () => {
  // Outer 20×20 CCW, hole = the rounded square above, reversed to CW.
  const outer = { start: [-5, -5], segments: [{ to: [15, -5] }, { to: [15, 15] }, { to: [-5, 15] }, { to: [-5, -5] }] };
  const hole = { start: [0, 0], segments: [
    { to: [0, 10] }, { to: [8, 10] },
    { to: [10, 8], via: [8 + 2 * Math.SQRT1_2, 8 + 2 * Math.SQRT1_2] },
    { to: [10, 0] }, { to: [0, 0] },
  ] };
  const rg = facts(region(outer, [hole])).regions[0];
  expect(rg.holes).toHaveLength(1);
  expect(rg.holes[0].arcs[0].sweepDeg).toBeCloseTo(-90, 3);
});

test("rings past the caps are cut and flagged", () => {
  const n = MAX_RING_ARCS + 5;
  const segments = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n, am = (a0 + a1) / 2;
    segments.push({ to: [10 * Math.cos(a1), 10 * Math.sin(a1)], via: [10 * Math.cos(am), 10 * Math.sin(am)] });
  }
  const bumpy = { start: [10, 0], segments };
  const out = facts(region(bumpy));
  expect(out.regions[0].outer.arcs).toHaveLength(MAX_RING_ARCS);
  expect(out.regions[0].outer.segments).toBe(n);
  expect(out.truncated).toBe(true);
  expect(MAX_RING_CORNERS).toBe(64);
});

test("an empty shape is reported as empty with nothing else", () => {
  const out = summarizeContours([], { isEmpty: true, area: 0, bbox: null });
  expect(out).toEqual({ kind: "shape2d", empty: true, area: 0, bbox: null, regions: [], truncated: false });
});

test("the summary is rounded to 1e-4 and carries kind/area/bbox", () => {
  const out = facts(region(roundedCorner));
  expect(out.kind).toBe("shape2d");
  expect(out.empty).toBe(false);
  expect(out.area).toBe(100);
  expect(out.bbox).toEqual({ min: [0, 0], max: [10, 10] });
  const a = out.regions[0].outer.arcs[0];
  expect(String(a.center[0]).length).toBeLessThanOrEqual(6); // "8" — no 7.999999999 tails
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/shape-probe.test.js`
Expected: FAIL — `Cannot find module '../src/framework/oracle/shape-probe.js'`

- [ ] **Step 3: Write the summariser**

```js
// src/framework/oracle/shape-probe.js
// The probe-report summary of a Shape2D: its arcs as centre + radius, its corners as
// point + angle. A reader asking "do these two arcs share a centre?" or "what radius
// did that fillet actually take?" reads the numbers here instead of a render.
//
// Arcs come from the contour IR, never from tessellation: a {to, via} segment is exact
// (circumcircle of from/via/to); a cubic — what a curve-adjacent fillet emits — is
// FITTED through its start, midpoint and end and tagged `fit: "cubic"` so the reader
// knows it is an approximation. Straight segments are counted, not listed.
//
// Corners are profileCorners' three reader-facing fields. The `index` field is
// deliberately dropped: it is the contour vertex index, not a position into the list
// `fillet({indices})` selects from, and carrying it here is what invites that mistake.
//
// Bounded: partforge-cloud drops a probe value that grows past its JSON budget, so a
// ring lists at most MAX_RING_ARCS arcs and MAX_RING_CORNERS corners and the summary
// says `truncated` when it had to cut.
import { arcCenterAndSweep } from "../geometry/paper-bridge.js";
import { cubicAt, profileCorners } from "../geometry/contour-ops.js";

export const MAX_RING_ARCS = 64;
export const MAX_RING_CORNERS = 64;

const round = (x) => Math.round(x * 1e4) / 1e4;
const pt = ([x, y]) => [round(x), round(y)];
const toDeg = (rad) => (rad * 180) / Math.PI;

// One segment → an arc record, or null for a straight (or degenerate) segment.
function arcOf(from, seg) {
  if (seg.c1 && seg.c2) {
    const mid = cubicAt(from, seg.c1, seg.c2, seg.to, 0.5);
    const c = arcCenterAndSweep(from, mid, seg.to);
    if (!c) return null;
    return { center: pt(c.center), r: round(c.r), from: pt(from), to: pt(seg.to), sweepDeg: round(toDeg(c.dA)), fit: "cubic" };
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (!c) return null;
    return { center: pt(c.center), r: round(c.r), from: pt(from), to: pt(seg.to), sweepDeg: round(toDeg(c.dA)) };
  }
  return null;
}

function summarizeRing(contour, state) {
  const arcs = [];
  let lines = 0;
  let from = contour.start;
  for (const seg of contour.segments) {
    const a = arcOf(from, seg);
    if (a) {
      if (arcs.length < MAX_RING_ARCS) arcs.push(a); else state.truncated = true;
    } else lines++;
    from = seg.to;
  }
  const corners = profileCorners(contour).map((c) => ({
    point: pt(c.point), interiorAngleDeg: round(c.interiorAngleDeg), convex: c.convex,
  }));
  if (corners.length > MAX_RING_CORNERS) { corners.length = MAX_RING_CORNERS; state.truncated = true; }
  return { segments: contour.segments.length, arcs, lines, corners };
}

/**
 * Summarise a Shape2D's stored contour regions (the `toContours()` value) for the
 * probe report. `isEmpty`, `area` and `bbox` are read by the caller from the shape
 * itself so this stays a pure function of plain data.
 */
export function summarizeContours(regions, { isEmpty, area, bbox }) {
  if (isEmpty || !regions?.length) return { kind: "shape2d", empty: true, area: 0, bbox: null, regions: [], truncated: false };
  const state = { truncated: false };
  const out = regions.map((rg) => ({
    outer: summarizeRing(rg.outer, state),
    holes: (rg.holes ?? []).map((h) => summarizeRing(h, state)),
  }));
  return {
    kind: "shape2d", empty: false, area: round(area),
    bbox: bbox ? { min: pt(bbox.min), max: pt(bbox.max) } : null,
    regions: out, truncated: state.truncated,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/shape-probe.test.js`
Expected: PASS (8 tests). If the hole test's sign is inverted, the contour is not CW as written — reverse the hole's segment order rather than changing the sign convention (`dA` positive is CCW by `arcCenterAndSweep`'s contract).

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/shape-probe.js test/shape-probe.test.js
git commit -m "oracle: summarise a Shape2D's arcs and corners for the probe report"
```

---

### Task 2: A `Shape2D` returned from a probe is summarised

**Files:**
- Modify: `src/framework/oracle/measure.js:28-70` (`isSolid`, `resolveProbeValue`)
- Test: `test/measure.test.js` (append after the existing probe tests, ~line 203)

**Interfaces:**
- Consumes: `summarizeContours` from Task 1; a live `Shape2D` exposes `toContours()`, `area()`, `isEmpty()`, `boundingBox()` (see `src/framework/geometry/shape2d.js:87-92`).
- Produces: `measure(...).probes.<name>` carries a `{kind: "shape2d", …}` object wherever the probe returned a `Shape2D`, at any depth up to the existing `MAX_PROBE_VALUE_DEPTH`.

- [ ] **Step 1: Write the failing tests**

Append to `test/measure.test.js`:

```js
// A Shape2D anywhere in a probe's return value is summarised into arcs and corners
// (shape-probe.js). This is the numeric channel for "are these two arcs concentric?" —
// partforge-cloud feedback #95 was fifteen edits of eyeballing renders for exactly that.
const shapeProbed = {
  meta: { title: "Shaped", units: "mm" },
  defaults: { r: 2 },
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 5] }) } },
  views: { v: { label: "V" } },
  probes: {
    outline: (kk, p) => kk.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(p.r),
    mixed: (kk, p) => ({ shape: kk.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(p.r), solid: kk.box({ min: [0, 0, 0], max: [1, 1, 1] }) }),
    nothing: (kk) => kk.shape2d([[0, 0], [1, 0], [1, 1], [0, 1]]).cut(kk.shape2d([[-1, -1], [2, -1], [2, 2], [-1, 2]])),
  },
};

test("a probe returning a Shape2D reports its arcs with centre and radius", () => {
  const r = measure(k, shapeProbed, "v");
  const s = r.probes.outline;
  expect(s.kind).toBe("shape2d");
  expect(s.empty).toBe(false);
  expect(s.area).toBeCloseTo(100 - (4 - Math.PI) * 4, 2); // four r=2 corners removed
  const ring = s.regions[0].outer;
  expect(ring.arcs).toHaveLength(4);
  const centres = ring.arcs.map((a) => a.center.join(",")).sort();
  expect(centres).toEqual(["2,2", "2,8", "8,2", "8,8"]);
  for (const a of ring.arcs) expect(a.r).toBeCloseTo(2, 3);
  expect(ring.corners).toHaveLength(0); // every corner is now a smooth joint
});

test("a Shape2D nested beside a Solid is summarised in place", () => {
  const r = measure(k, shapeProbed, "v");
  expect(r.probes.mixed.shape.kind).toBe("shape2d");
  expect(r.probes.mixed.solid.volume).toBeCloseTo(1, 3);
});

test("an empty Shape2D probe reports empty, not an error", () => {
  const r = measure(k, shapeProbed, "v");
  expect(r.probes.nothing).toEqual({ kind: "shape2d", empty: true, area: 0, bbox: null, regions: [], truncated: false });
});

test("probe shape summaries follow the caller's params", () => {
  const r = measure(k, shapeProbed, "v", { r: 3 });
  for (const a of r.probes.outline.regions[0].outer.arcs) expect(a.r).toBeCloseTo(3, 3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/measure.test.js -t "Shape2D"`
Expected: FAIL — `s.kind` is undefined (the shape is walked as a plain object today).

- [ ] **Step 3: Wire the duck type into the walker**

In `src/framework/oracle/measure.js`, add the import at the top:

```js
import { summarizeContours } from "./shape-probe.js";
```

Below `isSolid` (line ~29) add:

```js
// A Shape2D is a class instance with value semantics: walking it as a plain object
// would leak its storage fields. Duck-typed on the two reads the summary needs.
const isShape2D = (v) => v !== null && typeof v === "object"
  && typeof v.toContours === "function" && typeof v.area === "function";

const shapeProbeFacts = (shape) => summarizeContours(shape.toContours(), {
  isEmpty: typeof shape.isEmpty === "function" ? shape.isEmpty() : false,
  area: shape.area(),
  bbox: typeof shape.boundingBox === "function" ? shape.boundingBox() : null,
});
```

In `resolveProbeValue`, add the branch right after the Solid one:

```js
  if (isSolid(v)) return solidProbeFacts(v);
  if (isShape2D(v)) return shapeProbeFacts(v);
```

Update the header comment above `isSolid` to say "A Solid … is replaced by a fact object; a Shape2D by its arc/corner summary (shape-probe.js)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/measure.test.js`
Expected: PASS, including every pre-existing probe test. If `profileBounds` returns `{min, max}` under different key names, read `src/framework/geometry/contour-ops.js:901` and adapt `shapeProbeFacts`, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/measure.js test/measure.test.js
git commit -m "probes: a Shape2D in a probe result is summarised into arcs and corners"
```

---

### Task 3: Types, docs, and the Feature 1 release

**Files:**
- Modify: `types/testing.d.ts` (`MeasureReport`, ~line 307 — add `probes?`, and a `ShapeProbeFacts` interface above it)
- Modify: `docs/AUTHORING-PARTS.md` (insert before the `**Cost.**` paragraph in "Probes: measuring geometry into the report", ~line 2410)
- Modify: `package.json` (version `0.118.0` → `0.119.0`)

- [ ] **Step 1: Add the types**

Above `export interface MeasureReport` in `types/testing.d.ts`:

```ts
/** One arc of a probed `Shape2D` ring: centre and radius from the contour IR. */
export interface ProbeArc {
  center: [number, number];
  r: number;
  from: [number, number];
  to: [number, number];
  /** Signed; positive counter-clockwise. */
  sweepDeg: number;
  /** Present when the segment was a cubic and the circle is a fit, not a construction. */
  fit?: "cubic";
}

export interface ProbeRing {
  /** Total segment count, before any cap. */
  segments: number;
  /** At most 64; `truncated` on the summary says when the list was cut. */
  arcs: ProbeArc[];
  /** Straight segments, count only. */
  lines: number;
  corners: Array<{ point: [number, number]; interiorAngleDeg: number; convex: boolean }>;
}

/** What a `Shape2D` returned from a probe becomes in the report. */
export interface ShapeProbeFacts {
  kind: "shape2d";
  empty: boolean;
  area: number;
  bbox: { min: [number, number]; max: [number, number] } | null;
  regions: Array<{ outer: ProbeRing; holes: ProbeRing[] }>;
  truncated: boolean;
}
```

Inside `MeasureReport`, after `nearMisses: Gap[];`:

```ts
  /**
   * Declared probes' values, present only when the part declares probes and this
   * run evaluated them. A Solid in a probe's return value becomes a fact object, a
   * Shape2D becomes a `ShapeProbeFacts`, plain JSON passes through, a throw is `{error}`.
   */
  probes?: Record<string, unknown>;
```

Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 2: Add the docs paragraph**

Insert before `**Cost.**` in the Probes section of `docs/AUTHORING-PARTS.md`:

```markdown
**Reading a 2-D shape's arcs and corners.** Return the `Shape2D` itself and the
report carries a summary instead of the object: every arc as `{ center, r, from,
to, sweepDeg }` (exact for a `{to, via}` arc; a cubic — what a curve-adjacent
fillet emits — is fitted through its start, midpoint and end and tagged `fit:
"cubic"`), every corner as `{ point, interiorAngleDeg, convex }`, plus `area`,
`bbox`, and a straight-segment count. This is the instrument for any question a
render cannot settle to a fraction of a millimetre: whether two arcs share a
centre (a bend's inner and outer radii), what radius a `fillet` actually took
after clamping, whether a corner is still a corner. A ring lists at most 64 arcs
and 64 corners and the summary says `truncated` when it had to cut, so keep the
probe to the region in question — intersect with a small rectangle first.

```js
probes: {
  bend: (k, p, d) => trayPocket(k, p, d).intersect(k.shape2d([[18, -6], [28, -6], [28, 4], [18, 4]])),
}
// → probes.bend.regions[0].outer.arcs: [{ center: [23.75, -3], r: 4, … }]
```
```

- [ ] **Step 3: Bump the version and run everything**

Edit `package.json`: `"version": "0.119.0"`.

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green. (WASM boots make the suite slow — several minutes is normal.)

- [ ] **Step 4: Commit and open the PR**

```bash
git add types/testing.d.ts docs/AUTHORING-PARTS.md package.json
git commit -m "docs+types: Shape2D probe summaries; 0.119.0"
git push -u origin claude/shape2d-probe-wall-band
```

Open a PR titled "Probes: read a Shape2D's arcs and corners back from the report". Body per the reviewer-friendly style in `~/.claude/CLAUDE.md`: what it does for an author, the feedback #95 origin, the caps, and that nothing reports automatically. Link the spec.

---

### Task 4: Second worktree + `minWall()` learns a band

**Files:**
- Create worktree: `.claude/worktrees/wall-band-metric` on branch `claude/wall-band-metric` from `origin/main`
- Modify: `src/framework/oracle/min-wall.js:74-115`
- Test: `test/wall-band.test.js` (new; this file grows through Tasks 4-7)

**Interfaces:**
- Produces: `minWall(mesh, { band?: {min, max}, … })` returns the existing object plus `band: { value, location, members } | null` — `null` when no band was requested; `{ value: null, location: null, members: 0 }` when no sample fell in the membership window `[0.75 × min, 1.5 × max]`; otherwise `value` = the member thickness farthest from the band (or, when all members are inside it, farthest from its midpoint), `location` = that ray's origin centroid.
- Consumes: nothing new.

- [ ] **Step 0: Create the worktree**

```bash
cd /Users/scottsykora/Documents/Docs/pixite/code/partforge
git fetch origin main
git worktree add .claude/worktrees/wall-band-metric -b claude/wall-band-metric origin/main
cd .claude/worktrees/wall-band-metric && npm install --no-audit --no-fund
```

Copy `docs/superpowers/specs/2026-09-21-shape2d-probe-and-wall-band-design.md` and this plan into the new worktree (`git show claude/shape2d-probe-wall-band:<path> > <path>`) and commit them there first, so the branch carries its own spec.

- [ ] **Step 1: Write the failing tests**

```js
// test/wall-band.test.js
// The `wall` band metric end to end: min-wall's extra running extreme (Task 4), the
// band resolved from verify.expect (Task 5), the sub-part fact (Task 6), the verify
// check (Task 7). The fixture is partforge-cloud feedback #95's bend: a 2 mm L-wall
// whose outer arc is r=4 about C; concentric when the inner arc is r=2 about C, and
// the shipped bug when it is r=3.5 about C' — 2.62 mm thick at the diagonal.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { minWall } from "../src/framework/oracle/min-wall.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const C = [6, 12];
// Everything on the wall's side of the OUTER boundary (outer corner rounded r=4 about C).
const outerRegion = (kk) => kk.shape2d([[0, 8], [6, 8], [10, 12], [10, 20], [0, 20]])
  .union(kk.shape2d(circleProfile(4, C, 128)));
// The pocket: inner corner rounded r=2 about C (concentric) …
const pocketConcentric = (kk) => kk.shape2d([[0, 10], [6, 10], [8, 12], [8, 20], [0, 20]])
  .union(kk.shape2d(circleProfile(2, C, 128)));
// … or r=3.5 about C' = (4.5, 13.5), tangent to the same two faces (the bug).
const pocketOffset = (kk) => kk.shape2d([[0, 10], [4.5, 10], [8, 13.5], [8, 20], [0, 20]])
  .union(kk.shape2d(circleProfile(3.5, [4.5, 13.5], 128)));
export const lWall = (kk, concentric) => outerRegion(kk).cut(concentric ? pocketConcentric(kk) : pocketOffset(kk)).extrude({ h: 10 });

test("minWall without a band is unchanged and reports band: null", () => {
  const r = minWall(lWall(k, true).toMesh());
  expect(r.value).toBeCloseTo(2, 1);
  expect(r.band).toBeNull();
});

test("a concentric bend stays inside its band", () => {
  const r = minWall(lWall(k, true).toMesh(), { band: { min: 1.8, max: 2.2 } });
  expect(r.band.members).toBeGreaterThan(0);
  expect(r.band.value).toBeGreaterThanOrEqual(1.8);
  expect(r.band.value).toBeLessThanOrEqual(2.25);
});

test("the offset bend reports its thickest member, located in the bend", () => {
  const r = minWall(lWall(k, false).toMesh(), { band: { min: 1.8, max: 2.2 } });
  expect(r.band.value).toBeGreaterThan(2.4);
  expect(r.band.value).toBeLessThan(2.8);
  const [x, y] = r.band.location;
  expect(x).toBeGreaterThan(5.5); expect(x).toBeLessThan(10.5);
  expect(y).toBeGreaterThan(7.5); expect(y).toBeLessThan(12.5);
});

test("samples outside the membership window are not members", () => {
  // A 10×20×5 block: every ray reads 5, 10 or 20 — none within [1.35, 3.3].
  const r = minWall(k.box({ min: [0, 0, 0], max: [10, 20, 5] }).toMesh(), { band: { min: 1.8, max: 2.2 } });
  expect(r.band).toEqual({ value: null, location: null, members: 0 });
});

test("a 1.2 mm floor under a 2 mm wall is ignored by the band", () => {
  const floor = k.box({ min: [0, 0, 0], max: [10, 20, 1.2] });
  const solid = lWall(k, true).translate([0, 0, 1.2]).union(floor);
  const r = minWall(solid.toMesh(), { band: { min: 1.8, max: 2.2 } });
  expect(r.value).toBeCloseTo(1.2, 1);                  // min wall still sees the floor
  expect(r.band.value).toBeGreaterThanOrEqual(1.8);     // the band does not
  expect(r.band.value).toBeLessThanOrEqual(2.25);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/wall-band.test.js`
Expected: the first test FAILS on `expect(r.band).toBeNull()` (`undefined`), the rest fail on `r.band` being undefined. If `lWall` itself throws, fix the fixture (check `circleProfile(r, center, segs)` signature at `src/framework/geometry/polygon.js:308`), not the assertions.

- [ ] **Step 3: Add the band to the ray loop**

In `src/framework/oracle/min-wall.js`, above `export function minWall` add:

```js
// Membership window for a declared wall band: a ray reading inside
// [BAND_FLOOR × min, BAND_CEIL × max] belongs to that wall; anything outside is another
// feature (a thinner floor, a solid boss) and is ignored. Constants, not knobs: a part
// that needs two bands declares two sub-parts.
export const BAND_FLOOR = 0.75;
export const BAND_CEIL = 1.5;
```

Change the signature and the loop:

```js
export function minWall(mesh, { maxThickness, maxSamples = MAX_SAMPLES, bvh = buildBVH(mesh), band = null } = {}) {
  …
  // Band tracking: the member farthest from the band, or — while every member is
  // inside it — farthest from its midpoint. One comparison per ray, no new rays.
  const bandLo = band ? BAND_FLOOR * band.min : 0, bandHi = band ? BAND_CEIL * band.max : 0;
  const bandMid = band ? (band.min + band.max) / 2 : 0;
  let bandWorst = -1, bandValue = null, bandLoc = null, members = 0;
  const bandScore = (x) => x > band.max ? 1 + (x - band.max) : x < band.min ? 1 + (band.min - x) : Math.abs(x - bandMid) / (band.max - band.min + 1e-9);
  …
    if (hit && hit.t < best) { best = hit.t; loc = c; }
    if (band && hit && hit.t >= bandLo && hit.t <= bandHi) {
      members++;
      const s = bandScore(hit.t);
      if (s > bandWorst) { bandWorst = s; bandValue = hit.t; bandLoc = c; }
    }
  }
  return {
    value: best === Infinity ? null : best, location: loc, sampled, sampledTriangles: budget, totalTriangles: n,
    band: band ? { value: bandValue, location: bandLoc, members } : null,
  };
```

(`bandScore` ranks any out-of-band member above every in-band one: out-of-band scores start at 1, in-band scores are the normalised distance from the midpoint, at most 0.5.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/wall-band.test.js test/min-wall.test.js`
Expected: PASS. The existing min-wall tests must be untouched by the change.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/min-wall.js test/wall-band.test.js
git commit -m "min-wall: track the worst member of a declared wall band in the same ray pass"
```

---

### Task 5: Resolve the band from `verify.expect`

**Files:**
- Modify: `src/framework/oracle/gates.js` (append after `partGatesMinWall`, ~line 60; widen `partGatesMinWall`)
- Test: `test/wall-band.test.js` (append)

**Interfaces:**
- Produces: `partWallBands(part, params) → Record<subpartName, {min, max}>` (empty object when nothing is declared; throws `Error('wall expectation for "<name>" must be a range like "1.8..2.2"')` on any non-range form). `partGatesMinWall(part)` now also returns `true` when any case declares `wall`.
- Consumes: `parseAssertion` from `./assert-dsl.js`, `resolveParams` from `../part-model.js` (already imported in gates.js).

- [ ] **Step 1: Write the failing tests**

Append to `test/wall-band.test.js`:

```js
import { partWallBands, partGatesMinWall } from "../src/framework/oracle/gates.js";

const bandPart = (expect) => ({
  meta: { title: "L", units: "mm" },
  defaults: { concentric: 1 },
  parts: { wall: { views: ["v"], build: (kk, p) => lWall(kk, p.concentric > 0) } },
  views: { v: { label: "V" } },
  verify: { expect },
});

test("partWallBands reads a static wall range per sub-part", () => {
  expect(partWallBands(bandPart({ wall: { wall: "1.8..2.2" } }), {})).toEqual({ wall: { min: 1.8, max: 2.2 } });
  expect(partWallBands(bandPart({ wall: { volume: ">0" } }), {})).toEqual({});
  expect(partWallBands(bandPart(undefined), {})).toEqual({});
});

test("partWallBands resolves a function expect against the given params", () => {
  const fn = (p) => ({ wall: { wall: p.concentric > 0 ? "1.8..2.2" : "2.4..2.8" } });
  expect(partWallBands(bandPart(fn), {})).toEqual({ wall: { min: 1.8, max: 2.2 } });
  expect(partWallBands(bandPart(fn), { concentric: 0 })).toEqual({ wall: { min: 2.4, max: 2.8 } });
});

test("a non-range wall expectation throws, naming the sub-part", () => {
  expect(() => partWallBands(bandPart({ wall: { wall: "<=2" } }), {})).toThrow(/wall expectation for "wall" must be a range/);
  expect(() => partWallBands(bandPart({ wall: { wall: 2 } }), {})).toThrow(/must be a range/);
});

test("a declared wall arms the full min-wall sample budget", () => {
  expect(partGatesMinWall(bandPart({ wall: { wall: "1.8..2.2" } }))).toBe(true);
  expect(partGatesMinWall(bandPart({ wall: { volume: ">0" } }))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/wall-band.test.js -t "partWallBands|arms"`
Expected: FAIL — `partWallBands` is not exported.

- [ ] **Step 3: Implement**

In `src/framework/oracle/gates.js` add the import `import { parseAssertion } from "./assert-dsl.js";` and, after `partGatesMinWall`:

```js
// The wall bands a measurement of `params` must track, per sub-part, from the part's
// own `verify.expect` — resolved for exactly these params (a function expect may
// change the band per case). Range form only: the membership window needs both ends.
// Throws on a bad form so verify reports it where a reader can act; measure's caller
// (Task 6) lets that throw surface as the measure error it is.
export function partWallBands(part, params = {}) {
  const spec = part?.verify?.expect;
  if (!spec) return {};
  const expect = typeof spec === "function" ? (spec(...Object.values(resolveParams(part, params))) ?? {}) : spec;
  const out = {};
  for (const [name, metrics] of Object.entries(expect)) {
    if (name === "_view" || !metrics || typeof metrics !== "object" || !("wall" in metrics)) continue;
    const raw = metrics.wall;
    const expr = raw && typeof raw === "object" && "expr" in raw ? raw.expr : raw;
    let parsed = null;
    try { parsed = parseAssertion(expr); } catch { parsed = null; }
    if (!parsed || parsed.op !== "range") throw new Error(`wall expectation for "${name}" must be a range like "1.8..2.2"`);
    out[name] = { min: parsed.min, max: parsed.max };
  }
  return out;
}
```

Note: `resolveParams` returns `{p, d}`; `spec(p, d)` is the contract (see `expandExpectations` above). Write it as `const { p, d } = resolveParams(part, params); … spec(p, d)` rather than the spread above — the spread is only a reminder that both are passed.

In `partGatesMinWall`, change the `.some(...)` predicate to:

```js
      Object.values(expect ?? {}).some((o) => o && typeof o === "object" && ("minWall" in o || "wall" in o)));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/wall-band.test.js test/oracle-fast-lap.test.js test/dfm-profiles.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/gates.js test/wall-band.test.js
git commit -m "gates: resolve a sub-part's declared wall band; a wall expectation arms full min-wall sampling"
```

---

### Task 6: `measure` reports `wall` per sub-part

**Files:**
- Modify: `src/framework/oracle/measure.js` (~line 126 budget line; ~line 141 the `minWall(...)` call; ~lines 182-191 the facts)
- Test: `test/wall-band.test.js` (append)

**Interfaces:**
- Produces: each `SubPartFacts` gains `wall: { value: number|null, location: number[]|null, band: {min, max}, members: number } | null` — `null` when the sub-part declares no band OR min wall was not measured (`opts.minWall` false).
- Consumes: `partWallBands` (Task 5), `minWall`'s `band` (Task 4).

- [ ] **Step 1: Write the failing tests**

Append to `test/wall-band.test.js`:

```js
import { measure } from "../src/framework/oracle/measure.js";

test("measure reports the wall band fact for a declared sub-part", () => {
  const r = measure(k, bandPart({ wall: { wall: "1.8..2.2" } }), "v", {}, { minWall: true });
  const s = r.subparts[0];
  expect(s.wall.band).toEqual({ min: 1.8, max: 2.2 });
  expect(s.wall.members).toBeGreaterThan(0);
  expect(s.wall.value).toBeLessThanOrEqual(2.25);
});

test("the offset bend's wall fact carries the deviation and its location", () => {
  const r = measure(k, bandPart({ wall: { wall: "1.8..2.2" } }), "v", { concentric: 0 }, { minWall: true });
  const s = r.subparts[0];
  expect(s.wall.value).toBeGreaterThan(2.4);
  expect(s.wall.location[0]).toBeGreaterThan(5.5);
});

test("no band declared, or min wall not measured, reads wall: null", () => {
  expect(measure(k, bandPart({ wall: { volume: ">0" } }), "v", {}, { minWall: true }).subparts[0].wall).toBeNull();
  expect(measure(k, bandPart({ wall: { wall: "1.8..2.2" } }), "v", {}).subparts[0].wall).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/wall-band.test.js -t "measure|offset bend's wall|reads wall"`
Expected: FAIL — `s.wall` is undefined.

- [ ] **Step 3: Wire it**

In `src/framework/oracle/measure.js`: import `partWallBands` beside `partGatesMinWall`. Next to the `minWallSamples` line add:

```js
  // Declared wall bands, per sub-part, for exactly these params (Task 5). Resolved
  // once per measure; a bad declaration throws here, which is a measure error.
  const wallBands = opts.minWall ? partWallBands(part, params) : {};
```

Change the `minWall(...)` call:

```js
    const mw = opts.minWall
      ? minWall(mesh, { bvh: cachedBVH(mesh, bvhCache), maxSamples: minWallSamples, band: wallBands[name] ?? null })
      : null;
```

After `minWallSamples: …,` in the facts object add:

```js
      // The declared wall band's worst member (min-wall.js): null unless this
      // sub-part declared `wall` and the pass ran.
      wall: mw?.band && wallBands[name]
        ? { value: mw.band.value, location: mw.band.location, band: wallBands[name], members: mw.band.members }
        : null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/wall-band.test.js test/measure.test.js test/measure-occt.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/measure.js test/wall-band.test.js
git commit -m "measure: report the declared wall band's worst member per sub-part"
```

---

### Task 7: The `wall` metric in verify

**Files:**
- Modify: `src/framework/verify-metrics.js` (after the `minWall` entry)
- Modify: `src/framework/oracle/verify.js:120-152` (`check`), `:180-198` (sub-part loop)
- Test: `test/verify.test.js` (append), `test/wall-band.test.js` (append one end-to-end test)

**Interfaces:**
- Produces: a `subpart`-scoped check `{ metric: "wall", kind: "warn", … }`; `status: "warn"` with `location` when the worst member is outside the band; `"pass"` inside; `"skip"` with message `no wall in band` when `wall.value` is null; `unevaluated` on a quick lap exactly as `minWall`.
- Registry entries may now carry `form: "range"` (read by Task 8's lint rule) and `unavailable` (the skip message).

- [ ] **Step 1: Write the failing tests**

Append to `test/verify.test.js`:

```js
const wallFacts = (value, location = [8, 9, 5]) => ({
  measuredMinWall: true,
  subparts: [{ name: "wall", holes: 0, volume: 100, surfaceArea: 100, triangleCount: 10, bbox: [10, 12, 10], watertight: true, minWall: 2,
    wall: value === undefined ? null : { value, location, band: { min: 1.8, max: 2.2 }, members: value === null ? 0 : 40 } }],
  aggregate: { bbox: [10, 12, 10], volume: 100 },
  overlaps: [],
});

test("wall outside its band is a located warning", () => {
  const w = byKey(evaluateCase(wallFacts(2.62), { profile: null, expect: { wall: { wall: "1.8..2.2" } } }), "subpart", "wall");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.location).toEqual([8, 9, 5]);
  expect(w.message).toMatch(/2\.62 out of 1\.8\.\.2\.2/);
  expect(w.hint).toMatch(/drifts from the declared band/);
});

test("wall inside its band passes and still reports the worst member", () => {
  const w = byKey(evaluateCase(wallFacts(2.05), { profile: null, expect: { wall: { wall: "1.8..2.2" } } }), "subpart", "wall");
  expect(w.status).toBe("pass");
  expect(w.actual).toBe(2.05);
});

test("wall with no member skips with its own message", () => {
  const w = byKey(evaluateCase(wallFacts(null), { profile: null, expect: { wall: { wall: "1.8..2.2" } } }), "subpart", "wall");
  expect(w.status).toBe("skip");
  expect(w.message).toBe("no wall in band");
});

test("wall on a quick lap is unevaluated, like minWall", () => {
  const facts = { ...wallFacts(undefined), measuredMinWall: false };
  const w = byKey(evaluateCase(facts, { profile: null, expect: { wall: { wall: "1.8..2.2" } } }), "subpart", "wall");
  expect(w.unevaluated).toBe(true);
  expect(w.message).toBe("not measured (quick check)");
});
```

Append to `test/wall-band.test.js`:

```js
import { verify } from "../src/framework/oracle/verify.js";

test("end to end: the offset bend warns, the concentric bend passes", () => {
  const part = bandPart((p) => ({ wall: { wall: "1.8..2.2" } }));
  const bad = verify(k, { ...part, defaults: { concentric: 0 } });
  const badCheck = bad.warnings.find((c) => c.metric === "wall");
  expect(badCheck).toBeDefined();
  expect(badCheck.actual).toBeGreaterThan(2.4);
  expect(badCheck.location[0]).toBeGreaterThan(5.5);
  const good = verify(k, part);
  expect(good.warnings.find((c) => c.metric === "wall")).toBeUndefined();
  expect(good.ok).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/verify.test.js test/wall-band.test.js -t "wall"`
Expected: FAIL — `unknown subpart metric "wall"`.

- [ ] **Step 3: Register the metric and teach `check`**

In `src/framework/verify-metrics.js`, after the `minWall` entry:

```js
  // The declared wall band's worst member (min-wall.js `band`): the member thickness
  // farthest from the range the part declared, located. Range form only — `form` is
  // read by the linter's verify-bad-expr rule and by gates.js. A warning like minWall,
  // because it is a sampled ray reading: a sample can miss the widest spot, never
  // invent one. `unavailable` is the skip message when no ray fell in the window.
  wall: { kind: "warn", form: "range", extract: (s) => s.wall?.value ?? null,
    hint: "wall thickness drifts from the declared band at the reported location — a fillet radius, an offset or a boolean tool there is not tracking the wall",
    locate: (s) => s.wall?.location ?? null,
    unavailable: "no wall in band",
    note: (s) => {
      if (!s.wall) return null;
      const sampled = s.minWallSampled && s.minWallSamples ? ` (sampled ${s.minWallSamples.sampled} of ${s.minWallSamples.total} triangles)` : "";
      return `${s.wall.members} rays read as this wall${sampled}`;
    } },
```

In `src/framework/oracle/verify.js` `check()`, replace the final generic skip line:

```js
    return { ...base, actual, status: "skip", pass: null, message: reg.unavailable ?? "unavailable" };
```

In the sub-part loop, widen the quick-lap guard:

```js
      if (minWallSkipped && (metric === "minWall" || metric === "wall") && c.actual == null) {
        checks.push({ ...c, unevaluated: true, message: "not measured (quick check)",
          hint: `re-run this check without \`quick\` to measure ${metric === "wall" ? "the wall band" : "min wall"}` });
        continue;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/verify.test.js test/verify-metrics.test.js test/wall-band.test.js test/oracle-fast-lap.test.js`
Expected: PASS. If `test/verify-metrics.test.js` enumerates the registry's keys or required fields, extend its table with `wall` rather than loosening it.

- [ ] **Step 5: Commit**

```bash
git add src/framework/verify-metrics.js src/framework/oracle/verify.js test/verify.test.js test/wall-band.test.js
git commit -m "verify: the wall metric — a located warning when a declared wall drifts from its band"
```

---

### Task 8: Lint knows `wall` and its range-only form

**Files:**
- Modify: `src/framework/lint/rules-verify.js` (`verify-bad-expr`, ~lines 240-256)
- Test: `test/lint-verify.test.js` (append)

**Interfaces:**
- Consumes: `SUBPART_METRICS.wall.form === "range"` (Task 7).
- Produces: `verify-bad-expr` on any non-range `wall` assertion; `wall` is already a known metric via the registry.

- [ ] **Step 1: Write the failing tests**

Append to `test/lint-verify.test.js`:

```js
test("wall is a known sub-part metric", () => {
  const r = lintPart(partWith({ expect: { body: { wall: "1.8..2.2" } } }));
  expect(ids(r.errors)).not.toContain("verify-unknown-metric");
  expect(ids(r.errors)).not.toContain("verify-bad-expr");
});

test("a wall expectation that is not a range is a bad expression", () => {
  const r = lintPart(partWith({ expect: { body: { wall: "<=2" } } }));
  expect(ids(r.errors)).toContain("verify-bad-expr");
  expect(find(r, "verify-bad-expr").message).toMatch(/wall.*must be a range/);
  expect(find(r, "verify-bad-expr").path).toBe("verify.expect.body.wall");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/lint-verify.test.js -t "wall"`
Expected: the second test FAILS (no error emitted for `"<=2"`).

- [ ] **Step 3: Extend the rule**

In `verify-bad-expr`'s inner loop, after the `try { parseAssertion(exprOf(spec)); }` succeeds, add the form check. Restructure the body of the loop to:

```js
        const registry = target === "_view" ? VIEW_METRICS : SUBPART_METRICS;
        for (const [metric, spec] of Object.entries(metrics)) {
          let parsed;
          try { parsed = parseAssertion(exprOf(spec)); }
          catch (e) {
            out.push(err("verify-bad-expr",
              `the expectation for ${target}.${metric} is not a valid assertion: ${e?.message || String(e)}`,
              "Use the assertion DSL: a bare value for equality, a comparison like `>=3`, a range like `2..5`, or a componentwise vector like `<=[60,60,60]` (with `*` to skip an axis).",
              `verify.expect.${target}.${metric}`));
            continue;
          }
          const form = registry[metric]?.form;
          if (form === "range" && parsed.op !== "range") {
            out.push(err("verify-bad-expr",
              `the expectation for ${target}.${metric} must be a range like "1.8..2.2" — the ${metric} metric needs both ends of its band`,
              `Write ${metric} as \`"<min>..<max>"\` in mm.`,
              `verify.expect.${target}.${metric}`));
          }
        }
```

(`VIEW_METRICS` and `SUBPART_METRICS` are already imported at the top of the file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/lint-verify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/rules-verify.js test/lint-verify.test.js
git commit -m "lint: a wall expectation must be a range"
```

---

### Task 9: Types, docs, and the Feature 2 release

**Files:**
- Modify: `types/testing.d.ts` (`SubPartFacts`, after `minWallSamples`)
- Modify: `docs/AUTHORING-PARTS.md` (Self-verification section: the `expect` metric list at ~line 3324, and a paragraph after "**Gates vs. warnings:**")
- Modify: `package.json` (version → `0.120.0`; if Feature 1 has not merged yet, still `0.120.0` — whichever merges second rebases and re-checks its bump)

- [ ] **Step 1: Types**

In `SubPartFacts` after `minWallSamples`:

```ts
  /**
   * The declared wall band's worst member: the sampled thickness farthest from the
   * range the part's `verify.expect.<name>.wall` declared (or, when every member is
   * inside it, farthest from its midpoint), where it was read, the band, and how many
   * rays fell in the membership window `[0.75 × min, 1.5 × max]`. `null` when the
   * sub-part declares no band or min wall was not measured; `value` null when no ray
   * read as this wall.
   */
  wall: { value: number | null; location: number[] | null; band: { min: number; max: number }; members: number } | null;
```

Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 2: Docs**

In the `expect` metric list, change `` `overhangArea`, `boundsMin` / `boundsMax` `` to `` `overhangArea`, `wall` (a range — see below), `boundsMin` / `boundsMax` ``.

After the "**Gates vs. warnings:**" paragraph add:

```markdown
**A wall that must stay one thickness: `wall`.** `minWall` answers "is anything too
thin"; `wall` answers "does this wall stay what I declared" — the question a bend, a
fillet or an offset silently breaks. Declare it as a range in mm, per sub-part:

```js
verify: { expect: { tray: { wall: "1.8..2.2" } } }
```

It rides the same inward rays as `minWall`. A ray reading inside `[0.75 × min,
1.5 × max]` counts as this wall (a 1.2 mm floor under a 2 mm wall is another
feature and is ignored); the check reports the member farthest from the band, with
its location, and warns when it lies outside — `wall 2.62 out of 1.8..2.2 at (22.8,
-2.0, 15.1)` is a bend whose outer arc is not concentric with its inner one. Range
form only (lint refuses `"<=2"`), a warning like `minWall` because it is a sampled
reading, and a part that needs two thicknesses declares two sub-parts.
```

- [ ] **Step 3: Bump, run everything, commit, PR**

Edit `package.json`: `"version": "0.120.0"`.

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

```bash
git add types/testing.d.ts docs/AUTHORING-PARTS.md package.json
git commit -m "docs+types: the wall band metric; 0.120.0"
git push -u origin claude/wall-band-metric
```

Open a PR titled "Verify: a `wall` expectation warns when a wall drifts from its band". Reviewer-friendly body; link the spec; note it merges after the Shape2D probe PR and re-checks its bump after rebasing.

---

### Task 10: Cloud follow-through (partforge-cloud, after both versions publish)

**Files (partforge-cloud repo, new worktree from `main`):**
- Modify: `src/sandbox/protocol.js` (`sanitizeMeasure`, the sub-part map ~line 1081)
- Modify: the unit test that pins `sanitizeMeasure` (`grep -rln "sanitizeMeasure" tests/unit`)
- Modify: `prompts/authoring-compact-essentials.md`
- Modify: `package.json` (partforge pin), then `npm run docs:generate && npm run prompt:generate`

**Interfaces:**
- Consumes: partforge ≥ 0.120.0's `SubPartFacts.wall` and `ShapeProbeFacts`.

- [ ] **Step 1: Sanitizer test + change**

Add a row to the `sanitizeMeasure` test: a sub-part carrying `wall: { value: 2.62, location: [22.8, -2, 15.1], band: { min: 1.8, max: 2.2 }, members: 40 }` must come through with all four fields, and `wall: null` / a missing field must read `null`. Then in `sanitizeMeasure`'s sub-part mapper add:

```js
    wall: s?.wall && typeof s.wall === "object"
      ? { value: finite(s.wall.value), location: vec3(s.wall.location),
          band: { min: finite(s.wall.band?.min), max: finite(s.wall.band?.max) }, members: finite(s.wall.members) }
      : null,
```

Run the protocol tests; commit.

- [ ] **Step 2: Pin bump + regeneration**

`npm install partforge@0.120.0`, then `npm run docs:generate && npm run prompt:generate`. Read the prompt diff: the probes paragraph and the `wall` metric must appear in the generated corpus; nothing else should move. Run `npm test`.

- [ ] **Step 3: Essentials paragraph**

Add to `prompts/authoring-compact-essentials.md`, beside the existing probes guidance (~line 181):

```markdown
- **Sub-millimetre 2-D questions are answered by numbers, never renders.** When the
  ask is a relationship — two arcs concentric, a wall constant around a bend, a
  fillet that actually took its radius — declare a probe that returns the `Shape2D`
  (intersect it with a small rectangle around the spot first) and read
  `probes.<name>.regions[].outer.arcs[]` for centres and radii; when a wall must stay
  one thickness, declare `wall: "<min>..<max>"` on that sub-part and read the
  located warning. A zoomed render cannot tell a 3.5 mm arc from a 4 mm one whose
  centre sits 1.5 mm away; the report can.
```

Re-run `npm run prompt:generate`, read the diff, run `npm test`, commit.

- [ ] **Step 4: Prove it on the feedback part**

Re-run the headless build of feedback #95's saved tree (the harness in this session's scratchpad, or `evals/runner/headless.js`'s `applyTree`) with `probes: { bend: … }` and `verify.expect.topTray.wall: "1.8..2.2"` added, and confirm the measure report names two centres 1.5 mm apart and the verify report warns at the bend. Paste both lines into the PR body.

---

## Self-review notes

- **Spec coverage.** Feature 1: summariser (T1), duck type + walker (T2), caps and `truncated` (T1), no `index` (T1 test), types + docs (T3). Feature 2: band in the ray pass (T4), per-params resolution + full budget (T5), sub-part fact (T6), registry/warn/skip/unevaluated (T7), lint range-only (T8), types + docs (T9). Cloud follow-through (T10). The spec's "KERNEL-CONTRACT.md's probe row" does not exist in the current docs (the file's "probe" mentions are the backend probe), so the docs change lands in AUTHORING-PARTS.md only — spec amended by this note.
- **Placeholders.** None; every step carries its code. T5 Step 3 flags one line the implementer must write the plain way (`const { p, d } = resolveParams(...)`).
- **Type consistency.** `summarizeContours(regions, {isEmpty, area, bbox})` (T1) is what T2 calls; `minWall(..., {band})` returns `band: {value, location, members}` (T4) and T6 wraps it with the declared `band`; `partWallBands(part, params)` (T5) is called by T6 with measure's `params`; `SUBPART_METRICS.wall.form` (T7) is read by T8; `s.wall` field names match between T6, T7's fake facts, T9's types and T10's sanitizer.
