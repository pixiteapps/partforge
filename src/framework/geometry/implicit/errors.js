// The implicit engine's two error kinds. `code` is the stable handle hosts and
// lint match on; the message always starts with "implicit: ".
export class ImplicitSpecError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(`implicit: ${list.join("; ")}`);
    this.name = "ImplicitSpecError";
    this.code = "IMPLICIT_SPEC";
    this.issues = list;
  }
}

export class ImplicitSizeError extends Error {
  constructor(message) {
    super(`implicit: ${message}`);
    this.name = "ImplicitSizeError";
    this.code = "IMPLICIT_SIZE";
  }
}
