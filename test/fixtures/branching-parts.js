// Small parts that genuinely branch, for the recorded-reads soundness property.
// Each one makes a different set of params matter depending on other params, so a
// nudge can flip a branch, not just scale a dimension.

// Enum switch: ribCount/ribH are read only on the "ribs" branch, holeD only on "holes".
export const enumSwitch = {
  defaults: { mode: "ribs", size: 20, ribCount: 3, ribH: 4, holeD: 4 },
  parameters: [{ id: "g", title: "G", advanced: [
    { key: "mode", label: "Mode", control: "select", options: [{ value: "ribs", label: "Ribs" }, { value: "holes", label: "Holes" }] },
  ] }],
  views: { v: { label: "V" } },
  parts: {
    plate: { views: ["v"], build: (k, p) => {
      const body = k.box({ min: [0, 0, 0], max: [p.size, p.size, 3] });
      if (p.mode === "ribs") {
        let out = body;
        for (let i = 0; i < p.ribCount; i++) out = out.union(k.box({ min: [2 + i * 5, 0, 3], max: [3 + i * 5, p.size, 3 + p.ribH] }));
        return out;
      }
      return body.cut(k.cylinder({ d: p.holeD, h: 10 }).at([p.size / 2, p.size / 2, -2]));
    } },
  },
};

// Two sub-parts with disjoint reads; a grouped derive key is consumed only by B.
export const disjoint = {
  defaults: { w: 10, h: 6, r: 4, seg: 5 },
  derive: {
    radius: (p) => ({ rr: p.r + 1 }),
    stack: (p) => ({ sh: p.seg * 2 }),
  },
  views: { v: { label: "V" } },
  parts: {
    a: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.h, 3] }) },
    b: { views: ["v"], build: (k, p, d) => k.cylinder({ r: d.rr, h: d.sh }).at([40, 0, 0]) },
  },
};

// A param moves the pocket in and out of emptiness; pocketDepth is read only past the guard.
export const pocketGuard = {
  defaults: { px: 10, pocketDepth: 2, size: 20 },
  views: { v: { label: "V" } },
  parts: {
    block: { views: ["v"], build: (k, p) => {
      const body = k.box({ min: [0, 0, 0], max: [p.size, p.size, 6] });
      const pocket = k.box({ min: [p.px, 0, 0], max: [p.px + 5, p.size, 6] }).intersect(body);
      return pocket.isEmpty() ? body : body.cut(k.box({ min: [p.px, 2, 6 - p.pocketDepth], max: [p.px + 5, p.size - 2, 7] }));
    } },
  },
};

// NEGATIVE CONTROL: reads state outside p and d. The soundness check must flag it.
export const leak = { n: 0 };
export const leaky = {
  defaults: { size: 10, other: 1 },
  views: { v: { label: "V" } },
  parts: {
    box: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.size + leak.n, 5, 5] }) },
  },
};
