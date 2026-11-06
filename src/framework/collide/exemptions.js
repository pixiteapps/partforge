// Which pairs a drag may leave touching: a pair already inside clearance when the drag
// starts is not held to clearance, or the drag could never move it at all. Pure, like the
// world it reads; the guard (guard.js) owns one per drag.
//
// A pair's state, by pairKey: "near" (inside clearance: exempt until it opens past
// clearance once) or "inside" (wholly inside, where distance reads clear: exempt until it
// reaches the surface, then "near"). A "near" pair is free to move, deeper in included,
// until it opens past clearance once: "never further in" would need penetration depth,
// which distance alone does not give. An "inside" pair relies on the walk's sub-steps to
// see it reach the surface, which assumes pieces thicker than SETTLE_STEP_MM.
import { pairKey } from "./pairs.js";
import { applyMat } from "./motion.js";

function boxUnder(box, m) {
  if (!box) return null; // an empty mesh: no box
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
    const q = applyMat(m, [x, y, z]);
    for (let j = 0; j < 3; j++) { out[j] = Math.min(out[j], q[j]); out[j + 3] = Math.max(out[j + 3], q[j]); }
  }
  return out;
}

const boxesOverlap = (a, b) => !!a && !!b && [0, 1, 2].every((j) => a[j] <= b[j + 3] && b[j] <= a[j + 3]);

/**
 * The exemptions at `startMats`, and the clearance check they change.
 * - check(mats): one clearance query: `{ clear, blocked, next }`, clear unless a non-exempt
 *   pair is inside clearance. `next` is the exemptions as they stand once this pose is
 *   accepted; a check on its own changes nothing.
 * - accept(checked): take a check's `next`, moving on to that pose.
 * - has(key): whether a pair is exempt right now.
 * - snapshot() / restore(saved): undo every accept since, for a walk that gets discarded.
 */
export function createExemptions({ world, startMats, moving, clearance }) {
  const exempt = new Map();
  for (const r of world.distances(startMats, { names: moving, within: clearance })) exempt.set(pairKey(r.a, r.b), "near");
  // Wholly inside at begin: one parity test per pair whose boxes overlap, once per drag.
  const names = world.names().filter((n) => startMats.get(n) !== null);
  const movingSet = new Set(moving);
  const boxes = new Map(names.map((n) => [n, boxUnder(world.boundsOf(n), startMats.get(n))]));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j], key = pairKey(a, b);
      if (!movingSet.has(a) && !movingSet.has(b)) continue;
      if (exempt.has(key) || !boxesOverlap(boxes.get(a), boxes.get(b))) continue;
      if (world.inside(startMats, a, b)) exempt.set(key, "inside");
    }
  }

  // Lower bounds on pair gaps by relative placement, kept for the drag (world.distances'
  // `bounds`): most pairs a check meets have not moved relative to each other since the
  // last one, or by less than its pad.
  const clearBounds = new Map();
  const set = (entries) => { exempt.clear(); for (const [k, v] of entries) exempt.set(k, v); };

  return {
    check(mats) {
      const hits = world.distances(mats, { names: moving, within: clearance, bounds: clearBounds });
      const next = new Map(exempt);
      const touching = new Set();
      let blocked = null;
      for (const r of hits) {
        const key = pairKey(r.a, r.b);
        touching.add(key);
        if (exempt.has(key)) next.set(key, "near");
        else if (!blocked) blocked = { a: r.a, b: r.b };
      }
      for (const [key, kind] of exempt) if (kind === "near" && !touching.has(key)) next.delete(key);
      return { clear: !blocked, blocked, next };
    },
    accept: ({ next }) => set(next),
    has: (key) => exempt.has(key),
    snapshot: () => new Map(exempt),
    restore: set,
  };
}
