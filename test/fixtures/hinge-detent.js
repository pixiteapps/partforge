// A hinge that swings clear but for one detent bump, for sweeps that allow pressing in
// (spec 2026-11-12-moving-fits-swept-design.md, B). The lid is a 20 mm bar on a hinge axis
// along X at the origin; the base plate starts 1 mm in front of the axis and 0.5 mm below
// the lid (the relief), so the lid lifts off it freely. The base also carries a catch, a
// 3 mm pin parallel to the axis at 45°, set 0.3 mm inside the circle the lid's tip sweeps:
// the tip rubs over it, at most 0.3 mm deep, between about 40° and 50°. At clearance 0
// that rub is a contact; at clearance -0.3 it is an allowed one.
const W = 10, L = 20, HALF = 0.5, PIN_R = 3, BUMP = 0.3, AT = 45;
const TIP_R = Math.hypot(L, HALF); // the radius the lid's tip corners sweep
const PIN_D = TIP_R + PIN_R - BUMP; // the pin's centre, from the axis
const rad = (AT * Math.PI) / 180;

export default {
  meta: { title: "Hinge detent", units: "mm" },
  parameters: [{ id: "hinge", title: "Hinge", description: "The detent hinge.", controls: [
    { key: "open", label: "Open", unit: "°", min: 0, max: 110, step: 1, description: "Opens the lid about the hinge axis." },
  ] }],
  defaults: { open: 0 },
  parts: {
    base: {
      label: "Base",
      build: (k) => k.box({ min: [0, 1, -4], max: [W, L + 2, -1] })
        .union(k.cylinder({ r: PIN_R, h: W }).along("+X").translate([0, PIN_D * Math.cos(rad), PIN_D * Math.sin(rad)])),
      views: { assembly: (s) => s },
    },
    lid: {
      label: "Lid",
      build: (k) => k.box({ min: [0, 0, -HALF], max: [W, L, HALF] }),
      views: { assembly: (s, p) => s.rotateAbout({ axis: "X", deg: p.open, through: [0, 0, 0] }) },
    },
  },
  views: { assembly: { label: "Assembly" } },
  verify: { sweeps: { open: { param: "open", clearance: 0 } } },
};
