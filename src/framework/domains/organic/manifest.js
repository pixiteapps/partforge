// The organic domain: k.implicit signed-distance bodies, registered in place. The engine
// stays in geometry/implicit/ because both backends and the native core call it, and core
// may not import a domain folder (test/domain-layering.test.js). So this manifest TAGS the
// two ops, which both in-repo backends implement natively; its attaches are the fallbacks a
// kernel without them gets (kernel-front.js runs an attach only where the op is missing).
import { implicitFrames } from "../../geometry/implicit/frame-report.js";

export default {
  id: "organic",
  title: "Organic",
  when: "smooth organic bodies: hands, paws, creatures, blobby or sculpted forms; blended signed-distance shapes with surface detail",
  subpath: "partforge/organic",
  guide: "docs/domains/organic.md",
  referenceParts: [],
  kernelOps: [
    {
      name: "implicit",
      attach: (k) => {
        k.implicit = () => { throw new Error("implicit: this kernel has no implicit engine — build the part on the Manifold backend"); };
      },
    },
    // The frame report is pure (it validates and lowers, never meshes), so any kernel can run it.
    { name: "implicitFrames", attach: (k) => { k.implicitFrames = (spec) => implicitFrames(spec); } },
  ],
  lintRules: [],
  oracle: { facts: null, metrics: {}, checks: [] },
  processes: [],
  workerSafe: true,
};
