// The verify golden (sheet parts, P1b). Sheet parts change how verify judges a view
// that HOLDS one — the bed per printed part, the laser checks volunteered — and must
// change nothing for a view that holds none. This pins that: verify() over every view
// of every reference part, recorded from the code BEFORE sheet scoping landed, must
// come back deep-equal. It runs the real CLI once per view, so every part boots with
// its own fonts, images, imports and backend exactly as `partforge measure` does —
// mixed-smoke routes to OCCT, which cannot share a process with Manifold.
//
// The report is read from `--out`, never stdout: the CLI ends with process.exit(),
// which cuts a piped stdout off at 64 KB.
//
// Re-record ONLY for a deliberate verdict change (or a new reference part), and say
// so in the PR:
//   PARTFORGE_RECORD_VERIFY_GOLDEN=1 npx vitest run test/verify-golden.test.js
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/verify-golden.json", import.meta.url));
const RECORD = process.env.PARTFORGE_RECORD_VERIFY_GOLDEN === "1";
// laser-box.js is the sheet-part reference: it never had a pre-sheet verdict.
const EXCLUDED = new Set(["laser-box.js"]);
const TMP = mkdtempSync(join(tmpdir(), "pf-verify-golden-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// Floats rounded to 9 significant digits: the golden guards verdicts and readings, not
// the last ulp a future V8 or Manifold build might move. -0 folds to 0.
const canon = (v) => (typeof v === "number" ? (Object.is(v, -0) ? 0 : Number(v.toPrecision(9)))
  : Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([key, x]) => [key, canon(x)]))
  : v);

// Every "<file>#<view>" pair: files sorted, views in declaration order.
async function currentKeys() {
  const files = readdirSync(join(ROOT, "src/parts")).filter((f) => f.endsWith(".js") && !EXCLUDED.has(f)).sort();
  const keys = [];
  for (const file of files) {
    const part = (await import(`../src/parts/${file}`)).default;
    for (const view of Object.keys(part.views)) keys.push(`${file}#${view}`);
  }
  return keys;
}

async function verifyOf(key) {
  const [file, view] = key.split("#");
  const out = join(TMP, `${file}-${view}.json`);
  // Exit 1 is a failing gate — still a complete report, and part of the golden.
  await run(process.execPath, ["bin/cli.js", "measure", `src/parts/${file}`, view, "--no-lint", "--out", out],
    { cwd: ROOT, maxBuffer: 1 << 26 }).catch((e) => { if (e.code !== 1) throw e; });
  return canon(JSON.parse(readFileSync(out, "utf8")).verify);
}

// Four CLI processes at a time; results keyed back in `keys` order.
async function collect(keys) {
  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++];
      results.set(key, await verifyOf(key));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return Object.fromEntries(keys.map((key) => [key, results.get(key)]));
}

test("verify() over every reference part matches the pre-sheet golden", async () => {
  if (RECORD) {
    writeFileSync(FIXTURE, `${JSON.stringify(await collect(await currentKeys()), null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const keys = Object.keys(golden);
  expect(keys.length).toBeGreaterThan(0);
  const now = await collect(keys);
  for (const key of keys) expect(now[key], key).toEqual(golden[key]);
}, 300_000);

test("the golden covers every view of every reference part except laser-box.js", async () => {
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8"));
  expect(Object.keys(golden), "a new reference part needs its golden — see this file's header to re-record")
    .toEqual(await currentKeys());
});
