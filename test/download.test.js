// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { unzipSync } from "fflate";
import { triggerDownload, downloadParts, deliverKit } from "../src/framework/download.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("triggerDownload with a sink", () => {
  it("calls the sink with {data,filename,mime} and touches no DOM", () => {
    const sink = vi.fn();
    const createEl = vi.spyOn(document, "createElement");
    const bytes = new Uint8Array([1, 2, 3]);
    triggerDownload(bytes, "box.step", "application/step", sink);
    expect(sink).toHaveBeenCalledWith({ data: bytes, filename: "box.step", mime: "application/step" });
    expect(createEl).not.toHaveBeenCalled();
  });

  it("without a sink still builds an anchor (legacy DOM path)", () => {
    const createEl = vi.spyOn(document, "createElement");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // jsdom/happy-dom anchors have a no-op click; just prove the DOM path runs.
    triggerDownload(new Uint8Array([1]), "a.stl", "model/stl");
    expect(createEl).toHaveBeenCalledWith("a");
  });
});

describe("downloadParts with a sink", () => {
  it("single part routes the raw bytes to the sink under <name>.<ext>", () => {
    const sink = vi.fn();
    const data = new Uint8Array([9]);
    downloadParts({ parts: [{ name: "iso", data }], ext: "stl", mime: "model/stl" }, "part.zip", sink);
    expect(sink).toHaveBeenCalledWith({ data, filename: "iso.stl", mime: "model/stl" });
  });

  it("multiple parts zip first, then route the zip to the sink", () => {
    const sink = vi.fn();
    downloadParts(
      { parts: [{ name: "a", data: new Uint8Array([1]) }, { name: "b", data: new Uint8Array([2]) }], ext: "stl", mime: "model/stl" },
      "widget.zip",
      sink,
    );
    expect(sink).toHaveBeenCalledTimes(1);
    const call = sink.mock.calls[0][0];
    expect(call.filename).toBe("widget.zip");
    expect(call.mime).toBe("application/zip");
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBeGreaterThan(0); // real zip bytes
  });

  // Sub-part export names come from the (untrusted) part definition. A zip entry
  // of "../evil.stl" is zip-slip: a naive extractor writes it outside the target.
  it("zip entries stay flat — a traversal-shaped export name is slugged", () => {
    const sink = vi.fn();
    downloadParts(
      { parts: [{ name: "../../evil", data: new Uint8Array([1]) }, { name: "Left Bracket", data: new Uint8Array([2]) }], ext: "stl", mime: "model/stl" },
      "widget.zip",
      sink,
    );
    const names = Object.keys(unzipSync(sink.mock.calls[0][0].data));
    expect(names).toEqual(["evil.stl", "left-bracket.stl"]);
    for (const n of names) expect(n).not.toMatch(/[/\\]|^\./);
  });

  it("a single traversal-shaped export name is slugged too", () => {
    const sink = vi.fn();
    downloadParts({ parts: [{ name: "../../.ssh/authorized", data: new Uint8Array([9]) }], ext: "stl", mime: "model/stl" }, "part.zip", sink);
    expect(sink.mock.calls[0][0].filename).toBe("ssh-authorized.stl");
  });
});

describe("deliverKit", () => {
  const stl = { path: "print/lid.stl", kind: "model-stl", data: new Uint8Array([7]) };
  const readme = { path: "README.txt", kind: "text", data: new Uint8Array([8]) };
  const csv = { path: "parts.csv", kind: "table", data: new Uint8Array([9]) };
  const svg = { path: "laser/parts/lid.svg", kind: "drawing-svg", data: new Uint8Array([10]) };

  it("hands the entries to onKit when the host gives one, and saves nothing itself", () => {
    const onKit = vi.fn();
    const onDownload = vi.fn();
    deliverKit({ entries: [stl, readme, csv], name: "box" }, onKit, onDownload);
    expect(onKit).toHaveBeenCalledWith({ entries: [stl, readme, csv], name: "box" });
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("with no onKit, saves one model bare under its base name, without the README", () => {
    const onDownload = vi.fn();
    deliverKit({ entries: [stl, readme, csv], name: "box" }, undefined, onDownload);
    expect(onDownload).toHaveBeenCalledWith({ data: stl.data, filename: "lid.stl", mime: "model/stl" });
  });

  it("with no onKit, zips every entry as <name>-kit.zip otherwise", () => {
    const onDownload = vi.fn();
    deliverKit({ entries: [stl, svg, readme, csv], name: "box" }, undefined, onDownload);
    expect(onDownload).toHaveBeenCalledTimes(1);
    const { data, filename, mime } = onDownload.mock.calls[0][0];
    expect(filename).toBe("box-kit.zip");
    expect(mime).toBe("application/zip");
    expect(Object.keys(unzipSync(data)).sort()).toEqual(["README.txt", "laser/parts/lid.svg", "parts.csv", "print/lid.stl"]);
  });

  it("the fallback zip round-trips every entry, models stored and the rest deflated", () => {
    const text = (n) => new TextEncoder().encode("line of text\n".repeat(n));
    const entries = [
      { path: "print/lid.stl", kind: "model-stl", data: Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 251) },
      { path: "print/box.3mf", kind: "model-3mf", data: Uint8Array.from({ length: 200 }, (_, i) => i % 7) },
      { path: "laser/parts/lid.svg", kind: "drawing-svg", data: text(40) },
      { path: "README.txt", kind: "text", data: text(20) },
      { path: "parts.csv", kind: "table", data: text(5) },
    ];
    const onDownload = vi.fn();
    deliverKit({ entries, name: "box" }, undefined, onDownload);
    const methods = {};
    const files = unzipSync(onDownload.mock.calls[0][0].data, { filter: (f) => { methods[f.name] = f.compression; return true; } });
    expect(Object.keys(files).sort()).toEqual(entries.map((e) => e.path).sort());
    for (const e of entries) expect(Buffer.from(files[e.path]).equals(Buffer.from(e.data)), e.path).toBe(true);
    expect(methods).toEqual({ "print/lid.stl": 0, "print/box.3mf": 0, "laser/parts/lid.svg": 8, "README.txt": 8, "parts.csv": 8 });
  });
});
