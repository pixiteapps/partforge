// kernel-error.js — words for a kernel throw that is not an Error (an uncaught
// C++ exception out of the exception-less OCCT build reaches JavaScript as a
// bare number), and the heap read that names its C++ type.
import { describe, it, expect } from "vitest";
import {
  describeKernelThrow, isOpaqueThrow, labelImportFailure, demangleClassName,
  emscriptenThrowEvidence, formatBytes, WASM32_HEAP_CEILING_BYTES,
} from "../src/framework/kernel-error.js";

const BASE = "the geometry kernel raised an internal error it could not describe";

describe("isOpaqueThrow", () => {
  it("is true for a number, an empty value, and an object with no message", () => {
    expect(isOpaqueThrow(154591824)).toBe(true);
    expect(isOpaqueThrow(undefined)).toBe(true);
    expect(isOpaqueThrow(null)).toBe(true);
    expect(isOpaqueThrow({})).toBe(true);
    expect(isOpaqueThrow({ message: "" })).toBe(true);
    expect(isOpaqueThrow("")).toBe(true);
  });
  it("is false for an Error or anything carrying a message", () => {
    expect(isOpaqueThrow(new Error("boom"))).toBe(false);
    expect(isOpaqueThrow({ message: "boom" })).toBe(false);
    expect(isOpaqueThrow("plain string")).toBe(false);
  });
});

describe("describeKernelThrow", () => {
  it("turns a thrown number into an Error that says what it is", () => {
    const err = describeKernelThrow(154591824);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`${BASE} (the kernel reported only an exception address, 154591824)`);
    expect(err.cause).toBe(154591824);
  });
  it("turns a thrown object with no message into a readable Error", () => {
    class Opaque {}
    const err = describeKernelThrow(new Opaque());
    expect(err.message).toBe(`${BASE} (the kernel reported only an opaque Opaque)`);
    expect(describeKernelThrow({}).message).toBe(`${BASE} (the kernel reported only an opaque value)`);
  });
  it("returns a real Error unchanged — same object, code and all", () => {
    const real = new Error("import \"m\": STL/3MF imports need the Manifold backend");
    real.code = "NEEDS_IMPORT_MESH";
    const out = describeKernelThrow(real, { operation: "anything", evidence: { typeName: "std::bad_alloc" } });
    expect(out).toBe(real);
    expect(out.code).toBe("NEEDS_IMPORT_MESH");
  });
  it("names the operation when the caller knows it", () => {
    const err = describeKernelThrow(7, { operation: 'STEP import of "frame" (17.1 MB)' });
    expect(err.message).toMatch(/^the geometry kernel raised an internal error it could not describe during STEP import of "frame" \(17\.1 MB\) \(/);
  });
  it("names the C++ type and heap size when the evidence carries them, and nothing more", () => {
    const err = describeKernelThrow(7, { evidence: { typeName: "StdFail_NotDone", heapBytes: 104857600 } });
    expect(err.message).toBe(`${BASE} (C++ exception StdFail_NotDone, kernel heap 104.9 MB)`);
    expect(err.kernelExceptionType).toBe("StdFail_NotDone");
    expect(err.message).not.toMatch(/too large|out of memory/);
  });
  it("says the input is probably too large only for an out-of-memory type", () => {
    const err = describeKernelThrow(7, {
      operation: 'STEP import of "frame" (17.1 MB)', subject: "the file",
      evidence: { typeName: "std::bad_alloc", heapBytes: 2 ** 31 },
    });
    expect(err.message).toContain("C++ exception std::bad_alloc");
    expect(err.message).toContain("the kernel ran out of memory, so the file is probably too large for the in-browser kernel");
    expect(describeKernelThrow(7, { evidence: { typeName: "Standard_OutOfMemory" } }).message)
      .toContain("so the part is probably too large for the in-browser kernel");
  });
  it("calls a typeless throw out of memory only when the heap has reached its ceiling", () => {
    const atCeiling = describeKernelThrow(7, { evidence: { heapBytes: WASM32_HEAP_CEILING_BYTES } });
    expect(atCeiling.message).toContain("ran out of memory");
    const nearCeiling = describeKernelThrow(7, { evidence: { heapBytes: WASM32_HEAP_CEILING_BYTES * 0.95 } });
    expect(nearCeiling.message).toContain("ran out of memory");
    const small = describeKernelThrow(7, { evidence: { heapBytes: 100 * 1024 * 1024 } });
    expect(small.message).not.toMatch(/out of memory|too large/);
    expect(small.message).toContain("kernel heap 104.9 MB");
  });
  it("a readable type that is NOT out of memory wins over a full heap", () => {
    const err = describeKernelThrow(7, { evidence: { typeName: "StdFail_NotDone", heapBytes: WASM32_HEAP_CEILING_BYTES } });
    expect(err.message).not.toMatch(/out of memory|too large/);
  });
});

describe("labelImportFailure", () => {
  it("labels an opaque throw with the import's name and size", () => {
    const err = labelImportFailure({ name: "frame", bytes: 17_100_000, error: 154591824, evidence: { heapBytes: 50e6 } });
    expect(err.message).toBe(`${BASE} during STEP import of "frame" (17.1 MB) (kernel heap 50.0 MB)`);
    expect(err.cause).toBe(154591824);
  });
  it("keeps a real Error's text behind the same label", () => {
    const real = new Error("Failed to load STEP file");
    const err = labelImportFailure({ name: "frame", bytes: 2048, error: real });
    expect(err.message).toBe('STEP import of "frame" (2 KB) failed: Failed to load STEP file');
    expect(err.cause).toBe(real);
  });
  it("blames the file, not the part, when the kernel ran out of memory", () => {
    const err = labelImportFailure({ name: "frame", bytes: 17_100_000, error: 1, evidence: { typeName: "std::bad_alloc" } });
    expect(err.message).toContain("so the file is probably too large for the in-browser kernel");
  });
});

describe("demangleClassName", () => {
  it("reads the shapes exception types take", () => {
    expect(demangleClassName("St9bad_alloc")).toBe("std::bad_alloc");
    expect(demangleClassName("16Standard_Failure")).toBe("Standard_Failure");
    expect(demangleClassName("20Standard_OutOfMemory")).toBe("Standard_OutOfMemory");
    expect(demangleClassName("15StdFail_NotDone")).toBe("StdFail_NotDone");
    expect(demangleClassName("N3foo3BarE")).toBe("foo::Bar");
    expect(demangleClassName("NSt3__212length_errorE")).toBe("std::__2::length_error");
  });
  it("refuses anything that is not exactly a mangled class name", () => {
    expect(demangleClassName("")).toBeNull();
    expect(demangleClassName(null)).toBeNull();
    expect(demangleClassName("hello")).toBeNull(); // no length prefix
    expect(demangleClassName("5abc")).toBeNull(); // length overruns
    expect(demangleClassName("3abcd")).toBeNull(); // trailing bytes
    expect(demangleClassName("N3abc")).toBeNull(); // unterminated nesting
    expect(demangleClassName("St")).toBeNull(); // std:: alone
    expect(demangleClassName("2a-")).toBeNull(); // not an identifier
    expect(demangleClassName("0")).toBeNull();
  });
});

describe("emscriptenThrowEvidence", () => {
  // A heap laid out the way Emscripten's ExceptionInfo and libc++abi's
  // std::type_info are: exception object at EXC, its 24-byte header before it
  // with the type_info pointer at header+4, the type_info's name pointer at +4.
  const fakeModule = (mangled, { excPtr = 4096, typeInfo = 1024, namePtr = 512 } = {}) => {
    const buf = new ArrayBuffer(8192);
    const u8 = new Uint8Array(buf);
    const u32 = new Uint32Array(buf);
    for (let i = 0; i < mangled.length; i++) u8[namePtr + i] = mangled.charCodeAt(i);
    u32[(typeInfo + 4) >> 2] = namePtr;
    u32[(excPtr - 24 + 4) >> 2] = typeInfo;
    return { HEAPU8: u8, HEAPU32: u32 };
  };
  it("reads the thrown exception's C++ type name and the heap size", () => {
    expect(emscriptenThrowEvidence(fakeModule("St9bad_alloc"), 4096)).toEqual({ heapBytes: 8192, typeName: "std::bad_alloc" });
    expect(emscriptenThrowEvidence(fakeModule("16Standard_Failure"), 4096)).toEqual({ heapBytes: 8192, typeName: "Standard_Failure" });
  });
  it("reports only the heap size when the pointer leads nowhere readable", () => {
    const m = fakeModule("St9bad_alloc");
    expect(emscriptenThrowEvidence(m, 40)).toEqual({ heapBytes: 8192 }); // some other exception object: garbage header
    expect(emscriptenThrowEvidence(m, 8192 + 100)).toEqual({ heapBytes: 8192 }); // outside the heap
    expect(emscriptenThrowEvidence(m, 10)).toEqual({ heapBytes: 8192 }); // header would start before 0
    expect(emscriptenThrowEvidence(m, new Error("x"))).toEqual({ heapBytes: 8192 }); // not a number
    const noTerminator = fakeModule("St9bad_alloc", { namePtr: 8192 - 4 });
    expect(emscriptenThrowEvidence(noTerminator, 4096)).toEqual({ heapBytes: 8192 });
  });
  it("answers nothing for a module without heap views, and never throws", () => {
    expect(emscriptenThrowEvidence(undefined, 7)).toEqual({});
    expect(emscriptenThrowEvidence({}, 7)).toEqual({});
    expect(emscriptenThrowEvidence({ HEAPU8: [1, 2, 3] }, 7)).toEqual({});
  });
});

describe("formatBytes", () => {
  it("prints kilobytes under a megabyte and one decimal of megabytes above", () => {
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(100)).toBe("1 KB");
    expect(formatBytes(17_100_000)).toBe("17.1 MB");
    expect(formatBytes(undefined)).toBe("unknown size");
  });
});
