// Pure half of the profile-validity warning: turning validateProfile's
// self-intersection issues into deduplicated build-warning messages, with no
// kernel involved. The kernel-level tests (profile-warnings.test.js and its OCCT
// twin) cover the hooks; this file pins the message contract and the bounds.
import { describe, expect, it, vi } from "vitest";
import {
  PROFILE_VALIDATE_MAX_SEGMENTS, PROFILE_WARN_MAX_PER_PROFILE,
  makeProfileWarner, profileWarningMessages,
} from "../src/framework/geometry/profile-warnings.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";
import { createValidatingProbe, runValidatingProbe } from "../src/framework/geometry/probe.js";

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

  it("is silent on a hole that touches its outer (a cross-contour contact, not a crossing)", () => {
    // Drawn as a notch: the hole's mouth lies ON the outer's bottom edge. The solid
    // builds exactly as authored (profile-warnings.test.js pins the volume), so the
    // contacts validateProfile files under self-intersection are not this warning's
    // subject — they carry `crosses` and are filtered out.
    const notched = { outer: [[0, 0], [20, 0], [20, 10], [0, 10]], holes: [[[5, 0], [5, 5], [10, 5], [10, 0]]] };
    expect(profileWarningMessages("extrude: profile", notched)).toEqual([]);
  });

  it("caps at three messages, the last one counting the rest", () => {
    // A {24/7} star polygon: 24 points stepped 7 around the circle, which crosses
    // itself 144 times. Unbounded that is one profile's worth of ~50 KB, enough to
    // evict every other warning from a host's list.
    const N = 24, STEP = 7;
    const star = Array.from({ length: N }, (_, i) => {
      const a = (2 * Math.PI * ((i * STEP) % N)) / N;
      return [10 * Math.cos(a), 10 * Math.sin(a)];
    });
    const msgs = profileWarningMessages("extrude: profile", star);
    expect(PROFILE_WARN_MAX_PER_PROFILE).toBe(3);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).not.toMatch(/more crossings/);
    expect(msgs[1]).not.toMatch(/more crossings/);
    expect(msgs[2]).toMatch(/^extrude: profile self-intersects near /);
    expect(msgs[2]).toMatch(/ \(and 141 more crossings on this profile\)$/);
  });

  it("says nothing extra when there are exactly three crossings", () => {
    // Three disjoint bowtie regions: one crossing each, none cross-contour.
    const bow = (dx) => ({ outer: [[dx, 0], [dx + 10, 10], [dx + 10, 0], [dx, 10]], holes: [] });
    const msgs = profileWarningMessages("extrude: profile", [bow(0), bow(30), bow(60)]);
    expect(msgs).toHaveLength(3);
    expect(msgs.some((m) => /more crossings/.test(m))).toBe(false);
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

// The lint probe runs a part against a fake kernel of proxies, never a backend, so
// no profile is ever validated there — a lint pass must not pay validation cost or
// mint build warnings. Two independent facts hold that: the probe's `ignore(key)`
// resolves every `_`-prefixed key to undefined, so `k._warnProfile` does not exist;
// and `onCall` runs each spec's `toArgs` but never its `warn` hook.
describe("the lint probe never validates a profile", () => {
  it("exposes no _warnProfile", () => {
    // `ignore(key)` resolves every `_`-prefixed key to undefined rather than to a
    // chainable op, so the warner the kernel front reads (`warn?.(k._warnProfile,
    // …)`) is absent here, and `warn` is a no-op even if it were ever reached.
    expect(createValidatingProbe().kernel._warnProfile).toBeUndefined();
  });

  it("records no profile warning for a part whose every profile crosses itself", () => {
    const part = { parts: { bad: { build: (k) => {
      k.extrude({ profile: BOW, h: 5 });
      k.prism({ points: BOW, h: 5 });
      k.loft({ rings: [{ polygon: SQUARE, z: 0 }, { polygon: BOW, z: 10 }] });
      return k.shape2d(BOW);
    } } } };
    const r = runValidatingProbe(part, {}, {});
    expect(r.throws).toEqual([]);
    expect(r.issues).toEqual([]);                      // no unknown-op / invalid-options either
    expect(r.calls.every((c) => !/self-intersects/.test(JSON.stringify(c)))).toBe(true);
  });
});
