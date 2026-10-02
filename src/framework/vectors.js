// Resolve a part's declared `vectors` ({ name: source }) to internal regions before
// the synchronous build — the vector-art sibling of fonts.js and imports.js:
// same source grammar and identity-memoization rule, built on the shared core in
// asset-resolve.js. The source resolves to JSON in the partforge-vector format,
// not to SVG; conversion happened once, in a browser, at ingest.
//
// No content digest, deliberately. It looks like a missing piece next to
// imports.js and is not: k.vector2d lowers to k.shape2d(regions) and the Shape2D
// hash keys on the actual coordinates, so different artwork gives a different
// cache entry automatically. Imports need a digest because a Solid master is
// registered by NAME and is opaque to that hash; parsed regions are not. Same
// argument kernel-front.js:117-121 records for text2d.
//
// DOM-free and node:-free.
import { makeAssetResolver, resolveDecl, unwrapModule } from "./asset-resolve.js";
import { toInternalDocument } from "./geometry/vector-format.js";

const cache = new Map();   // source → Promise<Uint8Array> (raw bytes)
// source → { units, shapes }. The bytes memo above stops a refetch; this stops a re-PARSE
// (UTF-8 decode + JSON.parse + validation + a bbox recomputation that tessellates
// every contour). Without it every regen of a part with artwork redoes all of that.
// Fonts solve the same problem with kernel._fontsBySource (jobs.js:277-312), a bounded
// LRU keyed by source and the only holder of a parsed font (the resolver's memo is
// transient); imports use a digest comparison. This is the third pipeline's version.
// Keyed on the SOURCE, not the name: one worker outlives many parts, and a name is
// not an identity. Only successes are cached — a parse failure must throw again
// under the next name that declares it, with that name in the message.
const parsed = new Map();

// A source that IS the parsed contents of a partforge-vector file, rather than a
// way to reach its bytes — the in-tree form, `import doc from "./x.vector.json"`.
// Returns that object, or null for every other source form.
//
// `unwrapModule` first, so a dynamic `import("./x.vector.json")` namespace reads
// the same as the static default import, matching the rule the resolver applies
// to bytes and URLs.
//
// Deliberately STRUCTURAL, not a format check: anything object-shaped is claimed
// here and judged afterwards by toInternalDocument, so an object that is not
// artwork draws the validator's specific complaint (`has format "svg"`) rather
// than the source grammar's generic one. Arrays are not claimed — an array is
// never a file, and for it the grammar error names the real mistake.
function asParsedFile(source) {
  const v = unwrapModule(source);
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof URL) return null;
  return v;
}

// `payload` is what resolveOne produced: the resolved bytes, or — for a source
// `asParsedFile` claimed — the file's contents themselves, already parsed.
function parseDocument(payload, label) {
  if (!(payload instanceof ArrayBuffer)) return toInternalDocument(payload, label);
  let text;
  try { text = new TextDecoder().decode(payload); }
  catch { throw new Error(`vector2d: "${label}" could not be decoded as UTF-8 text`); }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) {
    throw new Error(`vector2d: "${label}" is not valid JSON — ${e.message}. `
      + "A vectors source is an ingested partforge-vector file, not an .svg file; see docs/VECTOR-FORMAT.md");
  }
  return toInternalDocument(doc, label);
}

// source -> resolved bytes, recorded only once a source has SUCCESSFULLY resolved.
// `cache` above cannot answer that question: makeAssetResolver stores the promise
// synchronously, so `cache.has(source)` is true the instant a fetch starts and
// stays true if it never finishes. This map is what `cachedVectorDocs` reads, and
// its whole point is that membership means "the bytes are here, now".
const bytesBySource = new Map();
// source -> raw parsed JSON, or null if it is not a JSON object. Filled LAZILY by
// cachedVectorDocs rather than at resolve time, so the build path never pays a
// JSON.parse for lint's benefit, and lint never re-parses the same file twice.
const rawBySource = new Map();

// The resolver memoizes by source identity and cannot see the declared name, so
// the name is bound per declaration below rather than baked into the resolver.
const resolveOne = makeAssetResolver(
  cache,
  (bytes, _value, source) => { bytesBySource.set(source, bytes); return bytes; },
  "resolveVectors: a vector source must be bytes, a URL, a thunk returning one, "
    + "or the already-parsed contents of a partforge-vector file",
  (value) => asParsedFile(value) ?? undefined,
);

// `vectors` may be a plain { name: source } map, or a function of the resolved
// params — the second form is what lets a `type: "vector"` control drive the
// artwork. Resolving it needs `p`, which is why this is a separate step from
// resolveVectors rather than folded into it. Mirrors fontsFor/imagesFor.
export function vectorsFor(part, p) {
  const decl = part?.vectors;
  return typeof decl === "function" ? decl(p) : decl;
}

export async function resolveVectors(vectorsDecl) {
  // A function reaching here means a caller passed `part.vectors` raw, the way
  // fonts.js's resolveFonts guards against the same mistake for `part.fonts`.
  // `Object.entries` on a function is `[]`, not a thrown error, so without
  // this check a function-valued `vectors` would silently resolve to an empty
  // map and only surface much later as `vector2d: unknown vector "…"` — a name a
  // part author declared correctly, that k.vector2d insists doesn't exist. No
  // part currently declares `vectors` as a function (unlike fonts, which a
  // `type: "font"` control already drives this way) — this exists so the
  // day that form is added, it fails loudly instead of silently.
  if (typeof vectorsDecl === "function") {
    throw new Error("resolveVectors: `vectors` is a function — it is not resolved against params yet; pass the plain object form");
  }
  const raw = await resolveDecl(vectorsDecl, resolveOne);
  const out = new Map();
  for (const [name, payload] of raw) {
    let doc = parsed.get(payload);
    if (!doc) { doc = parseDocument(payload, name); parsed.set(payload, doc); }
    out.set(name, doc);
  }
  return out;
}

// The RAW parsed JSON, before validation or conversion — what lint's
// document-dependent rules need to read `units` and `shapes`. Never throws: a
// source that will not fetch, decode, or parse (to a JSON object) maps to
// null, and the rules that depend on it stay quiet for that name only —
// resolution is PER-SOURCE, not all-or-nothing, so one broken vector among
// several does not silence document-aware lint for its siblings. Deliberately
// calls `resolveOne` itself rather than going through `resolveDecl` (whose
// `Promise.all` rejects the whole batch on a single failure) — this still
// shares `resolveOne`'s bytes memo with resolveVectors, so running `lint`
// ahead of `measure` (the CLI does both) costs no extra fetch. It does its own
// decode/parse rather than reusing the `parsed` memo, which holds the
// VALIDATED/converted document, not the raw JSON this needs.
export async function resolveVectorDocs(vectorsDecl) {
  if (typeof vectorsDecl === "function") return new Map();
  const decl = vectorsDecl ?? {};
  const out = new Map();
  await Promise.all(Object.entries(decl).map(async ([name, source]) => {
    try {
      const payload = await resolveOne(source);
      // An adopted source resolves to the raw JSON itself — there is nothing to
      // decode, and running it through TextDecoder would map a perfectly good
      // file to null.
      const doc = payload instanceof ArrayBuffer
        ? JSON.parse(new TextDecoder().decode(payload))
        : payload;
      out.set(name, doc && typeof doc === "object" ? doc : null);
    } catch {
      out.set(name, null);
    }
  }));
  return out;
}

// The SYNCHRONOUS, FETCH-FREE sibling of resolveVectorDocs: the raw parsed JSON
// for every declared vector whose bytes are ALREADY resolved, and nothing for the
// rest. Never fetches, never awaits, never throws.
//
// This exists because lint is instant and offline BY CONSTRUCTION — that is the
// property that lets a browser sandbox run it on every keystroke — and calling
// the async resolver from the lint path quietly gave that away: a slow or hanging
// vector URL (asset-resolve.js's fetch has no timeout) would stall the lint reply
// forever, and a throwing `vectors` getter would reject in a floating promise,
// which surfaces as `unhandledrejection` rather than an `error` event, so a host
// waiting on a lint-report simply waits.
//
// The degradation is the one the two document-dependent rules are designed for:
// no document, no finding. In a hosted sandbox a build has almost always run
// first, so the bytes are already in the memo and both rules light up; before the
// first build they stay silent, exactly as they do today for a caller that passes
// no vectorDocs at all. Nothing regresses, and lint cannot become slower or
// hangable than it was before vectors existed.
//
// `decl` is caller data all the way down (a throwing getter, a Proxy whose
// ownKeys trap throws), so every step that touches it is guarded per-name and the
// whole walk is guarded once.
export function cachedVectorDocs(vectorsDecl) {
  const out = new Map();
  if (!vectorsDecl || typeof vectorsDecl !== "object") return out;
  let entries;
  try { entries = Object.entries(vectorsDecl); } catch { return out; }
  for (const entry of entries) {
    try {
      const [name, source] = entry;
      // An already-parsed source has nothing to resolve, so unlike bytes and URLs
      // it is readable on the very first lint — before any build has run. That is
      // the state a hosted editor spends most of its time in.
      const inline = asParsedFile(source);
      if (inline) { out.set(name, inline); continue; }
      if (!bytesBySource.has(source)) continue;        // not resolved yet — stay silent
      if (!rawBySource.has(source)) {
        let doc = null;
        try {
          const parsedJson = JSON.parse(new TextDecoder().decode(bytesBySource.get(source)));
          doc = parsedJson && typeof parsedJson === "object" ? parsedJson : null;
        } catch { doc = null; }                        // not JSON, or not decodable
        rawBySource.set(source, doc);
      }
      out.set(name, rawBySource.get(source));
    } catch { /* one hostile entry silences itself, not its siblings */ }
  }
  return out;
}

// Register a part's vectors on a booted kernel. Called in the async phase before
// every job's synchronous build — worker (jobs.js) and Node boots alike.
export async function ensureVectors(kernel, vectorsDecl) {
  if (!kernel?._vectors) return;
  const declared = vectorsDecl ?? {};
  for (const [name, doc] of await resolveVectors(declared)) kernel._vectors.set(name, doc);
  // Drop names this declaration does not supply. `_vectors` is the kernel's and the
  // kernel outlives the job (worker-rebind, many parts), so without this a name
  // from a previous part stays resolvable — the stale-registration bug jobs.js's
  // font prune exists to prevent.
  for (const name of [...kernel._vectors.keys()]) {
    if (!Object.hasOwn(declared, name)) kernel._vectors.delete(name);
  }
}
