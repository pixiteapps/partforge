// Builds the native core (native/*.cpp) into WebAssembly, as TWO modules, each a plain
// ES module holding base64 bytes and stamped with a hash of the sources and flags:
//
//   src/framework/core/core-wasm.js        the BASE build: creased normals and the BVH
//       only (BASE_SOURCES), scalar. Every worker imports it statically, so it is what
//       every part's first load pays for — keep it small (test/core-wasm.test.js caps it).
//   src/framework/core/core-full-wasm.js   the FULL build: every source, the implicit
//       engine included, in a scalar and a SIMD variant (SIMD_FLAGS, below). core.js
//       imports it dynamically (loadFullCore), so only a part that calls k.implicit
//       downloads it; once loaded it replaces the base build for every pass.
//
//   node scripts/build-core-wasm.mjs            # needs Emscripten's em++ on PATH
//   node scripts/build-core-wasm.mjs --check    # no compiler: exit 1 if stale
//
// Why a JS module and not a .wasm file: partforge ships as source and runs in a
// browser worker, Node (CLI, tests, a host's server), and hosts that load it from
// a blob: URL. A sibling .wasm would need a loader per environment (fetch vs fs,
// asset URLs a bundler must rewrite); an import works the same everywhere, and the
// module instantiates synchronously from the bytes.
//
// The generated file is committed. test/core-wasm.test.js recomputes the source
// hash (no compiler needed) so a C++ edit without a rebuild fails CI.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NATIVE = join(ROOT, "native");
const OUT = join(ROOT, "src", "framework", "core", "core-wasm.js");
const OUT_FULL = join(ROOT, "src", "framework", "core", "core-full-wasm.js");

// The base build's translation units; every other native/*.cpp is the implicit engine,
// which only the full build carries. The implicit sources include none of these.
export const BASE_SOURCES = ["blend_surfaces.cpp", "bvh.cpp", "creased_normals.cpp"];

export const BASE_EXPORTS = [
  "malloc", "free",
  "cn_create", "cn_finish", "cn_positions", "cn_normals", "cn_edges", "cn_edge_floats",
  "cn_feature_ids", "cn_feature_count", "cn_feature_labels", "cn_destroy",
  "bvh_build", "bvh_triangle_count", "bvh_root_bounds", "bvh_raycast", "bvh_closest_point",
  "bvh_distance_to", "bvh_min_wall", "bvh_fingerprint", "bvh_destroy",
];
export const EXPORTS = [
  ...BASE_EXPORTS,
  "ip_math_probe", "ip_bracket_probe",
  "ip_session_create", "ip_session_destroy", "ip_tex_add", "ip_prog_add", "ip_eval", "ip_eval_contact",
  "ip_sample", "ip_sample_cached", "ip_leaf_vals", "ip_leaf_owners", "ip_clipped",
  "ip_mesh", "ip_vertex_count", "ip_positions", "ip_index_count", "ip_indices", "ip_vert_leaf",
  "ip_mesh_load", "ip_project", "ip_cleanup", "ip_normals", "ip_detail",
  "ip_set_contact", "ip_mesh_owners", "ip_crease", "ip_untangle",
  "ip_vert_owner", "ip_owner_held", "ip_pinned", "ip_crease_marks", "ip_tri_owners",
];
// -ffp-contract=off: the core must round every operation exactly as the JS does
// (see native/js_math.h). WebAssembly has no FMA to fuse into, but say so anyway.
export const FLAGS = [
  "-O3", "-std=c++17", "-fno-exceptions", "-fno-rtti", "-ffp-contract=off",
  "--no-entry", "-sSTANDALONE_WASM", "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=16MB",
];
const exported = (names) => `-sEXPORTED_FUNCTIONS=${names.map((e) => `_${e}`).join(",")}`;

// The full module is built twice from the same sources and FLAGS: once scalar, and once
// with SIMD_FLAGS added, which lets the compiler vectorize ANY loop in any
// translation unit into wasm SIMD. That is safe for parity only because the
// vector ops it may use are per-lane exact: f64x2 add/sub/mul/div/sqrt round each
// lane exactly as the scalar op, and without -ffast-math nothing is reassociated or
// fused. The rule for C++ edits is the same as ever (per-lane IEEE ops, the JS's
// order); never add -mrelaxed-simd (its madd fuses) or -ffast-math. core.js boots
// the SIMD module when the engine validates a v128 probe, else the scalar one, so
// an engine without wasm SIMD still gets the whole core; the parity suites run both.
// The base module is scalar only: its passes gain little from SIMD, and a second
// variant would double what every part's first load downloads.
export const SIMD_FLAGS = ["-msimd128"];

// The hash covers every source file's bytes (sorted by name) and the flags.
export function sourceHash() {
  const h = createHash("sha256");
  for (const f of readdirSync(NATIVE).filter((n) => /\.(h|cpp)$/.test(n)).sort()) {
    h.update(f).update("\0").update(readFileSync(join(NATIVE, f))).update("\0");
  }
  h.update(FLAGS.join(" ")).update("\0").update(SIMD_FLAGS.join(" "));
  h.update("\0").update(BASE_SOURCES.join(" ")).update("\0").update(BASE_EXPORTS.join(" ")).update("\0").update(EXPORTS.join(" "));
  return h.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hash = sourceHash();
  if (process.argv.includes("--check")) {
    for (const [file, name] of [[OUT, "CORE_SOURCE_HASH"], [OUT_FULL, "CORE_FULL_SOURCE_HASH"]]) {
      const current = new RegExp(`${name} = "([0-9a-f]+)"`).exec(readFileSync(file, "utf8"))?.[1];
      if (current !== hash) { console.error(`${file} is stale: rebuild with node scripts/build-core-wasm.mjs`); process.exit(1); }
    }
    console.log("core-wasm.js and core-full-wasm.js are current");
    process.exit(0);
  }
  const tmp = mkdtempSync(join(tmpdir(), "pf-core-"));
  try {
    const all = readdirSync(NATIVE).filter((n) => n.endsWith(".cpp")).sort();
    const build = (names, exports, extra, out) => {
      const wasm = join(tmp, out);
      execFileSync("em++", [...FLAGS, exported(exports), ...extra, ...names.map((n) => join(NATIVE, n)), "-o", wasm], { stdio: "inherit" });
      return readFileSync(wasm);
    };
    const base = build(BASE_SOURCES, BASE_EXPORTS, [], "core-base.wasm");
    const scalar = build(all, EXPORTS, [], "core.wasm"), simd = build(all, EXPORTS, SIMD_FLAGS, "core-simd.wasm");
    const version = execFileSync("em++", ["--version"], { encoding: "utf8" }).split("\n")[0];
    const head = [
      "// GENERATED by scripts/build-core-wasm.mjs from native/ — do not edit by hand.",
      `// ${version}`,
    ];
    const tail = [
      "// test/core-wasm.test.js checks the hash below against native/ so a C++ change",
      "// without a rebuild fails.",
    ];
    writeFileSync(OUT, [
      ...head,
      `// The BASE build (${BASE_SOURCES.join(", ")}): ${base.length} bytes of scalar WebAssembly.`,
      "// Every worker loads this file; the implicit engine is in core-full-wasm.js.",
      ...tail,
      `export const CORE_SOURCE_HASH = "${hash}";`,
      `export const CORE_WASM_BASE64 = "${base.toString("base64")}";`,
      "",
    ].join("\n"));
    writeFileSync(OUT_FULL, [
      ...head,
      `// The FULL build (every native/*.cpp): ${scalar.length} bytes of scalar WebAssembly, ${simd.length} built`,
      `// with ${SIMD_FLAGS.join(" ")} (core.js picks). Loaded on demand (core.js loadFullCore).`,
      ...tail,
      `export const CORE_FULL_SOURCE_HASH = "${hash}";`,
      `export const CORE_FULL_WASM_BASE64 = "${scalar.toString("base64")}";`,
      `export const CORE_FULL_WASM_SIMD_BASE64 = "${simd.toString("base64")}";`,
      "",
    ].join("\n"));
    console.log(`wrote ${OUT} (${base.length} bytes) and ${OUT_FULL} (${scalar.length} bytes scalar + ${simd.length} bytes SIMD wasm)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
