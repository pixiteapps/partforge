// Minimal 3MF writer. 3MF is an OPC package (a zip) holding an XML model; it's a
// mesh format like STL but supports units and multiple named objects in one file,
// so a multi-part view exports as a single .3mf. Built from indexed meshes.
// Each object may carry an optional colour (0xRRGGBB).
import { zipSync, strToU8 } from "fflate";

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  "</Types>";

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  "</Relationships>";

const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const r = (x) => +x.toFixed(4); // 0.1 µm precision — finer than any printer, much smaller XML

// Weld coincident vertices and drop triangles that collapse to zero area.
//
// This is what keeps a .3mf manifold, and it has no STL equivalent: STL is vertex
// soup, so a consumer re-stitches triangles by POSITION and never sees how the
// mesh was indexed. 3MF reads topology from the indices instead, so two triangles
// that meet along an edge must literally cite the same two vertex ids — otherwise
// each counts the shared edge as its own boundary and slicers report the solid as
// non-manifold. The OCCT backend triangulates every B-rep face independently and
// concatenates the results, so it hands us one copy of each seam vertex PER
// adjacent face; welding here is what closes that mesh. (Manifold's own output is
// already welded, so for that backend this is a no-op beyond the copy.)
//
// Welding uses `r` — exactly the precision the file is written at — so any two
// vertices that would print identical coordinates always collapse to one id. A
// looser tolerance would move geometry; a tighter one would leave split vertices
// sitting at coordinates the file cannot tell apart.
function weld(positions, indices) {
  const idOf = new Map(); // "x,y,z" → canonical vertex id
  const coord = []; // canonical id → rounded x,y,z (flat)
  const canon = new Uint32Array(positions.length / 3);
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    const x = r(positions[i]), y = r(positions[i + 1]), z = r(positions[i + 2]);
    const key = `${x},${y},${z}`;
    let id = idOf.get(key);
    if (id === undefined) { id = coord.length / 3; idOf.set(key, id); coord.push(x, y, z); }
    canon[v] = id;
  }
  // Emit vertices in order of first use by a surviving triangle, so a vertex left
  // behind by a dropped degenerate never ships as an unreferenced <vertex>.
  const emitted = new Map(); // canonical id → written vertex index
  const verts = [], tris = [];
  const emit = (id) => {
    let at = emitted.get(id);
    if (at === undefined) {
      at = verts.length / 3;
      emitted.set(id, at);
      verts.push(coord[id * 3], coord[id * 3 + 1], coord[id * 3 + 2]);
    }
    return at;
  };
  for (let k = 0; k < indices.length; k += 3) {
    const a = canon[indices[k]], b = canon[indices[k + 1]], c = canon[indices[k + 2]];
    if (a === b || b === c || a === c) continue; // zero area at print precision — carries no surface
    tris.push(emit(a), emit(b), emit(c));
  }
  return { verts, tris };
}

// Default for an uncoloured object in an export where some other object IS
// coloured: the viewer's own default look (presets.js "default"). Written as a
// literal so this module keeps its fflate-only import closure.
const DEFAULT_DISPLAY_COLOR = 0x9fb4cc;
// Base-material group id: outside the object id range (objects are 1..n).
const BASE_MATERIALS_ID = 1000;
const hexColor = (c) => `#${c.toString(16).padStart(6, "0").toUpperCase()}FF`;

// parts: [{ name, positions, indices, color? }] → ArrayBuffer of the .3mf zip.
// `color` (0xRRGGBB) is optional per part. When NO part carries one, the model is
// byte-for-byte what it was before colour support — no <basematerials>, no pid.
// When any does, every object points (pid/pindex) into one core-spec
// <basematerials> group, one <base> per distinct colour, so a slicer opens the
// file pre-split into coloured objects.
export function meshTo3MF(parts) {
  const colored = parts.some((p) => p.color != null);
  const palette = [];
  const pindexOf = (c) => {
    const color = c ?? DEFAULT_DISPLAY_COLOR;
    let i = palette.indexOf(color);
    if (i < 0) { i = palette.length; palette.push(color); }
    return i;
  };
  const pindex = colored ? parts.map((p) => pindexOf(p.color)) : [];

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    "<resources>",
  ];
  if (colored) {
    out.push(`<basematerials id="${BASE_MATERIALS_ID}">`);
    palette.forEach((c, i) => out.push(`<base name="color-${i + 1}" displaycolor="${hexColor(c)}"/>`));
    out.push("</basematerials>");
  }
  parts.forEach((p, i) => {
    const mat = colored ? ` pid="${BASE_MATERIALS_ID}" pindex="${pindex[i]}"` : "";
    out.push(`<object id="${i + 1}" type="model" name="${xmlEsc(p.name)}"${mat}><mesh><vertices>`);
    const { verts: v, tris: t } = weld(p.positions, p.indices);
    for (let k = 0; k < v.length; k += 3) out.push(`<vertex x="${v[k]}" y="${v[k + 1]}" z="${v[k + 2]}"/>`);
    out.push("</vertices><triangles>");
    for (let k = 0; k < t.length; k += 3) out.push(`<triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>`);
    out.push("</triangles></mesh></object>");
  });
  out.push("</resources><build>");
  parts.forEach((p, i) => out.push(`<item objectid="${i + 1}"/>`));
  out.push("</build></model>");

  const zip = zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "_rels/.rels": strToU8(RELS),
      "3D/3dmodel.model": strToU8(out.join("")),
    },
    { level: 6 } // 3MF XML is highly repetitive — compresses ~10×
  );
  return zip.buffer;
}
