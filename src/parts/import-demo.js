// Reference part for docs/AUTHORING-PARTS.md's "Importing geometry" section —
// and for its "Probes" section (the `probes` block below measures the import
// live into the measure report) — the worked example for BOTH import uses in
// one part:
//   • reference — `ref` is the imported scan as a non-exported sub-part;
//     `body` is a parametric rebuild of the same block, compared against it
//     via `reference: "ref"` and held to it by the three ref*
//     deviation metrics in `verify.expect.body`.
//   • component — `mount` uses the import as a real boolean tool: a plate
//     with a through-socket cut to the scan's own shape (scaled up by `fit`
//     for clearance), exported like any other sub-part.
// `src/parts/assets/import-demo-scan.stl` is a small hand-written ascii STL —
// a 20×14×8 mm block, origin-cornered, outward-wound. `body`'s defaults
// reproduce those dimensions exactly, so the deviation gate passes with real
// margin. Open /import-demo.html after `npm run dev`.
export default {
  meta: { title: "Import demo", units: "mm", background: 0x15181d },
  imports: {
    scan: new URL("./assets/import-demo-scan.stl", import.meta.url),
  },
  parameters: [
    {
      id: "scan",
      title: "Scan",
      description: "Dimensions of the parametric rebuild (`body`). Defaults match the imported reference block exactly — drag one and watch the deviation gate in `partforge measure` react.",
      advanced: [
        { key: "scanW", label: "Width", unit: "mm", min: 10, max: 40, step: 0.5,
          description: "Rebuild width (X). Matches the scan's width at the default." },
        { key: "scanD", label: "Depth", unit: "mm", min: 10, max: 40, step: 0.5,
          description: "Rebuild depth (Y). Matches the scan's depth at the default." },
        { key: "scanH", label: "Height", unit: "mm", min: 4, max: 20, step: 0.5,
          description: "Rebuild height (Z). Matches the scan's height at the default." },
      ],
    },
    {
      id: "mount",
      title: "Mount",
      description: "A plate with a through-socket cut to the scan's own shape — the import used as a real boolean component, not just a reference.",
      advanced: [
        { key: "fit", label: "Socket clearance", unit: "×", min: 1, max: 1.2, step: 0.01,
          description: "Uniform scale applied to the imported scan before it's used as the cutting tool, so the block seats with a slip fit." },
        { key: "margin", label: "Plate margin", unit: "mm", min: 1, max: 10, step: 0.5,
          description: "Solid plate border kept around the socket on every side." },
        // The socket is the scan's own (fixed, ~8mm-tall) imported geometry scaled
        // by `fit` and overcut 1mm past the plate's bottom face — see `mount.build`
        // below. It only stays a genuine through-hole (not a blind pocket) while
        // plateH < scanH*fit - 1; at the worst-case corner (fit at its slider
        // minimum, 1) that's plateH < 7. max is capped at 6.5, half a millimetre
        // inside that bound, so every reachable (plateH, fit) combination — not
        // just the defaults — keeps `mount: { holes: 1 }` true.
        { key: "plateH", label: "Plate thickness", unit: "mm", min: 2, max: 6.5, step: 0.5,
          description: "Mount plate thickness. The socket cuts all the way through it." },
        { key: "gap", label: "Gap from rebuild", unit: "mm", min: 5, max: 30, step: 1,
          description: "Presentation-only spacing between `body` and `mount` in the assembly view, so the two never overlap." },
      ],
    },
  ],
  defaults: { scanW: 20, scanD: 14, scanH: 8, fit: 1.05, margin: 3, plateH: 4, gap: 10 },
  // mountOffsetX: how far along X the mount plate sits from the rebuild, so
  // the two solids never interpenetrate regardless of the current dimensions.
  derive: (p) => ({ mountOffsetX: p.scanW + p.gap }),
  parts: {
    // The raw import as a sub-part. `body` names it as its reference
    // (`reference: "ref"`, below); measure() compares against `ref` posed for
    // the measured view whether or not that view shows it, so `ref` appears
    // only in "reference", over `body`. The opacity is just a look. The
    // (body, ref) pair is left out of overlaps and gaps.
    ref: {
      label: "Reference",
      views: ["reference"],
      exportable: false,
      display: { opacity: 0.3 },
      build: (k) => k.import("scan"),
    },
    // Parametric rebuild of the scanned block. `reference: "ref"` tells
    // measure() to compute deviation facts (xorVolume / volumeDeltaPct /
    // bboxDelta, plus missing/excess regions) against the `ref` sub-part;
    // verify.expect.body below gates on them. Shown alone (with `mount`) in
    // "assembly", and with `ref` in "reference".
    body: {
      label: "Rebuild",
      views: ["assembly", "reference"],
      export: { name: "body" },
      reference: "ref",
      build: (k, p) => k.box({ min: [0, 0, 0], max: [p.scanW, p.scanD, p.scanH] }),
    },
    // The import used as a real component: a plate with a through-socket cut
    // to the (clearance-scaled) scan shape. Offset along X so it never
    // overlaps `body` in the assembly view.
    mount: {
      label: "Mount plate",
      views: ["assembly"],
      export: { name: "mount" },
      build: (k, p, d) => {
        const plate = k.box({
          min: [d.mountOffsetX - p.margin, -p.margin, -p.plateH],
          max: [d.mountOffsetX + p.scanW * p.fit + p.margin, p.scanD * p.fit + p.margin, 0],
        });
        const socket = k.import("scan")
          .scale(p.fit)
          .translate([d.mountOffsetX, 0, -p.plateH - 1]); // overcut past both plate faces
        return plate.cut(socket);
      },
    },
  },
  // "assembly" is first so `measure`/`verify`/`render` (which default to the
  // first view key) and thumbnails show the part without the scan. "reference"
  // shows `ref` and `body` together, browsed by hand or with an explicit view
  // argument.
  views: { assembly: { label: "Assembly" }, reference: { label: "Reference overlay" } },
  // Probes — measurements that land in the `measure` report instead of the
  // scene (docs/AUTHORING-PARTS.md "Probes"). Pure (k, p, d) functions like
  // build; never rendered, never exported, reported for every view.
  probes: {
    // Paired 1 mm cross-sections of the rebuild and the scan at the same X
    // station. `deviation.regions` says where the two solids differ; move the
    // slab there to compare their profiles.
    midSlab: (k, p) => {
      const slab = () => k.box({ min: [9.5, -50, -50], max: [10.5, 50, 50] });
      return {
        body: k.box({ min: [0, 0, 0], max: [p.scanW, p.scanD, p.scanH] }).intersect(slab()),
        scan: k.import("scan").intersect(slab()),
      };
    },
    // A live reading straight off the import — the numbers `defaults` were
    // measured from. Plain JSON passes through the report verbatim.
    scanBounds: (k) => k.import("scan").boundingBox(),
  },
  verify: {
    process: "fdm-pla",
    expect: {
      body: {
        holes: 0,
        watertight: true,
        bbox: "<=[30,20,15]",
        // Deviation gate: at the defaults, body reproduces the scan's exact
        // box dimensions, so all three read near-zero — thresholds below
        // leave real margin rather than sitting on the exact values.
        refXorVolume: "<=5mm3",
        refVolumeDeltaPct: "<=1",
        refBboxDelta: "<=[0.2,0.2,0.2]",
      },
      mount: { holes: 1, watertight: true, bbox: "<=[40,25,10]" },
      // `body` and `mount` never overlap (see `mountOffsetX`). The
      // (body, ref) pair is exempt, so this holds in "reference" too.
      _view: { overlaps: 0 },
    },
  },
};
