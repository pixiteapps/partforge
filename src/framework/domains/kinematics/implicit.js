// The implicit adapter of one posed limb: flesh() and attach() write plain k.implicit data
// (a capsule-chain node and a contact `attach` entry) over the limb's own frames. Plain data
// only — this file imports nothing from the implicit engine; k.implicit validates it.

/** `{ flesh, attach }` for a posed limb; `fail(field, problem)` throws the limb's SpecError. */
export function implicitAdapters(tree, fail) {
  const { name, joints } = tree;
  const base = joints[0].frame;

  /** A `union` (k = blend) of one tapered capsule per non-zero-length segment, in its joint's frame. */
  function flesh({ r = tree.r, blend, label = name } = {}) {
    if (r == null) fail("", "flesh needs r — pass r, or set r on the limb");
    if (!Array.isArray(r) || r.length !== joints.length + 1) fail("r", `expected ${joints.length + 1} radii, got ${Array.isArray(r) ? r.length : r}`);
    const children = [];
    joints.forEach((j, i) => {
      if (j.length === 0) return;
      children.push({ kind: "capsule", frame: j.frame, b: [0, j.length, 0], r: [r[i], r[i + 1]], label: j.frame });
    });
    return { kind: "union", k: blend, label, children };
  }

  /**
   * A contact `attach` entry joining the flesh (label `a`, default the limb's name) to the
   * piece `label`, near the base joint. Defaults from the fixture hand: `radius` a third of
   * the first non-zero segment, `band` 3 mm scaled by the base radius over 9.5 mm.
   */
  function attach(label, { k, radius, band, r, a = name } = {}) {
    const r0 = r ?? tree.r;
    if (band == null && r0 == null) fail("", "attach needs r for its default band — pass band or r");
    if (band == null && !(Array.isArray(r0) && Number.isFinite(r0[0]))) fail("", "attach r must be an array with a finite first radius — pass r: [r0, …] or band");
    radius ??= (joints.find((j) => j.length > 0)?.length ?? 0) / 3;
    band ??= (3 * r0[0]) / 9.5;
    return { a, b: label, near: base, radius, band, k };
  }

  return { flesh, attach };
}
