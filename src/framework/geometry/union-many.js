// Union of many Shape2Ds — the text2d / vector2d reduction — without the
// quadratic left fold those ops used to run.
//
// `shapes.reduce((a, b) => a.union(b))` hands paper.js the WHOLE accumulated
// result on every step, so n glyphs cost about n²/2 glyph conversions plus n
// planar booleans over an ever-growing compound path. Measured on a 4-line,
// 290-glyph paragraph (feedback #169, a bathroom sign): 14 s for text2d alone,
// over a minute for the forge. Two independent savings, applied in order:
//
//   1. Shapes whose bounding boxes do not touch cannot share a point, so their
//      union is just their regions side by side — no boolean at all. Text is
//      almost entirely this case: letters sit apart, and only a kerned pair, a
//      script face or negative tracking makes neighbours overlap. Shapes are
//      grouped into clusters whose boxes overlap (transitively); the clusters
//      are mutually disjoint, so concatenating them IS the union.
//   2. Inside a cluster that does need booleans, the union is balanced
//      (pairs, then pairs of pairs), so each shape is converted O(log n)
//      times instead of O(n).
//
// Bounds are paper's exact curve bounds (Shape2D.boundingBox), padded by EPS so
// shapes that merely touch along an edge still meet a boolean — touching
// glyphs must fuse, not sit as two regions sharing an edge.
//
// Deterministic: clusters are emitted in the order of their first member, and
// members keep input order, so the same inputs give the same regions (and so
// the same Shape2D hash — build purity rests on it).
const EPS = 1e-6;

// `fromContours` builds a Shape2D from a list of already-resolved regions (the
// kernel's k.shape2d.trusted) — passed in so this module needs no kernel.
export function unionMany(shapes, fromContours) {
  if (shapes.length === 0) throw new Error("unionMany: no shapes");
  if (shapes.length === 1) return shapes[0];

  const boxes = shapes.map((s) => s.boundingBox());
  const n = shapes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  // Sweep in x: `active` holds every box whose x-range can still reach the
  // current one. Worst case (a vertical column of shapes) is O(n²) box checks —
  // cheap arithmetic, nothing like the booleans it saves.
  const order = [...boxes.keys()].sort((a, b) => boxes[a].min[0] - boxes[b].min[0] || a - b);
  let active = [];
  for (const i of order) {
    const bi = boxes[i];
    active = active.filter((j) => boxes[j].max[0] + EPS >= bi.min[0]);
    for (const j of active) {
      const bj = boxes[j];
      if (bj.min[1] - EPS <= bi.max[1] && bi.min[1] - EPS <= bj.max[1]) join(i, j);
    }
    active.push(i);
  }

  const clusters = new Map();                       // root → member indices, input order
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(i);
  }

  const merged = [...clusters.values()].map((members) => balancedUnion(members.map((i) => shapes[i])));
  if (merged.length === 1) return merged[0];
  return fromContours(merged.flatMap((s) => s.toContours()));
}

function balancedUnion(xs) {
  while (xs.length > 1) {
    const next = [];
    for (let i = 0; i < xs.length; i += 2) next.push(i + 1 < xs.length ? xs[i].union(xs[i + 1]) : xs[i]);
    xs = next;
  }
  return xs[0];
}
