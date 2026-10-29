// A manifest that reaches a registry consumer: the layering test's rule 6 must call it a
// cycle. Never registered.
import { PROCESS_IDS } from "../../../src/framework/process/registry.js";

export default { id: "cyclic", processes: PROCESS_IDS };
