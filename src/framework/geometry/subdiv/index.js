// The subdivision cage: a coarse closed quad mesh an author box-models with k.cage(...).
import { subdivide, levelFor, applySubdivPlanAt, SUBDIV_TOLERANCE, SUBDIV_MAX_TRIANGLES, MAX_SUBDIV_LEVEL } from "./surface.js";
import { selfIntersections } from "./self-intersect.js";

// The pieces stay in their own modules (cage.js, surface.js, self-intersect.js), which
// their tests import directly; this entry re-exports what the kernels and probes use.
export { createCage, isCage, MAX_CAGE_FACES } from "./cage.js";
export { SUBDIV_TOLERANCE, SUBDIV_MAX_TRIANGLES } from "./surface.js";

// A cage snapshot as the triangle mesh k.subdiv builds at a quality tier ("preview" or
// "print"): the level levelFor picks for SUBDIV_TOLERANCE[tier] within
// SUBDIV_MAX_TRIANGLES[tier]. The body still builds when the tolerance cannot be met (a
// warning says so, with the remedy for what stopped the level: the top level asks for
// more faces, the triangle limit for fewer). A body passing through itself throws at
// print and warns at preview, naming the cage faces; a body with no volume throws at both
// (with the through-itself message when it has one). `maxTriangles` overrides the tier's
// limit, there for tests. `level` is the level it built.
export function meshSubdiv(snapshot, tier, { maxTriangles } = {}) {
  const tolerance = SUBDIV_TOLERANCE[tier];
  if (tolerance === undefined) throw new Error(`subdiv: quality must be "preview" or "print", not ${JSON.stringify(tier)}`);
  const warnings = [];
  const { level, error, met, mesh: built } = levelFor(snapshot, tolerance, { maxTriangles: maxTriangles ?? SUBDIV_MAX_TRIANGLES[tier] });
  if (!met) {
    const remedy = level === MAX_SUBDIV_LEVEL
      ? "split the cage into more faces (more segs, or more steps on an extrude)"
      : "use fewer, larger cage faces";
    warnings.push(`subdiv: the surface is within ${Number(error.toPrecision(2))} mm of smooth, not the ${tolerance} mm this quality asks for — ${remedy}`);
  }
  const mesh = subdivide(snapshot, level, built);   // the mesh the level search already built
  const through = throughMessage(selfIntersections(mesh), snapshot.ids ?? []);
  // A body with no volume cannot build at any tier; when it also passes through itself
  // (a face pushed out through the far side), that is the cause, so say that instead.
  if (!(signedVolume(mesh.positions, mesh.indices) > 0)) throw new Error(through ?? "subdiv: the body has no volume");
  if (through) {
    if (tier === "print") throw new Error(through);
    warnings.push(through);
  }
  return { level, positions: mesh.positions, indices: mesh.indices, triFace: mesh.triFace, triRegion: mesh.triRegion, regions: mesh.regions, creasePairs: mesh.creasePairs, warnings };
}

// The drag validity check (docs/superpowers/specs/2026-11-22-cage-pose-drag-design.md,
// "Stopping at the last valid pose"): meshSubdiv's two refusals, the body passing through
// itself and the body with no volume, on a coarser surface, fast enough to run before each
// pose a drag draws. The level is min(plan.level, DRAG_CHECK_LEVEL): 1, because level 2
// costs about 11 ms a move on the cage hand and level 1 about 3 ms (npm run
// bench:cage-drag; the budget is 5 ms). A coarse surface can miss a fine crossing: the
// exact build after release still runs the full check.
export const DRAG_CHECK_LEVEL = 1;

/**
 * Is a drag pose of a cage drawable? `plan` is a subdivPlan (surface.js) and `points` the
 * cage's points in the plan's snapshot order. `ids` names the cage faces in the message
 * (the faces' indices are used without it). Kernel-free and DOM-free.
 * @returns {null | { message: string }} null for a valid pose, else meshSubdiv's message
 */
export function dragValidity(plan, points, { ids = [], level = Math.min(plan.level, DRAG_CHECK_LEVEL) } = {}) {
  let positions;
  try { positions = applySubdivPlanAt(plan, points, level); } catch (err) { return { message: `subdiv: ${err.message}` }; }
  const { indices, triFace } = plan.levels[level];
  const through = throughMessage(selfIntersections({ positions, indices, triFace }), ids);
  if (!(signedVolume(positions, indices) > 0)) return { message: through ?? "subdiv: the body has no volume" };
  return through ? { message: through } : null;
}

// "subdiv: the body passes through itself between A and B; C and D", or null for no
// crossings. A face crossing itself is named once, after the pairs:
// "...; E folds through itself" (": E folds through itself" when it is the only kind).
function throughMessage(pairs, ids) {
  if (pairs.length === 0) return null;
  const name = (f) => ids[f] ?? f;
  const between = pairs.filter(([a, b]) => a !== b).map(([a, b]) => `${name(a)} and ${name(b)}`);
  const folds = pairs.filter(([a, b]) => a === b).map(([a]) => `${name(a)} folds through itself`);
  const head = "subdiv: the body passes through itself";
  if (between.length === 0) return `${head}: ${folds.join("; ")}`;
  return `${head} between ${[...between, ...folds].join("; ")}`;
}

function signedVolume(P, I) {
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
      - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
      + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}
