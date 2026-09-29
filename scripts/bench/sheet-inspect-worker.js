// The inspect-time bench's worker (scripts/time-sheet-inspect.mjs): an ordinary
// partforge geometry worker over the two sheet-part stress fixtures, plus one message
// of its own — { type: "bench-part", name } — which rebinds it to a fixture the way a
// host's setPart does (it answers "ready").
import { runWorker } from "../../src/framework/worker.js";
import laserBox from "../../src/parts/laser-box.js";
import twelvePanel from "../../test/fixtures/sheet-twelve-panel-part.js";

const PARTS = { "laser-box": laserBox, "twelve-panel": twelvePanel };
const bench = runWorker(laserBox);
const handleJob = self.onmessage;
self.onmessage = (e) => {
  if (e.data?.type === "bench-part") bench.setPart(PARTS[e.data.name]);
  else handleJob(e);
};
