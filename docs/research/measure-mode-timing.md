# Measure mode timing

Task 1 of the measure mode redesign timed the OLD mode, before any measure
code changed (the first half of this file). Task 8 timed the NEW two-click
mode before and after its speed fix (the section "Task 8: the two-click
mode" below). Old and new use the same machine, browser, dev server, pages
and sampling.

## Method

- **Machine:** Apple M1 Max, 32 GB, macOS. Node 24.19.0.
- **Browser:** Playwright 1.61.0 headless Chromium (`--use-angle=swiftshader`),
  viewport 1400 × 900, against `vite` (the `npm run dev` server).
  All the timed paths are CPU work (three.js raycasts, typed-array scans,
  canvas label paint), so the software GL does not enter the numbers.
- **Instrumentation:** the script rewrites `measure-mode.js` in flight with
  `page.route` and adds `performance.now()` timers. Nothing in `src/` changed.
  - **hover** = the whole scheduled `onMove` callback (the `schedule` option is
    wrapped).
  - **click** = the whole `onClick` handler.
  - Inside each callback, the time is split into `raycastViewer`,
    `featureSpec` (the cache wrapper around `classifyFeature`), `placeDims`
    and `scene.update`. The parts do not add up to the total: the rest is
    `buildItems`, `evaluateChoices`, the highlight and the cache keys.
- **Samples:** the script probes a 3% grid of the canvas with the same
  `raycastViewer` and keeps only the points that hit the part. Hover: 300
  pointer moves (200 on filleted-box), two animation frames each. Click: 60
  (40) pin-then-unpin pairs, so pins never pile up. Only samples whose
  raycast hit the part are counted.
- **Two views of each number.** "All on-part" is every sample. Most of them
  are cache hits: `specCache`, `baseCache`, `paintCache` and `extremeCache`
  make a second visit to the same feature cheap. "Placed this frame" is only
  the samples in which `placeDims` ran, which is the first touch of a feature
  or a new pin set. That is the one a user feels as "slow".
- The script is in the appendix below, so Task 8 can run it again.

## Which part

| Page | Triangles | Feature labels |
| --- | ---: | ---: |
| hinged-box.html | 40 | 0 |
| relief.html | 29,750 | 0 |
| propeller.html | 52,798 | 3 |
| screw.html | **210,552** | 0 |
| filleted-box.html | 7,384 | 1 |

`screw.html` has the most triangles of all the demo pages, but it has no
feature labels, so a hover on it only ever finds the sub-part bounding box,
which the overall dims already show (the hover dim is suppressed). It times
the raycast cost well and nothing else. `propeller.html` is the largest part
with labelled features, so it is the main row below. `filleted-box.html` is a
typical small part.

## Results (ms)

Hover = one scheduled `onMove` callback. Click = one `onClick`.

| Part | Event | Samples | n | median | p95 | max |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| propeller (52.8k) | hover | all on-part | 300 | 3.0 | 3.6 | 97.1 |
| propeller (52.8k) | hover | placed this frame | 2 | — | — | 97.1 |
| propeller (52.8k) | click | all on-part | 110 | 3.2 | **20.5** | 39.0 |
| propeller (52.8k) | click | placed this frame | 7 | 37.4 | 39.0 | 39.0 |
| screw (210.6k) | hover | all on-part | 300 | 10.5 | **11.1** | 14.6 |
| screw (210.6k) | click | all on-part | 118 | 10.8 | 11.2 | 75.8 |
| screw (210.6k) | click | placed this frame | 1 | — | — | 75.8 |
| filleted-box (7.4k) | hover | all on-part | 197 | 0.5 | 0.7 | 5.7 |
| filleted-box (7.4k) | click | all on-part | 78 | 0.7 | 0.9 | 3.7 |

### Split (ms, the slow samples)

| Part | Event | total | raycastViewer | featureSpec / classifyFeature | placeDims | scene.update |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| propeller | first hover on a feature | 97.1 | 2.9 | **73.3** | 17.3 | 1.6 |
| propeller | click, placed (median of 7) | 37.4 | 2.9 | 0 (cached) | **34.0** | 0.3 |
| screw | any hover | 10.5 | **10.4** | 0 | 0 | 0 |
| screw | click, placed | 75.8 | 10.3 | 0 | **64.4** | 0.6 |
| filleted-box | first hover on a feature | 5.7 | 0.4 | 2.8 | 0.1 | 1.6 |

## What this says

1. **The first touch is the slow one, and it is many frames.** On the
   propeller, the first hover over a labelled feature takes 97 ms (six
   frames), and 73 ms of it is `classifyFeature`. The cylinder fit tries
   about 120 normal pairs, and scores each one against every triangle of the
   feature. The result is cached, so the second hover over the same feature is
   3 ms.
2. **A click that places is 35–75 ms, all in `placeDims`.** A pin changes the
   base set, so the base cache misses and the whole base pass is placed again.
   On the screw, 64 ms of the 76 ms is `placeDims`, and the vertex extremes
   are already cached by then, so that time is the `surfaceHit` raycasts: six
   bbox ends × about 10 ms each. A raycast against the 210k-triangle soup
   costs 10 ms (there is no BVH). On the propeller the same pass is 34 ms.
3. **Steady hover is bounded by one raycast.** With every cache warm, a hover
   is one `raycastViewer` call: 0.4 ms (7k triangles), 2.9 ms (53k) and
   10.4 ms (211k). On the screw that is already most of a 16 ms frame, every
   pointer move.
4. `scene.update` is never the problem (under 2 ms).

For Task 8: the targets to remove are (a) `classifyFeature` on first hover,
(b) the `surfaceHit` raycasts inside `placeDims` (and the full base re-place
on every pin), and (c) for parts past about 100k triangles, the unaccelerated
`raycastViewer` on every move.

## Limits

- Headless Chromium on an M1 Max is faster than a typical laptop and much
  faster than a phone. Read these as lower bounds.
- "Placed this frame" has few samples (1–7), because the demos have few
  features and the caches fill fast. Those rows report what one cold touch
  costs, not a distribution.
- Enabling the mode (the first full placement inside `setEnabled`) was not
  timed.

## Appendix: the Task 1 timing script

Run with the dev server up:

```bash
node measure-timing.cjs <repo dir> http://localhost:<port> propeller.html 300 60
```

```js
// Times today's measure mode hover/click in headless Chromium against the dev
// server. Instrumentation is injected by rewriting measure-mode.js in flight
// (page.route) — nothing in src/ changes.
// usage: node measure-timing.cjs <repoDir> <baseUrl> <page.html> [moves] [clicks]
//
// One record per hover callback (the scheduled onMove body) and per onClick:
//   { total, raycast, featureSpec, placeDims, sceneUpdate, hit }
// Sub-timers accumulate into the record of the callback they ran inside.
const { createRequire } = require("module");
const [repo, base, pageName, movesArg, clicksArg] = process.argv.slice(2);
const req = createRequire(repo + "/package.json");
const { chromium } = req("playwright");
const MOVES = Number(movesArg ?? 300), CLICKS = Number(clicksArg ?? 60);

const PRELUDE = `
const __pfT = (globalThis.__pfT ??= { recs: { hover: [], click: [] }, cur: null });
function __t(name, fn) {
  const t0 = performance.now();
  try { return fn(); } finally {
    const c = __pfT.cur; if (c) c[name] = (c[name] ?? 0) + performance.now() - t0;
  }
}
function __rec(kind, fn) {
  const outer = __pfT.cur;
  const rec = { raycast: 0, featureSpec: 0, placeDims: 0, sceneUpdate: 0, hit: null };
  __pfT.cur = rec;
  const t0 = performance.now();
  try { return fn(); } finally {
    rec.total = performance.now() - t0;
    __pfT.cur = outer;
    __pfT.recs[kind].push(rec);
  }
}
`;

function instrument(src) {
  const rep = (a, b) => { if (!src.includes(a)) throw new Error("anchor missing: " + a.slice(0, 60)); src = src.replace(a, b); };
  src = PRELUDE + src;
  const bodyStart = src.indexOf(") {", src.indexOf("export function createMeasureMode")) + 3;
  src = src.slice(0, bodyStart)
    + `\n  globalThis.__pfViewer = viewer;\n  schedule = ((orig) => (cb) => orig(() => __rec("hover", cb)))(schedule);\n`
    + src.slice(bodyStart);
  rep(`function featureSpec(mesh, featureId) {`,
    `function featureSpec(mesh, featureId) { return __t("featureSpec", () => __featureSpec(mesh, featureId)); }\n  function __featureSpec(mesh, featureId) {`);
  rep(`const hit = raycastViewer(viewer, p.x, p.y);`,
    `const hit = __t("raycast", () => raycastViewer(viewer, p.x, p.y)); if (__pfT.cur) __pfT.cur.hit = !!hit;`);
  rep(`const hit = raycastViewer(viewer, ev.clientX, ev.clientY);`,
    `const hit = __t("raycast", () => raycastViewer(viewer, ev.clientX, ev.clientY)); if (__pfT.cur) __pfT.cur.hit = !!hit;`);
  rep(`placeDims(list, {`, `__t("placeDims", () => placeDims(list, {`);
  rep(`bounds, suppress, lanes, units }, choices);`, `bounds, suppress, lanes, units }, choices));`);
  rep(`scene.update(drawings); }`, `__t("sceneUpdate", () => scene.update(drawings)); }`);
  rep(`function onClick(ev) {`, `function onClick(ev) { return __rec("click", () => __onClick(ev)); }\n  function __onClick(ev) {`);
  return src;
}

const q = (s, p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
function summarize(recs) {
  if (!recs.length) return { n: 0 };
  const out = { n: recs.length };
  for (const k of ["total", "raycast", "featureSpec", "placeDims", "sceneUpdate"]) {
    const s = recs.map((r) => r[k] ?? 0).sort((a, b) => a - b);
    out[k] = { median: +q(s, 0.5).toFixed(2), p95: +q(s, 0.95).toFixed(2), max: +s[s.length - 1].toFixed(2),
      mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) };
  }
  return out;
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.route("**/src/framework/measure/measure-mode.js*", async (route) => {
    const resp = await route.fetch();
    await route.fulfill({ response: resp, body: instrument(await resp.text()) });
  });
  await page.goto(`${base}/${pageName}`);
  await page.waitForFunction(() => {
    const v = globalThis.__pfViewer;
    if (!v) return false;
    const ms = Object.values(v._subMeshes ?? {});
    return ms.length && ms.every((m) => m.geometry.getAttribute("position")?.count);
  }, null, { timeout: 180000 });
  await page.waitForTimeout(3000);
  const tri = await page.evaluate(() => {
    let t = 0, labeled = 0;
    for (const m of Object.values(globalThis.__pfViewer._subMeshes)) {
      if (!m.visible) continue;
      const idx = m.geometry.getIndex();
      t += (idx ? idx.count : m.geometry.getAttribute("position").count) / 3;
      labeled += (m.geometry.userData.features ?? []).length;
    }
    return { triangles: t, subParts: Object.keys(globalThis.__pfViewer._subMeshes).length, featureLabels: labeled };
  });
  await page.click("#measure");
  await page.waitForTimeout(800);
  // on-part sample points: probe a grid with the SAME raycastViewer (a direct
  // call — not wrapped, so not recorded), keep the points that hit
  const probe = await page.evaluate(async () => {
    const { raycastViewer } = await import("/src/framework/selection/raycast.js");
    const v = globalThis.__pfViewer;
    const r = v.domElement.getBoundingClientRect();
    const on = [];
    const keys = new Set();
    for (let gy = 0.05; gy <= 0.95; gy += 0.03) for (let gx = 0.05; gx <= 0.95; gx += 0.03) {
      const x = r.left + gx * r.width, y = r.top + gy * r.height;
      const hit = raycastViewer(v, x, y);
      if (hit) { on.push([x, y]); keys.add(`${hit.subPart}:${hit.feature?.id ?? "-"}`); }
    }
    return { on, distinctTargets: keys.size };
  });
  const pts = probe.on;
  if (!pts.length) throw new Error("no on-part points");
  const raf = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => { globalThis.__pfT.recs = { hover: [], click: [] }; });
  for (let i = 0; i < MOVES; i++) {
    const [x, y] = pts[(i * 7919) % pts.length];
    await page.mouse.move(x, y);
    await raf();
  }
  const hover = await page.evaluate(() => globalThis.__pfT.recs.hover);
  await page.evaluate(() => { globalThis.__pfT.recs = { hover: [], click: [] }; });
  for (let i = 0; i < CLICKS; i++) {
    const [x, y] = pts[(i * 104729) % pts.length];
    await page.mouse.move(x, y);
    await raf();
    await page.mouse.click(x, y); // pin
    await raf();
    await page.mouse.click(x, y); // unpin, so pins never pile up across samples
    await raf();
  }
  const click = await page.evaluate(() => globalThis.__pfT.recs.click);
  const hits = (rs) => rs.filter((r) => r.hit === true);
  const cold = (rs) => rs.filter((r) => r.hit === true && r.placeDims > 0);
  console.log(JSON.stringify({
    page: pageName, ...tri, onPartPoints: pts.length, distinctTargets: probe.distinctTargets,
    hover: { onPart: summarize(hits(hover)), placedThisFrame: summarize(cold(hover)) },
    click: { onPart: summarize(hits(click)), placedThisFrame: summarize(cold(click)) },
  }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
```

## Task 8: the two-click mode

### Method

The same as Task 1 (M1 Max, headless Chromium with SwiftShader, 1400 × 900,
`vite`, `measure-mode.js` rewritten in flight; nothing in `src/` changed for
the timing). The script changed only where the mode did: hover is now
`raycastViewer` → `snapIndex` → `findSnap` → the marker (no `placeDims`), and a
click is a state change that places at most one item, so the click loop no
longer pins and unpins. Each part is loaded **three times** in a fresh page:
the first on-part hover and the first click of each load are the **cold**
samples (the first hover goes to a labelled feature when the part has one);
every later sample is **warm** (300 moves, 60 clicks per load). After the
mode is turned on, the script waits 1.5 s before the first hover, the time a
user takes to reach the part. `setEnabled(true)` and each idle pre-build step
are timed too. A second script (appendix B) records the main thread's long
tasks (> 50 ms) in the 2.5 s after the Measure button is clicked.

### Results (ms)

"Before" is the new mode at `b6b3c85c`, before Task 8's fix. "After" is the
shipped fix: idle pre-build, and a BVH only for a geometry of 100,000
triangles or more (`BVH_MIN_TRIANGLES`), so the propeller (52.8k) keeps
three's ray and the screw (210.6k) gets a BVH. "Task 1" is the old mode, for
comparison. The first version of the fix also gave the propeller a BVH; its
numbers are in "First version" below.

| Part | Event | Task 1 (old mode) | Before fix | After fix |
| --- | --- | --- | --- | --- |
| propeller (52.8k) | cold hover (3 loads) | 97.1 | 44.5 / 48.1 / 44.8 (max over any first touch: 64.8) | **4.0 / 4.0 / 4.3** |
| propeller (52.8k) | warm hover, median / p95 | 3.0 / 3.6 | 3.3 / 3.7 | **3.2 / 3.5** (max 6.1) |
| propeller (52.8k) | cold click (3 loads) | 37.4 (placed) | 7.7 / 5.0 / 4.6 | **4.5 / 4.9 / 6.0** |
| propeller (52.8k) | warm click, median / p95 | 3.2 / 20.5 | 3.5 / 3.8 | **3.4 / 3.8** |
| screw (210.6k) | cold hover (3 loads) | — | 17.5 / 17.4 / 17.5 | **1.1 / 0.7 / 1.1** |
| screw (210.6k) | warm hover, median / p95 | 10.5 / 11.1 | 10.5 / 11.0 | **0.2 / 0.3** |
| screw (210.6k) | cold click (3 loads) | 75.8 (placed) | 10.4 / 10.7 / 10.7 | **0.2 / 0.3 / 0.3** |
| screw (210.6k) | warm click, median / p95 | 10.8 / 11.2 | 10.8 / 11.4 | **0.4 / 0.7** |
| screw (210.6k) | **worst case: a hover that lands while the BVH build runs** | — | — | **waits up to 308–328 ms**, once per geometry, ~0.1–0.5 s after entry |
| both | a hover before the snap index step runs (first ~0.1 s) | — | — | the before-fix cold cost, once |

The "after" cold rows are measured 1.5 s after the mode turns on, so the
pre-build has finished. The two last rows are the honest worst first hover.

**First version** (BVH for every geometry, `2549d948`), propeller: cold hover
1.3 / 2.2 / 1.4, warm hover 0.3 / 0.5, cold click 2.3 / 1.8 / 1.8, warm click
0.6 / 0.9, for an 84 ms BVH task after entry. The ~3 ms a move it saved did
not justify that task below 100k triangles.

Split of the slow samples, before the fix:

| Part | Event | total | raycast | snapIndex (build) | featureSpec (classify) | rest |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| propeller | first hover (hub) | 44.5 | 2.8 | 30.4 | 9.9 | 1.4 |
| propeller | first hover on the blade | 64.8 | 3.1 | 0 | 61.4 | 0.3 |
| screw | first hover | 17.5 | 11.9 | 5.0 | 0 | 0.6 |
| screw | any warm hover or click | 10.5–11 | 10.3 | 0 | 0 | ~0.3 |

What the two-click mode had already fixed: a click places one item, so the
35–75 ms `placeDims` clicks of Task 1 were gone (a click placed in 0.1–0.2 ms).
What it still had: the first hover on a geometry built its snap index and
classified the feature (45–65 ms on the propeller, three or four frames), and
every hover and click cast a brute-force ray (10.3 ms on the screw, over the
8 ms line the plan set).

### What changed

1. **Idle pre-build** (`measure-mode.js`). Entering the mode, and any geometry
   change while it is on, queues work for each visible geometry: its snap
   index, the spec of each named feature, then, from 100,000 triangles up, a
   triangle BVH. The queue runs
   in `requestIdleCallback` (timeout 1 s; a 16 ms timer where the browser has
   none, as Safari by default), at least one step per callback. Turning the
   mode off empties the queue, cancels the callback and releases every BVH;
   a step whose mesh is gone, hidden or shows another geometry is dropped, not
   run. A step that throws is logged and skipped: its cache stays empty, so
   hover computes that piece itself, as before. Every cache is a WeakMap keyed
   by geometry, so a step can only fill its own geometry's entry.
2. **BVH rays** (`selection/raycast.js` `firstSurfaceHit`, used by
   `raycastViewer` when given `bvhFor`, and by the placement's `surfaceHit`).
   The index is `oracle/bvh.js`'s JS `buildBVH`, cached per geometry. Hover
   and click NEVER build one: until the idle step lands, rays take three's
   path, as before. The answer is three's (same culling by material side, same
   "nearest hit the cutaway keeps", a drawn face sharing its t with a culled
   one at a silhouette edge, three's own ray after 256 skipped hits); tests
   check it against three over a grid, including the viewer's `setSubPose`
   pose (`matrixAutoUpdate` off). The selection picker and hover labels do not pass `bvhFor`, so they
   are unchanged.

### Pre-build cost (ms, per step, 3 loads)

| Part | snap index | feature specs | BVH |
| --- | ---: | ---: | ---: |
| propeller | 30.0 / 29.9 / 30.6 | 53–55 (blade), 6–11 (hub), 1 | none (under the floor; 81–89 in the first version) |
| screw | 4.8 / 4.7 / 4.7 | — (no labels) | 309.6 / 308.5 / 308.1 (328.5 in a later run) |

### Mode entry: what moved into it (ms)

Long tasks on the main thread in the 2.5 s after the Measure button is
clicked (appendix B; three runs on the propeller, one on the screw):

| Part | Before fix | After fix |
| --- | --- | --- |
| propeller | 393 | 405, 56 (the blade's spec) |
| screw | 101, 387 | 103, 405, **326** (the BVH) |

`setEnabled(true)` itself: first entry 29–46 ms (propeller) and 84–103 ms
(screw), unchanged; most of the screw's is the overall dims' `surfaceHit`
rays (61 ms), which have no BVH yet. Re-entry (off, then on again) is the
same as before the fix, 18 ms (propeller) and 73 ms (screw), because turning
the mode off releases the BVH; the screw's is rebuilt in idle time again.
(The first version kept it, and re-entry was ~1 ms.)

The ~400 ms task right after the click is there before and after the fix: it
is not the mode's own code (enable is 30–100 ms of it); it was not chased
further here.

The new cost is the BVH step: one **308–328 ms** task on the screw, in idle
time, about 0.1–0.5 s after the mode turns on (and again on each entry). A
pointer move that arrives while it runs waits for it, once per geometry. That
is the trade: one wait of up to a third of a second, in place of 10 ms on
every move for as long as the mode is on. A part under 100k triangles builds
no BVH and pays nothing of this. On a phone the wait could be about 1 s.

**Follow-up: build the BVH in a worker** (or a build that yields), so it never
holds the main thread. `bvh.js` has no constructor from its four typed arrays
today, so that is not done here.

### Memory

The BVH costs about 75 bytes a triangle (16 MB on the screw). It is released
when the mode turns off (the oracle's own rule in `bvh.js`: no index outlives
the pass that needed it), and a regenerate drops the old geometry's. Only
geometries of 100k triangles or more ever hold one. The snap index and
feature specs are small and stay cached by geometry, as before.

### Verdict

Once the pre-build has run, hover and click p95 are 3.5 / 3.8 ms on the
propeller (three's ray) and 0.3 / 0.7 ms on the screw (BVH), and the first
hover is 4.0–4.3 ms and 0.7–1.1 ms: within one 16 ms frame. The exceptions are
the two worst-case rows above: a hover during the screw's BVH build waits up
to ~330 ms once, and a hover in the first ~0.1 s after entry, before the snap
index is built, still pays the old cold cost once.

## Appendix A: the Task 8 timing script

```bash
node measure-timing2.cjs <repo dir> http://localhost:<port> propeller.html 300 60 3
```

```js
// Times the two-click measure mode (Task 8) in headless Chromium against the
// dev server, the same way Task 1's script did: measure-mode.js is rewritten
// in flight (page.route) to add performance.now() timers. Nothing in src/ changes.
// usage: node measure-timing2.cjs <repoDir> <baseUrl> <page.html> [moves] [clicks] [loads]
//
// Records (one per hover callback, per onClick, per setEnabled(true), per idle pre-build):
//   { total, raycast, featureSpec, snapIndex, findSnap, marker, placeDims,
//     surfaceHit, sceneUpdate, hit, specMiss, indexMiss }
// Each load is a fresh page: its FIRST on-part hover and FIRST click are the
// cold samples. Warm samples are every later one.
const { createRequire } = require("module");
const [repo, base, pageName, movesArg, clicksArg, loadsArg] = process.argv.slice(2);
const req = createRequire(repo + "/package.json");
const { chromium } = req("playwright");
const MOVES = Number(movesArg ?? 300), CLICKS = Number(clicksArg ?? 60), LOADS = Number(loadsArg ?? 3);

const PRELUDE = `
const __pfT = (globalThis.__pfT ??= { recs: { hover: [], click: [], enable: [], prebuild: [] }, cur: null });
function __t(name, fn) {
  const t0 = performance.now();
  try { return fn(); } finally {
    const c = __pfT.cur; if (c) c[name] = (c[name] ?? 0) + performance.now() - t0;
  }
}
function __flag(name) { if (__pfT.cur) __pfT.cur[name] = 1; }
function __rec(kind, fn) {
  const outer = __pfT.cur;
  const rec = { hit: null };
  __pfT.cur = rec;
  const t0 = performance.now();
  try { return fn(); } finally {
    rec.total = performance.now() - t0;
    __pfT.cur = outer;
    __pfT.recs[kind].push(rec);
  }
}
`;

function instrument(src) {
  const rep = (a, b, optional = false) => {
    if (!src.includes(a)) { if (optional) return; throw new Error("anchor missing: " + a.slice(0, 60)); }
    src = src.replace(a, b);
  };
  const repAny = (...pairs) => {
    const pair = pairs.find(([a]) => src.includes(a));
    if (!pair) throw new Error("anchor missing: " + pairs[0][0].slice(0, 60));
    src = src.replace(pair[0], pair[1]);
  };
  src = PRELUDE + src;
  const bodyStart = src.indexOf(") {", src.indexOf("export function createMeasureMode")) + 3;
  src = src.slice(0, bodyStart)
    + `\n  globalThis.__pfViewer = viewer;\n  schedule = ((orig) => (cb) => orig(() => __rec("hover", cb)))(schedule);\n`
    + src.slice(bodyStart);
  // before Task 8 / after it (the spec cache is keyed by geometry since)
  repAny([`function featureSpec(mesh, featureId) {`,
    `function featureSpec(mesh, featureId) { return __t("featureSpec", () => __featureSpec(mesh, featureId)); }\n  function __featureSpec(mesh, featureId) {`],
  [`function featureSpec(geometry, featureId) {`,
    `function featureSpec(geometry, featureId) { return __t("featureSpec", () => __featureSpec(geometry, featureId)); }\n  function __featureSpec(geometry, featureId) {`]);
  rep(`if (!byId.has(featureId)) {`, `if (!byId.has(featureId)) { __flag("specMiss");`);
  rep(`function snapIndex(geometry) {`,
    `function snapIndex(geometry) { return __t("snapIndex", () => __snapIndex(geometry)); }\n  function __snapIndex(geometry) {`);
  rep(`if (!index) {`, `if (!index) { __flag("indexMiss");`);
  repAny([`const hit = raycastViewer(viewer, x, y);`,
    `const hit = __t("raycast", () => raycastViewer(viewer, x, y)); if (__pfT.cur) __pfT.cur.hit = !!hit;`],
  [`const hit = raycastViewer(viewer, x, y, { bvhFor: builtBVH });`,
    `const hit = __t("raycast", () => raycastViewer(viewer, x, y, { bvhFor: builtBVH })); if (__pfT.cur) __pfT.cur.hit = !!hit;`]);
  rep(`const target = findSnap(snapIndex(mesh.geometry), {`,
    `const __si = snapIndex(mesh.geometry); const target = __t("findSnap", () => findSnap(__si, {`);
  rep(`snapPx: SNAP_PX,\n    });`, `snapPx: SNAP_PX,\n    }));`);
  rep(`marker.show(snap.target, snap.mesh, snapText(snap));`,
    `__t("marker", () => marker.show(snap.target, snap.mesh, snapText(snap)));`);
  rep(`placeDims(list, { meshData: env.meshData, surfaceHit: env.surfaceHit, bounds, suppress, lanes, units }, choices);`,
    `__t("placeDims", () => placeDims(list, { meshData: env.meshData, surfaceHit: env.surfaceHit, bounds, suppress, lanes, units }, choices));`);
  repAny([`const hit = _rc.intersectObjects(hittable, false)[0];`,
    `const hit = __t("surfaceHit", () => _rc.intersectObjects(hittable, false)[0]);`],
  [`const hit = firstSurfaceHit(_rc.ray, hittable, { bvhFor: builtBVH });`,
    `const hit = __t("surfaceHit", () => firstSurfaceHit(_rc.ray, hittable, { bvhFor: builtBVH }));`]);
  rep(`if (painted !== drawings) { painted = drawings; scene.update(drawings); }`,
    `if (painted !== drawings) { painted = drawings; __t("sceneUpdate", () => scene.update(drawings)); }`);
  rep(`function onClick(ev) {`, `function onClick(ev) { return __rec("click", () => __onClick(ev)); }\n  function __onClick(ev) {`);
  rep(`function setEnabled(on) {`,
    `function setEnabled(on) { return on && !enabled ? __rec("enable", () => __setEnabled(on)) : __setEnabled(on); }\n  function __setEnabled(on) {`);
  // Task 8's idle pre-build, when present
  rep(`if (isLive(step)) step.run();`, `if (isLive(step)) __rec("prebuild", () => { __pfT.cur.what = step.what + " " + step.mesh.name; step.run(); });`, true);
  rep(`try { step.run(); }`, `try { __rec("prebuild", () => { __pfT.cur.what = step.what + " " + step.mesh.name; step.run(); }); }`, true);
  return src;
}

const KEYS = ["total", "raycast", "featureSpec", "snapIndex", "findSnap", "marker", "placeDims", "surfaceHit", "sceneUpdate"];
const q = (s, p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
function summarize(recs) {
  if (!recs.length) return { n: 0 };
  const out = { n: recs.length };
  for (const k of KEYS) {
    const s = recs.map((r) => r[k] ?? 0).sort((a, b) => a - b);
    if (s[s.length - 1] === 0) continue;
    out[k] = { median: +q(s, 0.5).toFixed(2), p95: +q(s, 0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
  }
  return out;
}
const round = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(2) : v]));

async function oneLoad(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.route("**/src/framework/measure/measure-mode.js*", async (route) => {
    const resp = await route.fetch();
    await route.fulfill({ response: resp, body: instrument(await resp.text()) });
  });
  await page.goto(`${base}/${pageName}`);
  await page.waitForFunction(() => {
    const v = globalThis.__pfViewer;
    if (!v) return false;
    const ms = Object.values(v._subMeshes ?? {});
    return ms.length && ms.every((m) => m.geometry.getAttribute("position")?.count);
  }, null, { timeout: 180000 });
  await page.waitForTimeout(3000);
  const tri = await page.evaluate(() => {
    let t = 0, labeled = 0;
    for (const m of Object.values(globalThis.__pfViewer._subMeshes)) {
      if (!m.visible) continue;
      const idx = m.geometry.getIndex();
      t += (idx ? idx.count : m.geometry.getAttribute("position").count) / 3;
      labeled += (m.geometry.userData.features ?? []).length;
    }
    return { triangles: t, featureLabels: labeled };
  });
  // on-part points, probed BEFORE the mode is on (a direct raycastViewer call is not recorded)
  const pts = await page.evaluate(async () => {
    const { raycastViewer } = await import("/src/framework/selection/raycast.js");
    const v = globalThis.__pfViewer;
    const r = v.domElement.getBoundingClientRect();
    const on = [];
    for (let gy = 0.05; gy <= 0.95; gy += 0.03) for (let gx = 0.05; gx <= 0.95; gx += 0.03) {
      const x = r.left + gx * r.width, y = r.top + gy * r.height;
      const hit = raycastViewer(v, x, y);
      // labelled-feature points first, so the first hover is a feature's cold path
      if (hit) on.push([x, y, hit.feature?.id > 0 ? 1 : 0]);
    }
    return on.sort((a, b) => b[2] - a[2]);
  });
  if (!pts.length) throw new Error("no on-part points");
  const raf = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.click("#measure");
  // an idle pre-build (Task 8) runs here; give it the time a user takes to reach the part
  await page.waitForTimeout(Number(process.env.WAIT_MS ?? 1500));
  await page.mouse.move(5, 5); // off the canvas
  await raf();
  const enable = await page.evaluate(() => globalThis.__pfT.recs.enable);
  const prebuild = await page.evaluate(() => globalThis.__pfT.recs.prebuild);
  await page.evaluate(() => { globalThis.__pfT.recs.hover = []; globalThis.__pfT.recs.click = []; });
  for (let i = 0; i < MOVES; i++) {
    const [x, y] = i === 0 ? pts[0] : pts[(i * 7919) % pts.length];
    await page.mouse.move(x, y);
    await raf();
  }
  const hover = await page.evaluate(() => globalThis.__pfT.recs.hover);
  await page.evaluate(() => { globalThis.__pfT.recs.click = []; globalThis.__pfT.recs.hover = []; });
  for (let i = 0; i < CLICKS; i++) {
    const [x, y] = pts[(i * 104729) % pts.length];
    await page.mouse.move(x, y);
    await raf();
    await page.mouse.click(x, y);
    await raf();
  }
  const click = await page.evaluate(() => globalThis.__pfT.recs.click);
  await page.close();
  return { tri, enable, prebuild, hover: hover.filter((r) => r.hit === true), click: click.filter((r) => r.hit === true) };
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const loads = [];
  for (let l = 0; l < LOADS; l++) loads.push(await oneLoad(browser));
  const coldHover = loads.map((L) => L.hover[0]).filter(Boolean);
  const coldClick = loads.map((L) => L.click[0]).filter(Boolean);
  const warmHover = loads.flatMap((L) => L.hover.slice(1));
  const warmClick = loads.flatMap((L) => L.click.slice(1));
  const missHover = loads.flatMap((L) => L.hover.filter((r) => r.specMiss || r.indexMiss));
  console.log(JSON.stringify({
    page: pageName, ...loads[0].tri, loads: LOADS,
    enable: loads.flatMap((L) => L.enable).map(round),
    prebuild: loads.flatMap((L) => L.prebuild).map(round),
    coldHover: coldHover.map(round),
    coldClick: coldClick.map(round),
    anyMissHover: summarize(missHover),
    warmHover: summarize(warmHover),
    warmClick: summarize(warmClick),
    allClickPlaced: summarize(loads.flatMap((L) => L.click).filter((r) => r.placeDims > 0)),
  }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
```

## Appendix B: the mode-entry script

```bash
node entry.cjs <repo dir> http://localhost:<port> screw.html
```

```js
// Mode entry: long tasks (>50 ms) on the main thread in the 2.5 s after the
// measure button is clicked, and the enable time on first entry and re-entry.
const { createRequire } = require("module");
const [repo, base, pageName] = process.argv.slice(2);
const { chromium } = createRequire(repo + "/package.json")("playwright");
(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.route("**/src/framework/measure/measure-mode.js*", async (route) => {
    const resp = await route.fetch(); let t = await resp.text();
    const i = t.indexOf(") {", t.indexOf("export function createMeasureMode")) + 3;
    t = t.slice(0, i) + "\n globalThis.__pfViewer = viewer;\n" + t.slice(i);
    t = t.replace("function setEnabled(on) {", "function setEnabled(on) { const __t0 = performance.now(); try { return __setEnabled(on); } finally { if (on) (globalThis.__en ??= []).push(+(performance.now() - __t0).toFixed(1)); } }\n  function __setEnabled(on) {");
    await route.fulfill({ response: resp, body: t });
  });
  await page.goto(`${base}/${pageName}`);
  await page.waitForFunction(() => { const v = globalThis.__pfViewer; const ms = Object.values(v?._subMeshes ?? {}); return ms.length && ms.every((m) => m.geometry.getAttribute("position")?.count); }, null, { timeout: 180000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    globalThis.__lt = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) globalThis.__lt.push(+e.duration.toFixed(0)); }).observe({ type: "longtask" });
  });
  await page.click("#measure");
  await page.waitForTimeout(2500);
  const longtasks = await page.evaluate(() => globalThis.__lt);
  await page.click("#measure"); await page.waitForTimeout(300);
  await page.click("#measure"); await page.waitForTimeout(300);
  const enables = await page.evaluate(() => globalThis.__en);
  console.log(JSON.stringify({ page: pageName, longtasksAfterEntry: longtasks, enableFirstThenReentry: enables }));
  await browser.close();
})();
```
