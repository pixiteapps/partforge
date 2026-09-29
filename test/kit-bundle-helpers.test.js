// The kit's pure helpers (spec D.4, D.9, D.10): entry names, deterministic
// disambiguation, dedupe whose hash only nominates, and the 2-D check wording the
// README prints — held equal to verify's own wording, which the kit may not import.
import { describe, expect, test } from "vitest";
import {
  KIT_ENTRY_RE, kitName, uniqueName, dedupe, checkMessage, sheetWarnings,
} from "../src/framework/export/bundle.js";
import { parseAssertion, evaluateAssertion } from "../src/framework/oracle/assert-dsl.js";
import { SHEET_METRICS } from "../src/framework/process/registry.js";

describe("kitName", () => {
  test.each([
    ["Front", "front"],
    ["Side (L)", "side-l"],
    ["../../.ssh/authorized", "ssh-authorized"],
    ["a..b", "a.b"],
    ["", "part"],
    ["日本語", "part"],
    ["birch plywood-2.7mm", "birch-plywood-2.7mm"],
    // every entry segment must start with [a-z0-9] (KIT_ENTRY_RE): safeName keeps a
    // leading underscore, so kitName strips it — a name is never refused for it
    ["_left", "left"],
    ["__init__", "init__"],
    ["_", "part"],
    ["_-.x", "x"],
  ])("%j → %j", (input, want) => expect(kitName(input)).toBe(want));
});

describe("uniqueName", () => {
  test("hands out base, base-2, base-3 in call order", () => {
    const taken = new Set();
    expect(["side", "side", "side", "top"].map((b) => uniqueName(b, taken))).toEqual(["side", "side-2", "side-3", "top"]);
  });

  test("a name is free only when every file it produces is free", () => {
    const taken = new Set(["parts/front-x2.svg"]); // front ×2 — or a piece literally named front-x2
    const filesOf = (n) => [`parts/${n}-x2.svg`, `parts/${n}-x2-marks.dxf`];
    expect(uniqueName("front", taken, filesOf)).toBe("front-2");
    expect(taken.has("parts/front-2-x2.svg")).toBe(true);
    expect(taken.has("parts/front-2-x2-marks.dxf")).toBe(true);
  });
});

describe("KIT_ENTRY_RE", () => {
  test.each([
    "README.txt", "parts.csv",
    "sheets/birch-plywood-3mm/sheet-1-of-2.svg", "sheets/acrylic-2.7mm/sheet-12-of-12.dxf",
    "parts/front.svg", "parts/left-x2.dxf", "parts/front-x2-marks.dxf", "parts/front-2-x2.svg",
    "print/hinge-x2.stl", "print/knob.3mf",
  ])("accepts %s", (name) => expect(name).toMatch(KIT_ENTRY_RE));

  test.each([
    "../README.txt", "readme.txt", "sheets/a/sheet-1.svg", "sheets/../sheet-1-of-1.svg",
    "parts/Front.svg", "parts/-front.svg", "parts/.front.svg", "parts/front.png", "parts/sub/front.svg",
    "print/hinge.step", "print/hinge.svg",
  ])("refuses %s", (name) => expect(name).not.toMatch(KIT_ENTRY_RE));
});

describe("dedupe", () => {
  const items = [{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "a" }];

  test("the hash only nominates: a colliding hash with unequal items keeps them apart", () => {
    const groups = dedupe(items, () => "one-hash-for-all", (a, b) => a.v === b.v);
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([[1, 3], [2]]);
    expect(groups.map((g) => g.item.id)).toEqual([1, 2]);
  });

  test("items under different hashes never merge, whatever `same` says", () => {
    expect(dedupe(items, (x) => String(x.id), () => true).map((g) => g.members.length)).toEqual([1, 1, 1]);
  });
});

describe("checkMessage", () => {
  test.each([
    [">=1.5", 1.2], [">=1.5", 1.5], [">=1.5", 1.4999995], [">=0.5", 0.45],
    ["<=2", 2.5], ["<=2", 2],
    ["0", 0], ["0", 3], ["1", 1], ["1", 2],
  ])("checkMessage(%j, %j) words it exactly as verify does", (expr, actual) => {
    expect(checkMessage(expr, actual)).toEqual(evaluateAssertion(parseAssertion(expr), actual));
  });

  test("an expression form the kit cannot word throws, loudly", () => {
    expect(() => checkMessage("1..2", 1)).toThrow('cut kit: unsupported sheet check "1..2"');
  });
});

describe("sheetWarnings", () => {
  // A 3 mm laser piece whose every check passes; tests override one field at a time.
  const facts = (over = {}) => ({
    process: "laser", material: "birch plywood", thickness: 3, group: "birch plywood|3.00",
    flat: [100, 50], area: 5000, pieces: 1, customBuild: false, marksArea: null,
    bridge: 3, bridgeCapped: true, gap: 3, gapCapped: true, marksOutside: 0, solidMatchPct: null,
    at2d: { bridge: null, gap: null, marks: null }, at: { bridge: null, gap: null, marks: null },
    evaluated: true, ...over,
  });

  test("nothing to say about a piece that passes", () => {
    expect(sheetWarnings("Panel", facts())).toEqual([]);
  });

  test("a failing check reads `label: message — hint`, word for word", () => {
    expect(sheetWarnings("Panel", facts({ bridge: 0.3, bridgeCapped: false }))).toEqual([
      `Panel: 0.3 not >= 1.5 — ${SHEET_METRICS.sheetBridge.hint}`,
    ]);
    expect(sheetWarnings("Panel", facts({ pieces: 2 }))).toEqual([
      `Panel: 2 != 1 — ${SHEET_METRICS.sheetPieces.hint}`,
    ]);
  });

  // P1's final-review fix added SheetFacts.readErrors and a readError() accessor on
  // each budget-gated SHEET_METRICS entry: a metric the geometry engine refused to
  // read (an offset it could not chain, distinct from running out of time) even
  // though the sheet as a whole WAS evaluated. oracle/verify.js reports that as
  // `not measured — <reason>`; the kit's README line must say the same thing.
  test("a check the geometry engine refused says so, worded like verify's own line", () => {
    expect(sheetWarnings("Panel", facts({
      bridge: null,
      readErrors: { bridge: "offset: self-intersecting contour near (12.5, 40)", gap: null, marks: null, marksArea: null },
    }))).toEqual([
      "Panel: not measured — offset: self-intersecting contour near (12.5, 40) — The geometry engine could not run this 2-D laser check on the profile (the reason is in the message). The part still builds; an overlapping or self-touching contour, or a sliver, is the usual cause — simplify the profile there and re-run.",
    ]);
  });

  test("an unevaluated piece says so once instead of the checks it skipped", () => {
    expect(sheetWarnings("Panel", facts({ evaluated: false, bridge: null, gap: null, marksOutside: null }))).toEqual([
      "Panel: 2-D sheet checks not evaluated (time budget) — the kit ran out of time checking this piece for narrow webs, narrow gaps and stray marks; look it over before cutting",
    ]);
  });

  test("a custom build's volume match needs a solid, so the kit skips it", () => {
    expect(sheetWarnings("Panel", facts({ customBuild: true, marksArea: 0 }))).toEqual([]);
  });
});
