// Facts of the cached-preview format shared by its writer (encode-preview.js) and its
// reader (decode-preview.js). Import-free, so the reader does not pull in gltf-transform.

// POSITION precision (bits, signed) the writer quantizes every surface to: gltf-transform's
// quantize() default, passed to it explicitly. One step of it is the mesh's widest extent
// / (2^bits − 1); the reader reports that step beside a payload's ties (`ties.step`), since
// it bounds how far a decoded position may sit from where its tie places it.
export const PREVIEW_POSITION_BITS = 14;
