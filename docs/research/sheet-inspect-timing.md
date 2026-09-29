# Sheet-part inspect timing

What sheet parts cost the inspect job — the report a partforge-cloud apply waits on —
for five stress cases: `src/parts/laser-box.js` (six panels, two printed hinges),
`test/fixtures/sheet-twelve-panel-part.js` (twelve finger-jointed panels),
`test/fixtures/sheet-screw-plate-part.js` (a plate with sixteen booleaned M3 holes),
`test/fixtures/sheet-perforated-panel-part.js` (a grille of 900 perforations) and
`test/fixtures/sheet-web-plate-part.js` ("holes-web": thirty booleaned 6 mm holes and
one 1 mm web, which the bridge check must find) (sheet parts spec C.6).
partforge-cloud gives the whole report ONE 8 s budget; the 2-D sheet checks have
their own, `SHEET_CHECK_BUDGET_MS` = 1500 ms per `measure()` call, charged for 2-D
work alone. The laser descriptor prices every step before it starts and starts none
whose price will not fit what is left (below); a sheet it stops reads
`evaluated: false` — one `sheetChecks` warning, never a lost report. "Cold" is the
first inspect of that lap type in the bench's shared worker (only the first row also
pays the lazy oracle load); "warm" is the median of the runs after it. The 2-D column
is every sheet's facts computed with no deadline — and so with nothing priced out.

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
twelve-panel, screw-plate and holes-web rows read all sheets evaluated (`n/n`), the
perforated row reads `0/1` (priced out before its first test, by design), and every
warm full lap is under 6000 ms.

## Node

### Node v24.19.0 (darwin arm64) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 336 | 109 | 61 | 6/6 |
| laser-box | full | 182 | 141 | 61 | 6/6 |
| twelve-panel | quick | 351 | 262 | 241 | 12/12 |
| twelve-panel | full | 314 | 324 | 241 | 12/12 |
| screw-plate | quick | 58 | 37 | 10 | 1/1 |
| screw-plate | full | 36 | 37 | 10 | 1/1 |
| perforated | quick | 1560 | 551 | 148914 | 0/1 |
| perforated | full | 581 | 552 | 148914 | 0/1 |
| holes-web | quick | 246 | 173 | 56 | 1/1 |
| holes-web | full | 147 | 163 | 56 | 1/1 |

Both this block and the Chromium one were taken while the machine was under heavy load
from other work (1-minute load average 14–119 on 10 cores); the rows are upper bounds.

## Chromium

### Chromium 149.0.7827.55 (headless, module worker) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 340 | 107 | n/a | 6/6 |
| laser-box | full | 246 | 131 | n/a | 6/6 |
| twelve-panel | quick | 311 | 275 | n/a | 12/12 |
| twelve-panel | full | 372 | 345 | n/a | 12/12 |
| screw-plate | quick | 72 | 40 | n/a | 1/1 |
| screw-plate | full | 40 | 39 | n/a | 1/1 |
| perforated | quick | 1515 | 501 | n/a | 0/1 |
| perforated | full | 465 | 467 | n/a | 0/1 |
| holes-web | quick | 157 | 118 | n/a | 1/1 |
| holes-web | full | 110 | 111 | n/a | 1/1 |

## iPhone (Safari)

Scott measures this by hand before the PR merges (spec launch gate 5).

## What a profile costs

The measurements behind the laser descriptor's prices
(`src/framework/process/laser/descriptor.js`, "what a step costs"). Nothing interrupts
a step once started — the deadline is checked between steps — so under a deadline every
step is priced before it starts and not started when its price, scaled by the pace this
device has measured on the steps it already took, will not fit what is left. The steps
are one test (a sharp shrink-and-regrow and an area) and the one-sided difference a test
that found something then runs, priced from that test's own result. Before any of it,
each width search leaves out the holes it cannot involve (`holePlan`): the closing, round
holes (read directly) and convex holes wider than the ceiling; the opening, convex holes
that clear every other ring by twice the ceiling (1.5 times for a round one).

Prices are in units of about one desktop-Node millisecond, fitted to CPU time in Node
v24.19.0 (darwin arm64) on 3 mm stock (search ceiling 3 mm), each step timed alone:

| step | price | calibration (CPU) |
|---|---|---|
| test, per line | 1.2 | 256 square holes (1,028 lines), holes merging: 1.1 s |
| test, per arc | 2.5 | 256 perforations d 3 at a 5 mm pitch (512 arcs), webs merging: 1.1 s; with nothing merging, 0.02 s |
| test, per cubic | 3 | 256 rounded-rect cutouts (1,024 cubics, 1,028 lines), merging: 4.7–5.2 s; 256 booleaned holes, nothing merging: 1.5–1.9 s |
| test, cubics the first offset shrinks to within 2.5·w/2 (convex in an opening, concave in a closing) | +12 × (their count)² | the offset engine's worst case — the cubic offset subdivides toward its depth limit and the winding resolver pays for every piece, superlinearly: rounded-rect hole corners r 1.2 closed at 3 mm, 16 of them 3.5 s, 64 50 s, 256 804 s; r 2.5 (not inverting), 64 4.7 s, 256 73 s; a comb's r 2.5 inner corners, 32 1.8 s, 64 29 s |
| test, cubics grown first and shrunk back to within 1.5·w/2 | +10 each | 128 filleted tab corners closed at 1.5 mm: 1.2 s |
| difference, per line of both shapes | 0.25 | 1,028 + 1,036 lines: 0.45 s |
| difference, per arc of both shapes | 0.5 | 512 + 512 arcs: 0.44 s |
| difference, per cubic of both shapes, + 0.0005 × (all cubics)² | 0.4 | the offset engine returns a booleaned hole's 4 cubics as 16–32, and paper's boolean on that near-copy is quadratic: 1,024 result cubics 0.7 s, 2,048 2.0 s, 4,096 7.4–8.5 s |

What that buys, measured on the reviewers' stress cases: one sheet's facts under the
1,500 ms deadline, real time, at 3efdb6d9 (the cost pre-gate) and after this change,
side by side on the same loaded machine:

| profile | before | after |
|---|---|---|
| 100 perforations, d 3 at a 5 mm pitch | 1,571 ms, not evaluated | 1,003 ms, not evaluated |
| 196 perforations | 2,633 ms, not evaluated | 661 ms, not evaluated |
| 289 perforations | 2,202 ms, not evaluated | 1,356 ms, not evaluated |
| 324 perforations | 2,643 ms, not evaluated | 8 ms, not started |
| 24 booleaned d 6 holes + one 1 mm web | 4,178 ms, not evaluated | 17 ms, web read (1.03) |
| 30 booleaned d 6 holes + one 1 mm web (holes-web) | 6,399 ms, not evaluated (one 5.5 s boolean) | 13 ms, web read (1.03) |
| 3 rounded-rect cutouts r 1.2 + one 1 mm web | 2,238 ms, web read | 324 ms, web read |
| 4 corner M3 holes 5 mm in + one 1 mm web | 565 ms, web read | 550 ms, web read |
| 12 d 6 holes 3.5 mm from an edge + one 1 mm web | 1,749 ms, not evaluated | 41 ms, not evaluated (the difference priced out) |
| 30 such holes + one 1 mm web | 6,240 ms, not evaluated | 99 ms, not evaluated (the difference priced out) |

The last two rows are the class the prices withhold rather than read: holes within an
opening's reach of an edge or of each other stay in the opening, and a test that finds
the web would then run the difference against their exploded near-copy (3 s and 13 s
with no deadline). Replacing a booleaned round hole's four cubics by the exact circle
they approximate, inside the search only, would make that difference cheap — a
follow-up, not done here.

Earlier in this branch a booleaned round hole was the engine's worst shape outright: it
shrinks to a near-point circle of cubics the offset engine could not cheaply regrow — one
M2.5 hole took 4.5 s and four took 47 s. Round holes are read directly (their narrowest
opening is their diameter), the offset engine drops a hole a sharp dilation fully erodes
while every join on it takes the miter (`contour-offset.js`), and the width searches
leave out the holes they cannot involve.
