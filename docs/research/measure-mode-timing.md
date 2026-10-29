# Measure mode timing (before the redesign)

Task 1 of the measure mode redesign. These numbers are today's mode, measured
before any measure code changed. They decide Task 8 (the speed fix).

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

## Appendix: the timing script

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
