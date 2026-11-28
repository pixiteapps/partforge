// @vitest-environment happy-dom
// Encoder version 7: a k.subdiv body's ties ride in the preview file (encode-preview.js,
// "a mesh with `ties`"), in the file's own vertex order, so a kernel-free preview can
// re-pose the body from its cage (docs/superpowers/specs/2026-11-22-cage-pose-drag-design.md,
// "Part 4"). The file stores the cage's topology key and level, not its points: the reader
// runs the part's cage code at the file's params (version 6's partforgeParams). A mesh with
// no ties writes the bytes version 6 wrote, the version digit apart.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { encodePreviewGlb, PREVIEW_ENCODER_VERSION } from "../src/framework/gltf/encode-preview.js";
import { decodePreviewGlb } from "../src/framework/gltf/decode-preview.js";
import { bootManifoldKernel, handle } from "../src/testing.js";
import { probePoses } from "../src/framework/pose-probe.js";
import { subdivPlan, applySubdivPlan, topologyKey } from "../src/framework/geometry/subdiv/surface.js";
import { placeFromTies } from "../src/framework/geometry/subdiv/ties.js";
import { composePose, mulMat4 } from "../src/framework/geometry/pose.js";
import hand from "../src/parts/cage-hand.js";
import { inputs } from "./helpers/preview-v6-inputs.js";
import { anim } from "./helpers/preview-animation-fixture.js";

// node:url's URL: happy-dom replaces the global one.
const fixture = (name) => new Uint8Array(readFileSync(fileURLToPath(new NodeURL(`./fixtures/${name}`, import.meta.url))));
// The GLB's JSON chunk, parsed.
const jsonOf = (glb) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));

test("PREVIEW_ENCODER_VERSION is 7 or later (a cage body's ties ride in the file)", () => {
  expect(PREVIEW_ENCODER_VERSION).toBeGreaterThanOrEqual(7);
});

describe("a file with no ties", () => {
  for (const [kind, name] of [["still", "preview-v6.glb"], ["animated", "preview-v6-animated.glb"]]) {
    test(`${kind}: the same input writes version 6's bytes, the version digit apart`, async () => {
      const v6 = fixture(name);
      const v7 = await encodePreviewGlb(inputs[kind]());
      expect(jsonOf(v6).extras.partforgeEncoder).toBe(6);
      expect(jsonOf(v7).extras.partforgeEncoder).toBe(PREVIEW_ENCODER_VERSION);
      const text = new TextDecoder("latin1");
      const at = text.decode(v6).indexOf('"partforgeEncoder":6');
      expect(at).toBeGreaterThan(0);
      const expected = v6.slice();
      expected[at + '"partforgeEncoder":'.length] = String(PREVIEW_ENCODER_VERSION).charCodeAt(0);
      expect(v7.byteLength).toBe(v6.byteLength);
      expect(Buffer.compare(Buffer.from(v7), Buffer.from(expected))).toBe(0);
    });

    test(`${kind}: the version 6 fixture decodes exactly as the version 7 file does, with no ties`, async () => {
      const old = await decodePreviewGlb(fixture(name));
      const now = await decodePreviewGlb(await encodePreviewGlb(inputs[kind]()));
      expect(old).toEqual(now);
      for (const m of old.meshes) expect(m).not.toHaveProperty("ties");
      expect(old.params).toEqual(inputs[kind]().params);
      if (kind === "animated") expect(old.animation.animated).toEqual(["lid"]);
    });
  }
});

describe("the cage hand", () => {
  let mesh, glb, plainGlb, decoded, snapshot;
  beforeAll(async () => {
    const k = await bootManifoldKernel({ quality: "preview" });
    const post = vi.fn();
    await handle(k, hand, { type: "generate", subparts: ["hand"], view: "assembly", params: hand.defaults }, post);
    [mesh] = post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes").meshes;
    const { ties, ...plain } = mesh;
    glb = await encodePreviewGlb({ meshes: [mesh], part: hand, view: "assembly", params: hand.defaults });
    plainGlb = await encodePreviewGlb({ meshes: [plain], part: hand, view: "assembly", params: hand.defaults });
    decoded = await decodePreviewGlb(glb);
    // The reader's route: the part's cage code at the file's params.
    snapshot = probePoses(hand, decoded.view, { ...hand.defaults, ...decoded.params }, { scope: "build" }).get("hand").cages[0];
  }, 120_000);

  // One quantization step of the decoded positions (14 bits over the widest extent).
  const stepOf = (positions) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], positions[i]);
      hi[i % 3] = Math.max(hi[i % 3], positions[i]);
    }
    return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / (2 ** 14 - 1);
  };
  // The worst per-axis gap between a decoded vertex and where its decoded tie places it on
  // the rest limit mesh of `snap`, moved by the tie's pose. Per axis because quantization is
  // per axis: half a step of rounding, plus up to about 0.19 of a step from gltf-transform's
  // bit replication (a 13-bit value stored in 16 bits as v << 2 | v >> 11). Measured on the
  // hand: 0.0087 mm on each axis, 0.0134 mm as a distance, against a 0.0127 mm step.
  const worstMiss = (payload, snap) => {
    const { ties } = payload;
    const plan = subdivPlan(snap, ties.level);
    const L = applySubdivPlan(plan, snap.points);
    const placed = placeFromTies(ties, L.positions, plan.indices);
    const m = ties.pose;
    let worst = 0;
    for (let v = 0; v < ties.tri.length; v++) {
      const [x, y, z] = [placed[3 * v], placed[3 * v + 1], placed[3 * v + 2]];
      for (let a = 0; a < 3; a++) {
        worst = Math.max(worst, Math.abs(m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a] - payload.positions[3 * v + a]));
      }
    }
    return worst;
  };

  test("the file stays under the host's cap with its ties", () => {
    expect(glb.byteLength).toBeLessThan(3_300_000); // partforge-cloud's browser-made previews
    expect(glb.byteLength).toBeGreaterThan(plainGlb.byteLength);
  });

  test("the decoded payload carries the cage's key and level, and one tie per vertex", () => {
    const [p] = decoded.meshes;
    expect(p.ties).toBeTruthy();
    expect(p.ties.key).toBe(mesh.ties.key);
    expect(p.ties.key).toBe(topologyKey(snapshot));
    expect(p.ties.level).toBe(mesh.ties.level);
    expect(p.ties.pose).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(p.ties.tri.length).toBe(p.positions.length / 3);
    expect(p.ties.w.length).toBe(2 * p.ties.tri.length);
    const nTri = subdivPlan(snapshot, p.ties.level).indices.length / 3;
    expect(p.ties.tri.every((t) => t < nTri)).toBe(true);
    for (const x of p.ties.w) expect(x >= 0 && x <= 1).toBe(true);
  });

  test("the ties put every decoded vertex back on the rest limit mesh within one quantization step on each axis", () => {
    const [p] = decoded.meshes;
    expect(worstMiss(p, snapshot)).toBeLessThan(stepOf(p.positions));
  });

  test("the ties change nothing else: the surface decodes as it does without them", async () => {
    const [without] = (await decodePreviewGlb(plainGlb)).meshes;
    const { ties, ...rest } = decoded.meshes[0];
    expect(rest).toEqual(without);
  });

  test("a posed mesh: the tie's pose maps the cage's frame onto the decoded positions", async () => {
    const pose = composePose([{ t: "rotate", deg: 30, center: [0, 0, 0], axis: [0, 0, 1] }, { t: "translate", v: [20, -5, 7] }]);
    const apply = (arr, normal) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 3) {
        const [x, y, z] = [arr[i], arr[i + 1], arr[i + 2]];
        for (let a = 0; a < 3; a++) out[i + a] = pose[a] * x + pose[4 + a] * y + pose[8 + a] * z + (normal ? 0 : pose[12 + a]);
      }
      return out;
    };
    const posed = { ...mesh, positions: apply(mesh.positions), normals: apply(mesh.normals, true), edges: apply(mesh.edges), ties: { ...mesh.ties, pose } };
    const [p] = (await decodePreviewGlb(await encodePreviewGlb({ meshes: [posed], part: hand, view: "assembly" }))).meshes;
    for (let i = 0; i < 16; i++) expect(p.ties.pose[i]).toBeCloseTo(pose[i], 12);
    expect(worstMiss(p, snapshot)).toBeLessThan(stepOf(p.positions));
  });

  test("an animated cage sub-part: the ties' pose carries the animation's rest, so they hold at the opening pose", async () => {
    const T = (z) => composePose([{ t: "translate", v: [0, 0, z] }]);
    const animation = {
      anim, base: { hand: T(0) },
      samples: [{ t: 0, poses: { hand: T(10) }, opacity: {} }, { t: 0.5, poses: { hand: T(30) }, opacity: {} }, { t: 1, poses: { hand: T(10) }, opacity: {} }],
    };
    const out = await decodePreviewGlb(await encodePreviewGlb({ meshes: [mesh], part: hand, view: "assembly", animation }));
    const [p] = out.meshes;
    expect(out.animation.animated).toEqual(["hand"]);
    expect(p.ties.pose).toEqual(mulMat4(T(10), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    expect(worstMiss(p, snapshot)).toBeLessThan(stepOf(p.positions));
  });

  test("malformed ties are refused", async () => {
    const bad = (ties) => encodePreviewGlb({ meshes: [{ ...mesh, ties: { ...mesh.ties, ...ties } }] });
    await expect(bad({ key: "" })).rejects.toThrow(/topology key/);
    await expect(bad({ level: 1.5 })).rejects.toThrow(/level/);
    await expect(bad({ tri: mesh.ties.tri.subarray(1) })).rejects.toThrow(/one Uint32 triangle per vertex/);
    await expect(bad({ w: mesh.ties.w.subarray(1) })).rejects.toThrow(/two weights per vertex/);
    await expect(bad({ pose: [1, 2, 3] })).rejects.toThrow(/16 finite numbers/);
  });
});
