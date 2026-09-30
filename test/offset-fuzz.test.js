// Seeded fuzz for the 2-D offset engine: random shapes from the committed corpus
// (test/helpers/offset-corpus.js), offset at several deltas under all three corner styles,
// compared against the independent Minkowski-union oracle on REGION COUNT, HOLE COUNT and
// area — in that order of importance.
//
// Why topology first: the text bug this branch exists to fix sat within 0.1–0.3 % on area
// while being badly wrong topologically (a dilated "o" whose counter had closed came back as
// 25 regions and 11 holes, 0.21 % from the true area). An area-only oracle passes that. So
// this file asserts counts, and treats area as the weaker of the two checks.
//
// Determinism: the corpus is a pure function of integer seeds (mulberry32, never
// `Math.random`), so every failure below names a seed that reproduces it forever, both here
// and from `node scripts/offset-rates.mjs --seed <n>`.
//
// Boots manifold-3d (for the oracle's polygon-set assembly only — the oracle never calls
// anybody's offsetter). Must not share a process with OCCT; vitest isolates per file.
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { CHAIN_INCOMPLETE_MESSAGE } from "../src/framework/geometry/contour-winding.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";
import { minkowskiOracle } from "./helpers/minkowski-oracle.js";
import { corpus, CORNER_STYLES } from "./helpers/offset-corpus.js";

const SEGS = 64;
// Fuzz slice: 7 of the rate script's 20 deltas, so the suite stays fast (~1.5 s for the
// whole sweep). Five are inward, where severing lives; two are outward. +2 joined in the
// sheet-parts fix wave: it is where a SHARP dilation used to leave a fully eroded hole behind
// as a phantom (seeds 27, 63, 73, 85 — one outward delta at +1 never reached them), so a
// regression of that gate fails here. 150 cases x 7 deltas x 3 styles = 3 150 comparisons,
// which is the "a few hundred cases, not thousands" the corpus is meant to be. The corpus
// holds no hole with an acute spike of material, so the gate's other boundary — a sharp
// join that bevels — is pinned by name instead (offset-oracle-manifold.test.js, the star).
const DELTAS = [-0.5, -1.25, -2, -2.5, -3.25, 1, 2];

// Fully eroded holes under CHAMFER still leave a remnant — parked, with its reason, in
// docs/KERNEL-CONTRACT.md and offset-oracle-manifold.test.js (the 1×1 hole at +2). +2 reaches
// four of them. They are the same four seeds sharp used to get wrong, and are pinned as an
// exact list, so a fix shows up as loudly as a regression and neither can drift silently.
const CHAMFER_REMNANTS = [
  "seed 27 (multi-region) delta=2 chamfer: 2r/2h vs truth 2r/1h",
  "seed 63 (multi-region) delta=2 chamfer: 2r/2h vs truth 2r/0h",
  "seed 73 (pocket-plate) delta=2 chamfer: 1r/1h vs truth 1r/0h",
  "seed 85 (pocket-plate) delta=2 chamfer: 1r/1h vs truth 1r/0h",
];
const CASES = 150;

// A ring under this is not a feature; it is a resolver artifact. Applied to BOTH sides
// before any count is taken, and the results that carry one are pinned separately below —
// see "degenerate sliver rings" for what is actually known about them.
const SLIVER = 1e-3;                                // mm²

const pointRings = (regions) => regions.map((rg) => ({
  outer: tessellateContour(rg.outer, SEGS), holes: rg.holes.map((h) => tessellateContour(h, SEGS)) }));

// Engine topology + net area, slivers excluded.
function engineTopology(out) {
  const rs = pointRings(out);
  let regions = 0, holes = 0, area = 0, slivers = 0, smallest = Infinity;
  for (const rg of rs) {
    const a = Math.abs(ringArea(rg.outer));
    if (a < SLIVER) { slivers++; continue; }
    regions++; area += a; smallest = Math.min(smallest, a);
    for (const h of rg.holes) {
      const ha = Math.abs(ringArea(h));
      if (ha < SLIVER) { slivers++; continue; }
      holes++; area -= ha; smallest = Math.min(smallest, ha);
    }
  }
  return { regions, holes, area, slivers, smallest };
}

// Oracle topology + area. Under the Positive fill rule Clipper2 hands outers back CCW and
// holes CW, so the signed area of each returned ring is its own classifier.
function oracleTopology(O, src, delta, corners, fan) {
  const cs = O.offset(pointRings(src), delta, { corners, fan });
  const polys = cs.toPolygons();
  cs.delete?.();
  let regions = 0, holes = 0, area = 0, smallest = Infinity;
  for (const p of polys) {
    const a = ringArea(p);
    if (Math.abs(a) < SLIVER) continue;
    if (a > 0) regions++; else holes++;
    area += a; smallest = Math.min(smallest, Math.abs(a));
  }
  return { regions, holes, area, smallest };
}

let O;
beforeAll(async () => {
  const wasm = await Module();
  wasm.setup();
  O = minkowskiOracle(wasm.CrossSection);
});

// The whole sweep runs once and every disagreement is collected, so a failure message names
// EVERY seed that is wrong rather than only the first — otherwise a change that breaks 40
// cases is indistinguishable from one that breaks 1.
function sweep() {
  const topoBad = [], areaBad = [], chain = [], other = [], slivers = [], remnants = [];
  let compared = 0, ambiguous = 0;
  for (const c of corpus(CASES)) {
    for (const delta of DELTAS) for (const corners of CORNER_STYLES) {
      const where = `seed ${c.seed} (${c.family}) delta=${delta} ${corners}`;
      // The oracle's round caps are sampled at `fan` facets per full turn, the same
      // convention as the engine's tessellation density, so fan = SEGS puts both sides on
      // the same discretization and the residual is real disagreement, not chord error.
      let truth;
      try { truth = oracleTopology(O, c.regions, delta, corners, SEGS); }
      catch { continue; }                            // the oracle's own boolean gave up: skip
      let out;
      try { out = offsetRegions(c.regions, delta, { corners }); }
      catch (e) {
        if (e.message === CHAIN_INCOMPLETE_MESSAGE) chain.push(where);
        else if (/offset collapses the shape/.test(e.message)) {
          // Legitimate only if the truth really is empty.
          if (Math.abs(truth.area) > 0.05) other.push(`${where}: collapse throw but truth area ${truth.area.toFixed(4)}`);
        } else other.push(`${where}: ${e.message}`);
        continue;
      }
      const got = engineTopology(out);
      if (got.slivers) slivers.push(`${where}: ${got.slivers} ring(s) under ${SLIVER} mm²`);
      if (truth.regions === 0) continue;             // nothing left to compare
      compared++;
      // A count is only meaningful when nothing sits NEAR the sliver cutoff. A shape one
      // step from losing a 0.001 mm² crumb legitimately gains or loses a region depending on
      // which side of 1e-3 that crumb lands, and calling that a topology defect would be
      // reading the threshold, not the engine. Skipped, counted, and reported — never
      // silently tolerated.
      if (Math.min(got.smallest, truth.smallest) < 10 * SLIVER) { ambiguous++; continue; }
      if (got.regions !== truth.regions || got.holes !== truth.holes) {
        const line = `${where}: ${got.regions}r/${got.holes}h vs truth ${truth.regions}r/${truth.holes}h`;
        (CHAMFER_REMNANTS.includes(line) ? remnants : topoBad).push(line);
      }
      const rel = Math.abs(got.area - truth.area) / Math.abs(truth.area);
      // 1 % relative with a 0.02 mm² absolute floor. The engine's own everyday disagreement
      // with this oracle on cases that never failed runs to 0.43 % relative (task-7D), so 1 %
      // is ~2x that and still an order below anything KERNEL-CONTRACT.md parks; the floor
      // stops a shape that has eroded to a crumb from failing on a relative measure of nothing.
      if (rel > 0.01 && Math.abs(got.area - truth.area) > 0.02)
        areaBad.push(`${where}: ${got.area.toFixed(4)} vs truth ${truth.area.toFixed(4)} (${(100 * rel).toFixed(2)} %)`);
    }
  }
  return { topoBad, areaBad, chain, other, slivers, remnants, compared, ambiguous };
}

let R;
beforeAll(() => { R = sweep(); });

test("no unexpected error escapes the offset engine", () => {
  expect(R.other.join("\n")).toBe("");
});

test("region and hole counts match the oracle on every fuzz case", () => {
  // 3 080 comparisons (four of them the chamfer remnants pinned below); 14 more are skipped
  // as ambiguous (a kept ring within 10x of the sliver cutoff — see the sweep). If this
  // ever fails, the message names every seed.
  expect(R.topoBad.join("\n")).toBe("");
});

test("the fully eroded chamfer holes that leave a remnant are exactly the known ones", () => {
  expect(R.remnants.join("\n")).toBe(CHAMFER_REMNANTS.join("\n"));
});

test("area matches the oracle within 1 % on every fuzz case", () => {
  expect(R.areaBad.join("\n")).toBe("");
});

// ── exact characterizations ────────────────────────────────────────────────────────────
// Pinned as exact affected-seed lists rather than counts, so a fix shows up as loudly as a
// regression and neither can drift silently.

// The adaptive classifier resolves both formerly pinned failures (seed 27 sharp and seed 96
// round). Keep this assertion rather than deleting the category: any future escaped chain
// failure names its exact seed here.
test("no chain-incomplete failure remains in the fuzz slice", () => {
  expect(R.chain.join("\n")).toBe("");
});

// Degenerate sliver rings: the resolver can emit extra rings of ~1e-9 … 1e-3 mm² beside the
// real ones. They contribute nothing to area (an even-odd assembly, which is what extrude
// does, gives the same answer with or without them) but they DO corrupt `regions().length`
// and hole counts, which is why every count in this file filters them first. Rare on
// rectilinear input — 5 cases here. Two became observable when arrangements that formerly
// threw began returning geometry. Positive dilation has a source-membership proof for
// removing false islands; erosion does not, because a real surviving crumb need not contain
// a sampled source boundary point. These remain visible rather than area-pruned.
const SLIVER_CASES = [
  "seed 23 (multi-region) delta=-2.5 round: 1 ring(s) under 0.001 mm²",
  "seed 52 (notched-plate) delta=-2 chamfer: 1 ring(s) under 0.001 mm²",
  "seed 60 (notched-plate) delta=-2 round: 1 ring(s) under 0.001 mm²",
  "seed 96 (notched-plate) delta=-2.5 round: 1 ring(s) under 0.001 mm²",
  "seed 118 (radial-polygon) delta=-2 round: 1 ring(s) under 0.001 mm²",
];
test("the results carrying degenerate sliver rings are exactly the known ones", () => {
  expect(R.slivers.join("\n")).toBe(SLIVER_CASES.join("\n"));
});
