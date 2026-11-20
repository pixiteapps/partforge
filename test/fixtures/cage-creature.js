// DEMO fixture (dev-only, not a reference part; lives here so the reference-part tests skip it): a whale from one subdivision cage with drag
// handles on its tail, flukes, dorsal fin, pectoral fins and nose. Every handle writes
// cage sizes, so each drag is a SHAPE drag: the cage is rebuilt and re-smoothed while the
// handle moves. Five more settings have no handle (head and tail taper, fluke and pectoral
// width, dorsal rake): click that part of the whale and its sliders open at the spot.
// `npm run dev`, then open /cage-creature.html.
//
// The handles sit on cage face centres. derive() has no kernel, so the same cage is built
// there with `cage` from partforge/organic (what k.cage calls) to read those centres.
import { cage as createCage } from "../../src/framework/domains/organic/index.js";

const far = ([x, y, z]) => [x, -y, z];   // a point's twin across the cage's mirror plane (Y = 0)
const mean = (c, ids) => {
  const list = Array.isArray(ids) ? ids : [ids];
  const sum = [0, 0, 0];
  for (const id of list) { const p = c.centroid(id); for (let a = 0; a < 3; a++) sum[a] += p[a] / list.length; }
  return sum;
};

/** The cage at params p, built by `make` (k.cage in build, createCage in derive). Returns the cage and the faces the handles sit on. */
function creature(make, p) {
  const c = make({ box: { size: [60, 30 * p.girth, 26 * p.girth], center: [0, 0, 0], segs: [4, 2, 2] }, mirror: "xz" });
  const positive = (prefix) => c.faces(prefix).filter((id) => !id.endsWith("~"));
  c.scale(positive("+y:"), [1, 1, 0.75]);
  c.scale(positive("+z:"), [1, 0.75, 1]);
  c.scale(positive("-z:"), [1, 0.75, 1]);
  const head = c.extrude(["-x:1,0", "-x:1,1"], { by: 8, scale: [1, p.headTaper, p.headTaper + 0.05], id: "head" });
  const nose = c.extrude(head, { by: p.noseLength, scale: [1, 0.7, 0.7], id: "nose" });
  const t1 = c.extrude(["+x:1,0", "+x:1,1"], { by: [p.tailLength * 0.45, 0, 1], scale: [1, p.tailTaper, p.tailTaper], id: "tail1" });
  const t2 = c.extrude(t1, { by: [p.tailLength * 0.38, 0, p.tailLift / 2], scale: [1, 0.6, 0.6], id: "tail2" });
  const t3 = c.extrude(t2, { by: [p.tailLength * 0.17, 0, p.tailLift / 2], scale: [1, 0.8, 0.8], id: "tail3" });
  const fluke = c.extrude(["tail3.s1", "tail3.s2"], { by: [p.flukeSweep * 0.3, p.flukeSpan * 0.5, 0], scale: [1.2 * p.flukeChord, 1, 0.3], id: "fluke" });
  const flukeTip = c.extrude(fluke, { by: [p.flukeSweep * 0.7, p.flukeSpan * 0.5, 0], scale: [0.6, 1, 0.7], id: "flukeTip" });
  const fin = c.extrude("+z:3,1", { by: [2, 0, p.finHeight * 0.55], scale: [0.6, 0.7, 1], id: "fin" });
  const finTip = c.extrude(fin, { by: [p.finRake, 0, p.finHeight * 0.45], scale: [0.5, 0.35, 0.6], id: "finTip" });
  const pec = c.extrude("+y:1,0", { by: [p.pecSweep * 0.3, p.pecSpan * 0.35, -2], scale: [0.7 * p.pecChord, 1, 0.35], id: "pec" });
  const pecTip = c.extrude(pec, { by: [p.pecSweep * 0.7, p.pecSpan * 0.65, -2], scale: [0.6, 1, 0.6], id: "pecTip" });
  const own = (ids) => (Array.isArray(ids) ? ids : [ids]).filter((id) => !id.endsWith("~"));
  const onPlane = ([x, , z]) => [x, 0, z];   // these caps straddle the mirror plane
  return { c, at: { nose: onPlane(mean(c, nose)), tail: onPlane(mean(c, t3)), fluke: mean(c, own(flukeTip)), fin: onPlane(mean(c, finTip)), pec: mean(c, own(pecTip)) } };
}

export default {
  meta: { title: "Cage creature (demo)", units: "mm", backend: "manifold" },
  parameters: [
    { id: "body", title: "Body", controls: [
      { key: "girth", label: "Girth", min: 0.7, max: 1.4, step: 0.05, description: "Scales the body's cross-section." },
      { key: "noseLength", label: "Nose", unit: "mm", min: 2, max: 20, step: 0.5 },
      { key: "headTaper", label: "Head taper", min: 0.5, max: 1, step: 0.05, description: "How much the head narrows toward the nose. No handle: click the head." },
    ] },
    { id: "tail", title: "Tail", controls: [
      { key: "tailLength", label: "Tail length", unit: "mm", min: 25, max: 70, step: 0.5 },
      { key: "tailTaper", label: "Tail taper", min: 0.4, max: 0.9, step: 0.05, description: "No handle: click the tail." },
      { key: "tailLift", label: "Tail lift", unit: "mm", min: -14, max: 24, step: 0.5 },
      { key: "flukeSpan", label: "Fluke span", unit: "mm", min: 10, max: 45, step: 0.5 },
      { key: "flukeSweep", label: "Fluke sweep", unit: "mm", min: -6, max: 28, step: 0.5 },
      { key: "flukeChord", label: "Fluke width", min: 0.6, max: 1.6, step: 0.05, description: "No handle: click a fluke." },
    ] },
    { id: "fins", title: "Fins", controls: [
      { key: "finHeight", label: "Dorsal fin", unit: "mm", min: 3, max: 26, step: 0.5 },
      { key: "pecSpan", label: "Pectoral span", unit: "mm", min: 8, max: 40, step: 0.5 },
      { key: "pecSweep", label: "Pectoral sweep", unit: "mm", min: -8, max: 26, step: 0.5 },
      { key: "finRake", label: "Dorsal rake", unit: "mm", min: -4, max: 14, step: 0.5, description: "How far the dorsal fin leans back. No handle: click the fin." },
      { key: "pecChord", label: "Pectoral width", min: 0.6, max: 1.6, step: 0.05, description: "No handle: click a pectoral fin." },
    ] },
  ],
  defaults: { girth: 1, noseLength: 5, tailLength: 42, tailLift: 6, flukeSpan: 24, flukeSweep: 12, finHeight: 9, pecSpan: 18, pecSweep: 11, headTaper: 0.8, tailTaper: 0.6, flukeChord: 1, finRake: 5, pecChord: 1 },
  derive: (p) => creature(createCage, p).at,
  parts: {
    creature: {
      label: "Creature",
      views: ["creature"],
      build: (k, p) => k.subdiv(creature(k.cage, p).c),
    },
  },
  views: { creature: { label: "Creature" } },
  handles: {
    tail: { point: (p, d) => d.tail, params: ["tailLength", "tailLift"], drag: "plane", normal: [0, 1, 0], label: "Tail", showOn: "creature" },
    fluke: { point: (p, d) => d.fluke, params: ["flukeSweep", "flukeSpan"], drag: "plane", normal: [0, 0, 1], label: "Fluke", showOn: "creature" },
    // The cage is mirrored, so each side handle has a twin at the reflected point writing
    // the same params: grab either side and both sides follow.
    flukeFar: { point: (p, d) => far(d.fluke), params: ["flukeSweep", "flukeSpan"], drag: "plane", normal: [0, 0, 1], label: "Fluke", showOn: "creature" },
    fin: { point: (p, d) => d.fin, params: ["finHeight"], drag: "axis", direction: [0, 0, 1], label: "Dorsal fin", showOn: "creature" },
    pec: { point: (p, d) => d.pec, params: ["pecSweep", "pecSpan"], drag: "plane", normal: [0, 0, 1], label: "Pectoral fin", showOn: "creature" },
    pecFar: { point: (p, d) => far(d.pec), params: ["pecSweep", "pecSpan"], drag: "plane", normal: [0, 0, 1], label: "Pectoral fin", showOn: "creature" },
    nose: { point: (p, d) => d.nose, params: ["noseLength"], drag: "axis", direction: [-1, 0, 0], label: "Nose", showOn: "creature" },
  },
};
