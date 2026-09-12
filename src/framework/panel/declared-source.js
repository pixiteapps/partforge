// What a part is ACTUALLY using for an asset key, when the control's own param
// is empty.
//
// The problem this solves is not cosmetic. A part's bundled default lives in the
// `images`/`vectors` DECLARATION, never in `defaults` — an author cannot move it
// there, because the allow list passes only `https` and a bundled asset resolves
// to a `file:`/dev URL, so `defaults: { relief: new URL(…) }` is refused and
// reset. The declaration is therefore the only home for it, and the panel could
// not see the declaration at all: `buildControls` receives `part.parameters`.
// The result was a control that opened empty while the part was plainly building
// from an image.
//
// Main-thread only, and deliberately import-free beyond what a lookup needs: it
// runs during panel construction, on every rebuild.

// `images`/`vectors`/`fonts` may each be a plain map or a function of params —
// the function form is what a control drives. Resolving it can throw (it is
// author code running on every panel build), and a broken declaration must not
// take the panel down: the control simply shows nothing, which is the same thing
// it showed before this existed.
function resolveDecl(decl, params) {
  try {
    return typeof decl === "function" ? decl(params) : decl;
  } catch {
    return undefined;
  }
}

const FIELD = { image: "images", vector: "vectors", font: "fonts" };

// URL-shaped for the same reason lint's probes are: a declaration may parse the
// value it is handed, and an arbitrary string would make it throw for reasons
// that have nothing to do with which asset the key feeds.
const SENTINEL = "pf-panel-sentinel://declared-source";

/**
 * Build `(kind, key) => source | undefined` for one part and its current params.
 *
 * Returns `undefined` when the param already holds a value: the param IS the
 * user's choice, and the declaration for that key is derived from it. Only an
 * empty param falls through to whatever the part declared.
 */
export function declaredSourceLookup(part, params) {
  return (kind, key) => {
    const own = params?.[key];
    if (own !== undefined && own !== null && own !== "") return undefined;

    const decl = part?.[FIELD[kind]];
    const resolved = resolveDecl(decl, params ?? {});
    if (!resolved || typeof resolved !== "object") return undefined;

    // A control's param key is NOT necessarily the asset's name. emblem.js
    // declares `vectors: (p) => ({ emblem: p.art || bundled })` — key `art`,
    // asset `emblem`. relief.js happens to use the same word for both, which is
    // what makes the assumption look safe until it is not.
    //
    // So probe, the way lint's *-control-not-in-* rules already do: resolve the
    // declaration once with a sentinel in this key and see which asset name it
    // came out under. A URL-shaped sentinel, because a declaration is free to
    // parse what it is handed and an arbitrary string would make it throw for
    // reasons unrelated to the mapping.
    let name = key;
    if (typeof decl === "function" && !(key in resolved)) {
      const probe = resolveDecl(decl, { ...(params ?? {}), [key]: SENTINEL });
      const hit = probe && typeof probe === "object"
        && Object.keys(probe).find((n) => probe[n] === SENTINEL);
      if (!hit) return undefined;   // this key feeds nothing — not our asset
      name = hit;
    }

    const source = resolved[name];
    return source == null || source === "" ? undefined : source;
  };
}

/**
 * A declared image source -> something an `<img>` can load, or `undefined`.
 *
 * The allow list gates PARAMS, not author declarations, so a `file:` or dev URL
 * is perfectly fine to display here — the browser is loading it, nothing is
 * being accepted from an untrusted link.
 */
export async function declaredImageUrl(source) {
  try {
    let v = typeof source === "function" ? await source() : source;
    // A Vite `() => import("./x.png")` resolves to `{ default: url }`.
    if (v && typeof v === "object" && !(v instanceof URL) && "default" in v) v = v.default;
    if (v instanceof URL) return v.href;
    if (typeof v === "string" && v) return v;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      return URL.createObjectURL(new Blob([v], { type: "image/png" }));
    }
    return undefined;
  } catch {
    return undefined;   // a thunk that rejects shows nothing, it does not propagate
  }
}

/**
 * A declared vector source -> its parsed document, or `undefined`.
 *
 * Unlike an image there is nothing to point at: the thumbnail is drawn from the
 * document's own contours, so the file has to be fetched and parsed. Results are
 * memoised per source, because a panel rebuild would otherwise refetch on every
 * slider drag.
 */
const vectorDocs = new Map();
export async function declaredVectorDoc(source) {
  if (source == null) return undefined;
  if (typeof source === "object" && !(source instanceof URL) && !("default" in source)) return source;
  if (vectorDocs.has(source)) return vectorDocs.get(source);
  const p = (async () => {
    try {
      let v = typeof source === "function" ? await source() : source;
      if (v && typeof v === "object" && !(v instanceof URL) && "default" in v) v = v.default;
      if (v && typeof v === "object" && !(v instanceof URL)) return v;   // already parsed
      const res = await fetch(v instanceof URL ? v.href : v);
      if (!res.ok) return undefined;
      return await res.json();
    } catch {
      return undefined;   // offline, 404, CORS, malformed JSON — all show nothing
    }
  })();
  vectorDocs.set(source, p);
  return p;
}
