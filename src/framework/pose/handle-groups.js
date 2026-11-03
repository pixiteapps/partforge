// Handle groups (spec 2026-11-02 handles-for-limbs, goal 3): handles that share a
// `group` name show one at a time. Pure — pose-mode.js feeds it screen points; lint and
// the oracle read `groupOf` alone.

/** A handle's group name, or null (none, or not a non-empty string — lint's handle-bad-group). */
export function groupOf(handle) {
  const g = handle?.group;
  return typeof g === "string" && g.length ? g : null;
}

/**
 * Of the candidates that would show under the pointer, `[{ id, group, x, y }]` (`x`, `y`
 * the handle's grab point on screen), the ids to hide: in each group with more than one
 * candidate, every one but the one whose grab point is nearest `pointer` (a tie: the first
 * listed). A candidate with no group, or alone in its group, is never hidden.
 */
export function groupHidden(candidates, pointer) {
  const best = new Map(); // group -> { id, dist }
  const hidden = new Set();
  for (const c of candidates) {
    if (c.group == null) continue;
    const dist = Math.hypot(c.x - pointer.x, c.y - pointer.y);
    const d = Number.isFinite(dist) ? dist : Infinity;
    const cur = best.get(c.group);
    if (!cur) { best.set(c.group, { id: c.id, dist: d }); continue; }
    if (d < cur.dist) { hidden.add(cur.id); best.set(c.group, { id: c.id, dist: d }); }
    else hidden.add(c.id);
  }
  return hidden;
}

/**
 * The resting cue's handles among the `ids` a view shows: every ungrouped one, and per
 * group the first in `handles`' key order (a mark on something grabbable, not a centroid).
 */
export function cueHandleIds(handles, ids) {
  const shown = new Set(ids);
  const kept = new Set();
  const seen = new Set();
  for (const id of Object.keys(handles ?? {})) {
    if (!shown.has(id)) continue;
    const g = groupOf(handles[id]);
    if (g != null) {
      if (seen.has(g)) continue;
      seen.add(g);
    }
    kept.add(id);
  }
  return kept;
}
