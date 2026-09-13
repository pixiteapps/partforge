// Thrown by a backend that can't perform a requested op (e.g. Manifold has no
// fillet/chamfer). The framework catches `.code === "NEEDS_OCCT"` and reroutes
// the part to the OCCT backend.
export class KernelCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "KernelCapabilityError";
    this.code = "NEEDS_OCCT";
  }
}

// Thrown by the boolean result gate (boolean-gate.js) when a boolean's result is
// geometrically impossible — the kernel returned wrong geometry without reporting
// it. Not a capability gap: nothing reroutes on it. `.code` is the stable handle.
export class BooleanResultError extends Error {
  constructor(message) {
    super(message);
    this.name = "BooleanResultError";
    this.code = "BOOLEAN_RESULT_INVALID";
  }
}
