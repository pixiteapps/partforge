// Reference part for k.screwSweep — an ISO-style metric bolt. The thread uses the
// PERIODIC profile form (spans exactly one pitch, first radius == last radius), so
// one screwSweep call yields the whole threaded shank with no boolean against a
// core. See docs/AUTHORING-PARTS.md "Helical & threaded features".
export default {
  meta: { title: "Screw", units: "mm", background: 0x15181d, environment: "studio" },
  parameters: [
    {
      id: "thread",
      title: "Thread",
      description: "Nominal thread size. Pick a preset, or open **Advanced** for exact dimensions.",
      presets: { M6: { major: 6, pitch: 1.0, length: 20 }, M10: { major: 10, pitch: 1.5, length: 30 } },
      advanced: [
        { key: "major", label: "Major diameter", unit: "mm", min: 4, max: 24, step: 0.5,
          description: "Outside diameter measured across the thread crests." },
        { key: "pitch", label: "Pitch", unit: "mm", min: 0.5, max: 3, step: 0.05, control: "number",
          description: "Axial rise per turn. A coarse pitch on a small major diameter runs the root radius down toward zero, which is why Major diameter starts at 4 mm. The 0.5 mm floor is the ISO fine pitch for the smallest diameter offered here — and a floor is needed, because cost scales with turns = length / pitch." },
        { key: "length", label: "Threaded length", unit: "mm", min: 5, max: 40, step: 1,
          description: "Length of the threaded shank, excluding the head. Capped at 40 mm so the worst case reachable from these sliders — 40 mm at a 0.5 mm pitch, 80 turns — stays a couple of seconds of preview rather than minutes." },
        { key: "lefthand", label: "Left-hand thread", control: "toggle",
          description: "Reverses the helix. Rare outside gas fittings and bicycle pedals." },
      ],
    },
    {
      id: "head",
      title: "Head",
      description: "The hex head at the top of the shank.",
      advanced: [
        { key: "headAcross", label: "Head width across flats", unit: "mm", min: 0, max: 40, step: 0.5,
          description: "Spanner size. Zero gives a headless threaded rod." },
        { key: "headH", label: "Head height", unit: "mm", min: 1, max: 20, step: 0.5,
          description: "Head thickness along the axis." },
      ],
    },
  ],
  defaults: { major: 10, pitch: 1.5, length: 30, lefthand: false, headAcross: 17, headH: 6.4 },
  // derive(): the ISO 60-degree tooth, expressed as radii the build consumes directly.
  derive: (p) => {
    const H = (Math.sqrt(3) / 2) * p.pitch;   // sharp-V height
    const majorR = p.major / 2;
    const rootR = majorR - (5 / 8) * H;
    const rootFlat = p.pitch / 4, crestFlat = p.pitch / 8;
    return {
      majorR, rootR, rootFlat, crestFlat,
      rise: (p.pitch - crestFlat - rootFlat) / 2,
      turns: p.length / p.pitch,
      headR: p.headAcross / Math.sqrt(3),      // circumradius of a hex across flats
    };
  },
  parts: {
    screw: {
      label: "Screw",
      views: ["screw"],
      export: { name: "screw" },
      display: { material: "brushed-stainless" },
      build: (k, p, d) => {
        // Periodic profile: exactly one pitch tall, first radius == last radius.
        const shank = k.screwSweep({
          profile: [
            [d.rootR,  0],
            [d.rootR,  d.rootFlat],
            [d.majorR, d.rootFlat + d.rise],
            [d.majorR, d.rootFlat + d.rise + d.crestFlat],
            [d.rootR,  p.pitch],
          ],
          pitch: p.pitch,
          turns: d.turns,
          lefthand: p.lefthand,
        });
        if (p.headAcross <= 0) return shank;
        const head = k.prism({ points: hexPoints(d.headR), h: p.headH }).at([0, 0, p.length]);
        return shank.union(head);
      },
    },
  },
  views: { screw: { label: "Screw" } },
};

const hexPoints = (r) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
