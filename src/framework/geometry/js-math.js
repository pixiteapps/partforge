// partforge's own hypot, for the passes the native core (src/framework/core/)
// mirrors in C++ — creased-normals.js, blend-surfaces.js and min-wall.js.
//
// Math.hypot is not one function: JavaScriptCore computes it as libc++'s fused
// std::hypot(x, y, z) and V8 as a Kahan-summed sum of scaled squares, and the
// two disagree in the last bit on about a third of inputs — so the same part
// shaded, measured and hashed slightly differently in Safari and in Chrome, and
// no C++ could match "the JS" in both. This is three multiplies, two adds and a
// correctly rounded square root, each rounded in order: the same on every
// engine (JS never fuses), and reproduced exactly by native/js_math.h.
//
// No overflow scaling: inputs are millimetre coordinates and their
// differences, nowhere near 1e154. Keep this file and native/js_math.h in step.
export const hypot3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
