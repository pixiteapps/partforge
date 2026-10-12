// The cnc-router exporter: one resolved routed piece → one Drawing. Loaded only through
// process/exporters.js's dynamic import.
function drawing() {
  throw new Error("cnc-router exporter: not implemented yet");
}
export default { drawing };
