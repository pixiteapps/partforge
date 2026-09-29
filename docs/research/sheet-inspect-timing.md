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
`evaluated: false` — one `sheetChecks` warning. The prices are fitted on this machine
(over the calibration corpus below, read under the budget, every step costs about its
price (0.95–1.04 across runs) — the worst is a test on a row of three flattened ovals,
643 ms priced 676 — and the largest
runs about 0.9 s), so the checks end inside their budget plus at most one step's overrun;
a device slower than the pace the meter has measured so far can overrun one step by its
own slowness (the meter learns it after 50 priced units). What runs before the first
priced step — the arc fit, the flattening and the hole plan — is not priced, nor is the
pass over a search's lines that prices its setup (at most 2 ms on the grilles). The
arc fit is cheap, not linear, on real outlines: a ring of 4,000 organic cubics costs it
8.5–10.8 ms of CPU, a circle of 4,000 cubics 5.1–5.7 ms, and a smooth traced-style blob
(Catmull-Rom through n points, what an imported SVG gives) scales closer to n^1.6 — 1.7 ms
at 500 points, 11.6 ms at 2,000, 35 ms at 4,000, 104 ms at 8,000. Some rings of thousands
of cubics built to
keep its search long still cost it superlinearly — at 4,000 cubics, runs of collinear
cubics 0.20–0.66 s (0.66 s measured under load), a dense near-circle (an ellipse of 1.01) 0.23 s, a circle through
4,000 noisy points 0.83 s; 36–60 ms at 1,600. That cost is pre-existing (origin/main's
fit spends 0.12–6.1 s on the same rings at 1,600) and unpriced; they are shapes built to
keep the fit's search long, not ones the helpers or a boolean produce. "Cold" is the
first inspect of that lap type in the bench's shared worker (only the first row also pays
the lazy oracle load); "warm" is the median of the runs after it. The 2-D column is every
sheet's facts computed with no deadline — so nothing is priced out, and nothing holds a
step to its price: every test starts however long it runs. Over the calibration corpus
read that way a line-heavy test ran up to 1.79 × its price (6.4 s priced 3.6 s, a wavy
edge of 30 periods on 3 mm), and whole readings took up to 78 s; the perforated row's
86 s is the same thing.

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
| laser-box | quick | 316 | 106 | 60 | 6/6 |
| laser-box | full | 173 | 132 | 60 | 6/6 |
| twelve-panel | quick | 344 | 260 | 237 | 12/12 |
| twelve-panel | full | 325 | 309 | 237 | 12/12 |
| screw-plate | quick | 56 | 36 | 10 | 1/1 |
| screw-plate | full | 35 | 35 | 10 | 1/1 |
| perforated | quick | 1364 | 475 | 85531 | 0/1 |
| perforated | full | 451 | 454 | 85531 | 0/1 |
| holes-web | quick | 173 | 123 | 41 | 1/1 |
| holes-web | full | 112 | 110 | 41 | 1/1 |

Both this block and the Chromium one were taken with the machine carrying other work
(1-minute load average 4–9 on 10 cores), after the arc fit went linear, the flattened
pieces were held to 4° and a search's setup was priced for its facing count. Against the
fifth fix pass (laser-box 134 ms, twelve-panel 312, screw-plate 35, perforated 483,
holes-web 108 warm full) the laps are unchanged within that noise: nothing in these parts
is a slow cubic, so the 4° pieces never touch them, and their lines are too sparse for the
facing count's price to move. The bench runs on the wall clock: taken once during a burst
of other work (load average 36), the twelve-panel part read 5/12 in its one shared budget
and its 2-D column 1.75 s, and 12/12 and 0.24 s again when the burst had passed. The
perforated grille's uncapped column is the whole bisection, every test collapsing 900
holes' webs; under any deadline its first test is priced out.

## Chromium

### Chromium 149.0.7827.55 (headless, module worker) — 2026-09-29, 5 warm runs
| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |
|---|---|---|---|---|---|
| laser-box | quick | 284 | 100 | n/a | 6/6 |
| laser-box | full | 147 | 125 | n/a | 6/6 |
| twelve-panel | quick | 297 | 241 | n/a | 12/12 |
| twelve-panel | full | 289 | 279 | n/a | 12/12 |
| screw-plate | quick | 55 | 35 | n/a | 1/1 |
| screw-plate | full | 34 | 33 | n/a | 1/1 |
| perforated | quick | 1216 | 387 | n/a | 0/1 |
| perforated | full | 377 | 374 | n/a | 0/1 |
| holes-web | quick | 135 | 105 | n/a | 1/1 |
| holes-web | full | 105 | 103 | n/a | 1/1 |

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
  the cut files with, handed over by `resolveSheet`; it accepts a run within
  min(1e-3·r, 2e-3·chord) of every cubic at every probe and joint, so a non-circle that
  close to a circle is read as it, and refuses a fit through three near-collinear
  points), every cubic left that the search could carry into the offset engine's slow
  band read as lines (below), less the holes the search cannot involve (`holePlan`: the
  closing leaves out round holes, read directly, and convex holes wider than the ceiling;
  the opening, convex holes that clear every other ring by twice the ceiling, 1.5 times
  for a round one). The area, pieces and marks read the profile.
- **Its setup** — the profile rebuilt from those rings, and the count of its lines that
  face another line within the ceiling, which its tests' price needs — is a priced step.
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
- **What the margin hides, read directly.** A web or slot narrower than 0.02 mm fits
  inside the margin, and those are exactly what a kerf burns away (a slot 0.015 mm inside
  a plate's edge read "nothing narrower than 3 mm"). The margin cannot shrink: the winding
  resolver merges crossings 0.005 mm apart, and at a 0.005 margin the corners of sector
  panels of radius 100–800 read false webs of 4.7–5.7 mm on 6 mm stock. So one pass over
  the profile's boundary (`nearContacts`) finds faces within 0.02 mm of each other — runs
  facing within 60° of opposite directions, at least 0.5 mm long (0.01 mm² at that width,
  the difference's own loss rule), so a sharp tip's two sides never count — and reads the
  narrowest as a bridge (material between) or a gap (empty between), rounded up to
  0.01 mm. Whole segments are checked first; only a profile with two faces that close is
  walked in 0.1 mm pieces.

### The spike class

Twice in this branch a single priced step could run for seconds inside the 1,500 ms
budget — and not only for a caller that passes no deadline (every shipped caller passes
one: `measure()` always does). A boolean hands every arc back as cubics, and the offset
engine approximates a cubic's offset (adaptive Tiller–Hanson): a cubic an offset moves
toward its centre of curvature until little of its radius is left subdivides toward the
depth limit.
- **Circular cubics** (fourth fix pass). Rounded plates with booleaned holes, corners r
  1.6–1.8 on 3 mm stock, ran one test for 4–61 s (one inspect of a 100 × 60 × 3 plate took
  61.8 s wall); 2, 4 and 6 mm stock the same at r ≈ 0.55–0.65 × t. Reading circular runs
  as arcs removed it: those plates read in 1–3 ms of CPU, the inspect in 56 ms.
- **Non-circular cubics** (fifth). The fourth pass never started a test that would
  shrink such a cubic into the band 0.9–1.35 × w/2 — but only in the first offset's
  direction. A cubic grown first (radius r + h) and shrunk back by the second offset meets
  the same band when r ≲ 0.35 h: a row of six booleaned 2 × 8 mm ovals (tips r 0.25) ran
  ONE test priced 317 for 2.3 s at 3 mm and 20 s at 6 mm, and a plate's elliptical corners
  (tightest radius 0.1 h) closed for 1.56 s priced 57. The band, measured on elliptical
  corners (moved toward the centre first) and elliptical holes (moved away first) at 3 and
  6 mm, per test of four cubics: toward first, 9–20 ms at r/h 0.2–0.5, 57–95 ms at 0.8,
  0.2–3.2 s at 1.0, 0.1–0.4 s at 1.2, 6–29 ms at 1.5, 1–4 ms from 1.8; away first,
  0.3–1.0 s at 0.2, 76–96 ms at 0.35, 28–34 ms at 0.5, 8–17 ms from 0.8.
  Each search now reads as lines (within 0.005 mm of the control polygon, the curve within
  0.00375 mm, and no piece turning more than 4° — "Point contacts", below) every cubic it
  could carry into that band at the ceiling: moved toward its centre first below 2.5 h,
  away first below 0.75 h (margins over the measured edges, 2.2 h and 0.35 h); one that
  bends both ways is judged the strict way. Lines offset exactly, meet other edges at
  corners the sharp join mitres exactly, and a test on lines runs no spike. The ovals are
  withheld inside the budget before their first test (5–20 ms of CPU), and the
  elliptical-corner plates read in 110–135 ms.
  Flattening every cubic was measured and set aside: a benign curve becomes a hundred lines
  where it was four cubics, and a line-heavy test costs superlinearly (the prices), so
  ordinary elliptical-hole panels that read in tens of milliseconds were priced out — 97 of
  the 151 calibration panels read under the budget, against 105 (106 against 114 before
  the pieces were held to 4°). Fitting the flattened pieces as arcs (three-point or G1
  biarcs) was measured too: 10–100 × cheaper, but a tip the test collapses regrows along
  the arcs' circles rather than their tangents, and the readings moved by up to 1.6 mm (a
  wave's crest 3.19 → 4.17–4.73, an oval's tip gap 0.94 → 1.22–1.31) on rows where the
  lines read what the cubics read. Lines read the cubics' reading wherever a web has
  length; a point contact is read by area, and there no outline reads it exactly.

### Point contacts

Two tight tips facing — two elliptical holes tip to tip, a tip against a straight edge —
meet at a point, and a width search reads a point by area: the width at which
`LOSS_TOL_MM2` of area leaves (or enters). That area grows so slowly past the true web
that a small change in the outline moves the reading a long way, either way. Cut into
lines to 0.005 mm alone, a 1.2 mm web between two 2 × 5 mm elliptical holes on 3 mm
stock read 1.83 (a silent pass under the 1.5 mm floor; the exact cubics read 1.22), and a
2.85 mm web between two 2 × 8 mm ones on 6 mm read 3.00. So no flattened piece turns more
than 4° (`SEARCH_TURN`), and both of those warn or are withheld
(test/sheet-dfm.test.js). On the reviewer's 40 tip-to-tip rows — two 2 × 5 to 4 × 10 mm
elliptical holes tip to tip on 3 and 6 mm stock, webs 0.8–1.2 × the floor — read under
the budget, the 24 sub-floor webs give 19 warnings, 3 withheld (the notice) and 2 silent
passes: 2 × 8 mm holes 1.2 mm apart on 3 mm read 1.78, 2 × 5 mm 2.4 mm apart on 6 mm read
3.05. That 19/3 split is one run's — one row (6 mm, 2 × 5 mm, web 2.85) sits on the
budget and is read or withheld depending on load. The exact cubics pass both of the
silent passes too (1.83, 3.05): area on a point contact is
their own limit, not the flattening's. None of the 16 webs over the floor warns; 4 are
withheld. The cost is on grilles: 4° pieces cut flattened oval and ellipse grilles into
more lines, all facing, and eight such calibration panels and a text stencil that read
before are now withheld, along with six more of the helpers-and-ellipses fuzz's 72 panels
(seven in all). An elliptical hole's tip is the same class: on a ring-sector panel with
an r 0.4 ellipse, the gap reading moved 1.31 → 1.27–1.28 mm (2 / 3 / 6 mm stock) with the
4° pieces; the exact cubics read 1.25–1.31 — inside the point-contact limit either way.

### Prices

In units of about one desktop-Node millisecond, fitted to main-thread CPU time in Node
v24.19.0 (darwin arm64) on 2–6 mm stock, each step timed alone:

| step | price | calibration (CPU) |
|---|---|---|
| test, per line | 1.2 | 256 square holes (1,028 lines), holes merging: 1.1 s; a panel of 12 polyline-rounded tabs (884 lines): 0.92 s |
| test, per line facing another line within the ceiling, + 0.002 × (their count)² | — | the winding resolver classifies every piece of an offset it has to clean up against every edge of it, and where a test brings two polylines nearly tangent it splits them into many pieces and probes each many times over: 24 flattened 2 × 1 mm ovals on 2 mm stock, 964 lines all facing, 2.4 s (priced 3.0 s); six 2 × 8 mm ovals on 6 mm, 384 of 436 facing, 0.72 s (0.82 s). Linear alone, a grille of 24 drawn 48-facet ellipses ran 2.3 s in a step priced 1.4 s |
| test, per arc, + 0.0015 × (the arcs)² | 2.5 | a grille of round holes whose webs a test collapses costs the same resolver superlinearly: 200 arcs 0.2 s, 392 0.6 s, 578 1.3 s, 800 2.4 s, 1,058 4.1 s; with nothing merging, 0.02 s for 512 |
| test, per cubic | 3 | only cubics out of the slow band are left: 1,024 cubics beside 1,028 lines, merging: 4.7–5.2 s |
| difference, per line of both shapes | 0.1 | a grille of 50 drawn 32-facet circles: 0.28 s (0.34 s) |
| difference, per arc of both shapes | 0.5 | the 196-hole grille, 1,148 arcs and 744 lines: 0.46–0.55 s |
| difference, per cubic of both shapes | 0.15 | a margin clear of the shape, not quadratic: 200 booleaned ellipses, 8,856 cubics and lines 1.2 s, 14,356 1.5 s |
| the margin shape, once per search | half a test's per-segment price | one offset |
| a search's setup (the profile rebuilt, its facing lines counted), per line / other segment, + per probe the count's grid makes | 0.02 / 0.002, + 0.00004 | the count probes every line against every line bucketed within the ceiling of it, so on short, dense lines it is superlinear: 36 flattened 2 × 1 mm ellipses 0.6 mm apart (4,756 lines), 90 ms on 2 mm stock and 440 ms on 6 mm, 37–42 ns a probe (priced 171 and 545; per line alone, 95 for both); 60 of them on 6 mm, 1.02 s (1.19 s). The probes are estimated before the step from the lines' midpoints binned in the grid's own cells (within 15% of the grid's count on the calibration grilles) |
| the boundary pass (`nearContacts`), once | 0.003 per 0.1 mm piece | a 900-hole grille, 91,000 pieces: 0.15 s (0.27 s); a sign's worth of text: 31 ms (36 ms) |

The calibration corpus is 151 panels on 2–6 mm stock: the fourth pass's 45 (finger
panels, mounting plates, rows of holes, rounded cutouts, rounded tabs, combs, grilles,
booleaned ellipses, elliptical corners, #233's profiles, keyholes), grilles of flattened
ovals and of drawn polyline ellipses and faceted circles, big elliptical outlines, text
stencils, wavy edges, polyline-rounded tab panels, and #233's helpers and ellipses across
radius and stock. The prices above were fitted on it before no flattened piece could turn
more than 4° ("Point contacts"); then, read with no deadline, no step cost more than 0.93
of its price, and under the budget 114 were read with the worst step at 0.83. The 4° pieces
cut grilles of flattened ovals and ellipses into more lines, nearly all facing. Under the
budget one step then ran past 1.5 × its price: a search's setup, whose facing-line count
probes every line against every line near it, on 36 flattened 1.5 × 3 mm ellipses 1 mm
apart on 4 mm stock (4,756 lines, all facing), 120–146 ms priced 95 per line — and on
denser grilles beyond the corpus, 6.6 × (1.05 s priced 158). So the setup is priced for its
probes (the row above); nothing else was re-fitted. Read under the 1,500 ms budget on the
CPU clock, 105 of the 151 are read, and every step costs about its price (0.95–1.04
across runs — the worst is a test on a
row of three flattened 2 × 8 mm ovals, 643–701 ms priced 676) and the largest runs about
0.9 s (a test priced 1.36 s); across #233's helpers-and-ellipses fuzz (72 panels, 65 read)
the worst is 0.67, and across grilles of 36–60 flattened ellipses on 2–6 mm stock 0.86. Read
with no deadline, where every test starts however long it runs, tests on those grilles and
on fine polyline waves cost up to 1.7–1.8 × their price (a 30-period wave on 3 mm, 6.2–6.4 s
priced 3.6 s; 12 flattened 2 × 4 mm ellipses on 3 mm, 7.5 s priced 4.5 s), differences at
most 0.78 ×, setups 0.60 × and the boundary pass 0.52 × (steps of 6 ms and more). The same
corpus at the fourth pass read 96, and one step there cost 62 × its price (20 s).

### What that buys

The re-review's coverage table (3 mm stock), re-measured in CPU time: desk is a 1,500 ms
budget on this machine's CPU clock, phone the same clock × 2.2, a device 2.2 × slower. The
middle column is the fourth fix pass's (8ade9579), the rows below the rule this pass's.

| panel | fourth pass desk (phone) | now desk (phone) |
|---|---|---|
| finger-jointed panels, bare | 6–53 ms (13–113), read | 6–57 ms (13–119), read |
| finger panel + 4 M3 / hand-hole / r 5 window | 9–13 ms (20–27), read | 10–14 ms (22–29), read |
| 120 × 80 r 3 plate, 4 / 6 / 8 M3 holes 5 mm in | 3 / 3 / 4 ms (7), read | 4 / 5 / 5 ms (8–11), read |
| row of 10 d 4 holes at an 8 mm pitch | 1 ms (3), read | 2 ms (4), read |
| 4 rounded cutouts r 2–5, 4–6 mm webs | 2–3 ms (5–6), read | 3–4 ms (6–9), read |
| 9 rounded cutouts r 3 | 4 ms (11), read | 6 ms (12), read |
| 4 corner M3 5 mm in + 1 mm web | 15 ms (32), web 1.03 | 16 ms (38), web 1.03 |
| 12 or 30 d 6 holes 3.5 mm from an edge + 1 mm web | 39 ms (83–85), web 1.03, slot 2.02 | 43 ms (93), web 1.03, slot 2.02 |
| rounded tabs r 2 / r 3, 2–12 tabs | 2–8 ms (5–17), read | 3–9 ms (6–20), read |
| 100 / 196 perforations d 3 at a 5 mm pitch | withheld at 1.2 s / 0.6 s; 289 and more not started | withheld at 0.94 s / 0.66 s (phone 1.46 / 1.44 s); 289 and more not started |
| twelve-panel, whole part, one shared budget | 12/12 at 3 × | 12/12 at 3 × |
| six booleaned 2 × 8 mm ovals, 3 mm, pitch 4.4 | withheld after ONE 2.3 s step (priced 317) | withheld at 9–20 ms (16–18): its first test is priced past the budget |
| the same on 6 mm, pitch 6.8 | withheld after ONE 20 s step | withheld at 16–18 ms (33–55), the same way |
| 100 × 60 plate, elliptical corners 0.1 h, 4 M3, 6 mm | withheld after a 1.56 s step (priced 57) | read in 125–134 ms (271–287) (b 6c, g 3.4) |
| wavy top edge (4 periods) + M3 1 mm under a trough | "nothing narrower than 3 mm" (14 cubics read as one straight arc) | web 1.03 at the trough |
| slot 0.015 mm inside the edge / 0.015 mm slit | "nothing narrower than 3 mm" (inside the difference's margin) | web 0.02 / gap 0.02, located |
| the 151-panel calibration corpus | 96 read, worst step 62 × its price | 105 read, every step about its price (0.95–1.04 across runs) |

Nothing in any row passes silently: a sheet the budget stops reads the notice. The
sub-floor webs the re-review found reading as engine errors on r 0.6–0.8 plates read
their true widths (0.84, 1.03, 1.22, 1.41) in 6–28 ms, and the 6 mm plate with r 3
corners and a 10 × 10 hole reads its 5 mm web as 5.02 at the web, not 4.31 at the top
edge.

What this pass gives up, measured on the same corpus: four panels the fourth pass read are
now withheld, all line-heavy after flattening or drawn that way — three wavy edges whose
crests are tight (one of them the fourth pass read only as engine errors) and a grille of
six drawn 64-facet ellipses 1 mm apart, whose linear price the fourth pass under-charged
(a sibling grille ran 2.3 s in one step priced 1.4 s). Thirteen it withheld or never
started are read — elliptical corners and holes, a row of three ovals, a scaled rounded
rectangle, a wavy edge, two elliptical outlines, a stencil. Twenty-two were, before the
flattened pieces were held to 4°; the nine that went back to the notice are grilles and
rows of flattened ovals and ellipses and one text stencil ("Point contacts").

Earlier in this branch a booleaned round hole was the engine's worst shape outright: it
shrinks to a near-point circle of cubics the offset engine could not cheaply regrow — one
M2.5 hole took 4.5 s and four took 47 s. Round holes are read directly (their narrowest
opening is their diameter), the offset engine drops a hole a sharp dilation fully erodes
while every join on it takes the miter (`contour-offset.js`), and the width searches
leave out the holes they cannot involve.
