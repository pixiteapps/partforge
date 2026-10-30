// The organic domain's lint rules: geometry-free checks over the k.implicit and
// k.implicitFrames specs the validating probe records (probe.js keeps each call's
// arguments as JSON, and a spec is plain data, so it parses back whole). Specs are judged
// at the lint params, i.e. the default pose.
//
// Imports: lint/finding.js and nothing else from lint (the registry rule), and only the
// engine's pure modules — never implicit/index.js, which loads the mesher and native core.
import { err } from "../../lint/finding.js";
import { ROUTED_CAD_OPS } from "../../geometry/kernel.js";
import { validateSpec } from "../../geometry/implicit/grammar.js";
import { lowerSpec } from "../../geometry/implicit/ir.js";

const SPEC_OPS = new Set(["implicit", "implicitFrames"]);
const ROUTED = new Set(ROUTED_CAD_OPS);

// A 1×1 stand-in for each image a spec names: lowering needs pixels, and lint has none.
const STUB_IMAGE = Object.freeze({ width: 1, height: 1, data: Uint16Array.of(0), digest: "lint-stub" });

/** Every image name a spec reads: `textures` maps on expr-bearing nodes, and texture detail. */
function imageNamesIn(value, out = new Set()) {
  if (Array.isArray(value)) { for (const v of value) imageNamesIn(v, out); return out; }
  if (!value || typeof value !== "object") return out;
  if (value.kind === "texture" && typeof value.image === "string") out.add(value.image);
  if (value.textures && typeof value.textures === "object") {
    for (const t of Object.values(value.textures)) if (typeof t?.image === "string") out.add(t.image);
  }
  for (const v of Object.values(value)) imageNamesIn(v, out);
  return out;
}

/**
 * The distinct recorded specs, each compiled once: `{ op, spec, compiled, error }`, where
 * `error` is the ImplicitSpecError / ImplicitSizeError the build would throw. Image names
 * are checked only against a static `images` object (a function's result depends on
 * params); every named image is then lowered from a stub.
 */
const memo = new WeakMap();
export function implicitCalls({ part, probe }) {
  const run = probe();
  if (memo.has(run)) return memo.get(run);
  const known = typeof part?.images === "function" ? null
    : new Set(part?.images && typeof part.images === "object" ? Object.keys(part.images) : []);
  const seen = new Set(), out = [];
  for (const call of run.calls) {
    if (call.scope !== "kernel" || !SPEC_OPS.has(call.op) || seen.has(call.args[0])) continue;
    seen.add(call.args[0]);
    let spec;
    try { spec = JSON.parse(call.args[0]); } catch { continue; }
    if (!spec || typeof spec !== "object") continue;
    let compiled = null, error = null;
    try {
      validateSpec(spec, { imageNames: known });
      const images = new Map([...imageNamesIn(spec)].map((name) => [name, STUB_IMAGE]));
      compiled = lowerSpec(spec, { images });
    } catch (e) {
      if (e?.code !== "IMPLICIT_SPEC" && e?.code !== "IMPLICIT_SIZE") throw e;
      error = e;
    }
    out.push({ op: call.op, spec, compiled, error });
  }
  memo.set(run, out);
  return out;
}

export const ORGANIC_LINT_RULES = [
  {
    id: "implicit-spec-invalid",
    run: (ctx) => implicitCalls(ctx).filter((c) => c.error).map((c) => err("implicit-spec-invalid",
      `k.${c.op} spec is invalid: ${c.error.message.replace(/^implicit: /, "")}`,
      "Fix the spec as the message says — the build throws the same error. docs/domains/organic.md has the node reference.",
      "parts")),
  },
  {
    id: "implicit-needs-manifold",
    run: (ctx) => {
      if (!implicitCalls(ctx).some((c) => c.op === "implicit")) return [];
      const pinned = ctx.part?.meta?.backend === "occt";
      const routed = [...ctx.probe().solidUsed].filter((op) => ROUTED.has(op));
      if (!pinned && routed.length === 0) return [];
      const cause = pinned ? "meta.backend pins OCCT" : `\`${routed.join("`, `")}\` routes the part to OCCT`;
      return [err("implicit-needs-manifold",
        `the build calls k.implicit, which only the Manifold backend can build, but ${cause}`,
        pinned
          ? "Remove `meta.backend: \"occt\"` (or set it to \"manifold\"): the OCCT build throws on k.implicit."
          : "Build the OCCT-only feature in a separate part, or replace it with a mesh-friendly construction: the OCCT build throws on k.implicit.",
        "meta.backend")];
    },
  },
];
