// The page half of the inspect-time bench (scripts/time-sheet-inspect.mjs --browser,
// or an iPhone opening this page by hand). Boots ONE geometry worker the way an app
// does, rebinds it to each fixture, and times inspect round trips — the report
// partforge-cloud waits on after every apply — for quick and full laps: the first run
// (cold, it pays the lazy oracle load once) and the median of the rest (warm). Prints a
// markdown block into #out; the script reads window.__sheetBench.
const RUNS = Number(new URLSearchParams(location.search).get("runs") ?? "5");
const out = document.getElementById("out");
const print = (line) => { out.textContent += `${line}\n`; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const worker = new Worker(new URL("./sheet-inspect-worker.js", import.meta.url), { type: "module", name: "manifold" });
// The next message of `type` from the worker; a job error rejects instead.
const next = (type) => new Promise((resolve, reject) => {
  const on = (e) => {
    if (e.data?.type !== type && e.data?.type !== "error") return;
    worker.removeEventListener("message", on);
    if (e.data.type === "error") reject(new Error(e.data.message));
    else resolve(e.data);
  };
  worker.addEventListener("message", on);
});
async function inspect(quick) {
  const report = next("report");
  const t0 = performance.now();
  worker.postMessage({ type: "inspect", ...(quick ? { checks: "quick" } : {}) });
  return { report: await report, ms: performance.now() - t0 };
}

try {
  await next("ready");
  print(`### ${navigator.userAgent} — ${new Date().toISOString().slice(0, 10)}, ${RUNS} warm runs`);
  print("| part | lap | cold ms | warm median ms | 2-D checks ms (no budget) | sheets evaluated |");
  print("|---|---|---|---|---|---|");
  const rows = [];
  for (const part of ["laser-box", "twelve-panel", "screw-plate", "perforated"]) {
    const rebound = next("ready");
    worker.postMessage({ type: "bench-part", name: part });
    await rebound;
    for (const lap of ["quick", "full"]) {
      const times = [];
      let report;
      for (let i = 0; i <= RUNS; i++) ({ ms: times[i], report } = await inspect(lap === "quick"));
      const sheets = report.measure.subparts.filter((s) => s.sheet);
      const row = { part, lap, coldMs: Math.round(times[0]), warmMs: Math.round(median(times.slice(1))), sheetChecksMs: null,
        sheetsEvaluated: `${sheets.filter((s) => s.sheet.evaluated).length}/${sheets.length}` };
      rows.push(row);
      print(`| ${row.part} | ${row.lap} | ${row.coldMs} | ${row.warmMs} | n/a | ${row.sheetsEvaluated} |`);
    }
  }
  window.__sheetBench = { rows };
  print("done");
} catch (e) {
  window.__sheetBench = { error: String(e?.message ?? e) };
  print(`failed: ${e?.message ?? e}`);
}
