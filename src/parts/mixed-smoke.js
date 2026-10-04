// CI fixture for per-sub-part backend routing (the mixed-backend twin of
// text-smoke.js): one shelled sub-part that routes to OCCT next to a plain one
// that stays on Manifold, so the smoke check exercises a split generate — two
// workers answering one regen cycle — in a real browser. Dial "Wall" to 0 and
// the whole part drops back to Manifold (the build skips the shell branch).
// Shell is the routing exemplar since contract v3 — fillet/chamfer build
// natively on the mesh backend and no longer route.
export default {
  meta: { title: "Mixed smoke", units: "mm" },
  parameters: [
    {
      id: "body",
      title: "Body",
      advanced: [
        { key: "w", label: "Width", unit: "mm", min: 10, max: 60, step: 1 },
        { key: "t", label: "Wall", unit: "mm", min: 0, max: 5, step: 0.5 },
      ],
    },
  ],
  defaults: { w: 30, t: 2 },
  parts: {
    body: {
      label: "Body",
      views: { assembly: true },
      export: { name: "body" },
      // The t > 0 branch is what drives the routing: the probe re-runs with live
      // params, so the shell call is only seen (and OCCT only engaged) when the
      // wall is dialed on.
      build: (k, p) => {
        const box = k.box({ min: [0, 0, 0], max: [p.w, p.w, 10] });
        return p.t > 0 ? box.shell({ t: p.t, open: { dir: "Z" } }) : box;
      },
    },
    lid: {
      label: "Lid",
      views: { assembly: (s) => s.at([0, 0, 12]) },
      export: { name: "lid" },
      build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, 2] }),
    },
  },
  views: { assembly: { label: "Assembly" } },
};
