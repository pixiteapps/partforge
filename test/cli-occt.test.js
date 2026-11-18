import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

// Render into a per-file output dir, not the shared default `render/`. Two CLI test
// files both rendering to (and rmSync-ing) `render/` race under vitest's parallel
// file execution — one file's afterAll deletes it mid-render in the other.
const OUT = "test/.cli-occt-render";

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

test("render runs the filleted part (Manifold-resident now) and writes a PNG", () => {
  const out = run(["render", "src/parts/filleted-box.js", "box", "--views", "iso", "--out", OUT]);
  expect(out).toMatch(/wrote test\/\.cli-occt-render\/filleted-box-box-iso\.png/);
  expect(existsSync(`${OUT}/filleted-box-box-iso.png`)).toBe(true);
});

test("measure preloads a part's declared fonts on the OCCT branch too", () => {
  // Same regression as the manifold-side test in cli.test.js: bootKernel must
  // pass part.fonts to whichever kernel it boots.
  const out = run(["measure", "test/fixtures/font-part-occt.js"]);
  expect(out).toMatch(/FontRig \/ v/);
});

test("measure runs the filleted part on Manifold with real topology", () => {
  const out = run(["measure", "src/parts/filleted-box.js"]);
  expect(out).toMatch(/Filleted Box \/ box/);
  expect(out).toMatch(/watertight ✓/);
  expect(existsSync("measure-filleted-box-box.json")).toBe(false); // only --out writes a file
});

test("PARTFORGE_BACKEND=occt forces the OCCT kernel (n/a topology)", () => {
  const out = execFileSync("node", ["bin/cli.js", "measure", "src/parts/filleted-box.js"],
    { encoding: "utf8", env: { ...process.env, PARTFORGE_BACKEND: "occt" } });
  expect(out).toMatch(/watertight n\/a/);
});

test("measure names the fillet when a part needs k.implicit and an OCCT-only fillet", () => {
  // The Manifold build stops at the fillet, the OCCT retry at k.implicit: the message must
  // name the fillet rather than send the author to meta.backend.
  let err;
  try { execFileSync("node", ["bin/cli.js", "measure", "test/fixtures/implicit-occt-fillet-part.js", "--no-lint"], { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { err = e; }
  expect(err?.status).toBe(1);
  expect(err.stderr).toMatch(/the Manifold build stopped at "fillet: function selectors need the OCCT backend"/);
  expect(err.stderr).toMatch(/pattern: ERROR-PATTERNS\.md#implicit-with-occt-fallback/);
});
