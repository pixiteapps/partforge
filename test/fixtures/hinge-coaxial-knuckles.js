// A textbook printed hinge that touches but never presses: two plates, the lid resting on the
// base, each carrying one knuckle — equal-radius cylinders on ONE axis along X, `gap` mm apart
// end to end — with a bore through each. Nothing overlaps (the kernel's intersection is empty).
// Before 0.191.2 world.depth read 0.3 to 7.7 mm here (by L and T): a sample on the line of a
// bore facet's edge, cast along +X, ran exactly along that facet and the parity test counted a
// lone edge hit as a crossing. `press` lowers the lid into the base, a real press for contrast.
const control = { key: "open", label: "Open", unit: "°", min: 0, max: 180, step: 1, description: "Opens the lid about the hinge axis." };

export function coaxialKnuckles({ L = 30, T = 6, gap = 0.3, bore = 2.3, press = 0 } = {}) {
  const YA = -(T + 0.3), M = L / 2;
  const cyl = (k, r, x0, x1) => k.cylinder({ r, h: x1 - x0 }).along("+X").translate([x0, YA, T]);
  return {
    meta: { title: "Hinge coaxial knuckles", units: "mm" },
    parameters: [{ id: "hinge", title: "Hinge", description: "The hinge.", controls: [control] }],
    defaults: { open: 0 },
    parts: {
      base: {
        label: "Base",
        build: (k) => k.box({ min: [0, 0, 0], max: [L, 20, T] })
          .union(k.box({ min: [M + gap / 2, YA, 0], max: [L, 0, T] }))
          .union(cyl(k, T, M + gap / 2, L)).cut(cyl(k, bore, -1, L + 1)),
        views: { assembly: (s) => s },
      },
      lid: {
        label: "Lid",
        build: (k) => k.box({ min: [0, 0, T], max: [L, 20, 2 * T] })
          .union(cyl(k, T, 0, M - gap / 2)).cut(cyl(k, bore, -1, M)),
        views: { assembly: (s, p) => s.rotateAbout({ axis: "X", deg: p.open, through: [0, YA, T] }).translate([0, 0, -press]) },
      },
    },
    views: { assembly: { label: "Assembly" } },
    verify: { sweeps: { open: { param: "open", clearance: 0 } } },
  };
}

export default coaxialKnuckles();
