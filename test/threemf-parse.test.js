import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { parse3MF } from "../src/framework/geometry/threemf-parse.js";
import { meshTo3MF } from "../src/framework/geometry/threemf.js";

const QUAD = { // unit square, two triangles
  name: "q",
  positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
};

const CONTENT_TYPES = strToU8(
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
);
const RELS = strToU8(
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
);

// Build a valid, readable-as-a-zip .3mf archive around a caller-supplied model
// XML string (or omit the model part entirely, for the "no .model" case).
function buildZip(modelXml) {
  const files = { "[Content_Types].xml": CONTENT_TYPES, "_rels/.rels": RELS };
  if (modelXml !== null) files["3D/3dmodel.model"] = strToU8(modelXml);
  return zipSync(files);
}

describe("parse3MF", () => {
  it("round-trips the writer", () => {
    const { positions, indices } = parse3MF(meshTo3MF([QUAD]));
    expect(indices.length).toBe(6);
    expect(positions.length).toBe(12);
    expect(positions[3]).toBeCloseTo(1);
  });

  it("scales non-mm units to mm", () => {
    // Take the writer's output, unzip it (fflate), rewrite unit="millimeter" ->
    // unit="centimeter" in the model XML, rezip, and confirm every coordinate
    // comes back scaled by 10 (1 cm = 10 mm).
    const buf = meshTo3MF([QUAD]);
    const files = unzipSync(new Uint8Array(buf));
    const modelPath = Object.keys(files).find((f) => f.toLowerCase().endsWith(".model"));
    const xml = new TextDecoder().decode(files[modelPath]).replace('unit="millimeter"', 'unit="centimeter"');
    files[modelPath] = strToU8(xml);
    const rezipped = zipSync(files);

    const { positions } = parse3MF(rezipped);
    expect(positions[3]).toBeCloseTo(10);
    expect(positions[6]).toBeCloseTo(10);
    expect(positions[7]).toBeCloseTo(10);
  });

  it("applies a build-item transform (row-major 4x3, translation in the last row)", () => {
    // Hand-written model XML (not produced by the writer, which never emits a
    // transform) so the parser's matrix convention can be checked directly:
    // scale x2 on the diagonal, plus a translation, applied to a single point.
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources><object id="1" type="model" name="p"><mesh><vertices>' +
      '<vertex x="1" y="2" z="3"/><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
      "</vertices><triangles>" +
      '<triangle v1="0" v2="1" v3="2"/>' +
      "</triangles></mesh></object></resources>" +
      '<build><item objectid="1" transform="2 0 0 0 2 0 0 0 2 10 20 30"/></build>' +
      "</model>";

    const { positions } = parse3MF(buildZip(xml));
    // vertex (1,2,3) * diag(2,2,2) + (10,20,30) = (12, 24, 36)
    expect(positions[0]).toBeCloseTo(12);
    expect(positions[1]).toBeCloseTo(24);
    expect(positions[2]).toBeCloseTo(36);
  });

  it("scales a build-item translation by the model unit, combined with mm-scaled geometry", () => {
    // unit="centimeter": vertex (1,2,3) cm is stored pre-scaled to (10,20,30) mm
    // by the vertex loop; the transform's translation (5,0,0) is *model* units
    // (cm) per the 3MF spec, so it must also be scaled (x10) before adding —
    // exercising the `t[9]*scale` path, which the other transform test (unit
    // "millimeter", scale 1) can't distinguish from an unscaled `t[9]`.
    // Expected (hand-verified): (1,2,3)cm -> (10,20,30)mm, + (5,0,0)cm -> (50,0,0)mm
    // = (60, 20, 30) mm.
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<model unit="centimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources><object id="1" type="model" name="p"><mesh><vertices>' +
      '<vertex x="1" y="2" z="3"/><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
      "</vertices><triangles>" +
      '<triangle v1="0" v2="1" v3="2"/>' +
      "</triangles></mesh></object></resources>" +
      '<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></build>' +
      "</model>";

    const { positions } = parse3MF(buildZip(xml));
    expect(positions[0]).toBeCloseTo(60);
    expect(positions[1]).toBeCloseTo(20);
    expect(positions[2]).toBeCloseTo(30);
  });

  it("reads a slicer project: root components pointing at another part via p:path", () => {
    // Bambu Studio / Orca shape: the root part holds no mesh, only an object
    // whose <components> reference meshes in 3D/Objects/object_1.model, and the
    // .rels names the root. The objects part sorts FIRST among *.model entries
    // in this zip, which is what used to make the reader pick it alone.
    const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
    const objectsXml =
      `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources>` +
      '<object id="1" type="model"><mesh><vertices>' +
      '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
      '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
      "</resources><build/></model>";
    const rootXml =
      `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources>` +
      '<object id="2" type="model"><components>' +
      '<component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>' +
      '<component p:path="/3D/Objects/object_1.model" objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/>' +
      "</components></object></resources>" +
      '<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 10" printable="1"></item></build></model>';
    const zip = zipSync({
      "3D/Objects/object_1.model": strToU8(objectsXml),
      "[Content_Types].xml": CONTENT_TYPES,
      "_rels/.rels": RELS,
      "3D/3dmodel.model": strToU8(rootXml),
    });
    const { positions, indices } = parse3MF(zip);
    expect(indices.length).toBe(6); // two instances of one triangle
    // first instance: (1,0,0) + (5,0,0) + item (0,0,10) = (6,0,10)
    expect([...positions.slice(3, 6)]).toEqual([6, 0, 10]);
    // second instance: (1,0,0) * 2 + item = (2,0,10); (0,1,0) * 2 + item = (0,2,10)
    expect([...positions.slice(12, 15)]).toEqual([2, 0, 10]);
    expect([...positions.slice(15, 18)]).toEqual([0, 2, 10]);
  });

  it("composes nested component transforms child-first", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>' +
      '<object id="1" type="model"><mesh><vertices>' +
      '<vertex x="1" y="0" z="0"/><vertex x="0" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
      '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
      // rotate 90° about z (x -> y) as the child, then translate +10 x as the parent
      '<object id="2" type="model"><components><component objectid="1" transform="0 1 0 -1 0 0 0 0 1 0 0 0"/></components></object>' +
      '<object id="3" type="model"><components><component objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>' +
      '</resources><build><item objectid="3"/></build></model>';
    const { positions } = parse3MF(buildZip(xml));
    // (1,0,0) rotated -> (0,1,0), then +10 x -> (10,1,0)
    expect(positions[0]).toBeCloseTo(10);
    expect(positions[1]).toBeCloseTo(1);
  });

  it("with no build items, places only objects no component uses", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>' +
      '<object id="1" type="model"><mesh><vertices>' +
      '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
      '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
      '<object id="2" type="model"><components><component objectid="1"/></components></object>' +
      "</resources></model>";
    expect(parse3MF(buildZip(xml)).indices.length).toBe(3);
  });

  it("names a component that points at a missing part", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>' +
      '<object id="2" type="model"><components><component p:path="/3D/Objects/gone.model" objectid="1"/></components></object>' +
      '</resources><build><item objectid="2"/></build></model>';
    expect(() => parse3MF(buildZip(xml))).toThrow(/missing model part/);
  });

  it("refuses a component loop instead of recursing forever", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>' +
      '<object id="1" type="model"><components><component objectid="2"/></components></object>' +
      '<object id="2" type="model"><components><component objectid="1"/></components></object>' +
      '</resources><build><item objectid="1"/></build></model>';
    expect(() => parse3MF(buildZip(xml))).toThrow(/loop/);
  });

  it("throws on an unrecognized unit", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<model unit="furlong" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources><object id="1" type="model" name="p"><mesh><vertices>' +
      '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
      "</vertices><triangles>" +
      '<triangle v1="0" v2="1" v3="2"/>' +
      "</triangles></mesh></object></resources><build><item objectid=\"1\"/></build></model>";
    expect(() => parse3MF(buildZip(xml))).toThrow(/unit/i);
  });

  it("throws when the archive is a valid zip with no 3D model part", () => {
    const zip = buildZip(null); // [Content_Types].xml + _rels/.rels only, no *.model entry
    expect(() => parse3MF(zip)).toThrow(/3mf/i);
    expect(() => parse3MF(zip)).toThrow(/model/i);
  });

  it("throws when the .model part has no mesh geometry", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      "<resources></resources><build></build></model>";
    expect(() => parse3MF(buildZip(xml))).toThrow(/mesh|geometry/i);
  });

  it("throws when the bytes are not a readable zip archive at all", () => {
    // "PK\x03\x04" is the local-file-header signature, so unzipSync recognizes
    // this as zip-shaped and attempts to parse it, but the payload is garbage —
    // it never gets far enough to look for a .model part.
    expect(() => parse3MF(new TextEncoder().encode("PK\x03\x04garbage"))).toThrow(/3mf/i);
  });
});
