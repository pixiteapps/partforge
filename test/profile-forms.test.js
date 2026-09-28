// Which profile FORMS each factory op actually accepts — the ops' half of the
// typedefs in kernel.js, pinned so the two cannot drift again. `prism`, `extrude`
// and `revolve` take a `{start, segments}` contour; `sweep` does not. `revolve` used to
// refuse one ("lift it with k.shape2d first"); since the *Profile curve helpers it lifts
// the contour itself (finishKernel), so a curve helper works everywhere a point list
// does. `sweep` still takes points only — its stations are placed point by point.
//
// Manifold only (AGENTS.md: the two backends must not boot in one file). The
// forms are normalized in the shared front (op-options.js), so OCCT agrees by
// construction.
import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

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

  it("is refused by sweep", () => {
    expect(() => k.sweep({ profile: tab(), path: [[0, 0, 0], [0, 0, 20]] }))
      .toThrow(/profile2D must be an array of ≥3 \[x, ?y\] points/);
  });
});

describe("revolve's point-list path is unchanged", () => {
  it("builds a lathe point list and still rejects a negative radius", () => {
    expect(k.revolve({ profile: [[0, 0], [10, 0], [10, 20], [0, 20]] }).volume()).toBeGreaterThan(0);
    expect(() => k.revolve({ profile: [[-1, 0], [10, 0], [10, 20]] })).toThrow(/radius must be ≥ 0/);
  });
});
