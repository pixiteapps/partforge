// Worked example for the views map (docs/AUTHORING-PARTS.md "The PartDefinition
// contract"): a storage box with a hinged lid, a lattice insert in the lid window, a
// nameplate on the front and a filament-offcut hinge pin. Every piece is ONE sub-part,
// built as it prints; each view entry only moves it — `assembly` puts it together and
// swings the lid, the piece tabs show it as built, `print` spreads the printed pieces
// on the bed. lidAngle is read only in view entries, so the Open lid animation never
// rebuilds geometry, and layer lines follow each piece's print orientation.

// The one hinge every piece that rides on the lid swings about.
const swing = (s, p, d) => s.rotate(-p.lidAngle, d.hinge, [1, 0, 0]);

export default {
  meta: { title: "Lattice Box", units: "mm" },
  parameters: [
    {
      id: "box", title: "Box",
      advanced: [
        { key: "w", label: "Width", unit: "mm", min: 50, max: 140, step: 1 },
        { key: "d", label: "Depth", unit: "mm", min: 40, max: 120, step: 1 },
        { key: "h", label: "Height", unit: "mm", min: 20, max: 80, step: 1 },
      ],
    },
    {
      id: "pose", title: "Pose",
      advanced: [{ key: "lidAngle", label: "Lid angle", unit: "°", min: 0, max: 110, step: 1 }],
    },
  ],
  defaults: { w: 80, d: 60, h: 40, wall: 2, t: 2.4, lidAngle: 0 },
  derive: (p) => ({
    hinge: [0, p.d + 1, p.h],                         // just behind the rear top edge, along X
    win: { x: 12, y: 12, w: p.w - 24, d: p.d - 24 },  // the lid's window
    fit: 0.2,
    gap: 10,                                          // spacing in the print view
  }),
  parts: {
    body: {
      label: "Body",
      display: { color: 0x1e88e5 },
      // Open-top box; prints open side up, as built.
      build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.d, p.h] })
        .cut(k.box({ min: [p.wall, p.wall, p.wall], max: [p.w - p.wall, p.d - p.wall, p.h + 1] })),
      views: { assembly: true, body: true, print: true },
    },
    lid: {
      label: "Lid",
      display: { color: 0xe53935 },
      // A flat plate with the lattice window, printed flat.
      build: (k, p, d) => k.box({ min: [0, 0, 0], max: [p.w, p.d, p.t] })
        .cut(k.box({ min: [d.win.x, d.win.y, -1], max: [d.win.x + d.win.w, d.win.y + d.win.d, p.t + 1] })),
      views: {
        assembly: (s, p, d) => swing(s.translate([0, 0, p.h]), p, d),
        lid: true,
        print: (s, p, d) => s.translate([p.w + d.gap, 0, 0]),
      },
    },
    mesh: {
      label: "Lattice insert",
      display: { color: 0x222222 },
      // Fills the window less the fit, with a staggered grid of round holes; printed flat.
      build: (k, p, d) => {
        const W = d.win.w - 2 * d.fit, D = d.win.d - 2 * d.fit;
        let plate = k.box({ min: [0, 0, 0], max: [W, D, p.t] });
        let row = 0;
        for (let y = 4; y <= D - 4; y += 6, row++) {
          for (let x = 4 + (row % 2) * 3; x <= W - 4; x += 6) {
            plate = plate.cut(k.cylinder({ r: 2.2, h: p.t + 2 }).translate([x, y, -1]));
          }
        }
        return plate;
      },
      views: {
        assembly: (s, p, d) => swing(s.translate([d.win.x + d.fit, d.win.y + d.fit, p.h]), p, d),
        mesh: true,
        print: (s, p, d) => s.translate([p.w + d.gap, p.d + d.gap, 0]),
      },
    },
    plate: {
      label: "Nameplate",
      display: { color: 0xffd400 },
      // A thin plate, printed flat; stands just off the front of the box (0.2 mm clear) in the assembly.
      build: (k) => k.box({ min: [0, 0, 0], max: [40, 12, 1.6] }),
      views: {
        assembly: (s, p) => s.rotateX(90).translate([(p.w - 40) / 2, -0.2, p.h / 2 - 6]),
        plate: true,
        print: (s, p, d) => s.translate([0, p.d + d.gap, 0]),
      },
    },
    pin: {
      label: "Hinge pin (1.75 mm filament)",
      exportable: false,
      display: { color: 0x9e9e9e },
      build: (k, p) => k.cylinder({ r: 0.875, h: p.w }).rotate(90, [0, 0, 0], [0, 1, 0]),
      views: { assembly: (s, p, d) => s.translate(d.hinge) },
    },
  },
  views: {
    assembly: {
      label: "Assembly",
      animations: {
        open: { label: "Open lid", duration: 1.2, tracks: { lidAngle: [[0, 0], [1, 110]] } },
      },
    },
    body: { label: "Body" },
    lid: { label: "Lid" },
    mesh: { label: "Lattice insert" },
    plate: { label: "Nameplate" },
    print: { label: "Print bed" },
  },
  verify: { process: "fdm-pla", expect: { _view: { overlaps: 0 } } },
};
