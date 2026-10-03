// Resolve a part's declared `fonts` ({ name: source }) to ArrayBuffers, before the
// synchronous build. A source is: an ArrayBuffer/Uint8Array (bytes), a URL string
// or `URL` instance (fetched — a Vite `import('./x.ttf')` yields { default: url }),
// or a thunk returning any of those (possibly async). Memoized process-wide by
// source so repeated builds don't refetch. DOM-free (uses global fetch, present in
// workers). Built on the shared resolution core in asset-resolve.js.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";

const cache = new Map(); // source (string|object) → Promise<ArrayBuffer>
const resolveOne = makeAssetResolver(
  cache,
  (bytes) => bytes,
  "resolveFonts: a font source must be bytes, a URL, or a thunk returning one",
);

// `fonts` may be a plain { name: source } map, or a function of the resolved
// params — the second form is what lets a `type: "font"` control drive the
// typeface. Resolving it needs `p`, which is why this is a separate step from
// resolveFonts rather than folded into it.
export { fontsFor } from "./asset-decls.js";

export async function resolveFonts(fontsDecl) {
  // A function reaching here means a caller passed `part.fonts` raw. It cannot
  // be resolved without params, and silently returning an empty map would show
  // up much later as `text2d: unknown font "…"`.
  if (typeof fontsDecl === "function") {
    throw new Error("resolveFonts: `fonts` is a function of params — resolve it with fontsFor(part, p) first");
  }
  return resolveDecl(fontsDecl, resolveOne);
}

// Drop one source's memo entry. jobs.js calls this once a font is PARSED: the
// parsed Font is what the kernel keeps (kernel._fontsBySource, bounded), so
// holding the raw ArrayBuffer here as well doubled the cost of every font a
// session ever auditioned and released none of it (spec 2026-10-01 §3).
export function forgetFontSource(source) {
  cache.delete(source);
}
