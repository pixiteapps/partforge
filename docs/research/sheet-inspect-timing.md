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
| laser-box | quick | 411 | 188 | 135 | 6/6 |
| laser-box | full | 240 | 208 | 135 | 6/6 |
| twelve-panel | quick | 725 | 651 | 624 | 12/12 |
| twelve-panel | full | 702 | 701 | 624 | 12/12 |
| screw-plate | quick | 55 | 37 | 10 | 1/1 |
| screw-plate | full | 36 | 35 | 10 | 1/1 |
| perforated | quick | 1407 | 489 | 14512 | 0/1 |
| perforated | full | 479 | 468 | 14512 | 0/1 |
| holes-web | quick | 150 | 117 | 42 | 1/1 |
| holes-web | full | 114 | 114 | 42 | 1/1 |

Both this block and the Chromium one were taken while the machine carried other work
(1-minute load average 29–44 on 10 cores). Every test now runs its one-sided
difference (below), which on these line-only panels doubles the 2-D work or more: in
CPU time, back to back, laser-box 83 → 173 ms and twelve-panel 266 → 690 ms for all
twelve sheets. The perforated grille's uncapped column fell because its bridge reading
now ends at the ceiling: paper refuses that difference (a read error, below).

## Chromium

### Chromium 149.0.7827.55 (headless, module worker) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 381 | 173 | n/a | 6/6 |
| laser-box | full | 216 | 193 | n/a | 6/6 |
| twelve-panel | quick | 630 | 579 | n/a | 12/12 |
| twelve-panel | full | 633 | 619 | n/a | 12/12 |
| screw-plate | quick | 53 | 34 | n/a | 1/1 |
| screw-plate | full | 33 | 33 | n/a | 1/1 |
| perforated | quick | 1214 | 468 | n/a | 0/1 |
| perforated | full | 482 | 369 | n/a | 0/1 |
| holes-web | quick | 136 | 110 | n/a | 1/1 |
| holes-web | full | 106 | 105 | n/a | 1/1 |

## iPhone (Safari)

Scott measures this by hand before the PR merges (spec launch gate 5).

## What a profile costs

The measurements behind the laser descriptor's prices
(`src/framework/process/laser/descriptor.js`, "what a step costs"). Nothing interrupts
a step once started — the deadline is checked between steps — so under a deadline every
step is priced before it starts and not started when its price, scaled by the pace this
device has measured on the steps it already took, will not fit what is left. The steps
are one test (a sharp shrink and regrow) and the one-sided difference every test then
runs, priced from that test's own result. No test skips its difference on a net area
change: the square corners a chamfer or fillet elsewhere regrows can cancel a real web's
loss to zero, so a skip read "nothing narrower" over a sub-floor bridge. Before any of it,
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
| test, cubics the first offset shrinks to under 1.85·w/2 (convex in an opening, concave in a closing) | +16 × (their count)² | the offset engine's worst case — the cubic offset subdivides toward its depth limit and the winding resolver pays for every piece, superlinearly: rounded tab corners opened at 3 mm, r 2–2.25, 12 of them 1.9–2.3 s, 20 4.7–5.4 s (up to 15.6 × count²); rounded-rect hole corners r 1.2 closed at 3 mm, 16 3.5 s, 64 50 s, 256 804 s; a comb's r 2.5 inner corners, 32 1.8 s, 64 29 s. The edge of the band is sharp: tab corners at 1.8·w/2, 12 176 ms and 20 440 ms; at 1.87·w/2, 16 ms — at 1.5, 3 and 6 mm stock alike (a comb's closing: 225 ms at 1.8, 14 ms at 1.87) |
| test, cubics grown first and shrunk back to within 1.5·w/2 | +10 each | 128 filleted tab corners closed at 1.5 mm: 1.2 s |
| difference, per line of both shapes | 0.25 | 1,028 + 1,036 lines: 0.45 s |
| difference, per arc of both shapes | 0.5 | 512 + 512 arcs: 0.44 s |
| difference, per cubic of both shapes, + 0.0005 × (all cubics)² | 0.4 | a test hands back every cubic as 32, and paper's boolean on that near-copy is quadratic: booleaned holes, 1,056 cubics in all 0.6 s, 2,112 1.8 s, 4,224 6.4 s, 6,336 17 s; rounded tab corners r 4, 1,716 1.4 s, 3,300 4.3 s (r 3: half that) |

What that buys, measured on the reviewers' stress cases: one sheet's facts under the
1,500 ms deadline, real time, at 3efdb6d9 (the cost pre-gate) and now, with every step
priced and every test running its difference. The before column ran at a 1-minute load
average near 90, the now column near 30:

| profile | before | now |
|---|---|---|
| 100 perforations, d 3 at a 5 mm pitch | 1,571 ms, not evaluated | 1,068 ms, not evaluated |
| 196 perforations | 2,633 ms, not evaluated | 660 ms, not evaluated |
| 289 perforations | 2,202 ms, not evaluated | 1,320 ms, not evaluated |
| 324 perforations | 2,643 ms, not evaluated | 8 ms, not started |
| 24 booleaned d 6 holes + one 1 mm web | 4,178 ms, not evaluated | 24 ms, web read (1.03) |
| 30 booleaned d 6 holes + one 1 mm web (holes-web) | 6,399 ms, not evaluated (one 5.5 s boolean) | 17 ms, web read (1.03) |
| 3 rounded-rect cutouts r 1.2 + one 1 mm web | 2,238 ms, web read | 482 ms, web read |
| 4 corner M3 holes 5 mm in + one 1 mm web | 565 ms, web read | 791 ms, web read |
| 12 d 6 holes 3.5 mm from an edge + one 1 mm web | 1,749 ms, not evaluated | 37 ms, not evaluated (the difference priced out) |
| 30 such holes + one 1 mm web | 6,240 ms, not evaluated | 98 ms, not evaluated (the difference priced out) |

The last two rows are the class the prices withhold rather than read: holes within an
opening's reach of an edge or of each other stay in the opening, and every test runs the
difference against their exploded near-copy. Since no test skips its difference, that
class no longer needs a web to be withheld: twelve booleaned d 6 holes at a 10 mm pitch
(4 mm webs) cost 1.2 s with no deadline and are priced out, where a skip read them in
25 ms. On curved outlines the difference, not the test, is now the costly step.
Rounded-tab panels (3 mm stock, every corner r 3, one hole cut): 4 and 6 tabs are read
(0.4 and 0.6 s uncapped); 8 tabs only on a stopped clock (0.9 s uncapped — on a real one
the closing's difference, priced at three times its cost, no longer fits after the
opening's); 12 tabs are priced out at their difference (1,716 cubics, priced 2,187,
measured 0.7 s, twice). Sixteen 12 mm rounded-rect cutouts r 4 on 4 mm webs are priced
out (one 2.0 s difference) where they read in 58 ms before.

With no deadline paper sometimes refuses a difference against a near-copy ("curve-fill:
resolved hole has no containing outer"), and that reading is now a read error carrying
its width, where the net area change used to stand in: the perforated grille's bridge
(at 3 mm), twelve d 6 holes 3.5 mm from an edge plus a 1 mm web (at 0.75 mm), six 4 mm
booleaned stadium slots beside an r 2 outline (at 0.09 mm). Under the budget all but
the last are priced out before the refusal, so verify shows the notice either way.

A scratch experiment (not committed) swapped each booleaned round hole a search keeps
for the exact circle it approximates (two arcs; the cubics sit within 0.03 % of its
radius): twelve and sixteen d 6 holes at a 10 mm pitch then read in 9–12 ms,
forty-eight in 77 ms, and both holes-near-an-edge rows above read their webs (83 and
197 ms under the deadline) — the follow-up this section recommends.

Earlier in this branch a booleaned round hole was the engine's worst shape outright: it
shrinks to a near-point circle of cubics the offset engine could not cheaply regrow — one
M2.5 hole took 4.5 s and four took 47 s. Round holes are read directly (their narrowest
opening is their diameter), the offset engine drops a hole a sharp dilation fully erodes
while every join on it takes the miter (`contour-offset.js`), and the width searches
leave out the holes they cannot involve.
