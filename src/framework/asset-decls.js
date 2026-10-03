// The per-params asset DECLARATIONS a part makes — `fonts`, `images`, `vectors`, each
// a plain { name: source } map or a function of the resolved params (the second form
// is what lets a font/image/vector control drive the source). Resolving the
// declaration needs `p`, which is why this is its own step, separate from loading
// the sources (resolveFonts / ensureImages / ensureVectors).
//
// A leaf with no imports on purpose: the pose probe folds these declarations into
// its hash on the host page's main thread, and reaching them through vectors.js
// pulled in vector-format → contour-ops → paper, which builds a canvas at import
// (see test/mount-no-paper.test.js). fonts.js, images.js and vectors.js re-export
// these, so their importers are unchanged.
const declFor = (decl, p) => (typeof decl === "function" ? decl(p) : decl);

export function fontsFor(part, p) { return declFor(part?.fonts, p); }
export function imagesFor(part, p) { return declFor(part?.images, p); }
export function vectorsFor(part, p) { return declFor(part?.vectors, p); }
