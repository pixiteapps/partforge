// The organic domain: k.implicit signed-distance bodies and k.subdiv subdivision bodies,
// registered in place. The engines stay in geometry/implicit/ and geometry/subdiv/ because
// both backends (and, for implicit, the native core) call them, and core may not import a
// domain folder (test/domain-layering.test.js). So this manifest TAGS the ops, which both
// in-repo backends implement natively; its attaches are the fallbacks a
// kernel without them gets (kernel-front.js runs an attach only where the op is missing).
import { implicitFrames } from "../../geometry/implicit/frame-report.js";
import { createCage } from "../../geometry/subdiv/cage.js";
import { ORGANIC_LINT_RULES } from "./lint.js";

export default {
  id: "organic",
  title: "Organic",
  when: "smooth organic bodies: hands, paws, creatures, blobby or sculpted forms; blended signed-distance shapes with surface detail",
  subpath: "partforge/organic",
  guide: "docs/domains/organic.md",
  referenceParts: ["src/parts/organic-hand.js", "src/parts/organic-whale.js"],
  kernelOps: [
    {
      name: "implicit",
      attach: (k) => {
        k.implicit = () => { throw new Error("implicit: this kernel has no implicit engine — build the part on the Manifold backend"); };
      },
    },
    // The frame report is pure (it validates and lowers, never meshes), so any kernel can run it.
    { name: "implicitFrames", attach: (k) => { k.implicitFrames = (spec) => implicitFrames(spec); } },
    {
      name: "subdiv",
      attach: (k) => {
        k.subdiv = () => { throw new Error("subdiv: this kernel has no subdivision engine — build the part on the Manifold backend"); };
      },
    },
    // A cage is plain data (subdiv/cage.js), so any kernel can hand one out.
    { name: "cage", attach: (k) => { k.cage = createCage; } },
  ],
  lintRules: ORGANIC_LINT_RULES,
  oracle: { facts: null, metrics: {}, checks: [] },
  processes: [],
  workerSafe: true,
};
