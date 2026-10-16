// TEST-ONLY export: lets test/implicit-native-math.test.js compare the native
// implicit math against its JS twins bit for bit. Nothing in the product calls it.
#include "implicit_math.h"

extern "C" {
// fn: 0 sin(a), 1 cos(a), 2 atan2(a, b), 3 hash(a, b, c), 4 noise(a, b, c).
double ip_math_probe(int fn, double a, double b, double c) {
  switch (fn) {
    case 0: return ipm::pf_sin(a);
    case 1: return ipm::pf_cos(a);
    case 2: return ipm::pf_atan2(a, b);
    case 3: return ipm::lattice_hash(a, b, c);
    case 4: return ipm::value_noise(a, b, c);
    default: return NAN;
  }
}
}
