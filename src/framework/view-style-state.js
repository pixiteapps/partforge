// src/framework/view-style-state.js
// The view style popover's pure half: which styles exist, what feature lines
// default to in each, and the thumbnail cache's freshness. No DOM, no three —
// view-style-controls.js is the DOM, the viewer owns the lines themselves.
import { ENVIRONMENTS } from "./materials/environments.js";

// CAD first, then the environments in their declared order.
export const STYLES = [
  { id: "cad", label: "CAD" },
  ...Object.values(ENVIRONMENTS).map(({ id, label }) => ({ id, label })),
];

// CAD is a drawing, so its edges are on; a realistic style is a photograph,
// so they start off — the behaviour before the switch existed.
export const defaultFeatureLines = (style) => style === "cad";

export const styleFor = (renderMode, environmentId) => (renderMode === "realistic" ? environmentId : "cad");

// Thumbnails are rendered on OPEN and cached. `invalidate` (a part or theme
// change) only marks them stale — the next open re-renders. A render already
// in flight keeps painting (view-style-controls.js says why).
export function createThumbnailCache() {
  const images = new Map();
  let stale = true;
  return {
    get: (id) => images.get(id),
    set: (id, url) => { images.set(id, url); },
    isStale: () => stale,
    markFresh: () => { stale = false; },
    invalidate: () => { stale = true; },
  };
}
