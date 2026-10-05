// Which view a part opens on. The rule is independent of display order: an author
// can flag a view `default: true` wherever it sits in the tab bar, and when nobody
// flags one, the biggest view wins — the one placing the most sub-parts at the
// part's defaults, which for a multi-view part is the assembly. Ties fall back to
// declaration order, so every part written before this existed resolves to the view
// it has always opened on.
//
// Pure: no DOM, no storage, no kernel, no build. The headless surfaces (measure /
// verify / renderViews) deliberately do NOT use this — they stay on
// Object.keys(part.views)[0], where a mechanically obvious rule matters more than a
// convenient one.
import { inView } from "./sub-part-views.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// A sub-part counts toward a view when it lists that view and is enabled at the
// part's defaults. A throwing `enabled` counts as present: the same instinct as
// mount's throwing-`derive` handling, and an unrelated predicate bug shouldn't
// silently demote a whole view.
function placedCount(part, view, defaults) {
  const parts = isPlainObject(part?.parts) ? part.parts : {};
  let n = 0;
  for (const sp of Object.values(parts)) {
    if (!inView(sp, view)) continue;
    if (typeof sp.enabled !== "function") { n++; continue; }
    try { if (sp.enabled(defaults)) n++; } catch { n++; }
  }
  return n;
}

export function resolveDefaultView(part) {
  if (!isPlainObject(part?.views)) return null;
  const keys = Object.keys(part.views);
  if (keys.length === 0) return null;

  const flagged = keys.find((k) => part.views[k]?.default === true);
  if (flagged) return flagged;

  const defaults = isPlainObject(part?.defaults) ? part.defaults : {};
  let best = keys[0];
  let bestCount = placedCount(part, best, defaults);
  for (const k of keys.slice(1)) {
    const n = placedCount(part, k, defaults);
    if (n > bestCount) { best = k; bestCount = n; } // strict > keeps a tie on the earlier key
  }
  return best;
}
