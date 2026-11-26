// test/implicit-sharpen-digest.test.js
// The sharpen stage's output, pinned byte for byte. Each case runs the stages before sharpen,
// then sharpenMesh in JS and ip_sharpen on the core, from one plan. The JS output's positions,
// indices and normals (`mesh`) and its other tables and stats (`tables`) must match the digests
// recorded here, and the core's positions, indices and normals must match the JS's. The digests
// were recorded before the stage's bookkeeping was made local (0.207): a speed-up must keep them.
// Do not re-record a digest to make a speed-up pass.
import { createHash } from "node:crypto";
import { describe, test, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { compileImplicit } from "../src/framework/geometry/implicit/compile.js";
import { planLeaves, evaluateLeaves } from "../src/framework/geometry/implicit/sparse.js";
import { meshStore } from "../src/framework/geometry/implicit/mesher.js";
import { meshStoreOwners } from "../src/framework/geometry/implicit/mesher-owners.js";
import { cleanupMesh, CLEANUP, PREVIEW_CLEANUP } from "../src/framework/geometry/implicit/cleanup.js";
import { cutCreases } from "../src/framework/geometry/implicit/crease.js";
import { sharpenMesh } from "../src/framework/geometry/implicit/sharpen.js";
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

// [case, grid, tier, mesh digest, tables digest]. Recorded before any speed-up (commit ad1d180b).
const CASES = [
  ["box", 0.6, "preview", "6fd979839473a476307cf0cd714c06d2", "5a536d67585bab2ec47c7f5ae36c6cbc"],
  ["box", 1.0, "preview", "cdebb18d97c33d63561bc64fe2e6a8da", "4cc31022c08cd3c8e36527b6be86f92a"],
  ["plate-edge", 0.6, "preview", "08bcb55e5e1db948b1d4d21d8dad2964", "0464c0c20049b5432dc7ee5d307fe37a"],
  ["plate-edge", 1.0, "preview", "5722cc5c22dd0f07e1a62b4e1e70317f", "590255a1c77535b89b039fbd5fafbb34"],
  ["bracket-corner", 0.6, "preview", "f89765dbd14f330a4561aaf045e55ce0", "2e0782e06a83d83f557b3be3d4b4a5bb"],
  ["bracket-corner", 1.0, "preview", "ec77c3496e1de3b4dd9d5fa49c572f84", "4a0f6d6c6aaa87b41ff7db7ba92ada83"],
  ["cylinder-side", 0.6, "preview", "53983dd98c332e76ce90e28e43724a55", "62216c13921edf86835533f1f27ef393"],
  ["cylinder-side", 1.0, "preview", "cbcc4ff51c9db8c910bb29d04e0f2d05", "b4e6592e9e08688ed17fd126733adf25"],
  ["curved-crease", 0.6, "preview", "c59a7bf8c0dc9dba4443331c101dad22", "d9c6cb12c8712daa2266d3ddbcab42f4"],
  ["curved-crease", 1.0, "preview", "196ba1e7f7f0ffc140b1a7c5269c812d", "b8faa9bf6b87212f8a447cc3e92fdace"],
  ["cage", 0.6, "preview", "db9a48347390c631016b69a06ced14a4", "6e79d10e035a3520ef178161cb8d4b3a"],
  ["offset -2", 0.6, "preview", "7b2ba336b2ba37a8be9a16fcb9f6e41c", "3d566f805ca1986303ba40b7d1c366ba"],
  ["offset +2", 0.6, "preview", "191224c0a339e1c05d6f2be48e685475", "ba7ff9c0113049d0ad21d3dcfeffcfc6"],
  ["knurl", 0.6, "preview", "a522bba433acf50218c797ca908dcb82", "f0048ce94fa2854b60235211ad046d50"],
  ["knurl", 0.3, "print", "2c0f87063bace24606c252c750b84c3b", "24061a14c5ea3a5fa684067e2a9c81ce"],
  ["knurl and box", 0.6, "preview", "58546dfa04c9ea742a21afcb1c08dacf", "af6c0f5e0b5a889c66c90fb3e6a59bcd"],
  ["posed gap 0", 0.6, "preview", "f756b66491d2bf88463121c546bd44fd", "58827cad23648486de264b79e00965ea"],
  ["posed gap 0.05", 0.6, "preview", "bf6196bd59d58cdc6454cf738722ce0d", "b67e61bf99f431c1c330bcf3b0f48b18"],
  ["posed gap 0", 1.0, "preview", "f2adba4ec0d3f24e911106ad61a1e222", "3e8ff9685f79b6eee41169bb2aa16607"],
  ["posed gap 0.05", 1.0, "preview", "48cd117622fa00d3357770f25d358a49", "aa98c12b614dcea6d70cd6bbf8f7ac77"],
  ["hand", 1.5, "preview", "34e17d8d70dd6875be376e115fc7d854", "00ce19b2f82ccccbf6ba43a6bd8fb47f"],
  ["hand", 0.8, "print", "b1ba5a783c93a1735eefa8dd7ec0a45a", "2fc9cbd647d03fd9f795fcc06b99615b"],
  ["vase", 1.2, "preview", "c6e719e1b30ef7a197817d62bae79d2e", "d19efb4bd6839a5322fa79f892d4f6e5"],
  ["spheres", 0.6, "preview", "b10fdae08e3f3ab847c9dabb9000f64b", "19873b4965f904aa1e6b09544c9ffb31"],
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
