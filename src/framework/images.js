// Resolve a part's declared `images` ({ name: source }) to a decoded luminance
// grid + a SHA-256 content digest, before the synchronous build — the third
// asset sibling beside fonts.js and imports.js, on the shared resolution core in
// asset-resolve.js. DOM-free and node:-free; crypto.subtle exists in workers and
// Node.
//
// Registration is simpler than imports': every backend can consume a normalized
// grid, so there are no per-format error entries and no crossover.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";
import { decodePng } from "./geometry/png-decode.js";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cache = new Map(); // source → Promise<{digest, width, height, data}>
const resolveOne = makeAssetResolver(
  cache,
  async (bytes) => {
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < 4; i++) {
      if (u8[i] !== PNG_SIG[i]) {
        throw new Error(
          "images: only PNG is supported — convert with imageToPng() from \"partforge/ingest\" before storing, " +
          "or have the host normalize on upload",
        );
      }
    }
    const { width, height, data } = decodePng(u8);
    return { digest: await sha256Hex(bytes), width, height, data };
  },
  "resolveImages: an image source must be bytes, a URL, or a thunk returning one",
);

// `images` may be a plain { name: source } map or a function of the resolved
// params — the second form is what lets a `type: "image"` control drive the
// source. Mirrors fontsFor.
export { imagesFor } from "./asset-decls.js";

export async function resolveImages(imagesDecl) {
  // A function reaching here means a caller passed `part.images` raw. It
  // cannot be resolved without params — resolve it with imagesFor(part, p)
  // first (mirrors resolveFonts's guard in fonts.js).
  if (typeof imagesDecl === "function") {
    throw new Error("resolveImages: `images` is a function of params — resolve it with imagesFor(part, p) first");
  }
  return resolveDecl(imagesDecl, resolveOne);
}

// Register a part's images on a booted kernel (idempotent per digest). Called in
// the async phase before every job's synchronous build — worker (jobs.js) and
// Node boots alike.
export async function ensureImages(kernel, imagesDecl) {
  if (!imagesDecl || typeof kernel?._registerImage !== "function") return;
  const resolved = await resolveImages(imagesDecl);
  for (const [name, a] of resolved) {
    if (kernel._imageDigest?.(name) === a.digest) continue;
    await kernel._registerImage({ name, digest: a.digest, width: a.width, height: a.height, data: a.data });
  }
}
