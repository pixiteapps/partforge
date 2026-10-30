// The organic domain's lint rules: geometry-free checks over the k.implicit and
// k.implicitFrames specs the validating probe records (probe.js keeps each call's
// arguments as JSON, and a spec is plain data, so it parses back whole). Specs are judged
// at the lint params, i.e. the default pose.
//
// Imports: lint/finding.js and nothing else from lint (the registry rule), and only the
// engine's pure modules — never implicit/index.js, which loads the mesher and native core.
import { err, note, warn } from "../../lint/finding.js";
import { ROUTED_CAD_OPS } from "../../geometry/kernel.js";
import { validateSpec } from "../../geometry/implicit/grammar.js";
import { lowerSpec } from "../../geometry/implicit/ir.js";
import { IMPLICIT_DEFAULTS } from "../../geometry/implicit/compile.js";
import { choosePreviewEdge } from "../../geometry/implicit/preview-edge.js";
import { compileExprSource, evalExprScalar } from "../../geometry/implicit/expr-lower.js";

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

const compiledCalls = (ctx) => implicitCalls(ctx).filter((c) => c.compiled && c.op === "implicit");
const mm = (v) => `${v.toFixed(2)} mm`;

// Kinds a sharp-edged CAD model is made of; any other kind (a sphere, a warp, round,
// onion, displace, expr, contact) is what k.implicit is for.
const CAD_KINDS = new Set(["box", "cylinder", "halfspace", "union", "intersect", "subtract", "mirror", "repeat"]);
/** Every node of a raw spec tree, through `root`, `children` and `child`. */
function* specNodes(node) {
  if (!node || typeof node !== "object") return;
  yield node;
  for (const c of node.children ?? []) yield* specNodes(c);
  if (node.child) yield* specNodes(node.child);
}
/** `[node, path]` for every node of a raw spec tree, paths as the engine writes them. */
function* specPaths(node, path = "root") {
  if (!node || typeof node !== "object") return;
  yield [node, path];
  for (const [i, c] of (node.children ?? []).entries()) yield* specPaths(c, `${path}.children[${i}]`);
  if (node.child) yield* specPaths(node.child, `${path}.child`);
}

// The lipschitz spot check: N³ lattice points across the expr's box, a central difference
// at each, and the RANK-th largest gradient norm (a kink — abs, max — can spike a few
// differences above the true bound). At most MAX_EXPRS formulas per lint run.
const LATTICE = 8, RANK = 5, MAX_EXPRS = 8, SLACK = 1.1;
function sampledSlope(L, [lo, hi]) {
  const h = 1e-3 * Math.hypot(...hi.map((v, a) => v - lo[a]));
  const f = (x, y, z) => evalExprScalar(L, x, y, z, [], null);
  const norms = [];
  for (let i = 0; i < LATTICE; i++) for (let j = 0; j < LATTICE; j++) for (let k = 0; k < LATTICE; k++) {
    const [x, y, z] = [i, j, k].map((t, a) => lo[a] + ((t + 0.5) / LATTICE) * (hi[a] - lo[a]));
    const g = [f(x + h, y, z) - f(x - h, y, z), f(x, y + h, z) - f(x, y - h, z), f(x, y, z + h) - f(x, y, z - h)];
    const n = Math.hypot(...g) / (2 * h);
    if (Number.isFinite(n)) norms.push(n);
  }
  norms.sort((a, b) => b - a);
  return norms[Math.min(RANK, norms.length) - 1] ?? 0;
}

const plainCsg = (spec) => !(spec.detail?.length) && [...specNodes(spec.root)].every((n) =>
  CAD_KINDS.has(n.kind) && !n.round && !(n.k > 0));

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
  {
    id: "implicit-thin-feature",
    run: (ctx) => compiledCalls(ctx).flatMap(({ spec, compiled }) => {
      const tiers = [
        ["preview", spec.preview ?? choosePreviewEdge(compiled)],
        ["print", spec.resolution ?? IMPLICIT_DEFAULTS.resolution],
      ].filter(([, edge]) => compiled.thin < 2 * edge);
      if (tiers.length === 0) return [];
      const grids = tiers.map(([tier, edge]) => `the ${tier} grid (${mm(edge)})`).join(" and ");
      return [warn("implicit-thin-feature",
        `k.implicit: the thinnest feature (${mm(compiled.thin)}) is under 2 cells of ${grids} at the default pose — it may break up or grow handles`,
        "Give the thin feature its own k.implicit with a finer `preview` and `resolution`, unioned on (the guide's nail pattern), or thicken it. See ERROR-PATTERNS.md#implicit-thin-feature.",
        "parts")];
    }),
  },
  {
    id: "implicit-blend-eats-child",
    run: (ctx) => compiledCalls(ctx).flatMap(({ spec, compiled }) => {
      const { nodes } = compiled.ir, out = [];
      for (const n of nodes) {
        if (!["union", "intersect", "subtract"].includes(n.kind) || !(n.k > 0) || !n.path) continue;
        for (const c of n.children) if (nodes[c].thin < n.k) {
          out.push(warn("implicit-blend-eats-child",
            `k.implicit: ${n.path} blends with k = ${mm(n.k)}, wider than ${nodes[c].path} (${mm(nodes[c].thin)} thick) — the blend swallows it into a blob`,
            "Make the blend narrower than the thinnest child it joins, or blend that child separately with its own smaller k. See ERROR-PATTERNS.md#implicit-blend-eats-child.",
            "parts"));
        }
      }
      if (compiled.ownerRoot >= 0) {
        const thinOf = new Map(nodes[compiled.ownerRoot].children.map((c) => [nodes[c].label, nodes[c].thin]));
        for (const [i, e] of (spec.root.attach ?? []).entries()) {
          const piece = [e.a, e.b].find((l) => thinOf.get(l) < e.k);
          if (piece != null) out.push(warn("implicit-blend-eats-child",
            `k.implicit: root.attach[${i}] blends ${e.a} into ${e.b} with k = ${mm(e.k)}, wider than "${piece}" (${mm(thinOf.get(piece))} thick)`,
            "Use an attach k narrower than both pieces it joins. See ERROR-PATTERNS.md#implicit-blend-eats-child.",
            "parts"));
        }
      }
      return out;
    }),
  },
  {
    id: "implicit-csg-in-disguise",
    run: (ctx) => compiledCalls(ctx).filter(({ spec }) => plainCsg(spec)).map(() => note("implicit-csg-in-disguise",
      "k.implicit builds only boxes, cylinders and halfspaces with sharp booleans — plain CAD, meshed approximately",
      "Build it with the standard ops (k.box, k.cylinder, union/cut): they are exact, faster, and export a true STEP. Keep k.implicit for blended, organic forms.",
      "parts")),
  },
  {
    id: "implicit-lipschitz-low",
    run: (ctx) => {
      const out = [];
      let budget = MAX_EXPRS;
      for (const { spec } of compiledCalls(ctx)) {
        for (const [n, path] of specPaths(spec.root)) {
          // A formula that reads a texture would be sampled against lint's stub pixels.
          if (n.kind !== "expr" || n.textures || budget === 0) continue;
          budget--;
          const slope = sampledSlope(compileExprSource(n.sdf, { uniforms: n.uniforms ?? {} }), n.box);
          const declared = n.lipschitz ?? 1;
          if (slope <= SLACK * declared) continue;
          out.push(warn("implicit-lipschitz-low",
            `k.implicit: ${path} changes by up to ${slope.toFixed(1)} per mm on a sample of its box, but declares lipschitz ${declared} — the mesher can step past its surface and open holes`,
            `Set \`lipschitz: ${Math.ceil(slope * 10) / 10}\` (or more) on the node, or rescale the formula toward a true distance. This is a spot check on ${LATTICE ** 3} points, not a bound. See ERROR-PATTERNS.md#implicit-lipschitz-low.`,
            "parts"));
        }
      }
      return out;
    },
  },
];
