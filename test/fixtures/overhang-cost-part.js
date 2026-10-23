// The accepted-overhang tee without `accept`: the overhang is an open cost, so the CLI
// prints its location and hint.
import accepted from "./accepted-overhang-part.js";

export default { ...accepted, meta: { title: "Tee", units: "mm" }, verify: { process: "fdm-pla" } };
