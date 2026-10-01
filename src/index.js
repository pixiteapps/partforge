// partforge — app entry (DOM). Apps call mount(); viewSubParts is handy for app-side
// view logic. This entry pulls in the viewer/controls (which use `document`), so it
// must NOT be imported from a part's build functions — those run in a Web Worker.
// Part build functions import geometry helpers from "partforge/geometry" instead.
export { mount } from "./framework/index.js";
export { viewSubParts } from "./framework/part-model.js";
// The cut & print kit's options surface, for a host that draws its own options screen
// (partforge-cloud's coupling test reads KIT_OPTIONS_ERROR from here). export/formats.js
// is import-free, so this adds nothing to the app bundle but a few constants.
export { EXPORT_FORMATS, KIT_OPTIONS_ERROR, KIT_DEFAULTS, validateKitOptions } from "./framework/export/formats.js";
