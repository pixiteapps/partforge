// Geometry-free build execution. Two consumers share one Proxy implementation:
//
//  • createProbeKernel() — records op NAMES so ../backend-select.js's
//    detectBackend() can route a part to OCCT when it uses Solid.shell.
//  • createValidatingProbe() — additionally checks op names against the kernel
//    contract's op lists and routes options-form calls through the same op-options
//    normalizers the real backends use, so partforge/lint can catch a bad call in
//    microseconds instead of after a WASM boot.
//
// Catch-all proxies (rather than a hand-listed allowlist) mean new kernel/solid
// methods never have to be mirrored here — the probe can't drift out of sync with
// the real backends. (That drift previously broke the panel's relevance dimming
// when the build-step vocabulary was added but not taught to the probe.) The
// validating probe DOES need an allowlist, so it takes one from kernel.js's op
// lists, which test/kernel-contract.test.js pins to both backend implementations.
import {
  KERNEL_OPS, KERNEL_OPTIONAL_OPS,
  SOLID_OPS, SOLID_OPTIONAL_OPS, SHAPE2D_OPS, ROUTED_CAD_OPS,
} from "./kernel.js";
import { KERNEL_OP_SPECS, SOLID_OP_SPECS, isPlainOptions } from "./op-options.js";

// The probe hands out TWO chainable handles: k.shape2d()/k.text2d() yield a Shape2D
// handle (whose extrude/revolve yield the Solid handle), everything else yields the
// Solid handle. The split lets lint and routing distinguish handle-specific ops:
// `Shape2D.fillet` is shared pure JS, `Solid.fillet` starts mesh-native and may
// request a runtime OCCT fallback, and `Solid.shell` probe-routes up front.
// Handle-level VALIDATION stays deliberately permissive (one union allowlist for
// both handle kinds), so the split can never false-positive on an error rule.
const KERNEL_ALLOWED = new Set([...KERNEL_OPS, ...KERNEL_OPTIONAL_OPS]);
const SOLID_ALLOWED = new Set([...SOLID_OPS, ...SOLID_OPTIONAL_OPS, ...SHAPE2D_OPS]);

// Kernel ops whose result is a Shape2D, and Shape2D ops whose result is a Solid —
// the only two places the probe's handle kind changes.
const SHAPE2D_YIELDING_KERNEL_OPS = new Set(["shape2d", "text2d", "vector2d"]);
const SOLID_YIELDING_SHAPE2D_OPS = new Set(["extrude", "revolve"]);

export const MAX_PROBE_OPS = 100000;

// Thrown to unwind a runaway build. Never escapes runValidatingProbe.
export class ProbeRunawayError extends Error {
  constructor(message) { super(message); this.name = "ProbeRunawayError"; }
}

// Shared proxy construction. `onCall(scope, op, args)` observes every op; queries
// return realistic dummy values the build may read.
function makeProbe(onCall) {
  const solidQueries = {
    boundingBox: () => ({ min: [0, 0, 0], max: [1, 1, 1], center: [0.5, 0.5, 0.5], size: [1, 1, 1] }),
    volume: () => 1,
    toMesh: () => ({ positions: new Float32Array(9), normals: new Float32Array(9), triangles: 1, edges: new Float32Array(0) }),
    toSTL: () => new ArrayBuffer(0),
    toIndexedMesh: () => ({ positions: new Float32Array(9), indices: new Uint32Array(3) }),
  };
  // Solid's optional mesh-topology queries return numbers/booleans, not a handle.
  Object.assign(solidQueries, { genus: () => 0, isEmpty: () => false });
  // Shape2D ops that return DATA rather than another Shape2D. Without an entry here an
  // op falls through to the chaining branch and hands back the Shape2D handle itself,
  // so ordinary array/number use of the result (`.corners().map(…)`, `.area() * 2`)
  // was recorded as an unknown Shape2D op and failed lint as `unknown-solid-op`.
  // `regions()` returns live Shape2Ds, so its dummy is an array holding the handle.
  // The dummy region is a unit square in the contour IR (closed: last point = first).
  const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const shape2dQueries = {
    ...solidQueries,
    isEmpty: () => false,
    area: () => 1,
    boundingBox: () => ({ min: [0, 0], max: [1, 1], center: [0.5, 0.5], size: [1, 1] }),
    toRegions: () => [{ outer: square.map((p) => [...p]), holes: [] }],
    simple: () => ({ outer: square.map((p) => [...p]), holes: [] }),
    toContours: () => [{ outer: { start: [0, 0], segments: square.slice(1).map((p) => ({ to: [...p] })) }, holes: [] }],
    corners: () => [0, 1, 2, 3].map((i) => ({
      index: i, position: i, point: [...square[i]], interiorAngleDeg: 90, convex: true, segTypes: ["line", "line"],
    })),
    contains: () => false,
    regions: () => [shape2d],
  };
  const kernelQueries = {
    toSTEP: () => Promise.resolve(new ArrayBuffer(0)),
    cleanup: () => {},
  };

  // `ignore` keeps the proxy from masquerading as a thenable/internal/serializable
  // handle: symbols, `then` (so it's never await-unwrapped), `_`-prefixed internals,
  // and `toJSON` all resolve to undefined rather than a chainable op. `toJSON` matters
  // because a handle nested inside an options object (the normal calling convention,
  // e.g. `k.extrude({ profile: someShape, h: 5 })`) isn't caught by the `describe()`
  // identity check below — that only sees the top-level options object, not the
  // nested handle — so `JSON.stringify` walks into it and probes for `toJSON` per the
  // spec. Without this, that probe would be recorded as a real op and then flagged as
  // an unknown one.
  const ignore = (key) => typeof key !== "string" || key === "then" || key === "toJSON" || key[0] === "_";

  // A query (boundingBox, volume, toMesh, …) must count against `onCall`'s ceiling
  // exactly like any other op — returning `queries[key]` directly here used to let
  // every query bypass the counter entirely, so a query-only loop (`for(;;)
  // s.volume()`) never tripped MAX_PROBE_OPS and hung forever. Wrap it the same
  // way as the chaining branch below: observe the call, then run the real query.
  // `routeFor(op)` picks which handle an op's result chains to — resolved at call
  // time so the three proxies can reference each other despite declaration order.
  const opProxy = (queries, scope, routeFor) => new Proxy({}, {
    get(_t, key) {
      if (ignore(key)) return undefined;
      if (key in queries) return (...args) => { onCall(scope, key, args); return queries[key](...args); };
      return (...args) => { onCall(scope, key, args); return routeFor(key); };
    },
  });

  const proxy = opProxy(solidQueries, "solid", () => proxy);   // a solid handle: every op chains back to itself
  const shape2d = opProxy(shape2dQueries, "shape2d",
    (key) => (SOLID_YIELDING_SHAPE2D_OPS.has(key) ? proxy : shape2d));
  const kernel = opProxy(kernelQueries, "kernel",             // factory ops (cylinder/box/prism/…) return a solid
    (key) => (SHAPE2D_YIELDING_KERNEL_OPS.has(key) ? shape2d : proxy));
  return { kernel, proxy, shape2d };
}

const CAD_OPS = new Set(ROUTED_CAD_OPS);

export function createProbeKernel() {
  const used = new Set();       // every op name, any handle kind
  const solidUsed = new Set();  // ops recorded on kernel/Solid handles only — the
                                // routing set: Shape2D.fillet must not look like Solid.fillet
  const cadCalls = [];          // Probe-routed Solid ops WITH args (currently shell).
  const { kernel } = makeProbe((scope, key, args) => {
    used.add(key);
    if (scope !== "shape2d") {
      solidUsed.add(key);
      if (CAD_OPS.has(key)) cadCalls.push({ op: key, args });
    }
  });
  return { kernel, used, solidUsed, cadCalls };
}

export function createValidatingProbe({ maxOps = MAX_PROBE_OPS } = {}) {
  const calls = [];
  const issues = [];
  const used = new Set();
  const solidUsed = new Set();  // same split as createProbeKernel: non-Shape2D-handle ops
  let count = 0;
  let solidProxy = null;
  let shape2dProxy = null;

  // Args are recorded as strings so two probe runs can be compared for determinism.
  // Each chainable handle is a single shared object, so identity is enough to spot it —
  // and checking identity FIRST matters, because JSON.stringify would trip its traps.
  const describe = (a) => {
    if (a === solidProxy) return "<solid>";
    if (a === shape2dProxy) return "<shape2d>";
    if (typeof a === "function") return "<fn>";
    try { return JSON.stringify(a) ?? String(a); } catch { return "<unserializable>"; }
  };

  const onCall = (scope, op, args) => {
    if (++count > maxOps) throw new ProbeRunawayError(`build exceeded ${maxOps} kernel operations`);
    used.add(op);
    if (scope !== "shape2d") solidUsed.add(op);
    const allowed = scope === "kernel" ? KERNEL_ALLOWED : SOLID_ALLOWED;
    if (!allowed.has(op)) issues.push({ kind: "unknown-op", scope, op });
    // Validate ONLY the options form — the normative rule (KERNEL-CONTRACT.md
    // "Calling convention") is that a call is options form when it receives exactly
    // one plain-object argument. Legacy positional calls have no options contract to
    // check against. We run `toArgs` (key + required validation) but never the spec's
    // separate `check` hook: `check` inspects real geometry (revolve's calls
    // boundingBox() on its profile), which is meaningless against a proxy.
    const specs = scope === "kernel" ? KERNEL_OP_SPECS : SOLID_OP_SPECS;
    if (specs[op] && args.length === 1 && isPlainOptions(args[0])) {
      try { specs[op].toArgs(args[0]); }
      catch (e) { issues.push({ kind: "invalid-options", scope, op, message: e?.message || String(e) }); }
    }
    calls.push({ scope, op, args: args.map(describe) });
  };

  const { kernel, proxy, shape2d } = makeProbe(onCall);
  solidProxy = proxy;
  shape2dProxy = shape2d;
  return { kernel, calls, issues, used, solidUsed };
}

/**
 * Execute every sub-part's build() — and every declared probe (`part.probes`,
 * same (k, p, d) contract, see oracle/measure.js) — against a validating probe.
 * Never throws: a build error becomes an entry in `throws` (probe entries land
 * in `probeThrows`), a runaway sets `runaway`.
 */
export function runValidatingProbe(part, p, d, { maxOps = MAX_PROBE_OPS } = {}) {
  const probe = createValidatingProbe({ maxOps });
  const throws = [];
  const probeThrows = [];
  let runaway = false;
  const run = (fn, onThrow) => {
    try {
      fn(probe.kernel, p, d);
    } catch (e) {
      if (e instanceof ProbeRunawayError) { runaway = true; return false; }
      onThrow(e?.message || String(e));
    }
    return true;
  };
  for (const [name, sp] of Object.entries(part?.parts ?? {})) {
    if (typeof sp?.build !== "function") continue; // no-buildable-parts already reports this
    if (!run(sp.build, (m) => throws.push({ subpart: name, message: m }))) break;
  }
  if (!runaway) {
    for (const [name, fn] of Object.entries(part?.probes ?? {})) {
      if (typeof fn !== "function") continue; // invalid-probes already reports this
      if (!run(fn, (m) => probeThrows.push({ probe: name, message: m }))) break;
    }
  }
  return { calls: probe.calls, issues: probe.issues, used: probe.used, solidUsed: probe.solidUsed, throws, probeThrows, runaway };
}
