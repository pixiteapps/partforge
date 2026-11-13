// partforge — app entry (DOM). Apps call mount(); viewSubParts is handy for app-side
// view logic. This entry pulls in the viewer/controls (which use `document`), so it
// must NOT be imported from a part's build functions — those run in a Web Worker.
// Part build functions import geometry helpers from "partforge/geometry" instead.
export { mount } from "./framework/index.js";
// The kernel-free viewer for a cached preview GLB (partforge/gltf): no part, no worker.
export { mountPreview } from "./framework/mount-preview.js";
export { viewSubParts } from "./framework/part-model.js";
// The cut & print kit's options surface, for a host that draws its own options screen
// (partforge-cloud's coupling test reads KIT_OPTIONS_ERROR from here). export/formats.js
// is import-free, so this adds nothing to the app bundle but a few constants.
export { EXPORT_FORMATS, KIT_OPTIONS_ERROR, KIT_DEFAULTS, validateKitOptions } from "./framework/export/formats.js";
// The download kit's vocabulary, for a host's own tests: each entry kind with its name
// pattern, the cut section ids, and every section's label (an options error raised
// inside a section reads `cut kit options: <label>: …`). Both modules are already in the
// app bundle through mount.js and download.js, and neither loads a kit builder.
export { KIT_KINDS } from "./framework/export/kit/entries.js";
export { SECTION_LABELS, cutSectionIds } from "./framework/export/kit/options.js";
// Which view mount() opens on — for a host that builds a part outside the viewer
// (a cached preview, a server-side render) and must agree with it.
export { resolveDefaultView } from "./framework/default-view.js";
