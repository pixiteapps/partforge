// The subdivision cage: a coarse closed quad mesh an author box-models with k.cage(...).
export { createCage, isCage, MAX_CAGE_FACES } from "./cage.js";
export {
  subdivide,
  levelFor,
  chordError,
  SUBDIV_TOLERANCE,
  MIN_SUBDIV_LEVEL,
  MAX_SUBDIV_LEVEL,
} from "./surface.js";
