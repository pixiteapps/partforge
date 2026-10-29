// Rigid 3×4 transforms and the named frame tree, for the implicit engine: core's
// geometry/xform.js, re-exported. The three helpers that can refuse a spec
// (axisVector, rotation, resolveFrames) throw core's SpecError (code "SPEC"); the
// engine's callers match on ImplicitSpecError (code "IMPLICIT_SPEC", grammar.js
// collects its `issues`), so those three are wrapped to rethrow it as one. The
// rest are pure arithmetic and pass straight through.
import * as xform from "../xform.js";
import { ImplicitSpecError } from "./errors.js";

export { IDENTITY, compose, invert, translation, xformPoint, xformDir } from "../xform.js";

/** `fn` with a core SpecError rethrown as an ImplicitSpecError carrying the same issues. */
const implicitly = (fn) => (...args) => {
  try { return fn(...args); }
  catch (e) { if (e?.code === "SPEC") throw new ImplicitSpecError(e.issues); throw e; }
};

export const axisVector = implicitly(xform.axisVector);
export const rotation = implicitly(xform.rotation);
export const resolveFrames = implicitly(xform.resolveFrames);
