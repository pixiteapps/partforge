// Pure half of the profile-validity warning: turning validateProfile's
// self-intersection issues into deduplicated build-warning messages, with no
// kernel involved. The kernel-level tests (profile-warnings.test.js and its OCCT
// twin) cover the hooks; this file pins the message contract and the bounds.
import { describe, expect, it, vi } from "vitest";
import {
  PROFILE_VALIDATE_MAX_SEGMENTS, makeProfileWarner, profileWarningMessages,
} from "../src/framework/geometry/profile-warnings.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

const BOW = [[0, 0], [10, 10], [10, 0], [0, 10]];         // crosses itself at (5, 5)
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];

describe("profileWarningMessages", () => {
  it("names the op, the crossing point, and the arcTo remedy", () => {
    const msgs = profileWarningMessages("extrude: profile", BOW);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/^extrude: profile self-intersects near \(5\.0000, 5\.0000\) — /);
    expect(msgs[0]).toMatch(/pathProfile\(\)\.arcTo\(to, via\)/);
    expect(msgs[0]).toMatch(/validateProfile\(\)/);
  });

  it("is silent on a clean point list, a clean contour, and a clean region", () => {
    expect(profileWarningMessages("extrude: profile", SQUARE)).toEqual([]);
    const tab = pathProfile([0, -5]).lineTo([20, -5]).arcTo([20, 5], [25, 0]).lineTo([0, 5]).close();
    expect(profileWarningMessages("extrude: profile", tab)).toEqual([]);
    expect(profileWarningMessages("extrude: profile", { outer: SQUARE, holes: [[[2, 2], [2, 4], [4, 4], [4, 2]]] })).toEqual([]);
  });

  it("reports a flipped arc in a contour", () => {
    // The tip arc's via point sits on the WRONG side (inside the tab), so the arc
    // sweeps back through the body and crosses the straight sides.
    const flipped = pathProfile([0, -5]).lineTo([20, -5]).arcTo([20, 5], [10, 0]).lineTo([0, 5]).close();
    const msgs = profileWarningMessages("extrude: profile", flipped);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]).toMatch(/^extrude: profile self-intersects near /);
  });

  it("never re-validates a Shape2D and never throws on bad input", () => {
    expect(profileWarningMessages("extrude: profile", { _shape2d: true, _regions: [] })).toEqual([]);
    expect(profileWarningMessages("extrude: profile", null)).toEqual([]);
    expect(profileWarningMessages("extrude: profile", "nonsense")).toEqual([]);
    expect(profileWarningMessages("extrude: profile", [[0, 0], [1, 1]])).toEqual([]);   // 2 points: the op's own error path
  });

  it("skips a profile above the segment ceiling", () => {
    const n = PROFILE_VALIDATE_MAX_SEGMENTS + 1;
    // A dense bowtie: the crossing is real, but the ceiling wins.
    const dense = [];
    for (let i = 0; i < n / 2; i++) dense.push([i / n, (i / n) * 10]);
    for (let i = n / 2; i < n; i++) dense.push([10 - i / n, 10 - ((i - n / 2) / n) * 10]);
    expect(dense.length).toBeGreaterThan(PROFILE_VALIDATE_MAX_SEGMENTS);
    expect(profileWarningMessages("extrude: profile", dense)).toEqual([]);
  });
});

describe("makeProfileWarner", () => {
  it("records each distinct message once until reset", () => {
    const record = vi.fn();
    const w = makeProfileWarner(record);
    w.warn("extrude: profile", BOW);
    w.warn("extrude: profile", BOW);
    w.warn("extrude: profile", BOW);
    expect(record).toHaveBeenCalledTimes(1);
    w.warn("prism: profile", BOW);           // different prefix = different fact
    expect(record).toHaveBeenCalledTimes(2);
    w.reset();
    w.warn("extrude: profile", BOW);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("tolerates a missing recorder (the lint probe's fake kernel)", () => {
    const w = makeProfileWarner(undefined);
    expect(() => w.warn("extrude: profile", BOW)).not.toThrow();
  });
});
