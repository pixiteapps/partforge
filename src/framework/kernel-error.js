// What to say when the geometry kernel throws something that is not an Error.
//
// replicad-opencascadejs's `replicad_single` build (the OCCT kernel worker.js
// loads) is compiled WITHOUT C++ exception catching. An exception OCCT throws
// that nothing inside the WASM catches — a Standard_Failure out of the STEP
// reader, a std::bad_alloc when the heap cannot grow — leaves the module through
// Emscripten's `___cxa_throw`, whose last line is `throw ptr`: JavaScript
// receives the exception's ADDRESS, a bare number such as 154591824, different
// on every run. Stringified as-is, that number was the whole error message a
// part author (and partforge-cloud's agent, which read it as the part's fault
// and retried blindly — cloud feedback #208) got for a failed build.
//
// This module is the ONE place such a value becomes a readable Error, used by
// both the job loop's error post (jobs.js, worker.js) and the STEP import path
// (occt-backend.js). It never invents a cause: the message says the kernel
// raised an internal error it could not describe, names the operation when the
// caller knows it, and adds only what the kernel's own heap can prove —
// `emscriptenThrowEvidence` reads the thrown exception's C++ type name off the
// heap through the Itanium ABI layout Emscripten's `ExceptionInfo` uses, and
// says "too large for the in-browser kernel" only when that type IS an
// out-of-memory type, or the heap has reached the wasm32 ceiling. Anything the
// read cannot validate is dropped rather than guessed.

// A thrown value the caller cannot read: a number (the Emscripten case above), or
// an object with no non-empty string message (a bare WebAssembly.Exception, a
// plain object). A real Error — anything with a message — is never opaque.
export function isOpaqueThrow(err) {
  if (typeof err === "number") return true;
  if (err == null) return true;
  if (typeof err === "string") return err.trim() === "";
  return !(typeof err.message === "string" && err.message.trim() !== "");
}

// Emscripten's ExceptionInfo (replicad-opencascadejs 0.23): the thrown pointer
// is the exception OBJECT; a 24-byte header sits before it, with the
// std::type_info pointer at header + 4. A std::type_info (libc++abi, wasm32)
// is { vtable*, const char* __type_name }, so the mangled class name is the
// C string at *(typeInfo + 4). test/kernel-error-occt.test.js holds this
// layout against the installed glue: a replicad-opencascadejs bump that moves
// it fails there, and until it is re-pinned the read simply yields no type
// name (a wrong read almost never parses as a mangled name — see below).
const EXCEPTION_HEADER_BYTES = 24;
const TYPE_OFFSET_IN_HEADER = 4;
const NAME_OFFSET_IN_TYPE_INFO = 4;
const MAX_MANGLED_NAME = 128;

// getHeapMax() in the replicad_single glue: the wasm32 build's memory ceiling.
export const WASM32_HEAP_CEILING_BYTES = 2 ** 31;
// At or past this share of the ceiling, a throw with no readable type is still
// called out of memory: nothing else grows a heap to the top of its range.
const HEAP_CEILING_SHARE = 0.9;

// C++ exception types that mean the kernel could not get memory.
const OUT_OF_MEMORY_TYPES = new Set(["std::bad_alloc", "std::bad_array_new_length", "Standard_OutOfMemory"]);

// Itanium-mangled class name → readable, for the shapes exception types take:
// `St9bad_alloc` (std::bad_alloc), `16Standard_Failure`, `N3foo3BarE`
// (foo::Bar). Every length prefix must match its identifier exactly and the
// string must be consumed whole, which is what makes a misread (a pointer that
// landed on arbitrary heap bytes) come back null instead of as a "type".
export function demangleClassName(mangled) {
  if (typeof mangled !== "string" || !/^[A-Za-z0-9_]{1,128}$/.test(mangled)) return null;
  let i = 0;
  const nested = mangled[0] === "N";
  if (nested) i++;
  const parts = [];
  if (mangled.startsWith("St", i)) { parts.push("std"); i += 2; }
  while (i < mangled.length && /[0-9]/.test(mangled[i])) {
    let j = i;
    while (j < mangled.length && /[0-9]/.test(mangled[j])) j++;
    const len = Number(mangled.slice(i, j));
    if (len < 1 || j + len > mangled.length) return null;
    const ident = mangled.slice(j, j + len);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) return null;
    parts.push(ident);
    i = j + len;
  }
  if (nested ? mangled.slice(i) !== "E" : i !== mangled.length) return null;
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "std")) return null;
  return parts.join("::");
}

function readCString(u8, ptr, cap) {
  if (!Number.isInteger(ptr) || ptr <= 0 || ptr >= u8.length) return null;
  let s = "";
  for (let i = 0; i < cap && ptr + i < u8.length; i++) {
    const c = u8[ptr + i];
    if (c === 0) return s;
    s += String.fromCharCode(c);
  }
  return null; // ran past the cap or the heap without a terminator
}

// What the kernel's heap can say about a thrown value: `{ heapBytes, typeName? }`.
// `module` is the Emscripten module object (what `opencascade()` resolved to,
// `replicad.getOC()`); the HEAP views are re-read from it on every call because
// the glue replaces them whenever the memory grows. Returns `{}` for a module
// without heap views, and never throws.
export function emscriptenThrowEvidence(module, value) {
  const evidence = {};
  const u8 = module?.HEAPU8;
  const u32 = module?.HEAPU32;
  if (!(u8 instanceof Uint8Array) || !(u32 instanceof Uint32Array)) return evidence;
  evidence.heapBytes = u8.length;
  if (!Number.isInteger(value) || value <= EXCEPTION_HEADER_BYTES || value >= u8.length) return evidence;
  const typeInfo = u32[(value - EXCEPTION_HEADER_BYTES + TYPE_OFFSET_IN_HEADER) >> 2];
  if (!(typeInfo > 0 && typeInfo + NAME_OFFSET_IN_TYPE_INFO + 4 <= u8.length)) return evidence;
  const namePtr = u32[(typeInfo + NAME_OFFSET_IN_TYPE_INFO) >> 2];
  const typeName = demangleClassName(readCString(u8, namePtr, MAX_MANGLED_NAME));
  if (typeName) evidence.typeName = typeName;
  return evidence;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "unknown size";
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}

const describeRaw = (err) => {
  if (typeof err === "number") return `the kernel reported only an exception address, ${err}`;
  const ctor = err?.constructor?.name;
  return `the kernel reported only an opaque ${ctor && ctor !== "Object" ? ctor : "value"}`;
};

// Turn a thrown value into an Error. A real Error (anything with a message) is
// returned AS IS — same object, nothing rewritten — so a caller can branch on
// its `code` exactly as before. `operation` names what was running ("STEP
// import of "frame" (17.1 MB)"); `subject` is what the memory clause blames
// ("the file" for an import, "the part" otherwise); `evidence` is
// `emscriptenThrowEvidence`'s answer, or nothing.
export function describeKernelThrow(err, { operation, subject = "the part", evidence = {} } = {}) {
  if (!isOpaqueThrow(err)) return err;
  const { typeName, heapBytes } = evidence ?? {};
  let message = "the geometry kernel raised an internal error it could not describe";
  if (operation) message += ` during ${operation}`;
  const detail = [];
  if (typeName) detail.push(`C++ exception ${typeName}`);
  if (Number.isFinite(heapBytes)) detail.push(`kernel heap ${formatBytes(heapBytes)}`);
  message += detail.length ? ` (${detail.join(", ")})` : ` (${describeRaw(err)})`;
  const outOfMemory = typeName
    ? OUT_OF_MEMORY_TYPES.has(typeName)
    : Number.isFinite(heapBytes) && heapBytes >= WASM32_HEAP_CEILING_BYTES * HEAP_CEILING_SHARE;
  if (outOfMemory) {
    message += ` — the kernel ran out of memory, so ${subject} is probably too large for the in-browser kernel; retrying without reducing it will fail the same way`;
  }
  const out = new Error(message, { cause: err });
  if (typeName) out.kernelExceptionType = typeName;
  return out;
}

// The STEP import path's wrapper: whatever `importSTEP` threw, labelled with the
// import's name and size. An opaque throw takes `describeKernelThrow` with the
// import as its operation; a real Error (replicad's "Failed to load STEP file",
// its "This shape has not type, it is null" for a file the reader parsed but
// could not transfer) keeps its text behind the same label, `cause` attached.
export function labelImportFailure({ name, bytes, error, evidence }) {
  const operation = `STEP import of "${name}" (${formatBytes(bytes)})`;
  if (isOpaqueThrow(error)) return describeKernelThrow(error, { operation, subject: "the file", evidence });
  return new Error(`${operation} failed: ${error.message}`, { cause: error });
}
