import { describe, expect, it } from "vitest";
import { readZip } from "../scripts/zip.ts";
import { buildZip } from "./support/zip-builder.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("readZip", () => {
  it("lists the entries and reads stored and deflated content", () => {
    const entries = readZip(buildZip([
      { name: "a/stored.txt", content: "stored text" },
      { name: "a/deflated.txt", content: "deflated text ".repeat(50), method: "deflated" },
      { name: "empty", content: "" },
      { name: "é/ünïcode.txt", content: "unicode name" },
    ]));
    expect(entries.map(entry => entry.name)).toEqual(["a/stored.txt", "a/deflated.txt", "empty", "é/ünïcode.txt"]);
    expect(entries.map(entry => entry.size)).toEqual([11, 700, 0, 12]);
    expect(entries.map(entry => text(entry.read()))).toEqual(["stored text", "deflated text ".repeat(50), "", "unicode name"]);
  });

  it("refuses bytes that are not a zip file", () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(10), new TextEncoder().encode("PK but not really a zip file at all, only text")]) expect(() => readZip(bytes)).toThrow(/zip/u);
  });

  it("refuses a directory that points outside the file", () => {
    const zip = buildZip([{ name: "x", content: "y" }]);
    const damaged = Uint8Array.from(zip);
    // The central directory offset is the last four bytes before the (empty) comment length in the end record.
    new DataView(damaged.buffer).setUint32(damaged.length - 6, damaged.length + 100, true);
    expect(() => readZip(damaged)).toThrow(/zip/u);
  });

  it("refuses an entry whose content does not match its CRC", () => {
    const zip = buildZip([{ name: "x", content: "payload" }]);
    const damaged = Uint8Array.from(zip);
    damaged[30 + 1] = (damaged[30 + 1] ?? 0) ^ 1;
    const [entry] = readZip(damaged);
    expect(() => entry?.read()).toThrow(/CRC/u);
  });

  it("refuses a compression method it does not know and an entry that is far larger than allowed", () => {
    const zip = buildZip([{ name: "x", content: "payload" }]);
    const unknown = Uint8Array.from(zip);
    const view = new DataView(unknown.buffer);
    // The method is stored in the local header (offset 8) and again in the directory entry (10 bytes into it).
    view.setUint16(8, 99, true);
    view.setUint16(view.getUint32(unknown.length - 22 + 16, true) + 10, 99, true);
    expect(() => readZip(unknown)[0]?.read()).toThrow(/method 99/u);
    const large = buildZip([{ name: "big", content: new Uint8Array(9 * 1024 ** 2), method: "deflated" }]);
    expect(() => readZip(large)[0]?.read()).toThrow(/larger/u);
  });
});
