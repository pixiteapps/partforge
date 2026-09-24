// Example PartDefinition — a faceted planter / cup / vase. A second worked example
// alongside parts/demo.js (the Spacer): it shows a prism-based body (Manifold backend,
// so it stays fast — no OCCT), per-control descriptions, presets, an optional feature
// (drainage), a hidden internal constant (floor), and a derive() that turns raw inputs
// into the n-gon point lists and dependent dimensions the build consumes.
//
// Why it's a good demo: every control has an obvious reason to touch it before
// printing. Facets/twist are pure fun, height/diameter/taper fit it to your plant or
// pens, the drainage hole is a real functional choice (planter vs. cup), and dropping
// Wall below the fdm-pla 1.2 mm minimum trips partforge's min-wall warning.

import { offsetPolygon } from "partforge/geometry";

// A regular n-gon of circumradius R, in the XY plane, as [[x,y],…] for k.prism.
// A small rotation seats a flat edge toward the viewer so even-sided shapes read right.
const ngon = (R, n) => {
  const pts = [];
  const offset = Math.PI / n - Math.PI / 2; // flat side facing -Y
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n + offset;
    pts.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return pts;
};

export default {
  meta: { title: "Faceted Planter", units: "mm", background: 0x15181d, environment: "print-bed" },
  parameters: [
    {
      id: "body",
      title: "Body",
      description:
        "The faceted vessel. Pick a preset to start, or dial exact dimensions below — " +
        "**Facets** and **Twist** are pure styling; open **Wall** for the one that decides whether it prints cleanly.",
      controls: [
        { type: "preset", presets: {
          "Pen cup": { facets: 6, dia: 80, height: 100, taper: 1.0, twist: 0, drain: 0 },
          Planter: { facets: 8, dia: 90, height: 80, taper: 0.9, twist: 0, drain: 8 },
          Vase: { facets: 5, dia: 70, height: 150, taper: 1.12, twist: 40, drain: 0 },
        } },
        { key: "facets", type: "slider", label: "Facets", min: 3, max: 12, step: 1,
          description: "Number of flat sides around the body. Low counts read as crystalline; high counts approach a smooth cylinder." },
        { key: "dia", type: "slider", label: "Diameter", unit: "mm", min: 30, max: 150, step: 1,
          description: "Across-corners diameter at the base. Size it to the plant, pens, or shelf it has to fit." },
        { key: "height", type: "slider", label: "Height", unit: "mm", min: 20, max: 200, step: 1,
          description: "Overall height along the axis." },
        { key: "taper", type: "slider", label: "Top taper", min: 0.6, max: 1.4, step: 0.02,
          description: "Rim size relative to the base: below 1 tapers inward (planter), 1 is straight (cup), above 1 flares out (vase)." },
        { key: "twist", type: "slider", label: "Twist", unit: "°", min: 0, max: 180, step: 5,
          description: "Rotates the facets from base to rim for a spiral look. 0 keeps the facets vertical." },
        { type: "group", title: "Wall", collapsed: "auto", controls: [
          { key: "wall", type: "slider", label: "Wall thickness", unit: "mm", min: 0.8, max: 4, step: 0.1,
            recommended: [1.2, 4],
            description: "Side-wall thickness. The fdm-pla profile wants **≥ 1.2 mm** — go thinner and partforge flags a min-wall warning." },
          { type: "readout", label: "Inner diameter", derivedKey: "innerDia", unit: "mm",
            description: "Clear inside width at the base, after the walls." },
          { key: "floor", type: "slider", label: "Floor thickness", unit: "mm", min: 1, max: 6, step: 0.5, hidden: true,
            description: "Internal: solid base thickness, fixed by the design. Hidden from the end user but still drives the geometry." },
        ] },
      ],
    },
    {
      id: "drainage",
      title: "Drainage",
      description: "Optional drainage hole through the base — turn it on for a planter, off to hold water like a cup or vase.",
      features: [
        { label: "Drainage hole", key: "drain", on: 8,
          description: "Drills a centered hole of this diameter through the floor.",
          sliders: [{ key: "drain", label: "Hole diameter", unit: "mm", min: 3, max: 30, step: 1,
            description: "Diameter of the centered drainage hole." }] },
      ],
    },
  ],
  defaults: { facets: 6, dia: 70, height: 90, taper: 1.2, wall: 1.6, twist: 30, drain: 8, floor: 3 },
  // derive(): turn raw inputs into the n-gon point lists and dependent dimensions the
  // build needs, sized so the wall stays even (see build()).
  derive: (p) => {
    const Rout = p.dia / 2;
    // Inset the outer polygon inward by `wall` along the FACE normals via
    // offsetPolygon (sharp corners keep the n-gon exact — see the closed-form
    // pin in test/offset-polygon.test.js). Cap the wall so the inset can never
    // collapse below circumradius 1 — same clamp as the old closed form (only
    // matters if wall is set past the slider bounds via the API).
    const wall = Math.min(p.wall, (Rout - 1) * Math.cos(Math.PI / p.facets));
    const outerPts = ngon(Rout, p.facets);
    const innerPts = offsetPolygon(outerPts, -wall, { corners: "sharp" });
    const Rin = Math.hypot(innerPts[0][0], innerPts[0][1]);   // read back from the geometry
    return {
      outerPts,
      innerPts,
      // Inner taper that holds the wall constant top-to-bottom even as the body flares:
      // pick it so inner_radius(top) = outer_radius(top) − wall.
      innerTaper: 1 + (Rout * (p.taper - 1)) / Rin,
      drainR: (p.drain + 0.2) / 2, // nominal hole + 0.2 mm print clearance, as a radius
      innerDia: 2 * Rin, // across-corners inner diameter at the base, after the wall inset
    };
  },
  parts: {
    planter: {
      label: "Planter",
      views: ["planter"],
      export: { name: "planter" },
      display: { material: "pla-print", color: 0xc4622d },
      build: (k, p, d) => {
        const body = k.prism({ points: d.outerPts, h: p.height, scaleTop: p.taper, twist: p.twist }).label("Faceted wall");
        // Hollow it. The cavity is built from z=0 sharing the body's exact twist RATE and
        // taper slope (f rescales the ~4 mm overshoot so the rates still match), so the
        // inner and outer facets stay radially aligned at every height — the wall can't
        // pinch when twisted. Then clip the cavity to z ≥ floor so the base stays solid.
        const f = (p.height + 4) / p.height;
        const cavity = k
          .prism({ points: d.innerPts, h: p.height + 4, scaleTop: 1 + (d.innerTaper - 1) * f, twist: p.twist * f })
          .intersect(k.box({ min: [-1e4, -1e4, p.floor], max: [1e4, 1e4, p.height + 10] }))
          .label("Cavity");
        let s = body.cut(cavity);
        // Optional drainage hole straight through the base.
        if (p.drain > 0) s = s.cut(k.cylinder({ r: d.drainR, h: p.floor + 4 }).at([0, 0, -2]).label("Drainage hole"));
        return s;
      },
    },
  },
  views: { planter: { label: "Planter" } },
  // Self-verification (see docs/AUTHORING-PARTS.md "Self-verification"): opt into the
  // FDM-PLA process profile (bed-fit gate + min-wall warning) and pin the design intent
  // — fits the bed, no interpenetration, and the RIGHT genus per case: verify runs
  // across every preset, and "Pen cup"/"Vase" turn the drain off, so `expect` is a
  // function of the case's params rather than one static hole count.
  verify: {
    process: "fdm-pla",
    expect: (p) => ({
      planter: { holes: p.drain > 0 ? 1 : 0, bbox: "<=[220,220,250]" },
      _view: { overlaps: 0 } /* _view = whole-model composite (not a named part) */,
    }),
  },
};
