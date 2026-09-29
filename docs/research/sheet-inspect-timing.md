# Sheet-part inspect timing

What sheet parts cost the inspect job — the report a partforge-cloud apply waits on —
for the two stress cases, `src/parts/laser-box.js` (six panels, two printed hinges)
and `test/fixtures/sheet-twelve-panel-part.js` (twelve finger-jointed panels)
(sheet parts spec C.6). partforge-cloud gives the whole report ONE 8 s budget; the
2-D sheet checks have their own, `SHEET_CHECK_BUDGET_MS` = 1500 ms per `measure()`
call, and a sheet that runs past it reads `evaluated: false` (one `sheetChecks`
warning, never a lost report). "Cold" is the first inspect after the worker is
pointed at the part — it pays the lazy oracle load once; "warm" is the median of
the runs after it. The 2-D column is every sheet's facts computed with no deadline.

The Chromium numbers come from partforge's own module-worker bench, which runs the
same `jobs.js` inspect code partforge-cloud's worker runs; cloud cannot pin 0.133.0
(sheet parts ship to cloud with the kit, 0.134.0), so a cloud-worker re-measure
belongs to C1.

Re-run: `node scripts/time-sheet-inspect.mjs` (Node) and
`node scripts/time-sheet-inspect.mjs --browser` (headless Chromium). The iPhone
block is taken by hand: `npx vite --host --port 5195`, then open
`http://<the Mac's LAN address>:5195/scripts/bench/sheet-inspect.html` on the phone
and copy what it prints.

**Ship gate for 0.133.0:** in the Node and Chromium blocks, every row reads all
sheets evaluated (`n/n`) and every warm full lap is under 6000 ms.

## Node

### Node v24.19.0 (darwin arm64) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 323 | 104 | 59 | 6/6 |
| laser-box | full | 165 | 133 | 59 | 6/6 |
| twelve-panel | quick | 335 | 252 | 233 | 12/12 |
| twelve-panel | full | 303 | 303 | 233 | 12/12 |

## Chromium

### Chromium 149.0.7827.55 (headless, module worker) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 300 | 97 | n/a | 6/6 |
| laser-box | full | 143 | 129 | n/a | 6/6 |
| twelve-panel | quick | 291 | 234 | n/a | 12/12 |
| twelve-panel | full | 277 | 277 | n/a | 12/12 |

## iPhone (Safari)

Scott measures this by hand before the PR merges (spec launch gate 5).
