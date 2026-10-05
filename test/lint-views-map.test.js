import { expect, test } from "vitest";
import { lintPart } from "../src/framework/lint/index.js";
import { sheetPart } from "../src/framework/sheet/part.js";

const box = (k) => k.box({ size: [10, 10, 2] });
const mk = (lid, extraViews = {}) => ({
  meta: { title: "T" }, parameters: [], defaults: { h: 5 },
  parts: { lid: { build: box, ...lid } },
  views: { assembly: { label: "A" }, lid: { label: "L" }, ...extraViews },
});
const ids = (part) => lintPart(part).errors.map((f) => f.rule);
const finding = (part, rule) => lintPart(part).errors.find((f) => f.rule === rule);

test("a clean map-form part has no place or view findings", () => {
  const part = mk({ views: { assembly: (s, p) => s.translate([0, 0, p.h]), lid: true } });
  expect(ids(part).filter((i) => /place|view|pose/.test(i))).toEqual([]);
});

test("view-entry-invalid names the view for false, null and strings", () => {
  for (const bad of [false, null, "yes", { x: 1 }]) {
    const f = finding(mk({ views: { assembly: true, lid: bad } }), "view-entry-invalid");
    expect(f, String(bad)).toBeTruthy();
    expect(f.path).toBe("parts.lid.views.lid");
    expect(f.message).toContain('"lid"');
  }
});

test("views-and-place refuses an author place beside a views map", () => {
  const f = finding(mk({ views: { assembly: true }, place: (s) => s }), "views-and-place");
  expect(f.path).toBe("parts.lid.place");
});

test("views-and-place allows sheetPart's own generated pose", () => {
  const part = {
    meta: { title: "S" }, parameters: [], defaults: {},
    parts: { panel: sheetPart({ material: "birch plywood", thickness: 3,
      profile: (kk) => kk.shape2d({ outer: [[0, 0], [40, 0], [40, 20], [0, 20]], holes: [] }),
      pose: { face: "-Y", up: "+Z", at: [0, 0, 0] }, views: { box: true } }) },
    views: { box: { label: "Box" } },
  };
  expect(ids(part)).not.toContain("views-and-place");
});

test("view-pose-not-rigid fires once per sub-part for a reshaping entry, and is silent for an unreadable one", () => {
  const reshape = mk({ views: { assembly: (s) => s.scale(2), lid: (s) => s.scale(3) } });
  expect(ids(reshape).filter((i) => i === "view-pose-not-rigid")).toHaveLength(1);
  const query = mk({ views: { assembly: (s) => s.translate([0, 0, s.boundingBox().max[2]]), lid: true } });
  expect(ids(query)).not.toContain("view-pose-not-rigid");
});

test("place-not-rigid stays on legacy parts and does not double-report a map part", () => {
  const legacy = mk({ views: ["assembly"], place: (s, { purpose }) => (purpose === "export" ? s.scale(2) : s) });
  expect(ids(legacy)).toContain("place-not-rigid");
  const map = mk({ views: { assembly: (s) => s.scale(2) } });
  expect(ids(map)).not.toContain("place-not-rigid");
});

test("part-view-unknown reads map keys with a map path; view-unused counts map keys", () => {
  const f = finding(mk({ views: { assembly: true, lidd: true } }), "part-view-unknown");
  expect(f.path).toBe("parts.lid.views.lidd");
  const warns = lintPart(mk({ views: { assembly: true, lid: true } })).warnings.map((w) => w.rule);
  expect(warns).not.toContain("view-unused");
});

test("an animation fading a map-form piece is accepted in a view the map lists", () => {
  const part = mk({ views: { assembly: true, lid: true } });
  part.views.assembly.animations = { a: { duration: 1, opacity: { lid: [[0, 0], [1, 1]] } } };
  expect(ids(part)).not.toContain("animation-opacity-unknown-part");
});

test("views-invalid fires for missing views, a string and a number; array and map pass", () => {
  for (const bad of [undefined, "assembly", 3]) {
    const f = finding(mk({ views: bad }), "views-invalid");
    expect(f, String(bad)).toBeTruthy();
    expect(f.path).toBe("parts.lid.views");
    expect(f.message).toContain('"lid"');
    expect(f.hint).toContain("views: { assembly: true }");
  }
  expect(finding(mk({ views: ["assembly"] }), "views-invalid")).toBeUndefined();
  expect(finding(mk({ views: { assembly: true } }), "views-invalid")).toBeUndefined();
});
