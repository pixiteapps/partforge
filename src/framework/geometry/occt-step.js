// STEP writer for the OCCT backend: replicad 0.23.1's `exportSTEP` (and the
// `createAssembly` it calls), changed in how each body's colour is made and in
// when the writer's model is made (so every file's header names AP242; below).
//
// replicad gets colour wrong twice. A body with no colour is painted its default
// red, so every exported part opened red in a CAD tool. And a colour it is given
// is built with `Quantity_ColorRGBA(r/255, g/255, b/255, a)` — a LINEAR-RGB
// constructor — from an sRGB hex, while OCCT's STEP writer converts linear to
// sRGB on the way out, so each colour landed lighter than asked (#3366cc was
// written as #7caae7). Here every body gets a colour (the viewer's no-material
// drafting colour when it has none of its own), converted sRGB → linear with
// OCCT's own Convert_sRGB_To_LinearRGB — the exact inverse of the writer's
// conversion — before it reaches that constructor, so a body's COLOUR_RGB is
// the 0xRRGGBB the caller passed. (Building the colour as Quantity_TOC_sRGB
// directly would be tidier, but this WASM build does not bind that enum.)
//
// Everything else — the XCAF document, naming, the writer's modes and statics,
// the FS round trip, and which native objects are handed to GC — is replicad's
// own, so this writes the same file replicad did apart from the colours and the
// first file in a process, whose header replicad left saying AP214. The
// document handle passed to Transfer is deliberately never freed: the document
// itself is owned by its WrappingObj (as replicad's AssemblyExporter owns it),
// and freeing the handle too would destroy it twice.
import { NO_MATERIAL_COLOR } from "../materials/resolve.js";

const isColor = (c) => Number.isInteger(c) && c >= 0 && c <= 0xffffff;

// 0xRRGGBB → sRGB channels in 0..1. A missing or unusable colour falls back to
// the no-material colour: appearance never fails an export.
function srgbChannels(color) {
  const c = isColor(color) ? color : NO_MATERIAL_COLOR;
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255].map((v) => v / 255);
}

// bodies: [{ name, shape (a replicad Shape), color? (0xRRGGBB) }] → ArrayBuffer.
export function writeStep(replicad, bodies) {
  const oc = replicad.getOC();
  const r = replicad.GCWithScope();
  const text = (s) => r(new oc.TCollection_ExtendedString_2(s, true));

  const doc = new replicad.WrappingObj(new oc.TDocStd_Document(text("XmlOcaf")));
  oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
  const mainLabel = r(doc.wrapped.Main());
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(mainLabel).get();
  const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(mainLabel).get();
  for (const { name, shape, color } of bodies) {
    const node = r(shapeTool.NewShape());
    shapeTool.SetShape(node, shape.wrapped);
    oc.TDataStd_Name.Set_1(node, text(name));
    const [red, green, blue] = srgbChannels(color).map((v) => oc.Quantity_Color.Convert_sRGB_To_LinearRGB_1(v));
    colorTool.SetColor_3(node, r(new oc.Quantity_ColorRGBA_5(red, green, blue, 1)), oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
  }
  shapeTool.UpdateAssemblies();

  const session = r(new oc.XSControl_WorkSession());
  const sessionHandle = r(new oc.Handle_XSControl_WorkSession_2(session));
  const writer = r(new oc.STEPCAFControl_Writer_2(sessionHandle, false));
  oc.Interface_Static.SetIVal("write.surfacecurve.mode", true);
  oc.Interface_Static.SetIVal("write.precision.mode", 0);
  oc.Interface_Static.SetIVal("write.step.assembly", 2);
  oc.Interface_Static.SetIVal("write.step.schema", 5);
  // The header's FILE_SCHEMA is fixed when the writer's model is made, which
  // constructing the writer does — before the statics above are set. They cannot
  // go first: the process's first STEP writer is what defines them, so until then
  // SetIVal is a silent no-op. So the first file in a process said AP214 (OCCT's
  // default) over an AP242 body. Re-initialising with a fresh model now stamps
  // the header with the schema the body is written in, on every export.
  writer.Init(sessionHandle, true);
  writer.SetColorMode(true);
  writer.SetLayerMode(true);
  writer.SetNameMode(true);
  const progress = r(new oc.Message_ProgressRange_1());
  writer.Transfer_1(new oc.Handle_TDocStd_Document_2(doc.wrapped), oc.STEPControl_StepModelType.STEPControl_AsIs, null, progress);

  const filename = "partforge-export.step";
  if (writer.Write(filename) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("STEP write failed");
  const file = oc.FS.readFile(`/${filename}`);
  oc.FS.unlink(`/${filename}`);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}
