// Integer lattice hash + trilinear value noise for implicit surface detail.
// The hash chains multiply-add steps through the murmur3 finaliser: each add is
// followed by `| 0`, which is int32 wraparound (ECMAScript ToInt32), and the C++
// port must reproduce that wrap exactly. `>>> 0` reads the final bits as uint32.
// Only Math.imul, xor/shift, + and floor on doubles, which the native core
// reproduces exactly.
const fin = (h) => { h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h; };
export function latticeHash(i, j, l) {
  const h = fin((Math.imul(fin((Math.imul(i | 0, 0x27d4eb2d) + (j | 0)) | 0), 0x165667b1) + (l | 0)) | 0);
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

/** Trilinear value noise in [-0.5, 0.5), period-free, continuous. */
export function valueNoise(x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const ux = fade(x - fx), uy = fade(y - fy), uz = fade(z - fz);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
    acc += latticeHash(fx + dx, fy + dy, fz + dz) * w;
  }
  return acc - 0.5;
}
