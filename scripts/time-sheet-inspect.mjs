// Times the inspect job — the report a partforge-cloud apply waits on, under ONE 8 s
// budget there — for the sheet-part stress cases: src/parts/laser-box.js,
// test/fixtures/sheet-twelve-panel-part.js, a 16-hole screw plate and a 900-hole
// perforated grille (test/fixtures/sheet-*-part.js; sheet parts spec C.6). Quick and full
// laps; the first run (cold) and the median of the rest (warm); and, in Node, what
// the 2-D sheet checks cost alone with no budget, against their own 1500 ms one.
// Prints a markdown block for docs/research/sheet-inspect-timing.md.
//
//   node scripts/time-sheet-inspect.mjs [--runs 5]             Node: V8 + the Manifold WASM
//   node scripts/time-sheet-inspect.mjs --browser [--runs 5]   headless Chromium, a real module worker
//
// --browser serves scripts/bench/sheet-inspect.html from a Vite dev server on
// SHEET_BENCH_PORT (default 5195) and reads what the page measured; it needs
// Playwright's Chromium, as scripts/check-app.mjs does. An iPhone runs the same page
// by hand — see the page's header comment.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const runsAt = argv.indexOf("--runs");
const RUNS = runsAt >= 0 ? Number(argv[runsAt + 1]) : 5;
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error("--runs must be a whole number of at least 1");
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function nodeRows() {
  const [{ bootManifoldKernel, handle }, { resolveParams }, { isSheetPart }, { resolveSheet }, { processFor },
    { default: laserBox }, { default: twelvePanel }, { default: screwPlate }, { default: perforated }] = await Promise.all([
    import("../src/testing.js"),
    import("../src/framework/part-model.js"),
    import("../src/framework/sheet/constants.js"),
    import("../src/framework/sheet/resolve.js"),
    import("../src/framework/process/registry.js"),
    import("../src/parts/laser-box.js"),
    import("../test/fixtures/sheet-twelve-panel-part.js"),
    import("../test/fixtures/sheet-screw-plate-part.js"),
    import("../test/fixtures/sheet-perforated-panel-part.js"),
  ]);
  const kernel = await bootManifoldKernel();
  // One inspect through the worker's own job function, exactly as the geometry worker runs it.
  const inspect = async (part, quick) => {
    let report = null;
    const t0 = performance.now();
    await handle(kernel, part, { type: "inspect", ...(quick ? { checks: "quick" } : {}) }, (m) => { if (m.type === "report") report = m; });
    if (!report) throw new Error("the inspect job posted no report");
    return { report, ms: performance.now() - t0 };
  };
  // Every sheet's 2-D facts with no deadline: what the checks cost uncapped.
  const sheetChecksMs = (part) => {
    const { p, d } = resolveParams(part, {});
    const t0 = performance.now();
    for (const sp of Object.values(part.parts)) if (isSheetPart(sp)) processFor(sp).facts(resolveSheet(kernel, sp, p, d));
    return Math.round(performance.now() - t0);
  };
  const rows = [];
  for (const [part, def] of [["laser-box", laserBox], ["twelve-panel", twelvePanel], ["screw-plate", screwPlate], ["perforated", perforated]]) {
    const uncapped = sheetChecksMs(def);
    for (const lap of ["quick", "full"]) {
      const times = [];
      let report;
      for (let i = 0; i <= RUNS; i++) ({ ms: times[i], report } = await inspect(def, lap === "quick"));
      const sheets = report.measure.subparts.filter((s) => s.sheet);
      rows.push({ part, lap, coldMs: Math.round(times[0]), warmMs: Math.round(median(times.slice(1))),
        sheetChecksMs: uncapped, sheetsEvaluated: `${sheets.filter((s) => s.sheet.evaluated).length}/${sheets.length}` });
    }
  }
  return { where: `Node ${process.version} (${process.platform} ${process.arch})`, rows };
}

async function browserRows() {
  const { chromium } = await import("playwright");
  const PORT = Number(process.env.SHEET_BENCH_PORT) || 5195;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
  const url = `http://localhost:${PORT}/scripts/bench/sheet-inspect.html?runs=${RUNS}`;
  const vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], { cwd: root, detached: true, stdio: "ignore" });
  let browser;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* not listening yet */ }
      if (i >= 120) throw new Error(`vite did not answer on port ${PORT}`);
      await sleep(250);
    }
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
    await page.goto(url);
    const result = await (await page.waitForFunction(() => window.__sheetBench, null, { timeout: 900_000 })).jsonValue();
    if (result.error) throw new Error(`bench page: ${result.error}`);
    return { where: `Chromium ${browser.version()} (headless, module worker)`, rows: result.rows };
  } finally {
    await browser?.close();
    try { process.kill(-vite.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

const { where, rows } = argv.includes("--browser") ? await browserRows() : await nodeRows();
console.log(`### ${where} — ${new Date().toISOString().slice(0, 10)}, ${RUNS} warm runs`);
console.log("| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.part} | ${r.lap} | ${r.coldMs} | ${r.warmMs} | ${r.sheetChecksMs ?? "n/a"} | ${r.sheetsEvaluated} |`);
