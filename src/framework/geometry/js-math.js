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

// partforge's own sin/cos/atan2 for code the native core will mirror (the
// implicit engine's expr formulas, warps and surface detail). Math.sin & co. are
// not one function across engines or libms, so a C++ port could never match
// "the JS"; these are fdlibm's kernels — only + − × and floor, each rounded in
// order — so native/js_math.h can reproduce them bit for bit (PR 2 ports them).
// Accuracy: a few ulp for |x| below ~1e5 (one-step Cody–Waite reduction), which
// is all an implicit formula in millimetres needs; larger inputs stay
// deterministic, just less accurate.
const INVPIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
  S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
  S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
  C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
  C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
const kSin = (r) => { const z = r * r, v = z * r; return r + v * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6))))); };
const kCos = (r) => { const z = r * r; return 1 - (0.5 * z - z * (z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))))); };
const quadrant = (n) => ((n % 4) + 4) % 4;
export function pfSin(x) {
  const n = Math.floor(x * INVPIO2 + 0.5), r = (x - n * PIO2_1) - n * PIO2_1T, q = quadrant(n);
  return q === 0 ? kSin(r) : q === 1 ? kCos(r) : q === 2 ? -kSin(r) : -kCos(r);
}
export function pfCos(x) {
  const n = Math.floor(x * INVPIO2 + 0.5), r = (x - n * PIO2_1) - n * PIO2_1T, q = quadrant(n);
  return q === 0 ? kCos(r) : q === 1 ? -kSin(r) : q === 2 ? -kCos(r) : kSin(r);
}
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
  -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
  6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
  -3.65315727442169155270e-02, 1.62858201153657823623e-02];
function pfAtan(x) { // fdlibm s_atan.c
  const neg = x < 0;
  let ax = neg ? -x : x, id;
  if (ax < 0.4375) id = -1;
  else if (ax < 0.6875) { id = 0; ax = (2 * ax - 1) / (2 + ax); }
  else if (ax < 1.1875) { id = 1; ax = (ax - 1) / (ax + 1); }
  else if (ax < 2.4375) { id = 2; ax = (ax - 1.5) / (1 + 1.5 * ax); }
  else { id = 3; ax = -1 / ax; }
  const z = ax * ax, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  const r = id < 0 ? ax - ax * (s1 + s2) : ATANHI[id] - ((ax * (s1 + s2) - ATANLO[id]) - ax);
  return neg ? -r : r;
}
const PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16, PIO2 = 1.5707963267948965580e+00;
/** atan2 for the implicit engine. Both zeros give 0 (signed zeros are not distinguished). */
export function pfAtan2(y, x) {
  if (x !== x || y !== y) return NaN;
  if (x === 0) return y > 0 ? PIO2 : y < 0 ? -PIO2 : 0;
  const a = pfAtan(Math.abs(y / x));
  if (x > 0) return y < 0 ? -a : a;
  return y < 0 ? -(PI - (a - PI_LO)) : PI - (a - PI_LO);
}
