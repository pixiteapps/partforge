// test/implicit-sharpen-digest.test.js
// The sharpen stage's output, pinned byte for byte. Each case runs the stages before sharpen,
// then sharpenMesh in JS and ip_sharpen on the core, from one plan. The JS output's positions,
// indices and normals (`mesh`) and its other tables and stats (`tables`) must match the digests
// recorded here, and the core's positions, indices and normals must match the JS's. The digests
// were recorded before the stage's bookkeeping was made local (0.207), and re-recorded for a change
// to cleanup's output and to the density rule, and for the corner solve. A speed-up must keep them. Do not re-record a
// digest to make a speed-up pass. Last, a check of the apart index's fallback.
import { createHash } from "node:crypto";
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { compileImplicit } from "../src/framework/geometry/implicit/compile.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { meshStoreOwners } from "../src/framework/geometry/implicit/mesher-owners.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { cutCreases } from "../src/framework/geometry/implicit/crease.js";
import { sharpenMesh, SHARP_APART } from "../src/framework/geometry/implicit/sharpen.js";
import { apartIndex } from "../src/framework/geometry/implicit/sharpen-mesh.js";
import { core, loadFullCore } from "../src/framework/core/core.js";
import { NativeSession } from "../src/framework/core/implicit-core.js";
import { handSpec, vaseSpec } from "./fixtures/implicit-trees.js";
import { meshFieldOf } from "./helpers/implicit-stages.js";

let k;
beforeAll(async () => {
  await loadFullCore();
  k = await bootManifoldKernel({ quality: "preview", meshFields: true });
}, 60_000);

const leaf = (s) => ({ kind: "solid", solid: s });
const KNURL = "vec2 z = normalize(p.xy); for (int i = 0; i < 4; i++) { z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y); } "
  + "float c = cos(p.z * 1.3); float s = sin(p.z * 1.3); return max(z.x * c - z.y * s, z.x * c + z.y * s);";
const knurl = () => ({ kind: "displace", amount: 0.7, child: leaf(k.cylinder({ r: 12, h: 30 })), by: { expr: KNURL } });
const posed = (gap) => ({
  frames: { fa: { at: [-7.4, 0, 0] }, fb: { at: [7.4, 0, 0], rotate: [{ axis: "y", deg: 6 }] } },
  root: { kind: "contact", gap, bulge: 0, children: [
    { kind: "capsule", a: [0, 0, -20], b: [0, 0, 20], r: 8, frame: "fa", label: "a" },
    { kind: "capsule", a: [0, 0, -20], b: [0, 0, 20], r: 8, frame: "fb", label: "b" },
    { kind: "box", size: [36, 24, 6], at: [0, 0, 26], label: "c" },
  ] },
});
// The cases of test/implicit-sharpen.test.js, the hand and the vase. [spec maker, grid, tier].
const SPECS = {
  "box": () => ({ root: { kind: "box", size: [40, 30, 6] } }),
  "plate-edge": () => ({ root: { kind: "union", k: 8, children: [leaf(k.box({ min: [-30, -20, 0], max: [30, 20, 6] })),
    leaf(k.cylinder({ r: 8, h: 26 }).at([20, 0, 4]))] } }),
  "bracket-corner": () => ({ root: { kind: "union", k: 6, children: [
    leaf(k.box({ min: [-30, -20, 0], max: [30, 20, 6] }).union(k.box({ min: [-30, -20, 0], max: [-24, 20, 30] }))),
    leaf(k.cylinder({ r: 5, h: 20 }).at([-14, 0, 4]))] } }),
  "cylinder-side": () => ({ root: { kind: "union", k: 4, children: [leaf(k.cylinder({ r: 12, h: 40 })),
    leaf(k.box({ min: [8, -4, 16], max: [22, 4, 24] }))] } }),
  "curved-crease": () => ({ root: { kind: "intersect", k: 0, children: [{ kind: "sphere", r: 12 }, { kind: "cylinder", r: 8, h: 40 }] } }),
  "cage": () => {
    const c = k.cage({ box: { size: [44, 24, 22], segs: [2, 1, 1] } });
    c.extrude("+x:0,0", { by: 14, scale: 0.55 });
    return { root: { kind: "union", k: 7, children: [leaf(k.subdiv(c).at([0, 0, 24])), leaf(k.cylinder({ r: 5, h: 22 }).at([-6, 0, 0]))] } };
  },
  "offset -2": () => ({ root: { kind: "offset", d: -2, child: leaf(k.box({ min: [-20, -15, -10], max: [20, 15, 10] })) } }),
  "offset +2": () => ({ root: { kind: "offset", d: 2, child: leaf(k.box({ min: [-20, -15, -10], max: [20, 15, 10] })) } }),
  "knurl": () => ({ root: knurl() }),
  "knurl and box": () => ({ root: { kind: "union", children: [knurl(), leaf(k.box({ min: [30, -10, 0], max: [50, 10, 10] }))] } }),
  "posed gap 0": () => posed(0),
  "posed gap 0.05": () => posed(0.05),
  "hand": () => handSpec(),
  "vase": () => vaseSpec().spec,
  "spheres": () => ({ root: { kind: "union", k: 6, children: [{ kind: "sphere", r: 10, at: [-6, 0, 0] }, { kind: "sphere", r: 10, at: [6, 0, 0] }] } }),
};

// [case, grid, tier, mesh digest, tables digest]. Recorded before any speed-up (commit ad1d180b), and
// re-recorded twice (0.207): once when cleanup began merging the mesher's vertex clusters and the
// density rule began measuring candidates per cell of area (those change the stage's input and its
// skips), and once when a corner point began to be solved on its three faces (a moved corner, and
// two new counts in the stats).
const CASES = [
  ["box", 0.6, "preview", "69fdeae954de8c9a16dc3faef88ff7eb", "4bcf24881880651a185f1948d9c91f5b"],
  ["box", 1.0, "preview", "ab7f9c0465a66ddcba9c46525d76421c", "6538a78fff6a9f03122c12d0ef4d93b7"],
  ["plate-edge", 0.6, "preview", "d991d460532b92277e7599d920d46fd4", "dd89150f3e2b3780f2b49e03ca7368ef"],
  ["plate-edge", 1.0, "preview", "5480d2937d3374701e91deaec10f045f", "d5567c89d2b070be96a540d72f4f81f8"],
  ["bracket-corner", 0.6, "preview", "d53c4eea2d9ae42305fd33270c248832", "93bc1c581fd50b81fd9900704d03fe68"],
  ["bracket-corner", 1.0, "preview", "601c0179f27b9c0215ed3dae28683231", "a65bea3259956407cb209bb2cc06a755"],
  ["cylinder-side", 0.6, "preview", "2cb576ca3a801e187ca89d63daf411f5", "eef2b7a1a78e7be9cf264c7654a019a2"],
  ["cylinder-side", 1.0, "preview", "5fa3e2353b83a35df748d9529edfd69b", "a11547ab23510af24d69b0f975873383"],
  ["curved-crease", 0.6, "preview", "c59a7bf8c0dc9dba4443331c101dad22", "0809c17b44134731d05d0d16309421fd"],
  ["curved-crease", 1.0, "preview", "8bc0f777d01f4f22f713f4898d8a42b9", "65a10b737d357046c5d4471ccbf74c68"],
  ["cage", 0.6, "preview", "7e42ac5aed6f6f2067c79a0bb257668d", "5e8bc7fc9911b212ef36ee73889b128f"],
  ["offset -2", 0.6, "preview", "8434dffc1c858b8546ae2f400ed784b3", "ec13fa3f175f870b5d8f452639f3d846"],
  ["offset +2", 0.6, "preview", "bed5f1c485920c1e7aca21f67b5200dd", "0afe80435e51f9a48d473dcc583a2157"],
  ["knurl", 0.6, "preview", "2e805f62a6327cff76ef60b8a6f01458", "ca27528b5ebb7c777f408140c04277f5"],
  ["knurl", 0.3, "print", "32953166b2299435b78284b1931be636", "6609c000b9daca821ed539e332c3fa75"],
  ["knurl and box", 0.6, "preview", "232323d3de16e9f5f187a6003de6245a", "e26fa8bf703d055ba5caebae7c42b6e2"],
  ["posed gap 0", 0.6, "preview", "8dba7d483af6305202e3a98a00f032a8", "12cc3061deb04c0490a42e28e11512af"],
  ["posed gap 0.05", 0.6, "preview", "39d1dae984e01ad02baa011c38376478", "b5cfb6a3fea80828ee3be1ce24410764"],
  ["posed gap 0", 1.0, "preview", "6d7ab5f30474f92bd42ad440075a01ca", "2b60eaad62222d99b572eca2b4df357b"],
  ["posed gap 0.05", 1.0, "preview", "64832adbdf493f1f7f33e67ed5b5d725", "db03d7e9c146c20a2dd635484430970b"],
  ["hand", 1.5, "preview", "82d61f4e32f106e24da47c5ab418cb93", "17bd0aaf5b9439ceb36649f31c1214e1"],
  ["hand", 0.8, "print", "14ecaa445aaa8b328f96f2185b09a350", "815fedebc7784641888fe3debe8c1b24"],
  ["vase", 1.2, "preview", "207c65551444ff5397b219cfb25abb2c", "23a20bd1a8a26f59704fc5eaf5fbfd34"],
  ["spheres", 0.6, "preview", "4e446bca7b4db97129ab2a3e90988002", "6347e61579ff392527a10b749519d677"],
  ["spheres", 1.0, "preview", "ca0035bb5664646364dab210a4d611d7", "fbc55f9f0f918abe62a58fc6894895d4"],
];

const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const digest = (parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "string" ? Buffer.from(p) : bytes(p)).update("|");
  return h.digest("hex").slice(0, 32);
};
const meshDigest = (m) => digest([m.positions, m.indices, m.normals]);
const TABLES = ["vertLeaf", "sharp", "sharpPlanes", "vertOwner", "ownerHeld", "pinned", "crease"];
const tablesDigest = (m, stats) => digest([...TABLES.map((f) => (m[f] ? m[f] : `no ${f}`)), JSON.stringify(stats)]);

describe("the sharpen stage's output is pinned", () => {
  for (const [name, edge, tier, want, wantTables] of CASES) {
    test(`${name} at ${edge} ${tier}`, () => {
      const vase = name === "vase" ? vaseSpec() : null;
      const images = vase ? vase.images : new Map();
      const compiled = compileImplicit(SPECS[name](), { images, meshFieldOf });
      const opts = tier === "preview" ? PREVIEW_CLEANUP : CLEANUP;
      const plan = planLeaves(compiled, edge, { anchor: false });
      const owner = compiled.ownerRoot >= 0 ? compiled.ir.nodes[compiled.ownerRoot] : null;
      // JS.
      const store = evaluateLeaves(plan, {});
      let cleaned = cleanupMesh(store, owner ? meshStoreOwners(store, { gap: owner.gap }) : meshStore(store), opts);
      if (owner) cleaned = cutCreases(store, cleaned, owner.attWorld);
      const stats = {}, js = sharpenMesh(store, cleaned, { stats });
      const got = meshDigest(js), gotTables = tablesDigest(js, stats);
      // The core, from the same plan.
      const s = new NativeSession(core());
      let nat;
      try {
        plan.textures.forEach((t) => s.addTexture(t));
        (plan.textures.meshes ?? []).forEach((f) => s.addMesh(f));
        plan.programs.forEach((p) => s.addProgram(p));
        if (owner) s.setContact(owner);
        s.sample(plan, { readBack: false });
        if (owner) s.meshOwners({ readBack: false }); else s.mesh({ readBack: false });
        s.cleanup(opts, { readBack: false });
        if (owner) s.crease({ readBack: false });
        nat = s.sharpen();
      } finally { s.destroy(); }
      expect(meshDigest(nat), "core == JS").toBe(got);
      expect(got, "mesh").toBe(want);
      expect(gotTables, "tables and stats").toBe(wantTables);
    }, 600_000);
  }
});

// The apart index files only the cells around the points it is told it will be asked about. A
// point it was not told about is answered by testing every vertex: the same answers.
describe("the sharpen apart index", () => {
  test("answers a point it was not built for as one it was", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const edge = 1, ap = SHARP_APART * edge, nv = 400, P = new Float64Array(3 * (nv + 50));
    for (let i = 0; i < 3 * nv; i++) P[i] = rnd() * 0.05;
    // Points near vertices (inside and outside the guard distance) and far from all of them.
    const asks = [];
    for (let q = 0; q < 300; q++) {
      const v = Math.floor(rnd() * nv), r = (q % 3) * ap * 0.8;
      asks.push([P[3 * v] + r, P[3 * v + 1] - r / 2, P[3 * v + 2] + r / 3]);
    }
    const built = apartIndex(P, nv, edge, asks)(P), blind = apartIndex(P, nv, edge, [])(P);
    // A vertex moved by the commit, and one it placed, filed with add().
    P[0] = asks[5][0] + ap / 2; P[1] = asks[5][1]; P[2] = asks[5][2];
    P.set(asks[9], 3 * nv);
    for (const ix of [built, blind]) { ix.add(0); ix.add(nv); }
    let near = 0;
    asks.forEach((p, q) => {
      const skip = q % 7 === 0 ? 0 : -1, a = built.has(p, skip);
      expect(blind.has(p, skip), `ask ${q}`).toBe(a);
      if (a) near++;
    });
    expect(near).toBeGreaterThan(50);
    expect(near).toBeLessThan(300);
  });
});
