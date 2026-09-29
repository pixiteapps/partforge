# Sheet-part inspect timing

What sheet parts cost the inspect job — the report a partforge-cloud apply waits on —
for four stress cases: `src/parts/laser-box.js` (six panels, two printed hinges),
`test/fixtures/sheet-twelve-panel-part.js` (twelve finger-jointed panels),
`test/fixtures/sheet-screw-plate-part.js` (a plate with sixteen booleaned M3 holes)
and `test/fixtures/sheet-perforated-panel-part.js` (a grille of 900 perforations)
(sheet parts spec C.6). partforge-cloud gives the whole report ONE 8 s budget; the
2-D sheet checks have their own, `SHEET_CHECK_BUDGET_MS` = 1500 ms per `measure()`
call, charged for 2-D work alone. A sheet that runs past it, or whose profile is
plainly too complex to read within it (the laser descriptor's cost pre-gate, below),
reads `evaluated: false` — one `sheetChecks` warning, never a lost report. "Cold" is
the first inspect of that lap type in the bench's shared worker (only the first row
also pays the lazy oracle load); "warm" is the median of the runs after it. The 2-D
column is every sheet's facts computed with no deadline — and so with no pre-gate.

**Residual (contract §7.2):** `verify()` measures once per case, so a forge that
declares presets spends up to one 2-D budget per case inside cloud's single 8 s
report. The stress fixtures here declare none.

The Chromium numbers come from partforge's own module-worker bench, which runs the
same `jobs.js` inspect code partforge-cloud's worker runs; cloud cannot pin 0.133.0
(sheet parts ship to cloud with the kit, 0.134.0), so a cloud-worker re-measure
belongs to C1.

Re-run: `node scripts/time-sheet-inspect.mjs` (Node) and
`node scripts/time-sheet-inspect.mjs --browser` (headless Chromium). The iPhone
block is taken by hand: `npx vite --host --port 5195`, then open
`http://<the Mac's LAN address>:5195/scripts/bench/sheet-inspect.html` on the phone
and copy what it prints.

**Ship gate for 0.133.0:** in the Node and Chromium blocks, the laser-box,
twelve-panel and screw-plate rows read all sheets evaluated (`n/n`), the perforated
row reads `0/1` (withheld by the pre-gate, by design), and every warm full lap is
under 6000 ms.

## Node

### Node v24.19.0 (darwin arm64) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 311 | 103 | 58 | 6/6 |
| laser-box | full | 156 | 130 | 58 | 6/6 |
| twelve-panel | quick | 335 | 255 | 267 | 12/12 |
| twelve-panel | full | 304 | 336 | 267 | 12/12 |
| screw-plate | quick | 132 | 78 | 50 | 1/1 |
| screw-plate | full | 76 | 74 | 50 | 1/1 |
| perforated | quick | 1402 | 491 | 107475 | 0/1 |
| perforated | full | 434 | 439 | 107475 | 0/1 |

## Chromium

### Chromium 149.0.7827.55 (headless, module worker) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 283 | 99 | n/a | 6/6 |
| laser-box | full | 148 | 125 | n/a | 6/6 |
| twelve-panel | quick | 291 | 238 | n/a | 12/12 |
| twelve-panel | full | 281 | 276 | n/a | 12/12 |
| screw-plate | quick | 125 | 81 | n/a | 1/1 |
| screw-plate | full | 76 | 72 | n/a | 1/1 |
| perforated | quick | 1217 | 446 | n/a | 0/1 |
| perforated | full | 387 | 374 | n/a | 0/1 |

## iPhone (Safari)

Scott measures this by hand before the PR merges (spec launch gate 5).

## What a profile costs

The measurements behind the laser descriptor's cost pre-gate
(`src/framework/process/laser/descriptor.js`, `checkCost`): one sheet's 2-D facts in
Node v24.19.0 (darwin arm64), 3 mm stock (so the width search's ceiling is 3 mm),
no deadline. "One test" is a single uninterruptible shrink-and-regrow at the
ceiling — the unit the deadline, checked between tests, cannot bound. "Units" is
the pre-gate's estimate; above 1,500 (the budget) a profile is not started under
a deadline.

| profile | segments | one test | all readings | units | under the budget |
|---|---|---|---|---|---|
| 256 square holes | 1,028 lines | 0.6 s | 2.5 s | 1,028 | read until the budget runs out |
| 400 perforations, d 3 at a 5 mm pitch | 800 arcs | 2.5 s | 21.8 s | 1,604 | not started |
| 16 booleaned d 6 holes, nothing narrow | 64 cubics | 0.06 s | 0.07 s | 772 | read |
| 96 booleaned d 6 holes, nothing narrow | 384 cubics | 0.3 s | 0.8 s | 4,612 | not started (a web beside them would cost a boolean per test: 32 holes and one web, 15.7 s) |
| 16 rounded-rect cutouts, r 2.5 | 64 cubics | 4.7 s | 7.0 s | 2,628 | not started |
| 4 rounded-rect cutouts, r 1.2 | 16 cubics | 3.2 s | 3.5 s | 1,620 | not started |
| 3 rounded-rect cutouts, r 1.2 | 12 cubics | 1.9 s | 2.1 s | 1,216 | read (overruns by one test) |
| 16 booleaned d 2.7 holes | 64 cubics | < 0.01 s | 0.05 s | 772 | read |

Before this fix wave the last row's shape was the engine's worst: a booleaned round
hole shrinks to a near-point circle of cubics that the offset engine cannot cheaply
regrow — one M2.5 hole took 4.5 s and four took 47 s, a single d 3.5 hole 4.3 s for
one test. Round holes are now read directly (their narrowest opening is their
diameter) and kept out of the width search, and the offset engine drops a hole a
sharp dilation fully erodes (`contour-offset.js`).

