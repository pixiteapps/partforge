// A dig hidden inside a touch (Task 5 review): two r 5 knuckles butt end to end on the
// hinge axis (X) with no axial gap — the base's x 0..8, the lid's x 8..16 — so they touch at
// every angle. The lid's 0.6 mm arm runs out to y -30, and (`post`) the base carries a
// 0.6 mm post that the arm passes through around 30°, about 0.3 mm deep. Read at a few
// points, the long touching interval looked like an allowed rub; read along it, the dig
// is a contact at `clearance: 0`.
const control = { key: "open", label: "Open", unit: "°", min: 0, max: 110, step: 1, description: "Opens the lid about the hinge axis." };

export function buttingKnuckles(post = true) {
  return {
    meta: { title: "Hinge butting knuckles", units: "mm" },
    parameters: [{ id: "hinge", title: "Hinge", description: "The hinge.", controls: [control] }],
    defaults: { open: 0 },
    parts: {
      base: {
        label: "Base",
        build: (k) => {
          const knuckle = k.cylinder({ r: 5, h: 8 }).along("+X");
          return post ? knuckle.union(k.box({ min: [9, -25, -0.3], max: [15, -15, 0.3] }).rotateAbout({ axis: "X", deg: -30, through: [0, 0, 0] })) : knuckle;
        },
        views: { assembly: (s) => s },
      },
      lid: {
        label: "Lid",
        build: (k) => k.cylinder({ r: 5, h: 8 }).along("+X").translate([8, 0, 0]).union(k.box({ min: [8, -30, -0.3], max: [16, -4, 0.3] })),
        views: { assembly: (s, p) => s.rotateAbout({ axis: "X", deg: -p.open, through: [0, 0, 0] }) },
      },
    },
    views: { assembly: { label: "Assembly" } },
    verify: { sweeps: { open: { param: "open", clearance: 0 } } },
  };
}

export default buttingKnuckles();
