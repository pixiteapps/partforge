// Which profile FORMS each factory op actually accepts — the ops' half of the
// typedefs in kernel.js, pinned so the two cannot drift again. `prism` and
// `extrude` take a `{start, segments}` contour; `revolve` and `sweep` do not, and
// the typedefs claimed otherwise for both. `revolve` used to die on one as a bare
// `TypeError: pts is not iterable` from inside its own radius check; it now says
// what it wants. Contour support is deliberately NOT added to either op — for
// `revolve` the lift is one `k.shape2d()` away and the error says so.
//
// Manifold only (AGENTS.md: the two backends must not boot in one file). The
// forms are normalized in the shared front (op-options.js), so OCCT agrees by
// construction.
import { beforeAll, describe, expect, it } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

const CONTOUR_RE = /a \{start, segments\} contour is not accepted/;

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

  it("is refused by revolve, by name, with the lift in the message", () => {
    expect(() => k.revolve({ profile: lathe() })).toThrow(CONTOUR_RE);
    expect(() => k.revolve({ profile: lathe() })).toThrow(/revolve: profile must be an \[\[r, z\]/);
  });

  it("revolve takes the same contour once it is lifted to a Shape2D", () => {
    expect(k.revolve({ profile: k.shape2d(lathe()) }).volume()).toBeGreaterThan(0);
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
