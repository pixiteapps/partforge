// partforge/gltf — the cached-preview writer. One view's posed display meshes as a
// small GLB (see src/framework/gltf/encode-preview.js for the file's contract).
// Worker-safe: no three.js, no DOM, so it runs in Node (a server-side preview job),
// a page (runtime.exportPreview) and a Web Worker alike. Read the files back with
// mount()'s `preview` option or mountPreview(), both on the main entry.
export { encodePreviewGlb, PREVIEW_ENCODER_VERSION } from "./framework/gltf/encode-preview.js";
