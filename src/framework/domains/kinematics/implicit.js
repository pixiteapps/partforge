// The implicit adapter of one posed limb: flesh() and attach() write plain k.implicit data
// (a capsule-chain node and a contact `attach` entry) over the limb's own frames. Plain data
// only — this file imports nothing from the implicit engine. Every value they pass through is
// checked here, so a bad one names the limb rather than a node deep in the spec.

const show = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));

/** `{ flesh, attach }` for a posed limb; `fail(field, problem)` throws the limb's SpecError. */
export function implicitAdapters(tree, fail) {
  const { name, joints } = tree;
  const base = joints[0].frame;
  const hasLength = joints.some((j) => j.length > 0);
  const NO_LENGTH = "the limb has no segment with length > 0";
  const positive = (field, v) => { if (!(Number.isFinite(v) && v > 0)) fail(field, `must be a number > 0, got ${show(v)}`); };
  const nonEmpty = (field, v) => { if (typeof v !== "string" || v.length === 0) fail(field, "must be a non-empty string"); };

  /** A `union` (k = blend) of one tapered capsule per non-zero-length segment, in its joint's frame. */
  function flesh({ r = tree.r, blend, label = name } = {}) {
    if (r == null) fail("", "flesh needs r — pass r, or set r on the limb");
    if (!Array.isArray(r) || r.length !== joints.length + 1) fail("r", `expected ${joints.length + 1} radii, got ${Array.isArray(r) ? r.length : r}`);
    r.forEach((v, i) => positive(`r[${i}]`, v));
    if (blend !== undefined && !(Number.isFinite(blend) && blend >= 0)) fail("blend", `must be a number ≥ 0, got ${show(blend)}`);
    nonEmpty("label", label);
    if (!hasLength) fail("flesh", NO_LENGTH);
    const children = [];
    joints.forEach((j, i) => {
      if (j.length === 0) return;
      children.push({ kind: "capsule", frame: j.frame, b: [0, j.length, 0], r: [r[i], r[i + 1]], label: j.frame });
    });
    return blend === undefined ? { kind: "union", label, children } : { kind: "union", k: blend, label, children };
  }

  /**
   * A contact `attach` entry joining the flesh (label `a`, default the limb's name) to the
   * piece `label`, near the base joint. Defaults from the fixture hand: `radius` a third of
   * the first non-zero segment, `band` 3 mm scaled by the base radius over 9.5 mm.
   */
  function attach(label, { k, radius, band, r, a = name } = {}) {
    nonEmpty("label", label);
    nonEmpty("a", a);
    if (label === a) fail("attach", `cannot join ${show(label)} to itself — pass the other piece's label`);
    if (!(Number.isFinite(k) && k >= 0)) fail("attach", `k is required (the blend width in mm where the limb joins ${label})`);
    if (!hasLength) fail("attach", NO_LENGTH);
    const r0 = r ?? tree.r;
    if (band == null && r0 == null) fail("", "attach needs r for its default band — pass band or r");
    if (band == null && !(Array.isArray(r0) && Number.isFinite(r0[0]))) fail("", "attach r must be an array with a finite first radius — pass r: [r0, …] or band");
    radius ??= joints.find((j) => j.length > 0).length / 3;
    band ??= (3 * r0[0]) / 9.5;
    positive("radius", radius);
    positive("band", band);
    return { a, b: label, near: base, radius, band, k };
  }

  return { flesh, attach };
}
