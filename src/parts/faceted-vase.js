// Example PartDefinition — the motivating showcase for k.loft(). Silhouette rings are
// stacked up a smooth base→waist→rim curve; each ring is a regular n-gon rotated by a
// running twist plus an alternating half-facet offset, so the facets zig-zag into a
// woven look. A second, wall-inset loft is cut from the body to hollow it (Manifold
// backend, so it stays fast — no OCCT). See docs/AUTHORING-PARTS.md for the conventions.

const RINGS = 28; // silhouette resolution (ring count up the height)

// Body radius at height fraction t (0..1): a quadratic Bézier through base/waist/rim.
const silhouette = (t, p) => { const a = 1 - t; return a * a * p.baseR + 2 * a * t * p.waistR + t * t * p.rimR; };

// Ring list for a wall at radial `inner` inset (offset along the face normal so the
// perpendicular wall stays == p.wall on every facet). inner=false → outer surface.
const vaseRings = (p, inner) => {
  const inset = inner ? p.wall / Math.cos(Math.PI / p.facets) : 0;
  const out = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const radius = Math.max(silhouette(t, p) - inset, 0.5);
    const rotate = p.twist * t + (i % 2) * (180 / p.facets); // running twist + alternating half-facet
    out.push({ sides: p.facets, radius, z: p.height * t, rotate });
  }
  return out;
};

export default {
  meta: { title: "Faceted Vase", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "body",
      title: "Body",
      description: "A faceted, twisting vase built from stacked cross-sections (`k.loft`). " +
        "Pick a preset, or open **Advanced** for exact dimensions. **Facets** and **Twist** are the styling; **Wall** decides whether it prints cleanly.",
      presets: {
        "Tulip vase": { height: 150, baseR: 35, waistR: 26, rimR: 40, facets: 5, twist: 40, wall: 2 },
        "Barrel pot": { height: 90, baseR: 40, waistR: 44, rimR: 38, facets: 8, twist: 0, wall: 2.4 },
        "Twist column": { height: 180, baseR: 30, waistR: 30, rimR: 30, facets: 6, twist: 120, wall: 2 },
      },
      advanced: [
        { key: "height", label: "Height", unit: "mm", min: 40, max: 220, step: 1, description: "Overall height along the axis." },
        { key: "baseR", label: "Base radius", unit: "mm", min: 15, max: 70, step: 1, description: "Across-corners radius at the foot." },
        { key: "waistR", label: "Waist radius", unit: "mm", min: 12, max: 80, step: 1, description: "Radius at mid-height — set below base+rim to pinch a waist, above to bulge a belly." },
        { key: "rimR", label: "Rim radius", unit: "mm", min: 12, max: 80, step: 1, description: "Across-corners radius at the mouth." },
        { key: "facets", label: "Facets", min: 3, max: 12, step: 1, description: "Sides of each cross-section. Low counts read crystalline; high counts approach smooth." },
        { key: "twist", label: "Twist", unit: "°", min: 0, max: 180, step: 5, description: "Total rotation of the facets from foot to rim, for a spiral." },
        { key: "wall", label: "Wall thickness", unit: "mm", min: 1, max: 5, step: 0.1, description: "Perpendicular wall thickness. The fdm-pla profile wants **≥ 1.2 mm**." },
        { key: "floor", label: "Floor thickness", unit: "mm", min: 1, max: 8, step: 0.5, hidden: true, description: "Internal: solid base thickness; hidden but drives the geometry." },
      ],
    },
  ],
  defaults: { height: 150, baseR: 35, waistR: 26, rimR: 40, facets: 5, twist: 40, wall: 2, floor: 3 },
  parts: {
    vase: {
      label: "Vase", views: ["vase"], export: { name: "vase" },
      build: (k, p) => {
        const body = k.loft({ rings: vaseRings(p, false) }).label("Faceted wall");
        // Hollow it: an inset loft clipped to z ≥ floor (so the base stays solid), cut from the body.
        const cavity = k.loft({ rings: vaseRings(p, true) })
          .intersect(k.box({ min: [-1e4, -1e4, p.floor], max: [1e4, 1e4, p.height + 10] })).label("Cavity");
        return body.cut(cavity);
      },
    },
  },
  views: { vase: { label: "Vase" } },
  // Self-verification: opt into the FDM-PLA profile (bed-fit gate + min-wall warning) and
  // pin the intent — an open vessel (no through-holes), fits the bed, no interpenetration.
  verify: {
    process: "fdm-pla",
    expect: {
      vase: { holes: 0, bbox: "<=[220,220,230]" },
      _view: { overlaps: 0 },
    },
  },
};
