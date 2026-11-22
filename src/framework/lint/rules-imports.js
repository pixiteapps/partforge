// Group 5 — geometry-import well-formedness. Each condition here is a static
// early-catch for something that otherwise throws only later: `k.import()` on
// an undeclared name throws mid-build (kernel.js), a declared mesh import
// under an OCCT-routed part throws lazily from the `{error}` registration
// entry the first time `k.import` reads it (imports.js), an unknown
// `reference` breaks the deviation gate silently (measure.js just reports no
// deviation), and a `ref*` verify metric with no `reference` always reports
// status "skip" (verify-metrics.js) rather than the gate the author intended.
//
// `import-mesh-on-occt` is deliberately conservative: only extension-detectable
// sources (a `URL` or a string path) are checked. Bytes and thunks carry no
// format information without actually resolving them, which lint — geometry-
// free and synchronous — cannot do; those cases (and any per-sub-part routing
// split a whole-part `detectBackend` can't see) still fail correctly at build
// time via imports.js's lazy `{error}` entry. This rule exists to catch the
// common case early, not to replace that runtime authority.
import { err, warn } from "./finding.js";
import { detectBackend } from "../backend-select.js";
import { SUBPART_METRICS } from "../verify-metrics.js";

const MESH_EXT = /\.(stl|3mf)$/i;

const REF_METRICS = new Set(Object.keys(SUBPART_METRICS).filter((k) => k.startsWith("ref")));

const declaredImports = (part) => Object.keys(part?.imports ?? {});

// Only URL/string sources carry a statically-visible extension; a thunk or raw
// bytes source is skipped (see file header).
const meshDeclared = (part) => Object.entries(part?.imports ?? {}).filter(([, src]) => {
  const path = src instanceof URL ? src.pathname : typeof src === "string" ? src.split("?")[0] : null;
  return path != null && MESH_EXT.test(path);
});

export const IMPORT_RULES = [
  {
    id: "import-unknown-name",
    run: ({ part, probe }) => {
      const known = new Set(declaredImports(part));
      const seen = new Set();
      const out = [];
      for (const call of probe().calls) {
        if (call.scope !== "kernel" || call.op !== "import") continue;
        let name;
        try { name = JSON.parse(call.args[0]); } catch { name = null; }
        if (typeof name !== "string" || known.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(err("import-unknown-name",
          `build calls k.import with name "${name}", which the part's imports field does not declare: ${[...known].join(", ") || "(nothing)"}`,
          "Declare the file under imports: { name: source }, or fix the name to match an existing entry.",
          "imports"));
      }
      return out;
    },
  },
  {
    id: "import-mesh-on-occt",
    run: ({ part, p }) => {
      const mesh = meshDeclared(part);
      if (mesh.length === 0 || detectBackend(part, p) !== "occt") return [];
      const cause = part?.meta?.backend === "occt"
        ? "meta.backend forces OCCT"
        : "a shell op routes this part to OCCT"; // post-contract-v3, fillet/chamfer no longer probe-route
      return mesh.map(([name]) => err("import-mesh-on-occt",
        `import "${name}" is a mesh (STL/3MF) but ${cause} — mesh imports need the Manifold backend`,
        // detectBackend (this rule's own gate) is the whole-part max over every
        // sub-part, same as lint/measure/single-worker export — so putting the
        // import on a nominally Manifold sub-part does not clear this error
        // while any OTHER sub-part routes to OCCT; that coexistence only works
        // for the browser preview's per-sub-part routing. Say so explicitly —
        // see ERROR-PATTERNS.md#import-mesh-on-occt for the long version.
        "Split the mesh-importing sub-part into its own separate part (per-sub-part Manifold/OCCT coexistence is preview-only), replace it with a STEP source, or drop the CAD-only op / meta.backend pin so the whole part routes to Manifold.",
        "imports"));
    },
  },
  {
    id: "reference-unknown",
    run: ({ part }) => {
      const imports = new Set(declaredImports(part));
      const subs = new Set(Object.keys(part?.parts ?? {}));
      return Object.entries(part?.parts ?? {})
        .filter(([, sp]) => sp?.reference && !imports.has(sp.reference) && !subs.has(sp.reference))
        .map(([name, sp]) => err("reference-unknown",
          `sub-part "${name}" declares reference: "${sp.reference}" but no import and no sub-part has that name`,
          "reference must name a key of the part's imports field or another sub-part of this part.",
          `parts.${name}.reference`));
    },
  },
  {
    id: "reference-ambiguous",
    run: ({ part }) => {
      const imports = new Set(declaredImports(part));
      const subs = new Set(Object.keys(part?.parts ?? {}));
      return Object.entries(part?.parts ?? {})
        .filter(([, sp]) => sp?.reference && imports.has(sp.reference) && subs.has(sp.reference))
        .map(([name, sp]) => err("reference-ambiguous",
          `sub-part "${name}" declares reference: "${sp.reference}", which is both an import and a sub-part`,
          "Rename the import or the sub-part so the reference names exactly one thing.",
          `parts.${name}.reference`));
    },
  },
  {
    id: "reference-self",
    run: ({ part }) => {
      const imports = new Set(declaredImports(part));
      const parts = part?.parts ?? {};
      const next = (n) => {
        const r = parts[n]?.reference;
        return typeof r === "string" && !imports.has(r) && Object.hasOwn(parts, r) ? r : null;
      };
      const out = [];
      for (const name of Object.keys(parts)) {
        // Follow the chain from `name`; it is in a cycle iff it comes back to itself.
        const seen = new Set();
        let cur = next(name);
        while (cur && cur !== name && !seen.has(cur)) { seen.add(cur); cur = next(cur); }
        if (cur !== name) continue;
        out.push(err("reference-self",
          `sub-part "${name}" is its own reference, directly or through a chain of references`,
          "A reference must point at a different sub-part (or an import) and the chain must end; break the cycle.",
          `parts.${name}.reference`));
      }
      return out;
    },
  },
  {
    id: "reference-exportable",
    run: ({ part }) => {
      const imports = new Set(declaredImports(part));
      const parts = part?.parts ?? {};
      const seen = new Set();
      const out = [];
      for (const sp of Object.values(parts)) {
        const r = sp?.reference;
        if (typeof r !== "string" || imports.has(r) || !Object.hasOwn(parts, r) || seen.has(r)) continue;
        seen.add(r);
        if (parts[r]?.exportable === false) continue;
        out.push(warn("reference-exportable",
          `sub-part "${r}" is used as a reference but is exportable, so it prints and ships with the part`,
          `Set exportable: false on sub-part "${r}".`,
          `parts.${r}.exportable`));
      }
      return out;
    },
  },
  {
    id: "ref-metric-without-reference",
    // Deliberately resolves function-form `verify.expect` via `resolveExpectOnce()`
    // (same memoized, try/caught call the Group 4 verify rules share) rather than
    // skipping it — the plan's anchor guarded with a bare `typeof expect ===
    // "object"` check on the assumption a function-form `expect` "can't be
    // inspected statically", but `resolveExpectOnce()` already does exactly that
    // inspection safely (a throw is reported separately by `verify-expect-throws`
    // and short-circuits here via `!expect`). A ref* metric surfaced from a
    // function-form expect with no `reference` is just as real a finding as one
    // from the static-object form, so skipping it would be a false negative, not
    // caution.
    run: ({ part, resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      if (!expect || typeof expect !== "object") return [];
      const names = new Set(Object.keys(part?.parts ?? {}));
      return Object.entries(expect)
        // `sub` must name a real sub-part — a typo'd name is already reported by
        // `verify-unknown-subpart`; skip it here so the two rules don't double-report
        // the same typo under two different ids.
        .filter(([sub, metrics]) => sub !== "_view" && names.has(sub) && metrics && typeof metrics === "object" &&
          Object.keys(metrics).some((k) => REF_METRICS.has(k)) && !part?.parts?.[sub]?.reference)
        .map(([sub]) => warn("ref-metric-without-reference",
          `verify.expect.${sub} uses a ref* metric but sub-part "${sub}" declares no reference`,
          `Add reference: "<sub-part name>" (or an import name) to sub-part "${sub}", or the ref* checks always report status "skip".`,
          `verify.expect.${sub}`));
    },
  },
];
