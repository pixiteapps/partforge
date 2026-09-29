// Demo part — a lettered nameplate. Showcases k.text2d (the vector-text feature):
// two lines of text with counters and curves (P A R T F O R G E, digits) resolved to
// exact curve regions, then either raised above (emboss) or cut into (deboss) a
// rounded plate. The plate itself is a Shape2D rounded-rectangle, so the part also
// exercises shape2d + the extrude/boolean path. Open /nameplate.html after `npm run dev`.
import { roundedRectProfile } from "partforge/geometry";

export default {
  meta: { title: "Nameplate", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "text",
      title: "Lettering",
      description: "Editable text resolved to exact glyph curves, with open counters and sizing based on cap height.",
      advanced: [
        { key: "label", label: "Text", control: "textarea",
          description: "The text rendered on the nameplate. Line breaks create multiple lines." },
        { key: "size", label: "Cap height", unit: "mm", min: 4, max: 16, step: 0.5,
          description: "Height of the uppercase letters. The second line scales with it." },
        { key: "depth", label: "Relief depth", unit: "mm", min: 0.4, max: 3, step: 0.1,
          description: "How far the lettering is raised above (emboss) or recessed into (engrave) the plate face." },
        { key: "stroke", label: "Stroke offset", unit: "mm", min: -0.3, max: 1.5, step: 0.05,
          description: "Grow (>0, bolder) or shrink (<0, thinner) the letters with a **Shape2D offset** — the same operation used for print clearance. Large negative values collapse thin strokes, so the letters hold at their thinnest valid size rather than breaking." },
      ],
    },
    {
      id: "typeface",
      title: "Typeface",
      description: "The face the lettering is cut in. Falls back to the bundled Roboto when left as the default.",
      controls: [
        { key: "face", type: "font", label: "Typeface",
          description: "Any face the host's font catalog offers. Without a catalog this is a URL field — a direct link to a `.ttf` or `.otf` that allows cross-origin requests." },
      ],
    },
    {
      id: "plate",
      title: "Plate",
      description: "A rounded-rectangle backing plate, sized automatically from the text bounding box plus the border.",
      advanced: [
        { key: "margin", label: "Border", unit: "mm", min: 2, max: 12, step: 0.5,
          description: "Clear space between the lettering and the plate edge." },
        { key: "corner", label: "Corner radius", unit: "mm", min: 0, max: 10, step: 0.5,
          description: "Rounding on the plate corners (clamped so it never exceeds half the shorter side)." },
        { key: "thickness", label: "Thickness", unit: "mm", min: 1.5, max: 8, step: 0.5,
          description: "Plate thickness." },
      ],
    },
    {
      id: "style",
      title: "Style",
      toggles: [
        { key: "engrave", label: "Engrave (recessed)", on: 1,
          description: "Cut the lettering into the top face instead of raising it above the plate." },
      ],
    },
  ],
  defaults: { label: "PARTFORGE\nv0.20", size: 8, depth: 1.2, stroke: 0, margin: 4, corner: 3, thickness: 3, engrave: 0, face: "" },
  // A function of params, not a static map — that is what makes `face` a
  // parameter rather than a constant. An empty value declares nothing, and
  // text2d falls back to the bundled Roboto.
  fonts: (p) => (p.face ? { face: p.face } : {}),
  parts: {
    plate: {
      label: "Nameplate",
      views: ["plate"],
      export: { name: "nameplate" },
      build: (k, p) => {
        let text = k.text2d(p.label, { size: p.size, align: "center", valign: "middle",
          lineHeight: p.size * 1.7, ...(p.face ? { font: "face" } : {}) });
        // Shape2D offset on the lettering: grow (>0, bolder) or shrink (<0, thinner). Guard
        // against a shrink that collapses thin strokes — keep the un-offset letters if so.
        if (p.stroke !== 0) {
          try { const g = text.offset(p.stroke); if (g.area() > 1) text = g; } catch { /* collapsed — keep un-offset */ }
        }
        const bb = text.boundingBox();
        const w = (bb.max[0] - bb.min[0]) + 2 * p.margin;
        const h = (bb.max[1] - bb.min[1]) + 2 * p.margin;
        const corner = Math.max(0, Math.min(p.corner, Math.min(w, h) / 2 - 0.5));
        const plate = k.extrude({ profile: k.shape2d(roundedRectProfile(w, h, corner)), h: p.thickness }).label("Plate");
        const relief = k.extrude({ profile: text, h: p.depth });
        return p.engrave
          ? plate.cut(relief.translate([0, 0, p.thickness - p.depth]))
          : plate.union(relief.translate([0, 0, p.thickness]).label("Lettering"));
      },
    },
  },
  views: { plate: { label: "Nameplate" } },
};
