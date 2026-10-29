// The implicit engine's two error kinds. `code` is the stable handle hosts and
// lint match on; the message always starts with "implicit: ". A spec error is
// core's SpecError (geometry/errors.js) with the engine's own code and prefix.
import { SpecError } from "../errors.js";

export class ImplicitSpecError extends SpecError {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(`implicit: ${list.join("; ")}`, { issues: list });
    this.name = "ImplicitSpecError";
    this.code = "IMPLICIT_SPEC";
  }
}

export class ImplicitSizeError extends Error {
  constructor(message) {
    super(`implicit: ${message}`);
    this.name = "ImplicitSizeError";
    this.code = "IMPLICIT_SIZE";
  }
}
