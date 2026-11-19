// The subdivision cage: a coarse closed quad mesh an author box-models with k.cage(...).
import { subdivide, levelFor, SUBDIV_TOLERANCE } from "./surface.js";
import { selfIntersections } from "./self-intersect.js";

// The pieces stay in their own modules (cage.js, surface.js, self-intersect.js), which
// their tests import directly; this entry re-exports what the kernels and probes use.
export { createCage, isCage, MAX_CAGE_FACES } from "./cage.js";
export { SUBDIV_TOLERANCE } from "./surface.js";

// A cage snapshot as the triangle mesh k.subdiv builds at a quality tier ("preview" or
// "print"): the level levelFor picks for SUBDIV_TOLERANCE[tier]. The body still builds
// when the tolerance cannot be met (a warning says so). A body passing through itself
// throws at print and warns at preview, naming the cage faces; a body with no volume
// throws at both (with the through-itself message when it has one). `maxTriangles` is levelFor's limit, there for tests.
export function meshSubdiv(snapshot, tier, { maxTriangles } = {}) {
  const tolerance = SUBDIV_TOLERANCE[tier];
  if (tolerance === undefined) throw new Error(`subdiv: quality must be "preview" or "print", not ${JSON.stringify(tier)}`);
  const warnings = [];
  const { level, error, met } = levelFor(snapshot, tolerance, maxTriangles === undefined ? {} : { maxTriangles });
  if (!met) {
    warnings.push(`subdiv: the surface is within ${Number(error.toPrecision(2))} mm of smooth, not the ${tolerance} mm this quality asks for — use fewer, larger cage faces`);
  }
  const mesh = subdivide(snapshot, level);
  const pairs = selfIntersections(mesh);
  const ids = snapshot.ids ?? [];
  const through = pairs.length === 0 ? null
    : `subdiv: the body passes through itself between ${pairs.map(([a, b]) => `${ids[a] ?? a} and ${ids[b] ?? b}`).join("; ")}`;
  // A body with no volume cannot build at any tier; when it also passes through itself
  // (a face pushed out through the far side), that is the cause, so say that instead.
  if (!(signedVolume(mesh.positions, mesh.indices) > 0)) throw new Error(through ?? "subdiv: the body has no volume");
  if (through) {
    if (tier === "print") throw new Error(through);
    warnings.push(through);
  }
  return { positions: mesh.positions, indices: mesh.indices, warnings };
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
