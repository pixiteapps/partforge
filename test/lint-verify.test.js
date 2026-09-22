// Group 4 — the verify block. Each of these currently throws mid-run, after measure
// has already printed and the kernel has booted; lint reaches them before any of that.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const partWith = (verify) => ({
  meta: { title: "T" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
  verify,
});

// Two sub-parts, for the pair-wise `_view.contacts` / `_view.clearance` checks —
// `partWith` above only has one sub-part, which can never form a valid pair.
const partWithTwoSubparts = (verify) => ({
  meta: { title: "T" },
  defaults: { h: 10 },
  parts: {
    lid: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) },
    body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) },
  },
  views: { main: { label: "Main" } },
  verify,
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a well-formed verify block produces no findings", () => {
  const r = lintPart(partWith({ process: "fdm-pla", expect: { body: { holes: 0, bbox: "<=[60,60,60]" }, _view: { overlaps: 0 } } }));
  expect(ids(r.errors)).toEqual([]);
});

test("a part with no verify block produces no findings", () => {
  const part = partWith(undefined);
  delete part.verify;
  expect(ids(lintPart(part).errors)).toEqual([]);
});

test("an unknown subpart metric is an error", () => {
  const r = lintPart(partWith({ expect: { body: { wallThickness: 2 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
  expect(find(r, "verify-unknown-metric").path).toBe("verify.expect.body.wallThickness");
});

test("a subpart metric used under _view is an error", () => {
  // `holes` is subpart-scoped only; _view has its own smaller vocabulary.
  const r = lintPart(partWith({ expect: { _view: { holes: 1 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
});

test("an unknown subpart name is an error", () => {
  const r = lintPart(partWith({ expect: { boddy: { holes: 0 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-subpart");
  expect(find(r, "verify-unknown-subpart").hint).toMatch(/body/);
});

test("an unparseable assertion is an error", () => {
  const r = lintPart(partWith({ expect: { body: { volume: ">>> 5" } } }));
  expect(ids(r.errors)).toContain("verify-bad-expr");
});

test("an unknown process profile is an error", () => {
  const r = lintPart(partWith({ process: "fdm-unobtanium", expect: {} }));
  expect(ids(r.errors)).toContain("verify-unknown-process");
  expect(find(r, "verify-unknown-process").hint).toMatch(/fdm-pla/);
});

test("an inline process object is accepted", () => {
  const r = lintPart(partWith({ process: { bed: [200, 200, 200], minWall: 1.2 }, expect: {} }));
  expect(ids(r.errors)).not.toContain("verify-unknown-process");
});

test("an inline process object with an unknown base is an error", () => {
  const r = lintPart(partWith({ process: { base: "fdm-unobtanium" }, expect: {} }));
  expect(ids(r.errors)).toContain("verify-unknown-process");
});

test("a nested unknown base (base of a base) is an error", () => {
  const r = lintPart(partWith({ process: { base: { base: "nope" } }, expect: {} }));
  expect(ids(r.errors)).toContain("verify-unknown-process");
});

test("an inline process object with a valid base is accepted", () => {
  const r = lintPart(partWith({ process: { base: "fdm-pla", minWall: 2 }, expect: {} }));
  expect(ids(r.errors)).not.toContain("verify-unknown-process");
});

test("an inline process object with no base is accepted", () => {
  const r = lintPart(partWith({ process: { bed: [200, 200, 200], minWall: 1.2 }, expect: {} }));
  expect(ids(r.errors)).not.toContain("verify-unknown-process");
});

// verify.js:163-164 — `profileSpec ? resolveProfile(profileSpec) : null` — is a
// truthiness check, so any falsy `process` (not just undefined/null) is skipped
// at runtime and never throws. `""`/`0`/`false` must not be flagged either.
test.each([["", "empty string"], [0, "zero"], [false, "false"]])(
  "a falsy process (%s: %s) is not an unknown-process error", (process) => {
    const r = lintPart(partWith({ process, expect: {} }));
    expect(ids(r.errors)).not.toContain("verify-unknown-process");
  },
);

test("the function form of expect is resolved and linted", () => {
  const r = lintPart(partWith({ expect: () => ({ body: { wallThickness: 2 } }) }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
});

test("a throwing expect function is an error", () => {
  const r = lintPart(partWith({ expect: () => { throw new Error("nope"); } }));
  expect(ids(r.errors)).toContain("verify-expect-throws");
  expect(find(r, "verify-expect-throws").message).toContain("nope");
});

test("the { expr, hint } expectation form is accepted", () => {
  const r = lintPart(partWith({ expect: { body: { volume: { expr: ">=100", hint: "keep it chunky" } } } }));
  expect(ids(r.errors)).toEqual([]);
});

// --- _view.contacts / _view.clearance ---------------------------------------

test("a well-formed contacts/clearance block produces no findings", () => {
  const r = lintPart(partWithTwoSubparts({
    expect: { _view: { overlaps: 0, contacts: [["lid", "body"]], clearance: { "lid×body": ">=0.3" } } },
  }));
  expect(ids(r.errors)).toEqual([]);
});

test("contacts/clearance are not flagged as unknown view metrics or bad expressions", () => {
  const r = lintPart(partWithTwoSubparts({
    expect: { _view: { contacts: [["lid", "body"]], clearance: { "lid×body": ">=0.3" } } },
  }));
  expect(ids(r.errors)).not.toContain("verify-unknown-metric");
  expect(ids(r.errors)).not.toContain("verify-bad-expr");
});

test("a non-array contacts is an error", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { contacts: 5 } } }));
  expect(ids(r.errors)).toContain("verify-bad-pair-check");
  expect(find(r, "verify-bad-pair-check").path).toBe("verify.expect._view.contacts");
});

test("a malformed contacts pair entry is an error", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { contacts: [["lid", "body", "extra"]] } } }));
  expect(ids(r.errors)).toContain("verify-bad-pair-check");
  expect(find(r, "verify-bad-pair-check").path).toBe("verify.expect._view.contacts[0]");
});

test("a clearance key not of the form a×b is an error", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { clearance: { "lid-body": ">=0.3" } } } }));
  expect(ids(r.errors)).toContain("verify-bad-pair-check");
  expect(find(r, "verify-bad-pair-check").path).toBe('verify.expect._view.clearance["lid-body"]');
});

test("an unknown sub-part name inside contacts is reported as verify-unknown-subpart", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { contacts: [["lid", "flange"]] } } }));
  expect(ids(r.errors)).toContain("verify-unknown-subpart");
  expect(find(r, "verify-unknown-subpart").path).toBe("verify.expect._view.contacts[0]");
  expect(ids(r.errors)).not.toContain("verify-bad-pair-check");
});

test("an unknown sub-part name inside a clearance key is reported as verify-unknown-subpart", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { clearance: { "lid×flange": ">=0.3" } } } }));
  expect(ids(r.errors)).toContain("verify-unknown-subpart");
  expect(find(r, "verify-unknown-subpart").path).toBe('verify.expect._view.clearance["lid×flange"]');
});

test("lintPart never throws on hostile pair-check input", () => {
  const r = lintPart(partWithTwoSubparts({
    expect: { _view: { contacts: [["lid", 5], null, ["lid"]], clearance: { "lid×body": null, bad: null } } },
  }));
  expect(r.ok).toBe(false);
  expect(ids(r.errors)).toContain("verify-bad-pair-check");
});

// --- verify-bad-pair-check: same-name pairs ----------------------------------

test("a contacts pair naming the same sub-part twice is an error", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { contacts: [["lid", "lid"]] } } }));
  expect(ids(r.errors)).toContain("verify-bad-pair-check");
  expect(find(r, "verify-bad-pair-check").path).toBe("verify.expect._view.contacts[0]");
});

test("a clearance key naming the same sub-part twice is an error", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { clearance: { "lid×lid": ">=0.3" } } } }));
  expect(ids(r.errors)).toContain("verify-bad-pair-check");
  expect(find(r, "verify-bad-pair-check").path).toBe('verify.expect._view.clearance["lid×lid"]');
});

test("a valid two-different-names contacts pair produces no pair-check findings", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { contacts: [["lid", "body"]] } } }));
  expect(ids(r.errors)).not.toContain("verify-bad-pair-check");
});

test("a same-name pair naming an undeclared sub-part produces exactly one finding", () => {
  // requirePair (verify.js:41) checks the same-name case first and short-circuits,
  // so at runtime only one error would ever be thrown — not a bad-pair-check plus
  // two duplicate unknown-subpart findings for the one undeclared name.
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { contacts: [["flange", "flange"]] } } }));
  expect([...r.errors, ...r.warnings]).toHaveLength(1);
  expect(ids(r.errors)).toEqual(["verify-bad-pair-check"]);
});

// --- verify-bad-expr: clearance values are assertions -----------------------

test("an unparseable clearance value is an error", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { clearance: { "lid×body": ">>> bad" } } } }));
  expect(ids(r.errors)).toContain("verify-bad-expr");
  expect(find(r, "verify-bad-expr").path).toBe('verify.expect._view.clearance["lid×body"]');
});

test("a valid clearance scalar assertion value produces no findings", () => {
  const r = lintPart(partWithTwoSubparts({ expect: { _view: { clearance: { "lid×body": ">=0.3" } } } }));
  expect(ids(r.errors)).toEqual([]);
});

test("a valid clearance { expr, hint } value produces no findings", () => {
  const r = lintPart(partWithTwoSubparts({
    expect: { _view: { clearance: { "lid×body": { expr: ">=0.3", hint: "keep a slip fit" } } } },
  }));
  expect(ids(r.errors)).toEqual([]);
});

// --- resolveExpect is memoized (Finding 2) ----------------------------------

test("a first-call-throwing expect() produces exactly one finding, no cascade", () => {
  let calls = 0;
  const r = lintPart(partWith({
    expect: () => { calls += 1; if (calls === 1) throw new Error("boom"); return { body: { wallThickness: 2 } }; },
  }));
  expect(calls).toBe(1);
  expect(ids(r.errors)).toEqual(["verify-expect-throws"]);
});

// `verify.orientation` (the overhang opt-in) throws from verify() on an unknown
// value, the same way an unknown profile name does — and gets the same static
// rule, with a suggestion, so a typo is a lint finding before the kernel boots.
test("an unknown verify.orientation is an error, with a suggestion", () => {
  const r = lintPart(partWith({ orientation: "Print", expect: {} }));
  expect(ids(r.errors)).toContain("verify-unknown-orientation");
  expect(find(r, "verify-unknown-orientation").hint).toMatch(/"print"/);
  expect(find(r, "verify-unknown-orientation").path).toBe("verify.orientation");
});

test("the known orientation, or none, is accepted", () => {
  expect(ids(lintPart(partWith({ process: "fdm-pla", orientation: "print", expect: {} })).errors)).not.toContain("verify-unknown-orientation");
  expect(ids(lintPart(partWith({ process: "fdm-pla", expect: {} })).errors)).not.toContain("verify-unknown-orientation");
});

test("a non-string orientation is an error too", () => {
  expect(ids(lintPart(partWith({ orientation: true, expect: {} })).errors)).toContain("verify-unknown-orientation");
});

// --- verify-bad-expr: wall is range-only ------------------------------------

test("wall is a known sub-part metric", () => {
  const r = lintPart(partWith({ expect: { body: { wall: "1.8..2.2" } } }));
  expect(ids(r.errors)).not.toContain("verify-unknown-metric");
  expect(ids(r.errors)).not.toContain("verify-bad-expr");
});

test("a wall expectation that is not a range is a bad expression", () => {
  const r = lintPart(partWith({ expect: { body: { wall: "<=2" } } }));
  expect(ids(r.errors)).toContain("verify-bad-expr");
  expect(find(r, "verify-bad-expr").message).toMatch(/wall.*must be a range/);
  expect(find(r, "verify-bad-expr").path).toBe("verify.expect.body.wall");
});

test("a wall range with min > max is a bad expression, not a warn-forever band", () => {
  const r = lintPart(partWith({ expect: { body: { wall: "2.2..1.8" } } }));
  expect(ids(r.errors)).toContain("verify-bad-expr");
  expect(find(r, "verify-bad-expr").message).toMatch(/wall.*must be a range with min <= max/);
  expect(find(r, "verify-bad-expr").path).toBe("verify.expect.body.wall");
});
