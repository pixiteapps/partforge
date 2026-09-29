// Which profile FORMS each factory op actually accepts — the ops' half of the
// typedefs in kernel.js, pinned so the two cannot drift again. `prism`, `extrude`,
// `revolve` and `sweep` all take a `{start, segments}` contour. `revolve` used to refuse
// one ("lift it with k.shape2d first") and `sweep` to die on it; since the *Profile curve
// helpers the kernel front lifts it — to a Shape2D for revolve, and to a point ring
// sampled at 48 per circle for sweep, which places its profile point by point.
//
// Manifold only (AGENTS.md: the two backends must not boot in one file). The
// forms are normalized in the shared front (op-options.js), so OCCT agrees by
// construction.
import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";
import { contourToPoints } from "../src/framework/geometry/profile.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// A rounded tab: straight sides with one arc at the +X end. A real contour, not a
// polyline in disguise, so a form that "accepts" it by tessellating is visible.
const tab = () => pathProfile([0, -5]).lineTo([20, -5]).arcTo([20, 5], [25, 0]).lineTo([0, 5]).close();
// The same shape as a lathe profile: r ≥ 0 throughout, so only the FORM is at issue.
const lathe = () => pathProfile([0, 0]).lineTo([10, 0]).arcTo([10, 20], [14, 10]).lineTo([0, 20]).close();

describe("a {start, segments} contour", () => {
  it("builds through prism", () => {
    expect(k.prism({ points: tab(), h: 5 }).volume()).toBeGreaterThan(0);
  });

  it("builds through extrude", () => {
    expect(k.extrude({ profile: tab(), h: 5 }).volume()).toBeGreaterThan(0);
  });

  it("builds through revolve, exactly as its Shape2D lift does", () => {
    expect(k.revolve({ profile: lathe() }).volume())
      .toBeCloseTo(k.revolve({ profile: k.shape2d(lathe()) }).volume(), 9);
  });

  it("revolve still names what it wants for a form it cannot take", () => {
    expect(() => k.revolve({ profile: { points: [[0, 0], [1, 0], [1, 1]] } }))
      .toThrow(/revolve: profile must be an \[\[r, z\], …\] point list, a \{start, segments\} contour, or a Shape2D/);
  });

  it("builds through sweep, sampled to a point ring first", () => {
    const path = [[0, 0, 0], [0, 0, 20]];
    const curve = k.sweep({ profile: tab(), path });
    const points = k.sweep({ profile: contourToPoints(tab()), path });
    expect(curve.volume()).toBeCloseTo(points.volume(), 9);
    expect(k.sweep(tab(), path).volume()).toBeCloseTo(points.volume(), 9);   // positional too
  });
});

describe("revolve's point-list path is unchanged", () => {
  it("builds a lathe point list and still rejects a negative radius", () => {
    expect(k.revolve({ profile: [[0, 0], [10, 0], [10, 20], [0, 20]] }).volume()).toBeGreaterThan(0);
    expect(() => k.revolve({ profile: [[-1, 0], [10, 0], [10, 20]] })).toThrow(/radius must be ≥ 0/);
  });
});
