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
| laser-box | quick | 312 | 102 | 57 | 6/6 |
| laser-box | full | 162 | 131 | 57 | 6/6 |
| twelve-panel | quick | 334 | 253 | 231 | 12/12 |
| twelve-panel | full | 300 | 305 | 231 | 12/12 |
| screw-plate | quick | 53 | 35 | 9 | 1/1 |
| screw-plate | full | 35 | 34 | 9 | 1/1 |
| perforated | quick | 1384 | 500 | 86865 | 0/1 |
| perforated | full | 457 | 461 | 86865 | 0/1 |
| holes-web | quick | 154 | 116 | 39 | 1/1 |
| holes-web | full | 116 | 115 | 39 | 1/1 |

Both this block and the Chromium one were taken with the machine carrying other work
(1-minute load average 4–6 on 10 cores). A test that hands back the searched shape's own
rings now runs no difference (below), so the line-only panels cost less than before the
difference ran on every test: in CPU time, back to back, laser-box 133 → 53 ms and
twelve-panel 603 → 231 ms for all twelve sheets, against 83 and 266 ms when a net-area
shortcut still skipped differences. The perforated grille's uncapped column rose: its
bridge search used to end at the ceiling in a refused difference, and with the difference
taken a margin clear of the shape nothing refuses, so with no deadline the whole
bisection runs, every test collapsing 900 holes' webs. Under any deadline its first test
is priced out, as before.

## Chromium

### Chromium 149.0.7827.55 (headless, module worker) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 288 | 99 | n/a | 6/6 |
| laser-box | full | 144 | 121 | n/a | 6/6 |
| twelve-panel | quick | 288 | 231 | n/a | 12/12 |
| twelve-panel | full | 278 | 279 | n/a | 12/12 |
| screw-plate | quick | 53 | 33 | n/a | 1/1 |
| screw-plate | full | 32 | 32 | n/a | 1/1 |
| perforated | quick | 1208 | 394 | n/a | 0/1 |
| perforated | full | 365 | 371 | n/a | 0/1 |
| holes-web | quick | 134 | 102 | n/a | 1/1 |
| holes-web | full | 100 | 99 | n/a | 1/1 |

## iPhone (Safari)

Scott measures this by hand before the PR merges (spec launch gate 5).

## What a profile costs

The measurements behind the laser descriptor's prices
(`src/framework/process/laser/descriptor.js`, "what a step costs"). Nothing interrupts
a step once started — the deadline is checked between steps — so under a deadline every
step is priced before it starts and not started when its price, scaled by the pace this
device has measured on the steps it already took, will not fit what is left.

What each width search runs on, and in what steps:
- **The searched shape** is the profile with every run of cubics that lies on one circle
  read as that circle's arcs (`recoverArcs`, `geometry/arc-fit.js`, the fit the kit draws
  the cut files with, handed over by `resolveSheet`), less the holes the search cannot
  involve (`holePlan`: the closing leaves out round holes, read directly, and convex holes
  wider than the ceiling; the opening, convex holes that clear every other ring by twice
  the ceiling, 1.5 times for a round one). The area, pieces and marks read the profile.
- **One test** per width: a sharp shrink and regrow. A sharp join extends an arc along its
  own circle (`contour-offset.js`), so an arc meeting a line or another arc at a real
  corner comes back as itself; extended along its end tangent it cut the corner short, and
  a ring-sector hole read a 1.88 mm gap, a thumb notch a 1.5 mm web.
- **No difference when nothing changed.** When the test hands back the searched shape's
  own rings — collinear and co-circular runs merged, matched ring for ring to 1e-9 mm —
  there is no loss and no gain, and no boolean runs.
- **Otherwise the one-sided difference**, priced from the test's own result and taken
  0.01 mm clear of the searched shape (what the test lost of the shape shrunk by 0.01, or
  gained beyond it grown by 0.01). Against the shape itself, paper's boolean met every
  unchanged curve beside its near-twin and refused ("curve-fill: resolved hole has no
  containing outer") or returned nothing: a keyhole's 4 mm slot read 4.55. The margin
  shape is one offset per search, priced into its first difference. No test skips its
  difference on a net area change: the square corners a chamfer or fillet elsewhere
  regrows can cancel a real web's loss to zero.

### The spike class

Until this branch's fourth fix pass a single priced step could run for seconds inside
the 1,500 ms budget — and not only for a caller that passes no deadline (every shipped
caller passes one: `measure()` always does). A boolean hands every arc back as cubics,
and a test that shrinks a cubic to just past w/2 takes seconds per cubic, while four such
cubics were priced 256. It hit ordinary rounded plates with booleaned holes, at corner
radii about 0.55–0.65 × the stock at the ceiling (bisection widths widened the band): a
100 × 60 × 3 plate, corners r 1.6–1.8, four M3 holes 5 or 8 mm in, ran one test for
4–61 s, and one full inspect of it took 61.8 s wall; 2 mm stock at r 1.1–1.14 took
2.3–9.7 s, 4 mm at r 2.2–2.6 2.7–26.6 s, 6 mm at r 3.3–3.9 6–73 s. Reading circular cubics
as arcs removes it: those plates now read in 1–3 ms of CPU, and the inspect takes 56 ms.
What remains is a cubic that is not a circle: four elliptical corners whose tightest
radius was 0.93–1.3 × w/2 took 0.3–2.4 s at 3 mm and 1.6–4.5 s at 6 mm in one test
priced 273 and 303. No price follows that, so a test that would meet a cubic there is
never started under a deadline (`spike`, below).

### Prices

In units of about one desktop-Node millisecond, fitted to main-thread CPU time in Node
v24.19.0 (darwin arm64) on 3 and 6 mm stock, each step timed alone:

| step | price | calibration (CPU) |
|---|---|---|
| test, per line | 1.2 | 256 square holes (1,028 lines), holes merging: 1.1 s |
| test, per arc, + 0.0015 × (the arcs)² | 2.5 | a grille of round holes whose webs a test collapses costs the winding resolver superlinearly: 200 arcs 0.2 s, 392 0.6 s, 578 1.3 s, 800 2.4 s, 1,058 4.1 s (linear, 400 holes and more were priced under cost); with nothing merging, 0.02 s for 512 |
| test, per cubic | 3 | 1,024 cubics beside 1,028 lines, merging: 4.7–5.2 s |
| test, a cubic the first offset shrinks (convex in an opening, concave in a closing) with its tightest radius 0.9–1.35 × w/2 | never started | the spike class above |
| test, such cubics elsewhere under 1.85 × w/2 | +16 × (their count)² | elliptical tab corners at 0.8 × w/2: 12 of them 0.75 s, 130 21.7 s; before the arc fit, circular tab corners at 1.33–1.5 × w/2, 12 1.9–2.3 s, 20 4.7–5.4 s |
| test, such cubics from 1.85 to 2.2 × w/2 | +0.2 × (their count)² | a circle's cost fell away at 1.85, an ellipse's only by 2.2: 130 elliptical corners at 2.0 × w/2, 0.74 s against a linear 559; at 2.3 × w/2, 52 ms |
| test, cubics grown first and shrunk back to within 1.5 × w/2 | +10 each | 128 filleted tab corners closed at 1.5 mm: 1.2 s |
| difference, per line of both shapes | 0.25 | 1,028 + 1,036 lines: 0.45 s |
| difference, per arc of both shapes | 0.5 | the 196-hole grille, 1,148 arcs and 744 lines: 0.46–0.55 s |
| difference, per cubic of both shapes | 0.15 | a margin clear of the shape, no longer quadratic: 200 booleaned ellipses, 8,856 cubics and lines 1.2 s, 14,356 1.5 s (against a near-copy 4,224 cubics took 6.4 s) |
| the margin shape, once per search | half a test's per-segment price | one offset |

Over a 45-panel calibration corpus (finger panels, mounting plates, rows of holes,
rounded cutouts, rounded tabs, combs, grilles, booleaned ellipses, elliptical corners,
#233's profiles, keyholes) no step cost more than 0.9 of its price, and the median step
0.2.

### What that buys

The re-review's coverage table (3 mm stock), re-measured in CPU time: desk is a 1,500 ms
budget on this machine's CPU clock, phone the same clock × 2.2, a device 2.2 × slower. The
first two columns are the re-review's (its HEAD, ac811d40, has the same laser code as
ca84e23d).

| panel | 047c3f72 desk (phone) | before this pass (ca84e23d) desk (phone) | now desk (phone) |
|---|---|---|---|
| finger-jointed panels, bare | 6–54 ms, read | 15–133 ms, read | 6–53 ms (13–113), read |
| finger panel + 4 M3 / hand-hole / r 5 window | 9–22 ms | 23–229 ms, read | 9–13 ms (20–27), read |
| 120 × 80 r 3 plate, 4 / 6 / 8 M3 holes 5 mm in | 15 / 16 / 21 ms | 257 / 386 / 603 ms (8 holes 1,288 phone-ms) | 3 / 3 / 4 ms (7), read |
| row of 10 d 4 holes at an 8 mm pitch | 18 ms, read | 822 ms (phone withheld) | 1 ms (3), read |
| 12 d 6 holes at a 10 mm pitch | 25–33 ms, read | withheld | 3 ms, read |
| 4 rounded cutouts r 2–5, 4–6 mm webs | 12–13 ms | 260–323 ms, read | 2–3 ms (5–6), read |
| 9 rounded cutouts r 3 | 23 ms, read | 823 ms (phone withheld) | 4 ms (11), read |
| 16 cutouts r 4 on 4 mm webs | 42 ms, read | withheld | 5 ms, read |
| 4 corner M3 5 mm in + 1 mm web | 441 ms, read | 726 ms (phone withheld) | 15 ms (32), web read 1.03 |
| 12 or 30 d 6 holes 3.5 mm from an edge + 1 mm web | — | withheld | 39 ms (83–85), web 1.03, slot 2.02 |
| rounded tabs r 2 / r 3, 2–12 tabs | — | r 2: not started (2 tabs withheld); r 3: read to 6 tabs, withheld from 8 | 2–8 ms (5–17), read |
| 100 / 196 perforations d 3 at a 5 mm pitch | — | withheld | withheld at 1.2 s / 0.6 s (phone too); 289 and more not started |
| twelve-panel, whole part, one shared budget | 12/12 at 3 × | 12/12 at 2.2 ×, 7/12 at 3 × | 12/12 at 3 × |

Nothing in any row passes silently: a sheet the budget stops reads the notice. The
sub-floor webs the re-review found reading as engine errors on r 0.6–0.8 plates read
their true widths (0.84, 1.03, 1.22, 1.41) in 6–28 ms, and the 6 mm plate with r 3
corners and a 10 × 10 hole reads its 5 mm web as 5.02 at the web, not 4.31 at the top
edge.

Earlier in this branch a booleaned round hole was the engine's worst shape outright: it
shrinks to a near-point circle of cubics the offset engine could not cheaply regrow — one
M2.5 hole took 4.5 s and four took 47 s. Round holes are read directly (their narrowest
opening is their diameter), the offset engine drops a hole a sharp dilation fully erodes
while every join on it takes the miter (`contour-offset.js`), and the width searches
leave out the holes they cannot involve.
