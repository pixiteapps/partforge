// test/implicit-sharpen-digest.test.js
// The sharpen stage's output, pinned byte for byte. Each case runs the stages before sharpen,
// then sharpenMesh in JS and ip_sharpen on the core, from one plan. The JS output's positions,
// indices and normals (`mesh`) and its other tables and stats (`tables`) must match the digests
// recorded here, and the core's positions, indices and normals must match the JS's. The digests
// were recorded before the stage's bookkeeping was made local (0.207), and re-recorded once for a
// change to cleanup's output and to the density rule. A speed-up must keep them. Do not re-record a
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
// re-recorded once (0.207) when cleanup began merging the mesher's vertex clusters and the density
// rule began measuring candidates per cell of area: those change the stage's input and its skips.
const CASES = [
  ["box", 0.6, "preview", "06400bd3d304fa37f4c2aba16ccd21b7", "d71776f265eb2061065bd41bc05696ec"],
  ["box", 1.0, "preview", "23938f26b55a6fce02da4bcd8b9cdf66", "5288b9d5b57ad0cb125ba8f847b64778"],
  ["plate-edge", 0.6, "preview", "5de400f84b721558212f8ff2dc34120b", "c47dfc36cf87f83da4ce2f4d78a59cbb"],
  ["plate-edge", 1.0, "preview", "777de647dfefcfd485557ca32cf4881b", "e18643061e2e5c469d617076b1f28796"],
  ["bracket-corner", 0.6, "preview", "f89765dbd14f330a4561aaf045e55ce0", "2e0782e06a83d83f557b3be3d4b4a5bb"],
  ["bracket-corner", 1.0, "preview", "ec77c3496e1de3b4dd9d5fa49c572f84", "4a0f6d6c6aaa87b41ff7db7ba92ada83"],
  ["cylinder-side", 0.6, "preview", "7793a55a0c74830884c4e945a0dff047", "571f7107ce4ab020509e987e2a628afa"],
  ["cylinder-side", 1.0, "preview", "76f64dd6bd1ce3b0752cb347cb29e968", "3dbb5c315e4262d22f8877c0be5a04ce"],
  ["curved-crease", 0.6, "preview", "c59a7bf8c0dc9dba4443331c101dad22", "d9c6cb12c8712daa2266d3ddbcab42f4"],
  ["curved-crease", 1.0, "preview", "8bc0f777d01f4f22f713f4898d8a42b9", "1ce355c6fc9d9aa6721b864fcc3a86f0"],
  ["cage", 0.6, "preview", "7e42ac5aed6f6f2067c79a0bb257668d", "81d6cb4bb090bcb3b9212b2c77dc7cb3"],
  ["offset -2", 0.6, "preview", "8434dffc1c858b8546ae2f400ed784b3", "6f8325588de8e5ea5e8a448ced886fd9"],
  ["offset +2", 0.6, "preview", "bed5f1c485920c1e7aca21f67b5200dd", "8fd4b5536e73b6a13f8c7bbd02668fbb"],
  ["knurl", 0.6, "preview", "2e805f62a6327cff76ef60b8a6f01458", "31bdad36860b7b1eb159db6758e04ca0"],
  ["knurl", 0.3, "print", "93bfb877af8668f4135e442b6de3d722", "eb2893800160947c28c0d11ac15082a8"],
  ["knurl and box", 0.6, "preview", "82e6b582d918ddc9b5f69472ffdb73c4", "445768cb0f5f04e8720f7f6797af8cdf"],
  ["posed gap 0", 0.6, "preview", "eba4d56db41ec240d72bdadd20ac89f5", "8ffb7325e65bf8c8cd1b454aa1896980"],
  ["posed gap 0.05", 0.6, "preview", "4ffb835260f9b2e5808dacab4b56932b", "8ec2848ffbf20939a00f5ebb9ee10dfc"],
  ["posed gap 0", 1.0, "preview", "66ee21bb7fbe694548d16ecfd2c0740f", "b9e91bec7e57e42f743bbbd105bf580f"],
  ["posed gap 0.05", 1.0, "preview", "26cf193d5fee4fbf38b4e6a9c6d00cf0", "8a3739553f08dbefaf75b5a637724bb4"],
  ["hand", 1.5, "preview", "9ac58e9262f80c64c982073ce1aeb453", "62fa4b6c0a0d812fd8ca4082816b6347"],
  ["hand", 0.8, "print", "052e4a229aad837e10c5ef1bd1bc3c74", "96e09904f409a87df8080ba306d7ba05"],
  ["vase", 1.2, "preview", "cdf0b1703b974b78eb62554da361afab", "d9442b12bedc9337b72c3a78ae46b30f"],
  ["spheres", 0.6, "preview", "4e446bca7b4db97129ab2a3e90988002", "455aa2263e14df8bed56353678b35f57"],
  ["spheres", 1.0, "preview", "ca0035bb5664646364dab210a4d611d7", "9594a0e42915f767808810065dd8bb11"],
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
