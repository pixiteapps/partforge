// Which parameter keys a clicked spot offers. Pure: imports nothing.

export const SPOT_CAP = 3;

// Face keys when the face is known, else the piece's; excluded and undrawable
// keys drop before the cap; `more` says the cap cut something.
export function resolveSpotKeys({ faceKeys = null, pieceKeys = [], excluded = new Set(), drawable = new Set(), cap = SPOT_CAP } = {}) {
  const useFace = Array.isArray(faceKeys) && faceKeys.length > 0;
  const keep = (k) => !excluded.has(k) && drawable.has(k);
  const first = (useFace ? faceKeys : pieceKeys).filter(keep);
  const full = [...first];
  const seen = new Set(first);
  for (const k of [...(useFace ? faceKeys : []), ...pieceKeys]) {
    if (keep(k) && !seen.has(k)) { seen.add(k); full.push(k); }
  }
  const keys = [...new Set(first)].slice(0, cap);
  if (keys.length === 0) return { keys: [], source: null, more: false };
  return { keys, source: useFace ? "face" : "piece", more: full.length > keys.length };
}

// The keys the hit triangle's face run was built from, or null.
export function faceKeysOf(origins, hit) {
  if (!origins || !hit || hit.onCutPlane) return null;
  const id = origins.originIds?.[hit.triIndex];
  if (!id) return null;
  return origins.origins?.[id - 1] ?? null;
}

// Whether a handle belongs to the clicked piece.
export function handleOnPiece(handle, name, { point = null, bounds = null, slack = 2 } = {}) {
  const on = handle?.showOn;
  if (on != null) return Array.isArray(on) ? on.includes(name) : on === name;
  if (!point || !bounds) return false;
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(point[i])) return false; // NaN passes both comparisons below
    if (point[i] < bounds.min[i] - slack || point[i] > bounds.max[i] + slack) return false;
  }
  return true;
}
