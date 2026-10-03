// The pose probe: geometry-free per-subpart {baseHash, pose} extraction.
// Pure main-thread module — no kernel boot, no DOM.
import { expect, test } from "vitest";
import { probePoses } from "../src/framework/pose-probe.js";

// Minimal hinged-box shape: expensive base, then a pose rotation from a param.
const posedPart = {
  defaults: { w: 10, bore: 3, angle: 0 },
  views: { v: { label: "V" } },
  parts: {
    a: {
      views: ["v"],
      build: (k, p) =>
        k.box({ min: [0, 0, 0], max: [p.w, 10, 5] })
          .fillet({ r: 1, edges: { dir: "Z" } })
          .cut(k.cylinder({ r: p.bore / 2, h: 7 }).at([5, 5, -1]))
          .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
    },
  },
};

test("a pose-only param change keeps baseHash stable and changes only the pose", () => {
  const a0 = probePoses(posedPart, "v", { angle: 0 }).get("a");
  const a45 = probePoses(posedPart, "v", { angle: 45 }).get("a");
  expect(a0.trusted).toBe(true);
  expect(a45.trusted).toBe(true);
  expect(a45.baseHash).toBe(a0.baseHash);
  expect(a45.pose).not.toEqual(a0.pose);
  // the recorded steps are the rotateAbout sugar's underlying rotate
  expect(a45.pose.at(-1)).toEqual({ t: "rotate", deg: 45, center: [0, 0, 5], axis: [1, 0, 0] });
});

test("a geometry param change changes baseHash", () => {
  const a = probePoses(posedPart, "v", { bore: 3 }).get("a");
  const b = probePoses(posedPart, "v", { bore: 4 }).get("a");
  expect(a.baseHash).not.toBe(b.baseHash);
});

test("a transform buried under later booleans folds into baseHash (pose stays empty)", () => {
  const part = {
    defaults: { off: 1 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) =>
      k.box({ min: [0, 0, 0], max: [4, 4, 4] })
        .union(k.sphere({ r: 2 }).translate([p.off, 0, 0])) } },
  };
  const a1 = probePoses(part, "v", { off: 1 }).get("a");
  const a2 = probePoses(part, "v", { off: 2 }).get("a");
  expect(a1.trusted).toBe(true);
  expect(a1.pose).toEqual([]);                 // the translate was consumed by the union
  expect(a1.baseHash).not.toBe(a2.baseHash);   // …so it must live in the hash
});

test("place() is part of the probed pose", () => {
  const part = {
    defaults: { lift: 2 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"],
      build: (k) => k.box({ min: [0, 0, 0], max: [2, 2, 2] }),
      place: (s, { p }) => s.translate([0, 0, p.lift]) } },
  };
  const a = probePoses(part, "v", { lift: 3 }).get("a");
  expect(a.trusted).toBe(true);
  expect(a.pose).toEqual([{ t: "translate", v: [0, 0, 3] }]);
});

test("a build that queries geometry is untrusted (query results can't be probed)", () => {
  const part = {
    defaults: {},
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k) => {
      const s = k.box({ min: [0, 0, 0], max: [4, 4, 4] });
      return s.translate([0, 0, s.boundingBox().size[2]]);
    } } },
  };
  expect(probePoses(part, "v", {}).get("a").trusted).toBe(false);
});

test("a query feeding a GEOMETRY arg is untrusted (not just a pose arg)", () => {
  const part = {
    defaults: {},
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k) => {
      const s = k.box({ min: [0, 0, 0], max: [4, 4, 4] });
      return s.union(k.sphere({ r: s.boundingBox().size[0] }));
    } } },
  };
  expect(probePoses(part, "v", {}).get("a").trusted).toBe(false);
});

// A closure selector captures params the source text doesn't show, so it can't be
// hashed — the OCCT backend gives function selectors a per-call unique key for the
// same reason. Hashing them would keep baseHash stable while geometry changed.
test("a function arg nested in an options object is untrusted", () => {
  const part = {
    defaults: { z: 1 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) =>
      k.box({ min: [0, 0, 0], max: [4, 4, 4] })
        .fillet({ r: 1, edges: (e) => e.inDirection([0, 0, p.z]) }) } },
  };
  const a1 = probePoses(part, "v", { z: 1 }).get("a");
  const a2 = probePoses(part, "v", { z: 2 }).get("a");
  expect(a1.trusted).toBe(false);
  expect(a2.trusted).toBe(false);
});

test("a top-level positional function arg is untrusted", () => {
  const part = {
    defaults: { z: 1 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) =>
      k.box({ min: [0, 0, 0], max: [4, 4, 4] })
        .fillet(1, (e) => e.inDirection([0, 0, p.z])) } },
  };
  expect(probePoses(part, "v", { z: 1 }).get("a").trusted).toBe(false);
  expect(probePoses(part, "v", { z: 2 }).get("a").trusted).toBe(false);
});

// regions() is scission: on a real backend the ARRAY LENGTH is param-dependent
// data, so a build branching on it can keep a stable baseHash while the geometry
// changes. The probe returns one token, so that data can't be believed either.
test("a build that calls regions() is untrusted (its length is a query result)", () => {
  const part = {
    defaults: { n: 2 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => {
      const profile = k.rect({ w: p.n, h: 4 });
      const regions = profile.regions();
      return k.extrude({ profile: regions[0], h: regions.length });
    } } },
  };
  expect(probePoses(part, "v", { n: 2 }).get("a").trusted).toBe(false);
});

// The NaN belt-and-suspenders: a pose step whose angle isn't finite must fail
// the trust gate on its own, with no query op anywhere in the build.
test("a non-finite pose value is untrusted even with no query", () => {
  const part = {
    defaults: { angle: 0 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) =>
      k.box({ min: [0, 0, 0], max: [4, 4, 4] })
        .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 2] }) } },
  };
  expect(probePoses(part, "v", { angle: 45 }).get("a").trusted).toBe(true);
  expect(probePoses(part, "v", { angle: NaN }).get("a").trusted).toBe(false);
});

test("a throwing build is untrusted, and other subparts still probe", () => {
  const part = {
    defaults: {},
    views: { v: { label: "V" } },
    parts: {
      bad: { views: ["v"], build: () => { throw new Error("boom"); } },
      good: { views: ["v"], build: (k) => k.sphere({ r: 3 }) },
    },
  };
  const m = probePoses(part, "v", {});
  expect(m.get("bad").trusted).toBe(false);
  expect(m.get("good").trusted).toBe(true);
});

test("only subparts of the requested view are probed", () => {
  const part = {
    defaults: {},
    views: { v: { label: "V" }, w: { label: "W" } },
    parts: {
      a: { views: ["v"], build: (k) => k.sphere({ r: 1 }) },
      b: { views: ["w"], build: (k) => k.sphere({ r: 2 }) },
    },
  };
  const m = probePoses(part, "v", {});
  expect([...m.keys()]).toEqual(["a"]);
});

// A named asset's SOURCE is geometry too. The build names a font ("face"), an
// image or an artwork, and that name is the same whichever one a control
// picked — so before the sources were folded in, a font pick probed as
// "unchanged geometry" and the fast path re-posed the old letters (the Lattice
// Box's raised text kept its previous typeface while the pocket cut from the
// same text updated).
const textPart = {
  defaults: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf", angle: 0 },
  fonts: (p) => ({ face: p.face }),
  views: { v: { label: "V" } },
  parts: {
    letters: {
      views: ["v"],
      build: (k, p) =>
        k.text2d("Eddie", { size: 10, font: "face" })
          .extrude({ h: 2 })
          .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 0] }),
    },
  },
};

test("a font pick changes baseHash even though the build names the same font", () => {
  const a = probePoses(textPart, "v", { ...textPart.defaults }).get("letters");
  const b = probePoses(textPart, "v", { ...textPart.defaults, face: "https://fonts.gstatic.com/s/b/v1/b.ttf" }).get("letters");
  expect(a.trusted).toBe(true);
  expect(b.trusted).toBe(true);
  expect(b.baseHash).not.toBe(a.baseHash);
});

test("a pose-only change on a text part still takes the fast path", () => {
  const a = probePoses(textPart, "v", { ...textPart.defaults, angle: 0 }).get("letters");
  const b = probePoses(textPart, "v", { ...textPart.defaults, angle: 30 }).get("letters");
  expect(b.baseHash).toBe(a.baseHash);
  expect(b.pose).not.toEqual(a.pose);
});

test("byte-valued font sources are told apart by content, not identity", () => {
  const bytes = (n) => new Uint8Array([1, 2, 3, n]).buffer;
  const a = probePoses(textPart, "v", { ...textPart.defaults, face: bytes(4) }).get("letters");
  const same = probePoses(textPart, "v", { ...textPart.defaults, face: bytes(4) }).get("letters");
  const other = probePoses(textPart, "v", { ...textPart.defaults, face: bytes(5) }).get("letters");
  expect(same.baseHash).toBe(a.baseHash);
  expect(other.baseHash).not.toBe(a.baseHash);
});

test("image and vector picks change baseHash the same way", () => {
  const part = {
    defaults: { img: "a.png", art: "a.svg" },
    images: (p) => ({ img: p.img }),
    vectors: (p) => ({ art: p.art }),
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k) => k.heightfield("img", { size: [10, 10], h: 2 }).union(k.vector2d("art").extrude({ h: 1 })) } },
  };
  const base = probePoses(part, "v", { ...part.defaults }).get("a");
  expect(base.trusted).toBe(true);
  expect(probePoses(part, "v", { ...part.defaults, img: "b.png" }).get("a").baseHash).not.toBe(base.baseHash);
  expect(probePoses(part, "v", { ...part.defaults, art: "b.svg" }).get("a").baseHash).not.toBe(base.baseHash);
});

test("a throwing asset declaration makes every sub-part untrusted rather than throwing", () => {
  const part = { ...textPart, fonts: () => { throw new Error("boom"); } };
  expect(probePoses(part, "v", { ...textPart.defaults }).get("letters").trusted).toBe(false);
});
