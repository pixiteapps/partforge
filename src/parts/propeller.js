// THE reference part for organic lofted geometry (docs/AUTHORING-PARTS.md "Smooth
// organic lofts"): a boat propeller — bored hub + N airfoil blades, each blade one
// `k.loftSmooth` of 5 sparse control sections. If you are building a boat propeller,
// a fan, an impeller, or an airplane prop, start from this file: the blade recipe
// (airfoil ring → chord/twist schedule up the span → smooth loft → radial placement)
// is the whole pattern, and everything else is ordinary hub plumbing.
//
// Vocabulary → code:
//   span       — blade length root→tip (the loft's z axis, before placement)
//   chord      — airfoil width at a station (`rootChord`→`tipChord` × CHORD_MUL)
//   pitch      — per-section `rotate` (deg): angle between chord and rotation plane
//   washout    — the root→tip pitch DROP (`twistRoot` > `twistTip`), standard on
//                real props/fans so the tip doesn't stall/over-bite
//   camber     — curvature of the airfoil midline (% chord): lift/thrust asymmetry
//   handedness — `lefthand` mirrors every section and negates pitch: a true
//                mirror-image prop for counter-rotating pairs or reversed shafts
//
// The blade-frame trick: each blade is lofted SPAN-UP (+Z), so its sections are
// plain 2-D rings and `rotate` is exactly the pitch angle; `rotateY(90)` then lays
// it radial along +X, where the chord sits in the axis/rotation-plane frame. Clone
// and `rotateZ` for the other blades; never author sections in the placed frame.
//
// Adapting this part (change parameters, not plumbing):
//   boat propeller — the defaults: 3 blades, high pitch (62°→30°), thick sections,
//     generous camber, stubby hub. Wide-chord "kaplan" styles: raise CHORD_MUL mid.
//   fan / desk fan — more blades (4–6+), FLAT pitch (`twistRoot` ~35°, `twistTip`
//     ~20°), thin sections (`thickness` 5–8%), modest camber (2–4%), longer span
//     relative to hub. Reversible fans want `camber: 0` (symmetric sections).
//   airplane prop — 2 blades, long span, small chord, washout similar to defaults.
//   counter-rotating pair — build twice, second with `lefthand: 1`.
// Leave alone: the loft/`sharp` plumbing, the blade frame, the CCW/TE-at-vertex-0
// contracts of `airfoil()` below.
//
// The "Surface" section is didactic, not part of the propeller: untick **Smooth**
// to see the raw `k.loft` of the same sparse sections (the chunky failure mode
// `loftSmooth` exists to fix). Contract: docs/KERNEL-CONTRACT.md `loftSmooth` row.
// Specs: docs/superpowers/specs/2026-08-24-loft-smooth-design.md,
//        docs/superpowers/specs/2026-08-25-loft-smooth-v2-design.md

/**
 * NACA-4-ish airfoil section as a closed CCW point ring.
 * Contract (relied on by `bladeSections` and the `sharp` tag): the ring starts at
 * the TRAILING EDGE (vertex 0), runs TE→LE along the upper surface, LE→TE along
 * the lower, stays CCW, and is centered near the quarter chord so per-section
 * `rotate` pitches about a sensible axis. `n` points per surface; cosine spacing
 * clusters points at the leading edge — exactly the uneven spacing loftSmooth's
 * centripetal resampler is built for, so ~12 points per surface is plenty.
 * @param {number} chord     section width, mm
 * @param {number} thickPct  max thickness, % of chord
 * @param {number} camberPct midline camber, % of chord (0 = symmetric)
 * @param {number} n         points per surface (ring has 2n vertices)
 */
export const airfoil = (chord, thickPct, camberPct, n) => {
  const t = thickPct / 100, m = camberPct / 100, p = 0.4;
  const yt = (x) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = (x) => (x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x));
  const upper = [], lower = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2; // cosine spacing, LE→TE
    upper.push([x, yc(x) + yt(x)]);
    lower.push([x, yc(x) - yt(x)]);
  }
  // TE→LE along the top, LE→TE along the bottom; drop duplicated LE/TE points.
  const pts = [...upper.reverse().slice(0, -1), ...lower.slice(1)];
  return pts.map(([x, y]) => [(x - 0.3) * chord, y * chord]);
};

// Mirror a section ring across its chord (y → −y) for a lefthand blade, keeping
// both `airfoil()` contracts intact: re-reversing the order restores CCW winding,
// and pinning the first point keeps the trailing edge at vertex 0 for `sharp`.
const mirrorRing = (pts) => {
  const m = pts.map(([x, y]) => [x, -y]);
  return [m[0], ...m.slice(1).reverse()];
};

// The blade's spanwise schedules. SPAN_T places the 5 control stations along the
// span (clustered toward the tip, where shape changes fastest); CHORD_MUL shapes
// the outline on top of the root→tip chord taper — widest mid-span, closing to a
// rounded tip. This is where a different blade silhouette lives.
const SPAN_T = [0, 0.3, 0.6, 0.85, 1];
const CHORD_MUL = [1, 1.12, 1.0, 0.72, 0.28];

/**
 * The 5 sparse control sections for one blade, span-up: `{polygon, z, rotate,
 * sharp?}` ring specs ready for `k.loftSmooth({sections})`. Chord tapers
 * root→tip (× CHORD_MUL), thickness thins 45% toward the tip, pitch interpolates
 * `twistRoot`→`twistTip` (washout). `lefthand` mirrors each ring and negates
 * pitch — together exactly a mirror of the whole blade.
 */
export const bladeSections = (p) =>
  SPAN_T.map((t, i) => {
    const ring = airfoil(
      (p.rootChord + (p.tipChord - p.rootChord) * t) * CHORD_MUL[i],
      p.thickness * (1 - 0.45 * t), // blades thin toward the tip
      p.camber,
      p.sectionPts,
    );
    return {
      polygon: p.lefthand ? mirrorRing(ring) : ring,
      // The trailing edge is the ring's two end vertices (upper TE vertex 0, lower
      // TE the last) — this NACA closure (coefficient -0.1036) already brings them
      // together at the same point, so the "gap" between them is a genuine zero-
      // length edge, not a blunt base. Tagging vertex 0 as the single corner keeps
      // that meeting point a crease instead of letting the CR spline round it off;
      // a *second* tag at the last vertex would mark a zero-length arc between two
      // coincident corners, which — after the per-section pitch `rotate` below
      // collapses their sub-epsilon separation to bit-identical floats — the
      // resampler rejects as a zero-perimeter section.
      ...(p.sharpTE && p.smooth ? { sharp: [0] } : {}),
      z: p.span * t,
      rotate: (p.lefthand ? -1 : 1) * (p.twistRoot + (p.twistTip - p.twistRoot) * t),
    };
  });

export default {
  meta: { title: "Propeller", units: "mm", background: 0x15181d, environment: "studio" },
  parameters: [
    {
      id: "prop",
      title: "Propeller",
      description: "A boat propeller: bored hub + airfoil blades, every blade surface a `loftSmooth` of 5 sparse control sections. Also the starting point for fans and airplane props — see the file header's \"Adapting this part\".",
      controls: [
        { key: "blades", label: "Blades", min: 2, max: 6, step: 1,
          description: "Boat props: 3–4. Fans: 4–6. Airplane props: 2." },
        { key: "span", label: "Blade span", unit: "mm", min: 30, max: 120, step: 1,
          description: "Root-to-tip blade length. Overall diameter ≈ hub + 2×span." },
        { key: "rootChord", label: "Root chord", unit: "mm", min: 10, max: 50, step: 1,
          description: "Airfoil width where the blade meets the hub." },
        { key: "tipChord", label: "Tip chord", unit: "mm", min: 6, max: 40, step: 1,
          description: "Airfoil width at the tip, before the outline's own taper closes it." },
        { key: "twistRoot", label: "Root pitch", unit: "°", min: 0, max: 80, step: 1,
          description: "Blade angle at the root; 0° puts the chord in the rotation plane. Boat props run steep (50–70°); fans flat (25–40°)." },
        { key: "twistTip", label: "Tip pitch", unit: "°", min: 0, max: 80, step: 1,
          description: "Blade angle at the tip. Keep it below root pitch (washout) so the tip doesn't over-bite." },
        { key: "thickness", label: "Thickness", unit: "%", min: 4, max: 25, step: 1,
          description: "Airfoil thickness as % of chord, at the root (thins 45% toward the tip). Boat props 10–15%; fans 5–8%." },
        { key: "camber", label: "Camber", unit: "%", min: 0, max: 12, step: 1,
          description: "Midline curvature as % of chord — the thrust asymmetry. 0 = symmetric section (reversible fans)." },
        { key: "lefthand", type: "checkbox", label: "Left-hand rotation",
          description: "Mirror-image blades for a counter-rotating pair or a reversed shaft. Every section mirrors and pitch negates — a true mirror of the whole propeller." },
        { type: "group", title: "Hub", collapsed: "auto", controls: [
          { key: "hubD", label: "Hub diameter", unit: "mm", min: 14, max: 60, step: 1,
            description: "Blade roots sink to 62% of hub radius, so the union always has generous overlap." },
          { key: "hubH", label: "Hub length", unit: "mm", min: 10, max: 60, step: 1 },
          { key: "boreD", label: "Shaft bore", unit: "mm", min: 2, max: 20, step: 0.5,
            description: "Through-hole for the shaft — the part's one expected hole (see `verify`)." },
        ] },
      ],
    },
    {
      id: "surface",
      title: "Surface",
      description: "**Smooth** interpolates the 5 sparse control sections with `loftSmooth`; off shows the raw `k.loft` of the same sections. **Sharp trailing edge** tags the TE vertex as a crease instead of letting the spline smear it. **Stations/Samples** are the densifier resolution; **Section points** is how sparse the control sections are.",
      controls: [
        { key: "smooth", type: "checkbox", label: "Smooth (loftSmooth)",
          description: "A/B toggle: spline-densified vs raw loft of identical control sections. Leave ON in real parts — the raw loft is the chunky failure mode." },
        { key: "sharpTE", type: "checkbox", label: "Sharp trailing edge", when: { smooth: 1 },
          description: "Tags the trailing-edge vertex as a true corner — the spline interpolates it with a crease instead of smearing it round." },
        { key: "stations", label: "Stations", min: 5, max: 128, step: 1, when: { smooth: 1 },
          description: "Interpolated rings along the span. The default (48) is visually converged; more costs build time." },
        { key: "samples", label: "Samples / ring", min: 16, max: 512, step: 4, when: { smooth: 1 },
          description: "Spline-fit resolution around each ring. STEP file size scales with this; volume converges by ~48." },
        { key: "sectionPts", label: "Section points", min: 6, max: 40, step: 1,
          description: "Points per airfoil *surface* in each control section — the sparse input both paths share." },
      ],
    },
  ],
  defaults: {
    blades: 3, span: 70, rootChord: 26, tipChord: 16, twistRoot: 62, twistTip: 30,
    thickness: 12, camber: 6, lefthand: 0, hubD: 30, hubH: 26, boreD: 8,
    smooth: 1, sharpTE: 1, stations: 48, samples: 128, sectionPts: 12,
  },
  parts: {
    propeller: {
      label: "Propeller", views: ["propeller"], export: { name: "propeller" },
      display: { material: "brushed-aluminum" },
      build: (k, p) => {
        const sections = bladeSections(p);
        const bladeUp = p.smooth
          ? k.loftSmooth({ sections, stations: p.stations, samples: p.samples })
          : k.loft({ rings: sections });
        // Built span-up (+Z); lay it radial along +X — the airfoil chord then sits
        // in the axis/rotation-plane frame, so `rotate` above reads as pitch angle.
        // Root sinks to 62% of hub radius so the union has generous overlap.
        const blade = bladeUp.rotateY(90).translate([p.hubD * 0.31, 0, 0]).label("Blade");
        const blades = [];
        for (let i = 0; i < p.blades; i++) blades.push(blade.clone().rotateZ((360 / p.blades) * i));
        const hub = k.cylinder({ r: p.hubD / 2, h: p.hubH })
          .translate([0, 0, -p.hubH / 2]).label("Hub")
          .cut(k.cylinder({ r: p.boreD / 2, h: p.hubH + 4 }).translate([0, 0, -p.hubH / 2 - 2]).label("Bore"));
        return k.union([hub, ...blades]);
      },
    },
  },
  views: { propeller: { label: "Propeller" } },
  verify: {
    expect: {
      // holes: 1 — exactly the shaft bore; a second hole means a blade/hub union
      // gap. bbox bounds catch a runaway parameter. overlaps: 0 — the union must
      // leave one watertight body, no interpenetrating leftovers.
      propeller: { holes: 1, bbox: "<=[300,300,300]" },
      _view: { overlaps: 0 },
    },
  },
};
