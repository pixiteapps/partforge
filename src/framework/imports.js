// Resolve a part's declared `imports` ({ name: source }) to bytes + a SHA-256
// content digest + a detected format, before the synchronous build — the
// import-asset sibling of fonts.js: same source grammar and identity-
// memoization rule (import sources are content-stable for a session), built on
// the shared resolution core in asset-resolve.js. DOM-free and node:-free;
// crypto.subtle exists in workers and Node.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";
import { parseStl } from "./geometry/stl-parse.js";
import { parse3MF } from "./geometry/threemf-parse.js";

const EXT = { step: "step", stp: "step", stl: "stl", "3mf": "3mf" };

// Font files declared as an import. Without this a TTF fell through to the STL
// fallback below and failed as "binary STL truncated: header says 3848966777
// triangles" — an error about a mesh the author never meant (cloud feedback #148).
const FONT_EXT = new Set(["ttf", "otf", "woff", "woff2"]);
const FONT_MAGIC = ["\x00\x01\x00\x00", "OTTO", "true", "ttcf", "wOFF", "wOF2"];

export function detectFormat(source, bytes) {
  const path = source instanceof URL ? source.pathname : typeof source === "string" ? source.split("?")[0] : null;
  const ext = path?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const magic = u8 && u8.length >= 4 ? String.fromCharCode(...u8.slice(0, 4)) : "";
  if ((ext && FONT_EXT.has(ext)) || FONT_MAGIC.includes(magic)) {
    throw new Error(`a font file${path ? ` ("${path}")` : ""} is declared under \`imports\` — declare it under \`fonts\` and use it with text2d`);
  }
  if (ext && EXT[ext]) return EXT[ext];
  if (u8 && u8.length > 0) {
    const head = String.fromCharCode(...u8.slice(0, 64));
    if (head.startsWith("ISO-10303-21")) return "step";
    if (u8[0] === 0x50 && u8[1] === 0x4b) return "3mf"; // zip signature
    return "stl"; // ascii "solid …" and binary STL both land here
  }
  throw new Error(`unrecognized import format${path ? ` for "${path}"` : ""} — use a .step/.stl/.3mf extension or non-empty bytes`);
}

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cache = new Map(); // source → Promise<{bytes, digest, format}>
const resolveOne = makeAssetResolver(
  cache,
  async (bytes, v, source) => {
    const format = detectFormat(source instanceof URL || typeof source === "string" ? source : v, bytes);
    return { bytes, digest: await sha256Hex(bytes), format };
  },
  "resolveImports: an import source must be bytes, a URL, or a thunk returning one",
);

export async function resolveImports(importsDecl) {
  return resolveDecl(importsDecl, resolveOne);
}

// Register a part's imports on a booted kernel (idempotent per digest). The
// framework calls this in the async phase before every job's synchronous
// build — worker (jobs.js) and Node boots (src/testing/) alike.
//
// Registration is total; errors are lazy (see the spec section of that name):
// every declared import registers on whichever kernel runs the job, and a
// format this kernel cannot use registers as an {error} entry that k.import
// throws at call time. That is what keeps a mixed-format declaration from
// poisoning unrelated jobs — the OCCT worker's tessellate-imports service
// job, or a per-backend generate group that never touches the unusable
// import. STEP on a mesh backend needs pre-tessellated triangles in
// `importMeshes`; absent, the entry carries code NEEDS_IMPORT_MESH and the
// first build to call k.import on it makes the host arrange tessellation
// (mount's needs-import-mesh flow in the browser, worker_threads in Node).
export async function ensureImports(kernel, importsDecl, importMeshes = null) {
  if (!importsDecl || typeof kernel._registerImport !== "function") return;
  const resolved = await resolveImports(importsDecl);
  for (const [name, a] of resolved) {
    if (kernel._importDigest?.(name) === a.digest) continue; // error entries answer undefined → always retried
    if (a.format === "step") {
      if (kernel._acceptsStep) { await kernel._registerImport({ name, digest: a.digest, step: a.bytes }); continue; }
      const m = importMeshes?.get?.(name);
      if (m && m.digest === a.digest) {
        await kernel._registerImport({ name, digest: a.digest, positions: m.positions, indices: m.indices });
      } else {
        const e = new Error(`import "${name}": STEP needs tessellation for the Manifold backend`);
        e.code = "NEEDS_IMPORT_MESH";
        await kernel._registerImport({ name, digest: a.digest, error: e });
      }
    } else if (kernel._acceptsMesh) {
      const { positions, indices } = a.format === "3mf" ? parse3MF(a.bytes) : parseStl(a.bytes);
      await kernel._registerImport({ name, digest: a.digest, positions, indices });
    } else {
      // No parse for a kernel that can't take the mesh — error entry directly.
      await kernel._registerImport({ name, digest: a.digest, error: new Error(
        `import "${name}": STL/3MF imports need the Manifold backend — this build routes to OCCT (shell or meta.backend, or a fillet/chamfer rerouted for an unsupported edge class); use the mesh import from a Manifold-routed build`) });
    }
  }
}
