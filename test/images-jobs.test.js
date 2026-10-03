import { test, expect } from "vitest";
import { PNG } from "pngjs";
import { resolveParams } from "../src/framework/part-model.js";
import { h } from "../src/framework/geometry/solid-hash.js";
import { handle } from "../src/framework/jobs.js";
import { imagesFor } from "../src/framework/images.js";
import { relevanceHash } from "../src/framework/param-deps.js";
import { createMeshCache } from "../src/framework/mesh-cache.js";
import { createBackendPolicy } from "../src/framework/backend-select.js";

// Returns an ArrayBuffer holding exactly the encoded PNG bytes.
//
// The brief's version of this helper did `PNG.sync.write(p).buffer.slice(0)`.
// That is broken the same way test/images-resolve.test.js's own comment
// already documents: Node's Buffer pool means a small Buffer's `.buffer` is a
// much larger shared ArrayBuffer and the Buffer's data starts at a nonzero
// `byteOffset`, so `.slice(0)` copies from the POOL's start, not the PNG's —
// wrong length, and depending on allocation order maybe not even starting
// with the PNG signature. Slicing by the Buffer's own byteOffset/byteLength
// (as asset-resolve.js's toBuffer() and images-resolve.test.js's png() both
// do) is the fix.
const png = (v = 180) => {
  const p = new PNG({ width: 2, height: 2 });
  p.data.fill(v); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  const buf = PNG.sync.write(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

// Spec §7 invariant 1.
test("resolveParams passes an ArrayBuffer through untouched", () => {
  const buf = png();
  const part = { defaults: { relief: "", n: 1 }, parameters: [] };
  const out = resolveParams(part, { relief: buf, n: 2 });
  expect(out.p.relief).toBe(buf); // identity, not a copy
});

// The `sanitize` hook (jobs.js's font/image allow-check) rewrites `params` IN
// PLACE but must never touch a key it has no opinion about — an untouched
// buffer must survive it by the same identity.
test("resolveParams' sanitize hook cannot mangle a buffer it doesn't reject", () => {
  const buf = png();
  const part = { defaults: { relief: "" }, parameters: [] };
  const out = resolveParams(part, { relief: buf }, (p) => { p.unrelated = 1; });
  expect(out.p.relief).toBe(buf);
  expect(out.p.unrelated).toBe(1);
});

// ── Fix round 1: the REAL invariant-2 site is JSON.stringify, not h() ─────
// h() is never actually called with raw image bytes anywhere in the codebase
// (both backends' `heightfield` ops key on `grid.digest`, a hex string — see
// manifold-backend.js/occt-backend.js), so a test aimed at h() documented a
// hypothetical, not the live bug. The wholesale params hash the codebase
// actually uses is JSON.stringify — param-deps.js's relevanceHash (Layer-1
// mesh-cache validity, and oracle/verify's memo signature), and
// backend-select.js's JSON reroute-latch snapshot. These tests are retargeted
// at the real call sites: two different image buffers, identical everything
// else, must produce two different hashes.
test("relevanceHash gives two different image buffers two different hashes", () => {
  const a = relevanceHash(["relief", "n"], { relief: png(10), n: 1 });
  const b = relevanceHash(["relief", "n"], { relief: png(240), n: 1 }); // a completely different image
  expect(a).not.toBe(b);
});

// The Layer-1 mesh cache (mesh-cache.js) is the actual consumer relevanceHash
// exists for: isCurrent() must go stale the moment the ONLY thing that
// changed is which image is registered under a param, or a swapped relief
// would keep showing the OLD relief indefinitely (viewer.hasSubMesh stays
// true, and the old bug's hash — JSON.stringify(ArrayBuffer) === "{}" for
// every image — never changes).
test("mesh-cache isCurrent() reports stale when only an image buffer changes", () => {
  // An every-param stamp (no recorded reads), so the image key is in its hash.
  const params = { relief: png(1), n: 5 }; // mesh-cache.js: "params is a stable object mutated in place"
  const viewer = { hasSubMesh: () => true };
  const cache = createMeshCache(viewer, {
    params, getView: () => "v", getParamsVersion: () => 1, isCaching: () => true,
  });
  cache.record("slab");
  expect(cache.isCurrent("slab")).toBe(true);
  params.relief = png(240); // swap the image; n and every other param untouched
  expect(cache.isCurrent("slab"), "a swapped image must invalidate the cached mesh").toBe(false);
});

// backend-select.js's reroute latch has the same shape of bug: `noteNeedsOcct`
// snapshots the params that proved OCCT was needed with JSON.stringify, and
// `latched()` compares a later params object against that snapshot. Under the
// old bug two different images both stringify to the same "{}", so a build
// that never actually needed OCCT for ITS image would incorrectly inherit the
// latch from a completely different image that did.
test("the OCCT reroute latch does not treat two different images as the same params", () => {
  const part = { defaults: { relief: png(1) }, parts: { p: { build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }) } } };
  const policy = createBackendPolicy(part);
  const paramsA = { relief: png(1) };
  policy.noteNeedsOcct(paramsA, ["p"]);
  expect(policy.backendsFor(paramsA).p).toBe("occt"); // the exact params that proved it stay latched
  const paramsB = { relief: png(240) }; // a different image — nothing else differs in shape
  expect(policy.backendsFor(paramsB).p).toBe("manifold"); // must NOT inherit paramsA's latch
});

// ── Fix round 2 ──────────────────────────────────────────────────────────
// A Node Buffer reaches byteAwareReplacer through a DIFFERENT door: Buffer
// has its own `toJSON()` (inherited from its Uint8Array/TypedArray lineage —
// Node adds `{type:"Buffer",data:[...]}`), and per the JSON spec that runs
// BEFORE any replacer function ever sees the value. A replacer that checks
// its `value` argument (as fix round 1's did) never sees the raw Buffer at
// all — only the already-expanded `{type:"Buffer",data:[...]}` object, which
// is not `instanceof ArrayBuffer` and fails `ArrayBuffer.isView` (a plain
// object, not a typed array), so it silently falls through to ordinary
// JSON.stringify handling: one JSON number per byte, unmemoized, on every
// hash — the exact pathology fix round 1 existed to eliminate, reached
// through Buffer's toJSON instead of ArrayBuffer's absent one.
// image-source.js's `isBytes` explicitly admits `ArrayBuffer.isView`, so a
// Buffer is a supported image-source shape — and `fs.readFileSync` (the
// natural way to produce one in Node, which the CLI does) returns exactly
// one.
test("relevanceHash fingerprints a Node Buffer instead of expanding it byte-by-byte", () => {
  const buf = Buffer.from(png(1)); // Buffer.from(ArrayBuffer) — the CLI's actual shape
  const a = relevanceHash(["img"], { img: buf });
  expect(a).not.toContain('"type":"Buffer"');  // never JSON.stringify's default Buffer expansion
  expect(a).not.toContain('"data":[');
  expect(a.length).toBeLessThan(64);           // a short fingerprint, not one number per byte

  const b = relevanceHash(["img"], { img: Buffer.from(png(240)) }); // a different image
  expect(a).not.toBe(b);
});

// Object.prototype.toString.call(...), not `instanceof`/`ArrayBuffer.isView`
// alone, closes the cross-realm gap: an ArrayBuffer or SharedArrayBuffer
// constructed in a different realm (vm context, worker, iframe) fails
// `instanceof ArrayBuffer` and would otherwise silently fall back to the
// original "{}" bug. Exercised here with a real SharedArrayBuffer (same
// realm, but neither `instanceof ArrayBuffer` nor a typed-array view, so it
// pins the same code path a cross-realm ArrayBuffer would take).
test("relevanceHash fingerprints a SharedArrayBuffer, not just ArrayBuffer/typed-array views", () => {
  const a = relevanceHash(["img"], { img: new SharedArrayBuffer(8) });
  const bytes = new SharedArrayBuffer(8);
  new Uint8Array(bytes).set([1, 2, 3, 4, 5, 6, 7, 8]);
  const b = relevanceHash(["img"], { img: bytes });
  expect(a).not.toContain("{}"); // must not silently collapse to the original bug
  expect(a).not.toBe(b);
});

// Spec §7 invariant 2, still true of h() specifically: it is short and never
// grows unbounded for the args heightfield actually passes it (a digest
// string, never raw bytes).
test("h() does not expand a heightfield call into a giant key", () => {
  const key = h("heightfield", "abc123", 60, 60, 1.5, 3, 0.5, false, [0, 1], "center");
  expect(key.length).toBeLessThan(32);
  expect(typeof key).toBe("string");
});

const job = { type: "generate", subparts: [], view: "iso", params: {} };

// A fake kernel exposing exactly the images side-channel jobs.js consumes
// (`_registerImage`/`_imageDigest`/`_pruneImages`), mirroring how
// test/fonts-dynamic.test.js fakes `kernel._fonts` directly rather than
// booting a real WASM backend.
function fakeImageKernel() {
  const images = new Map();
  return {
    images, // exposed for assertions only; jobs.js never reads this property
    cleanup() {},
    _registerImage: ({ name, digest, width, height, data }) => { images.set(name, { digest, width, height, data }); },
    _imageDigest: (name) => images.get(name)?.digest,
    _pruneImages: (keep) => { for (const n of [...images.keys()]) if (!keep.has(n)) images.delete(n); },
  };
}

test("imagesFor calls the function form with resolved params", () => {
  const part = { defaults: { relief: "A" }, images: (p) => ({ relief: p.relief }) };
  expect(imagesFor(part, { relief: "B" })).toEqual({ relief: "B" });
});

test("a declared image is resolved and registered on the kernel", async () => {
  const kernel = fakeImageKernel();
  const bytes = png(10);
  const part = { defaults: {}, images: { relief: bytes }, parts: {} };
  await handle(kernel, part, job, () => {});
  const entry = kernel.images.get("relief");
  expect(entry.width).toBe(2);
  expect(entry.digest).toMatch(/^[0-9a-f]{64}$/);
});

test("no image source declared for a name is skipped, not an error", async () => {
  const kernel = fakeImageKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image" }] }],
    defaults: { relief: "" },
    images: (p) => ({ relief: p.relief }),
    parts: {},
  };
  const posts = [];
  await handle(kernel, part, { ...job, params: { relief: "" } }, (m) => posts.push(m));
  expect(kernel.images.has("relief")).toBe(false);
  expect(posts.find((m) => m.type === "error")).toBeUndefined();
  const skip = posts.find((m) => m.type === "progress" && /no image source declared/.test(m.phase));
  expect(skip).toBeTruthy();
});

// ── the allow-check must run as resolveParams' sanitize hook, not after ────
// (the controller's second, substantive brief correction). Proven the same
// way font-source's placement fix is proven: derive() must observe the
// REPLACEMENT value, not the refused one.
test("derive() sees the default replacement, not a disallowed image source", async () => {
  const kernel = fakeImageKernel();
  const seen = [];
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image", allow: ["gstatic"] }] }],
    defaults: { relief: "" },
    derive: (p) => { seen.push(p.relief); return {}; },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: {},
  };
  await handle(kernel, part, { ...job, params: { relief: "https://evil.test/x.png" } }, () => {});
  expect(seen).toEqual([""]); // the part's own default, not the refused URL
});

test("a disallowed image param source is refused, warns, and never registers", async () => {
  const kernel = fakeImageKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image", allow: ["gstatic"] }] }],
    defaults: { relief: "" },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: {},
  };
  const posts = [];
  await handle(kernel, part, { ...job, params: { relief: "https://evil.test/x.png" } }, (m) => posts.push(m));
  expect(kernel.images.has("relief")).toBe(false);
  const meshes = posts.find((m) => m.type === "meshes");
  expect(meshes.warnings).toEqual([{ part: null, message: expect.stringContaining('image source for "relief" is not allowed') }]);
});

// image-source.js's header: an ArrayBuffer in params cannot have arrived via a
// share link (a URL can't carry megabytes), so it always bypasses `allow` —
// even a maximally restrictive list. Do NOT special-case it in jobs.js; the
// existing imageSourceAllowed(bytes) === true check must be enough.
test("a byte-valued param source always bypasses the allow check", async () => {
  const kernel = fakeImageKernel();
  const bytes = png(50);
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image", allow: ["gstatic"] }] }],
    defaults: { relief: "" },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: {},
  };
  const posts = [];
  await handle(kernel, part, { ...job, params: { relief: bytes } }, (m) => posts.push(m));
  expect(kernel.images.has("relief")).toBe(true);
  expect(posts.find((m) => m.type === "meshes").warnings).toBeUndefined();
});

// ── stale-registration pruning: the images-map twin of the fonts prune ─────
test("clearing a picked image drops the name instead of leaving the old grid registered", async () => {
  const kernel = fakeImageKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image" }] }],
    defaults: { relief: "" },
    images: (p) => ({ relief: p.relief }),
    parts: {},
  };
  await handle(kernel, part, { ...job, params: { relief: png(10) } }, () => {});
  expect(kernel.images.has("relief")).toBe(true);
  await handle(kernel, part, { ...job, params: { relief: "" } }, () => {}); // cleared
  expect(kernel.images.has("relief"), "a cleared pick must not stay registered").toBe(false);
});

test("a part with no `images` field leaves a host-seeded kernel image map alone", async () => {
  const kernel = fakeImageKernel();
  kernel._registerImage({ name: "heading", digest: "seeded", width: 1, height: 1, data: new Uint16Array(1) });
  await handle(kernel, { parts: {}, defaults: {} }, job, () => {});
  expect(kernel.images.get("heading").digest).toBe("seeded");
});

test("a renamed image declaration prunes only the name it dropped", async () => {
  const kernel = fakeImageKernel();
  const part1 = { defaults: {}, images: { one: png(1), two: png(2) }, parts: {} };
  await handle(kernel, part1, job, () => {});
  expect([...kernel.images.keys()].sort()).toEqual(["one", "two"]);
  const part2 = { defaults: {}, images: { two: png(2) }, parts: {} };
  await handle(kernel, part2, job, () => {});
  expect([...kernel.images.keys()]).toEqual(["two"]);
});
