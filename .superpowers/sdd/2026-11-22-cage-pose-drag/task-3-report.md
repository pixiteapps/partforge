# Task 3 report
Implemented scripts/bench-cage-drag.mjs and the `bench:cage-drag` npm script. Ran it (Apple M1 Max, Node v24.19.0, median of 12, preview tier) and pasted the table into the spec under "Measure first". No unit test (not shipped behaviour). Skipped the dragValidity row (does not exist yet).

cage-hand (level 4, 300 faces, 153,600 tris): cage code 3.8; levelFor 14.7; subdivide 3.8; selfIntersect 215.6; manifold 164.2; cut 96.1; toMesh 27.5; whole 527.7.
Drag sum (cage code + manifold + cut + toMesh) = 291.5 ms (over the 120 ms checkpoint; reported, not acted on).
organic-whale (level 2, 132 faces, 4,224 tris): 0.7 / 1.4 / 0.1 / 4.6 / 3.7 / 3.1 / 0.8; whole 60.4; drag sum 8.4.
Note: the whale's whole build (60 ms) exceeds its stage sum (~15 ms); about 40 ms is outside the measured stages (not investigated).
Files: scripts/bench-cage-drag.mjs, package.json, docs/superpowers/specs/2026-11-22-cage-pose-drag-design.md.
