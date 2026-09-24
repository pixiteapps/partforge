const FONT_URLS = {
  pacifico: "https://raw.githubusercontent.com/google/fonts/main/ofl/pacifico/Pacifico-Regular.ttf",
  dancing: "https://raw.githubusercontent.com/google/fonts/main/ofl/dancingscript/DancingScript%5Bwght%5D.ttf",
  greatVibes: "https://raw.githubusercontent.com/google/fonts/main/ofl/greatvibes/GreatVibes-Regular.ttf",
};

const slantProfile = (k, profile, shear) => {
  if (!shear) return profile;
  const regions = profile.toRegions();
  if (!Array.isArray(regions)) return profile;

  let combined = null;
  for (const region of regions) {
    const outer = [];
    for (const point of region.outer) {
      outer.push([point[0] + shear * point[1], point[1]]);
    }
    const holes = [];
    for (const hole of region.holes) {
      const slantedHole = [];
      for (const point of hole) {
        slantedHole.push([point[0] + shear * point[1], point[1]]);
      }
      holes.push(slantedHole);
    }
    const slantedRegion = k.shape2d({ outer, holes });
    combined = combined ? combined.union(slantedRegion) : slantedRegion;
  }
  return combined || profile;
};

const styleProfile = (k, profile, bold, italic) => {
  let styled = slantProfile(k, profile, italic ? 0.2126 : 0);
  if (bold) {
    styled = styled.offset(0.4, { corners: "round", segs: 32 });
  }
  return styled;
};

const offsetGlyphContours = (k, profile, distance) => {
  const options = { corners: "round", segs: 32 };
  const regions = profile.regions();
  if (!Array.isArray(regions)) return k.hull([profile]).offset(distance, options);
  let combined = null;
  for (const region of regions) {
    const expanded = k.hull([region]).offset(distance, options);
    combined = combined ? combined.union(expanded) : expanded;
  }
  return combined || k.hull([profile]).offset(distance, options);
};

const planarTopFillet = (solid, height, radius) => solid.fillet({
  r: radius,
  edges: { inPlane: "XY", at: height },
});

const filletGlyphRegions = (k, profile, height, radius) => {
  const regions = profile.regions();
  if (!Array.isArray(regions)) return profile.extrude({ h: height });
  const rounded = [];
  for (const region of regions) {
    const glyph = region.extrude({ h: height });
    rounded.push(planarTopFillet(glyph, height, radius));
  }
  if (rounded.length === 1) return rounded[0];
  return k.union(rounded);
};

export default {
  meta: {
    title: "Editable Layered Label",
    units: "mm",
    background: 0x171a20,
    environment: "print-bed",
  },

  parameters: [
    {
      id: "label",
      title: "Label",
      description: "Dimensions for the raised name and its larger lower backing layer.",
      controls: [
        {
          key: "text",
          type: "text",
          label: "Label text",
          description: "Text shown on the raised face; changes preview immediately.",
        },
        {
          key: "fontStyle",
          type: "select",
          label: "Font",
          options: [
            { value: "roboto", label: "Roboto" },
            { value: "pacifico", label: "Pacifico Script" },
            { value: "dancing", label: "Dancing Script" },
            { value: "greatVibes", label: "Great Vibes Script" },
          ],
          description: "Choose the bundled sans-serif or an elegant script font.",
        },
        {
          key: "bold",
          type: "checkbox",
          label: "Bold",
          description: "Adds 0.4 mm of weight around every letter stroke.",
        },
        {
          key: "italic",
          type: "checkbox",
          label: "Italic",
          description: "Slants the lettering 12 degrees to the right.",
        },
        {
          key: "textSize",
          label: "Letter height",
          unit: "mm",
          min: 10,
          max: 60,
          step: 1,
          description: "Nominal height of the raised lettering.",
        },
        {
          key: "backingStyle",
          type: "select",
          label: "Backing edge style",
          options: [
            { value: "fillet", label: "Top fillet (planar)" },
            { value: "roundAll", label: "Round all edges" },
          ],
          description: "Top fillet rounds only the top rim; Round all rounds every edge of the backing (roundAll test).",
        },
        {
          key: "border",
          label: "Backing offset",
          unit: "mm",
          min: 2,
          max: 20,
          step: 0.5,
          recommended: [4, 12],
          description: "Distance the lower layer extends beyond the lettering.",
        },
        {
          key: "backingThickness",
          label: "Lower layer thickness",
          unit: "mm",
          min: 1.2,
          max: 8,
          step: 0.1,
          recommended: [2, 4],
          description: "Printable thickness of the larger backing layer.",
        },
        {
          key: "letterThickness",
          label: "Raised letter thickness",
          unit: "mm",
          min: 0.8,
          max: 6,
          step: 0.1,
          recommended: [1.2, 3],
          description: "Height of the raised lettering above the lower layer.",
        },
      ],
    },
  ],

  defaults: {
    text: "Scott",
    fontStyle: "roboto",
    bold: 0,
    italic: 0,
    backingStyle: "roundAll",
    textSize: 31,
    border: 5,
    backingThickness: 2.5,
    letterThickness: 2,
  },

  derive: (p) => ({
    textValue: String(p.text ?? "").trim() || "Scott",
    fontUrl: FONT_URLS[p.fontStyle],
    topZ: p.backingThickness,
    totalHeight: p.backingThickness + p.letterThickness,
  }),

  parts: {
    backing: {
      label: "Lower outer layer",
      views: ["backing", "assembly"],
      display: { material: "pla-print", color: 0x1e88e5 },
      build: (k, p, d) => {
        const rawTextProfile = k.text2d(d.textValue, {
          size: p.textSize,
          ...(d.fontUrl ? { font: d.fontUrl } : {}),
          align: "center",
          valign: "middle",
        });
        const textProfile = slantProfile(k, rawTextProfile, p.italic ? 0.2126 : 0);
        const backingProfile = offsetGlyphContours(
          k,
          textProfile,
          p.border + (p.bold ? 0.4 : 0),
        );
        const topRound = Math.min(0.3, p.backingThickness / 2 - 0.1);
        const solid = p.backingStyle === "roundAll"
          ? backingProfile.extrude({ h: p.backingThickness }).roundAll(topRound)
          : filletGlyphRegions(k, backingProfile, p.backingThickness, topRound);
        return solid.label("Letter contour backing");
      },
    },
    lettering: {
      label: "Editable lettering",
      views: ["lettering", "assembly"],
      display: { material: "pla-print", color: 0xfdd835 },
      build: (k, p, d) => {
        const rawLetteringProfile = k.text2d(d.textValue, {
          size: p.textSize,
          ...(d.fontUrl ? { font: d.fontUrl } : {}),
          align: "center",
          valign: "middle",
        });
        const letteringProfile = styleProfile(k, rawLetteringProfile, p.bold, p.italic);
        const topRound = Math.min(0.3, p.letterThickness / 2 - 0.1, p.textSize * 0.015);
        return filletGlyphRegions(k, letteringProfile, p.letterThickness, topRound)
          .at([0, 0, d.topZ])
          .label("Raised text");
      },
    },
  },

  views: {
    backing: { label: "Lower layer" },
    lettering: { label: "Lettering" },
    assembly: { label: "Layered label" },
  },

  verify: {
    process: "fdm-pla",
    expect: {
      backing: {
        watertight: true,
        bbox: "<=[*,*,8]",
      },
      lettering: {
        watertight: true,
        bbox: "<=[*,*,14]",
      },
      _view: {
        overlaps: 0,
        contacts: [["backing", "lettering"]],
      },
    },
  },
};
