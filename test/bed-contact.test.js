// Bed contact (oracle/bed-contact.js): how much of a printed piece's flat underside
// rests on the bed, and the `bedContactPct` gate the FDM profiles arm. The defect it
// exists for: a flat-bottomed piece whose lowest point is something smaller — a
// horizontal knuckle dipping under the plate, lettering embossed on the bottom — so
// the exporter rests it on that and the flat face prints in mid-air. Hand-built meshes
// first, so every number is known; then the measure/verify integration on real builds.
import { beforeAll, describe, expect, it, test } from "vitest";
import { bedContact, HOVER_FLOOR, MAX_BED_EPS } from "../src/framework/oracle/bed-contact.js";
import { bedContactFor, DEFAULT_BED_CONTACT, PROFILES } from "../src/framework/oracle/dfm-profiles.js";
import { bootManifoldKernel } from "../src/testing.js";
import { verify } from "../src/framework/oracle/verify.js";
import { measure } from "../src/framework/oracle/measure.js";

// A closed box as a Manifold-style soup (9 floats per triangle), outward CCW.
function boxSoup([x0, y0, z0], [x1, y1, z1]) {
  const P = [];
  const quad = (a, b, c, d) => { P.push(...a, ...b, ...c, ...a, ...c, ...d); };
  const v = (x, y, z) => [x, y, z];
  quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)); // top (+Z)
  quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0), v(x0, y0, z0)); // bottom (−Z)
  quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)); // −Y
  quad(v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)); // +Y
  quad(v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)); // −X
  quad(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)); // +X
  return P;
}
const soup = (...boxes) => {
  const P = boxes.flat();
  return { positions: Float32Array.from(P), triangles: P.length / 9 };
};

describe("bedContact (the reading)", () => {
  it("a plate flat on the bed: all contact, nothing hovers", () => {
    const r = bedContact(soup(boxSoup([0, 0, 0], [30, 20, 3])));
    expect(r.pct).toBe(100);
    expect(r.contactArea).toBeCloseTo(600, 3);
    expect(r.hoverArea).toBe(0);
    expect(r.gap).toBeNull();
  });

  it("a plate resting on a small foot 0.25 mm lower: the plate's underside hovers, located", () => {
    // 30×20 plate whose bottom is at z = 0.25, over a 2×20 strip reaching z = 0.
    const r = bedContact(soup(boxSoup([0, 0, 0.25], [30, 20, 3]), boxSoup([14, 0, 0], [16, 20, 0.25])));
    expect(r.contactArea).toBeCloseTo(40, 3);
    expect(r.hoverArea).toBeCloseTo(600, 3);       // the plate's whole bottom face (the strip's top is internal to the soup)
    expect(r.pct).toBeCloseTo((100 * 40) / 640, 3);
    expect(r.gap).toBeCloseTo(0.25, 4);
    expect(r.at[2]).toBeCloseTo(0.25, 4);
  });

  it("a flat face more than the band above the bed is a ceiling, not a hover", () => {
    const r = bedContact(soup(boxSoup([0, 0, 1.5], [30, 20, 4]), boxSoup([14, 0, 0], [16, 20, 1.5])));
    expect(r.hoverArea).toBe(0);
    expect(r.pct).toBe(100);
  });

  it("hovering area under the floor is noise", () => {
    const r = bedContact(soup(boxSoup([0, 0, 0], [30, 20, 3]), boxSoup([40, 0, 0.2], [40.5, 1, 3])));
    expect(r.hoverArea).toBeCloseTo(0.5, 3);
    expect(r.hoverArea).toBeLessThan(HOVER_FLOOR);
    expect(r.pct).toBe(100);
  });

  it("the bed is the mesh's own lowest Z, wherever it sits", () => {
    const r = bedContact(soup(boxSoup([0, 0, 10.25], [30, 20, 13]), boxSoup([14, 0, 10], [16, 20, 10.25])));
    expect(r.gap).toBeCloseTo(0.25, 4);
    expect(r.pct).toBeLessThan(10);
  });

  it("the footprint slack is capped, so a taller piece does not turn a hover into contact", () => {
    // A 30×20 underside with a 2×20 foot on the bed and the rest 0.15 mm up: the same
    // verdict whether the piece is 10 mm or 200 mm tall (uncapped, 0.1% of 200 mm would
    // be 0.2 mm of slack and call the hovering faces contact).
    const stepped = (top) => bedContact(soup(boxSoup([0, 0, 0.15], [30, 20, top]), boxSoup([0, 0, 0], [2, 20, 0.15])));
    const short = stepped(10), tall = stepped(200);
    expect(short.pct).toBeCloseTo((100 * 40) / 640, 3);
    expect(tall.pct).toBeCloseTo(short.pct, 6);
    expect(tall.gap).toBeCloseTo(0.15, 4);
    expect(MAX_BED_EPS).toBeLessThan(0.15);
  });

  it("an empty mesh has no reading", () => {
    expect(bedContact({ positions: new Float32Array(0), triangles: 0 })).toBeNull();
  });
});

describe("bedContactFor (what arms it)", () => {
  it("the FDM profiles carry a floor; resin does not", () => {
    expect(PROFILES["fdm-pla"].bedContact).toBe(50);
    expect(PROFILES["fdm-petg"].bedContact).toBe(50);
    expect(PROFILES.resin.bedContact).toBeUndefined();
  });

  it("the profile alone arms it — no orientation key needed", () => {
    expect(bedContactFor({ verify: { process: "fdm-pla" } })).toBe(50);
    expect(bedContactFor({ verify: { process: { base: "fdm-pla", bedContact: 80 } } })).toBe(80);
    expect(bedContactFor({ verify: { process: "resin" } })).toBeNull();
    expect(bedContactFor({})).toBeNull();
  });

  it("orientation: print arms it only with no profile; an author's own expectation arms it anywhere", () => {
    expect(bedContactFor({ verify: { orientation: "print" } })).toBe(DEFAULT_BED_CONTACT);
    // A named profile decides alone: resin prints on supports, and an FDM switch-off stays off.
    expect(bedContactFor({ verify: { process: "resin", orientation: "print" } })).toBeNull();
    expect(bedContactFor({ verify: { process: { base: "fdm-pla", bedContact: null }, orientation: "print" } })).toBeNull();
    expect(bedContactFor({ verify: { process: "resin" } }, undefined,
      { expanded: [{ expect: { a: { bedContactPct: ">=10" } } }] })).toBe(DEFAULT_BED_CONTACT);
    expect(bedContactFor({}, undefined, { expanded: [{ expect: { a: { bedContactPct: ">=10" } } }] })).toBe(DEFAULT_BED_CONTACT);
    expect(() => bedContactFor({ verify: { orientation: "sideways" } })).toThrow(/unknown verify.orientation/);
  });

  it("an explicit bedContact: null opts out even beside orientation: print", () => {
    expect(bedContactFor({ verify: { process: { base: "fdm-pla", bedContact: null }, orientation: "print" } })).toBeNull();
    // …while the author's own expectation can still ask for the measurement.
    expect(bedContactFor({ verify: { process: { base: "fdm-pla", bedContact: null }, orientation: "print" } }, undefined,
      { expanded: [{ expect: { a: { bedContactPct: ">=10" } } }] })).toBe(DEFAULT_BED_CONTACT);
  });
});

// ── measure + verify on real builds ───────────────────────────────────────────

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// The toggle latch's defect, reduced: a 30×24×3 lever body on the bed and a
// horizontal knuckle (a cylinder along Y) whose centre sits `dip` mm too low, so its
// bottom pokes below the body. Exported, the piece rests on the knuckle and the body
// hovers by `dip`.
const lever = (dip) => ({
  meta: { title: "Lever", units: "mm" },
  defaults: { dip },
  parts: { lever: { views: ["v"], build: (kk, p) => kk.box({ min: [0, -12, 0], max: [30, 12, 3] })
    .union(kk.cylinder({ d: 7.2, h: 24 }).along("+Y").at([30, -12, 3.6 - p.dip])) } },
  views: { v: { label: "V" } },
});

test("verify: an FDM part whose knuckle dips under its flat body fails bed contact, located and explained", () => {
  const v = verify(k, { ...lever(0.25), verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } });
  expect(v.ok).toBe(false);
  const bc = v.cases[0].checks.find((c) => c.metric === "bedContactPct");
  expect(bc.status).toBe("fail");
  expect(bc.kind).toBe("gate");
  expect(bc.actual).toBeLessThan(10);
  expect(bc.pattern).toBe("piece-hovers-above-bed");
  expect(bc.hint).toMatch(/z = 0/);
  expect(bc.note).toMatch(/0\.25 mm above the bed/);
  // Located on the body's underside, in the coordinates the view shows (body bottom at z = 0).
  expect(bc.location[2]).toBeCloseTo(0, 3);
  expect(v.failures.some((f) => f.metric === "bedContactPct")).toBe(true);
});

test("verify: the same part with the knuckle tangent to the bed passes", () => {
  const v = verify(k, { ...lever(0), verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } });
  const bc = v.cases[0].checks.find((c) => c.metric === "bedContactPct");
  expect(bc.status).toBe("pass");
  expect(bc.actual).toBe(100);
});

test("verify: the fix — trimming the piece flat at the bed plane — passes", () => {
  const trimmed = lever(0.25);
  const build = trimmed.parts.lever.build;
  trimmed.parts.lever.build = (kk, p) => build(kk, p).cut(kk.box({ min: [-50, -50, -20], max: [100, 50, 0] }));
  const v = verify(k, { ...trimmed, verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } });
  expect(v.cases[0].checks.find((c) => c.metric === "bedContactPct").status).toBe("pass");
});

test("verify: a rounded-bottom plate (fillet curl in the first millimetre) passes", () => {
  const plate = {
    meta: { title: "Plate", units: "mm" }, defaults: { r: 1 },
    parts: { plate: { views: ["v"], build: (kk, p) => kk.roundedBox({ size: [20, 20, 5], round: p.r }) } },
    views: { v: { label: "V" } },
  };
  const v = verify(k, { ...plate, verify: { process: "fdm-pla", expect: { plate: { holes: 0 } } } });
  expect(v.cases[0].checks.find((c) => c.metric === "bedContactPct").status).toBe("pass");
});

test("verify: not checked under resin or with no profile; an author can lower the floor for a recess meant to clear the bed", () => {
  const has = (v) => v.cases[0].checks.some((c) => c.metric === "bedContactPct");
  expect(has(verify(k, { ...lever(0.25), verify: { process: "resin", expect: { lever: { holes: 0 } } } }))).toBe(false);
  expect(has(verify(k, { ...lever(0.25), verify: { expect: { lever: { holes: 0 } } } }))).toBe(false);
  const lowered = verify(k, { ...lever(0.25), verify: { process: "fdm-pla", expect: { lever: { bedContactPct: ">=0" } } } });
  expect(lowered.cases[0].checks.find((c) => c.metric === "bedContactPct").status).toBe("pass");
});

test("verify: read in the print pose — a piece shown lifted or flipped is judged as it prints", () => {
  const part = lever(0.25);
  part.parts.lever.place = (s, { purpose }) => (purpose === "export" ? s : s.rotate(180, [15, 0, 5], [1, 0, 0]));
  const v = verify(k, { ...part, verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } });
  const bc = v.cases[0].checks.find((c) => c.metric === "bedContactPct");
  expect(bc.status).toBe("fail");
  // As built (the print pose) the body's underside sits at z = 0, 0.25 mm above the
  // knuckle's bottom; flipped about z = 5 for display, it sits at z = 10 in the view.
  expect(bc.location[2]).toBeCloseTo(10, 2);
});

test("verify: an exportable: false sub-part is not judged", () => {
  const part = lever(0);
  part.parts.ghost = { views: ["v"], exportable: false, build: (kk) => lever(0.25).parts.lever.build(kk, { dip: 0.25 }).translate([0, 40, 0]) };
  const v = verify(k, { ...part, verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } });
  const names = v.cases[0].checks.filter((c) => c.metric === "bedContactPct").map((c) => c.subpart);
  expect(names).toEqual(["lever"]);
});

test("measure: stamps whether the pass ran, and a quick lap on a seed without it withholds the gate", () => {
  const part = { ...lever(0.25), verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } };
  const armed = measure(k, part, "v");
  expect(armed.measuredBedContact).toBe(true);
  expect(armed.subparts[0].bedContactPct).toBeLessThan(10);
  const bare = measure(k, part, "v", {}, { bedContact: null });
  expect(bare.measuredBedContact).toBe(false);
  expect(bare.subparts[0].bedContactPct).toBeNull();
  const quick = verify(k, part, { seed: { params: {}, result: bare }, quick: true });
  const bc = quick.cases[0].checks.find((c) => c.metric === "bedContactPct");
  expect(bc.unevaluated).toBe(true);
  expect(quick.ok).toBeNull();
  // Not quick: the seed that skipped the pass is refused and the case re-measured.
  const full = verify(k, part, { seed: { params: {}, result: bare } });
  expect(full.cases[0].checks.find((c) => c.metric === "bedContactPct").status).toBe("fail");
});

// A place() that queries its solid cannot be read by the pose probes, so the display
// mesh cannot be carried into the print pose. Judged as displayed, the defective lever
// below — flipped for display — would show its flat TOP down, 4 mm under a knuckle that
// is now a hump, and pass. Bed contact reads the export build instead.
const queryingFlip = (part, { throwOnExport = false } = {}) => {
  part.parts.lever.place = (s, { purpose }) => {
    const { max } = s.boundingBox();
    if (purpose === "export") {
      if (throwOnExport) throw new Error("export pose unavailable");
      return s;
    }
    return s.rotate(180, [15, 0, max[2] / 2], [1, 0, 0]);
  };
  return part;
};

test("verify: a print pose place() cannot reveal is read off the export build, not the display mesh", () => {
  const bad = verify(k, { ...queryingFlip(lever(0.25)), verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } });
  const bc = bad.cases[0].checks.find((c) => c.metric === "bedContactPct");
  expect(bc.status).toBe("fail");
  expect(bc.actual).toBeLessThan(10);
  expect(bc.location ?? null).toBeNull();          // no honest way back to display coordinates
  const good = verify(k, { ...queryingFlip(lever(0)), verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } });
  expect(good.cases[0].checks.find((c) => c.metric === "bedContactPct").status).toBe("pass");
});

test("verify: when that export build fails, the gate is unevaluated, never judged on the display mesh", () => {
  const v = verify(k, { ...queryingFlip(lever(0), { throwOnExport: true }), verify: { process: "fdm-pla", expect: { lever: { holes: 0 } } } });
  const bc = v.cases[0].checks.find((c) => c.metric === "bedContactPct");
  expect(bc.unevaluated).toBe(true);
  expect(bc.message).toMatch(/pose did not build — export pose unavailable/);
  expect(v.ok).toBeNull();
});
